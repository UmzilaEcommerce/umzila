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

// Sort keys and build param string to sign - FIXED: DO NOT FILTER OUT EMPTY VALUES
function buildStringToSign(params, passphrase = '') {
  // PayFast requires ALL parameters in the signature, even empty ones
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map(k => `${k}=${encodePfValue(params[k])}`)
    .join('&');
  
  if (passphrase && passphrase.trim() !== '') {
    return `${paramString}&passphrase=${encodePfValue(passphrase)}`;
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
  const headers = { 'Content-Type': 'text/html' };

  // Allow preflight (if you POST via fetch) — but we serve HTML for window navigation
  if (event.httpMethod === 'OPTIONS') {
    return { 
      statusCode: 200, 
      headers: { 
        'Access-Control-Allow-Origin': '*', 
        'Access-Control-Allow-Headers': 'Content-Type' 
      }, 
      body: '' 
    };
  }

  try {
    const body = event.body && event.headers && event.headers['content-type'] && event.headers['content-type'].includes('application/json')
      ? JSON.parse(event.body)
      : JSON.parse(event.body || '{}');

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

    // Check for SITE_BASE_URL - critical for PayFast URLs
    if (!SITE_BASE_URL) {
      console.error('ERROR: SITE_BASE_URL environment variable is not set!');
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Server configuration error: SITE_BASE_URL not set' })
      };
    }

    // validate and compute
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
      return { 
        statusCode: 500, 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ error: 'Failed to create order' }) 
      };
    }

    // Build PayFast params exactly as we will POST them
    // Note: PayFast requires ALL parameters in the signature, even empty ones
    const pfParams = {
      merchant_id: PAYFAST_MERCHANT_ID,
      merchant_key: PAYFAST_MERCHANT_KEY,
      return_url: `${SITE_BASE_URL}/checkout-success.html?payment_status=COMPLETE&m_payment_id=${encodeURIComponent(m_payment_id)}`,
      cancel_url: `${SITE_BASE_URL}/checkout-cancel.html?payment_status=CANCELLED&m_payment_id=${encodeURIComponent(m_payment_id)}`,
      notify_url: `${SITE_BASE_URL}/.netlify/functions/payfast-itn`,
      m_payment_id,
      amount: amountString,
      item_name: `Umzila Order #${m_payment_id}`,
      item_description: `${validatedItems.length} item(s) from Umzila`,
      email_address: customerEmail,
      email_confirmation: '1',
      confirmation_address: customerEmail
    };

    // Add optional fields (empty but required for signature consistency)
    pfParams.name_first = customerName.split(' ')[0] || '';
    pfParams.name_last = customerName.split(' ').slice(1).join(' ') || '';
    pfParams.cell_number = ''; // Optional
    pfParams.signature = ''; // Will be calculated and added separately

    // Build string to sign and calculate signature
    const stringToSign = buildStringToSign(pfParams, PAYFAST_PASSPHRASE);
    const signature = md5Hash(stringToSign);

    // Debug logs (temporary - remove in production)
    console.log('PAYFAST: All params:', JSON.stringify(pfParams, null, 2));
    console.log('PAYFAST: stringToSign:', stringToSign);
    console.log('PAYFAST: signature:', signature);
    console.log('PAYFAST: passphrase used:', PAYFAST_PASSPHRASE ? 'YES (length: ' + PAYFAST_PASSPHRASE.length + ')' : 'NO');
    console.log('PAYFAST: posting to URL:', PAYFAST_URL);
    console.log('PAYFAST: SITE_BASE_URL:', SITE_BASE_URL);

    // Build HTML form that will auto-submit to PayFast (this ensures exact same params are posted)
    let inputsHtml = '';
    for (const [k, v] of Object.entries(pfParams)) {
      // Skip signature field - we'll add it separately
      if (k === 'signature') continue;
      
      const val = v === null || v === undefined ? '' : String(v);
      inputsHtml += `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(val)}"/>`;
    }
    // add signature hidden input
    inputsHtml += `<input type="hidden" name="signature" value="${escapeHtml(signature)}"/>`;

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Redirecting to PayFast...</title>
    <style>
      body { 
        font-family: Arial, sans-serif; 
        background: #f7f7f9; 
        display: flex; 
        justify-content: center; 
        align-items: center; 
        min-height: 100vh; 
        margin: 0; 
        padding: 20px; 
      }
      .container { 
        background: white; 
        padding: 30px; 
        border-radius: 10px; 
        box-shadow: 0 4px 12px rgba(0,0,0,0.1); 
        max-width: 500px; 
        text-align: center; 
      }
      .loading { 
        display: flex; 
        flex-direction: column; 
        align-items: center; 
        gap: 15px; 
      }
      .spinner { 
        width: 40px; 
        height: 40px; 
        border: 4px solid #f3f3f3; 
        border-top: 4px solid #3498db; 
        border-radius: 50%; 
        animation: spin 1s linear infinite; 
      }
      @keyframes spin { 
        0% { transform: rotate(0deg); } 
        100% { transform: rotate(360deg); } 
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="loading">
        <div class="spinner"></div>
        <h2>Redirecting to PayFast...</h2>
        <p>Please wait while we securely transfer you to PayFast for payment.</p>
        <p style="color: #666; font-size: 14px;">If you are not redirected automatically, click the button below.</p>
      </div>
      <form id="pf" action="${escapeHtml(PAYFAST_URL)}" method="post" style="display: none;">
        ${inputsHtml}
        <noscript>
          <div style="margin-top: 20px;">
            <p style="color: #e74c3c;">JavaScript is required for automatic redirection.</p>
            <button type="submit" style="padding: 10px 20px; background: #3498db; color: white; border: none; border-radius: 5px; cursor: pointer;">
              Proceed to PayFast
            </button>
          </div>
        </noscript>
      </form>
    </div>
    <script>
      // Auto-submit after a brief delay to show the loading message
      setTimeout(function() {
        document.getElementById('pf').submit();
      }, 1500);
      
      // Fallback: if form hasn't submitted after 5 seconds, show the button
      setTimeout(function() {
        var form = document.getElementById('pf');
        var noscript = form.querySelector('noscript');
        if (form.parentNode.contains(form)) {
          noscript.style.display = 'block';
        }
      }, 5000);
    </script>
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
      body: JSON.stringify({ 
        error: 'Internal server error', 
        details: err?.message,
        stack: process.env.NODE_ENV === 'development' ? err?.stack : undefined 
      })
    };
  }
};