// Store promo pop-up (shop.html STORE_PROMOS) → one personal, one-off code.
// POST { slug, email } → { code, until } (and emails the code).
//
// One code per email per promo (asking again returns the same code), locked
// to that email, single use, only on that store, no account needed — the
// same shape as the promo email's codes, so both count toward the promo's
// order cap. Codes are plain discount_codes rows (type 'percentage',
// seller_id, expires_at = the promo end), validated by lib/discounts.js like
// any other code. A promo ends by date; after that this returns 410 and the
// pop-up never shows (it checks the same date).
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { checkEmail } = require('./lib/contact-check');
const { mailFrom } = require('./lib/mail');

// slug → promo. Keep the dates in sync with shop.html STORE_PROMOS.
const PROMOS = {
  velaphishisanyama: {
    percent: 10,
    ends: '2026-10-10T18:00:00+02:00',
    maxOrders: 100,          // codes actually used across this promo
    prefix: 'VELAPHI',
    label: 'Workshop Shisanyama'
  }
};

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const reply = (code, body) => ({ statusCode: code, headers: CORS, body: JSON.stringify(body) });
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, {});
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }

  const slug = String(b.slug || '').toLowerCase();
  const promo = PROMOS[slug];
  if (!promo) return reply(404, { error: 'No promo here.' });
  const ends = new Date(promo.ends);
  if (Date.now() >= ends.getTime()) return reply(410, { error: 'This promo has ended.' });

  const em = checkEmail(b.email);
  if (!em.ok) return reply(400, { error: em.error, suggestion: em.suggestion || null });
  const email = em.value;

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: seller, error: sErr } = await admin.from('sellers').select('id, shop_name').eq('slug', slug).maybeSingle();
  if (sErr || !seller) return reply(500, { error: 'Something went wrong — please try again.' });

  const promoCodes = (cols, opts) => admin.from('discount_codes').select(cols, opts)
    .eq('seller_id', seller.id).eq('type', 'percentage').eq('expires_at', ends.toISOString()).like('code', promo.prefix + '%');

  // Already has one → same code again
  const { data: mine } = await promoCodes('code, used').eq('email', email).limit(1).maybeSingle();
  if (mine) {
    if (mine.used) return reply(409, { error: 'You’ve already used your code for this promo — thank you!' });
    return reply(200, { code: mine.code, until: promo.ends, again: true });
  }

  const { count: usedCount } = await promoCodes('id', { count: 'exact', head: true }).eq('used', true);
  if ((usedCount || 0) >= promo.maxOrders) return reply(410, { error: `All ${promo.maxOrders} promo orders have been claimed.` });

  let code = null;
  for (let i = 0; i < 4 && !code; i++) {
    const c = promo.prefix + crypto.randomBytes(4).toString('hex').slice(0, 5).toUpperCase();
    const { error } = await admin.from('discount_codes').insert({
      code: c, amount: promo.percent, type: 'percentage', email, seller_id: seller.id,
      expires_at: ends.toISOString(), multi_use: false, per_user_limit: 1, scope: 'order', status: 'active'
    });
    if (!error) code = c;
    else if (error.code !== '23505') { console.error('claim-store-promo insert', error); break; }
  }
  if (!code) return reply(500, { error: 'Something went wrong — please try again.' });

  // Email it too (best effort — the pop-up already shows the code)
  const SITE = (process.env.SITE_BASE_URL || '').replace(/\/$/, '');
  if (process.env.RESEND_API_KEY && SITE) {
    const until = ends.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const store = `${SITE}/${slug}`;
    const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:24px auto;padding:26px;border:1px solid #eee;border-radius:14px">
<p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#e0284f">${esc(seller.shop_name)} · on Umzila</p>
<h2 style="margin:0 0 12px;color:#1a1a1a">Here's your ${promo.percent}% off code 🔥</h2>
<div style="border:2px dashed #e0284f;border-radius:12px;padding:16px;text-align:center;margin:16px 0;background:#fff7f8">
<div style="font-size:26px;font-weight:800;color:#e0284f;letter-spacing:3px;font-family:monospace">${esc(code)}</div>
<div style="font-size:12px;color:#888;margin-top:4px">Any ${esc(seller.shop_name)} order · use with this email · until ${esc(until)}</div></div>
<p style="color:#444;line-height:1.6;font-size:15px">Add your plate → checkout → type the code in the discount box. No account needed. Store closed? Order anyway — it's prepared first when they open.</p>
<p style="text-align:center;margin:20px 0"><a href="${store}" style="background:#e0284f;color:#fff;padding:13px 32px;border-radius:999px;text-decoration:none;font-weight:700">Order now &rarr;</a></p></div>`;
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...mailFrom('Umzila', 'orders'), to: [email], subject: `Your ${promo.percent}% off ${seller.shop_name} code: ${code}`, html })
      });
    } catch (e) { console.error('claim-store-promo email', e); }
  }
  return reply(200, { code, until: promo.ends });
};
