// netlify/functions/submit-marketing-campaign.js
//
// Sellers/admins compose a promotional email in five plain-text slots —
// the layout (netlify/functions/lib/marketing-template.js) is fixed and
// never editable. Sellers submit as 'pending' (needs admin approval before
// it can send); admins submit as 'approved' (a platform campaign skips its
// own queue — the admin already is the approver).
const { createClient } = require('@supabase/supabase-js');
const { renderMarketingEmail } = require('./lib/marketing-template');

const MAX_LEN = { subject: 80, headline: 60, body_message: 500, cta_text: 30 };

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
    const { data: shops } = await admin.from('sellers').select('id, shop_name').eq('user_id', user.id);
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

  // ── Resolve CTA destination from a fixed set of options — never a raw
  // client-supplied URL, so a campaign can never link somewhere unintended.
  let cta_path = '/';
  let shopName = null;
  const dest = body.cta_destination;
  if (dest === 'my_shop' && sellerRow) {
    cta_path = `/shop.html?shop=${encodeURIComponent(sellerRow.shop_name)}`;
    shopName = sellerRow.shop_name;
  } else if (dest === 'product' && body.cta_product_id) {
    const { data: product } = await admin.from('products').select('id, seller_id').eq('id', body.cta_product_id).maybeSingle();
    if (!product) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Product not found.' }) };
    if (!isAdmin && product.seller_id !== sellerRow.id) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'You can only link to your own products.' }) };
    }
    let shopParam = '';
    if (!isAdmin) { shopName = sellerRow.shop_name; shopParam = `shop=${encodeURIComponent(sellerRow.shop_name)}&`; }
    cta_path = `/shop.html?${shopParam}product=${encodeURIComponent(body.cta_product_id)}`;
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
      siteUrl: SITE_BASE_URL, unsubscribeUrl: `${SITE_BASE_URL}/.netlify/functions/unsubscribe?e=preview%40example.com&t=preview`
    });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin }, body: JSON.stringify({ html }) };
  }

  if (body.action !== 'submit') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  }

  const insertRow = {
    seller_id: isAdmin ? (body.seller_id || null) : sellerRow.id,
    created_by: user.id,
    discount_code_id,
    subject, headline, body_message: body_message,
    cta_text, cta_path,
    audience: 'subscribers',
    status: isAdmin ? 'approved' : 'pending'
  };
  if (isAdmin) {
    insertRow.approved_by = user.id;
    insertRow.approved_at = new Date().toISOString();
  }

  const { data: created, error: insErr } = await admin.from('marketing_campaigns').insert([insertRow]).select().single();
  if (insErr) return { statusCode: 500, headers, body: JSON.stringify({ error: insErr.message }) };

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, campaign: created }) };
};
