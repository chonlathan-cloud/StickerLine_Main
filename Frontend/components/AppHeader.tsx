import React from 'react';
import { Bell as NotificationIcon, Sparkles as SparklesIcon } from 'lucide-react';

interface AppHeaderProps {
  isOnline: boolean;
}

export const AppHeader: React.FC<AppHeaderProps> = ({ isOnline }) => {
  return (
    <header className="sticky top-0 z-50 flex items-center justify-between px-6 py-3 bg-surface border-b border-outline-variant/30 backdrop-blur-md">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 h-10 rounded-full overflow-hidden shadow-sm shrink-0">
          <img src="/assets/template/avatar.png" alt="User" className="w-full h-full object-cover" />
        </div>
        <h1 className="text-xl font-extrabold text-primary tracking-tight truncate">Mia-U-Sticker</h1>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary-container rounded-full shadow-sm">
          <SparklesIcon className="text-on-secondary-container w-5 h-5" />
          <span className="text-sm font-bold text-on-secondary-container">{isOnline ? 'Ready' : 'Offline'}</span>
        </div>
        <button type="button" className="relative p-2 rounded-full hover:bg-surface-container transition-colors" aria-label="Notifications">
          <NotificationIcon className="text-primary w-6 h-6" />
        </button>
      </div>
    </header>
  );
};
