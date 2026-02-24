import logging
import datetime
from google.cloud import storage
from app.core.config import settings

logger = logging.getLogger(__name__)

class StorageClient:
    def __init__(self):
        try:
            # Initialize Storage Client
            self.client = storage.Client(project=settings.PROJECT_ID)
            self.bucket_name = settings.GCS_BUCKET_NAME
            self.bucket = self.client.bucket(self.bucket_name)
            logger.info("Storage Client initialized successfully.")
        except Exception as e:
            logger.error(f"Failed to initialize Storage Client: {e}")
            raise e

    def upload_file(self, file_bytes: bytes, destination_blob_name: str, content_type: str = "image/png") -> str:
        """
        Upload data to GCS bucket defined in config.py.
        Returns the signed URL valid for 1 hour.
        """
        try:
            blob = self.bucket.blob(destination_blob_name)
            blob.upload_from_string(file_bytes, content_type=content_type)
            
            # Generate a signed URL valid for 1 hour for secure frontend access
            url = blob.generate_signed_url(
                version="v4",
                expiration=datetime.timedelta(hours=1),
                method="GET"
            )
            
            logger.info(f"File uploaded to {destination_blob_name}")
            return url
        except Exception as e:
            logger.error(f"Failed to upload file to GCS: {e}")
            raise e
