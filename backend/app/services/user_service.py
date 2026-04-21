import logging
from datetime import datetime, timezone
from google.cloud import firestore
from app.utils.firestore import get_db
from app.models.user import UserCreate, UserInDB

logger = logging.getLogger(__name__)

class InsufficientCoinsError(Exception):
    pass

class UserService:
    def __init__(self):
        self.db = get_db()
        self.users_collection = self.db.collection('users')

    async def sync_user(self, line_profile: UserCreate) -> dict:
        """
        Check if user exists. If not, create new user with 2 free coins.
        If exists, update info and return.
        """
        user_ref = self.users_collection.document(line_profile.line_id)
        user_doc = await user_ref.get()

        if not user_doc.exists:
            # Create new user based on Business Rules (Grant 2 Free Coins)
            new_user = UserInDB(
                line_id=line_profile.line_id,
                display_name=line_profile.display_name,
                picture_url=line_profile.picture_url,
                coin_balance=2,
                total_spent_thb=0.0,
                is_free_trial_used=True,
                current_stickers=[],
                current_stickers_job_id=None,
                current_stickers_updated_at=None,
                current_extra_picks=[],
                current_extra_picks_job_id=None,
                current_extra_picks_unlocked=False,
                current_extra_picks_updated_at=None,
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc)
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
                "updated_at": datetime.now(timezone.utc)
            }
            await user_ref.update(update_data)
            
            user_data = user_doc.to_dict()
            # Merge updated fields for immediate response reflection
            user_data.update(update_data)
            logger.info(f"Updated existing user: {line_profile.line_id}")
            return user_data

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
        now = datetime.now(timezone.utc)
        await user_ref.update({
            "current_stickers": slots,
            "current_stickers_job_id": job_id,
            "current_stickers_updated_at": now,
            "current_extra_picks": extra_picks,
            "current_extra_picks_job_id": job_id,
            "current_extra_picks_unlocked": extra_picks_unlocked,
            "current_extra_picks_updated_at": now,
            "updated_at": now,
        })

    async def reset_current_stickers(self, user_id: str) -> None:
        """
        Clear the current sticker set when a new source image is uploaded.
        """
        await self.set_current_generation_state(user_id, [], None, [], False)

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

    async def deduct_coin(self, user_id: str, amount: int = 1) -> int:
        """
        Deduct coin from user using atomic transaction to prevent race conditions.
        """
        transaction = self.db.transaction()
        user_ref = self.users_collection.document(user_id)

        @firestore.async_transactional
        async def atomic_deduct(transaction, user_ref, amount):
            snapshot = await user_ref.get(transaction=transaction)
            if not snapshot.exists:
                raise ValueError(f"User {user_id} not found")
            
            balance = snapshot.get("coin_balance")
            if balance < amount:
                raise InsufficientCoinsError(f"Not enough coins. Balance: {balance}, Required: {amount}")
            
            new_balance = balance - amount
            transaction.update(user_ref, {
                "coin_balance": new_balance,
                "updated_at": datetime.now(timezone.utc)
            })
            return new_balance

        try:
            new_balance = await atomic_deduct(transaction, user_ref, amount)
            logger.info(f"Deducted {amount} coins from {user_id}. New balance: {new_balance}")
            return new_balance
        except Exception as e:
            logger.error(f"Failed to deduct coin for {user_id}: {e}")
            raise
    
    async def refund_coin(self, user_id: str, amount: int = 1) -> int:
        """
        Refund coin to user using atomic transaction to prevent race conditions.
        Used as a rollback mechanism when generation fails.
        """
        transaction = self.db.transaction()
        user_ref = self.users_collection.document(user_id)

        @firestore.async_transactional
        async def atomic_refund(transaction, user_ref, amount):
            snapshot = await user_ref.get(transaction=transaction)
            if not snapshot.exists:
                raise ValueError(f"User {user_id} not found")
            
            balance = snapshot.get("coin_balance")
            new_balance = balance + amount
            transaction.update(user_ref, {
                "coin_balance": new_balance,
                "updated_at": datetime.now(timezone.utc)
            })
            return new_balance

        try:
            new_balance = await atomic_refund(transaction, user_ref, amount)
            logger.info(f"Refunded {amount} coins to {user_id}. New balance: {new_balance}")
            return new_balance
        except Exception as e:
            logger.error(f"Failed to refund coin for {user_id}: {e}")
            raise

    async def top_up_coin(self, user_id: str, coins: int, thb_amount: float, reference_id: str) -> dict:
        """
        Top up coins and total spent THB using an atomic transaction.
        Also logs the transaction in the 'transactions' collection.
        """
        transaction = self.db.transaction()
        user_ref = self.users_collection.document(user_id)
        
        # Auto-generate a transaction ID
        txn_ref = self.db.collection('transactions').document()

        @firestore.async_transactional
        async def atomic_top_up(transaction, user_ref, txn_ref, coins, thb_amount, reference_id):
            snapshot = await user_ref.get(transaction=transaction)
            if not snapshot.exists:
                raise ValueError(f"User {user_id} not found")
            
            # Update user balances
            data = snapshot.to_dict() or {}
            current_coins = data.get("coin_balance", 0)
            current_spent = data.get("total_spent_thb", 0.0)
            
            new_coins = current_coins + coins
            new_spent = current_spent + thb_amount
            
            now_utc = datetime.now(timezone.utc)
            
            transaction.update(user_ref, {
                "coin_balance": new_coins,
                "total_spent_thb": new_spent,
                "updated_at": now_utc
            })
            
            # Log the transaction
            transaction.set(txn_ref, {
                "txn_id": txn_ref.id,
                "user_id": user_id,
                "type": "topup",
                "amount": coins,
                "reference_id": reference_id,
                "timestamp": now_utc
            })
            
            return {
                "coin_balance": new_coins,
                "total_spent_thb": new_spent
            }

        try:
            result = await atomic_top_up(transaction, user_ref, txn_ref, coins, thb_amount, reference_id)
            logger.info(f"Top-up successful for {user_id}. Added {coins} coins for {thb_amount} THB.")
            return result
        except Exception as e:
            logger.error(f"Failed to top up coin for {user_id}: {e}")
            raise

    async def unlock_current_extra_picks(self, user_id: str, amount: int = 1) -> int:
        transaction = self.db.transaction()
        user_ref = self.users_collection.document(user_id)

        @firestore.async_transactional
        async def atomic_unlock(transaction, user_ref, amount):
            snapshot = await user_ref.get(transaction=transaction)
            if not snapshot.exists:
                raise ValueError(f"User {user_id} not found")

            data = snapshot.to_dict() or {}
            extra_picks = data.get("current_extra_picks") or []
            if not extra_picks:
                raise ValueError("No extra picks available for this session.")
            if bool(data.get("current_extra_picks_unlocked", False)):
                return int(data.get("coin_balance", 0))

            balance = int(data.get("coin_balance", 0))
            if balance < amount:
                raise InsufficientCoinsError(f"Not enough coins. Balance: {balance}, Required: {amount}")

            new_balance = balance - amount
            now = datetime.now(timezone.utc)
            transaction.update(user_ref, {
                "coin_balance": new_balance,
                "current_extra_picks_unlocked": True,
                "current_extra_picks_updated_at": now,
                "updated_at": now,
            })
            return new_balance

        new_balance = await atomic_unlock(transaction, user_ref, amount)
        logger.info("Unlocked extra picks for %s. New balance: %s", user_id, new_balance)
        return new_balance

    async def apply_current_extra_picks(self, user_id: str, selected_indices: list[int]) -> dict:
        transaction = self.db.transaction()
        user_ref = self.users_collection.document(user_id)
        normalized_indices = sorted({idx for idx in selected_indices if isinstance(idx, int) and idx >= 0})

        @firestore.async_transactional
        async def atomic_apply(transaction, user_ref, normalized_indices):
            snapshot = await user_ref.get(transaction=transaction)
            if not snapshot.exists:
                raise ValueError(f"User {user_id} not found")

            data = snapshot.to_dict() or {}
            if not bool(data.get("current_extra_picks_unlocked", False)):
                raise ValueError("Extra picks are locked.")

            current_stickers = [slot for slot in (data.get("current_stickers") or []) if isinstance(slot, dict)]
            current_extra_picks = [pick for pick in (data.get("current_extra_picks") or []) if isinstance(pick, dict)]

            slots_by_index = {
                int(slot.get("index")): dict(slot)
                for slot in current_stickers
                if isinstance(slot.get("index"), int)
            }
            extra_by_index = {
                int(pick.get("index")): dict(pick)
                for pick in current_extra_picks
                if isinstance(pick.get("index"), int)
            }

            for index in normalized_indices:
                slot = slots_by_index.get(index)
                extra = extra_by_index.get(index)
                if slot is None or extra is None:
                    continue
                slot_blob = slot.get("blob_name")
                extra_blob = extra.get("blob_name")
                if not slot_blob or not extra_blob:
                    continue
                slot["blob_name"], extra["blob_name"] = extra_blob, slot_blob
                slots_by_index[index] = slot
                extra_by_index[index] = extra

            updated_slots = sorted(slots_by_index.values(), key=lambda item: int(item.get("index", 9999)))
            updated_extras = sorted(extra_by_index.values(), key=lambda item: int(item.get("index", 9999)))
            now = datetime.now(timezone.utc)
            transaction.update(user_ref, {
                "current_stickers": updated_slots,
                "current_stickers_updated_at": now,
                "current_extra_picks": updated_extras,
                "current_extra_picks_updated_at": now,
                "updated_at": now,
            })
            return {
                "current_stickers": updated_slots,
                "current_extra_picks": updated_extras,
                "current_stickers_job_id": data.get("current_stickers_job_id"),
                "current_extra_picks_unlocked": bool(data.get("current_extra_picks_unlocked", False)),
            }

        result = await atomic_apply(transaction, user_ref, normalized_indices)
        logger.info("Applied extra picks for %s on indices %s", user_id, normalized_indices)
        return result
