import React from 'react';
import { AppHeader } from './AppHeader';

interface PageLayoutProps {
  isOnline: boolean;
  children: React.ReactNode;
}

export const PageLayout: React.FC<PageLayoutProps> = ({ isOnline, children }) => {
  return (
    <div className="min-h-dvh bg-[#f8fafc] text-slate-900">
      <AppHeader isOnline={isOnline} />
      {children}
    </div>
  );
};
