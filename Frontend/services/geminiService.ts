
import { GoogleGenAI } from "@google/genai";
import { StickerStyle, StickerSheetConfig } from "../types";

const DEFAULT_THAI_CAPTIONS = [
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
];

/**
 * GeminiService: Master Version V3.3-STABLE
 * Following LINE Sticker Guidelines & Strict Thai Text Constraints.
 */
export class GeminiService {
  /**
   * Generates sticker sheet using Gemini 3 Pro Image (Master Spec).
   */
  async generateStickerSheet(config: StickerSheetConfig): Promise<string> {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const model = 'gemini-3-pro-image-preview'; 
    
    const base64Data = config.base64Image.split(',')[1];
    const mimeType = config.base64Image.match(/data:(.*?);/)?.[1] || 'image/png';

    // STYLE GUIDE - PIXAR 3D PROMPT LOCK (user-requested update)
    let styleGuide = "";
    if (config.style === 'Chibi 2D') {
      styleGuide = `Art Style: Premium 2D Chibi, bold black outlines, vibrant flat colors.`;
    } else if (config.style === 'Pixar 3D') {
      styleGuide = `
        Art Style: Cute premium 3D character (Pixar-like sticker quality, original character only).
        - Chibi proportion: larger head with smaller body, rounded cheeks, expressive eyes, friendly facial features.
        - Hair should be sculpted in soft chunky strands with clean volume, not realistic thin strands.
        - Lighting: warm cinematic key light + soft rim light, smooth gradients, polished but readable at small size.
        - Expression quality: exaggerated and clear for chat usage (smile, laugh, wink, thinking, shocked, etc.).
        - Framing rule: keep full face/head/hands inside each cell with safe margins; no cropped forehead/chin.
        - Render as sticker-ready subject with clean silhouette and no messy artifacts.
      `;
    }

    // TECHNICAL TOKENS - AGENTS.MD SECTION 4 (LOCKED)
    const technicalTokens = "High-resolution professional art, sharp clean outlines, no die-cut border, no white outline, no green spill on character edges, solid #00FF00 green background for transparency, 4x4 grid layout, 16 distinct poses, consistent character design, center-aligned characters, LINE sticker compliant style, safe margin in every cell.";

    const noTextRequested = /(no text|without text|no caption|ไม่มีข้อความ|ไม่ต้องมีข้อความ|ไม่มีแคปชัน)/i.test(config.extraPrompt);

    // TEXT INSTRUCTION - STICKER SAMPLE STYLE (default ON, can disable via prompt)
    const textInstruction = noTextRequested
      ? "Generate stickers without any text captions."
      : `
        MANDATORY TEXT CAPTIONS:
        - Add one short Thai caption per sticker using this set: ${DEFAULT_THAI_CAPTIONS.join(", ")}.
        - Place caption at bottom-center of each cell, clearly separated from face/hands.
        - Typography style: Google Fonts look (Kanit ExtraBold or Noto Sans Thai Black style).
        - Text render: solid black letters with thick white outline and soft shadow for high readability.
        - Keep caption large and readable in chat size, but do not clip text at cell edges.
        - Thai glyph integrity is mandatory: all vowels/diacritics/tonemarks must remain complete and visible (e.g. ุ ู ิ ี ึ ื ่ ้ ๊ ๋ ์).
        - Do not drop, merge, crop, or distort any Thai marks; spelling must be exactly correct.
        - Keep extra vertical safety above/below text so lower vowels and upper tone marks are never cut.
        - Outline must stay outside glyph strokes and must not cover interior Thai marks.
      `;

    const fullPrompt = `
      ${technicalTokens}
      Objective: Create a professional 16-pose sticker sheet (4 columns x 4 rows) based on the uploaded photo.
      ${styleGuide}
      ${textInstruction}
      Character Likeness: ${config.extraPrompt || 'Maintain subject identity faithfully.'}
      Character should be positioned clearly in each grid cell.
    `.trim();

    try {
      const response = await ai.models.generateContent({
        model: model,
        contents: [{
          parts: [
            { inlineData: { mimeType: mimeType, data: base64Data } },
            { text: fullPrompt }
          ],
        }],
        config: {
          imageConfig: {
            aspectRatio: config.aspectRatio || "1:1",
            imageSize: config.size || "2K"
          }
        }
      });

      const part = response.candidates?.[0]?.content?.parts.find(p => p.inlineData);
      if (part?.inlineData?.data) {
        return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      }
      throw new Error("API returned success but no image data was found.");
    } catch (error: any) {
      console.error("Master Generation Error:", error);
      throw new Error(error.message || "Sticker Generation Failed");
    }
  }
}
