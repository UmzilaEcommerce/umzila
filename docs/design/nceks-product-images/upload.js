// Run with: npx netlify dev:exec node upload.js  (env injected, service role)
// Uploads the 8 designed Nceks product images and makes each its listing's
// primary image (product_images image_order 0 + products.image); the
// existing photos stay in the gallery after it.
const fs = require('fs'), path = require('path');
const { createClient } = require(require.resolve('@supabase/supabase-js', { paths: [process.cwd()] }));
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const OUT = path.join(__dirname, 'out');
(async () => {
  const { data: seller } = await sb.from('sellers').select('id').eq('slug', 'ncekeniquads').single();
  const { data: prods } = await sb.from('products').select('id, name, metadata, slot_duration_minutes').eq('seller_id', seller.id);
  for (const p of prods) {
    const voucher = p.metadata && p.metadata.voucher === true;
    const mins = Number((p.metadata && p.metadata.ride_minutes) || p.slot_duration_minutes);
    if (!mins) { console.log('skip', p.name); continue; }
    const file = `nceks-${voucher ? 'voucher' : 'ride'}-${mins}.webp`;
    const key = `stores/ncekeniquads/${file}`;
    const up = await sb.storage.from('product-images').upload(key, fs.readFileSync(path.join(OUT, file)), { contentType: 'image/webp', upsert: true, cacheControl: '604800' });
    if (up.error) throw up.error;
    const url = sb.storage.from('product-images').getPublicUrl(key).data.publicUrl;
    const { data: imgs } = await sb.from('product_images').select('id, url, image_order').eq('product_id', p.id).order('image_order');
    const rest = (imgs || []).filter(i => i.url !== url);
    // shift existing images back by one, then insert the design at 0
    for (let i = 0; i < rest.length; i++) await sb.from('product_images').update({ image_order: i + 1 }).eq('id', rest[i].id);
    if (!(imgs || []).some(i => i.url === url)) {
      const ins = await sb.from('product_images').insert({ product_id: p.id, url, image_order: 0, alt_text: `${p.name} — Nceks Quad Biking` });
      if (ins.error) throw ins.error;
    } else {
      await sb.from('product_images').update({ image_order: 0 }).eq('product_id', p.id).eq('url', url);
    }
    const upd = await sb.from('products').update({ image: url }).eq('id', p.id);
    if (upd.error) throw upd.error;
    console.log('ok', p.name, '→', file, '(+' + rest.length + ' photos)');
  }
})().catch(e => { console.error('FAILED', e.message || e); process.exit(1); });
