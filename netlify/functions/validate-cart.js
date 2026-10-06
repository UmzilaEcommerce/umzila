const { createClient } = require('@supabase/supabase-js');
const { validateCode, computeDiscount } = require('./lib/discounts');
const { FALLBACK_FEE, DELIVERY_FEE_MIN, DELIVERY_FEE_MAX } = require('./lib/delivery-price');

// Must match checkout.html's client-side copies — this server copy is authoritative.
// Fallback when there's no live distance quote (routing down, store without
// a pickup pin): flat R39 for every size, within the R34–R45 band
// (lib/delivery-price.js — founder 2026-10-04).
const DELIVERY_CLASS_PRICES   = { small: FALLBACK_FEE, medium: FALLBACK_FEE, large: FALLBACK_FEE };
const PER_SELLER_FEE          = 3;
// "Free delivery over R…" — off since 2026-10-04 (null = off). Free delivery
// comes only from the product or store switch in admin.
const FREE_DELIVERY_THRESHOLD = null;
const SERVICE_COLLECT_FEE     = 15; // rep collects buyer's item from their address
const SERVICE_RETURN_FEE      = 15; // finished item delivered to an address
// Quantity-aware fee stepping — must match checkout.html exactly.
const DEFAULT_UNITS_PER_TRIP  = { small: 8, medium: 4, large: 2 };
const LARGE_OVERFLOW_FEE      = 10;
const MAX_DELIVERY_FEE        = DELIVERY_FEE_MAX; // R45

// A client-supplied slot is only trusted if it parses to a real, future
// instant — anything else (missing, malformed, already past) is treated as
// "no slot", which downgrades the paid leg to the free default below.
function validSlotIso(val) {
  if (!val) return null;
  const d = new Date(val);
  if (isNaN(d.getTime()) || d.getTime() <= Date.now()) return null;
  return d.toISOString();
}

// Server mirror of checkout.html's calculateDeliveryFee() + calculateServiceFees().
// validatedCart items already carry seller_id/delivery_class/free_delivery/service_fees
// as clamped/priced by this file, so this just sums them up authoritatively.
function computeFees(validatedCart) {
    const productItems = validatedCart.filter(i => (i.listing_type || 'product') !== 'service');
    const subtotal = productItems.reduce((s, i) => s + i.price * i.quantity, 0);
    const feeItems = productItems.filter(i => !i.free_delivery);

    let productDelivery = 0;
    let deliveryClass = 'small';
    let sellerCount = 0;
    let allFreeDelivery = false;

    if (!productItems.length) {
        // service-only cart — no product delivery fee
    } else if (!feeItems.length) {
        allFreeDelivery = true;
    } else if (FREE_DELIVERY_THRESHOLD != null && subtotal >= FREE_DELIVERY_THRESHOLD) {
        // free — still counts free_delivery items toward the threshold
    } else {
        // A per-product "Custom Delivery Price" (admin.html, stored at
        // products.metadata.delivery_price) overrides the Small/Medium/Large
        // class price for that line entirely — must match checkout.html's
        // calculateDeliveryFee() exactly.
        const customItems = feeItems.filter(i => Number.isFinite(i.delivery_price));
        const classItems = feeItems.filter(i => !Number.isFinite(i.delivery_price));

        const classOrder = { small: 0, medium: 1, large: 2 };
        const classNames = ['small', 'medium', 'large'];
        const sellerIds = new Set();
        let maxClassIdx = 0;
        let extraTrips = 0;
        classItems.forEach(item => {
            const dc = (item.delivery_class || 'small').toLowerCase();
            const baseIdx = classOrder[dc] ?? 0;
            const capacity = item.units_per_trip || DEFAULT_UNITS_PER_TRIP[dc] || DEFAULT_UNITS_PER_TRIP.small;
            const trips = Math.ceil(item.quantity / capacity);
            const rawIdx = baseIdx + (trips - 1);
            if (rawIdx > maxClassIdx) maxClassIdx = Math.min(rawIdx, 2);
            extraTrips += Math.max(0, rawIdx - 2);
        });
        feeItems.forEach(item => { if (item.seller_id) sellerIds.add(item.seller_id); });
        deliveryClass = classNames[maxClassIdx];
        sellerCount = Math.max(sellerIds.size, 1);
        const classBaseFee = classItems.length ? DELIVERY_CLASS_PRICES[deliveryClass] : 0;
        const customBaseFee = customItems.length ? Math.max(...customItems.map(i => i.delivery_price)) : 0;
        const baseFee = Math.max(classBaseFee, customBaseFee);
        productDelivery = Math.min(MAX_DELIVERY_FEE, Math.max(DELIVERY_FEE_MIN, baseFee + (sellerCount - 1) * PER_SELLER_FEE + extraTrips * LARGE_OVERFLOW_FEE));
    }

    // Service collection/return fees are flat, per line, and never waived by
    // the R600 threshold — that's a product-delivery concept.
    let serviceCollection = 0;
    let serviceReturn = 0;
    validatedCart.forEach(item => {
        if (!item.service_fees) return;
        serviceCollection += item.service_fees.collection || 0;
        serviceReturn += item.service_fees.return_delivery || 0;
    });

    return {
        productDelivery,
        serviceCollection,
        serviceReturn,
        total: productDelivery + serviceCollection + serviceReturn,
        deliveryClass,
        sellerCount,
        allFreeDelivery
    };
}

exports.handler = async function(event, context) {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const { cartItems, couponCode, customerEmail, quoteId, persistCart, finalCheck, destination } = JSON.parse(event.body);

        if (!cartItems || !Array.isArray(cartItems)) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid cart items' })
            };
        }
        
        // Initialize Supabase
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        if (!supabaseUrl || !supabaseKey) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Server configuration error' })
            };
        }

        // Who the buyer is comes from their session token, never from the
        // request body: a client-sent userId let anyone overwrite another
        // user's saved cart, use their delivery quote, or borrow their
        // first-order / per-user discount allowances. Server-side callers
        // (lib/reprice-order.js) pass the order's own user as trustedUserId —
        // a property no HTTP request can set.
        let userId = null;
        if (event.trustedUserId !== undefined) {
            userId = event.trustedUserId || null;
        } else {
            const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
            const token = authHeader.replace(/^Bearers+/i, '').trim();
            if (token) {
                const authClient = createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false, persistSession: false } });
                const { data: authData } = await authClient.auth.getUser(token);
                userId = (authData && authData.user && authData.user.id) || null;
            }
        }
        
        const supabase = createClient(supabaseUrl, supabaseKey);
        
        // Get product IDs from cart
const productIds = cartItems
  .map(i => i.id || i.product_id || i.productId)
  .filter(Boolean)
  .map(String);

if (!productIds.length) {
  return {
    statusCode: 400,
    body: JSON.stringify({ error: 'No valid product IDs in cart' })
  };
}
        
        // Fetch products — only visible ones
const { data: products, error: productsError } = await supabase
  .from('products')
  .select('id, price, sale, sale_price, stock, name, image, seller_id, delivery_class, visible, listing_type, fulfillment_type, service_turnaround, acceptance_deadline_hours, free_delivery, units_per_trip, intake_kind, intake_fields, booking_mode, instant_confirm, service_location, slot_duration_minutes, metadata, sellers(free_delivery)')
  .in('id', productIds)
  .eq('visible', true);

// then fetch variants separately
const { data: variants = [], error: variantsError } = await supabase
  .from('product_variants')
  .select('id, product_id, size, price_override, stock')
  .in('product_id', productIds);

if (variantsError) {
  console.error('Error fetching variants:', variantsError);
  return {
    statusCode: 500,
    body: JSON.stringify({ error: 'Failed to validate cart' })
  };
}


// then build productMap and variantMap from those two arrays

            
        if (productsError) {
            console.error('Error fetching products:', productsError);
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to validate cart' })
            };
        }
        
        // Create product map
        const productMap = {};
        products.forEach(product => {
            productMap[product.id] = product;
        });
        
// Build variantMap from variants query
const variantMap = {};
variants.forEach(v => {
  if (v.id) variantMap[v.id] = v;
  if (v.product_id && v.size) {
    variantMap[`${v.product_id}::${v.size}`] = v;
  }
});


		
        // Validate each cart item
        const validatedCart = [];
        let total = 0;
        let hasChanges = false;
        
        for (const rawItem of cartItems) {
  // Normalize incoming fields so the rest of the logic can rely on stable names
  const item = {
    id: rawItem.id || rawItem.product_id || rawItem.productId || null,
    name: rawItem.name || rawItem.title || '',
    price: typeof rawItem.price !== 'undefined' ? rawItem.price : (rawItem.Price || 0),
    quantity: rawItem.quantity || rawItem.qty || rawItem.Qty || 1,
    size: rawItem.size || rawItem.variant_size || 'One Size',
    image: rawItem.image || rawItem.img || '',
    variant_id: rawItem.variant_id || rawItem.variantId || rawItem.variant || null,
    // keep any other fields if needed
    _raw: rawItem
  };

  // now use `item` instead of rawItem below
  const pid = item.id;
  const product = productMap[pid];
  if (!product) {
    hasChanges = true;
    console.log('Product not found:', pid);
    continue;
  }

  // default
  const isService = product.listing_type === 'service';
  let itemPrice = product.price;
  // Services with null stock have unlimited slots
  let itemStock = (isService && product.stock == null) ? Infinity : (Number.isFinite(product.stock) ? product.stock : Infinity);
  let maxQuantity = itemStock;

  // If item has variant_id use that, else try by size
  let variant = null;
  if (item.variant_id) variant = variantMap[item.variant_id];
  if (!variant && item.size) variant = variantMap[`${pid}::${item.size}`];

  // A required option (products.metadata.option_required, e.g. Velaphi's
  // starch) must match one of the product's options — an old "One Size" line
  // or a missing choice is refused so the store never gets a plate without it.
  if (!variant && product.metadata && product.metadata.option_required && !isService) {
    const label = String(product.metadata.option_label || 'an option').replace(/^choose\s+/i, '');
    return { statusCode: 400, body: JSON.stringify({ error: `Please choose ${label} for "${item.name || product.name}" — open it from the store and pick one.`, code: 'OPTION_REQUIRED', productId: product.id }) };
  }

  if (variant) {
    itemPrice = variant.price_override || product.price;
    itemStock = variant.stock != null ? variant.stock : itemStock;
    maxQuantity = itemStock;
  }

  if (product.sale && product.sale_price) {
    itemPrice = product.sale_price;
  }

  // A physical product must never reach payment with a zero/invalid price —
  // this is the authoritative check (checkout.html has a matching client-side
  // check too, but that's only a UX shortcut; this is what actually blocks it).
  if (!isService && !(Number(itemPrice) > 0)) {
    return {
        statusCode: 400,
        body: JSON.stringify({ error: `"${item.name || product.name}" has no valid price and cannot be purchased. Please contact the seller.` })
    };
  }

  // Scheduled in-person bookings: the hold placed by hold-service-booking.js
  // is the source of truth for time and quantity (e.g. 3 quads). Re-checked
  // here because a hold can expire, be reused, or belong to another listing.
  // Refreshing hold_expires_at keeps it alive through PayFast; on an already
  // expired hold the capacity trigger re-checks, so a released slot that
  // someone else took is refused rather than double-booked.
  let booking = null;
  if (isService && product.fulfillment_type === 'in_person' && product.booking_mode === 'scheduled') {
    const label = item.name || product.name;
    if (!rawItem.booking_id) {
      return { statusCode: 400, body: JSON.stringify({ error: `Pick a time for "${label}" before paying.`, code: 'BOOKING_REQUIRED', productId: product.id }) };
    }
    const { data: b } = await supabase.from('service_bookings')
      .select('id, product_id, status, order_id, start_at, end_at, units')
      .eq('id', rawItem.booking_id).maybeSingle();
    if (!b || b.product_id !== product.id || b.status !== 'held' || b.order_id) {
      return { statusCode: 409, body: JSON.stringify({ error: `Your time for "${label}" is no longer held. Please pick a time again.`, code: 'BOOKING_EXPIRED', productId: product.id }) };
    }
    const { error: extendErr } = await supabase.from('service_bookings')
      .update({ hold_expires_at: new Date(Date.now() + 30 * 60000).toISOString() })
      .eq('id', b.id).eq('status', 'held');
    if (extendErr) {
      return { statusCode: 409, body: JSON.stringify({ error: `Your time for "${label}" was released and has since been booked. Please pick another time.`, code: 'BOOKING_EXPIRED', productId: product.id }) };
    }
    booking = b;
  }

  // Physical stock is a hard cap (0 = sold out → line dropped). Sold-out
  // products now stay visible, so this — not visibility — is what stops a
  // stale cart line being bought. Services keep their old behaviour (a 0/null
  // stock on a service never limited it).
  const qtyCap = isService ? (itemStock || Infinity) : Math.max(0, itemStock);
  const qty = booking ? booking.units : Math.min(item.quantity || 1, qtyCap);
  if (qty <= 0) {
    hasChanges = true;
    continue;
  }

  if (typeof item.price !== 'undefined' && Number(item.price) !== Number(itemPrice)) {
    hasChanges = true;
  }

  const isItemDropoff = isService && product.fulfillment_type === 'item_dropoff';
  const itemReturned = rawItem.item_returned !== false;
  const deliveryPrice = (product.metadata && Number.isFinite(Number(product.metadata.delivery_price)))
    ? Number(product.metadata.delivery_price) : null;

  const validated = {
    id: product.id,
    product_id: product.id,
    name: item.name || product.name,
    price: itemPrice,
    quantity: qty,
    size: item.size || 'One Size',
    image: product.image || item.image,
    variant_id: item.variant_id,
    max_quantity: maxQuantity,
    subtotal: itemPrice * qty,
    seller_id: product.seller_id || null,
    delivery_class: product.delivery_class || 'small',
    delivery_price: deliveryPrice,
    listing_type: product.listing_type || 'product',
    fulfillment_type: product.fulfillment_type || null,
    service_turnaround: product.service_turnaround || null,
    acceptance_deadline_hours: product.acceptance_deadline_hours || 24,
    free_delivery: !!product.free_delivery || !!(product.sellers && product.sellers.free_delivery), // product or whole-store switch
    units_per_trip: product.units_per_trip || null,
    // Carried through from the client cart item — previously dropped here,
    // which silently discarded intake answers and left paid scheduled-service
    // bookings unconfirmed (never flipped from 'held' to 'confirmed').
    intake: rawItem.intake || null,
    booking_id: booking ? booking.id : null,
    booking_start_at: booking ? booking.start_at : null,
    booking_end_at: booking ? booking.end_at : null,
    booking_units: booking ? booking.units : null,
    instant_confirm: isService ? !!product.instant_confirm : false,
    // What kind of service this is, from the listing (never the browser) —
    // every later screen/email picks its wording and steps from these.
    is_voucher: isService && !!(product.metadata && product.metadata.voucher === true),
    service_location: isService ? (product.service_location || null) : null,
    item_returned: itemReturned,
    intake_kind: isService ? (product.intake_kind || 'item') : null,
    intake_fields: isService ? (Array.isArray(product.intake_fields) ? product.intake_fields : []) : null,
    booking_mode: isService ? (product.booking_mode || null) : null
  };

  if (isItemDropoff) {
    // Never trust client-chosen methods/fees — clamp to known values and
    // price server-side. Collection/return is always rep-collect/deliver
    // now (no free campus drop-off/pickup-point option left) — a missing
    // address or slot is rejected rather than silently downgraded, since
    // there's no free fallback state to downgrade to anymore.
    const intakeKind = product.intake_kind || 'item';
    const rawOpts = (rawItem.service_options && typeof rawItem.service_options === 'object') ? rawItem.service_options : {};
    // Nothing physical to collect when the buyer sends a file or nothing —
    // that leg simply doesn't exist for this archetype.
    const collectionMethod = intakeKind === 'item' ? 'rep_collect' : 'none';
    const collectionAddress = (rawOpts.collection_address || '').toString().trim().slice(0, 300) || null;
    const collectionSlotStart = validSlotIso(rawOpts.collection_slot_start);
    const collectionSlotEnd = validSlotIso(rawOpts.collection_slot_end);
    if (collectionMethod === 'rep_collect' && (!collectionAddress || !collectionSlotStart)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Missing collection address/time for "${item.name || product.name}".` })
      };
    }

    const returnMethod = itemReturned ? 'deliver' : 'none';
    const returnAddress = (rawOpts.return_address || '').toString().trim().slice(0, 300) || null;
    const returnSlotStart = validSlotIso(rawOpts.return_slot_start);
    const returnSlotEnd = validSlotIso(rawOpts.return_slot_end);
    if (returnMethod === 'deliver' && (!returnAddress || !returnSlotStart)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Missing return address/time for "${item.name || product.name}".` })
      };
    }

    validated.service_options = {
      collection_method: collectionMethod,
      collection_address: collectionMethod === 'rep_collect' ? collectionAddress : null,
      collection_slot_start: collectionMethod === 'rep_collect' ? collectionSlotStart : null,
      collection_slot_end: collectionMethod === 'rep_collect' ? collectionSlotEnd : null,
      return_method: returnMethod,
      return_address: returnMethod === 'deliver' ? returnAddress : null,
      return_slot_start: returnMethod === 'deliver' ? returnSlotStart : null,
      return_slot_end: returnMethod === 'deliver' ? returnSlotEnd : null
    };
    validated.service_fees = {
      collection: collectionMethod === 'rep_collect' ? SERVICE_COLLECT_FEE : 0,
      return_delivery: returnMethod === 'deliver' ? SERVICE_RETURN_FEE : 0
    };
  }

  validatedCart.push(validated);

  total += itemPrice * qty;
}

        
        // If user is authenticated, update their cart in database — unless
        // this is only part of their cart (a one-store checkout or Buy Now),
        // which must not overwrite the rest of their saved cart.
        if (userId && persistCart !== false) {
            const cartData = {
                items: validatedCart.map(item => ({
                    product_id: item.id,
                    name: item.name,
                    price: item.price,
                    quantity: item.quantity,
                    size: item.size,
                    image: item.image,
                    variant_id: item.variant_id,
                    max_quantity: item.max_quantity,
                    // Service setup lives on the cart item — dropping it here
                    // made a signed-in buyer's booking/intake vanish from their
                    // saved cart, leaving checkout stuck on "pick a time".
                    seller_id: item.seller_id,
                    listing_type: item.listing_type,
                    fulfillment_type: item.fulfillment_type,
                    intake: item.intake || null,
                    booking_id: item.booking_id || null,
                    booking_start_at: item.booking_start_at || null,
                    service_options: item.service_options || null
                })),
                updated_at: new Date().toISOString()
            };
            
            await supabase
                .from('carts')
                .upsert({
                    user_id: userId,
                    ...cartData
                }, {
                    onConflict: 'user_id'
                });
        }
        
        // Server-authoritative discount — mirrors how `fees` already works.
        // Never trust a client-computed discount amount once real seller
        // money is involved.
        let discount = null;
        if (couponCode) {
            const v = await validateCode(supabase, { code: couponCode, email: customerEmail, userId });
            if (!v.ok) {
                discount = { valid: false, reason: v.reason };
            } else {
                let sellerShopName = null;
                if (v.codeRow.seller_id) {
                    const { data: sellerRow } = await supabase
                        .from('sellers')
                        .select('shop_name')
                        .eq('id', v.codeRow.seller_id)
                        .maybeSingle();
                    sellerShopName = sellerRow?.shop_name || null;
                }
                const computed = computeDiscount(v.codeRow, validatedCart, sellerShopName);
                discount = {
                    valid: true,
                    code: v.codeRow.code,
                    type: v.codeRow.type,
                    requiresSignIn: !!v.requiresSignIn,
                    amount: v.requiresSignIn ? 0 : computed.amount,
                    previewAmount: computed.amount,
                    eligibleSubtotal: computed.eligibleSubtotal,
                    matchedItems: computed.matchedItems,
                    scopeLabel: computed.scopeLabel,
                    reason: computed.reason || null
                };
            }
        }

        // Delivery network Stage 3 (docs/systems/delivery-network-spec.md §E) — a
        // locked pre-payment quote (plan §104-105) is the trusted delivery total
        // when one was supplied and is still genuinely valid. This never trusts
        // the client's own claim about what the quote said -- it re-reads the row
        // from delivery_quotes itself. Falls through to today's exact computeFees()
        // behavior (unchanged) whenever no quoteId is given, or the quote doesn't
        // check out -- fully backward compatible with every caller that predates
        // quotes entirely.
        // Final pre-payment check (checkout sends finalCheck + the address's
        // coordinates): physical items are only delivered inside an active
        // delivery zone (admin → Service Areas). Outside every zone there is
        // no delivery — checkout offers "notify me when you deliver here"
        // instead (founder decision 2026-10-04: never a default fee there).
        if (finalCheck && validatedCart.some(i => (i.listing_type || 'product') !== 'service')) {
            const dLat = destination ? Number(destination.lat) : NaN, dLon = destination ? Number(destination.lon) : NaN;
            if (!Number.isFinite(dLat) || !Number.isFinite(dLon)) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Pick your delivery address from the suggestions so we can check we deliver there.', code: 'ADDRESS_REQUIRED' }) };
            }
            const { data: zoneRows, error: zoneErr } = await supabase.rpc('find_service_zone_for_point', { p_lat: dLat, p_lon: dLon });
            const zone = Array.isArray(zoneRows) ? zoneRows[0] : zoneRows;
            if (zoneErr) {
                return { statusCode: 503, body: JSON.stringify({ error: 'We couldn’t check delivery to your address — please try again.', code: 'AREA_CHECK_FAILED' }) };
            }
            if (!zone || zone.zone_type === 'restricted') {
                return { statusCode: 400, body: JSON.stringify({ error: 'We don’t deliver to this address yet.', code: 'OUTSIDE_AREA' }) };
            }
        }

        let fees = computeFees(validatedCart);
        let quoteApplied = false;
        if (quoteId) {
            const { data: quoteRow, error: quoteError } = await supabase
                .from('delivery_quotes')
                .select('id, customer_id, total_delivery_fee, status, expires_at')
                .eq('id', quoteId)
                .maybeSingle();

            const quoteBelongsToCaller = quoteRow && (
                quoteRow.customer_id === null || quoteRow.customer_id === userId
            );
            const quoteStillValid = quoteRow
                && quoteRow.status === 'active'
                && new Date(quoteRow.expires_at).getTime() > Date.now();

            if (!quoteError && quoteRow && quoteBelongsToCaller && quoteStillValid) {
                // The quote prices product delivery only — rep collection /
                // return fees for services in the same cart still apply.
                const quoted = Number(quoteRow.total_delivery_fee);
                fees = { ...fees, productDelivery: quoted, total: Math.round((quoted + (fees.serviceCollection || 0) + (fees.serviceReturn || 0)) * 100) / 100, quotedFee: quoted };
                quoteApplied = true;
            }
            // An invalid/expired/mismatched quote is not an error -- it just means
            // the fallback computeFees() total (already assigned above) is used,
            // same as if no quoteId had been sent at all.
        }

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                validatedCart,
                total,
                hasChanges,
                fees,
                quoteApplied,
                discount,
                message: hasChanges ? 'Cart has been updated with current prices and stock' : 'Cart is valid'
            })
        };
        
    } catch (error) {
        console.error('Cart validation error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: 'Internal server error',
                details: error.message 
            })
        };
    }
};