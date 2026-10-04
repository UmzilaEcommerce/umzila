// netlify/functions/lib/payout-formula.js
//
// Rider payout (founder 2026-10-04): the rider is paid the delivery price of
// each delivery on the route — lib/delivery-price.js: R34 for the first 3
// road-km + R0.40/km after (the quote's road distance, what the customer was
// priced on), +R3 per extra store, never more than R45 per delivery; R39 when
// the distance is unknown. Paid even when the customer got free delivery.
//
// The AUTHORITATIVE computation is the compute_driver_payout_on_route_completion
// Postgres trigger (driver_payouts row when the route completes). This JS copy
// only shows a rider a pre-acceptance ESTIMATE on a driver_offers row — keep
// the two identical. (Was: R4 + R4/km, min R20, +R10 per extra stop,
// +R1.50/min over 30 min — formula_v1_2026_09_17.)
const { feeForRoadKm, clampFee, DELIVERY_FEE_MIN } = require('./delivery-price');

const PER_EXTRA_STORE = 3;

function estimatePayout({ distanceKm, extraDrops = 0, extraPickups = 0 }) {
  const perDelivery = clampFee(feeForRoadKm(distanceKm) + PER_EXTRA_STORE * Math.max(extraPickups, 0));
  // Each extra customer is its own delivery (batching is off today — see
  // lib/batch-dispatch.js); its distance isn't known here, so count the minimum.
  return Math.round((perDelivery + DELIVERY_FEE_MIN * Math.max(extraDrops, 0)) * 100) / 100;
}

module.exports = { estimatePayout, PER_EXTRA_STORE };
