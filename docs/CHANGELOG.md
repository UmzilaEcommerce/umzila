# Changelog

Dated log of drastic/significant changes — bug fixes touching core flows (checkout, cart, payments, auth, seller system), multi-file fixes, and new features. Newest first. See `CLAUDE.md`'s "Change Documentation & System Notes" section for when an entry here is required, and `docs/systems/` for full prose write-ups of whole systems.

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
