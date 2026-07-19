const { createClient } = require('@supabase/supabase-js');
const { validateCode, computeDiscount } = require('./lib/discounts');

// Must match checkout.html's client-side copies — this server copy is authoritative.
const DELIVERY_CLASS_PRICES   = { small: 12, medium: 22, large: 50 };
const PER_SELLER_FEE          = 3;
const FREE_DELIVERY_THRESHOLD = 600;
const SERVICE_COLLECT_FEE     = 15; // rep collects buyer's item from their address
const SERVICE_RETURN_FEE      = 15; // finished item delivered to an address
// Quantity-aware fee stepping — must match checkout.html exactly.
const DEFAULT_UNITS_PER_TRIP  = { small: 8, medium: 4, large: 2 };
const LARGE_OVERFLOW_FEE      = 10;
const MAX_DELIVERY_FEE        = 80;

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
    } else if (subtotal >= FREE_DELIVERY_THRESHOLD) {
        // free — still counts free_delivery items toward the threshold
    } else {
        const classOrder = { small: 0, medium: 1, large: 2 };
        const classNames = ['small', 'medium', 'large'];
        const sellerIds = new Set();
        let maxClassIdx = 0;
        let extraTrips = 0;
        feeItems.forEach(item => {
            const dc = (item.delivery_class || 'small').toLowerCase();
            const baseIdx = classOrder[dc] ?? 0;
            const capacity = item.units_per_trip || DEFAULT_UNITS_PER_TRIP[dc] || DEFAULT_UNITS_PER_TRIP.small;
            const trips = Math.ceil(item.quantity / capacity);
            const rawIdx = baseIdx + (trips - 1);
            if (rawIdx > maxClassIdx) maxClassIdx = Math.min(rawIdx, 2);
            extraTrips += Math.max(0, rawIdx - 2);
            if (item.seller_id) sellerIds.add(item.seller_id);
        });
        deliveryClass = classNames[maxClassIdx];
        sellerCount = Math.max(sellerIds.size, 1);
        productDelivery = Math.min(MAX_DELIVERY_FEE, Math.max(0, DELIVERY_CLASS_PRICES[deliveryClass] + (sellerCount - 1) * PER_SELLER_FEE + extraTrips * LARGE_OVERFLOW_FEE));
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
        const { cartItems, userId, couponCode, customerEmail } = JSON.parse(event.body);

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
  .select('id, price, sale, sale_price, stock, name, image, seller_id, delivery_class, visible, listing_type, fulfillment_type, service_turnaround, acceptance_deadline_hours, free_delivery, units_per_trip, intake_kind, intake_fields, booking_mode')
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

  if (variant) {
    itemPrice = variant.price_override || product.price;
    itemStock = variant.stock != null ? variant.stock : itemStock;
    maxQuantity = itemStock;
  }

  if (product.sale && product.sale_price) {
    itemPrice = product.sale_price;
  }

  const qty = Math.min(item.quantity || 1, itemStock || Infinity);
  if (qty <= 0) {
    hasChanges = true;
    continue;
  }

  if (typeof item.price !== 'undefined' && Number(item.price) !== Number(itemPrice)) {
    hasChanges = true;
  }

  const isItemDropoff = isService && product.fulfillment_type === 'item_dropoff';
  const itemReturned = rawItem.item_returned !== false;

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
    delivery_class: product.delivery_class || null,
    listing_type: product.listing_type || 'product',
    fulfillment_type: product.fulfillment_type || null,
    service_turnaround: product.service_turnaround || null,
    acceptance_deadline_hours: product.acceptance_deadline_hours || 24,
    free_delivery: !!product.free_delivery,
    units_per_trip: product.units_per_trip || null,
    // Carried through from the client cart item — previously dropped here,
    // which silently discarded intake answers and left paid scheduled-service
    // bookings unconfirmed (never flipped from 'held' to 'confirmed').
    intake: rawItem.intake || null,
    booking_id: rawItem.booking_id || null,
    booking_start_at: rawItem.booking_start_at || null,
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

        
        // If user is authenticated, update their cart in database
        if (userId) {
            const cartData = {
                items: validatedCart.map(item => ({
                    product_id: item.id,
                    name: item.name,
                    price: item.price,
                    quantity: item.quantity,
                    size: item.size,
                    image: item.image,
                    variant_id: item.variant_id,
                    max_quantity: item.max_quantity
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

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                validatedCart,
                total,
                hasChanges,
                fees: computeFees(validatedCart),
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