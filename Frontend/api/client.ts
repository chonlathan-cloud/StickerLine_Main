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

export type PaymentProductId = 'final_pack_199' | 'extra_pack_99';
export type GenerationWarning = {
  level: 'gentle' | 'strong' | 'limit_reached';
  message: string;
  remaining: number;
};
export type GenerationState = {
  cycle_id?: string | null;
  generation_count: number;
  generation_limit: number;
  remaining_attempts: number;
  is_generation_locked: boolean;
  generation_locked_at?: string | null;
  generation_cooldown_until?: string | null;
  final_pack_paid: boolean;
  final_pack_exported: boolean;
  extra_pack_paid: boolean;
  extra_pack_exported: boolean;
  extra_pack_selected_ids?: string[];
  extra_vault_expires_at?: string | null;
  warning?: GenerationWarning | null;
};
export type StickerSlotResponse = { index: number; url: string; locked: boolean };
export type ExtraPickResponse = { index: number; url: string | null; preview_url?: string | null };
export type ExtraVaultItemResponse = {
  id: string;
  source_job_id?: string | null;
  replaced_from_slot?: number | null;
  url: string | null;
  created_at?: string | null;
};

export const PENDING_PAYMENT_ID_KEY = 'beam_pending_payment_link_id';
export const PENDING_CHECKOUT_URL_KEY = 'beam_pending_checkout_url';
export const PENDING_PRODUCT_ID_KEY = 'beam_pending_product_id';
export const PENDING_EXPIRES_AT_KEY = 'beam_pending_expires_at';
export const PENDING_SELECTED_EXTRA_IDS_KEY = 'beam_pending_selected_extra_ids';

export const persistPendingPayment = (
  paymentLinkId: string,
  checkoutUrl: string,
  productId: PaymentProductId,
  expiresAt?: string | null,
  selectedExtraIds: string[] = [],
) => {
  try {
    localStorage.setItem(PENDING_PAYMENT_ID_KEY, paymentLinkId);
    localStorage.setItem(PENDING_CHECKOUT_URL_KEY, checkoutUrl);
    localStorage.setItem(PENDING_PRODUCT_ID_KEY, productId);
    localStorage.setItem(PENDING_SELECTED_EXTRA_IDS_KEY, JSON.stringify(selectedExtraIds));
    if (expiresAt) {
      localStorage.setItem(PENDING_EXPIRES_AT_KEY, expiresAt);
    } else {
      localStorage.removeItem(PENDING_EXPIRES_AT_KEY);
    }
  } catch {
    // ignore browser storage failures
  }
};

export const clearPendingPayment = () => {
  try {
    localStorage.removeItem(PENDING_PAYMENT_ID_KEY);
    localStorage.removeItem(PENDING_CHECKOUT_URL_KEY);
    localStorage.removeItem(PENDING_PRODUCT_ID_KEY);
    localStorage.removeItem(PENDING_EXPIRES_AT_KEY);
    localStorage.removeItem(PENDING_SELECTED_EXTRA_IDS_KEY);
  } catch {
    // ignore browser storage failures
  }
};

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
    generation_state?: GenerationState;
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
    generation_state?: GenerationState;
    extra_vault_item_count?: number;
    error?: string;
    error_code?: string;
    retry_after_seconds?: number;
    attempt_refunded?: boolean;
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

export async function createPayment(
  userId: string,
  productId: PaymentProductId,
  options: {
    cycleId?: string | null;
    selectedExtraIds?: string[];
  } = {},
) {
  const { data } = await API.post<{
    payment_link_id: string;
    status: string;
    provider_status: string;
    product_id: PaymentProductId;
    cycle_id?: string | null;
    amount_satang: number;
    checkout_url: string;
    selected_extra_ids?: string[];
    expires_at?: string | null;
  }>('/api/v1/payments/create', {
    user_id: userId,
    product_id: productId,
    cycle_id: options.cycleId,
    selected_extra_ids: options.selectedExtraIds,
  });
  return data;
}

export async function getPaymentStatus(chargeId: string) {
  const { data } = await API.get<{
    payment_link_id: string;
    status: string;
    provider_status: string;
    product_id?: PaymentProductId | null;
    cycle_id?: string | null;
    amount_satang: number;
    checkout_url?: string | null;
    selected_extra_ids?: string[];
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
    generation_state?: GenerationState;
    extra_vault_count?: number;
    extra_vault?: ExtraVaultItemResponse[];
    extra_pick_count?: number;
    extra_picks_unlocked?: boolean;
    extra_picks?: ExtraPickResponse[];
  }>(`/api/v1/jobs/current?user_id=${encodeURIComponent(userId)}`);
  return data;
}

export async function finalizeCurrentStickerExport(userId: string) {
  const { data } = await API.post<{
    status: string;
    generation_state: GenerationState;
    extra_vault_count: number;
    extra_vault: ExtraVaultItemResponse[];
  }>('/api/v1/jobs/current/finalize-export', { user_id: userId });
  return data;
}

export async function getCurrentExtraVault(userId: string) {
  const { data } = await API.get<{
    status: string;
    generation_state: GenerationState;
    extra_vault_expired: boolean;
    extra_vault_count: number;
    extra_vault: ExtraVaultItemResponse[];
  }>(`/api/v1/jobs/current/extra-vault?user_id=${encodeURIComponent(userId)}`);
  return data;
}

export async function getExtraVaultDownloadUrl(userId: string, selectedExtraIds: string[]) {
  const { data } = await API.post<{
    status: string;
    url: string;
    selected_extra_ids: string[];
    generation_state: GenerationState;
  }>('/api/v1/jobs/current/extra-vault/download-url', {
    user_id: userId,
    selected_extra_ids: selectedExtraIds,
  });
  return data;
}

export async function finalizeExtraVaultExport(userId: string) {
  const { data } = await API.post<{
    status: string;
    generation_state: GenerationState;
  }>('/api/v1/jobs/current/extra-vault/finalize-export', { user_id: userId });
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

export async function downloadExtraVaultStickerForShare(userId: string, extraId: string) {
  const { data } = await API.get<Blob>(
    `/api/v1/jobs/current/extra-vault/share-file?user_id=${encodeURIComponent(userId)}&extra_id=${encodeURIComponent(extraId)}`,
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
