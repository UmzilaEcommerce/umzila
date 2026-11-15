// netlify/functions/lib/batch-dispatch.js
//
// Multi-drop trips (rebuilt 2026-10-05; delivery-network-spec.md §31–35).
// For a delivery waiting for a rider (READY_FOR_DISPATCH), checks whether it
// fits onto a trip a rider already has — heading to the first store
// ('assigned'), collecting ('started') or delivering ('active') — and if so
// OFFERS it to that rider as an optional addition (spec §32: the rider sees
// the extra distance/time/pay and chooses ADD TO TRIP or NO THANKS; declining
// never affects their current trip).
//
// Where it slots in comes from lib/route-insertion.js planTrip(): every
// not-yet-started stop may be re-ordered for the fastest whole trip, nobody
// already on the trip gets more than 8 min later (unless the new order bought
// priority), up to 5 orders per trip. The plan is stored on the offer
// (driver_offers.insertion) for the rider to see, and re-planned on accept
// (respond-to-driver-offer.js) because the trip may have moved on.
//
// Single-store orders only — an order from 2 stores always gets a fresh trip
// from an idle rider (lib/dispatch.js).
//
// Delivery timeslots (2026-11-14): a delivery whose order has a run is not offered
// before that run's cut-off (isHeldForRun, lib/dispatch.js — the one rule every offer
// path asks), and once released, same-run orders are grouped: while one run-mate has
// an unanswered fresh-trip offer, the others wait (they then batch onto that rider's
// trip when it is accepted — respond-to-driver-offer re-sweeps). Orders without a run
// (or timeslots off) take none of these branches.
//
// Every delivery status change goes through transitionDelivery().
const { transitionDelivery } = require('./delivery-state');
const { estimatePayout } = require('./payout-formula');
const { planTrip, MAX_DELIVERIES_PER_TRIP } = require('./route-insertion');
const { dispatchDelivery, getRunInfo, isHeldForRun } = require('./dispatch');

const DRIVER_STALENESS_SECONDS = 90; // same constant as dispatch.js/track.html
const OFFER_TTL_MINUTES = 2;         // same as dispatch.js
const BATCHING_ENABLED = true;
const MAX_CANDIDATE_TRIPS = 3;       // nearest trips evaluated per delivery

/**
 * Returns (never throws for an expected outcome):
 *   { batched: true, offerId, routeId, driverId, plan }
 *   { batched: false, reason, detail? }
 */
async function evaluateBatchCandidates(supabase, deliveryId, opts = {}) {
  if (!BATCHING_ENABLED) return { batched: false, reason: 'disabled' };
  if (!supabase || !deliveryId) return { batched: false, reason: 'not_ready', detail: 'Missing supabase/deliveryId' };

  const { data: point, error: pointError } = await supabase.rpc('get_delivery_plan_point', { p_delivery_id: deliveryId });
  if (pointError || !point) return { batched: false, reason: 'not_ready', detail: pointError && pointError.message };
  if (point.status !== 'READY_FOR_DISPATCH') return { batched: false, reason: 'not_ready' };
  const held = await isHeldForRun(supabase, deliveryId);
  if (held) return { batched: false, reason: 'waiting_for_run', detail: held.cutoffAt };
  if (point.seller_count !== 1) return { batched: false, reason: 'multi_seller_unsupported' };
  if (!point.pickup || !point.drop || !point.seller_geo) return { batched: false, reason: 'no_pickup_location' };

  // Never double-offer the same delivery.
  const { data: existingOffer } = await supabase.from('driver_offers').select('id')
    .eq('delivery_id', deliveryId).eq('status', 'pending').maybeSingle();
  if (existingOffer) return { batched: false, reason: 'already_offered' };

  const { data: candidates, error: candidatesError } = await supabase.rpc('find_batchable_routes', {
    p_seller_geo: point.seller_geo,
    p_max_age_seconds: DRIVER_STALENESS_SECONDS,
    p_delivery_id: deliveryId,
    p_max_deliveries: opts.relaxed ? 1000 : MAX_DELIVERIES_PER_TRIP
  });
  if (candidatesError) return { batched: false, reason: 'no_batchable_routes', detail: candidatesError.message };
  if (!Array.isArray(candidates) || !candidates.length) return { batched: false, reason: 'no_batchable_routes' };

  const add = { deliveryId, sellerId: point.seller_id, pickup: point.pickup, drop: point.drop, customer: point.customer, priority: !!point.priority };
  let best = null;
  for (const c of candidates.slice(0, MAX_CANDIDATE_TRIPS)) {
    const { data: input } = await supabase.rpc('get_route_plan_input', { p_route_id: c.route_id });
    if (!input) continue;
    const plan = await planTrip(supabase, input, add, { relaxed: !!opts.relaxed });
    const cost = p => (p.addedMin == null ? 1e9 : p.addedMin);
    if (plan.ok && (!best || cost(plan) < cost(best.plan))) best = { candidate: c, plan };
  }
  if (!best) return { batched: false, reason: 'no_fit' };
  // Prefer the least extra time; an "add to the end" plan has no estimate — rank it last.

  // Full delivery price for the added order (founder 2026-10-05).
  const payoutAmount = estimatePayout({ distanceKm: point.road_km != null ? Number(point.road_km) : NaN });
  const expiresAt = new Date(Date.now() + OFFER_TTL_MINUTES * 60 * 1000).toISOString();
  const { data: offer, error: offerInsertError } = await supabase.from('driver_offers').insert({
    delivery_id: deliveryId,
    driver_id: best.candidate.driver_id,
    route_id: best.candidate.route_id,
    offer_type: 'batch_addition',
    payout_amount: payoutAmount,
    distance_impact_km: best.plan.addedKm,
    duration_impact_min: best.plan.addedMin,
    insertion: { order: best.plan.order, after: best.plan.afterName, added_km: best.plan.addedKm, added_min: best.plan.addedMin,
                 new_arrival_min: best.plan.newArrivalMin, relaxed: !!best.plan.relaxed, appended: !!best.plan.appended, planned_at: new Date().toISOString() },
    status: 'pending',
    expires_at: expiresAt
  }).select('id').single();
  if (offerInsertError) {
    if (offerInsertError.code === '23505') return { batched: false, reason: 'already_offered' };
    return { batched: false, reason: 'offer_insert_failed', detail: offerInsertError.message };
  }

  const transitionResult = await transitionDelivery(supabase, deliveryId, 'OFFERED', { type: 'system' },
    { eventType: 'BATCH_OFFERED', metadata: { driver_id: best.candidate.driver_id, route_id: best.candidate.route_id, offer_id: offer.id, added_min: best.plan.addedMin } });
  if (!transitionResult.ok) {
    await supabase.from('driver_offers').delete().eq('id', offer.id);
    return { batched: false, reason: 'transition_failed', detail: transitionResult.detail || transitionResult.reason };
  }
  return { batched: true, offerId: offer.id, routeId: best.candidate.route_id, driverId: best.candidate.driver_id, plan: best.plan };
}

// True when another delivery of the same run has a pending new_route offer.
async function runMateHasPendingNewRoute(supabase, deliveryId, run) {
  try {
    const { data: orders } = await supabase.from('orders').select('id')
      .eq('slot_id', run.slotId).eq('slot_run_date', run.runDate);
    const orderIds = (orders || []).map(o => o.id);
    if (!orderIds.length) return false;
    const { data: ds } = await supabase.from('deliveries').select('id').in('order_id', orderIds).neq('id', deliveryId);
    const ids = (ds || []).map(d => d.id);
    if (!ids.length) return false;
    const { data: offers } = await supabase.from('driver_offers').select('id')
      .in('delivery_id', ids).eq('status', 'pending').eq('offer_type', 'new_route').limit(1);
    return !!(offers && offers.length);
  } catch (e) {
    return false;
  }
}

/**
 * Offer one waiting delivery, in this order:
 *  1. onto a rider's trip where it fits the normal rules;
 *  2. to the nearest FREE rider (a fresh trip);
 *  3. no free rider → onto an on-trip rider anyway (relaxed: added at the
 *     end once the trip is long; existing customers still protected) — the
 *     founder's "while it's us delivering, accept any order". Always optional
 *     for the rider.
 */
async function offerDelivery(supabase, deliveryId) {
  const run = await getRunInfo(supabase, deliveryId);
  if (run && run.held) return { dispatched: false, reason: 'waiting_for_run', detail: run.cutoffAt };
  let r = await evaluateBatchCandidates(supabase, deliveryId).catch(e => ({ batched: false, reason: 'error', detail: e.message }));
  if (r.batched) return r;
  // Run mode: a run-mate already has a fresh-trip offer out — wait for that rider's answer.
  if (run && await runMateHasPendingNewRoute(supabase, deliveryId, run)) {
    return { dispatched: false, reason: 'waiting_for_run_mate' };
  }
  const d = await dispatchDelivery(supabase, deliveryId).catch(e => ({ dispatched: false, reason: 'error', detail: e.message }));
  if (d.dispatched || d.reason !== 'no_drivers_online') return d;
  r = await evaluateBatchCandidates(supabase, deliveryId, { relaxed: true }).catch(e => ({ batched: false, reason: 'error', detail: e.message }));
  return r.batched ? r : d;
}

/**
 * Offer every waiting delivery (oldest first): onto a rider's trip if it
 * fits, otherwise to the nearest free rider. Used by the rider heartbeat and
 * right after a rider accepts (so two orders from one store reach the same
 * rider within seconds). Best-effort; never throws.
 */
async function sweepWaitingDeliveries(supabase, { limit = 5 } = {}) {
  const out = [];
  try {
    // Deliveries held for a run's cut-off don't count toward the limit (they'd otherwise
    // starve ready ones behind them); page on until `limit` real attempts or the end.
    let attempted = 0;
    for (let from = 0; attempted < limit && from < 50; from += limit) {
      const { data: waiting } = await supabase.from('deliveries').select('id')
        .eq('status', 'READY_FOR_DISPATCH').order('created_at', { ascending: true }).range(from, from + limit - 1);
      for (const w of waiting || []) {
        const result = await offerDelivery(supabase, w.id);
        out.push({ id: w.id, result });
        if (!result || (result.reason !== 'waiting_for_run' && result.reason !== 'waiting_for_run_mate')) attempted++;
      }
      if (!waiting || waiting.length < limit) break;
    }
  } catch (e) {
    console.warn('sweepWaitingDeliveries failed', e && e.message);
  }
  return out;
}

module.exports = { evaluateBatchCandidates, offerDelivery, sweepWaitingDeliveries, DRIVER_STALENESS_SECONDS, OFFER_TTL_MINUTES };
