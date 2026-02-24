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
                
            height, width = grid_img.shape[:2]
            cell_h = height // 4
            cell_w = width // 4
            
            processed_stickers = []
            
            # Step B: Loop 4x4 times to slice the grid into 16 individual images
            for row in range(4):
                for col in range(4):
                    # Slice the grid
                    y_start = row * cell_h
                    y_end = (row + 1) * cell_h
                    x_start = col * cell_w
                    x_end = (col + 1) * cell_w
                    
                    slice_img = grid_img[y_start:y_end, x_start:x_end]
                    
                    # Step C: Process each slice
                    output_bytes = self._process_single_sticker(slice_img)
                    processed_stickers.append(output_bytes)
                    
            return processed_stickers
        except Exception as e:
            logger.error(f"Error processing sticker grid: {e}")
            raise e

    def _process_single_sticker(self, cv_img: np.ndarray) -> bytes:
        # 1. Remove background using rembg
        # Note: rembg removes the green/solid background and returns RGBA
        img_with_alpha = rembg.remove(cv_img)
        
        # 2. Trim transparent whitespace (Crop to content)
        b, g, r, a = cv2.split(img_with_alpha)
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
