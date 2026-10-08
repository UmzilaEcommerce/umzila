# House add-ons (Umzila Drinks) and the "Complete your order" screen

Written 2026-10-08. Read this before touching drinks, `sellers.is_house`, or anything that counts "how many stores are in this order".

## What it is

Umzila sells its own drinks (Coca-Cola, Fanta, Sprite, Appletiser, Liqui-Fruit…) as add-ons to a store's order. They're bought in bulk by Umzila and carried in the rider's car. The store whose page you're on (e.g. Velaphi) never sells them, never sees them, and never earns from them. The agreement with Velaphi is that Umzila sells the drinks, the same way Umzila handles delivery.

## The pieces

### The house store

- **What:** the drinks belong to their own seller, **Umzila Drinks** (`sellers.slug = 'umzila-drinks'`, `sellers.is_house = true`, no owner).
- **Why a separate store:** everything that shows a store its business (seller dashboard products/orders/earnings, the "New order" email, `order_items` RLS) is per seller. Velaphi therefore never sees a drink.
- **Why not the existing "Umzila store":** it sells other things (Inuka perfumes) that do need a real pickup.

### Products

- `products.metadata.addon = true`, category Drinks; `metadata.popular = true` shows the green "Popular" badge on the add-ons screen. Managed in admin like any product (price, stock, visible).
- **Images:** product packshots on a pure-white square (`stores/umzila-drinks/photo-*.w1280.webp` + `.w480`), 2026-10-08. Coca-Cola No Sugar 500ml is hidden until it has a photo.

### Riding along

A house item rides along in the order of whichever store it was added to:

| Where | What it does with house items |
|---|---|
| `get-delivery-quote.js` | Never adds a pickup stop. A drinks-only cart is ineligible (`addon_only`). |
| `validate-cart.js` | `computeFees` never counts the house store towards the +R3-per-store fee. `finalCheck` refuses drinks-only carts (`ADDON_ONLY`). Validated lines carry `house: true`. |
| `create_delivery_on_payment()` (fallback quote) | Excludes house sellers from the pickup list. |
| `advance-delivery-on-fulfillment.js` | Readiness only waits for real stores' "Mark ready", never for drinks. |
| `advance-route.js` (pickup aggregation) | Already scoped to pickup stops' sellers, so drinks never make a delivery "partially picked up". |
| `get_driver_board()` | The delivery's first pickup stop carries `house_items`. `logistics.html` shows "🥤 Also bring from Umzila stock: 2× Coca-Cola 500ml" on the bag card. The drop stop lists every item, drinks included. |
| `order_closed_store()` | The house store has no opening hours, so it is never "closed". |

### On the store page (`shop.html`)

- **`ADDON_STORES`** (store slugs, currently Velaphi) decides where the add-ons screen appears.
- **`loadHouseAddons`** loads house sellers (anon read of `sellers.is_house`) and in-stock add-on products.
- **Cart scope:** `storeLines()` includes house lines, so drinks stay in that store's cart and checkout.
- **Checkout tap:** in the cart sheet, `a[data-checkout]` first opens **"Complete your order"** (`showAddons`), once per visit. It shows:
  - a 2-column grid (3 on wide screens) with photo, "Popular" badge, + / stepper, name and price;
  - **No thanks** → becomes **Continue to checkout · R…** once something is added;
  - ← back to the cart.

### At checkout (`checkout.html`)

- `scopeCart()` keeps house lines with the scoped store (`?store=`). `HOUSE_IDS` is loaded once by `ensureHouseIds()` before the cart loads.
- The fee preview, the "Ordering from <store>" banner and the "stores too far apart" buttons all ignore house sellers.

### Home page

- `browsableProducts()` hides add-ons.
- `get-catalog` leaves the house store out of the store list.
- Search can still find a drink. A drinks-only cart is refused at checkout with a clear message.

## Gotchas

- **Any new code that counts stores** in an order (fees, pickups, readiness, banners, "multi-store" logic) must ignore `sellers.is_house`.
- **To offer add-ons on another store,** add its slug to `ADDON_STORES` in `shop.html`.
- **Data visibility:** a store can still technically read the full `orders.items` JSON of its orders through the API (existing RLS). Only the UI and emails are per store.
