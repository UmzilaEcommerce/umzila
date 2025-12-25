// netlify/functions/initiate-payfast.js
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const {
  PAYFAST_MERCHANT_ID,
  PAYFAST_MERCHANT_KEY,
  PAYFAST_PASSPHRASE = '',
  PAYFAST_SANDBOX = 'false',
  SITE_BASE_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

const PAYFAST_URL = (PAYFAST_SANDBOX === 'true' || PAYFAST_SANDBOX === true)
  ? 'https://sandbox.payfast.co.za/eng/process'
  : 'https://www.payfast.co.za/eng/process';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// encode spaces as + for PayFast
function encodePfValue(value) {
  return encodeURIComponent(value === null || value === undefined ? '' : String(value)).replace(/%20/g, '+');
}

// Sort keys and build param string to sign
function buildStringToSign(params, passphrase = '') {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '');
  const keys = entries.map(([k]) => k).sort();
  const paramString = keys.map(k => `${k}=${encodePfValue(params[k])}`).join('&');
  return passphrase ? `${paramString}&passphrase=${encodePfValue(passphrase)}` : paramString;
}

function md5Hash(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports.handler = async function (event) {
  const headers = { 'Content-Type': 'text/html' };

  // Allow preflight (if you POST via fetch) — but we serve HTML for window navigation
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }

  try {
    const body = event.body && event.headers && event.headers['content-type'] && event.headers['content-type'].includes('application/json')
      ? JSON.parse(event.body)
      : JSON.parse(event.body || '{}');

    const { cartItems, customerEmail, customerName = '' } = body;

    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Cart empty' }) };
    }
    if (!customerEmail) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Email required' }) };
    }

    // validate and compute
    let totalNumber = 0;
    const validatedItems = [];

    for (const item of cartItems) {
      if (!item?.product_id || !item?.quantity) {
        return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid cart item format' }) };
      }

      const { data: product, error: prodErr } = await supabase
        .from('products')
        .select('id, price, sale_price, stock, name')
        .eq('id', item.product_id)
        .single();

      if (prodErr || !product) {
        return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Product ${item.product_id} not found` }) };
      }

      if (product.stock < item.quantity) {
        return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Insufficient stock for ${product.name}` }) };
      }

      const unitPrice = product.sale_price ?? product.price;
      const lineTotal = Number((unitPrice * item.quantity).toFixed(2));
      totalNumber += lineTotal;

      validatedItems.push({
        product_id: product.id,
        name: product.name,
        unit_price: Number(unitPrice),
        quantity: Number(item.quantity),
        total: lineTotal
      });
    }

    totalNumber = Number(totalNumber.toFixed(2)); // numeric stored
    const amountString = totalNumber.toFixed(2);   // string to send to PayFast

    const m_payment_id = `UMZILA-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // insert order with m_payment_id
    const { data: order, error: orderError } = await supabase.from('orders').insert([{
      m_payment_id,
      customer_name: customerName || customerEmail,
      total: totalNumber,
      items: validatedItems,
      order_status: 'pending_payment',
      created_at: new Date().toISOString()
    }]).select().single();

    if (orderError) {
      console.error('Supabase insert error:', orderError);
      return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Failed to create order' }) };
    }

    // Build PayFast params exactly as we will POST them
    const pfParams = {
      merchant_id: PAYFAST_MERCHANT_ID,
      merchant_key: PAYFAST_MERCHANT_KEY,
      return_url: `${SITE_BASE_URL}/checkout-success.html?payment_status=COMPLETE&m_payment_id=${encodePfValue(m_payment_id)}`,
      cancel_url: `${SITE_BASE_URL}/checkout-cancel.html?payment_status=CANCELLED&m_payment_id=${encodePfValue(m_payment_id)}`,
      notify_url: `${SITE_BASE_URL}/.netlify/functions/payfast-itn`,
      m_payment_id,
      amount: amountString,
      item_name: `Umzila Order #${m_payment_id}`,
      item_description: `${validatedItems.length} item(s) from Umzila`,
      email_address: customerEmail,
      email_confirmation: '1',
      confirmation_address: customerEmail
    };

    // Build string to sign and calculate signature
    const stringToSign = buildStringToSign(pfParams, PAYFAST_PASSPHRASE);
    const signature = md5Hash(stringToSign);

    // Debug logs (temporary)
    console.log('PAYFAST: stringToSign:', stringToSign);
    console.log('PAYFAST: signature:', signature);
    console.log('PAYFAST: posting to URL:', PAYFAST_URL);

    // Build HTML form that will auto-submit to PayFast (this ensures exact same params are posted)
    let inputsHtml = '';
    for (const [k, v] of Object.entries(pfParams)) {
      const val = v === null || v === undefined ? '' : String(v);
      inputsHtml += `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(val)}"/>`;
    }
    // add signature hidden input
    inputsHtml += `<input type="hidden" name="signature" value="${escapeHtml(signature)}"/>`;

    const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Redirecting to PayFast...</title></head>
  <body>
    <form id="pf" action="${escapeHtml(PAYFAST_URL)}" method="post">
      ${inputsHtml}
      <noscript><p>Redirecting to PayFast - please click the button below if not redirected.</p>
      <button type="submit">Pay</button></noscript>
    </form>
    <script>document.getElementById('pf').submit();</script>
  </body>
</html>`;

    // Return HTML — the browser will load and immediately POST to PayFast
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: html
    };

  } catch (err) {
    console.error('Payment function error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error', details: err?.message })
    };
  }
};
