import base64
import logging
import vertexai
from vertexai.generative_models import GenerativeModel, Part
from app.core.config import settings

logger = logging.getLogger(__name__)

class AIService:
    def __init__(self):
        try:
            vertexai.init(project=settings.PROJECT_ID)
            # As requested, using the gemini-2.5-flash-001 model
            self.model = GenerativeModel("gemini-2.5-flash-001")
            logger.info("Vertex AI model initialized.")
        except Exception as e:
            logger.error(f"Failed to initialize Vertex AI: {e}")
            raise e

    async def generate_sticker_grid(self, prompt: str, image_uri: str, style: str) -> bytes:
        """
        Calls Vertex AI Gemini model to generate a sticker grid.
        Returns the raw image bytes.
        """
        try:
            full_prompt = (
                f"Generate a 4x4 grid of 16 stickers featuring the person in the input image. "
                f"The art style must be '{style}'. "
                f"Additional details requested: {prompt}."
            )
            
            # GCS URI of the input image
            image_part = Part.from_uri(image_uri, mime_type="image/jpeg")
            
            # Call Vertex AI Model
            response = await self.model.generate_content_async(
                contents=[image_part, full_prompt]
            )
            
            # Try to extract an inline image from the response parts (if the model returns one)
            for part in response.candidates[0].content.parts:
                if part.inline_data:
                    return part.inline_data.data
            
            # Fallback if the model returned base64 text instead of an inline attachment
            return base64.b64decode(response.text.strip())
            
        except Exception as e:
            logger.error(f"Error generating sticker grid: {e}")
            raise e
