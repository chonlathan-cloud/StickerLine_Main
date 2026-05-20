import logging
from fastapi import APIRouter, Request, Header, HTTPException, status, Depends
from app.services.payment_service import PaymentService

logger = logging.getLogger(__name__)
router = APIRouter()

def get_payment_service():
    return PaymentService()

@router.post("/beam")
async def beam_webhook(
    request: Request,
    x_beam_signature: str = Header(None),
    x_beam_event: str = Header(None),
    payment_service: PaymentService = Depends(get_payment_service)
):
    if not x_beam_signature:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, 
            detail="Missing Beam signature"
        )

    try:
        raw_body = await request.body()
        payload = await request.json()

        await payment_service.process_webhook(
            payload=payload,
            event=x_beam_event or "",
            signature=x_beam_signature,
            raw_payload=raw_body,
        )

        return {"status": "success"}
    except ValueError as ve:
        logger.warning(f"Webhook processing validation error: {ve}")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(ve))
    except Exception as e:
        logger.error(f"Webhook processing failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail="Internal Server Error"
        )
