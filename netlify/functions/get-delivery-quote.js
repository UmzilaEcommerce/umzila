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
// custom per-product delivery_price override, the MAX_DELIVERY_FEE cap, the
// FREE_DELIVERY_THRESHOLD full-waiver) but swaps the base fee from a
// class-based lookup (DELIVERY_CLASS_PRICES) to a road-distance tier lookup
// against delivery_pricing_config.distance_tiers. delivery_class still feeds
// the bulk-stepping capacity lookup only — it no longer determines the base
// fee, distance does.
//
// Does not touch validate-cart.js, checkout.html, or any PayFast file.
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const QUOTE_TTL_MINUTES = 15; // no existing convention in this repo for quote TTLs — 15 min is a reasonable default for a checkout session.

const OUTSIDE_ZONE_REASON = "We can't deliver to this address yet. This location is currently outside Umzila's delivery area.";
const MULTI_SELLER_REASON = "This basket needs separate deliveries. Some items are currently too far apart to be combined into one delivery.";

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

// First distance tier where distance_km <= tier.max_km; if distance exceeds
// every tier, fall back to extended_zone_fee ONLY when the destination is in
// an 'extended' zone. Any other case here means "priceable is not possible"
// and the caller must treat it as ineligible rather than guess a fee.
function resolveDistanceBaseFee(distanceKm, tiers, extendedZoneFee, zoneType) {
  const sorted = Array.isArray(tiers)
    ? [...tiers].filter(t => Number.isFinite(t && t.max_km) && Number.isFinite(t && t.fee)).sort((a, b) => a.max_km - b.max_km)
    : [];
  const tier = sorted.find(t => distanceKm <= t.max_km);
  if (tier) return { fee: tier.fee, ineligible: false };
  if (zoneType === 'extended' && Number.isFinite(extendedZoneFee)) return { fee: extendedZoneFee, ineligible: false };
  return { fee: null, ineligible: true };
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

    const { cartItems, userId } = body;
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
    if (userId != null && (typeof userId !== 'string' || !UUID_RE.test(userId))) {
      return badRequest('Invalid userId');
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return serverError('Server configuration error');
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

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

    // ---- Multi-store handling (deliberately simple for the pilot) ----
    // TODO(bundle-engine, deferred per delivery-network-spec.md §B.2): once a
    // second store is onboarded this needs real inter-store route scoring and
    // split-delivery decisioning (plan §15/§137). For the pilot there's only
    // ever one seller (Isqalo), so this path is currently unreachable but
    // must be handled correctly rather than silently mis-pricing a
    // multi-seller cart.
    const pickupSellerIds = [...new Set(productItems.map(i => i.seller_id))];
    if (pickupSellerIds.length > 1) {
      return ineligible(MULTI_SELLER_REASON);
    }
    const sellerId = pickupSellerIds[0];

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

    // ---- Seller pickup location ----
    const { data: seller, error: sellerError } = await supabase
      .from('sellers')
      .select('id, pickup_geo')
      .eq('id', sellerId)
      .maybeSingle();
    if (sellerError) {
      return serverError('Failed to load seller pickup location', sellerError);
    }
    if (!seller || !seller.pickup_geo) {
      return serverError('Seller pickup location is not yet configured; delivery quotes cannot be generated for this store.');
    }
    const pickupPoint = parseGeographyPoint(seller.pickup_geo);
    if (!pickupPoint) {
      return serverError('Failed to read seller pickup location.');
    }

    // ---- Road distance via Google Routes API ----
    // https://routes.googleapis.com/directions/v2:computeRoutes
    // Server-only key via X-Goog-Api-Key header; field mask restricts the
    // (billed) response to just what we need. Never falls back to
    // straight-line distance for pricing (plan §11) — a Routes API failure
    // is a hard error, not a silent downgrade.
    let distanceKm, durationMin;
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

    // ---- Base fee: distance tier lookup (replaces DELIVERY_CLASS_PRICES) ----
    const { fee: distanceBaseFee, ineligible: distanceIneligible } = resolveDistanceBaseFee(
      distanceKm, pricingConfig.distance_tiers, pricingConfig.extended_zone_fee, zone.zone_type
    );
    if (distanceIneligible) {
      return ineligible(OUTSIDE_ZONE_REASON);
    }

    const PER_SELLER_FEE = Number(pricingConfig.per_seller_fee) || 0;
    const FREE_DELIVERY_THRESHOLD = Number(pricingConfig.free_delivery_threshold) || 0;
    const MAX_DELIVERY_FEE = Number(pricingConfig.max_delivery_fee) || 0;
    const DEFAULT_UNITS_PER_TRIP = pricingConfig.default_units_per_trip || { small: 8, medium: 4, large: 2 };
    const LARGE_OVERFLOW_FEE = Number(pricingConfig.large_overflow_fee) || 0;
    const PRIORITY_FEE = Number(pricingConfig.priority_fee) || 0;

    // ---- Fee calc — ports validate-cart.js's computeFees() product-delivery
    // branch, swapping the class-based base fee for the distance tier above. ----
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

      perSellerFeeTotal = (pickupSellerIds.length - 1) * PER_SELLER_FEE; // always 0 for the pilot's single-seller path
      overflowSurcharge = extraTrips * LARGE_OVERFLOW_FEE;
      baseFeeUsed = baseFee;
      productDelivery = Math.min(MAX_DELIVERY_FEE, Math.max(0, baseFee + perSellerFeeTotal + overflowSurcharge));
    }

    const priorityFee = priority ? PRIORITY_FEE : 0; // flat, belongs to Umzila — unaffected by the free-delivery waiver/cap
    const totalDeliveryFee = Math.round((productDelivery + priorityFee) * 100) / 100;

    // ---- Lock the quote ----
    const expiresAt = new Date(Date.now() + QUOTE_TTL_MINUTES * 60 * 1000).toISOString();
    const { data: quoteRow, error: insertError } = await supabase
      .from('delivery_quotes')
      .insert({
        customer_id: userId || null,
        pickup_seller_ids: pickupSellerIds,
        destination_geo: `SRID=4326;POINT(${destinationLon} ${destinationLat})`,
        destination_snapshot: { lat: destinationLat, lon: destinationLon, zone_id: zone.id || null, zone_name: zone.name || null, zone_type: zone.zone_type || null },
        distance_km: distanceKm,
        duration_min: durationMin,
        delivery_class: deliveryClass,
        base_fee: baseFeeUsed,
        // No separate distance-surcharge layer exists in this tier model — the
        // tier fee already fully prices distance. This column instead carries
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
