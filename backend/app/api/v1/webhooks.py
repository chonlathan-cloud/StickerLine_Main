import logging
import json
from fastapi import APIRouter, Request, Header, HTTPException, status, Depends
from app.services.payment_service import PaymentService

logger = logging.getLogger(__name__)
router = APIRouter()

def get_payment_service():
    return PaymentService()

@router.post("/omise")
async def omise_webhook(
    request: Request,
    x_omise_signature: str = Header(None),
    payment_service: PaymentService = Depends(get_payment_service)
):
    """
    Omise Webhook Handler.
    Listens for 'charge.complete' events.
    """
    if not x_omise_signature:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, 
            detail="Missing Omise Signature"
        )
        
    try:
        # We need the raw body bytes to verify the HMAC signature correctly
        raw_body = await request.body()
        payload = await request.json()
        
        await payment_service.process_webhook(
            payload=payload, 
            signature=x_omise_signature, 
            raw_payload=raw_body
        )
        
        # Must return 200 OK fast so Omise doesn't retry
        return {"status": "success"}
        
    except ValueError as ve:
        logger.warning(f"Webhook processing validation error: {ve}")
        # Return 403 for validation/signature issues
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(ve))
    except Exception as e:
        logger.error(f"Webhook processing failed: {e}")
        # Do not return 500 otherwise Omise keeps retrying.
        # But for critical faults, returning 500 will tell them to retry.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail="Internal Server Error"
        )
