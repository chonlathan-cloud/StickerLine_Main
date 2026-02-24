import hmac
import hashlib
import logging
from app.core.config import settings
from app.services.user_service import UserService

logger = logging.getLogger(__name__)

class PaymentService:
    def __init__(self):
        self.user_service = UserService()
        # Usually Omise provides a webhook secret for signature verification, 
        # but the spec asks to use OMISE_SECRET_KEY for HMAC-SHA256
        self.secret = settings.OMISE_SECRET_KEY.encode('utf-8')

    def verify_signature(self, payload_bytes: bytes, signature: str) -> bool:
        """
        Verify the Omise Webhook Signature using HMAC-SHA256.
        """
        if not signature:
            return False
            
        # Calculate expected signature
        expected_signature = hmac.new(
            self.secret, 
            payload_bytes, 
            hashlib.sha256
        ).hexdigest()
        
        # Use secure comparison to prevent timing attacks
        return hmac.compare_digest(expected_signature, signature)

    async def process_webhook(self, payload: dict, signature: str, raw_payload: bytes):
        """
        Processes the Omise event webhook payload.
        """
        if not self.verify_signature(raw_payload, signature):
            logger.warning("Invalid Omise signature detected.")
            raise ValueError("Invalid Signature")

        event_key = payload.get("key")
        if event_key != "charge.complete":
            # Ignore other events
            logger.info(f"Ignoring non-charge.complete event: {event_key}")
            return
            
        data = payload.get("data", {})
        status = data.get("status")
        
        if status != "successful":
            logger.info(f"Ignoring unsuccessful charge with status: {status}")
            return
            
        # Extract charge details
        amount_satang = data.get("amount", 0)
        metadata = data.get("metadata", {})
        user_id = metadata.get("user_id")
        
        if not user_id:
            logger.error("No user_id found in charge metadata.")
            raise ValueError("user_id is missing in metadata")
            
        # Convert satang to THB
        thb_amount = amount_satang / 100.0
        
        # Calculate coins based on packages
        coins = self._calculate_coins(thb_amount)
        
        # Reference ID (for transaction logging)
        charge_id = data.get("id")
        
        # Top-up user coins
        await self.user_service.top_up_coin(
            user_id=user_id, 
            coins=coins, 
            thb_amount=thb_amount,
            reference_id=charge_id
        )
        
        logger.info(f"Successfully processed charge {charge_id} for user {user_id}: +{coins} coins")

    def _calculate_coins(self, thb_amount: float) -> int:
        """
        Business Logic for package conversions:
        - 70 THB -> 7 Coins
        - 100 THB -> 12 Coins (Bonus!)
        - Else -> Standard rate (10 THB = 1 Coin).
        """
        # Package matching (Using rough equality for floats)
        if abs(thb_amount - 100.0) < 0.01:
            return 12
        elif abs(thb_amount - 70.0) < 0.01:
            return 7
        else:
            return int(thb_amount // 10)
