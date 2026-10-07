// netlify/functions/request-delivery-area.js
//
// "Notify me when you deliver here" — a buyer whose address is outside every
// delivery zone (admin → Service Areas) can't check out; instead they tap
// this and the founder gets their name, contact, address and what they
// wanted to order, to decide where to expand (2026-10-04, founder decision:
// no default fee outside the zones). Saved to delivery_area_requests; the
// admin email goes to ADMIN_NOTIFY_EMAIL.
//
// POST { name, email, phone, address, city, postal_code, province, lat, lon, reason, cart:[{ id, qty, size }] }
// → 200 { ok:true, duplicate? }
// Cart lines are re-read from products (names/prices are never trusted from
// the browser). The same email + address within 24 h isn't saved or emailed twice.
const { createClient } = require('@supabase/supabase-js');
const { checkEmail, checkPhone } = require('./lib/contact-check');
const { mailFrom } = require('./lib/mail'); // sender: mail.umzila.store, replies to @umzila.store

const headers = { 'Content-Type': 'application/json' };
const fail = (statusCode, error) => ({ statusCode, headers, body: JSON.stringify({ error }) });
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return fail(400, 'Invalid request'); }

  const email = str(b.email, 200).toLowerCase();
  const address = str(b.address, 300);
  if (!email) return fail(400, 'Enter your email so we can let you know.');
  const emCheck = checkEmail(email);
  if (!emCheck.ok) return fail(400, emCheck.error);
  if (!address) return fail(400, 'Enter your address first.');
  const lat = Number(b.lat), lon = Number(b.lon);
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    // Optional sign-in, from the session token (never from the body).
    let userId = null;
    const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token) { const { data } = await supabase.auth.getUser(token); userId = (data && data.user && data.user.id) || null; }

    // Same person + same address in the last day → already noted.
    const since = new Date(Date.now() - 86400000).toISOString();
    const { data: recent } = await supabase.from('delivery_area_requests').select('id')
      .eq('email', email).ilike('address', address).gte('created_at', since).limit(1);
    if (recent && recent.length) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, duplicate: true }) };
    const { count: todayCount } = await supabase.from('delivery_area_requests').select('id', { count: 'exact', head: true })
      .eq('email', email).gte('created_at', since);
    if ((todayCount || 0) >= 5) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, duplicate: true }) };

    // Cart snapshot from the real listings.
    const lines = Array.isArray(b.cart) ? b.cart.slice(0, 40) : [];
    const ids = [...new Set(lines.map(l => String(l.id || l.product_id || '')).filter(id => /^[0-9a-f-]{36}$/i.test(id)))];
    let cart = [], cartTotal = 0;
    if (ids.length) {
      const { data: prods } = await supabase.from('products').select('id, name, price, sale, sale_price, seller_id, sellers(shop_name)').in('id', ids);
      const byId = Object.fromEntries((prods || []).map(p => [p.id, p]));
      cart = lines.map(l => {
        const p = byId[String(l.id || l.product_id)];
        if (!p) return null;
        const qty = Math.max(1, Math.min(99, parseInt(l.qty || l.quantity || 1, 10) || 1));
        const price = p.sale && Number(p.sale_price) > 0 ? Number(p.sale_price) : Number(p.price);
        cartTotal += price * qty;
        return { product_id: p.id, name: p.name, store: p.sellers && p.sellers.shop_name, qty, price, size: str(l.size, 40) || null };
      }).filter(Boolean);
    }

    const row = {
      user_id: userId,
      name: str(b.name, 120) || null,
      email,
      phone: (b.phone && checkPhone(b.phone).ok) ? checkPhone(b.phone).value : (str(b.phone, 40) || null),
      address,
      city: str(b.city, 120) || null,
      postal_code: str(b.postal_code, 20) || null,
      province: str(b.province, 60) || null,
      lat: hasPoint ? lat : null,
      lon: hasPoint ? lon : null,
      reason: str(b.reason, 300) || null,
      cart,
      cart_total: Math.round(cartTotal * 100) / 100
    };
    const { error: insErr } = await supabase.from('delivery_area_requests').insert(row);
    if (insErr) { console.error('request-delivery-area insert', insErr.message); return fail(500, 'Could not save your request. Please try again.'); }

    // Tell the founder (never blocks the buyer's confirmation).
    const RESEND = process.env.RESEND_API_KEY;
    const to = process.env.ADMIN_NOTIFY_EMAIL || 'umzilaecommerce@gmail.com';
    if (RESEND) {
      const map = hasPoint ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=13/${lat}/${lon}` : '';
      const items = cart.length
        ? cart.map(c => `<li>${esc(c.qty)} × ${esc(c.name)}${c.store ? ` <span style="color:#6b7280">(${esc(c.store)})</span>` : ''} — R${esc(c.price.toFixed(2))}</li>`).join('')
        : '<li>(cart empty)</li>';
      const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
        <h2 style="color:#0a2f66;margin:0 0 6px">Someone wants delivery outside your area</h2>
        <p style="color:#4b5563;margin:0 0 14px">They couldn't check out because this address is outside every delivery zone.</p>
        <table style="font-size:14px;border-collapse:collapse">
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Name</td><td>${esc(row.name || '—')}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Email</td><td>${esc(email)}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Phone</td><td>${esc(row.phone || '—')}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Address</td><td>${esc([address, row.city, row.postal_code, row.province].filter(Boolean).join(', '))}${map ? ` · <a href="${map}">map</a>` : ''}</td></tr>
          <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Why</td><td>${esc(row.reason || 'Outside the delivery zones')}</td></tr>
        </table>
        <p style="margin:14px 0 4px;font-weight:700">Their cart (R${esc(row.cart_total.toFixed(2))})</p>
        <ul style="margin:0;padding-left:18px">${items}</ul>
        <p style="color:#6b7280;font-size:12px;margin-top:16px">All requests: admin → Service Areas → Delivery requests. Add or resize a zone there to start delivering to this area.</p>
      </div>`;
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...mailFrom('Umzila', 'orders'), to: [to], reply_to: email, subject: `Delivery request: ${row.city || address}`.slice(0, 120), html })
        });
        if (!res.ok) console.warn('request-delivery-area: email failed', res.status, await res.text());
      } catch (e) { console.warn('request-delivery-area: email error', e.message); }
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error('request-delivery-area error', e);
    return fail(500, 'Could not save your request. Please try again.');
  }
};
