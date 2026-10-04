// netlify/functions/get-delivery-quote.js
//
// Delivery network (plan §139/§20, delivery-network-spec.md Stage 3):
// computes and locks a delivery fee quote *before* checkout, using real
// road-distance pricing from Google's Routes API. Writes a `delivery_quotes`
// row and returns only { quoteId, totalDeliveryFee, expiresAt } — customers
// see the total, not the breakdown (plan §139).
//
// This mirrors validate-cart.js's supporting fee logic (per-seller surcharge,
// free_delivery exclusion, bulk-quantity stepping via units_per_trip, the
// custom per-product delivery_price override, the FREE_DELIVERY_THRESHOLD
// full-waiver).
//
// Base-fee model (founder decision 2026-09-26, §AA): the base fee is no
// longer an independent distance-tier lookup — it IS the real driver payout
// estimate (lib/payout-formula.js), plus an admin-set margin_percent on top
// (0 for now, since the founder/partner are driving deliveries themselves;
// bumping margin_percent in the admin panel is the entire "turn on profit"
// step once real drivers are hired, no code change needed). Anything beyond
// `delivery_pricing_config.max_service_distance_km` (real road distance) is
// refused outright rather than capped, so "fee == cost (+margin)" stays true
// instead of quietly eating a loss on far routes — the old MAX_DELIVERY_FEE
// cap did exactly that (see docs/systems/delivery-network-spec.md §AA for
// the real numbers that drove this). A per-zone, time-boxed promo cap
// (service_zones.promo_*) can still deliberately price below cost for a
// launch window — that's an intentional loss-leader, not a bug.
//
// Does not touch validate-cart.js, checkout.html, or any PayFast file.
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { estimatePayout } = require('./lib/payout-formula');

const QUOTE_TTL_MINUTES = 15; // no existing convention in this repo for quote TTLs — 15 min is a reasonable default for a checkout session.

const OUTSIDE_ZONE_REASON = "We can't deliver to this address yet. This location is currently outside Umzila's delivery area.";
const MULTI_SELLER_REASON = "This basket needs separate deliveries. Some items are currently too far apart to be combined into one delivery.";

// Stage 4 (delivery-network-spec.md §B.2 -> real build 2026-09-17): a cart
// spanning more than this many distinct sellers still refuses with
// MULTI_SELLER_REASON. Capped at 2 deliberately -- it keeps the quote-time
// route sequencing below a cheap 2-permutation Google Routes comparison
// instead of needing real route optimization (which bills at a materially
// higher rate). Revisit once a third real seller has a nearby pickup_geo.
const MAX_BUNDLE_SELLERS = 2;

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

function badRequest(msg) {
  return { statusCode: 400, headers, body: JSON.stringify({ error: msg }) };
}
function serverError(msg, details) {
  if (details) console.error('get-delivery-quote:', msg, details);
  return { statusCode: 500, headers, body: JSON.stringify({ error: msg }) };
}
function ineligible(reason) {
  return { statusCode: 200, headers, body: JSON.stringify({ eligible: false, reason }) };
}

function toFiniteNumber(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PostgREST returns geography columns as hex-encoded (E)WKB text by default
// (no GeoJSON casting configured for `sellers`). sellers.pickup_geo is always
// written as a simple `SRID=4326;POINT(lon lat)` (see seller-dashboard.html),
// so we only need to decode the plain-Point-with-SRID EWKB shape — no need
// for a full WKB parser library or a new DB helper function for this.
function parseGeographyPoint(hex) {
  if (!hex || typeof hex !== 'string') return null;
  try {
    const buf = Buffer.from(hex, 'hex');
    if (buf.length < 21) return null;
    const little = buf.readUInt8(0) === 1;
    const type = little ? buf.readUInt32LE(1) : buf.readUInt32BE(1);
    const hasSrid = (type & 0x20000000) !== 0;
    let offset = 5;
    if (hasSrid) offset += 4;
    const lon = little ? buf.readDoubleLE(offset) : buf.readDoubleBE(offset);
    const lat = little ? buf.readDoubleLE(offset + 8) : buf.readDoubleBE(offset + 8);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  } catch (e) {
    return null;
  }
}

// Straight-line only -- self-arranged eligibility is a simple "close enough
// to sort out yourselves" radius check, not a real road-distance quote, so
// there's no reason to spend a paid Google Routes call on it.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Stage 4 -- one computeRoutes call for a specific 2-pickup visiting order
// (origin -> intermediate -> destination). Requests routes.legs so the
// origin->intermediate leg (the real inter-store distance) is available
// from the same call, at no extra cost, for the max_bundle_leg_km check --
// no separate straight-line-only lookup needed. Returns null on any
// failure; the caller treats that the same as the existing hard-error path
// (never falls back to straight-line distance for pricing, plan §11).
async function computeBundleRoute(googleRoutesKey, originPoint, intermediatePoint, destLat, destLon) {
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': googleRoutesKey,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.legs.distanceMeters'
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: originPoint.lat, longitude: originPoint.lon } } },
      intermediates: [{ location: { latLng: { latitude: intermediatePoint.lat, longitude: intermediatePoint.lon } } }],
      destination: { location: { latLng: { latitude: destLat, longitude: destLon } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      units: 'METRIC'
    })
  }).catch(() => null);
  if (!res) return null;
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !Array.isArray(json.routes) || !json.routes.length) return null;
  const route = json.routes[0];
  const distanceMeters = Number(route.distanceMeters);
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) return null;
  const durationSeconds = typeof route.duration === 'string' ? parseFloat(route.duration.replace(/s$/, '')) : Number(route.duration);
  const legs = Array.isArray(route.legs) ? route.legs : [];
  const interStoreLegMeters = legs.length && Number.isFinite(Number(legs[0].distanceMeters)) ? Number(legs[0].distanceMeters) : null;
  return {
    totalDistanceKm: distanceMeters / 1000,
    totalDurationMin: Number.isFinite(durationSeconds) ? durationSeconds / 60 : null,
    interStoreLegKm: interStoreLegMeters != null ? interStoreLegMeters / 1000 : null
  };
}

exports.handler = async function (event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return badRequest('Invalid JSON body');
    }

    const { cartItems } = body;
    const destinationLat = toFiniteNumber(body.destinationLat ?? body.lat ?? body.latitude);
    const destinationLon = toFiniteNumber(body.destinationLon ?? body.lon ?? body.lng ?? body.longitude);
    const priority = !!body.priority;

    if (!cartItems || !Array.isArray(cartItems) || !cartItems.length) {
      return badRequest('Invalid cart items');
    }
    if (destinationLat === null || destinationLon === null ||
        destinationLat < -90 || destinationLat > 90 || destinationLon < -180 || destinationLon > 180) {
      return badRequest('Invalid or missing destination coordinates');
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return serverError('Server configuration error');
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    // The quote's owner comes from the buyer's session token, never the
    // body — validate-cart.js only honours a quote for its owner (or an
    // ownerless guest quote), so a client-sent id could claim anyone's.
    let userId = null;
    const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token) {
      const { data: authData } = await supabase.auth.getUser(token);
      userId = (authData && authData.user && authData.user.id) || null;
    }

    // ---- Re-fetch products/variants server-side by id — never trust
    // client-supplied prices or seller_ids from cartItems (same defensive
    // posture as validate-cart.js). ----
    const productIds = cartItems
      .map(i => i.id || i.product_id || i.productId)
      .filter(Boolean)
      .map(String);
    if (!productIds.length) {
      return badRequest('No valid product IDs in cart');
    }

    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('id, price, sale, sale_price, seller_id, delivery_class, visible, listing_type, free_delivery, units_per_trip, metadata')
      .in('id', productIds)
      .eq('visible', true);
    if (productsError) {
      return serverError('Failed to price delivery quote', productsError);
    }

    const { data: variants, error: variantsError } = await supabase
      .from('product_variants')
      .select('id, product_id, size, price_override')
      .in('product_id', productIds);
    if (variantsError) {
      return serverError('Failed to price delivery quote', variantsError);
    }

    const productMap = {};
    (products || []).forEach(p => { productMap[p.id] = p; });
    const variantMap = {};
    (variants || []).forEach(v => {
      if (v.id) variantMap[v.id] = v;
      if (v.product_id && v.size) variantMap[`${v.product_id}::${v.size}`] = v;
    });

    // ---- Normalize cart items (same tolerant field names as validate-cart.js) ----
    const productItems = [];
    for (const rawItem of cartItems) {
      const pid = rawItem.id || rawItem.product_id || rawItem.productId || null;
      const product = productMap[pid];
      if (!product) continue; // missing/invisible product — silently skip, same as validate-cart.js
      if ((product.listing_type || 'product') === 'service') continue; // services don't feed this quote

      const qty = Number(rawItem.quantity ?? rawItem.qty ?? rawItem.Qty ?? 1);
      if (!Number.isFinite(qty) || qty <= 0) continue;

      let itemPrice = product.price;
      const variantId = rawItem.variant_id || rawItem.variantId || rawItem.variant || null;
      const size = rawItem.size || rawItem.variant_size || null;
      let variant = null;
      if (variantId) variant = variantMap[variantId];
      if (!variant && size) variant = variantMap[`${pid}::${size}`];
      if (variant && variant.price_override) itemPrice = variant.price_override;
      if (product.sale && product.sale_price) itemPrice = product.sale_price;

      if (!product.seller_id) {
        return serverError(`Product "${pid}" is missing a seller assignment; cannot generate a delivery quote.`);
      }

      const deliveryPrice = (product.metadata && Number.isFinite(Number(product.metadata.delivery_price)))
        ? Number(product.metadata.delivery_price) : null;

      productItems.push({
        seller_id: product.seller_id,
        price: Number(itemPrice) || 0,
        quantity: qty,
        delivery_class: (product.delivery_class || 'small').toLowerCase(),
        free_delivery: !!product.free_delivery,
        units_per_trip: product.units_per_trip || null,
        delivery_price: deliveryPrice
      });
    }

    if (!productItems.length) {
      return badRequest('No deliverable items in cart');
    }

    // ---- Multi-store handling (Stage 4, real build 2026-09-17) ----
    // Up to MAX_BUNDLE_SELLERS distinct sellers in one cart get bundled into
    // one delivery with multiple pickup stops; beyond that, still refused
    // (plan §15/§137's full inter-store route scoring is more than a 2-seller
    // pilot needs -- see delivery-network-spec.md §B.2/§4 for what's deferred
    // and why).
    const pickupSellerIds = [...new Set(productItems.map(i => i.seller_id))];
    if (pickupSellerIds.length > MAX_BUNDLE_SELLERS) {
      return ineligible(MULTI_SELLER_REASON);
    }

    // ---- Self-arranged sellers (admin-set, founder ask 2026-09-17): a
    // hyperlocal seller (e.g. a residence-based student selling ice-cream/
    // noodles/water) can be marked as not needing the delivery network at
    // all for free-delivery items within a set radius -- buyer and seller
    // sort out the handoff directly, exactly like every order did before
    // this build existed. Checked before the zone check / paid Routes call
    // since it's a completely separate, cheaper path. Only ever applies to
    // a genuinely single-seller cart -- a self-arranged seller's items never
    // combine with a bundled/real-delivery seller's items in one quote.
    if (pickupSellerIds.length === 1) {
      const { data: selfArrangedSeller, error: selfArrangedSellerError } = await supabase
        .from('sellers')
        .select('self_arranged_radius_km, pickup_geo')
        .eq('id', pickupSellerIds[0])
        .maybeSingle();
      if (selfArrangedSellerError) {
        return serverError('Failed to check self-arranged eligibility', selfArrangedSellerError);
      }
      if (selfArrangedSeller && selfArrangedSeller.self_arranged_radius_km && selfArrangedSeller.pickup_geo
          && productItems.every(i => i.free_delivery)) {
        const selfArrangedPoint = parseGeographyPoint(selfArrangedSeller.pickup_geo);
        if (selfArrangedPoint) {
          const distanceToSellerKm = haversineKm(selfArrangedPoint.lat, selfArrangedPoint.lon, destinationLat, destinationLon);
          if (distanceToSellerKm <= Number(selfArrangedSeller.self_arranged_radius_km)) {
            return ineligible('self_arranged');
          }
        }
      }
    }

    // ---- Eligibility check BEFORE calling the (paid) Routes API ----
    const { data: zoneData, error: zoneError } = await supabase.rpc('find_service_zone_for_point', {
      p_lat: destinationLat,
      p_lon: destinationLon
    });
    if (zoneError) {
      return serverError('Failed to check delivery eligibility', zoneError);
    }
    const zone = Array.isArray(zoneData) ? zoneData[0] : zoneData;
    if (!zone || zone.zone_type === 'restricted') {
      return ineligible(OUTSIDE_ZONE_REASON);
    }

    // ---- Google Routes API key (server-only, not yet provided by founder) ----
    const googleRoutesKey = process.env.GOOGLE_ROUTES_SERVER_KEY;
    if (!googleRoutesKey) {
      return serverError('Delivery pricing is not yet configured (missing GOOGLE_ROUTES_SERVER_KEY) — quotes cannot be generated until this is added in Netlify.');
    }

    // ---- Active pricing config (single source of truth for all tariff numbers) ----
    const { data: pricingConfig, error: pricingError } = await supabase
      .from('delivery_pricing_config')
      .select('*')
      .eq('is_active', true)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pricingError) {
      return serverError('Failed to load delivery pricing configuration', pricingError);
    }
    if (!pricingConfig) {
      return serverError('No active delivery_pricing_config row found — cannot price delivery.');
    }

    // ---- Seller pickup location(s) ----
    const { data: sellersData, error: sellersError } = await supabase
      .from('sellers')
      .select('id, pickup_geo')
      .in('id', pickupSellerIds);
    if (sellersError) {
      return serverError('Failed to load seller pickup location', sellersError);
    }
    const pickupPointBySellerId = {};
    for (const id of pickupSellerIds) {
      const row = (sellersData || []).find(s => s.id === id);
      if (!row || !row.pickup_geo) {
        return serverError('Seller pickup location is not yet configured; delivery quotes cannot be generated for this store.');
      }
      const pt = parseGeographyPoint(row.pickup_geo);
      if (!pt) {
        return serverError('Failed to read seller pickup location.');
      }
      pickupPointBySellerId[id] = pt;
    }

    // ---- Road distance via Google Routes API ----
    // https://routes.googleapis.com/directions/v2:computeRoutes
    // Server-only key via X-Goog-Api-Key header; field mask restricts the
    // (billed) response to just what we need. Never falls back to
    // straight-line distance for pricing (plan §11) — a Routes API failure
    // is a hard error, not a silent downgrade.
    let distanceKm, durationMin;
    // Stage 4: for a bundled 2-seller cart, `orderedSellerIds` may differ
    // from `pickupSellerIds` -- it's the actual visiting order the quote was
    // priced against, stored into delivery_quotes.pickup_seller_ids below.
    // respond-to-driver-offer.js re-sequences independently at offer-
    // acceptance time from the real driver's position, so this is only ever
    // a reasonable pre-driver estimate, not a promise (see spec §W... §Stage4).
    let orderedSellerIds = pickupSellerIds;

    if (pickupSellerIds.length === 1) {
      const pickupPoint = pickupPointBySellerId[pickupSellerIds[0]];
      try {
        const routesRes = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': googleRoutesKey,
            'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration'
          },
          body: JSON.stringify({
            origin: { location: { latLng: { latitude: pickupPoint.lat, longitude: pickupPoint.lon } } },
            destination: { location: { latLng: { latitude: destinationLat, longitude: destinationLon } } },
            travelMode: 'DRIVE',
            routingPreference: 'TRAFFIC_AWARE',
            units: 'METRIC'
          })
        });

        const routesJson = await routesRes.json().catch(() => null);
        if (!routesRes.ok || !routesJson || !Array.isArray(routesJson.routes) || !routesJson.routes.length) {
          return serverError('Failed to compute delivery route (Google Routes API error).', { status: routesRes.status, body: routesJson });
        }
        const route = routesJson.routes[0];
        const distanceMeters = Number(route.distanceMeters);
        const durationSeconds = typeof route.duration === 'string' ? parseFloat(route.duration.replace(/s$/, '')) : Number(route.duration);
        if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
          return serverError('Google Routes API returned an invalid distance.');
        }
        distanceKm = distanceMeters / 1000;
        durationMin = Number.isFinite(durationSeconds) ? durationSeconds / 60 : null;
      } catch (err) {
        return serverError('Failed to reach Google Routes API.', err);
      }
    } else {
      // Exactly 2 sellers (MAX_BUNDLE_SELLERS): try both visiting orders --
      // A->B->customer vs B->A->customer -- and price off whichever totals
      // less distance. optimizeWaypointOrder exists but bills at a materially
      // higher rate for what's only ever 2 possible orderings here, so 2
      // plain calls is the cheaper, simpler choice for this pilot.
      const [a, b] = pickupSellerIds;
      let optionAB, optionBA;
      try {
        [optionAB, optionBA] = await Promise.all([
          computeBundleRoute(googleRoutesKey, pickupPointBySellerId[a], pickupPointBySellerId[b], destinationLat, destinationLon),
          computeBundleRoute(googleRoutesKey, pickupPointBySellerId[b], pickupPointBySellerId[a], destinationLat, destinationLon)
        ]);
      } catch (err) {
        return serverError('Failed to reach Google Routes API.', err);
      }
      if (!optionAB && !optionBA) {
        return serverError('Failed to compute delivery route (Google Routes API error).');
      }
      const winner = (!optionBA || (optionAB && optionAB.totalDistanceKm <= optionBA.totalDistanceKm)) ? optionAB : optionBA;
      orderedSellerIds = (winner === optionAB) ? [a, b] : [b, a];

      if (winner.interStoreLegKm == null) {
        return serverError('Google Routes API did not return the inter-store leg distance.');
      }
      const maxBundleLegKm = Number(pricingConfig.max_bundle_leg_km);
      if (Number.isFinite(maxBundleLegKm) && winner.interStoreLegKm > maxBundleLegKm) {
        return ineligible(MULTI_SELLER_REASON);
      }

      distanceKm = winner.totalDistanceKm;
      durationMin = winner.totalDurationMin;
    }

    // ---- Hard distance cutoff (founder decision 2026-09-26, §AA): a real
    // route longer than this is refused outright, not capped -- see the file
    // header for why. Checked before pricing, same as any other ineligible
    // path (200 + eligible:false, never a 500).
    const maxServiceDistanceKm = Number(pricingConfig.max_service_distance_km);
    if (Number.isFinite(maxServiceDistanceKm) && distanceKm > maxServiceDistanceKm) {
      return ineligible(OUTSIDE_ZONE_REASON);
    }

    // ---- Base fee: real driver-payout estimate + admin-set margin (see the
    // file header — this replaces the old independent distance-tier table). ----
    const MARGIN_PERCENT = Number(pricingConfig.margin_percent) || 0;
    const payoutEstimate = estimatePayout({ distanceKm, durationMin });
    const distanceBaseFee = Math.round(payoutEstimate * (1 + MARGIN_PERCENT / 100) * 100) / 100;

    const PER_SELLER_FEE = Number(pricingConfig.per_seller_fee) || 0;
    const FREE_DELIVERY_THRESHOLD = Number(pricingConfig.free_delivery_threshold) || 0;
    const DEFAULT_UNITS_PER_TRIP = pricingConfig.default_units_per_trip || { small: 8, medium: 4, large: 2 };
    const LARGE_OVERFLOW_FEE = Number(pricingConfig.large_overflow_fee) || 0;
    const PRIORITY_FEE = Number(pricingConfig.priority_fee) || 0;

    // ---- Fee calc — ports validate-cart.js's computeFees() product-delivery
    // branch, swapping the class-based base fee for the payout-based fee above. ----
    const subtotal = productItems.reduce((s, i) => s + i.price * i.quantity, 0);
    const feeItems = productItems.filter(i => !i.free_delivery);

    let deliveryClass = 'small';
    let baseFeeUsed = 0;
    let overflowSurcharge = 0;
    let perSellerFeeTotal = 0;
    let productDelivery = 0;

    if (!feeItems.length) {
      // allFreeDelivery — every item in the cart is delivery-fee-exempt.
    } else if (subtotal >= FREE_DELIVERY_THRESHOLD) {
      // free — still counts free_delivery items toward the threshold, matching validate-cart.js.
    } else {
      const customItems = feeItems.filter(i => Number.isFinite(i.delivery_price));
      const classItems = feeItems.filter(i => !Number.isFinite(i.delivery_price));

      const classOrder = { small: 0, medium: 1, large: 2 };
      const classNames = ['small', 'medium', 'large'];
      let maxClassIdx = 0;
      let extraTrips = 0;
      classItems.forEach(item => {
        const dc = item.delivery_class || 'small';
        const baseIdx = classOrder[dc] ?? 0;
        const capacity = item.units_per_trip || DEFAULT_UNITS_PER_TRIP[dc] || DEFAULT_UNITS_PER_TRIP.small;
        const trips = Math.ceil(item.quantity / capacity);
        const rawIdx = baseIdx + (trips - 1);
        if (rawIdx > maxClassIdx) maxClassIdx = Math.min(rawIdx, 2);
        extraTrips += Math.max(0, rawIdx - 2);
      });
      deliveryClass = classNames[maxClassIdx];

      const classBaseFee = classItems.length ? distanceBaseFee : 0;
      const customBaseFee = customItems.length ? Math.max(...customItems.map(i => i.delivery_price)) : 0;
      const baseFee = Math.max(classBaseFee, customBaseFee);

      perSellerFeeTotal = (pickupSellerIds.length - 1) * PER_SELLER_FEE; // Stage 4: +PER_SELLER_FEE for a genuinely bundled 2-seller cart, 0 otherwise
      overflowSurcharge = extraTrips * LARGE_OVERFLOW_FEE;
      baseFeeUsed = baseFee;
      productDelivery = Math.max(0, baseFee + perSellerFeeTotal + overflowSurcharge);

      // ---- Launch promo cap (admin-set per zone, §AA) -- deliberately
      // allows pricing BELOW real driver cost for a launch window; that's
      // the point (loss-leader), not a bug. promo_expires_at is a safety
      // net so it lapses on its own even if nobody flips it off by hand.
      if (zone.promo_active && Number.isFinite(Number(zone.promo_cap_fee)) &&
          (!zone.promo_expires_at || new Date(zone.promo_expires_at) > new Date())) {
        productDelivery = Math.min(productDelivery, Number(zone.promo_cap_fee));
      }
    }

    const priorityFee = priority ? PRIORITY_FEE : 0; // flat, belongs to Umzila — unaffected by the free-delivery waiver/cap
    const totalDeliveryFee = Math.round((productDelivery + priorityFee) * 100) / 100;

    // ---- Lock the quote ----
    const expiresAt = new Date(Date.now() + QUOTE_TTL_MINUTES * 60 * 1000).toISOString();
    const { data: quoteRow, error: insertError } = await supabase
      .from('delivery_quotes')
      .insert({
        customer_id: userId || null,
        // Stage 4: for a bundled cart this is the winning VISITING ORDER
        // (not just an unordered set of sellers) -- respond-to-driver-offer.js
        // may re-sequence independently at offer-acceptance time from the
        // real driver's position; see the note above the road-distance block.
        pickup_seller_ids: orderedSellerIds,
        destination_geo: `SRID=4326;POINT(${destinationLon} ${destinationLat})`,
        destination_snapshot: { lat: destinationLat, lon: destinationLon, zone_id: zone.id || null, zone_name: zone.name || null, zone_type: zone.zone_type || null },
        distance_km: distanceKm,
        duration_min: durationMin,
        delivery_class: deliveryClass,
        base_fee: baseFeeUsed,
        // No separate distance-surcharge layer exists in this model — the
        // payout-based base fee already fully prices distance. This column instead carries
        // the bulk-quantity overflow surcharge (extra trips beyond the top
        // class), the closest fit among the existing audit columns.
        distance_surcharge: overflowSurcharge,
        per_seller_fee_total: perSellerFeeTotal,
        priority_fee: priorityFee,
        total_delivery_fee: totalDeliveryFee,
        pricing_config_version: pricingConfig.version,
        expires_at: expiresAt,
        status: 'active'
      })
      .select('id, expires_at')
      .single();

    if (insertError) {
      return serverError('Failed to save delivery quote', insertError);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        quoteId: quoteRow.id,
        totalDeliveryFee,
        expiresAt: quoteRow.expires_at
      })
    };

  } catch (error) {
    console.error('get-delivery-quote error', error);
    return serverError('Internal server error', error);
  }
};
