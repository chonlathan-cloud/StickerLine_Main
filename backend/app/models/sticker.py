from pydantic import BaseModel

class StickerGenerateRequest(BaseModel):
    user_id: str
    image_uri: str
    style: str
    prompt: str
