import React from 'react';
import { AppHeader } from './AppHeader';

interface PageLayoutProps {
  isOnline: boolean;
  children: React.ReactNode;
}

export const PageLayout: React.FC<PageLayoutProps> = ({ isOnline, children }) => {
  return (
    <div className="min-h-screen bg-background font-sans text-on-background selection:bg-primary selection:text-white">
      <AppHeader isOnline={isOnline} />
      {children}
    </div>
  );
};
