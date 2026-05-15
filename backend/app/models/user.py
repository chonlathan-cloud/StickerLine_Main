from pydantic import BaseModel, Field
from typing import Optional, List, Dict
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
    coin_balance: int = 0
    total_spent_thb: float = 0.0
    is_free_trial_used: bool = False
    created_at: datetime = Field(default_factory=get_utc_now)
    updated_at: datetime = Field(default_factory=get_utc_now)
    current_cycle_id: Optional[str] = None
    generation_count: int = 0
    generation_limit: int = 20
    generation_locked_at: Optional[datetime] = None
    generation_cooldown_until: Optional[datetime] = None
    current_stickers: Optional[List[Dict]] = None
    current_stickers_job_id: Optional[str] = None
    current_stickers_updated_at: Optional[datetime] = None
    extra_vault: Optional[List[Dict]] = None
    extra_vault_expires_at: Optional[datetime] = None
    final_pack_paid_at: Optional[datetime] = None
    final_pack_exported_at: Optional[datetime] = None
    extra_pack_paid_at: Optional[datetime] = None
    extra_pack_exported_at: Optional[datetime] = None
    current_extra_picks: Optional[List[Dict]] = None
    current_extra_picks_job_id: Optional[str] = None
    current_extra_picks_unlocked: bool = False
    current_extra_picks_updated_at: Optional[datetime] = None
