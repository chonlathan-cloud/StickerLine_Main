import logging
from typing import Optional, List
import datetime
import google.auth
from google.auth.transport.requests import Request
from google.auth.iam import Signer
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
            self._signer = None
            self._service_account_email = None
            self._access_token = None
            logger.info("Storage Client initialized successfully.")
        except Exception as e:
            logger.error(f"Failed to initialize Storage Client: {e}")
            raise e

    def upload_file(
        self,
        file_bytes: bytes,
        destination_blob_name: str,
        content_type: str = "image/png",
        response_disposition: Optional[str] = None,
        response_type: Optional[str] = None,
    ) -> str:
        """
        Upload data to GCS bucket defined in config.py.
        Returns the signed URL valid for 1 hour.
        """
        try:
            blob = self.bucket.blob(destination_blob_name)
            blob.upload_from_string(file_bytes, content_type=content_type)
            
            # Generate a signed URL valid for 1 hour for secure frontend access
            url = self._generate_signed_url(
                blob,
                expires_hours=1,
                response_disposition=response_disposition,
                response_type=response_type,
            )
            
            logger.info(f"File uploaded to {destination_blob_name}")
            return url
        except Exception as e:
            logger.error(f"Failed to upload file to GCS: {e}")
            raise e

    def list_blobs(self, prefix: str) -> List[storage.Blob]:
        """
        List blobs in the bucket by prefix.
        """
        return list(self.bucket.list_blobs(prefix=prefix))

    def generate_signed_url(
        self,
        blob_name: str,
        expires_hours: int = 1,
        response_disposition: Optional[str] = None,
        response_type: Optional[str] = None,
    ) -> str:
        """
        Generate a signed URL for an existing blob.
        """
        blob = self.bucket.blob(blob_name)
        return self._generate_signed_url(
            blob,
            expires_hours=expires_hours,
            response_disposition=response_disposition,
            response_type=response_type,
        )

    def _refresh_signer(self) -> None:
        """
        Refresh credentials and create IAM signer if needed (for Cloud Run).
        """
        credentials, _ = google.auth.default()
        request = Request()
        credentials.refresh(request)

        service_account_email = getattr(credentials, "service_account_email", None)
        if not service_account_email:
            self._signer = None
            self._service_account_email = None
            self._access_token = None
            return

        self._signer = Signer(request, credentials, service_account_email)
        self._service_account_email = service_account_email
        self._access_token = credentials.token

    def _generate_signed_url(
        self,
        blob: storage.Blob,
        expires_hours: int = 1,
        response_disposition: Optional[str] = None,
        response_type: Optional[str] = None,
    ) -> str:
        """
        Generate signed URL using IAM Signer if available; fall back to default signer.
        """
        self._refresh_signer()
        if self._signer and self._service_account_email and self._access_token:
            return blob.generate_signed_url(
                version="v4",
                expiration=datetime.timedelta(hours=expires_hours),
                method="GET",
                service_account_email=self._service_account_email,
                access_token=self._access_token,
                response_disposition=response_disposition,
                response_type=response_type,
            )

        return blob.generate_signed_url(
            version="v4",
            expiration=datetime.timedelta(hours=expires_hours),
            method="GET",
            response_disposition=response_disposition,
            response_type=response_type,
        )

    def download_gcs_uri(self, gcs_uri: str) -> bytes:
        """
        Download a blob by its gs:// URI and return bytes.
        """
        if not gcs_uri.startswith("gs://"):
            raise ValueError(f"Invalid GCS URI: {gcs_uri}")

        path = gcs_uri[len("gs://"):]
        if "/" not in path:
            raise ValueError(f"Invalid GCS URI: {gcs_uri}")

        bucket_name, blob_name = path.split("/", 1)
        bucket = self.client.bucket(bucket_name)
        blob = bucket.blob(blob_name)
        return blob.download_as_bytes()
