# Nceks product images

The designed images for the Nceks listings (2026-10-04): a **ride** look (the ride photo full-bleed, huge duration, orange "Book a time" pill) and a **gift voucher** look (a cream gift card with an orange ribbon over a blurred photo), so the two can't be confused at card size.

- `thumb.html?k=ride|voucher&m=30|60|90|120&img=<photo>&logo=<logo>` is the design (1200×1200; everything important sits in the central ~840px so the 3:4 homepage crop and the 4:3 phone-modal crop keep it).
- `render.js` takes a screenshot of each variant with headless Chrome and writes WebP files with `sharp` (install it next to the script: `npm i sharp`). Fix the paths at the top first.
- `upload.js` (run via `npx netlify dev:exec node upload.js`) uploads them to `product-images/stores/ncekeniquads/` and makes each one its listing's primary image (`product_images` order 0 + `products.image`); the photos stay in the gallery after it.

A new ride length needs a label in `thumb.html` (`big` map) and a photo.
