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
from app.services.user_service import UserService
from app.services.ai_service import AIService
from app.services.image_service import ImageProcessor
from app.utils.storage import StorageClient
from app.utils.firestore import get_db
from app.core.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

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

def _sanitize_locked_indices(indices: list[int]) -> set[int]:
    return {idx for idx in indices if isinstance(idx, int) and 0 <= idx < 16}

def _utc_now():
    return datetime.now(timezone.utc)

def _get_jobs_collection():
    return get_db().collection("jobs")

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

            grid_bytes = await ai_service.generate_sticker_grid(
                image_uri=request.image_uri,
                style_id=request.style,
                extra_prompt=request.prompt,
            )

            sticker_images = image_processor.process_sticker_grid(grid_bytes)

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
            for slot in existing_slots:
                if not isinstance(slot, dict):
                    continue
                idx = slot.get("index")
                if isinstance(idx, int) and 0 <= idx < 16:
                    existing_map[idx] = slot

            result_slots = []
            persisted_slots = []
            for index in range(16):
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

            await user_service.set_current_stickers(request.user_id, persisted_slots, job_id)
            await _update_job(job_id, {"status": "completed", "result_slots": persisted_slots})

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
    storage_client: StorageClient = Depends(get_storage_client)
):
    """
    Main orchestration endpoint for generating Stickers.
    """
    user_id = request.user_id
    
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
):
    """
    Return the latest sticker set for the user with fresh signed URLs.
    """
    slots, job_id = await user_service.get_current_stickers(user_id)
    if not slots:
        return {"status": "empty"}

    result_slots = []
    for slot in slots:
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
    return {
        "status": "ok",
        "job_id": job_id,
        "result_slots": result_slots,
    }

@router.post("/reset", status_code=status.HTTP_200_OK)
async def reset_current_stickers(
    request: ResetStickerSetRequest,
    user_service: UserService = Depends(get_user_service),
):
    """
    Clear current sticker set when user starts a new selfie.
    """
    await user_service.reset_current_stickers(request.user_id)
    return {"status": "ok"}

@router.get("/current/download")
async def download_current_sticker_zip(
    user_id: str = Query(..., min_length=3),
    user_service: UserService = Depends(get_user_service),
    storage_client: StorageClient = Depends(get_storage_client),
):
    """
    Download the latest merged sticker set for a user as a ZIP file.
    """
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

@router.get("/{job_id}")
async def get_job_status(
    job_id: str,
    storage_client: StorageClient = Depends(get_storage_client),
):
    job_ref = _get_jobs_collection().document(job_id)
    snapshot = await job_ref.get()
    if not snapshot.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found.")

    data = snapshot.to_dict() or {}
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
        return {"status": "completed", "job_id": job_id, "result_slots": result_slots}

    if status_value == "failed":
        return {"status": "failed", "job_id": job_id, "error": data.get("error", "Unknown error")}

    return {"status": status_value or "queued", "job_id": job_id}

@router.get("/{job_id}/download")
async def download_sticker_zip(
    job_id: str,
    user_id: str = Query(..., min_length=3),
    storage_client: StorageClient = Depends(get_storage_client),
):
    """
    Download all 16 stickers for a job as a ZIP file.
    """
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
