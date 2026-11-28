// netlify/functions/submit-marketing-campaign.js
//
// Sellers/admins compose a promotional email in five plain-text slots —
// the layout (netlify/functions/lib/marketing-template.js) is fixed and
// never editable. Sellers submit as 'pending' (needs admin approval before
// it can send); admins submit as 'approved' (a platform campaign skips its
// own queue — the admin already is the approver).
const { createClient } = require('@supabase/supabase-js');
const { renderMarketingEmail } = require('./lib/marketing-template');

const MAX_LEN = { subject: 80, headline: 60, body_message: 500, cta_text: 30, eyebrow: 40, urgency: 90, highlight: 70 };
// Rich slots (photo, price/was, urgency, highlights) — 2026-11-25. A photo must be an https
// image on our own site or our Supabase storage (never an arbitrary host).
function cleanImage(u) {
  const v = String(u || '').trim();
  if (!v) return null;
  try {
    const url = new URL(v), hosts = [process.env.SITE_BASE_URL, process.env.URL, process.env.SUPABASE_URL].filter(Boolean).map(h => { try { return new URL(h).host; } catch (e) { return ''; } });
    if (url.protocol !== 'https:' || !hosts.includes(url.host)) return null;
    return url.toString();
  } catch (e) { return null; }
}
function cleanMoney(v) { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) || n < 0 || n > 100000 ? null : Math.round(n * 100) / 100; }

function clamp(str, max) {
  return String(str || '').trim().replace(/[<>]/g, '').slice(0, max);
}

exports.handler = async function (event) {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const SITE_BASE_URL = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server config error' }) };
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };

  const { data: adminRow } = await admin.from('admins').select('role').eq('user_id', user.id).maybeSingle();
  const isAdmin = !!adminRow && adminRow.role === 'admin';

  let sellerRow = null;
  if (!isAdmin) {
    // Primary-owned stores plus any the user co-owns (seller_members).
    const { data: memberRows } = await admin.from('seller_members').select('seller_id').eq('user_id', user.id);
    const memberIds = (memberRows || []).map(m => m.seller_id);
    let shopsQ = admin.from('sellers').select('id, shop_name, slug');
    shopsQ = memberIds.length ? shopsQ.or(`user_id.eq.${user.id},id.in.(${memberIds.join(',')})`) : shopsQ.eq('user_id', user.id);
    const { data: shops } = await shopsQ;
    if (!shops || !shops.length) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
    // A seller campaign is scoped to whichever shop the request names, or
    // their first shop if unspecified — verified against their own list,
    // never trusted blindly.
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    sellerRow = shops.find(s => s.id === body.seller_id) || shops[0];
  }

  // ── GET: list this submitter's own campaigns ────────────────────────────
  if (event.httpMethod === 'GET') {
    let q = admin.from('marketing_campaigns').select('*').order('created_at', { ascending: false }).limit(100);
    q = isAdmin ? q.eq('created_by', user.id) : q.eq('seller_id', sellerRow.id);
    const { data: campaigns, error } = await q;
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ campaigns: campaigns || [] }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const subject      = clamp(body.subject, MAX_LEN.subject);
  const headline      = clamp(body.headline, MAX_LEN.headline);
  const body_message  = clamp(body.body_message, MAX_LEN.body_message);
  const cta_text      = clamp(body.cta_text, MAX_LEN.cta_text) || 'Shop now';

  if (!subject || !headline || !body_message) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Subject, headline, and message are required.' }) };
  }
  const image_url = cleanImage(body.image_url);
  if (body.image_url && !image_url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'The photo must be an https image from umzila.store or our image storage.' }) };
  const eyebrow = clamp(body.eyebrow, MAX_LEN.eyebrow) || null;
  const urgency = clamp(body.urgency, MAX_LEN.urgency) || null;
  const highlights = String(body.highlights || '').split('\n').map(x => clamp(x, MAX_LEN.highlight)).filter(Boolean).slice(0, 6);
  const offer_price = cleanMoney(body.offer_price);
  const offer_was = offer_price != null ? cleanMoney(body.offer_was) : null;
  if (offer_was != null && offer_was <= offer_price) return { statusCode: 400, headers, body: JSON.stringify({ error: 'The "was" price must be higher than the price.' }) };
  const rich = { image_url, eyebrow, urgency, highlights: highlights.length ? highlights : null, offer_price, offer_was };

  // ── Resolve CTA destination from a fixed set of options — never a raw
  // client-supplied URL, so a campaign can never link somewhere unintended.
  let cta_path = '/';
  let shopName = null;
  const dest = body.cta_destination;
  if (dest === 'my_shop' && sellerRow) {
    cta_path = sellerRow.slug ? `/${sellerRow.slug}` : `/shop.html?shop=${encodeURIComponent(sellerRow.shop_name)}`;
    shopName = sellerRow.shop_name;
  } else if (dest === 'product' && body.cta_product_id) {
    const { data: product } = await admin.from('products').select('id, seller_id, sellers(slug, shop_name)').eq('id', body.cta_product_id).maybeSingle();
    if (!product) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Product not found.' }) };
    if (!isAdmin && product.seller_id !== sellerRow.id) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'You can only link to your own products.' }) };
    }
    if (!isAdmin) shopName = sellerRow.shop_name;
    // The product's own store page, with the product modal opened on arrival.
    const productShop = product.sellers || null;
    cta_path = productShop && productShop.slug
      ? `/${productShop.slug}?product=${encodeURIComponent(body.cta_product_id)}`
      : `/shop.html?${productShop && productShop.shop_name ? `shop=${encodeURIComponent(productShop.shop_name)}&` : ''}product=${encodeURIComponent(body.cta_product_id)}`;
  } else if (dest === 'store') {
    if (!isAdmin || !body.cta_seller_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Choose which store the button opens.' }) };
    // Platform campaign pointing at one store (admin only). src=email so the
    // orders it brings show under "Where orders come from".
    const { data: store } = await admin.from('sellers').select('id, slug').eq('id', body.cta_seller_id).maybeSingle();
    if (!store || !store.slug) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Store not found.' }) };
    cta_path = `/${store.slug}?src=email`;
  } else if (dest === 'checkout_with_code' && body.discount_code_id) {
    // resolved below once the code is verified
  } else {
    cta_path = '/';
  }
  if (!isAdmin && sellerRow) shopName = sellerRow.shop_name;

  // ── Attached discount code (optional) — must exist and belong to the submitter.
  let discount_code_id = null;
  let codeRowForPreview = null;
  if (body.discount_code_id) {
    const { data: codeRow } = await admin.from('discount_codes').select('*').eq('id', body.discount_code_id).maybeSingle();
    if (!codeRow) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Discount code not found.' }) };
    if (!isAdmin && codeRow.seller_id !== sellerRow.id) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'You can only attach your own codes.' }) };
    }
    if (codeRow.status !== 'active' || (codeRow.expires_at && new Date(codeRow.expires_at) < new Date())) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'That code is not currently active.' }) };
    }
    discount_code_id = codeRow.id;
    codeRowForPreview = codeRow;
    if (dest === 'checkout_with_code') cta_path = `/checkout.html?coupon=${encodeURIComponent(codeRow.code)}`;
  }

  const ctaUrl = `${SITE_BASE_URL}${cta_path}`;

  if (body.action === 'preview') {
    const html = renderMarketingEmail({
      headline, bodyMessage: body_message, ctaText: cta_text, ctaUrl, shopName,
      codeRow: codeRowForPreview, sellerShopName: shopName,
      imageUrl: rich.image_url, eyebrow: rich.eyebrow, urgency: rich.urgency, highlights: rich.highlights,
      offerPrice: rich.offer_price, offerWas: rich.offer_was,
      siteUrl: SITE_BASE_URL, unsubscribeUrl: `${SITE_BASE_URL}/.netlify/functions/unsubscribe?e=preview%40example.com&t=preview`
    });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin }, body: JSON.stringify({ html }) };
  }

  if (body.action !== 'submit' && body.action !== 'schedule') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  }
  // Schedule (admins only): send-scheduled-campaigns.js sends it at scheduled_for.
  let scheduled_for = null;
  if (body.action === 'schedule') {
    if (!isAdmin) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Only admins can schedule campaigns.' }) };
    const at = new Date(body.scheduled_for);
    if (isNaN(at) || at.getTime() < Date.now() + 60000 || at.getTime() > Date.now() + 60 * 86400000) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Pick a send time at least a minute from now and within 60 days.' }) };
    }
    scheduled_for = at.toISOString();
  }

  const insertRow = {
    seller_id: isAdmin ? (body.seller_id || null) : sellerRow.id,
    created_by: user.id,
    discount_code_id,
    subject, headline, body_message: body_message,
    cta_text, cta_path,
    // Admins may send to people with an unfinished basket (campaign_basket_recipients()); sellers always 'subscribers'.
    audience: isAdmin && body.audience === 'baskets' ? 'baskets' : 'subscribers',
    ...rich,
    scheduled_for,
    status: scheduled_for ? 'scheduled' : isAdmin ? 'approved' : 'pending'
  };
  if (isAdmin) {
    insertRow.approved_by = user.id;
    insertRow.approved_at = new Date().toISOString();
  }

  const { data: created, error: insErr } = await admin.from('marketing_campaigns').insert([insertRow]).select().single();
  if (insErr) return { statusCode: 500, headers, body: JSON.stringify({ error: insErr.message }) };

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, campaign: created }) };
};
