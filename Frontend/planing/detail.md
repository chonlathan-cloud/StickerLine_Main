ด้านล่างคือสรุป “ละเอียดทีละไฟล์/ฟังก์ชัน” และ data‑flow diagram (ทั้ง Mermaid และ ASCII) ตามที่ขอ

**ภาพรวมโครงสร้าง**
- React + Vite SPA
- เรียก Gemini จากฝั่ง client ผ่าน `@google/genai`
- ประมวลผลภาพด้วย Canvas ใน browser (ลบพื้นหลังสีเขียว, แยก/รวมสติ๊กเกอร์)

**ไฟล์หลัก + ฟังก์ชัน**

**`App.tsx`**
- บทบาท: UI หลัก + state ทั้งระบบ + flow การ generate/regenerate/preview/lock/download
- ค่าคงที่: `STICKER_COLUMNS = 4`, `STICKER_ROWS = 4`, `TOTAL_STICKERS = 16`
- state สำคัญ: `config` (base64Image, size, aspectRatio, extraPrompt, style), `stickerSlots`, `transparentImageUrl`, `loading`, `processingStep`, `hasGenerated`, `isOnline`
- `wait(ms)`: หน่วงเวลาเพื่อให้ state loading/step ดูสมจริง
- `STYLE_OPTIONS`: รายการ style 2D/3D + รูป preview
- `useEffect` (ตรวจ API key):
  - ถ้ามี `window.aistudio` จะเช็คว่าเลือก API key แล้วหรือยัง → แสดง `ApiKeyScreen` ถ้ายังไม่เลือก
- `useEffect` (online/offline):
  - เปลี่ยน badge Ready/Offline ตาม `navigator.onLine`
- `useEffect` (simulate progress):
  - จำลองจำนวนสติ๊กเกอร์ที่ “กำลังถูกสร้าง” ตามเวลา + สลับข้อความ “ตรวจสอบกฎ LINE”
- `handleImageUpload(e)`:
  - ตรวจว่าเป็นไฟล์ภาพ
  - อ่านเป็น base64 เก็บใน `config.base64Image`
  - reset สถานะ generate เดิม
- `openImagePicker()`:
  - trigger input file ที่ซ่อนอยู่
- `generateSheet()`:
  - ตรวจ online และต้องมีรูป
  - ถ้าเป็นการ regenerate → คำนวณจำนวนที่ไม่ล็อก
  - ลำดับงาน:
    1. set `processingStep = 'analyzing'`
    2. เรียก `geminiService.generateStickerSheet(config)`
    3. `processTransparentSheet()` ลบพื้นหลังเขียว
    4. `splitStickerSheet()` แยกเป็น 16 รูป
    5. merge กับรูปที่ล็อกไว้ (ถ้ามี)
    6. `composeStickerSheet()` รวมกลับเป็นชีตโปร่งใส
  - scroll ไปส่วน Preview เมื่อเสร็จ
  - ถ้าข้อผิดพลาดมีคำว่า 403/500/key → เปิด `ApiKeyScreen`
- `toggleStickerLock(index)`:
  - สลับล็อกของสติ๊กเกอร์แต่ละช่อง
- `handleDownload()`:
  - ดาวน์โหลดไฟล์ชีตเป็น PNG
- UI สำคัญ:
  - header status Ready/Offline
  - upload area + loading overlay (โปร่งใสทับบนภาพ)
  - style selector + textarea prompt detail
  - preview grid 4x4 สำหรับเลือกล็อก

**`services/geminiService.ts`**
- `DEFAULT_THAI_CAPTIONS`: ชุดข้อความไทย 16 คำ
- `generateStickerSheet(config)`:
  - ใช้ `GoogleGenAI({ apiKey: process.env.API_KEY })`
  - model: `gemini-3-pro-image-preview`
  - สร้าง `styleGuide` ตาม `config.style`
  - `technicalTokens` ชุดคำบังคับ (อิง Agents.md)
  - ถ้า `extraPrompt` มีคำว่า no text/ไม่มีข้อความ → ไม่ใส่ caption
  - สร้าง `fullPrompt` รวม technical tokens + style + caption rules + extra prompt
  - เรียก `ai.models.generateContent` ส่ง `inlineData` (รูป) + `text` (prompt)
  - คืนค่าเป็น `data:image/...;base64,...`
- หมายเหตุเชิงสังเกต: ใน `technicalTokens` ไม่มีคำว่า “2K generation quality” ที่อยู่ใน `Agents.md` (เป็นข้อมูลจริงจากโค้ด)

**`utils/imageProcessor.ts`**
- `loadImage(dataUrl)`:
  - โหลด Data URL เป็น `HTMLImageElement`
- `findOpaqueBounds(data, width, height, alphaThreshold=8)`:
  - หา bounding box ของพื้นที่ที่มี alpha เกิน threshold
- `processTransparentSheet(sheetDataUrl, removeBackground=true)`:
  - วาดลง canvas
  - หาก `removeBackground`:
    - ตรวจ pixel เขียวแบบเด่น (chroma green)
    - ทำ flood fill จากขอบเพื่อ mark พื้นหลังเขียวให้ alpha = 0
    - ลด green spill รอบขอบตัวละคร (ปรับ RGB และ alpha)
  - คืนค่า PNG โปร่งใส
- `splitStickerSheet(sheetDataUrl, columns=4, rows=4)`:
  - ตัดเป็นกริด
  - เว้น safe inset 2%
  - ใช้ `findOpaqueBounds` เพื่อ crop แล้ว scale ให้อยู่กลาง cell
  - คืน array ของ Data URL
- `composeStickerSheet(stickerDataUrls, columns=4, rows=4)`:
  - รวมรูปเดี่ยวเป็นชีต 4x4

**`components/ApiKeyScreen.tsx`**
- หน้าให้ผู้ใช้เลือก API key ผ่าน `window.aistudio.openSelectKey()`
- ถ้าเลือกสำเร็จ → callback `onKeySelected()` กลับไป App

**`components/StickerCard.tsx`**
- การ์ด preview + ดาวน์โหลดสติ๊กเกอร์รายใบ
- ปัจจุบันไม่ได้ถูกเรียกใช้ใน `App.tsx`

**`types.ts`**
- ประเภทข้อมูลทั้งหมด เช่น `StickerStyle`, `StickerSheetConfig`, `AIStudio`

**`index.tsx`**
- mount React root
- register service worker `sw.js`

**`index.html`**
- โหลด Tailwind CDN + Google Fonts (Inter)
- importmap สำหรับ `@google/genai` และ React
- มี meta สำหรับ PWA

**`index.css`**
- ตั้ง global style + focus ring
- มีชุด animation/class สำหรับ loading runner (แต่ UI ตอนนี้ใช้ overlay แบบง่ายใน `App.tsx`)

**`firebase.json`**
- hosting target: `dist`
- predeploy: `npm run build`
- rewrite ทั้งหมดไป `/index.html`

**`manifest.json`**
- PWA metadata + icons (inline base64)

**`metadata.json`**
- ชื่อแอป + ขอ permission กล้อง

**`sw.js`**
- cache static assets ขั้นพื้นฐาน (`./`, `index.html`, `manifest.json`)

**`public/Chibi2D.png`, `public/Pixar3D.png`**
- รูป preview style

**`public/index.html`**
- หน้า default ของ Firebase Hosting (ไม่ถูกใช้โดย Vite build)

**`Agents.md`**
- กฎล็อก prompt/UI (ห้ามเปลี่ยนโดยไม่ขออนุญาต)

**`UI_UX_GUARDRAILS.md`**
- ข้อกำหนด UI/UX ที่ต้องรักษาเสมอ
