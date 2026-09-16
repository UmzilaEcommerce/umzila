# Changelog

Dated log of drastic/significant changes — bug fixes touching core flows (checkout, cart, payments, auth, seller system), multi-file fixes, and new features. Newest first. See `CLAUDE.md`'s "Change Documentation & System Notes" section for when an entry here is required, and `docs/systems/` for full prose write-ups of whole systems.

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
