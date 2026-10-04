# Bespoke storefronts

A paid option for stores that want a site that looks like their own while still being a normal Umzila store: same products, cart, checkout, PayFast, orders, seller dashboard, and its listings still appear on the main site. First one: **Nceks Quad Biking** at `umzila.store/ncekeniquads` (design by Shazi Media), built 2026-10-03.

Every store *without* a folder gets the default template, `shop.html` — see `store-pages.md`.

## How it fits together

- **Routing**: every store's link is `/<sellers.slug>` (`netlify.toml` rewrites `/:slug` → `shop.html`). A bespoke store is a **folder with the same name as the slug** (`/ncekeniquads/index.html` + `img/`). Netlify serves real files before rewrites, so the folder shadows the generic shop page for that one store. Asset paths are absolute (`/ncekeniquads/img/...`) because the page is served without a trailing slash.
- **The page is a skin.** It reads everything that matters from Umzila at runtime, using the anon key from `/.netlify/functions/get-client-config` (no keys in the file):
  - store by slug (`sellers`: id, status, `booking_capacity`, `booking_start_interval_minutes`)
  - listings (`products` where `metadata.storefront_role` is `ride` or `voucher`; prices always from the DB)
  - weekly hours (`seller_availability`) and live load (`get_booking_load`), all in SAST
- **Booking**: "Pay on Umzila" → `hold-service-booking` (guests allowed) → writes the line into the shared cart (`localStorage.ss_cart`, same item shape as `script.js` `addToCart`) → `/checkout.html`. The bag is the real Umzila cart filtered to this store.
- **Vouchers**: `?voucher=CODE` (from the voucher email) is kept in `sessionStorage` and sent to checkout as `?coupon=`. `?product=<id>` opens that ride (used by checkout's "pick a time again").
- **Help**: the booking flow's WhatsApp fallback goes to Umzila's line; the footer keeps the business's own contact details (owner's choice).
- Display copy/photos per ride length live in `RIDE_ART` in the page; prices/durations/capacity/hours are edited in the seller dashboard, never in the file.

## Making another one

1. Create/approve the store; set its slug (admin → Manage Shops → Store link).
2. Create listings with `metadata.storefront_role` (and anything the design needs, e.g. `ride_minutes`). Upload images to `product-images/stores/<slug>/`.
3. Put the design in `/<slug>/`, wire it the same way (copy the Nceks script's CONFIG/SA time/cart/hold sections). Never hardcode prices or the site URL; never take payment anywhere but Umzila checkout.
4. Never paste the Supabase project URL into a page — Netlify secret scanning fails the build. `og:image` uses the page's own `/<slug>/img/...` path (site-relative, since the site URL must not be hardcoded either; most previewers resolve it, some may not).

## Gotchas

- The bag counter must not filter the cart by store before the store has loaded (crashed the page when the cart already had items — fixed with a guard; there's also a 20 s load timeout with a WhatsApp fallback).
- Turning a store's listings invisible makes the bespoke page show "Online booking is unavailable" (the hold function also refuses invisible listings).
- `seller_slug_reserved()` must include any top-level folder you add that isn't a store.
