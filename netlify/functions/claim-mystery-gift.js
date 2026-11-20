// netlify/functions/claim-mystery-gift.js
// Action-routed mystery-gift endpoint:
//   check      {email}                         -> {has_profile, code_state}
//   claim      {email, fun_fact}                -> creates/looks up a 10% mystery code (12% with fun_fact) (or, if the
//                                                  email's existing code is already used/expired,
//                                                  issues the small free-item consolation gift)
//   post_login {email, fun_fact}                -> same as above but requires a Bearer JWT whose
//                                                  own email matches the body email; the only path
//                                                  that can reinstate an expired code or confirm
//                                                  free-gift issuance for an account that exists.
// Uses service role key — never exposed to the browser.

const { createClient } = require('@supabase/supabase-js');
const { mailFrom } = require('./lib/mail'); // sender: mail.umzila.store, replies to @umzila.store
const { tagLinks } = require('./lib/visitor-tag'); // People: ?ut= on site links

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const { checkEmail } = require('./lib/contact-check'); // same rules as the page (input-guard.js)
const DEFAULT_FREE_GIFT_PRODUCT_ID = 'eff1bf49-929a-4a71-8e4d-44189ccec7ea'; // Milky pie ice cream

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

  const action = body.action || 'claim'; // default to legacy behaviour for safety
  const rawEmail = (body.email || '').trim().toLowerCase();
  const emCheck = checkEmail(rawEmail);
  if (!emCheck.ok)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: emCheck.error, suggestion: emCheck.suggestion || null }) };

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // The free-item consolation gift (admin.html → Marketing → Mystery gift pop-up): on/off and
  // which product, from public.site_settings key 'mystery_gift'. Missing row = on, ice cream.
  async function freeGiftSettings() {
    let v = {};
    try {
      const { data } = await admin.from('site_settings').select('value').eq('key', 'mystery_gift').maybeSingle();
      v = (data && data.value) || {};
    } catch (_) { /* fall back to the defaults */ }
    return {
      enabled: v.free_gift_enabled !== false,
      productId: v.free_gift_product_id || process.env.FREE_GIFT_PRODUCT_ID || DEFAULT_FREE_GIFT_PRODUCT_ID
    };
  }
  async function consolation(reason) {
    const cfg = await freeGiftSettings();
    if (!cfg.enabled) return { state: 'gift_off', reason };
    return issueFreeGift(admin, rawEmail, cfg.productId);
  }

  try {
    if (action === 'check') {
      const hasProfile = await hasProfileForEmail(admin, rawEmail);
      const { state } = await classifyCode(admin, rawEmail);
      return ok({ has_profile: hasProfile, code_state: state });
    }

    if (action === 'claim') {
      const funFact = !!body.fun_fact;
      const { state, row } = await classifyCode(admin, rawEmail);

      // expires_at (never the code) lets the browser remind the buyer at their cart that the
      // code is waiting in THIS inbox. The code itself only travels by email: handing it to
      // the browser would let anyone mint codes by typing made-up emails.
      if (state === 'none') {
        const created = await issueMysteryCode(admin, rawEmail, funFact, SITE_BASE_URL, RESEND_KEY);
        if (!created) return serverError();
        return ok({ state: 'claimed', expires_at: created.expires_at });
      }
      if (state === 'active') {
        return ok({ state: 'active', expires_at: row.expires_at });
      }
      // state is 'used' or 'expired' — the email-only claim flow cannot verify account
      // ownership to reinstate the original code (that requires post_login), so both
      // "already used" and "expired unused" are treated as spent and routed to the
      // small free-item consolation gift instead (or a plain message when it is switched off).
      return ok(await consolation(state));
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
      const { state, row } = await classifyCode(admin, rawEmail);

      if (state === 'none') {
        const created = await issueMysteryCode(admin, rawEmail, funFact, SITE_BASE_URL, RESEND_KEY);
        if (!created) return serverError();
        return ok({ state: 'claimed', expires_at: created.expires_at });
      }
      if (state === 'active') {
        return ok({ state: 'active', expires_at: row.expires_at });
      }
      if (state === 'expired') {
        const reinstated = await reinstateCode(admin, row, SITE_BASE_URL, RESEND_KEY);
        if (!reinstated) return serverError();
        return ok({ state: 'reinstated', expires_at: reinstated.expires_at });
      }
      // state === 'used'
      return ok(await consolation('used'));
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

// Creates a fresh mystery code and emails it. 10% normally; 12% when the user chose to read
// the fun facts in the popup (index.html promises an unnamed "bonus" on top for doing so).
async function issueMysteryCode(admin, email, funFact, SITE_BASE_URL, RESEND_KEY) {
  const code = 'MYSTERY' + randomSuffix(6);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  const { data: newCode, error: insertErr } = await admin
    .from('discount_codes')
    .insert([{
      code,
      amount: funFact ? 12 : 10,
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
        ? buildMysteryFunFactEmail(newCode.code, expiryLabel, SITE_BASE_URL)
        : buildMysteryEmail(newCode.code, expiryLabel, SITE_BASE_URL);
      const subject = funFact
        ? MYSTERY_SUBJECT_BONUS
        : MYSTERY_SUBJECT;
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...mailFrom('Umzila', 'noreply'),
          to: [email],
          subject,
          html: tagLinks(html, email, SITE_BASE_URL)
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
          ...mailFrom('Umzila', 'noreply'),
          to: [updated.email],
          subject: 'Your mystery gift code is back 🎁',
          html: tagLinks(buildReinstateEmail(updated.code, expiryLabel, SITE_BASE_URL), updated.email, SITE_BASE_URL)
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


// Subjects are quoted word for word in the pop-up (index.html "Find the email called …"),
// so people who read English as a second language know exactly what to look for. Change both together.
const MYSTERY_SUBJECT = 'Your mystery gift is waiting 🎁';
const MYSTERY_SUBJECT_BONUS = 'Your mystery gift, plus a little extra 🎁';

// One email for the new code (with or without the fun-fact bonus) and the revived code.
// Rules: never name the amount (it is revealed at checkout), plain short sentences, no dashes,
// and push "fill your cart first" so people arrive at checkout with things they want.
function giftEmail({ code, expiryLabel, siteUrl, kicker, title, intro, bonus }) {
  const shop = esc(siteUrl) + '/?src=mystery-email';
  const step = (n, html) => `<tr><td style="vertical-align:top;padding:0 12px 14px 0"><div style="width:28px;height:28px;border-radius:9px;background:#0a2f66;color:#fff;font-weight:800;font-size:14px;line-height:28px;text-align:center">${n}</div></td><td style="padding:2px 0 14px;font-size:15px;line-height:1.55;color:#374151">${html}</td></tr>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f6f4f0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">
<div style="display:none;max-height:0;overflow:hidden">Your code is inside. Fill your cart, then use it at checkout to see what you got.</div>
<div style="max-width:560px;margin:28px auto;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #e9e6df">
  <div style="background:#0a2f66;padding:28px 32px;text-align:center">
    <div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:#fff">Umzila</div>
    <div style="color:#c9d6ee;font-size:14px;margin-top:4px">${esc(kicker)}</div>
  </div>
  <div style="padding:30px 32px 8px">
    <h1 style="margin:0 0 10px;font-family:Georgia,serif;font-size:24px;line-height:1.25;color:#0a2f66">${esc(title)}</h1>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#374151">${intro}</p>
    <div style="border:2px dashed #e0284f;border-radius:14px;padding:20px;text-align:center;margin:0 0 8px">
      <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin-bottom:6px">Your code</div>
      <div style="font-family:'Courier New',monospace;font-size:28px;font-weight:800;letter-spacing:3px;color:#e0284f">${esc(code)}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:8px">Use it before ${esc(expiryLabel)}</div>
    </div>
    ${bonus ? `<p style="margin:12px 0 0;font-size:14px;line-height:1.55;color:#0a2f66;background:#eef2f8;border-radius:12px;padding:12px 14px">Because you read about Umzila, there is a bonus inside this code too.</p>` : ''}
    <h2 style="margin:24px 0 12px;font-size:17px;color:#16181d">How to use your gift</h2>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">
      ${step(1, '<b>Add the things you like to your cart.</b> Food, treats, gifts, anything from the stores on Umzila.')}
      ${step(2, '<b>Go to checkout.</b> Type your code in the box that says <b>“Have a code?”</b> and press <b>Apply</b>.')}
      ${step(3, '<b>See your gift.</b> It shows on your order straight away.')}
    </table>
    <div style="text-align:center;margin:10px 0 22px">
      <a href="${shop}" style="display:inline-block;background:#e0284f;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:15px 34px;border-radius:14px">Start filling my cart</a>
    </div>
    <p style="margin:0 0 24px;font-size:13px;line-height:1.55;color:#6b7280;text-align:center">Tip: pick what you really want first. Your gift is revealed when you apply the code at checkout.</p>
  </div>
  <div style="background:#f6f4f0;padding:16px 32px;text-align:center;font-size:12px;color:#6b7280">
    <a href="${esc(siteUrl)}" style="color:#0a2f66;font-weight:700;text-decoration:none">Umzila</a> · Durban's best local businesses, delivered<br>
    Questions? Reply to this email or write to <a href="mailto:support@umzila.store" style="color:#0a2f66">support@umzila.store</a>
  </div>
</div></body></html>`;
}

function buildMysteryEmail(code, expiryLabel, siteUrl) {
  return giftEmail({ code, expiryLabel, siteUrl, kicker: 'Your mystery gift is here', title: 'Here is your mystery gift code',
    intro: 'Thanks for visiting Umzila. We hid a gift inside the code below. We won’t tell you what it is yet. You find out at checkout.' });
}

function buildMysteryFunFactEmail(code, expiryLabel, siteUrl) {
  return giftEmail({ code, expiryLabel, siteUrl, kicker: 'Your mystery gift is here, with a little extra', title: 'Here is your mystery gift code',
    intro: 'Thanks for getting to know Umzila. We hid a gift inside the code below. We won’t tell you what it is yet. You find out at checkout.', bonus: true });
}

function buildReinstateEmail(code, expiryLabel, siteUrl) {
  return giftEmail({ code, expiryLabel, siteUrl, kicker: 'Your mystery gift code is back', title: 'We brought your gift back',
    intro: 'Your mystery gift code ran out before you used it, so we gave it more time. It is the same code, with a new date below.' });
}
