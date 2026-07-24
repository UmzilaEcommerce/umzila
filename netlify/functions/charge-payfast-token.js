// netlify/functions/charge-payfast-token.js
//
// One-click "pay with saved card" — charges a buyer's previously-tokenized
// PayFast payment method via PayFast's ad-hoc/subscriptions API, rather than
// redirecting through the PayFast payment page. This is a NEW, standalone
// code path — it does not touch generate-payfast-signature.js or the
// existing form-based checkout flow, which remain byte-for-byte unchanged.
//
// Header/signature scheme verified 2026-07-24 against PayFast's official PHP SDK source
// (github.com/PayFast/payfast-php-sdk: PayFastApi.php, Request.php, Auth.php,
// Services/Subscriptions.php) across two rounds of production 502s:
//   Round 1 — the sandbox path pointed at "api.sandbox.payfast.co.za", which does not
//   resolve as a real host (PayFast has exactly one API host; sandbox mode is a
//   `?testing=true` query param on the same host); timestamp used milliseconds + "Z"
//   instead of PayFast's exact signed format (PHP's date("Y-m-d\TH:i:sO")).
//   Round 2 — PayFast returned 401 "Merchant authorization failed" (per PayFast's own
//   support KB, this specifically means a bad signature, not a credentials/account
//   problem), which was the passphrase being appended to the signature string AFTER
//   sorting instead of being merged in BEFORE sorting (it belongs alphabetically
//   between "merchant-id" and "timestamp"), plus PHP's urlencode() escaping !*'()~
//   that JS's encodeURIComponent leaves untouched. Both fixed below.
// The exact JSON response shape on success/failure still isn't confirmed against live
// docs — `pfJson.status` is checked defensively (only fails the request if PayFast
// explicitly returns a non-"success" status; a response with no `status` field at all
// won't be treated as a failure) precisely because that field's presence is unconfirmed.
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

    // PayFast's official SDK (github.com/PayFast/payfast-php-sdk) exposes a single API
    // host — there is no "api.sandbox.payfast.co.za" (verified: that hostname does not
    // resolve). Sandbox/test mode is switched via a `testing=true` query param instead.
    const apiHost = 'api.payfast.co.za';
    const amountCents = Math.round(Number(order.total) * 100);
    // PayFast's SDK builds this as PHP's date("Y-m-d\TH:i:sO") — no milliseconds, and a
    // numeric UTC offset rather than "Z". This exact string is signed and re-verified by
    // PayFast server-side, so it must match their format, not just be valid ISO-8601.
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const offsetMin = -now.getTimezoneOffset();
    const offsetSign = offsetMin >= 0 ? '+' : '-';
    const offsetH = pad(Math.floor(Math.abs(offsetMin) / 60));
    const offsetM = pad(Math.abs(offsetMin) % 60);
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetH}${offsetM}`;

    // PHP's urlencode() (used by PayFast's SDK) escapes !*'()~ in addition to
    // everything encodeURIComponent already escapes, and turns spaces into
    // "+" rather than "%20" -- match it exactly, since the signature is a
    // byte-for-byte MD5 of this encoded string.
    function phpUrlEncode(value) {
      return encodeURIComponent(String(value))
        .replace(/%20/g, '+')
        .replace(/[!*'()~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    }

    // PayFast API v1 header-based signing, matching PayFast/payfast-php-sdk's
    // Auth::generateApiSignature exactly: passphrase is merged into the SAME
    // object before sorting -- it lands alphabetically between "merchant-id"
    // and "timestamp", not appended at the end. Getting this ordering wrong
    // silently produces a completely different (wrong) MD5, which is exactly
    // what PayFast's "Merchant authorization failed" (401) means: a bad
    // signature, not a credentials problem.
    const signaturePayload = {
      'merchant-id': MERCHANT_ID,
      version: 'v1',
      timestamp,
      amount: amountCents,
      item_name: `Umzila order ${order.order_number || m_payment_id}`
    };
    if (PASSPHRASE) signaturePayload.passphrase = PASSPHRASE;
    const sigString = Object.keys(signaturePayload)
      .sort()
      .map(k => `${k}=${phpUrlEncode(signaturePayload[k])}`)
      .join('&');
    const signature = crypto.createHash('md5').update(sigString).digest('hex');

    const pfUrl = `https://${apiHost}/subscriptions/${encodeURIComponent(profile.payfast_token)}/adhoc${SANDBOX ? '?testing=true' : ''}`;
    const pfRes = await fetch(pfUrl, {
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

    // Read as text first — if PayFast's response isn't valid JSON (a plain-text
    // or HTML error from an edge/gateway layer, say), `.json()` would throw and
    // get swallowed, losing the one clue we have to what actually went wrong.
    const pfRawText = await pfRes.text();
    let pfJson = {};
    try { pfJson = JSON.parse(pfRawText); } catch (_) { /* not JSON — pfRawText still has it */ }

    if (!pfRes.ok || (pfJson.status && pfJson.status !== 'success')) {
      console.error('charge-payfast-token: PayFast API error', pfRes.status, pfRawText);
      // `detail`/`pfStatus` are for the browser console only (checkout.html logs
      // them, never shows them in the user-facing banner) — this is PayFast's
      // own response, not a secret, and it's the fastest way to diagnose a
      // rejection without server-log access.
      const detail = pfJson?.message || pfJson?.error || (pfRawText ? pfRawText.slice(0, 300) : null);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: 'PayFast declined the charge. Please pay another way.',
          detail,
          pfStatus: pfRes.status
        })
      };
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
