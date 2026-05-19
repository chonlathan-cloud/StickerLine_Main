import logging
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from google.cloud import firestore
from app.core.config import settings
from app.utils.firestore import get_db
from app.models.user import UserCreate, UserInDB

logger = logging.getLogger(__name__)

GENERATION_LIMIT = 20
WARNING_START_ATTEMPT = 15
FINAL_PACK_PRODUCT_ID = "final_pack_199"
EXTRA_PACK_PRODUCT_ID = "extra_pack_99"
EXTRA_VAULT_TTL_HOURS = 24

class GenerationLimitReachedError(Exception):
    def __init__(self, state: dict):
        self.state = state
        super().__init__("Generation trial limit reached.")

class FinalPackPaymentRequiredError(Exception):
    def __init__(self, state: dict | None = None):
        self.state = state or {}
        super().__init__("Final pack payment is required before export.")

class ExtraPackPaymentRequiredError(Exception):
    def __init__(self, state: dict | None = None):
        self.state = state or {}
        super().__init__("Extra pack payment is required before export.")

class UserService:
    def __init__(self):
        self.db = get_db()
        self.users_collection = self.db.collection('users')

    def _now(self) -> datetime:
        return datetime.now(timezone.utc)

    def _new_cycle_id(self) -> str:
        return uuid4().hex

    def _transaction(self):
        return self.db.transaction(max_attempts=max(5, settings.FIRESTORE_TRANSACTION_MAX_ATTEMPTS))

    def _build_warning(self, generation_count: int, generation_limit: int = GENERATION_LIMIT) -> dict | None:
        remaining = max(generation_limit - generation_count, 0)
        if generation_count >= generation_limit:
            return {
                "level": "limit_reached",
                "message": "ครบโควต้าทดลองแล้ว ปลดล็อก 199 บาทเพื่อบันทึกสติกเกอร์ชุดนี้",
                "remaining": remaining,
            }
        if 18 <= generation_count <= 19:
            return {
                "level": "strong",
                "message": f"เหลืออีก {remaining} ครั้งเท่านั้น บันทึกชุดนี้ได้ด้วยแพ็ก 199 บาท",
                "remaining": remaining,
            }
        if WARNING_START_ATTEMPT <= generation_count <= 17:
            return {
                "level": "gentle",
                "message": f"ใกล้ครบโควต้าทดลองแล้ว เหลืออีก {remaining} ครั้งก่อนต้องปลดล็อกเพื่อบันทึกรูป",
                "remaining": remaining,
            }
        return None

    def _build_generation_state(self, data: dict) -> dict:
        generation_limit = int(data.get("generation_limit") or GENERATION_LIMIT)
        generation_count = int(data.get("generation_count") or 0)
        remaining = max(generation_limit - generation_count, 0)
        cooldown_until = data.get("generation_cooldown_until")
        locked_at = data.get("generation_locked_at")
        final_paid_at = data.get("final_pack_paid_at")
        final_exported_at = data.get("final_pack_exported_at")
        is_locked = bool(locked_at and not final_paid_at and remaining == 0)
        return {
            "cycle_id": data.get("current_cycle_id"),
            "generation_count": generation_count,
            "generation_limit": generation_limit,
            "remaining_attempts": remaining,
            "is_generation_locked": is_locked,
            "generation_locked_at": locked_at,
            "generation_cooldown_until": cooldown_until,
            "final_pack_paid": bool(final_paid_at),
            "final_pack_exported": bool(final_exported_at),
            "extra_pack_paid": bool(data.get("extra_pack_paid_at")),
            "extra_pack_exported": bool(data.get("extra_pack_exported_at")),
            "extra_pack_selected_ids": data.get("extra_pack_selected_ids") or [],
            "extra_vault_expires_at": data.get("extra_vault_expires_at"),
            "warning": self._build_warning(generation_count, generation_limit),
        }

    def _cycle_reset_update(self, now: datetime | None = None) -> dict:
        now = now or self._now()
        return {
            "current_cycle_id": self._new_cycle_id(),
            "generation_count": 0,
            "generation_limit": GENERATION_LIMIT,
            "generation_locked_at": None,
            "generation_cooldown_until": None,
            "current_stickers": [],
            "current_stickers_job_id": None,
            "current_stickers_updated_at": now,
            "extra_vault": [],
            "extra_vault_expires_at": None,
            "final_pack_paid_at": None,
            "final_pack_exported_at": None,
            "final_pack_payment_link_id": None,
            "extra_pack_paid_at": None,
            "extra_pack_exported_at": None,
            "extra_pack_payment_link_id": None,
            "extra_pack_selected_ids": [],
            "current_extra_picks": [],
            "current_extra_picks_job_id": None,
            "current_extra_picks_unlocked": False,
            "current_extra_picks_updated_at": now,
            "updated_at": now,
        }

    def _with_cycle_defaults(self, data: dict) -> dict:
        normalized = dict(data)
        normalized.setdefault("current_cycle_id", self._new_cycle_id())
        normalized.setdefault("generation_count", 0)
        normalized.setdefault("generation_limit", GENERATION_LIMIT)
        normalized.setdefault("generation_locked_at", None)
        normalized.setdefault("generation_cooldown_until", None)
        normalized.setdefault("current_stickers", [])
        normalized.setdefault("current_stickers_job_id", None)
        normalized.setdefault("extra_vault", normalized.get("current_extra_picks") or [])
        normalized.setdefault("extra_vault_expires_at", None)
        normalized.setdefault("final_pack_paid_at", None)
        normalized.setdefault("final_pack_exported_at", None)
        normalized.setdefault("extra_pack_paid_at", None)
        normalized.setdefault("extra_pack_exported_at", None)
        normalized.setdefault("extra_pack_selected_ids", [])
        return normalized

    async def sync_user(self, line_profile: UserCreate) -> dict:
        """
        Check if user exists. If not, create a new pay-on-save user profile.
        If exists, update info and return.
        """
        user_ref = self.users_collection.document(line_profile.line_id)
        user_doc = await user_ref.get()
        now = self._now()

        if not user_doc.exists:
            new_user = UserInDB(
                line_id=line_profile.line_id,
                display_name=line_profile.display_name,
                picture_url=line_profile.picture_url,
                coin_balance=0,
                total_spent_thb=0.0,
                is_free_trial_used=False,
                current_cycle_id=self._new_cycle_id(),
                generation_count=0,
                generation_limit=GENERATION_LIMIT,
                generation_locked_at=None,
                generation_cooldown_until=None,
                current_stickers=[],
                current_stickers_job_id=None,
                current_stickers_updated_at=None,
                extra_vault=[],
                extra_vault_expires_at=None,
                final_pack_paid_at=None,
                final_pack_exported_at=None,
                extra_pack_paid_at=None,
                extra_pack_exported_at=None,
                current_extra_picks=[],
                current_extra_picks_job_id=None,
                current_extra_picks_unlocked=False,
                current_extra_picks_updated_at=None,
                created_at=now,
                updated_at=now
            )
            user_data = new_user.model_dump()
            await user_ref.set(user_data)
            logger.info(f"Created new user: {line_profile.line_id}")
            return user_data
        else:
            # Update existing user info asynchronously
            update_data = {
                "display_name": line_profile.display_name,
                "picture_url": line_profile.picture_url,
                "updated_at": now
            }
            user_data = user_doc.to_dict()
            normalized = self._with_cycle_defaults(user_data or {})
            missing_cycle_fields = {
                key: value
                for key, value in normalized.items()
                if key not in (user_data or {})
                and key in {
                    "current_cycle_id",
                    "generation_count",
                    "generation_limit",
                    "generation_locked_at",
                    "generation_cooldown_until",
                    "extra_vault",
                    "extra_vault_expires_at",
                    "final_pack_paid_at",
                    "final_pack_exported_at",
                    "extra_pack_paid_at",
                    "extra_pack_exported_at",
                    "extra_pack_selected_ids",
                }
            }
            await user_ref.update({**missing_cycle_fields, **update_data})
            # Merge updated fields for immediate response reflection
            normalized.update(update_data)
            logger.info(f"Updated existing user: {line_profile.line_id}")
            return normalized

    async def get_current_stickers(self, user_id: str) -> tuple[list[dict], str | None]:
        """
        Fetch the user's current sticker set and associated job ID.
        Returns (slots, job_id). Slots may be empty if none exist.
        """
        user_ref = self.users_collection.document(user_id)
        snapshot = await user_ref.get()
        if not snapshot.exists:
            raise ValueError(f"User {user_id} not found")

        data = snapshot.to_dict() or {}
        slots = data.get("current_stickers") or []
        job_id = data.get("current_stickers_job_id")
        return slots, job_id

    async def get_cycle_state(self, user_id: str) -> dict:
        """
        Return normalized cycle state and reset an unpaid expired cooldown if needed.
        """
        user_ref = self.users_collection.document(user_id)
        snapshot = await user_ref.get()
        if not snapshot.exists:
            raise ValueError(f"User {user_id} not found")

        data = self._with_cycle_defaults(snapshot.to_dict() or {})
        now = self._now()
        cooldown_until = data.get("generation_cooldown_until")
        final_paid_at = data.get("final_pack_paid_at")
        if cooldown_until and not final_paid_at and cooldown_until <= now:
            reset_update = self._cycle_reset_update(now)
            await user_ref.update(reset_update)
            data.update(reset_update)

        return self._build_generation_state(data)

    async def prepare_generation_attempt(self, user_id: str) -> dict:
        """
        Atomically reserve one generation attempt for Generate or Regenerate.
        The 20th accepted attempt is allowed, then generation locks for the cycle.
        Later attempts are blocked until payment or cooldown reset.
        """
        transaction = self._transaction()
        user_ref = self.users_collection.document(user_id)

        @firestore.async_transactional
        async def atomic_prepare(transaction, user_ref):
            snapshot = await user_ref.get(transaction=transaction)
            if not snapshot.exists:
                raise ValueError(f"User {user_id} not found")

            now = self._now()
            data = self._with_cycle_defaults(snapshot.to_dict() or {})
            cooldown_until = data.get("generation_cooldown_until")
            final_paid_at = data.get("final_pack_paid_at")
            final_exported_at = data.get("final_pack_exported_at")

            if final_exported_at:
                reset_update = self._cycle_reset_update(now)
                data.update(reset_update)
                transaction.update(user_ref, reset_update)
            elif cooldown_until and not final_paid_at and cooldown_until <= now:
                reset_update = self._cycle_reset_update(now)
                data.update(reset_update)
                transaction.update(user_ref, reset_update)

            if data.get("final_pack_paid_at") and not data.get("final_pack_exported_at"):
                raise GenerationLimitReachedError(self._build_generation_state(data))

            generation_limit = int(data.get("generation_limit") or GENERATION_LIMIT)
            generation_count = int(data.get("generation_count") or 0)
            if generation_count >= generation_limit and not data.get("final_pack_paid_at"):
                lock_update = {}
                if not data.get("generation_locked_at"):
                    lock_update["generation_locked_at"] = now
                    lock_update["generation_cooldown_until"] = now + timedelta(hours=24)
                    lock_update["updated_at"] = now
                    data.update(lock_update)
                    transaction.update(user_ref, lock_update)
                raise GenerationLimitReachedError(self._build_generation_state(data))

            next_count = generation_count + 1
            update_data = {
                "generation_count": next_count,
                "generation_limit": generation_limit,
                "updated_at": now,
            }
            data["generation_count"] = next_count
            if next_count >= generation_limit:
                update_data["generation_locked_at"] = now
                update_data["generation_cooldown_until"] = now + timedelta(hours=24)
                data["generation_locked_at"] = update_data["generation_locked_at"]
                data["generation_cooldown_until"] = update_data["generation_cooldown_until"]

            transaction.update(user_ref, update_data)
            return self._build_generation_state(data)

        state = await atomic_prepare(transaction, user_ref)
        logger.info("Reserved generation attempt for %s: %s/%s", user_id, state["generation_count"], state["generation_limit"])
        return state

    async def set_current_stickers(self, user_id: str, slots: list[dict], job_id: str | None) -> None:
        """
        Persist the user's current sticker set in Firestore.
        """
        user_ref = self.users_collection.document(user_id)
        await user_ref.update({
            "current_stickers": slots,
            "current_stickers_job_id": job_id,
            "current_stickers_updated_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        })

    async def get_current_extra_picks(self, user_id: str) -> tuple[list[dict], str | None, bool]:
        user_ref = self.users_collection.document(user_id)
        snapshot = await user_ref.get()
        if not snapshot.exists:
            raise ValueError(f"User {user_id} not found")

        data = snapshot.to_dict() or {}
        picks = data.get("current_extra_picks") or []
        job_id = data.get("current_extra_picks_job_id")
        unlocked = bool(data.get("current_extra_picks_unlocked", False))
        return picks, job_id, unlocked

    async def set_current_generation_state(
        self,
        user_id: str,
        slots: list[dict],
        job_id: str | None,
        extra_picks: list[dict],
        extra_picks_unlocked: bool = False,
    ) -> None:
        user_ref = self.users_collection.document(user_id)
        transaction = self._transaction()

        @firestore.async_transactional
        async def atomic_set(transaction, user_ref):
            snapshot = await user_ref.get(transaction=transaction)
            if not snapshot.exists:
                raise ValueError(f"User {user_id} not found")

            data = self._with_cycle_defaults(snapshot.to_dict() or {})
            existing_vault = [item for item in (data.get("extra_vault") or []) if isinstance(item, dict)]
            new_vault_items = [item for item in (extra_picks or []) if isinstance(item, dict)]
            updated_vault = existing_vault + new_vault_items
            now = self._now()
            transaction.update(user_ref, {
                "current_stickers": slots,
                "current_stickers_job_id": job_id,
                "current_stickers_updated_at": now,
                "extra_vault": updated_vault,
                "current_extra_picks": updated_vault,
                "current_extra_picks_job_id": job_id,
                "current_extra_picks_unlocked": extra_picks_unlocked,
                "current_extra_picks_updated_at": now,
                "updated_at": now,
            })

        await atomic_set(transaction, user_ref)

    async def reset_current_stickers(self, user_id: str) -> None:
        """
        Clear the current cycle when a new source image is uploaded.
        """
        await self.reset_generation_cycle(user_id)

    async def reset_generation_cycle(self, user_id: str) -> dict:
        user_ref = self.users_collection.document(user_id)
        now = self._now()
        update_data = self._cycle_reset_update(now)
        await user_ref.update(update_data)
        return self._build_generation_state(update_data)

    async def refund_generation_attempt(self, user_id: str, cycle_id: str | None = None) -> dict:
        user_ref = self.users_collection.document(user_id)
        transaction = self._transaction()

        @firestore.async_transactional
        async def atomic_refund(transaction, user_ref):
            snapshot = await user_ref.get(transaction=transaction)
            if not snapshot.exists:
                raise ValueError(f"User {user_id} not found")

            data = self._with_cycle_defaults(snapshot.to_dict() or {})
            if cycle_id and data.get("current_cycle_id") != cycle_id:
                return {
                    "refunded": False,
                    "generation_state": self._build_generation_state(data),
                }

            generation_count = int(data.get("generation_count") or 0)
            if generation_count <= 0:
                return {
                    "refunded": False,
                    "generation_state": self._build_generation_state(data),
                }

            now = self._now()
            generation_limit = int(data.get("generation_limit") or GENERATION_LIMIT)
            next_count = max(0, generation_count - 1)
            update_data = {
                "generation_count": next_count,
                "updated_at": now,
            }
            if next_count < generation_limit and not data.get("final_pack_paid_at"):
                update_data["generation_locked_at"] = None
                update_data["generation_cooldown_until"] = None

            data.update(update_data)
            transaction.update(user_ref, update_data)
            return {
                "refunded": True,
                "generation_state": self._build_generation_state(data),
            }

        return await atomic_refund(transaction, user_ref)

    async def require_final_pack_paid(self, user_id: str) -> dict:
        state = await self.get_cycle_state(user_id)
        if not state.get("final_pack_paid"):
            raise FinalPackPaymentRequiredError(state)
        return state

    async def mark_final_pack_exported(self, user_id: str) -> dict:
        transaction = self._transaction()
        user_ref = self.users_collection.document(user_id)

        @firestore.async_transactional
        async def atomic_mark(transaction, user_ref):
            snapshot = await user_ref.get(transaction=transaction)
            if not snapshot.exists:
                raise ValueError(f"User {user_id} not found")

            data = self._with_cycle_defaults(snapshot.to_dict() or {})
            if not data.get("final_pack_paid_at"):
                raise FinalPackPaymentRequiredError(self._build_generation_state(data))

            now = self._now()
            update_data = {
                "final_pack_exported_at": now,
                "extra_vault_expires_at": now + timedelta(hours=EXTRA_VAULT_TTL_HOURS),
                "updated_at": now,
            }
            data.update(update_data)
            transaction.update(user_ref, update_data)
            payment_link_id = data.get("final_pack_payment_link_id")
            if payment_link_id:
                purchase_ref = self.db.collection("purchases").document(f"purchase_{payment_link_id}")
                transaction.set(purchase_ref, {"exported_at": now}, merge=True)
            return data

        data = await atomic_mark(transaction, user_ref)
        return {
            "generation_state": self._build_generation_state(data),
            "extra_vault": data.get("extra_vault") or [],
        }

    async def get_extra_vault(self, user_id: str) -> dict:
        user_ref = self.users_collection.document(user_id)
        snapshot = await user_ref.get()
        if not snapshot.exists:
            raise ValueError(f"User {user_id} not found")

        data = self._with_cycle_defaults(snapshot.to_dict() or {})
        now = self._now()
        expires_at = data.get("extra_vault_expires_at")
        if expires_at and expires_at <= now:
            return {
                "generation_state": self._build_generation_state(data),
                "extra_vault": [],
                "extra_vault_expired": True,
            }

        if not data.get("final_pack_exported_at"):
            return {
                "generation_state": self._build_generation_state(data),
                "extra_vault": [],
                "extra_vault_expired": False,
            }

        return {
            "generation_state": self._build_generation_state(data),
            "extra_vault": data.get("extra_vault") or [],
            "extra_vault_expired": False,
        }

    async def require_extra_pack_paid(self, user_id: str) -> dict:
        vault_state = await self.get_extra_vault(user_id)
        state = vault_state["generation_state"]
        if not state.get("extra_pack_paid"):
            raise ExtraPackPaymentRequiredError(state)
        if vault_state.get("extra_vault_expired"):
            raise ValueError("Extra Vault has expired.")
        return vault_state

    async def mark_extra_pack_exported(self, user_id: str) -> dict:
        transaction = self._transaction()
        user_ref = self.users_collection.document(user_id)

        @firestore.async_transactional
        async def atomic_mark(transaction, user_ref):
            snapshot = await user_ref.get(transaction=transaction)
            if not snapshot.exists:
                raise ValueError(f"User {user_id} not found")

            data = self._with_cycle_defaults(snapshot.to_dict() or {})
            if not data.get("extra_pack_paid_at"):
                raise ExtraPackPaymentRequiredError(self._build_generation_state(data))

            now = self._now()
            update_data = {
                "extra_pack_exported_at": now,
                "updated_at": now,
            }
            data.update(update_data)
            transaction.update(user_ref, update_data)
            payment_link_id = data.get("extra_pack_payment_link_id")
            if payment_link_id:
                purchase_ref = self.db.collection("purchases").document(f"purchase_{payment_link_id}")
                transaction.set(purchase_ref, {"exported_at": now}, merge=True)
            return data

        data = await atomic_mark(transaction, user_ref)
        return self._build_generation_state(data)

    async def record_purchase_entitlement(
        self,
        user_id: str,
        product_id: str,
        payment_link_id: str,
        amount_satang: int,
        selected_extra_ids: list[str] | None = None,
    ) -> None:
        user_ref = self.users_collection.document(user_id)
        now = self._now()
        update_data = {
            "total_spent_thb": firestore.Increment(amount_satang / 100.0),
            "updated_at": now,
        }
        if product_id == FINAL_PACK_PRODUCT_ID:
            update_data.update({
                "final_pack_paid_at": now,
                "final_pack_payment_link_id": payment_link_id,
            })
        elif product_id == EXTRA_PACK_PRODUCT_ID:
            update_data.update({
                "extra_pack_paid_at": now,
                "extra_pack_payment_link_id": payment_link_id,
                "extra_pack_selected_ids": selected_extra_ids or [],
            })
        else:
            raise ValueError(f"Unsupported product_id: {product_id}")

        await user_ref.update(update_data)

    async def get_display_name(self, user_id: str) -> str | None:
        user_ref = self.users_collection.document(user_id)
        snapshot = await user_ref.get()
        if not snapshot.exists:
            return None
        data = snapshot.to_dict() or {}
        display_name = data.get("display_name")
        if isinstance(display_name, str) and display_name.strip():
            return display_name.strip()
        return None
