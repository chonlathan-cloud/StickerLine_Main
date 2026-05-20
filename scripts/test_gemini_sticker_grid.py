#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from google import genai
    from google.genai import types
except ModuleNotFoundError as exc:
    raise SystemExit(
        "Missing google-genai package. Install it in your local venv first:\n"
        "  .venv/bin/pip install google-genai\n"
        "This script is intentionally standalone and does not require changing production requirements."
    ) from exc


DEFAULT_PROJECT_ID = "skitkerline"
DEFAULT_LOCATION = "global"
DEFAULT_MODEL = "gemini-3.1-flash-image-preview"
DEFAULT_IMAGE = "/Users/chonlathansongsri/Documents/Manee-son/SubProject/bug/TestModel/PictureforTest.jpg"
DEFAULT_OUTPUT_DIR = "Infra/model_test_outputs"

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
    "Add clear #00FF00 gutters between cells (12-16px). No elements may cross cell boundaries. "
    "Do not draw black grid lines, dividers, frames, borders, panels, or boxes between cells or around the full sheet. "
    "Cell separators must be empty pure #00FF00 gutters only. "
    "Every cell background must be solid #00FF00 edge-to-edge with no white or colored rectangular panels behind the subject or caption. "
    "Each sticker must be fully contained inside its own cell. "
    "Keep camera distance and subject scale consistent across all 16 cells. "
    "Each character should occupy roughly the same visual height in every cell, around 70-78% of the cell height. "
    "Captions must sit directly over the #00FF00 background; do not add green underlines, colored bars, highlight strips, baseline blocks, or caption boxes."
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
GEMINI_31_FLASH_PROMPT_ADDENDUM = (
    "MODEL-SPECIFIC RULES FOR GEMINI 3.1 FLASH IMAGE (CRITICAL):\n"
    "- Place every caption in the bottom quarter of its own cell, bottom-center only.\n"
    "- Never place caption text, title text, or large Thai words above the character's head.\n"
    "- Keep the area above hair, hats, props, and hands clean. Do not add stray curved strokes, loose black marks, small white outline scraps, sparkle crumbs, or detached accent marks near the top of a sticker.\n"
    "- Avoid decorative symbols that float above the subject unless the user explicitly asks for them; if used, keep them visually intentional, inside the cell, and not attached to the crop edge.\n"
    "- Keep character, props, caption, and shadow as one clean sticker silhouette that will survive chroma-key cropping."
)


def utc_now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def resolve_style_prompt(style_id: str) -> str:
    normalized = style_id.strip().lower()
    if normalized in {"chibi_2d", "chibi-2d", "chibi 2d", "chibi2d", "2d"}:
        return LOCKED_PROMPT_CHIBI_2D
    if normalized in {"pixar_3d", "pixar-3d", "pixar 3d", "pixar3d", "3d"}:
        return LOCKED_PROMPT_PIXAR_3D
    raise ValueError("Unsupported style. Use chibi_2d or pixar_3d.")


def build_text_instruction(no_text: bool) -> str:
    if no_text:
        return "Generate stickers without any text captions."

    return (
        "MANDATORY TEXT CAPTIONS:\n"
        f"- Add one short Thai caption per sticker using this set: {', '.join(DEFAULT_THAI_CAPTIONS)}.\n"
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


def build_model_profile_instruction(model_id: str | None) -> str:
    if model_id and "gemini-3.1-flash-image" in model_id.strip().lower():
        return GEMINI_31_FLASH_PROMPT_ADDENDUM
    return ""


def build_prompt(style_id: str, extra_prompt: str | None, no_text: bool, model_id: str | None = None) -> str:
    user_direction = (
        "USER CREATIVE DIRECTION (HIGH PRIORITY):\n"
        f"{extra_prompt.strip()}\n"
        "- Treat the user direction above as the primary source for scene ideas, gestures, props, emotions, and overall tone.\n"
        "- Keep the same person identity from the uploaded photo, but adapt the sticker set to the user's requested concept."
        if extra_prompt and extra_prompt.strip()
        else (
            "USER CREATIVE DIRECTION:\n"
            "- Maintain subject identity faithfully.\n"
            "- Use a natural, chat-friendly variety of poses and expressions."
        )
    )

    return (
        f"{TECHNICAL_TOKENS}\n"
        "Objective: Create a professional 16-pose sticker sheet (4 columns by 4 rows) on a square 1:1 canvas based on the uploaded photo.\n"
        f"{resolve_style_prompt(style_id)}\n"
        f"{build_text_instruction(no_text)}\n"
        f"{user_direction}\n"
        f"{build_model_profile_instruction(model_id)}\n"
        "Subject Identity Rule: maintain recognizable facial identity from the uploaded photo.\n"
        "Character should be positioned clearly in each grid cell."
    ).strip()


def guess_mime_type(path_or_uri: str) -> str:
    guessed, _ = mimetypes.guess_type(path_or_uri)
    if guessed and guessed.startswith("image/"):
        return guessed
    return "image/jpeg"


def build_image_part(image: str) -> types.Part:
    mime_type = guess_mime_type(image)
    if image.startswith("gs://"):
        return types.Part.from_uri(file_uri=image, mime_type=mime_type)

    path = Path(image).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"Input image not found: {path}")
    return types.Part.from_bytes(data=path.read_bytes(), mime_type=mime_type)


def inline_data_to_bytes(inline_data: Any) -> tuple[bytes, str]:
    data = inline_data.data
    if isinstance(data, str):
        image_bytes = base64.b64decode(data)
    else:
        image_bytes = bytes(data)

    mime_type = getattr(inline_data, "mime_type", None) or getattr(inline_data, "mimeType", None) or "image/png"
    return image_bytes, mime_type


def extension_for_mime_type(mime_type: str) -> str:
    return {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
    }.get(mime_type.lower(), ".png")


def save_outputs(response: Any, output_dir: Path, prefix: str, metadata: dict[str, Any]) -> list[str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    saved_files: list[str] = []
    text_parts: list[str] = []

    candidates = getattr(response, "candidates", None) or []
    for candidate_index, candidate in enumerate(candidates):
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or []
        for part_index, part in enumerate(parts):
            if getattr(part, "text", None):
                text_parts.append(part.text)
                continue

            inline_data = getattr(part, "inline_data", None)
            if not inline_data:
                continue

            image_bytes, mime_type = inline_data_to_bytes(inline_data)
            suffix = extension_for_mime_type(mime_type)
            filename = f"{prefix}_candidate{candidate_index + 1}_image{part_index + 1}{suffix}"
            path = output_dir / filename
            path.write_bytes(image_bytes)
            saved_files.append(str(path))

    metadata["text_parts"] = text_parts
    metadata["saved_files"] = saved_files
    metadata_path = output_dir / f"{prefix}_metadata.json"
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    saved_files.append(str(metadata_path))

    if not any(not item.endswith("_metadata.json") for item in saved_files):
        raise RuntimeError(f"Model returned no image data. Metadata saved at {metadata_path}")

    return saved_files


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate one raw 4x4 sticker sheet with a Gemini image model for model-quality testing only. "
            "This script does not call production APIs, Firestore, GCS upload, Pub/Sub, or crop logic."
        )
    )
    parser.add_argument("--project", default=os.getenv("GOOGLE_CLOUD_PROJECT") or DEFAULT_PROJECT_ID)
    parser.add_argument("--location", default=os.getenv("GOOGLE_CLOUD_LOCATION") or DEFAULT_LOCATION)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--image", default=DEFAULT_IMAGE, help="Local image path or gs:// image URI.")
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--style", default="pixar_3d", choices=["pixar_3d", "chibi_2d"])
    parser.add_argument("--prompt", default=None, help="Optional extra creative direction.")
    parser.add_argument("--no-text", action="store_true", help="Generate stickers without Thai captions.")
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--image-size", default="2K")
    parser.add_argument("--aspect-ratio", default="1:1")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    prompt = build_prompt(style_id=args.style, extra_prompt=args.prompt, no_text=args.no_text, model_id=args.model)
    output_dir = Path(args.output_dir)
    prefix = f"{args.model.replace('/', '_')}_{utc_now_compact()}"

    print(f"Project: {args.project}")
    print(f"Location: {args.location}")
    print(f"Model: {args.model}")
    print(f"Input image: {args.image}")
    print(f"Output dir: {output_dir}")

    client = genai.Client(vertexai=True, project=args.project, location=args.location)
    image_part = build_image_part(args.image)
    started_at = time.monotonic()
    response = client.models.generate_content(
        model=args.model,
        contents=[image_part, types.Part.from_text(text=prompt)],
        config=types.GenerateContentConfig(
            response_modalities=[types.Modality.TEXT, types.Modality.IMAGE],
            temperature=args.temperature,
            image_config=types.ImageConfig(
                aspect_ratio=args.aspect_ratio,
                image_size=args.image_size,
            ),
        ),
    )
    elapsed_seconds = round(time.monotonic() - started_at, 3)

    metadata = {
        "project": args.project,
        "location": args.location,
        "model": args.model,
        "input_image": args.image,
        "style": args.style,
        "extra_prompt": args.prompt,
        "no_text": args.no_text,
        "temperature": args.temperature,
        "aspect_ratio": args.aspect_ratio,
        "image_size": args.image_size,
        "elapsed_seconds": elapsed_seconds,
        "prompt": prompt,
    }
    saved_files = save_outputs(response=response, output_dir=output_dir, prefix=prefix, metadata=metadata)

    print(f"Elapsed seconds: {elapsed_seconds}")
    print("Saved files:")
    for path in saved_files:
        print(f"- {path}")


if __name__ == "__main__":
    main()
