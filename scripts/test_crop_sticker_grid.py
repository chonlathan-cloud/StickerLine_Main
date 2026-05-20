#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.image_service import ImageProcessor, UnsupportedStickerGridLayoutError  # noqa: E402


DEFAULT_INPUT = (
    "Infra/model_test_outputs/"
    "gemini-3.1-flash-image-preview_20260520_050244_candidate1_image1.png"
)
DEFAULT_OUTPUT_ROOT = "Infra/model_test_outputs/cropped"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_stem(path: Path) -> str:
    name = path.stem
    if name.endswith("_candidate1_image1"):
        name = name[: -len("_candidate1_image1")]
    return "".join(char if char.isalnum() or char in "._-" else "_" for char in name)


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


def build_quality_warnings(
    sticker_count: int,
    edge_risks: list[dict],
    artifact_risks: list[dict],
    residual_screen_risks: list[dict],
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
    if scale_consistency.get("is_inconsistent"):
        warnings.append({"type": "scale_inconsistency", "details": scale_consistency})
    return warnings


def risk_score(
    sticker_count: int,
    edge_risks: list[dict],
    artifact_risks: list[dict],
    residual_screen_risks: list[dict],
    scale_consistency: dict,
) -> int:
    return (
        abs(16 - sticker_count) * 1000
        + sum(int(item.get("severity", 0)) for item in edge_risks)
        + (sum(int(item.get("severity", 0)) for item in artifact_risks) * 50)
        + (sum(int(item.get("severity", 0)) for item in residual_screen_risks) * 40)
        + int(round(float(scale_consistency.get("std_ratio", 0.0)) * 1000))
        + (len(scale_consistency.get("outliers") or []) * 10)
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run the production ImageProcessor crop logic against one generated sticker grid, "
            "then write cropped PNGs and a quality summary. This script does not call AI, GCS, "
            "Firestore, Pub/Sub, or backend APIs."
        )
    )
    parser.add_argument("--input", default=DEFAULT_INPUT, help="Generated sticker grid PNG/JPEG/WebP.")
    parser.add_argument("--output-root", default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--columns", type=int, default=None, help="Optional manual grid columns override.")
    parser.add_argument("--rows", type=int, default=None, help="Optional manual grid rows override.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_path = (REPO_ROOT / args.input).resolve() if not Path(args.input).is_absolute() else Path(args.input)
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    output_dir = (REPO_ROOT / args.output_root / safe_stem(input_path)).resolve()
    processor = ImageProcessor()
    started_at = time.monotonic()
    summary: dict[str, Any] = {
        "created_at": utc_now_iso(),
        "input": str(input_path),
        "output_dir": str(output_dir),
        "input_image": image_info(input_path),
        "columns_override": args.columns,
        "rows_override": args.rows,
        "success": False,
    }

    try:
        grid_bytes = input_path.read_bytes()
        sticker_pngs = processor.process_sticker_grid(
            grid_bytes,
            columns=args.columns,
            rows=args.rows,
        )
        outputs = write_stickers(sticker_pngs, output_dir)
        edge_risks = processor.assess_sticker_set_edge_risk(sticker_pngs)
        artifact_risks = processor.assess_sticker_set_artifact_risk(sticker_pngs)
        residual_screen_risks = processor.assess_sticker_set_residual_screen_risk(sticker_pngs)
        scale_consistency = processor.assess_subject_scale_consistency(sticker_pngs)
        sticker_count = len(sticker_pngs)
        quality_warnings = build_quality_warnings(
            sticker_count=sticker_count,
            edge_risks=edge_risks,
            artifact_risks=artifact_risks,
            residual_screen_risks=residual_screen_risks,
            scale_consistency=scale_consistency,
        )

        summary.update({
            "success": True,
            "elapsed_seconds": round(time.monotonic() - started_at, 3),
            "sticker_count": sticker_count,
            "outputs": outputs,
            "edge_risks": edge_risks,
            "artifact_risks": artifact_risks,
            "residual_screen_risks": residual_screen_risks,
            "scale_consistency": scale_consistency,
            "quality_warnings": quality_warnings,
            "risk_score": risk_score(
                sticker_count=sticker_count,
                edge_risks=edge_risks,
                artifact_risks=artifact_risks,
                residual_screen_risks=residual_screen_risks,
                scale_consistency=scale_consistency,
            ),
        })
    except UnsupportedStickerGridLayoutError as exc:
        summary.update({
            "success": False,
            "elapsed_seconds": round(time.monotonic() - started_at, 3),
            "error_type": "UnsupportedStickerGridLayoutError",
            "error": str(exc),
        })
    except Exception as exc:
        summary.update({
            "success": False,
            "elapsed_seconds": round(time.monotonic() - started_at, 3),
            "error_type": type(exc).__name__,
            "error": str(exc),
        })
        raise
    finally:
        output_dir.mkdir(parents=True, exist_ok=True)
        summary_path = output_dir / "summary.json"
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Success: {summary['success']}")
    print(f"Elapsed seconds: {summary['elapsed_seconds']}")
    print(f"Output dir: {output_dir}")
    print(f"Summary: {output_dir / 'summary.json'}")
    if summary.get("success"):
        print(f"Sticker count: {summary['sticker_count']}")
        print(f"Risk score: {summary['risk_score']}")
        print(f"Quality warnings: {len(summary['quality_warnings'])}")
    else:
        print(f"Error: {summary.get('error_type')}: {summary.get('error')}")


if __name__ == "__main__":
    main()
