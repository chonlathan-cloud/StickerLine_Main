from typing import List
from pydantic import BaseModel, Field

class StickerGenerateRequest(BaseModel):
    user_id: str
    image_uri: str
    style: str
    prompt: str
    locked_indices: List[int] = Field(default_factory=list)
