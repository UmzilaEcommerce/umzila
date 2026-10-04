// netlify/functions/respond-to-driver-offer.js
//
// Delivery network Stage 8 — a driver accepts or declines a driver_offers row
// created by lib/dispatch.js. Never trusts a client-supplied driverId: the
// offer's driver_id is always checked against the caller's OWN `drivers` row,
// resolved from their auth token.
//
// All deliveries.status changes still go exclusively through
// transitionDelivery() (lib/delivery-state.js).
const { createClient } = require('@supabase/supabase-js');
const { transitionDelivery } = require('./lib/delivery-state');
const { planTrip } = require('./lib/route-insertion');
const { sweepWaitingDeliveries } = require('./lib/batch-dispatch');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// Multi-drop trips (2026-10-05): an accepted 'batch_addition' offer joins the
// rider's EXISTING trip. The trip may have moved on since the offer was made,
// so it is re-planned now (lib/route-insertion.js — fastest whole trip, nobody
// already on it more than 8 min later unless this order bought priority, max
// 5 orders) and applied atomically by apply_route_sequence(). If it no longer
// fits, the rider is told and the order goes back to waiting.
async function planBatchAddition(admin, offer) {
  if (!offer.route_id) return { ok: false, reason: 'no_route_on_offer' };
  const { data: point } = await admin.rpc('get_delivery_plan_point', { p_delivery_id: offer.delivery_id });
  if (!point || !point.pickup || !point.drop || point.seller_count !== 1) return { ok: false, reason: 'unroutable' };
  const { data: input } = await admin.rpc('get_route_plan_input', { p_route_id: offer.route_id });
  if (!input || !input.route) return { ok: false, reason: 'route_not_found' };
  if (input.route.driver_id !== offer.driver_id) return { ok: false, reason: 'route_driver_mismatch' };
  if (!['assigned', 'started', 'active'].includes(input.route.status)) return { ok: false, reason: 'route_no_longer_active' };
  // An offer made because no free rider existed is re-planned the same way.
  const relaxed = !!(offer.insertion && offer.insertion.relaxed);
  const plan = await planTrip(admin, input, { deliveryId: offer.delivery_id, sellerId: point.seller_id, pickup: point.pickup, drop: point.drop, customer: point.customer, priority: !!point.priority }, { relaxed });
  return plan.ok ? { ok: true, plan } : { ok: false, reason: plan.reason };
}

async function appendToExistingRoute(admin, offer, delivery) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const planned = await planBatchAddition(admin, offer);
    if (!planned.ok) return { ok: false, reason: planned.reason };
    const { error } = await admin.rpc('apply_route_sequence', { p_route_id: offer.route_id, p_new_delivery_id: delivery.id, p_order: planned.plan.order });
    if (!error) return { ok: true, routeId: offer.route_id, plan: planned.plan };
    if (!/plan_stale/.test(error.message || '')) return { ok: false, reason: 'db_error', detail: error.message };
    // The rider moved on between planning and applying — plan again once.
  }
  return { ok: false, reason: 'plan_stale' };
}

// Delivery network Stage 10 (Stage 4, 2026-09-17: N pickups) — builds the
// route for a freshly-accepted 'new_route' offer: one pickup stop per
// bundled seller (seq_order 1..N, first pending stop is the only one
// 'active' at a time — see advance-route.js's complete_pickup) followed by
// one drop stop. Kept local to this file rather than a shared lib for now:
// it's specific to first-time route creation on offer acceptance, not
// something any other caller needs yet.
async function createRouteForAcceptedOffer(admin, offer, delivery, driverId) {
  if (!delivery.quote_id) return { ok: false, reason: 'no_quote' };

  const { data: quote, error: quoteError } = await admin
    .from('delivery_quotes')
    .select('pickup_seller_ids')
    .eq('id', delivery.quote_id)
    .maybeSingle();
  if (quoteError || !quote) return { ok: false, reason: 'no_quote', detail: quoteError && quoteError.message };

  const quoteSellerIds = Array.isArray(quote.pickup_seller_ids) ? quote.pickup_seller_ids : [];
  const MAX_BUNDLE_SELLERS = 2; // matches get-delivery-quote.js/dispatch.js's own cap
  if (!quoteSellerIds.length || quoteSellerIds.length > MAX_BUNDLE_SELLERS) {
    return { ok: false, reason: 'multi_seller_unsupported' };
  }

  const { data: sellersData, error: sellersError } = await admin
    .from('sellers')
    .select('id, pickup_geo')
    .in('id', quoteSellerIds);
  if (sellersError) return { ok: false, reason: 'no_pickup_location', detail: sellersError.message };
  const pickupGeoBySellerId = {};
  for (const id of quoteSellerIds) {
    const row = (sellersData || []).find(s => s.id === id);
    if (!row || !row.pickup_geo) return { ok: false, reason: 'no_pickup_location' };
    pickupGeoBySellerId[id] = row.pickup_geo;
  }

  if (!delivery.destination_geo) return { ok: false, reason: 'no_destination' };

  // Re-sequence independently from the quote's own (pre-driver) ordering,
  // nearest-pickup-first from this driver's real current position -- these
  // are allowed to disagree (see get-delivery-quote.js's note on why). Falls
  // back to the quote's stored order if the driver has no GPS fix yet,
  // rather than failing route creation over a missing heartbeat.
  let orderedSellerIds = quoteSellerIds;
  if (quoteSellerIds.length > 1) {
    const { data: sequenced, error: sequenceError } = await admin.rpc('order_pickups_by_driver_distance', {
      p_driver_id: driverId,
      p_seller_ids: quoteSellerIds
    });
    if (!sequenceError && Array.isArray(sequenced) && sequenced.length === quoteSellerIds.length) {
      orderedSellerIds = sequenced.map(r => r.seller_id);
    }
  }

  const { data: route, error: routeError } = await admin
    .from('routes')
    .insert({ driver_id: driverId, status: 'assigned' })
    .select('id')
    .single();
  if (routeError) return { ok: false, reason: 'db_error', detail: routeError.message };

  const pickupStopRows = orderedSellerIds.map((sellerId, idx) => ({
    route_id: route.id, stop_type: 'pickup', seq_order: idx + 1, seller_id: sellerId,
    delivery_id: delivery.id, location: pickupGeoBySellerId[sellerId], status: 'pending'
  }));
  const dropStopRow = {
    route_id: route.id, stop_type: 'drop', seq_order: orderedSellerIds.length + 1, seller_id: null,
    delivery_id: delivery.id, location: delivery.destination_geo, status: 'pending'
  };

  const { error: stopsError } = await admin.from('route_stops').insert([...pickupStopRows, dropStopRow]);
  if (stopsError) {
    await admin.from('routes').delete().eq('id', route.id); // best-effort rollback of the orphaned route
    return { ok: false, reason: 'db_error', detail: stopsError.message };
  }

  // Link the delivery and the accepted offer back to this route -- the
  // offer's route_id is what the payout trigger sums by when the route
  // eventually completes (compute_driver_payout_on_route_completion).
  const { error: deliveryLinkError } = await admin.from('deliveries').update({ route_id: route.id }).eq('id', delivery.id);
  if (deliveryLinkError) return { ok: false, reason: 'db_error', detail: deliveryLinkError.message };
  const { error: offerLinkError } = await admin.from('driver_offers').update({ route_id: route.id }).eq('id', offer.id);
  if (offerLinkError) return { ok: false, reason: 'db_error', detail: offerLinkError.message };

  return { ok: true, routeId: route.id };
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

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { offerId, response } = body;
  if (!offerId || typeof offerId !== 'string' || !['accept', 'decline'].includes(response)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "offerId and response ('accept'|'decline') required" }) };
  }

  // Resolve the caller's OWN driver row -- this is the only source of truth
  // for "is this offer theirs", never a client-supplied id.
  const { data: callerDriver, error: driverLookupError } = await admin
    .from('drivers')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (driverLookupError) {
    console.error('respond-to-driver-offer: driver lookup failed', driverLookupError.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to look up driver record' }) };
  }
  if (!callerDriver) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'No driver record for this account' }) };
  }

  const { data: offer, error: offerError } = await admin
    .from('driver_offers')
    .select('id, delivery_id, driver_id, status, expires_at, offer_type, route_id, insertion')
    .eq('id', offerId)
    .maybeSingle();
  if (offerError) {
    console.error('respond-to-driver-offer: offer lookup failed', offerError.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to look up offer' }) };
  }
  if (!offer) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Offer not found' }) };
  }
  if (offer.driver_id !== callerDriver.id) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'This offer does not belong to you' }) };
  }
  if (offer.status !== 'pending') {
    return { statusCode: 409, headers, body: JSON.stringify({ error: 'This offer has already been responded to', status: offer.status }) };
  }
  if (new Date(offer.expires_at).getTime() <= Date.now()) {
    // Opportunistically mark it expired so it stops showing as an active
    // pending offer -- best-effort, the 409 below is returned either way.
    await admin.from('driver_offers').update({ status: 'expired' }).eq('id', offer.id).eq('status', 'pending');
    return { statusCode: 409, headers, body: JSON.stringify({ error: 'This offer has expired' }) };
  }

  const nowIso = new Date().toISOString();

  if (response === 'accept') {
    // An addition to a trip: make sure it still fits before taking it.
    if (offer.offer_type === 'batch_addition') {
      const pre = await planBatchAddition(admin, offer);
      if (!pre.ok) {
        await admin.from('driver_offers').update({ status: 'expired', responded_at: nowIso }).eq('id', offer.id).eq('status', 'pending');
        await transitionDelivery(admin, offer.delivery_id, 'READY_FOR_DISPATCH', { type: 'system' }, { eventType: 'BATCH_NO_LONGER_FITS', metadata: { offer_id: offer.id, reason: pre.reason } });
        sweepWaitingDeliveries(admin, { limit: 3 }).catch(() => {});
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'This order no longer fits your trip — it will go to another rider.', reason: pre.reason }) };
      }
    }

    // Optimistic guard: only one concurrent 'accept'/'decline' can flip this
    // row from pending -- if 0 rows update, someone else (or the expiry
    // check above) already resolved it.
    const { data: claimed, error: claimError } = await admin
      .from('driver_offers')
      .update({ status: 'accepted', responded_at: nowIso })
      .eq('id', offer.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (claimError) {
      console.error('respond-to-driver-offer: accept update failed', claimError.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to accept offer' }) };
    }
    if (!claimed) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'This offer has already been responded to' }) };
    }

    const transitionResult = await transitionDelivery(
      admin,
      offer.delivery_id,
      'ASSIGNED',
      { type: 'driver', id: callerDriver.id },
      { eventType: 'DRIVER_ACCEPTED', metadata: { offer_id: offer.id } }
    );

    if (!transitionResult.ok) {
      // Don't leave the offer showing 'accepted' against a delivery that
      // never actually moved to ASSIGNED (e.g. it was cancelled concurrently)
      // -- revert so the offer's status stays truthful.
      const { error: revertError } = await admin
        .from('driver_offers')
        .update({ status: 'pending', responded_at: null })
        .eq('id', offer.id)
        .eq('status', 'accepted');
      if (revertError) console.warn('respond-to-driver-offer: failed to revert offer after transition failure', revertError.message);
      return {
        statusCode: transitionResult.reason === 'conflict' ? 409 : 500,
        headers,
        body: JSON.stringify({ error: 'Could not confirm assignment', detail: transitionResult.detail || transitionResult.reason })
      };
    }

    // Delivery network Stage 10/11 -- an ASSIGNED delivery with no route is a
    // dead end for the driver (nothing to navigate to, nothing to check off),
    // so route creation/appending is treated as part of accepting, not a
    // best-effort afterthought: any failure here rolls back the transition
    // and the offer claim, same as the transition-failure branch above,
    // rather than leaving the driver "assigned" to a delivery with no actual
    // route. 'batch_addition' offers append to their existing route instead
    // of creating a new one.
    const routeResult = offer.offer_type === 'batch_addition'
      ? await appendToExistingRoute(admin, offer, transitionResult.delivery)
      : await createRouteForAcceptedOffer(admin, offer, transitionResult.delivery, callerDriver.id);
    if (!routeResult.ok) {
      await transitionDelivery(admin, offer.delivery_id, 'REASSIGNING', { type: 'system' }, { eventType: 'ROUTE_CREATION_FAILED', metadata: { offer_id: offer.id, reason: routeResult.reason } })
        .catch(() => {}); // best-effort -- the error below is returned regardless
      const { error: revertError2 } = await admin
        .from('driver_offers')
        .update({ status: 'pending', responded_at: null })
        .eq('id', offer.id)
        .eq('status', 'accepted');
      if (revertError2) console.warn('respond-to-driver-offer: failed to revert offer after route-creation failure', revertError2.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not create route for this delivery', detail: routeResult.detail || routeResult.reason }) };
    }

    // Two orders from one store at the same time: now that this rider has a
    // trip, offer them the other waiting order(s) that fit it straight away.
    await sweepWaitingDeliveries(admin, { limit: 5 });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, response: 'accept', delivery: transitionResult.delivery, routeId: routeResult.routeId }) };
  }

  // response === 'decline'
  const { data: claimed, error: claimError } = await admin
    .from('driver_offers')
    .update({ status: 'declined', responded_at: nowIso })
    .eq('id', offer.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (claimError) {
    console.error('respond-to-driver-offer: decline update failed', claimError.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to decline offer' }) };
  }
  if (!claimed) {
    return { statusCode: 409, headers, body: JSON.stringify({ error: 'This offer has already been responded to' }) };
  }

  // Sends the delivery back to the dispatch pool. Deliberately does NOT call
  // dispatchDelivery() again here -- re-offering to another driver is an
  // admin manual-redispatch action (dispatch-delivery.js) or a future
  // auto-retry stage, not this endpoint's job (a declining driver shouldn't
  // block on however long the next dispatch attempt takes).
  const transitionResult = await transitionDelivery(
    admin,
    offer.delivery_id,
    'READY_FOR_DISPATCH',
    { type: 'driver', id: callerDriver.id },
    { eventType: 'DRIVER_DECLINED', metadata: { offer_id: offer.id } }
  );

  if (!transitionResult.ok) {
    // The decline itself is already recorded and driver-facing; log and
    // report the transition problem without pretending nothing went wrong.
    console.warn('respond-to-driver-offer: decline recorded but delivery transition failed', transitionResult.reason, transitionResult.detail);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Offer declined, but the delivery could not be returned to the dispatch pool', detail: transitionResult.detail || transitionResult.reason })
    };
  }

  if (offer.offer_type === 'batch_addition') await sweepWaitingDeliveries(admin, { limit: 3 });
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, response: 'decline', delivery: transitionResult.delivery }) };
};
