/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_LIFF_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

type LiffProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
};

type LiffInitConfig = {
  liffId: string;
};

type LiffLoginConfig = {
  redirectUri?: string;
};

type LiffOpenWindowConfig = {
  url: string;
  external?: boolean;
};

interface LiffInstance {
  init(config: LiffInitConfig): Promise<void>;
  isLoggedIn(): boolean;
  getAccessToken(): string | null;
  getProfile(): Promise<LiffProfile>;
  login(config?: LiffLoginConfig): void;
  logout(): void;
  isInClient?(): boolean;
  openWindow?(config: LiffOpenWindowConfig): void;
}

declare global {
  const liff: LiffInstance;

  interface Window {
    liff?: LiffInstance;
  }
}

export {};
