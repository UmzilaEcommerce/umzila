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

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// Delivery network Stage 11 — appends a (pickup, drop) pair to an EXISTING
// route for an accepted 'batch_addition' offer, instead of creating a new
// route (createRouteForAcceptedOffer, below, still handles 'new_route').
// Append-to-end-of-current-stops only -- the same deliberate simplification
// lib/batch-dispatch.js documents (full route-insertion-point optimization
// is plan §33, more machinery than this pilot needs yet).
async function appendToExistingRoute(admin, offer, delivery, driverId) {
  if (!offer.route_id) return { ok: false, reason: 'no_route_on_offer' };
  if (!delivery.quote_id) return { ok: false, reason: 'no_quote' };

  // Re-validate the route is still live and still this driver's -- time may
  // have passed between the offer being created and being accepted.
  const { data: route, error: routeError } = await admin
    .from('routes')
    .select('id, driver_id, status')
    .eq('id', offer.route_id)
    .maybeSingle();
  if (routeError || !route) return { ok: false, reason: 'route_not_found', detail: routeError && routeError.message };
  if (route.driver_id !== driverId) return { ok: false, reason: 'route_driver_mismatch' };
  if (!['started', 'active'].includes(route.status)) return { ok: false, reason: 'route_no_longer_active' };

  const { data: quote, error: quoteError } = await admin
    .from('delivery_quotes')
    .select('pickup_seller_ids')
    .eq('id', delivery.quote_id)
    .maybeSingle();
  if (quoteError || !quote) return { ok: false, reason: 'no_quote', detail: quoteError && quoteError.message };

  const pickupSellerIds = Array.isArray(quote.pickup_seller_ids) ? quote.pickup_seller_ids : [];
  if (pickupSellerIds.length !== 1) return { ok: false, reason: 'multi_seller_unsupported' };
  const sellerId = pickupSellerIds[0];

  const { data: seller, error: sellerError } = await admin
    .from('sellers')
    .select('pickup_geo')
    .eq('id', sellerId)
    .maybeSingle();
  if (sellerError || !seller || !seller.pickup_geo) return { ok: false, reason: 'no_pickup_location', detail: sellerError && sellerError.message };
  if (!delivery.destination_geo) return { ok: false, reason: 'no_destination' };

  const { data: existingStops, error: stopsReadError } = await admin
    .from('route_stops')
    .select('seq_order')
    .eq('route_id', route.id)
    .order('seq_order', { ascending: false })
    .limit(1);
  if (stopsReadError) return { ok: false, reason: 'db_error', detail: stopsReadError.message };
  const nextSeq = (existingStops && existingStops[0] ? existingStops[0].seq_order : 0) + 1;

  const { error: stopsError } = await admin.from('route_stops').insert([
    { route_id: route.id, stop_type: 'pickup', seq_order: nextSeq, seller_id: sellerId, delivery_id: delivery.id, location: seller.pickup_geo, status: 'pending' },
    { route_id: route.id, stop_type: 'drop', seq_order: nextSeq + 1, seller_id: null, delivery_id: delivery.id, location: delivery.destination_geo, status: 'pending' }
  ]);
  if (stopsError) return { ok: false, reason: 'db_error', detail: stopsError.message };

  const { error: deliveryLinkError } = await admin.from('deliveries').update({ route_id: route.id }).eq('id', delivery.id);
  if (deliveryLinkError) return { ok: false, reason: 'db_error', detail: deliveryLinkError.message };
  // offer.route_id was already set when evaluateBatchCandidates() created
  // this offer (the route already existed then) -- nothing to link back.

  return { ok: true, routeId: route.id };
}

// Delivery network Stage 10 — builds the (pickup, drop) route for a freshly-
// accepted 'new_route' offer. Kept local to this file rather than a shared
// lib for now: it's specific to first-time route creation on offer
// acceptance, not something any other caller needs yet.
async function createRouteForAcceptedOffer(admin, offer, delivery, driverId) {
  if (!delivery.quote_id) return { ok: false, reason: 'no_quote' };

  const { data: quote, error: quoteError } = await admin
    .from('delivery_quotes')
    .select('pickup_seller_ids')
    .eq('id', delivery.quote_id)
    .maybeSingle();
  if (quoteError || !quote) return { ok: false, reason: 'no_quote', detail: quoteError && quoteError.message };

  const pickupSellerIds = Array.isArray(quote.pickup_seller_ids) ? quote.pickup_seller_ids : [];
  if (pickupSellerIds.length !== 1) return { ok: false, reason: 'multi_seller_unsupported' }; // same deferred TODO as dispatch.js/get-delivery-quote.js
  const sellerId = pickupSellerIds[0];

  const { data: seller, error: sellerError } = await admin
    .from('sellers')
    .select('pickup_geo')
    .eq('id', sellerId)
    .maybeSingle();
  if (sellerError || !seller || !seller.pickup_geo) return { ok: false, reason: 'no_pickup_location', detail: sellerError && sellerError.message };

  if (!delivery.destination_geo) return { ok: false, reason: 'no_destination' };

  const { data: route, error: routeError } = await admin
    .from('routes')
    .insert({ driver_id: driverId, status: 'assigned' })
    .select('id')
    .single();
  if (routeError) return { ok: false, reason: 'db_error', detail: routeError.message };

  const { error: stopsError } = await admin.from('route_stops').insert([
    { route_id: route.id, stop_type: 'pickup', seq_order: 1, seller_id: sellerId, delivery_id: delivery.id, location: seller.pickup_geo, status: 'pending' },
    { route_id: route.id, stop_type: 'drop', seq_order: 2, seller_id: null, delivery_id: delivery.id, location: delivery.destination_geo, status: 'pending' }
  ]);
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
    .select('id, delivery_id, driver_id, status, expires_at, offer_type, route_id')
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
      ? await appendToExistingRoute(admin, offer, transitionResult.delivery, callerDriver.id)
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

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, response: 'decline', delivery: transitionResult.delivery }) };
};
