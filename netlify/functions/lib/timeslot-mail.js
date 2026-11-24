// netlify/functions/lib/timeslot-mail.js
//
// Delivery timeslots — every email body for the run system, as PURE builders:
// each returns { subject, html } and sends nothing (the callers in
// timeslot-tick.js / timeslot-admin.js / timeslots.js send via Resend with
// mailFrom('Umzila','orders') for customers, mailFrom('Umzila Sellers',
// 'sellers') for stores, and mailFrom('Umzila','orders') for admins —
// transactional only, never the news stream).
//
// Plan: docs/plans/delivery-timeslots-plan.md §4 workstream D. Times are
// ALWAYS South African time (Africa/Johannesburg, R21) — formatted here from
// the ISO instants the server stores. Chrome = notify.js emailShell/esc.
//
// Wording rule (founder decision 2026-11-15): customers are NEVER promised an
// arrival time or window. A 12:00–13:00 run is shown to customers only as
// "dispatched by 12:00" (the window START) — no end time, no "between", no
// "arrives by". Customer builders use dispatchLabel() only; store/admin
// builders may keep the full window (timeRange/windowLabel).

const { emailShell, esc } = require('./notify');

const TZ = 'Africa/Johannesburg';
const SUPPORT_WA = '27797662768'; // same support WhatsApp number as notify.js / profile.html
const SUPPORT_EMAIL = (process.env.MAIL_REPLY_TO || 'umzilaecommerce@gmail.com').trim();

const NAVY = '#0a2f66';

// ---------- time helpers (SAST) ----------
function _d(v) { const d = v instanceof Date ? v : new Date(v); return isNaN(d) ? null : d; }
function hhmm(v) {
  const d = _d(v); if (!d) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
function ymd(v) {
  const d = _d(v); if (!d) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function dayWord(v, now) {
  const d = _d(v); if (!d) return '';
  const today = ymd(now || new Date());
  const day = ymd(d);
  if (day === today) return 'today';
  const tomorrow = ymd(new Date(_d(now || new Date()).getTime() + 86400000));
  if (day === tomorrow) return 'tomorrow';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}
// "12:00 to 13:00"
function timeRange(run) { return run ? `${hhmm(run.window_start)} to ${hhmm(run.window_end)}` : ''; }
// "today 12:00 to 13:00" / "tomorrow …" / "Sun 16 Nov 12:00 to 13:00"
function windowLabel(run, now) { return run ? `${dayWord(run.window_start, now)} ${timeRange(run)}` : ''; }
// CUSTOMER wording: "dispatched today by 12:00" / "dispatched tomorrow by 12:00"
// / "dispatched Sun 16 Nov by 12:00". Never mentions the window end.
function dispatchLabel(run, now) { return run && run.window_start ? `dispatched ${dayWord(run.window_start, now)} by ${hhmm(run.window_start)}` : ''; }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function longDate(v) {
  const d = _d(v); if (!d) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}
function money(n) { const x = Number(n); return isFinite(x) ? 'R' + x.toFixed(2) : ''; }

// ---------- shared fragments ----------
function p(html) { return `<p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 14px">${html}</p>`; }
function box(html, bg, border) {
  return `<div style="background:${bg || '#f8faff'};border:1px solid ${border || '#dbe4f5'};border-radius:10px;padding:14px 18px;margin:16px 0">${html}</div>`;
}
function cta(url, label) {
  return `<div style="text-align:center;margin:26px 0 6px"><a href="${esc(url)}" style="display:inline-block;background:${NAVY};color:#fff;padding:13px 32px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px">${esc(label)}</a></div>`;
}
function itemLine(it) {
  const qty = Number(it && it.qty) > 0 ? Number(it.qty) : 1;
  const size = it && it.size ? ` <span style="color:#6b7280">(${esc(it.size)})</span>` : '';
  const note = it && it.note ? `<div style="color:#6b7280;font-size:12px;margin-left:22px">${esc(it.note)}</div>` : '';
  return `<li style="margin:3px 0"><strong>${qty} &times;</strong> ${esc((it && it.name) || 'Item')}${size}${note}</li>`;
}
function itemList(items) {
  const rows = (items || []).map(itemLine).join('');
  return rows ? `<ul style="margin:6px 0 0;padding:0 0 0 20px;font-size:14px;color:#111827;list-style:disc">${rows}</ul>` : '';
}
function totalsTable(totals) {
  const rows = (totals || []).map(t => {
    const size = t.size ? ` <span style="color:#6b7280">(${esc(t.size)})</span>` : '';
    return `<tr><td style="padding:6px 10px;border-bottom:1px solid #eaecf0;font-size:15px">${esc(t.name || 'Item')}${size}</td><td style="padding:6px 10px;border-bottom:1px solid #eaecf0;font-size:16px;font-weight:800;text-align:right;white-space:nowrap">${Number(t.qty) || 0}</td></tr>`;
  }).join('');
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;background:#f8faff;border-radius:10px">${rows || '<tr><td style="padding:10px;color:#6b7280">No items</td></tr>'}</table>`;
}
function ordersBlock(orders) {
  return (orders || []).map(o => `<div style="border:1px solid #eaecf0;border-radius:10px;padding:12px 16px;margin:10px 0">
      <div style="font-weight:800;color:${NAVY};font-size:14px">${esc(o.order_number || '')}${o.customer_first_name ? ' &middot; ' + esc(o.customer_first_name) : ''}</div>
      ${itemList(o.items)}
      ${o.notes ? `<div style="margin-top:8px;font-size:13px;color:#92400e;background:#fffbeb;border-radius:6px;padding:6px 10px">Note: ${esc(o.notes)}</div>` : ''}
    </div>`).join('');
}
function runHeading(run) {
  return `${hhmm(run.window_start)} run`;
}
function runFacts(run) {
  return `<strong>${esc(runHeading(run))}</strong> &middot; start preparing at ${esc(hhmm(run.cutoff_at))} &middot; collection about ${esc(hhmm(run.window_start))}`;
}
function dashUrl(siteUrl) { return String(siteUrl || '').replace(/\/$/, '') + '/seller-dashboard.html'; }
function adminUrl(siteUrl) { return String(siteUrl || '').replace(/\/$/, '') + '/admin.html'; }
function trackUrl(siteUrl, orderId) { return String(siteUrl || '').replace(/\/$/, '') + '/track.html?order=' + encodeURIComponent(orderId || ''); }

// ---------- STORE: cut-off summary ----------
// One message per store per run: item totals first, then orders one by one.
function storeRunSummary({ shopName, run, totals, orders, siteUrl, graceMinutes }) {
  const n = (orders || []).length;
  const body =
    p(`Hi ${esc(shopName || 'there')}, the <strong>${esc(hhmm(run.window_start))} run</strong> is now closed to new orders. Please <strong>start preparing now</strong> &mdash; the driver collects about ${esc(hhmm(run.window_start))}.`) +
    box(runFacts(run) + `<div style="margin-top:4px;font-size:13px;color:#6b7280">${esc(longDate(run.window_start))} &middot; ${n} order${n === 1 ? '' : 's'}</div>`) +
    `<h3 style="color:${NAVY};font-size:16px;margin:20px 0 8px">Total to prepare</h3>` + totalsTable(totals) +
    `<h3 style="color:${NAVY};font-size:16px;margin:22px 0 4px">Orders, one by one</h3>` + ordersBlock(orders) +
    p(`<span style="font-size:13px;color:#6b7280">A late payment can still join this run until ${esc(hhmm(run.cutoff_at ? new Date(new Date(run.cutoff_at).getTime() + (Number(graceMinutes) || 5) * 60000) : null))} &mdash; if one does you will get an &ldquo;Add to the ${esc(hhmm(run.window_start))} run&rdquo; message.</span>`);
  return {
    subject: `Prepare now: ${hhmm(run.window_start)} run — ${n} order${n === 1 ? '' : 's'}`,
    html: emailShell(siteUrl, `${esc(runHeading(run))}: start preparing`, body, cta(dashUrl(siteUrl), 'Open seller dashboard')),
  };
}

// ---------- ADMIN: cut-off summary (all stores + Umzila stock) ----------
function adminRunSummary({ run, stores, houseItems, siteUrl }) {
  const list = stores || [];
  const total = list.reduce((s, st) => s + ((st.orders || []).length), 0);
  const sections = list.map(st => `<div style="margin:22px 0 0">
      <h3 style="color:${NAVY};font-size:16px;margin:0 0 8px;border-bottom:2px solid ${NAVY};padding-bottom:4px">${esc(st.shopName || 'Store')} <span style="font-weight:400;color:#6b7280;font-size:13px">&middot; ${(st.orders || []).length} order${(st.orders || []).length === 1 ? '' : 's'}</span></h3>
      ${totalsTable(st.totals)}
      ${ordersBlock(st.orders)}
    </div>`).join('');
  const house = (houseItems || []).length
    ? `<div style="margin:22px 0 0"><h3 style="color:${NAVY};font-size:16px;margin:0 0 8px">Umzila stock (drinks)</h3>${itemList(houseItems)}</div>` : '';
  const body =
    p(`The <strong>${esc(hhmm(run.window_start))} run</strong> has closed. Phone each store below so they start preparing.`) +
    box(runFacts(run) + `<div style="margin-top:4px;font-size:13px;color:#6b7280">${esc(longDate(run.window_start))} &middot; ${total} order${total === 1 ? '' : 's'} across ${list.length} store${list.length === 1 ? '' : 's'}</div>`) +
    sections + house;
  return {
    subject: `Run summary: ${hhmm(run.window_start)} run — ${total} order${total === 1 ? '' : 's'}`,
    html: emailShell(siteUrl, `${esc(runHeading(run))} summary`, body, cta(adminUrl(siteUrl), 'Open run sheet')),
  };
}

// ---------- STORE / ADMIN: "Add to the 12:00 run" ----------
function additionBody(who, run, order, extra) {
  return p(`${who}A late payment has joined the <strong>${esc(hhmm(run.window_start))} run</strong> after the cut-off. <strong>Please add this order to the ${esc(hhmm(run.window_start))} run.</strong>`) +
    box(`<div style="font-weight:800;color:${NAVY}">${esc(order.order_number || '')}${order.customer_first_name ? ' &middot; ' + esc(order.customer_first_name) : ''}</div>${itemList(order.items)}` +
      (order.notes ? `<div style="margin-top:8px;font-size:13px;color:#92400e">Note: ${esc(order.notes)}</div>` : ''), '#fffbeb', '#fde68a') +
    (extra || '');
}
function storeRunAddition({ shopName, run, order, siteUrl }) {
  return {
    subject: `Add to the ${hhmm(run.window_start)} run — ${order.order_number || 'new order'}`,
    html: emailShell(siteUrl, `Add to the ${esc(hhmm(run.window_start))} run`, additionBody(`Hi ${esc(shopName || 'there')}, `, run, order), cta(dashUrl(siteUrl), 'Open seller dashboard')),
  };
}
function adminRunAddition({ shopName, run, order, siteUrl }) {
  const extra = shopName ? p(`Store: <strong>${esc(shopName)}</strong> &mdash; let them know by phone.`) : '';
  return {
    subject: `Add to the ${hhmm(run.window_start)} run — ${order.order_number || 'new order'}${shopName ? ' (' + shopName + ')' : ''}`,
    html: emailShell(siteUrl, `Add to the ${esc(hhmm(run.window_start))} run`, additionBody('', run, order, extra), cta(adminUrl(siteUrl), 'Open run sheet')),
  };
}

// ---------- CUSTOMER: run changed ----------
// fromRun/toRun = { window_start, window_end } (customers only see the start, as "dispatched by"); cutoffAt = the NEW run's cut-off.
function customerRunChanged({ firstName, orderNumber, fromRun, toRun, cutoffAt, siteUrl, orderId }) {
  const hi = firstName ? `Hi ${esc(firstName)}, ` : 'Hi, ';
  const newLbl = dispatchLabel(toRun);
  const body =
    p(`${hi}your delivery time for order <strong>${esc(orderNumber || '')}</strong> has changed.`) +
    box(`<div style="font-size:13px;color:#6b7280">Was</div><div style="font-size:16px;text-decoration:line-through;color:#6b7280">${esc(fromRun ? cap(dispatchLabel(fromRun)) : 'your chosen time')}</div>
         <div style="font-size:13px;color:#6b7280;margin-top:10px">Now</div><div style="font-size:20px;font-weight:800;color:${NAVY}">${esc(cap(newLbl))}</div>`) +
    p(`Your order will now be ${esc(newLbl)}.`) +
    p(`<strong>Not suitable?</strong> You can cancel for a full refund until <strong>${esc(hhmm(cutoffAt))}</strong>. Reply to this email or WhatsApp us on <a href="https://wa.me/${SUPPORT_WA}" style="color:${NAVY}">+27 79 766 2768</a> with your order number and we will cancel it and refund you.`);
  return {
    subject: `Your delivery time changed — now ${newLbl} — ${orderNumber || ''}`.trim(),
    html: emailShell(siteUrl, 'Your delivery time changed', body, orderId ? cta(trackUrl(siteUrl, orderId), 'See your order') : ''),
  };
}

// ---------- needs attention ----------
function customerNeedsAttention({ firstName, orderNumber, siteUrl }) {
  const body =
    p(`${firstName ? 'Hi ' + esc(firstName) + ', ' : 'Hi, '}thank you for your order <strong>${esc(orderNumber || '')}</strong>. Your payment reached us after the delivery time you chose had closed, and there is no later delivery time available right now.`) +
    p(`<strong>Umzila will contact you shortly</strong> to arrange a new delivery time or a full refund &mdash; you do not need to do anything. Prefer to reach us first? Reply to this email or WhatsApp <a href="https://wa.me/${SUPPORT_WA}" style="color:${NAVY}">+27 79 766 2768</a>.`);
  return {
    subject: `We will be in touch about your delivery — ${orderNumber || ''}`.trim(),
    html: emailShell(siteUrl, 'We will contact you', body, ''),
  };
}
function adminNeedsAttention({ order, siteUrl }) {
  const o = order || {};
  const body =
    p(`Order <strong>${esc(o.order_number || '')}</strong> was paid after its run closed and <strong>no later run is available</strong>. Pick a run for it or mark it for refund.`) +
    box(`${o.customer_name ? '<div><strong>' + esc(o.customer_name) + '</strong></div>' : ''}${o.customer_phone ? '<div>' + esc(o.customer_phone) + '</div>' : ''}${o.address ? '<div style="color:#6b7280">' + esc(o.address) + '</div>' : ''}${o.total != null ? '<div style="margin-top:6px">Total ' + esc(money(o.total)) + '</div>' : ''}${itemList(o.items)}`, '#fef2f2', '#fecaca');
  return {
    subject: `Needs attention: ${o.order_number || 'order'} has no run`,
    html: emailShell(siteUrl, 'Order needs attention', body, cta(adminUrl(siteUrl), 'Open run sheet')),
  };
}

// ---------- admin busy alert ----------
function adminBusy({ run, paidCount, busyAt, siteUrl }) {
  const body =
    p(`The <strong>${esc(windowLabel(run))}</strong> run now has <strong>${Number(paidCount) || 0} paid orders</strong> (busy alert at ${Number(busyAt) || 0}).`) +
    p(`Time to arrange a second driver or warn customers. Customers see no change. This alert is sent once per run.`);
  return {
    subject: `Busy run: ${hhmm(run.window_start)} run has ${Number(paidCount) || 0} orders`,
    html: emailShell(siteUrl, 'Busy run', body, cta(adminUrl(siteUrl), 'Open run sheet')),
  };
}

// ---------- customer: running late ----------
function customerRunningLate({ firstName, orderNumber, run, minutes, siteUrl }) {
  const m = Number(minutes) || 0;
  const body =
    p(`${firstName ? 'Hi ' + esc(firstName) + ', ' : 'Hi, '}a quick update on order <strong>${esc(orderNumber || '')}</strong>: the dispatch of your order is running about <strong>${m} minute${m === 1 ? '' : 's'}</strong> late (it was due to leave by ${esc(hhmm(run && run.window_start))}).`) +
    p(`We are sorry for the wait &mdash; we will get your order on the road as soon as we can.`);
  return {
    subject: `Running about ${m} min late — ${orderNumber || ''}`.trim(),
    html: emailShell(siteUrl, 'Running a little late', body, ''),
  };
}

// ---------- customer: refunded ----------
function customerRefunded({ firstName, orderNumber, total, siteUrl }) {
  const amt = total != null && total !== '' ? ` of <strong>${esc(money(total))}</strong>` : '';
  const body =
    p(`${firstName ? 'Hi ' + esc(firstName) + ', ' : 'Hi, '}order <strong>${esc(orderNumber || '')}</strong> has been cancelled and your refund${amt} is on its way.`) +
    p(`Refunds usually reach your account within <strong>3 to 5 working days</strong>, depending on your bank.`) +
    p(`Questions? Reply to this email or WhatsApp <a href="https://wa.me/${SUPPORT_WA}" style="color:${NAVY}">+27 79 766 2768</a>.`);
  return {
    subject: `Refund on its way — ${orderNumber || ''}`.trim(),
    html: emailShell(siteUrl, 'Your refund is on its way', body, ''),
  };
}

// ---------- customer: sent early (admin "Send to riders now", timeslot-admin.js release_now) ----------
function customerSentEarly({ firstName, orderNumber, run, siteUrl, trackLink }) {
  const was = run && run.window_start ? ` (it was due to leave by ${esc(hhmm(run.window_start))})` : '';
  const body =
    p(`${firstName ? 'Hi ' + esc(firstName) + ', ' : 'Hi, '}good news on order <strong>${esc(orderNumber || '')}</strong>: we have moved it forward${was}.`) +
    box(`<div style="font-size:20px;font-weight:800;color:${NAVY}">Your order is going out now</div><div style="font-size:14px;color:#374151;margin-top:6px">A rider is being sent to collect it &mdash; you can follow it live.</div>`) +
    p(`Questions? Reply to this email or WhatsApp <a href="https://wa.me/${SUPPORT_WA}" style="color:${NAVY}">+27 79 766 2768</a>.`);
  return {
    subject: `Good news — your order is going out early — ${orderNumber || ''}`.trim(),
    html: emailShell(siteUrl, 'Your order is going out early', body, trackLink ? cta(trackLink, 'Track your order') : ''),
  };
}

module.exports = {
  storeRunSummary, adminRunSummary, storeRunAddition, adminRunAddition,
  customerRunChanged, customerNeedsAttention, adminNeedsAttention,
  adminBusy, customerRunningLate, customerRefunded, customerSentEarly,
  // helpers other files may reuse (wording consistency)
  // windowLabel/timeRange = full window, STORE/ADMIN text only; dispatchLabel = customer text.
  hhmm, dayWord, windowLabel, timeRange, dispatchLabel, SUPPORT_EMAIL,
};
