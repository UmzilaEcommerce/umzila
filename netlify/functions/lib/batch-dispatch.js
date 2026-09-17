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

const DRIVER_STALENESS_SECONDS = 90; // same constant as dispatch.js/track.html
const OFFER_TTL_MINUTES = 2; // same as dispatch.js

// ── Founder input needed, not invented silently (delivery-network-spec.md
// §C / plan §86/132 explicitly ask for a real ETA-impact threshold number,
// e.g. "don't offer a batch that would push an existing customer's ETA past
// +X minutes"). No live routing/duration is available internally (the paid
// Google Routes API is reserved for get-delivery-quote.js's customer-facing
// quote, same reasoning dispatch.js already documents for omitting
// duration_impact_min) -- so this placeholder is expressed as a straight-
// line distance proxy instead of true ETA minutes. 1.5km is a deliberately
// conservative guess for a small campus service area; TRACKED as an open
// "ACTION NEEDED FROM YOU" item (§C) until the founder gives a real number,
// at which point this should become a true minutes-based check once
// GOOGLE_ROUTES_SERVER_KEY is live. ──
const PLACEHOLDER_BATCH_IMPACT_KM = 1.5;

const PLACEHOLDER_PAYOUT_RATE = 0.75; // same placeholder as dispatch.js, same founder-pending formula

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
    .select('id, pickup_seller_ids, total_delivery_fee')
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
  if (distanceKm > PLACEHOLDER_BATCH_IMPACT_KM) {
    // Correctly stays READY_FOR_DISPATCH -- the caller falls through to the
    // normal idle-driver dispatchDelivery() path.
    return { batched: false, reason: 'over_impact_threshold', detail: `${distanceKm.toFixed(2)}km > ${PLACEHOLDER_BATCH_IMPACT_KM}km threshold` };
  }

  const totalDeliveryFee = Number(quote.total_delivery_fee) || 0;
  const payoutAmount = Math.round(totalDeliveryFee * PLACEHOLDER_PAYOUT_RATE * 100) / 100;
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

module.exports = { evaluateBatchCandidates, DRIVER_STALENESS_SECONDS, OFFER_TTL_MINUTES, PLACEHOLDER_BATCH_IMPACT_KM };
