// netlify/functions/generate-payfast-signature.js
const crypto = require('crypto');

exports.handler = async function (event, context) {
  try {
    // Handle OPTIONS preflight quickly (must run before POST-only checks)
if (event.httpMethod === 'OPTIONS') {
  return {
    statusCode: 204,
    headers: {
      'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body: ''
  };
}

// Only allow POST for the actual signing call
if (event.httpMethod !== 'POST') {
  return {
    statusCode: 405,
    headers: {
      'Allow': 'POST',
      'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body: 'Method Not Allowed'
  };
}


    // Parse input
    const body = JSON.parse(event.body || '{}');
    // expected: body.payload = { amount, item_name, m_payment_id, ... }
    // optional: body.returnForm = true -> return HTML form auto-submitting
    const payload = body.payload || {};
    const returnForm = !!body.returnForm;

    // Read secrets from environment (set these in Netlify dashboard)
    const MERCHANT_ID = (process.env.PAYFAST_MERCHANT_ID || '').toString().trim();
    const MERCHANT_KEY = (process.env.PAYFAST_MERCHANT_KEY || '').toString().trim();
    const PASSPHRASE = (process.env.PAYFAST_PASSPHRASE || '').toString().trim();
    const SANDBOX = (process.env.PAYFAST_SANDBOX || 'true').toLowerCase() !== 'false';

    if (!MERCHANT_ID || !MERCHANT_KEY) {
  return {
    statusCode: 500,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body: JSON.stringify({ error: 'PayFast merchant configuration missing on server.' })
  };
}


    const pfHost = SANDBOX ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';
    const actionUrl = `https://${pfHost}/eng/process`;

    // Build the data object we will sign and submit.
    // We merge server-side merchant fields so client cannot supply them.
    const data = {
      merchant_id: MERCHANT_ID,
      merchant_key: MERCHANT_KEY,
      // client should normally supply return_url/cancel_url/notify_url (but server can supply defaults)
      return_url: payload.return_url || payload.returnUrl || payload.return || '',
      cancel_url: payload.cancel_url || payload.cancelUrl || payload.cancel || '',
      notify_url: payload.notify_url || payload.notifyUrl || payload.notify || '',

      // Customer details (optional)
      name_first: payload.name_first || payload.nameFirst || payload.name_first || '',
      name_last: payload.name_last || payload.nameLast || payload.name_last || '',
      email_address: payload.email_address || payload.email || '', 
      cell_number: payload.cell_number || payload.cellNumber || '',

      // Transaction details (client must supply amount, item_name or m_payment_id)
      m_payment_id: payload.m_payment_id || payload.mPaymentId || payload.m_payment_id || '',
      amount: typeof payload.amount === 'number' ? payload.amount.toFixed(2) : (payload.amount || ''),
      item_name: payload.item_name || payload.itemName || payload.item_name || '',
      item_description: payload.item_description || payload.itemDescription || payload.item_description || '',

      // Custom fields (optional)
      custom_int1: payload.custom_int1 || payload.customInt1 || '',
      custom_int2: payload.custom_int2 || payload.customInt2 || '',
      custom_int3: payload.custom_int3 || payload.customInt3 || '',
      custom_int4: payload.custom_int4 || payload.customInt4 || '',
      custom_int5: payload.custom_int5 || payload.customInt5 || '',
      custom_str1: payload.custom_str1 || payload.customStr1 || '',
      custom_str2: payload.custom_str2 || payload.customStr2 || '',
      custom_str3: payload.custom_str3 || payload.customStr3 || '',
      custom_str4: payload.custom_str4 || payload.customStr4 || '',
      custom_str5: payload.custom_str5 || payload.customStr5 || '',

      // Transaction options
      email_confirmation: (payload.email_confirmation === undefined ? (payload.emailConfirmation || '1') : payload.email_confirmation),
      confirmation_address: payload.confirmation_address || payload.confirmationAddress || ''
      // add any other fields you require here (payment_method, etc.)
    };

    // PayFast requires the parameter pairs to be concatenated in a SPECIFIC order (not alphabetical).
    // Use this ordered list (extend if you include optional fields).
    const orderedKeys = [
      'merchant_id','merchant_key','return_url','cancel_url','notify_url',
      'name_first','name_last','email_address','cell_number',
      'm_payment_id','amount','item_name','item_description',
      'custom_int1','custom_int2','custom_int3','custom_int4','custom_int5',
      'custom_str1','custom_str2','custom_str3','custom_str4','custom_str5',
      'email_confirmation','confirmation_address'
      // add additional keys here in the exact order you will submit them
    ];

    // Helper for encoding: encodeURIComponent, replace %20 with +, make percent-hex uppercase
    function pfEncode(value) {
      const encoded = encodeURIComponent(String(value)).replace(/%20/g, '+');
      // Uppercase percent-encoding hex characters (PayFast requires upper case in examples)
      return encoded.replace(/%[0-9a-f]{2}/gi, match => match.toUpperCase());
    }

    // Build canonical string from non-blank variables only (like PayFast PHP example)
    let pfOutput = '';
    orderedKeys.forEach(key => {
      const val = data[key];
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        pfOutput += `${key}=${pfEncode(String(val).trim())}&`;
      }
    });

    // remove trailing &
    if (pfOutput.endsWith('&')) pfOutput = pfOutput.slice(0, -1);

    // Append passphrase only if non-empty
    let stringToSign = pfOutput;
    if (PASSPHRASE && PASSPHRASE.length > 0) {
      stringToSign += `&passphrase=${pfEncode(PASSPHRASE)}`;
    }

    // Compute MD5 in lower-case hex
    const signature = crypto.createHash('md5').update(stringToSign).digest('hex');

    // Prepare params to return to client (all original data plus signature).
    // Include only keys we will submit in the form (order will be controlled by client).
        // Build params including the signature (used internally)
    const params = { ...data, signature };

    // Prepare a copy to return to clients. merchant_key is required by PayFast forms.
const paramsToReturn = { ...params };
// IMPORTANT: do NOT include the passphrase anywhere in the response.
// We keep merchant_key because PayFast expects it in the form submission.



    // Return either JSON (params) or a ready-to-submit HTML form
        if (returnForm) {
      // Build form HTML using paramsToReturn (no merchant_key)
      const keysInOrder = [
        ...orderedKeys,
        'signature'
      ];

      const inputsHtml = keysInOrder.map(key => {
        const val = paramsToReturn[key] !== undefined && paramsToReturn[key] !== null ? paramsToReturn[key] : '';
        // Always include the input to maintain ordering/structure; escape quotes
        const safeVal = String(val).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
        return `<input type="hidden" name="${key}" value="${safeVal}" />`;
      }).join('\n');

      const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Redirecting to PayFast</title></head>
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
        headers: {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*' // restrict in production
        },
        body: html
      };
    }


    // Default: JSON response
        // Default: JSON response — return paramsToReturn (no merchant_key) and avoid returning the stringToSign in production.
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*', // set to your origin in production
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify({
        pfHost,
        actionUrl,
        signature,
        // stringToSign, // remove this line in production — uncomment only for temporary debugging
        params: paramsToReturn
      })
    };


  } catch (err) {
    console.error('generate-payfast-signature error', err);
    return {
  statusCode: 500,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  },
  body: JSON.stringify({ error: err.message || 'Server error' })
};

  }
};
