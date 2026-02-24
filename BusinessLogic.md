# Business Logic

---

### 1. Core Business Logic & Rules (สรุปตรรกะทางธุรกิจ)

จากการวิเคราะห์ ข้อมูล Business Logic ที่สำคัญที่สุดแบ่งออกเป็น 4 ส่วนหลัก ดังนี้ครับ:

**A. User Identity & Onboarding (การยืนยันตัวตน)**

- **Single Source of Truth:** ใช้ `line_id` เป็น Primary Key เพียงอย่างเดียว
- **Free Trial Rule:** ผู้ใช้ใหม่ (New User) จะได้รับ 2 Coins ฟรี **ครั้งเดียวเท่านั้น** ตรวจสอบผ่าน Flag `is_free_trial_used`.
- **Session Security:** การกระทำ Sensitive (Generate, Download) ต้องตรวจสอบผ่าน Backend โดยใช้ LIFF Access Token หรือ Session ID เสมอ ห้ามเชื่อ Client-side.

**B. Token Economy (ระบบเงินตรา)**

- **Exchange Rate:** Base rate คือ 10 THB = 1 Coin (มีโปรโมชั่นตามแพ็กเกจ เช่น 100 บาท ได้ 12 Coins).
- **Cost of Goods:** การสร้างสติกเกอร์ 1 ครั้ง (1 Request) = หัก 1 Coin.
- **Deduction Logic:** ต้องทำแบบ **Atomic Transaction** (หักเงินสำเร็จก่อน จึงเริ่มสั่งงาน AI) เพื่อป้องกัน Race Condition.

**C. Generation Workflow (ขั้นตอนการสร้างงาน)**

- **Input:** รูปถ่ายของผู้ใช้ (User Photo) + Master Prompt (Backend Managed).
- **AI Output Standard:**
    - Model: Vertex AI (Gemini 1.5 Flash).
    - Format: 4x4 Grid (รวม 16 ท่าทางใน 1 รูป).
    - Requirement: พื้นหลังสีเขียว (#00FF00) เพื่อให้ง่ายต่อการ Die-cut.
- **Post-Processing:** ระบบ Backend ต้องทำ Background Removal (ลบสีเขียว) และ Add White Stroke (ขอบขาว) ให้อัตโนมัติ.
- **Data Retention:** รูปภาพผลลัพธ์เก็บใน GCS และมี Lifecycle ลบอัตโนมัติใน 24 ชม. (เพื่อลดต้นทุน Storage).

**D. Access Control (เงื่อนไขการดาวน์โหลด)**

- **The "30 Baht" Gate:** การดาวน์โหลดไฟล์ความละเอียดสูง (Final Product) ไม่ได้ขึ้นอยู่กับจำนวน Coin ที่เหลือ แต่ขึ้นอยู่กับ `total_spent_thb` >= 30.
    - *นัยยะสำคัญ:* ผู้ใช้สายฟรี (Free Tier) จะ Generate เล่นได้ แต่จะเอารูปไปใช้จริงไม่ได้จนกว่าจะจ่ายเงิน (Pay-to-Unlock).

---

### 2. Key Actors & Main Actions

| Actor (ผู้เกี่ยวข้อง) | Role Description | Main Actions (กิจกรรมหลัก) |
| --- | --- | --- |
| **User (LINE User)** | ผู้ใช้งานทั่วไปที่เข้าผ่าน LIFF | 1. **Register/Login:** เข้าผ่าน LINE และรับ Free Coins.<br>2. **Top-up:** เติมเงินผ่าน Omise.<br>3. **Generate:** อัปโหลดรูปและกดสร้างสติกเกอร์ (เสีย 1 Coin).<br>4. **Download:** ดาวน์โหลดรูป (ถ้า `total_spent` >= 30). |
| **LIFF Client (Frontend)** | Web App ที่รันบน LINE | 1. แสดงผล UI และ Preview รูป.<br>2. ส่ง Access Token ให้ Backend ตรวจสอบ.<br>3. เรียก Omise JS เพื่อสร้าง Payment Token. |
| **Cloud Run (Backend)** | ศูนย์กลางการประมวลผล | 1. **Auth & Logic:** ตรวจสอบสิทธิ์และตัด Coin.<br>2. **Orchestrator:** เรียก Vertex AI และจัดการ Prompt.<br>3. **Image Processor:** ลบพื้นหลัง (rembg) และใส่ขอบขาว.<br>4. **Webhook Handler:** รับสถานะการจ่ายเงินจาก Omise. |
| **AI Agents (Vertex AI)** | Engine ในการสร้างภาพ | 1. รับ Image + Prompt.<br>2. สร้างภาพ 4x4 Grid ตาม Style ที่กำหนด. |
| **Payment Gateway (Omise)** | ผู้ให้บริการรับชำระเงิน | 1. ตัดบัตรเครดิต/QR Code.<br>2. ส่ง Webhook ยืนยันยอดเงินกลับมาที่ Backend. |

### 3. Data Flow Overview (Mermaid.js Flowchart)

แผนภาพนี้แสดงการไหลของข้อมูลใน 2 Flow หลักคือ **Generation Flow** (การสร้าง) และ **Payment Flow** (การเงิน)

flowchart TD
    %% Define Styles
    classDef user fill:#f9f,stroke:#333,stroke-width:2px;
    classDef system fill:#d1e7dd,stroke:#333,stroke-width:2px;
    classDef external fill:#fff3cd,stroke:#333,stroke-width:2px;
    classDef db fill:#cfe2ff,stroke:#333,stroke-width:2px;

    User((User / LIFF)):::user
    Backend[Cloud Run API]:::system
    Firestore[(Firestore DB)]:::db
    GCS[(Cloud Storage)]:::db
    VertexAI[Vertex AI \Gemini 3.0 P.]:::external
    Omise[Omise Gateway]:::external

    %% Onboarding
    User -- 1. Open LIFF (Check/Create) --> Backend
    Backend -- 1.1 Get/Set User Data --> Firestore
    Backend -- 1.2 Free Coin logic --> Firestore

    %% Generation Flow
    User -- 2. Upload Photo & Request Gen --> Backend
    Backend -- 2.1 Atomic Deduct (-1 Coin) --> Firestore
    Firestore -- 2.2 Success/Fail --> Backend
    
    subgraph "AI Processing"
    Backend -- 2.3 Send Image + Prompt --> VertexAI
    VertexAI -- 2.4 Return 4x4 Grid (#00FF00) --> Backend
    Backend -- 2.5 Remove BG & Add Stroke (Python) --> Backend
    Backend -- 2.6 Save Result (Exp 24h) --> GCS
    end
    
    GCS -- 2.7 Signed URL --> Backend
    Backend -- 2.8 Return Preview URL --> User

    %% Payment Flow
    User -- 3. Pay (Credit/QR) --> Omise
    Omise -- 3.1 Webhook (Success) --> Backend
    Backend -- 3.2 Update Coin & Total Spent --> Firestore

    %% Download Flow
    User -- 4. Request Download --> Backend
    Backend -- 4.1 Check total_spent >= 30 --> Firestore
    Firestore -- 4.2 Result (True/False) --> Backend
    Backend -- 4.3 Allow/Deny --> User