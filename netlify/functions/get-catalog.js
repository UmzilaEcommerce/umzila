// netlify/functions/get-catalog.js
//
// The home page's product catalogue (script.js loadProducts), served from
// Netlify's CDN instead of every visitor querying Supabase. The same reads the
// page used to make itself, with the ANON key — so it returns exactly what a
// guest is allowed to see (RLS unchanged): listed products with their images
// and store, every product option (product_variants), the active stores
// (Featured Shops) and the running ads (sponsored products, featured shops,
// hero banners — the page re-checks ends_at itself).
//
// Cached at the edge for 60 s (then refreshed in the background), so 2,000
// visitors in a minute cost ~1 database read instead of ~4,000. A product
// change shows on the home page within about a minute; stock is still checked
// live at add-to-cart / validate-cart, never from this list. If this function
// fails, script.js falls back to querying Supabase directly (old path).
const { createClient } = require('@supabase/supabase-js');

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const [prods, vars, stores_, ads_] = await Promise.all([
      sb.from('products')
        .select(`
          *,
          product_images!fk_product_images_product(*),
          sellers(id, shop_name, slug, logo_url, whatsapp_number, delivery_method, turnaround_time, status)
        `)
        .eq('visible', true)
        .order('created_at', { ascending: false }),
      sb.from('product_variants').select('*'),
      sb.from('sellers').select('id,shop_name,slug,banner_url,logo_url,description').eq('status', 'active').eq('is_house', false), // house add-on store (Umzila Drinks) isn't a browsable store
      sb.from('ad_campaigns').select('type, product_id, seller_id, image_url, link_url, ends_at')
        .eq('status', 'active').gt('ends_at', new Date().toISOString())
    ]);
    if (prods.error) throw prods.error;
    if (vars.error) throw vars.error;
    // Stores/ads are extras: if either read fails the page queries them itself.
    const stores = stores_.error ? null : (stores_.data || []);
    const ads = ads_.error ? null : (ads_.data || []);
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Netlify-CDN-Cache-Control': 'public, durable, max-age=60, stale-while-revalidate=300'
      },
      body: JSON.stringify({ products: prods.data || [], variants: vars.data || [], stores, ads, at: new Date().toISOString() })
    };
  } catch (err) {
    // Never cache a failure.
    return { statusCode: 500, headers: { ...headers, 'Cache-Control': 'no-store', 'Netlify-CDN-Cache-Control': 'no-store' }, body: JSON.stringify({ error: err.message || 'catalog failed' }) };
  }
};
