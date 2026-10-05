# Site speed, images and the live visitor counter

Written 2026-10-05. Read this before touching image uploads, the home page's data loading, `get-client-config`, `get-catalog` or `presence.js`.

## Why this exists

The founder asked whether Umzila could handle about 2,000 people at once. At the time it couldn't, for three reasons:

- **Images.** Store photos were 1–3 MB PNGs, averaging about 590 KB. Cards showed them full size, so one home visit pulled 8–10 MB from Supabase Storage. The free plan allows 5 GB of egress a month, so a single busy evening would use it up.
- **Database calls.** Every home visit made about 14 Supabase calls. They included the full catalogue join (products, images, stores), all product options, 6 filter queries (2 of which always failed with a 400 because `products.type` / `products.color` don't exist), store and ad reads, and a product count. A few were sequential.
- **Waiting before loading.** Every page waited on a Netlify function (`get-client-config`) before it could load anything. The home page also loaded supabase-js twice, once render-blocking in `<head>`, using an unpinned "latest" URL that the browser caches only briefly.

## Images

### The convention

Every optimised image sits next to its original in the same bucket:

- `<name>.w1280.webp`: full product photo, max 1280 px, WebP q80.
- `<name>.w480.webp`: card thumbnail for product photos only, max 480 px, q74, about 30 KB.
- `<name>.w1600.webp`: store banner.
- `<name>.w512.webp`: store logo.

The database (`products.image`, `product_images.url`, `sellers.logo_url` / `banner_url`) always stores the full-size name. The thumbnail is derived by swapping `.w1280.webp` for `.w480.webp`:
- `script.js` `thumbUrl()` / `thumbFallback()`;
- the same two helpers in `shop.html`;
- inline `.replace()` in `cart.html`, `checkout.html` and `profile.html`.

Any URL without the `.w1280.webp` suffix is used unchanged, so old URLs, videos and outside images keep working. If a thumbnail ever fails to load, cards fall back once to the full image (`data-full` + `thumbFallback`).

Files are uploaded with `cacheControl: 31536000` (1 year). That is safe because **names are never reused**: every upload gets a timestamped base and `upsert: false`. Logos and banners used to overwrite `sellers/<id>/logo.png`; they are now `logo-<ts>.w512.webp`. Never re-upload different content under an existing name.

### One-time conversion (2026-10-05)

`docs/design/product-images/optimize-all.js` converted every image that was referenced:
- 444 images, 214.7 MB → 16.6 MB, plus 4.2 MB of thumbnails;
- 690 database rows switched.

**Originals were kept.** Old orders, emails and carts may still point at them, and they are the rollback. `optimize-map-2026-10-05.json` maps each original bucket/path to its copy, stored as paths only: a full project URL in the repo would trip Netlify's secret scan.

The script is safe to re-run; it skips anything already named `.wNNN.webp`. Run it with `npx netlify dev:exec node …`, `NODE_PATH` pointing at a `sharp` install, and `APPLY=1` to write.

### New uploads

`image-upload.js` is loaded by `seller-dashboard.html` and `admin.html`. `umzilaImages.upload(storage, bucket, base, file, kind)` does the shrinking in the browser (canvas → WebP, EXIF orientation respected) and uploads the full image plus the thumbnail.

It covers:
- the seller dashboard: new-product photos, edit-product photos, logo, banner, and hero-ad banner;
- admin: `tryUploadImageToBucket`.

If the browser can't encode WebP (older Safari), the file is a video or GIF, or anything fails, it uploads the original exactly as before. An upload never breaks because of the optimiser.

### Storage permissions (tightened 2026-10-05)

`shop-assets` used to accept inserts and updates from any signed-in user into any folder, so a buyer could overwrite a store's photos. Writes are now allowed only under `sellers/<id>/…` for that store's owners (`my_seller_ids()`) or admins.

`product-images` still allows any signed-in user to add new files, but never to overwrite: there is no update policy.

## Page loading

- **`get-client-config`** is served from Netlify's CDN (`Netlify-CDN-Cache-Control: durable, max-age=3600`), so visitors never wait on a function cold start. The browser keeps it for an hour, and for a day while refreshing in the background. A redeploy clears the CDN copy.
- **`get-catalog`** (new) runs the reads the home page used to make, with the anon key, so it returns exactly what a guest may see:
  - listed products with images and store;
  - all `product_variants`;
  - active stores;
  - running ads.

  It is CDN-cached for 60 s, then refreshed in the background. 2,000 visitors in a minute cost about 1 database read instead of thousands.

  `script.js` starts downloading it (`catalogPromise`) the moment the script parses, in parallel with the Supabase client set-up. These all read from it:
  - `loadProducts`;
  - `loadFilterOptions` (the 6 filter queries are gone);
  - the sponsored-product boost;
  - index.html's Featured Shops (stores, product counts, featured-shop ads, hero banners).

  Every one of these falls back to its old direct query if the catalogue failed, so the page works without it.
  - **Gotcha:** a product edit takes up to about a minute to show on the home page. Stock is never trusted from this list; `addToCart` / `validate-cart` check it live.
  - **Gotcha:** a column the catalogue doesn't return behaves like the old failed query (the filter keeps its default).
- **supabase-js** is pinned to `@2.117.2` on every page. That version is immutable on jsDelivr, so it's cached for a year and shared across pages. To upgrade, change the version everywhere at once.
- **index.html `<head>`** preloads:
  - supabase-js, the config, the catalogue and the first hero slide, all in parallel;
  - the blocking duplicate supabase-js is gone.

  Hero slides after the first get their background only after the page `load` event.
- **Skeleton cards.** The three curated rows ship with shimmering skeleton cards (`.sk-wrap` / `.sk`, `style.css`), and `renderAll` replaces them. If products fail to load, `clearHomeSkeletons()` hides those rows instead of leaving them shimmering.

  The old generic home rows (Hot Deals, Trending…) now start hidden. The curated home always hid them, but their empty headings used to flash while loading.
- **Repo images.** The hero images went from 3840 px to 1600 px: 257/470 KB → 92/134 KB. `umzila.webp` went from 1563 px to 480 px. `netlify.toml` gives them a 1-day cache plus a 1-week stale-while-revalidate, so **give a replaced image a new name.**

## Store pages (added 2026-10-05, second pass)

`netlify/functions/get-store.js?slug=<slug>` is the store-page twin of `get-catalog`. It is CDN-cached for 60 s per slug and read with the anon key. It returns:
- the seller's **public columns only**: no `user_id`, `email`, `pickup_geo` or `application_id` (see `SELLER_COLS`);
- the listed products with their images;
- `seller_availability` rows;
- `get_store_hours_status()`;
- sponsored product ids for this store.

`shop.html` and `/ncekeniquads/` both start the fetch at script parse (`storePromise`), in parallel with the config. A store visit now makes about 3 small live calls instead of about 6:
- the presence ping;
- a live open/closed re-check, because the cached hours can be a minute old;
- favourites when signed in, and the booking load on Nceks.

Fallbacks:
- If the function fails, each page runs its old direct queries.
- The legacy `shop.html?shop=<name>` link always uses the direct path.
- An unknown slug is cached as `{seller:null}` and shows "Store not found".

**New store page or bespoke storefront?** Read from `get-store` and keep a fallback. If you need a seller column that isn't in `SELLER_COLS`, add it there, and only if it's public.

## Store visitor tracking

Store pages don't load `script.js`, so until 2026-10-05 they recorded nothing: no store visits, product opens or add-to-carts. That covers the template `shop.html` and the bespoke Nceks page.

`presence.js` now also provides `umzilaTrack(event, data)`, using the same `user_events` rows and the same `ss_anon_id` as `script.js` `trackEvent`. It records:
- `store_view`: once per store page load, with `metadata.page` = template or bespoke;
- `product_click`: quick view opened, or a ride picked;
- `add_to_cart`: an item added, a ride held or a voucher added.

**Counter events (click, view, add-to-cart) go only through `track-engagement.js`.** It logs the `user_events` row and bumps the product counters. `script.js` used to *also* insert them itself, so every home click and add was stored twice. That's fixed, and the historical pairs were deleted (migration `user_events_dedupe_double_logged_clicks`).

Where people see it:
- **Admin** → Intelligence → Sellers has a "Store visits (30d)" column with distinct people.
- **Admin** → Live now names the store (`get_live_visitors` joins the slug to `shop_name`).
- **Sellers** → Analytics has "Store visitors": on your store now, visitors over 7 and 30 days, and visits over 30 days. This uses `get_my_store_traffic(seller_id)`, which only works for a store you own.

## Live visitor counter ("On the site now" in admin)

`presence.js` is loaded on the buyer pages: home, store pages, the Nceks page, cart, checkout, the success page, profile and track. It keeps one random id per browser in localStorage (`umz_presence_id`) and calls `touch_presence(id, page)` when the page's Supabase client is ready, then about once a minute while the tab is visible.

`site_presence` is an **UNLOGGED** table: throw-away data with no WAL cost. RLS is on with no policies, so only the two RPCs below can touch it:
- `touch_presence` (anon + authenticated) upserts the row, tags `user_id` from the session token, skips rewrites within 20 s, and about 1 in 50 calls deletes rows older than 10 minutes.
- `get_live_visitors()` follows the same staff rule as `get_ops_board`. It returns the total, signed in vs guests, and the top pages for heartbeats in the last 150 s.

admin.html's Live now strip shows it, refreshed every 30 s with the ops board.

Limitations:
- Staff pages (admin, logistics, seller dashboard) don't send heartbeats.
- Someone deliberately spamming random ids could inflate the number; it's a gauge, not analytics.
- At 2,000 visitors it costs about 33 tiny writes a second.

## Before touching this again

- Adding a new place that shows product photos small? Use `thumbUrl()` (or the inline replace) with a fallback.
- Adding an upload? Go through `umzilaImages.upload` with a unique, timestamped base.
- Adding a home-page read that every visitor makes? Put it in `get-catalog` (with a fallback) rather than a per-visitor query.
- Changing what the catalogue returns? The page maps rows through `loadProducts`' object literal (see the allowlist gotcha in CLAUDE.md), so a new column needs adding there too.
