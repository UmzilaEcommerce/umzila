// netlify/functions/initiate-ad-payment.js
// Authenticated by seller JWT.
// Creates an ad_campaigns row then returns an auto-submitting PayFast form.
// custom_str1 = 'ad_campaign', custom_str2 = campaign.id
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PRICES = { sponsored_product: 50, featured_shop: 150, hero_banner: 300 };
const TYPES  = ['sponsored_product', 'featured_shop', 'hero_banner'];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const SUPABASE_URL  = process.env.SUPABASE_URL || '';
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const MERCHANT_ID   = (process.env.PAYFAST_MERCHANT_ID  || '').trim();
  const MERCHANT_KEY  = (process.env.PAYFAST_MERCHANT_KEY || '').trim();
  const PASSPHRASE    = (process.env.PAYFAST_PASSPHRASE   || '').trim();
  const SANDBOX       = (process.env.PAYFAST_SANDBOX || 'true').toLowerCase() !== 'false';
  const SITE_BASE_URL = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');

  if (!SUPABASE_URL || !SERVICE_KEY || !MERCHANT_ID || !MERCHANT_KEY) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  // ── Auth: verify JWT belongs to a seller ───────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: { user: callerUser }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !callerUser) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid or expired session' }) };
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { seller_id, type, product_id, image_url, link_url, duration_weeks = 1 } = body;

  if (!seller_id || !type || !TYPES.includes(type)) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'seller_id and valid type are required' }) };
  }

  // Confirm the caller owns this seller
  const { data: seller } = await admin
    .from('sellers')
    .select('id, shop_name, email, whatsapp_number, status')
    .eq('id', seller_id)
    .eq('user_id', callerUser.id)
    .maybeSingle();

  if (!seller) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Forbidden: seller not found or not yours' }) };
  }

  if (type === 'sponsored_product' && !product_id) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'product_id required for sponsored_product' }) };
  }
  if (type === 'hero_banner' && !image_url) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'image_url required for hero_banner' }) };
  }

  const weeks      = Math.max(1, Math.min(12, parseInt(duration_weeks) || 1));
  const pricePerWk = PRICES[type];
  const amount     = pricePerWk * weeks;

  // ── Create ad_campaigns row ────────────────────────────────────────────────
  const mPaymentId = `AD-${seller_id.slice(0,8)}-${Date.now()}`;

  const { data: campaign, error: campErr } = await admin
    .from('ad_campaigns')
    .insert({
      seller_id,
      type,
      product_id: product_id || null,
      image_url:  image_url  || null,
      link_url:   link_url   || null,
      amount_paid:    amount,
      payment_status: 'pending',
      status:         'pending_payment',
      m_payment_id:   mPaymentId
    })
    .select('id')
    .single();

  if (campErr || !campaign) {
    console.error('initiate-ad-payment: insert campaign error', campErr);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Failed to create campaign' }) };
  }

  // ── Build PayFast form ─────────────────────────────────────────────────────
  const pfHost    = SANDBOX ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';
  const actionUrl = `https://${pfHost}/eng/process`;

  const typeLabel = { sponsored_product: 'Sponsored Product', featured_shop: 'Featured Shop', hero_banner: 'Hero Banner' }[type];
  const sellerName = seller.shop_name || 'Seller';
  const [firstName, ...rest] = sellerName.split(' ');
  const lastName  = rest.join(' ') || sellerName;
  const email     = seller.email || callerUser.email || '';
  const phone     = seller.whatsapp_number || '';

  const data = {
    merchant_id:     MERCHANT_ID,
    merchant_key:    MERCHANT_KEY,
    return_url:      `${SITE_BASE_URL}/seller-dashboard.html?adSuccess=1`,
    cancel_url:      `${SITE_BASE_URL}/seller-dashboard.html?adCancelled=1`,
    notify_url:      `${SITE_BASE_URL}/.netlify/functions/payfast-itn`,
    name_first:      firstName,
    name_last:       lastName,
    email_address:   email,
    cell_number:     phone,
    m_payment_id:    mPaymentId,
    amount:          amount.toFixed(2),
    item_name:       `Umzila Ad - ${typeLabel} (${weeks}wk)`,
    item_description:'',
    custom_int1:'', custom_int2:'', custom_int3:'', custom_int4:'', custom_int5:'',
    custom_str1:     'ad_campaign',
    custom_str2:     campaign.id,
    custom_str3:'', custom_str4:'', custom_str5:'',
    email_confirmation:   '1',
    confirmation_address: email
  };

  const orderedKeys = [
    'merchant_id','merchant_key','return_url','cancel_url','notify_url',
    'name_first','name_last','email_address','cell_number',
    'm_payment_id','amount','item_name','item_description',
    'custom_int1','custom_int2','custom_int3','custom_int4','custom_int5',
    'custom_str1','custom_str2','custom_str3','custom_str4','custom_str5',
    'email_confirmation','confirmation_address'
  ];

  function pfEncode(value) {
    return encodeURIComponent(String(value))
      .replace(/%20/g, '+')
      .replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
      .replace(/%[0-9a-f]{2}/gi, m => m.toUpperCase());
  }

  let pfOutput = '';
  orderedKeys.forEach(key => {
    let val = String(data[key] !== undefined && data[key] !== null ? data[key] : '').trim();
    if (val !== '') pfOutput += `${key}=${pfEncode(val)}&`;
  });
  if (pfOutput.endsWith('&')) pfOutput = pfOutput.slice(0, -1);

  let stringToSign = pfOutput;
  if (PASSPHRASE) stringToSign += `&passphrase=${pfEncode(PASSPHRASE)}`;

  const signature = crypto.createHash('md5').update(stringToSign).digest('hex');

  const allData    = { ...data, signature };
  const allKeys    = [...orderedKeys, 'signature'];
  const inputsHtml = allKeys.map(key => {
    const val = String(allData[key] !== undefined && allData[key] !== null ? allData[key] : '');
    return `<input type="hidden" name="${key}" value="${val.replace(/"/g, '&quot;')}" />`;
  }).join('\n');

  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Redirecting to PayFast…</title></head>
  <body>
    <form id="pf_form" action="${actionUrl}" method="post">
      ${inputsHtml}
      <noscript>
        <p>JavaScript is disabled — click below to continue to PayFast.</p>
        <input type="submit" value="Continue to PayFast" />
      </noscript>
    </form>
    <script>document.getElementById('pf_form').submit();</script>
  </body>
</html>`;

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'text/html' },
    body: html
  };
};
