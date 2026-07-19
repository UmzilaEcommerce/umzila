// netlify/functions/unsubscribe.js
//
// One-click unsubscribe link for marketing emails. `t` is an HMAC of the
// email so the link can't be reused to unsubscribe someone else's address.
// Flips subscribers.unsubscribed — upserts rather than updates so a link
// for an email not yet in the table still permanently suppresses it.
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

function sign(email) {
  const secret = process.env.UNSUBSCRIBE_SECRET || '';
  return crypto.createHmac('sha256', secret).update(email.toLowerCase().trim()).digest('hex');
}

function page(title, message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:40px 20px;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif;
             display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="max-width:420px;background:#fff;border-radius:14px;padding:36px 32px;text-align:center;
            box-shadow:0 4px 20px rgba(0,0,0,0.08)">
  <div style="font-size:24px;font-weight:900;color:#0a2f66;margin-bottom:12px">Umzila</div>
  <p style="color:#333;font-size:15px;line-height:1.6;margin:0">${message}</p>
</div></body></html>`;
}

exports.handler = async function (event) {
  const htmlHeaders = { 'Content-Type': 'text/html; charset=utf-8' };

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: htmlHeaders, body: page('Unsubscribe', 'Method not allowed.') };
  }

  const email = (event.queryStringParameters && event.queryStringParameters.e || '').trim();
  const providedToken = (event.queryStringParameters && event.queryStringParameters.t || '').trim();

  const secret = process.env.UNSUBSCRIBE_SECRET || '';
  if (!email || !providedToken || !secret) {
    return { statusCode: 400, headers: htmlHeaders, body: page('Unsubscribe', 'This unsubscribe link is invalid.') };
  }

  const expected = sign(email);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(providedToken, 'hex');
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) {
    return { statusCode: 400, headers: htmlHeaders, body: page('Unsubscribe', 'This unsubscribe link is invalid or has expired.') };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers: htmlHeaders, body: page('Unsubscribe', 'Something went wrong. Please try again later.') };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const normalizedEmail = email.toLowerCase().trim();
  const { data: existing } = await admin.from('subscribers').select('sources').ilike('email', normalizedEmail).maybeSingle();
  await admin.from('subscribers').upsert({
    email: normalizedEmail,
    sources: existing ? existing.sources : [],
    unsubscribed: true,
    unsubscribed_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }, { onConflict: 'email' });

  return { statusCode: 200, headers: htmlHeaders, body: page('Unsubscribed', `You've been unsubscribed from Umzila promotional emails. You won't receive further marketing messages at <strong>${email.replace(/</g, '&lt;')}</strong>.`) };
};
