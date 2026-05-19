import asyncio
import logging
import random
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator

from google.cloud import firestore

from app.core.config import settings
from app.utils.firestore import get_db

logger = logging.getLogger(__name__)

CAPACITY_COLLECTION = "_system"
CAPACITY_DOCUMENT = "ai_provider_capacity"
AI_CAPACITY_ERROR_CODE = "ai_capacity_exhausted"
AI_CAPACITY_USER_MESSAGE = "ระบบหนาแน่น กรุณารอ 5 นาที แล้วลองใหม่"
AI_CAPACITY_RETRY_AFTER_SECONDS = 300


class AIProviderCapacityError(RuntimeError):
    def __init__(
        self,
        message: str = AI_CAPACITY_USER_MESSAGE,
        retry_after_seconds: int = AI_CAPACITY_RETRY_AFTER_SECONDS,
    ) -> None:
        self.error_code = AI_CAPACITY_ERROR_CODE
        self.retry_after_seconds = retry_after_seconds
        super().__init__(message)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _is_transaction_contention_error(exc: Exception) -> bool:
    return "failed to commit transaction" in str(exc).lower()


class AIProviderCapacityLimiter:
    def __init__(self, provider: str, model_id: str) -> None:
        self.provider = provider
        self.model_id = model_id
        self.limit = max(0, settings.AI_PROVIDER_MAX_CONCURRENT_CALLS)
        self.lease_seconds = max(60, settings.AI_PROVIDER_CAPACITY_LEASE_SECONDS)
        self.wait_timeout_seconds = max(0.0, settings.AI_PROVIDER_CAPACITY_WAIT_TIMEOUT_SECONDS)
        self.poll_seconds = max(0.1, settings.AI_PROVIDER_CAPACITY_POLL_SECONDS)
        self.lease_id = uuid.uuid4().hex

    @property
    def enabled(self) -> bool:
        return self.limit > 0

    async def acquire(self) -> str | None:
        if not self.enabled:
            return None

        deadline = time.monotonic() + self.wait_timeout_seconds
        waited = False
        while True:
            try:
                if await self._try_acquire():
                    if waited:
                        logger.info("Acquired AI provider capacity lease after waiting.")
                    return self.lease_id
            except Exception as exc:
                if not _is_transaction_contention_error(exc):
                    raise
                logger.info("AI provider capacity lease transaction conflicted; retrying.")

            if time.monotonic() >= deadline:
                raise AIProviderCapacityError()

            waited = True
            await asyncio.sleep(self.poll_seconds + random.uniform(0, self.poll_seconds * 0.25))

    async def release(self) -> None:
        if not self.enabled:
            return

        try:
            await self._release()
        except Exception:
            logger.exception("Failed to release AI provider capacity lease %s", self.lease_id)

    async def _try_acquire(self) -> bool:
        db = get_db()
        doc_ref = db.collection(CAPACITY_COLLECTION).document(CAPACITY_DOCUMENT)
        transaction = db.transaction(max_attempts=max(5, settings.FIRESTORE_TRANSACTION_MAX_ATTEMPTS))
        now = _utc_now()
        expires_at = now + timedelta(seconds=self.lease_seconds)
        lease_id = self.lease_id

        @firestore.async_transactional
        async def atomic_acquire(transaction, doc_ref):
            snapshot = await doc_ref.get(transaction=transaction)
            data = snapshot.to_dict() if snapshot.exists else {}
            leases = self._valid_leases(data.get("leases") if data else {}, now)
            if len(leases) >= self.limit:
                transaction.set(
                    doc_ref,
                    {
                        "active_count": len(leases),
                        "limit": self.limit,
                        "updated_at": now,
                        "leases": leases,
                    },
                )
                return False

            leases[lease_id] = {
                "provider": self.provider,
                "model_id": self.model_id,
                "claimed_at": now,
                "expires_at": expires_at,
            }
            transaction.set(
                doc_ref,
                {
                    "active_count": len(leases),
                    "limit": self.limit,
                    "updated_at": now,
                    "leases": leases,
                },
            )
            return True

        return await atomic_acquire(transaction, doc_ref)

    async def _release(self) -> None:
        db = get_db()
        doc_ref = db.collection(CAPACITY_COLLECTION).document(CAPACITY_DOCUMENT)
        transaction = db.transaction(max_attempts=max(5, settings.FIRESTORE_TRANSACTION_MAX_ATTEMPTS))
        now = _utc_now()
        lease_id = self.lease_id

        @firestore.async_transactional
        async def atomic_release(transaction, doc_ref):
            snapshot = await doc_ref.get(transaction=transaction)
            if not snapshot.exists:
                return

            data = snapshot.to_dict() or {}
            leases = self._valid_leases(data.get("leases"), now)
            leases.pop(lease_id, None)
            transaction.set(
                doc_ref,
                {
                    "active_count": len(leases),
                    "limit": self.limit,
                    "updated_at": now,
                    "leases": leases,
                },
            )

        await atomic_release(transaction, doc_ref)

    @staticmethod
    def _valid_leases(raw_leases: Any, now: datetime) -> dict[str, dict]:
        if not isinstance(raw_leases, dict):
            return {}

        leases: dict[str, dict] = {}
        for lease_id, lease_data in raw_leases.items():
            if not isinstance(lease_id, str) or not isinstance(lease_data, dict):
                continue
            expires_at = lease_data.get("expires_at")
            if not isinstance(expires_at, datetime):
                continue
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            else:
                expires_at = expires_at.astimezone(timezone.utc)
            if expires_at <= now:
                continue
            leases[lease_id] = lease_data
        return leases


@asynccontextmanager
async def ai_provider_capacity_limiter(provider: str, model_id: str) -> AsyncIterator[None]:
    limiter = AIProviderCapacityLimiter(provider=provider, model_id=model_id)
    lease_id = await limiter.acquire()
    try:
        yield
    finally:
        if lease_id:
            await limiter.release()
