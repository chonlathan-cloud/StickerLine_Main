# User Flow: AI Sticker Maker

This flow describes the new pay-on-save business model. Users can freely explore generation until the trial limit is reached, but saving the final stickers always requires payment.

## 1. Welcome and LINE Login

**User goal:** Enter the app quickly and start creating stickers.

**Flow:**

1. User opens the LIFF app.
2. User logs in with LINE.
3. The app creates or syncs the user profile.
4. User lands directly in the Creator Studio.

**UI focus:**

- Keep login simple and trustworthy.
- Do not show coin balance or coin packages.
- Make the first action clearly about creating stickers.

## 2. Creator Studio

**User goal:** Set up the sticker pack.

**Flow:**

1. User uploads a selfie.
2. User selects a visual style, such as 2D cartoon or 3D cartoon.
3. User enters an optional prompt or selects a prompt example.
4. User taps **Generate**.

**Business rule:**

- Every tap on **Generate** or **Regenerate** counts as 1 generation attempt.
- The trial limit is 20 total attempts per cycle.

**UI focus:**

- Show the generation counter as a clear usage status, for example `12 / 20 attempts used`.
- The counter must be visible but should not dominate the creative workflow.
- The user should understand that payment is required only when saving, or when the trial limit is reached.

## 3. Magic Grid and Keep Loop

**User goal:** Build a final set of 16 stickers.

**Flow:**

1. The system displays a 4x4 grid with 16 sticker slots.
2. User taps stickers they want to keep.
3. Kept stickers remain locked in their current slots.
4. User taps **Regenerate** to replace only unlocked stickers.
5. Each regenerate action increases the generation counter by 1.

**Extra Vault rule:**

- Starting from the first regenerate after the initial generate, every sticker that gets replaced out of the final 16 is saved into the Extra Vault.
- Extra Vault images are not shown during the main creation loop.
- Extra Vault is shown only after the user has successfully saved the paid final pack.

**UI focus:**

- Make locked/kept stickers visually obvious.
- Make unlocked stickers feel available for replacement.
- Explain the regenerate result with concise action text, such as `Regenerate unlocked slots`.

## 4. Trial Limit Warning

**User goal:** Understand they are approaching the free exploration limit.

**Flow:**

1. Attempts 1-14: no warning.
2. Attempts 15-17: show a gentle warning.
3. Attempts 18-19: show a stronger warning.
4. Attempt 20: lock further generation and show the 199 THB unlock path.

**Approved warning meaning:**

- Attempts 15-17: The user is close to the trial limit and should know how many attempts remain.
- Attempts 18-19: The user has very few attempts left and should understand the final pack can be saved for 199 THB.
- Attempt 20: The trial limit is reached; the user must unlock the final pack for 199 THB to continue to save.

**UI focus:**

- Warnings should be visible near the generation controls.
- The copy should be calm, direct, and action-oriented.
- The warning should not interrupt image selection unless the limit has already been reached.

## 5. Trial Limit Lock and 24-Hour Cooldown

**User goal:** Understand why generation is blocked and what they can do next.

**Flow:**

1. When the 20th attempt is used, the app immediately blocks further Generate and Regenerate actions.
2. The app shows the final pack payment path for 199 THB.
3. If the user does not pay and goes back, the app shows a 24-hour countdown.
4. The countdown starts from the time the 20th attempt was used.
5. During the countdown, the app should continue encouraging payment.
6. If the user pays during countdown, they can proceed to save the final pack.
7. If the countdown reaches zero without payment, the app resets the full cycle:
   - generation counter
   - current final stickers
   - Extra Vault
   - cycle payment state

**UI focus:**

- Countdown should be clear and easy to scan.
- The 199 THB payment action should remain the primary action during countdown.
- Reset after cooldown should feel like a fresh start.

## 6. Final Pack Payment and Save to Photos

**User goal:** Save the selected 16 final stickers.

**Flow:**

1. User taps **Save to Photos**.
2. If the final pack has not been paid for, the app opens Beam payment for `final_pack_199`.
3. `final_pack_199` costs 199 THB.
4. After payment success, the user returns to the save screen.
5. User taps **Save to Photos** again or the app resumes the save action automatically.
6. The app exports the final 16 stickers.
7. Save is considered successful when the backend/frontend download or share flow has completed and the user reaches the success summary screen.

**Business rule:**

- Payment is required for Save to Photos even if the user has not reached the 20-attempt limit.
- Payment unlocks only the current final pack for the current cycle.

**UI focus:**

- Make the price and outcome explicit: `Save final 16 stickers - 199 THB`.
- After payment success, return the user directly to the saving action.
- The success screen should confirm that the final pack has been saved or prepared for saving.

## 7. Extra Vault Upsell

**User goal:** Optionally buy additional stickers that were replaced during regeneration.

**Flow:**

1. After the final 16 stickers are successfully saved, the app shows the Extra Vault.
2. Extra Vault displays all replaced stickers collected during regeneration.
3. User can select up to 16 extra stickers into a cart.
4. If fewer than 16 extra stickers exist, the user can buy all available extra stickers.
5. User taps the extra pack payment action.
6. The app opens Beam payment for `extra_pack_99`.
7. `extra_pack_99` costs 99 THB.
8. After payment success, the app exports only the selected extra stickers.
9. The extra pack flow ends after the selected extra stickers are exported.

**Business rule:**

- Extra Vault is separate from the final 16.
- Extra pack export must not include final pack stickers.
- Extra Vault expires 24 hours after final pack save/export success.
- Extra pack is optional; the user can skip it without blocking the final pack.

**UI focus:**

- Make the cart limit clear: `Select up to 16`.
- Keep final pack and extra pack visually separated to avoid confusion.
- Do not show Extra Vault before final save success.

## 8. Payment Products

The app uses Beam for payment.

| Product ID | Price | Purpose |
| --- | ---: | --- |
| `final_pack_199` | 199 THB | Unlock and export the current final 16 stickers |
| `extra_pack_99` | 99 THB | Export up to 16 selected Extra Vault stickers |

**UI focus:**

- Do not present products as coins.
- Show each product as a direct purchase of an outcome.

## 9. End State

**Final pack only:**

- User pays 199 THB.
- User saves the final 16 stickers.
- User sees the success summary.
- User may skip Extra Vault.

**Final pack plus extra pack:**

- User pays 199 THB.
- User saves the final 16 stickers.
- User selects Extra Vault stickers.
- User pays 99 THB.
- User saves the selected extra stickers.
- The process is complete.

**Skipped payment after limit:**

- User reaches 20 attempts.
- User does not pay.
- User sees a 24-hour countdown.
- When countdown ends, the full cycle resets and the user can start again.
