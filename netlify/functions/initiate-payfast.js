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
  // Sort keys alphabetically
  const sortedKeys = Object.keys(params).sort();
  
  // Build param string
  const paramString = sortedKeys
    .map(k => `${k}=${encodePfValue(params[k])}`)
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
  console.log('=== PAYFAST INITIATE FUNCTION STARTED ===');
  console.log('Environment:', {
    PAYFAST_SANDBOX,
    SITE_BASE_URL: SITE_BASE_URL ? 'SET' : 'NOT SET',
    MERCHANT_ID_SET: !!PAYFAST_MERCHANT_ID,
    MERCHANT_KEY_SET: !!PAYFAST_MERCHANT_KEY,
    PASSPHRASE_LENGTH: PAYFAST_PASSPHRASE?.length || 0
  });

  // If in production mode but using sandbox credentials, warn
  if (PAYFAST_SANDBOX === 'false' && PAYFAST_MERCHANT_ID === '10000100') {
    console.error('WARNING: Using sandbox credentials in production mode!');
  }

  const headers = { 'Content-Type': 'text/html' };

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
    // Parse request body
    let body = {};
    try {
      if (event.body) {
        body = JSON.parse(event.body);
      }
    } catch (e) {
      console.error('Error parsing body:', e);
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

    // Check for SITE_BASE_URL
    if (!SITE_BASE_URL) {
      console.error('ERROR: SITE_BASE_URL environment variable is not set!');
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'Server configuration error',
          details: 'SITE_BASE_URL environment variable is required'
        })
      };
    }

    // Validate and compute cart total
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

    totalNumber = Number(totalNumber.toFixed(2));
    const amountString = totalNumber.toFixed(2);

    const m_payment_id = `UMZILA-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

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
      console.error('Supabase insert error:', orderError);
      return { 
        statusCode: 500, 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ error: 'Failed to create order' }) 
      };
    }

    console.log('Order created:', m_payment_id, 'Total:', amountString);

    // ===== BUILD PAYFAST PARAMETERS =====
    // According to PayFast documentation, these are required fields
    const pfParams = {
      merchant_id: PAYFAST_MERCHANT_ID,
      merchant_key: PAYFAST_MERCHANT_KEY,
      return_url: `${SITE_BASE_URL}/checkout-success.html?payment_status=COMPLETE&m_payment_id=${encodeURIComponent(m_payment_id)}`,
      cancel_url: `${SITE_BASE_URL}/checkout-cancel.html?payment_status=CANCELLED&m_payment_id=${encodeURIComponent(m_payment_id)}`,
      notify_url: `${SITE_BASE_URL}/.netlify/functions/payfast-itn`,
      m_payment_id: m_payment_id,
      amount: amountString,
      item_name: `Umzila Order #${m_payment_id}`,
      item_description: `${validatedItems.length} item(s) from Umzila`,
      email_address: customerEmail
    };

    // Optional but recommended
    if (customerName) {
      const nameParts = customerName.split(' ');
      pfParams.name_first = nameParts[0] || '';
      pfParams.name_last = nameParts.slice(1).join(' ') || '';
    }

    // For sandbox testing, you can add these
    if (PAYFAST_SANDBOX === 'true') {
      // Sandbox-specific parameters
      pfParams.email_confirmation = '1';
      pfParams.confirmation_address = customerEmail;
    }

    // ===== CALCULATE SIGNATURE =====
    const stringToSign = buildStringToSign(pfParams, PAYFAST_PASSPHRASE);
    const signature = md5Hash(stringToSign);

    // ===== DEBUG LOGS =====
    console.log('\n=== PAYFAST DEBUG INFO ===');
    console.log('PayFast URL:', PAYFAST_URL);
    console.log('Sandbox Mode:', PAYFAST_SANDBOX);
    console.log('SITE_BASE_URL:', SITE_BASE_URL);
    console.log('\nParameters to be sent:');
    Object.entries(pfParams).forEach(([key, value]) => {
      console.log(`  ${key}: ${value}`);
    });
    console.log('\nString to sign (before MD5):');
    console.log('-------------------------');
    console.log(stringToSign);
    console.log('-------------------------');
    console.log('Generated Signature:', signature);
    console.log('Passphrase used:', PAYFAST_PASSPHRASE ? `"${PAYFAST_PASSPHRASE}" (${PAYFAST_PASSPHRASE.length} chars)` : 'None');
    console.log('=========================\n');

    // ===== VERIFY CREDENTIALS =====
    // Check if using sandbox credentials in production
    if (PAYFAST_SANDBOX === 'false' && PAYFAST_MERCHANT_ID === '10000100') {
      const errorHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Configuration Error</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 40px; text-align: center; }
    .error { background: #f8d7da; color: #721c24; padding: 20px; border-radius: 5px; margin: 20px auto; max-width: 600px; }
    .warning { background: #fff3cd; color: #856404; padding: 15px; border-radius: 5px; margin: 20px auto; max-width: 600px; }
  </style>
</head>
<body>
  <h1>Configuration Error</h1>
  <div class="error">
    <h2>⚠️ You are using Sandbox credentials in Production mode!</h2>
    <p>Your PAYFAST_SANDBOX is set to 'false' (production) but you're using sandbox credentials.</p>
    <p><strong>Fix:</strong> Set PAYFAST_SANDBOX to 'true' in your Netlify environment variables.</p>
  </div>
  <div class="warning">
    <h3>Environment Variables Checklist:</h3>
    <ul style="text-align: left; display: inline-block;">
      <li>PAYFAST_SANDBOX=true (for testing)</li>
      <li>PAYFAST_MERCHANT_ID=10000100 (sandbox ID)</li>
      <li>PAYFAST_MERCHANT_KEY=46f0cd694581a (sandbox key)</li>
      <li>PAYFAST_PASSPHRASE= (leave empty for sandbox)</li>
      <li>SITE_BASE_URL=https://your-site.netlify.app</li>
    </ul>
  </div>
</body>
</html>`;
      
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'text/html' },
        body: errorHtml
      };
    }

    // ===== BUILD HTML FORM =====
    let inputsHtml = '';
    for (const [key, value] of Object.entries(pfParams)) {
      const val = value === null || value === undefined ? '' : String(value);
      inputsHtml += `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(val)}" />\n`;
    }
    // Add signature separately
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
    .test-card {
      background: #d4edda;
      border: 1px solid #c3e6cb;
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
      <p>You are being securely redirected to PayFast to complete your payment.</p>
      <p style="color: #666; font-size: 14px;">Please do not close this window.</p>
      
      ${PAYFAST_SANDBOX === 'true' ? `
      <div class="test-card">
        <strong>🔄 SANDBOX TEST MODE</strong><br>
        <strong>Test Card:</strong> 4242 4242 4242 4242<br>
        <strong>Expiry:</strong> Any future date<br>
        <strong>CVV:</strong> Any 3 digits<br>
        <strong>Amount:</strong> R${amountString}
      </div>
      ` : ''}
      
      <p style="font-size: 12px; color: #999; margin-top: 20px;">
        If you are not redirected in 5 seconds, please enable JavaScript or check your browser settings.
      </p>
    </div>
    
    <form id="pfForm" action="${escapeHtml(PAYFAST_URL)}" method="post" style="display: none;">
      ${inputsHtml}
      <noscript>
        <div style="margin-top: 20px; padding: 20px; background: #fff3cd; border-radius: 5px;">
          <p style="color: #856404; margin: 0;">
            <strong>JavaScript is disabled.</strong><br>
            Please click the button below to proceed to PayFast.
          </p>
          <button type="submit" style="margin-top: 15px; padding: 10px 20px; background: #28a745; color: white; border: none; border-radius: 5px; cursor: pointer;">
            Proceed to PayFast
          </button>
        </div>
      </noscript>
    </form>
  </div>
  
  <script>
    console.log('Submitting to PayFast...');
    console.log('Order ID: ${m_payment_id}');
    console.log('Amount: R${amountString}');
    console.log('Mode: ${PAYFAST_SANDBOX === 'true' ? 'SANDBOX' : 'PRODUCTION'}');
    
    // Auto-submit after 1.5 seconds
    setTimeout(function() {
      console.log('Auto-submitting form to: ${PAYFAST_URL}');
      document.getElementById('pfForm').submit();
    }, 1500);
    
    // Manual submit button fallback
    window.addEventListener('load', function() {
      setTimeout(function() {
        var form = document.getElementById('pfForm');
        if (form && form.parentNode) {
          var noscript = form.querySelector('noscript');
          if (noscript) noscript.style.display = 'block';
        }
      }, 5000);
    });
  </script>
</body>
</html>`;

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
        message: err?.message
      })
    };
  }
};