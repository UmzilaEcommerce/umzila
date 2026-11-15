// netlify/functions/timeslot-admin.js
//
// Delivery timeslots — admin actions that need Node (emails, delivery cancel).
// POST + Authorization: Bearer <admin session>; JSON in, { ok: true, ... } or { error } out.
//   { action: 'tick' }                                  run the once-a-minute job now (e.g. after a Move)
//   { action: 'mark_refund', orderId }                  order_status 'refunded', delivery CANCELLED,
//                                                       move row (reason 'refund'), customer email.
//                                                       The money is refunded by hand in PayFast.
//   { action: 'running_late', slotId, runDate, minutes } email every paid customer in the run
// Admin = a row in public.admins (same rule as the database's timeslot_is_admin()).
const { createClient } = require('@supabase/supabase-js');
const { transitionDelivery } = require('./lib/delivery-state');
const T = require('./lib/timeslots');
const M = require('./lib/timeslot-mail');

const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (code, obj) => ({ statusCode: code, headers: H, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, {});
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method' });
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!tok) return reply(401, { error: 'Unauthorized' });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: { user } = {}, error: aErr } = await supabase.auth.getUser(tok);
  if (aErr || !user) return reply(401, { error: 'Invalid session' });
  const { data: adminRow } = await supabase.from('admins').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!adminRow) return reply(403, { error: 'Admins only' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'bad_json' }); }
  const site = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');

  try {
    if (b.action === 'tick') {
      return reply(200, { ok: true, result: await T.runTick(supabase, site) });
    }

    if (b.action === 'mark_refund') {
      if (!b.orderId) return reply(400, { error: 'orderId required' });
      const { data: o } = await supabase.from('orders').select('*').eq('id', b.orderId).maybeSingle();
      if (!o) return reply(404, { error: 'Order not found' });
      if (o.payment_status !== 'paid') return reply(400, { error: 'Only a paid order can be marked for refund.' });
      if (o.order_status === 'refunded') return reply(200, { ok: true, already: true });
      if (o.order_status === 'cancelled') return reply(400, { error: 'This order is already cancelled.' });
      // 1. the order (service role: allowed to write the order; slot columns stay as sold)
      const { error: uErr } = await supabase.from('orders').update({ order_status: 'refunded', slot_needs_attention: false }).eq('id', o.id);
      if (uErr) throw uErr;
      // 2. cancel the delivery (through the state machine) so no rider is sent
      let deliveryCancelled = null;
      const { data: d } = await supabase.from('deliveries').select('id, status').eq('order_id', o.id).maybeSingle();
      if (d && !['DELIVERED', 'CANCELLED', 'FAILED', 'RETURNED'].includes(d.status)) {
        const r = await transitionDelivery(supabase, d.id, 'CANCELLED', { type: 'admin', id: user.id }, { eventType: 'ORDER_REFUNDED' });
        deliveryCancelled = r.ok ? true : (r.reason || 'failed');
        if (!r.ok) console.warn('timeslot-admin mark_refund: delivery cancel failed', r.reason, r.detail);
      }
      // 3. history + customer email
      await supabase.from('delivery_run_moves').insert({
        order_id: o.id, from_slot_id: o.slot_id, from_run_date: o.slot_run_date, from_window_start: o.slot_window_start,
        from_window_end: o.slot_window_end, reason: 'refund', actor_type: 'admin', actor_id: user.id,
        customer_emailed_at: new Date().toISOString()
      });
      if (o.customer_email) {
        await T.sendMail(o.customer_email, M.customerRefunded({ firstName: T.firstName(o.customer_name), orderNumber: o.order_number, total: o.total, siteUrl: site }));
      }
      return reply(200, { ok: true, deliveryCancelled });
    }

    if (b.action === 'running_late') {
      const minutes = parseInt(b.minutes, 10);
      if (!b.slotId || !b.runDate || !(minutes > 0 && minutes <= 600)) return reply(400, { error: 'slotId, runDate and minutes (1-600) are required.' });
      const st = await T.getSettings(supabase);
      const orders = await T.loadRunOrders(supabase, b.slotId, b.runDate);
      await supabase.from('delivery_runs').upsert({ slot_id: b.slotId, run_date: b.runDate, late_minutes: minutes, late_sent_at: new Date().toISOString() }, { onConflict: 'slot_id,run_date' });
      let sent = 0;
      for (const o of orders) {
        if (!o.customer_email) continue;
        const run = T.runObj(o, st);
        const ok = await T.sendMail(o.customer_email, M.customerRunningLate({ firstName: T.firstName(o.customer_name), orderNumber: o.order_number, run, minutes, siteUrl: site }));
        if (ok) sent++;
      }
      return reply(200, { ok: true, customers: orders.length, emailed: sent });
    }

    return reply(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('timeslot-admin error', e);
    return reply(500, { error: e.message || 'Server error' });
  }
};
