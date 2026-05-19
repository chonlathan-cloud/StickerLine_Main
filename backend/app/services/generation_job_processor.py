import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone

from app.core.config import settings
from app.models.sticker import StickerGenerateRequest
from app.services.ai_service import AIService
from app.services.image_service import ImageProcessor, UnsupportedStickerGridLayoutError
from app.services.user_service import UserService
from app.utils.firestore import get_db
from app.utils.storage import StorageClient

logger = logging.getLogger(__name__)

TARGET_STICKER_COUNT = 16
ALLOWED_STICKER_COUNTS = {TARGET_STICKER_COUNT}

GENERATION_SEMAPHORE = asyncio.Semaphore(max(1, settings.GENERATION_CONCURRENCY))
USER_COOLDOWN: dict[str, float] = {}
USER_COOLDOWN_LOCK = asyncio.Lock()


def _sanitize_locked_indices(indices: list[int]) -> set[int]:
    return {idx for idx in indices if isinstance(idx, int) and idx >= 0}


def _utc_now():
    return datetime.now(timezone.utc)


def _get_jobs_collection():
    return get_db().collection("jobs")


async def update_generation_job(job_id: str, data: dict) -> None:
    job_ref = _get_jobs_collection().document(job_id)
    data["updated_at"] = _utc_now()
    await job_ref.update(data)


async def _apply_user_cooldown(user_id: str) -> None:
    cooldown = max(0, settings.GENERATION_COOLDOWN_SECONDS)
    if cooldown == 0:
        return
    async with USER_COOLDOWN_LOCK:
        now = time.monotonic()
        next_allowed = USER_COOLDOWN.get(user_id, now)
        wait_seconds = max(0, next_allowed - now)
        USER_COOLDOWN[user_id] = max(next_allowed, now) + cooldown
    if wait_seconds > 0:
        await asyncio.sleep(wait_seconds)


async def process_generation_job(
    job_id: str,
    request: StickerGenerateRequest,
    user_service: UserService,
    ai_service: AIService,
    image_processor: ImageProcessor,
    storage_client: StorageClient,
) -> None:
    try:
        await update_generation_job(job_id, {"status": "queued"})
        await _apply_user_cooldown(request.user_id)

        async with GENERATION_SEMAPHORE:
            await update_generation_job(job_id, {"status": "processing"})
            best_candidate: dict | None = None
            last_quality_warnings: list[dict] = []

            for attempt in range(3):
                grid_bytes = await ai_service.generate_sticker_grid(
                    image_uri=request.image_uri,
                    style_id=request.style,
                    extra_prompt=request.prompt,
                    strict_cell_framing=attempt > 0,
                )

                try:
                    sticker_images = image_processor.process_sticker_grid(grid_bytes)
                except UnsupportedStickerGridLayoutError as layout_error:
                    last_quality_warnings = [{
                        "type": "layout_mismatch",
                        "details": {
                            "expected_layout": "4x4",
                            "reason": str(layout_error),
                        },
                    }]
                    logger.warning(
                        "Rejected unsupported sticker grid for job %s on attempt %d: %s",
                        job_id,
                        attempt + 1,
                        layout_error,
                    )
                    if attempt < 2:
                        continue
                    raise

                sticker_count = len(sticker_images)
                edge_risks = image_processor.assess_sticker_set_edge_risk(sticker_images)
                artifact_risks = image_processor.assess_sticker_set_artifact_risk(sticker_images)
                residual_screen_risks = image_processor.assess_sticker_set_residual_screen_risk(sticker_images)
                scale_consistency = image_processor.assess_subject_scale_consistency(sticker_images)
                quality_warnings: list[dict] = []
                if sticker_count != TARGET_STICKER_COUNT:
                    quality_warnings.append({
                        "type": "layout_mismatch",
                        "details": {
                            "expected_sticker_count": TARGET_STICKER_COUNT,
                            "actual_sticker_count": sticker_count,
                        },
                    })
                if edge_risks:
                    quality_warnings.append({
                        "type": "edge_touch_risk",
                        "details": edge_risks,
                    })
                if artifact_risks:
                    quality_warnings.append({
                        "type": "detached_artifact_risk",
                        "details": artifact_risks,
                    })
                if residual_screen_risks:
                    quality_warnings.append({
                        "type": "residual_screen_risk",
                        "details": residual_screen_risks,
                    })
                if scale_consistency["is_inconsistent"]:
                    quality_warnings.append({
                        "type": "scale_inconsistency",
                        "details": scale_consistency,
                    })

                candidate = {
                    "grid_bytes": grid_bytes,
                    "sticker_images": sticker_images,
                    "sticker_count": sticker_count,
                    "edge_risks": edge_risks,
                    "artifact_risks": artifact_risks,
                    "residual_screen_risks": residual_screen_risks,
                    "scale_consistency": scale_consistency,
                    "quality_warnings": quality_warnings,
                    "risk_score": (
                        abs(TARGET_STICKER_COUNT - sticker_count) * 1000
                        + sum(int(item.get("severity", 0)) for item in edge_risks)
                        + (sum(int(item.get("severity", 0)) for item in artifact_risks) * 50)
                        + (sum(int(item.get("severity", 0)) for item in residual_screen_risks) * 40)
                        + int(round(scale_consistency["std_ratio"] * 1000))
                        + (len(scale_consistency["outliers"]) * 10)
                    ),
                }

                if (
                    best_candidate is None
                    or candidate["risk_score"] < best_candidate["risk_score"]
                    or (
                        candidate["risk_score"] == best_candidate["risk_score"]
                        and (
                            len(candidate["edge_risks"])
                            + len(candidate["artifact_risks"])
                            + len(candidate["residual_screen_risks"])
                        )
                        < (
                            len(best_candidate["edge_risks"])
                            + len(best_candidate["artifact_risks"])
                            + len(best_candidate["residual_screen_risks"])
                        )
                    )
                ):
                    best_candidate = candidate

                if (
                    sticker_count == TARGET_STICKER_COUNT
                    and not edge_risks
                    and not artifact_risks
                    and not residual_screen_risks
                    and not scale_consistency["is_inconsistent"]
                ):
                    break

                last_quality_warnings = quality_warnings
                logger.warning(
                    "Detected sticker quality issues for job %s on attempt %d: %s",
                    job_id,
                    attempt + 1,
                    quality_warnings,
                )

            if best_candidate is None:
                raise ValueError("Sticker generation did not produce any candidate output.")

            grid_bytes = best_candidate["grid_bytes"]
            sticker_images = best_candidate["sticker_images"]
            sticker_count = int(best_candidate["sticker_count"])
            if sticker_count not in ALLOWED_STICKER_COUNTS:
                raise ValueError(
                    f"Expected exactly {TARGET_STICKER_COUNT} stickers from the generated sheet, but detected {sticker_count}. "
                    "The source grid layout is unsupported."
                )
            if best_candidate["quality_warnings"]:
                logger.warning(
                    "Using best available sticker set for job %s despite remaining quality warnings: %s",
                    job_id,
                    best_candidate["quality_warnings"],
                )

            grid_blob = f"users/{request.user_id}/jobs/{job_id}/grid.png"
            storage_client.upload_file(
                file_bytes=grid_bytes,
                destination_blob_name=grid_blob,
                content_type="image/png",
            )
            await update_generation_job(
                job_id,
                {
                    "grid_blob": grid_blob,
                    "quality_warnings": best_candidate["quality_warnings"] or last_quality_warnings,
                },
            )

            output_urls: list[str] = []
            output_blobs: list[str] = []

            for i, sticker_bytes in enumerate(sticker_images):
                blob_name = f"users/{request.user_id}/jobs/{job_id}/{i}.png"
                url = storage_client.upload_file(
                    file_bytes=sticker_bytes,
                    destination_blob_name=blob_name,
                    content_type="image/png",
                )
                output_urls.append(url)
                output_blobs.append(blob_name)

            locked_indices = _sanitize_locked_indices(request.locked_indices)
            existing_slots, existing_job_id = await user_service.get_current_stickers(request.user_id)
            existing_map: dict[int, dict] = {}
            for slot in existing_slots:
                if not isinstance(slot, dict):
                    continue
                idx = slot.get("index")
                if isinstance(idx, int) and 0 <= idx < sticker_count:
                    existing_map[idx] = slot
            existing_count = len(existing_map)

            if locked_indices and existing_count and existing_count != sticker_count:
                raise ValueError(
                    f"Locked regenerate requires the same sticker count, but the current set has {existing_count} "
                    f"and the new generation has {sticker_count}."
                )

            locked_indices = {idx for idx in locked_indices if idx < sticker_count}

            result_slots = []
            persisted_slots = []
            new_extra_vault_items = []
            now = _utc_now()
            for index in range(sticker_count):
                use_existing = index in locked_indices and index in existing_map
                if use_existing:
                    existing_blob = existing_map[index].get("blob_name")
                    if existing_blob:
                        url = storage_client.generate_signed_url(existing_blob)
                        blob_name = existing_blob
                    else:
                        url = output_urls[index]
                        blob_name = output_blobs[index]
                        use_existing = False
                else:
                    url = output_urls[index]
                    blob_name = output_blobs[index]
                    replaced_slot = existing_map.get(index)
                    replaced_blob = replaced_slot.get("blob_name") if replaced_slot else None
                    if replaced_blob:
                        new_extra_vault_items.append({
                            "id": f"{job_id}-{index}-{uuid.uuid4().hex[:8]}",
                            "source_job_id": replaced_slot.get("source_job_id") or existing_job_id,
                            "replaced_by_job_id": job_id,
                            "replaced_from_slot": index,
                            "blob_name": replaced_blob,
                            "created_at": now,
                        })

                locked = index in locked_indices if use_existing or locked_indices else False
                result_slots.append({"index": index, "url": url, "locked": locked})
                source_job_id = existing_map[index].get("source_job_id") if use_existing and index in existing_map else job_id
                persisted_slots.append({
                    "index": index,
                    "blob_name": blob_name,
                    "locked": locked,
                    "source_job_id": source_job_id,
                })

            await user_service.set_current_generation_state(
                request.user_id,
                persisted_slots,
                job_id,
                new_extra_vault_items,
                False,
            )
            await update_generation_job(
                job_id,
                {
                    "status": "completed",
                    "sticker_count": sticker_count,
                    "result_slots": persisted_slots,
                    "extra_vault_items": new_extra_vault_items,
                    "extra_vault_item_count": len(new_extra_vault_items),
                },
            )

    except Exception as e:
        logger.error("Sticker generation failed for %s. Error: %s", request.user_id, e)
        await update_generation_job(job_id, {"status": "failed", "error": str(e)})
