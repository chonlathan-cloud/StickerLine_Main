# Technical Design Document (TDD)

**Project:** Mia-U-Sticker / StickerLine AI
**Production stack:** React + Vite + LIFF, FastAPI on Cloud Run, Firestore, Cloud
Storage, Vertex AI/Gemini API, Beam Checkout

## 1. Current System Components

| Component | Module / Location | Responsibility |
| --- | --- | --- |
| Frontend API client | `Frontend/api/client.ts` | Adds LIFF Bearer token, calls backend endpoints, stores pending Beam payment metadata |
| Auth provider | `Frontend/providers/AuthProvider.tsx` | Initializes LIFF, stores access token, syncs verified LINE user profile |
| Generate page | `Frontend/pages/GeneratePage.tsx` | Upload, generate, locked-slot regeneration, payment entry, native share/ZIP export, Extra Vault |
| Payment page | `Frontend/pages/PaymentPage.tsx` | Reads Beam return/pending payment state, polls backend payment status, routes user back to generation |
| FastAPI app | `backend/app/main.py` | API composition, CORS, route registration |
| Auth dependency | `backend/app/api/deps.py` | Verifies LINE access token and enforces user-id match |
| User service | `backend/app/services/user_service.py` | User sync, cycle state, generation attempt limit, export entitlement state |
| Sticker API | `backend/app/api/v1/stickers.py` | Generate jobs, current stickers, downloads/share files, final/extra export finalize |
| AI service | `backend/app/services/ai_service.py` | Prompt building, Vertex/Gemini API image generation, retry/fallback logic |
| Image processor | `backend/app/services/image_service.py` | 4x4 validation, chroma-key cleanup, slicing, stroke, output PNG normalization |
| Payment service | `backend/app/services/payment_service.py` | Beam link creation, webhook signature verification, status polling, purchases |
| Storage client | `backend/app/utils/storage.py` | GCS upload/download/list and signed URL generation |

## 2. API Specification

Base path is backend host plus the route below. User-scoped routes require:

```http
Authorization: Bearer <LIFF_ACCESS_TOKEN>
Content-Type: application/json
```

### 2.1 Auth

#### `POST /api/v1/auth/sync`

Request:

```json
{
  "line_id": "Uxxxxxxxx",
  "display_name": "Somchai",
  "picture_url": "https://..."
}
```

Backend ignores untrusted identity fields after token verification and uses the
LINE profile returned by LINE Profile API.

Response includes the user document plus:

```json
{
  "generation_state": {
    "cycle_id": "cycle_uuid",
    "generation_count": 0,
    "generation_limit": 20,
    "remaining_attempts": 20,
    "is_generation_locked": false,
    "final_pack_paid": false,
    "final_pack_exported": false,
    "extra_pack_paid": false,
    "extra_pack_exported": false,
    "extra_pack_selected_ids": [],
    "extra_vault_expires_at": null,
    "warning": null
  }
}
```

### 2.2 Upload

#### `POST /api/v1/upload`

Request:

```json
{
  "image_base64": "data:image/jpeg;base64,...",
  "filename": "selfie_123.jpg"
}
```

Response:

```json
{
  "gcs_uri": "gs://bucket/temp/uploads/<uuid>/selfie_123.jpg",
  "public_url": "https://storage.googleapis.com/..."
}
```

Validation:

- Accepts JPEG, PNG, and WEBP magic bytes.
- Stores under `temp/uploads/{uuid}/{filename}`.
- Returns `400` for invalid base64 or unsupported image bytes.

### 2.3 Generation

#### `POST /api/v1/jobs/generate`

Request:

```json
{
  "user_id": "Uxxxxxxxx",
  "image_uri": "gs://bucket/temp/uploads/.../selfie.jpg",
  "style": "Pixar 3D",
  "prompt": "Thai chat captions, office mood",
  "locked_indices": [0, 3, 7]
}
```

Response:

```json
{
  "job_id": "job_uuid",
  "status": "queued",
  "generation_state": {
    "cycle_id": "cycle_uuid",
    "generation_count": 12,
    "generation_limit": 20,
    "remaining_attempts": 8,
    "is_generation_locked": false,
    "warning": null
  }
}
```

Errors:

- `400` for invalid state or missing user.
- `401` for missing/invalid LINE token.
- `403` for token/user mismatch.
- `429` with detail:

```json
{
  "error_code": "generation_limit_reached",
  "product_id": "final_pack_199",
  "generation_state": {}
}
```

#### `GET /api/v1/jobs/{job_id}`

Queued/processing response:

```json
{
  "status": "processing",
  "job_id": "job_uuid",
  "generation_state": {}
}
```

Completed response:

```json
{
  "status": "completed",
  "job_id": "job_uuid",
  "sticker_count": 16,
  "result_slots": [
    { "index": 0, "url": "https://signed-url", "locked": false }
  ],
  "generation_state": {},
  "extra_vault_item_count": 4,
  "grid_url": "https://signed-url"
}
```

Failed response:

```json
{
  "status": "failed",
  "job_id": "job_uuid",
  "error": "Generation failed",
  "generation_state": {},
  "grid_url": "https://signed-url"
}
```

### 2.4 Current Stickers and Reset

#### `GET /api/v1/jobs/current?user_id=<line_id>`

Response when empty:

```json
{
  "status": "empty",
  "job_id": null,
  "sticker_count": 0,
  "result_slots": [],
  "generation_state": {},
  "extra_vault_count": 0,
  "extra_vault": [],
  "extra_picks_unlocked": false,
  "extra_picks": []
}
```

Response when stickers exist:

```json
{
  "status": "ok",
  "job_id": "job_uuid",
  "sticker_count": 16,
  "result_slots": [
    { "index": 0, "url": "https://signed-url", "locked": true }
  ],
  "generation_state": {},
  "extra_vault_count": 3,
  "extra_vault": [
    {
      "id": "extra_id",
      "source_job_id": "old_job",
      "replaced_from_slot": 5,
      "url": null,
      "created_at": "timestamp"
    }
  ],
  "extra_picks_unlocked": false,
  "extra_picks": []
}
```

Extra Vault item URLs are `null` until final pack export is complete and the
vault has not expired.

#### `POST /api/v1/jobs/reset`

Request:

```json
{ "user_id": "Uxxxxxxxx" }
```

Response:

```json
{ "status": "ok" }
```

### 2.5 Final Pack Export

All final export routes require `final_pack_paid_at`.

#### `GET /api/v1/jobs/current/share-file?user_id=<line_id>&index=0`

Streams a single PNG for native share/save flows.

#### `GET /api/v1/jobs/current/download-url?user_id=<line_id>`

Builds a ZIP in GCS and returns:

```json
{ "url": "https://signed-url" }
```

#### `GET /api/v1/jobs/current/download?user_id=<line_id>`

Streams a ZIP response. This exists for compatibility; the frontend uses
`download-url` for mobile friendliness.

#### `POST /api/v1/jobs/current/finalize-export`

Request:

```json
{ "user_id": "Uxxxxxxxx" }
```

Response:

```json
{
  "status": "ok",
  "generation_state": {
    "final_pack_paid": true,
    "final_pack_exported": true,
    "extra_vault_expires_at": "timestamp"
  },
  "extra_vault_count": 3,
  "extra_vault": [
    { "id": "extra_id", "url": "https://signed-url" }
  ]
}
```

If unpaid, these routes return `402`:

```json
{
  "error_code": "payment_required",
  "product_id": "final_pack_199",
  "generation_state": {}
}
```

### 2.6 Extra Vault

#### `GET /api/v1/jobs/current/extra-vault?user_id=<line_id>`

Response:

```json
{
  "status": "ok",
  "generation_state": {},
  "extra_vault_expired": false,
  "extra_vault_count": 3,
  "extra_vault": [
    { "id": "extra_id", "url": "https://signed-url" }
  ]
}
```

#### `GET /api/v1/jobs/current/extra-vault/share-file?user_id=<line_id>&extra_id=<id>`

Streams one paid selected extra PNG. If the paid product has
`extra_pack_selected_ids`, only those IDs are allowed.

#### `POST /api/v1/jobs/current/extra-vault/download-url`

Request:

```json
{
  "user_id": "Uxxxxxxxx",
  "selected_extra_ids": ["extra_1", "extra_2"]
}
```

Response:

```json
{
  "status": "ok",
  "url": "https://signed-url",
  "selected_extra_ids": ["extra_1", "extra_2"],
  "generation_state": {}
}
```

Requires `extra_pack_paid_at`; otherwise returns `402 payment_required` with
`product_id = extra_pack_99`.

#### `POST /api/v1/jobs/current/extra-vault/finalize-export`

Marks extra export complete and updates purchase `exported_at`.

### 2.7 Payments

#### `POST /api/v1/payments/create`

Request:

```json
{
  "user_id": "Uxxxxxxxx",
  "product_id": "final_pack_199",
  "cycle_id": "cycle_uuid",
  "selected_extra_ids": []
}
```

Response:

```json
{
  "payment_link_id": "beam_link_id",
  "status": "pending",
  "provider_status": "ACTIVE",
  "product_id": "final_pack_199",
  "cycle_id": "cycle_uuid",
  "amount_satang": 19900,
  "checkout_url": "https://beamcheckout...",
  "selected_extra_ids": [],
  "expires_at": "timestamp"
}
```

Rules:

- `final_pack_199`: current stickers must exist, final pack must not already be
  paid, and locked expired unpaid cycle cannot be paid.
- `extra_pack_99`: final pack must be exported, vault must not be expired, at
  least one and at most 16 available extra IDs must be selected, and extra pack
  must not already be paid.

#### `GET /api/v1/payments/status?payment_link_id=<id>`

Returns payment status and syncs from Beam when local status is not `success`.

#### `POST /webhooks/beam`

Headers:

```http
X-Beam-Signature: <base64-hmac>
X-Beam-Event: payment_link.paid
```

Behavior:

- Verifies HMAC-SHA256 against raw payload.
- Processes `payment_link.paid`.
- Processes `charge.succeeded` with `source = PAYMENT_LINK` by fetching Beam
  payment link status.
- Ignores unsupported events.
- Idempotency is based on payment document `processed_at`.

## 3. Firestore Schema

### 3.1 `users/{line_id}`

| Field | Type | Purpose |
| --- | --- | --- |
| `line_id` | string | LINE user ID |
| `display_name` | string | LINE display name |
| `picture_url` | string/null | LINE profile image |
| `coin_balance` | number | Legacy compatibility, active flow uses zero coins |
| `total_spent_thb` | number | Reporting/history, not active export gate |
| `is_free_trial_used` | boolean | Legacy compatibility |
| `current_cycle_id` | string | Active sticker cycle |
| `generation_count` | number | Accepted generate/regenerate attempts |
| `generation_limit` | number | Default 20 |
| `generation_locked_at` | timestamp/null | Set at attempt 20 |
| `generation_cooldown_until` | timestamp/null | Lock expiry |
| `current_stickers` | array<object> | Final slot records `{index, blob_name, locked, source_job_id}` |
| `current_stickers_job_id` | string/null | Latest job that wrote current set |
| `current_stickers_updated_at` | timestamp/null | Current slot update time |
| `extra_vault` | array<object> | Replaced sticker records |
| `extra_vault_expires_at` | timestamp/null | 24-hour vault expiry after final export |
| `final_pack_paid_at` | timestamp/null | Final payment entitlement |
| `final_pack_exported_at` | timestamp/null | Final export completed |
| `final_pack_payment_link_id` | string/null | Beam payment link ID |
| `extra_pack_paid_at` | timestamp/null | Extra payment entitlement |
| `extra_pack_exported_at` | timestamp/null | Extra export completed |
| `extra_pack_payment_link_id` | string/null | Beam payment link ID |
| `extra_pack_selected_ids` | array<string> | Paid extra IDs |
| `current_extra_picks*` | mixed | Legacy compatibility for removed Extra Picks flow |
| `created_at` | timestamp | User create time |
| `updated_at` | timestamp | Last update time |

Extra Vault item shape:

```json
{
  "id": "job-index-random",
  "source_job_id": "old_job_id",
  "replaced_by_job_id": "new_job_id",
  "replaced_from_slot": 5,
  "blob_name": "users/U/jobs/job/5.png",
  "created_at": "timestamp"
}
```

### 3.2 `jobs/{job_id}`

| Field | Type | Purpose |
| --- | --- | --- |
| `job_id` | string | UUID |
| `user_id` | string | Owner |
| `cycle_id` | string | Cycle snapshot |
| `status` | string | `queued`, `processing`, `completed`, `failed` |
| `sticker_count` | number/null | Expected 16 when complete |
| `generation_state` | object | State snapshot after attempt reservation |
| `grid_blob` | string/null | Raw grid GCS blob |
| `quality_warnings` | array<object> | Layout/edge/artifact/scale warnings |
| `result_slots` | array<object> | Persisted slot records |
| `extra_vault_items` | array<object> | Items created by this job |
| `extra_vault_item_count` | number | Count of new vault items |
| `error` | string/null | Failure reason |
| `created_at` | timestamp | Create time |
| `updated_at` | timestamp | Last update time |

### 3.3 `payments/{payment_link_id}`

| Field | Type | Purpose |
| --- | --- | --- |
| `payment_link_id` | string | Beam link ID |
| `provider` | string | `beam` |
| `user_id` | string | Owner |
| `cycle_id` | string | Cycle tied to product |
| `product_id` | string | `final_pack_199` or `extra_pack_99` |
| `reference_id` | string | Internal Beam reference |
| `amount_satang` | number | 19900 or 9900 |
| `thb_amount` | number | 199.0 or 99.0 |
| `status` | string | `pending`, `success`, `failed` |
| `provider_status` | string | Beam status |
| `checkout_url` | string | Beam checkout URL |
| `redirect_url` | string | App return URL with `beam_return=1` |
| `selected_extra_ids` | array<string> | Extra selection snapshot |
| `expires_at` | string/timestamp | Beam/payment expiry |
| `created_at` | timestamp | Created |
| `updated_at` | timestamp | Last updated |
| `paid_at` | timestamp/null | Success time |
| `processed_at` | timestamp/null | Idempotency marker |

### 3.4 `purchases/purchase_{payment_link_id}`

| Field | Type | Purpose |
| --- | --- | --- |
| `purchase_id` | string | Document ID |
| `user_id` | string | Owner |
| `cycle_id` | string | Product cycle |
| `product_id` | string | Purchased product |
| `amount_satang` | number | Paid amount |
| `provider` | string | `beam` |
| `payment_link_id` | string | Beam link ID |
| `source` | string | `webhook` or `poll` |
| `selected_extra_ids` | array<string> | Extra selection |
| `purchased_at` | timestamp | Payment processed |
| `exported_at` | timestamp/null | Export finalize time |

## 4. Internal Algorithms

### 4.1 Atomic Generation Attempt

```python
async def prepare_generation_attempt(user_id):
    data = load_user_in_firestore_transaction(user_id)

    if data.final_pack_exported_at:
        reset_cycle()
    elif data.generation_cooldown_until <= now and not data.final_pack_paid_at:
        reset_cycle()

    if data.final_pack_paid_at and not data.final_pack_exported_at:
        raise GenerationLimitReachedError(state)

    if data.generation_count >= data.generation_limit and not data.final_pack_paid_at:
        ensure_lock_and_cooldown()
        raise GenerationLimitReachedError(state)

    data.generation_count += 1
    if data.generation_count >= data.generation_limit:
        data.generation_locked_at = now
        data.generation_cooldown_until = now + 24h

    write_update()
    return build_generation_state(data)
```

### 4.2 Generation Job

```python
async def process_job(job_id, request):
    update_job(status="queued")
    await per_user_short_cooldown(request.user_id)

    async with GENERATION_SEMAPHORE:
        update_job(status="processing")
        best_candidate = None

        for attempt in range(3):
            grid = ai.generate_sticker_grid(
                image_uri=request.image_uri,
                style_id=request.style,
                extra_prompt=request.prompt,
                strict_cell_framing=attempt > 0,
            )
            stickers = image_processor.process_sticker_grid(grid)
            warnings = assess_quality(stickers)
            best_candidate = choose_lowest_risk(best_candidate, grid, stickers, warnings)
            if len(stickers) == 16 and no_warnings(warnings):
                break

        if len(best_candidate.stickers) != 16:
            fail_job()

        upload_grid()
        upload_16_stickers()
        merge_locked_slots_and_append_replaced_slots_to_extra_vault()
        update_user_current_generation_state()
        update_job(status="completed")
```

### 4.3 Payment Success

```python
async def record_payment_success(payment_link_id, payload, source):
    payment = load_payment_in_transaction(payment_link_id)
    if payment.processed_at:
        return

    assert_received_amount_matches_expected()
    user = load_user(payment.user_id)

    if product_id == "final_pack_199":
        set user.final_pack_paid_at
        set user.final_pack_payment_link_id
    elif product_id == "extra_pack_99":
        set user.extra_pack_paid_at
        set user.extra_pack_payment_link_id
        set user.extra_pack_selected_ids

    increment user.total_spent_thb
    create purchases/purchase_{payment_link_id}
    set payment.status = "success"
    set payment.provider_status = "PAID"
    set payment.paid_at and processed_at
```

## 5. Environment Variables

Required or production-relevant:

```bash
PROJECT_ID=
GCS_BUCKET_NAME=
LIFF_CHANNEL_ID=
LINE_CHANNEL_SECRET=

BEAM_BASE_URL=https://playground.api.beamcheckout.com
BEAM_MERCHANT_ID=
BEAM_API_KEY=
BEAM_WEBHOOK_HMAC_KEY=
PAYMENT_REDIRECT_URL=
PAYMENT_WEBHOOK_PUBLIC_URL=
PAYMENT_LINK_EXPIRY_MINUTES=30
PAYMENT_CURRENCY=THB

VERTEX_MODEL=gemini-3-pro-image-preview
VERTEX_LOCATION=global
GENAI_PROVIDER=vertex
GENAI_FALLBACK_PROVIDER=gemini_api
GEMINI_API_KEY=
GEMINI_API_BASE_URL=https://generativelanguage.googleapis.com

LINE_PROFILE_CACHE_TTL_SECONDS=300
LINE_PROFILE_CACHE_GRACE_SECONDS=600
GENERATION_CONCURRENCY=1
GENERATION_COOLDOWN_SECONDS=30
GENERATION_MAX_RETRIES=8
GENERATION_RETRY_BASE_DELAY=5.0
```

## 6. Technical Test Coverage Targets

- Auth: missing token, invalid token, mismatched user ID.
- User sync: new profile defaults and old profile migration/default fields.
- Generation attempt transaction: warnings, 20th lock, 21st block, expired
  cooldown reset, paid-unexported block.
- Job API: queued/completed/failed response shapes and user ownership checks.
- Locked regeneration: locked slots reused, replaced slots appended to Extra Vault.
- Image processor: rejects non-square/unsupported grids and emits exactly 16 PNGs.
- Final export: unpaid `402`, paid share/download success, finalize unlocks vault.
- Extra Vault: hidden before final export, visible after, expired after TTL.
- Extra payment: validates selected IDs and 1-16 count.
- Beam webhook: invalid signature rejected; success is idempotent.
- Payment status polling: syncs non-success payments from Beam and records
  entitlement on success.
