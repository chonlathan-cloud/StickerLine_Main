import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { syncUser } from '../api/client';

type LineProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
};

interface AuthContextValue {
  isReady: boolean;
  isAuthenticated: boolean;
  profile: LineProfile | null;
  coinBalance: number | null;
  error: string | null;
  login: () => void;
  logout: () => void;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isReady, setIsReady] = useState(true);
  const [profile, setProfile] = useState<LineProfile | null>({
    userId: 'mock-user-123',
    displayName: 'Mock User',
    pictureUrl: 'https://placehold.co/150x150/png',
  });
  const [coinBalance, setCoinBalance] = useState<number | null>(100);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Login system is removed for development, bypassing LINE SDK.
  }, []);

  const login = () => {};

  const logout = () => {
    setProfile(null);
    setCoinBalance(null);
  };

  const refreshProfile = async () => {
    setCoinBalance(100);
  };

  const value = useMemo<AuthContextValue>(() => {
    const isAuthenticated = Boolean(profile?.userId);
    return {
      isReady,
      isAuthenticated,
      profile,
      coinBalance,
      error,
      login,
      logout,
      refreshProfile,
    };
  }, [isReady, profile, coinBalance, error]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
