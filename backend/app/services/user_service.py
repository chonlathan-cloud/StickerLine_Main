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
