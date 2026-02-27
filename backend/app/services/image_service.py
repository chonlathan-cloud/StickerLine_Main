import cv2
import numpy as np
import rembg
import logging
from typing import List

logger = logging.getLogger(__name__)

class ImageProcessor:
    def process_sticker_grid(self, image_bytes: bytes) -> List[bytes]:
        """
        Process the 4x4 grid image into 16 individual stickers.
        """
        try:
            # Step A: Load image from bytes to OpenCV format
            nparr = np.frombuffer(image_bytes, np.uint8)
            grid_img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if grid_img is None:
                raise ValueError("Could not decode image bytes into OpenCV format.")

            # Step A.1: Trim solid green margins (if any) to stabilize grid slicing
            grid_img = self._trim_green_margin(grid_img)

            # Step A.2: Normalize to sizes divisible by 4 to avoid drift
            grid_img = self._normalize_grid_size(grid_img)

            processed_stickers = []
            
            # Step B: Detect grid boundaries using green gutters (fallback to equal split)
            height, width = grid_img.shape[:2]
            y_edges = self._detect_grid_edges(grid_img, axis="y")
            if y_edges is None:
                y_edges = self._equal_edges(height)
            x_edges = self._detect_grid_edges(grid_img, axis="x")
            if x_edges is None:
                x_edges = self._equal_edges(width)

            for row in range(4):
                for col in range(4):
                    # Slice the grid using fractional edges to reduce drift
                    y_start = y_edges[row]
                    y_end = y_edges[row + 1]
                    x_start = x_edges[col]
                    x_end = x_edges[col + 1]

                    slice_img = grid_img[y_start:y_end, x_start:x_end]
                    slice_img = self._apply_safe_inset(slice_img, inset_ratio=0.01)
                    
                    # Step C: Process each slice
                    output_bytes = self._process_single_sticker(slice_img)
                    processed_stickers.append(output_bytes)

            return processed_stickers
        except Exception as e:
            logger.error(f"Error processing sticker grid: {e}")
            raise e

    def _apply_safe_inset(self, cv_img: np.ndarray, inset_ratio: float = 0.02) -> np.ndarray:
        """
        Trim a small inset from each cell to avoid bleed from adjacent cells.
        """
        height, width = cv_img.shape[:2]
        inset_x = int(round(width * inset_ratio))
        inset_y = int(round(height * inset_ratio))
        if inset_x <= 0 and inset_y <= 0:
            return cv_img
        x_start = min(inset_x, width - 1)
        y_start = min(inset_y, height - 1)
        x_end = max(width - inset_x, x_start + 1)
        y_end = max(height - inset_y, y_start + 1)
        return cv_img[y_start:y_end, x_start:x_end]

    def _equal_edges(self, size: int) -> np.ndarray:
        edges = np.linspace(0, size, 5).round().astype(int)
        edges[-1] = size
        return edges

    def _detect_grid_edges(self, cv_img: np.ndarray, axis: str) -> np.ndarray | None:
        """
        Detect grid boundaries by finding low-content (green) gutters.
        Returns edges array of length 5 if successful.
        """
        b, g, r = cv2.split(cv_img)
        green_mask = (g >= 200) & (r <= 60) & (b <= 60)
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
        if len(gaps) < 3:
            return None

        ideal = [size * i / 4 for i in range(1, 4)]
        centers = []
        used = set()
        for target in ideal:
            candidates = [gap for gap in gaps if gap not in used]
            if not candidates:
                return None
            best = min(candidates, key=lambda g: abs(g[2] - target))
            if abs(best[2] - target) > size * 0.2:
                return None
            centers.append(int(round(best[2])))
            used.add(best)

        centers = sorted(centers)
        edges = np.array([0] + centers + [size], dtype=int)
        if len(edges) != 5 or edges[0] != 0 or edges[-1] != size:
            return None
        return edges

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

    def _normalize_grid_size(self, cv_img: np.ndarray) -> np.ndarray:
        """
        Crop the grid to the nearest size divisible by 4 to prevent slice drift.
        """
        height, width = cv_img.shape[:2]
        new_h = (height // 4) * 4
        new_w = (width // 4) * 4

        if new_h == height and new_w == width:
            return cv_img

        y_start = max((height - new_h) // 2, 0)
        x_start = max((width - new_w) // 2, 0)
        y_end = y_start + new_h
        x_end = x_start + new_w

        return cv_img[y_start:y_end, x_start:x_end]

    def _process_single_sticker(self, cv_img: np.ndarray) -> bytes:
        # 1. Remove background using rembg
        # Note: rembg removes the green/solid background and returns RGBA
        img_with_alpha = rembg.remove(cv_img)

        # 1.1 Clean residual green spill before cropping
        img_with_alpha = self._remove_green_spill(img_with_alpha)
        
        # 2. Remove tiny fragments then trim transparent whitespace
        b, g, r, a = cv2.split(img_with_alpha)
        a = self._remove_small_alpha_blobs(a)
        y_indices, x_indices = np.where(a > 0)

        if len(x_indices) > 0 and len(y_indices) > 0:
            x_min, x_max = np.min(x_indices), np.max(x_indices)
            y_min, y_max = np.min(y_indices), np.max(y_indices)
            cropped_img = img_with_alpha[y_min:y_max+1, x_min:x_max+1]
        else:
            cropped_img = img_with_alpha  # fallback if totally transparent
            
        # 3. Add White Stroke
        # Add padding first so the stroke doesn't get cut off at the edges
        pad = 12
        padded_img = cv2.copyMakeBorder(cropped_img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=[0, 0, 0, 0])
        b_p, g_p, r_p, a_p = cv2.split(padded_img)
        
        # Create a circular kernel for the stroke and use cv2.dilate on the alpha channel to create a mask
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        dilated_alpha = cv2.dilate(a_p, kernel, iterations=2)
        
        # Overlay the original image on a white background using the dilated alpha mask
        final_img = np.zeros_like(padded_img)
        
        # Set pixels where dilated alpha is > 0 to white with full opacity
        stroke_mask = dilated_alpha > 0
        final_img[stroke_mask] = [255, 255, 255, 255]
        
        # Overwrite the white background with the original actual object pixels
        object_mask = a_p > 0
        final_img[object_mask] = padded_img[object_mask]
        
        # 4. Resize to 370x320 px maintaining aspect ratio
        target_w, target_h = 370, 320
        h, w = final_img.shape[:2]
        
        scale = min(target_w / w, target_h / h)
        new_w, new_h = int(w * scale), int(h * scale)
        
        resized_img = cv2.resize(final_img, (new_w, new_h), interpolation=cv2.INTER_AREA)
        
        # Create a blank 370x320 transparent canvas and paste the resized image in the center
        canvas = np.zeros((target_h, target_w, 4), dtype=np.uint8)
        x_offset = (target_w - new_w) // 2
        y_offset = (target_h - new_h) // 2
        
        canvas[y_offset:y_offset+new_h, x_offset:x_offset+new_w] = resized_img
        
        # Encode back to PNG bytes
        is_success, buffer = cv2.imencode(".png", canvas)
        if not is_success:
            raise ValueError("Failed to encode image to PNG.")
            
        return buffer.tobytes()

    def _remove_green_spill(self, rgba_img: np.ndarray) -> np.ndarray:
        """
        Remove leftover green spill by zeroing alpha on near-green pixels.
        """
        b, g, r, a = cv2.split(rgba_img)
        green_mask = (g >= 170) & (r <= 80) & (b <= 80)
        a = np.where(green_mask, 0, a).astype(np.uint8)
        return cv2.merge([b, g, r, a])

    def _remove_small_alpha_blobs(self, alpha: np.ndarray) -> np.ndarray:
        """
        Remove tiny alpha fragments that cause random debris.
        """
        if alpha is None or alpha.size == 0:
            return alpha

        mask = (alpha > 0).astype(np.uint8) * 255
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        if num_labels <= 1:
            return alpha

        min_area = max(50, int(alpha.shape[0] * alpha.shape[1] * 0.002))
        cleaned = np.zeros_like(alpha)
        for label in range(1, num_labels):
            x, y, w, h, area = stats[label]
            if area < min_area:
                continue
            cleaned[labels == label] = alpha[labels == label]
        return cleaned
