// netlify/functions/claim-mystery-gift.js
// Action-routed mystery-gift endpoint:
//   check      {email}                         -> {has_profile, code_state}
//   claim      {email, fun_fact, fact_text}     -> creates/looks up a 10% mystery code (or, if the
//                                                  email's existing code is already used/expired,
//                                                  issues the small free-item consolation gift)
//   post_login {email, fun_fact, fact_text}     -> same as above but requires a Bearer JWT whose
//                                                  own email matches the body email; the only path
//                                                  that can reinstate an expired code or confirm
//                                                  free-gift issuance for an account that exists.
// Uses service role key — never exposed to the browser.

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_FREE_GIFT_PRODUCT_ID = 'eff1bf49-929a-4a71-8e4d-44189ccec7ea'; // Milky pie ice cream

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const SUPABASE_URL  = process.env.SUPABASE_URL || '';
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const RESEND_KEY    = process.env.RESEND_API_KEY || '';
  const SITE_BASE_URL = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');
  const FREE_GIFT_PRODUCT_ID = process.env.FREE_GIFT_PRODUCT_ID || DEFAULT_FREE_GIFT_PRODUCT_ID;

  if (!SUPABASE_URL || !SERVICE_KEY)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const action = body.action || 'claim'; // default to legacy behaviour for safety
  const rawEmail = (body.email || '').trim().toLowerCase();
  if (!rawEmail || !EMAIL_RE.test(rawEmail))
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Valid email address required' }) };

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    if (action === 'check') {
      const hasProfile = await hasProfileForEmail(admin, rawEmail);
      const { state } = await classifyCode(admin, rawEmail);
      return ok({ has_profile: hasProfile, code_state: state });
    }

    if (action === 'claim') {
      const funFact = !!body.fun_fact;
      const factText = typeof body.fact_text === 'string' ? body.fact_text.slice(0, 300) : '';
      const { state, row } = await classifyCode(admin, rawEmail);

      if (state === 'none') {
        const created = await issueMysteryCode(admin, rawEmail, funFact, factText, SITE_BASE_URL, RESEND_KEY);
        if (!created) return serverError();
        return ok({ state: 'claimed' });
      }
      if (state === 'active') {
        return ok({ state: 'active' });
      }
      // state is 'used' or 'expired' — the email-only claim flow cannot verify account
      // ownership to reinstate the original code (that requires post_login), so both
      // "already used" and "expired unused" are treated as spent and routed to the
      // small free-item consolation gift instead.
      const gift = await issueFreeGift(admin, rawEmail, FREE_GIFT_PRODUCT_ID);
      return ok(gift);
    }

    if (action === 'post_login') {
      const authHeader = event.headers && (event.headers.authorization || event.headers.Authorization);
      const token = authHeader && authHeader.replace(/^Bearer\s+/i, '').trim();
      if (!token) return unauthorized('Missing auth token');

      const { data: userData, error: userErr } = await admin.auth.getUser(token);
      if (userErr || !userData || !userData.user || !userData.user.email)
        return unauthorized('Invalid session');

      const authedEmail = String(userData.user.email).trim().toLowerCase();
      if (authedEmail !== rawEmail)
        return unauthorized('Email does not match authenticated user');

      const funFact = !!body.fun_fact;
      const factText = typeof body.fact_text === 'string' ? body.fact_text.slice(0, 300) : '';
      const { state, row } = await classifyCode(admin, rawEmail);

      if (state === 'none') {
        const created = await issueMysteryCode(admin, rawEmail, funFact, factText, SITE_BASE_URL, RESEND_KEY);
        if (!created) return serverError();
        return ok({ state: 'claimed' });
      }
      if (state === 'active') {
        return ok({ state: 'active' });
      }
      if (state === 'expired') {
        const reinstated = await reinstateCode(admin, row, SITE_BASE_URL, RESEND_KEY);
        if (!reinstated) return serverError();
        return ok({ state: 'reinstated' });
      }
      // state === 'used'
      const gift = await issueFreeGift(admin, rawEmail, FREE_GIFT_PRODUCT_ID);
      return ok(gift);
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    console.error('claim-mystery-gift: unexpected error', err);
    return serverError();
  }
};

function ok(obj) {
  return { statusCode: 200, headers: CORS, body: JSON.stringify(Object.assign({ success: true }, obj)) };
}
function unauthorized(msg) {
  return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: msg || 'Unauthorized' }) };
}
function serverError() {
  return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Something went wrong. Please try again.' }) };
}

async function hasProfileForEmail(admin, email) {
  const { data } = await admin
    .from('profiles')
    .select('id')
    .ilike('email', email)
    .limit(1)
    .maybeSingle();
  return !!data;
}

// Classifies the most recent mystery_gift discount_codes row for this email.
async function classifyCode(admin, email) {
  const { data } = await admin
    .from('discount_codes')
    .select('*')
    .eq('email', email)
    .eq('type', 'mystery_gift')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return { state: 'none', row: null };
  if (data.used) return { state: 'used', row: data };
  if (new Date(data.expires_at) < new Date()) return { state: 'expired', row: data };
  return { state: 'active', row: data };
}

function randomSuffix(n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Creates a fresh 10% mystery code and emails it. The discount value/shape is identical
// regardless of fun_fact — only the email copy differs.
async function issueMysteryCode(admin, email, funFact, factText, SITE_BASE_URL, RESEND_KEY) {
  const code = 'MYSTERY' + randomSuffix(6);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  const { data: newCode, error: insertErr } = await admin
    .from('discount_codes')
    .insert([{
      code,
      amount: 10,
      used: false,
      expires_at: expiresAt.toISOString(),
      email,
      type: 'mystery_gift'
    }])
    .select()
    .single();

  if (insertErr) {
    console.error('claim-mystery-gift: insert error', insertErr);
    return null;
  }

  if (RESEND_KEY) {
    const expiryLabel = expiresAt.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });
    try {
      const html = funFact
        ? buildMysteryFunFactEmail(newCode.code, expiryLabel, SITE_BASE_URL, factText)
        : buildMysteryEmail(newCode.code, expiryLabel, SITE_BASE_URL);
      const subject = funFact
        ? 'Your mystery gift — with a little something extra 🎁'
        : 'Your mystery gift is waiting... 🎁';
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Umzila <noreply@umzila.store>',
          to: [email],
          subject,
          html
        })
      });
      if (!res.ok) console.error('claim-mystery-gift: Resend error', res.status, await res.text());
    } catch (emailErr) {
      console.error('claim-mystery-gift: email error', emailErr);
    }
  } else {
    console.warn('claim-mystery-gift: RESEND_API_KEY not set — email skipped');
  }

  return newCode;
}

// Reinstates an expired-but-unused mystery code in place — same code, extends expiry.
// Never mints a new code.
async function reinstateCode(admin, row, SITE_BASE_URL, RESEND_KEY) {
  const newExpiresAt = new Date();
  newExpiresAt.setDate(newExpiresAt.getDate() + 14);

  const { data: updated, error: updateErr } = await admin
    .from('discount_codes')
    .update({ expires_at: newExpiresAt.toISOString(), updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .select()
    .single();

  if (updateErr) {
    console.error('claim-mystery-gift: reinstate error', updateErr);
    return null;
  }

  if (RESEND_KEY) {
    const expiryLabel = newExpiresAt.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Umzila <noreply@umzila.store>',
          to: [updated.email],
          subject: 'Your mystery code is back from the dead 🧟🎁',
          html: buildReinstateEmail(updated.code, expiryLabel, SITE_BASE_URL)
        })
      });
      if (!res.ok) console.error('claim-mystery-gift: Resend error', res.status, await res.text());
    } catch (emailErr) {
      console.error('claim-mystery-gift: email error', emailErr);
    }
  } else {
    console.warn('claim-mystery-gift: RESEND_API_KEY not set — email skipped');
  }

  return updated;
}

// Issues (or reuses) a free-item discount code for the "already used your mystery gift" case,
// and returns the payload the client needs to add the product to the cart. The row shape is
// 100% compatible with checkout.html's existing applyCoupon() — a non-percentage `type` means
// it applies `amount` as a flat rand discount, which fully offsets the gift product's price.
async function issueFreeGift(admin, email, productId) {
  const { data: product } = await admin
    .from('products')
    .select('id, name, price, image, visible, stock')
    .eq('id', productId)
    .maybeSingle();

  if (!product || !product.visible || !((product.stock || 0) > 0)) {
    return { state: 'used_no_gift' };
  }

  const { data: existing } = await admin
    .from('discount_codes')
    .select('*')
    .eq('email', email)
    .eq('type', 'free_item')
    .eq('used', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    return {
      state: 'free_gift',
      gift: { product_id: product.id, name: product.name, price: existing.amount, image: product.image },
      code: existing.code
    };
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const { data: newCode, error: insertErr } = await admin
    .from('discount_codes')
    .insert([{
      code: 'GIFT' + randomSuffix(6),
      amount: product.price,
      used: false,
      expires_at: expiresAt.toISOString(),
      email,
      type: 'free_item',
      first_order_only: false
    }])
    .select()
    .single();

  if (insertErr) {
    console.error('claim-mystery-gift: free-gift insert error', insertErr);
    return { state: 'used_no_gift' };
  }

  return {
    state: 'free_gift',
    gift: { product_id: product.id, name: product.name, price: product.price, image: product.image },
    code: newCode.code
  };
}

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
//foto
}

// Same underlying gift as buildMysteryEmail (identical code/amount/expiry) — only the copy
// changes, referencing the fun fact the user chose to see on-site.
function buildMysteryFunFactEmail(code, expiryLabel, siteUrl, fact) {
  const factLine = fact
    ? esc(fact)
    : "sellers here walk most deliveries across campus themselves — barely any of it is driven.";
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
  .fact-wrap{background:linear-gradient(135deg,#eef2f8,#f0f4ff);border-left:4px solid #0a2f66;border-radius:8px;padding:18px 22px;margin:18px 0}
  .fact-wrap p{margin:0;color:#0a2f66;font-size:14px;line-height:1.6;font-style:italic}
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
    <p>Your mystery gift has arrived — plus a little extra</p>
  </div>
  <div class="bd">
    <h2>Since you wanted the extra, here's a secret.</h2>
    <div class="fact-wrap"><p>${factLine}</p></div>
    <div class="gift-wrap">
      <div class="gift-icon">🎁</div>
      <p class="gift-teaser">Your mystery gift is inside.</p>
      <p class="gift-sub">The gift below is the same great mystery either way.</p>
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

function buildReinstateEmail(code, expiryLabel, siteUrl) {
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
  .code-box{background:#fff;border:2px dashed #0a2f66;border-radius:10px;padding:22px;text-align:center;margin:22px 0;box-shadow:0 2px 8px rgba(10,47,102,0.08)}
  .code-box .code{font-size:28px;font-weight:800;color:#0a2f66;letter-spacing:4px;font-family:monospace}
  .code-box .note{font-size:12px;color:#999;margin-top:8px}
  .cta{text-align:center;margin:22px 0 14px}
  .btn{display:inline-block;background:#0a2f66;color:#fff !important;padding:14px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px}
  .ft{background:#f4f6fb;padding:18px 40px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0}
  .ft a{color:#0a2f66;text-decoration:none}
</style></head>
<body><div class="wrap">
  <div class="hdr">
    <h1>Umzila</h1>
    <p>Your mystery code lives again</p>
  </div>
  <div class="bd">
    <h2>It expired unused — so we brought it back.</h2>
    <p>Your mystery discount quietly expired without ever being used. Since that's a shame, we've revived it — same code, same 10% off, fresh expiry date below.</p>
    <div class="code-box">
      <div class="code">${esc(code)}</div>
      <div class="note">Enter at checkout &bull; Valid until ${esc(expiryLabel)}</div>
    </div>
    <div class="cta"><a href="${esc(siteUrl)}/shop.html" class="btn">Use It Now &rarr;</a></div>
  </div>
  <div class="ft">
    <strong><a href="${esc(siteUrl)}">Umzila</a></strong> &mdash; campus marketplace<br>
    Questions? <a href="mailto:support@umzila.store">support@umzila.store</a>
  </div>
</div></body></html>`;
}
