# Low - Level Design : LLD

**Phase 4: Low-Level Design (LLD)** สำหรับโปรเจกต์ **StickerLine AI** 

เอกสารนี้จะลงลึกถึงระดับ **Class, Function, Database Field, และ Logic Algorithm** เพื่อให้ Developer (หรือตัวผมเองในขั้นตอนถัดไป) สามารถเขียน Code ได้ทันทีโดยไม่ต้องเดาครับ

---

# Phase 4: Low-Level Design (LLD) Document

**System:** StickerLine AI (Production)

**Stack:** Python FastAPI (Cloud Run) + React (Firebase) + Firestore

## 1. Backend Project Structure (Python FastAPI)

เราจะใช้โครงสร้างแบบ **Modular Architecture** เพื่อความสะอาดและขยายง่ายครับ

```
/backend
├── Dockerfile                  # Configuration for Cloud Run (Python 3.11)
├── requirements.txt            # dependencies: fastapi, uvicorn, rembg, numpy, cv2, etc.
├── app/
│   ├── __init__.py
│   ├── main.py                 # Entry point (FastAPI app init)
│   ├── core/
│   │   ├── config.py           # Load Env Vars (GCP_PROJECT, OMISE_KEY)
│   │   ├── security.py         # Verify LIFF Token logic
│   │   └── exceptions.py       # Custom Exceptions
│   ├── models/                 # Pydantic Schemas & DB Models
│   │   ├── user.py
│   │   ├── job.py
│   │   └── transaction.py
│   ├── api/                    # Route Controllers
│   │   ├── v1/
│   │   │   ├── auth.py         # POST /sync
│   │   │   ├── stickers.py     # POST /generate, GET /jobs/{id}
│   │   │   └── webhooks.py     # POST /omise
│   ├── services/               # Business Logic (The Brain)
│   │   ├── user_service.py     # Firestore Logic (Get/Create/Update)
│   │   ├── ai_service.py       # Vertex AI Integration
│   │   ├── image_service.py    # Rembg + OpenCV (Slice/Stroke)
│   │   └── payment_service.py  # Omise Logic
│   └── utils/
│       ├── firestore.py        # DB Connection Client
│       └── storage.py          # GCS Upload/Download helpers
```

---

## 2. Database Design (Firestore Detailed Schema)

ระบุ Field และ Type ให้ชัดเจนเพื่อป้องกัน Data Type Mismatch

### **Collection: `users`**

*Document ID: `line_user_id` (String)*

| Field Name | Type | Constraint | Description |
| --- | --- | --- | --- |
| `display_name` | String |  | ชื่อจาก LINE Profile |
| `picture_url` | String |  | URL รูปโปรไฟล์ |
| `coin_balance` | Integer | Min: 0 | จำนวน Coin คงเหลือ |
| `total_spent_thb` | Float | Min: 0.0 | ยอดเงินสะสม (สำหรับปลดล็อก Download) |
| `is_free_trial_used` | Boolean | Default: False | Flag ป้องกันการปั๊ม Coin ฟรี |
| `created_at` | Timestamp |  | วันที่สมัคร |
| `updated_at` | Timestamp |  | วันที่อัปเดตล่าสุด |

### **Collection: `jobs`**

*Document ID: `job_uuid` (String)*

| Field Name | Type | Description |
| --- | --- | --- |
| `user_id` | String | Ref to `users` |
| `status` | String | Enum: `pending`, `processing`, `completed`, `failed` |
| `input_gcs_uri` | String | `gs://...` รูปต้นฉบับ |
| `style_id` | String | `chibi_2d` หรือ `pixar_3d` |
| `output_urls` | Array[Str] | List ของ Signed URL (16 รูป) เมื่อเสร็จ |
| `error_msg` | String | เก็บ Error log กรณี Failed |
| `created_at` | Timestamp |  |

### **Collection: `transactions`**

*Document ID: `txn_uuid` (String)*

| Field Name | Type | Description |
| --- | --- | --- |
| `user_id` | String | Ref to `users` |
| `type` | String | Enum: `usage` (gen), `topup` (omise), `refund` (error) |
| `amount` | Integer | e.g., -1, +12 |
| `reference_id` | String | Link to `job_id` or `omise_charge_id` |
| `URL_Public` | string | save link for history user |

---

## 3. Algorithm Specification (Logic เจาะลึก)

### **A. User Sync & Free Coin Logic (`services/user_service.py`)**

```python
def sync_user(line_profile: dict):
    user_ref = db.collection('users').document(line_profile['userId'])
    user_doc = user_ref.get()

    if not user_doc.exists:
        # New User: Create + Grant Free Coins
        new_user = {
            "display_name": line_profile['displayName'],
            "coin_balance": 2,  # <--- Logic: Free 2 Coins
            "is_free_trial_used": True,
            "total_spent_thb": 0.0,
            "created_at": firestore.SERVER_TIMESTAMP
        }
        user_ref.set(new_user)
        return new_user
    else:
        # Existing User: Return current data
        return user_doc.to_dict()
```

### **B. Atomic Coin Deduction (`services/user_service.py`)**

ต้องใช้ `transaction` ของ Firestore เพื่อป้องกัน Race Condition (เช่น กดรัวๆ แล้วเหรียญติดลบ)

```python
@firestore.transactional
def deduct_coin(transaction, user_ref):
    snapshot = user_ref.get(transaction=transaction)
    balance = snapshot.get("coin_balance")

    if balance < 1:
        raise ValueError("Insufficient coins")

    # Logic: Deduct 1 Coin
    transaction.update(user_ref, {"coin_balance": balance - 1})
    return True
```

### **C. Image Processing Pipeline (`services/image_service.py`)**

นี่คือส่วนที่ซับซ้อนที่สุด (The Core Engine) แปลง Grid 4x4 -> 16 สติกเกอร์

**Algorithm Steps:**

1. **Download:** โหลดรูป Grid (PNG) จาก GCS เข้า Memory.
2. **Slice Calculation:** คำนวณขนาดช่อง (Width/4, Height/4).
3. **Loop 16 Times (4 rows x 4 cols):**
    - **Crop:** ตัดภาพตามพิกัด `(x, y, w, h)`.
    - **Rembg:** ส่งภาพย่อยเข้า `rembg.remove()` เพื่อลบพื้นหลัง.
    - **Find Contours:** หาขอบเขตของตัวการ์ตูน (Bounding Box) แล้ว Crop ให้กระชับ (Trim whitespace).
    - **Add Stroke:** ใช้ OpenCV (`cv2.dilate`) ขยาย Mask สีขาวเพื่อทำขอบ.
    - **Resize:** ปรับขนาดให้พอดีกับมาตรฐาน Sticker (เช่น 370x320px) โดยรักษา Aspect Ratio.
    - **Upload:** อัปโหลดกลับ GCS.

**Pseudocode for Slicing & Stroke:**

```python
import cv2
import numpy as np
from rembg import remove

def process_grid_image(image_bytes):
    # 1. Load Image
    nparr = np.frombuffer(image_bytes, np.uint8)
    full_img = cv2.imdecode(nparr, cv2.IMREAD_UNCHANGED)
    h, w, _ = full_img.shape

    step_h, step_w = h // 4, w // 4
    processed_stickers = []

    for row in range(4):
        for col in range(4):
            # 2. Slice
            y1, y2 = row * step_h, (row + 1) * step_h
            x1, x2 = col * step_w, (col + 1) * step_w
            crop = full_img[y1:y2, x1:x2]

            # 3. Remove BG (Library call)
            # แปลง cv2 -> bytes -> rembg -> cv2
            crop_no_bg = remove_background_rembg(crop)

            # 4. Add White Stroke
            final_sticker = add_white_stroke(crop_no_bg, thickness=10)

            processed_stickers.append(final_sticker)

    return processed_stickers

def add_white_stroke(image, thickness):
    # แยก Alpha channel มาทำ Mask
    alpha = image[:, :, 3]
    _, mask = cv2.threshold(alpha, 0, 255, cv2.THRESH_BINARY)

    # ขยาย Mask (Dilate)
    kernel = np.ones((thickness, thickness), np.uint8)
    dilated = cv2.dilate(mask, kernel, iterations=1)

    # สร้างภาพสีขาวขนาดเท่าเดิม
    stroke_layer = np.zeros_like(image, dtype=np.uint8)
    stroke_layer[:, :, 0:3] = 255 # White color
    stroke_layer[:, :, 3] = dilated # Alpha from dilated mask

    # ซ้อนภาพต้นฉบับทับภาพ Stroke
    # (ใช้ Alpha blending logic หรือวางทับตรงๆ ถ้า Mask เป๊ะ)
    result = overlay_images(stroke_layer, image)
    return result
```

---

## 4. API Interface Specification (FastAPI)

### **Request: Generate Sticker**

`POST /api/v1/stickers/generate`

```json
{
  "input_gcs_uri": "gs://app-bucket/temp/u123/selfie.jpg",
  "style_id": "chibi_2d",
  "extra_prompt": "wearing spacesuit"
}
```

### **Response: Job Created**

```json
{
  "job_id": "job_550e8400-e29b",
  "status": "processing",
  "message": "Deducted 1 coin. AI is working..."
}
```

### **Request: Omise Webhook**

`POST /api/v1/webhooks/omise`

*Headers:* `User-Agent: Omise`, `X-Omise-Signature: ...`

```json
{
  "object": "event",
  "key": "evnt_...",
  "data": {
    "object": "charge",
    "status": "successful",
    "amount": 10000, // 100.00 THB
    "metadata": {
      "user_id": "U123456"
    }
  }
}
```

---

## 5. Security & Env Variables

ไฟล์ `.env` (สำหรับการพัฒนา) หรือ Cloud Run Environment Variables:

```bash
# General
ENV=production
PROJECT_ID=my-sticker-project

# Database & Storage
FIRESTORE_DB=default
GCS_BUCKET_NAME=app-sticker-assets

# Authentication
LIFF_CHANNEL_ID=165xxxxxxx
LINE_CHANNEL_SECRET=xxxxxx  # Keep in Secret Manager

# Payment
OMISE_SECRET_KEY=skey_test_xxxxxx # Keep in Secret Manager
OMISE_PUBLIC_KEY=pkey_test_xxxxxx

# AI
VERTEX_AI_LOCATION=us-central1
```

---