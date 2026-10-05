// One-time (re-runnable) image optimiser for every image the site shows.
// Run from the repo root:  npx netlify dev:exec node docs/design/product-images/optimize-all.js   (set APPLY=1 to write)
// (needs `sharp`: npm i --no-save sharp). Without --apply it only measures.
//
// For each image referenced by products.image, product_images.url,
// sellers.logo_url / banner_url it writes WebP copies next to the original:
//   <name>.w1280.webp  full size (product photos; banners use w1600, logos w512)
//   <name>.w480.webp   card thumbnail (products only) — the site derives the
//                      thumbnail URL from the .w1280.webp name (script.js thumbUrl)
// served with a 1-year cache (the names never get reused). The database rows
// are switched to the .w1280 / .w1600 / .w512 file. Originals are KEPT: old
// orders/emails may still point at them, and they are the rollback.
const fs = require('fs'), path = require('path');
const sharp = require(require.resolve('sharp', { paths: [process.cwd(), __dirname] }));
const { createClient } = require(require.resolve('@supabase/supabase-js', { paths: [process.cwd()] }));
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1';
const DONE = /\.w\d+\.webp$/i;
const SIZES = { product: 1280, banner: 1600, logo: 512 };
const THUMB = 480;
const YEAR = '31536000';

function parse(url) {
  const m = /\/storage\/v1\/object\/public\/([^/]+)\/(.+?)(\?.*)?$/.exec(url || '');
  return m ? { bucket: m[1], path: decodeURIComponent(m[2]) } : null;
}
const base = p => p.replace(/\.[a-z0-9]+$/i, '');
const enc = async (buf, max, q) => sharp(buf, { failOn: 'none' }).rotate()
  .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true }).webp({ quality: q, effort: 5 }).toBuffer();

(async () => {
  const [prods, imgs, sellers] = await Promise.all([
    sb.from('products').select('id, image'),
    sb.from('product_images').select('id, url'),
    sb.from('sellers').select('id, logo_url, banner_url')
  ]);
  for (const r of [prods, imgs, sellers]) if (r.error) throw r.error;
  const jobs = new Map(); // url -> kind (product wins over banner/logo)
  const want = (url, kind) => { if (!url || DONE.test(url) || !parse(url)) return; if (jobs.get(url) !== 'product') jobs.set(url, kind); };
  prods.data.forEach(r => want(r.image, 'product'));
  imgs.data.forEach(r => want(r.url, 'product'));
  sellers.data.forEach(r => { want(r.logo_url, 'logo'); want(r.banner_url, 'banner'); });

  const map = {}; let before = 0, after = 0, thumbs = 0, n = 0, failed = 0;
  for (const [url, kind] of jobs) {
    const { bucket, path: p } = parse(url);
    const dl = await sb.storage.from(bucket).download(p);
    if (dl.error) { console.log('skip (missing)', p); failed++; continue; }
    const orig = Buffer.from(await dl.data.arrayBuffer());
    if (!/^image\//.test(dl.data.type || '') && !/\.(png|jpe?g|webp|gif|avif)$/i.test(p)) { console.log('skip (not an image)', p); continue; }
    let full, small;
    try {
      full = await enc(orig, SIZES[kind], 80);
      // An already-small WebP stays byte-for-byte (no second lossy pass).
      const meta = await sharp(orig).metadata();
      if (meta.format === 'webp' && orig.length <= full.length && Math.max(meta.width, meta.height) <= SIZES[kind]) full = orig;
      if (kind === 'product') small = await enc(orig, THUMB, 74);
    } catch (e) { console.log('skip (cannot decode)', p, e.message); failed++; continue; }
    const fullPath = `${base(p)}.w${SIZES[kind]}.webp`, smallPath = `${base(p)}.w${THUMB}.webp`;
    before += orig.length; after += full.length; thumbs += small ? small.length : 0; n++;
    console.log(`${kind.padEnd(7)} ${(orig.length / 1024).toFixed(0).padStart(5)} KB → ${(full.length / 1024).toFixed(0).padStart(4)} KB${small ? ` (+ thumb ${(small.length / 1024).toFixed(0)} KB)` : ''}  ${p}`);
    if (!APPLY) continue;
    const up1 = await sb.storage.from(bucket).upload(fullPath, full, { contentType: 'image/webp', upsert: true, cacheControl: YEAR });
    if (up1.error) { console.log('upload failed', fullPath, up1.error.message); failed++; continue; }
    if (small) {
      const up2 = await sb.storage.from(bucket).upload(smallPath, small, { contentType: 'image/webp', upsert: true, cacheControl: YEAR });
      if (up2.error) { console.log('thumb upload failed', smallPath, up2.error.message); failed++; continue; }
    }
    map[url] = sb.storage.from(bucket).getPublicUrl(fullPath).data.publicUrl;
  }

  if (APPLY) {
    let rows = 0;
    for (const [oldUrl, newUrl] of Object.entries(map)) {
      for (const [table, col] of [['products', 'image'], ['product_images', 'url'], ['sellers', 'logo_url'], ['sellers', 'banner_url']]) {
        const { data, error } = await sb.from(table).update({ [col]: newUrl }).eq(col, oldUrl).select('id');
        if (error) { console.log('db update failed', table, col, error.message); failed++; } else rows += data.length;
      }
    }
    const out = path.join(__dirname, `optimize-map-${new Date().toISOString().slice(0, 10)}.json`);
    // Saved as bucket/path only — a full project URL in the repo trips Netlify's secret scan.
    const strip = u => decodeURIComponent(u.replace(/^.*\/storage\/v1\/object\/public\//, ''));
    const paths = {}; for (const [k, v] of Object.entries(map)) paths[strip(k)] = strip(v);
    fs.writeFileSync(out, JSON.stringify({ note: 'bucket/path of each original -> its optimised copy (originals kept)', map: paths }, null, 1));
    console.log(`\nDB rows switched: ${rows}. Old→new map (rollback) saved to ${out}`);
  }
  const mb = b => (b / 1048576).toFixed(1) + ' MB';
  console.log(`\n${n} images: ${mb(before)} → ${mb(after)} full + ${mb(thumbs)} thumbnails. Failed/skipped: ${failed}. ${APPLY ? 'APPLIED' : 'dry run (add --apply)'}`);
})().catch(e => { console.error('FAILED', e.message || e); process.exit(1); });
