from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="StickerLine AI API",
    description="Backend API Gateway for StickerLine AI",
    version="1.0.0"
)

# Configure CORS (Should be restricted in production config to frontend domain)
origins = [
    "*",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    """Health check endpoint for Cloud Run."""
    return {"status": "ok", "service": "stickerline-api"}

from app.api.v1 import auth

# TODO: Include proper routers when they are created
# from app.api.v1 import jobs, payment
app.include_router(auth.router, prefix="/api/v1/auth", tags=["auth"])
# app.include_router(jobs.router, prefix="/api/v1/jobs", tags=["jobs"])
# app.include_router(payment.router, prefix="/webhooks", tags=["payment"])
