# Design System: Manee-son AI Sticker (Cyberpunk/Dark AI Edition)

## 1. Visual Identity & Vibe
- **Core Concept:** "The Magic AI Terminal" — It should feel futuristic, highly advanced, and magical.
- **Personality:** Edgy, Futuristic, Tech-forward, and Premium Dark.
- **Visual Style:** True Dark Mode. Heavy use of "Glassmorphism" (frosted glass effects), glowing neon elements, and high-contrast vibrant accents against deep dark backgrounds.

## 2. Color Palette & Glows
- **Background:** `#0B0F19` (Deep Space Navy/Black) - A rich, dark background to make neon colors pop.
- **Surface/Cards:** `rgba(255, 255, 255, 0.05)` with backdrop-blur (Glassmorphism effect) and a very subtle `#1E293B` border.
- **Primary Accent (AI Magic):** `#00F0FF` (Neon Cyan) - Used for primary actions, generating states, and active text.
- **Secondary Accent:** `#B026FF` (Neon Purple) - For highlights, gradients, and secondary elements.
- **Business/Coin Color:** `#FF007F` (Neon Pink) - To make the coins and payment sections aggressively stand out in the dark.
- **Text:** `#FFFFFF` for headings, `#94A3B8` (Slate Gray) for body text.

## 3. Typography
- **Primary Font:** 'Space Grotesk', 'Outfit', or a modern tech-looking geometric font.
- **Heading:** 24px, Bold, Uppercase styling for section titles.
- **Body:** 15px, Light or Regular weight.

## 4. Component Style (The "Futuristic" Specs)
- **Buttons:** - **Style:** Slightly rounded edges (`8px`).
  - **Primary Action:** Solid `#00F0FF` with a subtle outer glow effect (`box-shadow: 0 0 15px rgba(0, 240, 255, 0.4)`). Text inside should be dark (`#0B0F19`).
  - **Secondary Action:** Transparent with a `1px` solid `#B026FF` border and glowing purple text.
- **Input Fields:** Dark transparent background with a bottom-only neon border that glows when focused.

## 5. Core Workflow UI: The 4x4 Grid
- **The "Keep" State:** When a sticker is locked, surround it with a glowing `2px` Neon Cyan border and a holographic "Lock" icon.
- **The "Regenerate" State:** Unselected slots are deeply dimmed (`0.2` opacity) to put total focus on the locked items.
- **Loading State:** A futuristic scanning line (like a laser scanner) moving top-to-bottom over the grid during AI generation.

## 6. Payment & Coins
- **Coin Badge:** A glowing Neon Pink pill shape. 
- **Package Cards:** The "Best Value" card should feature an animated or gradient border moving between Cyan and Purple to signify premium AI power.
