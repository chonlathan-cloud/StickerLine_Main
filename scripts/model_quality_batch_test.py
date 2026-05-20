#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image

try:
    from google import genai
    from google.genai import types
except ModuleNotFoundError as exc:
    raise SystemExit(
        "Missing google-genai package. Install it in your local venv first:\n"
        "  .venv/bin/pip install google-genai\n"
        "This script is intentionally standalone and does not require changing production requirements."
    ) from exc


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[0]
BACKEND_DIR = REPO_ROOT / "backend"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.image_service import ImageProcessor, UnsupportedStickerGridLayoutError  # noqa: E402
from test_gemini_sticker_grid import build_prompt, guess_mime_type, inline_data_to_bytes  # noqa: E402


DEFAULT_PROJECT_ID = "skitkerline"
DEFAULT_LOCATION = "global"
DEFAULT_MODEL = "gemini-3.1-flash-image-preview"
DEFAULT_IMAGE = "/Users/chonlathansongsri/Documents/Manee-son/SubProject/bug/TestModel/PictureforTest.jpg"
DEFAULT_MULTI_IMAGES = [
    "/Users/chonlathansongsri/Documents/Manee-son/SubProject/bug/TestModel/gemini-3.1-flash-test1.JPG",
    "/Users/chonlathansongsri/Documents/Manee-son/SubProject/bug/TestModel/gemini-3.1-flash-test2.jpeg",
    "/Users/chonlathansongsri/Documents/Manee-son/SubProject/bug/TestModel/gemini-3.1-flash-test3.jpg",
    "/Users/chonlathansongsri/Documents/Manee-son/SubProject/bug/TestModel/gemini-3.1-flash-test4.jpg",
]
DEFAULT_OUTPUT_ROOT = "Infra/model_test_outputs/batch_runs"
STRICT_QUALITY_RETRY_INSTRUCTION = (
    "QUALITY RETRY RULES (CRITICAL):\n"
    "- The previous output had small detached artifacts after chroma-key cropping.\n"
    "- Do not create any tiny floating fragments, broken shadow pieces, loose text-outline crumbs, or detached slivers.\n"
    "- Keep every character, prop, emoji, caption outline, and shadow visually connected to the sticker subject or caption.\n"
    "- Keep the bottom area under every caption clean. Avoid small leftover marks below Thai text.\n"
    "- Keep the top area above hair/props clean. Avoid detached highlight fragments near the top edge.\n"
    "- Keep all captions at bottom-center only. Do not place Thai captions above the character's head.\n"
    "- Remove all small black/white marks, stray strokes, sparkle crumbs, and loose accent marks above hair or props.\n"
    "- Use a clean, uniform bright green background and simple empty gutters between cells.\n"
    "- Keep all 16 stickers fully inside their cells with safe margins."
)


def utc_now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_name(value: str) -> str:
    return "".join(char if char.isalnum() or char in "._-" else "_" for char in value)


def resolve_path(value: str) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path
    return REPO_ROOT / path


def parse_image_list(args: argparse.Namespace) -> list[Path]:
    if args.images:
        raw_images = args.images
    elif args.images_file:
        raw_images = [
            line.strip()
            for line in Path(args.images_file).expanduser().read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
    elif args.use_default_multi_images:
        raw_images = DEFAULT_MULTI_IMAGES
    else:
        raw_images = [args.image]

    images: list[Path] = []
    seen: set[str] = set()
    for raw_image in raw_images:
        path = resolve_path(raw_image)
        key = str(path)
        if key in seen:
            continue
        if not path.exists():
            raise FileNotFoundError(f"Input image not found: {path}")
        images.append(path)
        seen.add(key)

    if not images:
        raise ValueError("No input images provided.")
    return images


def build_attempt_prompt(base_prompt: str, quality_attempt: int) -> str:
    if quality_attempt <= 1:
        return base_prompt
    return f"{base_prompt}\n\n{STRICT_QUALITY_RETRY_INSTRUCTION}"


def nearest_rank(values: list[float], percentile: int) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(percentile / 100 * len(ordered)) - 1))
    return ordered[index]


def metric_summary(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "min": None, "max": None, "avg": None, "p50": None, "p95": None, "p99": None}
    return {
        "count": len(values),
        "min": round(min(values), 3),
        "max": round(max(values), 3),
        "avg": round(sum(values) / len(values), 3),
        "p50": round(nearest_rank(values, 50) or 0, 3),
        "p95": round(nearest_rank(values, 95) or 0, 3),
        "p99": round(nearest_rank(values, 99) or 0, 3),
    }


def image_info(path: Path) -> dict[str, Any]:
    with Image.open(path) as image:
        return {
            "format": image.format,
            "mode": image.mode,
            "width": image.width,
            "height": image.height,
        }


def png_info(image_bytes: bytes) -> dict[str, Any]:
    from io import BytesIO

    with Image.open(BytesIO(image_bytes)) as image:
        return {
            "mode": image.mode,
            "width": image.width,
            "height": image.height,
        }


def is_rate_limit_error(error: BaseException | str) -> bool:
    message = str(error).lower()
    return (
        "429" in message
        or "resource exhausted" in message
        or "quota" in message
        or "rate limit" in message
        or "too many requests" in message
    )


def extension_for_mime_type(mime_type: str) -> str:
    return {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
    }.get(mime_type.lower(), ".png")


def extract_first_image(response: Any) -> tuple[bytes, str]:
    candidates = getattr(response, "candidates", None) or []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or []
        for part in parts:
            inline_data = getattr(part, "inline_data", None)
            if not inline_data:
                continue
            return inline_data_to_bytes(inline_data)
    raise RuntimeError("Model returned no image data.")


def build_quality_warnings(
    sticker_count: int,
    edge_risks: list[dict],
    artifact_risks: list[dict],
    residual_screen_risks: list[dict],
    top_caption_risks: list[dict],
    top_attached_artifact_risks: list[dict],
    scale_consistency: dict,
) -> list[dict]:
    warnings: list[dict] = []
    if sticker_count != 16:
        warnings.append({
            "type": "layout_mismatch",
            "details": {
                "expected_sticker_count": 16,
                "actual_sticker_count": sticker_count,
            },
        })
    if edge_risks:
        warnings.append({"type": "edge_touch_risk", "details": edge_risks})
    if artifact_risks:
        warnings.append({"type": "detached_artifact_risk", "details": artifact_risks})
    if residual_screen_risks:
        warnings.append({"type": "residual_screen_risk", "details": residual_screen_risks})
    if top_caption_risks:
        warnings.append({"type": "top_caption_placement_risk", "details": top_caption_risks})
    if top_attached_artifact_risks:
        warnings.append({"type": "top_attached_artifact_risk", "details": top_attached_artifact_risks})
    if scale_consistency.get("is_inconsistent"):
        warnings.append({"type": "scale_inconsistency", "details": scale_consistency})
    return warnings


def risk_score(
    sticker_count: int,
    edge_risks: list[dict],
    artifact_risks: list[dict],
    residual_screen_risks: list[dict],
    top_caption_risks: list[dict],
    top_attached_artifact_risks: list[dict],
    scale_consistency: dict,
) -> int:
    return (
        abs(16 - sticker_count) * 1000
        + sum(int(item.get("severity", 0)) for item in edge_risks)
        + (sum(int(item.get("severity", 0)) for item in artifact_risks) * 50)
        + (sum(int(item.get("severity", 0)) for item in residual_screen_risks) * 40)
        + (sum(int(item.get("severity", 0)) for item in top_caption_risks) * 80)
        + (sum(int(item.get("severity", 0)) for item in top_attached_artifact_risks) * 60)
        + int(round(float(scale_consistency.get("std_ratio", 0.0)) * 1000))
        + (len(scale_consistency.get("outliers") or []) * 10)
    )


def write_stickers(sticker_pngs: list[bytes], output_dir: Path) -> list[dict[str, Any]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    outputs: list[dict[str, Any]] = []
    for index, sticker_png in enumerate(sticker_pngs, start=1):
        path = output_dir / f"sticker_{index:02d}.png"
        path.write_bytes(sticker_png)
        outputs.append({
            "index": index - 1,
            "path": str(path),
            "bytes": len(sticker_png),
            **png_info(sticker_png),
        })
    return outputs


def generate_grid_with_retry(
    args: argparse.Namespace,
    prompt: str,
    image_bytes: bytes,
    mime_type: str,
    sequence: int,
) -> dict[str, Any]:
    attempts: list[dict[str, Any]] = []
    max_attempts = max(1, args.generate_retries + 1)
    for attempt in range(max_attempts):
        started_at = time.monotonic()
        try:
            client = genai.Client(vertexai=True, project=args.project, location=args.location)
            response = client.models.generate_content(
                model=args.model,
                contents=[
                    types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
                    types.Part.from_text(text=prompt),
                ],
                config=types.GenerateContentConfig(
                    response_modalities=[types.Modality.TEXT, types.Modality.IMAGE],
                    temperature=args.temperature,
                    image_config=types.ImageConfig(
                        aspect_ratio=args.aspect_ratio,
                        image_size=args.image_size,
                    ),
                ),
            )
            grid_bytes, output_mime_type = extract_first_image(response)
            return {
                "success": True,
                "sequence": sequence,
                "generate_attempts": attempt + 1,
                "generate_elapsed_seconds": round(time.monotonic() - started_at, 3),
                "grid_bytes": grid_bytes,
                "output_mime_type": output_mime_type,
                "attempts": attempts,
            }
        except Exception as exc:
            elapsed_seconds = round(time.monotonic() - started_at, 3)
            rate_limited = is_rate_limit_error(exc)
            attempts.append({
                "attempt": attempt + 1,
                "elapsed_seconds": elapsed_seconds,
                "error_type": type(exc).__name__,
                "error": str(exc),
                "rate_limited": rate_limited,
            })
            if attempt >= max_attempts - 1 or not rate_limited:
                return {
                    "success": False,
                    "sequence": sequence,
                    "generate_attempts": attempt + 1,
                    "generate_elapsed_seconds": elapsed_seconds,
                    "error_type": type(exc).__name__,
                    "error": str(exc),
                    "rate_limited": rate_limited,
                    "attempts": attempts,
                }
            delay = args.generate_retry_base_delay * (2 ** attempt)
            delay += random.uniform(0, delay * 0.25)
            time.sleep(delay)

    raise RuntimeError("unreachable")


def process_crop(grid_bytes: bytes, output_dir: Path) -> dict[str, Any]:
    processor = ImageProcessor()
    started_at = time.monotonic()
    sticker_pngs = processor.process_sticker_grid(grid_bytes)
    outputs = write_stickers(sticker_pngs, output_dir / "stickers")
    edge_risks = processor.assess_sticker_set_edge_risk(sticker_pngs)
    artifact_risks = processor.assess_sticker_set_artifact_risk(sticker_pngs)
    residual_screen_risks = processor.assess_sticker_set_residual_screen_risk(sticker_pngs)
    top_caption_risks = processor.assess_raw_grid_caption_placement_risk(grid_bytes)
    top_attached_artifact_risks = processor.assess_sticker_set_top_attached_artifact_risk(sticker_pngs)
    scale_consistency = processor.assess_subject_scale_consistency(sticker_pngs)
    sticker_count = len(sticker_pngs)
    quality_warnings = build_quality_warnings(
        sticker_count=sticker_count,
        edge_risks=edge_risks,
        artifact_risks=artifact_risks,
        residual_screen_risks=residual_screen_risks,
        top_caption_risks=top_caption_risks,
        top_attached_artifact_risks=top_attached_artifact_risks,
        scale_consistency=scale_consistency,
    )
    return {
        "crop_success": True,
        "crop_elapsed_seconds": round(time.monotonic() - started_at, 3),
        "sticker_count": sticker_count,
        "outputs": outputs,
        "edge_risks": edge_risks,
        "artifact_risks": artifact_risks,
        "residual_screen_risks": residual_screen_risks,
        "top_caption_risks": top_caption_risks,
        "top_attached_artifact_risks": top_attached_artifact_risks,
        "scale_consistency": scale_consistency,
        "quality_warnings": quality_warnings,
        "risk_score": risk_score(
            sticker_count=sticker_count,
            edge_risks=edge_risks,
            artifact_risks=artifact_risks,
            residual_screen_risks=residual_screen_risks,
            top_caption_risks=top_caption_risks,
            top_attached_artifact_risks=top_attached_artifact_risks,
            scale_consistency=scale_consistency,
        ),
    }


def write_job_summary(job_dir: Path, summary: dict[str, Any]) -> None:
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def candidate_is_better(candidate: dict[str, Any], best_candidate: dict[str, Any] | None) -> bool:
    if best_candidate is None:
        return True

    candidate_risk = int(candidate.get("risk_score", 10**9))
    best_risk = int(best_candidate.get("risk_score", 10**9))
    if candidate_risk != best_risk:
        return candidate_risk < best_risk

    candidate_warning_count = len(candidate.get("quality_warnings") or [])
    best_warning_count = len(best_candidate.get("quality_warnings") or [])
    if candidate_warning_count != best_warning_count:
        return candidate_warning_count < best_warning_count

    return int(candidate.get("quality_attempt", 10**9)) < int(best_candidate.get("quality_attempt", 10**9))


async def run_one_job(
    args: argparse.Namespace,
    prompt: str,
    image_bytes: bytes,
    mime_type: str,
    run_dir: Path,
    sequence: int,
    image_index: int,
    image_path: Path,
) -> dict[str, Any]:
    job_dir = run_dir / f"job_{sequence:03d}"
    max_quality_attempts = max(1, int(args.quality_attempts))
    summary: dict[str, Any] = {
        "sequence": sequence,
        "image_index": image_index,
        "image_path": str(image_path),
        "created_at": utc_now_iso(),
        "model": args.model,
        "success": False,
        "generate_success": False,
        "crop_success": False,
        "rate_limited": False,
        "quality_attempts_requested": max_quality_attempts,
        "quality_attempts_used": 0,
        "best_quality_attempt": None,
        "attempts": [],
    }

    best_candidate: dict[str, Any] | None = None
    total_generate_elapsed = 0.0
    total_crop_elapsed = 0.0

    for quality_attempt in range(1, max_quality_attempts + 1):
        attempt_dir = job_dir / f"attempt_{quality_attempt:02d}"
        attempt_prompt = build_attempt_prompt(prompt, quality_attempt)
        attempt_summary: dict[str, Any] = {
            "sequence": sequence,
            "quality_attempt": quality_attempt,
            "created_at": utc_now_iso(),
            "model": args.model,
            "success": False,
            "generate_success": False,
            "crop_success": False,
            "rate_limited": False,
        }
        print(f"[job {sequence:03d}] generate start attempt {quality_attempt}/{max_quality_attempts}")
        generate_result = await asyncio.to_thread(
            generate_grid_with_retry,
            args,
            attempt_prompt,
            image_bytes,
            mime_type,
            sequence,
        )
        attempt_summary.update({
            key: value
            for key, value in generate_result.items()
            if key not in {"grid_bytes"}
        })
        attempt_summary["generate_success"] = bool(generate_result.get("success"))
        attempt_summary["rate_limited"] = bool(generate_result.get("rate_limited"))
        summary["rate_limited"] = bool(summary["rate_limited"] or attempt_summary["rate_limited"])
        if generate_result.get("generate_elapsed_seconds") is not None:
            total_generate_elapsed += float(generate_result["generate_elapsed_seconds"])

        if not generate_result.get("success"):
            attempt_summary["success"] = False
            summary["attempts"].append(attempt_summary)
            write_job_summary(attempt_dir, attempt_summary)
            summary.update({
                "error_type": attempt_summary.get("error_type"),
                "error": attempt_summary.get("error"),
                "generate_attempts": attempt_summary.get("generate_attempts"),
            })
            print(f"[job {sequence:03d}] generate failed attempt {quality_attempt}: {attempt_summary.get('error_type')}")
            break

        grid_bytes = generate_result["grid_bytes"]
        suffix = extension_for_mime_type(str(generate_result.get("output_mime_type") or "image/png"))
        grid_path = attempt_dir / f"grid{suffix}"
        attempt_dir.mkdir(parents=True, exist_ok=True)
        grid_path.write_bytes(grid_bytes)
        attempt_summary["grid_path"] = str(grid_path)
        attempt_summary["grid_bytes"] = len(grid_bytes)
        attempt_summary["grid_image"] = image_info(grid_path)

        try:
            crop_result = await asyncio.to_thread(process_crop, grid_bytes, attempt_dir)
            attempt_summary.update(crop_result)
            if crop_result.get("crop_elapsed_seconds") is not None:
                total_crop_elapsed += float(crop_result["crop_elapsed_seconds"])
            attempt_summary["success"] = (
                bool(crop_result.get("crop_success"))
                and not crop_result.get("quality_warnings")
            )
            if candidate_is_better(attempt_summary, best_candidate):
                best_candidate = dict(attempt_summary)
            print(
                f"[job {sequence:03d}] attempt {quality_attempt} "
                f"generate={attempt_summary['generate_elapsed_seconds']}s "
                f"crop={attempt_summary['crop_elapsed_seconds']}s "
                f"risk={attempt_summary['risk_score']} warnings={len(attempt_summary['quality_warnings'])}"
            )
        except UnsupportedStickerGridLayoutError as exc:
            attempt_summary.update({
                "success": False,
                "crop_success": False,
                "crop_error_type": "UnsupportedStickerGridLayoutError",
                "crop_error": str(exc),
                "quality_warnings": [{
                    "type": "layout_mismatch",
                    "details": {
                        "expected_layout": "4x4",
                        "reason": str(exc),
                    },
                }],
                "risk_score": 1000,
            })
            if candidate_is_better(attempt_summary, best_candidate):
                best_candidate = dict(attempt_summary)
            print(f"[job {sequence:03d}] crop layout failed attempt {quality_attempt}")
        except Exception as exc:
            attempt_summary.update({
                "success": False,
                "crop_success": False,
                "crop_error_type": type(exc).__name__,
                "crop_error": str(exc),
            })
            print(f"[job {sequence:03d}] crop failed attempt {quality_attempt}: {type(exc).__name__}")
        finally:
            summary["attempts"].append(attempt_summary)
            summary["quality_attempts_used"] = quality_attempt
            write_job_summary(attempt_dir, attempt_summary)

        if attempt_summary.get("success"):
            break

    summary["total_generate_elapsed_seconds"] = round(total_generate_elapsed, 3)
    summary["total_crop_elapsed_seconds"] = round(total_crop_elapsed, 3)

    if best_candidate is not None:
        summary.update({
            key: value
            for key, value in best_candidate.items()
            if key
            not in {
                "attempts",
                "created_at",
                "model",
                "sequence",
                "success",
                "rate_limited",
            }
        })
        summary["generate_success"] = True
        summary["crop_success"] = bool(best_candidate.get("crop_success"))
        summary["best_quality_attempt"] = best_candidate.get("quality_attempt")
        summary["success"] = bool(best_candidate.get("success"))
    else:
        summary["success"] = False

    write_job_summary(job_dir, summary)
    if summary.get("success"):
        print(
            f"[job {sequence:03d}] ok best_attempt={summary['best_quality_attempt']} "
            f"risk={summary.get('risk_score')} warnings={len(summary.get('quality_warnings') or [])}"
        )
    else:
        print(
            f"[job {sequence:03d}] best_available best_attempt={summary.get('best_quality_attempt')} "
            f"risk={summary.get('risk_score')} warnings={len(summary.get('quality_warnings') or [])}"
        )
    return summary


async def run_batch(args: argparse.Namespace) -> tuple[Path, list[dict[str, Any]], dict[str, Any]]:
    run_dir = Path(args.output_root) / f"{safe_name(args.model)}_{utc_now_compact()}"
    run_dir.mkdir(parents=True, exist_ok=True)
    prompt = build_prompt(style_id=args.style, extra_prompt=args.prompt, no_text=args.no_text, model_id=args.model)
    input_paths = parse_image_list(args)
    all_results: list[dict[str, Any]] = []
    started_at = time.monotonic()
    next_sequence = 1

    for image_index, input_path in enumerate(input_paths, start=1):
        image_bytes = input_path.read_bytes()
        mime_type = guess_mime_type(str(input_path))
        image_job_total = args.jobs_per_image if len(input_paths) > 1 else args.total_jobs
        remaining = image_job_total
        wave = 1
        print(f"Input image {image_index}/{len(input_paths)}: {input_path}")

        while remaining > 0:
            wave_size = min(args.burst_size, remaining)
            print(f"Submitting image {image_index} wave {wave}: {wave_size} jobs")
            tasks = [
                run_one_job(
                    args=args,
                    prompt=prompt,
                    image_bytes=image_bytes,
                    mime_type=mime_type,
                    run_dir=run_dir,
                    sequence=sequence,
                    image_index=image_index,
                    image_path=input_path,
                )
                for sequence in range(next_sequence, next_sequence + wave_size)
            ]
            all_results.extend(await asyncio.gather(*tasks))
            remaining -= wave_size
            next_sequence += wave_size
            wave += 1
            if remaining > 0 and args.wave_gap_seconds > 0:
                await asyncio.sleep(args.wave_gap_seconds)

    report = build_report(
        args=args,
        input_paths=input_paths,
        run_dir=run_dir,
        prompt=prompt,
        results=all_results,
        elapsed_seconds=round(time.monotonic() - started_at, 3),
    )
    (run_dir / "batch_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return run_dir, all_results, report


def build_report(
    args: argparse.Namespace,
    input_paths: list[Path],
    run_dir: Path,
    prompt: str,
    results: list[dict[str, Any]],
    elapsed_seconds: float,
) -> dict[str, Any]:
    generate_successes = [result for result in results if result.get("generate_success")]
    crop_successes = [result for result in results if result.get("crop_success")]
    full_successes = [result for result in results if result.get("success")]
    failed = [result for result in results if not result.get("success")]
    rate_limited = [
        result
        for result in results
        if result.get("rate_limited") or any(attempt.get("rate_limited") for attempt in result.get("attempts") or [])
    ]
    quality_warning_jobs = [result for result in results if result.get("quality_warnings")]
    quality_retry_jobs = [
        result for result in results
        if int(result.get("quality_attempts_used") or 0) > 1
    ]
    image_reports: list[dict[str, Any]] = []
    for image_index, input_path in enumerate(input_paths, start=1):
        image_results = [result for result in results if result.get("image_index") == image_index]
        image_generate_successes = [result for result in image_results if result.get("generate_success")]
        image_crop_successes = [result for result in image_results if result.get("crop_success")]
        image_full_successes = [result for result in image_results if result.get("success")]
        image_rate_limited = [
            result for result in image_results
            if result.get("rate_limited") or any(attempt.get("rate_limited") for attempt in result.get("attempts") or [])
        ]
        image_quality_warning_jobs = [result for result in image_results if result.get("quality_warnings")]
        image_quality_retry_jobs = [
            result for result in image_results
            if int(result.get("quality_attempts_used") or 0) > 1
        ]
        image_reports.append({
            "image_index": image_index,
            "input_image": str(input_path),
            "input_image_info": image_info(input_path),
            "counts": {
                "total": len(image_results),
                "generate_success": len(image_generate_successes),
                "crop_success": len(image_crop_successes),
                "full_success": len(image_full_successes),
                "failed": len([result for result in image_results if not result.get("success")]),
                "rate_limited": len(image_rate_limited),
                "quality_warning_jobs": len(image_quality_warning_jobs),
                "quality_retry_jobs": len(image_quality_retry_jobs),
            },
            "metrics": {
                "generate_elapsed_seconds": metric_summary([
                    float(result["generate_elapsed_seconds"])
                    for result in image_generate_successes
                    if result.get("generate_elapsed_seconds") is not None
                ]),
                "total_generate_elapsed_seconds": metric_summary([
                    float(result["total_generate_elapsed_seconds"])
                    for result in image_results
                    if result.get("total_generate_elapsed_seconds") is not None
                ]),
                "risk_score": metric_summary([
                    float(result["risk_score"])
                    for result in image_crop_successes
                    if result.get("risk_score") is not None
                ]),
            },
        })
    total_requested_jobs = len(results)

    return {
        "created_at": utc_now_iso(),
        "run_dir": str(run_dir),
        "project": args.project,
        "location": args.location,
        "model": args.model,
        "input_images": [str(path) for path in input_paths],
        "input_image_infos": [image_info(path) for path in input_paths],
        "total_jobs": total_requested_jobs,
        "configured_total_jobs": args.total_jobs,
        "jobs_per_image": args.jobs_per_image,
        "burst_size": args.burst_size,
        "wave_gap_seconds": args.wave_gap_seconds,
        "generate_retries": args.generate_retries,
        "generate_retry_base_delay": args.generate_retry_base_delay,
        "quality_attempts": args.quality_attempts,
        "style": args.style,
        "extra_prompt": args.prompt,
        "no_text": args.no_text,
        "temperature": args.temperature,
        "aspect_ratio": args.aspect_ratio,
        "image_size": args.image_size,
        "elapsed_seconds": elapsed_seconds,
        "counts": {
            "generate_success": len(generate_successes),
            "crop_success": len(crop_successes),
            "full_success": len(full_successes),
            "failed": len(failed),
            "rate_limited": len(rate_limited),
            "quality_warning_jobs": len(quality_warning_jobs),
            "quality_retry_jobs": len(quality_retry_jobs),
        },
        "images": image_reports,
        "metrics": {
            "generate_elapsed_seconds": metric_summary([
                float(result["generate_elapsed_seconds"])
                for result in generate_successes
                if result.get("generate_elapsed_seconds") is not None
            ]),
            "crop_elapsed_seconds": metric_summary([
                float(result["crop_elapsed_seconds"])
                for result in crop_successes
                if result.get("crop_elapsed_seconds") is not None
            ]),
            "total_generate_elapsed_seconds": metric_summary([
                float(result["total_generate_elapsed_seconds"])
                for result in results
                if result.get("total_generate_elapsed_seconds") is not None
            ]),
            "total_crop_elapsed_seconds": metric_summary([
                float(result["total_crop_elapsed_seconds"])
                for result in results
                if result.get("total_crop_elapsed_seconds") is not None
            ]),
            "quality_attempts_used": metric_summary([
                float(result["quality_attempts_used"])
                for result in results
                if result.get("quality_attempts_used") is not None
            ]),
            "risk_score": metric_summary([
                float(result["risk_score"])
                for result in crop_successes
                if result.get("risk_score") is not None
            ]),
        },
        "failures": [
            {
                "sequence": result.get("sequence"),
                "image_index": result.get("image_index"),
                "image_path": result.get("image_path"),
                "generate_success": result.get("generate_success"),
                "crop_success": result.get("crop_success"),
                "rate_limited": result.get("rate_limited"),
                "error_type": result.get("error_type") or result.get("crop_error_type"),
                "error": result.get("error") or result.get("crop_error"),
                "risk_score": result.get("risk_score"),
                "quality_warning_count": len(result.get("quality_warnings") or []),
                "quality_warnings": result.get("quality_warnings"),
                "quality_attempts_used": result.get("quality_attempts_used"),
                "best_quality_attempt": result.get("best_quality_attempt"),
                "attempts": result.get("attempts"),
            }
            for result in failed
        ],
        "jobs": [
            {
                "sequence": result.get("sequence"),
                "image_index": result.get("image_index"),
                "image_path": result.get("image_path"),
                "success": result.get("success"),
                "generate_success": result.get("generate_success"),
                "crop_success": result.get("crop_success"),
                "rate_limited": result.get("rate_limited"),
                "generate_elapsed_seconds": result.get("generate_elapsed_seconds"),
                "crop_elapsed_seconds": result.get("crop_elapsed_seconds"),
                "total_generate_elapsed_seconds": result.get("total_generate_elapsed_seconds"),
                "total_crop_elapsed_seconds": result.get("total_crop_elapsed_seconds"),
                "quality_attempts_used": result.get("quality_attempts_used"),
                "best_quality_attempt": result.get("best_quality_attempt"),
                "risk_score": result.get("risk_score"),
                "quality_warning_count": len(result.get("quality_warnings") or []),
                "grid_path": result.get("grid_path"),
            }
            for result in results
        ],
        "prompt": prompt,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Batch-test a Gemini image model with direct Vertex calls plus the local production crop logic. "
            "This script writes grids, cropped stickers, per-job summaries, and an aggregate report. "
            "It does not call Cloud Run, Firestore, GCS upload, or Pub/Sub."
        )
    )
    parser.add_argument("--project", default=os.getenv("GOOGLE_CLOUD_PROJECT") or DEFAULT_PROJECT_ID)
    parser.add_argument("--location", default=os.getenv("GOOGLE_CLOUD_LOCATION") or DEFAULT_LOCATION)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--image", default=DEFAULT_IMAGE)
    parser.add_argument(
        "--images",
        nargs="+",
        default=None,
        help="Run a multi-image test using these image paths.",
    )
    parser.add_argument(
        "--images-file",
        default=None,
        help="Text file containing one image path per line for multi-image testing.",
    )
    parser.add_argument(
        "--use-default-multi-images",
        action="store_true",
        help="Use the four local Gemini 3.1 Flash test images in bug/TestModel.",
    )
    parser.add_argument("--output-root", default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--total-jobs", type=int, default=10)
    parser.add_argument("--jobs-per-image", type=int, default=5)
    parser.add_argument("--burst-size", type=int, default=10)
    parser.add_argument("--wave-gap-seconds", type=float, default=0.0)
    parser.add_argument("--generate-retries", type=int, default=0)
    parser.add_argument("--generate-retry-base-delay", type=float, default=3.0)
    parser.add_argument(
        "--quality-attempts",
        type=int,
        default=1,
        help="Maximum generation attempts per job when crop/quality warnings remain.",
    )
    parser.add_argument("--style", default="pixar_3d", choices=["pixar_3d", "chibi_2d"])
    parser.add_argument("--prompt", default=None)
    parser.add_argument("--no-text", action="store_true")
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--image-size", default="2K")
    parser.add_argument("--aspect-ratio", default="1:1")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_count = len(parse_image_list(args))
    is_multi_image = bool(args.images or args.images_file or args.use_default_multi_images)
    planned_jobs = args.jobs_per_image * input_count if is_multi_image else args.total_jobs
    print("Batch model quality test")
    print(f"Project: {args.project}")
    print(f"Location: {args.location}")
    print(f"Model: {args.model}")
    print(f"Planned jobs: {planned_jobs}")
    if is_multi_image:
        print(f"Input images: {input_count}")
        print(f"Jobs per image: {args.jobs_per_image}")
    print(f"Burst size: {args.burst_size}")
    print(f"Generate retries: {args.generate_retries}")
    print(f"Quality attempts: {args.quality_attempts}")
    print(f"Input image: {args.image}")
    run_dir, _, report = asyncio.run(run_batch(args))

    counts = report["counts"]
    metrics = report["metrics"]
    print("Done")
    print(f"Run dir: {run_dir}")
    print(f"Report: {run_dir / 'batch_report.json'}")
    total_jobs = int(report.get("total_jobs") if report.get("total_jobs") is not None else planned_jobs)
    print(
        "Counts: "
        f"generate_success={counts['generate_success']}/{total_jobs}, "
        f"crop_success={counts['crop_success']}/{total_jobs}, "
        f"full_success={counts['full_success']}/{total_jobs}, "
        f"rate_limited={counts['rate_limited']}/{total_jobs}, "
        f"quality_warning_jobs={counts['quality_warning_jobs']}/{total_jobs}, "
        f"quality_retry_jobs={counts['quality_retry_jobs']}/{total_jobs}"
    )
    print(f"Generate latency: {metrics['generate_elapsed_seconds']}")
    print(f"Risk score: {metrics['risk_score']}")


if __name__ == "__main__":
    main()
