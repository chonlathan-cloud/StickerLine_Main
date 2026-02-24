import logging
from fastapi import APIRouter, Depends, HTTPException, status
from app.services.user_service import UserService

logger = logging.getLogger(__name__)
router = APIRouter()

def get_user_service():
    return UserService()

@router.get("/{user_id}/permissions")
async def get_user_permissions(
    user_id: str,
    user_service: UserService = Depends(get_user_service)
):
    """
    Check if a user has sufficient spending to download all their standard stickers.
    Business Logic: total_spent_thb >= 30.
    """
    try:
        user_ref = user_service.users_collection.document(user_id)
        user_doc = await user_ref.get()

        if not user_doc.exists:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"User {user_id} not found"
            )

        user_data = user_doc.to_dict()
        current_spent = user_data.get("total_spent_thb", 0.0)
        
        required_spent = 30.0
        can_download = current_spent >= required_spent

        return {
            "can_download": can_download,
            "current_spent": current_spent,
            "required": required_spent
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error checking permissions for {user_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve user permissions"
        )
