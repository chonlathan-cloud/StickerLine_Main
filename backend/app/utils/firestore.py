import logging
from google.cloud import firestore
from app.core.config import settings

logger = logging.getLogger(__name__)

class AsyncFirestoreClientWrapper:
    """
    Singleton Wrapper for Async Firestore Client to reuse the connection across requests.
    """
    _instance = None
    _client = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(AsyncFirestoreClientWrapper, cls).__new__(cls)
            try:
                # Initialize Async Firestore Client using the project ID from settings
                cls._instance._client = firestore.AsyncClient(project=settings.PROJECT_ID)
                logger.info("Async Firestore Client initialized successfully.")
            except Exception as e:
                logger.error(f"Failed to initialize Async Firestore Client: {e}")
                raise e
        return cls._instance
    
    @property
    def client(self) -> firestore.AsyncClient:
        return self._client

def get_db() -> firestore.AsyncClient:
    """Helper function to return the Firestore client singleton instance."""
    wrapper = AsyncFirestoreClientWrapper()
    return wrapper.client
