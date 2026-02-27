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
    GENERATION_CONCURRENCY: int = 1
    GENERATION_COOLDOWN_SECONDS: int = 20
    GENERATION_MAX_RETRIES: int = 5
    GENERATION_RETRY_BASE_DELAY: float = 2.0

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        # Ignore extra environment variables that aren't defined here
        extra="ignore"
    )

settings = Settings()
