// netlify/functions/lib/dispatch.js
//
// Delivery network Stage 8 (delivery-network-spec.md §E) — turns a delivery
// that's sitting at READY_FOR_DISPATCH into a live offer to the nearest
// eligible online driver. This is a plain library module (no exports.handler)
// so it can be called both from dispatch-delivery.js's thin HTTP wrapper and
// directly, same-request, from advance-delivery-on-fulfillment.js — no extra
// HTTP hop needed for a seller's "fulfilled" action to actually reach a rider.
//
// Every delivery status change still goes exclusively through
// transitionDelivery() (./delivery-state.js) — this module never writes
// deliveries.status itself.
const { transitionDelivery } = require('./delivery-state');
const { estimatePayout } = require('./payout-formula');

// Matches track.html/§B.1's live-tracking staleness rule exactly (a driver
// whose last heartbeat is older than this is treated as not really
// reachable right now) — reusing the same number here keeps "is this driver
// actually online" consistent across dispatch and customer tracking.
const DRIVER_STALENESS_SECONDS = 90;

// No existing convention in this repo for an offer response window — 2
// minutes is a reasonable, deliberately short pilot default (a 2-driver
// pilot needs fast turnaround so a declined/ignored offer doesn't strand the
// order); easy to tune later via a config row if that's ever needed.
const OFFER_TTL_MINUTES = 2;

// Rider payout formula confirmed by the founder 2026-09-17 (plan §102,
// delivery-network-spec.md §C item 6) -- see lib/payout-formula.js for the
// real formula and why this is only an ESTIMATE (the actual payout is
// computed from the route's real final stats once it's completed).

/**
 * Attempts to dispatch a single READY_FOR_DISPATCH delivery to the nearest
 * eligible, currently-online driver.
 *
 * Returns (never throws for an expected outcome):
 *   { dispatched: true, offerId, driverId }
 *   { dispatched: false, reason:
 *       'not_ready'                 -- delivery missing or not READY_FOR_DISPATCH
 *     | 'already_offered'           -- a pending offer already exists for this delivery
 *     | 'no_quote'                  -- delivery has no usable delivery_quotes row
 *     | 'multi_seller_unsupported'  -- quote spans >1 seller (deferred, tracked TODO)
 *     | 'no_pickup_location'        -- seller has no pickup_geo configured yet
 *     | 'no_drivers_online'         -- zero eligible drivers right now
 *     | 'transition_failed'         -- offer inserted but the OFFERED transition
 *                                      didn't go through; the offer is rolled back
 *   , detail? }
 */
async function dispatchDelivery(supabase, deliveryId) {
  if (!supabase || !deliveryId) {
    return { dispatched: false, reason: 'not_ready', detail: 'Missing supabase/deliveryId' };
  }

  const { data: delivery, error: deliveryError } = await supabase
    .from('deliveries')
    .select('id, status, quote_id')
    .eq('id', deliveryId)
    .maybeSingle();

  if (deliveryError) {
    console.warn('dispatchDelivery: failed to read delivery', deliveryError.message);
    return { dispatched: false, reason: 'not_ready', detail: deliveryError.message };
  }
  if (!delivery || delivery.status !== 'READY_FOR_DISPATCH') {
    return { dispatched: false, reason: 'not_ready' };
  }

  // Don't create a second pending offer for a delivery that already has one
  // in flight. (A unique partial index on driver_offers(delivery_id) WHERE
  // status='pending' backs this up at the DB level for the concurrent case —
  // this check just avoids the wasted work/round trip in the common case.)
  const { data: existingOffer, error: existingOfferError } = await supabase
    .from('driver_offers')
    .select('id')
    .eq('delivery_id', deliveryId)
    .eq('status', 'pending')
    .maybeSingle();
  if (existingOfferError) {
    console.warn('dispatchDelivery: failed to check existing offers', existingOfferError.message);
    return { dispatched: false, reason: 'not_ready', detail: existingOfferError.message };
  }
  if (existingOffer) {
    return { dispatched: false, reason: 'already_offered' };
  }

  if (!delivery.quote_id) {
    return { dispatched: false, reason: 'no_quote' };
  }
  const { data: quote, error: quoteError } = await supabase
    .from('delivery_quotes')
    .select('id, pickup_seller_ids, total_delivery_fee, distance_km, duration_min')
    .eq('id', delivery.quote_id)
    .maybeSingle();
  if (quoteError || !quote) {
    console.warn('dispatchDelivery: failed to load delivery_quotes row', quoteError && quoteError.message);
    return { dispatched: false, reason: 'no_quote', detail: quoteError && quoteError.message };
  }

  // Multi-seller bundling/split-delivery is an explicitly deferred concern
  // (plan §15/§137, same TODO as get-delivery-quote.js's MULTI_SELLER_REASON
  // path) — for this pilot pickup_seller_ids is always exactly one id.
  const pickupSellerIds = Array.isArray(quote.pickup_seller_ids) ? quote.pickup_seller_ids : [];
  if (pickupSellerIds.length !== 1) {
    return { dispatched: false, reason: 'multi_seller_unsupported' };
  }
  const sellerId = pickupSellerIds[0];

  const { data: seller, error: sellerError } = await supabase
    .from('sellers')
    .select('id, pickup_geo')
    .eq('id', sellerId)
    .maybeSingle();
  if (sellerError) {
    console.warn('dispatchDelivery: failed to load seller pickup location', sellerError.message);
    return { dispatched: false, reason: 'no_pickup_location', detail: sellerError.message };
  }
  if (!seller || !seller.pickup_geo) {
    return { dispatched: false, reason: 'no_pickup_location' };
  }

  // find_nearest_eligible_drivers (delivery_stage8_dispatch_helpers migration)
  // does the online/eligible/live-delivery/90s-staleness filtering and
  // nearest-first ST_Distance ordering server-side — PostgREST can't express
  // "order by distance to this seller's pickup point" as a plain .select()
  // query, same reason get-delivery-quote.js's find_service_zone_for_point
  // RPC exists. Full multi-factor ranking (plan's original rider-scoring
  // model) is deliberately deferred for this 2-driver pilot; nearest-first is
  // the whole ranking for now.
  const { data: candidates, error: candidatesError } = await supabase.rpc('find_nearest_eligible_drivers', {
    p_seller_id: sellerId,
    p_max_age_seconds: DRIVER_STALENESS_SECONDS
  });
  if (candidatesError) {
    console.warn('dispatchDelivery: find_nearest_eligible_drivers failed', candidatesError.message);
    return { dispatched: false, reason: 'no_drivers_online', detail: candidatesError.message };
  }
  if (!Array.isArray(candidates) || !candidates.length) {
    // Delivery correctly stays READY_FOR_DISPATCH — a later heartbeat or a
    // manual admin redispatch (dispatch-delivery.js) can pick it up.
    return { dispatched: false, reason: 'no_drivers_online' };
  }

  const nearest = candidates[0];
  const distanceKm = Number.isFinite(nearest.distance_m) ? nearest.distance_m / 1000 : null;

  // Pre-acceptance estimate — a single-delivery new route has no "extra"
  // pickups/drops (this is the only stop pair), so extraDrops/extraPickups
  // stay 0. Real formula, see lib/payout-formula.js.
  const payoutAmount = estimatePayout({ distanceKm: quote.distance_km, durationMin: quote.duration_min });

  const expiresAt = new Date(Date.now() + OFFER_TTL_MINUTES * 60 * 1000).toISOString();

  const { data: offer, error: offerInsertError } = await supabase
    .from('driver_offers')
    .insert({
      delivery_id: deliveryId,
      driver_id: nearest.driver_id,
      offer_type: 'new_route',
      payout_amount: payoutAmount,
      distance_impact_km: distanceKm,
      // duration_impact_min intentionally omitted -- no external routing call
      // here (that's the paid Google Routes API, reserved for get-delivery-quote.js's
      // customer-facing quote, not an internal ranking/informational field).
      status: 'pending',
      expires_at: expiresAt
    })
    .select('id')
    .single();

  if (offerInsertError) {
    // 23505 = unique_violation -- the driver_offers_pending_per_delivery_uniq
    // partial index caught a race against another concurrent dispatch call.
    if (offerInsertError.code === '23505') {
      return { dispatched: false, reason: 'already_offered' };
    }
    console.warn('dispatchDelivery: failed to insert driver_offers row', offerInsertError.message);
    return { dispatched: false, reason: 'no_drivers_online', detail: offerInsertError.message };
  }

  const transitionResult = await transitionDelivery(
    supabase,
    deliveryId,
    'OFFERED',
    { type: 'system' },
    { eventType: 'DRIVER_ASSIGNED', metadata: { driver_id: nearest.driver_id, offer_id: offer.id } }
  );

  if (!transitionResult.ok) {
    // Keep driver_offers consistent with deliveries.status -- an offer
    // shouldn't sit "pending" against a delivery that never actually left
    // READY_FOR_DISPATCH (e.g. it was concurrently cancelled). Best-effort:
    // the transition itself already failed, so this failing too doesn't make
    // things worse, just leaves a stray offer for the next redispatch to
    // clean up via the pending-offer check above.
    const { error: cleanupError } = await supabase.from('driver_offers').delete().eq('id', offer.id);
    if (cleanupError) console.warn('dispatchDelivery: failed to roll back orphaned offer', cleanupError.message);
    return { dispatched: false, reason: 'transition_failed', detail: transitionResult.detail || transitionResult.reason };
  }

  return { dispatched: true, offerId: offer.id, driverId: nearest.driver_id };
}

module.exports = { dispatchDelivery, DRIVER_STALENESS_SECONDS, OFFER_TTL_MINUTES };
