# Application Flow: Manee-son AI Sticker (Pay-on-Save Model)

## 🎯 Global Business Rules (CRITICAL FOR UI)
- **NO COINS:** Do not show any coin balances or virtual currency anywhere in the app. All transactions are direct fiat purchases (THB).
- **TRIAL LIMIT:** Users get a maximum of 20 generation attempts per cycle.
- **MONETIZATION:** Free to play, pay to save. 

---

## 📱 Screen 1: Welcome & Creator Studio (Entry)
- **State 1 (Login):** Simple LINE login button. No pricing or limits shown yet.
- **State 2 (Studio):** After login, user uploads a selfie, selects a style (2D/3D), inputs a prompt, and clicks `[Generate]`. 
- **UI Requirement:** Show a subtle counter somewhere indicating "0 / 20 attempts used". 

---

## 📱 Screen 2: The Magic Grid & Trial Loop (Core Engagement)
- **Layout:** A 4x4 grid showing 16 generated stickers.
- **Interactions:** User taps a sticker to lock/keep it.
- **Action:** User clicks `[Regenerate unlocked slots]`. This increments the attempt counter by +1.
- **Dynamic Warning States (Crucial UI):**
  - **Attempts 1-14:** Normal state. Counter updates quietly (e.g., "5/20 attempts").
  - **Attempts 15-17 (Gentle Warning):** Show a mild visual cue (e.g., yellow text) near the regenerate button: "Approaching trial limit."
  - **Attempts 18-19 (Final Warning):** Show a stronger visual cue (e.g., orange/red text): "Only X attempts left! Save final pack for 199 THB."
  - **Attempt 20 (Hard Lock):** The `[Regenerate]` button is disabled. Proceed to Screen 3.

---

## 📱 Screen 3: The Paywall & Cooldown (Post-Trial Limit)
- **Trigger:** Reaching 20/20 attempts without paying.
- **UI State:** The grid is locked. 
- **Primary Action:** A highly visible `[Unlock & Save Final Pack - 199 THB]` button.
- **Secondary UI (The Cooldown):** Display a prominent "24:00:00" countdown timer. 
- **Copywriting:** "Limit reached. Pay 199 THB to save your current pack, or wait [Timer] for a full free reset."

---

## 📱 Screen 4: Checkout & Save (The Main Conversion)
- **Trigger:** User clicks `[Save to Photos]` (either from the Grid or the Paywall).
- **Payment Gateway:** If unpaid, redirect to Beam payment gateway for product `final_pack_199` (199 THB).
- **Success State:** User returns from Beam. Show a "Payment Successful" confirmation, and automatically trigger the actual image download/export process. 
- **Final UI:** A celebratory "Your Final Pack is Saved!" screen.

---

## 📱 Screen 5: The Extra Vault (Post-Save Upsell)
- **Rule:** THIS SCREEN MUST ONLY APPEAR AFTER SCREEN 4 IS SUCCESSFUL.
- **Content:** Display a gallery of "discarded/replaced" stickers collected during the user's regenerate loops.
- **Interaction:** User can select up to 16 stickers to add to a "Cart". Show a clear "Selected: X/16" counter.
- **Primary Action:** `[Buy Extra Pack - 99 THB]` button.
- **Payment & End:** Triggers Beam payment for `extra_pack_99`. Upon success, download the selected extras and show the final "All Done" screen.