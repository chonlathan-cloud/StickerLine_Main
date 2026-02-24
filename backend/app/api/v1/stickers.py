import uuid
import logging
from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks
from app.models.sticker import StickerGenerateRequest
from app.services.user_service import UserService
from app.services.ai_service import AIService
from app.services.image_service import ImageProcessor
from app.utils.storage import StorageClient

logger = logging.getLogger(__name__)
router = APIRouter()

def get_user_service():
    return UserService()

def get_ai_service():
    return AIService()

def get_image_processor():
    return ImageProcessor()

def get_storage_client():
    return StorageClient()

@router.post("/generate", status_code=status.HTTP_201_CREATED)
async def generate_stickers(
    request: StickerGenerateRequest,
    user_service: UserService = Depends(get_user_service),
    ai_service: AIService = Depends(get_ai_service),
    image_processor: ImageProcessor = Depends(get_image_processor),
    storage_client: StorageClient = Depends(get_storage_client)
):
    """
    Main orchestration endpoint for generating Stickers.
    """
    user_id = request.user_id
    
    # 1. Deduct 1 Coin from User atomically
    try:
        await user_service.deduct_coin(user_id, amount=1)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
        
    try:
        # 2. Vertex AI Generation
        grid_bytes = await ai_service.generate_sticker_grid(
            image_uri=request.image_uri,
            style_id=request.style,
            extra_prompt=request.prompt,
        )
        
        # 3. Image Processing (Slice, Remove BG, White Stroke)
        sticker_images = image_processor.process_sticker_grid(grid_bytes)
        
        # 4. Upload all 16 images to GCS
        output_urls = []
        job_id = str(uuid.uuid4())
        
        for i, sticker_bytes in enumerate(sticker_images):
            blob_name = f"users/{user_id}/jobs/{job_id}/{i}.png"
            url = storage_client.upload_file(
                file_bytes=sticker_bytes,
                destination_blob_name=blob_name,
                content_type="image/png"
            )
            output_urls.append(url)
            
        # 5. Return the 16 Signed URLs
        return {
            "job_id": job_id,
            "status": "completed",
            "result_urls": output_urls
        }
        
    except Exception as e:
        logger.error(f"Sticker generation failed for {user_id}. Rolling back coin deduction. Error: {e}")
        # Rollback: Refund the coin
        try:
            await user_service.refund_coin(user_id, amount=1)
        except Exception as refund_error:
            logger.error(f"CRITICAL: Failed to refund {user_id}: {refund_error}")
            
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Generation failed due to processing error. Coins refunded. Error: {str(e)}"
        )
