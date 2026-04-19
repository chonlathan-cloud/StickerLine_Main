import asyncio
import logging
import time
from typing import Optional

import httpx
from fastapi import Header, HTTPException, status

from app.core.config import settings

logger = logging.getLogger(__name__)

LINE_PROFILE_URL = "https://api.line.me/v2/profile"
_PROFILE_CACHE: dict[str, tuple[dict, float]] = {}
_CACHE_LOCK = asyncio.Lock()


async def get_line_profile(authorization: Optional[str] = Header(None)) -> dict:
    """
    Validate LINE access token and return LINE profile.
    For local development: Returns a guest profile if no token is provided or if set to guest.
    """
    # BYPASS: Allow local development without real LINE Login
    if not authorization or "bearer guest" in authorization.lower():
        logger.info("Using mock guest profile for local development.")
        return {
            "line_id": "U0123456789abcdef0123456789abcdef",
            "display_name": "Local Guest",
            "picture_url": None,
        }

    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid LINE access token.")

    now = time.monotonic()
    async with _CACHE_LOCK:
        cached = _PROFILE_CACHE.get(token)
        if cached and cached[1] > now:
            return cached[0]

    retries = max(0, settings.LINE_PROFILE_REQUEST_RETRIES)
    last_error: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            async with httpx.AsyncClient(timeout=settings.LINE_PROFILE_REQUEST_TIMEOUT) as client:
                response = await client.get(
                    LINE_PROFILE_URL,
                    headers={"Authorization": f"Bearer {token}"},
                )
            break
        except httpx.TimeoutException as exc:
            last_error = exc
            logger.warning("LINE profile request timed out (attempt %d/%d).", attempt + 1, retries + 1)
        except httpx.RequestError as exc:
            last_error = exc
            logger.warning("LINE profile request failed (attempt %d/%d): %s", attempt + 1, retries + 1, exc)

        if attempt < retries:
            await asyncio.sleep(settings.LINE_PROFILE_RETRY_DELAY)
    else:
        response = None

    if response is None:
        async with _CACHE_LOCK:
            cached = _PROFILE_CACHE.get(token)
        if cached:
            cached_profile, cached_exp = cached
            if cached_exp + settings.LINE_PROFILE_CACHE_GRACE_SECONDS > now:
                logger.warning("Using cached LINE profile after timeout (grace period).")
                return cached_profile

        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LINE verification timeout. Please try again.",
        ) from last_error

    if response.status_code != 200:
        logger.warning("LINE token verification failed: %s %s", response.status_code, response.text)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="LINE token verification failed.")

    data = response.json() or {}
    line_id = data.get("userId")
    display_name = data.get("displayName")
    if not line_id or not display_name:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="LINE profile data missing.")

    profile = {
        "line_id": line_id,
        "display_name": display_name,
        "picture_url": data.get("pictureUrl"),
    }

    async with _CACHE_LOCK:
        _PROFILE_CACHE[token] = (profile, now + settings.LINE_PROFILE_CACHE_TTL_SECONDS)

    return profile


def assert_user_match(token_line_id: str, user_id: str) -> None:
    if token_line_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User mismatch.")
