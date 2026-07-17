// netlify/functions/charge-payfast-token.js
//
// One-click "pay with saved card" — charges a buyer's previously-tokenized
// PayFast payment method via PayFast's ad-hoc/subscriptions API, rather than
// redirecting through the PayFast payment page. This is a NEW, standalone
// code path — it does not touch generate-payfast-signature.js or the
// existing form-based checkout flow, which remain byte-for-byte unchanged.
//
// IMPORTANT — verify before going live: the exact header/signature scheme
// PayFast's adhoc-charge API expects, and the response shape, could not be
// confirmed against PayFast's live docs in the environment this was written
// in. Test this end-to-end against PAYFAST_SANDBOX=true with a real
// tokenized order before ever calling it with PAYFAST_SANDBOX=false.
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

exports.handler = async function (event, context) {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // ── Require the buyer's own authenticated session — never trust a
    // client-supplied user_id (CLAUDE.md authorization rule).
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const userToken  = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!userToken) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Authentication required' }) };
    }

    const SUPABASE_URL      = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    const SERVICE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
    }

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: { user }, error: authErr } = await authClient.auth.getUser(userToken);
    if (authErr || !user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired session' }) };
    }

    const { m_payment_id } = JSON.parse(event.body || '{}');
    if (!m_payment_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing m_payment_id' }) };
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

    // ── Look up the stored token for THIS user only.
    const { data: profile } = await supabase
      .from('profiles')
      .select('payfast_token')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!profile?.payfast_token) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'No saved card on file' }) };
    }

    // ── Look up the pending order and confirm it belongs to this user —
    // the authoritative amount comes from the order row (already priced
    // server-side by validate-cart.js when checkout.html created it), never
    // from client input, per the "don't trust frontend for financial data" rule.
    const { data: order } = await supabase
      .from('orders')
      .select('id, user_id, total, payment_status, order_number')
      .eq('m_payment_id', m_payment_id)
      .maybeSingle();

    if (!order || order.user_id !== user.id) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Order not found for this account' }) };
    }
    if (order.payment_status === 'paid') {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, alreadyPaid: true }) };
    }

    const MERCHANT_ID = (process.env.PAYFAST_MERCHANT_ID || '').toString().trim();
    const PASSPHRASE  = (process.env.PAYFAST_PASSPHRASE || '').toString().trim();
    const SANDBOX     = (process.env.PAYFAST_SANDBOX || 'true').toLowerCase() !== 'false';
    if (!MERCHANT_ID) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'PayFast merchant configuration missing on server.' }) };
    }

    const apiHost = SANDBOX ? 'api.sandbox.payfast.co.za' : 'api.payfast.co.za';
    const amountCents = Math.round(Number(order.total) * 100);
    const timestamp = new Date().toISOString();

    // PayFast API v1 header-based signing — merchant-id/version/timestamp
    // are signed together with the body params, MD5, same passphrase used
    // for the form flow. Confirm this against PayFast's API docs/sandbox.
    const signaturePayload = {
      'merchant-id': MERCHANT_ID,
      version: 'v1',
      timestamp,
      amount: amountCents,
      item_name: `Umzila order ${order.order_number || m_payment_id}`
    };
    const sigString = Object.keys(signaturePayload)
      .sort()
      .map(k => `${k}=${encodeURIComponent(signaturePayload[k]).replace(/%20/g, '+')}`)
      .join('&') + (PASSPHRASE ? `&passphrase=${encodeURIComponent(PASSPHRASE).replace(/%20/g, '+')}` : '');
    const signature = crypto.createHash('md5').update(sigString).digest('hex');

    const pfRes = await fetch(`https://${apiHost}/subscriptions/${encodeURIComponent(profile.payfast_token)}/adhoc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'merchant-id': MERCHANT_ID,
        version: 'v1',
        timestamp,
        signature
      },
      body: JSON.stringify({ amount: amountCents, item_name: signaturePayload.item_name })
    });

    const pfJson = await pfRes.json().catch(() => ({}));

    if (!pfRes.ok || (pfJson.status && pfJson.status !== 'success')) {
      console.error('charge-payfast-token: PayFast API error', pfRes.status, pfJson);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'PayFast declined the charge. Please pay another way.' }) };
    }

    // Order is marked paid asynchronously by payfast-itn.js when PayFast's
    // ITN for this charge arrives (same notify_url as every other payment,
    // matched by m_payment_id) — no order-status write happens here.
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

  } catch (err) {
    console.error('charge-payfast-token error', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Server error' }) };
  }
};
