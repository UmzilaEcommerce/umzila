// netlify/functions/lib/batch-dispatch.js
//
// Delivery network Stage 11 (delivery-network-spec.md §E, "Optional dynamic
// batch offers") — for a newly-READY_FOR_DISPATCH delivery, checks whether
// an already-moving driver (an existing 'started'/'active' route) is close
// enough to the new pickup to reasonably add it to their current route,
// instead of only ever waiting for a separate idle driver (lib/dispatch.js).
//
// Deliberate simplification, flagged by the plan itself as acceptable for
// this pilot: APPEND-TO-END-OF-CURRENT-STOPS ONLY. The plan's own §33
// describes a fuller 3-option route-insertion comparison (insert before/
// between/after existing stops) -- that's more machinery than a 2-rider
// pilot needs today. Tracked as a named future enhancement once a driver
// regularly carries 3+ simultaneous stops, not silently dropped.
//
// Every delivery status change still goes exclusively through
// transitionDelivery() (./delivery-state.js) -- this module never writes
// deliveries.status itself.
const { transitionDelivery } = require('./delivery-state');
const { estimatePayout } = require('./payout-formula');

const DRIVER_STALENESS_SECONDS = 90; // same constant as dispatch.js/track.html
const OFFER_TTL_MINUTES = 2; // same as dispatch.js

// Founder-confirmed 2026-09-17 (delivery-network-spec.md §C item 5): max 90
// minutes of added time to justify a batch addition, ~60 minutes as a
// typical/average target (tracked for later analytics review, not a second
// hard gate -- one clear threshold is operationally less ambiguous than two
// active at once).
const MAX_BATCH_IMPACT_MINUTES = 90;
const TARGET_AVERAGE_BATCH_IMPACT_MINUTES = 60;

// Estimating added minutes without a live Google Routes call for THIS leg
// specifically (that stays reserved for get-delivery-quote.js's paid,
// customer-facing quote -- calling it again per batch-evaluation would add
// ongoing cost for a low-stakes internal dispatch decision). Decomposed into
// two legs: driver's current position -> new pickup (unknown; estimated from
// find_batchable_routes' straight-line distance at an assumed urban speed),
// and new pickup -> destination (REAL: the delivery's own delivery_quotes
// row already has this from Google Routes at quote-creation time -- reused
// here rather than re-estimated). This is an approximation, not exact, but
// meaningfully better than a flat distance-only proxy since half of it is
// real routed-duration data.
const ASSUMED_URBAN_SPEED_KMH = 25;

function estimateAddedMinutes(driverToPickupKm, quoteDurationMin) {
  const legToPickupMin = (driverToPickupKm / ASSUMED_URBAN_SPEED_KMH) * 60;
  const legPickupToDropMin = Number.isFinite(quoteDurationMin) ? quoteDurationMin : legToPickupMin; // fall back to a symmetric guess if the quote has no duration for some reason
  return legToPickupMin + legPickupToDropMin;
}

// Rider payout formula confirmed by the founder 2026-09-17 -- see
// lib/payout-formula.js for the real formula and why this is only an
// ESTIMATE (the actual payout is computed once the whole route completes).

/**
 * Attempts to add a single READY_FOR_DISPATCH delivery onto an existing,
 * already-moving driver's route as a batch stop.
 *
 * Returns (never throws for an expected outcome):
 *   { batched: true, offerId, routeId, driverId }
 *   { batched: false, reason:
 *       'not_ready' | 'already_offered' | 'no_quote' | 'multi_seller_unsupported'
 *     | 'no_pickup_location' | 'no_batchable_routes' | 'over_impact_threshold'
 *     | 'transition_failed'
 *   , detail? }
 */
async function evaluateBatchCandidates(supabase, deliveryId) {
  if (!supabase || !deliveryId) {
    return { batched: false, reason: 'not_ready', detail: 'Missing supabase/deliveryId' };
  }

  const { data: delivery, error: deliveryError } = await supabase
    .from('deliveries')
    .select('id, status, quote_id')
    .eq('id', deliveryId)
    .maybeSingle();
  if (deliveryError || !delivery || delivery.status !== 'READY_FOR_DISPATCH') {
    return { batched: false, reason: 'not_ready', detail: deliveryError && deliveryError.message };
  }

  // Same pending-offer guard as dispatchDelivery() -- never double-offer.
  const { data: existingOffer, error: existingOfferError } = await supabase
    .from('driver_offers')
    .select('id')
    .eq('delivery_id', deliveryId)
    .eq('status', 'pending')
    .maybeSingle();
  if (existingOfferError) return { batched: false, reason: 'not_ready', detail: existingOfferError.message };
  if (existingOffer) return { batched: false, reason: 'already_offered' };

  if (!delivery.quote_id) return { batched: false, reason: 'no_quote' };
  const { data: quote, error: quoteError } = await supabase
    .from('delivery_quotes')
    .select('id, pickup_seller_ids, total_delivery_fee, distance_km, duration_min')
    .eq('id', delivery.quote_id)
    .maybeSingle();
  if (quoteError || !quote) return { batched: false, reason: 'no_quote', detail: quoteError && quoteError.message };

  const pickupSellerIds = Array.isArray(quote.pickup_seller_ids) ? quote.pickup_seller_ids : [];
  if (pickupSellerIds.length !== 1) return { batched: false, reason: 'multi_seller_unsupported' }; // same deferred TODO as dispatch.js
  const sellerId = pickupSellerIds[0];

  const { data: seller, error: sellerError } = await supabase
    .from('sellers')
    .select('id, pickup_geo')
    .eq('id', sellerId)
    .maybeSingle();
  if (sellerError || !seller || !seller.pickup_geo) {
    return { batched: false, reason: 'no_pickup_location', detail: sellerError && sellerError.message };
  }

  const { data: candidates, error: candidatesError } = await supabase.rpc('find_batchable_routes', {
    p_seller_geo: seller.pickup_geo,
    p_max_age_seconds: DRIVER_STALENESS_SECONDS
  });
  if (candidatesError) {
    console.warn('evaluateBatchCandidates: find_batchable_routes failed', candidatesError.message);
    return { batched: false, reason: 'no_batchable_routes', detail: candidatesError.message };
  }
  if (!Array.isArray(candidates) || !candidates.length) {
    return { batched: false, reason: 'no_batchable_routes' };
  }

  const nearest = candidates[0];
  const distanceKm = Number.isFinite(nearest.distance_m) ? nearest.distance_m / 1000 : Infinity;
  const addedMinutes = estimateAddedMinutes(distanceKm, quote.duration_min);
  if (addedMinutes > MAX_BATCH_IMPACT_MINUTES) {
    // Correctly stays READY_FOR_DISPATCH -- the caller falls through to the
    // normal idle-driver dispatchDelivery() path.
    return { batched: false, reason: 'over_impact_threshold', detail: `~${addedMinutes.toFixed(1)}min > ${MAX_BATCH_IMPACT_MINUTES}min threshold` };
  }
  if (addedMinutes > TARGET_AVERAGE_BATCH_IMPACT_MINUTES) {
    // Still allowed (under the hard cap) but worth a log line -- this is the
    // founder's "average" figure, tracked for future analytics review rather
    // than gated on right now.
    console.warn('evaluateBatchCandidates: batch offer above the target average impact', addedMinutes.toFixed(1), 'min (allowed, under the', MAX_BATCH_IMPACT_MINUTES, 'min hard cap)');
  }

  // Pre-acceptance estimate — a batch addition is, by definition, one extra
  // pickup + one extra drop tacked onto whatever route it joins, so those
  // count as 1 each. Real formula, see lib/payout-formula.js.
  const payoutAmount = estimatePayout({ distanceKm: quote.distance_km, durationMin: quote.duration_min, extraDrops: 1, extraPickups: 1 });
  const expiresAt = new Date(Date.now() + OFFER_TTL_MINUTES * 60 * 1000).toISOString();

  const { data: offer, error: offerInsertError } = await supabase
    .from('driver_offers')
    .insert({
      delivery_id: deliveryId,
      driver_id: nearest.driver_id,
      route_id: nearest.route_id,
      offer_type: 'batch_addition',
      payout_amount: payoutAmount,
      distance_impact_km: distanceKm,
      duration_impact_min: addedMinutes,
      status: 'pending',
      expires_at: expiresAt
    })
    .select('id')
    .single();

  if (offerInsertError) {
    if (offerInsertError.code === '23505') return { batched: false, reason: 'already_offered' };
    console.warn('evaluateBatchCandidates: failed to insert driver_offers row', offerInsertError.message);
    return { batched: false, reason: 'no_batchable_routes', detail: offerInsertError.message };
  }

  const transitionResult = await transitionDelivery(
    supabase,
    deliveryId,
    'OFFERED',
    { type: 'system' },
    { eventType: 'BATCH_OFFERED', metadata: { driver_id: nearest.driver_id, route_id: nearest.route_id, offer_id: offer.id } }
  );

  if (!transitionResult.ok) {
    const { error: cleanupError } = await supabase.from('driver_offers').delete().eq('id', offer.id);
    if (cleanupError) console.warn('evaluateBatchCandidates: failed to roll back orphaned offer', cleanupError.message);
    return { batched: false, reason: 'transition_failed', detail: transitionResult.detail || transitionResult.reason };
  }

  return { batched: true, offerId: offer.id, routeId: nearest.route_id, driverId: nearest.driver_id };
}

module.exports = { evaluateBatchCandidates, DRIVER_STALENESS_SECONDS, OFFER_TTL_MINUTES, MAX_BATCH_IMPACT_MINUTES, TARGET_AVERAGE_BATCH_IMPACT_MINUTES };
