from fastapi import APIRouter, Depends, HTTPException, status
from app.api.deps import get_line_profile, assert_user_match
from app.models.user import UserCreate
from app.services.user_service import UserService

router = APIRouter()

def get_user_service():
    return UserService()

@router.post("/sync")
async def sync_user(
    line_profile: UserCreate,
    user_service: UserService = Depends(get_user_service),
    token_profile: dict = Depends(get_line_profile),
):
    """
    Sync user profile from LINE.
    Checks if a user exists. If not, initializes a new pay-on-save profile.
    """
    try:
        assert_user_match(token_profile["line_id"], line_profile.line_id)
        verified_profile = UserCreate(
            line_id=token_profile["line_id"],
            display_name=token_profile["display_name"],
            picture_url=token_profile.get("picture_url"),
        )
        user_data = await user_service.sync_user(verified_profile)
        user_data["generation_state"] = await user_service.get_cycle_state(verified_profile.line_id)
        return user_data
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )
