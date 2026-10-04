# Designed product images (Nceks, Velaphi)

Images that say what a listing *is* at card size, with the real photo underneath. Last regenerated 2026-10-04.

- **Nceks rides:** ride photo full-bleed, huge duration ("1 HOUR", "1½ HOURS"…), and a "Tap **Book** below" arrow pointing at the real button under the image. That's the "+"/Book button on homepage cards, or Book on the Nceks cards. There are two shapes:
  - `nceks-ride-<m>-v2.webp` (1200², product image)
  - `ncekeniquads/img/card-<m>.webp` (960×1200, the bespoke page's "Pick your ride" cards; the top corners and bottom-left stay clear for the best-value tag, gauge and next-time tag)
- **Nceks gift vouchers:** a cream gift card with ribbon and bow over a blurred photo, plus "Tap **Buy gift** below".
- **Velaphi plates:** each plate's own photo, with "BEEF & WORS" plus a bold yellow "+2 WINGS" / "PLATE" / "FOR TWO" and red "FREE SIDES" chips. The five wing plates looked identical before, and the originals were 1.6–2.9 MB PNGs; these are about 70–180 KB WebP.

Files:
- `thumb.html?k=ride|voucher|vel&ar=sq|card…` is the design. On squares, everything important sits in the central ~840px, so the 3:4 homepage crop and the 4:3 phone-modal crop keep it.
- `render.js` renders each job with headless Chrome and writes WebP with `sharp` (`npm i sharp` next to it, and fix the paths at the top first). Velaphi source photos go in `vel/` and the logo in `vel/logo.png`.
- `upload.js` runs via `npx netlify dev:exec node upload.js`. It uploads to `product-images/stores/<slug>/`, makes the design `product_images` order 0 and `products.image`, removes the previous design, and keeps the photos in the gallery.
- **Bump the filename** (`-v2`, `-v3`…) when changing an image, because storage serves it with a 7-day cache.
