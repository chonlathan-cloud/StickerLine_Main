import asyncio
import base64
import logging
import random
import re
from typing import Optional

import vertexai
from google.api_core import exceptions as gax_exceptions
from vertexai.generative_models import GenerativeModel, Part, GenerationConfig

from app.core.config import settings

logger = logging.getLogger(__name__)

class AIService:
    LOCKED_PROMPT_CHIBI_2D = "Art Style: Premium 2D Chibi, bold black outlines, vibrant flat colors."
    LOCKED_PROMPT_PIXAR_3D = (
        "Art Style: Cute premium 3D character (Pixar-like sticker quality, original character only).\n"
        "- Chibi proportion: larger head with smaller body, rounded cheeks, expressive eyes, friendly facial features.\n"
        "- Hair should be sculpted in soft chunky strands with clean volume, not realistic thin strands.\n"
        "- Lighting: warm cinematic key light + soft rim light, smooth gradients, polished but readable at small size.\n"
        "- Expression quality: exaggerated and clear for chat usage (smile, laugh, wink, thinking, shocked, etc.).\n"
        "- Framing rule: keep full face/head/hands inside each cell with safe margins; no cropped forehead/chin.\n"
        "- Render as sticker-ready subject with clean silhouette and no messy artifacts."
    )
    TECHNICAL_TOKENS = (
        "High-resolution professional art, sharp clean outlines, no die-cut border, no white outline, "
        "no green spill on character edges, solid #00FF00 green background for transparency, 4x4 grid layout, "
        "16 distinct poses, consistent character design, center-aligned characters, LINE sticker compliant style, "
        "safe margin in every cell, 2K generation quality. "
        "Add clear #00FF00 gutters between cells (12–16px). No elements may cross cell boundaries. "
        "Each sticker must be fully contained inside its own cell."
    )
    DEFAULT_THAI_CAPTIONS = [
        "สวัสดี",
        "ขอบคุณนะ",
        "โอเค",
        "สู้ๆ นะ",
        "ขอโทษนะ",
        "เย้!",
        "ยุ่งอยู่",
        "รักนะ",
        "งอนแล้ว",
        "ตกใจเลย",
        "คิดแป๊บ",
        "ฝันดีนะ",
        "หิวแล้ว",
        "รอก่อน",
        "รับทราบ",
        "ไปก่อนนะ",
    ]
    NO_TEXT_PATTERN = re.compile(
        r"(no text|without text|no caption|ไม่มีข้อความ|ไม่ต้องมีข้อความ|ไม่มีแคปชัน)",
        re.IGNORECASE,
    )

    def __init__(self) -> None:
        try:
            vertexai.init(project=settings.PROJECT_ID, location=settings.VERTEX_LOCATION)
            self.model = GenerativeModel(settings.VERTEX_MODEL)
            self.generation_config = GenerationConfig(
                response_modalities=[GenerationConfig.Modality.IMAGE]
            )
            self.max_retries = max(0, settings.GENERATION_MAX_RETRIES)
            self.retry_base_delay = max(0.1, float(settings.GENERATION_RETRY_BASE_DELAY))
            logger.info("Vertex AI model initialized.")
        except Exception as e:
            logger.error(f"Failed to initialize Vertex AI: {e}")
            raise e

    def _resolve_style_prompt(self, style_id: str) -> str:
        normalized = style_id.strip().lower()
        if normalized in {"chibi_2d", "chibi-2d", "chibi 2d", "chibi2d", "2d"}:
            return self.LOCKED_PROMPT_CHIBI_2D
        if normalized in {"pixar_3d", "pixar-3d", "pixar 3d", "pixar3d", "3d"}:
            return self.LOCKED_PROMPT_PIXAR_3D
        raise ValueError(f"Unsupported style_id: {style_id}. Expected chibi_2d or pixar_3d.")

    def _build_text_instruction(self, extra_prompt: Optional[str]) -> str:
        no_text_requested = bool(extra_prompt and self.NO_TEXT_PATTERN.search(extra_prompt))
        if no_text_requested:
            return "Generate stickers without any text captions."
        return (
            "MANDATORY TEXT CAPTIONS:\n"
            f"- Add one short Thai caption per sticker using this set: {', '.join(self.DEFAULT_THAI_CAPTIONS)}.\n"
            "- Place caption at bottom-center of each cell, clearly separated from face/hands.\n"
            "- Typography style: Google Fonts look (Kanit ExtraBold or Noto Sans Thai Black style).\n"
            "- Text render: solid black letters with thick white outline and soft shadow for high readability.\n"
            "- Keep caption large and readable in chat size, but do not clip text at cell edges.\n"
            "- Thai glyph integrity is mandatory: all vowels/diacritics/tonemarks must remain complete and visible "
            "(e.g. ุ ู ิ ี ึ ื ่ ้ ๊ ๋ ์).\n"
            "- Do not drop, merge, crop, or distort any Thai marks; spelling must be exactly correct.\n"
            "- Keep extra vertical safety above/below text so lower vowels and upper tone marks are never cut.\n"
            "- Outline must stay outside glyph strokes and must not cover interior Thai marks."
        )

    async def generate_sticker_grid(
        self,
        image_uri: str,
        style_id: str,
        extra_prompt: Optional[str],
    ) -> bytes:
        """
        Calls Vertex AI Gemini model to generate a sticker grid.
        Returns the raw image bytes.
        """
        try:
            style_prompt = self._resolve_style_prompt(style_id)
            text_instruction = self._build_text_instruction(extra_prompt)
            character_likeness = (
                extra_prompt.strip()
                if extra_prompt and extra_prompt.strip()
                else "Maintain subject identity faithfully."
            )

            full_prompt = (
                f"{self.TECHNICAL_TOKENS}\n"
                "Objective: Create a professional 16-pose sticker sheet (4 columns x 4 rows) based on the uploaded photo.\n"
                f"{style_prompt}\n"
                f"{text_instruction}\n"
                f"Character Likeness: {character_likeness}\n"
                "Character should be positioned clearly in each grid cell."
            ).strip()

            image_part = Part.from_uri(image_uri, mime_type="image/jpeg")
            response = await self._generate_with_retry(
                contents=[image_part, full_prompt],
                generation_config=self.generation_config,
            )

            candidates = response.candidates or []
            if not candidates:
                raise ValueError("No candidates returned from AI model.")

            for part in candidates[0].content.parts:
                if part.inline_data:
                    return part.inline_data.data

            response_text = getattr(response, "text", None)
            if response_text:
                cleaned_text = response_text.strip()
                if self._looks_like_base64(cleaned_text):
                    return base64.b64decode(cleaned_text)
                logger.warning(
                    "Vertex AI returned text instead of image data. text_preview=%s",
                    cleaned_text[:200].replace("\n", " "),
                )

            # Debug logging to help diagnose missing image data
            try:
                first_candidate = candidates[0]
                parts = getattr(first_candidate.content, "parts", []) or []
                part_types = [
                    "inline_data" if getattr(p, "inline_data", None) else "text" if getattr(p, "text", None) else "other"
                    for p in parts
                ]
                logger.warning(
                    "Vertex AI returned no image data. model=%s candidates=%d parts=%s finish_reason=%s",
                    settings.VERTEX_MODEL,
                    len(candidates),
                    part_types,
                    getattr(first_candidate, "finish_reason", None),
                )
            except Exception:
                logger.warning("Vertex AI returned no image data (debug log failed).")

            raise ValueError("API returned success but no image data was found.")
        except Exception as e:
            logger.error(f"Error generating sticker grid: {e}")
            raise e

    async def _generate_with_retry(self, **kwargs):
        for attempt in range(self.max_retries + 1):
            try:
                return await self.model.generate_content_async(**kwargs)
            except Exception as e:
                if not self._is_retryable_error(e) or attempt >= self.max_retries:
                    raise
                delay = self.retry_base_delay * (2 ** attempt)
                delay += random.uniform(0, delay * 0.25)
                logger.warning("Vertex AI rate limit hit. Retrying in %.2fs (attempt %d/%d)", delay, attempt + 1, self.max_retries)
                await asyncio.sleep(delay)

    @staticmethod
    def _is_retryable_error(error: Exception) -> bool:
        if isinstance(error, (gax_exceptions.ResourceExhausted, gax_exceptions.TooManyRequests, gax_exceptions.ServiceUnavailable)):
            return True
        message = str(error).lower()
        return "429" in message or "resource exhausted" in message or "too many requests" in message

    @staticmethod
    def _looks_like_base64(value: str) -> bool:
        if not value:
            return False
        # Base64 should be ASCII only and length divisible by 4
        if len(value) % 4 != 0:
            return False
        if not re.fullmatch(r"[A-Za-z0-9+/=\s]+", value):
            return False
        return True
