// netlify/functions/get-store.js?slug=<sellers.slug>
//
// One store page's data (shop.html and bespoke storefronts like /ncekeniquads/),
// served from Netlify's CDN instead of every visitor querying Supabase — the
// same idea as get-catalog.js for the home page (docs/systems/site-speed.md).
// Reads with the ANON key, so it returns only what a guest may see:
//   seller        the store's public profile (no owner id/email/pickup pin)
//   products      its listed products with their images
//   availability  its opening/booking hours (seller_availability rows)
//   hours         get_store_hours_status() at fetch time (open/closed now)
//   sponsored     product ids with a running sponsored-product ad
// Cached at the edge for 60 s per slug (then refreshed in the background).
// Stock/booking capacity are always re-checked live (validate-cart,
// get_booking_load, hold-service-booking) — never trusted from here. The
// pages poll hours live and fall back to their old direct queries if this fails.
const { createClient } = require('@supabase/supabase-js');

// Every column the store pages read from sellers — nothing private.
const SELLER_COLS = 'id, shop_name, slug, status, description, about_story, owner_story, location, logo_url, banner_url, '
  + 'turnaround_time, years_operating, return_policy, theme_color, self_arranged_radius_km, booking_capacity, '
  + 'booking_start_interval_minutes, social_instagram, social_tiktok, whatsapp_number, support_email, delivery_method, free_delivery';

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const noStore = { ...headers, 'Cache-Control': 'no-store', 'Netlify-CDN-Cache-Control': 'no-store' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: noStore, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const slug = String((event.queryStringParameters || {}).slug || '').toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    return { statusCode: 400, headers: noStore, body: JSON.stringify({ error: 'Bad store link' }) };
  }
  const cached = {
    ...headers,
    'Cache-Control': 'public, max-age=0, must-revalidate',
    'Netlify-CDN-Cache-Control': 'public, durable, max-age=60, stale-while-revalidate=300'
  };
  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const sellerRes = await sb.from('sellers').select(SELLER_COLS).eq('slug', slug).limit(1);
    if (sellerRes.error) throw sellerRes.error;
    const seller = (sellerRes.data || [])[0] || null;
    if (!seller) return { statusCode: 200, headers: cached, body: JSON.stringify({ seller: null }) };
    const [prods, avail, hours, ads] = await Promise.all([
      sb.from('products').select('*, product_images!fk_product_images_product(*)').eq('seller_id', seller.id).eq('visible', true).order('created_at', { ascending: false }),
      sb.from('seller_availability').select('day_of_week, start_time, end_time').eq('seller_id', seller.id),
      sb.rpc('get_store_hours_status', { p_seller_ids: [seller.id] }),
      sb.from('ad_campaigns').select('product_id').eq('type', 'sponsored_product').eq('status', 'active').gt('ends_at', new Date().toISOString())
    ]);
    if (prods.error) throw prods.error;
    return {
      statusCode: 200,
      headers: cached,
      body: JSON.stringify({
        seller,
        products: prods.data || [],
        availability: avail.error ? null : (avail.data || []),
        hours: hours.error ? null : ((hours.data || [])[0] || null),
        sponsored: ads.error ? [] : (ads.data || []).map(a => a.product_id).filter(id => (prods.data || []).some(p => p.id === id)),
        at: new Date().toISOString()
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: noStore, body: JSON.stringify({ error: err.message || 'store failed' }) };
  }
};
