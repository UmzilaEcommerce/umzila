// netlify/functions/lib/order-alert-mail.js
//
// The "new paid order" emails to the STORE and to the ADMINS (2026-11-25).
// Called from lib/complete-order-payment.js (sendSellerOrderNotifications /
// sendAdminOrderNotification) for goods orders — service orders keep their own
// email there. Everything is read fresh from the database (the full order row,
// its delivery + tracking token, quote, stores, store prices, open/closed state)
// so the emails say exactly where the order stands:
//   * WHEN: the delivery run (timeslot) — store: "have it ready by 12:00" (prep
//     from the cut-off), admin: the run window, cut-off and rider-notice time; or
//     "now" / "when the store opens at 08:00" for orders without a run.
//   * WHO: customer name, phone (tap to call / WhatsApp), email (admin), address,
//     the rider note.
//   * WHAT: every line with the picks / option breakdown (order line `size`),
//     per store; Umzila Drinks (house add-ons) only in the admin email — a store
//     never sees them (CLAUDE.md house add-ons rule).
//   * MONEY (admin): items, discount + code, delivery, priority, tip, total, how it
//     was paid, and what each store is owed (finance store prices; estimate flagged).
// Customer copy promises a DISPATCH time only — store/admin copy may show the window.
// Never throws: load() returns what it could read; builders cope with gaps.
const TZ = 'Africa/Johannesburg';
const NAVY = '#0a2f66';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => 'R' + (Number(n) || 0).toFixed(2);
const hhmm = v => v ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(v)) : '';
const ymd = v => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(v));
function dayWord(v) {
  if (!v) return '';
  const d = ymd(v), today = ymd(new Date()), tmr = ymd(new Date(Date.now() + 86400000));
  if (d === today) return 'today';
  if (d === tmr) return 'tomorrow';
  return new Intl.DateTimeFormat('en-ZA', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short' }).format(new Date(v));
}
const firstName = n => String(n || '').trim().split(/\s+/)[0] || 'Customer';
const qtyOf = i => parseInt(i.quantity || i.qty || 1, 10) || 1;
const nameOf = i => i.title || i.name || i.item || 'Item';
const priceOf = i => Number(i.price || i.unit_price || 0);
const pidOf = i => i.product_id || i.id;
function phoneLinks(p) {
  const d = String(p || '').replace(/[^\d+]/g, '');
  if (!d) return '<span style="color:#9ca3af">no number given</span>';
  const wa = d.replace(/^\+/, '').replace(/^0/, '27');
  return `<a href="tel:${esc(d)}" style="color:${NAVY};font-weight:700;text-decoration:none">${esc(p)}</a> &nbsp;·&nbsp; <a href="https://wa.me/${esc(wa)}" style="color:#16a34a;font-weight:700;text-decoration:none">WhatsApp</a>`;
}
const PAY = { cc: 'Card', dc: 'Card', token: 'Saved card', ap: 'Apple Pay', gp: 'Google Pay', sp: 'Samsung Pay', cp: 'Capitec Pay', ef: 'Instant EFT', zero: 'Nothing to pay (R0)', cash: 'Cash (manual)', pos: 'Card machine (manual)', eft_manual: 'EFT (manual)' };
function paidWith(o) {
  if (o.payment_method_code && PAY[o.payment_method_code]) return PAY[o.payment_method_code];
  if (o.payment_option_key) return String(o.payment_option_key).replace(/_/g, ' ');
  return 'PayFast';
}

// ---------- load everything once per order ----------
async function load(supabase, orderId) {
  const ctx = { order: null, delivery: null, quote: null, products: {}, sellers: {}, closed: [], cutoffMin: 15, noticeMin: 30, storePrices: {}, defaultMarkup: 9 };
  try {
    const { data: o } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
    ctx.order = o || null;
    if (!o) return ctx;
    const items = Array.isArray(o.items) ? o.items : [];
    const pids = [...new Set(items.map(pidOf).filter(Boolean))];
    const [dl, prods, ts, fin, closed] = await Promise.all([
      supabase.from('deliveries').select('id, status, tracking_token').eq('order_id', o.id).maybeSingle(),
      pids.length ? supabase.from('products').select('id, seller_id, name, listing_type').in('id', pids) : Promise.resolve({ data: [] }),
      supabase.from('site_settings').select('value').eq('key', 'timeslots').maybeSingle(),
      supabase.from('site_settings').select('value').eq('key', 'finance').maybeSingle(),
      supabase.rpc('order_closed_store', { p_order_id: o.id })
    ]);
    ctx.delivery = (dl && dl.data) || null;
    (prods.data || []).forEach(p => { ctx.products[p.id] = p; });
    const t = ts && ts.data && ts.data.value;
    if (t) { if (Number(t.cutoff_minutes) >= 0) ctx.cutoffMin = Number(t.cutoff_minutes); if (t.rider_notice_minutes != null && Number(t.rider_notice_minutes) >= 0) ctx.noticeMin = Number(t.rider_notice_minutes); }
    const f = fin && fin.data && fin.data.value;
    if (f) { ctx.storePrices = f.store_prices || {}; if (Number(f.default_markup_percent) >= 0) ctx.defaultMarkup = Number(f.default_markup_percent); }
    ctx.closed = (closed && !closed.error && closed.data) || [];
    const sids = [...new Set(Object.values(ctx.products).map(p => p.seller_id).filter(Boolean))];
    if (sids.length) {
      const { data: ss } = await supabase.from('sellers').select('id, shop_name, slug, is_house, whatsapp_number').in('id', sids);
      (ss || []).forEach(s => { ctx.sellers[s.id] = s; });
    }
    if (o.delivery_quote_id) {
      const { data: q } = await supabase.from('delivery_quotes').select('distance_km, duration_min, priority_fee').eq('id', o.delivery_quote_id).maybeSingle();
      ctx.quote = q || null;
    }
  } catch (e) { console.warn('order-alert-mail load', e && e.message); }
  return ctx;
}

// ---------- shared pieces ----------
function sellerOf(ctx, item) { const p = ctx.products[pidOf(item)]; return p ? ctx.sellers[p.seller_id] : null; }
function groupByStore(ctx) {
  const g = {};
  (Array.isArray(ctx.order.items) ? ctx.order.items : []).forEach(i => {
    const s = sellerOf(ctx, i);
    const k = s ? s.id : 'unknown';
    (g[k] = g[k] || { seller: s, items: [] }).items.push(i);
  });
  return g;
}
// What the store is owed for one line: finance store price (exact) or price ÷ (1 + markup) (estimate).
function owedFor(ctx, i) {
  const pid = pidOf(i), vid = i.variant_id;
  const exact = (vid && ctx.storePrices[pid + ':' + vid] != null) ? ctx.storePrices[pid + ':' + vid] : ctx.storePrices[pid];
  if (exact != null && Number.isFinite(Number(exact))) return { amount: Number(exact) * qtyOf(i), estimate: false };
  return { amount: (Number(i.list_price || priceOf(i)) / (1 + ctx.defaultMarkup / 100)) * qtyOf(i), estimate: true };
}
function isPriority(ctx) { return Number(ctx.order.priority_fee || (ctx.quote && ctx.quote.priority_fee) || 0) > 0; }
function run(ctx) {
  const o = ctx.order;
  if (!o.slot_id || !o.slot_window_start) return null;
  const start = new Date(o.slot_window_start).getTime();
  return { start: o.slot_window_start, end: o.slot_window_end, cutoff: new Date(start - ctx.cutoffMin * 60000).toISOString(), notice: new Date(start - ctx.noticeMin * 60000).toISOString(), needsAttention: !!o.slot_needs_attention, early: !!o.dispatch_released_at };
}
function closedFor(ctx, sellerId) {
  const c = (ctx.closed || []).find(x => !sellerId || x.shop_name === (ctx.sellers[sellerId] || {}).shop_name);
  return c || null;
}
function trackLink(ctx, site) {
  return ctx.delivery && ctx.delivery.tracking_token ? `${site}/track.html?order=${encodeURIComponent(ctx.order.id)}&t=${encodeURIComponent(ctx.delivery.tracking_token)}` : '';
}
function linesHtml(items, opts) {
  return items.map(i => {
    const sz = i.size && !/^one size$/i.test(String(i.size)) ? String(i.size) : '';
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #eef0f4;vertical-align:top;width:44px"><div style="width:36px;height:36px;border-radius:10px;background:${NAVY};color:#fff;font-weight:800;font-size:15px;text-align:center;line-height:36px">${qtyOf(i)}×</div></td>
      <td style="padding:10px 0 10px 10px;border-bottom:1px solid #eef0f4;vertical-align:top">
        <div style="font-size:15px;font-weight:700;color:#111827">${esc(nameOf(i))}</div>
        ${sz ? `<div style="font-size:13.5px;color:#374151;margin-top:2px">${esc(sz)}</div>` : ''}
      </td>
      ${opts && opts.price ? `<td style="padding:10px 0;border-bottom:1px solid #eef0f4;vertical-align:top;text-align:right;white-space:nowrap;font-size:14px;font-weight:700;color:${NAVY}">${money(priceOf(i) * qtyOf(i))}</td>` : ''}
    </tr>`;
  }).join('');
}
const row = (k, v) => `<tr><td style="padding:5px 12px 5px 0;color:#6b7280;font-size:13px;vertical-align:top;white-space:nowrap">${k}</td><td style="padding:5px 0;color:#111827;font-size:14px;font-weight:600">${v}</td></tr>`;
const label = t => `<div style="font-size:11px;font-weight:800;color:#6b7280;text-transform:uppercase;letter-spacing:.8px;margin:22px 0 8px">${t}</div>`;
const box = (inner, bg, border) => `<div style="background:${bg || '#f8fafc'};border:1px solid ${border || '#e5e7eb'};border-radius:12px;padding:12px 16px">${inner}</div>`;
function shell(site, top, body, footer) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f4f9;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
<div style="max-width:600px;margin:24px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)">
${top}
<div style="padding:22px 26px 26px">${body}</div>
<div style="background:#f8fafc;padding:14px 26px;text-align:center;font-size:12px;color:#9ca3af;border-top:1px solid #eef0f4">${footer || `<a href="${esc(site)}" style="color:${NAVY};text-decoration:none;font-weight:700">Umzila</a>`}</div>
</div></body></html>`;
}
function customerBlock(ctx, withEmail) {
  const o = ctx.order;
  const addr = [o.delivery_address, o.city].filter(Boolean).join(', ');
  const note = String(o.delivery_instructions || o.notes || '').trim();
  return `<table style="border-collapse:collapse;width:100%">
    ${row('Name', esc(o.customer_name || 'Customer'))}
    ${row('Phone', phoneLinks(o.customer_phone))}
    ${withEmail && o.customer_email ? row('Email', `<a href="mailto:${esc(o.customer_email)}" style="color:${NAVY};text-decoration:none">${esc(o.customer_email)}</a>`) : ''}
    ${addr ? row('Deliver to', esc(addr)) : ''}
  </table>${note ? `<div style="margin-top:10px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:9px 12px;font-size:14px;color:#78350f;font-weight:600">📝 Customer note: ${esc(note)}</div>` : ''}`;
}

// ---------- STORE email ----------
function storeEmail(ctx, seller, items, site) {
  const o = ctx.order, r = run(ctx), cl = closedFor(ctx, seller.id);
  const ref = o.order_number || o.m_payment_id || '';
  const others = Object.values(groupByStore(ctx)).map(g => g.seller).filter(s => s && s.id !== seller.id && !s.is_house).map(s => s.shop_name);
  let whenBig, whenSmall, tone = { bg: '#ecfdf5', border: '#a7f3d0', ink: '#065f46' }, subjectWhen;
  if (r && r.needsAttention) {
    whenBig = 'Don’t start yet'; whenSmall = 'Umzila is confirming a delivery time with the customer. We’ll email you when it’s set.';
    tone = { bg: '#fef2f2', border: '#fecaca', ink: '#991b1b' }; subjectWhen = 'wait for a time';
  } else if (r && r.early) {
    whenBig = 'Prepare now'; whenSmall = 'This order was sent to riders early. A rider is on the way.'; subjectWhen = 'prepare now';
  } else if (r) {
    whenBig = `Ready by ${hhmm(r.start)} ${dayWord(r.start)}`;
    whenSmall = `${hhmm(r.start)} delivery round. Start preparing at ${hhmm(r.cutoff)}; the rider collects at ${hhmm(r.start)}.`;
    tone = { bg: '#eff6ff', border: '#bfdbfe', ink: '#1e3a8a' }; subjectWhen = `ready by ${hhmm(r.start)} ${dayWord(r.start)}`;
  } else if (cl && cl.opens_at) {
    whenBig = `Make it when you open — ${hhmm(cl.opens_at)} ${dayWord(cl.opens_at)}`; whenSmall = 'This was ordered while you were closed. A rider is sent once you open.';
    tone = { bg: '#fff7ed', border: '#fed7aa', ink: '#9a3412' }; subjectWhen = `make at ${hhmm(cl.opens_at)}`;
  } else {
    whenBig = 'Prepare now'; whenSmall = 'A rider is being sent to collect it.'; subjectWhen = 'prepare now';
  }
  const top = `<div style="background:${NAVY};padding:20px 26px;color:#fff">
    <div style="font-size:12px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;opacity:.75">${esc(seller.shop_name || 'Your store')} · new order</div>
    <div style="font-size:24px;font-weight:800;margin-top:4px">${esc(firstName(o.customer_name))} · ${items.reduce((s, i) => s + qtyOf(i), 0)} item${items.reduce((s, i) => s + qtyOf(i), 0) === 1 ? '' : 's'}</div>
    <div style="font-size:13px;opacity:.85;margin-top:4px">Order ${esc(ref)}</div>
  </div>`;
  const body =
    box(`<div style="font-size:20px;font-weight:800;color:${tone.ink}">⏰ ${esc(whenBig)}</div><div style="font-size:14px;color:${tone.ink};margin-top:4px;line-height:1.5">${esc(whenSmall)}</div>`, tone.bg, tone.border) +
    (isPriority(ctx) ? `<div style="margin-top:10px;background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:9px 12px;font-size:14px;color:#92400e;font-weight:700">⚡ Priority order — please have it ready first.</div>` : '') +
    label('What to make') +
    `<table style="border-collapse:collapse;width:100%">${linesHtml(items)}</table>` +
    label('Customer') + box(customerBlock(ctx, false)) +
    (others.length ? `<div style="margin-top:12px;font-size:13.5px;color:#374151">🛵 The same rider also collects from <b>${esc(others.join(' & '))}</b> for this order.</div>` : '') +
    label('Hand-over') +
    `<ol style="margin:0;padding-left:20px;color:#374151;font-size:14px;line-height:1.7">
      <li>Pack it and write <b>${esc(ref.slice(-9))}</b> and <b>${esc(firstName(o.customer_name))}</b> on the bag.</li>
      <li>Give it to the Umzila rider who asks for this order. Umzila delivers it; nothing to tap.</li>
      <li>Something missing or a problem? WhatsApp Umzila on <a href="https://wa.me/27797662768" style="color:${NAVY}">079 766 2768</a> with the order number.</li>
    </ol>` +
    `<div style="text-align:center;margin-top:22px"><a href="${esc(site)}/seller-dashboard.html" style="display:inline-block;background:${NAVY};color:#fff;padding:13px 30px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px">Open my orders →</a></div>`;
  return {
    subject: `New order — ${subjectWhen} — ${firstName(o.customer_name)} — ${ref}`,
    html: shell(site, top, body, `Umzila Sellers · <a href="${esc(site)}" style="color:${NAVY};text-decoration:none">umzila.store</a>`)
  };
}

// ---------- ADMIN email ----------
function adminEmail(ctx, site) {
  const o = ctx.order, r = run(ctx);
  const ref = o.order_number || o.m_payment_id || '';
  const groups = Object.values(groupByStore(ctx));
  const storeNames = groups.map(g => g.seller ? g.seller.shop_name : 'Unknown store').filter((n, i, a) => a.indexOf(n) === i);
  const manual = o.source === 'manual';
  let when, whenTone = '#eff6ff', whenInk = '#1e3a8a', subjWhen;
  if (r && r.needsAttention) { when = `⚠️ NEEDS ATTENTION — paid after the cut-off with no later run. Pick a run or refund it (Admin → Delivery Times).`; whenTone = '#fef2f2'; whenInk = '#991b1b'; subjWhen = 'NEEDS ATTENTION'; }
  else if (r) {
    when = `<b>${hhmm(r.start)}–${hhmm(r.end)} run, ${esc(dayWord(r.start))}</b><br><span style="font-size:13px">Cut-off ${hhmm(r.cutoff)} · riders get it at ${hhmm(r.notice)} · leaves the store by ${hhmm(r.start)}${r.early ? ' · <b>sent to riders early</b>' : ''}</span>`;
    subjWhen = `${hhmm(r.start)} run ${dayWord(r.start)}`;
  } else {
    const cl = closedFor(ctx, null);
    when = cl && cl.opens_at ? `<b>After-hours</b> — ${esc(cl.shop_name || 'a store')} is closed; made when it opens at ${hhmm(cl.opens_at)} ${esc(dayWord(cl.opens_at))}.` : (ctx.delivery ? '<b>Now</b> — no delivery time; a rider is being sent.' : '<b>No Umzila delivery</b> (collection, service or self-delivered).');
    subjWhen = cl && cl.opens_at ? `after-hours ${hhmm(cl.opens_at)}` : 'now';
    if (cl && cl.opens_at) { whenTone = '#fff7ed'; whenInk = '#9a3412'; }
  }
  const delivery = Number(o.shipping_cost || 0), prio = Number(o.priority_fee || 0), tip = Number(o.tip_amount || 0), disc = Number(o.discount || 0);
  const itemsSum = (Array.isArray(o.items) ? o.items : []).reduce((s, i) => s + priceOf(i) * qtyOf(i), 0);
  const top = `<div style="background:linear-gradient(135deg,${NAVY},#1a4f8a);padding:22px 26px;color:#fff">
    <div style="font-size:12px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#ffd700">💰 Cha-ching${manual ? ' · manual order' : ''}</div>
    <div style="font-size:30px;font-weight:900;margin-top:2px">${money(o.total)}</div>
    <div style="font-size:14px;opacity:.9;margin-top:2px">${esc(o.customer_name || 'Customer')} · ${esc(storeNames.join(' + '))}</div>
    <div style="font-size:12.5px;opacity:.75;margin-top:4px">${esc(ref)} · paid ${esc(hhmm(o.paid_at || new Date()))} with ${esc(paidWith(o))}${o.source && !manual ? ' · from ' + esc(o.source) : ''}</div>
  </div>`;
  const storesHtml = groups.map(g => {
    const s = g.seller, house = s && s.is_house;
    let owed = 0, est = false;
    g.items.forEach(i => { const w = owedFor(ctx, i); owed += w.amount; est = est || w.estimate; });
    return `<div style="border:1px solid #e5e7eb;border-radius:12px;padding:10px 14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;gap:8px;font-weight:800;color:${NAVY};font-size:14px"><span>🏪 ${esc(s ? s.shop_name : 'Unknown store')}${house ? ' <span style="font-weight:600;color:#6b7280">(house drinks — ride along; the store never sees them)</span>' : ''}</span></div>
      <table style="border-collapse:collapse;width:100%">${linesHtml(g.items, { price: true })}</table>
      <div style="font-size:12.5px;color:#6b7280;margin-top:6px">${house ? 'Drinks cost' : 'Store is owed'} about <b style="color:#111827">${money(owed)}</b>${est ? ' (estimate — no store price set for some items)' : ''}${s && s.whatsapp_number && !house ? ` · store ${phoneLinks(s.whatsapp_number)}` : ''}</div>
    </div>`;
  }).join('');
  const tl = trackLink(ctx, site);
  const flags = [];
  if (isPriority(ctx)) flags.push('⚡ PRIORITY — first drop-off on the trip');
  if (o.payment_flag) flags.push('🚩 Payment flag: ' + o.payment_flag.replace(/_/g, ' '));
  if (ctx.quote && ctx.quote.distance_km != null) flags.push(`🛣️ ${Number(ctx.quote.distance_km).toFixed(1)} km by road`);
  const body =
    box(`<div style="font-size:15px;color:${whenInk};line-height:1.5">🕒 ${when}</div>`, whenTone, '#dbeafe') +
    (flags.length ? `<div style="margin-top:10px;font-size:13.5px;color:#374151;line-height:1.7">${flags.map(esc).join('<br>')}</div>` : '') +
    label('Customer') + box(customerBlock(ctx, true)) +
    label(`Stores (${groups.length})`) + storesHtml +
    label('Money') +
    box(`<table style="border-collapse:collapse;width:100%">
      ${row('Items', money(itemsSum))}
      ${disc > 0 ? row('Discount', '−' + money(disc) + (o.coupon_code ? ' · code ' + esc(o.coupon_code) : '')) : ''}
      ${row('Delivery', money(delivery - prio > 0 ? delivery - prio : delivery))}
      ${prio > 0 ? row('Priority', money(prio)) : ''}
      ${tip > 0 ? row('Tip', money(tip)) : ''}
      ${row('<b>Total paid</b>', `<b>${money(o.total)}</b> · ${esc(paidWith(o))}`)}
    </table>`) +
    `<div style="text-align:center;margin-top:22px">
      ${tl ? `<a href="${esc(tl)}" style="display:inline-block;background:#16a34a;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700;font-size:14px;margin:4px">Live tracking →</a>` : ''}
      <a href="${esc(site)}/logistics.html" style="display:inline-block;background:${NAVY};color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700;font-size:14px;margin:4px">Logistics →</a>
    </div>`;
  return {
    subject: `💰 ${money(o.total)} — ${subjWhen} — ${firstName(o.customer_name)} — ${storeNames.join(' + ')} — ${ref}`,
    html: shell(site, top, body, 'Umzila admin alert')
  };
}

module.exports = { load, storeEmail, adminEmail };
