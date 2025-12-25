// netlify/functions/initiate-payfast.js
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const querystring = require('querystring');

const {
  PAYFAST_MERCHANT_ID,
  PAYFAST_MERCHANT_KEY,
  PAYFAST_PASSPHRASE = '',
  PAYFAST_SANDBOX = 'true', // Forced to true for testing
  SITE_BASE_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

const PAYFAST_URL = (PAYFAST_SANDBOX === 'true' || PAYFAST_SANDBOX === true)
  ? 'https://sandbox.payfast.co.za/eng/process'
  : 'https://www.payfast.co.za/eng/process';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// PayFast-specific encoding (spaces as +, NOT %20)
function encodePfValue(value) {
  if (value === null || value === undefined || value === '') return '';
  // Use querystring.escape for proper URL encoding, then replace %20 with +
  return querystring.escape(String(value)).replace(/%20/g, '+');
}

// Build string for MD5 signature - PayFast format
function buildStringToSign(params, passphrase = '') {
  // Sort parameters alphabetically
  const sortedKeys = Object.keys(params).sort();
  
  // Build key=value pairs with proper encoding
  const paramString = sortedKeys
    .map(key => `${key}=${encodePfValue(params[key])}`)
    .join('&');
  
  // Add passphrase if provided
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
  console.log('=== PAYFAST INITIATE (SANDBOX MODE) ===');
  
  // Force sandbox mode for testing - remove in production
  if (PAYFAST_SANDBOX !== 'true') {
    console.warn('WARNING: Forcing sandbox mode for testing');
  }

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

    // Validate cart and compute total
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

    // Create unique payment ID
    const m_payment_id = `UMZILA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Insert order
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

    console.log(`Order created: ${m_payment_id}, Amount: R${amountString}`);

    // ===== BUILD PAYFAST PARAMETERS =====
    // Minimal required parameters for sandbox testing
    const pfParams = {
      merchant_id: PAYFAST_MERCHANT_ID,
      merchant_key: PAYFAST_MERCHANT_KEY,
      return_url: `${SITE_BASE_URL}/checkout-success?m_payment_id=${m_payment_id}`,
      cancel_url: `${SITE_BASE_URL}/checkout-cancel?m_payment_id=${m_payment_id}`,
      notify_url: `${SITE_BASE_URL}/.netlify/functions/payfast-itn`,
      m_payment_id: m_payment_id,
      amount: amountString,
      item_name: `Umzila Order #${m_payment_id}`,
      item_description: `Purchase from Umzila Store`,
      email_address: customerEmail
    };

    // Calculate signature
    const stringToSign = buildStringToSign(pfParams, PAYFAST_PASSPHRASE);
    const signature = md5Hash(stringToSign);

    // Debug logs (safe for sandbox)
    console.log('\n=== PAYFAST DEBUG ===');
    console.log('Endpoint:', PAYFAST_URL);
    console.log('Order ID:', m_payment_id);
    console.log('Amount:', amountString);
    console.log('Email:', customerEmail);
    console.log('Signature (first 8 chars):', signature.substring(0, 8) + '...');
    console.log('String to sign (sample):', stringToSign.substring(0, 100) + '...');
    console.log('=====================\n');

    // Build HTML form
    let inputsHtml = '';
    for (const [key, value] of Object.entries(pfParams)) {
      const val = value === null || value === undefined ? '' : String(value);
      inputsHtml += `<input type="hidden" name="${key}" value="${escapeHtml(val)}" />\n`;
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
  </style>
</head>
<body>
  <div class="container">
    <div class="loading">
      <div class="spinner"></div>
      <h2>Processing Payment of R${amountString}</h2>
      <p>Redirecting to PayFast Sandbox...</p>
      <p style="color: #666; font-size: 14px;">Please wait while we securely transfer you.</p>
      
      <div style="background: #fff3cd; padding: 15px; border-radius: 5px; text-align: left; margin-top: 20px;">
        <strong>🔄 SANDBOX TEST MODE</strong><br>
        <strong>Test Card:</strong> 4242 4242 4242 4242<br>
        <strong>Expiry:</strong> Any future date<br>
        <strong>CVV:</strong> Any 3 digits<br>
        <strong>Amount:</strong> R${amountString}
      </div>
      
      <p style="font-size: 12px; color: #999; margin-top: 20px;">
        Order ID: ${m_payment_id}
      </p>
    </div>
    
    <form id="pfForm" action="${PAYFAST_URL}" method="post" style="display: none;">
      ${inputsHtml}
      <noscript>
        <div style="margin-top: 20px; padding: 20px; background: #fff3cd; border-radius: 5px;">
          <p style="color: #856404; margin: 0;">
            <strong>JavaScript is required for automatic redirection.</strong><br>
            Please click the button below.
          </p>
          <button type="submit" style="margin-top: 15px; padding: 10px 20px; background: #28a745; color: white; border: none; border-radius: 5px; cursor: pointer;">
            Proceed to PayFast
          </button>
        </div>
      </noscript>
    </form>
  </div>
  
  <script>
    console.log('Submitting to PayFast Sandbox...');
    
    // Auto-submit after 1 second
    setTimeout(function() {
      document.getElementById('pfForm').submit();
    }, 1000);
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
    console.error('Error stack:', err.stack);
    
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Internal server error during payment setup',
        message: err.message
      })
    };
  }
};