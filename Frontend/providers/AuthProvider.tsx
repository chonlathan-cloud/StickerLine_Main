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
  const [isReady, setIsReady] = useState(false);
  const [profile, setProfile] = useState<LineProfile | null>(null);
  const [coinBalance, setCoinBalance] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const liffId = import.meta.env.VITE_LIFF_ID as string | undefined;
    if (!liffId) {
      setError('Missing LIFF ID. Please set VITE_LIFF_ID in Frontend/.env');
      setIsReady(true);
      return;
    }

    if (typeof liff === 'undefined') {
      setError('LINE SDK failed to load. Please check index.html.');
      setIsReady(true);
      return;
    }

    let cancelled = false;

    const initLiff = async () => {
      try {
        await liff.init({ liffId });
        if (cancelled) return;

        if (liff.isLoggedIn()) {
          const liffProfile = await liff.getProfile();
          if (cancelled) return;

          try {
            const userData = await syncUser({
              line_id: liffProfile.userId,
              display_name: liffProfile.displayName,
              picture_url: liffProfile.pictureUrl,
            });
            if (!cancelled) {
              setProfile(liffProfile);
              setCoinBalance(typeof userData?.coin_balance === 'number' ? userData.coin_balance : null);
              setError(null);
            }
          } catch (syncErr: any) {
            if (!cancelled) {
              setError(syncErr?.response?.data?.detail || syncErr?.message || 'Failed to sync LINE profile.');
            }
          }
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Failed to initialize LINE login.');
        }
      } finally {
        if (!cancelled) {
          setIsReady(true);
        }
      }
    };

    initLiff();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = () => {
    if (typeof liff === 'undefined') {
      setError('LINE SDK failed to load. Please check index.html.');
      return;
    }
    setError(null);
    liff.login({ redirectUri: `${window.location.origin}/generate` });
  };

  const logout = () => {
    if (typeof liff !== 'undefined' && liff.isLoggedIn()) {
      liff.logout();
    }
    setProfile(null);
    setCoinBalance(null);
  };

  const refreshProfile = async () => {
    if (!profile?.userId) return;
    try {
      const userData = await syncUser({
        line_id: profile.userId,
        display_name: profile.displayName,
        picture_url: profile.pictureUrl,
      });
      setCoinBalance(typeof userData?.coin_balance === 'number' ? userData.coin_balance : null);
    } catch (syncErr: any) {
      setError(syncErr?.response?.data?.detail || syncErr?.message || 'Failed to refresh profile.');
    }
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
