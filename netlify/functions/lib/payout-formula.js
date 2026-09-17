// netlify/functions/lib/payout-formula.js
//
// Real driver payout formula, founder-confirmed 2026-09-17 (see
// docs/systems/delivery-network-spec.md §C item 6):
//   payout = max(minimum, base + per_km*route_km + per_extra_drop*(drops-1)
//                + per_extra_pickup*(pickups-1) + per_min_over*max(route_minutes-free_minutes,0))
//
// The AUTHORITATIVE computation is the compute_driver_payout_on_route_completion
// Postgres trigger, which uses the route's real final distance/duration/stop
// counts once it's actually done. This JS copy is ONLY for showing a driver a
// pre-acceptance ESTIMATE on a new driver_offers row -- the real route hasn't
// happened yet, so it estimates using the delivery_quotes row's own
// distance_km/duration_min (already computed via Google Routes at quote time)
// as a stand-in for what the trip will look like. Keep the constants here
// numerically identical to the trigger's -- if the founder changes the
// formula, update both places.
const PAYOUT_FORMULA = {
  base: 4,
  perKm: 4,
  perExtraDrop: 10,
  perExtraPickup: 10,
  minimum: 20,
  freeMinutes: 30,
  perMinOver: 1.5
};

function estimatePayout({ distanceKm, durationMin, extraDrops = 0, extraPickups = 0 }) {
  const km = Number.isFinite(distanceKm) ? distanceKm : 0;
  const minutes = Number.isFinite(durationMin) ? durationMin : 0;
  const raw = PAYOUT_FORMULA.base
    + PAYOUT_FORMULA.perKm * km
    + PAYOUT_FORMULA.perExtraDrop * Math.max(extraDrops, 0)
    + PAYOUT_FORMULA.perExtraPickup * Math.max(extraPickups, 0)
    + PAYOUT_FORMULA.perMinOver * Math.max(minutes - PAYOUT_FORMULA.freeMinutes, 0);
  return Math.round(Math.max(PAYOUT_FORMULA.minimum, raw) * 100) / 100;
}

module.exports = { PAYOUT_FORMULA, estimatePayout };
