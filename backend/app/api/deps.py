import logging
from typing import Optional

import httpx
from fastapi import Header, HTTPException, status

logger = logging.getLogger(__name__)

LINE_PROFILE_URL = "https://api.line.me/v2/profile"


async def get_line_profile(authorization: Optional[str] = Header(None)) -> dict:
    """
    Validate LINE access token and return LINE profile.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing LINE access token.")

    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid LINE access token.")

    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            LINE_PROFILE_URL,
            headers={"Authorization": f"Bearer {token}"},
        )

    if response.status_code != 200:
        logger.warning("LINE token verification failed: %s %s", response.status_code, response.text)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="LINE token verification failed.")

    data = response.json() or {}
    line_id = data.get("userId")
    display_name = data.get("displayName")
    if not line_id or not display_name:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="LINE profile data missing.")

    return {
        "line_id": line_id,
        "display_name": display_name,
        "picture_url": data.get("pictureUrl"),
    }


def assert_user_match(token_line_id: str, user_id: str) -> None:
    if token_line_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User mismatch.")
