import axios from 'axios';

const baseURL = (import.meta as any).env?.VITE_API_BASE_URL;
const API = axios.create({
  baseURL: baseURL ?? 'http://localhost:8080',
  headers: { 'Content-Type': 'application/json' },
});

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
) {
  const { data } = await API.post<{ job_id: string; status: string; result_urls?: string[] }>(
    '/api/v1/jobs/generate',
    { user_id: userId, image_uri: gcsUri, style, prompt },
  );
  return data;
}

/** Poll the backend for the status of a generation job. */
export async function checkJobStatus(jobId: string) {
  const { data } = await API.get<{ status: string; result_urls?: string[] }>(
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
