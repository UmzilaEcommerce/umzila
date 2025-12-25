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
  if (value === null || value === undefined) return '';
  return encodeURIComponent(String(value)).replace(/%20/g, '+');
}

// Sort keys and build param string to sign
function buildStringToSign(params, passphrase = '') {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map(k => `${k}=${encodePfValue(params[k])}`)
    .join('&');
  
  let stringToSign = paramString;
  if (passphrase && passphrase.trim() !== '') {
    stringToSign += `&passphrase=${encodePfValue(passphrase)}`;
  }
  
  return stringToSign;
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
  console.log('=== PAYFAST INITIATE FUNCTION STARTED ===');
  console.log('Environment Check - Sandbox Mode:', PAYFAST_SANDBOX);

  // Allow preflight
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
    let body = {};
    try {
      if (event.body) {
        body = JSON.parse(event.body);
      }
    } catch (e) {
      console.error('Error parsing body:', e.message);
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid JSON in request body' })
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

    // Validate critical environment variables (without logging values)
    if (!SITE_BASE_URL) {
      console.error('ERROR: SITE_BASE_URL environment variable is not set!');
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'Server configuration error: SITE_BASE_URL required'
        })
      };
    }
    if (!PAYFAST_MERCHANT_ID || !PAYFAST_MERCHANT_KEY) {
      console.error('ERROR: PayFast credentials (MERCHANT_ID or MERCHANT_KEY) are not set!');
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'Server configuration error: Payment credentials missing'
        })
      };
    }

    // validate and compute cart total
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
        console.error(`Product not found: ${item.product_id}`, prodErr);
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
    const amountString = totalNumber.toFixed(2);

    const m_payment_id = `UMZILA-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // insert order with m_payment_id
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

    console.log(`Order created: ${m_payment_id}, Amount: R${amountString}, Items: ${validatedItems.length}`);

    // Build PayFast params
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

    // Optional personal details (keep empty if not provided)
    if (customerName) {
      const nameParts = customerName.split(' ');
      pfParams.name_first = nameParts[0] || '';
      pfParams.name_last = nameParts.slice(1).join(' ') || '';
    }

    // Calculate signature
    const stringToSign = buildStringToSign(pfParams, PAYFAST_PASSPHRASE);
    const signature = md5Hash(stringToSign);

    // === SECURE DEBUG LOGS ===
    // Log useful info without exposing secrets
    console.log('\n=== PAYFAST REQUEST SUMMARY ===');
    console.log('Endpoint:', PAYFAST_URL);
    console.log('Order ID:', m_payment_id);
    console.log('Amount: R' + amountString);
    console.log('Customer Email:', customerEmail);
    console.log('Parameter Count:', Object.keys(pfParams).length);
    console.log('Signature Generated:', signature ? 'Yes' : 'No');
    console.log('Passphrase Provided:', PAYFAST_PASSPHRASE ? 'Yes' : 'No');
    
    // Sanitized parameter log - shows keys but hides credential values
    const sanitizedParams = { ...pfParams };
    sanitizedParams.merchant_id = '[REDACTED]';
    sanitizedParams.merchant_key = '[REDACTED]';
    console.log('Sanitized Parameters:', JSON.stringify(sanitizedParams, null, 2));
    console.log('String to Sign (Sanitized):', buildStringToSign(sanitizedParams, PAYFAST_PASSPHRASE ? '[REDACTED]' : ''));
    console.log('================================\n');

    // Build HTML form
    let inputsHtml = '';
    for (const [key, value] of Object.entries(pfParams)) {
      const val = value === null || value === undefined ? '' : String(value);
      inputsHtml += `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(val)}" />\n`;
    }
    inputsHtml += `<input type="hidden" name="signature" value="${escapeHtml(signature)}" />`;

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
      text-align: center;
    }
    .container { 
      background: white; 
      padding: 40px; 
      border-radius: 10px; 
      box-shadow: 0 4px 12px rgba(0,0,0,0.1); 
      max-width: 500px; 
      width: 100%;
    }
    .loading { 
      display: flex; 
      flex-direction: column; 
      align-items: center; 
      gap: 20px; 
    }
    .spinner { 
      width: 50px; 
      height: 50px; 
      border: 5px solid #f3f3f3; 
      border-top: 5px solid #3498db; 
      border-radius: 50%; 
      animation: spin 1s linear infinite; 
    }
    @keyframes spin { 
      0% { transform: rotate(0deg); } 
      100% { transform: rotate(360deg); } 
    }
    .sandbox-info {
      background: #fff3cd;
      border: 1px solid #ffeaa7;
      border-radius: 5px;
      padding: 15px;
      margin-top: 20px;
      text-align: left;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="loading">
      <div class="spinner"></div>
      <h2>Processing Payment...</h2>
      <p>You are being securely redirected to PayFast to complete your payment of <strong>R${amountString}</strong>.</p>
      <p style="color: #666; font-size: 14px;">Please do not close this window.</p>
      
      ${PAYFAST_SANDBOX === 'true' ? `
      <div class="sandbox-info">
        <strong>🛠️ SANDBOX TEST MODE</strong><br>
        <strong>Test Card Number:</strong> 4242 4242 4242 4242<br>
        <strong>Expiry Date:</strong> Any future date (e.g., 12/30)<br>
        <strong>CVV:</strong> Any 3 digits (e.g., 123)<br>
        <strong>Amount:</strong> R${amountString}
      </div>
      ` : ''}
      
      <p style="font-size: 12px; color: #999; margin-top: 20px;">
        If redirection fails, please check that JavaScript is enabled in your browser.
      </p>
    </div>
    
    <form id="pfForm" action="${escapeHtml(PAYFAST_URL)}" method="post" style="display: none;">
      ${inputsHtml}
      <noscript>
        <div style="margin-top: 20px; padding: 20px; background: #fff3cd; border-radius: 5px;">
          <p style="color: #856404; margin: 0;">
            <strong>JavaScript is required for automatic redirection.</strong><br>
            Please click the button below to proceed to PayFast.
          </p>
          <button type="submit" style="margin-top: 15px; padding: 10px 20px; background: #28a745; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 16px;">
            Proceed to PayFast Payment
          </button>
        </div>
      </noscript>
    </form>
  </div>
  
  <script>
    console.log('Umzila Payment: Submitting order ${m_payment_id} to PayFast');
    
    // Auto-submit after a short delay
    setTimeout(function() {
      console.log('Auto-submitting payment form...');
      document.getElementById('pfForm').submit();
    }, 1500);
    
    // Fallback: if still on page after 8 seconds, show the noscript content
    setTimeout(function() {
      var form = document.getElementById('pfForm');
      if (form && document.body.contains(form)) {
        var noscriptDiv = form.querySelector('noscript');
        if (noscriptDiv) {
          noscriptDiv.style.display = 'block';
          console.warn('Form submission delayed. Showing manual submit option.');
        }
      }
    }, 8000);
  </script>
</body>
</html>`;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: html
    };

  } catch (err) {
    console.error('Payment initiation error:', err.message);
    // Don't expose stack traces in production unless in development/sandbox
    const errorDetails = PAYFAST_SANDBOX === 'true' ? err.stack : undefined;
    
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Internal server error during payment setup',
        message: err.message,
        details: errorDetails
      })
    };
  }
};