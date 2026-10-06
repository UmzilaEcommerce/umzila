# Product pop-up and per-item picks (product-sheet.js)

Written 2026-10-06. Read this before touching how a product opens or gets added to the cart on the home page or a store page, or anything about Velaphi's starch choice.

## What it is

`product-sheet.js` is **one shared product pop-up** used by the home page (`script.js`) and every default store page (`shop.html`), so a product looks and behaves the same everywhere. Before this there were two different pop-ups that had drifted apart: the home page's older modal with "Size" boxes and a delivery-preference dropdown, and the store quick view.

It has two modes:
- **full**: the store quick view. Photo gallery, store name, title, price, description, the choice controls, Add, the "delivered by / secure checkout / sold by" list, and "Copy link".
- **quick**: the short sheet opened by a card's "+" (home and store). Just a thumbnail, the title, the price, the choice controls and Add.

**Services** (Nceks rides, hair, vouchers) don't use the choice controls. On a store page the button sends them to their setup flow (`serviceSetup`). On the home page, services still open the old booking/intake modal in `script.js`, which handles times, intake questions and so on.

A product with **nothing to choose** (only "One Size") is added straight away by "+", with no sheet.

## Per-item picks

`products.metadata.picks = { label, unit, options[], max }`. For example, Velaphi plates have `{ label: 'starch', unit: 'plate', options: ['Pap','Jeqe','Phuthu'], max: 1 }`; the +6 wings plate has `max: 2`.

It means **every item comes with its own choice**, and the choice is free. The founder's rules shaped the design:
- **max 1:** one row per option, "🍽 Plate with pap [−] n [+]". Every "+" is one more *plate*, so the number of plates is the total. There is no separate quantity counter to misread as "number of starches", and the header says "Each plate comes with its own starch". The live summary ("3 plates: 2 with pap · 1 with phuthu") and the button ("Add 3 plates · R210") count plates.
- **max 2:** "Plate 1 — pick 1 or 2" chips. A third tap swaps out the oldest pick. "+ Add another plate" copies the previous plate's picks.
- **Questions never asked:** the quantity (implied by the taps), "same for all?" (tap one row repeatedly), and "do you want a second starch?" (one pick is a complete answer).

### Storage

A cart line keeps `picks`, one entry per item, plus `picks_cfg` (label, unit, max) so carts can describe it without a product lookup. For example:
- max 1: `picks: [['Pap'], ['Pap'], ['Phuthu']]`
- max 2: `picks: [['Pap','Jeqe']]`

Rules for the line:
- `qty = picks.length` and `size = 'One Size'`. The size field is cut to 20 characters by `sanitizeCartData`, so the breakdown can't live in it while in the cart.
- Adding the same product again merges into one line (`picks` are concatenated).
- `picks` and `picks_cfg` are in all four `CART_EXTRA_FIELDS` lists (`script.js`, `shop.html`, `cart.html`, `checkout.html`) and in `validate-cart`'s saved-cart write, so they survive the local ↔ account-cart round trips.

### Cart behaviour

This applies to the store cart sheet and the cart page:
- The line shows `UmzilaPicks.summary()` ("3 plates: 2 with pap · 1 with phuthu", or "2 plates — Plate 1: pap & jeqe · Plate 2: phuthu" for max 2).
- **"+"** is `plusOne`: one more item with the same picks as the last.
- **"−"** is `minusOne`: drop the last item; an empty line is removed.
- **"Change starches"** reopens the picker filled with the line's picks and **replaces** them.

### Server (`lib/picks.js` + `validate-cart.js`, authoritative)

- Picked products ignore size variants and use the product's own price and stock.
- `normalizePicks` requires every item to have 1..max distinct allowed options. An old line saved as size "Pap" heals into picks; anything else returns 400 `PICKS_REQUIRED` with "Please choose a starch for each plate of …".
- Quantity = `picks.length`, capped to stock.
- The validated line's `size` becomes `picksText()` ("Pap ×2, Phuthu ×1" / "Pap & Jeqe; Phuthu"). That is what `orders.items` → `order_items` (populate trigger) → the seller order card, the rider bag and the emails already display, so nothing downstream had to change.
- Stock is deducted from the product (no `variant_id`).

## Other add paths

`script.js` `addToCart` refuses a picked product without picks and opens the quick sheet instead. That covers bundle suggestions, the old quick-add box and the mystery gift.

## Setting it up (seller dashboard)

Add/Edit product has a box: "Each item comes with its own choice". It holds:
- what the choice is (e.g. starch);
- what one item is called (e.g. plate);
- the choices, comma separated;
- one each, or up to two each.

These are saved as `metadata.picks` (`withPicksSettings` / `fillPicksSettings`).

This is separate from the size options (chips + `option_label` / `option_required`), which still exist for sizes and other priced variants.

## Gotchas

- **New buyer pages:** any page that shows cart lines must include `product-sheet.js` (for `UmzilaPicks`) and keep `picks`/`picks_cfg` in its cart-field list.
- **Never collapse picks lines by size:** the line key for picks lines is the product id.
- **Styles:** `product-sheet.js` injects its own scoped CSS (`.uq-*`) and lazy-loads the Archivo + Hanken fonts on the first open. Don't reuse the page's `.btn`/`.x` classes inside it.
- **Testing:** `docs/qa-guest-checkout.e2e.js` picks a starch automatically when the sheet opens.
