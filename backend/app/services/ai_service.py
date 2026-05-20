import asyncio
import base64
import logging
import random
import re
from dataclasses import dataclass
from typing import Optional, Callable, Awaitable, Any

import httpx
import vertexai
from google.api_core import exceptions as gax_exceptions
from vertexai.generative_models import GenerativeModel, Part, GenerationConfig

from app.core.config import settings
from app.services.ai_capacity_limiter import AIProviderCapacityError, AI_CAPACITY_USER_MESSAGE, ai_provider_capacity_limiter
from app.utils.storage import StorageClient

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class StickerGridGenerationResult:
    image_bytes: bytes
    provider: str
    model_id: str
    prompt_profile: str


class AIService:
    LEGACY_PROMPT_PROFILE = "legacy"
    GEMINI_31_FLASH_PROMPT_PROFILE = "gemini_31_flash"
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
        "Canvas must be square 1:1 with exactly 4 columns and exactly 4 rows. "
        "Do not create a portrait sheet, landscape sheet, 4x5 grid, 5x4 grid, fifth row, or extra stickers. "
        "Add clear #00FF00 gutters between cells (12–16px). No elements may cross cell boundaries. "
        "Do not draw black grid lines, dividers, frames, borders, panels, or boxes between cells or around the full sheet. "
        "Cell separators must be empty pure #00FF00 gutters only. "
        "Every cell background must be solid #00FF00 edge-to-edge with no white or colored rectangular panels behind the subject or caption. "
        "Each sticker must be fully contained inside its own cell. "
        "Keep camera distance and subject scale consistent across all 16 cells. "
        "Each character should occupy roughly the same visual height in every cell, around 70-78% of the cell height. "
        "Captions must sit directly over the #00FF00 background; do not add green underlines, colored bars, highlight strips, baseline blocks, or caption boxes."
    )
    GEMINI_31_FLASH_PROMPT_ADDENDUM = (
        "MODEL-SPECIFIC RULES FOR GEMINI 3.1 FLASH IMAGE (CRITICAL):\n"
        "- Place every caption in the bottom quarter of its own cell, bottom-center only.\n"
        "- Never place caption text, title text, or large Thai words above the character's head.\n"
        "- Keep the area above hair, hats, props, and hands clean. Do not add stray curved strokes, loose black marks, small white outline scraps, sparkle crumbs, or detached accent marks near the top of a sticker.\n"
        "- Avoid decorative symbols that float above the subject unless the user explicitly asks for them; if used, keep them visually intentional, inside the cell, and not attached to the crop edge.\n"
        "- Keep character, props, caption, and shadow as one clean sticker silhouette that will survive chroma-key cropping."
    )
    GEMINI_31_FLASH_RETRY_PROMPT_ADDENDUM = (
        "GEMINI 3.1 QUALITY RETRY RULES (CRITICAL):\n"
        "- The previous output had crop/compliance risk. Regenerate the entire 4x4 sheet cleanly.\n"
        "- Captions must remain at bottom-center only; no top captions or title-like text above heads.\n"
        "- Remove all tiny floating fragments, broken shadow pieces, loose text-outline crumbs, detached slivers, and small black/white marks above hair.\n"
        "- Do not create random decorative strokes, stray punctuation, loose zzz marks, spark crumbs, or accent marks that are not part of the Thai caption.\n"
        "- Use simple empty #00FF00 gutters and keep every sticker fully inside its own cell."
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
    QUOTED_CAPTION_PATTERN = re.compile(r"[\"“”']([^\"“”'\n]{1,32})[\"“”']")
    GEMINI_PROVIDER_ALIASES = {"gemini_api", "gemini", "ai_studio", "genai"}
    RATE_LIMIT_USER_MESSAGE = AI_CAPACITY_USER_MESSAGE

    def __init__(self) -> None:
        self.provider = (settings.GENAI_PROVIDER or "vertex").strip().lower()
        if self.provider == "auto":
            self.provider = "gemini_api" if settings.GEMINI_API_KEY else "vertex"

        self.max_retries = max(0, settings.GENERATION_MAX_RETRIES)
        self.retry_base_delay = max(0.1, float(settings.GENERATION_RETRY_BASE_DELAY))
        self.fallback_provider = (settings.GENAI_FALLBACK_PROVIDER or "").strip().lower()
        self.fallback_max_retries = max(0, settings.GENAI_FALLBACK_MAX_RETRIES)
        self.gemini_api_key = settings.GEMINI_API_KEY
        self.gemini_api_base_url = settings.GEMINI_API_BASE_URL.rstrip("/")
        self.model_routing_enabled = bool(settings.GENAI_MODEL_ROUTING_ENABLED)
        self.vertex_model_ids = self._build_vertex_model_route()
        self.model_id = self.vertex_model_ids[0]
        self.prompt_profile_setting = (settings.GENAI_PROMPT_PROFILE or "auto").strip().lower()
        self.gemini_api_fallback_model_id = (
            (settings.GENAI_GEMINI_API_FALLBACK_MODEL or "").strip()
            or settings.VERTEX_MODEL.strip()
            or self.model_id
        )
        self._vertex_models: dict[str, GenerativeModel] = {}

        try:
            if self.provider in self.GEMINI_PROVIDER_ALIASES:
                if not self.gemini_api_key:
                    raise ValueError("GEMINI_API_KEY is required when GENAI_PROVIDER=gemini_api.")
                self.model = None
                self.generation_config = None
                logger.info("Gemini API (AI Studio) client initialized.")
            elif self.provider == "vertex":
                vertexai.init(project=settings.PROJECT_ID, location=settings.VERTEX_LOCATION)
                self.generation_config = GenerationConfig(
                    response_modalities=[GenerationConfig.Modality.IMAGE]
                )
                self.model = self._get_vertex_model(self.model_id)
                logger.info(
                    "Vertex AI model initialized. routing_enabled=%s route=%s",
                    self.model_routing_enabled,
                    self.vertex_model_ids,
                )
            else:
                raise ValueError(f"Unsupported GENAI_PROVIDER: {self.provider}")
        except Exception as e:
            logger.error(f"Failed to initialize AI provider ({self.provider}): {e}")
            raise e

    def _build_vertex_model_route(self) -> list[str]:
        if not self.model_routing_enabled:
            return [settings.VERTEX_MODEL.strip()]

        route_value = (settings.GENAI_VERTEX_MODEL_ROUTE or "").strip()
        if route_value:
            candidates = [item.strip() for item in route_value.split(",")]
        else:
            candidates = [
                (settings.PRIMARY_VERTEX_MODEL or settings.VERTEX_MODEL).strip(),
                (settings.FALLBACK_VERTEX_MODEL or "").strip(),
            ]

        route: list[str] = []
        seen: set[str] = set()
        for candidate in candidates:
            if not candidate or candidate in seen:
                continue
            route.append(candidate)
            seen.add(candidate)

        if not route:
            raise ValueError("GENAI model routing is enabled but no Vertex model route was configured.")
        return route

    def primary_vertex_model_id(self) -> str | None:
        if self.provider != "vertex" or not self.vertex_model_ids:
            return None
        return self.vertex_model_ids[0]

    def quality_fallback_vertex_model_ids(self) -> list[str]:
        if self.provider != "vertex" or not settings.GENAI_QUALITY_FALLBACK_ENABLED:
            return []
        return self.vertex_model_ids[1:]

    def _get_vertex_model(self, model_id: str) -> GenerativeModel:
        model = self._vertex_models.get(model_id)
        if model is None:
            model = GenerativeModel(model_id)
            self._vertex_models[model_id] = model
        return model

    def _resolve_prompt_profile(self, model_id: str | None = None) -> str:
        configured = self.prompt_profile_setting
        if configured and configured not in {"auto", "default"}:
            normalized = configured.replace("-", "_").strip().lower()
            if normalized in {"gemini31_flash", "gemini_31", "gemini_31_flash", "3_1_flash"}:
                return self.GEMINI_31_FLASH_PROMPT_PROFILE
            if normalized in {"legacy", "gemini_30_pro", "gemini_3_pro", "default"}:
                return self.LEGACY_PROMPT_PROFILE
            logger.warning("Unknown GENAI_PROMPT_PROFILE=%s. Falling back to auto.", configured)

        candidate = (model_id or self.model_id or "").strip().lower()
        if "gemini-3.1-flash-image" in candidate or "gemini_3.1_flash_image" in candidate:
            return self.GEMINI_31_FLASH_PROMPT_PROFILE
        return self.LEGACY_PROMPT_PROFILE

    def _build_model_profile_instruction(self, prompt_profile: str, strict_cell_framing: bool) -> str:
        if prompt_profile != self.GEMINI_31_FLASH_PROMPT_PROFILE:
            return ""

        if strict_cell_framing:
            return f"{self.GEMINI_31_FLASH_PROMPT_ADDENDUM}\n{self.GEMINI_31_FLASH_RETRY_PROMPT_ADDENDUM}"
        return self.GEMINI_31_FLASH_PROMPT_ADDENDUM

    def _resolve_style_prompt(self, style_id: str) -> str:
        normalized = style_id.strip().lower()
        if normalized in {"chibi_2d", "chibi-2d", "chibi 2d", "chibi2d", "2d"}:
            return self.LOCKED_PROMPT_CHIBI_2D
        if normalized in {"pixar_3d", "pixar-3d", "pixar 3d", "pixar3d", "3d"}:
            return self.LOCKED_PROMPT_PIXAR_3D
        raise ValueError(f"Unsupported style_id: {style_id}. Expected chibi_2d or pixar_3d.")

    def _extract_explicit_captions(self, extra_prompt: Optional[str]) -> list[str]:
        if not extra_prompt:
            return []

        captions: list[str] = []
        seen: set[str] = set()
        for match in self.QUOTED_CAPTION_PATTERN.findall(extra_prompt):
            caption = " ".join(match.split()).strip()
            if not caption or caption in seen:
                continue
            if len(caption) > 24:
                continue
            seen.add(caption)
            captions.append(caption)

        return captions[:16]

    def _build_text_instruction(self, extra_prompt: Optional[str]) -> str:
        no_text_requested = bool(extra_prompt and self.NO_TEXT_PATTERN.search(extra_prompt))
        if no_text_requested:
            return "Generate stickers without any text captions."

        explicit_captions = self._extract_explicit_captions(extra_prompt)
        if explicit_captions:
            return (
                "MANDATORY TEXT CAPTIONS:\n"
                f"- Use these user-provided captions exactly as written, preserving order when possible: {', '.join(explicit_captions)}.\n"
                "- Do not replace them with generic LINE sticker phrases.\n"
                "- If the sheet has more cells than provided captions, create the remaining captions in the same tone and theme as the user prompt.\n"
                "- Place caption at bottom-center of each cell, clearly separated from face/hands.\n"
                "- Typography style: Google Fonts look (Kanit ExtraBold or Noto Sans Thai Black style).\n"
                "- Text render: solid black letters with thick white outline and soft shadow for high readability.\n"
                "- Caption background must remain transparent over the solid #00FF00 cell background; no boxes, panels, bars, underlines, or highlight strips behind text.\n"
                "- Keep caption large and readable in chat size, but do not clip text at cell edges.\n"
                "- Thai glyph integrity is mandatory: all vowels/diacritics/tonemarks must remain complete and visible.\n"
                "- Do not drop, merge, crop, or distort any Thai marks.\n"
                "- Keep extra vertical safety above/below text so lower vowels and upper tone marks are never cut.\n"
                "- Outline must stay outside glyph strokes and must not cover interior Thai marks."
            )

        if extra_prompt and extra_prompt.strip():
            return (
                "TEXT CAPTION POLICY:\n"
                "- Derive captions from the user's prompt and theme below.\n"
                "- Do not fall back to the default generic caption set unless the user explicitly asks for it.\n"
                "- Make captions, poses, mood, and props clearly reflect the user's requested scenario.\n"
                "- Keep each caption short, chat-friendly, and semantically varied across the sheet.\n"
                "- Place caption at bottom-center of each cell, clearly separated from face/hands.\n"
                "- Typography style: Google Fonts look (Kanit ExtraBold or Noto Sans Thai Black style).\n"
                "- Text render: solid black letters with thick white outline and soft shadow for high readability.\n"
                "- Caption background must remain transparent over the solid #00FF00 cell background; no boxes, panels, bars, underlines, or highlight strips behind text.\n"
                "- Keep caption large and readable in chat size, but do not clip text at cell edges.\n"
                "- Thai glyph integrity is mandatory: all vowels/diacritics/tonemarks must remain complete and visible.\n"
                "- Do not drop, merge, crop, or distort any Thai marks.\n"
                "- Keep extra vertical safety above/below text so lower vowels and upper tone marks are never cut.\n"
                "- Outline must stay outside glyph strokes and must not cover interior Thai marks."
            )

        return (
            "MANDATORY TEXT CAPTIONS:\n"
            f"- Add one short Thai caption per sticker using this set: {', '.join(self.DEFAULT_THAI_CAPTIONS)}.\n"
            "- Place caption at bottom-center of each cell, clearly separated from face/hands.\n"
            "- Typography style: Google Fonts look (Kanit ExtraBold or Noto Sans Thai Black style).\n"
            "- Text render: solid black letters with thick white outline and soft shadow for high readability.\n"
            "- Caption background must remain transparent over the solid #00FF00 cell background; no boxes, panels, bars, underlines, or highlight strips behind text.\n"
            "- Keep caption large and readable in chat size, but do not clip text at cell edges.\n"
            "- Thai glyph integrity is mandatory: all vowels/diacritics/tonemarks must remain complete and visible "
            "(e.g. ุ ู ิ ี ึ ื ่ ้ ๊ ๋ ์).\n"
            "- Do not drop, merge, crop, or distort any Thai marks; spelling must be exactly correct.\n"
            "- Keep extra vertical safety above/below text so lower vowels and upper tone marks are never cut.\n"
            "- Outline must stay outside glyph strokes and must not cover interior Thai marks."
        )

    def _build_user_direction_instruction(self, extra_prompt: Optional[str]) -> str:
        if extra_prompt and extra_prompt.strip():
            prompt_text = extra_prompt.strip()
            return (
                "USER CREATIVE DIRECTION (HIGH PRIORITY):\n"
                f"{prompt_text}\n"
                "- Treat the user direction above as the primary source for caption wording, scene ideas, gestures, props, emotions, and overall tone.\n"
                "- Keep the same person identity from the uploaded photo, but adapt the sticker set to the user's requested concept.\n"
                "- Avoid reverting to the standard generic greeting/thanks/okay sticker pack unless the user explicitly asks for those phrases."
            )

        return (
            "USER CREATIVE DIRECTION:\n"
            "- Maintain subject identity faithfully.\n"
            "- Use a natural, chat-friendly variety of poses and expressions."
        )

    def _build_full_prompt(
        self,
        style_id: str,
        extra_prompt: Optional[str],
        strict_cell_framing: bool,
        model_id: str | None = None,
    ) -> tuple[str, str]:
        prompt_profile = self._resolve_prompt_profile(model_id)
        style_prompt = self._resolve_style_prompt(style_id)
        text_instruction = self._build_text_instruction(extra_prompt)
        user_direction = self._build_user_direction_instruction(extra_prompt)
        model_profile_instruction = self._build_model_profile_instruction(
            prompt_profile=prompt_profile,
            strict_cell_framing=strict_cell_framing,
        )
        framing_retry_instruction = (
            "FRAMING RETRY RULES (CRITICAL):\n"
            "- Output exactly 16 stickers arranged in a strict 4 columns x 4 rows grid on a square 1:1 canvas.\n"
            "- Do not produce a portrait sheet, landscape sheet, 4x5, 5x4, 5x3, 15 stickers, a fifth row, or any other layout.\n"
            "- Keep every prop, limb, caption, and accessory fully inside its own cell with extra margin.\n"
            "- Reserve at least 10% empty space from every cell edge; do not let any object or text touch the boundary.\n"
            "- Maintain the same camera distance and same subject size across all cells; do not mix close-up stickers with full-body stickers.\n"
            "- Keep each character at a consistent scale, targeting about 72-76% of the cell height.\n"
            "- Hanging props near the top, wide props near the sides, and Thai captions near the bottom must stay comfortably inside the safe area.\n"
            "- If a composition feels tight, make the character and props slightly smaller rather than filling the cell.\n"
            "- Do not add visible grid outlines, black divider lines, or rectangular panels while correcting framing.\n"
            if strict_cell_framing
            else ""
        )

        full_prompt = (
            f"{self.TECHNICAL_TOKENS}\n"
            "Objective: Create a professional 16-pose sticker sheet (4 columns by 4 rows) on a square 1:1 canvas based on the uploaded photo.\n"
            f"{style_prompt}\n"
            f"{text_instruction}\n"
            f"{user_direction}\n"
            f"{model_profile_instruction}\n"
            f"{framing_retry_instruction}\n"
            "Subject Identity Rule: maintain recognizable facial identity from the uploaded photo.\n"
            "Character should be positioned clearly in each grid cell."
        ).strip()
        return full_prompt, prompt_profile

    async def generate_sticker_grid(
        self,
        image_uri: str,
        style_id: str,
        extra_prompt: Optional[str],
        strict_cell_framing: bool = False,
    ) -> bytes:
        result = await self.generate_sticker_grid_with_metadata(
            image_uri=image_uri,
            style_id=style_id,
            extra_prompt=extra_prompt,
            strict_cell_framing=strict_cell_framing,
        )
        return result.image_bytes

    async def generate_sticker_grid_with_metadata(
        self,
        image_uri: str,
        style_id: str,
        extra_prompt: Optional[str],
        strict_cell_framing: bool = False,
        vertex_model_route_override: list[str] | None = None,
    ) -> StickerGridGenerationResult:
        """
        Calls Vertex AI Gemini model to generate a sticker grid.
        Returns the raw image bytes.
        """
        try:
            if self.provider in self.GEMINI_PROVIDER_ALIASES:
                full_prompt, prompt_profile = self._build_full_prompt(
                    style_id=style_id,
                    extra_prompt=extra_prompt,
                    strict_cell_framing=strict_cell_framing,
                    model_id=self.model_id,
                )
                async with ai_provider_capacity_limiter(provider="gemini_api", model_id=self.model_id):
                    image_bytes = await self._generate_with_gemini_api(
                        image_uri=image_uri,
                        prompt=full_prompt,
                        max_retries=self.max_retries,
                        provider_label="Gemini API",
                        model_id=self.model_id,
                    )
                return StickerGridGenerationResult(
                    image_bytes=image_bytes,
                    provider="gemini_api",
                    model_id=self.model_id,
                    prompt_profile=prompt_profile,
                )

            if self.provider == "vertex":
                return await self._generate_with_vertex_route(
                    image_uri=image_uri,
                    style_id=style_id,
                    extra_prompt=extra_prompt,
                    strict_cell_framing=strict_cell_framing,
                    vertex_model_ids=vertex_model_route_override,
                )

            raise ValueError(f"Unsupported GENAI_PROVIDER: {self.provider}")
        except Exception as e:
            logger.error(f"Error generating sticker grid: {e}")
            raise e

    async def _generate_with_vertex_route(
        self,
        image_uri: str,
        style_id: str,
        extra_prompt: Optional[str],
        strict_cell_framing: bool,
        vertex_model_ids: list[str] | None = None,
    ) -> StickerGridGenerationResult:
        last_retryable_error: Exception | None = None
        route = [model_id for model_id in (vertex_model_ids or self.vertex_model_ids) if model_id]
        if not route:
            raise ValueError("No Vertex model route configured.")

        for index, model_id in enumerate(route):
            provider_label = f"Vertex AI ({model_id})"
            prompt, prompt_profile = self._build_full_prompt(
                style_id=style_id,
                extra_prompt=extra_prompt,
                strict_cell_framing=strict_cell_framing,
                model_id=model_id,
            )
            try:
                async with ai_provider_capacity_limiter(provider="vertex", model_id=model_id):
                    image_bytes = await self._generate_with_vertex(
                        image_uri=image_uri,
                        prompt=prompt,
                        max_retries=self.max_retries,
                        provider_label=provider_label,
                        model_id=model_id,
                    )
                return StickerGridGenerationResult(
                    image_bytes=image_bytes,
                    provider="vertex",
                    model_id=model_id,
                    prompt_profile=prompt_profile,
                )
            except AIProviderCapacityError:
                raise
            except Exception as e:
                if not self._is_retryable_error(e):
                    raise
                last_retryable_error = e
                has_next_vertex_model = index < len(route) - 1
                if has_next_vertex_model:
                    next_model = route[index + 1]
                    logger.warning(
                        "Vertex model %s exhausted. Trying fallback Vertex model %s.",
                        model_id,
                        next_model,
                    )

        if self.fallback_provider in self.GEMINI_PROVIDER_ALIASES and self.gemini_api_key:
            api_model_id = self.gemini_api_fallback_model_id
            prompt, prompt_profile = self._build_full_prompt(
                style_id=style_id,
                extra_prompt=extra_prompt,
                strict_cell_framing=strict_cell_framing,
                model_id=api_model_id,
            )
            logger.warning(
                "Vertex model route exhausted. Falling back to Gemini API model %s.",
                api_model_id,
            )
            try:
                async with ai_provider_capacity_limiter(provider="gemini_api", model_id=api_model_id):
                    image_bytes = await self._generate_with_gemini_api(
                        image_uri=image_uri,
                        prompt=prompt,
                        max_retries=self.fallback_max_retries,
                        provider_label=f"Gemini API fallback ({api_model_id})",
                        model_id=api_model_id,
                    )
                return StickerGridGenerationResult(
                    image_bytes=image_bytes,
                    provider="gemini_api",
                    model_id=api_model_id,
                    prompt_profile=prompt_profile,
                )
            except Exception as fallback_error:
                if self._is_retryable_error(fallback_error):
                    raise AIProviderCapacityError() from fallback_error
                raise

        raise AIProviderCapacityError() from last_retryable_error

    async def _generate_with_vertex(
        self,
        image_uri: str,
        prompt: str,
        max_retries: Optional[int] = None,
        provider_label: str = "Vertex AI",
        model_id: str | None = None,
    ) -> bytes:
        resolved_model_id = model_id or self.model_id
        model = self._get_vertex_model(resolved_model_id)
        image_part = Part.from_uri(image_uri, mime_type="image/jpeg")

        async def _call():
            return await model.generate_content_async(
                contents=[image_part, prompt],
                generation_config=self.generation_config,
            )

        response = await self._generate_with_retry(
            _call,
            max_retries=max_retries,
            provider_label=provider_label,
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
                resolved_model_id,
                len(candidates),
                part_types,
                getattr(first_candidate, "finish_reason", None),
            )
        except Exception:
            logger.warning("Vertex AI returned no image data (debug log failed).")

        raise ValueError("API returned success but no image data was found.")

    async def _generate_with_gemini_api(
        self,
        image_uri: str,
        prompt: str,
        max_retries: Optional[int] = None,
        provider_label: str = "Gemini API",
        model_id: str | None = None,
    ) -> bytes:
        resolved_model_id = model_id or self.model_id
        image_bytes = await self._load_image_bytes(image_uri)
        mime_type = self._guess_mime_type(image_bytes)
        image_b64 = base64.b64encode(image_bytes).decode("ascii")

        payload = {
            "contents": [
                {
                    "parts": [
                        {"inlineData": {"mimeType": mime_type, "data": image_b64}},
                        {"text": prompt},
                    ]
                }
            ],
            "generationConfig": {
                "responseModalities": ["IMAGE"],
                "imageConfig": {
                    "aspectRatio": settings.GEMINI_IMAGE_ASPECT_RATIO,
                    "imageSize": settings.GEMINI_IMAGE_SIZE,
                },
            },
        }

        async def _call():
            return await self._request_gemini_api(payload, model_id=resolved_model_id)

        data = await self._generate_with_retry(
            _call,
            max_retries=max_retries,
            provider_label=provider_label,
        )

        candidates = data.get("candidates") or []
        if not candidates:
            raise ValueError("No candidates returned from Gemini API.")

        parts = (candidates[0].get("content") or {}).get("parts") or []
        for part in parts:
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                return base64.b64decode(inline["data"])

        raise ValueError("API returned success but no image data was found.")

    async def _request_gemini_api(self, payload: dict, model_id: str | None = None) -> dict:
        resolved_model_id = model_id or self.model_id
        url = f"{self.gemini_api_base_url}/v1beta/models/{resolved_model_id}:generateContent"
        params = {"key": self.gemini_api_key}
        timeout = httpx.Timeout(120.0)

        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, params=params, json=payload)

        if response.status_code in {429, 500, 502, 503, 504}:
            raise RuntimeError(f"{response.status_code} Resource exhausted or service unavailable.")

        if response.status_code >= 400:
            raise RuntimeError(f"Gemini API error {response.status_code}: {response.text}")

        data = response.json()
        error = data.get("error")
        if error:
            status_value = str(error.get("status") or "").upper()
            message = error.get("message") or "Gemini API error."
            if "RESOURCE_EXHAUSTED" in status_value or "429" in message:
                raise RuntimeError(f"429 Resource exhausted. {message}")
            raise RuntimeError(message)

        return data

    async def _generate_with_retry(
        self,
        call: Callable[[], Awaitable[Any]],
        max_retries: Optional[int] = None,
        provider_label: str = "AI",
    ) -> Any:
        retries = self.max_retries if max_retries is None else max(0, max_retries)
        for attempt in range(retries + 1):
            try:
                return await call()
            except Exception as e:
                if not self._is_retryable_error(e) or attempt >= retries:
                    raise
                delay = self.retry_base_delay * (2 ** attempt)
                delay += random.uniform(0, delay * 0.25)
                logger.warning(
                    "%s rate limit hit. Retrying in %.2fs (attempt %d/%d)",
                    provider_label,
                    delay,
                    attempt + 1,
                    retries,
                )
                await asyncio.sleep(delay)

    async def _load_image_bytes(self, image_uri: str) -> bytes:
        if image_uri.startswith("gs://"):
            storage_client = StorageClient()
            return await asyncio.to_thread(storage_client.download_gcs_uri, image_uri)

        if image_uri.startswith("http://") or image_uri.startswith("https://"):
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(image_uri)
                response.raise_for_status()
                return response.content

        if image_uri.startswith("data:image"):
            base64_data = image_uri.split(",", 1)[-1]
            return base64.b64decode(base64_data)

        raise ValueError(f"Unsupported image URI: {image_uri}")

    @staticmethod
    def _is_retryable_error(error: Exception) -> bool:
        if isinstance(error, (gax_exceptions.ResourceExhausted, gax_exceptions.TooManyRequests, gax_exceptions.ServiceUnavailable)):
            return True
        message = str(error).lower()
        return (
            "429" in message
            or "resource exhausted" in message
            or "too many requests" in message
            or "service unavailable" in message
            or "unavailable" in message
            or "gateway timeout" in message
            or "timeout" in message
        )

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

    @staticmethod
    def _guess_mime_type(image_bytes: bytes) -> str:
        if image_bytes[:2] == b"\xff\xd8":
            return "image/jpeg"
        if image_bytes[:4] == b"\x89PNG":
            return "image/png"
        if image_bytes[:4] == b"RIFF":
            return "image/webp"
        return "image/jpeg"
