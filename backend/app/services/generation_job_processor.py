import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone

from app.core.config import settings
from app.models.sticker import StickerGenerateRequest
from app.services.ai_capacity_limiter import AIProviderCapacityError
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


async def _get_job_cycle_id(job_id: str) -> str | None:
    snapshot = await _get_jobs_collection().document(job_id).get()
    if not snapshot.exists:
        return None
    data = snapshot.to_dict() or {}
    cycle_id = data.get("cycle_id")
    return cycle_id if isinstance(cycle_id, str) else None


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
    mark_queued: bool = True,
) -> None:
    try:
        if mark_queued:
            await update_generation_job(job_id, {"status": "queued"})
        await _apply_user_cooldown(request.user_id)

        async with GENERATION_SEMAPHORE:
            await update_generation_job(
                job_id,
                {
                    "status": "processing",
                    "processing_started_at": _utc_now(),
                },
            )
            best_candidate: dict | None = None
            last_quality_warnings: list[dict] = []
            quality_attempts = max(1, int(settings.GENAI_QUALITY_ATTEMPTS))
            quality_attempt_summaries: list[dict] = []
            primary_vertex_model_id = ai_service.primary_vertex_model_id()
            quality_fallback_model_ids = ai_service.quality_fallback_vertex_model_ids()
            primary_error_fallback_route = (
                [primary_vertex_model_id, *quality_fallback_model_ids]
                if primary_vertex_model_id
                else None
            )

            async def run_quality_attempt(
                attempt_number: int,
                strict_cell_framing: bool,
                vertex_model_route_override: list[str] | None,
                phase: str,
            ) -> tuple[dict, bool]:
                generation_result = await ai_service.generate_sticker_grid_with_metadata(
                    image_uri=request.image_uri,
                    style_id=request.style,
                    extra_prompt=request.prompt,
                    strict_cell_framing=strict_cell_framing,
                    vertex_model_route_override=vertex_model_route_override,
                )
                grid_bytes = generation_result.image_bytes

                try:
                    sticker_images = image_processor.process_sticker_grid(grid_bytes)
                except UnsupportedStickerGridLayoutError as layout_error:
                    quality_warnings = [{
                        "type": "layout_mismatch",
                        "details": {
                            "expected_layout": "4x4",
                            "reason": str(layout_error),
                        },
                    }]
                    logger.warning(
                        "Rejected unsupported sticker grid for job %s on attempt %d: %s",
                        job_id,
                        attempt_number,
                        layout_error,
                    )
                    last_quality_warnings = quality_warnings
                    quality_attempt_summaries.append({
                        "attempt": attempt_number,
                        "phase": phase,
                        "model_used": generation_result.model_id,
                        "genai_provider_used": generation_result.provider,
                        "prompt_profile": generation_result.prompt_profile,
                        "sticker_count": 0,
                        "risk_score": abs(TARGET_STICKER_COUNT) * 1000,
                        "quality_warning_types": [warning["type"] for warning in quality_warnings],
                        "clean": False,
                    })
                    raise

                sticker_count = len(sticker_images)
                edge_risks = image_processor.assess_sticker_set_edge_risk(sticker_images)
                artifact_risks = image_processor.assess_sticker_set_artifact_risk(sticker_images)
                residual_screen_risks = image_processor.assess_sticker_set_residual_screen_risk(sticker_images)
                scale_consistency = image_processor.assess_subject_scale_consistency(sticker_images)
                top_caption_risks: list[dict] = []
                top_attached_artifact_risks: list[dict] = []
                if generation_result.prompt_profile == AIService.GEMINI_31_FLASH_PROMPT_PROFILE:
                    top_caption_risks = image_processor.assess_raw_grid_caption_placement_risk(grid_bytes)
                    top_attached_artifact_risks = image_processor.assess_sticker_set_top_attached_artifact_risk(sticker_images)
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
                if top_caption_risks:
                    quality_warnings.append({
                        "type": "top_caption_placement_risk",
                        "details": top_caption_risks,
                    })
                if top_attached_artifact_risks:
                    quality_warnings.append({
                        "type": "top_attached_artifact_risk",
                        "details": top_attached_artifact_risks,
                    })
                if scale_consistency["is_inconsistent"]:
                    quality_warnings.append({
                        "type": "scale_inconsistency",
                        "details": scale_consistency,
                    })

                candidate = {
                    "quality_attempt": attempt_number,
                    "quality_phase": phase,
                    "genai_provider_used": generation_result.provider,
                    "model_used": generation_result.model_id,
                    "prompt_profile": generation_result.prompt_profile,
                    "grid_bytes": grid_bytes,
                    "sticker_images": sticker_images,
                    "sticker_count": sticker_count,
                    "edge_risks": edge_risks,
                    "artifact_risks": artifact_risks,
                    "residual_screen_risks": residual_screen_risks,
                    "top_caption_risks": top_caption_risks,
                    "top_attached_artifact_risks": top_attached_artifact_risks,
                    "scale_consistency": scale_consistency,
                    "quality_warnings": quality_warnings,
                    "risk_score": (
                        abs(TARGET_STICKER_COUNT - sticker_count) * 1000
                        + sum(int(item.get("severity", 0)) for item in edge_risks)
                        + (sum(int(item.get("severity", 0)) for item in artifact_risks) * 50)
                        + (sum(int(item.get("severity", 0)) for item in residual_screen_risks) * 40)
                        + (sum(int(item.get("severity", 0)) for item in top_caption_risks) * 80)
                        + (sum(int(item.get("severity", 0)) for item in top_attached_artifact_risks) * 60)
                        + int(round(scale_consistency["std_ratio"] * 1000))
                        + (len(scale_consistency["outliers"]) * 10)
                    ),
                }
                is_clean = (
                    sticker_count == TARGET_STICKER_COUNT
                    and not edge_risks
                    and not artifact_risks
                    and not residual_screen_risks
                    and not top_caption_risks
                    and not top_attached_artifact_risks
                    and not scale_consistency["is_inconsistent"]
                )
                quality_attempt_summaries.append({
                    "attempt": attempt_number,
                    "phase": phase,
                    "model_used": generation_result.model_id,
                    "genai_provider_used": generation_result.provider,
                    "prompt_profile": generation_result.prompt_profile,
                    "sticker_count": sticker_count,
                    "risk_score": candidate["risk_score"],
                    "quality_warning_types": [warning["type"] for warning in quality_warnings],
                    "clean": is_clean,
                })
                return candidate, is_clean

            for attempt in range(quality_attempts):
                try:
                    candidate, is_clean = await run_quality_attempt(
                        attempt_number=attempt + 1,
                        strict_cell_framing=attempt > 0,
                        vertex_model_route_override=primary_error_fallback_route,
                        phase="primary",
                    )
                except UnsupportedStickerGridLayoutError:
                    if attempt < quality_attempts - 1 or quality_fallback_model_ids:
                        continue
                    raise

                if (
                    best_candidate is None
                    or candidate["risk_score"] < best_candidate["risk_score"]
                    or (
                        candidate["risk_score"] == best_candidate["risk_score"]
                        and (
                            len(candidate["edge_risks"])
                            + len(candidate["artifact_risks"])
                            + len(candidate["residual_screen_risks"])
                            + len(candidate["top_caption_risks"])
                            + len(candidate["top_attached_artifact_risks"])
                        )
                        < (
                            len(best_candidate["edge_risks"])
                            + len(best_candidate["artifact_risks"])
                            + len(best_candidate["residual_screen_risks"])
                            + len(best_candidate["top_caption_risks"])
                            + len(best_candidate["top_attached_artifact_risks"])
                        )
                    )
                ):
                    best_candidate = candidate

                if is_clean:
                    break

                last_quality_warnings = candidate["quality_warnings"]
                logger.warning(
                    "Detected sticker quality issues for job %s on attempt %d: %s",
                    job_id,
                    attempt + 1,
                    candidate["quality_warnings"],
                )

            if (
                (best_candidate is None or best_candidate["quality_warnings"])
                and quality_fallback_model_ids
            ):
                for fallback_index, fallback_model_id in enumerate(quality_fallback_model_ids, start=1):
                    attempt_number = quality_attempts + fallback_index
                    candidate, is_clean = await run_quality_attempt(
                        attempt_number=attempt_number,
                        strict_cell_framing=True,
                        vertex_model_route_override=[fallback_model_id],
                        phase="quality_fallback",
                    )
                    if (
                        best_candidate is None
                        or candidate["risk_score"] < best_candidate["risk_score"]
                        or (
                            candidate["risk_score"] == best_candidate["risk_score"]
                            and len(candidate["quality_warnings"]) < len(best_candidate["quality_warnings"])
                        )
                    ):
                        best_candidate = candidate
                    if is_clean:
                        break
                    last_quality_warnings = candidate["quality_warnings"]
                    logger.warning(
                        "Detected sticker quality issues for job %s on fallback attempt %d: %s",
                        job_id,
                        attempt_number,
                        candidate["quality_warnings"],
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
                    "quality_attempts_requested": quality_attempts,
                    "quality_attempts_used": int(best_candidate.get("quality_attempt") or 1),
                    "quality_phase": best_candidate.get("quality_phase"),
                    "quality_fallback_used": best_candidate.get("quality_phase") == "quality_fallback",
                    "quality_attempt_summaries": quality_attempt_summaries,
                    "risk_score": int(best_candidate.get("risk_score") or 0),
                    "model_used": best_candidate.get("model_used"),
                    "genai_provider_used": best_candidate.get("genai_provider_used"),
                    "prompt_profile": best_candidate.get("prompt_profile"),
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
                    "completed_at": _utc_now(),
                },
            )

    except Exception as e:
        logger.error("Sticker generation failed for %s. Error: %s", request.user_id, e)
        failure_data = {
            "status": "failed",
            "error": str(e),
            "error_type": type(e).__name__,
            "last_error": str(e),
            "failed_at": _utc_now(),
        }
        if isinstance(e, AIProviderCapacityError):
            cycle_id = await _get_job_cycle_id(job_id)
            try:
                refund_result = await user_service.refund_generation_attempt(request.user_id, cycle_id)
            except Exception:
                logger.exception("Failed to refund generation attempt for capacity failure on job %s", job_id)
                refund_result = {"refunded": False, "generation_state": None}
            failure_data.update({
                "error_code": e.error_code,
                "retry_after_seconds": e.retry_after_seconds,
                "attempt_refunded": bool(refund_result.get("refunded")),
                "generation_state": refund_result.get("generation_state"),
            })
        await update_generation_job(
            job_id,
            failure_data,
        )
