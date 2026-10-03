# Service orders: kinds, bookings, vouchers

How a service (anything with `products.listing_type = 'service'`) goes from listing to done. Written 2026-10-03 after rebuilding this area around the Nceks Quad Biking launch, when an end-to-end test showed services were all treated as one generic "accept → work → deliver back" flow. Read this before touching services in checkout, emails, profile, seller dashboard or logistics.

## The six kinds

Every service line is exactly one kind, derived from facts `validate-cart.js` stamps onto the line **from the listing** (never from the browser):

| Kind | Rule | Example | Flow |
|---|---|---|---|
| `booking` | `fulfillment_type='in_person'` and a booked time (`booking_start_at`) / `booking_mode='scheduled'` | Nceks quad ride, booked haircut | Pick time → hold → pay → confirmed (instantly or seller accepts) → seller "Mark as done" |
| `in_person` | `in_person`, no booked time | Braids arranged by chat | Pay → seller accepts (contact details shared) → "Mark as done" |
| `dropoff_return` | `item_dropoff`, `item_returned !== false` | Shoe cleaning, water refill | Pay → seller accepts → rep collects (slot) → handed to seller → in progress → completed → rep returns (slot) |
| `dropoff_kept` | `item_dropoff`, `item_returned === false` | Donation pickup | As above without the return leg |
| `digital` | anything else | CV rewrite, printing | Pay → accept → start work → complete with deliverable |
| `voucher` | `products.metadata.voucher === true` | Nceks gift voucher | Pay → code issued + emailed; service line recorded as `completed` |

`serviceKind()` is implemented (same rules) in: `netlify/functions/lib/complete-order-payment.js` (`serviceKind`, `buyerServiceSteps`), `checkout.html` (`checkoutServiceKind`), `checkout-success.html` (`serviceKind`), `profile.html` (`profileServiceKind`), `seller-dashboard.html` (`sdServiceKind`). There is no shared JS module in this codebase — **change all five together**.

Fields on a validated service line that drive it: `fulfillment_type, booking_mode, booking_start_at, booking_end_at, booking_units, item_returned, intake_kind, is_voucher, instant_confirm, service_location, acceptance_deadline_hours, service_options`.

`intake_kind` (`item/file/none`) only matters for drop-offs. In-person/digital listings are now saved as `none` (they used to default to `item`, which showed buyers collection steps for a haircut); existing rows were corrected.

## Bookings (scheduled in-person)

- **Capacity**: `sellers.booking_capacity` (default 1 = one at a time, e.g. a single chair; Nceks = 10 quads) shared by all the seller's bookable listings. Each `service_bookings` row has `units` (e.g. 3 quads). The `service_bookings_enforce_capacity` trigger refuses any hold/confirmation whose peak concurrent units would exceed capacity (it replaced the old one-booking-per-seller exclusion constraint). It row-locks the seller, so racing buyers can't both win.
- **Start grid**: `sellers.booking_start_interval_minutes` (null = back-to-back sessions of the listing's `slot_duration_minutes`; Nceks = 60, so 30-min and 2-h rides both start on the hour) inside `seller_availability` weekly windows (SAST).
- **Holds**: `netlify/functions/hold-service-booking.js` places a 30-min `held` row, validating the slot against hours/grid/lead time (30 min). Works for guests; links `buyer_user_id` if signed in. `replaceBookingId` releases a previous unpaid hold.
- **Load for pickers**: `get_booking_load(seller, from, to)` (SECURITY DEFINER) returns active bookings' times + units only. Buyers' own RLS only shows their own bookings — the old pickers queried `service_bookings` directly and so saw every slot as free.
- **Active** = `confirmed`, or `held` with `hold_expires_at > now()` (`service_booking_is_active`). Expired holds just stop counting.
- **Before payment**: `validate-cart.js` requires the hold, checks it belongs to the listing and is unpaid, refreshes `hold_expires_at` (the trigger re-checks capacity if it had expired), and charges `units × price` regardless of the cart's qty.
- **After payment**: `completeOrderPayment` confirms the hold (`held → confirmed`, never re-checked so a paid booking is never blocked). `products.instant_confirm` (re-read from DB) makes the service line `accepted` immediately.
- **Lifecycle sync**: trigger `sync_booking_from_service_status` — service line `completed` → booking `completed`; `rejected/cancelled` → booking `cancelled` (frees the units).
- Seller UI: **Bookings** tab (by day, with buyer contact once paid) and booking settings inside any bookable listing form.

## Gift vouchers

- A voucher is a service listing with `fulfillment_type='digital'`, `metadata.voucher = true` (+ `ride_minutes` for Nceks display), `instant_confirm = true`.
- After payment `issueGiftVouchers()` creates one `discount_codes` row per unit: `type='gift_voucher'`, `amount` = price paid, `seller_id` = the store, `scope='order'`, `multi_use=false`, `expires_at` = +3 years (Consumer Protection Act minimum for prepaid vouchers), `referral_code` = the buying order number. Code format `<SLUG6>-XXXX-XXXX`.
- `lib/discounts.js`: a `gift_voucher` covers **everything from its store** (services included — other codes still only discount physical products); the seller wall keeps it to that store.
- **Balance**: on redemption, `completeOrderPayment` subtracts the discount from `amount` (optimistic match on the old amount); `used` only when it reaches 0.
- Email (`buildGiftVoucherEmail`): "star this email", big code, "storewide", expiry, a "Use it at <store>" button to `SITE_BASE_URL/<slug>?voucher=CODE`, a **Send on WhatsApp** button and a select-all copy/paste block with the full message (code, value, scope, expiry, link — the link unfurls into the store preview on WhatsApp).

## R0 orders

A voucher can cover the whole order. PayFast can't take R0, so `checkout.html` calls `complete-zero-total-order.js` when its total is ≤ 0. That function **re-prices the saved order server-side** (`lib/reprice-order.js` → `validate-cart.js`) and only runs `completeOrderPayment` (`pf_payment_id = ZERO-…`) if nothing is owed — the browser's R0 is never trusted. Tested: a tampered R0 order that really owes R550 is refused.

## Guest checkout (fixed)

- `orders` insert RLS required `auth.uid() = user_id` (NULL = NULL is not true), so **guest orders never worked**. Policy "Guests can insert pending orders" allows anon to create unpaid, account-less orders; checkout now generates the order id client-side (anon can't read the row back).
- `generate-payfast-signature.js` required a session. Its guest path signs only for a real unpaid account-less order whose amount equals the server's re-pricing (`lib/reprice-order.js`), with matching email and no card tokenization. The signed-in path, field order, encoding and signature are unchanged.
- `checkout-success.html` reads status via `order-status.js` (anon can't SELECT orders).

## Gotchas

- Supabase query builders have **no `.catch()`** — use `{ error }` or `.then()`. Several `.catch()` calls aborted post-payment work silently (service records, stock decrement, referral emails); all were removed — keep it that way.
- Order rows are written by the browser. Anything financial or behavioural after payment (instant confirm, voucher value) is re-read from `products`.
- Seller order emails go to `sellers.email`, the owner's account email and every `seller_members` co-owner (several stores had no store email and were never emailed).
- There is **no automatic cancellation** of services the seller hasn't accepted, and refunds are manual. Wording only promises "please accept within Nh" / "Umzila refunds you".
- Rep collection/return windows come from `rep_availability` only (they aren't capacity-limited).

## Before touching this again

Run a service through every kind you change (the 2026-10-03 test drove a quad booking, a voucher, a voucher-covered R0 booking and a guest shoe-cleaning order through checkout → simulated ITN → emails/records). `docs/CHANGELOG.md` 2026-10-03 entries list exactly what was verified.
