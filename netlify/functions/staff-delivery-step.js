// netlify/functions/staff-delivery-step.js
//
// Staff override (admins + active logistics/admin user_roles — the same rule as
// timeslot_is_staff()): move ONE order's delivery forward when the rider can't
// (phone died, forgot to tap, delivered by hand…). logistics.html → order →
// "Move this delivery along".
//
// POST { orderId, step }   step = at_store | collected | on_the_way | arrived | delivered
//
// It walks the delivery through every normal status in between, each one via
// transitionDelivery() (the one state machine — events logged with actor
// 'admin', the usual customer emails fire, e.g. "on its way" / "delivered"), and
// keeps that order's route stops in step exactly like the rider app does
// (advance-route.js / confirm-delivery-pin.js): pickup stops active → completed,
// drop stop active → arriving → completed, and the trip is completed (which fires
// the rider-payout trigger) once every stop is done. Other orders on the same
// trip are never touched. "delivered" skips the customer's PIN — staff confirm it.
const { createClient } = require('@supabase/supabase-js');
const { transitionDelivery } = require('./lib/delivery-state');

const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (code, obj) => ({ statusCode: code, headers: H, body: JSON.stringify(obj) });

// The forward path a rider normally takes (PARTIALLY_PICKED_UP is a side-step of DRIVER_AT_PICKUP).
const PATH = ['PENDING', 'READY_FOR_DISPATCH', 'OFFERED', 'ASSIGNED', 'DRIVER_AT_PICKUP', 'PICKED_UP', 'IN_ROUTE', 'NEXT_STOP', 'ARRIVING', 'PIN_REQUIRED', 'DELIVERED'];
const TARGET = { at_store: 'DRIVER_AT_PICKUP', collected: 'PICKED_UP', on_the_way: 'IN_ROUTE', arrived: 'ARRIVING', delivered: 'DELIVERED' };
const EVENT = { DRIVER_AT_PICKUP: 'AT_PICKUP', PICKED_UP: 'ORDER_PICKED_UP', IN_ROUTE: 'ROUTE_STARTED', NEXT_STOP: 'DRIVER_NEARBY', ARRIVING: 'DRIVER_ARRIVING', PIN_REQUIRED: 'PIN_REQUIRED', DELIVERED: 'DELIVERED' };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return reply(401, { error: 'Unauthorized' });
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: { user } = {}, error: aErr } = await sb.auth.getUser(token);
  if (aErr || !user) return reply(401, { error: 'Invalid session' });
  const [{ data: adm }, { data: roles }] = await Promise.all([
    sb.from('admins').select('user_id').eq('user_id', user.id).maybeSingle(),
    sb.from('user_roles').select('role').eq('user_id', user.id).eq('is_active', true)
  ]);
  const staff = !!adm || (roles || []).some(r => ['logistics', 'admin'].includes(String(r.role || '').toLowerCase()));
  if (!staff) return reply(403, { error: 'Staff only' });

  let b; try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid JSON' }); }
  const target = TARGET[b.step];
  if (!b.orderId || !target) return reply(400, { error: 'orderId and step (at_store, collected, on_the_way, arrived, delivered) required' });

  const { data: d } = await sb.from('deliveries').select('id, status, route_id').eq('order_id', b.orderId).maybeSingle();
  if (!d) return reply(404, { error: 'This order has no Umzila delivery.' });
  const from = d.status === 'PARTIALLY_PICKED_UP' ? 'DRIVER_AT_PICKUP' : d.status;
  const i0 = PATH.indexOf(from), i1 = PATH.indexOf(target);
  if (i0 < 0) return reply(400, { error: `The delivery is ${d.status.replace(/_/g, ' ').toLowerCase()} — it can't be moved along from there.` });
  if (i1 <= i0) return reply(400, { error: 'It is already at (or past) that step.' });
  if (!d.route_id && target !== 'DELIVERED') return reply(400, { error: 'No rider has this order yet. Send it to riders first, or mark it Delivered if staff delivered it.' });

  const actor = { type: 'admin', id: user.id };
  const now = () => new Date().toISOString();
  const { data: stops } = d.route_id ? await sb.from('route_stops').select('id, stop_type, status').eq('route_id', d.route_id).eq('delivery_id', d.id) : { data: [] };
  const pickups = (stops || []).filter(s => s.stop_type === 'pickup'), drop = (stops || []).find(s => s.stop_type === 'drop');

  // Never leave a rider holding an offer for an order staff have taken over.
  if (PATH.indexOf('ASSIGNED') > i0) await sb.from('driver_offers').update({ status: 'expired' }).eq('delivery_id', d.id).eq('status', 'pending');

  let status = from === 'DRIVER_AT_PICKUP' && d.status === 'PARTIALLY_PICKED_UP' ? 'PARTIALLY_PICKED_UP' : from;
  for (let i = i0 + 1; i <= i1; i++) {
    const next = PATH[i];
    const r = await transitionDelivery(sb, d.id, next, actor, { eventType: EVENT[next], metadata: { staff_override: true, step: b.step } });
    if (!r.ok) return reply(r.reason === 'conflict' ? 409 : 500, { error: `Couldn't move it to ${next.replace(/_/g, ' ').toLowerCase()} (${r.reason}). Refresh and try again.`, reached: status });
    status = next;
    // keep this order's stops in step with the rider app
    if (next === 'DRIVER_AT_PICKUP') {
      for (const s of pickups) await sb.from('route_stops').update({ status: 'active', arrived_at: now() }).eq('id', s.id).eq('status', 'pending');
      if (d.route_id) await sb.from('routes').update({ status: 'started', started_at: now() }).eq('id', d.route_id).eq('status', 'assigned');
    } else if (next === 'PICKED_UP') {
      for (const s of pickups) await sb.from('route_stops').update({ status: 'completed', completed_at: now() }).eq('id', s.id).neq('status', 'completed');
    } else if (next === 'IN_ROUTE') {
      if (d.route_id) await sb.from('routes').update({ status: 'active' }).eq('id', d.route_id).in('status', ['assigned', 'started']);
      if (drop) await sb.from('route_stops').update({ status: 'active' }).eq('id', drop.id).eq('status', 'pending');
    } else if (next === 'ARRIVING') {
      if (drop) await sb.from('route_stops').update({ status: 'arriving', arrived_at: now() }).eq('id', drop.id).in('status', ['pending', 'active']);
    } else if (next === 'DELIVERED') {
      for (const s of pickups) await sb.from('route_stops').update({ status: 'completed', completed_at: now() }).eq('id', s.id).neq('status', 'completed');
      if (drop) await sb.from('route_stops').update({ status: 'completed', completed_at: now() }).eq('id', drop.id).neq('status', 'completed');
    }
  }

  let routeCompleted = false;
  if (status === 'DELIVERED' && d.route_id) {
    const { data: all } = await sb.from('route_stops').select('status').eq('route_id', d.route_id);
    if ((all || []).length && all.every(s => s.status === 'completed')) {
      const { data: rc } = await sb.from('routes').update({ status: 'completed', completed_at: now() }).eq('id', d.route_id).neq('status', 'completed').select('id');
      routeCompleted = !!(rc && rc.length);
    }
  }
  return reply(200, { ok: true, status, routeCompleted });
};
