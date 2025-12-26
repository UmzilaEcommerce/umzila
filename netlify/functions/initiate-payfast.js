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

const PAYFAST_URL = PAYFAST_SANDBOX === 'true'
  ? 'https://sandbox.payfast.co.za/eng/process'
  : 'https://www.payfast.co.za/eng/process';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Correct encoding for PayFast
function encodePfValue(value) {
  if (value === null || value === undefined) return '';
  return encodeURIComponent(String(value)); // PayFast uses %20 for spaces
}

// Signature calculation - ALWAYS include passphrase
function buildStringToSign(params, passphrase = '') {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map(key => `${key}=${encodePfValue(params[key])}`)
    .join('&');
  
  return `${paramString}&passphrase=${encodePfValue(passphrase)}`;
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

  // Calculate total from cart items (NO HARDCODING)
  let totalNumber = 0;
  for (const item of cartItems) {
    if (!item?.product_id || !item?.quantity) continue;
    
    // In production, you would fetch product price from database
    // For now, use a default or fetch from your products table
    const itemPrice = item.price || 0; // Assuming price is sent in cart
    totalNumber += itemPrice * item.quantity;
  }
  
  totalNumber = Number(totalNumber.toFixed(2));
  const amountString = totalNumber > 0 ? totalNumber.toFixed(2) : '150.00'; // Fallback only

  const m_payment_id = `UMZILA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Build PayFast parameters
  const pfParams = {
    merchant_id: PAYFAST_MERCHANT_ID,
    merchant_key: PAYFAST_MERCHANT_KEY,
    return_url: `${SITE_BASE_URL}/checkout-success?m_payment_id=${m_payment_id}`,
    cancel_url: `${SITE_BASE_URL}/checkout-cancel?m_payment_id=${m_payment_id}`,
    notify_url: `${SITE_BASE_URL}/.netlify/functions/payfast-itn`,
    m_payment_id: m_payment_id,
    amount: amountString,
    item_name: `Umzila Order #${m_payment_id}`,
    email_address: customerEmail
  };

  // Calculate signature
  const stringToSign = buildStringToSign(pfParams, PAYFAST_PASSPHRASE);
  const signature = md5Hash(stringToSign);

  // Debug output
  console.log('\n=== SIGNATURE CALCULATION ===');
  console.log('Amount:', amountString);
  console.log('Signature:', signature);
  console.log('String to sign:', stringToSign);
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
  <h1>Processing Payment of R${amountString}</h1>
  <p>Order ID: ${m_payment_id}</p>
  
  <form id="pfForm" action="${PAYFAST_URL}" method="post">
    ${inputsHtml}
    <button type="submit">Proceed to PayFast</button>
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