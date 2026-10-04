// Run with: npx netlify dev:exec node upload.js  (env injected, service role)
// Uploads designed product images and makes each its listing's primary image
// (product_images image_order 0 + products.image). Earlier designed images
// (same store folder, nceks-*/velaphi-* names) are replaced; real photos stay
// in the gallery after the design.
const fs = require('fs'), path = require('path');
const { createClient } = require(require.resolve('@supabase/supabase-js', { paths: [process.cwd()] }));
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const OUT = path.join(__dirname, 'out');
const isDesign = url => /\/stores\/(ncekeniquads|velaphishisanyama)\/(nceks|velaphi)-/.test(url);

async function setPrimary(productId, name, folder, file) {
  const key = `stores/${folder}/${file}`;
  const up = await sb.storage.from('product-images').upload(key, fs.readFileSync(path.join(OUT, file)), { contentType: 'image/webp', upsert: true, cacheControl: '604800' });
  if (up.error) throw up.error;
  const url = sb.storage.from('product-images').getPublicUrl(key).data.publicUrl;
  const { data: imgs } = await sb.from('product_images').select('id, url, image_order').eq('product_id', productId).order('image_order');
  const old = (imgs || []).filter(i => isDesign(i.url) && i.url !== url);
  for (const o of old) await sb.from('product_images').delete().eq('id', o.id);
  const photos = (imgs || []).filter(i => !isDesign(i.url));
  for (let i = 0; i < photos.length; i++) await sb.from('product_images').update({ image_order: i + 1 }).eq('id', photos[i].id);
  if (!(imgs || []).some(i => i.url === url)) {
    const ins = await sb.from('product_images').insert({ product_id: productId, url, image_order: 0, alt_text: name });
    if (ins.error) throw ins.error;
  } else {
    await sb.from('product_images').update({ image_order: 0 }).eq('product_id', productId).eq('url', url);
  }
  const upd = await sb.from('products').update({ image: url }).eq('id', productId);
  if (upd.error) throw upd.error;
  console.log('ok', name, '→', file, `(${photos.length} photo${photos.length === 1 ? '' : 's'} kept, ${old.length} old design removed)`);
}

(async () => {
  const { data: nceks } = await sb.from('sellers').select('id').eq('slug', 'ncekeniquads').single();
  const { data: np } = await sb.from('products').select('id, name, metadata, slot_duration_minutes').eq('seller_id', nceks.id);
  for (const p of np) {
    const voucher = p.metadata && p.metadata.voucher === true;
    const mins = Number((p.metadata && p.metadata.ride_minutes) || p.slot_duration_minutes);
    if (!mins) continue;
    await setPrimary(p.id, `${p.name} — Nceks Quad Biking`, 'ncekeniquads', `nceks-${voucher ? 'voucher' : 'ride'}-${mins}-v2.webp`);
  }
  const { data: vel } = await sb.from('sellers').select('id').eq('slug', 'velaphishisanyama').single();
  const { data: vp } = await sb.from('products').select('id, name').eq('seller_id', vel.id);
  for (const p of vp) {
    const file = `velaphi-${p.id}.webp`;
    if (!fs.existsSync(path.join(OUT, file))) { console.log('skip (no design)', p.name); continue; }
    await setPrimary(p.id, `${p.name} — Velaphi Shisanyama`, 'velaphishisanyama', file);
  }
})().catch(e => { console.error('FAILED', e.message || e); process.exit(1); });
