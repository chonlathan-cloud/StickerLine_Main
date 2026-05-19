from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    PROJECT_ID: str
    GCS_BUCKET_NAME: str
    LIFF_CHANNEL_ID: str
    LINE_CHANNEL_SECRET: str
    BEAM_BASE_URL: str = "https://playground.api.beamcheckout.com"
    BEAM_MERCHANT_ID: str | None = None
    BEAM_API_KEY: str | None = None
    BEAM_WEBHOOK_HMAC_KEY: str | None = None
    PAYMENT_REDIRECT_URL: str | None = None
    PAYMENT_WEBHOOK_PUBLIC_URL: str | None = None
    PAYMENT_LINK_EXPIRY_MINUTES: int = 30
    PAYMENT_CURRENCY: str = "THB"
    BEAM_ENABLE_CARD: bool = True
    BEAM_ENABLE_CARD_INSTALLMENTS: bool = False
    BEAM_ENABLE_QR_PROMPTPAY: bool = True
    BEAM_ENABLE_EWALLETS: bool = False
    BEAM_ENABLE_MOBILE_BANKING: bool = True
    BEAM_ENABLE_BNPL: bool = False
    VERTEX_MODEL: str = "gemini-3-pro-image-preview"
    VERTEX_LOCATION: str = "global"
    GENAI_PROVIDER: str = "vertex"
    GEMINI_API_KEY: str | None = None
    GEMINI_API_BASE_URL: str = "https://generativelanguage.googleapis.com"
    GEMINI_IMAGE_ASPECT_RATIO: str = "1:1"
    GEMINI_IMAGE_SIZE: str = "2K"
    GENAI_FALLBACK_PROVIDER: str = "gemini_api"
    GENAI_FALLBACK_MAX_RETRIES: int = 2
    LINE_PROFILE_CACHE_TTL_SECONDS: int = 300
    LINE_PROFILE_CACHE_GRACE_SECONDS: int = 600
    LINE_PROFILE_REQUEST_TIMEOUT: float = 10.0
    LINE_PROFILE_REQUEST_RETRIES: int = 1
    LINE_PROFILE_RETRY_DELAY: float = 0.5
    GENERATION_DISPATCH_MODE: str = "local_async"
    GENERATION_CONCURRENCY: int = 1
    GENERATION_COOLDOWN_SECONDS: int = 30
    GENERATION_MAX_RETRIES: int = 8
    GENERATION_RETRY_BASE_DELAY: float = 5.0
    PUBSUB_PROJECT_ID: str | None = None
    STICKER_GENERATION_TOPIC: str = "sticker-generation-jobs"
    PUBSUB_PUBLISH_TIMEOUT_SECONDS: float = 10.0

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        # Ignore extra environment variables that aren't defined here
        extra="ignore"
    )

settings = Settings()
