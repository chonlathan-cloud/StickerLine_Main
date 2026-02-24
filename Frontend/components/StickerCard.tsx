import React from 'react';
import { GeneratedSticker } from '../types';

interface StickerCardProps {
  sticker: GeneratedSticker;
  index: number;
}

export const StickerCard: React.FC<StickerCardProps> = ({ sticker, index }) => {
  const stickerNumber = index + 1;

  const downloadImage = () => {
    const link = document.createElement('a');
    link.href = sticker.url;
    link.download = `sticker-transparent-${stickerNumber}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <article className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="relative flex aspect-square items-center justify-center bg-slate-50 p-4">
        <img
          src={sticker.url}
          alt={`Sticker preview ${stickerNumber}`}
          className="max-h-full max-w-full object-contain"
        />
        <span className="absolute left-3 top-3 rounded-full bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white">
          {`#${stickerNumber}`}
        </span>
      </div>

      <div className="p-3">
        <button
          type="button"
          onClick={downloadImage}
          className="focus-ring min-h-11 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 hover:border-indigo-500 hover:text-indigo-700"
          aria-label={`Download sticker ${stickerNumber} as PNG`}
        >
          Download PNG
        </button>
      </div>
    </article>
  );
};
