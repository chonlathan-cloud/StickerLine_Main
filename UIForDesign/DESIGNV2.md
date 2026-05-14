# Design System: Manee-son AI Sticker (Minimal Studio Edition)

## 1. Visual Identity & Vibe
- **Core Concept:** "The Premium Gallery" — It should feel like a high-end, professional creator studio.
- **Personality:** Clean, Elegant, Minimalist, and Unobtrusive.
- **Visual Style:** High contrast (Black & White), flat design, zero clutter, and extreme use of whitespace (Negative space) to make the generated stickers the absolute center of attention.

## 2. Color Palette
- **Primary:** `#111827` (Deep Charcoal Black) - For primary buttons, active text, and strong borders.
- **Secondary:** `#F3F4F6` (Light Gray) - For secondary buttons, disabled states, and subtle background sections.
- **Background:** `#FFFFFF` (Pure White) - To keep the canvas completely clean.
- **Accent (Business Critical):** `#D97706` (Sleek Metallic Gold) - Used sparingly ONLY for "Coins" and "Premium Packages" to make them subtly elegant but noticeable.

## 3. Typography
- **Primary Font:** 'Inter', 'Helvetica Neue', or a clean Geometric Sans-serif.
- **Heading:** 22px, Semi-bold, crisp tracking (letter-spacing).
- **Body:** 14px, Regular, `#4B5563` (Medium Gray) for high legibility but not overpowering.
- **Micro-copy:** 11px, Uppercase with wide tracking for a premium feel (e.g., "7 COINS").

## 4. Component Style (The "Premium" Specs)
- **Buttons:** - **Style:** Sharp or very slightly rounded (Border-radius: `4px` or `6px` maximum). No pill shapes.
  - **Primary Button:** Solid `#111827` with `#FFFFFF` text. Flat, NO shadows.
  - **Height:** 48px.
- **Cards & Containers:** - Flat design with NO drop shadows.
  - Use a very delicate `1px` solid border (`#E5E7EB`) to define sections.
- **Icons:** Sharp, thin-line (Outline) icons. Minimalist style.

## 5. Core Workflow UI: The 4x4 Grid
- **Sticker Cells:** Square, flat, no rounded corners (`0px` or `4px` max).
- **The "Keep" State:** A stark, thick `2px` solid Black border around the kept sticker, with a minimalist Black "Check" icon in the corner.
- **The "Regenerate" State:** Unselected stickers fade to `0.3` opacity or turn completely grayscale.
- **Loading State:** A sleek, thin black loading bar or a simple fading gray skeleton block.

## 6. Payment & Coins
- **Coin Badge:** A minimalist outline of a coin with text, no heavy gradients.
- **Package Cards:** The "Best Value" card uses a solid black border (`2px`) to stand out from the standard light gray border, maintaining the monochrome elegance.