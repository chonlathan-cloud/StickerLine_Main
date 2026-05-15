import logging
from fastapi import APIRouter, Depends, HTTPException, status, Query
from pydantic import BaseModel
from app.services.payment_service import PaymentService
from app.api.deps import get_line_profile, assert_user_match

logger = logging.getLogger(__name__)
router = APIRouter()


def get_payment_service():
    return PaymentService()


class PaymentCreateRequest(BaseModel):
    user_id: str
    product_id: str | None = None
    package_id: str | None = None
    cycle_id: str | None = None
    selected_extra_ids: list[str] | None = None


@router.post("/create", status_code=status.HTTP_201_CREATED)
async def create_payment(
    request: PaymentCreateRequest,
    payment_service: PaymentService = Depends(get_payment_service),
    token_profile: dict = Depends(get_line_profile),
) -> dict:
    try:
        assert_user_match(token_profile["line_id"], request.user_id)
        product_id = request.product_id or request.package_id
        if not product_id:
            raise ValueError("product_id is required")
        result = await payment_service.create_payment_link(
            user_id=request.user_id,
            product_id=product_id,
            cycle_id=request.cycle_id,
            selected_extra_ids=request.selected_extra_ids,
        )
        return result
    except ValueError as ve:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(ve))
    except Exception as e:
        logger.error(f"Failed to create payment: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to create payment")


@router.get("/status")
async def get_payment_status(
    payment_link_id: str | None = Query(None, min_length=3),
    charge_id: str | None = Query(None, min_length=3),
    payment_service: PaymentService = Depends(get_payment_service),
    token_profile: dict = Depends(get_line_profile),
) -> dict:
    try:
        resolved_payment_id = payment_link_id or charge_id
        if not resolved_payment_id:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="payment_link_id is required",
            )

        result = await payment_service.get_payment_status(resolved_payment_id)
        if result.get("user_id"):
            assert_user_match(token_profile["line_id"], result["user_id"])
        result.pop("user_id", None)
        return result
    except ValueError as ve:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(ve))
    except Exception as e:
        logger.error(f"Failed to get payment status: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to fetch payment status")
