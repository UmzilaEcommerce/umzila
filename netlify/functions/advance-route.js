// netlify/functions/advance-route.js
//
// Delivery network Stage 9/10 (delivery-network-spec.md §E) — the driver-
// facing actions that move a route (and its linked delivery) forward, one
// step at a time. Consolidated into one function rather than four tiny ones,
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
  const pickupStop = stops.find(s => s.stop_type === 'pickup');
  const dropStop = stops.find(s => s.stop_type === 'drop');
  if (!pickupStop || !dropStop) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Route is missing its pickup/drop stops' }) };
  }
  const deliveryId = pickupStop.delivery_id; // pilot: single delivery per route, both stops share it

  // ── start_route: ASSIGNED -> DRIVER_AT_PICKUP, route assigned -> started ──
  if (action === 'start_route') {
    if (route.status !== 'assigned') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: `Route is not in a startable state (currently ${route.status})` }) };
    }
    const transitionResult = await transitionDelivery(admin, deliveryId, 'DRIVER_AT_PICKUP', { type: 'driver', id: driverId }, { eventType: 'AT_PICKUP' });
    if (!transitionResult.ok) {
      return { statusCode: transitionResult.reason === 'conflict' ? 409 : 500, headers, body: JSON.stringify({ error: 'Could not start route', detail: transitionResult.detail || transitionResult.reason }) };
    }
    await admin.from('routes').update({ status: 'started', started_at: new Date().toISOString() }).eq('id', routeId).eq('status', 'assigned');
    await admin.from('route_stops').update({ status: 'active' }).eq('id', pickupStop.id).eq('status', 'pending');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, delivery: transitionResult.delivery }) };
  }

  // ── complete_pickup: check off route_stop_items for the CURRENT pickup
  // stop; DRIVER_AT_PICKUP -> PICKED_UP or PARTIALLY_PICKED_UP only once
  // EVERY pickup stop for this delivery is done (Stage 4, 2026-09-17: a
  // bundled delivery has N pickup stops, seq_order 1..N, only one ever
  // 'active' at a time -- no client-supplied stop id needed, the server
  // resolves it). deliveries.status deliberately stays at DRIVER_AT_PICKUP
  // while moving between stores: delivery-state.js's TRANSITIONS map has no
  // "at pickup stop N of M" state, and PARTIALLY_PICKED_UP has no path back
  // to DRIVER_AT_PICKUP, so "transition once, after the last stop" is the
  // only design that doesn't require touching the state machine's enum. ──
  if (action === 'complete_pickup') {
    const collectedIds = Array.isArray(body.collectedOrderItemIds) ? body.collectedOrderItemIds : [];

    const pickupStops = stops.filter(s => s.stop_type === 'pickup'); // already seq_order-sorted
    const currentPickupStop = pickupStops.find(s => s.status === 'active') || pickupStops.find(s => s.status === 'pending');
    if (!currentPickupStop) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'No active pickup stop to complete' }) };
    }

    // Resolve which order_items actually belong to THIS stop's seller on the
    // underlying order (route_stop_items rows are created lazily here, on
    // first checklist submission, rather than pre-populated when the route
    // is created -- simpler, and the checklist UI already knows the full set
    // of item ids to send from its own order/product view).
    const { data: delivery, error: deliveryError } = await admin.from('deliveries').select('order_id').eq('id', deliveryId).maybeSingle();
    if (deliveryError || !delivery) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load delivery' }) };
    const { data: allItems, error: itemsError } = await admin.from('order_items').select('id').eq('order_id', delivery.order_id).eq('seller_id', currentPickupStop.seller_id);
    if (itemsError) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load order items for this pickup' }) };
    const allItemIds = (allItems || []).map(i => i.id);

    if (!allItemIds.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No order items found for this pickup stop' }) };
    }

    // Upsert a route_stop_items row per item -- collected:true only for ids
    // the driver actually checked off this call (plan §38: partial pickup is
    // a real, valid state, not an error, and must not block moving to the
    // next store in a bundled pickup).
    const nowIso = new Date().toISOString();
    for (const itemId of allItemIds) {
      const collected = collectedIds.includes(itemId);
      const { data: existing } = await admin.from('route_stop_items').select('id').eq('route_stop_id', currentPickupStop.id).eq('order_item_id', itemId).maybeSingle();
      if (existing) {
        if (collected) await admin.from('route_stop_items').update({ collected: true, collected_at: nowIso }).eq('id', existing.id);
      } else {
        await admin.from('route_stop_items').insert({ route_stop_id: currentPickupStop.id, order_item_id: itemId, collected, collected_at: collected ? nowIso : null });
      }
    }

    // This stop is done regardless of full/partial collection -- always mark
    // it completed before deciding what's next.
    await admin.from('route_stops').update({ status: 'completed', completed_at: nowIso }).eq('id', currentPickupStop.id);

    const nextPickupStop = pickupStops.find(s => s.id !== currentPickupStop.id && s.status !== 'completed');
    if (nextPickupStop) {
      // More stores to visit -- activate the next one, no transitionDelivery
      // call at all (status stays DRIVER_AT_PICKUP).
      await admin.from('route_stops').update({ status: 'active' }).eq('id', nextPickupStop.id).eq('status', 'pending');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, movedToNextPickup: true, nextSellerId: nextPickupStop.seller_id }) };
    }

    // Last pickup stop for this delivery -- aggregate collection across
    // EVERY pickup stop (not just the one just completed) before deciding
    // PICKED_UP vs PARTIALLY_PICKED_UP.
    const pickupStopIds = pickupStops.map(s => s.id);
    const bundleSellerIds = pickupStops.map(s => s.seller_id);
    const { data: finalItems } = await admin.from('route_stop_items').select('collected').in('route_stop_id', pickupStopIds);
    const { data: allBundleItems } = await admin.from('order_items').select('id').eq('order_id', delivery.order_id).in('seller_id', bundleSellerIds);
    const totalItemCount = (allBundleItems || []).length;
    const allCollected = (finalItems || []).length >= totalItemCount && (finalItems || []).every(i => i.collected);

    const targetStatus = allCollected ? 'PICKED_UP' : 'PARTIALLY_PICKED_UP';
    const transitionResult = await transitionDelivery(admin, deliveryId, targetStatus, { type: 'driver', id: driverId }, { eventType: 'ORDER_PICKED_UP', metadata: { all_collected: allCollected } });
    if (!transitionResult.ok) {
      return { statusCode: transitionResult.reason === 'conflict' ? 409 : 500, headers, body: JSON.stringify({ error: 'Could not update pickup status', detail: transitionResult.detail || transitionResult.reason }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, allCollected, delivery: transitionResult.delivery }) };
  }

  // ── start_delivery: PICKED_UP -> IN_ROUTE, drop stop pending -> active, route started -> active ──
  // Real bug found via live testing 2026-09-18 (pre-existing, not introduced
  // by Stage 4's multi-pickup work -- it already affected a single partially-
  // collected pickup): PARTIALLY_PICKED_UP has no direct transition to
  // IN_ROUTE in delivery-state.js's TRANSITIONS map (only PICKED_UP does), so
  // a driver who left even one item uncollected (plan §38's explicitly valid
  // "partial pickup" state) could never start the delivery leg -- "Start
  // Delivery Route" failed every time with no way forward. Fixed by routing
  // through PICKED_UP first when starting from PARTIALLY_PICKED_UP -- both
  // are legitimate "all pickup stops are done, ready to head out" states.
  if (action === 'start_delivery') {
    const { data: currentDelivery, error: currentDeliveryError } = await admin.from('deliveries').select('status').eq('id', deliveryId).maybeSingle();
    if (currentDeliveryError || !currentDelivery) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load delivery' }) };
    if (currentDelivery.status === 'PARTIALLY_PICKED_UP') {
      const upgradeResult = await transitionDelivery(admin, deliveryId, 'PICKED_UP', { type: 'driver', id: driverId }, { eventType: 'ORDER_PICKED_UP', metadata: { note: 'auto-upgrade from partial before starting delivery leg' } });
      if (!upgradeResult.ok) {
        return { statusCode: upgradeResult.reason === 'conflict' ? 409 : 500, headers, body: JSON.stringify({ error: 'Could not start delivery leg', detail: upgradeResult.detail || upgradeResult.reason }) };
      }
    }
    const transitionResult = await transitionDelivery(admin, deliveryId, 'IN_ROUTE', { type: 'driver', id: driverId }, { eventType: 'ROUTE_STARTED' });
    if (!transitionResult.ok) {
      return { statusCode: transitionResult.reason === 'conflict' ? 409 : 500, headers, body: JSON.stringify({ error: 'Could not start delivery leg', detail: transitionResult.detail || transitionResult.reason }) };
    }
    await admin.from('routes').update({ status: 'active' }).eq('id', routeId).eq('status', 'started');
    await admin.from('route_stops').update({ status: 'active' }).eq('id', dropStop.id).eq('status', 'pending');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, delivery: transitionResult.delivery }) };
  }

  // ── arrive_at_drop: IN_ROUTE -> NEXT_STOP -> ARRIVING, drop stop -> arriving ──
  // Stops here -- confirm-delivery-pin.js (Stage 13) is what completes the
  // drop stop, the delivery (-> DELIVERED), and (via the route-completion
  // trigger) the route and payout. Not built yet, by design at this stage.
  if (action === 'arrive_at_drop') {
    const step1 = await transitionDelivery(admin, deliveryId, 'NEXT_STOP', { type: 'driver', id: driverId }, { eventType: 'DRIVER_NEARBY' });
    if (!step1.ok) {
      return { statusCode: step1.reason === 'conflict' ? 409 : 500, headers, body: JSON.stringify({ error: 'Could not update delivery status', detail: step1.detail || step1.reason }) };
    }
    const step2 = await transitionDelivery(admin, deliveryId, 'ARRIVING', { type: 'driver', id: driverId }, { eventType: 'DRIVER_ARRIVING' });
    if (!step2.ok) {
      return { statusCode: step2.reason === 'conflict' ? 409 : 500, headers, body: JSON.stringify({ error: 'Could not update delivery status', detail: step2.detail || step2.reason }) };
    }
    await admin.from('route_stops').update({ status: 'arriving', arrived_at: new Date().toISOString() }).eq('id', dropStop.id).eq('status', 'active');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, delivery: step2.delivery }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unhandled action' }) };
};
