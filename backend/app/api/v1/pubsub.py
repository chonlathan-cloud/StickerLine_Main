import base64
import binascii
import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, HTTPException, status
from google.cloud import firestore
from pydantic import ValidationError

from app.core.config import settings
from app.models.sticker import StickerGenerateRequest
from app.services.pubsub_service import GENERATION_JOB_SCHEMA_VERSION
from app.utils.firestore import get_db

logger = logging.getLogger(__name__)
router = APIRouter()


class PubSubMessageError(ValueError):
    pass


def _utc_now():
    return datetime.now(timezone.utc)


def _get_jobs_collection():
    return get_db().collection("jobs")


def _parse_delivery_attempt(value: Any) -> int | None:
    if value is None:
        return None
    try:
        attempt = int(value)
    except (TypeError, ValueError):
        return None
    return attempt if attempt > 0 else None


def _decode_generation_message(envelope: dict) -> tuple[dict, str | None, int | None]:
    if not isinstance(envelope, dict):
        raise PubSubMessageError("Pub/Sub envelope must be a JSON object.")

    message = envelope.get("message")
    if not isinstance(message, dict):
        raise PubSubMessageError("Pub/Sub envelope missing message object.")

    encoded_data = message.get("data")
    if not isinstance(encoded_data, str) or not encoded_data:
        raise PubSubMessageError("Pub/Sub message missing base64 data.")

    try:
        raw_data = base64.b64decode(encoded_data.encode("utf-8"), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise PubSubMessageError("Pub/Sub message data is not valid base64.") from exc

    try:
        payload = json.loads(raw_data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PubSubMessageError("Pub/Sub message data is not valid JSON.") from exc

    if not isinstance(payload, dict):
        raise PubSubMessageError("Pub/Sub message payload must be a JSON object.")

    if payload.get("schema_version") != GENERATION_JOB_SCHEMA_VERSION:
        raise PubSubMessageError("Unsupported generation message schema version.")

    job_id = payload.get("job_id")
    if not isinstance(job_id, str) or not job_id.strip():
        raise PubSubMessageError("Generation message missing job_id.")
    payload["job_id"] = job_id.strip()

    user_id = payload.get("user_id")
    if user_id is not None and (not isinstance(user_id, str) or not user_id.strip()):
        raise PubSubMessageError("Generation message user_id must be a string.")
    if isinstance(user_id, str):
        payload["user_id"] = user_id.strip()

    cycle_id = payload.get("cycle_id")
    if cycle_id is not None and (not isinstance(cycle_id, str) or not cycle_id.strip()):
        raise PubSubMessageError("Generation message cycle_id must be a string or null.")
    if isinstance(cycle_id, str):
        payload["cycle_id"] = cycle_id.strip()

    message_id = message.get("messageId") or message.get("message_id")
    delivery_attempt = _parse_delivery_attempt(envelope.get("deliveryAttempt") or envelope.get("delivery_attempt"))
    return payload, message_id, delivery_attempt


async def _claim_generation_job(
    job_id: str,
    payload: dict,
    message_id: str | None,
    delivery_attempt: int | None,
) -> dict:
    transaction = get_db().transaction()
    job_ref = _get_jobs_collection().document(job_id)

    @firestore.async_transactional
    async def atomic_claim(transaction, job_ref):
        snapshot = await job_ref.get(transaction=transaction)
        if not snapshot.exists:
            return {
                "claim_status": "missing",
                "current_status": None,
                "job_data": None,
            }

        job_data = snapshot.to_dict() or {}
        current_status = job_data.get("status")
        if current_status != "queued":
            return {
                "claim_status": "ignored",
                "current_status": current_status,
                "job_data": job_data,
            }

        now = _utc_now()
        update_data = {
            "status": "processing",
            "processing_started_at": now,
            "updated_at": now,
            "worker_attempt": firestore.Increment(1),
            "worker_last_claimed_at": now,
            "worker_claim_source": "pubsub_push",
        }
        if message_id:
            update_data["pubsub_message_id"] = message_id
        if delivery_attempt is not None:
            update_data["pubsub_delivery_attempt"] = delivery_attempt
        if payload.get("schema_version") is not None:
            update_data["pubsub_schema_version"] = payload["schema_version"]

        transaction.update(job_ref, update_data)
        job_data.update({
            key: value
            for key, value in update_data.items()
            if key != "worker_attempt"
        })
        return {
            "claim_status": "claimed",
            "current_status": "processing",
            "job_data": job_data,
        }

    return await atomic_claim(transaction, job_ref)


async def _mark_job_failed(job_id: str, error: str, details: str | None = None) -> None:
    failed_at = _utc_now()
    update_data = {
        "status": "failed",
        "error": error,
        "failed_at": failed_at,
        "updated_at": failed_at,
    }
    if details:
        update_data["last_error"] = details
    await _get_jobs_collection().document(job_id).update(update_data)


def _build_request_from_job(job_id: str, job_data: dict, payload: dict) -> StickerGenerateRequest:
    job_user_id = job_data.get("user_id")
    payload_user_id = payload.get("user_id")
    if payload_user_id and job_user_id and payload_user_id != job_user_id:
        raise PubSubMessageError("Pub/Sub user_id does not match job document.")

    job_cycle_id = job_data.get("cycle_id")
    payload_cycle_id = payload.get("cycle_id")
    if payload_cycle_id and job_cycle_id and payload_cycle_id != job_cycle_id:
        raise PubSubMessageError("Pub/Sub cycle_id does not match job document.")

    request_payload = job_data.get("request_payload")
    if not isinstance(request_payload, dict):
        raise PubSubMessageError("Job document missing request_payload.")

    try:
        request = StickerGenerateRequest(**request_payload)
    except ValidationError as exc:
        raise PubSubMessageError("Job request_payload is invalid.") from exc

    if job_user_id and request.user_id != job_user_id:
        raise PubSubMessageError("Job request_payload user_id does not match job document.")

    return request


@router.post("/push", status_code=status.HTTP_200_OK)
async def handle_pubsub_push(envelope: dict = Body(...)):
    if not settings.ENABLE_PUBSUB_WORKER_ENDPOINT:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pub/Sub worker endpoint is disabled.")

    try:
        payload, message_id, delivery_attempt = _decode_generation_message(envelope)
    except PubSubMessageError as exc:
        logger.warning("Rejected invalid Pub/Sub generation message: %s", exc)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    job_id = payload["job_id"]
    claim = await _claim_generation_job(
        job_id=job_id,
        payload=payload,
        message_id=message_id,
        delivery_attempt=delivery_attempt,
    )

    claim_status = claim["claim_status"]
    current_status = claim["current_status"]

    if claim_status == "missing":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Job {job_id} not found.")

    if claim_status == "ignored":
        logger.info("Ignoring Pub/Sub delivery for job %s with status %s", job_id, current_status)
        return {
            "status": "ignored",
            "job_id": job_id,
            "current_status": current_status,
            "message_id": message_id,
        }

    job_data = claim["job_data"] or {}
    try:
        request = _build_request_from_job(job_id, job_data, payload)
    except PubSubMessageError as exc:
        logger.error("Cannot process claimed job %s: %s", job_id, exc)
        await _mark_job_failed(job_id, "invalid_generation_job", str(exc))
        return {
            "status": "failed",
            "job_id": job_id,
            "error": "invalid_generation_job",
        }

    from app.services.ai_service import AIService
    from app.services.generation_job_processor import process_generation_job
    from app.services.image_service import ImageProcessor
    from app.services.user_service import UserService
    from app.utils.storage import StorageClient

    await process_generation_job(
        job_id=job_id,
        request=request,
        user_service=UserService(),
        ai_service=AIService(),
        image_processor=ImageProcessor(),
        storage_client=StorageClient(),
        mark_queued=False,
    )

    return {
        "status": "processed",
        "job_id": job_id,
        "message_id": message_id,
    }
