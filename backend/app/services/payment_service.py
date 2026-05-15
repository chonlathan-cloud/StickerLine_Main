import base64
import hashlib
import hmac
import logging
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

import httpx
from google.cloud import firestore

from app.core.config import settings
from app.services.user_service import EXTRA_PACK_PRODUCT_ID, FINAL_PACK_PRODUCT_ID
from app.utils.firestore import get_db

logger = logging.getLogger(__name__)


class PaymentService:
    def __init__(self):
        self.db = get_db()
        self.beam_api_url = f"{settings.BEAM_BASE_URL.rstrip('/')}/api/v1/payment-links"
        self.products = {
            FINAL_PACK_PRODUCT_ID: {
                "amount_satang": 19900,
                "title": "Final Sticker Pack",
                "description": "Save final 16 stickers",
            },
            EXTRA_PACK_PRODUCT_ID: {
                "amount_satang": 9900,
                "title": "Extra Sticker Pack",
                "description": "Save up to 16 selected extra stickers",
            },
        }

    def _ensure_beam_configured(self) -> None:
        required = {
            "BEAM_MERCHANT_ID": settings.BEAM_MERCHANT_ID,
            "BEAM_API_KEY": settings.BEAM_API_KEY,
            "PAYMENT_REDIRECT_URL": settings.PAYMENT_REDIRECT_URL,
        }
        missing = [name for name, value in required.items() if not value]
        if missing:
            raise ValueError(f"Missing payment configuration: {', '.join(missing)}")

    def _ensure_beam_webhook_configured(self) -> None:
        if not settings.BEAM_WEBHOOK_HMAC_KEY:
            raise ValueError("Missing payment configuration: BEAM_WEBHOOK_HMAC_KEY")

    def _build_redirect_url(self) -> str:
        redirect_url = settings.PAYMENT_REDIRECT_URL
        if not redirect_url:
            raise ValueError("Missing payment configuration: PAYMENT_REDIRECT_URL")

        parsed = urlsplit(redirect_url)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query["beam_return"] = "1"
        return urlunsplit(parsed._replace(query=urlencode(query)))

    def _build_link_settings(self) -> dict[str, Any]:
        return {
            "buyNowPayLater": {"isEnabled": settings.BEAM_ENABLE_BNPL},
            "card": {"isEnabled": settings.BEAM_ENABLE_CARD},
            "cardInstallments": {
                "isEnabled": settings.BEAM_ENABLE_CARD_INSTALLMENTS,
                "installments3m": {"isEnabled": settings.BEAM_ENABLE_CARD_INSTALLMENTS},
                "installments4m": {"isEnabled": settings.BEAM_ENABLE_CARD_INSTALLMENTS},
                "installments6m": {"isEnabled": settings.BEAM_ENABLE_CARD_INSTALLMENTS},
                "installments10m": {"isEnabled": settings.BEAM_ENABLE_CARD_INSTALLMENTS},
            },
            "eWallets": {"isEnabled": settings.BEAM_ENABLE_EWALLETS},
            "mobileBanking": {"isEnabled": settings.BEAM_ENABLE_MOBILE_BANKING},
            "qrPromptPay": {"isEnabled": settings.BEAM_ENABLE_QR_PROMPTPAY},
        }

    def _decode_webhook_secret(self) -> bytes:
        self._ensure_beam_webhook_configured()
        try:
            return base64.b64decode(settings.BEAM_WEBHOOK_HMAC_KEY)
        except Exception as exc:
            raise ValueError("Invalid BEAM_WEBHOOK_HMAC_KEY format") from exc

    def verify_signature(self, payload_bytes: bytes, signature: str) -> bool:
        if not signature:
            return False

        secret = self._decode_webhook_secret()
        digest = hmac.new(secret, payload_bytes, hashlib.sha256).digest()
        expected_signature = base64.b64encode(digest).decode("utf-8")
        return hmac.compare_digest(expected_signature, signature.strip())

    def _normalize_status(self, provider_status: str | None) -> str:
        normalized = (provider_status or "").upper()
        if normalized in {"PAID", "SUCCEEDED"}:
            return "success"
        if normalized in {"EXPIRED", "DISABLED", "VOIDED", "REFUNDED", "FAILED", "CANCELED"}:
            return "failed"
        return "pending"

    def _get_product(self, product_id: str) -> dict[str, Any]:
        product = self.products.get(product_id)
        if not product:
            allowed = ", ".join(sorted(self.products))
            raise ValueError(f"Invalid product_id. Allowed: {allowed}")
        return product

    def _extract_payment_link_id(self, payload: dict[str, Any]) -> str | None:
        return payload.get("paymentLinkId") or payload.get("id") or payload.get("sourceId")

    async def create_payment_link(
        self,
        user_id: str,
        product_id: str,
        cycle_id: str | None = None,
        selected_extra_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        self._ensure_beam_configured()
        product = self._get_product(product_id)
        user_ref = self.db.collection("users").document(user_id)
        user_snapshot = await user_ref.get()
        if not user_snapshot.exists:
            raise ValueError(f"User {user_id} not found")

        user_data = user_snapshot.to_dict() or {}
        resolved_cycle_id = cycle_id or user_data.get("current_cycle_id")
        if not resolved_cycle_id:
            raise ValueError("User does not have an active sticker cycle.")
        selected_extra_ids = selected_extra_ids or []
        now_utc = datetime.now(timezone.utc)
        if product_id == FINAL_PACK_PRODUCT_ID:
            if user_data.get("final_pack_paid_at"):
                raise ValueError("Final pack is already paid.")
            cooldown_until = user_data.get("generation_cooldown_until")
            if user_data.get("generation_locked_at") and cooldown_until and cooldown_until <= now_utc:
                raise ValueError("This sticker cycle has expired. Start a new cycle.")
            if not (user_data.get("current_stickers") or []):
                raise ValueError("No final stickers are ready to save.")
        if product_id == EXTRA_PACK_PRODUCT_ID:
            if user_data.get("extra_pack_paid_at"):
                raise ValueError("Extra pack is already paid.")
            if not user_data.get("final_pack_exported_at"):
                raise ValueError("Final pack must be saved before buying extras.")
            expires_at = user_data.get("extra_vault_expires_at")
            if expires_at and expires_at <= now_utc:
                raise ValueError("Extra Vault has expired.")
            extra_vault = [item for item in (user_data.get("extra_vault") or []) if isinstance(item, dict)]
            if not extra_vault:
                raise ValueError("No extra stickers are available.")
            if len(selected_extra_ids) > 16:
                raise ValueError("Select at most 16 extra stickers.")
            available_ids = {item.get("id") for item in extra_vault}
            if not selected_extra_ids:
                raise ValueError("Select at least one extra sticker.")
            if any(extra_id not in available_ids for extra_id in selected_extra_ids):
                raise ValueError("One or more selected extra stickers are unavailable.")

        reference_id = f"{user_id}:{product_id}:{resolved_cycle_id}:{uuid4().hex[:12]}"
        redirect_url = self._build_redirect_url()
        expires_at = now_utc + timedelta(minutes=settings.PAYMENT_LINK_EXPIRY_MINUTES)

        payload = {
            "collectDeliveryAddress": False,
            "linkSettings": self._build_link_settings(),
            "order": {
                "currency": settings.PAYMENT_CURRENCY,
                "description": product["description"],
                "internalNote": user_id,
                "netAmount": product["amount_satang"],
                "orderItems": [
                    {
                        "description": product["description"],
                        "itemName": product["title"],
                        "price": product["amount_satang"],
                        "productId": product_id,
                        "quantity": 1,
                        "sku": product_id,
                    }
                ],
                "referenceId": reference_id,
            },
            "redirectUrl": redirect_url,
            "expiresAt": expires_at.isoformat(),
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                self.beam_api_url,
                json=payload,
                auth=(settings.BEAM_MERCHANT_ID or "", settings.BEAM_API_KEY or ""),
                headers={"x-beam-idempotency-key": str(uuid4())},
            )

        if response.status_code >= 400:
            logger.error("Beam payment link creation failed: %s %s", response.status_code, response.text)
            raise ValueError("Failed to create payment link")

        data = response.json()
        payment_link_id = self._extract_payment_link_id(data)
        checkout_url = data.get("url")
        provider_status = data.get("status", "ACTIVE")

        if not payment_link_id or not checkout_url:
            logger.error("Beam response missing payment link id or url: %s", data)
            raise ValueError("Invalid Beam response")

        payment_ref = self.db.collection("payments").document(payment_link_id)
        await payment_ref.set(
            {
                "payment_link_id": payment_link_id,
                "provider": "beam",
                "user_id": user_id,
                "cycle_id": resolved_cycle_id,
                "product_id": product_id,
                "reference_id": reference_id,
                "amount_satang": product["amount_satang"],
                "thb_amount": product["amount_satang"] / 100.0,
                "status": self._normalize_status(provider_status),
                "provider_status": provider_status,
                "checkout_url": checkout_url,
                "redirect_url": redirect_url,
                "selected_extra_ids": selected_extra_ids,
                "expires_at": data.get("expiresAt") or expires_at.isoformat(),
                "created_at": now_utc,
                "updated_at": now_utc,
            }
        )

        return {
            "payment_link_id": payment_link_id,
            "status": self._normalize_status(provider_status),
            "provider_status": provider_status,
            "product_id": product_id,
            "cycle_id": resolved_cycle_id,
            "amount_satang": product["amount_satang"],
            "checkout_url": checkout_url,
            "selected_extra_ids": selected_extra_ids,
            "expires_at": data.get("expiresAt") or expires_at.isoformat(),
        }

    async def process_webhook(
        self,
        payload: dict[str, Any],
        event: str,
        signature: str,
        raw_payload: bytes,
    ) -> None:
        if not self.verify_signature(raw_payload, signature):
            logger.warning("Invalid Beam signature detected.")
            raise ValueError("Invalid signature")

        if event == "payment_link.paid":
            await self._apply_payment_link_payload(payload, source="webhook")
            return

        if event == "charge.succeeded" and payload.get("source") == "PAYMENT_LINK":
            payment_link_id = self._extract_payment_link_id(payload)
            if payment_link_id:
                await self._sync_payment_status_from_beam(payment_link_id)
            return

        logger.info("Ignoring unsupported Beam webhook event: %s", event)

    async def get_payment_status(self, payment_link_id: str) -> dict[str, Any]:
        payment_ref = self.db.collection("payments").document(payment_link_id)
        snapshot = await payment_ref.get()
        if not snapshot.exists:
            raise ValueError("Payment not found")

        data = snapshot.to_dict() or {}
        if data.get("status") != "success":
            data = await self._sync_payment_status_from_beam(payment_link_id)

        return {
            "payment_link_id": payment_link_id,
            "user_id": data.get("user_id"),
            "status": data.get("status", "pending"),
            "provider_status": data.get("provider_status", "ACTIVE"),
            "product_id": data.get("product_id"),
            "cycle_id": data.get("cycle_id"),
            "amount_satang": data.get("amount_satang", 0),
            "checkout_url": data.get("checkout_url"),
            "selected_extra_ids": data.get("selected_extra_ids") or [],
            "expires_at": data.get("expires_at"),
        }

    async def _sync_payment_status_from_beam(self, payment_link_id: str) -> dict[str, Any]:
        try:
            payload = await self._fetch_payment_link(payment_link_id)
        except ValueError:
            payment_ref = self.db.collection("payments").document(payment_link_id)
            snapshot = await payment_ref.get()
            return snapshot.to_dict() or {}

        return await self._apply_payment_link_payload(payload, source="poll")

    async def _fetch_payment_link(self, payment_link_id: str) -> dict[str, Any]:
        self._ensure_beam_configured()
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                f"{self.beam_api_url}/{payment_link_id}",
                auth=(settings.BEAM_MERCHANT_ID or "", settings.BEAM_API_KEY or ""),
            )

        if response.status_code >= 400:
            logger.error("Beam payment link fetch failed: %s %s", response.status_code, response.text)
            raise ValueError("Failed to fetch payment link")

        return response.json()

    async def _apply_payment_link_payload(self, payload: dict[str, Any], source: str) -> dict[str, Any]:
        payment_link_id = self._extract_payment_link_id(payload)
        if not payment_link_id:
            raise ValueError("Missing payment link id")

        payment_ref = self.db.collection("payments").document(payment_link_id)
        snapshot = await payment_ref.get()
        if not snapshot.exists:
            raise ValueError("Payment not found")

        current = snapshot.to_dict() or {}
        order = payload.get("order", {}) or {}
        provider_status = payload.get("status") or current.get("provider_status") or "ACTIVE"
        normalized_status = self._normalize_status(provider_status)
        amount_satang = order.get("netAmount") or current.get("amount_satang") or 0
        update_data = {
            "provider_status": provider_status,
            "status": normalized_status,
            "checkout_url": payload.get("url") or current.get("checkout_url"),
            "expires_at": payload.get("expiresAt") or current.get("expires_at"),
            "updated_at": datetime.now(timezone.utc),
        }

        await payment_ref.set(update_data, merge=True)

        if normalized_status == "success":
            await self._record_payment_success(
                payment_link_id=payment_link_id,
                paid_payload=payload,
                source=source,
            )

        latest_snapshot = await payment_ref.get()
        latest = latest_snapshot.to_dict() or {}
        if not latest.get("amount_satang") and amount_satang:
            await payment_ref.set(
                {
                    "amount_satang": amount_satang,
                    "thb_amount": amount_satang / 100.0,
                    "updated_at": datetime.now(timezone.utc),
                },
                merge=True,
            )
            latest["amount_satang"] = amount_satang
            latest["thb_amount"] = amount_satang / 100.0
        return latest

    async def _record_payment_success(
        self,
        payment_link_id: str,
        paid_payload: dict[str, Any],
        source: str,
    ) -> None:
        transaction = self.db.transaction()
        payment_ref = self.db.collection("payments").document(payment_link_id)
        purchase_ref = self.db.collection("purchases").document(f"purchase_{payment_link_id}")

        @firestore.async_transactional
        async def atomic_apply(transaction_obj):
            payment_snapshot = await payment_ref.get(transaction=transaction_obj)
            if not payment_snapshot.exists:
                raise ValueError("Payment not found")

            payment_data = payment_snapshot.to_dict() or {}
            if payment_data.get("processed_at"):
                return

            order = paid_payload.get("order", {}) or {}
            expected_amount = int(payment_data.get("amount_satang", 0))
            received_amount = int(order.get("netAmount") or expected_amount)
            if expected_amount and received_amount != expected_amount:
                raise ValueError("Payment amount mismatch")

            user_id = payment_data.get("user_id")
            if not user_id:
                raise ValueError("Payment missing user_id")

            user_ref = self.db.collection("users").document(user_id)
            user_snapshot = await user_ref.get(transaction=transaction_obj)
            if not user_snapshot.exists:
                raise ValueError(f"User {user_id} not found")

            product_id = payment_data.get("product_id")
            if product_id not in {FINAL_PACK_PRODUCT_ID, EXTRA_PACK_PRODUCT_ID}:
                raise ValueError(f"Unsupported product_id: {product_id}")

            thb_amount = float(payment_data.get("thb_amount") or (received_amount / 100.0))
            user_data = user_snapshot.to_dict() or {}
            now_utc = datetime.now(timezone.utc)
            selected_extra_ids = payment_data.get("selected_extra_ids") or []
            cycle_id = payment_data.get("cycle_id") or user_data.get("current_cycle_id")

            user_update = {
                "total_spent_thb": float(user_data.get("total_spent_thb", 0.0)) + thb_amount,
                "updated_at": now_utc,
            }
            if product_id == FINAL_PACK_PRODUCT_ID:
                user_update.update({
                    "final_pack_paid_at": now_utc,
                    "final_pack_payment_link_id": payment_link_id,
                })
            elif product_id == EXTRA_PACK_PRODUCT_ID:
                user_update.update({
                    "extra_pack_paid_at": now_utc,
                    "extra_pack_payment_link_id": payment_link_id,
                    "extra_pack_selected_ids": selected_extra_ids,
                })

            transaction_obj.update(
                user_ref,
                user_update,
            )
            transaction_obj.set(
                purchase_ref,
                {
                    "purchase_id": purchase_ref.id,
                    "user_id": user_id,
                    "cycle_id": cycle_id,
                    "product_id": product_id,
                    "amount_satang": received_amount,
                    "provider": "beam",
                    "payment_link_id": payment_link_id,
                    "source": source,
                    "selected_extra_ids": selected_extra_ids,
                    "purchased_at": now_utc,
                    "exported_at": None,
                },
            )
            transaction_obj.set(
                payment_ref,
                {
                    "status": "success",
                    "provider_status": "PAID",
                    "paid_at": now_utc,
                    "processed_at": now_utc,
                    "updated_at": now_utc,
                },
                merge=True,
            )

        await atomic_apply(transaction)
