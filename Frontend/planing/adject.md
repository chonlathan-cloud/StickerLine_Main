ในฐานะ Mentor ผมขอฟันธงเลยครับว่า **"ต้องแยกครับ (Decoupled Architecture)"** หากคุณต้องการนำระบบนี้ขึ้น Production บน GCP อย่างมืออาชีพ

เหตุผลสำคัญคือเรื่อง **Security** และ **Efficiency** ครับ:

1. **Security:** Demo เดิมเรียก Gemini จาก Client-side ซึ่งทำให้ API Key หลุดได้ง่ายมาก ใน Production เราต้องซ่อน Logic และ Key ไว้หลัง Backend ที่ปลอดภัย
2. **Computing Power:** การลบพื้นหลัง (Background Removal) ใน Demo ใช้ Canvas บน Browser ซึ่งคุณภาพอาจไม่นิ่ง การย้ายไปใช้ Python Library (เช่น `rembg` หรือ `OpenCV`) บน Cloud Run จะได้ผลลัพธ์ที่เนียนและเป็นมาตรฐานกว่ามาก
3. **Independent Scaling:** คุณสามารถเพิ่มความแรงของ Backend (Cloud Run) เฉพาะตอนที่มีการประมวลผลรูปหนักๆ โดยไม่ต้องไปยุ่งกับส่วนแสดงผล (Frontend)

---

### 🏗️ Proposed Production File Structure

ผมแนะนำให้แบ่ง Project ออกเป็น 2 โฟลเดอร์หลักใน Repository เดียวกัน (Monorepo) หรือแยก Repo ก็ได้ครับ:

#### 1. Frontend (React + Vite) - Deploy on Firebase Hosting

โฟลเดอร์นี้จะเหลือแค่ส่วน UI และการรับส่งข้อมูลกับ Backend ของเราเองเท่านั้น

```text
/frontend
├── src/
│   ├── api/              # เปลี่ยนจากเรียก Gemini ตรงๆ เป็นเรียก Backend Cloud Run
│   │   └── client.ts     # Axios/Fetch config
│   ├── components/       # UI Components (StickerCard, ApiKeyScreen [เปลี่ยนเป็น Login])
│   ├── hooks/            # Custom hooks สำหรับจัดการ state
│   ├── pages/            # หน้าหลัก เช่น Home, Generate, Payment
│   ├── types/            # Type definitions
│   └── App.tsx           # Main Logic (เฉพาะส่วน UI Flow)
├── public/               # Static assets
└── vite.config.ts        #

```

#### 2. Backend (Python + FastAPI) - Deploy on Cloud Run

นี่คือส่วนที่คุณในฐานะ Data Engineer จะได้โชว์ฝีมือครับ

```text
/backend
├── app/
│   ├── main.py           # Entry point ของ FastAPI
│   ├── api/              # Route handlers (v1/generate, v1/payment, v1/user)
│   ├── core/             # Configuration (GCP Project ID, Secret Manager)
│   ├── services/         # Business Logic หลัก
│   │   ├── ai_service.py     # Vertex AI (Gemini) Integration (ย้ายจาก geminiService.ts)
│   │   ├── image_service.py  # Background Removal & Processing (ย้ายจาก imageProcessor.ts)
│   │   ├── firestore_service.py # จัดการ Token & User Profile
│   │   └── payment_service.py   # Omise Integration & Webhook
│   ├── models/           # Pydantic models (Request/Response schemas)
│   └── utils/            # Helper functions
├── Dockerfile            # สำหรับ Build image ขึ้น Cloud Run
└── requirements.txt      # (FastAPI, google-cloud-firestore, vertexai, rembg, etc.)

```

#### 3. Infrastructure (GCP Config)

```text
/infra
└── deployment_manager/   # ไฟล์ config สำหรับจัดการ GCP Resources อัตโนมัติ

```

---

### 💡 คำแนะนำเพิ่มเติมจาก Mentor

* **Communication:** แทนที่ Frontend จะส่ง Prompt ไป AI ตรงๆ, ให้ Frontend ส่ง `image_url` และ `style` ไปที่ `POST /v1/generate` ของ Backend แทน
* **Data Flow:**
1. Frontend อัปโหลดรูปไปที่ **Cloud Storage (GCS)**
2. Frontend ส่ง URL ของรูปใน GCS ไปให้ Backend
3. Backend ตรวจสอบ Token ใน **Firestore**
4. Backend เรียก **Vertex AI** มาสร้างรูป
5. Backend ลบพื้นหลังและบันทึกรูปใหม่ลง GCS
6. Backend ตอบกลับ Frontend ด้วย URL ของรูปที่ทำเสร็จแล้ว
