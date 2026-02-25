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
  error: string | null;
  login: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isReady, setIsReady] = useState(false);
  const [profile, setProfile] = useState<LineProfile | null>(null);
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
            await syncUser({
              line_id: liffProfile.userId,
              display_name: liffProfile.displayName,
              picture_url: liffProfile.pictureUrl,
            });
            if (!cancelled) {
              setProfile(liffProfile);
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
  };

  const value = useMemo<AuthContextValue>(() => {
    const isAuthenticated = Boolean(profile?.userId);
    return {
      isReady,
      isAuthenticated,
      profile,
      error,
      login,
      logout,
    };
  }, [isReady, profile, error]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
