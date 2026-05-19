from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings

app = FastAPI(
    title="StickerLine AI API",
    description="Backend API Gateway for StickerLine AI",
    version="1.0.0"
)

def _parse_cors_origins(value: str) -> list[str]:
    return [
        origin.strip().rstrip("/")
        for origin in value.split(",")
        if origin.strip()
    ]


origins = _parse_cors_origins(settings.CORS_ALLOWED_ORIGINS)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_origin_regex=settings.CORS_ALLOW_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    """Health check endpoint for Cloud Run."""
    return {"status": "ok", "service": "stickerline-api"}

from app.api.v1 import auth, stickers, webhooks, users, upload, payments, pubsub

app.include_router(auth.router, prefix="/api/v1/auth", tags=["auth"])
app.include_router(users.router, prefix="/api/v1/users", tags=["users"])
app.include_router(stickers.router, prefix="/api/v1/jobs", tags=["jobs"])
app.include_router(upload.router, prefix="/api/v1", tags=["upload"])
app.include_router(payments.router, prefix="/api/v1/payments", tags=["payments"])
app.include_router(webhooks.router, prefix="/webhooks", tags=["payment"])
app.include_router(pubsub.router, prefix="/pubsub", tags=["worker"])
