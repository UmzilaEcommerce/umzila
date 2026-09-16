# Checkout cart loading & delivery pricing

How a cart item gets from "buyer clicks something" to "correct price/delivery fee at checkout," across every page that can put something in a cart. Written 2026-09-16 after tracing and fixing three related bugs in this area (see `docs/CHANGELOG.md` for the two entries this doc backs). Read this before touching cart-loading, delivery fee, or Buy Now code again — several things here look like obvious duplication but exist for real reasons, and several other things *are* accidental duplication that's now been fixed once but could easily be reintroduced.

## Why this system is confusing

There is **no shared JS module** between pages. `script.js` (the real, full-featured cart logic — `addToCart()`, delivery fields, everything) is loaded **only by `index.html`**. `shop.html` and `checkout.html` are fully standalone `<script>` blocks with their own, separately-written copies of cart logic. This is why the same class of bug (a cart item missing `delivery_class`/`seller_id`/`listing_type`/etc.) has now been found and fixed in **four separate places** that all build or reshape a cart item. If you add a new field to `products` that checkout/delivery/fees need to know about, you must add it in every one of the places listed below, or grep for the existing fields (`delivery_class`, `free_delivery`, `units_per_trip`) to find any place that still needs it.

## The three ways a cart reaches checkout.html

### 1. Guest / normal cart — `localStorage['ss_cart']`
- Written by `script.js`'s `addToCart()` (index.html) or `shop.html`'s local `addToCart()`/quick-add (shop.html) — both now write the same full field set (`id, title, price, qty, size, img, stock, maxQuantity, preferred_delivery, seller_id, listing_type, delivery_class, free_delivery, units_per_trip, delivery_price`), via `buildCartItem()` on the shop.html side.
- Read by checkout.html's `loadCart()` → `loadFromLocalStorage()` → `refreshCartItemsFromProducts()`, which re-fetches `price/sale/sale_price/stock/name/image/seller_id/delivery_class/listing_type/free_delivery/units_per_trip/metadata` fresh from `products` and overwrites those fields on each item. This is the **authoritative refresh** — whatever the client cart item had for these fields is always replaced with current DB data (only `id/qty/size` etc. survive from the client).
- If that DB re-fetch fails, `refreshCartItemsFromProducts()` **throws** (deliberately — see "Gotchas" below), which `loadCart()`'s try/catch turns into an explicit empty-cart state rather than silently trusting stale client data.

### 2. Buy Now — `localStorage['ss_buynow']`
- Written only by `shop.html`'s `buyNow()` (product modal's "Buy Now" button). A **single-item array**, same shape as the `ss_cart` item, via the same `buildCartItem()`.
- Deliberately **never touches `ss_cart`** — a buyer's real cart must be untouched whichever way they leave the page.
- Read by checkout.html's `loadCart()`, which checks `?buynow=1` in the URL **and** that `ss_buynow` is actually present, before falling through to the normal cart logic. If both are true: sets `state.isBuyNow = true`, calls `loadBuyNowItem()` (which immediately does `localStorage.removeItem('ss_buynow')` so a refresh/back-nav never replays it), which itself calls the same `refreshCartItemsFromProducts()` as path 1 — same authoritative refresh, same throw-on-failure behavior.
- **`state.isBuyNow` matters beyond just `loadCart()`** — see path 3.

### 3. Signed-in server cart — Supabase `carts` table (`items` jsonb column, one row per `user_id`)
- `checkAuth()` runs *after* `loadCart()` in `continueInitialization()`. For a signed-in user it calls `updateAuthUI(user)`, which fires `syncCartOnLogin(user)` **without awaiting it** — this runs in the background while the rest of page init continues.
- `syncCartOnLogin()` merges `ss_cart` (local) with the buyer's `carts` row (server), resolves conflicts by `product_id-size` key, writes the merged result back to both, and — critically — **overwrites `state.cart`** with the result, then calls `updateOrderSummary()` again itself.
- **This is why `state.isBuyNow` exists.** `syncCartOnLogin()` has no concept of a buy-now cart — it only knows about `ss_cart`/the server `carts` row. During a Buy Now, `ss_cart` is empty by design, so left unguarded, this background call would silently replace the correctly-rendered buy-now item with the buyer's unrelated (possibly empty, possibly stale) server cart, *after* the correct render had already happened — the buyer would see it work for a moment, then watch it break. The call site (`if (!state.isBuyNow) syncCartOnLogin(user);`) skips this entirely for Buy Now.
- For the *normal* (non-buy-now) signed-in flow, this merge is intentional and correct behavior — it's the "reconcile guest cart with account cart on login" feature. Its own item-reshaping now also routes through `refreshCartItemsFromProducts()` rather than trusting the raw merged shape, for the same reason as paths 1/2.

## Cart item field reference

A fully-resolved cart item (post-backfill, whichever path it came from) has:

| Field | Source | Notes |
|---|---|---|
| `id` | client, never overwritten | product UUID |
| `qty` / `quantity` | client | **both spellings exist in the wild** — shop.html/script.js write `qty`, the Supabase `carts` table and `validate-cart.js` use `quantity`. Rendering code reads `item.quantity \|\| item.qty \|\| 1`. Don't assume either alone. |
| `price` | always re-fetched from DB | sale price if `sale && sale_price` set, else base `price` |
| `size`, `img`/`image`, `title`/`name` | client, `name`/`image` refreshed from DB when available | same dual-naming issue as qty |
| `seller_id` | always re-fetched from DB | drives the per-seller delivery surcharge |
| `delivery_class` | always re-fetched from DB, defaults to `'small'` | `small`/`medium`/`large` — see fee calc below |
| `listing_type` | always re-fetched from DB, defaults to `'product'` | `'service'` items are excluded from delivery fee entirely |
| `free_delivery` | always re-fetched from DB | admin-flagged (in-house/residence stock) — excluded from fee/class calc but still counts toward the R600 free-delivery subtotal threshold |
| `units_per_trip` | always re-fetched from DB | bulk-quantity fee stepping (see below) |
| `delivery_price` | always re-fetched from `products.metadata.delivery_price` | **custom per-product override** — see below |

## Delivery fee calculation

Lives in two places that **must stay in sync** (both have comments saying so): `calculateDeliveryFee()`/`calculateServiceFees()` in checkout.html (client preview) and `computeFees()` in `netlify/functions/validate-cart.js` (server-authoritative — this is what's actually charged, via `state.serverFees` set inside `validateCheckout()`).

- Services (`listing_type === 'service'`) never contribute to delivery fee.
- `free_delivery` items are excluded from the class/price calc but still count toward the R600 free-delivery subtotal threshold.
- If subtotal ≥ R600 (`FREE_DELIVERY_THRESHOLD`), delivery is free outright.
- Otherwise: each fee-eligible item has a `delivery_class` (`small`=R12/`medium`=R22/`large`=R50, `DELIVERY_CLASS_PRICES`) and a bulk-quantity step-up (`units_per_trip`, defaults per class) — the fee is based on the **worst-case single item** (max class after step-up across the cart), plus a per-extra-seller surcharge (`PER_SELLER_FEE`) and a per-extra-trip overflow fee once already at `large` (`LARGE_OVERFLOW_FEE`), capped at `MAX_DELIVERY_FEE` (R80).
- **Custom delivery price** (added 2026-09-16, admin.html): a product can have `metadata.delivery_price` set, which overrides its class price entirely for that line. Items *with* an override skip the class/step-up loop; items *without* one still go through it as before. The final base fee is `max(class-based fee from non-override items, max custom price among override items)` — i.e. the worst case wins, same philosophy as the class-based logic. Per-seller/overflow surcharges still apply on top regardless of which items are override vs. class-based.

## Zero-price guard

A physical (non-service) product must never reach payment with price ≤ 0. Checked in two places: `checkout.html`'s `preparePendingOrder()` (UX shortcut, avoids a pointless PayFast round-trip) and — the real enforcement — `validate-cart.js`, which returns a 400 if `!isService && !(itemPrice > 0)`.

## Gotchas / read this before changing anything here

- **Don't add a fifth cart-item-building copy.** If you need to change what fields a cart item carries, check all of: `script.js`'s `addToCart()`, `shop.html`'s `buildCartItem()`, checkout.html's `refreshCartItemsFromProducts()` / `loadAndValidateCartItems()` / `syncCartOnLogin()`, and `validate-cart.js`'s per-item normalization.
- **`refreshCartItemsFromProducts()` throws on a failed DB re-fetch, on purpose** (changed 2026-09-16 — it used to silently return the client's items unchanged, which is how the "R12 instead of R22" bug could happen even outside the signed-in race condition: a transient fetch failure would silently fall back to client data that, for a shop.html-sourced item, never had `delivery_class` in the first place). Every caller already has a try/catch that degrades to an explicit empty-cart state. Don't swallow this error silently again.
- **`syncCartOnLogin()` runs unawaited from `checkAuth()`.** This is a deliberate a "don't block sign-in on a cart merge" choice, not an oversight — but it means anything that depends on `state.cart` being stable right after `checkAuth()` resolves needs to either not care about the signed-in-merge race, or check `state.isBuyNow` the way the call site now does. If you add a fourth cart-loading path in the future, ask whether it also needs to respect `state.isBuyNow`.
- **`qty` vs `quantity`, `img` vs `image`, `title` vs `name`** are genuinely both in use across this codebase (client-built items use the shop.html/script.js naming, server-built/DB-synced items use the other). Always read with a fallback (`item.quantity || item.qty || 1`), never assume one.
- **`shop.html`'s card quick-add button used a different (weaker) product snapshot than the modal** until 2026-09-16 — `card.dataset.product` is deliberately minimal (id/price/stock only, for cheap rendering of 100+ cards) and must never be handed straight to `addToCart()`/`buyNow()`. Always resolve the full record from `allProducts` first (`allProducts.find(p => p.id === product.id)`), the same way `openProductModal()` already does.
