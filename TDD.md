# Technical Design Document : TDD

# Phase 3: Technical Design Document (TDD) v2.0

**Project Name:** StickerLine AI (Production)

**Tech Stack:** React (Vite) + Python (FastAPI on Cloud Run) + Firestore

## 1. System Components & Responsibility

เราแบ่งหน้าที่ชัดเจนเพื่อให้ง่ายต่อการขยายระบบ (Scale) และดูแลรักษา (Maintain):

| Component | Technology | Role |
| --- | --- | --- |
| **Frontend** | React (Vite) | แสดง UI, จัดการ State การอัปโหลด, แสดง Preview, เรียก API Backend |
| **Backend API** | Python (FastAPI) | จุดเข้าออกหลัก (Gateway), ตรวจสอบ Auth, จัดการ Transaction การเงิน |
| **AI Worker** | Python (Internal) | เรียก Vertex AI, ลบพื้นหลัง (`rembg`), ตัดภาพ (Slicing), ใส่ขอบขาว |
| **Database** | Firestore | เก็บ User Profile, Coin Balance, Transaction Logs |
| **Storage** | Google Cloud Storage | เก็บรูป Input (Selfie) และ Output (Stickers) ชั่วคราว |

---

## 2. API Specification (RESTful)

Frontend จะเชื่อมต่อกับ Backend ผ่าน Endpoints เหล่านี้ (Base URL: `https://api-service-xyz.a.run.app`)

### **Authentication & User Data**

**1. Sync User / Get Profile**

- **Endpoint:** `POST /api/v1/auth/sync`
- **Header:** `Authorization: Bearer <LIFF_ACCESS_TOKEN>`
- **Description:** ตรวจสอบ Token กับ LINE. ถ้าเป็น User ใหม่ -> สร้างและแจก 2 Coins. ถ้าเก่า -> คืนค่า Balance.
- **Response (200 OK):**
    
    ```json
    {
      "user_id": "U123456...",
      "display_name": "Somchai",
      "coin_balance": 5,
      "total_spent_thb": 100.0,
      "can_download": true  // (total_spent_thb >= 30)
    }
    ```
    

### **Sticker Generation (Core)**

**2. Start Generation Job**

- **Endpoint:** `POST /api/v1/jobs/generate`
- **Header:** `Authorization: Bearer <LIFF_ACCESS_TOKEN>`
- **Request Body:**
    
    ```json
    {
      "input_image_uri": "gs://bucket/inputs/u123/selfie_1.jpg",
      "style_id": "chibi_2d",
      "extra_prompt": "wearing sunglasses"
    }
    ```
    
- **Logic:**
    1. เช็ค Coin Balance >= 1
    2. หัก 1 Coin (Atomic Transaction)
    3. ส่ง Job เข้า Queue หรือเริ่ม Process (Async)
- **Response (201 Created):**
    
    ```json
    {
      "job_id": "job_abc123",
      "status": "processing",
      "estimated_wait_seconds": 20
    }
    ```
    

**3. Poll Job Status**

- **Endpoint:** `GET /api/v1/jobs/{job_id}`
- **Description:** Frontend วนลูปเช็คสถานะทุก 3-5 วินาที
- **Response (Processing):** `{ "status": "processing" }`
- **Response (Completed):**
    
    ```json
    {
      "status": "completed",
      "result_urls": [
        "https://storage.../sticker_01.png?signed=...",
        // ... จนถึง sticker_16.png
      ]
    }
    ```
    
- **Response (Failed):** `{ "status": "failed", "error": "Face not detected. Coins refunded." }`

### **Payment (Omise)**

**4. Webhook Handler**

- **Endpoint:** `POST /webhooks/omise`
- **Header:** `X-Omise-Signature` (Verify Request)
- **Logic:** รับ Event `charge.complete` -> Update `coin_balance` และ `total_spent_thb`.

---

## 3. Database Schema (Firestore)

โครงสร้างฐานข้อมูลออกแบบเพื่อรองรับการตรวจสอบยอดเงินและการดาวน์โหลด

### **Collection: `users`**

| Field | Type | Description |
| --- | --- | --- |
| `line_id` (PK) | String | User ID จาก LINE |
| `display_name` | String | ชื่อโปรไฟล์ |
| `coin_balance` | Integer | จำนวน Coin คงเหลือ (Default: 2) |
| `total_spent_thb` | Float | ยอดเงินสะสม (ใช้เช็คเงื่อนไขดาวน์โหลด 30 บาท) |
| `is_free_trial_used` | Boolean | `true` ถ้าเคยได้รับฟรีแล้ว |
| `created_at` | Timestamp | เวลาที่สมัคร |

### **Collection: `transactions`**

| Field | Type | Description |
| --- | --- | --- |
| `txn_id` (PK) | String | Auto-generated ID |
| `user_id` | String | Ref ถึง `users` |
| `type` | String | `deduct` (หัก), `topup` (เติม), `refund` (คืน) |
| `amount` | Integer | จำนวน Coin (+ หรือ -) |
| `reference_id` | String | `job_id` หรือ `omise_charge_id` |
| `timestamp` | Timestamp | เวลาที่เกิดรายการ |
| `URL_pubilc` | String | ที่เก็บ link file จาก การ Generate ของ User |

---

## 4. Internal Logic Details (Backend)

ส่วนนี้คือหัวใจสำคัญของการประมวลผลภาพ (Image Processing Pipeline) ที่จะรันบน Python Cloud Run

### **Pipeline: `generate_sticker_workflow`**

```python
# Pseudocode Flow
async def generate_sticker_workflow(user_id, input_uri, style, prompt):
    try:
        # 1. Vertex AI Generation
        # Prompt = Master Prompt + User Prompt + Safety Rules
        grid_image = await vertex_ai.generate(prompt, input_uri)

        # 2. Image Processing (High CPU)
        # Load image into memory (PIL/OpenCV)

        # A. Remove Background (rembg)
        # ลบสีเขียวออกจากภาพ Grid ใหญ่ก่อน
        clean_grid = remove_background(grid_image)

        # B. Slicing & Post-processing Loop
        output_urls = []
        for i in range(16):
            # Crop 4x4 logic
            sticker = crop_grid(clean_grid, index=i)

            # Add White Stroke (OpenCV)
            sticker = add_stroke(sticker, width=5, color="white")

            # Resize for LINE (370x320 px)
            sticker = resize_maintain_aspect(sticker, 370, 320)

            # Upload to GCS
            url = upload_to_gcs(sticker, f"users/{user_id}/jobs/{job_id}/{i}.png")
            output_urls.append(url)

        return output_urls

    except Exception as e:
        # Auto-Refund Logic
        refund_coin(user_id, 1)
        raise e
```

---

## 5. Directory Structure (Implementation Plan)

โครงสร้างโฟลเดอร์สำหรับ Monorepo (หรือแยก Repo ก็ได้) เพื่อความเป็นระเบียบ:

```
/project-root
├── /backend (Python FastAPI)
│   ├── /app
│   │   ├── main.py              # Entry point
│   │   ├── /api                 # Route Handlers (Auth, Jobs, Payment)
│   │   ├── /core                # Config (Env vars, Secrets)
│   │   ├── /services            # Business Logic
│   │   │   ├── ai_service.py    # Vertex AI Wrapper
│   │   │   ├── image_service.py # Rembg & OpenCV Logic
│   │   │   └── user_service.py  # Firestore Logic
│   │   └── /models              # Pydantic Schemas
│   ├── Dockerfile               # สำหรับ Cloud Run
│   └── requirements.txt         # Dependencies
│
├── /frontend (React Vite)
│   ├── /src
│   │   ├── /api                 # Axios Client (เรียก Backend)
│   │   ├── /components          # React Components
│   │   └── App.tsx              # Main Logic
│   └── firebase.json            # Hosting Config
│
└── /docs                        # TDD, API Docs
```

---

## 6. Security Checklist (สำหรับ Production)

1. **Environment Variables:** ห้าม Hardcode Key. ใช้ `os.getenv()` ดึงค่าจาก Cloud Run Variables หรือ Secret Manager.
2. **CORS Policy:** ที่ Backend ต้องตั้งค่า CORS ให้รับ Request จาก Domain ของ Frontend (Firebase Hosting) เท่านั้น.
3. **Rate Limiting:** (Optional ใน Phase 1) ใช้ Cloud Armor กันการยิง API รัวๆ.
4. **Omise Webhook:** ต้องตรวจสอบ Signature verification เพื่อป้องกันคนปลอม Webhook มาเติมเงินเอง.