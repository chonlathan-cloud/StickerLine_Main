import uuid
import logging
import asyncio
import time
from datetime import datetime, timezone
from io import BytesIO
import zipfile
from fastapi import APIRouter, Depends, HTTPException, status, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from app.models.sticker import StickerGenerateRequest
from app.api.deps import get_line_profile, assert_user_match
from app.services.user_service import UserService
from app.services.ai_service import AIService
from app.services.image_service import ImageProcessor
from app.utils.storage import StorageClient
from app.utils.firestore import get_db
from app.core.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()
TARGET_STICKER_COUNT = 16
ALLOWED_STICKER_COUNTS = {TARGET_STICKER_COUNT}

GENERATION_SEMAPHORE = asyncio.Semaphore(max(1, settings.GENERATION_CONCURRENCY))
USER_COOLDOWN: dict[str, float] = {}
USER_COOLDOWN_LOCK = asyncio.Lock()

def get_user_service():
    return UserService()

def get_ai_service():
    return AIService()

def get_image_processor():
    return ImageProcessor()

def get_storage_client():
    return StorageClient()

class ResetStickerSetRequest(BaseModel):
    user_id: str

class UnlockExtraPicksRequest(BaseModel):
    user_id: str

class ApplyExtraPicksRequest(BaseModel):
    user_id: str
    selected_indices: list[int]

def _sanitize_locked_indices(indices: list[int]) -> set[int]:
    return {idx for idx in indices if isinstance(idx, int) and idx >= 0}

def _sanitize_filename(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in value)
    cleaned = cleaned.strip("_")
    return cleaned or "stickers"

def _utc_now():
    return datetime.now(timezone.utc)

def _get_jobs_collection():
    return get_db().collection("jobs")

def _extract_slot_index(slot: dict) -> int:
    try:
        return int(slot.get("index", 9999))
    except Exception:
        return 9999

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

async def _update_job(job_id: str, data: dict) -> None:
    job_ref = _get_jobs_collection().document(job_id)
    data["updated_at"] = _utc_now()
    await job_ref.update(data)

def _serialize_slots(slots: list[dict], storage_client: StorageClient) -> list[dict]:
    result_slots = []
    for slot in sorted([s for s in slots if isinstance(s, dict)], key=_extract_slot_index):
        blob_name = slot.get("blob_name")
        if not blob_name:
            continue
        result_slots.append({
            "index": _extract_slot_index(slot),
            "url": storage_client.generate_signed_url(blob_name),
            "locked": bool(slot.get("locked", False)),
        })
    return result_slots

def _serialize_extra_picks(extra_picks: list[dict], storage_client: StorageClient, unlocked: bool) -> list[dict]:
    serialized = []
    for pick in sorted([p for p in extra_picks if isinstance(p, dict)], key=_extract_slot_index):
        blob_name = pick.get("blob_name")
        serialized.append({
            "index": _extract_slot_index(pick),
            "url": storage_client.generate_signed_url(blob_name) if unlocked and blob_name else None,
        })
    return serialized

async def _process_job(
    job_id: str,
    request: StickerGenerateRequest,
    user_service: UserService,
    ai_service: AIService,
    image_processor: ImageProcessor,
    storage_client: StorageClient,
) -> None:
    try:
        await _update_job(job_id, {"status": "queued"})
        await _apply_user_cooldown(request.user_id)

        async with GENERATION_SEMAPHORE:
            await _update_job(job_id, {"status": "processing"})
            best_candidate: dict | None = None
            last_quality_warnings: list[dict] = []

            for attempt in range(3):
                grid_bytes = await ai_service.generate_sticker_grid(
                    image_uri=request.image_uri,
                    style_id=request.style,
                    extra_prompt=request.prompt,
                    strict_cell_framing=attempt > 0,
                )

                sticker_images = image_processor.process_sticker_grid(grid_bytes)
                sticker_count = len(sticker_images)
                edge_risks = image_processor.assess_sticker_set_edge_risk(sticker_images)
                artifact_risks = image_processor.assess_sticker_set_artifact_risk(sticker_images)
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
                    "scale_consistency": scale_consistency,
                    "quality_warnings": quality_warnings,
                    "risk_score": (
                        abs(TARGET_STICKER_COUNT - sticker_count) * 1000
                        + sum(int(item.get("severity", 0)) for item in edge_risks)
                        + (sum(int(item.get("severity", 0)) for item in artifact_risks) * 50)
                        + int(round(scale_consistency["std_ratio"] * 1000))
                        + (len(scale_consistency["outliers"]) * 10)
                    ),
                }

                if (
                    best_candidate is None
                    or candidate["risk_score"] < best_candidate["risk_score"]
                    or (
                        candidate["risk_score"] == best_candidate["risk_score"]
                        and (len(candidate["edge_risks"]) + len(candidate["artifact_risks"]))
                        < (len(best_candidate["edge_risks"]) + len(best_candidate["artifact_risks"]))
                    )
                ):
                    best_candidate = candidate

                if (
                    sticker_count == TARGET_STICKER_COUNT
                    and not edge_risks
                    and not artifact_risks
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

            # Store raw grid output for debugging / QA
            grid_blob = f"users/{request.user_id}/jobs/{job_id}/grid.png"
            storage_client.upload_file(
                file_bytes=grid_bytes,
                destination_blob_name=grid_blob,
                content_type="image/png",
            )
            await _update_job(
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
                    content_type="image/png"
                )
                output_urls.append(url)
                output_blobs.append(blob_name)

            locked_indices = _sanitize_locked_indices(request.locked_indices)
            existing_slots, _ = await user_service.get_current_stickers(request.user_id)
            existing_map: dict[int, dict] = {}
            existing_count = 0
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
            persisted_extra_picks = []
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

                locked = index in locked_indices if use_existing or locked_indices else False
                result_slots.append({"index": index, "url": url, "locked": locked})
                persisted_slots.append({"index": index, "blob_name": blob_name, "locked": locked})
                if use_existing:
                    persisted_extra_picks.append({
                        "index": index,
                        "blob_name": output_blobs[index],
                    })

            await user_service.set_current_generation_state(
                request.user_id,
                persisted_slots,
                job_id,
                persisted_extra_picks,
                False,
            )
            await _update_job(
                job_id,
                {
                    "status": "completed",
                    "sticker_count": sticker_count,
                    "result_slots": persisted_slots,
                    "extra_picks": persisted_extra_picks,
                },
            )

    except Exception as e:
        logger.error(f"Sticker generation failed for {request.user_id}. Rolling back coin deduction. Error: {e}")
        try:
            await user_service.refund_coin(request.user_id, amount=1)
        except Exception as refund_error:
            logger.error(f"CRITICAL: Failed to refund {request.user_id}: {refund_error}")

        await _update_job(job_id, {"status": "failed", "error": str(e)})

@router.post("/generate", status_code=status.HTTP_201_CREATED)
async def generate_stickers(
    request: StickerGenerateRequest,
    user_service: UserService = Depends(get_user_service),
    ai_service: AIService = Depends(get_ai_service),
    image_processor: ImageProcessor = Depends(get_image_processor),
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    """
    Main orchestration endpoint for generating Stickers.
    """
    user_id = request.user_id
    assert_user_match(token_profile["line_id"], user_id)
    
    # 1. Deduct 1 Coin from User atomically
    try:
        await user_service.deduct_coin(user_id, amount=1)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
        
    job_id = str(uuid.uuid4())
    job_ref = _get_jobs_collection().document(job_id)
    await job_ref.set({
        "job_id": job_id,
        "user_id": user_id,
        "status": "queued",
        "sticker_count": None,
        "created_at": _utc_now(),
        "updated_at": _utc_now(),
    })

    asyncio.create_task(
        _process_job(
            job_id=job_id,
            request=request,
            user_service=user_service,
            ai_service=ai_service,
            image_processor=image_processor,
            storage_client=storage_client,
        )
    )

    return {
        "job_id": job_id,
        "status": "queued",
    }

@router.get("/current")
async def get_current_stickers(
    user_id: str = Query(..., min_length=3),
    user_service: UserService = Depends(get_user_service),
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    """
    Return the latest sticker set for the user with fresh signed URLs.
    """
    assert_user_match(token_profile["line_id"], user_id)
    slots, job_id = await user_service.get_current_stickers(user_id)
    extra_picks, _, extra_picks_unlocked = await user_service.get_current_extra_picks(user_id)
    if not slots:
        return {
            "status": "empty",
            "job_id": job_id,
            "sticker_count": 0,
            "result_slots": [],
            "extra_pick_count": 0,
            "extra_picks_unlocked": extra_picks_unlocked,
            "extra_picks": [],
        }

    result_slots = _serialize_slots(slots, storage_client)
    serialized_extra_picks = _serialize_extra_picks(extra_picks, storage_client, extra_picks_unlocked)
    return {
        "status": "ok",
        "job_id": job_id,
        "sticker_count": len(result_slots),
        "result_slots": result_slots,
        "extra_pick_count": len(serialized_extra_picks),
        "extra_picks_unlocked": extra_picks_unlocked,
        "extra_picks": serialized_extra_picks,
    }

@router.post("/current/extra-picks/unlock", status_code=status.HTTP_200_OK)
async def unlock_current_extra_picks(
    request: UnlockExtraPicksRequest,
    user_service: UserService = Depends(get_user_service),
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    assert_user_match(token_profile["line_id"], request.user_id)
    try:
        new_balance = await user_service.unlock_current_extra_picks(request.user_id, amount=1)
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    slots, job_id = await user_service.get_current_stickers(request.user_id)
    extra_picks, _, extra_picks_unlocked = await user_service.get_current_extra_picks(request.user_id)
    return {
        "status": "ok",
        "job_id": job_id,
        "coin_balance": new_balance,
        "sticker_count": len(slots),
        "result_slots": _serialize_slots(slots, storage_client),
        "extra_pick_count": len(extra_picks),
        "extra_picks_unlocked": extra_picks_unlocked,
        "extra_picks": _serialize_extra_picks(extra_picks, storage_client, extra_picks_unlocked),
    }

@router.post("/current/extra-picks/apply", status_code=status.HTTP_200_OK)
async def apply_current_extra_picks(
    request: ApplyExtraPicksRequest,
    user_service: UserService = Depends(get_user_service),
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    assert_user_match(token_profile["line_id"], request.user_id)
    if not request.selected_indices:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Select at least one extra pick.")

    try:
        updated = await user_service.apply_current_extra_picks(request.user_id, request.selected_indices)
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    slots = updated.get("current_stickers") or []
    extra_picks = updated.get("current_extra_picks") or []
    extra_picks_unlocked = bool(updated.get("current_extra_picks_unlocked", False))
    return {
        "status": "ok",
        "job_id": updated.get("current_stickers_job_id"),
        "sticker_count": len(slots),
        "result_slots": _serialize_slots(slots, storage_client),
        "extra_pick_count": len(extra_picks),
        "extra_picks_unlocked": extra_picks_unlocked,
        "extra_picks": _serialize_extra_picks(extra_picks, storage_client, extra_picks_unlocked),
    }

@router.post("/reset", status_code=status.HTTP_200_OK)
async def reset_current_stickers(
    request: ResetStickerSetRequest,
    user_service: UserService = Depends(get_user_service),
    token_profile: dict = Depends(get_line_profile),
):
    """
    Clear current sticker set when user starts a new selfie.
    """
    assert_user_match(token_profile["line_id"], request.user_id)
    await user_service.reset_current_stickers(request.user_id)
    return {"status": "ok"}

@router.get("/current/download")
async def download_current_sticker_zip(
    user_id: str = Query(..., min_length=3),
    user_service: UserService = Depends(get_user_service),
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    """
    Download the latest merged sticker set for a user as a ZIP file.
    """
    assert_user_match(token_profile["line_id"], user_id)
    slots, _ = await user_service.get_current_stickers(user_id)
    if not slots:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No stickers found for this user.")

    def extract_index(slot: dict) -> int:
        try:
            return int(slot.get("index", 9999))
        except Exception:
            return 9999

    slots_sorted = sorted([s for s in slots if isinstance(s, dict)], key=extract_index)

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for slot in slots_sorted:
            blob_name = slot.get("blob_name")
            if not blob_name:
                continue
            filename = f"{extract_index(slot)}.png"
            blob = storage_client.bucket.blob(blob_name)
            archive.writestr(filename, blob.download_as_bytes())

    buffer.seek(0)
    headers = {
        "Content-Disposition": "attachment; filename=stickers.zip"
    }
    return StreamingResponse(buffer, media_type="application/zip", headers=headers)

@router.get("/current/download-url")
async def get_current_sticker_download_url(
    user_id: str = Query(..., min_length=3),
    user_service: UserService = Depends(get_user_service),
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    """
    Generate a ZIP in GCS and return a signed URL for direct download (mobile-friendly).
    """
    assert_user_match(token_profile["line_id"], user_id)
    slots, _ = await user_service.get_current_stickers(user_id)
    if not slots:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No stickers found for this user.")

    def extract_index(slot: dict) -> int:
        try:
            return int(slot.get("index", 9999))
        except Exception:
            return 9999

    slots_sorted = sorted([s for s in slots if isinstance(s, dict)], key=extract_index)

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for slot in slots_sorted:
            blob_name = slot.get("blob_name")
            if not blob_name:
                continue
            filename = f"{extract_index(slot)}.png"
            blob = storage_client.bucket.blob(blob_name)
            archive.writestr(filename, blob.download_as_bytes())

    buffer.seek(0)
    display_name = await user_service.get_display_name(user_id) or user_id
    filename = f"stickers_{_sanitize_filename(display_name)}.zip"
    blob_name = f"users/{user_id}/downloads/{uuid.uuid4()}.zip"

    url = storage_client.upload_file(
        file_bytes=buffer.getvalue(),
        destination_blob_name=blob_name,
        content_type="application/zip",
        response_disposition=f"attachment; filename={filename}",
        response_type="application/zip",
    )

    return {"url": url}

@router.get("/current/share-file")
async def get_current_sticker_share_file(
    user_id: str = Query(..., min_length=3),
    index: int = Query(..., ge=0),
    user_service: UserService = Depends(get_user_service),
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    """
    Stream a single sticker PNG from the current set for mobile share flows.
    """
    assert_user_match(token_profile["line_id"], user_id)
    slots, _ = await user_service.get_current_stickers(user_id)
    if not slots:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No stickers found for this user.")

    target_slot = None
    for slot in slots:
        if not isinstance(slot, dict):
            continue
        try:
            slot_index = int(slot.get("index", -1))
        except Exception:
            continue
        if slot_index == index:
            target_slot = slot
            break

    if not target_slot:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sticker not found.")

    blob_name = target_slot.get("blob_name")
    if not blob_name:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sticker blob is unavailable.")

    blob = storage_client.bucket.blob(blob_name)
    try:
        sticker_bytes = blob.download_as_bytes()
    except Exception as exc:
        logger.error("Failed to download sticker blob %s for share: %s", blob_name, exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Failed to prepare sticker file.") from exc

    headers = {
        "Content-Disposition": f'inline; filename="sticker-{index + 1:02d}.png"',
        "Cache-Control": "no-store",
    }
    return StreamingResponse(BytesIO(sticker_bytes), media_type="image/png", headers=headers)

@router.get("/{job_id}")
async def get_job_status(
    job_id: str,
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    job_ref = _get_jobs_collection().document(job_id)
    snapshot = await job_ref.get()
    if not snapshot.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")

    data = snapshot.to_dict() or {}
    job_user_id = data.get("user_id")
    if job_user_id:
        assert_user_match(token_profile["line_id"], job_user_id)
    status_value = data.get("status")

    if status_value == "completed":
        result_slots = []
        for slot in data.get("result_slots", []) or []:
            if not isinstance(slot, dict):
                continue
            blob_name = slot.get("blob_name")
            if not blob_name:
                continue
            url = storage_client.generate_signed_url(blob_name)
            result_slots.append({
                "index": int(slot.get("index", 0)),
                "url": url,
                "locked": bool(slot.get("locked", False)),
            })
        result_slots = sorted(result_slots, key=lambda s: s["index"])
        response = {
            "status": "completed",
            "job_id": job_id,
            "sticker_count": len(result_slots),
            "result_slots": result_slots,
        }
        if data.get("grid_blob"):
            response["grid_url"] = storage_client.generate_signed_url(data["grid_blob"])
        return response

    if status_value == "failed":
        response = {"status": "failed", "job_id": job_id, "error": data.get("error", "Unknown error")}
        if data.get("grid_blob"):
            response["grid_url"] = storage_client.generate_signed_url(data["grid_blob"])
        return response

    response = {"status": status_value or "queued", "job_id": job_id}
    if data.get("grid_blob"):
        response["grid_url"] = storage_client.generate_signed_url(data["grid_blob"])
    return response

@router.get("/{job_id}/download")
async def download_sticker_zip(
    job_id: str,
    user_id: str = Query(..., min_length=3),
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    """
    Download all generated stickers for a job as a ZIP file.
    """
    assert_user_match(token_profile["line_id"], user_id)
    prefix = f"users/{user_id}/jobs/{job_id}/"
    blobs = storage_client.list_blobs(prefix=prefix)
    if not blobs:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No stickers found for this job.")

    def extract_index(blob_name: str) -> int:
        filename = blob_name.rsplit("/", 1)[-1]
        stem = filename.split(".")[0]
        try:
            return int(stem)
        except ValueError:
            return 9999

    blobs_sorted = sorted(blobs, key=lambda b: extract_index(b.name))

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for blob in blobs_sorted:
            filename = blob.name.rsplit("/", 1)[-1]
            archive.writestr(filename, blob.download_as_bytes())

    buffer.seek(0)
    headers = {
        "Content-Disposition": f"attachment; filename=stickers_{job_id}.zip"
    }
    return StreamingResponse(buffer, media_type="application/zip", headers=headers)
