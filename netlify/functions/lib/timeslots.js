// netlify/functions/lib/timeslots.js
//
// Delivery timeslots — server helpers + the once-a-minute job body (runTick) +
// timeslotAfterPaid (called by complete-order-payment.js after payment). The RULES live
// in the database (timeslot_open_runs + the orders triggers); this file only SENDS the
// messages those rules call for, idempotently:
//   * run cut-off summary  -> one per store per run (delivery_runs.summary_claimed_at /
//                             summary_sent_to / summary_sent_at, claim-first)
//   * "Add to the 12:00 run" (payment grace)  -> notification_log TS_GRACE_ADD (unique per order)
//   * Run changed / needs attention           -> delivery_run_moves.customer_emailed_at claim,
//                                                notification_log TS_NEEDS_ATTENTION
//   * busy alert                              -> delivery_runs.busy_alert_sent_at claim
// Everything is a no-op while site_settings.timeslots.enabled is false (tick) or the order has no
// slot_id (timeslotAfterPaid). Docs: docs/systems/delivery-timeslots.md
const { mailFrom } = require('./mail');
const M = require('./timeslot-mail');

const TZ = 'Africa/Johannesburg';
const ADMIN_SENTINEL = '00000000-0000-0000-0000-000000000000'; // marks "admin summary sent" inside summary_sent_to
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- settings / formatting ----------
async function getSettings(supabase) {
  const d = { enabled: false, cutoff_minutes: 15, grace_minutes: 5, days_ahead: 1, busy_alert_at: 6 };
  try {
    const { data } = await supabase.from('site_settings').select('value').eq('key', 'timeslots').maybeSingle();
    const v = (data && data.value) || {};
    return {
      enabled: v.enabled === true || v.enabled === 'true',
      cutoff_minutes: Number.isFinite(+v.cutoff_minutes) && v.cutoff_minutes !== null ? +v.cutoff_minutes : d.cutoff_minutes,
      grace_minutes: Number.isFinite(+v.grace_minutes) && v.grace_minutes !== null ? +v.grace_minutes : d.grace_minutes,
      days_ahead: Number.isFinite(+v.days_ahead) && v.days_ahead !== null ? +v.days_ahead : d.days_ahead,
      busy_alert_at: Number.isFinite(+v.busy_alert_at) && v.busy_alert_at !== null ? +v.busy_alert_at : d.busy_alert_at
    };
  } catch (_) { return d; }
}

const cutoffOf = (windowStart, st) => new Date(new Date(windowStart).getTime() - st.cutoff_minutes * 60000);
const graceEndOf = (windowStart, st) => new Date(cutoffOf(windowStart, st).getTime() + st.grace_minutes * 60000);
const sastDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// "Today 12:00 to 13:00" / "Tomorrow 12:00 to 13:00" / "Sun 16 Nov 12:00 to 13:00" (SAST)
function fmtWindow(start, end) { return M.windowLabel({ window_start: start, window_end: end }); }
function runLabel(run) { return M.hhmm(run.window_start) + ' run'; }
function runObj(o, st) {
  return {
    run_date: o.slot_run_date || o.run_date, window_start: o.slot_window_start || o.window_start,
    window_end: o.slot_window_end || o.window_end,
    cutoff_at: cutoffOf(o.slot_window_start || o.window_start, st).toISOString()
  };
}

// ---------- recipients ----------
// Admin alert recipients: the in-portal list (admin_alert_emails, active rows); if it has none,
// fall back to the Netlify env ADMIN_EMAILS (comma list). (Founder decision 4.)
async function adminAlertEmails(supabase) {
  try {
    const { data } = await supabase.from('admin_alert_emails').select('email').eq('active', true);
    const list = (data || []).map(r => String(r.email || '').trim()).filter(Boolean);
    if (list.length) return [...new Set(list.map(e => e.toLowerCase()))];
  } catch (_) { /* fall through to env */ }
  return String(process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

// Store contact + every co-owner (same resolution as complete-order-payment sellers' emails).
async function sellerRecipients(supabase, seller) {
  const out = seller.email ? [String(seller.email).trim()] : [];
  const { data: members } = await supabase.from('seller_members').select('user_id').eq('seller_id', seller.id);
  const owners = (seller.user_id ? [{ user_id: seller.user_id }] : []).concat(members || []);
  for (const m of owners) {
    try {
      const { data: u } = await supabase.auth.admin.getUserById(m.user_id);
      const e = u && u.user && u.user.email;
      if (e && !out.some(r => r.toLowerCase() === e.toLowerCase())) out.push(e);
    } catch (_) { /* skip */ }
  }
  return out;
}

// ---------- sending ----------
async function sendMail(to, mail, kind) {
  const key = process.env.RESEND_API_KEY || '';
  const list = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!key || !list.length) { console.warn('timeslots: not sending (no key or no recipients):', mail && mail.subject); return false; }
  const from = kind === 'sellers' ? mailFrom('Umzila Sellers', 'sellers') : mailFrom('Umzila', 'orders'); // transactional only
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...from, to: list, subject: mail.subject, html: mail.html })
    });
    if (!res.ok) { console.error('timeslots: Resend error', res.status, await res.text()); return false; }
    return true;
  } catch (e) { console.error('timeslots: send failed', e.message); return false; }
}

// One row per (order, event) in notification_log (unique index on coalesce(delivery_id, order_id), event_type, channel).
// true = we own this event now; false = it was already logged.
async function logOnce(supabase, orderId, eventType) {
  const { error } = await supabase.from('notification_log').insert({
    order_id: orderId, event_type: eventType, channel: 'email', status: 'sent', sent_at: new Date().toISOString()
  });
  if (!error) return true;
  if (error.code === '23505') return false;
  console.error('timeslots: logOnce failed', eventType, error.message);
  return false;
}
async function unlog(supabase, orderId, eventType) {
  await supabase.from('notification_log').delete().eq('order_id', orderId).eq('event_type', eventType).eq('channel', 'email');
}

// ---------- run data ----------
const firstName = n => String(n || '').trim().split(/\s+/)[0] || '';
const isPaidLive = o => o.payment_status === 'paid' && !['refunded', 'cancelled'].includes(o.order_status);

// Paid, not refunded/cancelled orders in a run (R14: unpaid orders never appear). A "needs
// attention" order (R13) still points at the run it missed but has no confirmed run, so it is
// left out of store summaries and running-late mails until an admin places it.
async function loadRunOrders(supabase, slotId, runDate) {
  const { data } = await supabase.from('orders')
    .select('id, order_number, customer_name, customer_email, customer_phone, delivery_address, city, postal_code, notes, delivery_instructions, total, items, paid_at, slot_id, slot_run_date, slot_window_start, slot_window_end, slot_needs_attention, order_status, payment_status')
    .eq('slot_id', slotId).eq('slot_run_date', runDate).eq('payment_status', 'paid').eq('slot_needs_attention', false)
    .not('order_status', 'in', '(refunded,cancelled)').order('paid_at');
  return data || [];
}

// order_items rows (name/size/qty per seller) for a set of orders.
async function loadOrderItems(supabase, orderIds) {
  if (!orderIds.length) return [];
  const { data } = await supabase.from('order_items').select('order_id, seller_id, product_name, selected_size, quantity').in('order_id', orderIds);
  return data || [];
}

// Totals across orders: [{name, size, qty}] (same name+size summed), biggest first.
function itemTotals(itemRows) {
  const map = new Map();
  for (const it of itemRows) {
    const key = (it.product_name || 'Item') + '||' + (it.selected_size || '');
    const cur = map.get(key) || { name: it.product_name || 'Item', size: it.selected_size || '', qty: 0 };
    cur.qty += Number(it.quantity) || 1;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
}
const toMailItems = rows => rows.map(r => ({ name: r.product_name || 'Item', size: r.selected_size || '', qty: Number(r.quantity) || 1 }));
const toMailOrder = (o, rows) => ({
  order_number: o.order_number, customer_first_name: firstName(o.customer_name),
  items: toMailItems(rows), notes: o.delivery_instructions || o.notes || ''
});
const totalsLine = totals => totals.map(t => `${t.qty}× ${t.name}${t.size ? ' (' + t.size + ')' : ''}`).join(', ');

async function sellersByIds(supabase, ids) {
  if (!ids.length) return [];
  const { data } = await supabase.from('sellers').select('id, shop_name, email, user_id, is_house').in('id', ids);
  return data || [];
}

// ---------- 1. cut-off summaries ----------
async function sendSummaries(supabase, siteUrl, st) {
  const today = sastDate();
  const yesterday = sastDate(new Date(Date.now() - 86400000));
  const { data: runs } = await supabase.from('delivery_runs').select('*').is('summary_sent_at', null).gte('run_date', yesterday);
  let done = 0;
  for (const r of runs || []) {
    const orders = await loadRunOrders(supabase, r.slot_id, r.run_date);
    let ws = orders.length ? orders.map(o => o.slot_window_start).sort()[0] : null;
    let we = orders.length ? orders.map(o => o.slot_window_end).sort().pop() : null;
    if (!ws) {
      const { data: sl } = await supabase.from('delivery_slots').select('start_time, end_time').eq('id', r.slot_id).maybeSingle();
      if (!sl) continue;
      // SAST wall clock -> instant (UTC+2, no DST)
      ws = new Date(`${r.run_date}T${sl.start_time.slice(0, 8)}+02:00`).toISOString();
      we = new Date(`${r.run_date}T${sl.end_time.slice(0, 8)}+02:00`).toISOString();
    }
    if (Date.now() < cutoffOf(ws, st).getTime()) continue;           // not yet the cut-off

    // claim (claim-first; a stale claim older than 3 min is retaken after a crash)
    const staleBefore = new Date(Date.now() - 3 * 60000).toISOString();
    const { data: claimed } = await supabase.from('delivery_runs')
      .update({ summary_claimed_at: new Date().toISOString() })
      .eq('slot_id', r.slot_id).eq('run_date', r.run_date).is('summary_sent_at', null)
      .or(`summary_claimed_at.is.null,summary_claimed_at.lt.${staleBefore}`).select('slot_id, summary_sent_to');
    if (!claimed || !claimed.length) continue;
    const sentTo = new Set(claimed[0].summary_sent_to || []);

    const fresh = await loadRunOrders(supabase, r.slot_id, r.run_date); // re-read after claiming
    if (!fresh.length) {                                              // no paid orders -> nothing is sent
      await supabase.from('delivery_runs').update({ summary_sent_at: new Date().toISOString() }).eq('slot_id', r.slot_id).eq('run_date', r.run_date);
      continue;
    }
    const run = { run_date: r.run_date, window_start: ws, window_end: we, cutoff_at: cutoffOf(ws, st).toISOString() };
    const itemRows = await loadOrderItems(supabase, fresh.map(o => o.id));
    const sellers = await sellersByIds(supabase, [...new Set(itemRows.map(i => i.seller_id).filter(Boolean))]);
    const goodsSellers = sellers.filter(s => !s.is_house);
    const houseIds = new Set(sellers.filter(s => s.is_house).map(s => s.id));
    const orderById = new Map(fresh.map(o => [o.id, o]));

    const storeBlocks = [];
    let failed = false;
    for (const s of goodsSellers) {
      const rows = itemRows.filter(i => i.seller_id === s.id);
      const byOrder = new Map();
      rows.forEach(i => { const l = byOrder.get(i.order_id) || []; l.push(i); byOrder.set(i.order_id, l); });
      const mailOrders = [...byOrder.entries()].map(([oid, rs]) => toMailOrder(orderById.get(oid), rs));
      const totals = itemTotals(rows);
      storeBlocks.push({ shopName: s.shop_name, totals, orders: mailOrders });
      if (sentTo.has(s.id)) continue;                                 // this store already got its summary
      const recipients = await sellerRecipients(supabase, s);
      const mail = M.storeRunSummary({ shopName: s.shop_name, run, totals, orders: mailOrders, siteUrl, graceMinutes: st.grace_minutes });
      const ok = recipients.length ? await sendMail(recipients, mail, 'sellers') : true; // no email on file: dashboard still shows it
      if (!ok) { failed = true; continue; }
      await supabase.from('seller_notifications').insert({
        seller_id: s.id, type: 'run_summary', recipient_role: 'seller',
        title: `${M.hhmm(ws)} run: start preparing`,
        body: `${mailOrders.length} order${mailOrders.length === 1 ? '' : 's'} — ${totalsLine(totals)}`,
        metadata: { slot_id: r.slot_id, run_date: r.run_date, totals, window_start: ws, window_end: we }
      });
      sentTo.add(s.id);
      await supabase.from('delivery_runs').update({ summary_sent_to: [...sentTo] }).eq('slot_id', r.slot_id).eq('run_date', r.run_date);
      await sleep(400);
    }
    if (failed) continue;                                             // retried next minute (only unsent stores)

    if (!sentTo.has(ADMIN_SENTINEL)) {
      const houseItems = toMailItems(itemRows.filter(i => houseIds.has(i.seller_id))).reduce((acc, it) => {
        const k = acc.find(a => a.name === it.name && a.size === it.size); if (k) k.qty += it.qty; else acc.push({ ...it }); return acc;
      }, []);
      const admins = await adminAlertEmails(supabase);
      const ok = admins.length ? await sendMail(admins, M.adminRunSummary({ run, stores: storeBlocks, houseItems, siteUrl })) : true;
      if (!ok) continue;
      sentTo.add(ADMIN_SENTINEL);
      await supabase.from('delivery_runs').update({ summary_sent_to: [...sentTo] }).eq('slot_id', r.slot_id).eq('run_date', r.run_date);
    }
    await supabase.from('delivery_runs').update({ summary_sent_at: new Date().toISOString() }).eq('slot_id', r.slot_id).eq('run_date', r.run_date);
    done++;
  }
  return done;
}

// ---------- per-order events (grace addition, run changed, needs attention) ----------
async function processOrder(supabase, siteUrl, st, order) {
  let sent = 0;
  if (!order.slot_id) return 0;

  // Run changed / needs attention (customer told) — claim the move row first.
  const { data: moves } = await supabase.from('delivery_run_moves').select('*')
    .eq('order_id', order.id).is('customer_emailed_at', null).in('reason', ['late_payment', 'admin', 'admin_stop']).order('created_at');
  for (const mv of moves || []) {
    const { data: claim } = await supabase.from('delivery_run_moves').update({ customer_emailed_at: new Date().toISOString() })
      .eq('id', mv.id).is('customer_emailed_at', null).select('id');
    if (!claim || !claim.length) continue;
    let ok = true;
    if (mv.to_slot_id) {
      const toRun = { window_start: mv.to_window_start, window_end: mv.to_window_end };
      const mail = M.customerRunChanged({
        firstName: firstName(order.customer_name), orderNumber: order.order_number,
        fromRun: mv.from_window_start ? { window_start: mv.from_window_start, window_end: mv.from_window_end } : null,
        toRun, cutoffAt: cutoffOf(mv.to_window_start, st).toISOString(), siteUrl, orderId: order.id
      });
      ok = order.customer_email ? await sendMail(order.customer_email, mail) : true;
      if (ok) sent++;
    } else if (await logOnce(supabase, order.id, 'TS_NEEDS_ATTENTION')) {
      const cust = M.customerNeedsAttention({ firstName: firstName(order.customer_name), orderNumber: order.order_number, siteUrl });
      if (order.customer_email) await sendMail(order.customer_email, cust);
      const itemRows = await loadOrderItems(supabase, [order.id]);
      const admins = await adminAlertEmails(supabase);
      const adminMail = M.adminNeedsAttention({ siteUrl, order: {
        order_number: order.order_number, customer_name: order.customer_name, customer_phone: order.customer_phone,
        address: [order.delivery_address, order.city, order.postal_code].filter(Boolean).join(', '), total: order.total,
        items: toMailItems(itemRows) } });
      if (admins.length) await sendMail(admins, adminMail);
      sent++;
    }
    if (!ok) await supabase.from('delivery_run_moves').update({ customer_emailed_at: null }).eq('id', mv.id); // retry next minute
  }

  // Payment grace: paid after the cut-off but inside the grace, after the summary already went out.
  if (!order.slot_needs_attention && order.payment_status === 'paid' && order.paid_at && order.slot_window_start) {
    const paid = new Date(order.paid_at).getTime();
    const cutoff = cutoffOf(order.slot_window_start, st).getTime();
    if (paid > cutoff && paid <= graceEndOf(order.slot_window_start, st).getTime()) {
      const { data: run } = await supabase.from('delivery_runs').select('summary_claimed_at').eq('slot_id', order.slot_id).eq('run_date', order.slot_run_date).maybeSingle();
      // not claimed yet => the cut-off summary (loaded later) will already contain this order
      if (run && run.summary_claimed_at && paid > new Date(run.summary_claimed_at).getTime()) {
        if (await logOnce(supabase, order.id, 'TS_GRACE_ADD')) {
          const itemRows = await loadOrderItems(supabase, [order.id]);
          const runO = runObj(order, st);
          const sellers = await sellersByIds(supabase, [...new Set(itemRows.map(i => i.seller_id).filter(Boolean))]);
          const admins = await adminAlertEmails(supabase);
          for (const s of sellers.filter(x => !x.is_house)) {
            const rows = itemRows.filter(i => i.seller_id === s.id);
            const mo = toMailOrder(order, rows);
            const recipients = await sellerRecipients(supabase, s);
            if (recipients.length) await sendMail(recipients, M.storeRunAddition({ shopName: s.shop_name, run: runO, order: mo, siteUrl }), 'sellers');
            await supabase.from('seller_notifications').insert({
              seller_id: s.id, type: 'run_addition', recipient_role: 'seller', related_order_id: order.id,
              title: `Add to the ${M.hhmm(order.slot_window_start)} run`,
              body: `${order.order_number}: ${totalsLine(itemTotals(rows))}`,
              metadata: { slot_id: order.slot_id, run_date: order.slot_run_date, totals: itemTotals(rows), order_number: order.order_number }
            });
            if (admins.length) await sendMail(admins, M.adminRunAddition({ shopName: s.shop_name, run: runO, order: mo, siteUrl }));
          }
          sent++;
        }
      }
    }
  }
  return sent;
}

// ---------- busy alert (once per run) ----------
async function maybeBusy(supabase, siteUrl, st, slotId, runDate) {
  const { count } = await supabase.from('orders').select('id', { count: 'exact', head: true })
    .eq('slot_id', slotId).eq('slot_run_date', runDate).eq('payment_status', 'paid').not('order_status', 'in', '(refunded,cancelled)');
  if (!count || count < st.busy_alert_at) return false;
  const { data: claim } = await supabase.from('delivery_runs').update({ busy_alert_sent_at: new Date().toISOString() })
    .eq('slot_id', slotId).eq('run_date', runDate).is('busy_alert_sent_at', null).select('slot_id');
  if (!claim || !claim.length) return false;
  const { data: o } = await supabase.from('orders').select('slot_window_start, slot_window_end').eq('slot_id', slotId).eq('slot_run_date', runDate)
    .eq('payment_status', 'paid').limit(1).maybeSingle();
  const run = { run_date: runDate, window_start: o && o.slot_window_start, window_end: o && o.slot_window_end };
  const admins = await adminAlertEmails(supabase);
  const ok = admins.length ? await sendMail(admins, M.adminBusy({ run, paidCount: count, busyAt: st.busy_alert_at, siteUrl })) : true;
  if (!ok) await supabase.from('delivery_runs').update({ busy_alert_sent_at: null }).eq('slot_id', slotId).eq('run_date', runDate);
  return ok;
}

// Called by complete-order-payment.js after the order is marked paid (guarded, never throws to the caller).
// No-op for orders with no run.
async function timeslotAfterPaid(supabase, orderId, siteUrl) {
  const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
  if (!order || !order.slot_id) return { skipped: true };
  const st = await getSettings(supabase);
  const sent = await processOrder(supabase, siteUrl, st, order);
  const busy = await maybeBusy(supabase, siteUrl, st, order.slot_id, order.slot_run_date);
  return { sent, busy };
}

// ---------- the job ----------
async function runTick(supabase, siteUrl) {
  const st = await getSettings(supabase);
  if (!st.enabled) return { skipped: 'disabled' };                    // cheap early return: nothing else is read
  const out = { summaries: 0, orderEvents: 0, busy: 0 };
  out.summaries = await sendSummaries(supabase, siteUrl, st);

  // sweep: recent paid orders with a run — grace additions + unsent run-changed / needs-attention mails
  const since = new Date(Date.now() - 36 * 3600000).toISOString();
  const { data: recent } = await supabase.from('orders').select('*')
    .not('slot_id', 'is', null).eq('payment_status', 'paid').gte('paid_at', since);
  for (const o of recent || []) out.orderEvents += await processOrder(supabase, siteUrl, st, o);
  // admin-initiated moves can be older than the paid_at window
  const { data: pend } = await supabase.from('delivery_run_moves').select('order_id').is('customer_emailed_at', null)
    .in('reason', ['admin', 'admin_stop', 'late_payment']).gte('created_at', since);
  const handled = new Set((recent || []).map(o => o.id));
  for (const id of [...new Set((pend || []).map(p => p.order_id))]) {
    if (handled.has(id)) continue;
    const { data: o } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
    if (o) out.orderEvents += await processOrder(supabase, siteUrl, st, o);
  }

  const { data: runs } = await supabase.from('delivery_runs').select('slot_id, run_date').is('busy_alert_sent_at', null).gte('run_date', sastDate(new Date(Date.now() - 86400000)));
  for (const r of runs || []) if (await maybeBusy(supabase, siteUrl, st, r.slot_id, r.run_date)) out.busy++;
  return out;
}

module.exports = {
  getSettings, fmtWindow, runLabel, loadRunOrders, itemTotals, sellerRecipients, adminAlertEmails,
  logOnce, unlog, sendMail, timeslotAfterPaid, runTick, firstName, cutoffOf, graceEndOf, runObj, sastDate
};
