#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import struct
import sys
from pathlib import Path


def _resolve_backend_root() -> Path:
    return Path(__file__).resolve().parents[1]


BACKEND_ROOT = _resolve_backend_root()
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.services.image_service import ImageProcessor


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the backend sticker crop pipeline against a local grid PNG."
    )
    parser.add_argument(
        "grid_image",
        type=Path,
        help="Path to the source sticker grid image, usually a 4x4 green-background PNG.",
    )
    parser.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        default=None,
        help="Directory to write output PNG files into. Defaults to backend/tmp/<grid-name>.",
    )
    parser.add_argument(
        "--prefix",
        default="sticker",
        help="Filename prefix for generated PNGs. Default: sticker",
    )
    parser.add_argument(
        "--keep-existing",
        action="store_true",
        help="Keep existing files in the output directory instead of cleaning only matching PNG names.",
    )
    parser.add_argument(
        "--columns",
        type=int,
        default=None,
        help="Force the grid column count instead of auto-detecting it.",
    )
    parser.add_argument(
        "--rows",
        type=int,
        default=None,
        help="Force the grid row count instead of auto-detecting it.",
    )
    return parser.parse_args()


def _default_output_dir(grid_image: Path) -> Path:
    safe_name = grid_image.stem.replace(" ", "_")
    return BACKEND_ROOT / "tmp" / safe_name


def _png_dimensions(png_bytes: bytes) -> tuple[int, int]:
    if len(png_bytes) < 24 or png_bytes[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Output is not a valid PNG file.")
    width, height = struct.unpack(">II", png_bytes[16:24])
    return width, height


def _clear_old_outputs(output_dir: Path, prefix: str) -> None:
    for file_path in output_dir.glob(f"{prefix}_*.png"):
        file_path.unlink()


def _print_header(grid_path: Path, output_dir: Path) -> None:
    print(f"Input : {grid_path}")
    print(f"Output: {output_dir}")


def _print_result(index: int, file_path: Path, png_bytes: bytes) -> None:
    width, height = _png_dimensions(png_bytes)
    digest = hashlib.sha1(png_bytes).hexdigest()[:10]
    print(
        f"[{index:02d}] {file_path.name}  {width}x{height}  {len(png_bytes):>7} bytes  sha1={digest}"
    )


def main() -> int:
    args = _parse_args()
    grid_path = args.grid_image.expanduser().resolve()
    if not grid_path.is_file():
        print(f"Grid image not found: {grid_path}", file=sys.stderr)
        return 1

    output_dir = (
        args.output_dir.expanduser().resolve()
        if args.output_dir is not None
        else _default_output_dir(grid_path)
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    if not args.keep_existing:
        _clear_old_outputs(output_dir, args.prefix)

    _print_header(grid_path, output_dir)
    print(f"Grid  : rows={args.rows or 'auto'} columns={args.columns or 'auto'}")

    processor = ImageProcessor()
    image_bytes = grid_path.read_bytes()
    outputs = processor.process_sticker_grid(
        image_bytes,
        columns=args.columns,
        rows=args.rows,
    )
    edge_risks = processor.assess_sticker_set_edge_risk(outputs)
    artifact_risks = processor.assess_sticker_set_artifact_risk(outputs)

    print(f"Generated {len(outputs)} sticker(s)")
    for index, png_bytes in enumerate(outputs):
        file_path = output_dir / f"{args.prefix}_{index:02d}.png"
        file_path.write_bytes(png_bytes)
        _print_result(index, file_path, png_bytes)

    if edge_risks:
        print("Edge-touch risk detected:")
        for risk in edge_risks:
            print(
                f"  - sticker_{risk['index']:02d}: severity={risk['severity']} "
                f"touches={risk['touches']} margins={risk['margins']}"
            )
    else:
        print("Edge-touch risk: none detected")

    if artifact_risks:
        print("Detached artifact risk detected:")
        for risk in artifact_risks:
            print(
                f"  - sticker_{risk['index']:02d}: severity={risk['severity']} "
                f"components={risk['components']}"
            )
    else:
        print("Detached artifact risk: none detected")

    print("Done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
