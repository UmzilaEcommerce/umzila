// netlify/functions/process-referral.js
// Server-side referral processing:
//   1. Looks up referrer by referral_code
//   2. Creates discount codes for referee (15% off first order) and referrer (R40 off)
//   3. Records the referral in referral_tracking
//   4. Sends walkthrough emails to both parties via Resend
// Uses service role key — never exposed to frontend.

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
  const SITE_BASE_URL = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');

  if (!SUPABASE_URL || !SERVICE_KEY)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const referralCode = (body.referral_code || '').trim().toUpperCase();
  const refereeEmail = (body.referee_email || '').trim().toLowerCase();
  const refereeName  = (body.referee_name  || 'there').trim();

  if (!referralCode || !refereeEmail)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'referral_code and referee_email are required' }) };

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // 1. Look up referrer by referral_code
  const { data: referrer, error: referrerErr } = await admin
    .from('profiles')
    .select('id, user_id, email, first_name')
    .eq('referral_code', referralCode)
    .maybeSingle();

  if (referrerErr || !referrer) {
    console.warn('process-referral: referral_code not found', referralCode);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: 'No matching referral code — skipped' }) };
  }

  // Prevent self-referral
  if (referrer.email && referrer.email.toLowerCase() === refereeEmail) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: 'Self-referral ignored' }) };
  }

  // 2. Idempotency: skip if referee discount already exists for this email + referral_code
  const { data: existing } = await admin
    .from('discount_codes')
    .select('id')
    .eq('email', refereeEmail)
    .eq('referral_code', referralCode)
    .eq('type', 'percentage')
    .maybeSingle();

  if (existing) {
    console.log('process-referral: duplicate — already processed for', refereeEmail);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: 'Already processed' }) };
  }

  // 3. Generate codes
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  function randomSuffix(len) {
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  const refereeCode  = 'WELCOME'  + randomSuffix(6);
  const referrerCode = 'REFERRAL' + randomSuffix(6);

  const refereeExpiry  = new Date(); refereeExpiry.setMonth(refereeExpiry.getMonth() + 1);
  const referrerExpiry = new Date(); referrerExpiry.setMonth(referrerExpiry.getMonth() + 3);

  // 4. Insert referee discount code
  const { error: refereeInsertErr } = await admin
    .from('discount_codes')
    .insert([{
      code:            refereeCode,
      amount:          15,
      used:            false,
      expires_at:      refereeExpiry.toISOString(),
      email:           refereeEmail,
      referral_code:   referralCode,
      type:            'percentage',
      first_order_only: true,
      user_id:         null
    }]);

  if (refereeInsertErr) {
    console.error('process-referral: referee insert error', refereeInsertErr);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to create referee discount' }) };
  }

  // 5. Insert referrer reward code (user_id = profiles.id of referrer, NOT auth UUID)
  const { error: referrerInsertErr } = await admin
    .from('discount_codes')
    .insert([{
      code:           referrerCode,
      amount:         40,
      used:           false,
      expires_at:     referrerExpiry.toISOString(),
      referral_reward: true,
      referee_email:  refereeEmail,
      referral_code:  referralCode,
      type:           'referrer_reward',
      first_order_only: false,
      user_id:        referrer.id   // profiles.id (the FK target)
    }]);

  if (referrerInsertErr) {
    console.error('process-referral: referrer reward insert error', referrerInsertErr);
    // Non-fatal: referee code already created — continue
  }

  // 6. Insert referral_tracking record
  await admin
    .from('referral_tracking')
    .insert([{
      referrer_id:   referrer.user_id,
      referee_email: refereeEmail,
      referral_code: referralCode,
      status:        'signed_up'
    }])
    .catch(e => console.warn('process-referral: referral_tracking insert error', e));

  // 7. Send walkthrough emails via Resend (non-fatal)
  if (RESEND_KEY) {
    const refereeExpiryLabel  = refereeExpiry.toLocaleDateString('en-ZA',  { day: 'numeric', month: 'long', year: 'numeric' });
    const referrerExpiryLabel = referrerExpiry.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
    const referrerFirstName   = referrer.first_name || 'there';

    // Email to referee
    try {
      const r1 = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:    'Umzila <noreply@umzila.store>',
          to:      [refereeEmail],
          subject: `Welcome to Umzila — your friend gave you 15% off 🎉`,
          html:    buildRefereeEmail(refereeCode, refereeExpiryLabel, refereeName, SITE_BASE_URL)
        })
      });
      if (!r1.ok) console.error('process-referral: referee email failed', r1.status, await r1.text());
    } catch (e) { console.error('process-referral: referee email error', e); }

    // Email to referrer
    if (referrer.email) {
      try {
        const r2 = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from:    'Umzila <noreply@umzila.store>',
            to:      [referrer.email],
            subject: `${refereeName} joined Umzila with your link — here's your R40 🙌`,
            html:    buildReferrerEmail(referrerCode, referrerExpiryLabel, referrerFirstName, refereeName, referralCode, SITE_BASE_URL)
          })
        });
        if (!r2.ok) console.error('process-referral: referrer email failed', r2.status, await r2.text());
      } catch (e) { console.error('process-referral: referrer email error', e); }
    }
  } else {
    console.warn('process-referral: RESEND_API_KEY not set — emails skipped');
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, message: 'Referral processed' })
  };
};

// ─── helpers ───────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Email: referee welcome + discount walkthrough ─────────────────────────

function buildRefereeEmail(code, expiryLabel, refereeName, siteUrl) {
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
  .code-box{background:#fff;border:2px dashed #e0284f;border-radius:10px;padding:22px;text-align:center;margin:22px 0;box-shadow:0 2px 8px rgba(224,40,79,0.08)}
  .code-box .code{font-size:28px;font-weight:800;color:#e0284f;letter-spacing:4px;font-family:monospace}
  .code-box .note{font-size:12px;color:#999;margin-top:8px}
  .steps{background:#f0f4ff;border-radius:10px;padding:20px 24px;margin:20px 0}
  .steps h3{color:#0a2f66;margin:0 0 12px;font-size:15px;font-weight:700}
  .step{display:flex;gap:12px;margin-bottom:10px;align-items:flex-start}
  .step-num{background:#0a2f66;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;margin-top:1px}
  .step-text{color:#333;font-size:14px;line-height:1.5}
  .referral-box{background:#fff8e7;border:1px solid #ffe58c;border-radius:10px;padding:16px 20px;margin:20px 0}
  .referral-box p{margin:0;font-size:13px;color:#7a5c00}
  .referral-box .ref-link{font-size:13px;color:#0a2f66;font-weight:600;word-break:break-all}
  .cta{text-align:center;margin:22px 0 14px}
  .btn{display:inline-block;background:#e0284f;color:#fff !important;padding:14px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px}
  .ft{background:#f4f6fb;padding:18px 40px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0}
  .ft a{color:#0a2f66;text-decoration:none}
</style></head>
<body><div class="wrap">
  <div class="hdr">
    <h1>Umzila</h1>
    <p>Welcome to the campus marketplace</p>
  </div>
  <div class="bd">
    <h2>Hey ${esc(refereeName)}, a friend gave you 15% off! 🎉</h2>
    <p>Someone thought you'd love Umzila — South Africa's student marketplace. As a welcome gift, you have <strong>15% off your first order</strong>.</p>

    <div class="code-box">
      <div class="code">${esc(code)}</div>
      <div class="note">First order only &bull; Valid until ${esc(expiryLabel)}</div>
    </div>

    <div class="steps">
      <h3>Here's exactly how to use it:</h3>
      <div class="step"><div class="step-num">1</div><div class="step-text">Browse the marketplace and add anything you like to your cart</div></div>
      <div class="step"><div class="step-num">2</div><div class="step-text">Head to checkout when you're ready</div></div>
      <div class="step"><div class="step-num">3</div><div class="step-text">Paste <strong>${esc(code)}</strong> in the <em>"Discount code"</em> field</div></div>
      <div class="step"><div class="step-num">4</div><div class="step-text">Your 15% is deducted instantly — no minimum spend</div></div>
    </div>

    <div class="cta"><a href="${esc(siteUrl)}/shop.html" class="btn">Shop Now &rarr;</a></div>

    <div class="referral-box">
      <p><strong>You also have your own referral link.</strong> Share it — every time a friend signs up using your link, you earn <strong>R40 off</strong> your next order.</p>
      <p style="margin-top:8px">Find your link on your <a href="${esc(siteUrl)}/profile.html" style="color:#0a2f66;font-weight:600">profile page</a> after logging in.</p>
    </div>
  </div>
  <div class="ft">
    <strong><a href="${esc(siteUrl)}">Umzila</a></strong> &mdash; campus marketplace<br>
    Questions? <a href="mailto:support@umzila.store">support@umzila.store</a>
  </div>
</div></body></html>`;
}

// ─── Email: referrer reward notification ───────────────────────────────────

function buildReferrerEmail(code, expiryLabel, referrerName, refereeName, referralCode, siteUrl) {
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
  .highlight{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 18px;margin:16px 0;font-size:15px;color:#064e3b;font-weight:600}
  .code-box{background:#fff;border:2px dashed #e0284f;border-radius:10px;padding:22px;text-align:center;margin:22px 0;box-shadow:0 2px 8px rgba(224,40,79,0.08)}
  .code-box .code{font-size:28px;font-weight:800;color:#e0284f;letter-spacing:4px;font-family:monospace}
  .code-box .note{font-size:12px;color:#999;margin-top:8px}
  .steps{background:#f0f4ff;border-radius:10px;padding:20px 24px;margin:20px 0}
  .steps h3{color:#0a2f66;margin:0 0 12px;font-size:15px;font-weight:700}
  .step{display:flex;gap:12px;margin-bottom:10px;align-items:flex-start}
  .step-num{background:#0a2f66;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;margin-top:1px}
  .step-text{color:#333;font-size:14px;line-height:1.5}
  .share-box{background:#fff8e7;border:1px solid #ffe58c;border-radius:10px;padding:16px 20px;margin:20px 0}
  .share-box p{margin:0;font-size:13px;color:#7a5c00}
  .share-link{font-size:13px;color:#0a2f66;font-weight:600;word-break:break-all;margin-top:6px;display:block}
  .cta{text-align:center;margin:22px 0 14px}
  .btn{display:inline-block;background:#e0284f;color:#fff !important;padding:14px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px}
  .ft{background:#f4f6fb;padding:18px 40px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0}
  .ft a{color:#0a2f66;text-decoration:none}
</style></head>
<body><div class="wrap">
  <div class="hdr">
    <h1>Umzila</h1>
    <p>Your referral reward is here</p>
  </div>
  <div class="bd">
    <h2>Nice one, ${esc(referrerName)}! 🙌</h2>

    <div class="highlight">
      🎉 ${esc(refereeName)} just joined Umzila using your referral link!
    </div>

    <p>As a thank you, here's <strong>R40 off your next order</strong> — no minimum spend, no strings attached.</p>

    <div class="code-box">
      <div class="code">${esc(code)}</div>
      <div class="note">No minimum spend &bull; Valid until ${esc(expiryLabel)}</div>
    </div>

    <div class="steps">
      <h3>How to use your R40:</h3>
      <div class="step"><div class="step-num">1</div><div class="step-text">Browse the shop and add items to your cart</div></div>
      <div class="step"><div class="step-num">2</div><div class="step-text">At checkout, enter <strong>${esc(code)}</strong> in the discount field</div></div>
      <div class="step"><div class="step-num">3</div><div class="step-text">R40 is deducted straight off your total</div></div>
    </div>

    <div class="cta"><a href="${esc(siteUrl)}/shop.html" class="btn">Use My R40 &rarr;</a></div>

    <div class="share-box">
      <p><strong>Keep earning.</strong> Every time someone signs up with your link, you get another R40 off.</p>
      <span class="share-link">${esc(siteUrl)}/?ref=${esc(referralCode)}</span>
      <p style="margin-top:8px">Find and copy your link anytime on your <a href="${esc(siteUrl)}/profile.html" style="color:#0a2f66;font-weight:600">profile page</a>.</p>
    </div>
  </div>
  <div class="ft">
    <strong><a href="${esc(siteUrl)}">Umzila</a></strong> &mdash; campus marketplace<br>
    Questions? <a href="mailto:support@umzila.store">support@umzila.store</a>
  </div>
</div></body></html>`;
}
