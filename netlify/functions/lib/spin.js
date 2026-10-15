// Spin & Win: shared server logic (docs/systems/spin-wheel.md).
// Used by spin-identify.js, spin-friend.js, spin-play.js, send-spin-emails.js
// and spin-admin.js.
//
// - GIFTS: the gift catalogue. spin.html mirrors the labels; every gift is
//   an ordinary discount_codes row, so checkout / validate-cart / PayFast
//   redeem it like any other code.
// - Spin sessions: a short-lived HMAC-signed token proving who the spinner is
//   (set by identify / friend, required by play).
// - getState(): eligibility. A paid order in the last 30 days unlocks one spin,
//   one live gift at a time, a one-time welcome-back spin, and friends
//   (never ordered) get a first-order gift.
const crypto = require('crypto');
const { mailFrom } = require('./mail');
const { unsubscribeUrl, unsubscribeHeaders } = require('./unsubscribe');

const GIFTS = {
  drink:   { emoji: '🥤', label: 'Free drink', title: 'A free cold drink', sub: 'With any Workshop order (Isiqalo Kitchen or Velaphi).' },
  pct10:   { emoji: '🏷️', label: '10% off', title: '10% off', sub: 'Your whole next order.' },
  r20:     { emoji: '💸', label: 'R20 off', title: 'R20 off', sub: 'Your next order over R60.' },
  food150: { emoji: '🤯', label: 'Food FREE', title: 'Your food, on us', sub: 'Up to R150 off your next order. You just pay delivery.' }
};
const RECENT_DAYS = 30;
const GIFT_DAYS = 5;
const WORKSHOP = ['isiqalokitchen', 'velaphishisanyama']; // stores with the drinks screen (shop.html ADDON_STORES)
const REFERRAL_MONTHLY_CAP = 5;

const SITE = () => (process.env.SITE_BASE_URL || '').replace(/\/$/, '');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstNameOf = n => { const f = String(n || '').trim().split(/\s+/)[0] || ''; return f && !/^(user|qa|test)$/i.test(f) ? f.charAt(0).toUpperCase() + f.slice(1) : ''; };
const maskEmail = e => { const [u, d] = String(e || '').split('@'); return d ? `${u[0]}•••@${d}` : ''; };
const digits = s => String(s || '').replace(/\D/g, '');

// ── Spin sessions (key derived from the service key: server-only) ──
function key() { return crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY || 'x').update('umzila-spin-session').digest(); }
function signSession(payload, minutes = 30) {
  const body = Buffer.from(JSON.stringify({ ...payload, x: Date.now() + minutes * 60000 })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', key()).update(body).digest('base64url');
}
function readSession(tok) {
  const [body, sig] = String(tok || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', key()).update(body).digest('base64url');
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.x > Date.now() ? p : null; } catch { return null; }
}

// Day 5, 23:59:59 South African time (SAST = UTC+2, no DST).
function giftExpiry(now = new Date()) {
  const sast = new Date(now.getTime() + 2 * 3600e3);
  return new Date(Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate() + GIFT_DAYS, 23, 59, 59) - 2 * 3600e3);
}
function randomCode(prefix, n) {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return prefix + Array.from(crypto.randomBytes(n), b => A[b % A.length]).join('');
}

async function isStaff(admin, email) {
  const list = String(process.env.ADMIN_EMAILS || '').toLowerCase().split(/[,;\s]+/).filter(Boolean);
  if (list.includes(String(email).toLowerCase())) return true;
  const { data } = await admin.rpc('spin_is_staff_email', { p_email: email });
  return !!data;
}

// Paid = PayFast-confirmed (pf_payment_id) or a completed R0 order.
async function paidOrders(admin, email, userId) {
  const cols = 'id, created_at, customer_name, customer_email, customer_phone, user_id, total, pf_payment_id, order_status';
  const qs = [admin.from('orders').select(cols).eq('payment_status', 'paid').ilike('customer_email', email).order('created_at', { ascending: false }).limit(50)];
  if (userId) qs.push(admin.from('orders').select(cols).eq('payment_status', 'paid').eq('user_id', userId).order('created_at', { ascending: false }).limit(50));
  const rows = (await Promise.all(qs)).flatMap(r => r.data || []);
  const seen = new Set();
  return rows.filter(o => !seen.has(o.id) && seen.add(o.id))
    .filter(o => (o.pf_payment_id || Number(o.total) === 0) && !/cancel|refund/i.test(o.order_status || ''))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

// The order card on the page: stores (not the house drinks seller), items,
// delivery + whether it was delivered / already rated.
async function orderSummary(admin, order) {
  if (!order) return null;
  const { data: items } = await admin.from('order_items').select('product_name, quantity, seller_id').eq('order_id', order.id);
  const sellerIds = [...new Set((items || []).map(i => i.seller_id).filter(Boolean))];
  const { data: sellers } = sellerIds.length ? await admin.from('sellers').select('id, shop_name, slug, is_house').in('id', sellerIds) : { data: [] };
  const real = (sellers || []).filter(s => !s.is_house);
  const realIds = new Set(real.map(s => s.id));
  const { data: del } = await admin.from('deliveries').select('id, status').eq('order_id', order.id).limit(1).maybeSingle();
  let rated = null;
  if (del) { const { data: fb } = await admin.from('delivery_feedback').select('rating').eq('delivery_id', del.id).maybeSingle(); rated = (fb && fb.rating) || null; }
  return {
    stores: real.map(s => ({ name: s.shop_name, url: '/' + s.slug, slug: s.slug })),
    items: (items || []).filter(i => realIds.has(i.seller_id)).map(i => i.product_name).filter(Boolean).slice(0, 4),
    deliveryId: del ? del.id : null,
    delivered: !!(del && del.status === 'DELIVERED'),
    date: order.created_at,
    rated
  };
}

function useUrlFor(kind, summary) {
  const slugs = (summary && summary.stores || []).map(s => s.slug);
  if (kind === 'drink') return '/' + (slugs.find(s => WORKSHOP.includes(s)) || WORKSHOP[0]);
  return slugs[0] ? '/' + slugs[0] : '/#section=workshop';
}

async function giftOfSpin(admin, spin) {
  if (!spin || !spin.discount_code_id) return null;
  const { data: dc } = await admin.from('discount_codes').select('code, used, expires_at, status').eq('id', spin.discount_code_id).maybeSingle();
  return dc || null;
}

// Eligibility for a verified email (and account). Returns { state, ... }.
async function getState(admin, { email, userId, name }) {
  const orders = await paidOrders(admin, email, userId);
  const { data: spinRows } = await admin.from('spins').select('*').ilike('email', email).eq('outcome', 'won').order('created_at', { ascending: false });
  const spins = spinRows || [];
  const newest = orders[0] || null;
  const firstName = firstNameOf(name || (newest && newest.customer_name) || (spins[0] && spins[0].name));
  const base = { firstName, emailMasked: maskEmail(email) };

  // 1. a live gift
  for (const s of spins) {
    const dc = await giftOfSpin(admin, s);
    // staff test spins have disabled codes: still shown as their live gift so the flow can be tested
    if (dc && !dc.used && (dc.status === 'active' || s.test) && new Date(dc.expires_at) > new Date()) {
      const sum = s.order_id ? await orderSummary(admin, orders.find(o => o.id === s.order_id) || { id: s.order_id, created_at: s.created_at }) : await orderSummary(admin, newest);
      return { ...base, state: 'HAS_GIFT', lastOrder: sum,
        gift: { kind: s.gift_kind, code: dc.code, expiresAt: dc.expires_at, useUrl: useUrlFor(s.gift_kind, sum), orderDate: s.order_id ? (sum && sum.date) : null, shareCode: s.share_code, test: s.test || undefined } };
    }
  }
  const lastSpin = spins[0] || null;
  const recentCut = Date.now() - RECENT_DAYS * 864e5;
  // 2. newest paid order in the last 30 days, placed after the last spin, not spun for
  const spunOrders = new Set(spins.map(s => s.order_id).filter(Boolean));
  const unlock = orders.find(o => new Date(o.created_at).getTime() >= recentCut && !spunOrders.has(o.id)
    && (!lastSpin || new Date(o.created_at) > new Date(lastSpin.created_at)));
  if (unlock) return { ...base, state: 'CAN_SPIN_ORDER', kind: 'order', orderId: unlock.id, lastOrder: await orderSummary(admin, unlock) };
  // 3. welcome back: ordered before, nothing in 30 days, never had one
  const hadRecent = orders.some(o => new Date(o.created_at).getTime() >= recentCut);
  if (orders.length && !hadRecent && !spins.some(s => s.kind === 'welcome_back'))
    return { ...base, state: 'CAN_SPIN_WELCOME_BACK', kind: 'welcome_back', lastOrder: await orderSummary(admin, newest) };
  // 4. never ordered, never spun as a friend
  if (!orders.length && !spins.some(s => s.kind === 'friend'))
    return { ...base, state: 'CAN_SPIN_FRIEND', kind: 'friend', lastOrder: null };
  // 5. nothing to spin
  let reason = null;
  const dc = await giftOfSpin(admin, lastSpin);
  if (dc) reason = dc.used ? 'used' : 'expired';
  return { ...base, state: 'NEEDS_ORDER', reason, lastOrder: await orderSummary(admin, newest) };
}

// Their personal "give a friend a spin" code (umzila.store/spin?ref=<code>).
// The newest code they already have (from a spin, or their kind='share' row),
// else a new kind='share' row (no gift) just to hold it. One link per person.
async function shareCodeFor(admin, { email, userId, name, phone }) {
  const { data: have } = await admin.from('spins').select('share_code').ilike('email', email)
    .in('outcome', ['won', 'share']).not('share_code', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (have && have.share_code) return have.share_code;
  for (let i = 0; i < 3; i++) {
    const { data, error } = await admin.from('spins').insert({
      email, user_id: userId || null, name: name || null, phone: phone || null, kind: 'share', outcome: 'share',
      share_code: crypto.randomBytes(5).toString('hex'), test: false
    }).select('share_code').single();
    if (!error) return data.share_code;
    if (error.code !== '23505') throw error;
    // a parallel request made their share row: read it back
    const { data: again } = await admin.from('spins').select('share_code').ilike('email', email).eq('kind', 'share').maybeSingle();
    if (again) return again.share_code;
  }
  return null;
}

// The discount_codes row for a gift.
async function codeRowFor(admin, kind, { email, friend, test }) {
  const row = {
    code: randomCode('SPIN', 6), email, type: 'percentage', amount: 10, scope: 'order',
    expires_at: giftExpiry().toISOString(), multi_use: false, per_user_limit: 1,
    first_order_only: !!friend, status: test ? 'disabled' : 'active'
  };
  if (kind === 'r20') Object.assign(row, { type: 'fixed', amount: 20, min_order_amount: 60 });
  if (kind === 'food150') Object.assign(row, { amount: 100, max_discount_amount: 150 });
  if (kind === 'drink') {
    const { data: house } = await admin.from('sellers').select('id').eq('is_house', true);
    const ids = (house || []).map(h => h.id);
    const { data: drinks } = ids.length ? await admin.from('products').select('id, price, sale, sale_price').in('seller_id', ids).eq('visible', true) : { data: [] };
    const list = drinks || [];
    const dearest = Math.max(0, ...list.map(p => Number(p.sale && p.sale_price ? p.sale_price : p.price) || 0));
    Object.assign(row, { amount: 100, scope: 'products', product_ids: list.map(p => p.id), max_discount_amount: dearest || 35 });
  }
  return row;
}

// ── Emails ──
const fmtDay = d => new Intl.DateTimeFormat('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(d));
function giftEmail(variant, { name, email, kind, code, expiresAt, useUrl, shareCode, friendName }) {
  const site = SITE(), g = GIFTS[kind] || GIFTS.drink, hi = firstNameOf(name);
  const use = site + (useUrl || '/') + ((useUrl || '/').includes('?') ? '&' : '?') + 'src=spin-email';
  const subj = {
    prize: `${g.emoji} ${hi ? hi + ', your' : 'Your'} ${g.label.toLowerCase()} is waiting`,
    reminder: `2 days left on your gift${hi ? ', ' + hi : ''} ${g.emoji}`,
    final: `Last day! Your gift ends tonight at midnight ${g.emoji}`,
    referral: `🎁 Your mystery gift is here${hi ? ', ' + hi : ''}`
  }[variant];
  const head = {
    prize: `You spun the wheel and got: <span style="color:#e0284f">${esc(g.title.toLowerCase())}</span> ${g.emoji}`,
    reminder: `${hi ? esc(hi) + ', your' : 'Your'} ${esc(g.title.toLowerCase())} is still waiting`,
    final: `Last day for your ${esc(g.title.toLowerCase())}`,
    referral: `Your mystery gift: <span style="color:#e0284f">R20 off</span> 🎁`
  }[variant];
  const lead = {
    prize: esc(g.sub),
    reminder: `It ends on ${esc(fmtDay(expiresAt))} at midnight. ${esc(g.sub)}`,
    final: `It ends tonight at 23:59. ${esc(g.sub)}`,
    referral: `${esc(friendName || 'Your friend')} just placed their first Umzila order with the spin you sent. Here's R20 off your next order over R60, just for you.`
  }[variant];
  const howTo = variant === 'referral'
    ? 'Sign in (or create your account) with this email, add your order, and type the code at checkout.'
    : 'Add your order, go to checkout, and use this email address. Your code is added at checkout, or type it in the discount box.';
  const shareRow = shareCode && variant !== 'referral' ? `<p style="margin:18px 0 0;font-size:13px;color:#6b7280;line-height:1.6">🎁 <b>Give a friend a spin:</b> <a href="${site}/spin?ref=${encodeURIComponent(shareCode)}" style="color:#0a2f66">${site.replace(/^https?:\/\//, '')}/spin?ref=${esc(shareCode)}</a>. If they order, you unlock a mystery gift.</p>` : '';
  const unsub = variant === 'prize' ? null : unsubscribeUrl(site, email);
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f2f3f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden">${esc(g.title)} with code ${esc(code)}. Ends ${esc(fmtDay(expiresAt))}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f7"><tr><td align="center" style="padding:26px 14px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:22px;overflow:hidden">
<tr><td style="padding:26px 26px 6px"><img src="${site}/umzila.webp" alt="umzila" width="92" style="display:block;border:0"></td></tr>
<tr><td style="padding:10px 26px 0">
  <p style="margin:0 0 4px;font-size:15px;color:#6b7280">${hi ? 'Hi ' + esc(hi) + ' 👋' : 'Hi there 👋'}</p>
  <h1 style="margin:0 0 10px;font-size:26px;line-height:1.2;color:#0a2f66;font-weight:800;letter-spacing:-.4px">${head}</h1>
  <p style="margin:0;font-size:15px;line-height:1.6;color:#374151">${lead}</p>
  <div style="margin:20px 0 6px;padding:18px;border-radius:16px;background:#f6f7fb;text-align:center">
    <div style="font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#6b7280">Your code</div>
    <div style="font-size:28px;font-weight:800;letter-spacing:3px;color:#0a2f66;margin:6px 0 4px;font-family:ui-monospace,Menlo,monospace">${esc(code)}</div>
    <div style="font-size:12.5px;color:#6b7280">Valid until ${esc(fmtDay(expiresAt))}, 23:59 · one code per order</div>
  </div>
  <div style="text-align:center;margin:20px 0 6px"><a href="${use}" style="display:inline-block;background:#e0284f;color:#ffffff;padding:15px 34px;border-radius:999px;text-decoration:none;font-weight:800;font-size:16px">${variant === 'referral' ? 'Use my R20 →' : 'Use it now →'}</a></div>
  <p style="margin:12px 0 0;font-size:13px;color:#6b7280;line-height:1.6;text-align:center">${esc(howTo)}</p>
  ${shareRow}
</td></tr>
<tr><td style="padding:22px 26px 24px;font-size:12px;color:#9ca3af;line-height:1.6;text-align:center">Umzila · Durban's local favourites, delivered${unsub ? `<br><a href="${unsub}" style="color:#9ca3af">Unsubscribe from reminders</a>` : ''}</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${hi ? 'Hi ' + hi + ',' : 'Hi there,'}\n\n${head.replace(/<[^>]+>/g, '')}\n${lead.replace(/<[^>]+>/g, '')}\n\nYour code: ${code} (valid until ${fmtDay(expiresAt)}, 23:59)\n${use}\n\n${howTo}${unsub ? '\n\nUnsubscribe: ' + unsub : ''}`;
  return { subject: subj, html, text, headers: unsub ? unsubscribeHeaders(unsub) : undefined };
}
async function sendGiftEmail(variant, to, data) {
  if (!process.env.RESEND_API_KEY || !SITE()) return false;
  const m = giftEmail(variant, { ...data, email: to });
  const body = { ...mailFrom('Umzila', 'hello', variant === 'prize' ? undefined : 'news'), to: [to], subject: m.subject, html: m.html, text: m.text };
  if (m.headers) body.headers = m.headers;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) console.error('spin email', variant, r.status, await r.text());
    return r.ok;
  } catch (e) { console.error('spin email', variant, e); return false; }
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (code, body) => ({ statusCode: code, headers: CORS, body: JSON.stringify(body) });

module.exports = {
  GIFTS, WORKSHOP, REFERRAL_MONTHLY_CAP, esc, firstNameOf, maskEmail, digits,
  signSession, readSession, giftExpiry, randomCode, isStaff, paidOrders, orderSummary, useUrlFor,
  getState, shareCodeFor, codeRowFor, giftEmail, sendGiftEmail, reply, CORS
};
