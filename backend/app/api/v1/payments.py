import logging
from fastapi import APIRouter, Depends, HTTPException, status, Query
from pydantic import BaseModel
from app.services.payment_service import PaymentService

logger = logging.getLogger(__name__)
router = APIRouter()


def get_payment_service():
    return PaymentService()


class PaymentCreateRequest(BaseModel):
    user_id: str
    package_id: str


@router.post("/create", status_code=status.HTTP_201_CREATED)
async def create_payment(
    request: PaymentCreateRequest,
    payment_service: PaymentService = Depends(get_payment_service),
) -> dict:
    try:
        result = await payment_service.create_promptpay_charge(
            user_id=request.user_id,
            package_id=request.package_id,
        )
        return result
    except ValueError as ve:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(ve))
    except Exception as e:
        logger.error(f"Failed to create payment: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to create payment")


@router.get("/status")
async def get_payment_status(
    charge_id: str = Query(..., min_length=3),
    payment_service: PaymentService = Depends(get_payment_service),
) -> dict:
    try:
        result = await payment_service.get_payment_status(charge_id)
        return result
    except ValueError as ve:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(ve))
    except Exception as e:
        logger.error(f"Failed to get payment status: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to fetch payment status")
