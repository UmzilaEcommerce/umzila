// netlify/functions/initiate-seller-enrollment.js
// Creates a pending order row for seller enrollment, then generates and returns
// an auto-submitting PayFast form. This mirrors how initiate-payfast.js works
// for regular orders — the order row must exist BEFORE PayFast so that
// payfast-itn.js can update it to 'paid' when the payment completes.
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const SUPABASE_URL        = process.env.SUPABASE_URL || '';
  const SERVICE_KEY         = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const MERCHANT_ID         = (process.env.PAYFAST_MERCHANT_ID || '').toString().trim();
  const MERCHANT_KEY        = (process.env.PAYFAST_MERCHANT_KEY || '').toString().trim();
  const PASSPHRASE          = (process.env.PAYFAST_PASSPHRASE || '').toString().trim();
  const SANDBOX             = (process.env.PAYFAST_SANDBOX || 'true').toLowerCase() !== 'false';
  const SITE_BASE_URL       = (process.env.SITE_BASE_URL || '').replace(/\/$/, '');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  if (!MERCHANT_ID || !MERCHANT_KEY) {
    return { statusCode: 500, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'PayFast merchant configuration missing' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { email, name, applicationId } = body;
  if (!email || !name || !applicationId) {
    return { statusCode: 400, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'email, name, and applicationId are required' }) };
  }

  // Split name into first/last for PayFast fields
  const nameParts  = name.trim().split(/\s+/);
  const nameFirst  = nameParts[0] || name;
  const nameLast   = nameParts.slice(1).join(' ') || '';

  // Generate unique payment ID
  const mPaymentId = `SELLER-${applicationId}-${Date.now()}`;

  // Pre-create the order row so payfast-itn.js can update it on payment confirmation
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { error: orderErr } = await admin.from('orders').insert({
    m_payment_id:    mPaymentId,
    customer_email:  email,
    customer_name:   name.trim(),
    total:           100,
    order_status:    'pending_payment',
    payment_status:  'pending',
    items:           [{ item_name: 'Umzila Seller Enrollment Fee', quantity: 1, unit_price: 100, total: 100 }]
  });

  if (orderErr) {
    console.error('initiate-seller-enrollment: insert order error', orderErr);
    return { statusCode: 500, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Failed to create enrollment order: ' + orderErr.message }) };
  }

  // Build PayFast data object — same field order as generate-payfast-signature.js
  const pfHost    = SANDBOX ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';
  const actionUrl = `https://${pfHost}/eng/process`;

  const data = {
    merchant_id:          MERCHANT_ID,
    merchant_key:         MERCHANT_KEY,
    return_url:           `${SITE_BASE_URL}/checkout-success.html`,
    cancel_url:           `${SITE_BASE_URL}/checkout-cancel.html`,
    notify_url:           `${SITE_BASE_URL}/.netlify/functions/payfast-itn`,
    name_first:           nameFirst,
    name_last:            nameLast,
    email_address:        email,
    cell_number:          '',
    m_payment_id:         mPaymentId,
    amount:               (100).toFixed(2),
    item_name:            'Umzila Seller Enrollment',
    item_description:     '',
    custom_int1: '', custom_int2: '', custom_int3: '', custom_int4: '', custom_int5: '',
    custom_str1:          'seller_enrollment',
    custom_str2:          applicationId,
    custom_str3:          '', custom_str4: '', custom_str5: '',
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
    const encoded = encodeURIComponent(String(value)).replace(/%20/g, '+');
    return encoded.replace(/%[0-9a-f]{2}/gi, m => m.toUpperCase());
  }

  let pfOutput = '';
  orderedKeys.forEach(key => {
    const val = data[key];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      pfOutput += `${key}=${pfEncode(String(val).trim())}&`;
    }
  });
  if (pfOutput.endsWith('&')) pfOutput = pfOutput.slice(0, -1);

  let stringToSign = pfOutput;
  if (PASSPHRASE) stringToSign += `&passphrase=${pfEncode(PASSPHRASE)}`;

  const signature = crypto.createHash('md5').update(stringToSign).digest('hex');

  // Build auto-submitting HTML form
  const allKeys    = [...orderedKeys, 'signature'];
  const allData    = { ...data, signature };
  const inputsHtml = allKeys.map(key => {
    const val     = allData[key] !== undefined && allData[key] !== null ? allData[key] : '';
    const safeVal = String(val).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    return `<input type="hidden" name="${key}" value="${safeVal}" />`;
  }).join('\n');

  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Redirecting to PayFast…</title></head>
  <body>
    <form id="pf_form" action="${actionUrl}" method="post">
      ${inputsHtml}
      <noscript>
        <p>JavaScript is disabled — click the button below to continue to PayFast.</p>
        <input type="submit" value="Continue to PayFast" />
      </noscript>
    </form>
    <script>document.getElementById('pf_form').submit();</script>
  </body>
</html>`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    body: html
  };
};
