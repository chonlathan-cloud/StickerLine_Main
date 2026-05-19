# Low-Level Design (LLD)

**System:** Mia-U-Sticker / StickerLine AI
**Current implementation:** `backend/app` + `Frontend`

This document maps production behavior to modules, functions, fields, and control
flow so implementation changes can be made without guessing.

## 1. Repository Structure

```text
/backend
├── Dockerfile
├── requirements.txt
└── app
    ├── main.py
    ├── core
    │   └── config.py
    ├── api
    │   ├── deps.py
    │   └── v1
    │       ├── auth.py
    │       ├── upload.py
    │       ├── stickers.py
    │       ├── payments.py
    │       ├── webhooks.py
    │       └── users.py
    ├── models
    │   ├── user.py
    │   └── sticker.py
    ├── services
    │   ├── user_service.py
    │   ├── ai_service.py
    │   ├── image_service.py
    │   └── payment_service.py
    └── utils
        ├── firestore.py
        └── storage.py

/Frontend
├── App.tsx
├── api/client.ts
├── providers/AuthProvider.tsx
├── pages
│   ├── LoginPage.tsx
│   ├── GeneratePage.tsx
│   └── PaymentPage.tsx
└── types.ts
```

## 2. Backend Entry Point

### `backend/app/main.py`

- Creates the FastAPI app.
- Adds permissive CORS (`allow_origins = ["*"]`) in current code.
- Registers routers:
  - `/api/v1/auth`
  - `/api/v1/users`
  - `/api/v1/jobs`
  - `/api/v1`
  - `/api/v1/payments`
  - `/webhooks`
- Root health check returns:

```json
{ "status": "ok", "service": "stickerline-api" }
```

## 3. Configuration

### `Settings` in `backend/app/core/config.py`

Important fields:

- GCP: `PROJECT_ID`, `GCS_BUCKET_NAME`
- LINE: `LIFF_CHANNEL_ID`, `LINE_CHANNEL_SECRET`
- Beam: `BEAM_BASE_URL`, `BEAM_MERCHANT_ID`, `BEAM_API_KEY`,
  `BEAM_WEBHOOK_HMAC_KEY`, `PAYMENT_REDIRECT_URL`
- AI: `VERTEX_MODEL`, `VERTEX_LOCATION`, `GENAI_PROVIDER`, `GEMINI_API_KEY`,
  `GENAI_FALLBACK_PROVIDER`
- Generation controls: `GENERATION_CONCURRENCY`,
  `GENERATION_COOLDOWN_SECONDS`, `GENERATION_MAX_RETRIES`,
  `GENERATION_RETRY_BASE_DELAY`

The backend loads `.env` during local development and ignores extra environment
variables.

## 4. Auth Layer

### `get_line_profile(authorization)`

Location: `backend/app/api/deps.py`

Algorithm:

1. Require `Authorization` header beginning with `Bearer `.
2. Extract LIFF access token.
3. Return cached profile if token cache is fresh.
4. Call `https://api.line.me/v2/profile`.
5. Retry timeout/request failures according to config.
6. If LINE is unavailable but token cache is in grace period, return cached
   profile.
7. Require `userId` and `displayName`.
8. Normalize to:

```python
{
    "line_id": data["userId"],
    "display_name": data["displayName"],
    "picture_url": data.get("pictureUrl"),
}
```

### `assert_user_match(token_line_id, user_id)`

Raises `403` if the verified token user does not match the route/request user.
All user-owned endpoints use this check.

## 5. Data Models

### `UserCreate`

Location: `backend/app/models/user.py`

```python
class UserCreate(BaseModel):
    line_id: str
    display_name: str
    picture_url: Optional[str] = None
```

### `UserInDB`

The current schema keeps legacy fields (`coin_balance`, `total_spent_thb`,
`is_free_trial_used`) but initializes active users for pay-on-save:

- `coin_balance = 0`
- `is_free_trial_used = False`
- `generation_limit = 20`
- active cycle and export/payment fields default to empty/null.

### `StickerGenerateRequest`

Location: `backend/app/models/sticker.py`

```python
class StickerGenerateRequest(BaseModel):
    user_id: str
    image_uri: str
    style: str
    prompt: str
    locked_indices: list[int] = []
```

## 6. User Service

Location: `backend/app/services/user_service.py`

### Constants

```python
GENERATION_LIMIT = 20
WARNING_START_ATTEMPT = 15
FINAL_PACK_PRODUCT_ID = "final_pack_199"
EXTRA_PACK_PRODUCT_ID = "extra_pack_99"
EXTRA_VAULT_TTL_HOURS = 24
```

### Exceptions

- `GenerationLimitReachedError(state)`
- `FinalPackPaymentRequiredError(state)`
- `ExtraPackPaymentRequiredError(state)`

### `_build_warning(generation_count, generation_limit)`

Returns:

- `None` for 1-14.
- `gentle` for 15-17.
- `strong` for 18-19.
- `limit_reached` for 20+.

Each warning includes `level`, Thai `message`, and `remaining`.

### `_build_generation_state(data)`

Returns frontend-safe normalized state:

```python
{
    "cycle_id": data.get("current_cycle_id"),
    "generation_count": generation_count,
    "generation_limit": generation_limit,
    "remaining_attempts": remaining,
    "is_generation_locked": bool(locked_at and not final_paid_at and remaining == 0),
    "generation_locked_at": locked_at,
    "generation_cooldown_until": cooldown_until,
    "final_pack_paid": bool(final_paid_at),
    "final_pack_exported": bool(final_exported_at),
    "extra_pack_paid": bool(extra_pack_paid_at),
    "extra_pack_exported": bool(extra_pack_exported_at),
    "extra_pack_selected_ids": data.get("extra_pack_selected_ids") or [],
    "extra_vault_expires_at": data.get("extra_vault_expires_at"),
    "warning": self._build_warning(generation_count, generation_limit),
}
```

### `_cycle_reset_update(now)`

Creates a new `current_cycle_id` and resets:

- generation count/lock/cooldown
- current stickers
- Extra Vault
- final/extra paid/exported fields
- final/extra payment link fields
- legacy current extra-pick fields

### `sync_user(line_profile)`

New user behavior:

- Creates `users/{line_id}`.
- Sets zero coins and a fresh active cycle.

Existing user behavior:

- Updates display name and profile image.
- Adds missing cycle fields for old documents without overwriting existing active
  cycle values.

### `get_cycle_state(user_id)`

- Loads user.
- Adds defaults for old records.
- If `generation_cooldown_until <= now` and final pack is unpaid, resets cycle.
- Returns `_build_generation_state`.

### `prepare_generation_attempt(user_id)`

Firestore transaction:

1. Load user and defaults.
2. Reset if final pack already exported.
3. Reset if unpaid cooldown expired.
4. If final pack paid but not exported, raise `GenerationLimitReachedError`.
5. If generation count already reached limit and final pack unpaid:
   - ensure lock/cooldown fields exist.
   - raise `GenerationLimitReachedError`.
6. Increment `generation_count`.
7. If increment reaches 20, set lock/cooldown.
8. Commit and return generation state.

### `set_current_generation_state(user_id, slots, job_id, extra_picks, extra_picks_unlocked=False)`

Firestore transaction:

- Appends new replaced stickers to existing `extra_vault`.
- Updates `current_stickers`, `current_stickers_job_id`,
  `current_stickers_updated_at`.
- Mirrors `extra_vault` into legacy `current_extra_picks` fields for
  compatibility.

### `require_final_pack_paid(user_id)`

Raises `FinalPackPaymentRequiredError` unless `final_pack_paid` is true.

### `mark_final_pack_exported(user_id)`

Firestore transaction:

- Requires `final_pack_paid_at`.
- Sets `final_pack_exported_at = now`.
- Sets `extra_vault_expires_at = now + 24h`.
- Sets purchase `exported_at` when `final_pack_payment_link_id` exists.
- Returns generation state and `extra_vault`.

### `get_extra_vault(user_id)`

- If vault expired, returns empty vault with `extra_vault_expired = true`.
- If final pack not exported, returns empty vault.
- Otherwise returns `extra_vault`.

### `require_extra_pack_paid(user_id)`

- Calls `get_extra_vault`.
- Requires `extra_pack_paid`.
- Rejects expired vault.

### `mark_extra_pack_exported(user_id)`

Firestore transaction:

- Requires `extra_pack_paid_at`.
- Sets `extra_pack_exported_at`.
- Sets purchase `exported_at` when `extra_pack_payment_link_id` exists.

## 7. Sticker API

Location: `backend/app/api/v1/stickers.py`

### Module State

```python
TARGET_STICKER_COUNT = 16
ALLOWED_STICKER_COUNTS = {16}
GENERATION_SEMAPHORE = asyncio.Semaphore(settings.GENERATION_CONCURRENCY)
USER_COOLDOWN = {}
```

The semaphore limits concurrent AI/image jobs per process. `USER_COOLDOWN`
adds a short in-memory delay between user jobs.

### `_process_job(job_id, request, ...)`

Control flow:

1. Set job `queued`.
2. Apply short in-memory user cooldown.
3. Acquire generation semaphore.
4. Set job `processing`.
5. Generate up to three AI candidates.
6. For each candidate:
   - process grid into PNG stickers.
   - calculate quality warnings:
     - layout mismatch
     - edge touch risk
     - detached artifact risk
     - residual green-screen risk
     - subject scale inconsistency
   - keep the lowest risk candidate.
7. Require exactly 16 stickers.
8. Upload raw grid as `users/{user_id}/jobs/{job_id}/grid.png`.
9. Upload stickers as `users/{user_id}/jobs/{job_id}/{index}.png`.
10. Merge locked slots:
    - if index is locked and previous slot exists, reuse previous blob.
    - otherwise use newly uploaded blob.
11. For every replaced previous blob, create Extra Vault item:

```python
{
    "id": f"{job_id}-{index}-{uuid.uuid4().hex[:8]}",
    "source_job_id": previous_source_job_id,
    "replaced_by_job_id": job_id,
    "replaced_from_slot": index,
    "blob_name": previous_blob,
    "created_at": now,
}
```

12. Persist current slots and Extra Vault through `UserService`.
13. Set job `completed`.
14. On any exception, set job `failed` with `error`.

Current behavior note: generation attempts are not refunded/decremented if the
async job later fails.

### Main route handlers

| Route | Handler | Notes |
| --- | --- | --- |
| `POST /generate` | `generate_stickers` | Reserves attempt, creates job, starts background task |
| `GET /{job_id}` | `get_job_status` | Returns signed URLs for completed job slots |
| `GET /current` | `get_current_stickers` | Returns current slots, generation state, Extra Vault summary |
| `POST /reset` | `reset_current_stickers` | Resets the active cycle |
| `GET /current/share-file` | `get_current_sticker_share_file` | Streams one final PNG; requires final payment |
| `GET /current/download-url` | `get_current_sticker_download_url` | Creates ZIP in GCS; requires final payment |
| `GET /current/download` | `download_current_sticker_zip` | Streams ZIP; compatibility path |
| `POST /current/finalize-export` | `finalize_current_final_pack_export` | Marks final export and exposes Extra Vault URLs |
| `GET /current/extra-vault` | `get_current_extra_vault` | Hides URLs before final export/after expiry |
| `GET /current/extra-vault/share-file` | `get_current_extra_vault_share_file` | Streams one paid selected extra PNG |
| `POST /current/extra-vault/download-url` | `get_current_extra_vault_download_url` | Creates ZIP for paid selected extras |
| `POST /current/extra-vault/finalize-export` | `finalize_current_extra_vault_export` | Marks extra export |
| `POST /current/extra-picks/unlock` | `unlock_current_extra_picks` | Removed; returns `410 Gone` |
| `POST /current/extra-picks/apply` | `apply_current_extra_picks` | Removed; returns `410 Gone` |

### `_select_extra_vault_items(extra_vault, selected_extra_ids)`

Rules:

- Trims IDs and removes duplicates.
- Requires at least one ID.
- Allows at most 16 IDs.
- Requires every ID to exist in the current Extra Vault.
- Returns selected items in requested order.

## 8. Upload API

Location: `backend/app/api/v1/upload.py`

### `_decode_base64_image(data)`

- Strips `data:image/...;base64,` prefix if present.
- Base64 decodes.
- Raises `400` on invalid data.

### `upload_image(request)`

- Requires valid LINE token.
- Validates image magic bytes:
  - JPEG: `0xff 0xd8`
  - PNG: `0x89PNG`
  - WEBP: `RIFF`
- Uploads to `temp/uploads/{uuid}/{filename}`.
- Returns `gcs_uri` and signed `public_url`.

## 9. Payment Service

Location: `backend/app/services/payment_service.py`

### Products

```python
{
    "final_pack_199": {
        "amount_satang": 19900,
        "title": "Final Sticker Pack",
        "description": "Save final 16 stickers",
    },
    "extra_pack_99": {
        "amount_satang": 9900,
        "title": "Extra Sticker Pack",
        "description": "Save up to 16 selected extra stickers",
    },
}
```

### `create_payment_link(user_id, product_id, cycle_id=None, selected_extra_ids=None)`

Validation:

- Beam merchant ID, API key, and redirect URL must be configured.
- User must exist.
- Cycle ID resolves from request or user `current_cycle_id`.
- Final pack:
  - not already paid.
  - current stickers exist.
  - locked expired unpaid cycle cannot be paid.
- Extra pack:
  - not already paid.
  - final pack exported.
  - vault not expired.
  - vault not empty.
  - selected IDs count is 1-16.
  - selected IDs all exist.

Beam payload:

- `collectDeliveryAddress = false`
- link settings from feature flags (`card`, `qrPromptPay`, `mobileBanking`, etc.)
- order currency from `PAYMENT_CURRENCY`
- `netAmount` in satang
- `referenceId = "{user}:{product}:{cycle}:{random}"`
- `redirectUrl` appends `beam_return=1`
- `expiresAt = now + PAYMENT_LINK_EXPIRY_MINUTES`

Persists `payments/{payment_link_id}` and returns checkout metadata.

### `verify_signature(payload_bytes, signature)`

- Decodes `BEAM_WEBHOOK_HMAC_KEY` from base64.
- Computes HMAC-SHA256 over raw payload.
- Compares base64 digest with `X-Beam-Signature`.

### `process_webhook(payload, event, signature, raw_payload)`

- Rejects invalid signature.
- `payment_link.paid`: applies payment payload directly.
- `charge.succeeded` with `source = PAYMENT_LINK`: fetches Beam payment link and
  applies status.
- Other events are logged and ignored.

### `get_payment_status(payment_link_id)`

- Loads local payment document.
- If status is not `success`, fetches Beam state and applies it.
- Returns status, product, cycle, amount, checkout URL, selected extras, expiry,
  and internal `user_id` for API ownership check.

### `_record_payment_success(payment_link_id, paid_payload, source)`

Firestore transaction:

1. Load payment.
2. If `processed_at` exists, return.
3. Check received amount equals expected amount.
4. Load user.
5. Validate supported product ID.
6. Increment `total_spent_thb` for reporting.
7. Set final or extra paid fields on user.
8. Create `purchases/purchase_{payment_link_id}`.
9. Set payment `status = success`, `provider_status = PAID`,
   `paid_at`, `processed_at`, and `updated_at`.

## 10. AI Service

Location: `backend/app/services/ai_service.py`

### Style mapping

- `Chibi 2D`, `chibi_2d`, `2d` -> premium 2D chibi prompt.
- `Pixar 3D`, `pixar_3d`, `3d` -> cute premium 3D prompt.
- Unsupported style raises `ValueError`.

### Caption handling

- If prompt contains no-text intent (`no text`, `ไม่มีข้อความ`, etc.), AI is
  instructed to generate without captions.
- If quoted captions exist, use them exactly and in order when possible.
- If custom prompt exists, derive captions from user theme.
- Otherwise use default Thai chat captions.

### Provider behavior

- `GENAI_PROVIDER=vertex`: initializes Vertex AI and `GenerativeModel`.
- `GENAI_PROVIDER=gemini_api`/aliases: uses Gemini API with inline base64 image.
- `GENAI_PROVIDER=auto`: uses Gemini API if `GEMINI_API_KEY` exists, otherwise
  Vertex.
- Retryable Vertex failures may fall back to Gemini API when configured.
- User-facing retry exhaustion message:
  `ระบบหนาแน่น กรุณารอ 5 นาที แล้วลองใหม่`

## 11. Image Processor

Location: `backend/app/services/image_service.py`

### Supported layout

- Target: 4 columns x 4 rows.
- Raw sheet must be approximately square:
  - min aspect ratio `0.88`
  - max aspect ratio `1.14`
- Detects and rejects likely unsupported layouts such as 4x5, 5x4, 5x5, 3x5,
  5x3, 4x3, and 3x4.

### `process_sticker_grid(image_bytes, columns=None, rows=None)`

1. Decode bytes to OpenCV image.
2. Trim solid green margin.
3. Validate raw grid when layout override is not provided.
4. Resolve grid edges.
5. For each cell:
   - crop with small overscan.
   - build core anchor alpha.
   - apply safe inset.
   - process a single sticker.
6. Return list of PNG bytes.

### `_process_single_sticker(cv_img, core_bounds, anchor_alpha)`

1. Extract foreground RGBA from green-screen cell.
2. Filter foreground components using core bounds/anchor alpha.
3. Clean top-strip artifacts, pure green pockets, caption baseline fringe,
   detached artifacts, and residual green-screen pixels.
4. Crop content with asymmetric padding to preserve Thai text.
5. Add a thin white stroke.
6. Resize and center on a 370x320 transparent canvas with padding.
7. Encode PNG.

### Quality assessments

The generation orchestrator calls:

- `assess_sticker_set_edge_risk`
- `assess_sticker_set_artifact_risk`
- `assess_sticker_set_residual_screen_risk`
- `assess_subject_scale_consistency`

These warnings are stored on the job but do not necessarily fail the job if the
best candidate is still a valid 16-sticker set.

## 12. Storage Client

Location: `backend/app/utils/storage.py`

### `upload_file`

- Uploads bytes to GCS.
- Returns a V4 signed URL valid for 1 hour.
- Supports response disposition/type overrides for ZIP downloads.

### `generate_signed_url`

- Generates a signed URL for an existing blob.
- Uses IAM signer with refreshed default credentials when service account email
  is available, otherwise falls back to default blob signing.

### `download_gcs_uri`

- Validates `gs://bucket/path`.
- Downloads bytes from GCS.

## 13. Frontend Control Flow

### Auth

`AuthProvider`:

1. Requires `VITE_LIFF_ID`.
2. Calls `liff.init`.
3. If logged in, stores `line_access_token`.
4. Calls `syncUser`.
5. Sets `profile`.

### Generate page state

Key state:

- `config.base64Image`
- `config.style`
- `config.extraPrompt`
- `stickerSlots`
- `extraSlots`
- `selectedExtraIds`
- `generationState`
- `checkoutProduct`
- `isCreatingPayment`
- `isSavingFinal`
- `isExtraExporting`

View state:

```ts
checkoutProduct ? "checkout"
: finalPackExported && extraPackExported ? "done"
: finalPackPaid ? "success"
: "workspace"
```

### Generate/regenerate

`generateSheet()`:

1. Requires online status, profile, and base image.
2. If current grid exists, requires at least one unlocked sticker.
3. Uploads base image.
4. Builds `locked_indices` from locked slots.
5. Starts generation job.
6. Polls job every 2 seconds up to 180 attempts.
7. Refreshes current stickers.
8. Shows warning modal for non-limit warnings.
9. Displays generation limit/cooldown errors from backend state.

### Final save

`handleSaveFinalPack()`:

- If final pack is unpaid, opens checkout for `final_pack_199`.
- If paid, calls `saveFinalPackToDevice(true)`.

`saveFinalPackToDevice(finalizeAfterSave)`:

- On Android inside LIFF, redirects to external browser with `saveToPhotos=1`.
- If native file share is available, downloads individual PNG blobs and calls
  `navigator.share({ files })`.
- Otherwise requests `current/download-url` and opens the ZIP signed URL.
- Calls `finalizeCurrentStickerExport` after the save/share/download flow when
  `finalizeAfterSave` is true.

### Extra Vault

- Final export response populates `extraSlots` and preselects first 16.
- Selection is limited to 16 in frontend and backend.
- `handleBuyExtraPack()` requires at least one selected extra and creates
  `extra_pack_99` Beam payment.
- `saveExtraVaultToDevice()` uses native file share when available, otherwise
  creates a ZIP via `extra-vault/download-url`.
- Extra export finalize is called after save/share/download.

### Payment page

`PaymentPage`:

- Reads payment ID from URL query or local storage.
- Reads product/checkout/expiry from local storage.
- On Beam return (`beam_return=1`), calls backend payment status endpoint.
- On success, clears pending payment, refreshes profile, and returns to
  `/generate`.

## 14. Legacy Code Paths

- `coin_balance`, `is_free_trial_used`, and `total_spent_thb` are retained in
  models and user documents for compatibility/history.
- The current production flow does not deduct coins, grant free coins, or sell
  coin packages.
- `GET /api/v1/users/{user_id}/permissions` still checks
  `total_spent_thb >= 30`; this is legacy and should not be used for new export
  authorization.
- `/current/extra-picks/unlock` and `/current/extra-picks/apply` intentionally
  return `410 Gone`.

## 15. Failure and Edge Cases

- LINE timeout can use cached profile only within grace window.
- Beam link creation fails fast when Beam config is incomplete.
- Invalid Beam webhook signatures are rejected with `403`.
- Payment amount mismatch fails payment processing.
- Attempt reservation happens before async generation; failed jobs still count
  against the cycle in current production.
- Extra Vault expiry returns empty vault instead of physically deleting old blobs.
- Download/share endpoints fail with `402 payment_required` when entitlement is
  missing.
- Current code supports only 16 processed stickers even though the frontend has a
  defensive local allowance for 15/16 in some display paths.
