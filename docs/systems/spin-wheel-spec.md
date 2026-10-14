# Spin & Win: spec (thank-you card → spin page)

Status: **spec, not built yet** (written 2026-10-15). Founder decisions are final unless marked *open*.
Printed thank-you cards already point at `umzila.store/spin`. Until this is built, `netlify.toml` redirects `/spin` to the home page (`?src=card`). Remove that redirect when `spin.html` ships. `spin`, `wheel`, `gift`, `gifts`, `rewards` and `thanks` are in `seller_slug_reserved()`.

---

## 1. What it is, in one paragraph

Every delivery has a printed Umzila thank-you card in the bag. Scanning it opens **/spin**:
1. The page works out who the person is (or asks).
2. It greets them personally.
3. They give a one-tap star rating.
4. They spin a prize wheel that feels like a game: sound, vibration, confetti.
5. They get a personal gift code for their next order, valid **5 days**, with three emails to bring them back.

People who never ordered (a friend found the card, or got a shared link) get the same spin, valid on their **first** order. After spinning, anyone can "give a friend a spin". If that friend becomes a new paying customer, the sharer unlocks a **mystery gift (R20 off)**.

**The wheel is not a game of chance.** Admin decides what is being given away right now (a schedule of time slots). The wheel animates to that gift. This keeps it out of "promotional competition" territory while keeping the mystery. The page never says the outcome is random or "luck".

## 2. Founder decisions (2026-10-14/15)

| # | Decision |
|---|---|
| D1 | **One spin per recent order.** A paid order in the **last 30 days** that hasn't been spun for unlocks **one** spin. **One live gift at a time.** Two orders don't stack two gifts. |
| D2 | **Welcome-back spin:** a customer whose last paid order is older than 30 days gets **one** comeback spin, once ever. |
| D3 | **"Your food free" covers food/items only, up to R150.** Delivery is still paid. No new discount type needed. |
| D4 | **R20 off needs a minimum order of R60.** |
| D5 | **Friend referral reward: max 5 per sharer per calendar month.** |
| D6 | **Phone check:** someone identifying by email on a new browser confirms the **last 4 digits of the phone number on their order**. |
| D7 | The prize is **preset by admin** per time slot (duration + optional max winners), with a default gift otherwise. Admin can change it at any time. |
| D8 | Gift codes last **5 days**, ending 23:59 SAST on day 5. |
| D9 | Emails: right after spinning, a reminder on day 3, and a final one on the morning of the expiry day. |
| D10 | Wheel wording is general Umzila wording, never about plates. |
| D11 | Rating = one tap on 1–5 stars + optional comment, then Next. Skippable. |
| D12 | Someone making a new account or using a new email to get another spin is acceptable. Every spin still needs a real paid order. |

## 3. The gifts

Gift kinds live in code (`netlify/functions/lib/spin-gifts.js`). Each kind maps to an ordinary `discount_codes` row, so checkout, validate-cart and PayFast need **no changes** to redeem them.

| Kind | Wheel label | Prize wording | `discount_codes` row |
|---|---|---|---|
| `drink` | 🥤 Free drink | "A free cold drink with your next order" | `type 'percentage'`, `amount 100`, `scope 'products'`, `product_ids` = all visible Umzila Drinks products, `max_discount_amount` = price of the dearest drink |
| `pct10` | 🏷️ 10% off | "10% off your next order" | `type 'percentage'`, `amount 10` |
| `r20` | 💸 R20 off | "R20 off your next order (over R60)" | `type 'fixed'`, `amount 20`, `min_order_amount 60` |
| `food150` | 🤯 Your food FREE | "Your food is on us, up to R150" | `type 'percentage'`, `amount 100`, `max_discount_amount 150` |
| `free_delivery` | 🛵 Free delivery | n/a | **Not available yet.** Codes can't discount delivery. It stays **off the wheel** until it's built (phase 2). |

**Every spin code:**
- `code` = `SPIN` + 6 random characters;
- `email` = the spinner (email-locked);
- `multi_use false`, so guests can use it;
- `expires_at` = day 5, 23:59 SAST;
- `seller_id null` (any store), `status 'active'`;
- friend spins also get `first_order_only true`.

As with every promo code, services/bookings are never discounted (`computeDiscount`).

**The free drink:** drinks can only be added on stores in `ADDON_STORES` (Velaphi and Isiqalo). The prize screen says *"with any Workshop order"*, and "Use it now" goes to the Workshop store they last ordered from (or Isiqalo).

**What the wheel shows:** only gifts that admin marks "on the wheel" (`spin-gifts.js` `onWheel`), currently `drink`, `pct10`, `r20` and `food150`. **Rule for admin:** anything on the wheel must really be given away in some slot. For example, schedule a "Your food FREE" slot from time to time, otherwise remove it from the wheel.

## 4. Who is scanning: identity resolution

Done **server-side** (`spin-identify.js`). The browser never decides who someone is. Checked in this order:

| Step | Signal | Trust |
|---|---|---|
| 1 | Signed in (Bearer token) → `my_verified_email()` + the account's orders | Proven |
| 2 | This browser has `ss_track_links` (order id + tracking token from checkout/success) → server checks the token matches `deliveries.tracking_token` | Proven: the private link is the proof |
| 3 | "Did you order from Umzila recently?" → **Yes** → email → **last 4 digits of the phone on that order** | Proven after the phone check |
| 4 | **No, a friend gave me this** → name, email, phone (UmzilaInput checks) | Friend path |

**Rules:**
- Nothing personal (name, store, items) is shown until steps 1–3 succeed. Typing someone else's email reveals nothing.
- Wrong last-4 digits: "That doesn't match the number on the order." Max **5 failed checks per email per hour**, then "Try again later or WhatsApp us". Failed checks are counted in `spins` rows with `outcome 'check_failed'`.
- A signed-in account beats a stored tracking link. There's always a **"Not {name}? Tap here"** link, which goes to step 3.
- On success the server returns a short-lived **spin session** (HMAC-signed, email + expiry 30 min, secret `SPIN_SECRET` in Netlify env). Every later call (rate, spin) sends it, and the server never trusts an email typed again later.
- After a successful check the browser remembers the email in `umz_guest_contact` (same as checkout). It never stores the phone digits.

## 5. Eligibility (server-side, at identify time and again at spin time)

Let `E` = the verified email. "Paid order" = `orders.payment_status = 'paid'` **and** a PayFast-confirmed payment (`pf_payment_id` not null) or an R0 order completed by `complete-zero-total-order`, for `customer_email = E` or `user_id` = the verified account.

1. **Live gift:** any `spins` row for E with an unused, unexpired code → state **HAS_GIFT**. No spin; show the gift again.
2. **Order spin:** the newest paid order in the last 30 days with **no spin yet** (`spins.order_id`) → state **CAN_SPIN_ORDER** (rating, then spin).
3. **Welcome back:** no paid order in 30 days, at least one older paid order, never had a `welcome_back` spin → **CAN_SPIN_WELCOME_BACK**.
4. **Friend:** no paid order ever and never spun as a friend → **CAN_SPIN_FRIEND** (gift is first-order only).
5. Otherwise → **NEEDS_ORDER**: "Your next Umzila order unlocks a new spin 🎡", plus the last store button.

**Staff/test:** emails of admins, logistics or drivers get `test_mode`. Spins work and the code is created with `status 'disabled'`, so nothing real is given away.

## 6. Screens and wording

Mobile-first, one screen at a time, big thumbs-friendly buttons. Brand: navy `#0a2f66`, pink `#e0284f`, yellow `#ffc21a`, cream `#fbf5ec`. Fonts: Fraunces for big friendly headings, Poppins for UI (as on the printed card).

1. **Welcome (unknown visitor)**
   - "Hey! 👋 Did you order from Umzila recently?"
   - Buttons: **[Yes, I ordered]** and **[No, a friend gave me this]**.
   - Small print: "The gifts on the wheel change throughout the day. Spin to see what's waiting for you 👀"
   - The first tap here also unlocks sound (browsers block audio until a tap).
2. **Email (ordered)**
   - "What email did you order with?" (prefilled from `umz_guest_contact` if present).
   - **Not found:** "We can't find a recent order for that email." Offer "Try another email", or "Get a welcome gift instead" (friend path, only if that email never ordered).
3. **Phone check**
   - "Quick check: what are the last 4 digits of the phone number on your order?" A 4-box PIN input, numeric keyboard.
4. **Hello (personalised)**
   - "Hi Shireletso 👋"
   - Line by state:
     - order spin: *"How was your Plata for 2 from Isiqalo Kitchen?"*;
     - two stores: *"How was your order from Isiqalo & Velaphi?"*;
     - welcome back: *"It's been a while! Your favourite plate missed you 🔥"*.
5. **Rating** (order spin only; skipped if it isn't delivered yet or the store delivers itself)
   - 5 big stars, one tap. Optional "Anything we should know?" box. **[Next]**, plus a small "Skip".
   - 1–2 stars: "Sorry it wasn't great, we'll look into it 🙏", then on to the spin. The spin is **never** conditional on the rating.
   - Already rated by email: stars shown filled, "You gave us 5⭐, thank you!"
   - Saved like `rate-delivery.js`: `delivery_feedback.rating` + message, upsert per delivery, so the latest rating wins.
6. **Spin**
   - "Your spin is ready, Shireletso." The wheel, and a giant **[SPIN]** button with a pulsing glow.
   - Friend version: "Welcome to Umzila, Thandi! Here's a spin on us 🎁"
7. **Result**
   - Landing on a slice, confetti burst, a strong vibration, then a prize card flips over:
     - "🥤 You got: **a free cold drink** with your next order!"
     - the code, big, with a copy button;
     - a countdown: "Expires in 4d 23h 59m";
     - **[Use it now →]**, which goes to their last store (or the Workshop row / Isiqalo for friends).
     - "We've emailed this to s•••@gmail.com too."
   - The code is saved to `localStorage umz_promo_code` (same shape as the store promo), so checkout fills it in.
8. **Give a friend a spin** (on the result screen, under the prize)
   - "🎁 Send a friend a spin. If they order, you unlock a **mystery gift**."
   - **[Share on WhatsApp]** opens `wa.me/?text=` with their personal link `umzila.store/spin?ref=<share code>`. There's also **[Copy link]**.
   - Never mention the amount (it's a mystery until earned).
9. **Already spun (HAS_GIFT)**
   - "You already spun for your 12 Oct order 🎉 Your free drink is waiting, **2 days left**."
   - Code, countdown and [Use it now →], then "Your next order unlocks another spin."
10. **Needs an order (NEEDS_ORDER)**
    - "Your gift was used. Nice! 🙌" (or "expired") + "Your next Umzila order unlocks a new spin 🎡", with **[Order again →]**.

**Copy rules:** use their first name wherever known. Never say "random", "luck" or "odds". Never name a slot's end time. No plate-specific wording on the wheel.

## 7. The wheel: game feel

- **Rendering:** SVG wheel, 4–6 slices from `onWheel` gifts, repeated to fill 8 slices. Pointer at the top. Slice colours from the brand palette.
- **Flow on [SPIN]:**
  1. Button press animation, a "whoosh" sound, and the wheel accelerates for 400 ms.
  2. In parallel, `POST /spin-play`. The wheel keeps spinning at full speed until the answer arrives (minimum 1.2 s).
  3. With the answer (target gift), it computes a landing angle: **5–7 extra full turns** + the target slice centre ± a random offset of up to 35% of the slice width.
  4. It decelerates with a long ease-out (cubic-bezier .12,.75,.12,1), 4–5 s.
  5. **Ticks:** each slice boundary passing the pointer plays a short click (WebAudio, pitch slightly up as it slows) and `navigator.vibrate(6)` (throttled to every 40 ms or slower).
  6. **Landing:** the pointer "catches", a small bounce-back (±3°), `navigator.vibrate([40, 60, 120])`, a win chime, a screen flash, then confetti (canvas, ~2 s) and the prize card flip.
- **No fake near-misses.** The landing offset is random within the target slice. It never deliberately stops on the edge of a bigger prize.
- **Haptics:**
  - Android Chrome: Vibration API.
  - iPhone Safari has no Vibration API. Progressive enhancement: on iOS 18+ a hidden `<input type="checkbox" switch>` toggled through its `<label>` gives a light system haptic; use it for ticks (throttled) and the landing. Otherwise iPhone gets sound + shake + confetti.
- **Sound:** WebAudio-generated (no audio files). A 🔊/🔇 toggle, remembered in `localStorage`.
- **Accessibility:**
  - `prefers-reduced-motion`: 1.5 s spin, no shake, no confetti.
  - Result announced through `aria-live`.
  - Every action reachable with buttons, not gestures only.
- **Performance:** no heavy libraries. supabase-js isn't needed on this page (all calls go to functions). The page loads presence.js (label `spin`) and input-guard.js.

## 8. Gift schedule (admin)

**New admin tab: "Spin & Win"**
- **Live now:** the gift currently being given, time left in the slot, winners so far / max.
- **Default gift:** what everyone gets when no slot is running (e.g. 🥤 Free drink).
- **Slots table:** gift, start (date + time), duration (minutes), max winners (optional), winners so far, status (scheduled / live / ended / cancelled). Add, edit, cancel.
  - Example: "🤯 Your food FREE · Fri 18:00 · 30 min · max 3 winners".
  - When a slot's time ends **or** its max winners is reached, spins fall back to the default gift **automatically**.
  - Overlapping slots: the most recently created live one wins. The UI warns about overlaps.
- **Wheel:** tick which gifts appear on the wheel (from the catalogue), with a reminder that every gift on the wheel must sometimes be given.
- **Log:** latest spins (name, email, kind order/welcome-back/friend, gift, code used? / expired, order it came from, rating). Plus totals:
  - spins;
  - codes used;
  - conversion %;
  - order value from spin codes;
  - discount given.
- **Referral rewards:** sharers, friends who ordered, R20 codes issued this month.
- **Test mode:** staff spins create disabled codes (see §5).

**Picking a gift at spin time:** done atomically in Postgres, `claim_spin_gift(p_now)`:
- locks the live slot row;
- checks `winners < max_winners`;
- increments;
- returns the gift;
- with no live slot (or full), returns the default.

Two people can never both get the last "Your food FREE".

## 9. Data model

Reused (no change): `discount_codes` (the codes), `delivery_feedback` (ratings), `subscribers` (friend contact + marketing consent), `orders` / `deliveries` (eligibility, tracking-link proof), `notification_log` (not needed: email state lives on the spin row).

**Two new tables** (justified: nothing existing holds a time-slot prize schedule or the spin ↔ order link):

`spin_schedule`
- `id uuid pk`
- `gift_kind text`, checked against the catalogue kinds
- `is_default bool`; exactly one active default (partial unique index)
- `starts_at timestamptz`, `ends_at timestamptz` (null for the default)
- `max_winners int null`, `winners int default 0`
- `status text` ('scheduled'/'cancelled')
- `created_by uuid`, `created_at`

`spins`
- `id uuid pk`, `email text`, `user_id uuid null`, `name text`
- `kind text` ('order'/'welcome_back'/'friend')
- `order_id uuid null`: the order that unlocked it; unique where not null, so one spin per order
- `outcome text` ('won'/'check_failed')
- `gift_kind text`, `schedule_id uuid null`, `discount_code_id uuid null`
- `share_code text unique`: their "give a friend" code
- `referred_by_spin_id uuid null`: the friend came through this sharer's link
- `referral_rewarded_at timestamptz null`
- `rating smallint null`
- `prize_email_at`, `reminder_email_at`, `final_email_at timestamptz null`
- `test bool`, `created_at`

- **RLS:** both tables admin-read/write only (`is_admin` / active admin `user_roles`). Every buyer path goes through service-role functions.
- **Indexes:** `spins(email)`, `spins(order_id)`, `spins(share_code)`, `spin_schedule(starts_at)`.

## 10. Server functions

All use `lib/contact-check.js` for emails/phones, `lib/mail.js` `mailFrom` for sending, `lib/unsubscribe.js` on reminders, and `SITE_BASE_URL` for links.

| Function | Does |
|---|---|
| `spin-identify.js` (POST) | `{ mode: 'session' }` (Bearer) / `{ mode: 'track', order, token }` / `{ mode: 'email', email }` → `{ needsPhoneCheck }` / `{ mode: 'verify', email, last4 }`. Returns `{ spinSession, firstName, state, lastOrder: { stores[], items[], deliveryId, delivered }, gift? }`. Rate-limited as §4. |
| `spin-friend.js` (POST) | `{ name, email, phone, ref? }`: validates, rejects emails with paid orders ("Looks like you've ordered before 👀"), upserts `subscribers` (source `spin`), returns a spin session with state CAN_SPIN_FRIEND. |
| `spin-play.js` (POST) | `{ spinSession, rating?, comment? }`. Re-checks eligibility, saves the rating, calls `claim_spin_gift()`, creates the code, inserts the `spins` row, sends the **prize email**, returns `{ gift, code, expiresAt, wheelIndex, shareCode, useUrl }`. **Idempotent:** a repeat call for the same order/session returns the same result (no second spin). |
| `send-spin-emails.js` (scheduled, every 30 min) | Reminder on day 3 (`reminder_email_at`); final email from 08:00 SAST on the expiry day (`final_email_at`). Skips used codes, test spins and unsubscribed emails. Also grants **referral rewards** (§11). |
| `spin-admin.js` | Admin-only (verify admin from the Bearer token): schedule CRUD, live status, log and totals. |

Plus:
- **`lib/discounts.js` (small fix):** `first_order_only` is today only checked for signed-in users. Also check guests by email (any paid order with that `customer_email`). This matters for friend codes. It changes nothing for existing codes, which are all email-locked or first-order by account.
- **`netlify.toml`:** remove the `/spin` 302 and add `from "/spin" to "/spin.html" status 200` (before `/:slug`).

## 11. Give a friend a spin: referral reward

1. A sharer's link is `umzila.store/spin?ref=<share_code>`. The friend lands on `/spin`, and `ref` is kept through the friend flow onto their `spins.referred_by_spin_id`.
2. The reward is granted by `send-spin-emails.js` (no change to the payment code) when **all** of these hold:
   - the friend's spin code was used on a paid order (`discount_codes.used = true`);
   - the friend had no paid order before their spin (guaranteed by the friend path);
   - the friend's phone ≠ the sharer's phone;
   - the sharer has < 5 rewards this calendar month (D5);
   - the sharer isn't already rewarded for this friend (`referral_rewarded_at`).
3. **The reward:** a `discount_codes` row:
   - `type 'fixed'`, `amount 20`, `min_order_amount 60`;
   - `email` = sharer, 30-day expiry;
   - **`multi_use true`, `max_redemptions 1`, `per_user_limit 1`**, so it can only be used **signed in** (existing multi-use rule; checkout shows its inline create-password / sign-in panel).
4. **The email:** "🎁 Your mystery gift is here: **R20 off**, because Thandi just placed her first order." Its button goes to checkout/sign-in with the code. If the sharer has no account: "Create your account with this email to unlock it" (the auth-mail.js panel handles confirmation).

## 12. Emails

All personalised by first name, from `mailFrom('Umzila', 'hello')`.
- **Transactional:** the prize email (they asked for it).
- **Marketing-style, with the unsubscribe link + headers:** the reminders.

| Email | When | Subject (example) | Body essentials |
|---|---|---|---|
| Prize | Right after the spin | "🥤 Shireletso, your free drink is waiting" | Gift, code, how to use it (3 steps), expiry date, [Use it now →], "Send a friend a spin" link |
| Reminder | Day 3, if unused | "2 days left on your gift, Shireletso" | Same, with "2 days left" |
| Final | Expiry day 08:00 SAST, if unused | "Last day! Your gift ends tonight at midnight" | Urgent, single button |
| Referral reward | When earned | "🎁 Your mystery gift is here" | R20 code, sign-in link |

Links carry `?src=spin-email` (prize/reminders) for attribution. Gmail Promotions annotations (DiscountOffer JSON-LD), as in the promo emails.

## 13. Scenarios and what happens (all edge cases)

**Identity**
- **Signed in + recent order** → straight to Hello/Rating.
- **Signed in, but ordered as a guest with another email** → "We can't find a recent order on this account. Ordered with a different email?" → email + phone check.
- **Same browser, not signed in** → `ss_track_links` proves it → straight in.
- **New browser, not signed in** → email + last 4 digits.
- **Shared phone** → recognises the other person → "Not Thandi?" → email + phone check.
- **Email typo** → UmzilaInput suggestion; not found → try again or the friend path.

**Eligibility**
- **Recent order, never spun** → spin.
- **Already spun for that order, scans again** → HAS_GIFT (or NEEDS_ORDER if used/expired).
- **Two orders since the last spin while the gift is still live** → no new spin until it's used or expired, then the newest unspun order within 30 days unlocks one.
- **Last order > 30 days, never had a welcome-back spin** → welcome-back spin (once ever).
- **Last order > 30 days, already had a welcome-back spin** → NEEDS_ORDER.
- **Paid but not delivered yet** → spin without the rating ("rate it once it arrives").
- **Refunded/cancelled/pending-only orders** → don't count.
- **Never ordered** → friend path.
- **Friend path but the email has orders** → back to the ordered path.
- **Staff** → test mode.

**Rating**
- **Low rating** → apology, still spins, an admin alert like the rating email's.
- **Skip** → allowed.
- **Already rated** → shown filled.
- **Order from two stores** → one rating per delivery (one question, saved per delivery).
- **Store delivers itself (no delivery row)** → rating skipped.

**Gifts/codes**
- **Free drink at a store without drinks** → the wording says "with any Workshop order"; the button goes to a Workshop store.
- **R20 on an order under R60** → checkout's normal "below minimum" message.
- **They also hold a store promo code** → checkout takes one code. The prize screen and email say "One code per order, use whichever saves you more".
- **Items already on special** → v1: spin gifts apply to all items, Umzila pays. *Open: exclude specials per gift?*
- **Services/bookings** → never discounted (existing rule). Nceks customers' "Use it now" goes to the home page.
- **Code used at checkout but payment abandoned** → stays usable (codes only count as used on payment).
- **Expiry** → day 5, 23:59 SAST.

**Schedule**
- **Slot changes while they're on the page** → the server decides at the spin moment.
- **Two people spin for the last "food free"** → the database lock gives it to one; the other gets the default.
- **Admin changes the gift after someone spun** → their gift and emails stay what they won.
- **No default set** → fallback to `drink` (hard-coded), and admin shows a warning.

**Technical**
- **Double-tap or refresh mid-spin** → idempotent: shows the same result.
- **Network fails mid-spin** → the wheel keeps going up to 10 s, then "Couldn't spin, tap to try again". Nothing is used up unless the server recorded it.
- **Bots/spam** → rate limits + identity checks + one live gift per email.
- **iPhone** → sound/visual haptics (see §7).
- **Sound blocked** → the first tap unlocks it.
- **Stores closed at scan time** → "Use it now" still works; store pages already say "made when it opens".

**Referral**
- **Friend never orders** → nothing.
- **Friend already a customer** → no reward.
- **Same phone as the sharer** → no reward.
- **6th reward in a month** → not granted, silently.
- **Sharer without an account** → the reward email explains how to create one.

## 14. Tracking and analytics

- **Presence:** the page calls `umzilaPresence.start('spin')`. Card scans arrive with `src=card` (QR) and are kept 30 days by presence.js.
- **Orders using a SPIN… code** count as spin conversions. Admin → Spin & Win shows the funnel:

  scans → identified → rated → spun → code used → order value

## 15. Build order (suggested)

1. DB: `spin_schedule`, `spins`, `claim_spin_gift()`, RLS; the `lib/discounts.js` guest first-order fix.
2. `lib/spin-gifts.js` + `spin-identify.js` + `spin-friend.js` + `spin-play.js` (prize email).
3. `spin.html`: screens, wheel, sound/haptics, share. Swap the `/spin` redirect for the page.
4. Admin "Spin & Win" tab (schedule, live, log, totals) + `spin-admin.js`.
5. `send-spin-emails.js` (reminders, final, referral rewards) + `netlify.toml` schedule.
6. QA with real functions, emails off, test emails only. Every scenario in §13. Headless screenshots at 390 px; Android vibration checked on a real phone by the founder.
7. Docs: turn this spec into `docs/systems/spin-wheel.md` (what was built), plus CHANGELOG and CLAUDE.md.

## 16. Open questions (small; defaults chosen)

- **Items on special:** excluded from spin gifts? *Default: no exclusion.*
- **Phase 2:** free delivery as a gift kind (needs a delivery-discount code type).
- **Should welcome-back customers who never ordered in-app (cash/manual orders) count?** *Default: no, PayFast/R0-confirmed orders only.*
