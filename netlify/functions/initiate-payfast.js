// netlify/functions/initiate-payfast.js
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const {
  PAYFAST_MERCHANT_ID,
  PAYFAST_MERCHANT_KEY,
  PAYFAST_PASSPHRASE = '',
  PAYFAST_SANDBOX = 'true',
  SITE_BASE_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

// FIX 1: Trim environment variables
const PAYFAST_MERCHANT_ID_TRIMMED = (PAYFAST_MERCHANT_ID || '').trim();
const PAYFAST_MERCHANT_KEY_TRIMMED = (PAYFAST_MERCHANT_KEY || '').trim();
const PAYFAST_PASSPHRASE_TRIMMED = (PAYFAST_PASSPHRASE || '').trim();
const PAYFAST_SANDBOX_TRIMMED = (PAYFAST_SANDBOX || 'true').trim();
const SITE_BASE_URL_TRIMMED = (SITE_BASE_URL || '').trim();
const SUPABASE_URL_TRIMMED = (SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY_TRIMMED = (SUPABASE_SERVICE_ROLE_KEY || '').trim();

const PAYFAST_URL = PAYFAST_SANDBOX_TRIMMED === 'true'
  ? 'https://sandbox.payfast.co.za/eng/process'
  : 'https://www.payfast.co.za/eng/process';

const supabase = createClient(SUPABASE_URL_TRIMMED, SUPABASE_SERVICE_ROLE_KEY_TRIMMED);

// FIX 2: Exact replacement for building the canonical param string used for signing
// Build string to sign using the PARAMETER INSERTION ORDER (matches form input order)
function buildStringToSign(params, passphrase = '') {
  // 1) take params in insertion order and filter out undefined/null/empty-string
  const entries = Object.entries(params).filter(([k, v]) => v !== undefined && v !== null && String(v) !== '');

  // 2) create URLSearchParams using insertion order (matches form post order)
  const usp = new URLSearchParams();
  for (const [k, v] of entries) {
    usp.append(k, String(v));
  }
  let paramString = usp.toString();

  // 3) append passphrase only if present
  if (passphrase && String(passphrase).length > 0) {
    paramString += `&passphrase=${encodeURIComponent(String(passphrase)).replace(/%20/g, '+')}`;
  }

  return paramString;
}


function md5Hash(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
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
  console.log('=== PAYFAST INITIATE ===');

  // Parse request
  let body = {};
  try {
    if (event.body) {
      body = JSON.parse(event.body);
    }
  } catch (e) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  const { cartItems, customerEmail, customerName = '' } = body;

  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return { 
      statusCode: 400, 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ error: 'Cart empty' }) 
    };
  }
  if (!customerEmail) {
    return { 
      statusCode: 400, 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ error: 'Email required' }) 
    };
  }

  // FIX 2C: Server-side price validation
  let totalNumber = 0;
  const validatedItems = [];

  for (const item of cartItems) {
    if (!item?.product_id || !item?.quantity) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid cart item format' })
      };
    }

    // fetch price from DB
    const { data: product, error: prodErr } = await supabase
      .from('products')
      .select('id, price, sale_price, stock, name')
      .eq('id', item.product_id)
      .single();

    if (prodErr || !product) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Product ${item.product_id} not found` })
      };
    }

    if (product.stock < item.quantity) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Insufficient stock for ${product.name}` })
      };
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

  totalNumber = Number(totalNumber.toFixed(2));
  if (totalNumber <= 0) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid order total' })
    };
  }
  const amountString = totalNumber.toFixed(2);

  const m_payment_id = `UMZILA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Insert order with validated items and correct total
  const { data: order, error: orderError } = await supabase.from('orders').insert([{
    m_payment_id,
    customer_name: customerName || customerEmail,
    customer_email: customerEmail,
    total: totalNumber,
    items: validatedItems,
    order_status: 'pending_payment',
    created_at: new Date().toISOString()
  }]).select().single();

  if (orderError) {
    console.error('Supabase insert error:', orderError.message);
    return { 
      statusCode: 500, 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ error: 'Failed to create order' }) 
    };
  }

  // Build PayFast parameters (use raw strings, not pre-encoded) 
  const pfParams = {
    merchant_id: PAYFAST_MERCHANT_ID_TRIMMED,
    merchant_key: PAYFAST_MERCHANT_KEY_TRIMMED,
    // FIX 5: URL-encode m_payment_id in return/cancel URLs
	return_url: `${SITE_BASE_URL_TRIMMED}/checkout-success?m_payment_id=${m_payment_id}`,
	cancel_url: `${SITE_BASE_URL_TRIMMED}/checkout-cancel?m_payment_id=${m_payment_id}`,
    notify_url: `${SITE_BASE_URL_TRIMMED}/.netlify/functions/payfast-itn`,
    m_payment_id: m_payment_id,
    amount: amountString,
    item_name: `Umzila Order #${m_payment_id}`,
    item_description: `Purchase from Umzila Store`,
    email_address: customerEmail
  };

  // Calculate signature with the new URLSearchParams approach
  const stringToSign = buildStringToSign(pfParams, PAYFAST_PASSPHRASE_TRIMMED);
  const signature = md5Hash(stringToSign);

  // FIX 7: Temporary debug logging
  console.log('\n=== SIGNATURE CALCULATION ===');
  console.log('StringToSign:', stringToSign);
  console.log('Signature:', signature);
  console.log('Passphrase used:', PAYFAST_PASSPHRASE_TRIMMED ? 'YES' : 'NO');
  console.log('=============================\n');

  // Build HTML form
  let inputsHtml = '';
  for (const [key, value] of Object.entries(pfParams)) {
    inputsHtml += `<input type="hidden" name="${key}" value="${escapeHtml(value)}" />\n`;
  }
  inputsHtml += `<input type="hidden" name="signature" value="${escapeHtml(signature)}" />`;

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>PayFast Payment</title>
</head>
<body>
  <form id="pfForm" action="${PAYFAST_URL}" method="post">
    ${inputsHtml}
  </form>
  <script>
    document.getElementById('pfForm').submit();
  </script>
</body>
</html>`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: html
  };
};