# Mia-U-Sticker

เว็บแอป (Mobile-first) สำหรับสร้างชุดสติ๊กเกอร์ LINE จากรูปผู้ใช้ ด้วย Gemini Image แล้วประมวลผลฝั่ง client ให้เป็น PNG โปร่งใส พร้อมเลือกล็อกบางภาพและ regenerate เฉพาะที่ต้องการ

## สถานะปัจจุบัน (อิงโค้ดล่าสุด)
- UI ชื่อแอป: `Mia-U-Sticker`
- จำนวนสติ๊กเกอร์ต่อชุด: `4 x 4 = 16`
- ขนาดที่ใช้ generate ค่าเริ่มต้น: `2K`
- สไตล์ที่เลือกได้: `Chibi 2D`, `Pixar 3D`
- ภาพตัวอย่าง style ใช้ไฟล์ใน `public/`:
  - `public/Chibi2D.png`
  - `public/Pixar3D.png`
- Loading runner แสดงทับบนกรอบ Upload photo แบบโปร่งใส (ไม่ทำการ์ดซ้ำด้านล่าง)
- Preview เลือกสติ๊กเกอร์โดยแตะที่ภาพ แล้วขึ้นเครื่องหมายถูกโปร่งใสสีเขียว
- ดาวน์โหลดผลลัพธ์เป็นไฟล์เดียว: `Download PNG`

## ฟีเจอร์หลัก
- อัปโหลดรูปต้นฉบับ 1 รูป
- เลือก style 2D/3D
- ใส่ `prompt detail` เพิ่มเติม (ช่อง prompt ขยายเมื่อโฟกัส)
- Generate ชุด 16 ภาพ
- ลบพื้นหลังเขียว `#00FF00` อัตโนมัติ
- ลด green spill รอบขอบตัวละคร
- ล็อกภาพที่ต้องการคงไว้ แล้วกด regenerate เฉพาะภาพที่ไม่ล็อก

## เทคโนโลยี
- React 19 + TypeScript
- Vite 6
- `@google/genai`
- Tailwind (ผ่าน CDN ใน `index.html`)
- Firebase Hosting

## โครงสร้างไฟล์สำคัญ
- `App.tsx` หน้า UI หลัก + state ทั้งระบบ
- `services/geminiService.ts` prompt construction และเรียก Gemini model
- `utils/imageProcessor.ts` ลบพื้นหลัง/ลด green spill/ตัดและประกอบชีต
- `components/ApiKeyScreen.tsx` หน้าจอเชื่อม API key ผ่าน AI Studio bridge
- `Agents.md` กฎล็อก prompt/UI ที่ห้ามเปลี่ยนโดยไม่ได้รับอนุญาต
- `firebase.json` ค่า deploy hosting

## การตั้งค่า Environment
สร้างไฟล์ `.env.local`:

```bash
GEMINI_API_KEY=YOUR_API_KEY
```

หมายเหตุ: `vite.config.ts` map ค่านี้ไปที่ `process.env.API_KEY` และ `process.env.GEMINI_API_KEY`

## รันในเครื่อง
```bash
npm install
npm run dev
```

ค่าเริ่มต้น dev server: `http://localhost:3000`

## Build / Preview
```bash
npm run build
npm run preview
```

## Deploy Firebase
ตั้งค่าแล้วตามไฟล์:
- Project: `mia-u-sticker` (ดู `.firebaserc`)
- Hosting public dir: `dist` (ดู `firebase.json`)
- Predeploy: `npm run build`

Deploy:

```bash
firebase deploy
```

## Prompt/UI Locks (สำคัญ)
กฎห้ามเปลี่ยนโดยพลการอยู่ใน `Agents.md` โดยเฉพาะ:
- Prompt lock สำหรับ `Chibi 2D` และ `Pixar 3D`
- Loading runner behavior (overlay โปร่งใสบน upload area)
- กฎข้อความภาษาไทยบนสติ๊กเกอร์และความถูกต้องสระ/วรรณยุกต์

หากต้องการแก้กฎ lock ให้แก้หลังได้รับอนุญาตจาก owner เท่านั้น

## ข้อจำกัดปัจจุบัน
- ปุ่ม `Download PNG` ส่งออกเป็นชีตรวม 16 ภาพไฟล์เดียว
- ยังไม่มีคำสั่ง lint/test ใน `package.json`
