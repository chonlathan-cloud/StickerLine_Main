# Design System: Manee-son AI Sticker (Playful Edition)

## 1. Visual Identity & Vibe
- **Core Concept:** "Creative Playmate" — It should feel like playing a fun game, not using a complex tool.
- **Personality:** Fun, Energetic, Playful, and Welcoming.
- **Visual Style:** Soft-UI with a touch of "Bouncy" elements. Use generous whitespace and rounded corners everywhere to emphasize friendliness.

## 2. Color Palette & Gradients
- **Primary AI Gradient:** - `linear-gradient(135deg, #A855F7 0%, #7C3AED 100%)` (Bright Purple to Deep Violet)
  - Usage: Primary buttons, Active states, and Branding elements.
- **Secondary Accent:** - `#FFD600` (Electric Yellow) - For "Coins" and "Call to Action" to create a fun contrast.
- **Success/Keep Color:** - `#2DD4BF` (Bright Teal) - For selected/kept stickers.
- **Background:** - `#FDFCFE` (Soft White with a hint of purple) - To keep the UI feeling light and airy.

## 3. Typography
- **Primary Font:** 'Prompt' (for Thai) or 'Nunito' (for English) - Choose rounded-edge fonts.
- **Heading:** 24px, Bold, Rounded.
- **Body:** 15px, Medium, for easy reading on mobile.
- **Micro-copy:** 12px, for hints and coin costs.

## 4. Component Style (The "Friendly" Specs)
- **Buttons:** - **Style:** Pill-shaped (Full Rounded Corners: `999px`).
  - **Effects:** Soft drop shadow when idle, slightly "shrink" on tap to give a tactile, bouncy feel.
  - **Height:** 52px (Large and easy to tap with a thumb).
- **Cards & Containers:** - **Radius:** `24px` (Very rounded).
  - **Border:** `2px` solid `#F3E8FF` (Very light purple) to define sections without being harsh.
- **Icons:** Use rounded, thick-stroke icons (Duo-tone style preferred).

## 5. Core Workflow UI: The 4x4 Grid
- **Sticker Cells:** `16px` border-radius. 
- **The "Keep" State:** When a sticker is selected, show a thick Purple Gradient border and a "🌟" or "✅" bouncing icon in the top-right corner.
- **The "Regenerate" State:** For unselected stickers, show them with a slight grayscale or `0.6` opacity to focus on the "Kept" ones.
- **Loading State:** Use a playful "Pulsing" animation on the grid while AI is generating.

## 6. Payment & Coins
- **Coin Badge:** A bright yellow pill-shaped badge with a spinning coin icon.
- **Package Cards:** Use a subtle gradient background to make the "Best Value" package stand out.