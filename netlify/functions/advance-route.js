// netlify/functions/advance-route.js
//
// Delivery network Stage 9/10 (delivery-network-spec.md §E) — the driver-
// facing actions that move a route forward, one step at a time. Since
// 2026-10-05 a route is a multi-drop TRIP: several orders, worked stop by
// stop (see the "current stop" note below). Consolidated into one function rather than four tiny ones,
// since they share the same auth/ownership verification and are always
// called in sequence by the same UI flow.
//
// Deliberately stops short of completing the drop stop / route / delivery:
// per plan §65/§195 design principle #10 ("PIN confirmation is authoritative
// -- no PIN, no completed delivery"), nothing here may ever mark a delivery
// DELIVERED. That's Stage 13's job (confirm-delivery-pin.js, not yet built)
// -- until it exists, a route can progress all the way to ARRIVING/
// PIN_REQUIRED and then waits there. This is the natural, correct stopping
// point for this stage, not a gap.
//
// All deliveries.status changes go exclusively through transitionDelivery()
// (lib/delivery-state.js). route_stops/routes status changes are simpler
// (no full state-machine module -- a small, fixed progression) and use a
// guarded UPDATE ... WHERE status = <expected> pattern for the same
// optimistic-concurrency reasoning transitionDelivery() itself uses.
const { createClient } = require('@supabase/supabase-js');
const { transitionDelivery } = require('./lib/delivery-state');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const VALID_ACTIONS = ['start_route', 'complete_pickup', 'start_delivery', 'arrive_at_drop'];

async function resolveCallerDriver(admin, token) {
  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return { error: { statusCode: 401, body: { error: 'Invalid session' } } };
  const { data: driver, error: driverError } = await admin.from('drivers').select('id').eq('user_id', user.id).maybeSingle();
  if (driverError) return { error: { statusCode: 500, body: { error: 'Failed to look up driver record' } } };
  if (!driver) return { error: { statusCode: 403, body: { error: 'No driver record for this account' } } };
  return { driverId: driver.id };
}

async function loadOwnedRoute(admin, routeId, driverId) {
  const { data: route, error } = await admin.from('routes').select('id, driver_id, status').eq('id', routeId).maybeSingle();
  if (error) return { error: { statusCode: 500, body: { error: 'Failed to look up route' } } };
  if (!route) return { error: { statusCode: 404, body: { error: 'Route not found' } } };
  if (route.driver_id !== driverId) return { error: { statusCode: 403, body: { error: 'This route does not belong to you' } } };
  return { route };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const resolved = await resolveCallerDriver(admin, token);
  if (resolved.error) return { statusCode: resolved.error.statusCode, headers, body: JSON.stringify(resolved.error.body) };
  const driverId = resolved.driverId;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { routeId, action } = body;
  if (!routeId || !VALID_ACTIONS.includes(action)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `routeId and action (one of ${VALID_ACTIONS.join(', ')}) required` }) };
  }

  const routeResolved = await loadOwnedRoute(admin, routeId, driverId);
  if (routeResolved.error) return { statusCode: routeResolved.error.statusCode, headers, body: JSON.stringify(routeResolved.error.body) };
  const route = routeResolved.route;

  const { data: stops, error: stopsError } = await admin
    .from('route_stops')
    .select('id, stop_type, seq_order, seller_id, delivery_id, status')
    .eq('route_id', routeId)
    .order('seq_order', { ascending: true });
  if (stopsError) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load route stops' }) };
  if (!stops || !stops.length) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Route has no stops' }) };

  // ── Multi-drop (2026-10-05): the rider always works the CURRENT stop = the
  // first stop (by seq_order) that isn't completed. Pickups at the same store
  // that follow each other are one visit ("group"). Each stop belongs to one
  // delivery; only that delivery's status moves. The client sends stopId so a
  // stale screen can't act on the wrong stop (409 → refresh). ──
  const current = stops.find(s => s.status !== 'completed');
  if (!current) return { statusCode: 409, headers, body: JSON.stringify({ error: 'This trip is already finished' }) };
  const group = [];
  if (current.stop_type === 'pickup') {
    for (const s of stops.slice(stops.indexOf(current))) {
      if (s.status === 'completed') continue;
      if (s.stop_type !== 'pickup' || s.seller_id !== current.seller_id) break;
      group.push(s);
    }
  } else {
    group.push(current);
  }
  const requestedStopId = body.stopId || null;
  if (requestedStopId && !group.some(s => s.id === requestedStopId)) {
    return { statusCode: 409, headers, body: JSON.stringify({ error: 'Your trip changed — refreshing.', code: 'TRIP_CHANGED' }) };
  }
  const target = requestedStopId ? group.find(s => s.id === requestedStopId) : group[0];
  const actor = { type: 'driver', id: driverId };
  const fail = (r, msg) => ({ statusCode: r.reason === 'conflict' ? 409 : 500, headers, body: JSON.stringify({ error: msg, detail: r.detail || r.reason }) });
  const deliveryStatus = async id => (await admin.from('deliveries').select('status, order_id').eq('id', id).maybeSingle()).data;

  // ── start_route = "I'm at the store": every pickup of this store visit
  // becomes active; each of those orders ASSIGNED → DRIVER_AT_PICKUP. ──
  if (action === 'start_route') {
    if (current.stop_type !== 'pickup') return { statusCode: 409, headers, body: JSON.stringify({ error: 'Next stop is a customer, not a store', code: 'TRIP_CHANGED' }) };
    for (const s of group) {
      const d = await deliveryStatus(s.delivery_id);
      if (d && d.status === 'ASSIGNED') {
        const r = await transitionDelivery(admin, s.delivery_id, 'DRIVER_AT_PICKUP', actor, { eventType: 'AT_PICKUP', metadata: { stop_id: s.id } });
        if (!r.ok) return fail(r, 'Could not start pickup');
      }
      await admin.from('route_stops').update({ status: 'active', arrived_at: new Date().toISOString() }).eq('id', s.id).eq('status', 'pending');
    }
    await admin.from('routes').update({ status: 'started', started_at: new Date().toISOString() }).eq('id', routeId).eq('status', 'assigned');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, stops: group.map(s => s.id) }) };
  }

  // ── complete_pickup: tick off THIS stop's items (its order, this store);
  // the stop is done; once that order has no pickups left it becomes
  // PICKED_UP (or PARTIALLY_PICKED_UP — a valid state, plan §38). ──
  if (action === 'complete_pickup') {
    if (target.stop_type !== 'pickup') return { statusCode: 409, headers, body: JSON.stringify({ error: 'No pickup to complete here', code: 'TRIP_CHANGED' }) };
    const collectedIds = Array.isArray(body.collectedOrderItemIds) ? body.collectedOrderItemIds : [];
    const d = await deliveryStatus(target.delivery_id);
    if (!d) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load delivery' }) };
    if (d.status === 'ASSIGNED') {
      const r = await transitionDelivery(admin, target.delivery_id, 'DRIVER_AT_PICKUP', actor, { eventType: 'AT_PICKUP', metadata: { stop_id: target.id } });
      if (!r.ok) return fail(r, 'Could not update pickup status');
    }
    const { data: allItems, error: itemsError } = await admin.from('order_items').select('id').eq('order_id', d.order_id).eq('seller_id', target.seller_id);
    if (itemsError) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load order items for this pickup' }) };
    const allItemIds = (allItems || []).map(i => i.id);
    if (!allItemIds.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No order items found for this pickup stop' }) };

    const nowIso = new Date().toISOString();
    for (const itemId of allItemIds) {
      const collected = collectedIds.includes(itemId);
      const { data: existing } = await admin.from('route_stop_items').select('id').eq('route_stop_id', target.id).eq('order_item_id', itemId).maybeSingle();
      if (existing) {
        if (collected) await admin.from('route_stop_items').update({ collected: true, collected_at: nowIso }).eq('id', existing.id);
      } else {
        await admin.from('route_stop_items').insert({ route_stop_id: target.id, order_item_id: itemId, collected, collected_at: collected ? nowIso : null });
      }
    }
    await admin.from('route_stops').update({ status: 'completed', completed_at: nowIso }).eq('id', target.id);

    // Other pickups for this same order (an order from 2 stores) still to do?
    const ownPickups = stops.filter(s => s.stop_type === 'pickup' && s.delivery_id === target.delivery_id);
    const pendingOwn = ownPickups.filter(s => s.id !== target.id && s.status !== 'completed');
    if (pendingOwn.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, movedToNextPickup: true, nextSellerId: pendingOwn[0].seller_id }) };
    }
    const ownIds = ownPickups.map(s => s.id);
    const { data: finalItems } = await admin.from('route_stop_items').select('collected').in('route_stop_id', ownIds);
    const { data: allOrderItems } = await admin.from('order_items').select('id').eq('order_id', d.order_id).in('seller_id', ownPickups.map(s => s.seller_id));
    const allCollected = (finalItems || []).length >= (allOrderItems || []).length && (finalItems || []).every(i => i.collected);
    const r = await transitionDelivery(admin, target.delivery_id, allCollected ? 'PICKED_UP' : 'PARTIALLY_PICKED_UP', actor, { eventType: 'ORDER_PICKED_UP', metadata: { all_collected: allCollected } });
    if (!r.ok) return fail(r, 'Could not update pickup status');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, allCollected, delivery: r.delivery }) };
  }

  // ── start_delivery = "Start trip to <customer>": only the customer whose
  // drop is now current becomes IN_ROUTE ("heading your way" + live map). Any
  // other order on the trip stays PICKED_UP until its own turn. ──
  if (action === 'start_delivery') {
    if (target.stop_type !== 'drop' || target.status !== 'pending') return { statusCode: 409, headers, body: JSON.stringify({ error: 'Next stop is not a customer yet', code: 'TRIP_CHANGED' }) };
    const d = await deliveryStatus(target.delivery_id);
    if (!d) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load delivery' }) };
    if (d.status === 'PARTIALLY_PICKED_UP') {
      const up = await transitionDelivery(admin, target.delivery_id, 'PICKED_UP', actor, { eventType: 'ORDER_PICKED_UP', metadata: { note: 'auto-upgrade from partial before starting delivery leg' } });
      if (!up.ok) return fail(up, 'Could not start delivery leg');
    }
    const r = await transitionDelivery(admin, target.delivery_id, 'IN_ROUTE', actor, { eventType: 'ROUTE_STARTED', metadata: { stop_id: target.id } });
    if (!r.ok) return fail(r, 'Could not start delivery leg');
    await admin.from('routes').update({ status: 'active' }).eq('id', routeId).in('status', ['assigned', 'started']);
    await admin.from('route_stops').update({ status: 'active' }).eq('id', target.id).eq('status', 'pending');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, delivery: r.delivery }) };
  }

  // ── arrive_at_drop: that customer IN_ROUTE → NEXT_STOP → ARRIVING; the PIN
  // (confirm-delivery-pin.js) completes the stop, and the trip once every
  // stop is done (payout trigger). ──
  if (action === 'arrive_at_drop') {
    if (target.stop_type !== 'drop' || target.status !== 'active') return { statusCode: 409, headers, body: JSON.stringify({ error: 'Start the trip to this customer first', code: 'TRIP_CHANGED' }) };
    const step1 = await transitionDelivery(admin, target.delivery_id, 'NEXT_STOP', actor, { eventType: 'DRIVER_NEARBY' });
    if (!step1.ok) return fail(step1, 'Could not update delivery status');
    const step2 = await transitionDelivery(admin, target.delivery_id, 'ARRIVING', actor, { eventType: 'DRIVER_ARRIVING' });
    if (!step2.ok) return fail(step2, 'Could not update delivery status');
    await admin.from('route_stops').update({ status: 'arriving', arrived_at: new Date().toISOString() }).eq('id', target.id).eq('status', 'active');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, delivery: step2.delivery }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unhandled action' }) };
};
