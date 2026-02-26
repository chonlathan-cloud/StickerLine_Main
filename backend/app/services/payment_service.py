import hmac
import hashlib
import logging
from datetime import datetime, timezone
from typing import Dict, Tuple

import httpx

from app.core.config import settings
from app.services.user_service import UserService
from app.utils.firestore import get_db

logger = logging.getLogger(__name__)

class PaymentService:
    def __init__(self):
        self.user_service = UserService()
        self.db = get_db()
        # Usually Omise provides a webhook secret for signature verification, 
        # but the spec asks to use OMISE_SECRET_KEY for HMAC-SHA256
        self.secret = settings.OMISE_SECRET_KEY.encode('utf-8')
        self.omise_secret = settings.OMISE_SECRET_KEY
        self.omise_api_url = "https://api.omise.co/charges"

        self.packages: Dict[str, Tuple[int, int]] = {
            "pkg_70": (7000, 7),
            "pkg_100": (10000, 12),
        }

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

    async def process_webhook(self, payload: dict, signature: str, raw_payload: bytes) -> None:
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

        await self._mark_payment_success(charge_id, user_id, coins, thb_amount)
        
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

    async def create_promptpay_charge(self, user_id: str, package_id: str) -> dict:
        if package_id not in self.packages:
            raise ValueError("Invalid package_id. Allowed: pkg_70, pkg_100")

        amount_satang, coins = self.packages[package_id]
        payload = {
            "amount": amount_satang,
            "currency": "thb",
            "source[type]": "promptpay",
            "metadata[user_id]": user_id,
            "metadata[package_id]": package_id,
            "metadata[coins]": str(coins),
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                self.omise_api_url,
                data=payload,
                auth=(self.omise_secret, ""),
            )

        if response.status_code >= 400:
            logger.error(f"Omise charge creation failed: {response.status_code} {response.text}")
            raise ValueError("Failed to create payment charge")

        data = response.json()
        charge_id = data.get("id")
        status = data.get("status")
        source = data.get("source", {}) or {}
        scannable = source.get("scannable_code", {}) or {}
        image = scannable.get("image", {}) or {}
        qr_image_url = image.get("download_uri") or image.get("url")
        expires_at = scannable.get("expires_at")

        if not charge_id or not qr_image_url:
            logger.error(f"Omise response missing charge_id or qr image: {data}")
            raise ValueError("Invalid Omise response")

        now_utc = datetime.now(timezone.utc)
        payment_ref = self.db.collection("payments").document(charge_id)
        await payment_ref.set(
            {
                "charge_id": charge_id,
                "user_id": user_id,
                "package_id": package_id,
                "amount_satang": amount_satang,
                "thb_amount": amount_satang / 100.0,
                "coins": coins,
                "status": status or "pending",
                "qr_image_url": qr_image_url,
                "expires_at": expires_at,
                "created_at": now_utc,
                "updated_at": now_utc,
            }
        )

        return {
            "charge_id": charge_id,
            "status": status or "pending",
            "amount_satang": amount_satang,
            "coins": coins,
            "qr_image_url": qr_image_url,
            "expires_at": expires_at,
        }

    async def get_payment_status(self, charge_id: str) -> dict:
        payment_ref = self.db.collection("payments").document(charge_id)
        snapshot = await payment_ref.get()
        if not snapshot.exists:
            raise ValueError("Payment not found")
        data = snapshot.to_dict() or {}
        return {
            "charge_id": charge_id,
            "status": data.get("status", "pending"),
            "coins": data.get("coins", 0),
            "amount_satang": data.get("amount_satang", 0),
            "qr_image_url": data.get("qr_image_url"),
            "expires_at": data.get("expires_at"),
        }

    async def _mark_payment_success(
        self,
        charge_id: str,
        user_id: str,
        coins: int,
        thb_amount: float
    ) -> None:
        now_utc = datetime.now(timezone.utc)
        payment_ref = self.db.collection("payments").document(charge_id)
        await payment_ref.set(
            {
                "charge_id": charge_id,
                "user_id": user_id,
                "status": "success",
                "coins": coins,
                "thb_amount": thb_amount,
                "updated_at": now_utc,
            },
            merge=True,
        )
