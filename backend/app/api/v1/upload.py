import base64
import uuid
import logging
import re
from fastapi import APIRouter, HTTPException, status, Depends
from pydantic import BaseModel
from app.utils.storage import StorageClient
from app.core.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()


class UploadRequest(BaseModel):
    image_base64: str
    filename: str


def get_storage_client():
    return StorageClient()


def _decode_base64_image(data: str) -> bytes:
    """
    Decode a Base64 string, stripping the optional
    'data:image/...;base64,' prefix if present.
    """
    # Strip the data-URI prefix (e.g. "data:image/png;base64,")
    match = re.match(r"^data:image/\w+;base64,", data)
    if match:
        data = data[match.end():]

    try:
        return base64.b64decode(data)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Base64 image data"
        )


@router.post("/upload")
async def upload_image(
    request: UploadRequest,
    storage_client: StorageClient = Depends(get_storage_client)
):
    """
    Accept a Base64-encoded image, upload it to GCS,
    and return the gs:// URI and a signed public URL.
    """
    image_bytes = _decode_base64_image(request.image_base64)

    # Basic validation: check for common image magic bytes
    if not (
        image_bytes[:2] == b'\xff\xd8'       # JPEG
        or image_bytes[:4] == b'\x89PNG'      # PNG
        or image_bytes[:4] == b'RIFF'         # WEBP
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded data does not appear to be a valid image (JPEG/PNG/WEBP)"
        )

    # Build a unique GCS path
    unique_id = str(uuid.uuid4())
    blob_name = f"temp/uploads/{unique_id}/{request.filename}"

    # Determine content type from filename extension
    ext = request.filename.rsplit(".", 1)[-1].lower() if "." in request.filename else "jpeg"
    content_type_map = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
    content_type = content_type_map.get(ext, "image/jpeg")

    try:
        public_url = storage_client.upload_file(
            file_bytes=image_bytes,
            destination_blob_name=blob_name,
            content_type=content_type
        )

        gcs_uri = f"gs://{settings.GCS_BUCKET_NAME}/{blob_name}"

        return {
            "gcs_uri": gcs_uri,
            "public_url": public_url
        }
    except Exception as e:
        logger.error(f"Failed to upload image: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to upload image to storage"
        )
