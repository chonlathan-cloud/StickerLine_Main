
export interface ProcessedSticker {
  id: string;
  url: string;
}

const loadImage = (dataUrl: string): Promise<HTMLImageElement> => (
  new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  })
);

const findOpaqueBounds = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold: number = 8
) => {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha <= alphaThreshold) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
};

/**
 * ลบพื้นหลังสี Green (#00FF00) ออกจากภาพ
 */
export async function processTransparentSheet(
  sheetDataUrl: string,
  removeBackground: boolean = true
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return reject("Could not get context");

      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      if (removeBackground) {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        // ตรวจจับพื้นหลังเขียวแบบเข้มเพื่อใช้เป็น mask หลัก
        const isStrongChromaGreen = (idx: number) => {
          const rVal = data[idx];
          const gVal = data[idx + 1];
          const bVal = data[idx + 2];
          const dominantAgainstRed = gVal > rVal * 1.2;
          const dominantAgainstBlue = gVal > bVal * 1.2;
          const greenExcess = gVal - Math.max(rVal, bVal);
          return gVal > 90 && dominantAgainstRed && dominantAgainstBlue && greenExcess > 28;
        };

        const visited = new Uint8Array(canvas.width * canvas.height);
        const q: [number, number][] = [];

        // เริ่มต้น Flood fill จากขอบทั้ง 4 ด้าน
        for (let x = 0; x < canvas.width; x++) {
          if (isStrongChromaGreen(x * 4)) { q.push([x, 0]); visited[x] = 1; }
          const botIdx = (canvas.height - 1) * canvas.width + x;
          if (isStrongChromaGreen(botIdx * 4)) { q.push([x, canvas.height - 1]); visited[botIdx] = 1; }
        }
        for (let y = 0; y < canvas.height; y++) {
          const leftIdx = y * canvas.width;
          if (isStrongChromaGreen(leftIdx * 4)) { q.push([0, y]); visited[leftIdx] = 1; }
          const rightIdx = y * canvas.width + (canvas.width - 1);
          if (isStrongChromaGreen(rightIdx * 4)) { q.push([canvas.width - 1, y]); visited[rightIdx] = 1; }
        }

        while (q.length > 0) {
          const [cx, cy] = q.shift()!;
          const idx = (cy * canvas.width + cx) * 4;

          // เปลี่ยนสีพื้นหลังเป็นโปร่งใส
          data[idx + 3] = 0;

          const neighbors: [number, number][] = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
          for (const [nx, ny] of neighbors) {
            if (nx >= 0 && nx < canvas.width && ny >= 0 && ny < canvas.height) {
              const nIdx = ny * canvas.width + nx;
              if (!visited[nIdx] && isStrongChromaGreen(nIdx * 4)) {
                visited[nIdx] = 1;
                q.push([nx, ny]);
              }
            }
          }
        }

        // ลด green spill บริเวณขอบตัวละครเพื่อให้ PNG คมขึ้น
        const hasTransparentNeighbor = (x: number, y: number) => {
          const neighbors: [number, number][] = [
            [x + 1, y],
            [x - 1, y],
            [x, y + 1],
            [x, y - 1],
          ];

          for (const [nx, ny] of neighbors) {
            if (nx < 0 || nx >= canvas.width || ny < 0 || ny >= canvas.height) continue;
            const nIdx = (ny * canvas.width + nx) * 4;
            if (data[nIdx + 3] === 0) return true;
          }
          return false;
        };

        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const idx = (y * canvas.width + x) * 4;
            const alpha = data[idx + 3];
            if (alpha === 0) continue;

            const rVal = data[idx];
            const gVal = data[idx + 1];
            const bVal = data[idx + 2];
            const greenExcess = gVal - Math.max(rVal, bVal);
            if (greenExcess <= 10) continue;

            const nearTransparent = hasTransparentNeighbor(x, y);
            const spillStrength = nearTransparent
              ? Math.min(1, greenExcess / 120)
              : Math.min(0.5, greenExcess / 180);
            const deGreen = Math.round(greenExcess * spillStrength);

            data[idx + 1] = Math.max(0, gVal - deGreen);
            data[idx] = Math.min(255, rVal + Math.round(deGreen * 0.28));
            data[idx + 2] = Math.min(255, bVal + Math.round(deGreen * 0.35));

            if (nearTransparent && greenExcess > 70) {
              data[idx + 3] = Math.max(0, alpha - Math.round((greenExcess - 70) * 0.65));
            }
          }
        }

        ctx.putImageData(imageData, 0, 0);
      }

      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = sheetDataUrl;
  });
}

/**
 * แยกสติ๊กเกอร์จากภาพชีตแบบ grid เป็นภาพเดี่ยว (ค่าเริ่มต้น 4x4 = 16 รูป)
 */
export async function splitStickerSheet(
  sheetDataUrl: string,
  columns: number = 4,
  rows: number = 4
): Promise<string[]> {
  if (columns <= 0 || rows <= 0) {
    throw new Error('Invalid grid dimensions for sticker splitting.');
  }

  const img = await loadImage(sheetDataUrl);
  const cellWidth = img.width / columns;
  const cellHeight = img.height / rows;
  const stickers: string[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const sx = Math.round(col * cellWidth);
      const sy = Math.round(row * cellHeight);
      const sw = Math.round((col + 1) * cellWidth) - sx;
      const sh = Math.round((row + 1) * cellHeight) - sy;
      const safeInset = Math.max(1, Math.round(Math.min(sw, sh) * 0.02));
      const sourceX = sx + safeInset;
      const sourceY = sy + safeInset;
      const sourceW = Math.max(1, sw - safeInset * 2);
      const sourceH = Math.max(1, sh - safeInset * 2);

      const sourceCanvas = document.createElement('canvas');
      const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
      if (!sourceCtx) throw new Error('Could not get context while splitting stickers.');
      sourceCanvas.width = sourceW;
      sourceCanvas.height = sourceH;
      sourceCtx.drawImage(img, sourceX, sourceY, sourceW, sourceH, 0, 0, sourceW, sourceH);

      const sourceData = sourceCtx.getImageData(0, 0, sourceW, sourceH);
      const opaqueBounds = findOpaqueBounds(sourceData.data, sourceW, sourceH);

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not get context while splitting stickers.');
      canvas.width = sw;
      canvas.height = sh;
      ctx.clearRect(0, 0, sw, sh);

      if (!opaqueBounds) {
        ctx.drawImage(sourceCanvas, 0, 0, sourceW, sourceH, 0, 0, sw, sh);
        stickers.push(canvas.toDataURL('image/png'));
        continue;
      }

      const targetPadding = Math.max(6, Math.round(Math.min(sw, sh) * 0.06));
      const availableWidth = Math.max(1, sw - targetPadding * 2);
      const availableHeight = Math.max(1, sh - targetPadding * 2);
      const fitScale = Math.min(
        availableWidth / opaqueBounds.width,
        availableHeight / opaqueBounds.height
      );

      const drawWidth = opaqueBounds.width * fitScale;
      const drawHeight = opaqueBounds.height * fitScale;
      const drawX = (sw - drawWidth) / 2;
      const drawY = (sh - drawHeight) / 2;

      ctx.drawImage(
        sourceCanvas,
        opaqueBounds.minX,
        opaqueBounds.minY,
        opaqueBounds.width,
        opaqueBounds.height,
        drawX,
        drawY,
        drawWidth,
        drawHeight
      );

      stickers.push(canvas.toDataURL('image/png'));
    }
  }

  return stickers;
}

/**
 * ประกอบภาพสติ๊กเกอร์เดี่ยวกลับเป็นภาพชีต
 */
export async function composeStickerSheet(
  stickerDataUrls: string[],
  columns: number = 4,
  rows: number = 4
): Promise<string> {
  if (stickerDataUrls.length === 0) {
    throw new Error('No sticker images provided for composition.');
  }
  if (columns <= 0 || rows <= 0) {
    throw new Error('Invalid grid dimensions for sticker composition.');
  }

  const maxSlots = columns * rows;
  const sources = stickerDataUrls.slice(0, maxSlots);
  const images = await Promise.all(sources.map((url) => loadImage(url)));
  const stickerWidth = images[0].width;
  const stickerHeight = images[0].height;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get context while composing sticker sheet.');

  canvas.width = stickerWidth * columns;
  canvas.height = stickerHeight * rows;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let index = 0; index < images.length; index++) {
    const col = index % columns;
    const row = Math.floor(index / columns);
    if (row >= rows) break;
    ctx.drawImage(images[index], col * stickerWidth, row * stickerHeight, stickerWidth, stickerHeight);
  }

  return canvas.toDataURL('image/png');
}
