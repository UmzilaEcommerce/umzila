// netlify/functions/lib/delivery-price.js
//
// What the CUSTOMER pays for delivery inside a zone (founder 2026-10-04 —
// priced to win on volume, not per trip): R34 minimum covering the first
// 3 road-km, +R0.40 per road-km after that, never more than R45 (also caps
// a 2-store bundle / overflow trips). e.g. 2 km R34 · 10 km R36.80 ·
// 16 km (Reservoir Hills) R39.20 · 20 km R40.80.
// When the road distance can't be worked out (routing down, store without a
// pickup pin) the flat fallback is R39.
//
// Riders are paid this same price per delivery (lib/payout-formula.js + the
// compute_driver_payout_on_route_completion trigger).
// checkout.html mirrors these numbers for its on-screen preview — change both.
const DELIVERY_FEE_MIN = 34;
const DELIVERY_FEE_MAX = 45;
const INCLUDED_KM = 3;
const PER_KM_AFTER = 0.40;
const FALLBACK_FEE = 39;

const round2 = n => Math.round(n * 100) / 100;
const clampFee = n => round2(Math.min(DELIVERY_FEE_MAX, Math.max(DELIVERY_FEE_MIN, n)));

// Umzila's delivery markup (admin → Delivery pricing → "Delivery markup %",
// delivery_pricing_config.margin_percent of the active version): the price
// above times (1 + markup/100), applied last (after the R45 cap and any zone
// promo cap) so 5% always means 5% more for the customer, 0 = the band
// exactly. Rider pay is NOT affected — the markup is Umzila's.
// Applied in get-delivery-quote.js (quotes) and validate-cart.js (no-quote
// fallback) — keep both.
function withMarkup(fee, marginPercent) {
  const m = Number(marginPercent);
  if (!(fee > 0) || !Number.isFinite(m) || m <= 0) return round2(fee || 0);
  return round2(fee * (1 + m / 100));
}

function feeForRoadKm(km) {
  if (!Number.isFinite(km) || km < 0) return FALLBACK_FEE;
  return clampFee(DELIVERY_FEE_MIN + Math.max(0, km - INCLUDED_KM) * PER_KM_AFTER);
}

module.exports = { DELIVERY_FEE_MIN, DELIVERY_FEE_MAX, INCLUDED_KM, PER_KM_AFTER, FALLBACK_FEE, feeForRoadKm, clampFee, withMarkup };
