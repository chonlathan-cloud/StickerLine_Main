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

const MOCK_PROFILE: LineProfile = {
  userId: 'U0123456789abcdef0123456789abcdef',
  displayName: 'Local Guest',
  pictureUrl: '',
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isReady, setIsReady] = useState(false);
  const [profile, setProfile] = useState<LineProfile | null>(null);
  const [coinBalance, setCoinBalance] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const initGuestMode = async () => {
      try {
        // Set a mock token for the backend to recognize
        localStorage.setItem('line_access_token', 'guest');
        
        // Sync with backend to get starting balance
        const userData = await syncUser({
          line_id: MOCK_PROFILE.userId,
          display_name: MOCK_PROFILE.displayName,
          picture_url: MOCK_PROFILE.pictureUrl,
        });

        if (!cancelled) {
          setProfile(MOCK_PROFILE);
          setCoinBalance(typeof userData?.coin_balance === 'number' ? userData.coin_balance : 100);
          setError(null);
        }
      } catch (err: any) {
        console.error('Failed to sync guest user:', err);
        // Fallback to local profile even if backend fails
        if (!cancelled) {
          setProfile(MOCK_PROFILE);
          setCoinBalance(100);
        }
      } finally {
        if (!cancelled) {
          setIsReady(true);
        }
      }
    };

    initGuestMode();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = () => {
    console.log('Login bypassed in guest mode.');
  };

  const logout = () => {
    localStorage.removeItem('line_access_token');
    setProfile(null);
    setCoinBalance(null);
    // Reload to reset state if needed
    window.location.href = '/';
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
      console.warn('Silent failure in refreshProfile guest mode:', syncErr);
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
