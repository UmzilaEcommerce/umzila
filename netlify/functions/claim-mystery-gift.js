// netlify/functions/claim-mystery-gift.js
// Creates a 10% mystery discount code and sends a teaser email.
// Uses service role key — never exposed to the browser.

const { createClient } = require('@supabase/supabase-js');

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

  const SUPABASE_URL  = process.env.SUPABASE_URL || '';
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const RESEND_KEY    = process.env.RESEND_API_KEY || '';
  const SITE_BASE_URL = (process.env.SITE_BASE_URL || '').replace(/\/$/, '');

  if (!SUPABASE_URL || !SERVICE_KEY)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const rawEmail = (body.email || '').trim().toLowerCase();
  if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail))
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Valid email address required' }) };

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Duplicate prevention — silently succeed if they already have an active mystery code
  const { data: existing } = await admin
    .from('discount_codes')
    .select('id')
    .eq('email', rawEmail)
    .eq('type', 'mystery_gift')
    .eq('used', false)
    .maybeSingle();

  if (existing) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, message: "Check your inbox! We've sent your mystery gift." })
    };
  }

  // Generate code
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'MYSTERY';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  const { data: newCode, error: insertErr } = await admin
    .from('discount_codes')
    .insert([{
      code,
      amount: 10,
      used: false,
      expires_at: expiresAt.toISOString(),
      email: rawEmail,
      type: 'mystery_gift'
    }])
    .select()
    .single();

  if (insertErr) {
    console.error('claim-mystery-gift: insert error', insertErr);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to create your gift. Please try again.' }) };
  }

  // Send teaser email (non-fatal — gift code is already created)
  if (RESEND_KEY) {
    const expiryLabel = expiresAt.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Umzila <noreply@umzila.store>',
          to: [rawEmail],
          subject: 'Your mystery gift is waiting... 🎁',
          html: buildMysteryEmail(newCode.code, expiryLabel, SITE_BASE_URL)
        })
      });
      if (!res.ok) console.error('claim-mystery-gift: Resend error', res.status, await res.text());
    } catch (emailErr) {
      console.error('claim-mystery-gift: email error', emailErr);
    }
  } else {
    console.warn('claim-mystery-gift: RESEND_API_KEY not set — email skipped');
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, message: "Check your inbox! We've sent your mystery gift." })
  };
};

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildMysteryEmail(code, expiryLabel, siteUrl) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif}
  .wrap{max-width:580px;margin:40px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.09)}
  .hdr{background:#0a2f66;padding:30px 40px;text-align:center}
  .hdr h1{color:#fff;margin:0 0 4px;font-size:22px;font-weight:800;letter-spacing:-0.5px}
  .hdr p{color:rgba(255,255,255,0.7);margin:0;font-size:13px}
  .bd{padding:34px 40px}
  .bd h2{color:#0a2f66;margin:0 0 12px;font-size:20px;font-weight:700}
  .bd p{color:#555;line-height:1.7;margin:0 0 14px;font-size:15px}
  .gift-wrap{background:linear-gradient(135deg,#f0f4ff,#fdf0f3);border-radius:14px;padding:28px;text-align:center;margin:20px 0}
  .gift-icon{font-size:52px;margin-bottom:10px}
  .gift-teaser{font-size:16px;color:#0a2f66;font-weight:700;margin:0}
  .gift-sub{font-size:13px;color:#888;margin-top:6px}
  .code-box{background:#fff;border:2px dashed #e0284f;border-radius:10px;padding:22px;text-align:center;margin:22px 0;box-shadow:0 2px 8px rgba(224,40,79,0.08)}
  .code-box .code{font-size:28px;font-weight:800;color:#e0284f;letter-spacing:4px;font-family:monospace}
  .code-box .note{font-size:12px;color:#999;margin-top:8px}
  .cta{text-align:center;margin:22px 0 14px}
  .btn{display:inline-block;background:#e0284f;color:#fff !important;padding:14px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px}
  .hint{font-size:13px;color:#aaa;text-align:center;font-style:italic;margin-top:4px}
  .ft{background:#f4f6fb;padding:18px 40px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0}
  .ft a{color:#0a2f66;text-decoration:none}
</style></head>
<body><div class="wrap">
  <div class="hdr">
    <h1>Umzila</h1>
    <p>Your mystery gift has arrived</p>
  </div>
  <div class="bd">
    <h2>Something special, just for you.</h2>
    <div class="gift-wrap">
      <div class="gift-icon">🎁</div>
      <p class="gift-teaser">Your mystery gift is inside.</p>
      <p class="gift-sub">We'd tell you what it is, but that would ruin the fun...</p>
    </div>
    <p>We don't want to spoil the surprise — just enter the code below when you checkout and watch what happens. Trust us, you'll like it.</p>
    <div class="code-box">
      <div class="code">${esc(code)}</div>
      <div class="note">Enter at checkout &bull; Valid until ${esc(expiryLabel)}</div>
    </div>
    <div class="cta"><a href="${esc(siteUrl)}/shop.html" class="btn">Claim Your Gift &rarr;</a></div>
    <p class="hint">The mystery reveals itself at checkout. 🤫</p>
  </div>
  <div class="ft">
    <strong><a href="${esc(siteUrl)}">Umzila</a></strong> &mdash; campus marketplace<br>
    Questions? <a href="mailto:support@umzila.store">support@umzila.store</a>
  </div>
</div></body></html>`;
}
