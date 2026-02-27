import os
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    PROJECT_ID: str
    GCS_BUCKET_NAME: str
    LIFF_CHANNEL_ID: str
    LINE_CHANNEL_SECRET: str
    OMISE_SECRET_KEY: str
    OMISE_PUBLIC_KEY: str
    VERTEX_MODEL: str = "gemini-3-pro-image-preview"
    VERTEX_LOCATION: str = "global"
    GENAI_PROVIDER: str = "vertex"
    GEMINI_API_KEY: str | None = None
    GEMINI_API_BASE_URL: str = "https://generativelanguage.googleapis.com"
    GEMINI_IMAGE_ASPECT_RATIO: str = "1:1"
    GEMINI_IMAGE_SIZE: str = "2K"
    GENAI_FALLBACK_PROVIDER: str = "gemini_api"
    GENAI_FALLBACK_MAX_RETRIES: int = 2
    GENERATION_CONCURRENCY: int = 1
    GENERATION_COOLDOWN_SECONDS: int = 30
    GENERATION_MAX_RETRIES: int = 8
    GENERATION_RETRY_BASE_DELAY: float = 5.0

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        # Ignore extra environment variables that aren't defined here
        extra="ignore"
    )

settings = Settings()
