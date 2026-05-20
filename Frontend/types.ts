
export type ImageSize = '1K' | '2K' | '4K';
// Supported aspect ratios for image generation: '1:1', '3:4', '4:3', '9:16', and '16:9'.
export type AspectRatio = '1:1' | '3:4' | '4:3' | '9:16' | '16:9';

export type StickerStyle = 'Chibi 2D' | 'Pixar 3D';
export type StickerSet = 'SetA' | 'SetB';

export interface StickerSheetConfig {
  base64Image: string;
  size: ImageSize;
  aspectRatio: AspectRatio;
  extraPrompt: string;
  style: StickerStyle;
}

export interface StickerConfig {
  prompt: string;
  size: ImageSize;
  aspectRatio: AspectRatio;
  base64Image?: string;
}

export interface GeneratedSticker {
  id: string;
  url: string;
  timestamp: number;
}

export interface AIStudio {
  hasSelectedApiKey: () => Promise<boolean>;
  openSelectKey: () => Promise<void>;
}
