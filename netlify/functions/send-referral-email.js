// netlify/functions/send-referral-email.js
// Sends referee welcome email OR referrer reward email via Resend.
// No auth required, no DB writes — caller already created the discount codes.

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const RESEND_KEY    = process.env.RESEND_API_KEY || '';
  const SITE_BASE_URL = (process.env.SITE_BASE_URL || 'https://umzila.store').replace(/\/$/, '');

  if (!RESEND_KEY) {
    console.warn('send-referral-email: RESEND_API_KEY not set — skipping');
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, skipped: true }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { type, email, code, expires_at, referrer_name } = body;

  if (!type || !email || !code)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'type, email and code are required' }) };

  const expiryLabel = expires_at
    ? new Date(expires_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })
    : '30 days';

  let subject, html;

  if (type === 'referee') {
    subject = 'Your 15% welcome discount — courtesy of a friend';
    html = buildRefereeEmail(esc(code), expiryLabel, SITE_BASE_URL);
  } else if (type === 'referrer') {
    subject = "Someone used your referral link — here's your R40!";
    html = buildReferrerEmail(esc(code), expiryLabel, esc(referrer_name || 'there'), SITE_BASE_URL);
  } else {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'type must be referee or referrer' }) };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Umzila <noreply@umzila.store>', to: [email], subject, html })
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error('send-referral-email: Resend error', res.status, txt);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Email send failed' }) };
    }
  } catch (err) {
    console.error('send-referral-email: fetch error', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Network error' }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
};

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sharedStyles() {
  return `
    body{margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif}
    .wrap{max-width:580px;margin:40px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.09)}
    .hdr{background:#0a2f66;padding:30px 40px;text-align:center}
    .hdr h1{color:#fff;margin:0 0 4px;font-size:22px;font-weight:800;letter-spacing:-0.5px}
    .hdr p{color:rgba(255,255,255,0.7);margin:0;font-size:13px}
    .bd{padding:34px 40px}
    .bd h2{color:#0a2f66;margin:0 0 12px;font-size:20px;font-weight:700}
    .bd p{color:#555;line-height:1.7;margin:0 0 14px;font-size:15px}
    .code-box{background:#f0f4ff;border:2px dashed #0a2f66;border-radius:10px;padding:22px;text-align:center;margin:24px 0}
    .code-box .code{font-size:28px;font-weight:800;color:#0a2f66;letter-spacing:4px;font-family:monospace}
    .code-box .note{font-size:12px;color:#888;margin-top:8px}
    .cta{text-align:center;margin:24px 0 16px}
    .btn{display:inline-block;background:#e0284f;color:#fff !important;padding:14px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px}
    .ft{background:#f4f6fb;padding:18px 40px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0}
    .ft a{color:#0a2f66;text-decoration:none}
  `;
}

function buildRefereeEmail(code, expiryLabel, siteUrl) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${sharedStyles()}</style></head>
<body><div class="wrap">
  <div class="hdr">
    <h1>Umzila</h1>
    <p>A friend invited you — here's your reward</p>
  </div>
  <div class="bd">
    <h2>Welcome to Umzila! 🎉</h2>
    <p>A friend thought you'd love shopping on Umzila — South Africa's student marketplace. As a thank you for joining, we're giving you <strong>15% off your first order</strong>.</p>
    <div class="code-box">
      <div class="code">${code}</div>
      <div class="note">Enter at checkout &bull; Valid until ${expiryLabel} &bull; First order only</div>
    </div>
    <p>Browse the latest drops in clothing, accessories, beauty and more — all from local sellers.</p>
    <div class="cta"><a href="${siteUrl}/shop.html" class="btn">Start Shopping &rarr;</a></div>
  </div>
  <div class="ft">
    <strong><a href="${siteUrl}">Umzila</a></strong> &mdash; campus marketplace<br>
    Questions? <a href="mailto:support@umzila.store">support@umzila.store</a>
  </div>
</div></body></html>`;
}

function buildReferrerEmail(code, expiryLabel, firstName, siteUrl) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${sharedStyles()}</style></head>
<body><div class="wrap">
  <div class="hdr">
    <h1>Umzila</h1>
    <p>Your referral worked!</p>
  </div>
  <div class="bd">
    <h2>Nice one, ${firstName}! 🙌</h2>
    <p>Someone just signed up using your referral link. As a thank you, here's <strong>R40 off your next order</strong> — no minimum spend required.</p>
    <div class="code-box">
      <div class="code">${code}</div>
      <div class="note">Enter at checkout &bull; Valid until ${expiryLabel}</div>
    </div>
    <p>Keep sharing your link — every time a friend signs up, you earn another reward.</p>
    <div class="cta"><a href="${siteUrl}/shop.html" class="btn">Shop Now &rarr;</a></div>
  </div>
  <div class="ft">
    <strong><a href="${siteUrl}">Umzila</a></strong> &mdash; campus marketplace<br>
    Questions? <a href="mailto:support@umzila.store">support@umzila.store</a>
  </div>
</div></body></html>`;
}
