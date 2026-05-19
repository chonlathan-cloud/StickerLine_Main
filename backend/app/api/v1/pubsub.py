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


def _normalize_datetime(value: Any) -> datetime | None:
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _processing_age_seconds(job_data: dict, now: datetime) -> float | None:
    started_at = _normalize_datetime(job_data.get("processing_started_at"))
    if started_at is None:
        started_at = _normalize_datetime(job_data.get("worker_last_claimed_at"))
    if started_at is None:
        started_at = _normalize_datetime(job_data.get("updated_at"))
    if started_at is None:
        return None
    return max(0.0, (now - started_at).total_seconds())


def _is_stale_processing_job(job_data: dict, now: datetime) -> tuple[bool, float | None]:
    threshold = max(0, int(settings.WORKER_STALE_PROCESSING_SECONDS))
    if threshold == 0:
        return False, None

    age_seconds = _processing_age_seconds(job_data, now)
    if age_seconds is None:
        return False, None
    return age_seconds >= threshold, age_seconds


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
        now = _utc_now()
        claim_status = "claimed"
        stale_age_seconds = None

        if current_status == "processing":
            is_stale, stale_age_seconds = _is_stale_processing_job(job_data, now)
            if not is_stale:
                return {
                    "claim_status": "retry_later",
                    "current_status": current_status,
                    "job_data": job_data,
                    "reason": "already_processing",
                    "processing_age_seconds": stale_age_seconds,
                }
            claim_status = "stale_reclaimed"
        elif current_status != "queued":
            return {
                "claim_status": "ignored",
                "current_status": current_status,
                "job_data": job_data,
                "reason": "non_claimable_status",
            }

        update_data = {
            "status": "processing",
            "processing_started_at": now,
            "updated_at": now,
            "worker_attempt": firestore.Increment(1),
            "worker_last_claimed_at": now,
            "worker_claim_source": "pubsub_push",
            "worker_claim_status": claim_status,
        }
        if claim_status == "stale_reclaimed":
            update_data["stale_reclaimed_at"] = now
            update_data["stale_reclaim_count"] = firestore.Increment(1)
            if stale_age_seconds is not None:
                update_data["stale_processing_age_seconds"] = int(stale_age_seconds)
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
            if key not in {"worker_attempt", "stale_reclaim_count"}
        })
        return {
            "claim_status": claim_status,
            "current_status": "processing",
            "job_data": job_data,
        }

    return await atomic_claim(transaction, job_ref)


async def _mark_job_failed(job_id: str, error: str, details: str | None = None) -> None:
    failed_at = _utc_now()
    update_data = {
        "status": "failed",
        "error": error,
        "last_error": details or error,
        "failed_at": failed_at,
        "updated_at": failed_at,
    }
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

    if claim_status == "retry_later":
        logger.info(
            "Pub/Sub delivery for job %s is already processing; asking Pub/Sub to retry later",
            job_id,
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "status": "retry_later",
                "job_id": job_id,
                "current_status": current_status,
                "message_id": message_id,
                "reason": claim.get("reason"),
                "processing_age_seconds": claim.get("processing_age_seconds"),
            },
        )

    if claim_status == "ignored":
        logger.info(
            "Ignoring Pub/Sub delivery for job %s with status %s: %s",
            job_id,
            current_status,
            claim.get("reason"),
        )
        return {
            "status": "ignored",
            "job_id": job_id,
            "current_status": current_status,
            "message_id": message_id,
            "reason": claim.get("reason"),
        }
    if claim_status == "stale_reclaimed":
        logger.warning("Reclaimed stale processing job %s from Pub/Sub delivery %s", job_id, message_id)

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
