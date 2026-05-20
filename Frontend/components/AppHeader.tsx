import React from 'react';

interface AppHeaderProps {
  isOnline: boolean;
}

export const AppHeader: React.FC<AppHeaderProps> = ({ isOnline }) => {
  return (
    <header className="sticky top-0 z-50 border-b border-slate-200/70 bg-white/80 px-4 py-4 backdrop-blur-[20px]">
      <div className="mx-auto flex w-full max-w-md items-center justify-between gap-4 sm:max-w-xl">
        <div className="space-y-1">
          <p className="text-xs font-semibold tracking-wide text-slate-600">Sticker Studio</p>
          <h1 className="bg-gradient-to-r from-indigo-600 via-sky-500 to-emerald-500 bg-clip-text text-2xl font-semibold leading-tight text-transparent">
            Mia-U-Sticker
          </h1>
          <div className="flex items-center gap-1.5" aria-hidden="true">
            <span className="h-2 w-2 rounded-full bg-rose-400" />
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="h-2 w-2 rounded-full bg-sky-400" />
          </div>
        </div>

        <div
          className={`inline-flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold ${isOnline ? 'bg-slate-100 text-slate-800' : 'bg-red-50 text-red-700'}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span
            className={`h-2.5 w-2.5 rounded-full ${isOnline ? 'bg-green-600' : 'bg-red-600'}`}
            aria-hidden="true"
          />
          <span>{isOnline ? 'Ready' : 'Offline'}</span>
        </div>
      </div>
    </header>
  );
};
