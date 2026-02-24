from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime, timezone

def get_utc_now():
    return datetime.now(timezone.utc)

class UserBase(BaseModel):
    display_name: str
    picture_url: Optional[str] = None

class UserCreate(UserBase):
    line_id: str

class UserInDB(UserBase):
    line_id: str
    coin_balance: int = 2
    total_spent_thb: float = 0.0
    is_free_trial_used: bool = False
    created_at: datetime = Field(default_factory=get_utc_now)
    updated_at: datetime = Field(default_factory=get_utc_now)
