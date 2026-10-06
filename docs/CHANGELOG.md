# Changelog

Dated log of drastic/significant changes — bug fixes touching core flows (checkout, cart, payments, auth, seller system), multi-file fixes, and new features. Newest first. See `CLAUDE.md`'s "Change Documentation & System Notes" section for when an entry here is required, and `docs/systems/` for full prose write-ups of whole systems.

---

## 2026-10-06 — Card nicknames: automatic default at checkout, rename in profile

**Asked for (founder):** buyers never fill in the card nickname box. Give it an automatic name they can change.

**Changes:**
- `checkout.html`:
  - the nickname box is pre-filled with "<First name>'s card" ("… card 2", "card 3" when the account already has cards; "My card" before a name is typed) and follows the first-name field until the buyer edits it (`defaultCardName`/`refreshDefaultCardName`, `data-touched`);
  - an emptied box saves the default, so a saved card is never nameless.
- `profile.html` → **Saved cards**: lists the account's cards (name, added, last used) with **Rename**. The token is never shown.
- New RPC `rename_my_payment_method(id, name)`: own card only, trimmed, max 40 characters, blank resets the name. `payment_methods` keeps no UPDATE policy, so tokens stay unwritable from the browser.

**Verified:**
- Checkout step 2 showed "Thandi's card" after typing "thandi"; once the buyer typed "Capitec debit", a later first-name change didn't overwrite it.
- RPC (rolled back): own card renamed (trimmed); another user's card refused and unchanged.

**Files:** `checkout.html`, `profile.html`. **Migration:** `rename_my_payment_method`.

---

## 2026-10-06 — Guests can save their card (added to their account once they sign in)

**Asked for (founder):** a guest who pays, then signs in, should never have to type card details again.

**How it works now:**
- **Checkout** shows "Save this card" to everyone again (on by default). Guests see: "Pay in one tap next time you sign in with this email."
- **`generate-payfast-signature.js` guest path (the only PayFast change):** a guest may now request `subscription_type=2` (PayFast ad-hoc card token) and nothing else. Mode 1 (fixed recurring) and any `billing_date`/`recurring_amount`/`frequency`/`cycles` are still refused. Field order, encoding and signing are untouched.
- **After payment** (`complete-order-payment.js`, unchanged):
  - the token is saved on the order (`pf_response`);
  - if that email already belongs to a **confirmed** account, the card goes straight into its saved cards;
  - otherwise `claim_my_email_orders()` adds it, with the nickname, when they sign in with the email confirmed.
- **Checkout runs the claim** before loading saved cards, so a guest who signs in and goes straight to checkout sees the card at once. Before, the claim ran only on the home, profile and track pages.

**Verified:**
- Signer tested against a real pending guest order:
  - no save-card: 200, signature **identical** to the live function;
  - mode 2: 200, signed with `subscription_type=2`;
  - mode 1: 401; mode 2 + `recurring_amount`: 401; wrong amount: 401.
- Claim tested in a rolled-back transaction: a paid guest order with a token and the email of a confirmed account → card added to that account with its nickname.

**Safety net:** if signing ever fails while a card token is requested, `submitToPayFast` signs again without it, so the buyer pays and the card just isn't saved. A save-card problem can no longer cost a sale (the 2026-10-06 morning incident).

**Not testable without a real card:** PayFast returning a token for a guest payment. Signed-in tokenization already works live, and the guest request is byte-for-byte the same request.

**Files:** `netlify/functions/generate-payfast-signature.js` (guest guard only), `checkout.html`.

---

## 2026-10-06 — Guest checkout matrix on the live site; existing-account emails no longer block; one-tap per-store checkout

**Asked for (founder):** make sure every guest can check out. Test all cases and edge cases.

**Tested live** (headless browser, real data, stopped at the PayFast redirect; nothing paid):
- **PASS:**
  - phone, store-page checkout (R70 plate + delivery);
  - one store, 2 items, tip + note;
  - priority delivery;
  - 5 rapid Pay taps (exactly 1 order);
  - address typed without picking a suggestion;
  - outside the delivery area (blocked, no order);
  - Nceks ride booking (no address);
  - Nceks gift voucher.
- **Every PASS case:** signature 200, no `subscription_type`, the button showed "Checking your order…" on the first tap, no console errors.

**Bugs found and fixed (`checkout.html`):**
1. **An email that already has an account blocked the guest completely.**
   - Checkout demanded the password, and Pay then failed silently: the error was written into the hidden step-1 box.
   - Anyone who forgot their password, or never confirmed the account, could not buy.
   - Now signing in is optional ("Welcome back — sign in, or just carry on as a guest"), and a blank password means guest checkout. The order can be claimed into the account later via the confirmed-email claim.
   - A failed sign-in now also shows next to Pay.
2. **"Stores too far apart for one delivery" was a dead end** ("open the store and use its cart"). It now lists one-tap "Check out <store> only · R…" buttons (`checkout.html?store=<id>`). The other lines stay in the cart.

**Re-run after deploying `1e995e8`: all 10 PASS.** The existing-account email reached PayFast as a guest; the multi-store cart showed "Check out Velaphi Shisanyama only · R70.00" / "Check out Sweet Corner only · R16.95", and the first one went through to PayFast. The 18 test orders, 2 Nceks holds and 25 test baskets were deleted afterwards. The harness is kept as `docs/qa-guest-checkout.e2e.js` (run with `B=<site> node …` from a folder with puppeteer-core); re-run it after any checkout change.

**Not covered:** signed-in checkout (no test credentials; that path was not changed) and a wrong password for an existing account.

---

## 2026-10-06 — URGENT: guests could not pay ("Failed to obtain signed PayFast parameters")

**Reported (founder, live customer):** a guest checkout failed at Pay three times (3 pending R109.28 orders).

**Root cause:** the "Save this card" switch is on by default and was shown to guests too. Checkout then sent `subscription_type=2` (card token). `generate-payfast-signature.js` refuses any guest payment that asks for a token (401, by design: guest path rule "no card tokenization"), so every guest with the default switch on was blocked. The two were changed separately (pay-panel redesign vs. guest checkout) and never tested together for a guest.

**Fix (`checkout.html` only; the PayFast function is untouched):**
- The save-card switch and nickname show only to signed-in buyers.
- `subscription_type` and `pending_card_name` are sent only when signed in.

**Verified against the live signer with the customer's real order:** with `subscription_type`: 401; without it: 200.

**Gotcha for later:** any guest-visible option that adds PayFast fields must be checked against the guest path in `generate-payfast-signature.js` (amount must equal the re-pricing; no tokenization).

---

## 2026-10-06 — Mystery-gift email follows the guest's baskets

**Asked for (founder):** many guests type their email into the mystery-gift popup. Remember them from that point, so any basket they start later shows with their details, before they reach checkout.

**Changes:**
- `presence.js` remembers the guest's details on the browser (localStorage `umz_guest_contact`) and sends them with every basket save.
- `umzilaGuestContact()` now merges details: the popup gives an email, checkout adds a name and phone.
- `index.html`: a valid email in the popup calls `umzilaGuestContact({email})`.
- The popup line "We'll only use this for your gift" became "We'll use this for your gift and to keep your basket handy if you shop", so the promise stays true.
- Signed-in visitors are unaffected; the server ignores guest saves when signed in.

**Verified (local):** email given first, then a plate added later on the Velaphi page: the basket was saved with that email.

**Files:** `presence.js`, `index.html`.

---

## 2026-10-06 — Baskets tidy-up: 30-day window + nightly cleanup of expired guest baskets

**Asked for (founder):** keep logistics → Baskets from filling up with long-abandoned carts.

**Changes:**
- **Logistics → Baskets** lists only baskets changed in the last 30 days (`logistics.html` loadBaskets).
- **New pg_cron job** `delete-expired-guest-baskets` (daily 01:15 UTC) deletes guest baskets (`user_id` NULL) past `expires_at`. `save_guest_cart` sets that to 30 days after the last change.
- Signed-in buyers' carts are never deleted.

**Files:** `logistics.html`. **Migration:** `guest_baskets_cleanup_cron`.

---

## 2026-10-05 — Seller dashboard: delivered orders now move from Active to Past

**Reported (founder):** completed orders never leave "Active orders" on the seller dashboard.

**Root cause:** Past required this seller's `order_item_statuses` rows to be `delivered` **and** buyer-confirmed. On delivery-network orders the rider's PIN marks the *delivery* `DELIVERED` (`confirm-delivery-pin.js`) and never touches those rows, so no network order could ever become Past. The two lists also used different rules: Past checked only the item rows, while Active excluded an order only when both conditions held.

**Fix (`seller-dashboard.html`):** a single `isPastOrder()` drives both lists. An order is past when:
- its delivery is `DELIVERED`, `CANCELLED` or `RETURNED`; or
- the order is `Returned`; or
- it has no delivery row (e.g. self-arranged stores) and meets the old rule: delivered and buyer-confirmed.

The Past list labels each order Delivered, Cancelled or Returned.

**Parked on purpose (founder):** the service acceptance-window rework (about a 4 h window inside opening hours, reminders, alert staff instead of silently cancelling on expiry, instant confirm where possible). No accept-type services are expected for now. The `expire-overdue-service-acceptances` cron still cancels paid, unaccepted services after 24 h **without telling anyone or refunding**. Fix that before those services go live.

---

## 2026-10-05 — After-hours orders explained end to end; guest baskets, anonymous baskets and unfinished payments for staff

**Asked for (founder):** fix the after-hours gaps; show guest baskets (with contact details from checkout, and anonymous ones) plus unfinished payments to staff.

**After-hours, root cause:** the only after-hours handling was checkout's "store is closed" popup when Pay is pressed. Everything else ignored it:
- the checkout delivery target still promised "about 35 min";
- the success page, confirmation email and tracking page said nothing about the wait;
- admin/logistics flagged the overnight order as "Store not ready after 45 min".

**After-hours changes:**
- `checkout.html`:
  - the delivery target becomes "<Store> is closed — your order is made when it opens tomorrow at 09:00. You can still order now. Delivery takes about N min once it's ready." Opening hours are fetched with the seller info in `updateEstimatedDelivery`, and only for goods; services never get closed messaging.
  - The Pay path no longer waits on `updateEstimatedDelivery`, and the closed-store dialog reuses the store names already loaded (one less query on the Pay tap).
  - Agreeing to the dialog saves `ss_closed_order_note` for the success page; a fresh checkout clears it.
- `checkout-success.html` shows the note: "<Store> is closed right now and opens Tuesday 09:00. Your order is made when the store opens…".
- The confirmation email (`lib/complete-order-payment.js`, email content only, in its own try/catch; nothing about payment changed) adds the same note when a goods store is closed at payment time.
- New SQL helper `order_closed_store(order_id)` (internal) returns the closed goods store on an order that opens last. It feeds:
  - `get_delivery_tracking`, which now also returns `store_closed_name` / `store_opens_at` while the delivery is still PENDING. `track.html` then says "<Store> is closed right now — your order is safe and paid. It's made when the store opens (Tuesday 09:00)…".
  - `get_ops_board`, whose deliveries carry `store_closed` / `store_opens_at`. Admin Live now and the logistics Today board show "Store closed · opens Tue 09:00" and no longer count it as needing attention.

**Baskets, root cause:**
- guest carts only lived in the guest's browser;
- logistics Baskets read only signed-in buyers' `carts` rows;
- the Orders list hides `pending_payment` orders, so nobody saw people who pressed Pay and never paid.

**Baskets changes** (existing `carts` table, no new table):
- New columns `anonymous_id` (unique when set), `guest_email`, `guest_name` and `guest_phone`, plus a check that a row has a user or an anonymous id.
- A guest basket is written only through `save_guest_cart()`:
  - it is anon-callable and ignored when signed in;
  - it validates the id, size, email and lengths, and converts browser-shape items to the server shape;
  - an empty cart deletes the row.
- `clear_guest_cart()` clears it, and trigger `clear_guest_carts_on_paid` removes that email's guest baskets when an order turns paid.
- `presence.js` mirrors `ss_cart` for guests on every buyer page, only when it changed (`umz_cart_synced`; 5 s check plus storage events). For signed-in buyers it clears the guest row instead.
- Checkout attaches the details as they're typed (`umzilaGuestContact`), with a line under the email field: "We keep your basket with these details so we can help if your order doesn't go through."
- logistics → Baskets & unfinished payments, three lists:
  - 💳 Unfinished payments: `pending_payment` orders from the last 14 days, guests included, hidden once that email has paid since;
  - 🛒 Baskets with contact details: account or guest;
  - 👀 Anonymous baskets.

  Each item has a tap-to-email and tap-to-call link and Send Nudge where there's an email.

**Verified (local, real data):**
- Velaphi closed at night: the checkout strip showed "Velaphi Shisanyama is closed — your order is made when it opens tomorrow at 09:00".
- The success note rendered.
- `order_closed_store` returned Velaphi / 09:00 SAST for Velaphi orders.
- `get_ops_board` returns the new keys.
- A guest basket was saved within seconds and gained name, email and phone once typed. Invalid ids were ignored. Test rows were deleted.

**Not yet tested in the browser:** the logistics Baskets screen itself (it needs a staff sign-in); its syntax and queries were checked.

**Files:** `checkout.html`, `checkout-success.html`, `track.html`, `admin.html`, `logistics.html`, `presence.js`, `netlify/functions/lib/complete-order-payment.js` (email only).

**Migrations:** `guest_baskets_in_carts`, `after_hours_tracking`, `ops_board_store_closed`.

---

## 2026-10-05 — Buttons never look dead: instant Pay feedback, instant cart updates, page-switch bar

**Reported (founder):** in checkout the Pay button (and others) sometimes takes very long, with nothing visible happening, so they tap again and again. They want it faster, or at least a loading state, and the same for switching between stores and the home page.

**Root causes:**
- **Pay looked dead for the first steps.** The Pay button only showed its spinner *after* the account check, the store-hours check (2 queries) and saving the shipping details. Before that the button looked unchanged.
- **Extra taps could re-run the flow.** Only the order step was guarded, so extra taps re-ran the account step.
- **Cold starts landed on the Pay tap.** The first call to `generate-payfast-signature` after a quiet spell pays a cold start of about 1–2 s.
- **Back from PayFast left the button stuck.** Pressing back from PayFast restored the page with the button still disabled.
- **Cart buttons waited on the server.** Every + / − / remove / size change on cart.html waited for the account cart save AND a `validate-cart` call before the screen changed.

**Changes:**
- **checkout.html Pay buttons** (new card and saved card, desktop and mobile):
  - `setPayStage()` turns the button into a spinner with a label on the very first tap: "Checking your order…" → "Securing your order…" → "Opening secure payment…" (or "Charging your card…" → "Paid ✓");
  - `payBusy` ignores every extra tap;
  - `finally` restores the button unless the page is leaving;
  - `pageshow` (back from PayFast) un-sticks it;
  - the label sync no longer overwrites a stage label.
- **Function warm-up:** checkout sends a no-op GET to the payment functions on load (`generate-payfast-signature`, `validate-cart`, `get-delivery-quote`, `charge-payfast-token`) to warm them up, so the Pay tap doesn't pay the cold start. The PayFast functions are untouched; a GET returns 405 before doing anything.
- **cart.html:**
  - quantity, size and remove update the screen and the local cart instantly (measured 70 ms);
  - the account-cart save and the code re-check run in the background, collapsed for rapid taps;
  - "Proceed to Checkout" shows "Opening checkout…" with a spinner while it finishes any pending save.
- **presence.js:** a thin top progress bar appears the moment any link to another Umzila page is tapped (store ↔ home, back arrows, Check out). `umzilaNavigating()` shows the same bar for JS redirects (script.js, cart.html).

**Verified (local):**
- Pay reacts on the first tap with "Checking your order…".
- 3 rapid taps ran the flow once, and the button restored after a failed validation.
- The cart + updated in 70 ms, and the checkout button showed its busy state.
- The nav bar appears on link taps.
- No page errors.

**Files:** `checkout.html`, `cart.html`, `presence.js`, `script.js`.

---

## 2026-10-05 — Store pages served from the CDN; store visitor tracking (Nceks included); double-counted clicks fixed

**Asked for (founder):** cache the store pages next. They also couldn't see users on Nceks's custom store.

**Root causes:**
- **No tracking on store pages.** The live counter already worked on Nceks, but store pages (`shop.html` and bespoke storefronts) don't load `script.js`, so they never recorded a store visit, a product open or an add-to-cart. Admin and the store owner had no way to see who visited a store.
- **Every click and add was counted twice.** `script.js` `trackEvent` inserted every `product_click` / `add_to_cart` into `user_events` itself AND through `track-engagement.js`. 110 of the last 114 such events were pairs.

**Changes** (details in [docs/systems/site-speed.md](systems/site-speed.md)):
- New `netlify/functions/get-store.js`: one store's public profile, products, hours rows, open/closed status and sponsored ids, CDN-cached for 60 s per slug.
  - `shop.html` and `ncekeniquads/index.html` fetch it in parallel with the config, keep their direct-query fallbacks, and re-check open/closed live.
  - It returns only public seller columns. `shop.html` used to read `sellers.*`, which includes the owner's email and pickup pin.
- `presence.js` `umzilaTrack()` records `store_view`, `product_click` and `add_to_cart` on both store pages. Counter events go only through `track-engagement`.
- `script.js` no longer double-inserts counter events, and the historical duplicates were removed.
- Where it shows:
  - admin Sellers intelligence: "Store visits (30d)" with distinct people;
  - admin Live now: store names instead of slugs;
  - seller dashboard → Analytics → "Store visitors" (on your store now, 7- and 30-day visitors, 30-day visits) via the new `get_my_store_traffic()`, own stores only.

**Verified (local, real data):**
- Velaphi store: `get-store` loaded, then one `store_view` row, one `product_click` and one `add_to_cart`, each logged once.
- Nceks loads its rides and records a `store_view`.
- The legacy `?shop=` link uses the direct path.
- An unknown slug shows "Store not found", and a malformed slug gets a 400.
- `get_my_store_traffic` works for the Nceks owner and refuses another store.
- No page errors.

**Files:**
- New: `netlify/functions/get-store.js`.
- Changed: `shop.html`, `ncekeniquads/index.html`, `presence.js`, `script.js`, `admin.html`, `netlify/functions/admin-analytics.js`, `seller-dashboard.html`.
- Migrations: `user_events_dedupe_double_logged_clicks`, `live_visitors_store_names`, `get_my_store_traffic`.

---

## 2026-10-05 — Speed for 2,000+ visitors: WebP images, CDN catalogue, skeletons, live visitor counter

**Asked for (founder):** could Umzila handle 2,000 people at once? Can admin see how many people are on the site right now, signed in or not? Make everything as fast as possible without breaking anything. (They thought the images were already WebP. Only the Velaphi/Nceks designed images were.)

**Root causes:**
- **Images:** 361 of the store images were PNGs of 1–3 MB (about 590 KB on average), and cards loaded them full size. That's 8–10 MB of Supabase egress per home visit; the free plan allows 5 GB a month.
- **Database calls:** about 14 Supabase calls per home visit, some sequential:
  - the catalogue join and all variants;
  - 6 filter queries, 2 of them always 400 (`products.type` / `color` don't exist);
  - stores, a product count and 3 ad reads.
- **Waiting before loading:**
  - every page waited on an uncached Netlify function (`get-client-config`) before loading anything;
  - index.html loaded supabase-js twice, once render-blocking in `<head>`, unpinned and so only briefly cached;
  - the 3840 px hero images were up to 470 KB.

**Changes** (full write-up: [docs/systems/site-speed.md](systems/site-speed.md)):
- **Images:**
  - all 444 referenced images converted to WebP (`<name>.w1280.webp`, plus a `.w480.webp` card thumbnail; banners `.w1600`, logos `.w512`): 214.7 MB → 16.6 MB, and 690 rows switched;
  - originals kept, with the rollback map in `docs/design/product-images/optimize-map-2026-10-05.json`;
  - cards, suggestions, small thumbnails, cart/checkout/profile thumbnails and store-page cards load the 480 px thumbnail (`thumbUrl`, with a fallback to the full image);
  - new uploads (seller dashboard and admin) are shrunk in the browser by `image-upload.js`, with unique names and a 1-year cache.
- **Security fix found on the way:** any signed-in user could overwrite any file in `shop-assets`. Writes are now only for that store's owners (`my_seller_ids()`) or admins.
- **Catalogue:**
  - new `get-catalog.js` is CDN-cached for 60 s and returns products, variants, stores and ads;
  - the download starts as `script.js` parses, and it feeds `loadProducts`, the filters, the sponsored boost and Featured Shops, each with a fallback to its old query;
  - a guest home visit now makes **1** Supabase call (the visitor heartbeat), down from about 14.
- **Config:** `get-client-config` is CDN-cached, so there is no function cold start per page.
- **index.html:** supabase-js is pinned to `@2.117.2` everywhere, so it's cached for a year. The `<head>` preloads supabase-js, the config, the catalogue and the first hero slide, and the blocking duplicate is gone.
- **Skeletons:** the 3 curated rows show skeleton cards until the products arrive, and the always-hidden legacy rows no longer flash their headings.
- **Hero images:** shrunk to 1600 px (92 KB / 134 KB); `umzila.webp` went to 480 px (8 KB). Hero slides after the first load after the page; `netlify.toml` caches the site images.
- **Live visitor counter:**
  - `presence.js` sends a heartbeat on every buyer page to `touch_presence`, which writes the UNLOGGED `site_presence` table;
  - `get_live_visitors()` is staff-only;
  - admin → Live now shows "N on the site now · X signed in · Y guests" plus the top pages.

**Verified (local, real data, throttled phone):**
- Home shows skeletons immediately and real cards next, with no page errors.
- Cards request `.w480.webp` and the product modal the `.w1280.webp`.
- The guest home made exactly one Supabase REST call.
- The store page loads the thumbnails.
- `image-upload.js` turned a 9.6 MB PNG into a 205 KB WebP plus a 6 KB thumbnail; a video was uploaded untouched.
- Storage policy: own store folder allowed, another store's folder refused.
- `get_live_visitors` counted the test browsers by page; anon can't call it or read the table.

**Follow-up fix after deploy:**
- **Symptom:** live card photos stayed as placeholders.
- **Cause:** with the config and catalogue preloaded, the first render now happens *before* DOMContentLoaded, where `setupLazyLoading()` wraps `renderAll`, so those images were never observed.
- **Fix:** `setupLazyLoading()` now also observes the `img[data-src]` already on the page.

**Files:**
- New: `netlify/functions/get-catalog.js`, `presence.js`, `image-upload.js`, `docs/design/product-images/optimize-all.js`, `docs/systems/site-speed.md`.
- Changed: `netlify/functions/get-client-config.js`, `script.js`, `index.html`, `style.css`, `shop.html`, `cart.html`, `checkout.html`, `checkout-success.html`, `profile.html`, `track.html`, `ncekeniquads/index.html`, `seller-dashboard.html`, `admin.html`, `netlify.toml`, every page's supabase-js tag, hero/logo images.
- Migrations: `site_presence_live_visitors`, `site_presence_revoke_anon_read`, `shop_assets_owner_only_writes`.

---

## 2026-10-05 — Curated home page: Velaphi plates are the star, Nceks the experience

**Asked for (founder):** Velaphi items rank higher and other stores lower (except Nceks); the home page looked cluttered (hair, then noodles, then a R100 plate). Plates should be the star; rename rows to highlight "Workshop Shisanyama" and "Xperience of a lifetime with Nceks"; "Under R100" should be items that complement the store (e.g. Milky Pie), not a random tub of oats. Fewer, curated rows.

**Changes (`script.js` `HOME_CURATION`, `index.html`, `style.css`):**
- **Home rows**, down from 11 generic rows to 3 curated ones:
  - **🔥 Workshop Shisanyama** (Velaphi, cheapest plate first, "Order from Velaphi →");
  - **🏍️ Xperience of a lifetime with Nceks** (rides, then gift vouchers, "Book a ride →");
  - **🥤 Under R100 — goes with your plate** (Velaphi's under-R100 plates, then desserts, drinks, snacks).
- The other rows (Hot Deals, Trending, New Drops, Back to School, Best Sellers, Clothing, Food, Services, Accessories, Beauty) are hidden; their code is kept. Other stores are reached through Featured Shops / All Shops, the category bubbles and search.
- **Ranking everywhere:** `computeScore()` adds `storeBoost()` (Velaphi +1000, Nceks +600), so they lead in search, categories, "See all" and the default "popular" sort. Featured Shops lists Velaphi, then Nceks, first.
- **Hero carousel:** trimmed to the Velaphi and Nceks slides. The laundry slide linked to "FreshFold", which isn't on Umzila. The Hot Deals bubble now opens the full Hot Deals list (its row is hidden).
- **Bug avoided:** `showFilteredView()` hides home rows by a fixed list, so the new rows were added to it (otherwise they'd sit above search/category results).

**Verified (headless, local, real products):**
- Phone and desktop show the 3 rows in order, Featured Shops leads with Velaphi and Nceks, and "goes with your plate" starts with the R70 plate, then Milky Pie.
- Food category lists all Velaphi plates first; the rows hide in results and return on Back. No page errors.

**Fix (same day):** "Book a ride →" / "Order from Velaphi →" showed an "All items" list (plates) instead of the store page — the global `.section-see-more` click handler intercepted every link with that class. It now ignores links without `data-section`.

**Note:** the "BEEF & WORS + 4 wings" plate is hidden as sold out — its product stock is 50 but its "One Size" option stock is 0 (sold-out rule uses the option). Left as the seller set it.

**Files:** `script.js`, `index.html`, `style.css`.

---

## 2026-10-05 — Multi-drop edge cases tested; orders offered to an on-trip rider when nobody else is free

**Asked for (founder):** test edge cases:
- new / returning-not-signed-in / signed-in buyers;
- orders arriving minutes apart (while the rider heads to the store, while at the store, ~10 min after collecting);
- "while it's still us delivering, we should be able to accept an order as it comes in, no matter where we are or how many orders".

**Change:** `lib/batch-dispatch.js#offerDelivery()` is the one rule for offering a ready order, used by Mark Ready (`advance-delivery-on-fulfillment.js`) and every heartbeat sweep:
1. add it to a trip under the normal rules;
2. else a free rider;
3. else — no free rider — offer it to an on-trip rider anyway (**relaxed**: no 5-order or 60-min cap; existing customers keep the 8-min protection; with 5+ orders the new stops go at the end).

`respond-to-driver-offer.js` re-plans relaxed offers in the same mode. Rider screen: an order added while the rider is already at the store joins the visit (no second "I'm at the store").

**Verified — one simulated shift, real database + real function code** (real payment-completion path `completeOrderPayment`, real `driver-heartbeat` for rider movement + sweeps, rider token mocked in-process; test rows removed; rider, product stock and the test buyer's saved cart restored). **32/32:**
- **Buyers:**
  - new guest: delivery created, no account, private-link tracking, checkout note visible;
  - returning buyer not signed in: order + delivery linked to their verified account;
  - signed-in buyer: delivery on their account.
- **Timing:**
  - order 2 added while the rider is still heading to the store;
  - order 3 added while the rider is at the store, joining the same visit;
  - partial collection;
  - order 4 ~10 min after collecting while driving → offered (relaxed) and accepted, the drop in progress kept first, back to the store before its drop.
- **Rider choices and safety:**
  - a declined order is not pushed back onto that rider;
  - two simultaneous sweeps → exactly one offer;
  - a stale screen gets 409;
  - a wrong PIN is refused.
- **Customers:** each saw the live map only on their own turn, "order/s ahead" while waiting; all 4 delivered with their own PINs; trip completed; rider paid for 4 deliveries (R139.28).
- **Regression:** founder scenario 29/29 and planner units 8/8 still pass.

**Files:** `netlify/functions/lib/{batch-dispatch,route-insertion}.js`, `netlify/functions/{advance-delivery-on-fulfillment,respond-to-driver-offer}.js`, `logistics.html`, `docs/systems/ops-panels.md`.

---

## 2026-10-05 — Multi-drop trips: riders carry up to 5 orders; priority delivery at checkout

**Asked for (founder):** riders take several orders per trip (win on volume), following the delivery spec (§31–35: optional additions, insertion points, underway riders). Rules confirmed:
- up to 5 orders per trip;
- an added order may make anyone already on the trip at most **8 min** later;
- the rider earns the full delivery price per added order;
- orders at one store are collected in one visit;
- drop-off order is the most efficient whole trip (not simply closest first);
- priority goes first unless a close drop costs it ≤ 8 min.

Customer side:
- A waiting customer sees "picked up" plus "There is an order/s ahead of you" (no count; not for priority).
- The live map appears only once the rider is heading to *them*.
- Priority must be easy to add and visible, with a **?** saying only that it arrives first.

**Was:** batching appended to the end of a moving rider's route, but `advance-route.js` and the rider screen handled one delivery per route, so an added order got stuck. On 2026-10-04 it was switched off and busy riders were skipped.

**Now:** see [docs/systems/ops-panels.md — Multi-drop trips](systems/ops-panels.md).
- `advance-route.js` is stop-driven (current stop, same-store visit groups, `stopId` guard).
- New `lib/route-insertion.js` planner (whole-trip optimisation, 8-min rule, priority rule, 5-order cap).
- `lib/road-distance.js#getRoadMatrix` (one ORS matrix call, every pair cached).
- `lib/batch-dispatch.js` uses the planner, has `sweepWaitingDeliveries()`, and is ON again.
- `respond-to-driver-offer.js` re-plans and applies on accept, then immediately offers other waiting orders to this rider (two orders from one store reach one rider within seconds).
- `driver-heartbeat.js` runs the sweep.
- Rider screen: "Trip · N orders · Stop x of y", the store visit with one bag per customer's full name, "Then" list, "Add to your trip" offer at the top.
- Tracking: per-order stops, `orders_ahead`, "Order picked up".
- Checkout: priority toggle + **?**.
- Logistics Today: "On a trip · N orders".

**Verified:**
- Planner unit runs: same-store merge; opposite directions; 8-min rule; priority close/far; 6th order refused.
- Rolled-back SQL: `apply_route_sequence` re-orders and refuses to move a started stop or drop one.
- **End-to-end on the real database and real function code** (rider token mocked in-process; test rows removed; rider restored):
  - **Founder's scenario:** 29/29 — offer A → accept → B offered as an addition at once → accept → A,B collected in one visit → near A first → B "picked up · order/s ahead", no rider visible → A live → A's PIN → B "heading your way" + live → B's PIN → trip done, rider paid R70.
  - **Priority variant:** 29/29 — far priority B delivered first, A sees "ahead", rider paid R70 (priority fee kept by Umzila).
  - **5-order trip:** a 6th order not added, all 5 PINs, paid R172.40.
- Headless 390 px: store-visit card, second drop, "Add to your trip" offer at the top; checkout priority toggle +R15, ? tooltip, fee R34.46 → R49.46 (quote stand-in locally — no ORS key on this machine).

**Files:** `netlify/functions/{advance-route,respond-to-driver-offer,driver-heartbeat,get-delivery-quote}.js`, `netlify/functions/lib/{route-insertion (new),batch-dispatch,road-distance}.js`, `logistics.html`, `track.html`, `checkout.html`. Migrations: `multi_drop_routes_core` (`driver_offers.insertion`, `get_route_plan_input`, `apply_route_sequence`, `find_batchable_routes` v2), `delivery_plan_point`, `driver_board_multi_drop`, `tracking_multi_drop` (+ ops board trip count).

---

## 2026-10-04 — Rider pay follows the delivery price

**Asked for (founder):** change rider pay to reflect the new R34–R45 delivery price.

**Was:** R4 + R4/km (min R20) + R10 per extra stop + R1.50/min over 30 min (`formula_v1_2026_09_17`) — e.g. the 16 km test route paid R49.92.

**Now:** per delivery on the route, the same band as the customer price — R34 for the first 3 road-km + R0.40/km (the quote's road distance), +R3 per extra store, max R45; R39 if the distance is unknown; paid even when the customer got free delivery. `compute_driver_payout_on_route_completion` (authoritative, method `delivery_price_band_2026_10_04`, per-delivery lines in `calculation_basis`) and `lib/payout-formula.js` (offer estimate, now built on `lib/delivery-price.js`). Verified in a rolled-back re-run of the founder's completed test route: R39.22 (was R49.92); JS estimate 16 km → R39.22, 2 km → R34. Existing payout rows unchanged. Admin pricing text updated.

**Files:** `netlify/functions/lib/{payout-formula,delivery-price}.js`, `netlify/functions/get-delivery-quote.js`, `admin.html`; migration `rider_payout_matches_delivery_price`.

---

## 2026-10-04 — Delivery price R34–R45 by distance; saved address priced on load

**Reported (founder):** signed in with a saved address, checkout showed the flat R42.50 (and no delivery target / time saved) until the address was re-picked. Price too high to compete (~R68 to Reservoir Hills) — wanted R34 minimum, R45 maximum, around R39 for the Umgudulu direction.

**Root causes:**
- The saved address filled the form as text only — no coordinates — so no live quote was requested until the buyer re-picked a suggestion. Profiles have `saved_address_geo` but nothing ever wrote it (0 of 19 profiles).
- The quote price was the rider-payout estimate × (1 + margin), uncapped.

**Changes:**
- Checkout locates the saved address on load (`useSavedAddressLocation`, single-flight, runs once both cart and profile are known): the saved pin if present (EWKB hex decoded in the browser), else a geocode of the text → live quote → price, delivery target and time saved show immediately. Each order now stores the picked location on the buyer's profile (`saved_address_geo`) for next time.
- New `netlify/functions/lib/delivery-price.js`: **R34 for the first 3 road-km, +R0.40/km after, max R45** (bundles/overflow included); fallback without a distance **R39** for every size. Used by `get-delivery-quote.js` (live price) and `validate-cart.js` (fallback + clamp); `checkout.html` mirrors the fallback. Examples: 2 km R34 · 10 km R36.80 · 16 km R39.22 · 20 km R40.80. Rider payout unchanged; admin's pricing panel explains that `margin_percent` no longer sets the customer price.

**Verified:** headless Chrome, fake signed-in buyer with saved "34 Umgudulu Rd": with a saved pin → R39.22, "Delivery target: about 57 min", time saved shown, only the quote call; text only → geocode + quote → same. Guest Berea → R34.46. No page errors.

**Files:** `checkout.html`, `admin.html`, `netlify/functions/{get-delivery-quote,validate-cart}.js`, `netlify/functions/lib/delivery-price.js` (new).

---

## 2026-10-04 — Log out on phones, hamburger "Profile" goes to the profile, delivery target from road distance

**Reported (founder):** no way to log out once signed in; the hamburger menu's "Profile" opened the login popup even when signed in; where does "estimated delivery 2–4 hrs" come from? — wanted: road distance × 2 min/km + 25 min, worded as a target, not a guarantee.

**Root causes / changes:**
- Hamburger: `updateAuthUI` only relabelled the item; its click always opened the login modal. Signed in it's now **My profile** (→ profile.html). Log out lives only on the profile page (founder: not a standalone menu item).
- profile.html hid its "Log out" button at ≤600 px, so phones had no logout anywhere — now shown (compact).
- Checkout ETA strip used the store's own "ready within" text mapped to fixed ranges ("1 hour" → "~2–4 hours", "Same day" → "today"…; before that "usually within 1–3 days") — no distance at all. Now: **Delivery target: about N min** = live quote road km × 2 + 25 (same road route as the price), with "We aim to get it to you in this time or sooner — a target, not a guarantee." Before an address: "Add your address to see your delivery time"; services-only carts hide it. Recomputed whenever the quote changes.

**Verified:** headless Chrome — guest menu → Sign In opens login; fake signed-in session → "My profile"; no page errors. Checkout with a Berea address → "Delivery target: about 33 min".

**Files:** `index.html`, `script.js`, `profile.html`, `checkout.html`.

---

## 2026-10-04 — Seller orders auto-refresh + product-first cards, notes everywhere, widget clears after delivery, one job per rider, seller activation by application

**Reported (founder):** the test item (said to be at 0) was still orderable; the home widget stays after delivery; seller orders need manual refresh and should lead with what was ordered (buyer's full name to tell orders apart at pickup); checkout notes should show everywhere; can a rider take several orders at once / multi-stop routes?; switch seller activation to the application's account; hide the test item; free delivery off.

**Findings & changes:**
- **Stock was right:** 2 → 0 after the two founder test orders; it was restocked to 3 for the saved-card test and the third order came after that (now 2). The test item is now hidden, stock 0, free delivery off.
- **Home widget** re-checks every minute while the page is open and shows "Order delivered ✓" for only 5 minutes after the PIN (was 2 hours; and it never updated without a reload).
- **Seller dashboard orders:** refresh themselves every 3 minutes and when the tab is reopened ("Updates automatically · last checked …"), with a "🛎 New order — <name>" alert and a highlighted card. Each card now leads with the products (big "2× Quarter chicken & chips", size), labelled "For <buyer's full name>" + time + short ref, the buyer's note highlighted, and phone / area / amount / paid on one small line.
- **Checkout note everywhere:** seller cards, rider job screen (already), logistics detail (already), admin → Deliveries (new "Customer & note" column), customer profile order card ("Your note"), tracking page (`get_delivery_tracking` now also returns `delivery_note`), confirmation + seller emails (already).
- **Several orders per rider — not safe yet, now prevented:** an order with several stores (one customer) works end-to-end. But (1) the batching path (`lib/batch-dispatch.js`) could offer a moving rider a second customer, while `advance-route.js` and the rider screen only progress ONE delivery per route — an accepted batch would leave the added order stuck; (2) `find_nearest_eligible_drivers` didn't skip riders already on a route or holding an open offer, so a busy rider could get a second route and the rider screen would show only the newer one. Batching is switched off (`BATCHING_ENABLED = false`) and busy riders are skipped; waiting orders go to the next free rider (the heartbeat re-offers them). Proper multi-drop routes = a follow-up build.
- **Seller activation (payfast-itn.js):** the enrollment payment now activates the store linked to the application (`sellers.application_id`, set by initiate-seller-enrollment) instead of looking the user up by `profiles.email` (user-editable).

**Files:** `index.html`, `seller-dashboard.html`, `admin.html`, `profile.html`, `track.html`, `netlify/functions/payfast-itn.js`, `netlify/functions/lib/batch-dispatch.js`; migrations `tracking_returns_delivery_note`, `one_job_per_rider_until_multi_drop`.

---

## 2026-10-04 — Checkout pay section redesigned (save card by default, named cards); saved cards can't be hijacked via profile email

**Asked for (founder, after confirming saved-card payments work live):** make people more likely to save their card, let them name it and pick it by name next time, confirm whether several cards can be saved, and make the bottom of checkout uncluttered and flowing — no thinking about boxes.

**Multiple cards:** yes — every saved card is its own `payment_methods` row (one PayFast token each, unique per user+token), so naming matters.

**What changed (checkout.html):**
- One "How do you want to pay?" panel: saved cards listed by nickname ("Last used …"), most recent preselected, plus "A new card". New card → "You'll type your card on PayFast next", a **Save this card** switch that is **on by default**, and a **Card nickname** field right under it (hidden if the switch is off).
- One button matching the choice ("Agree & pay" / "Agree & pay with FNB debit"; phone bar "Pay with FNB debit"). Terms are agreed by pressing it — the line sits right above it (and next to the phone pay bar); the old checkbox is kept hidden and ticked on press so validation and `terms_accepted_at` are unchanged.
- Order note became "+ Add a note for the store or rider". "Send me deals from Umzila shops (unsubscribe anytime)" is pre-ticked (POPIA allows this for a buyer's own purchase, with an easy opt-out).
- Tokenizing now follows the switch (it used to be forced for anyone with a saved card); the nickname is only stored when saving.
- Guests can save too: the token stays on the order and is added to their saved cards when they confirm that email (`claim_my_email_orders`).

**Security fix (complete-order-payment.js):** after payment it linked a guest order — and saved the guest's card — to whichever account had that email in `profiles.email`, a field users can edit. Someone could set their profile email to a victim's and receive the victim's saved card (chargeable). Now only an account that proved the email by confirmation link (`verified_user_id_for_email`, service-role only) is linked, and a signed-in buyer's order is never moved.

**Verified:** PayFast token lookup (read-only) accepted our signature on live and the founder's saved-card payment succeeded. Headless Chrome 390/1280 px: guest (switch on, nickname, one "Agree & pay"); signed-in with 2 fake saved cards (named + unnamed fallback "Card added …", most recent preselected, button "Agree & pay with FNB debit", "A new card" reveals switch + nickname, switch off hides nickname); no page errors.

**Not changed (flagged):** `payfast-itn.js` seller-enrollment activation also finds the user by `profiles.email`; left alone (PayFast ITN rule) — worth switching to the application's own user id.

**Files:** `checkout.html`, `netlify/functions/lib/complete-order-payment.js`; migration `verified_owner_for_cards_and_orders`.

---

## 2026-10-04 — Every paid delivery order now reaches a rider; seller "Fulfillment" dropdown removed

**Reported (founder's 2nd live test, signed in, R5 free-delivery item):** paid, showed on the seller dashboard with a Pending/Packaging/Fulfilled/Delivered/Returned dropdown (makes no sense for a seller), never appeared in logistics, and stayed "Pending" in the buyer's profile.

**Root cause:** the order was saved with `delivery_quote_id = null` although a valid quote for the same buyer existed 24 s earlier. In a signed-in checkout the saved cart can finish loading while the quote request is in flight; `ensureFreshQuote()` then saw a quote that no longer matched the cart, didn't ask again, and sent no quote. `create_delivery_on_payment` only created a delivery when `delivery_quote_id` was set → no delivery → nothing for logistics/riders, and the seller dashboard fell back to the legacy dropdown (it shows "Mark ready" only for orders with a delivery). Choosing in that dropdown then wrote `order_status = 'Pending'` over `'paid'` — why the profile said Pending. Same hole for any order without a live quote (e.g. stores without a pickup pin).

**Fixes:**
- `create_delivery_on_payment`: a paid order with a delivery address and physical items **always** gets a delivery. With no quote attached, it creates a stand-in quote (`destination_snapshot.source = 'payment_fallback'`, fee = what was charged, distance = straight line ×1.3 from the first store's pickup pin, used only for rider ranking/payout) and links it. Stores delivering themselves within `self_arranged_radius_km` are skipped (same rule as `get-delivery-quote.js`).
- Checkout: `ensureFreshQuote()` asks once more for exactly this cart when the in-flight quote no longer matches.
- Seller dashboard: no dropdown. A seller sees **Mark Ready for Pickup**, then "✓ Ready for Pickup" + the delivery stage ("Finding a rider", "Rider on the way to you", "Out for delivery", "Delivered to customer"…). Never writes `orders.order_status`.
- The test order was repaired: status back to `paid` (payment confirmed by PayFast) → delivery created (PENDING, waiting for the store).

**Verified:** rolled-back DB test on the real order → quote linked, delivery PENDING with tracking token, 1 order item. Headless checkout (picked and typed address) → order insert carries `delivery_quote_id` in both (the typed case previously never reached the insert).

**Still to do (ops):** only Sweet Corner and Velaphi have a pickup pin; deliveries from other stores are created but can't be offered to a rider until the store's pickup location is set — they show on the logistics Today board as "No rider".

**Files:** `checkout.html`, `seller-dashboard.html`; migrations `every_paid_delivery_order_gets_a_delivery` (+ `_fix_status`, `_skip_self_arranged`).

---

## 2026-10-04 — Admin revamp: grouped menu, "Live now" strip, phone layout

**Asked for (founder):** admin needs the same revamp as logistics (faster, more accurate, better on mobile).

**What was wrong:** the dashboard's "Pending Orders" counted every order still at `order_status = 'paid'` — including ones already delivered by the network and seller enrollment fees — and fetched the rows to count them. On phones, 16 flat menu items lived in a hidden drawer, the header showed a product search on every section, and many sections use inline multi-column grids and wide tables that overflowed the screen.

**What changed:**
- Dashboard **Live now** strip (same `get_ops_board()` as logistics, every 30 s while on the dashboard): open deliveries, needing attention (with reason), delivered today, riders online, and the top items needing attention — with a jump to Delivery Ops. The "Pending Orders" card became **Open Deliveries** from the same data; `updatePendingCount()` no longer queries.
- Sidebar grouped: Overview · Delivery · Sellers · Catalogue · Orders · Growth · System.
- Phone: bottom bar Home / Delivery / Shops / Products / Menu (drawer); header shows the current section's name (product search only on Manage Products); inline grids stack, KPI cards 2-across, wide tables scroll inside themselves, detail modals become bottom sheets, toasts sit above the bar. No sideways page scroll (checked at 390 px).

**Verified:** headless Chrome with stubbed data at 390 px and 1366 px — Live now renders with the attention reason, menu groups, bottom bar switches sections, Service Areas has 0 px horizontal overflow; no page errors.

**System doc:** [docs/systems/ops-panels.md](systems/ops-panels.md) — rider board, ops board, attention rules, gotchas.

**Files:** `admin.html`, `docs/systems/ops-panels.md`.

---

## 2026-10-04 — Logistics panel revamp: live "Today" board, real order status, safer edits, mobile layout

**Asked for (founder):** logistics needs a revamp — faster, more accurate, better looking and interactive on mobile.

**What was wrong (accuracy):**
- Logistics staff can't read `deliveries`, so the panel had no idea where an order was: every network order sat at "Pending" (`order_status = 'paid'` was shown as Pending) even after delivery. Seller enrollment payments (also in `orders`) showed up in the delivery queue.
- **Changing an order's status rewrote the whole row**: `saveOrder()` set `orders.user_id` to the rep (the customer lost the order from their profile), rewrote `payment_status`, and wrote "Pending" over `paid`.
- The order detail recomputed totals in the browser from item fields that differ between order types (often R0) instead of the charged `orders.total`. Delete was offered on paid orders.
- Leaving the Deliver tab stopped the rider's GPS heartbeat + offer polling.

**What changed:**
- New staff-only RPC `get_ops_board()` (admins or active logistics/admin `user_roles`, same rule as `orders_manage_staff`): every open delivery + the last 2 days, time in current state (last `delivery_events` row), stores, customer, area, rider; riders (online = heartbeat within 3 min, on a route, last seen); and a delivery-status map per order.
- **Today** (replaces Overview): KPIs (open deliveries, needing attention, delivered today, riders online, paid orders + sales today), a "Needs attention" list with the reason (no rider for 3+ min, offer unanswered, store not ready after 45 min, long pickup/trip, PIN locked, failed), lanes (waiting for store → finding a rider → rider collecting → on the road), riders, delivered today. Auto-refreshes every 15 s; tap a card for the order.
- **Orders**: status = the live delivery state when there is one (else the legacy status); filters Needs action / In progress / Delivered / Cancelled / All with counts; seller fees tagged, not queued; History uses the same real state. Detail: live status + time + rider + the reason it needs attention, Call / WhatsApp / Map buttons, delivery instructions, "Charged" = stored total, manual status buttons only for orders not in the delivery network, Delete hidden for paid orders.
- `saveOrder()` on an existing order no longer writes `user_id`, `created_at` or `payment_status`, and writes `order_status` only when a rep actually changed it.
- Faster: orders query selects only the columns used and skips unpaid checkouts server-side; products for the order form load in the background.
- Mobile: bottom bar Today / Orders / Deliver / Tasks / More (sheet: history, baskets, stores, analytics, settings, sign out), card-style order rows, compact header; refreshed tokens.

**Verified:** `get_ops_board()` as the logistics test account returned the real delivery and rider. Headless Chrome with stubbed data at 390 px and 1366 px: Today (KPIs, attention reasons, lanes, riders), Orders filters/counts, detail, More sheet — no page errors.

**Files:** `logistics.html`; migrations `ops_board_for_staff`, `ops_board_drop_ready_items`.

---

## 2026-10-04 — Rider app rebuilt: the rider sees the customer, the customer sees the rider's name

**Reported (founder):** the rider "sees nothing" yet they're the one moving — they need all the customer's details; the customer should only know the rider's name.

**Root cause:** the rider panel (`logistics.html` → Delivery) only ever showed a store name and "Navigate" buttons — it never loaded the customer (name, phone, address, instructions), the order number, the items to hand over, or the store's phone. It also made ~6 separate queries per 10 s refresh, only polled while the Delivery tab was open (offers were missed on any other tab), showed "offline" after a reload while dispatch still had the rider online, and used low-accuracy one-off GPS fixes every 30 s.

**What changed:**
- New RPC `get_driver_board()` (SECURITY DEFINER, caller's own driver row only): offers (payout, expiry, store(s) + area, drop-off area, distance/time, item count, parcel size — never the customer's identity) and the active route with every stop's store (name, address, phone), items (+ collected), coordinates, and for the drop: customer name, phone, address, area, postal code, delivery instructions/notes, order ref, PIN-locked flag. Customer contact details exist only while the route is active.
- Rider screen rebuilt (mobile-first): online switch that resumes the real state on load; GPS as a continuous high-accuracy watch with a status line (blocked / weak / good); offers with countdown, Accept/Decline, vibration + beep and a badge on the Delivery tab even when on another tab; job view with a stepper (stores → customer), big Navigate (Google Maps directions to the exact pin) / Call / WhatsApp buttons for store and customer, item checklist, delivery instructions highlighted, sticky main action ("I'm at the store" → "Collected — continue" → "Start trip to customer" → "I've arrived" → PIN). Heartbeat every 12 s on the way to the customer (30 s otherwise). Server actions unchanged (`advance-route`, `confirm-delivery-pin`, `respond-to-driver-offer`, `driver-heartbeat`).
- Customer: `get_delivery_tracking` also returns `driver_name` (first name only); `track.html` shows "🛵 Your rider: <name>" and uses it in the headline.

**Verified:** `get_driver_board()` as the test rider on the real (temporarily re-opened, rolled back) route returned store, items, customer name/phone/address. Headless Chrome (390 px) with stubbed data rendered every stage — offline, waiting, offer, go to store, at store (checklist), picked up, driving, PIN — with no page errors. `track.html` on the real order shows "Your rider: Ntando".

**Files:** `logistics.html`, `track.html`; migration `driver_board_and_driver_name`.

---

## 2026-10-04 — Email confirmation on: signing in now proves you own the email

**Asked for (founder):** a buyer signed in with the order's email should be able to track from their profile without hunting for the email link; turn on "Confirm email" so future accounts confirm, and past accounts go through confirmation the next time they sign in.

**Root cause of the gap:** Supabase "Confirm email" was off — every account was auto-confirmed within a second of creation (no email ever sent), so an account's email proved nothing. Anything matched by email was therefore readable by whoever registered that address first: guest orders (orders RLS matched `auth.email()`), discount codes / gift vouchers (matched `profiles.email`, which users can edit themselves) and newsletter subscriptions.

**What changed:**
- **Supabase Auth → "Confirm email" turned ON** (by the founder in the dashboard). Past accounts: `email_confirmed_at` reset so they confirm on their next sign-in (existing sessions keep working).
- New `public.my_verified_email()`: the caller's email only if it was confirmed by a link (confirmed > 10 s after the account was created — auto-confirmed and admin-created accounts don't count).
- RLS now uses it: `orders` ("by uid or verified email"), `discount_codes` (own codes by verified email or profile id), `subscribers`.
- New `claim_my_email_orders()`: a verified buyer's guest orders (same email) get `orders.user_id` / `deliveries.customer_id` set to them. Called by profile, the homepage widget and `track.html` — so profile tracking and the widget work on any device once the email is confirmed. (`claim_order_with_token` still links via the private link without waiting for confirmation.)
- `handle_new_user` fills `profiles.email/first_name/last_name` from the sign-up (there's no session yet when confirmation is on, so the browser can't).
- Every sign-up passes `emailRedirectTo` = the current page (checkout comes back signed in; the saved code re-applies on load) and, without a session, shows "we sent a confirmation link to …" instead of closing. Every sign-in that fails with "Email not confirmed" re-sends the link and says so: main modal (`script.js`), checkout (code-box panel, account card, inline sign-in), mystery gift (`index.html`), `login-admin.html`. Fixed `script.js` passing sign-up options as a second argument (the name was silently dropped).

**Needs in Supabase (dashboard):** Auth → URL Configuration → Redirect URLs must allow the live site with `/**` after it (the SITE_BASE_URL value) (otherwise links land on the Site URL); Auth emails must go through a real SMTP (e.g. Resend) — Supabase's built-in mailer only reaches team addresses and a few emails per hour.

**Files:** `script.js`, `checkout.html`, `index.html`, `login-admin.html`, `profile.html`, `track.html`; migrations `verified_email_ownership`, `reset_past_accounts_email_confirmation`.

---

## 2026-10-04 — Guest orders: profile "Track delivery" and the homepage widget now work

**Reported:** after ordering, the homepage "your order is on the way" widget never appeared, and profile → Track delivery said "No live tracking for this order on your account" (signed in on a phone), while the email link worked on another device.

**Root cause:** the test order was placed as a guest, so `orders.user_id` and `deliveries.customer_id` are null. The profile lists it anyway (the orders RLS also matches on account email), but the widget looks deliveries up by `customer_id` and `get_delivery_tracking` only accepts the owner or the token — and the profile link carries no token. Matching tracking on email alone is not safe: sign-ups are auto-confirmed (every `auth.users` row is confirmed within a second of creation, no confirmation email), so anyone could register someone else's email and get their live location + PIN.

**Fix:** a guest order is linked to an account only with proof:
- New RPC `claim_order_with_token(p_order_id, p_token)` (authenticated only): sets `orders.user_id` / `deliveries.customer_id` when the private tracking token matches **and** the signed-in email equals the order email, and only if not owned by someone else.
- It runs whenever a signed-in buyer opens the tracking link (`track.html`), lands on the payment-success page, or opens the homepage with a link saved on that device. After that, profile and widget work everywhere.
- Device memory: `ss_track_links` (localStorage, last 5, 14 days) is written by the success page and track page. The homepage widget shows guests' active deliveries from it (via `get_delivery_tracking` with the token, link includes `&t=`); `track.html` without `?t=` uses a saved token for that order.
- `track.html`'s signed-in "not linked" message now says to open the email link once to link the order.

**Verified:** RPC — wrong email → false, wrong token → false, matching email + token → linked (in a rolled-back transaction). Headless Chrome locally: widget hidden with no links, shows "Your order is on the way" with the token link for a saved link, hidden for a bad token; track page without `?t=` but with a saved link shows live tracking. No page errors.

**Known gap (not changed):** the existing orders RLS policy still shows orders whose `customer_email` matches the account email — with auto-confirmed sign-ups that exposes a guest's order details (address, phone) to whoever registers that email. Fix = turn on email confirmation in Supabase Auth, or drop the email clause (guest orders then appear only after claiming).

**Files:** `track.html`, `checkout-success.html`, `index.html`; migration `claim_guest_order_with_tracking_token`.

---

## 2026-10-04 — First live delivery test: "Mark Ready" did nothing, guests couldn't track, duplicate orders

**Reported (founder's live test, R5 free-delivery item → 34 Umgudulu Rd):** the order went through, but the rider app showed nothing when online; "Mark Ready for Pickup" appeared to do nothing; a buyer who isn't signed in can't track and isn't told where to; after creating an account, tracking said "No live tracking".

**Root causes:**
1. **Every paid order got its items twice in `order_items`** — the `populate_order_items_on_payment` trigger *and* `complete-order-payment.js` both inserted them. (A regression from the 2026-10-03 `.catch()` fix: before it, the JS insert crashed and never ran.) `advance-delivery-on-fulfillment.js` then compared 2 item rows to 1 "fulfilled" mark → "awaiting other sellers" → silently skipped; the delivery stayed `PENDING`, so dispatch never ran and the rider app had nothing.
2. **Tracking only worked for the signed-in account that placed the order** (`get_delivery_tracking` matched `customer_id = auth.uid()`). Guest orders have no customer, `track.html` bounced anyone not signed in to the homepage, and nothing gave guests a link. Creating an account afterwards doesn't attach the guest order (and auto-attaching by email would be unsafe: sign-ups aren't email-verified).
3. **Duplicate pending orders:** Pay could be pressed twice in the first seconds (before the button disabled) → two `orders` rows.

**Fixes:**
- `complete-order-payment.js` skips its `order_items` insert when the trigger already wrote them; `advance-delivery-on-fulfillment.js` counts distinct lines (product + size) per seller. The test order's duplicate was removed; only that one paid order was affected.
- **Private tracking link:** new `deliveries.tracking_token`; `get_delivery_tracking(p_order_id, p_token)` accepts the owner *or* the token (anon-callable). The link (`/track.html?order=…&t=…`) is on the payment-success page ("Track your delivery", via `order-status.js` → `trackPath`), in the order confirmation email ("Track my delivery") and in the delivery emails. `track.html` works with the link and no account; without one it explains where the link is.
- Checkout: `preparePendingOrder()` is single-flight — one order per Pay press.

**Verified:** the test delivery advanced `PENDING → READY_FOR_DISPATCH` and was offered to the online rider immediately; the founder then accepted it and progressed it to picked up / on the way live. Locally: `order-status` returns the link for the paid order; `track.html` with the link (no sign-in) shows "On the way to you", live rider position and the PIN; no link → explanation; wrong token → "couldn't find live tracking".

**Files:** `netlify/functions/{advance-delivery-on-fulfillment,order-status}.js`, `netlify/functions/lib/{complete-order-payment,notify}.js`, `track.html`, `checkout-success.html`, `checkout.html`; migration `delivery_tracking_token`.

---

## 2026-10-04 — Rider dispatch no longer stalls: missed offers released, waiting orders re-offered

**Found while preparing the founder's first live end-to-end delivery test:** dispatch only ran once, at the moment a seller marked an order ready. If no rider was online right then, the delivery sat at `READY_FOR_DISPATCH` forever (the code comments mentioned a "heartbeat or admin redispatch" that was never built). An offer nobody answered within its 2 minutes left the delivery stuck at `OFFERED` forever too — it was only marked expired if a rider tried to accept it late.

**Fix (`driver-heartbeat.js`):** on every heartbeat from an eligible online rider (every 30 s while the rider app is online): pending offers past `expires_at` are marked expired and their delivery goes back to `READY_FOR_DISPATCH` (`OFFER_EXPIRED` event); then the oldest waiting deliveries are offered via the existing `dispatchDelivery()` (nearest eligible online rider, never double-offers). Best-effort — never fails the heartbeat.

**Also:** a R5, free-delivery test item was added to Velaphi ("Delivery test item (Umzila staff)", stock 2, `metadata.internal_test`) for the founder's live test — hide it afterwards.

**Rider steps confirmed manual by design** (no GPS geofence): Accept → Start route → pickup checklist → Start delivery → "I've Arrived" → customer's 4-digit PIN. GPS (every 30 s) only drives the customer's live map.

**Files:** `netlify/functions/driver-heartbeat.js`; data: test product.

---

## 2026-10-04 — No delivery outside the zones ("notify me" instead), KZN-only province, free-over-R600 off, store-level free delivery

**Asked for (founder):** addresses outside the zones we draw must not be deliverable — no default R42.50 (e.g. a Cape Town order) — with a button that tells us their name, address and cart so we expand from real demand; the province dropdown should reflect that only KwaZulu-Natal works; turn off free delivery by cart value; free delivery toggleable per store and per product in admin.

**Why the founder still saw R42.50 on the live site:** the previous commit's production deploy was **skipped by Netlify — "account credit usage exceeded"** — so umzila.store was still serving the version without the live-quote display. (Every push to `main` is a production deploy and costs credits; changes are now batched into one push.)

**What changed:**
- **Outside coverage = not deliverable.** `get-delivery-quote.js` returns reason codes (`outside_area` for outside every zone or past the 20 km road cutoff, `multi_seller`, `self_arranged`); a routing outage or a store without a pickup address *after* the zone check returns 503 `inArea:true` (standard fee still allowed). Checkout: outside → "We don't deliver to this address yet" + **Notify me when you deliver here**, delivery "Not available", nothing added to the total, Pay blocked; stores too far apart → asked to check out each store separately; a typed address (no suggestion picked) is geocoded (new `address-search.js?action=geocode`, all of ZA so Cape Town lands in Cape Town) before paying; any failed check blocks rather than guessing. Editing the address clears stale coordinates.
- **Server enforcement:** `validate-cart.js` final pre-payment check (`finalCheck` + `destination`) refuses physical delivery outside every active zone (`OUTSIDE_AREA`) or without coordinates (`ADDRESS_REQUIRED`).
- **Notify me:** new `request-delivery-area.js` → new `delivery_area_requests` table (name, email, phone, address, coordinates, reason, cart re-priced from the real listings, status). Same email+address within 24 h isn't saved twice; email to `ADMIN_NOTIFY_EMAIL` (falls back to the Umzila inbox) with a map link and reply-to the buyer. Admin → Service Areas → **Delivery requests**: top areas + list with status (new/contacted/covered/dismissed).
- **Province:** checkout defaults to KwaZulu-Natal; others show "— coming soon" and choosing one immediately shows the notify-me note. HERE's "Kwazulu Natal" now matches the dropdown (it silently didn't); saved profile spellings are matched loosely.
- **Free delivery by cart value is off** (was "free over R600") in checkout, `validate-cart.js` and quotes (`delivery_pricing_config.free_delivery_threshold` now nullable, set to null = off; admin's pricing field blank = off).
- **Store-level free delivery:** new `sellers.free_delivery` (admin-only — added to `sellers_guard_admin_columns`), toggle in admin → Manage Shops; applied with OR alongside the existing product switch in checkout, `validate-cart.js` and quotes.

**Verified (local, real functions + DB; HERE answers and the notify endpoint simulated in headless Chrome):** Cape Town picked → blocked, notify works, Pay refused; Cape Town typed → geocoded at Pay → blocked; Western Cape province → blocked; Durban → R20.61 and through every area check to order creation (an earlier run reached PayFast — that pending order was deleted, unpaid; it carried `delivery_quote_id`, confirming the dispatch link). Server: Cape Town → `OUTSIDE_AREA`, Durban → ok, no address → `ADDRESS_REQUIRED`. Notify function (email off): saved with re-priced cart, repeat ignored, bad email refused, test row deleted. R899.67 cart now pays R42.50 delivery; store free delivery on → R0 (switched back off).

**Files:** `checkout.html`, `admin.html`, `netlify/functions/{request-delivery-area,address-search,get-delivery-quote,validate-cart}.js`; migrations `delivery_area_requests`, `store_free_delivery_and_threshold_off`.

---

## 2026-10-04 — Delivery price now actually follows road distance; orders enter dispatch/tracking; time saved uses the road route

**Reported:** delivery always showed R42.50 instead of varying with distance/zones; "time saved" changed but it was unclear whether it used straight-line or road distance; does tracking now work.

**Root causes (three, stacked):**
1. **Checkout threw the live price away.** `fetchDeliveryQuote()` got the road-distance quote but kept only its id; the delivery line always showed the class fallback. The quote was only used invisibly at payment — and only if it hadn't expired (15 min) and the cart hadn't changed.
2. **Almost all of Durban was "outside the delivery area".** The only `service_zones` row was the pre-rebrand "westville campus" zone (Berea/Westville/Pinetown). The CBD — where Velaphi is — Umhlanga, Chatsworth, Umlazi etc. got `eligible:false` → fallback.
3. **"Time saved" used straight-line (haversine) distance** × 2.5 min/km, never the road.
Consequence: **0 orders had ever carried a `delivery_quote_id`, so `trg_create_delivery_on_payment` never created a delivery** — nothing ever reached rider dispatch, live tracking or PIN confirmation.

**What changed:**
- `checkout.html`: the live quote is the delivery price on screen ("4.2 km by road · 1 seller"); it re-quotes automatically when the cart changes or the quote nears expiry, and `ensureFreshQuote()` runs right before payment so the price shown is the price charged and the order is linked to the quote. Addresses that can't be live-priced show a plain note and the standard (fallback) fee. Time saved now uses the quote's real road route and drive time (hidden when there's no road quote); the straight-line helpers were removed.
- `get-delivery-quote.js`: also returns `roadKm`/`driveMin` (one-way, farthest store → customer) for the time-saved line; customers still never see the fee breakdown.
- `validate-cart.js`: an applied quote now replaces only *product* delivery — rep collection/return fees for services in the same cart were being dropped.
- DB: new **"Durban metro"** core zone (20 km circle around the CBD). Doesn't widen where orders are accepted (they always were, at the fallback); it lets the city be priced by real distance. The 20 km road cutoff per store still applies. Hillcrest (~27 km) stays on the fallback. Editable in admin → Service Areas.

**Verified on a draft deploy with the real keys, real browser checkout (390 px):** 35 Musgrave Rd → **R20.61**, "4.2 km by road", time saved 32–42 min; 7 Westville Rd → **R55.45**, 12.9 km; 17 Inanda Rd Hillcrest → R42.50 + outside-area note; `validate-cart` with the quote → `productDelivery 20.61, quoteApplied true`. The delivery-creation trigger needs only `delivery_quote_id`, which paid orders now carry. Not run: a real paid order through to a rider (1 driver registered; they must be online in the rider app to receive offers).

**Files:** `checkout.html`, `netlify/functions/{get-delivery-quote,validate-cart}.js`; data: `service_zones` "Durban metro".

---

## 2026-10-04 — Address search tuned on real Durban addresses (keys live)

With `HERE_API_KEY`/`ORS_API_KEY` added, tested real searches. HERE Autocomplete alone: exact house numbers for "400 Umgeni Road", "35 Musgrave Road", "10 Problem Mkhize Road", "5 Jan Hofmeyr Road Westville" — but "12 Florida Road" ranked Evander (Mpumalanga) first, anything with the suburb typed ("120 Florida Road Morningside", "1 Ridge Road Umbilo") returned **nothing**, and places by name ("Gateway", "Wushwini Arts Centre") weren't found.

**Changed (`address-search.js`):** results limited to the Durban metro (80 km circle); when Autocomplete finds fewer than 3, HERE Discover (free-text) runs in the same area and is merged — now "120 Florida Road Morningside" → 120 Florida Rd, "1 Ridge Road Umbilo" → 1 Peter Mokaba Ridge (the road's new name), Gateway / Wushwini Art Centre / The Pavilion found; places show their name first. Pages (checkout, profile, seller dashboard): when HERE only knows the street, the house number the buyer typed is kept.

**Verified on a draft deploy with the real keys:** the searches above; lookup of 35 Musgrave Rd → exact coordinates; a real OpenRouteService quote from Velaphi → 4.15 km → **R20.61** (payout formula), second quote from the cache. Real customer quotes were already filling the cache (Velaphi → Westville, 16 km). Test quotes deleted.

**Pricing note for the founder:** live quotes are the driver-payout formula (R4 + R4/km, min R20, margin 0%), so short trips now price *below* the R42.50 fallback (≈R20 at 4 km, ≈R44 at 10 km, ≈R68 at 16 km). Raise `margin_percent` (admin → Delivery Pricing) to add profit on top.

---

## 2026-10-04 — Delivery: R42.50 fallback, HERE address search, OpenRouteService distance with a permanent cache (Google removed)

**Asked for:** remove Photon address suggestions; use HERE Geocoding & Search (better Durban house-number coverage); price delivery by OpenRouteService distance (traffic doesn't change distance); only use HERE/TomTom for times if times are shown; cache distances so usage stays far below free limits; and first, fix the fallback so a medium parcel (e.g. any Velaphi plate) is R42.50 when live pricing isn't available.

**Fallback price (the part customers pay today):** without a live distance quote — which was *every* order, since the Google key never existed — delivery used the class prices. Re-based on the founder's R42.50 average: **small R23 · medium R42.50 · large R96.50**, cap **R155** (all ×1.93 from R12/R22/R50/R80). Per-extra-seller (R3), large-overflow (R10) and the R600 free-delivery threshold unchanged. Server (`validate-cart.js`, authoritative) and checkout preview changed together; admin's package-size labels updated. Verified: a single Velaphi plate → `productDelivery: 42.5`.

**Address search:** new `address-search.js` (HERE Autocomplete + Lookup, server-only `HERE_API_KEY`, Durban-biased, ZA only) replaces `google-places.js` (deleted) **and every direct Photon call** in checkout, profile and the seller dashboard's pickup address. Same response shape, so the pages only changed their fetch; Photon branches/constants removed. Suburb + city go into the City field ("Morningside, Durban"). Responses are cached at Netlify's edge (suggestions 1 day, coordinates 7 days). Without the key: no suggestions (503), buyers type the address, checkout uses the fallback price — nothing breaks.

**Distance:** new `lib/road-distance.js` — OpenRouteService directions (driving-car), server-only `ORS_API_KEY` — replaces Google Routes in `get-delivery-quote.js`. Every leg (store → address, store → store) is cached forever in the new `route_distance_cache` table (service-role only; points rounded to ~11 m), so a store's distance to a saved address is fetched once. Bundles are priced as sums of cached legs (A→B→customer vs B→A→customer). Pricing logic itself (payout formula, margin, 20 km cutoff, zone promos) unchanged.

**Times:** checkout only shows the store's turnaround ("~2–4 hours"), not drive times, so no HERE/TomTom time lookup was added (per the instruction).

**Verified:** without keys — address search 503s cleanly, quote fails cleanly → fallback R42.50; with HERE stubbed (HERE's documented response format) — suggestion/coordinate mapping correct; with ORS stubbed at 9 km — full quote against the live DB returned R40 (payout formula), the second identical quote was served from the cache with **no** routing call; test quotes/cache rows deleted. **Not yet verified against the real HERE/ORS services** — needs the two keys in Netlify (then re-test house-number search on real Durban addresses).

**Files:** `netlify/functions/{address-search,get-delivery-quote,validate-cart}.js`, `netlify/functions/lib/road-distance.js`, `netlify/functions/google-places.js` (deleted), `checkout.html`, `profile.html`, `seller-dashboard.html`, `admin.html`, comments in `lib/{dispatch,batch-dispatch,payout-formula}.js` + `advance-delivery-on-fulfillment.js`; migration `route_distance_cache`.

---

## 2026-10-04 — Product images point to the button; Nceks "Pick your ride" shows the full design; Velaphi plates redesigned

**Asked for:** Nceks ride images that show everything and point to the button below to book; redesign Velaphi's images if needed.

**What changed:**
- **Nceks product images (v2):** the "Book a time" pill inside the image looked like a button but wasn't one — replaced with a "Tap **Book** below" / "Tap **Buy gift** below" cue and an orange arrow pointing bottom-right at the real button (homepage card "+"/Book, modal button). New filenames (`-v2`) so the 7-day image cache can't keep the old ones.
- **Nceks "Pick your ride" cards (bespoke page):** now show a 4:5 card version of the design (`ncekeniquads/img/card-<m>.webp`) that fits the 4:5 card exactly — nothing cropped — with the arrow pointing at that card's Book button. Top corners and bottom-left are kept clear for the best-value tag, gauge and next-time tag. The booking summary thumbnail keeps the photo. Changed via `build-nceks.js`/`nceks-script.js` (`RIDE_ART[m].card`).
- **Velaphi:** each plate keeps its own photo, now labelled "BEEF & WORS" + bold "PLATE" / "FOR TWO" / "+2…+6 WINGS" + "FREE SIDES" chips — the five wing plates were indistinguishable before. Originals were 1.6–2.9 MB PNGs; the designs are ~70–180 KB WebP (much faster on phones). Originals stay in each product's gallery.
- Design source moved to `docs/design/product-images/` (was `nceks-product-images/`), now covering both stores.

**Files:** `ncekeniquads/index.html`, `ncekeniquads/img/card-*.webp`, `docs/design/product-images/*`; storage + product rows (data, live immediately).

---

## 2026-10-04 — Forgot password: fixed end to end

**Tested every entry point** (homepage sign-in modal + Mystery Gift sign-in, checkout quick sign-in, checkout "welcome back" card, checkout code-box panel, profile → Security) and the landing page.

**Real bugs found and fixed:**
- `reset-password.html` redirected to `/login.html` after a successful reset — a page that doesn't exist (it only reached the homepage by accident via the store-link fallback). Its "failed to load" fallback could never fire (`window.supabase` is always the library). Expired/used links just said "Invalid or expired" with no way forward.
- `profile.html`'s reset link pointed at the **homepage**, which never handled recovery links — the buyer was silently signed in and never asked for a new password.
- Two checkout handlers (and the new code-box one) said "reset email sent" even when sending failed — `resetPasswordForEmail` returns `{error}`, it doesn't throw (e.g. Supabase's email rate limit).

**What changed:**
- `reset-password.html` rebuilt (site-styled, mobile): checks the link (implicit `#access_token…type=recovery` and PKCE `?code=`), new + confirm password with show/hide, ≥6 chars, "must differ from old" message, then "Password updated ✓ — you're signed in" with Continue / Profile buttons. Expired, used or broken links — or opening the page directly — show a "send me a new link" form right there (neutral wording, doesn't reveal whether an account exists). Tokens are cleared from the address bar.
- Homepage (`index.html` head): any `type=recovery` link that lands on it is forwarded to `/reset-password.html` before anything consumes the token — covers Supabase falling back to the Site URL if the reset URL isn't allow-listed.
- `profile.html` now redirects to `/reset-password.html`.
- `checkout.html`: one `sendPasswordReset()` for all three "Forgot password?" buttons, checks the error, plain-language rate-limit message. `script.js` homepage modal: same rate-limit wording.

**Verified locally:** reset page opened directly → request form; expired-link hash → "This reset link has expired" + form; fake token → "doesn't work any more" + form; homepage with a recovery hash → forwarded to the reset page; "send me a new link", homepage modal and checkout inline forgot all succeed (non-existent test addresses, so no emails sent) and validate empty email. **Not run:** a real reset email → new password, because that needs a real account and inbox.

**Files:** `reset-password.html`, `index.html`, `profile.html`, `checkout.html`, `script.js`.

---

## 2026-10-04 — Once-per-person codes: create the account right at the code box

**Asked for:** a guest typing a code that needs an account (reusable, once-per-person promo codes) shouldn't be sent away — explain, show a password field, create the profile, apply the code, carry on paying.

**What changed (`checkout.html`):**
- When such a code is entered (or restored from the cart page) and the buyer isn't signed in, a panel opens right under the code box using the email from step 1: new email → "R20 off with CODE — just add a password" + **Create account & apply**; existing account → "Sign in to use CODE" + **Sign in & apply** + Forgot password. On success the panel disappears, the code is re-checked against the new account and applied. Sign-ups on this project confirm instantly, so it's one step. Needs ≥6 characters; the phone order summary auto-expands so the panel is seen.
- Sign-in/sign-up logic now lives once in `signInOrCreateAccount()`, shared by the step-1 password card and this panel.
- Fixed: a failed code's specific reason ("already used", "first orders only"…) was immediately overwritten by a generic "Invalid or expired".
- **Decision — not every code:** one-off codes (gift vouchers, mystery-gift, referral) stay guest-usable. They can only be used once in total, so an account adds no protection, and requiring one would add friction for gift recipients. Only reusable "once per person" codes need an account, because that rule can only be enforced against a real login.

**Verified locally (test code, deleted after):** guest + new email shows the create-password panel with the right amount; empty/short password errors; existing-account version (simulated) shows Sign in & apply + Forgot password; zero-amount wording; panel no longer clipped. Not run: the actual sign-up/sign-in against the live auth service (same calls the existing step-1 card uses).

**Files:** `checkout.html`, docs.

---

## 2026-10-04 — Designed product images for Nceks; voucher cards read as gifts

**Reported:** every Nceks listing used a generic quad photo, and each ride and its gift voucher shared the *same* photo, so you had to read titles carefully to tell a booking from a voucher.

**What changed:**
- 8 designed images (1200×1200 WebP) uploaded to `product-images/stores/ncekeniquads/` and set as each listing's primary image (`product_images` order 0 + `products.image`; the photos stay in the gallery). **Rides:** photo full-bleed, huge duration ("1 HOUR", "1½ HOURS"…), "Quad bike ride", orange "Book a time" pill. **Vouchers:** cream gift card with ribbon + bow over a blurred photo, "Gift voucher", "Emailed instantly · valid 3 years". Key content stays inside the crop-safe centre (3:4 cards, 4:3 phone modal). Source + render/upload scripts in `docs/design/product-images/` (renamed later the same day).
- Homepage cards (`script.js`): gift vouchers now show a "Gift" badge, "🎁 Gift voucher · emailed" and a "Buy gift" button instead of "Service · Digital delivery · Request".
- The bespoke `/ncekeniquads` page keeps its own photos (only its bag line uses the listing image).

**Files:** `script.js`, `docs/design/nceks-product-images/*`; storage + product rows (data).

---

## 2026-10-04 — Sold-out items: listed on their store, search-only on the homepage

**Asked for:** keep "Sold out · Notify me" on storefronts; on the Umzila homepage sold-out items must not show or rank anywhere in browsing — only in search results, marked sold out, with Notify me in the modal.

**Root cause of the old behaviour:** the `auto_hide_out_of_stock` trigger set `visible=false` the moment stock hit 0 (and back on restock), so sold-out items vanished everywhere — including their own store — and the back-in-stock sign-up was unreachable.

**What changed:**
- DB: trigger + function dropped (migration `keep_sold_out_products_visible`). `visible` now only means "listed by the seller/admin". The 3 approved physical products hidden purely for being sold out were re-listed (Lumina "Water bottle", Sweet Corner "Sweets 200ml", Lemé "Protection hairstyles"); a hidden service was left alone.
- **Real bug this exposed, fixed:** `validate-cart.js` capped quantity with `itemStock || Infinity`, so stock 0 meant *unlimited* — previously masked because sold-out products were invisible (dropped as "not found"). Now physical stock is a hard cap (0 → line dropped); services keep their old uncapped behaviour. Verified: a sold-out line is removed, an in-stock line passes.
- Homepage (`script.js`): new `browsableProducts()` (listed + in stock) feeds every browse section, "See all" views, the homepage section helper and "Frequently bought together". `applyFilters()` includes sold-out items **only when there's a search term**, sorted after everything in stock; category views still exclude them. Cards get a "Sold out" badge (greyed image); search suggestions say "Sold out" instead of a price; the product modal hides quantity/delivery/Add to Cart and shows "Notify me when it's back".
- Store pages already list sold-out items last with "Sold out · Notify me" — now they actually appear there.

**Verified locally:** homepage browse doesn't contain Velaphi's sold-out 4-wings plate; searching "wings" lists it last, badged; its modal shows the sign-up with Add to Cart hidden; Sweet Corner's store shows "Sweets 200ml · Sold out · Notify me".

**Files:** `script.js`, `style.css`, `index.html`, `netlify/functions/validate-cart.js`, docs, `CLAUDE.md`.

---

## 2026-10-04 — Back-in-stock emails actually sent, buyer identity from tokens, service stores never "closed", Nceks way back to Umzila

**Asked:** how "Notify me" works (and whether signed-in buyers still type their email); fix the client-trusted `userId` gap; no closed-store friction for calendar/service businesses (only mixed stores, saying services book normally and goods may be delayed); the Umzila pill/arrow on the Nceks store.

**Back-in-stock alerts — root cause:** "Notify me" saved a `stock_alerts` row (and fed the marketing-email list via the existing capture trigger), but **nothing ever sent an email** — no function read the table and `notified_at` was never set. Also: the homepage modal ignored the insert's `{error}` (Supabase doesn't throw) and always said "You're on the list"; repeat taps created duplicates; signed-in buyers had to type their email.
- New scheduled function `send-stock-alerts.js` (`netlify.toml`, every 15 min): pending alerts whose product is visible, in stock and from an active store → one email per address listing everything that's back (image, store, price, "View it" → `/<slug>?product=<id>` via SITE_BASE_URL), then `notified_at` is stamped. Max 40 emails/run, 600 ms apart. Scheduled functions can't be hit by URL in production.
- Unique pending index `stock_alerts_one_pending` (product + lower(email) where not yet notified) — a repeat tap is "You're already on the list"; after an alert is sent they can sign up for the next restock.
- Signed in: no email box — one tap, sent to the account email (store page quick view + homepage modal).
- Note: at the time, `auto_hide_out_of_stock` hid products at 0 stock, so "Notify me" was rarely reachable — removed in the entry above.

**Security — buyer identity from the session token:** `validate-cart.js` took `userId` from the request body and used it for the saved-cart upsert, delivery-quote ownership and first-order / per-user discount checks — anyone could overwrite another user's saved cart or borrow their discount allowances. Now it reads the user from the `Authorization: Bearer` token (server-side callers pass `event.trustedUserId`, which no HTTP request can set — used by `lib/reprice-order.js`). Same fix in `get-delivery-quote.js` (quote owner). `checkout.html` (`validateCartHeaders()`) and `cart.html` now send the token; checkout's coupon re-check also sends `persistCart:false` for scoped/Buy Now carts. Verified: a spoofed body `userId` is ignored (no cart row written), a bad token is treated as a guest, pricing unchanged.

**Closed-store rules:** only **goods** wait for a store to open. Services (bookings, drop-offs with collection slots, digital, vouchers) never trigger anything — their calendars already follow store hours. Service-only store page: just "Opens today at 09:00" (no warning, note or popup). Goods-only: unchanged. Mixed store: note/popup say services can be booked as normal and goods may be delayed. Checkout popup only counts goods lines.

**Nceks:** the same navy strip ("‹ Umzila home" pill, "Track an order") and a back-arrow beside the Nceks logo, added through the build script; nav/"Book now" kept on one line at mid widths (nav hides below 1080px).

**Files:** `netlify/functions/{send-stock-alerts,validate-cart,get-delivery-quote}.js`, `netlify/functions/lib/reprice-order.js`, `netlify.toml`, `shop.html`, `checkout.html`, `cart.html`, `index.html`, `script.js`, `ncekeniquads/index.html`, docs, `CLAUDE.md`; migration `stock_alerts_one_pending_per_email`.

---

## 2026-10-04 — New default store template, store sections, saved stores, opening hours, per-store cart & checkout

Full write-up: [`docs/systems/store-pages.md`](systems/store-pages.md) (cart side also in [`checkout-cart-loading.md`](systems/checkout-cart-loading.md)).

**Asked for:** every store (except bespoke ones like Nceks) on the supplied template, with store-specific filter groups ("Plates with wings"); a "Save store" list; working Open/Closed from store hours, with a pre-checkout "store is closed — expect a delay" popup (not for bookings); a review of the booking calendar; a quiet but findable way back to Umzila; store-specific bottom nav and cart; a per-store checkout that doesn't wipe the main cart.

**What changed:**
- **`shop.html` rebuilt from the template**, wired to live data (store by slug, products + images, sponsored boost, favourites, stock alerts, share). Store accent `sellers.theme_color` (new nullable column, seller-editable). "Umzila home" pill + logo back-chevron; bottom nav = Store / Search / Saved / this store's Cart.
- **Store sections:** `products.metadata.store_section` (no new column), set per product in the seller dashboard (with suggestions); falls back to the category. Velaphi's six plates set to *Plates* / *Plates with wings*, and its accent to the template's red. Product edits re-read the current metadata before saving so an admin approval in between isn't undone.
- **Opening hours:** reuse `seller_availability` (already the booking hours); new **Dashboard → My Shop → Opening Hours** editor; new SQL `get_store_hours_status()` (SAST, server-side) used by the store page and checkout. Checkout's `confirmClosedStores()` popup runs inside `preparePendingOrder()` (Pay Now + saved card); skips timed bookings and vouchers; never blocks on a failed lookup.
- **Saved stores:** new `saved_stores` table (own rows only); guests keep a local list merged in at sign-in; homepage "Your saved stores" row.
- **Per-store cart/checkout:** drawer shows this store's lines from the one shared cart; `/checkout.html?store=<id>` pays only those, keeping the rest (`scopeCart`, `cartRest`, `persistLocalCart`); "Want to check out everything together?" → `/cart.html`; `ss_cart_after_paid` keeps unpaid lines after success.

**Real bugs found and fixed on the way:**
- Store-page cart changes were never saved to a signed-in buyer's `carts` row, so the homepage/checkout (which read the row first) brought removed items back / dropped added ones.
- `cart.html` mixed cart shapes: it copied the saved row's `product_id`-shaped items into `ss_cart` (other pages read `id`) and saved `id`-shaped items to the row (checkout reads `product_id`).
- **Buy Now wiped the buyer's whole cart after payment** (success page cleared `ss_cart`), and validate-cart overwrote the saved cart with the single Buy Now item; `reprice-order.js` (R0 orders / guest signing) also overwrote a signed-in buyer's saved cart with the order's items.
- Booking calendar: changing a held time to a slot that turned out full cancelled the old hold first and left the buyer with nothing — `hold-service-booking.js` now restores the previous hold. The Nceks page's start-time grid fell back to 60 min while the server falls back to the ride length (latent: Nceks has 60 set) — aligned.
- Calendar otherwise checked and correct: SAST throughout, slot grid/lead time/horizon match the server, peak-load maths identical in browser, Nceks page and DB trigger, capacity races serialised by the trigger.
- Homepage shop cards inserted shop names/logo URLs unescaped.

**Verified locally (netlify dev, live DB):** Velaphi + Sneaker Cleaners on the template at 390px and desktop; sections; quick-add → drawer shows only Velaphi with the "2 items from another store" line; `?store=` checkout priced only the R70 plate (+R22 delivery, `persistCart:false`) while `ss_cart` kept both; closed popup ("opens tomorrow at 10:00") — "Not now" wrote nothing, "Yes" continued to the order step (insert blocked by the test; no order created); Sneaker Cleaners "Closed now · opens today at 09:00"; guest saved store shown on the homepage; hold-restore tested live (old hold back to `held`); bespoke `/ncekeniquads` unaffected. Test hours, holds and carts removed.
**Not verified in a browser (needs a seller login):** the dashboard Opening Hours / colour / store-section fields (syntax-checked; same patterns as the existing quiz). Signed-in saved-stores sync tested by code path only.

**Known / not done:** services on the template still hand over to the homepage modal for setup; hours can't cross midnight; the client-sent `userId` gap was fixed in the entry above.

**Files:** `shop.html` (rewritten), `checkout.html`, `checkout-success.html`, `cart.html`, `index.html`, `seller-dashboard.html`, `ncekeniquads/index.html`, `netlify/functions/{validate-cart,hold-service-booking}.js`, `netlify/functions/lib/reprice-order.js`, `CLAUDE.md`, docs; migration `store_template_saved_stores_hours_status`.

---

## 2026-10-03 — New favicon, compact featured shops, slim mobile filters, Nceks booking card below the bikers

- **Favicon:** the old `umzila.webp` icon was a thin blue logo that disappeared at tab size. New `favicon.svg`: a white "u" on a navy rounded tile, drawn as a route that ends in an arrow under the red destination dot (the same dot as the wordmark), with a faint white edge so it reads on light and dark tabs. All 16 pages link it, with `umzila.webp` kept as the fallback icon.
- **Featured shops (homepage):** three tall centred cards (60 px logos, ~230 px of the phone screen) became slim horizontal cards: a 44 px ringed logo, name, item count, inline "Featured" pill and a chevron. That's three across on desktop, and on phones (≤640 px) a swipe strip where the next shop peeks in. The section is now ~116 px tall. Markup is in `index.html`'s top-3 render; styles are the `.shops-top3`/`.shop-card*` rules in `style.css`. The old mobile top-border override was removed.
- **Mobile filters:** the white card with a "Filters" heading and a big navy "Show Filters" button is now a single 44 px row (sliders icon, "Filters · Price, size & sort", chevron). The panel only becomes a card while open (`:has([aria-expanded="true"])`), and its controls were tightened (small-caps labels, pill size chips). `script.js` now toggles `aria-expanded` instead of rewriting the button text, which would wipe the icon. Filter logic is unchanged; verified that Apply still closes it.
- **Mobile category tiles, follow-up:** fitting all seven tiles across the row (previous entry) looked cramped. They are back in a sideways-scrolling row, but kept small (48 px, 14 px gaps, edge-to-edge so the next tile peeks in as a scroll hint).
- **Nceks (`/ncekeniquads`) on phones:** the booking card overlapped the biker animation by 70 px, so people missed the bikes. It now sits 6 px below the scene (`.hero-scene` bottom margin in `ncekeniquads/index.html`).

## 2026-10-03 — Checkout terms prompt, faster checkout start, mobile category tiles, Velaphi hero link

- **Terms prompt hidden on mobile:** the "agree to terms" error rendered in `#paymentError` above the fold while buyers pressed the sticky Pay bar, then vanished after 5 s — it only became visible if "More options" happened to shift the page. Now `promptForTerms()` scrolls to the checkbox, highlights it and shows the message beside it; `showError()` scrolls any off-screen error into view (8 s).
- **Checkout start-up:** signed-in load was a ~4.5 s chain of sequential requests. `loadCart()` and `checkAuth()` now run in parallel (`state.cartReady` gates `syncCartOnLogin()` so the saved-cart merge still runs after the local cart, and never for Buy Now). `get-client-config` (public values only) now sends `Cache-Control: public, max-age=600`, removing a ~0.9 s function call on repeat page loads site-wide. Realtime tables were considered and not used — they help live updates, not first load.
- **Mobile category tiles:** a late mobile rule set 70 px tiles (7 × 70 px didn't fit a ~330 px row). Phones now get 46 px tiles (40 px ≤360 px), labels that wrap instead of clipping (`Acces&shy;sories`), and the hero gains 16 px width. Measured at 360/390/430 px: no clipped labels or page overflow; tile row 126 → 89 px; hero 331×187 → 347×196 at 390 px.
- Hero slide 1 now links to `/velaphishisanyama` (store renamed from Isqalo; old `/isqalo-shisanyama` links no longer resolve).

**Files:** `checkout.html`, `netlify/functions/get-client-config.js`, `style.css`, `index.html`.

---

## 2026-10-03 — Nceks Quad Biking launch: co-owners, booking engine, gift vouchers, guest checkout, services per kind

Full write-ups: [`docs/systems/service-orders.md`](systems/service-orders.md), [`docs/systems/bespoke-storefronts.md`](systems/bespoke-storefronts.md).

**Asked for:** a new store (Nceks Quad Biking, `/ncekeniquads`, owned by ntandob38@gmail.com) built from a supplied bespoke HTML design; multiple owners per store; fix the untested service system; gift vouchers; each service kind handled properly.

**Real bugs found and fixed (root causes):**
- `.catch()` on Supabase query builders (they have none) threw mid post-payment: paid service orders never confirmed their booking hold or notified the seller (and skipped later service lines); **product stock was never decremented after any paid order** (`rpc().catch` aborted the stock/order_items loop); referral emails and the profile drop-off notification also aborted.
- **Guest checkout never worked**: orders insert RLS `auth.uid() = user_id` is NULL = NULL for guests; and `generate-payfast-signature` required a session. Fixed with a pending-only anon insert policy and a verified guest signing path (amount must equal the server's own re-pricing).
- Slot pickers queried `service_bookings` under buyer RLS → every slot looked free; no DB guard against double-booking beyond one-per-seller; expired holds blocked slots forever; checkout accepted expired holds; signed-in buyers' saved carts (`script.js`, `checkout.html`, `validate-cart.js`) dropped booking/intake fields.
- Self-service privilege escalation: users could set their own `profiles.role`/`is_admin`; sellers could change their store's `status`; any signed-in user could claim any owner-less store.
- Seller dashboard injected buyer-supplied names/items unescaped (stored XSS); never showed booked times.
- 5 active stores had no `sellers.email` and silently never received order emails.
- In-person/digital services saved as `intake_kind='item'` (buyers saw collection steps); emails/success page/checkout treated every service as "accept → deliver back" with "ships"/delivery/tip wording.

**What changed:** `seller_members` + `my_seller_ids()` (all ownership RLS), admin owner management; capacity booking engine (`booking_capacity`, `units`, trigger, `get_booking_load`, `hold-service-booking`), instant confirm, Bookings tab; gift vouchers (balance, 3 years, star-this-email + WhatsApp/copy block); `complete-zero-total-order` (R0 via server re-pricing, shared `lib/reprice-order.js`); `order-status` for guests' success page; six service kinds with per-kind checkout lines, emails, success page, profile timeline and seller actions; booking↔service-line sync trigger; rep pickers guest-friendly; Nceks bespoke storefront (`/ncekeniquads`), listings, images, hours.

**Verified (local `netlify dev`, live DB, PayFast intercepted, ITN simulated with emails captured not sent):** guest quad booking (3 quads) → hold → checkout → signed PayFast params → paid → booking confirmed, instant `accepted`, seller "booked & paid" email with time; voucher purchase → code issued + voucher email; voucher-covered booking → R0 completion path; tampered R0 order refused; guest signature refuses wrong amount/email/paid/tokenization; guest shoe cleaning with collection/return slots → paid → correct service record; capacity/expiry/re-activation/rejection rules in rolled-back DB transactions; every kind × status rendered from the real seller-dashboard/profile code. All test orders/codes/bookings deleted afterwards; Nceks listings left hidden (`visible=false`) until launch.

**Not verified in the browser (needs a real login):** admin Owners panel, seller Bookings tab / booking settings / card buttons, buyer profile timeline — logic tested via harness only.

**Files:** `ncekeniquads/`, `netlify/functions/{hold-service-booking,complete-zero-total-order,order-status,validate-cart,generate-payfast-signature,manage-discount-codes,submit-marketing-campaign,process-referral}.js`, `netlify/functions/lib/{complete-order-payment,discounts,reprice-order}.js`, `checkout.html`, `checkout-success.html`, `profile.html`, `seller-dashboard.html`, `admin.html`, `shop.html`, `script.js`; migrations `store_co_owners_and_ownership_guards`, `service_bookings_capacity_engine`, `orders_allow_guest_pending_insert`, `sync_booking_with_service_status`.

---

## 2026-10-03 — Clean store URLs: umzila.store/<store-name>

**What was reported:** store links looked like `umzila.store/shop.html?shop=Sweet%20Corner` — ugly to share, and keyed on the display name, so renaming a shop broke every shared link (sellers can rename their own shop). The name lookup also used `ilike`, where `%`/`_` act as wildcards.

**What changed:**
- **DB (applied live):** `sellers.slug` (NOT NULL, unique, format-checked). `sellers_assign_slug` BEFORE INSERT/UPDATE-OF-slug trigger generates it from `shop_name` for every new seller, whichever function creates the row (approve-seller, activate-free-seller, complete-seller-enrollment, admin…): lowercased, accents folded, non-alphanumerics → hyphens, ≤40 chars; reserved page names get `-store`; collisions get `-2`, `-3`. Sellers editing their own row can't change it (silently kept); admins/service role can, with a readable error if the link is reserved or taken. Helpers `seller_slug_base()` / `seller_slug_reserved()`. Backfilled all 18 existing stores (e.g. Sweet Corner → `sweet-corner`, Lemé → `leme`, LondyM's store → `londyms-store`). No existing table/column changed; existing `select('*')` callers just get one more field.
- **Routing:** `netlify.toml` rewrites `/:slug` → `/shop.html` (200, URL stays clean). Real files are served first, so `/cart`, `/style.css`, `/about.html` etc. are unaffected; the SPA fallback is unchanged for multi-segment paths.
- **`shop.html`:** resolves the store from the path (`.eq('slug', …)`), or from a legacy `?shop=<name>` link, then `history.replaceState`s to the canonical lowercase `/slug` keeping `?product=`/`?q=`. Trailing slash stripped before assets load (relative paths would otherwise break). Unknown slug → "Shop not found"; a page name typed without `.html` (e.g. `/cart` if ever routed here) → that page.
- **Links switched to `/slug`:** homepage featured shops + all-shops list + Isqalo hero slide, homepage product modal "Sold by" + share link (`script.js` product select now includes `slug`), shop page "Sold by" + share, profile favourites "Sold by", seller dashboard "View shop", marketing campaign CTA (shop and product destinations — product links now resolve the product's own store, which also fixes admin-created product CTAs that used to land on "shop not found").
- **Admin:** Manage Shops shows each store's link with an editor + "Open ↗" (confirm before changing an existing link, since old shared links stop working).

**Verified:** trigger rules in rolled-back transactions (duplicate name → `sweet-corner-2`, reserved "Cart" → `cart-store`, explicit admin handle normalised, non-admin seller rename keeps slug, taken handle rejected). On `netlify dev`: `/sweet-corner`, `/sweet-corner/`, `/Sweet-Corner?product=…` (modal opens, URL canonicalised), legacy `shop.html?shop=Sweet%20Corner&q=cake` → `/sweet-corner?q=cake`, unknown store → not found, `/cart` still the cart; homepage store/slide/modal links all clean.

**Known:** changing a slug in admin breaks old copies of the previous link (no redirect history kept). Homepage "clothing" hero slide still points at `shop.html?shop=FreshFold`, a store that doesn't exist (pre-existing dead link).

**Files:** `netlify.toml`, `shop.html`, `index.html`, `script.js`, `profile.html`, `seller-dashboard.html`, `admin.html`, `netlify/functions/submit-marketing-campaign.js`, `CLAUDE.md`; DB migrations `sellers_slug_clean_store_urls`, `sellers_slug_backfill_and_constraints`.

---

## 2026-10-03 — Tracking page: animated stage scenes, interactive timeline, PIN show-to-rider

**What changed (owner request — make `track.html` "interactive and fun", building on the looping route-dot animation from the homepage "How delivery works" popup):**
- Hero card per stage with a small looping SVG scene (delivery-network-spec.md §52/§93): preparing (items dropping into a bag beside the store, ticking clock), collecting (car drives up to the store, pin bobs), on the way (dot travels store → your pin, LIVE badge), arriving (car pulls up at your home, PIN bubble), delivered (bag at the door, check pops, confetti), plus a static problem scene. Shared artwork lives once in a hidden `<svg><defs>` (store/home/car/bag/pin symbols) and scenes reference it with `<use>`.
- Tapping the scene shows a short playful bubble ("Beep beep! 🚗") — never covers the PIN or blocks anything (§95).
- Horizontal step timeline with icons and an animated fill rail; tapping any step explains it in past/present/future tense.
- PIN shown as digit tiles (pulsing border while arriving), with a "Show rider" full-screen high-contrast view. PIN card hides once delivered/cancelled.
- "Live · updated Xs ago" ticker; "About X km away" chip from straight-line rider→destination distance (labelled "about"; no ETA claimed — `get_delivery_tracking` returns none). Hidden once the rider is at the door.
- ARRIVING vs PIN_REQUIRED now worded separately ("Rider arriving" / "Your rider is here!") — the pill used to say "Rider has arrived" for both.
- Scenes only re-render when the stage changes, so the 20s poll doesn't restart animations.
- Reduced motion (§54): CSS animations off via media query; SMIL scenes are frozen on a representative frame (`data-freeze` + `pauseAnimations()`). All state is also in text.

**Unchanged:** auth/redirect, `get_delivery_tracking` RPC, polling, Leaflet map + staleness logic, feedback prompt, support card.

**Verified:** temporary mocked copy of the page on `netlify dev` (deleted afterwards) — walked PENDING → ASSIGNED → IN_ROUTE → PIN_REQUIRED → DELIVERED → CANCELLED in one session; pill/title/scene/timeline/PIN/ticker all updated; show-rider overlay opens/closes; no horizontal overflow at phone width; freeze-frame path works. Not yet seen against a real live delivery.

**Also:** service-order seller email (`lib/complete-order-payment.js`, text only) no longer mentions a "campus collection point" — drop-off services now say Umzila collects the item from the customer and drops it off (or the seller collects it themselves where relevant); in-person/digital services get the short version.

**Files:** `track.html`, `netlify/functions/lib/complete-order-payment.js`.

---

## 2026-10-03 — Rebrand off "campus marketplace" + Mystery Gift fun facts now earn a real 2% bonus

**What was reported:** Google showed Umzila as a "campus marketplace"; homepage copy (footer, section titles, Sell modal, fun facts, "How delivery works") still described a UKZN-student, bike-delivery, order-number-handover operation. Separately, the Mystery Gift popup's fun-fact step offered "a little extra value" but gave nothing extra — every claim got the same 10% code, only the email copy differed — and only one random fact was shown, for 2.5s.

**What changed:**
- SEO: `index.html` title/meta description/og tags → "Umzila | Durban's Best Local Businesses, Delivered". `og:url` deliberately omitted (CLAUDE.md: never hardcode the site URL in the frontend; crawlers default to the fetched URL). `about.html` title fixed (was "About-Streetsale") + meta description + long About paragraph.
- Copy: footer tagline (index/shop/about), "Trending on Campus" → "Trending on Umzila" (index.html + script.js `SECTION_KEY_MAP`), Sell modal intro, seller location field ("Your location", no campus), fun facts rewritten for the Durban-businesses positioning, "How delivery works" (myP7) → address at checkout / track live / show 4-digit code.
- Mystery Gift bonus: prompt now reads "Want a bonus added to your mystery gift?" — deliberately never names the 2% or the base 10% (owner rule: the gift must stay a mystery until checkout; keep percentages out of all user-facing popup/email copy). "Yes, add the bonus" shows all 4 facts in a list with a "Claim my gift + bonus" button (no auto-advance timer). Backdrop-click on the facts pane claims with the bonus (it used to auto-claim after 2.5s, so a close-without-claim would otherwise be a regression). `claim-mystery-gift.js` issues `amount: 12` when `fun_fact` is true (10 otherwise); checkout already applies `mystery_gift` codes as a percentage of `amount` (`lib/discounts.js`), so no checkout change. The client no longer sends `fact_text` and the server no longer echoes client text into the email — the fun-fact email now confirms a bonus was added, without naming it. Reinstate email reads the code's real `amount` instead of hardcoded "10%". The fun-fact step is only offered when `code_state === 'none'`, so the bonus only ever lands on a freshly minted code.

**Verified:** popup walked end-to-end on local `netlify dev` with the claim call stubbed in-page (no real code/email); handler run against a mocked Supabase/Resend: `fun_fact:true` → amount 12 + bonus email, `false` → amount 10 + plain email.

- Email templates: every "campus marketplace" header/footer line (24 across 12 functions, incl. `payfast-itn.js` and `lib/complete-order-payment.js` — footer text only, no logic touched) → "Durban's best local businesses"; "campus shoppers"/"campus sellers"/"Welcome to the campus marketplace" reworded likewise.
- Icons: homepage category bubbles redrawn where they didn't fit — Clothing (hanger outline → t-shirt), Beauty (generic sparkles → lipstick), Services (sun burst → wrench), Hot Deals (lightning → flame, matching the section's 🔥). "How delivery works" illustrations replaced: bike → animated live-tracking map (store → pin, moving dot, LIVE badge); hands → phone showing a 4-digit code handing over a bag.

**Left as-is:** `lib/complete-order-payment.js` seller email still says the customer will drop off "at the Umzila campus collection point" — operational instruction, not branding; confirm whether that flow still exists before rewording.

**Files:** `index.html`, `about.html`, `shop.html`, `script.js`, `netlify/functions/claim-mystery-gift.js` + 11 other email-sending functions under `netlify/functions/` (footer text only).

---

## 2026-09-26 — Checkout: split the value-anchor line from the time estimate, scale wait time per store

**What changed (founder follow-up to the time-saved anchor below):**
- The italic reframe line ("Delivery is based on distance, not basket size...") moved from inside `#timeSavedBlock` to directly below the order Total in the price summary — reads as the reason for the number the buyer is looking at, right where they're looking. The time-saved figure itself stays where it was (below the address, above the summary).
- Wait time now scales per store instead of a single flat 30-45min: `WAIT_MIN_PER_STORE_LOW`/`HIGH` (20-30min) × the number of distinct sellers in the cart, not just the farthest one. Reasoning: a customer collecting a 2-store order themselves genuinely queues twice, not once — the old flat range understated multi-seller orders. A single-seller order's range also shifted slightly (was 30-45min base, now 20-30min base) since that's the same per-store unit, just ×1.

**Verified:** live against `netlify dev`. Single real seller (Isqalo, 8.98km straight-line): "1hr5min – 1hr15min" (down from the old flat-wait "1hr15min – 1hr30min", as expected from the lower per-store base). Real 2-seller cart (Isqalo + Lumina, only one with a known pickup point — travel distance still keys off whichever seller's location is known, but the wait time counts both stores): "1hr25min – 1hr45min", matching the formula by hand. Confirmed the italic line now renders directly under the Total row. Test cart data cleaned up afterward.

**Files:** `checkout.html`.

---

## 2026-09-26 — Checkout: time-saved value anchor, replacing the earlier fee-ratio note

**What changed:** replaces the same-day "anchor note under the delivery fee" entry below with a more prominent, always-on version per founder follow-up. A new block sits below the delivery address and above the price summary — on-screen with the total the buyer is about to pay — showing `⏱ Time saved compared to collecting yourself: <range>` plus a short italic line ("Delivery is based on distance, not basket size — we handle the trip, fuel and hassle, so you don't have to."). The old ratio-gated note under the "Delivery" line in the Order Summary is removed; this supersedes it with one clearer message instead of two competing ones in different places.

**Calculation (founder-specified formula):** straight-line (haversine) distance from the farthest cart seller's `pickup_geo` to the picked delivery address, × 2.5 min/km, doubled for the round trip, plus a 30–45min wait-in-queue range — e.g. 11km → 55min round-trip travel + 30–45min wait = "1hr25min – 1hr40min". Straight-line, not real road distance, since `GOOGLE_ROUTES_SERVER_KEY` still isn't live — a known approximation (real road distance is typically meaningfully longer; e.g. the Isqalo→Umgudulu Rd order used in earlier testing is 8.98km straight-line but 14.63km by real road). Swap in the real `distanceKm` from a `get-delivery-quote.js` quote once the key lands, instead of this client-side estimate.

**Implementation:** `sellers.pickup_geo` (already public-SELECT via existing RLS, no policy change needed) is decoded client-side from PostgREST's hex-encoded EWKB — a browser port of `get-delivery-quote.js`'s existing `parseGeographyPoint()` (`DataView`/`Uint8Array` instead of Node `Buffer`, same algorithm) since there's no shared module between a Netlify function and a static page. Piggybacks on the existing `updateEstimatedDelivery()` seller fetch (added `pickup_geo` to its existing `.select()` — no new query).

**Verified:** live against `netlify dev` with the real Isqalo Shisanyama pickup point and a real Umgudulu Rd/Palmiet address — decoded coordinates matched the known real values exactly (cross-checked against a direct SQL `ST_X`/`ST_Y` read), and the rendered text ("1hr15min – 1hr30min" for the real 8.98km straight-line distance) matches the formula by hand. Confirmed the block correctly stays hidden until both a real address and a seller pickup point are available. Test cart data cleaned up afterward.

**Files:** `checkout.html`.

---

## 2026-09-26 — Checkout: anchor note when the delivery fee looks steep next to a small basket (superseded, see above)

**What changed:** `checkout.html`'s Order Summary now shows a small italic note under the delivery fee — "Flat fee no matter your basket size — still less hassle (and often less cash) than the round trip yourself." — whenever the fee is at least 40% of the cart subtotal (`DELIVERY_VALUE_NOTE_RATIO` in `updateShippingAndTotal()`). Reasoning: a real live-tested payout-based fee (see the entry below) can be a large fraction of a small order's price even when it's objectively a good deal against the alternative (an Uber round-trip to fetch it yourself runs R140+, a taxi round-trip R32 plus two waits and a walk) — the sticker shock comes from comparing the fee to the order price, not to the real alternative, so the note deliberately anchors against the latter instead of trying to justify the number against the former. Reflows automatically as the cart changes; doesn't reference a fixed time estimate since that varies too much to state as fact.

**Files:** `checkout.html`.

---

## 2026-09-26 — Delivery pricing overhaul: fee now tracks real driver cost, hard 20km cutoff, per-zone launch promo

**What was broken:** a live test (real Isqalo Shisanyama order to a real Umgudulu Rd address, ~14.6km real road distance) showed the existing `distance_tiers`/`max_delivery_fee` model would charge a student **R80** for that delivery — capped down from a nominal R85. Checking the same distance against the real driver-payout formula showed the driver would only be paid **R62.54** for that route: the R80 fee wasn't sized to actual cost. Worse, because the payout formula scales unbounded with distance while the old fee capped at R80, **any order past ~19km was already losing money**, before this change and independent of it. The founder decided: since deliveries are currently done in-house (no hired drivers), the fee should equal real cost, no more, no arbitrary cap.

**Root cause:** the distance-tier table and the driver-payout formula were two independent, hand-tuned pricing models for the same real-world cost — a classic "two sources of truth for one concept" flaw, not just a wrong number.

**What changed:**
- `get-delivery-quote.js`: base delivery fee is now `estimatePayout(...)` (the exact function that pays the driver, from `lib/payout-formula.js`) × `(1 + margin_percent/100)`. `margin_percent` defaults to 0 — fee == driver pay today; raising it later (admin panel, one field) is the entire "turn on profit once real drivers are hired" step. The old `distance_tiers`/`max_delivery_fee`/`extended_zone_fee` columns and the `resolveDistanceBaseFee()` tier lookup are gone.
- New hard cutoff: `delivery_pricing_config.max_service_distance_km` (default 20) — a real route longer than this is refused outright rather than priced, replacing the old cap-and-still-serve behavior that was quietly losing money on long routes.
- New per-zone, time-boxed launch promo: `service_zones.promo_active`/`promo_cap_fee`/`promo_expires_at` — lets a zone's delivery fee be capped **below real cost** for a launch window (e.g. first few days), with an optional auto-expiry. `find_service_zone_for_point()` now returns these alongside the zone match so pricing needs no extra query.
- `admin.html`: replaced the tier-editor UI in Delivery Pricing with `margin_percent` + `max_service_distance_km` fields; added a "Launch promo" column with inline cap/expiry controls to the Service Areas table (same direct-update pattern as the existing self-arranged-radius control).
- Incidental fix: the pricing-editor's version-insert never carried `max_bundle_leg_km` forward, so every past edit through the admin panel would have silently reset it to the column default (15) instead of the founder's real value (3). Now preserved on save.

**Verified:** `GOOGLE_ROUTES_SERVER_KEY` still isn't live, so the new code can't be exercised over real HTTP past the Google Routes call (same limitation as everything else blocked on that key) — confirmed instead by extracting the exact new logic and running it against the real active config + a real OSRM road distance for the same order used in the live test (margin=0 reproduces the real payout exactly; margin=20% scales correctly; the 20km cutoff is exact at the boundary; the promo cap correctly overrides cost, correctly ignores expiry, correctly persists with no expiry set). Confirmed live against `netlify dev` that the missing-key error path is unchanged. Did not click through the new admin.html UI live (no admin credentials this session) — recommend a quick visual check.

**Files:** `netlify/functions/get-delivery-quote.js`, `admin.html`, migration `delivery_payout_based_pricing_and_zone_promo`.
**Full write-up:** `docs/systems/delivery-network-spec.md` §AA.

---

## 2026-09-18 — Stage 4 live end-to-end test: two real bugs found and fixed

**What happened:** tested the full multi-seller bundling flow live (seller → rider → customer) with `max_bundle_leg_km` temporarily raised to 15km so the real Isqalo/Sweet Corner pair could be used, since the real value (3km) is below their real distance. A real order was built through the actual payment triggers (not faked) since the Google Routes key still isn't live. The whole flow worked end to end — readiness gating, real 2-store pickup sequencing (correctly picked whichever store was actually nearer the driver, disagreeing with the quote's guess), partial-pickup handling, PIN confirmation, and a real GPS-computed payout (R75.30, correctly including the extra-pickup component).

**Two real bugs found and fixed:**
1. `advance-route.js`'s `start_delivery` couldn't handle `PARTIALLY_PICKED_UP` — a pre-existing gap (not introduced by Stage 4) where a partially-collected pickup could never start its delivery leg, since the state machine only allows `PICKED_UP → IN_ROUTE`, not `PARTIALLY_PICKED_UP → IN_ROUTE`. Fixed by upgrading to `PICKED_UP` first when needed.
2. `get_delivery_tracking()` (built in an earlier part of this session, before bundling existed) threw a real SQL error for any bundled delivery — its pickup-status subquery assumed exactly one pickup stop per route. `track.html` silently swallowed the error as "no tracking available," hiding the failure from the customer entirely. Fixed to report the earliest not-yet-completed pickup stop.

**Verified:** both fixes confirmed via SQL first, then live in the browser. All real test data cleaned up, zero leftover rows. `max_bundle_leg_km` dropped to its real target of 3 after the live pass succeeded — Stage 4 is now fully closed out.

**Files:** `netlify/functions/advance-route.js`, migration `fix_get_delivery_tracking_bundle_regression`.
**Full write-up:** `docs/systems/delivery-network-spec.md` §Z.
**Commit:** *(pending — see this entry's own commit; not pushed yet, per founder instruction)*

---

## 2026-09-17 — Admin-set self-arranged radius: skip the delivery network for hyperlocal sellers

**What shipped:** hyperlocal sellers (e.g. a residence student selling ice-cream/water) can now be flagged by an admin, via `admin.html`'s Manage Shops section, with a radius (km) within which their free-delivery orders never enter the driver/delivery pipeline at all — buyer and seller coordinate the handoff directly, same as every order did before this build. Mechanism: `get-delivery-quote.js` now checks this before the paid Google Routes call and returns `ineligible('self_arranged')`, which the existing checkout flow already silently treats as "no delivery quote" — zero changes needed to checkout.html or the delivery-creation trigger. New `sellers.self_arranged_radius_km` column; new admin-only RLS policy `sellers_admin_all` (there was no admin UPDATE policy on `sellers` at all before this).

**Files:** `netlify/functions/get-delivery-quote.js`, `admin.html`, migration `sellers_self_arranged_radius`.
**Full write-up:** `docs/systems/delivery-network-spec.md` §X.
**Commit:** *(pending — see this entry's own commit; not pushed yet, per founder instruction)*

---

## 2026-09-17 — Stage 4: real multi-seller cart bundling

**What shipped:** a cart spanning up to 2 distinct sellers now gets bundled into one delivery with multiple pickup stops before its one drop, instead of being refused. New migration adds `delivery_pricing_config.max_bundle_leg_km` (real target 3km, seeded at 15 during build) and changes `find_nearest_eligible_drivers` to rank across multiple sellers, plus a new `order_pickups_by_driver_distance` to sequence pickups from the driver's real position. `get-delivery-quote.js` prices a 2-seller cart via 2 plain Google Routes calls (cheaper than `optimizeWaypointOrder` for just 2 orderings) and stores the winning visiting order. `advance-route.js`'s `complete_pickup` now resolves the current pickup stop server-side and only transitions `deliveries.status` once every stop for a delivery is done (partial pickups no longer block moving to the next store). Fixed a real correctness bug this surfaced in `advance-delivery-on-fulfillment.js`: it was transitioning to `READY_FOR_DISPATCH` the instant any one seller on a shared order called it, correct only by accident for single-seller orders — now waits for every seller.

**Verified:** full transactional lifecycle test including the real (unmodified) payout trigger firing correctly for a 2-pickup route; live HTTP regression tests against `netlify dev` for the refusal/self-arranged paths. **Not yet verified:** the real Google Routes API call (no live key) and the live driver-auth HTTP/UI flow (no active browser session) — both named, tracked limitations, not silently skipped. `max_bundle_leg_km` stays at 15 (not dropped to the real 3) until those pass for real.

**Files:** `netlify/functions/get-delivery-quote.js`, `netlify/functions/lib/dispatch.js`, `netlify/functions/respond-to-driver-offer.js`, `netlify/functions/advance-route.js`, `netlify/functions/advance-delivery-on-fulfillment.js`, `netlify/functions/lib/batch-dispatch.js`, `logistics.html`, migration `delivery_stage4_multi_seller_bundling`.
**Full write-up:** `docs/systems/delivery-network-spec.md` §Y.
**Commit:** *(pending — see this entry's own commit; not pushed yet, per founder instruction)*

---

## 2026-09-17 — Founder correction: seller "ready" toggle, premature "delivered" popup, tracking-activation gate

**What was broken:** the seller dashboard let sellers pick any of 5 states (`Pending/Packaging/Fulfilled/Delivered/Returned`) for delivery-network orders. Marking `Fulfilled` (packed, not yet shipped) wrote `order_item_statuses.status='fulfilled'`, which `profile.html` reads as "Seller marked this as delivered. Did you receive it?" — so customers were prompted to confirm delivery before the order had even left the store. Root cause: an earlier same-session design correction (§J, Stage 7) reused this existing 5-state dropdown instead of building the plan's own §40 "simple binary ready toggle" — the aggregation logic was reused correctly, but the semantics ("fulfilled" == "delivered" from the customer's POV) weren't.

**What changed:**
- `seller-dashboard.html`: delivery-network orders (have a `deliveries` row) now get a binary `[Mark Ready for Pickup]` → `✓ Ready for Pickup` control instead of the 5-state dropdown; non-delivery-network orders are unaffected. New `sellers_select_own_order_deliveries` RLS policy on `deliveries` (there was none for sellers before) makes this possible.
- `profile.html`: delivery-network orders now derive customer-facing status from the real `deliveries.status`, not the `order_item_statuses` aggregate; the premature "did you receive it?" self-report prompt is suppressed for these orders — the driver's real PIN confirmation is now the only thing that can show "Delivered".
- `track.html`: fixed a related copy bug found while closing this out — the "no rider assigned yet" fallback text was still shown whenever driver coordinates are hidden by the earlier tracking-activation gate, even once a rider actually is assigned and collecting (just not yet visible per design). Now shows accurate copy for that state.
- Confirmed `advance-route.js`'s pickup-acceptance path never gated on seller readiness in the first place (verified by reading it, no change needed) — a biker showing up before the seller clicks "ready" was never blocked.
- Answered the standing "is order bundling built" question: multi-store cart bundling (different sellers in one delivery) is deliberately deferred per §B.2 (only one store exists to test against); multi-delivery route batching (different customers on one route) is already built and live (`evaluateBatchCandidates`, Stage 11).

**Files:** `seller-dashboard.html`, `profile.html`, `track.html`, migration `sellers_select_own_order_deliveries`.
**Full write-up:** `docs/systems/delivery-network-spec.md` §W.
**Commit:** *(pending — see this entry's own commit; not pushed yet, per founder instruction)*

---

## 2026-09-17 — Delivery network Stage 14 (notification system) built

**What happened:** Eleventh implementation stage, built entirely by me (touches the shared `lib/delivery-state.js` central to every delivery function, kept out of subagent hands). Plan §168 asks for centralized notification triggering rather than scattering calls across dispatch/pickup/PIN functions — `notify()` is now called from a single place, `transitionDelivery()` itself, so every future status-changing code path gets notifications automatically.

**Scope decision, made explicitly:** email only, not email+in-app. No customer-facing in-app notification feed exists anywhere in this codebase, and `track.html` (Stage 12) already gives customers live in-app status visibility — building a duplicate in-app notification center wasn't justified for a pilot with no real delivery volume yet. The `channel` column still supports `'in_app'` for later.

**What shipped:** new `notification_log` table with a unique dedup index (plan §111/169 — never double-send the same delivery-status email); new `netlify/functions/lib/notify.js` sending Resend emails for the 5 delivery states a customer actually needs to know about (`IN_ROUTE`, `ARRIVING`, `DELIVERED`, `FAILED`, `CANCELLED`), in the plan's specified warm/expressive tone, with the delivery PIN and a `track.html` link embedded directly in the relevant emails. `transitionDelivery()` now calls it on every successful transition (awaited, not fire-and-forget — a Netlify Function process can freeze the instant its handler resolves, so this matches the existing awaited-but-error-tolerant pattern already used for dispatch).

**Reconciled, not rewritten:** `send-on-the-way.js` (the existing service-collection "rep is on the way" email, a separate live system) had its own inline copy of the exact email header/footer chrome `lib/notify.js` also needs — per the plan's explicit "reconcile, don't duplicate... extend/wrap, don't rewrite" instruction, only that shared chrome now comes from `lib/notify.js`'s exported `emailShell()`/`esc()` helpers. The function's own trigger logic, auth, and rate-limiting are completely untouched. Verified byte-for-byte identical HTML output before/after via a side-by-side Node script — a true no-op refactor of a live path, not a behavior change.

**Verified:** all 3 touched files pass `node --check`; `notify()`'s two fast-paths (missing `RESEND_API_KEY`, non-notifiable event) unit-tested directly with a garbage Supabase client to guarantee no accidental real call; the dedup unique index tested for real against the database (exact duplicate correctly rejected, different event correctly allowed); `send-on-the-way.js`'s refactored output confirmed byte-identical to the original. Security advisor sweep clean relative to this stage. No PayFast/checkout/seller-dashboard/admin/logistics file touched.

**Known limitation, tracked not hidden:** no real Resend send was exercised end-to-end in this session's sandbox (no `RESEND_API_KEY` available locally) — verified at the unit/DB level only, same class of limitation already flagged for other frontend/integration work this session.

**Full write-up:** `docs/systems/delivery-network-spec.md` §P.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Founder decisions applied: real payout formula, real batch threshold, support contact, Google address search

**What happened:** Immediately after Stage 17 closed the full plan, the founder answered every remaining open item in §C in one message. Applied same-session: real driver payout formula, real batching ETA threshold, real support contact number, and the Photon→Google address-autocomplete switch.

**What shipped:**
- **Payout formula** (`base + per_km*route_km + per_extra_drop*(drops-1) + per_extra_pickup*(pickups-1) + per_min_over*max(route_minutes-free_minutes,0)`, real Rand values) replaces the old 75%-of-fee placeholder in both the authoritative Postgres completion trigger (uses the route's real final distance/duration/stop-count) and the pre-acceptance JS estimate shown to drivers (`netlify/functions/lib/payout-formula.js`).
- **Batching threshold** (90min hard cap, ~60min target) replaces the old flat-distance placeholder — estimated without an extra paid Google Routes call by combining a straight-line proxy for the unknown leg with the delivery's own already-real quoted duration for the known leg.
- **Support contact** (+27797662768) added as a real "Need help?" WhatsApp/call entry point on `track.html`.
- **Google Places autocomplete** replaces OpenStreetMap Photon on `checkout.html`/`profile.html`/`seller-dashboard.html`, via a new server-side proxy (`netlify/functions/google-places.js` — never a browser-facing key). **Ships with an automatic Photon fallback**, added after flagging the regression risk to the founder: since the real Google key isn't in Netlify yet and checkout is a live, payment-adjacent flow, a hard cutover would have broken address entry everywhere until the key is added. Google is preferred when available; Photon is the safety net until then, with zero further code changes needed once the key lands.

**Verified:** payout formula tested against two real completed-route scenarios with hand-computed expected amounts (both matched exactly, including the minimum-floor clamp); the Photon-fallback control flow tested via simulation (Google-success/Google-failure/aborted-request all behave correctly). All 8 touched/new files pass syntax checks. Security advisor sweep clean. No PayFast file touched.

**Known limitation, tracked not hidden:** the Google Places integration can't be live-tested until the real key exists in Netlify — built faithfully from documented API shapes, not yet exercised against a real response.

**Full write-up:** `docs/systems/delivery-network-spec.md` §U.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Full live end-to-end browser test finds and fixes two real production-blocking bugs

**What happened:** discovered mid-session that `umzila.store`'s Netlify deploys had silently stopped after Stage 6 — the account ran out of build-credit minutes, and every deploy since has failed with `"Skipped due to account credit usage exceeded"` (confirmed via the Netlify API's deploy history). Nothing from Stage 7 onward had ever run for real anywhere. Linked the local repo to the real Netlify site and ran `netlify dev` (pulling real env vars directly from Netlify, never through chat), then drove a real test order through the entire real pipeline across three real, separately-logged-in browser tabs (customer/seller/driver).

**Two real bugs found, both invisible to every earlier SQL-only test:**
1. **Every delivery offer acceptance was silently broken in production.** `transitionDelivery()` never selected `quote_id`/`destination_geo` on its `deliveries` queries; `respond-to-driver-offer.js` reads both directly off its return value, so both were always `undefined` and route creation failed with `reason: 'no_quote'` on every real accept, every time, silently reverting to `REASSIGNING`. A driver could never actually be assigned a route in this entire build until this test caught it. Fixed by adding both columns to `lib/delivery-state.js`'s two `SELECT`s.
2. **The pickup checklist could never load for a real order.** The live checkout flow has never once written to `order_items` (confirmed by a full codebase grep — zero write sites anywhere); only `orders.items` (jsonb) is reliably populated, but the Stage 9+10 pickup checklist and `route_stop_items`'s real foreign key both depend on `order_items`. Root-cause fixed (not a read-path patch) with a new trigger, `populate_order_items_on_payment()`, mirroring the existing `create_delivery_on_payment()` trigger exactly — purely additive, fires for every paid order.

**Verified:** both fixes re-verified live in the same browser session immediately after fixing — the full order flowed all the way through to `DELIVERED`, with a real auto-computed payout (R20.00, matching the real formula exactly), real live tracking, real feedback submission visible on the seller and admin dashboards, and 3 real confirmation emails sent via Resend (confirms Stage 14 genuinely works). All 4 new admin tabs confirmed rendering correctly with real data for the first time, including Stage 16's subagent-built Delivery Ops map. All test data (order, delivery, route, driver, feedback, notification log) cleaned from the real database afterward — zero leftover rows.

**Why this matters:** every prior stage's database-level testing this session was real and rigorous, but this was the first time the actual integration between functions — not each function's logic in isolation — was exercised. Both bugs were integration bugs, invisible to any test that manually assembled the data a function expected rather than actually calling the function that was supposed to produce it.

**Full write-up:** `docs/systems/delivery-network-spec.md` §V.
**Commit:** *(pending — see this entry's own commit; not pushed yet per founder instruction, Netlify is out of deploy credits)*

---

## 2026-09-17 — Delivery network Stage 17 (analytics) built — the full 196-section plan is now complete

**What happened:** Fifteenth and final implementation stage of the delivery network build. Unlike every other stage, the plan itself frames this one as explicitly lowest priority and "post-pilot-validation... not part of the launch checklist," since it needs real operational data to be meaningful — built anyway, structurally correct, per the founder's standing "nothing gets left out" instruction, with the honest caveat that it will show near-empty numbers until real delivery volume exists.

**What shipped:** two Postgres views (`route_profitability_v`, `delivery_analytics_summary_v`) over existing tables, no new tables. Exposed only through two admin-gated `SECURITY DEFINER` functions (cross-seller/cross-customer aggregates have no natural per-row RLS scoping, so the admin check lives inside the function, same pattern as `get_delivery_tracking`). New "📈 Delivery Analytics" admin tab: a KPI summary grid and a per-route profitability table matching the plan's own "ROUTE #348" breakdown example.

**Deliberately incomplete, documented not hidden:** average pickup time, rider acceptance time, and customer ETA accuracy (plan §99) need per-event timestamp diffing against `delivery_events` — a meaningfully bigger, harder-to-verify piece of SQL, left out and tracked (noted both in the docs and directly in the admin UI) rather than shipped untested. Per-service-zone analytics (plan §144) would need a real schema addition (deliveries don't currently retain which zone they matched) — not added casually for the lowest-priority stage of the build.

**Verified in the database:** both RPCs tested for real — non-admin correctly rejected, admin correctly sees results, and a constructed test scenario's exact arithmetic checked (a R40 delivery, R30 driver payout → R10 remaining, computed correctly). All test data cleaned up. Security advisor sweep clean relative to this stage.

**Full write-up:** `docs/systems/delivery-network-spec.md` §T.
**Commit:** *(pending — see this entry's own commit)*

**This closes the full 196-section delivery network plan.** All 17 stages are built (Stage 4's bundle engine remains a deliberate, founder-approved no-op; Stage 13b, found missing mid-session, was built rather than left out). What remains is entirely founder-side: the outstanding items in the spec's §C action list, and watching the system run once real delivery volume exists to validate what this stage's numbers actually show.

---

## 2026-09-17 — Delivery network Stage 13b (delivery feedback / compliments & complaints) built

**What happened:** Fourteenth implementation stage — the gap found and flagged while closing out Stage 11 (a real stage added during the original plan reconciliation, between Stage 13 and 14, that got missed while working through 12/13/14/15/16 in a different order). Built now, in full, per its original spec. Built entirely by me.

**What shipped:** new `delivery_feedback` table (one submission per delivery, enforced by a unique index) and `netlify/functions/submit-delivery-feedback.js` — the only place a row is created. Resolves `seller_id`/`driver_id` itself from the delivery's actual route rather than trusting the client, a deliberate tightening beyond the plan's literal "customer can insert their own" RLS wording: there is no client-facing INSERT policy at all, closing off a possible complaint-misattribution path before it could be a problem. Three frontend surfaces: `track.html` gets a post-delivery "How was your delivery? ♡ Loved it / Something went wrong" prompt (plan's exact copy) with category buttons for complaints; `seller-dashboard.html` gets a new "Feedback" tab scoped to the seller's own shop; `admin.html` folds a feedback list into the existing Stage 16 Deliveries section (as the plan itself said to do, not a separate admin build), each entry linking into the existing delivery-timeline drill-in.

**A testing mistake caught mid-session, not a product bug:** an RLS negative-test initially tried to reuse a `set_config('role', 'authenticated', ...)` call from a separate, earlier tool call — those settings don't carry across connections, so it silently ran as the bypass-RLS service connection and gave a false pass. Caught by checking the row actually existed afterward, and correctly re-verified within a single transaction (the same pattern already used successfully for every other RLS test this session).

**Verified:** all 4 touched files pass syntax checks; the seller_id/driver_id resolution logic tested against a real route; the one-per-delivery unique index tested for real; RLS re-verified correctly (unrelated user sees nothing, raw client INSERT correctly rejected). Security advisor sweep clean relative to this stage. No PayFast/checkout/logistics file touched, and no changes anywhere outside this stage's own three frontend surfaces plus the one new function.

**Known limitation, tracked not hidden:** no local Netlify dev environment to visually confirm any of the three frontend surfaces render correctly — same class of limitation as every other frontend piece this session.

**Full write-up:** `docs/systems/delivery-network-spec.md` §S.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 11 (optional dynamic batch offers) built — and a missed Stage 13b found

**What happened:** Thirteenth implementation stage. Explicitly marked optional by the plan itself, built anyway per the founder's standing "nothing gets left out" instruction. Built entirely by me (touches the shared dispatch/accept code path). While closing this out, found that "Stage 13b — Delivery feedback (compliments/complaints)" — a real stage added during the original plan reconciliation, between Stage 13 and 14 — was never built, having been missed while working through 12/13/14/15/16 in a different order. Tracked explicitly, not silently dropped; it's next.

**What shipped:** new `find_batchable_routes()` RPC (mirrors `find_nearest_eligible_drivers`'s exact pattern/lockdown) finds an already-moving driver's route close enough to a new pickup to add it as a batch stop. `netlify/functions/lib/batch-dispatch.js`'s `evaluateBatchCandidates()` tries this first when a delivery becomes `READY_FOR_DISPATCH`, only falling through to the existing idle-driver dispatch if nothing's close enough. `respond-to-driver-offer.js`'s accept path now branches on `offer_type` — a `'batch_addition'` offer appends (pickup, drop) stops to the end of the existing route instead of creating a new one, closing a gap that file's own Stage 10 comment had explicitly flagged and left open. Deliberately simplified to append-only (not the plan's fuller 3-option route-insertion comparison) — tracked as a future enhancement once a driver carries 3+ simultaneous stops.

**Founder input still pending, used as a placeholder, not invented silently:** the real ETA-impact threshold (already tracked in the spec's action list) has no live routing/duration available internally, so it's a straight-line-distance proxy (1.5km) until a real number is given and Google Routes is live.

**Verified in the database:** the new RPC tested for real (fresh nearby driver found; stale/not-yet-started routes correctly excluded); a full batch scenario mirrored at the SQL level end to end (existing route, new delivery, candidate found, offer created, stops correctly appended at the right sequence, delivery correctly linked to the shared route) — all cleaned up, zero leftover rows. Security advisor sweep clean relative to this stage. No PayFast/checkout/seller-dashboard/admin/logistics/track file touched.

**Known limitation, tracked not hidden:** no local Netlify dev environment to exercise the real HTTP path end to end — verified via direct SQL mirroring the JS's exact operations, plus syntax checks, not a live function invocation.

**Full write-up:** `docs/systems/delivery-network-spec.md` §R.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 15 (homepage active-delivery widget) built

**What happened:** Twelfth implementation stage. The plan itself notes this is "substantially delivered by Stage 12," kept as its own stage only for numbering — cosmetic polish per plan §50's exact state-by-state widget spec. Built entirely by me, small and self-contained, no new migration.

**What shipped:** a widget at the top of `index.html`, above the hero carousel, shown only to a signed-in customer with a non-terminal or recently-delivered `deliveries` row. Status-driven copy through "being prepared" → "with a driver" → "on the way"/"arrived" → "delivered ✓" (which then correctly disappears again 2 hours after `delivered_at`, per §50's "no need to permanently occupy homepage real estate").

**One deliberate scope narrowing:** §50's "During active travel" example text is a literal ETA ("Arriving in about 7 minutes") — this build has no ETA-recompute engine (consistent with the founder's own early instruction ruling out in-page routing machinery), so a fabricated minutes figure would be dishonest. Used honest status copy instead, the same principle `track.html`'s staleness label already applies.

**Verified:** `index.html`/`style.css` inline scripts syntax-check clean; the widget's exact `deliveries` query tested for real against the database as the owning customer, confirmed correct. No new migration or RLS change — reuses the existing `deliveries_select_own` policy.

**Full write-up:** `docs/systems/delivery-network-spec.md` §Q.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 16 (admin operations dashboard) built — closes Stage 13's PIN-unlock gap

**What happened:** Tenth implementation stage. The plan's own text for this stage was terse but its execution breakdown flagged it as the most parallelizable stage in the whole build (6 independent units, disjoint files/tables). Fixed a security prerequisite and built the pricing editor personally; dispatched two genuinely parallel subagents for the rest — same pattern as Stage 8, every claim independently re-verified against the real database and every diff hunk read personally before trusting it.

**Prerequisite gap found and fixed first:** `deliveries`, `delivery_events`, `delivery_quotes`, `driver_offers` had no admin RLS policy at all (unlike every other delivery-network table) — admins couldn't read them from the browser. Added the standard `*_admin_all` policy to all 4, verified with a real RLS test.

**What shipped, in `admin.html` only:**
- **Delivery Ops** — live Leaflet/OSM map of online drivers (new `list_online_driver_locations()` RPC, `SECURITY INVOKER`) + a riders roster with an eligible⇄suspended toggle.
- **Deliveries** — recent-deliveries list with a click-to-expand `delivery_events` timeline, and an exceptions view surfacing PIN-locked deliveries (with a real **Unlock PIN** action — clears the lock and logs a `PIN_UNLOCKED` event, closing the exact gap Stage 13 flagged and tracked), stale unaccepted offers, and failed deliveries.
- **Delivery Pricing** — `delivery_pricing_config` editor. Every save inserts a new version row and only flips the old one's `is_active` off; version numbers and their numeric fields are never mutated, so historical quotes stay accurate against what they were actually priced under.

**Verified:** RLS prerequisite tested directly (non-admin sees nothing, admin sees/writes everything); new RPC tested against real inserted-then-cleaned-up driver rows; the PIN-unlock query/update/event-log path tested end to end; the pricing-versioning insert/deactivate logic tested and restored to the original single-version production state (zero net data change). Security advisor sweep clean relative to this stage. Full `admin.html` diff read hunk-by-hunk, confirmed scoped to this stage only — no PayFast/checkout/seller-dashboard file touched.

**Known limitation, tracked not hidden:** `drivers` has 0 rows in production right now (dispatch has never fired against a real order yet), so the map/roster couldn't be visually smoke-tested — DB-level and syntax verification only, same class of limitation already flagged for `track.html` in Stage 12.

**Full write-up:** `docs/systems/delivery-network-spec.md` §O.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 12 (customer tracking) built

**What happened:** Ninth implementation stage, built entirely by me. Chosen next because Stage 13 had just closed the pipeline's last hard blocker, making this the customer-facing payoff of the whole build — and the founder had given an explicit spec for it earlier in the session (no in-page GPS turn-by-turn; show "last seen Xm ago" once the rider's position is more than 90s stale).

**What shipped:** `track.html` — a signed-in customer tracking page using Leaflet + OpenStreetMap tiles (free, keyless, consistent with the earlier decision to keep any Google Maps key server-only). Shows a friendly 5-stage status (collapsing the internal 16-state enum), the destination pin, and the assigned rider's last known position — greyed out with a "last seen Xm ago" label once older than 90s, never shown as falsely live. A "📍 Track delivery" link was added to each trackable order in `profile.html`. New `get_delivery_tracking()` RPC — a narrow `SECURITY DEFINER` function rather than a new broad RLS policy on `drivers`, so a tracking customer only ever sees a lat/lon + timestamp, never the driver's own identity/status fields. Also closed a small pre-existing gap: `deliveries.tracking_enabled` had existed since Stage 5 but nothing ever set it — the payment trigger now sets it `true` on every new delivery.

**Verified in the database:** RPC ownership check (returns nothing for a non-owning caller), correct destination/driver coordinate decoding, correct null-driver-position before assignment, and the >90s staleness condition exercised against a deliberately stale test fixture. All test data cleaned up. Security advisor sweep clean relative to this stage.

**Known limitation, tracked not hidden:** no local Netlify dev environment was available to live-browser-test `track.html` this session — verified via syntax check and real database-level RPC testing only, consistent with every other stage's frontend work this session. Founder should click through it once a real delivery exists.

**Full write-up:** `docs/systems/delivery-network-spec.md` §N.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 13 (PIN delivery confirmation) built — closes the pipeline end-to-end

**What happened:** Eighth implementation stage, built entirely by me (payment-adjacent: fires the Stage 10 payout trigger, so no subagent). Prioritized over Stages 11/12 because Stage 10 deliberately dead-ended at `ARRIVING`/`PIN_REQUIRED` with no way to actually complete a delivery — this was the one hard blocker left in the whole pipeline.

**What shipped:** `deliveries.pin_attempt_count`/`pin_locked_at` columns, and `confirm-delivery-pin.js` — the only function in the codebase permitted to set a delivery to `DELIVERED`, enforcing design principle #10 ("no PIN, no completed delivery") literally. Verifies caller identity via `route_stops → routes → drivers` (never trusts client-supplied ids). A wrong PIN never changes status; 5 wrong attempts locks the delivery (423, admin-unlock-only) — going beyond the plan's own text, which only asked for logging. On a correct PIN: transitions to `DELIVERED`, completes the drop stop, and completes the route (firing the Stage 10 payout trigger) if that was the last stop — checked generically ("are all stops done"), not hardcoded to one stop. `logistics.html`'s driver UI got a real PIN entry form replacing the Stage 10 "coming soon" placeholder.

**Verified in the database:** full lifecycle — correct PIN on first try enters `PIN_REQUIRED`; 4 wrong attempts confirmed to leave status unchanged; 5th wrong attempt confirmed to lock; after simulated admin unlock, correct PIN confirmed to reach `DELIVERED`, complete the stop and route, and auto-compute the exact correct payout via the existing trigger. Security advisor sweep clean relative to this stage — all findings present predate Stage 13.

**Known gap, tracked not hidden:** no admin UI yet to unlock a PIN-locked delivery (Stage 16) — today that means a direct DB update; acceptable for a 2-rider pilot.

**Full write-up:** `docs/systems/delivery-network-spec.md` §M.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stages 9+10 (routes, pickup checklist) built — two more gaps caught

**What happened:** Seventh implementation stage, built in the corrected dependency order (routes before route_stop_items, already flagged in the execution plan). Backend built directly (extends the payment-adjacent accept flow); the route/pickup UI delegated to one subagent against a precise contract, then reviewed in full.

**What shipped:** `routes`/`route_stops`/`route_stop_items`/`driver_payouts` tables, an automatic payout-on-route-completion trigger (correctly locked down from the start this time), `advance-route.js` (start route → pickup checklist with correct partial-pickup handling → start delivery leg → arrive) which deliberately stops before `DELIVERED` since PIN confirmation doesn't exist yet, and the corresponding `logistics.html` UI extending Stage 8's Delivery panel.

**Two more real gaps caught during my own review (this is now a clear pattern across Stages 5-10, not a one-off):** driver read access to `deliveries`/`order_items` was entirely missing (worked by accident only because the two test drivers are also admins — would have silently broken for any real future non-admin driver); and `route_stops.location` came back as raw unusable EWKB hex over the API, confirmed live, with no "Navigate to customer" link possible at all as a result. Both fixed — new RLS policies mirroring the existing pattern, and a new `SECURITY INVOKER` coordinate-decoding function that both stops' navigation links now use.

**Verified end-to-end in the database:** the full start→partial-pickup→full-pickup→start-delivery→arrive sequence with two real order items, confirming partial pickup correctly doesn't collapse the route; automatic payout computation verified against the exact expected amount; explicit confirmation nothing in this stage can reach `DELIVERED`.

**Full write-up:** `docs/systems/delivery-network-spec.md` §L.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 8 (rider dispatch) built — two real security gaps caught and fixed

**What happened:** Sixth implementation stage, built via two genuinely parallel subagents (backend dispatch functions; the `logistics.html` rider UI) working against contracts with zero file overlap — the first stage since address infrastructure safe to split this way. Both reviewed in full afterward.

**What shipped:** `drivers`/`driver_offers` tables, a nearest-eligible-driver RPC, new `dispatch.js`/`driver-heartbeat.js`/`respond-to-driver-offer.js`/`dispatch-delivery.js` functions, `advance-delivery-on-fulfillment.js` extended to trigger dispatch inline (no cron needed for this pilot's scale), and a new "Delivery" panel in `logistics.html` (online toggle, heartbeat, offer accept/decline).

**Two real security gaps caught during my own post-build verification (not self-reported by either agent):** the new dispatch RPC was directly callable by `anon`/`authenticated` despite an attempted `REVOKE FROM PUBLIC` — Supabase grants new functions to those roles separately from `PUBLIC`, a gotcha already documented in this project's memory from an earlier session. Then found **my own** Stage 5/6 trigger functions had the identical gap — repeated a mistake I'd previously documented. Both fixed via a full `get_advisors` sweep; trigger firing re-verified unaffected.

**One real data gap discovered by testing:** the dispatch chain couldn't be exercised at all until testing surfaced that Isqalo's `sellers.pickup_geo` is still `NULL` — the Stage 2 pickup-address UI exists but nobody's used it yet. Set a clearly-flagged placeholder to unblock testing; still needs founder confirmation (also affects Stage 3 pricing, not just dispatch).

**Verified end-to-end in the database, not per-file:** the full `READY_FOR_DISPATCH → offered → accepted → ASSIGNED` chain, the nearest-driver RPC, the concurrent-offer protection, and the complete event timeline. All test data cleaned up.

**Full write-up:** `docs/systems/delivery-network-spec.md` §K.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 7 (seller fulfillment hook) built — with a real design correction

**What happened:** Fifth implementation stage. The original execution plan called for a new "Mark ready" button and a check against `order_items.fulfillment_status`. Investigating before building surfaced that column is genuinely dead (no constraint, every row still `'pending'`, nothing ever writes to it) — and that `seller-dashboard.html` already has a real, working, multi-seller-aware fulfillment mechanism that solves exactly the problem Stage 7 needed to solve. Built a small hook into that existing mechanism instead of a duplicate one.

**What shipped:** new `netlify/functions/advance-delivery-on-fulfillment.js` — advances a linked delivery from `PENDING` to `READY_FOR_DISPATCH` once the existing seller-fulfillment code derives that every seller on an order is done, via Stage 6's `transitionDelivery()`. Wired into `seller-dashboard.html`'s existing `updateOrderFulfillment()`, fire-and-forget, never able to break the working flow it hooks into.

**Verified end-to-end in the database** — the first test in this build exercising Stages 5, 6, and 7 together (order → paid → delivery created → advanced to ready), not just in isolation.

**Full write-up:** `docs/systems/delivery-network-spec.md` §J.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 6 (delivery status state machine) built

**What happened:** Fourth implementation stage. Built entirely directly (no subagent — the enum, the auto-logging triggers, and the JS transition map are too tightly coupled to split across agents safely).

**What shipped:** `deliveries.status` is now a real Postgres enum (16 states, plan §112) — invalid values rejected by the type system itself. New `delivery_events` table, auto-populated by two DB triggers (on creation, and on any actual status change) so the audit trail can never be silently skipped by a future code path that forgets to log it. New shared `netlify/functions/lib/delivery-state.js` — every future stage must call its `transitionDelivery()` instead of writing raw status updates; it validates the transition against an explicit allowed-transitions map, guards against two callers racing to change the same delivery, and optionally logs a specific named event with actor attribution.

**Verified two ways, not just reviewed:** directly in the database (creation/status-change logging, idempotent no-op on a same-value re-set, invalid enum value correctly rejected), and via an 11-assertion logic test of the helper itself (valid/invalid transitions, concurrency conflict, named-event logging, actor validation) — all passed.

**Full write-up:** `docs/systems/delivery-network-spec.md` §I.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 5 (checkout integration / payment→delivery trigger) built

**What happened:** Third implementation stage — the one the plan itself flagged as highest-risk relative to the "never touch PayFast files" rules. Built entirely directly, no subagent, given that risk profile.

**Real bug caught during design (not shipped, then fixed):** verifying the trigger's assumptions surfaced that `orders.order_status` is also set to `'paid'` by a completely separate flow — `complete-seller-enrollment.js` (seller-enrollment fee payments share the `orders` table). A naive trigger would have created phantom delivery rows for those. Fixed by gating the trigger on `delivery_quote_id IS NOT NULL`, which also directly encodes the plan's own "delivery must be evaluated before payment" principle.

**What shipped:** `orders` gained `delivery_quote_id`/`priority_fee`; new `deliveries` table; a Postgres trigger (the founder-confirmed approach) creates the delivery job the instant an order is marked paid, PIN generated correctly for guests and signed-in customers alike. **Verified with a real transactional test in the database**, not just review: a synthetic seller-enrollment order correctly got no delivery row, a synthetic quoted product order correctly got one, and a simulated ITN retry correctly didn't duplicate it. `checkout.html` now writes the quote id onto the order only when the server actually confirmed it was applied — verified directly by simulating both the confirmed and rejected server responses.

**Not touched:** `payfast-itn.js`, `generate-payfast-signature.js`, `charge-payfast-token.js` (confirmed via `git status`). `complete-order-payment.js` read for reference only.

**Full write-up:** `docs/systems/delivery-network-spec.md` §H.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 3 (real road-distance pricing) built, not yet live

**What happened:** Second implementation stage. Built directly (migrations, `validate-cart.js`, `checkout.html`) plus one parallel subagent for the new pricing-engine function, independently verified (full line-by-line review including its custom EWKB coordinate parser) before acceptance.

**What shipped:** `delivery_pricing_config` (seeded with the founder-confirmed R36 road-distance tariff table) and `delivery_quotes` tables. New `netlify/functions/get-delivery-quote.js` — checks service-zone eligibility before calling the paid Google Routes API, refuses multi-seller carts cleanly (tracked, unreachable today), ports the existing fee-calculation logic (per-seller surcharge, free-delivery threshold, bulk stepping, custom overrides, fee cap) and swaps only the base fee from class-based to distance-tier-based. `validate-cart.js` now accepts an optional locked `quoteId` and uses it as the authoritative fee when valid, falling back to its existing unchanged behavior otherwise. `checkout.html` opportunistically requests a quote once a real address is picked, entirely non-blocking.

**Not live yet, by design:** the new pricing engine needs `GOOGLE_ROUTES_SERVER_KEY` (not yet provided) and returns a clear, specific error until it's added — no silent straight-line-distance fallback, per the plan's explicit rule against that. Verified live that today's checkout is completely unaffected either way (identical totals rendered with the new code in place).

**Full write-up:** `docs/systems/delivery-network-spec.md` §G.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 2 (address infrastructure) built

**What happened:** First actual implementation stage of the delivery network (see the two entries below for the planning that led here). Built directly (schema migrations, `checkout.html`) plus three subagents working in parallel on genuinely disjoint files, each independently verified (syntax-checked, RLS assumptions confirmed against live `pg_policies`, confirmed no PayFast files touched) before being accepted.

**What shipped:** `profiles`/`sellers`/`orders` gained geo/PIN/instruction columns (PIN backfilled for all 31 existing profiles); new `service_zones` table + two PostGIS RPC helpers. `checkout.html` and `profile.html` now capture real coordinates from the site's existing free OpenStreetMap Photon autocomplete (extended, not duplicated with a new provider) and invalidate them correctly if the address is hand-edited afterward — verified live end-to-end. `seller-dashboard.html` gained a pickup-address confirmation UI; `admin.html` gained a Service Areas editor (center+radius circle zones); new `netlify/functions/check-service-zone.js` does the eligibility check.

**One tracked gap (not blocking):** no formatted-address text column on `sellers` yet, only coordinates — deferred until Stage 16/8 actually need to display it, rather than adding a column speculatively now.

**Full write-up:** `docs/systems/delivery-network-spec.md` §F.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network: planning complete (audit + spec + execution plan), no implementation yet

**What happened:** Founder pasted a full 196-section delivery/logistics network design doc (address validation, service zones, road-distance pricing, multi-store bundling, rider dispatch/batching, route/stop state machines, customer tracking + PIN confirmation, notifications, admin ops, animation system, 20 final design principles). Asked for: an audit against the real schema, a concrete execution plan produced by Fable (`model: fable` via the Agent tool) fed with that audit, reconciliation against the full original plan to catch anything Fable's plan missed, and a persistent spec document to keep returning to across sessions.

**What was done:**
- Enabled PostGIS on the live Supabase project (`create extension postgis`).
- Full schema/codebase audit — key finding: a rich fulfillment state machine (`order_item_statuses`) already exists for *service* pickup/return (July 2026 build), plus a `rep_availability`/`logistics.html` rep app, plus a live, working delivery-fee tariff in `checkout.html`/`validate-cart.js` — none of which the original plan (written without schema access) could have known about.
- Wrote `docs/systems/delivery-network-spec.md`: full original plan preserved verbatim, founder's explicit modifications recorded (fixed R15 priority fee, use the live tariff not the plan's illustrative one, defer the bundle *engine* but design schema for it, no in-page GPS nav — just 90s position-staleness degradation on the customer map), a running "action needed from founder" list, and Fable's full execution plan (concrete migrations, files, parallelizable work units, and flagged concerns per stage).
- Reconciled Fable's plan against the full 196 sections and caught two real gaps Fable's plan didn't cover anywhere: compliments/complaints (§96–98) had no table/file/stage at all, and `driver_payouts` was referenced but never actually created in any migration. Both patched into the plan (new Stage 13b; `driver_payouts` added to Stage 10). Also added priority-aware dispatch ordering (§22) which Fable's simplified nearest-driver algorithm had dropped.

**Follow-up same day — all three judgment-call decisions resolved:** founder reviewed and decided all three: (1) Postgres trigger for "payment confirmed → delivery job created" confirmed as sufficient, with a narrow conditional pre-authorization to touch PayFast-adjacent files only if the trigger genuinely proves insufficient during build; (2) use the plan's own illustrative §12 R36 road-distance tariff table as the real live pricing, not a price-neutral layer on the old class-based tariff; (3) rejected exposing any Google Maps key in the browser — a second, narrow Fable consult confirmed a better approach was already half-built: `checkout.html` already has a free, keyless OpenStreetMap Photon-based address autocomplete live in production, which gets extended to `seller-dashboard.html`/`profile.html` instead of adding a Google browser key; Google's role shrinks to one server-only key (Routes API pricing, optionally Address Validation) restricted by API scope with a billing alert, never reachable from PayFast-adjacent functions. Fable flagged one real follow-up (not blocking): the public Photon instance has no SLA and should be self-hosted once usage across three pages is live, with a graceful manual-entry fallback on failure in the meantime.

**Not done yet:** no delivery-system code or tables have been written beyond enabling PostGIS. Stage 2 (address infrastructure) is next.

**Full write-up:** `docs/systems/delivery-network-spec.md` — this is the living reference; keep returning to it rather than re-deriving the plan.
**Commit:** `f84ae58` (spec + execution plan), plus a follow-up commit for the sign-off resolutions.

---

## 2026-09-16 — Fix signed-in Buy Now: unawaited cart sync overwrote it after load

**Reported as:** Logged-in buyer using Buy Now on a shop page saw the correct shop/price banner, but the order summary showed "1 item" with no item rendered, R0 total, and delivery stuck at R12 (the "small" class fallback). Paying said "cart is empty."

**Root cause:** `checkAuth()` (checkout.html) calls `updateAuthUI(user)`, which fires `syncCartOnLogin(user)` **without awaiting it**, right after `loadCart()` has already correctly rendered the buy-now item. `syncCartOnLogin()` has no concept of a buy-now cart — it only looks at `ss_cart` (empty during Buy Now) and the buyer's `carts` table row (possibly stale from earlier sessions) — and unconditionally overwrites `state.cart` with whatever it finds a moment later, after the correct render already happened. Its own item-mapping was also a fourth copy of the same incomplete-field bug (no `delivery_class`/`seller_id`/etc.), which is why delivery fell back to R12.

**Fix (`checkout.html` only):**
- Added `state.isBuyNow`, set true inside `loadCart()`'s buy-now branch.
- `syncCartOnLogin(user)` is now only called when `!state.isBuyNow` — a buy-now cart must stay fully isolated from the buyer's real cart.
- `syncCartOnLogin()`'s merge now re-fetches fresh product data via `refreshCartItemsFromProducts()` instead of trusting the stale/incomplete server-cart shape directly (fixes the same bug for the *normal* signed-in flow too).

**Full write-up:** `docs/systems/checkout-cart-loading.md`
**Commit:** `cb56c55`

---

## 2026-09-16 — Fix shop.html cart items dropping delivery/pricing data; add custom delivery price

**Reported as:** Buy Now on a shop page (Isqalo Shisanyama, R99 plate) sent the buyer to checkout with the wrong delivery fee (R12 "small" instead of the product's real R22 "medium").

**Root cause:** `shop.html` has its own separate, minimal cart-item builder (not shared with the main site's `script.js` — there's no shared JS module between pages) that only ever carried `id/title/price/qty/size/img/stock/maxQuantity`. It never included `delivery_class`, `seller_id`, `listing_type`, `free_delivery`, `units_per_trip` — for either "Add to Cart" *or* "Buy Now", and for both the product-modal button and the card's quick "+ Add" button (which used an even more minimal snapshot than the modal). checkout.html's own DB re-fetch usually backfilled `delivery_class`/`seller_id`, which is why it *usually* looked fine — but on any fetch failure it silently fell back to the untouched (missing) client data, producing the wrong fee or, worst case, letting a $0-priced item through.

**Fix:**
- `shop.html`: unified both entry points onto one `buildCartItem()` that carries the full field set; the card quick-add now resolves the full product record from `allProducts` (same as the modal already did) instead of a stripped-down snapshot; added a price-unavailable guard on both buttons. Also removed an unrelated pre-existing bug: a broken `updateCartCount()` call in a second, separate `<script>` block that threw `ReferenceError` on every page load (the function is scoped to the first block's IIFE and was never global; the badge is already correctly initialized from within that first block).
- `checkout.html`: both cart-loading paths (`refreshCartItemsFromProducts` for guest/buy-now, `loadAndValidateCartItems` for signed-in server cart) now backfill `listing_type`/`free_delivery`/`units_per_trip`/custom `delivery_price` too, and a failed product re-fetch now throws (surfaced as an explicit empty-cart error) instead of silently trusting incomplete client data.
- `netlify/functions/validate-cart.js`: server-authoritative rejection (400) if a physical product's resolved price is ≤0; mirrors the custom delivery price override logic exactly.
- `admin.html`: added "Custom Delivery Price (R)" to product create/edit, stored at `products.metadata.delivery_price` (no new column) — overrides the Small/Medium/Large class price for that product.

**Full write-up:** `docs/systems/checkout-cart-loading.md`
**Commit:** `d45f913`
