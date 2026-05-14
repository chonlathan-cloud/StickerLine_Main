🎨 User Flow: "The AI Sticker Maker" (Simplified Version)
We will divide the user journey into 5 main steps as follows:

1. Welcome & Quick Login (The First Door)

User Goal: Wants to quickly get in and try creating stickers.

Flow: Enter the app → See the LINE Login page (large, prominent button) → Once logged in, instantly receive a welcome gift of "2 Free Coins" to encourage them to try playing.

UI Focus: Simplicity, brand reliability, and free coin notifications.

2. The Creator Studio (Creative Space)

User Goal: Set up the desired stickers.

Flow: Upload a selfie → Select a style (e.g., 2D or 3D cartoon) → Type in the preferred vibe (with easy-to-select Prompt examples) → Press the "Generate" button (costs 1 Coin).

UI Focus: A form that doesn't look like a form (Interactive), clear visual style options, and a remaining coin balance bar.

3. The Magic Grid & Keep Loop (The Heart of the App)

User Goal: Select and adjust until satisfied with 16 images.

Flow: The system shows a 16-grid of stickers → Users tap the images they "like" to lock them (Keep) → For the ones they don't like, do not select them → Press "Regenerate" again to replace only the unlocked images.

UI Focus: A highly responsive Grid system (Tap to select), clear "Lock/Keep" symbols, and Action buttons that clearly indicate what will happen to the remaining images.

4. Extra Picks & Secret Versions (Backup Vault)

User Goal: Recover beautiful images that were seen but not selected.

Flow: If they want a different version in the same slot → Press Unlock to view "Extra Picks" (costs 1 Coin) → Select an image from the backup vault to swap into the main 16 images.

UI Focus: Using a Modal or a bottom drawer that pops up to avoid disrupting the main page.

5. Collection Export (Receive the Masterpiece)

User Goal: Actually use the stickers in LINE.

Flow: Satisfied with all 16 images → Press Save to device (Save to Photos). There is a shortcut to open the LINE Sticker Maker app to make stickers for sale right away.

UI Focus: Prominent Success/Download buttons, and options to share or proceed to other apps.

6. "The Coin Wallet" (UX Edition)
6.1 The Selection (Package selection page):

The user clearly sees the current coin balance.

There are packages to choose from: 7 Coins (70 THB) and 12 Coins (100 THB), highlighting that the 100 THB one is more worthwhile (Best Value).

Action: Click buy, and the app will redirect to the payment page (External Redirect).

6.2 The Bridge (Waiting for payment result page):

After completing the payment at Beam, the user will be sent back to the /payment?beam_return=1 page.

UI: Displays the status "Checking balance..." (Processing) to let the user know the system is working.

6.3 The Result (Summary page):

Success: "Top-up successful!" along with showing the new balance and a "Go create stickers now" button.

Fail/Pending: "Payment not yet completed" along with a "Try again" or "Contact support" button.