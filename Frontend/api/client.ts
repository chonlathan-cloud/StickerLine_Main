import axios from 'axios';

const baseURL = (import.meta as any).env?.VITE_API_BASE_URL;
const API = axios.create({
  baseURL: baseURL ?? 'http://localhost:8080',
  headers: { 'Content-Type': 'application/json' },
});

const getLineAccessToken = () => {
  try {
    return localStorage.getItem('line_access_token') || '';
  } catch {
    return '';
  }
};

API.interceptors.request.use((config) => {
  const token = getLineAccessToken();
  if (token) {
    config.headers = config.headers ?? new axios.AxiosHeaders();
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
});

export type StickerSlotResponse = { index: number; url: string; locked: boolean };
export type ExtraPickResponse = { index: number; url: string | null; preview_url?: string | null };

//const API = axios.create({
//  baseURL: (import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:8080',
//  headers: { 'Content-Type': 'application/json' },
//});

/** Upload a Base64 image to the backend, which stores it on GCS. */
export async function uploadImage(base64Str: string, filename: string = 'selfie.jpg') {
  const { data } = await API.post<{ gcs_uri: string; public_url: string }>(
    '/api/v1/upload',
    { image_base64: base64Str, filename },
  );
  return data;
}

/** Ask the backend to start a sticker generation job. */
export async function startGeneration(
  userId: string,
  gcsUri: string,
  style: string,
  prompt: string,
  lockedIndices: number[] = [],
) {
  const { data } = await API.post<{
    job_id?: string;
    status: string;
    sticker_count?: number;
    result_urls?: string[];
    result_slots?: Array<{ index: number; url: string; locked: boolean }>;
  }>(
    '/api/v1/jobs/generate',
    { user_id: userId, image_uri: gcsUri, style, prompt, locked_indices: lockedIndices },
  );
  return data;
}

/** Poll the backend for the status of a generation job. */
export async function checkJobStatus(jobId: string) {
  const { data } = await API.get<{
    status: string;
    job_id?: string;
    sticker_count?: number;
    result_slots?: Array<{ index: number; url: string; locked: boolean }>;
    error?: string;
  }>(
    `/api/v1/jobs/${jobId}`,
  );
  return data;
}

/** Sync LINE user profile with the backend. */
export async function syncUser(lineProfile: {
  line_id: string;
  display_name: string;
  picture_url?: string;
}) {
  const { data } = await API.post('/api/v1/auth/sync', lineProfile);
  return data;
}

export async function createPayment(userId: string, packageId: string) {
  const { data } = await API.post<{
    payment_link_id: string;
    status: string;
    provider_status: string;
    amount_satang: number;
    coins: number;
    checkout_url: string;
    expires_at?: string | null;
  }>('/api/v1/payments/create', {
    user_id: userId,
    package_id: packageId,
  });
  return data;
}

export async function getPaymentStatus(chargeId: string) {
  const { data } = await API.get<{
    payment_link_id: string;
    status: string;
    provider_status: string;
    coins: number;
    amount_satang: number;
    checkout_url?: string | null;
    expires_at?: string | null;
  }>(`/api/v1/payments/status?payment_link_id=${encodeURIComponent(chargeId)}`);
  return data;
}

export async function getCurrentStickers(userId: string) {
  const { data } = await API.get<{
    status: 'ok' | 'empty';
    job_id?: string | null;
    sticker_count?: number;
    result_slots?: StickerSlotResponse[];
    extra_pick_count?: number;
    extra_picks_unlocked?: boolean;
    extra_picks?: ExtraPickResponse[];
  }>(`/api/v1/jobs/current?user_id=${encodeURIComponent(userId)}`);
  return data;
}
export async function unlockCurrentExtraPicks(userId: string) {
  const { data } = await API.post<{
    status: string;
    job_id?: string | null;
    coin_balance?: number;
    sticker_count?: number;
    result_slots?: StickerSlotResponse[];
    extra_pick_count?: number;
    extra_picks_unlocked?: boolean;
    extra_picks?: ExtraPickResponse[];
  }>('/api/v1/jobs/current/extra-picks/unlock', { user_id: userId });
  return data;
}

export async function applyCurrentExtraPicks(userId: string, selectedIndices: number[]) {
  const { data } = await API.post<{
    status: string;
    job_id?: string | null;
    sticker_count?: number;
    result_slots?: StickerSlotResponse[];
    extra_pick_count?: number;
    extra_picks_unlocked?: boolean;
    extra_picks?: ExtraPickResponse[];
  }>('/api/v1/jobs/current/extra-picks/apply', {
    user_id: userId,
    selected_indices: selectedIndices,
  });
  return data;
}

export async function resetCurrentStickers(userId: string) {
  const { data } = await API.post<{ status: string }>('/api/v1/jobs/reset', { user_id: userId });
  return data;
}

export async function downloadCurrentStickersZip(userId: string) {
  const { data } = await API.get<Blob>(
    `/api/v1/jobs/current/download?user_id=${encodeURIComponent(userId)}`,
    { responseType: 'blob' },
  );
  return data;
}

export async function getCurrentStickersDownloadUrl(userId: string) {
  const { data } = await API.get<{ url: string }>(
    `/api/v1/jobs/current/download-url?user_id=${encodeURIComponent(userId)}`,
  );
  return data;
}

export async function downloadCurrentStickerForShare(userId: string, index: number) {
  const { data } = await API.get<Blob>(
    `/api/v1/jobs/current/share-file?user_id=${encodeURIComponent(userId)}&index=${index}`,
    {
      responseType: 'blob',
      headers: {
        Accept: 'image/png',
        'Cache-Control': 'no-store',
      },
    },
  );
  return data;
}
