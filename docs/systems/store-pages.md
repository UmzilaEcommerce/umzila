# Store pages (the default store template)

Every store on Umzila lives at `umzila.store/<slug>`. Unless the store has a bespoke folder (see `bespoke-storefronts.md`, e.g. `/ncekeniquads/`), that URL is rewritten by `netlify.toml` to **`shop.html`**, which renders the store from live data. `shop.html` *is* the template: one file, every store. Rebuilt 2026-10-04 from the owner's supplied design (`umzila-store-template.zip`), replacing the older Etsy-style shop page.

## What the page does

- **Finds the store** from the path (`sellers.slug`), or from a legacy `shop.html?shop=<name>` link, then canonicalises the URL to `/<slug>` (keeps `?product=` / `?q=`). Unknown slug → "Store not found"; a page name typed without `.html` (e.g. `/cart`) → that page; a store whose `status` isn't `active` → "Store unavailable".
- **Looks like the store, framed by Umzila.** A navy Umzila strip with an "Umzila home" pill (plus a back-chevron on the logo in the sticky header) is the way back to the marketplace. The store's area takes `sellers.theme_color` (optional `#rrggbb`, set by the seller in the dashboard; default Umzila orange). Text on the accent picks black or white for contrast automatically.
- **Hero:** banner (or a branded gradient with the short description as a tagline), logo, name, description, meta chips (open/closed, location, turnaround, who delivers, years), "Save store", "Share".
- **Sections ("filters" like *Plates with wings*):** each product's section is `products.metadata.store_section` (seller sets it per product in the dashboard, with suggestions from their other sections), falling back to the product's Umzila category. The main-site category is never changed by this. Sections are ordered cheapest-first (menu-like); in "Featured" sort, sponsored products (paid `ad_campaigns.sponsored_product`) come first, then in-stock, then by price. Filter pop-over: available only, on sale, saved items, price range. Sort: featured / price / A–Z. Search covers title, section and description.
- **Quick view** (bottom sheet on phones): images with thumbnails, price/sale, low-stock note, size choice (only when sizes are a real choice — a single "One Size" isn't asked about), quantity capped at stock, back-in-stock email (`stock_alerts`), copy link.
- **Services** (bookings, drop-offs, digital, vouchers) still need setup this page doesn't carry (a booked time, intake answers, collection/return), so "Book"/"Set up" hands over to the homepage product modal (`/?product=<id>`), exactly like the old page did. Bespoke booking stores (Nceks) have their own booking UI.

## Opening hours / open-closed

- One set of weekly hours per store: **`seller_availability`** (day_of_week + start/end, SAST). It is the same table the booking calendar uses, so a service store's opening hours *are* its booking hours. Sellers edit it in **Dashboard → My Shop → Opening Hours** (also still from the scheduled-service quiz, which writes the same rows).
- **`get_store_hours_status(seller_ids uuid[])`** (SQL, anon-callable, ≤100 ids) answers `has_hours, open_now, closes_at, next_open_at` server-side in Africa/Johannesburg time. The store page and checkout both use it — never compute open/closed in the browser from the raw rows.
- No hours set → nothing is shown and nothing is gated (treated as always open). Hours can't cross midnight yet (validation asks for close ≤ 23:59).
- Store page: "Open now · until 17:00" / "Closed now · opens tomorrow at 10:00", a closed note under the hero and in the cart drawer, refreshed every 5 minutes.
- **Checkout gate:** when Pay is pressed, if any line that waits for the store (physical items, and services other than timed bookings and gift vouchers) belongs to a closed store, a popup says which store, when it opens, and that the order will be prepared then (likely the next day). "Yes, order anyway" continues (remembered for that page visit); "Not now" stops before any order is written. A failed hours lookup never blocks a sale. Lives in `checkout.html` → `confirmClosedStores()`, called at the top of `preparePendingOrder()` so it covers Pay Now and Pay with saved card.

## Cart: one cart, per-store views

- There is still **one cart** for all of Umzila: `localStorage.ss_cart` (+ the signed-in `carts` row). Adding on a store page writes the same item shape as before (`buildCartItem`) and, when signed in, upserts the `carts` row too (server shape `product_id/quantity/...`), because the homepage and checkout read the row first — without this, a change made on a store page was undone on the next page.
- The store page's cart button, bottom-nav badge and drawer show **only this store's lines**. Going back to the homepage shows everything (they were always in the one cart); returning to the store shows its lines again.
- **Store checkout:** the drawer's button goes to `/checkout.html?store=<seller id>`. If the cart has other stores' lines, a small line offers "Want to check out everything together?" → `/cart.html`. Ignored, the buyer pays for this store only.
- **How checkout scopes it** (`checkout.html`): `state.storeScope` from the URL; `scopeCart(full)` splits the loaded cart into `state.cart` (this store) and `state.cartRest` (everything else) after every load/merge; `persistLocalCart()` / `saveCartToServer()` always write `cart + cartRest`, so nothing is dropped. `validate-cart` is sent `persistCart:false` for a scoped checkout or Buy Now so it doesn't overwrite the saved cart with a partial one.
- **After payment:** `preparePendingOrder()` stores `ss_cart_after_paid` (scoped → the rest of the cart; Buy Now → the untouched cart; normal → empty). `checkout-success.html`'s `finishPaidCart()` applies it instead of wiping `ss_cart`. The server still deletes the signed-in `carts` row on payment (`complete-order-payment.js`, unchanged); the next page finds no row, falls back to the local cart and re-saves it.

## Saved stores

- **`saved_stores`** (user_id, seller_id, unique pair, RLS: own rows only, authenticated). Guests keep `localStorage.ss_saved_stores` (seller ids); it is copied into the table the next time they're signed in on a store page or the homepage, then cleared.
- Homepage **"Your saved stores"** row (`#savedStoresSection`, above Featured Shops) uses the same compact shop cards; hidden when empty. Store page footer links to it.
- Item hearts are the existing product favourites (`toggle-favourite` function, `product_favourites`); the store's "Saved" filter shows hearted items from this store.

## Gotchas / before you touch it

- `sellers.delivery_method` is an internal code (`self_dropoff`) — never show it raw. Buyers see "Delivered by Umzila", or "Delivered by the store" for self-arranged sellers (`self_arranged_radius_km`).
- Don't add new cart item fields here without adding them everywhere listed in `checkout-cart-loading.md`.
- Never hardcode the site URL; share links use `location.origin`.
- A bespoke store folder wins over this template; reserve any new top-level page name in `seller_slug_reserved()`.
- Services on this page still redirect to the homepage modal — building booking/intake into the template would be a second copy of that logic.
