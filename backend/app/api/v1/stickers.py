import uuid
import logging
import asyncio
from datetime import datetime, timezone
from io import BytesIO
import zipfile
from fastapi import APIRouter, Depends, HTTPException, status, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from app.models.sticker import StickerGenerateRequest
from app.api.deps import get_line_profile, assert_user_match
from app.services.user_service import (
    ExtraPackPaymentRequiredError,
    FinalPackPaymentRequiredError,
    GenerationLimitReachedError,
    UserService,
)
from app.services.pubsub_service import PubSubPublishError, PubSubService
from app.core.config import settings
from app.utils.storage import StorageClient
from app.utils.firestore import get_db

logger = logging.getLogger(__name__)
router = APIRouter()
VALID_GENERATION_DISPATCH_MODES = {"local_async", "pubsub"}

def get_user_service():
    return UserService()

def get_ai_service():
    from app.services.ai_service import AIService

    return AIService()

def get_image_processor():
    from app.services.image_service import ImageProcessor

    return ImageProcessor()

def get_storage_client():
    return StorageClient()

def get_pubsub_service():
    return PubSubService()

class ResetStickerSetRequest(BaseModel):
    user_id: str

class UnlockExtraPicksRequest(BaseModel):
    user_id: str

class ApplyExtraPicksRequest(BaseModel):
    user_id: str
    selected_indices: list[int]

class FinalizeExportRequest(BaseModel):
    user_id: str

class ExtraVaultExportRequest(BaseModel):
    user_id: str
    selected_extra_ids: list[str]

def _sanitize_filename(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in value)
    cleaned = cleaned.strip("_")
    return cleaned or "stickers"

def _utc_now():
    return datetime.now(timezone.utc)

def _get_jobs_collection():
    return get_db().collection("jobs")

def _get_generation_dispatch_mode() -> str:
    mode = (settings.GENERATION_DISPATCH_MODE or "local_async").strip().lower()
    if mode not in VALID_GENERATION_DISPATCH_MODES:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Invalid GENERATION_DISPATCH_MODE: {settings.GENERATION_DISPATCH_MODE}",
        )
    return mode

def _extract_slot_index(slot: dict) -> int:
    try:
        return int(slot.get("index", 9999))
    except Exception:
        return 9999

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

def _serialize_extra_vault(extra_vault: list[dict], storage_client: StorageClient, expose_urls: bool) -> list[dict]:
    serialized = []
    for item in extra_vault:
        if not isinstance(item, dict):
            continue
        blob_name = item.get("blob_name")
        extra_id = item.get("id")
        if not blob_name or not extra_id:
            continue
        serialized.append({
            "id": extra_id,
            "source_job_id": item.get("source_job_id"),
            "replaced_from_slot": item.get("replaced_from_slot"),
            "url": storage_client.generate_signed_url(blob_name) if expose_urls else None,
            "created_at": item.get("created_at"),
        })
    return serialized

def _payment_required_detail(product_id: str, state: dict | None = None) -> dict:
    return {
        "error_code": "payment_required",
        "product_id": product_id,
        "generation_state": state or {},
    }

def _select_extra_vault_items(extra_vault: list[dict], selected_extra_ids: list[str]) -> list[dict]:
    normalized_ids = []
    seen = set()
    for extra_id in selected_extra_ids:
        if not isinstance(extra_id, str) or not extra_id.strip():
            continue
        cleaned = extra_id.strip()
        if cleaned in seen:
            continue
        seen.add(cleaned)
        normalized_ids.append(cleaned)

    if not normalized_ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Select at least one extra sticker.")
    if len(normalized_ids) > 16:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Select at most 16 extra stickers.")

    by_id = {
        item.get("id"): item
        for item in extra_vault
        if isinstance(item, dict) and item.get("id") and item.get("blob_name")
    }
    missing = [extra_id for extra_id in normalized_ids if extra_id not in by_id]
    if missing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="One or more extra stickers were not found.")

    return [by_id[extra_id] for extra_id in normalized_ids]

@router.post("/generate", status_code=status.HTTP_201_CREATED)
async def generate_stickers(
    request: StickerGenerateRequest,
    user_service: UserService = Depends(get_user_service),
    pubsub_service: PubSubService = Depends(get_pubsub_service),
    token_profile: dict = Depends(get_line_profile),
):
    """
    Main orchestration endpoint for generating Stickers.
    """
    user_id = request.user_id
    assert_user_match(token_profile["line_id"], user_id)
    dispatch_mode = _get_generation_dispatch_mode()

    if dispatch_mode == "local_async":
        ai_service = get_ai_service()
        image_processor = get_image_processor()
        storage_client = get_storage_client()

    try:
        generation_state = await user_service.prepare_generation_attempt(user_id)
    except GenerationLimitReachedError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "error_code": "generation_limit_reached",
                "product_id": "final_pack_199",
                "generation_state": exc.state,
            },
        ) from exc
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
        
    job_id = str(uuid.uuid4())
    job_ref = _get_jobs_collection().document(job_id)
    now = _utc_now()
    await job_ref.set({
        "job_id": job_id,
        "user_id": user_id,
        "cycle_id": generation_state.get("cycle_id"),
        "status": "queued",
        "dispatch_mode": dispatch_mode,
        "sticker_count": None,
        "generation_state": generation_state,
        "queued_at": now,
        "created_at": now,
        "updated_at": now,
    })

    if dispatch_mode == "pubsub":
        try:
            message_id = await pubsub_service.publish_generation_job(
                job_id=job_id,
                user_id=user_id,
                cycle_id=generation_state.get("cycle_id"),
            )
        except PubSubPublishError as exc:
            logger.exception("Failed to dispatch generation job %s to Pub/Sub", job_id)
            failed_at = _utc_now()
            await job_ref.update({
                "status": "failed",
                "error": "generation_dispatch_failed",
                "dispatch_error": str(exc),
                "failed_at": failed_at,
                "updated_at": failed_at,
            })
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={
                    "error_code": "generation_dispatch_failed",
                    "job_id": job_id,
                },
            ) from exc
        try:
            published_at = _utc_now()
            await job_ref.update({
                "pubsub_message_id": message_id,
                "published_at": published_at,
                "updated_at": published_at,
            })
        except Exception:
            logger.exception("Published generation job %s but failed to persist Pub/Sub metadata", job_id)
    else:
        from app.services.generation_job_processor import process_generation_job

        asyncio.create_task(
            process_generation_job(
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
        "dispatch_mode": dispatch_mode,
        "generation_state": generation_state,
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
    generation_state = await user_service.get_cycle_state(user_id)
    slots, job_id = await user_service.get_current_stickers(user_id)
    extra_vault_state = await user_service.get_extra_vault(user_id)
    extra_vault = extra_vault_state.get("extra_vault") or []
    expose_extra_urls = bool(generation_state.get("final_pack_exported")) and not extra_vault_state.get("extra_vault_expired")
    serialized_extra_vault = _serialize_extra_vault(extra_vault, storage_client, expose_extra_urls)
    if not slots:
        return {
            "status": "empty",
            "job_id": job_id,
            "sticker_count": 0,
            "result_slots": [],
            "generation_state": generation_state,
            "extra_vault_count": len(serialized_extra_vault),
            "extra_vault": serialized_extra_vault,
            "extra_pick_count": len(serialized_extra_vault),
            "extra_picks_unlocked": expose_extra_urls,
            "extra_picks": [],
        }

    result_slots = _serialize_slots(slots, storage_client)
    return {
        "status": "ok",
        "job_id": job_id,
        "sticker_count": len(result_slots),
        "result_slots": result_slots,
        "generation_state": generation_state,
        "extra_vault_count": len(serialized_extra_vault),
        "extra_vault": serialized_extra_vault,
        "extra_pick_count": len(serialized_extra_vault),
        "extra_picks_unlocked": expose_extra_urls,
        "extra_picks": serialized_extra_vault,
    }

@router.post("/current/extra-picks/unlock", status_code=status.HTTP_200_OK)
async def unlock_current_extra_picks(
    request: UnlockExtraPicksRequest,
    user_service: UserService = Depends(get_user_service),
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    assert_user_match(token_profile["line_id"], request.user_id)
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="Extra Picks unlock was removed. Use Extra Vault after final pack export.",
    )

@router.post("/current/extra-picks/apply", status_code=status.HTTP_200_OK)
async def apply_current_extra_picks(
    request: ApplyExtraPicksRequest,
    user_service: UserService = Depends(get_user_service),
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    assert_user_match(token_profile["line_id"], request.user_id)
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="Extra Picks swapping was removed. Extra Vault is exported separately after final pack save.",
    )

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
    try:
        await user_service.require_final_pack_paid(user_id)
    except FinalPackPaymentRequiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=_payment_required_detail("final_pack_199", exc.state),
        ) from exc

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
    try:
        await user_service.require_final_pack_paid(user_id)
    except FinalPackPaymentRequiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=_payment_required_detail("final_pack_199", exc.state),
        ) from exc

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
    try:
        await user_service.require_final_pack_paid(user_id)
    except FinalPackPaymentRequiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=_payment_required_detail("final_pack_199", exc.state),
        ) from exc

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

@router.post("/current/finalize-export", status_code=status.HTTP_200_OK)
async def finalize_current_final_pack_export(
    request: FinalizeExportRequest,
    user_service: UserService = Depends(get_user_service),
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    """
    Mark final pack export as completed after the frontend download/share flow finishes.
    This unlocks the Extra Vault upsell window for 24 hours.
    """
    assert_user_match(token_profile["line_id"], request.user_id)
    try:
        result = await user_service.mark_final_pack_exported(request.user_id)
    except FinalPackPaymentRequiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=_payment_required_detail("final_pack_199", exc.state),
        ) from exc

    extra_vault = result.get("extra_vault") or []
    return {
        "status": "ok",
        "generation_state": result["generation_state"],
        "extra_vault_count": len(extra_vault),
        "extra_vault": _serialize_extra_vault(extra_vault, storage_client, expose_urls=True),
    }

@router.get("/current/extra-vault")
async def get_current_extra_vault(
    user_id: str = Query(..., min_length=3),
    user_service: UserService = Depends(get_user_service),
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    assert_user_match(token_profile["line_id"], user_id)
    result = await user_service.get_extra_vault(user_id)
    state = result["generation_state"]
    extra_vault = result.get("extra_vault") or []
    expose_urls = bool(state.get("final_pack_exported")) and not result.get("extra_vault_expired")
    return {
        "status": "ok",
        "generation_state": state,
        "extra_vault_expired": bool(result.get("extra_vault_expired")),
        "extra_vault_count": len(extra_vault),
        "extra_vault": _serialize_extra_vault(extra_vault, storage_client, expose_urls=expose_urls),
    }

@router.post("/current/extra-vault/download-url", status_code=status.HTTP_200_OK)
async def get_current_extra_vault_download_url(
    request: ExtraVaultExportRequest,
    user_service: UserService = Depends(get_user_service),
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    assert_user_match(token_profile["line_id"], request.user_id)
    try:
        vault_state = await user_service.require_extra_pack_paid(request.user_id)
    except ExtraPackPaymentRequiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=_payment_required_detail("extra_pack_99", exc.state),
        ) from exc

    state = vault_state["generation_state"]
    paid_selected_ids = state.get("extra_pack_selected_ids") or []
    selected_ids = paid_selected_ids or request.selected_extra_ids
    selected_items = _select_extra_vault_items(vault_state.get("extra_vault") or [], selected_ids)

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for position, item in enumerate(selected_items, start=1):
            blob_name = item.get("blob_name")
            if not blob_name:
                continue
            replaced_slot = item.get("replaced_from_slot")
            filename = f"extra-{position:02d}"
            if isinstance(replaced_slot, int):
                filename = f"{filename}-slot-{replaced_slot + 1:02d}"
            blob = storage_client.bucket.blob(blob_name)
            archive.writestr(f"{filename}.png", blob.download_as_bytes())

    buffer.seek(0)
    display_name = await user_service.get_display_name(request.user_id) or request.user_id
    filename = f"extra_stickers_{_sanitize_filename(display_name)}.zip"
    blob_name = f"users/{request.user_id}/downloads/{uuid.uuid4()}-extras.zip"

    url = storage_client.upload_file(
        file_bytes=buffer.getvalue(),
        destination_blob_name=blob_name,
        content_type="application/zip",
        response_disposition=f"attachment; filename={filename}",
        response_type="application/zip",
    )

    return {
        "status": "ok",
        "url": url,
        "selected_extra_ids": [item["id"] for item in selected_items],
        "generation_state": state,
    }

@router.get("/current/extra-vault/share-file")
async def get_current_extra_vault_share_file(
    user_id: str = Query(..., min_length=3),
    extra_id: str = Query(..., min_length=1),
    user_service: UserService = Depends(get_user_service),
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    """
    Stream one paid Extra Vault PNG for mobile share/save flows.
    """
    assert_user_match(token_profile["line_id"], user_id)
    try:
        vault_state = await user_service.require_extra_pack_paid(user_id)
    except ExtraPackPaymentRequiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=_payment_required_detail("extra_pack_99", exc.state),
        ) from exc

    state = vault_state["generation_state"]
    paid_selected_ids = state.get("extra_pack_selected_ids") or []
    if paid_selected_ids and extra_id not in paid_selected_ids:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Extra sticker was not selected for this pack.")

    selected_items = _select_extra_vault_items(vault_state.get("extra_vault") or [], [extra_id])
    item = selected_items[0]
    blob_name = item.get("blob_name")
    if not blob_name:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Extra sticker blob is unavailable.")

    blob = storage_client.bucket.blob(blob_name)
    try:
        sticker_bytes = blob.download_as_bytes()
    except Exception as exc:
        logger.error("Failed to download extra sticker blob %s for share: %s", blob_name, exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Failed to prepare extra sticker file.") from exc

    headers = {
        "Content-Disposition": f'inline; filename="extra-sticker-{extra_id}.png"',
        "Cache-Control": "no-store",
    }
    return StreamingResponse(BytesIO(sticker_bytes), media_type="image/png", headers=headers)

@router.post("/current/extra-vault/finalize-export", status_code=status.HTTP_200_OK)
async def finalize_current_extra_vault_export(
    request: FinalizeExportRequest,
    user_service: UserService = Depends(get_user_service),
    token_profile: dict = Depends(get_line_profile),
):
    """
    Mark Extra Vault export as completed after frontend save/share/download flow finishes.
    """
    assert_user_match(token_profile["line_id"], request.user_id)
    try:
        generation_state = await user_service.mark_extra_pack_exported(request.user_id)
    except ExtraPackPaymentRequiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=_payment_required_detail("extra_pack_99", exc.state),
        ) from exc

    return {
        "status": "ok",
        "generation_state": generation_state,
    }

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
            "generation_state": data.get("generation_state"),
            "extra_vault_item_count": int(data.get("extra_vault_item_count") or 0),
        }
        if data.get("grid_blob"):
            response["grid_url"] = storage_client.generate_signed_url(data["grid_blob"])
        return response

    if status_value == "failed":
        response = {
            "status": "failed",
            "job_id": job_id,
            "error": data.get("error", "Unknown error"),
            "generation_state": data.get("generation_state"),
        }
        if data.get("grid_blob"):
            response["grid_url"] = storage_client.generate_signed_url(data["grid_blob"])
        return response

    response = {
        "status": status_value or "queued",
        "job_id": job_id,
        "generation_state": data.get("generation_state"),
    }
    if data.get("grid_blob"):
        response["grid_url"] = storage_client.generate_signed_url(data["grid_blob"])
    return response

@router.get("/{job_id}/download")
async def download_sticker_zip(
    job_id: str,
    user_id: str = Query(..., min_length=3),
    user_service: UserService = Depends(get_user_service),
    storage_client: StorageClient = Depends(get_storage_client),
    token_profile: dict = Depends(get_line_profile),
):
    """
    Download all generated stickers for a job as a ZIP file.
    """
    assert_user_match(token_profile["line_id"], user_id)
    try:
        await user_service.require_final_pack_paid(user_id)
    except FinalPackPaymentRequiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=_payment_required_detail("final_pack_199", exc.state),
        ) from exc

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
