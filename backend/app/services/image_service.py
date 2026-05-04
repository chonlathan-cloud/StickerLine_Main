import cv2
import numpy as np
import logging
from typing import List, Tuple

logger = logging.getLogger(__name__)

class ImageProcessor:
    def process_sticker_grid(
        self,
        image_bytes: bytes,
        columns: int | None = None,
        rows: int | None = None,
    ) -> List[bytes]:
        """
        Process a green-background sticker grid into individual stickers.
        """
        try:
            # Step A: Load image from bytes to OpenCV format
            nparr = np.frombuffer(image_bytes, np.uint8)
            grid_img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if grid_img is None:
                raise ValueError("Could not decode image bytes into OpenCV format.")

            # Step A.1: Trim solid green margins (if any) to stabilize grid slicing
            grid_img = self._trim_green_margin(grid_img)

            processed_stickers = []

            # Step B: Resolve the grid layout using the supported production layouts.
            col_count, row_count, x_edges, y_edges = self._resolve_grid_layout(
                grid_img,
                columns=columns,
                rows=rows,
            )
            logger.info("Resolved sticker grid layout as %dx%d.", col_count, row_count)

            for row in range(row_count):
                for col in range(col_count):
                    # Slice the grid using fractional edges to reduce drift
                    y_start = y_edges[row]
                    y_end = y_edges[row + 1]
                    x_start = x_edges[col]
                    x_end = x_edges[col + 1]

                    strict_core_img = grid_img[y_start:y_end, x_start:x_end]
                    anchor_alpha = self._build_core_anchor_alpha(strict_core_img)

                    slice_img, core_bounds = self._extract_cell_with_overscan(
                        grid_img,
                        x_start=x_start,
                        x_end=x_end,
                        y_start=y_start,
                        y_end=y_end,
                        overscan_x_ratio=0.03,
                        overscan_top_ratio=0.0,
                        overscan_bottom_ratio=0.02,
                    )
                    slice_img, core_bounds = self._apply_safe_inset(
                        slice_img,
                        core_bounds=core_bounds,
                        inset_ratio=0.01,
                    )
                    
                    # Step C: Process each slice
                    output_bytes = self._process_single_sticker(
                        slice_img,
                        core_bounds=core_bounds,
                        anchor_alpha=anchor_alpha,
                    )
                    processed_stickers.append(output_bytes)

            return processed_stickers
        except Exception as e:
            logger.error(f"Error processing sticker grid: {e}")
            raise e

    def assess_sticker_set_edge_risk(self, sticker_pngs: List[bytes]) -> list[dict]:
        risky: list[dict] = []
        for index, sticker_png in enumerate(sticker_pngs):
            metrics = self._measure_edge_touch_risk(sticker_png)
            if not metrics["is_risky"]:
                continue
            risky.append({
                "index": index,
                "margins": metrics["margins"],
                "touches": metrics["touches"],
                "severity": metrics["severity"],
            })
        return risky

    def assess_sticker_set_artifact_risk(self, sticker_pngs: List[bytes]) -> list[dict]:
        risky: list[dict] = []
        for index, sticker_png in enumerate(sticker_pngs):
            metrics = self._measure_detached_artifact_risk(sticker_png)
            if not metrics["is_risky"]:
                continue
            risky.append({
                "index": index,
                "components": metrics["components"],
                "severity": metrics["severity"],
            })
        return risky

    def assess_sticker_set_residual_screen_risk(self, sticker_pngs: List[bytes]) -> list[dict]:
        risky: list[dict] = []
        for index, sticker_png in enumerate(sticker_pngs):
            metrics = self._measure_residual_screen_risk(sticker_png)
            if not metrics["is_risky"]:
                continue
            risky.append({
                "index": index,
                "screen_pixels": metrics["screen_pixels"],
                "visible_pixels": metrics["visible_pixels"],
                "ratio": metrics["ratio"],
                "bounds": metrics["bounds"],
                "severity": metrics["severity"],
            })
        return risky

    def assess_subject_scale_consistency(self, sticker_pngs: List[bytes]) -> dict:
        ratios: list[float] = []
        indexed_ratios: list[tuple[int, float]] = []
        for index, sticker_png in enumerate(sticker_pngs):
            nparr = np.frombuffer(sticker_png, np.uint8)
            rgba = cv2.imdecode(nparr, cv2.IMREAD_UNCHANGED)
            if rgba is None or rgba.ndim < 3 or rgba.shape[2] < 4:
                continue

            alpha = rgba[:, :, 3]
            bounds = self._compute_content_bounds(alpha, threshold=16)
            if bounds is None:
                continue

            _, y1, _, y2 = bounds
            content_height = max(1, y2 - y1)
            ratio = float(content_height / max(1, alpha.shape[0]))
            ratios.append(ratio)
            indexed_ratios.append((index, ratio))

        if not ratios:
            return {
                "is_inconsistent": False,
                "mean_ratio": 0.0,
                "std_ratio": 0.0,
                "outliers": [],
            }

        mean_ratio = float(np.mean(ratios))
        std_ratio = float(np.std(ratios))
        outliers = [
            {
                "index": index,
                "ratio": ratio,
                "deviation": abs(ratio - mean_ratio),
            }
            for index, ratio in indexed_ratios
            if abs(ratio - mean_ratio) >= 0.09
        ]

        return {
            "is_inconsistent": bool(std_ratio >= 0.07 or len(outliers) >= 3),
            "mean_ratio": mean_ratio,
            "std_ratio": std_ratio,
            "outliers": outliers,
        }

    def _extract_cell_with_overscan(
        self,
        grid_img: np.ndarray,
        x_start: int,
        x_end: int,
        y_start: int,
        y_end: int,
        overscan_x_ratio: float,
        overscan_top_ratio: float,
        overscan_bottom_ratio: float,
    ) -> Tuple[np.ndarray, Tuple[int, int, int, int]]:
        height, width = grid_img.shape[:2]
        cell_w = max(1, x_end - x_start)
        cell_h = max(1, y_end - y_start)
        overscan_x = max(2, int(round(cell_w * overscan_x_ratio)))
        overscan_top = max(0, int(round(cell_h * overscan_top_ratio)))
        overscan_bottom = max(1, int(round(cell_h * overscan_bottom_ratio)))

        left = max(0, x_start - overscan_x)
        right = min(width, x_end + overscan_x)
        top = max(0, y_start - overscan_top)
        bottom = min(height, y_end + overscan_bottom)
        core_bounds = (
            int(x_start - left),
            int(y_start - top),
            int(x_end - left),
            int(y_end - top),
        )
        return grid_img[top:bottom, left:right], core_bounds

    def _build_core_anchor_alpha(self, core_img: np.ndarray) -> np.ndarray:
        rgba = self._extract_foreground_rgba(core_img)
        rgba[:, :, 3] = self._filter_foreground_components(rgba[:, :, 3])
        rgba[:, :, 3] = self._remove_pure_green_pockets(core_img, rgba[:, :, 3])
        rgba[:, :, 3] = self._choke_alpha(rgba[:, :, 3], choke_radius=1.4, feather=0.8)
        return rgba[:, :, 3]

    def _apply_safe_inset(
        self,
        cv_img: np.ndarray,
        core_bounds: Tuple[int, int, int, int] | None = None,
        inset_ratio: float = 0.02,
    ) -> Tuple[np.ndarray, Tuple[int, int, int, int] | None]:
        """
        Trim only the edges that are still mostly pure green gutter. This keeps
        adjacent-cell bleed out, but avoids clipping legitimate content that was
        rendered too close to the cell border.
        """
        height, width = cv_img.shape[:2]
        inset_x = int(round(width * inset_ratio))
        inset_y = int(round(height * inset_ratio))
        if inset_x <= 0 and inset_y <= 0:
            return cv_img, core_bounds

        separator_mask = self._grid_separator_mask(cv_img)
        edge_green_threshold = 0.9
        edge_separator_threshold = 0.62

        trim_left = inset_x if inset_x > 0 and float(separator_mask[:, :inset_x].mean()) >= edge_separator_threshold else 0
        trim_right = inset_x if inset_x > 0 and float(separator_mask[:, width - inset_x:].mean()) >= edge_separator_threshold else 0
        trim_top = inset_y if inset_y > 0 and float(separator_mask[:inset_y, :].mean()) >= edge_green_threshold else 0
        trim_bottom = inset_y if inset_y > 0 and float(separator_mask[height - inset_y:, :].mean()) >= edge_separator_threshold else 0

        x_start = min(trim_left, width - 1)
        y_start = min(trim_top, height - 1)
        x_end = max(width - trim_right, x_start + 1)
        y_end = max(height - trim_bottom, y_start + 1)
        adjusted_core_bounds = core_bounds
        if core_bounds is not None:
            cx1, cy1, cx2, cy2 = core_bounds
            new_width = x_end - x_start
            new_height = y_end - y_start
            new_cx1 = max(0, min(new_width - 1, cx1 - x_start))
            new_cy1 = max(0, min(new_height - 1, cy1 - y_start))
            new_cx2 = max(new_cx1 + 1, min(new_width, cx2 - x_start))
            new_cy2 = max(new_cy1 + 1, min(new_height, cy2 - y_start))
            adjusted_core_bounds = (
                new_cx1,
                new_cy1,
                new_cx2,
                new_cy2,
            )
        return cv_img[y_start:y_end, x_start:x_end], adjusted_core_bounds

    def _measure_edge_touch_risk(self, sticker_png: bytes) -> dict:
        nparr = np.frombuffer(sticker_png, np.uint8)
        rgba = cv2.imdecode(nparr, cv2.IMREAD_UNCHANGED)
        if rgba is None or rgba.ndim < 3 or rgba.shape[2] < 4:
            return {"is_risky": False, "margins": {}, "touches": {}, "severity": 0}

        alpha = rgba[:, :, 3]
        bounds = self._compute_content_bounds(alpha, threshold=16)
        if bounds is None:
            return {"is_risky": False, "margins": {}, "touches": {}, "severity": 0}

        x1, y1, x2, y2 = bounds
        height, width = alpha.shape
        margins = {
            "left": int(x1),
            "top": int(y1),
            "right": int(max(0, width - x2)),
            "bottom": int(max(0, height - y2)),
        }

        band = max(3, min(width, height) // 60)
        alpha_threshold = 16
        touches = {
            "left": bool(np.any(alpha[:, :band] > alpha_threshold)),
            "top": bool(np.any(alpha[:band, :] > alpha_threshold)),
            "right": bool(np.any(alpha[:, width - band:] > alpha_threshold)),
            "bottom": bool(np.any(alpha[height - band:, :] > alpha_threshold)),
        }

        tight_margin = 8
        severe_margin = 4
        risky_edges = [
            edge for edge, margin in margins.items()
            if touches[edge] and margin <= tight_margin
        ]
        severe_edges = [
            edge for edge, margin in margins.items()
            if touches[edge] and margin <= severe_margin
        ]

        return {
            "is_risky": bool(risky_edges),
            "margins": margins,
            "touches": touches,
            "severity": len(severe_edges) * 2 + len(risky_edges),
        }

    def _measure_detached_artifact_risk(self, sticker_png: bytes) -> dict:
        nparr = np.frombuffer(sticker_png, np.uint8)
        rgba = cv2.imdecode(nparr, cv2.IMREAD_UNCHANGED)
        if rgba is None or rgba.ndim < 3 or rgba.shape[2] < 4:
            return {"is_risky": False, "components": [], "severity": 0}

        alpha = rgba[:, :, 3]
        mask = (alpha > 16).astype(np.uint8)
        num_labels, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        if num_labels <= 2:
            return {"is_risky": False, "components": [], "severity": 0}

        component_areas = stats[1:, cv2.CC_STAT_AREA]
        primary_label = int(np.argmax(component_areas)) + 1
        primary_area = max(1, int(stats[primary_label, cv2.CC_STAT_AREA]))
        height, width = alpha.shape
        thin_limit = max(5, int(round(min(width, height) * 0.05)))
        area_limit = max(96, int(round(primary_area * 0.045)))
        significant_area = max(300, int(round(primary_area * 0.22)))
        significant_tops = [
            int(stats[label, cv2.CC_STAT_TOP])
            for label in range(1, num_labels)
            if int(stats[label, cv2.CC_STAT_AREA]) >= significant_area
        ]
        main_top = min(significant_tops) if significant_tops else int(stats[primary_label, cv2.CC_STAT_TOP])
        top_gap = max(5, int(round(height * 0.025)))
        top_height_limit = max(18, int(round(height * 0.075)))
        top_area_limit = max(3200, int(round(primary_area * 0.10)))

        risky_components: list[dict] = []
        for label in range(1, num_labels):
            if label == primary_label:
                continue

            x = int(stats[label, cv2.CC_STAT_LEFT])
            y = int(stats[label, cv2.CC_STAT_TOP])
            w = int(stats[label, cv2.CC_STAT_WIDTH])
            h = int(stats[label, cv2.CC_STAT_HEIGHT])
            area = int(stats[label, cv2.CC_STAT_AREA])
            if area < 24:
                continue

            thin_side = min(w, h)
            long_side = max(w, h)
            is_sliver = thin_side <= thin_limit and (long_side / max(1, thin_side)) >= 2.4
            is_small = area <= area_limit
            is_top_fragment = (
                y <= main_top - top_gap
                and h <= top_height_limit
                and area <= top_area_limit
                and w <= int(round(width * 0.76))
                and (w / max(1, h)) >= 2.5
            )
            if not ((is_sliver and is_small) or is_top_fragment):
                continue

            risky_components.append({
                "bounds": {
                    "x": x,
                    "y": y,
                    "width": w,
                    "height": h,
                },
                "area": area,
                "reason": "top_detached" if is_top_fragment else "detached_sliver",
            })

        return {
            "is_risky": bool(risky_components),
            "components": risky_components,
            "severity": len(risky_components),
        }

    def _measure_residual_screen_risk(self, sticker_png: bytes) -> dict:
        nparr = np.frombuffer(sticker_png, np.uint8)
        rgba = cv2.imdecode(nparr, cv2.IMREAD_UNCHANGED)
        if rgba is None or rgba.ndim < 3 or rgba.shape[2] < 4:
            return {
                "is_risky": False,
                "screen_pixels": 0,
                "visible_pixels": 0,
                "ratio": 0.0,
                "bounds": None,
                "severity": 0,
            }

        alpha = rgba[:, :, 3]
        visible_pixels = int(np.count_nonzero(alpha > 8))
        screen_mask = self._visible_screen_residue_mask(rgba)
        screen_pixels = int(np.count_nonzero(screen_mask))
        ratio = float(screen_pixels / max(visible_pixels, 1))
        bounds = self._compute_content_bounds((screen_mask.astype(np.uint8) * 255), threshold=1)
        min_pixels = max(28, int(round(visible_pixels * 0.0015)))
        is_risky = screen_pixels >= min_pixels
        severity = 0
        if is_risky:
            severity = 1 + int(screen_pixels >= max(90, min_pixels * 2)) + int(ratio >= 0.01)

        return {
            "is_risky": is_risky,
            "screen_pixels": screen_pixels,
            "visible_pixels": visible_pixels,
            "ratio": ratio,
            "bounds": bounds,
            "severity": severity,
        }

    def _equal_edges(self, size: int, segments: int) -> np.ndarray:
        segment_count = max(1, int(segments))
        edges = np.linspace(0, size, segment_count + 1).round().astype(int)
        edges[-1] = size
        return edges

    def _resolve_grid_layout(
        self,
        cv_img: np.ndarray,
        columns: int | None,
        rows: int | None,
    ) -> Tuple[int, int, np.ndarray, np.ndarray]:
        """
        Resolve the production grid layout. When the caller does not force a
        layout, evaluate only the supported outputs and pick the best-scoring
        candidate instead of trusting raw gap detection blindly.
        """
        height, width = cv_img.shape[:2]
        if columns is not None and rows is not None:
            x_edges = self._detect_grid_edges(cv_img, axis="x", expected_segments=columns)
            y_edges = self._detect_grid_edges(cv_img, axis="y", expected_segments=rows)
            return (
                int(columns),
                int(rows),
                x_edges if x_edges is not None else self._equal_edges(width, columns),
                y_edges if y_edges is not None else self._equal_edges(height, rows),
            )

        candidates = self._candidate_layouts_for_image(width=width, height=height)
        best_layout: Tuple[int, int] | None = None
        best_x_edges: np.ndarray | None = None
        best_y_edges: np.ndarray | None = None
        best_score = float("-inf")

        for candidate_columns, candidate_rows in candidates:
            x_edges_detected = self._detect_grid_edges(cv_img, axis="x", expected_segments=candidate_columns)
            y_edges_detected = self._detect_grid_edges(cv_img, axis="y", expected_segments=candidate_rows)
            x_edges = x_edges_detected if x_edges_detected is not None else self._equal_edges(width, candidate_columns)
            y_edges = y_edges_detected if y_edges_detected is not None else self._equal_edges(height, candidate_rows)
            score = self._score_grid_layout(
                cv_img,
                columns=candidate_columns,
                rows=candidate_rows,
                x_edges=x_edges,
                y_edges=y_edges,
                used_detected_x=x_edges_detected is not None,
                used_detected_y=y_edges_detected is not None,
            )
            if score > best_score:
                best_score = score
                best_layout = (candidate_columns, candidate_rows)
                best_x_edges = x_edges
                best_y_edges = y_edges

        if best_layout is None or best_x_edges is None or best_y_edges is None:
            fallback_columns = columns or 4
            fallback_rows = rows or 4
            return (
                fallback_columns,
                fallback_rows,
                self._equal_edges(width, fallback_columns),
                self._equal_edges(height, fallback_rows),
            )

        return best_layout[0], best_layout[1], best_x_edges, best_y_edges

    def _candidate_layouts_for_image(self, width: int, height: int) -> list[Tuple[int, int]]:
        return [(4, 4)]

    def _score_grid_layout(
        self,
        cv_img: np.ndarray,
        columns: int,
        rows: int,
        x_edges: np.ndarray,
        y_edges: np.ndarray,
        used_detected_x: bool,
        used_detected_y: bool,
    ) -> float:
        green_mask = self._grid_green_mask(cv_img)
        content_mask = ~green_mask
        gutter_score = self._score_gutters(green_mask, x_edges=x_edges, y_edges=y_edges)
        content_score = self._score_cells(content_mask, x_edges=x_edges, y_edges=y_edges)

        width_segments = np.diff(x_edges).astype(np.float32)
        height_segments = np.diff(y_edges).astype(np.float32)
        width_variation = float(width_segments.std() / max(width_segments.mean(), 1.0))
        height_variation = float(height_segments.std() / max(height_segments.mean(), 1.0))

        detection_bonus = 0.0
        if used_detected_x:
            detection_bonus += 0.22
        if used_detected_y:
            detection_bonus += 0.22

        layout_bias = 0.0
        if columns == rows == 4:
            layout_bias += 0.08
        elif columns == 5 and rows == 3:
            layout_bias += 0.04

        return (
            (gutter_score * 4.2)
            + (content_score * 3.4)
            + detection_bonus
            + layout_bias
            - (width_variation * 1.2)
            - (height_variation * 1.2)
        )

    def _grid_green_mask(self, cv_img: np.ndarray) -> np.ndarray:
        b, g, r = cv2.split(cv_img)
        return (g >= 185) & (r <= 75) & (b <= 75)

    def _grid_separator_mask(self, cv_img: np.ndarray) -> np.ndarray:
        b, g, r = cv2.split(cv_img)
        green = self._grid_green_mask(cv_img)
        dark_line = (r <= 32) & (g <= 42) & (b <= 42)
        return green | dark_line

    def _score_gutters(self, green_mask: np.ndarray, x_edges: np.ndarray, y_edges: np.ndarray) -> float:
        height, width = green_mask.shape
        strip_x = max(2, width // 180)
        strip_y = max(2, height // 180)
        scores: list[float] = []

        for x in x_edges[1:-1]:
            left = max(0, int(x) - strip_x)
            right = min(width, int(x) + strip_x)
            if right > left:
                scores.append(float(green_mask[:, left:right].mean()))

        for y in y_edges[1:-1]:
            top = max(0, int(y) - strip_y)
            bottom = min(height, int(y) + strip_y)
            if bottom > top:
                scores.append(float(green_mask[top:bottom, :].mean()))

        if not scores:
            return 0.0

        return float(np.mean(scores))

    def _score_cells(self, content_mask: np.ndarray, x_edges: np.ndarray, y_edges: np.ndarray) -> float:
        ratios: list[float] = []
        active_cells = 0
        total_cells = max(1, (len(x_edges) - 1) * (len(y_edges) - 1))

        for row in range(len(y_edges) - 1):
            for col in range(len(x_edges) - 1):
                y1, y2 = int(y_edges[row]), int(y_edges[row + 1])
                x1, x2 = int(x_edges[col]), int(x_edges[col + 1])
                if y2 <= y1 or x2 <= x1:
                    continue
                cell_ratio = float(content_mask[y1:y2, x1:x2].mean())
                ratios.append(cell_ratio)
                if cell_ratio >= 0.06:
                    active_cells += 1

        if not ratios:
            return 0.0

        ratio_mean = float(np.mean(ratios))
        ratio_std = float(np.std(ratios))
        active_score = active_cells / total_cells
        density_score = max(0.0, 1.0 - min(1.0, abs(ratio_mean - 0.34) / 0.34))

        return (active_score * 0.72) + (density_score * 0.28) - (ratio_std * 0.45)

    def _detect_grid_edges(
        self,
        cv_img: np.ndarray,
        axis: str,
        expected_segments: int | None = None,
    ) -> np.ndarray | None:
        """
        Detect grid boundaries by finding low-content (green) gutters.
        """
        green_mask = self._grid_green_mask(cv_img)
        content_mask = ~green_mask

        if axis == "y":
            ratios = content_mask.mean(axis=1)
            size = content_mask.shape[0]
        else:
            ratios = content_mask.mean(axis=0)
            size = content_mask.shape[1]

        # Smooth ratios to reduce noise
        window = max(3, size // 300)
        kernel = np.ones(window) / window
        ratios = np.convolve(ratios, kernel, mode="same")

        gaps = self._find_gaps(ratios, threshold=0.015, min_width=max(2, size // 200))
        if not gaps:
            return None

        if expected_segments is not None:
            return self._edges_from_expected_gaps(
                gaps,
                size=size,
                segment_count=max(1, expected_segments),
            )

        auto_edges = self._edges_from_all_gaps(gaps, size=size)
        return auto_edges

    def _find_gaps(self, ratios: np.ndarray, threshold: float, min_width: int) -> list[tuple[int, int, float]]:
        gaps = []
        start = None
        for idx, value in enumerate(ratios):
            if value < threshold:
                if start is None:
                    start = idx
            elif start is not None:
                end = idx - 1
                if end - start + 1 >= min_width:
                    center = (start + end) / 2.0
                    gaps.append((start, end, center))
                start = None
        if start is not None:
            end = len(ratios) - 1
            if end - start + 1 >= min_width:
                center = (start + end) / 2.0
                gaps.append((start, end, center))
        return gaps

    def _edges_from_expected_gaps(
        self,
        gaps: list[tuple[int, int, float]],
        size: int,
        segment_count: int,
    ) -> np.ndarray | None:
        required_gaps = max(0, segment_count - 1)
        if required_gaps == 0:
            return np.array([0, size], dtype=int)
        if len(gaps) < required_gaps:
            return None

        ideal = [size * i / segment_count for i in range(1, segment_count)]
        centers: list[int] = []
        used: set[int] = set()
        for target in ideal:
            candidates = [
                (idx, gap)
                for idx, gap in enumerate(gaps)
                if idx not in used
            ]
            if not candidates:
                return None

            best_idx, best_gap = min(candidates, key=lambda item: abs(item[1][2] - target))
            if abs(best_gap[2] - target) > size * 0.22:
                return None

            centers.append(int(round(best_gap[2])))
            used.add(best_idx)

        return self._build_edges_from_centers(size=size, centers=centers)

    def _edges_from_all_gaps(self, gaps: list[tuple[int, int, float]], size: int) -> np.ndarray | None:
        if not gaps:
            return None

        merged = []
        min_gap_separation = max(6, size // 14)
        for gap in sorted(gaps, key=lambda item: item[2]):
            if not merged:
                merged.append(gap)
                continue

            prev = merged[-1]
            if abs(gap[2] - prev[2]) < min_gap_separation:
                merged[-1] = (
                    min(prev[0], gap[0]),
                    max(prev[1], gap[1]),
                    (prev[2] + gap[2]) / 2.0,
                )
            else:
                merged.append(gap)

        if len(merged) > 7:
            return None

        centers = [int(round(gap[2])) for gap in merged]
        return self._build_edges_from_centers(size=size, centers=centers)

    def _build_edges_from_centers(self, size: int, centers: list[int]) -> np.ndarray | None:
        if not centers:
            return None

        centers = sorted(set(centers))
        edges = np.array([0] + centers + [size], dtype=int)
        min_segment = max(12, size // 10)
        for idx in range(len(edges) - 1):
            if (edges[idx + 1] - edges[idx]) < min_segment:
                return None

        if edges[0] != 0 or edges[-1] != size:
            return None
        return edges

    def _trim_green_margin(self, cv_img: np.ndarray) -> np.ndarray:
        """
        Trim outer margins that are almost entirely solid green (#00FF00-ish).
        This stabilizes grid slicing when the model adds padding.
        """
        try:
            b, g, r = cv2.split(cv_img)
            green_mask = (g >= 200) & (r <= 40) & (b <= 40)

            row_ratio = green_mask.mean(axis=1)
            col_ratio = green_mask.mean(axis=0)

            threshold = 0.98
            non_green_rows = np.where(row_ratio < threshold)[0]
            non_green_cols = np.where(col_ratio < threshold)[0]

            if non_green_rows.size == 0 or non_green_cols.size == 0:
                return cv_img

            top = int(non_green_rows[0])
            bottom = int(non_green_rows[-1])
            left = int(non_green_cols[0])
            right = int(non_green_cols[-1])

            # Ensure bounds are valid
            if bottom <= top or right <= left:
                return cv_img

            return cv_img[top:bottom + 1, left:right + 1]
        except Exception:
            # Fallback to original if trimming fails
            return cv_img

    def _process_single_sticker(
        self,
        cv_img: np.ndarray,
        core_bounds: Tuple[int, int, int, int] | None = None,
        anchor_alpha: np.ndarray | None = None,
    ) -> bytes:
        # 1. Extract foreground from the green background using a cell-local chroma key.
        rgba = self._extract_foreground_rgba(cv_img)
        rgba[:, :, 3] = self._filter_foreground_components(
            rgba[:, :, 3],
            core_bounds=core_bounds,
            anchor_alpha=anchor_alpha,
        )
        rgba[:, :, 3] = self._cleanup_top_strip_artifacts(
            rgba[:, :, 3],
            core_bounds=core_bounds,
            anchor_alpha=anchor_alpha,
        )
        rgba[:, :, 3] = self._remove_pure_green_pockets(cv_img, rgba[:, :, 3])
        rgba[:, :, 3] = self._choke_alpha(rgba[:, :, 3], choke_radius=2.0, feather=0.85)
        rgba = self._degreen_edges(rgba)
        rgba[:, :, 3] = self._cleanup_top_detached_artifacts(rgba[:, :, 3])
        rgba[:, :, 3] = self._cleanup_caption_baseline_fringe(rgba[:, :, 3])
        rgba = self._cleanup_residual_screen_artifacts(rgba)

        # 2. Crop with asymmetric padding so Thai text keeps breathing room.
        bounds = self._compute_content_bounds(rgba[:, :, 3], threshold=8)
        if bounds is None:
            rgba = self._build_fallback_rgba(cv_img)
        else:
            x1, y1, x2, y2 = self._expand_bounds(
                bounds,
                width=rgba.shape[1],
                height=rgba.shape[0],
                pad_x_ratio=0.08,
                pad_top_ratio=0.10,
                pad_bottom_ratio=0.16,
            )
            rgba = rgba[y1:y2, x1:x2]

        # 3. Add a thin white stroke with soft edges.
        stroked = self._add_white_stroke(
            rgba,
            stroke_radius=0.5,
            feather=1.2,
            outer_pad=8,
            supersample=2,
        )
        stroked[:, :, 3] = self._trim_outer_fringe(stroked[:, :, 3], trim_radius=2.5, feather=0.8)

        # 4. Resize to the output canvas using premultiplied alpha to avoid dark fringes.
        canvas = self._resize_and_center_rgba(stroked, target_w=370, target_h=320, padding=18)
        canvas = self._cleanup_residual_screen_artifacts(canvas)

        # Encode back to PNG bytes.
        is_success, buffer = cv2.imencode(".png", canvas)
        if not is_success:
            raise ValueError("Failed to encode image to PNG.")

        return buffer.tobytes()

    def _extract_foreground_rgba(self, cv_img: np.ndarray) -> np.ndarray:
        """
        Build a soft-alpha RGBA image from a green-screen sticker cell.
        """
        bg_mask = self._build_background_mask(cv_img)
        alpha = self._build_soft_alpha(cv_img, bg_mask)
        rgba = cv2.cvtColor(cv_img, cv2.COLOR_BGR2BGRA)
        rgba[:, :, 3] = alpha
        return rgba

    def _green_screen_like_mask(
        self,
        cv_img: np.ndarray,
        candidate_mask: np.ndarray,
        reference_mask: np.ndarray | None = None,
        alpha: np.ndarray | None = None,
        lab_threshold: float = 50.0,
    ) -> np.ndarray:
        """
        Keep chroma cleanup focused on the generated screen color, not green
        accessories that belong to the subject.
        """
        if candidate_mask.size == 0 or not np.any(candidate_mask):
            return np.zeros(candidate_mask.shape, dtype=bool)

        hsv = cv2.cvtColor(cv_img, cv2.COLOR_BGR2HSV)
        lab = cv2.cvtColor(cv_img, cv2.COLOR_BGR2LAB)
        b, g, r = cv2.split(cv_img)
        h, s, _ = cv2.split(hsv)
        green_excess = g.astype(np.int16) - np.maximum(r, b).astype(np.int16)
        greenish = (h >= 25) & (h <= 105) & (s >= 25) & (g >= 55) & (green_excess >= 8)

        if reference_mask is not None and reference_mask.shape == candidate_mask.shape:
            ref_mask = reference_mask.astype(bool) & greenish
        elif alpha is not None and alpha.shape == candidate_mask.shape:
            ref_mask = (alpha <= 2) & greenish
        else:
            ref_mask = np.zeros(candidate_mask.shape, dtype=bool)
            ref_mask[0, :] = True
            ref_mask[-1, :] = True
            ref_mask[:, 0] = True
            ref_mask[:, -1] = True
            ref_mask &= greenish

        screen_bright = (g >= 185) & (s >= 70) & (green_excess >= 65)
        if not np.any(ref_mask):
            return candidate_mask.astype(bool) & screen_bright

        lab_reference = np.median(lab[ref_mask], axis=0).astype(np.float32)
        lab_distance = np.linalg.norm(lab.astype(np.float32) - lab_reference, axis=2)
        return candidate_mask.astype(bool) & ((lab_distance <= lab_threshold) | screen_bright)

    def _remove_pure_green_pockets(self, cv_img: np.ndarray, alpha: np.ndarray) -> np.ndarray:
        """
        Remove bright chroma-green remnants that were not connected to the border.
        These typically appear in gaps under arms, between legs, or under captions.
        """
        if alpha is None or alpha.size == 0:
            return alpha

        hsv = cv2.cvtColor(cv_img, cv2.COLOR_BGR2HSV)
        b, g, r = cv2.split(cv_img)
        h, s, _ = cv2.split(hsv)
        green_excess = g.astype(np.int16) - np.maximum(r, b).astype(np.int16)

        pure_green = (
            (alpha > 0)
            & (h >= 35)
            & (h <= 90)
            & (s >= 70)
            & (g >= 120)
            & (green_excess >= 55)
        )
        pure_green = self._green_screen_like_mask(
            cv_img,
            pure_green,
            alpha=alpha,
            lab_threshold=48.0,
        )
        if not np.any(pure_green):
            return alpha

        pure_green_u8 = pure_green.astype(np.uint8)
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(pure_green_u8, connectivity=8)
        if num_labels <= 1:
            cleaned = alpha.copy()
            cleaned[pure_green] = 0
            return cleaned

        cleaned = alpha.copy()
        height, width = alpha.shape
        max_area = max(24, int(height * width * 0.018))
        for label in range(1, num_labels):
            area = int(stats[label, cv2.CC_STAT_AREA])
            x = int(stats[label, cv2.CC_STAT_LEFT])
            y = int(stats[label, cv2.CC_STAT_TOP])
            w = int(stats[label, cv2.CC_STAT_WIDTH])
            h = int(stats[label, cv2.CC_STAT_HEIGHT])
            touches_border = x <= 1 or y <= 1 or (x + w) >= (width - 1) or (y + h) >= (height - 1)
            if area <= max_area or not touches_border:
                cleaned[labels == label] = 0

        return cleaned

    def _visible_screen_residue_mask(self, rgba_img: np.ndarray) -> np.ndarray:
        if rgba_img is None:
            return np.zeros((0, 0), dtype=bool)
        if rgba_img.size == 0 or rgba_img.ndim < 3 or rgba_img.shape[2] < 4:
            return np.zeros(rgba_img.shape[:2], dtype=bool)

        hsv = cv2.cvtColor(rgba_img[:, :, :3], cv2.COLOR_BGR2HSV)
        b, g, r, alpha = cv2.split(rgba_img)
        h, s, _ = cv2.split(hsv)
        green_excess = g.astype(np.int16) - np.maximum(r, b).astype(np.int16)
        strong_screen = (
            (alpha > 6)
            & (h >= 35)
            & (h <= 90)
            & (s >= 65)
            & (g >= 115)
            & (green_excess >= 80)
            & (r <= 125)
            & (b <= 145)
        )

        mild_screen = (
            (alpha > 6)
            & (h >= 35)
            & (h <= 95)
            & (s >= 45)
            & (g >= 70)
            & (green_excess >= 40)
            & (r <= 160)
            & (b <= 170)
            & ~strong_screen
        )
        if not np.any(mild_screen):
            return strong_screen

        removable_mild = np.zeros_like(mild_screen, dtype=bool)
        mild_u8 = mild_screen.astype(np.uint8)
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mild_u8, connectivity=8)
        height, width = mild_screen.shape
        lower_region_y = int(round(height * 0.38))
        max_mild_area = max(120, int(round(np.count_nonzero(alpha > 8) * 0.012)))
        for label in range(1, num_labels):
            x = int(stats[label, cv2.CC_STAT_LEFT])
            y = int(stats[label, cv2.CC_STAT_TOP])
            w = int(stats[label, cv2.CC_STAT_WIDTH])
            h_label = int(stats[label, cv2.CC_STAT_HEIGHT])
            area = int(stats[label, cv2.CC_STAT_AREA])
            if area <= 0:
                continue

            lower_artifact = y >= lower_region_y or (y + h_label) >= int(round(height * 0.82))
            flat_artifact = h_label <= max(10, int(round(height * 0.04))) and w >= max(8, h_label * 2)
            small_artifact = area <= max_mild_area
            if lower_artifact and (small_artifact or flat_artifact):
                removable_mild[labels == label] = True

        return strong_screen | removable_mild

    def _cleanup_residual_screen_artifacts(self, rgba_img: np.ndarray) -> np.ndarray:
        if rgba_img is None or rgba_img.size == 0 or rgba_img.ndim < 3 or rgba_img.shape[2] < 4:
            return rgba_img

        residue_mask = self._visible_screen_residue_mask(rgba_img)
        if not np.any(residue_mask):
            return rgba_img

        cleaned = rgba_img.copy()
        cleaned[:, :, 3] = np.where(residue_mask, 0, cleaned[:, :, 3]).astype(np.uint8)
        return cleaned

    def _choke_alpha(self, alpha: np.ndarray, choke_radius: float, feather: float) -> np.ndarray:
        """
        Trim 1-2px from the outer matte before adding the final stroke so edge
        contamination does not remain visible as thin lines.
        """
        if alpha is None or alpha.size == 0:
            return alpha

        fg_mask = (alpha > 6).astype(np.uint8)
        if not np.any(fg_mask):
            return alpha

        distance_to_bg = cv2.distanceTransform(fg_mask, cv2.DIST_L2, 5)
        keep_factor = np.clip((distance_to_bg - choke_radius + feather) / max(feather, 1e-3), 0.0, 1.0)
        choked = np.clip(alpha.astype(np.float32) * keep_factor, 0.0, 255.0).astype(np.uint8)
        return choked

    def _trim_outer_fringe(self, alpha: np.ndarray, trim_radius: float, feather: float) -> np.ndarray:
        """
        Remove the faint outermost ring left by resampling/anti-aliasing after the
        white stroke is generated.
        """
        if alpha is None or alpha.size == 0:
            return alpha

        fg_mask = (alpha > 2).astype(np.uint8)
        if not np.any(fg_mask):
            return alpha

        distance_to_bg = cv2.distanceTransform(fg_mask, cv2.DIST_L2, 5)
        keep_factor = np.clip((distance_to_bg - trim_radius + feather) / max(feather, 1e-3), 0.0, 1.0)
        trimmed = np.clip(alpha.astype(np.float32) * keep_factor, 0.0, 255.0).astype(np.uint8)
        return trimmed

    def _cleanup_top_detached_artifacts(self, alpha: np.ndarray) -> np.ndarray:
        """
        Remove detached caption fragments that leak from the cell above. This
        targets small components touching the top edge of the cell-local crop,
        while preserving the primary character/text component.
        """
        if alpha is None or alpha.size == 0:
            return alpha

        mask = (alpha > 18).astype(np.uint8)
        num_labels, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        if num_labels <= 2:
            return alpha

        component_areas = stats[1:, cv2.CC_STAT_AREA]
        primary_label = int(np.argmax(component_areas)) + 1
        primary_area = max(1, int(stats[primary_label, cv2.CC_STAT_AREA]))
        height, width = alpha.shape
        max_height = max(12, int(round(height * 0.08)))
        max_area = max(1800, int(round(primary_area * 0.08)))
        max_width = int(round(width * 0.78))

        cleaned = alpha.copy()
        for label in range(1, num_labels):
            if label == primary_label:
                continue

            x = int(stats[label, cv2.CC_STAT_LEFT])
            y = int(stats[label, cv2.CC_STAT_TOP])
            w = int(stats[label, cv2.CC_STAT_WIDTH])
            h = int(stats[label, cv2.CC_STAT_HEIGHT])
            area = int(stats[label, cv2.CC_STAT_AREA])

            touches_top = y <= 1
            compact_top_piece = h <= max_height and area <= max_area and w <= max_width
            if touches_top and compact_top_piece:
                pad = 2
                x1 = max(0, x - pad)
                y1 = max(0, y - pad)
                x2 = min(width, x + w + pad)
                y2 = min(height, y + h + pad)
                cleaned[y1:y2, x1:x2] = 0

        return cleaned

    def _cleanup_caption_baseline_fringe(self, alpha: np.ndarray) -> np.ndarray:
        """
        Remove tiny horizontal alpha slivers that sit below the caption baseline.
        Thai lower marks are protected by only targeting detached, very flat
        components below the main sticker component.
        """
        if alpha is None or alpha.size == 0:
            return alpha

        mask = (alpha > 18).astype(np.uint8)
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        if num_labels <= 2:
            return alpha

        component_areas = stats[1:, cv2.CC_STAT_AREA]
        primary_label = int(np.argmax(component_areas)) + 1
        primary_y = int(stats[primary_label, cv2.CC_STAT_TOP])
        primary_h = int(stats[primary_label, cv2.CC_STAT_HEIGHT])
        primary_bottom = primary_y + primary_h
        primary_area = max(1, int(stats[primary_label, cv2.CC_STAT_AREA]))

        height, width = alpha.shape
        min_gap = max(2, int(round(height * 0.012)))
        max_sliver_height = max(3, int(round(height * 0.024)))
        max_area = max(90, int(round(primary_area * 0.006)))

        cleaned = alpha.copy()
        for label in range(1, num_labels):
            if label == primary_label:
                continue

            x = int(stats[label, cv2.CC_STAT_LEFT])
            y = int(stats[label, cv2.CC_STAT_TOP])
            w = int(stats[label, cv2.CC_STAT_WIDTH])
            h = int(stats[label, cv2.CC_STAT_HEIGHT])
            area = int(stats[label, cv2.CC_STAT_AREA])
            if area < 12:
                continue

            below_main = y >= primary_bottom + min_gap
            flat_horizontal = h <= max_sliver_height and (w / max(1, h)) >= 4.0
            small_enough = area <= max_area and w <= int(round(width * 0.22))
            if below_main and flat_horizontal and small_enough:
                cleaned[labels == label] = 0

        return cleaned

    def _build_fallback_rgba(self, cv_img: np.ndarray) -> np.ndarray:
        """
        Conservative fallback when the soft matte fails entirely.
        """
        hsv = cv2.cvtColor(cv_img, cv2.COLOR_BGR2HSV)
        b, g, r = cv2.split(cv_img)
        h, s, _ = cv2.split(hsv)
        green_excess = g.astype(np.int16) - np.maximum(r, b).astype(np.int16)
        green_bg = (h >= 30) & (h <= 95) & (s >= 30) & (g >= 70) & (green_excess >= 18)

        rgba = cv2.cvtColor(cv_img, cv2.COLOR_BGR2BGRA)
        rgba[:, :, 3] = np.where(green_bg, 0, 255).astype(np.uint8)
        return rgba

    def _build_background_mask(self, cv_img: np.ndarray) -> np.ndarray:
        """
        Detect the green background that is connected to the outer border.
        This avoids removing interior content that happens to be green-ish.
        """
        hsv = cv2.cvtColor(cv_img, cv2.COLOR_BGR2HSV)
        b, g, r = cv2.split(cv_img)
        h, s, _ = cv2.split(hsv)

        green_excess = g.astype(np.int16) - np.maximum(r, b).astype(np.int16)
        strong_green = (h >= 30) & (h <= 95) & (s >= 35) & (g >= 70) & (green_excess >= 18)

        border_mask = np.zeros(strong_green.shape, dtype=bool)
        border_mask[0, :] = True
        border_mask[-1, :] = True
        border_mask[:, 0] = True
        border_mask[:, -1] = True

        border_green = strong_green & border_mask
        if np.any(border_green):
            candidate_mask = self._green_screen_like_mask(
                cv_img,
                strong_green,
                reference_mask=border_green,
                lab_threshold=48.0,
            )
        else:
            candidate_mask = strong_green & (g >= 185) & (s >= 70) & (green_excess >= 65)

        candidate_u8 = candidate_mask.astype(np.uint8)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        candidate_u8 = cv2.morphologyEx(candidate_u8, cv2.MORPH_CLOSE, kernel, iterations=1)

        num_labels, labels = cv2.connectedComponents(candidate_u8, connectivity=8)
        if num_labels <= 1:
            return candidate_u8.astype(bool)

        border_labels = np.unique(
            np.concatenate([
                labels[0, :],
                labels[-1, :],
                labels[:, 0],
                labels[:, -1],
            ])
        )
        border_labels = border_labels[border_labels != 0]
        if border_labels.size == 0:
            return candidate_u8.astype(bool)

        bg_mask = np.isin(labels, border_labels) & candidate_mask
        bg_u8 = (bg_mask.astype(np.uint8) * 255)
        bg_u8 = cv2.morphologyEx(bg_u8, cv2.MORPH_CLOSE, kernel, iterations=1)
        return bg_u8 > 0

    def _build_soft_alpha(self, cv_img: np.ndarray, bg_mask: np.ndarray) -> np.ndarray:
        """
        Convert the binary background mask into a soft alpha matte and suppress
        green fringing near the subject boundary.
        """
        fg_mask = (~bg_mask).astype(np.uint8)
        if not np.any(fg_mask):
            return np.zeros(bg_mask.shape, dtype=np.uint8)

        distance_to_bg = cv2.distanceTransform(fg_mask, cv2.DIST_L2, 5)
        feather_px = 1.65
        alpha = np.clip(distance_to_bg / feather_px, 0.0, 1.0) * 255.0

        hsv = cv2.cvtColor(cv_img, cv2.COLOR_BGR2HSV)
        b, g, r = cv2.split(cv_img)
        h, s, _ = cv2.split(hsv)
        green_excess = g.astype(np.float32) - np.maximum(r, b).astype(np.float32)
        edge_weight = np.clip((5.5 - distance_to_bg) / 5.5, 0.0, 1.0)
        suspicious_green = (
            (h >= 28)
            & (h <= 98)
            & (s >= 25)
            & (green_excess > 10)
            & (edge_weight > 0)
        )
        screen_like_green = self._green_screen_like_mask(
            cv_img,
            suspicious_green,
            reference_mask=bg_mask,
            lab_threshold=50.0,
        )

        penalty = np.zeros_like(alpha, dtype=np.float32)
        penalty[screen_like_green] = np.clip(green_excess[screen_like_green] * 1.55, 0.0, 190.0) * edge_weight[screen_like_green]
        alpha = np.clip(alpha - penalty, 0.0, 255.0)
        alpha[bg_mask] = 0.0

        alpha_u8 = alpha.astype(np.uint8)
        alpha_u8 = cv2.GaussianBlur(alpha_u8, (0, 0), 0.65)
        return alpha_u8

    def _filter_foreground_components(
        self,
        alpha: np.ndarray,
        core_bounds: Tuple[int, int, int, int] | None = None,
        anchor_alpha: np.ndarray | None = None,
    ) -> np.ndarray:
        """
        Keep the primary sticker subject and nearby caption/accessories while
        dropping border debris from neighboring cells or failed masks.
        """
        if alpha is None or alpha.size == 0:
            return alpha

        mask = (alpha > 18).astype(np.uint8)
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        if num_labels <= 1:
            return alpha

        height, width = alpha.shape
        min_area = max(12, int(height * width * 0.00028))
        prominent_area = max(80, int(height * width * 0.012))

        core_focus: Tuple[int, int, int, int] | None = None
        anchor_projection: np.ndarray | None = None
        anchor_projection_dilated: np.ndarray | None = None
        if core_bounds is not None:
            cx1, cy1, cx2, cy2 = core_bounds
            core_w = max(1, cx2 - cx1)
            core_h = max(1, cy2 - cy1)
            core_focus = (
                max(0, cx1 - max(4, int(round(core_w * 0.18)))),
                max(0, cy1 - max(4, int(round(core_h * 0.22)))),
                min(width, cx2 + max(4, int(round(core_w * 0.18)))),
                min(height, cy2 + max(4, int(round(core_h * 0.18)))),
            )
            if anchor_alpha is not None and anchor_alpha.size > 0:
                anchor_h, anchor_w = anchor_alpha.shape[:2]
                target_w = max(1, min(anchor_w, cx2 - cx1))
                target_h = max(1, min(anchor_h, cy2 - cy1))
                resized_anchor = anchor_alpha
                if anchor_w != target_w or anchor_h != target_h:
                    resized_anchor = cv2.resize(anchor_alpha, (target_w, target_h), interpolation=cv2.INTER_NEAREST)

                anchor_projection = np.zeros_like(mask, dtype=np.uint8)
                anchor_projection[cy1:cy1 + target_h, cx1:cx1 + target_w] = (resized_anchor > 18).astype(np.uint8)
                kernel_w = max(3, int(round(target_w * 0.08)))
                kernel_h = max(3, int(round(target_h * 0.08)))
                dilation_kernel = cv2.getStructuringElement(
                    cv2.MORPH_ELLIPSE,
                    (kernel_w | 1, kernel_h | 1),
                )
                anchor_projection_dilated = cv2.dilate(anchor_projection, dilation_kernel, iterations=1)

        primary_candidates: list[tuple[int, int]] = []
        component_areas = stats[1:, cv2.CC_STAT_AREA]
        if core_focus is not None:
            fx1, fy1, fx2, fy2 = core_focus
            for label in range(1, num_labels):
                x = int(stats[label, cv2.CC_STAT_LEFT])
                y = int(stats[label, cv2.CC_STAT_TOP])
                w = int(stats[label, cv2.CC_STAT_WIDTH])
                h = int(stats[label, cv2.CC_STAT_HEIGHT])
                overlaps_focus = not (
                    (x + w) < fx1
                    or x > fx2
                    or (y + h) < fy1
                    or y > fy2
                )
                if overlaps_focus:
                    primary_candidates.append((label, int(stats[label, cv2.CC_STAT_AREA])))

        if primary_candidates:
            primary_label = max(primary_candidates, key=lambda item: item[1])[0]
        else:
            primary_label = int(np.argmax(component_areas)) + 1
        px = int(stats[primary_label, cv2.CC_STAT_LEFT])
        py = int(stats[primary_label, cv2.CC_STAT_TOP])
        pw = int(stats[primary_label, cv2.CC_STAT_WIDTH])
        ph = int(stats[primary_label, cv2.CC_STAT_HEIGHT])
        primary_area = int(stats[primary_label, cv2.CC_STAT_AREA])

        expand_x = int(round(width * 0.22))
        expand_top = int(round(height * 0.24))
        expand_bottom = int(round(height * 0.38))
        primary_left = max(0, px - expand_x)
        primary_top = max(0, py - expand_top)
        primary_right = min(width, px + pw + expand_x)
        primary_bottom = min(height, py + ph + expand_bottom)

        keep_mask = np.zeros_like(mask, dtype=bool)
        for label in range(1, num_labels):
            x = int(stats[label, cv2.CC_STAT_LEFT])
            y = int(stats[label, cv2.CC_STAT_TOP])
            w = int(stats[label, cv2.CC_STAT_WIDTH])
            h = int(stats[label, cv2.CC_STAT_HEIGHT])
            area = int(stats[label, cv2.CC_STAT_AREA])

            cx = x + (w / 2.0)
            cy = y + (h / 2.0)
            touches_side_or_top_border = x <= 1 or y <= 1 or (x + w) >= (width - 1)
            touches_slice_border = touches_side_or_top_border or (y + h) >= (height - 1)
            touches_hard_border = touches_side_or_top_border
            overlaps_primary = not (
                (x + w) < primary_left
                or x > primary_right
                or (y + h) < primary_top
                or y > primary_bottom
            )
            overlaps_core_focus = True
            if core_focus is not None:
                fx1, fy1, fx2, fy2 = core_focus
                overlaps_core_focus = not (
                    (x + w) < fx1
                    or x > fx2
                    or (y + h) < fy1
                    or y > fy2
                )
            overlaps_anchor = True
            if anchor_projection_dilated is not None:
                label_mask = (labels == label).astype(np.uint8)
                overlaps_anchor = bool(np.any(anchor_projection_dilated & label_mask))
            support_like = (
                primary_left <= cx <= primary_right
                and primary_top <= cy <= primary_bottom
            )

            if core_bounds is not None and label != primary_label:
                cx1, cy1, cx2, cy2 = core_bounds
                outside_core = (x + w) <= cx1 or x >= cx2 or (y + h) <= cy1 or y >= cy2
                edge_sliver_area_limit = max(
                    prominent_area,
                    int(round(primary_area * 0.055)),
                )
                edge_sliver_thin_limit = max(4, int(round(min(width, height) * 0.065)))
                edge_sliver = (
                    touches_side_or_top_border
                    and area <= edge_sliver_area_limit
                    and min(w, h) <= edge_sliver_thin_limit
                )
                if (outside_core and touches_slice_border) or edge_sliver:
                    continue

            if core_bounds is not None:
                cx1, cy1, cx2, cy2 = core_bounds
                core_h = max(1, cy2 - cy1)
                top_foreign_cutoff = cy1 + max(2, int(round(core_h * 0.045)))
                entirely_above_core = (y + h) <= top_foreign_cutoff
                if entirely_above_core and not overlaps_anchor and label != primary_label:
                    continue

            if anchor_projection_dilated is not None and not overlaps_anchor and label != primary_label and not overlaps_primary:
                continue

            if core_focus is not None and not overlaps_core_focus and label != primary_label and not overlaps_primary:
                continue

            if area < min_area and not support_like:
                continue

            keep = (
                label == primary_label
                or overlaps_primary
                or support_like
                or (area >= prominent_area and not touches_hard_border)
            )
            if keep:
                keep_mask |= labels == label

        cleaned_alpha = np.where(keep_mask, alpha, 0).astype(np.uint8)
        cleaned_mask = (cleaned_alpha > 0).astype(np.uint8) * 255
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        cleaned_mask = cv2.morphologyEx(cleaned_mask, cv2.MORPH_CLOSE, kernel, iterations=1)
        cleaned_alpha = np.where(cleaned_mask > 0, cleaned_alpha, 0).astype(np.uint8)
        return cleaned_alpha

    def _cleanup_top_strip_artifacts(
        self,
        alpha: np.ndarray,
        core_bounds: Tuple[int, int, int, int] | None = None,
        anchor_alpha: np.ndarray | None = None,
    ) -> np.ndarray:
        if alpha is None or alpha.size == 0 or core_bounds is None:
            return alpha

        height, width = alpha.shape
        cx1, cy1, cx2, cy2 = core_bounds
        core_h = max(1, cy2 - cy1)
        strip_bottom = min(height, max(4, cy1 + int(round(core_h * 0.14))))
        if strip_bottom <= 0:
            return alpha

        mask = (alpha > 18).astype(np.uint8)
        strip_mask = np.zeros_like(mask, dtype=np.uint8)
        strip_mask[:strip_bottom, :] = mask[:strip_bottom, :]
        if not np.any(strip_mask):
            return alpha

        anchor_projection_dilated: np.ndarray | None = None
        if anchor_alpha is not None and anchor_alpha.size > 0:
            anchor_h, anchor_w = anchor_alpha.shape[:2]
            target_w = max(1, min(anchor_w, cx2 - cx1))
            target_h = max(1, min(anchor_h, cy2 - cy1))
            resized_anchor = anchor_alpha
            if anchor_w != target_w or anchor_h != target_h:
                resized_anchor = cv2.resize(anchor_alpha, (target_w, target_h), interpolation=cv2.INTER_NEAREST)

            anchor_projection = np.zeros_like(mask, dtype=np.uint8)
            anchor_projection[cy1:cy1 + target_h, cx1:cx1 + target_w] = (resized_anchor > 18).astype(np.uint8)
            dilation_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
            anchor_projection_dilated = cv2.dilate(anchor_projection, dilation_kernel, iterations=1)

        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(strip_mask, connectivity=8)
        if num_labels <= 1:
            return alpha

        cleaned = alpha.copy()
        strip_midline = max(1, int(round(strip_bottom * 0.72)))
        for label in range(1, num_labels):
            x = int(stats[label, cv2.CC_STAT_LEFT])
            y = int(stats[label, cv2.CC_STAT_TOP])
            w = int(stats[label, cv2.CC_STAT_WIDTH])
            h = int(stats[label, cv2.CC_STAT_HEIGHT])
            area = int(stats[label, cv2.CC_STAT_AREA])
            if area <= 0:
                continue

            mostly_upper_strip = (y + h) <= strip_midline
            if not mostly_upper_strip:
                continue

            label_mask = (labels == label).astype(np.uint8)
            overlaps_anchor = False
            if anchor_projection_dilated is not None:
                overlaps_anchor = bool(np.any(anchor_projection_dilated & label_mask))

            if overlaps_anchor:
                continue

            cleaned[labels == label] = 0

        return cleaned

    def _degreen_edges(self, rgba_img: np.ndarray) -> np.ndarray:
        """
        Remove green halos around the matte without making the outline thick.
        """
        bgr = rgba_img[:, :, :3].astype(np.float32)
        alpha = rgba_img[:, :, 3].astype(np.float32)
        if not np.any(alpha > 0):
            return rgba_img

        hsv = cv2.cvtColor(rgba_img[:, :, :3], cv2.COLOR_BGR2HSV)
        h, s, _ = cv2.split(hsv)
        b = bgr[:, :, 0]
        g = bgr[:, :, 1]
        r = bgr[:, :, 2]
        green_excess = g - np.maximum(r, b)

        fg_mask = (alpha > 10).astype(np.uint8)
        distance_to_edge = cv2.distanceTransform(fg_mask, cv2.DIST_L2, 5)
        edge_strength = np.clip((5.0 - distance_to_edge) / 5.0, 0.0, 1.0)
        suspicious = (
            (alpha > 0)
            & (edge_strength > 0)
            & (h >= 28)
            & (h <= 100)
            & (s >= 18)
            & (green_excess > 4)
        )
        screen_like_green = self._green_screen_like_mask(
            rgba_img[:, :, :3],
            suspicious,
            alpha=rgba_img[:, :, 3],
            lab_threshold=52.0,
        )
        suspicious &= screen_like_green

        correction = np.zeros_like(g, dtype=np.float32)
        correction[suspicious] = np.clip(green_excess[suspicious] * 0.85, 0.0, 110.0) * edge_strength[suspicious]
        g[suspicious] = np.maximum(0.0, g[suspicious] - correction[suspicious])
        r[suspicious] = np.minimum(255.0, r[suspicious] + correction[suspicious] * 0.33)
        b[suspicious] = np.minimum(255.0, b[suspicious] + correction[suspicious] * 0.42)

        severe_spill = suspicious & (green_excess > 16)
        alpha[severe_spill] = np.maximum(
            0.0,
            alpha[severe_spill] - correction[severe_spill] * 1.15,
        )

        out = np.dstack([
            b.astype(np.uint8),
            g.astype(np.uint8),
            r.astype(np.uint8),
            alpha.astype(np.uint8),
        ])
        return out

    def _compute_content_bounds(self, alpha: np.ndarray, threshold: int = 8) -> Tuple[int, int, int, int] | None:
        indices = np.where(alpha > threshold)
        if indices[0].size == 0 or indices[1].size == 0:
            return None

        y1 = int(indices[0].min())
        y2 = int(indices[0].max()) + 1
        x1 = int(indices[1].min())
        x2 = int(indices[1].max()) + 1
        return x1, y1, x2, y2

    def _expand_bounds(
        self,
        bounds: Tuple[int, int, int, int],
        width: int,
        height: int,
        pad_x_ratio: float,
        pad_top_ratio: float,
        pad_bottom_ratio: float,
    ) -> Tuple[int, int, int, int]:
        x1, y1, x2, y2 = bounds
        box_w = max(1, x2 - x1)
        box_h = max(1, y2 - y1)
        pad_x = max(6, int(round(box_w * pad_x_ratio)))
        pad_top = max(6, int(round(box_h * pad_top_ratio)))
        pad_bottom = max(8, int(round(box_h * pad_bottom_ratio)))

        return (
            max(0, x1 - pad_x),
            max(0, y1 - pad_top),
            min(width, x2 + pad_x),
            min(height, y2 + pad_bottom),
        )

    def _add_white_stroke(
        self,
        rgba_img: np.ndarray,
        stroke_radius: float,
        feather: float,
        outer_pad: int,
        supersample: int,
    ) -> np.ndarray:
        if rgba_img.size == 0:
            return rgba_img

        src_h, src_w = rgba_img.shape[:2]
        upscaled = self._resize_rgba_premultiplied(
            rgba_img,
            new_w=max(1, src_w * supersample),
            new_h=max(1, src_h * supersample),
        )
        pad = max(0, outer_pad * supersample)
        if pad > 0:
            upscaled = cv2.copyMakeBorder(
                upscaled,
                pad,
                pad,
                pad,
                pad,
                cv2.BORDER_CONSTANT,
                value=[0, 0, 0, 0],
            )

        alpha = upscaled[:, :, 3].astype(np.float32) / 255.0
        fg_mask = (alpha > 0.02).astype(np.uint8)
        outside = (fg_mask == 0).astype(np.uint8)
        distance_to_fg = cv2.distanceTransform(outside, cv2.DIST_L2, 5)

        radius_px = stroke_radius * supersample
        feather_px = max(1.0, feather * supersample)
        stroke_alpha = np.zeros_like(alpha, dtype=np.float32)

        hard_band = distance_to_fg <= radius_px
        soft_band = (distance_to_fg > radius_px) & (distance_to_fg <= (radius_px + feather_px))
        stroke_alpha[hard_band] = 1.0
        stroke_alpha[soft_band] = 1.0 - ((distance_to_fg[soft_band] - radius_px) / feather_px)
        stroke_alpha[fg_mask > 0] = 0.0

        object_rgb = upscaled[:, :, :3].astype(np.float32) / 255.0
        object_a = alpha[..., None]
        stroke_a = stroke_alpha[..., None]

        premult_object = object_rgb * object_a
        premult_stroke = np.ones_like(object_rgb, dtype=np.float32) * stroke_a
        out_a = object_a + stroke_a * (1.0 - object_a)
        out_rgb = premult_object + (premult_stroke * (1.0 - object_a))

        composed = np.zeros_like(upscaled, dtype=np.uint8)
        non_zero = out_a[:, :, 0] > 1e-6
        composed_alpha = np.clip(out_a[:, :, 0] * 255.0, 0.0, 255.0).astype(np.uint8)
        composed_rgb = np.zeros_like(object_rgb, dtype=np.float32)
        composed_rgb[non_zero] = out_rgb[non_zero] / out_a[non_zero]
        composed[:, :, :3] = np.clip(composed_rgb * 255.0, 0.0, 255.0).astype(np.uint8)
        composed[:, :, 3] = composed_alpha

        return self._resize_rgba_premultiplied(composed, new_w=src_w + (outer_pad * 2), new_h=src_h + (outer_pad * 2))

    def _resize_and_center_rgba(self, rgba_img: np.ndarray, target_w: int, target_h: int, padding: int) -> np.ndarray:
        src_h, src_w = rgba_img.shape[:2]
        available_w = max(1, target_w - (padding * 2))
        available_h = max(1, target_h - (padding * 2))
        scale = min(available_w / max(src_w, 1), available_h / max(src_h, 1))

        new_w = max(1, int(round(src_w * scale)))
        new_h = max(1, int(round(src_h * scale)))
        resized = self._resize_rgba_premultiplied(rgba_img, new_w=new_w, new_h=new_h)

        canvas = np.zeros((target_h, target_w, 4), dtype=np.uint8)
        x_offset = (target_w - new_w) // 2
        y_offset = (target_h - new_h) // 2
        canvas[y_offset:y_offset + new_h, x_offset:x_offset + new_w] = resized
        return canvas

    def _resize_rgba_premultiplied(self, rgba_img: np.ndarray, new_w: int, new_h: int) -> np.ndarray:
        if rgba_img.shape[0] == new_h and rgba_img.shape[1] == new_w:
            return rgba_img.copy()

        alpha = rgba_img[:, :, 3:4].astype(np.float32) / 255.0
        rgb = rgba_img[:, :, :3].astype(np.float32) / 255.0
        premult = rgb * alpha

        interpolation = cv2.INTER_AREA if (new_w < rgba_img.shape[1] or new_h < rgba_img.shape[0]) else cv2.INTER_CUBIC
        resized_premult = cv2.resize(premult, (new_w, new_h), interpolation=interpolation)
        resized_alpha = cv2.resize(alpha, (new_w, new_h), interpolation=interpolation)
        if resized_alpha.ndim == 2:
            resized_alpha = resized_alpha[:, :, None]
        resized_alpha = np.clip(resized_alpha, 0.0, 1.0)

        restored_rgb = np.zeros_like(resized_premult, dtype=np.float32)
        non_zero = resized_alpha[:, :, 0] > 1e-6
        restored_rgb[non_zero] = resized_premult[non_zero] / resized_alpha[non_zero, 0][:, None]

        out = np.zeros((new_h, new_w, 4), dtype=np.uint8)
        out[:, :, :3] = np.clip(restored_rgb * 255.0, 0.0, 255.0).astype(np.uint8)
        out[:, :, 3] = np.clip(resized_alpha[:, :, 0] * 255.0, 0.0, 255.0).astype(np.uint8)
        return out
