// netlify/functions/advance-delivery-on-fulfillment.js
//
// Delivery network (delivery-network-spec.md Stage 7, corrected design) —
// called by seller-dashboard.html's EXISTING updateOrderFulfillment(), right
// after it derives orders.order_status from every seller's own
// order_item_statuses rows on an order. This does not add a new "mark
// ready" UI (the plan originally called for one) -- seller-dashboard.html
// already has a robust, multi-seller-aware fulfillment mechanism that
// correctly aggregates every seller's progress on a shared order without
// one seller clobbering another's. Reusing it, rather than building a
// second, parallel "ready" concept, is what Stage 7 actually needed to do.
//
// deliveries.status is only ever writable by the service role (no client
// RLS write policy exists), so this one small step has to be server-side --
// everything else about "is this order ready" already lives client-side in
// seller-dashboard.html and stays there unchanged.
const { createClient } = require('@supabase/supabase-js');
const { transitionDelivery } = require('./lib/delivery-state');
const { offerDelivery } = require('./lib/batch-dispatch');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { orderId } = JSON.parse(event.body || '{}');
    if (!orderId || typeof orderId !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'orderId required' }) };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Most orders won't have one yet -- no ORS_API_KEY (routing) means no
    // quote ever succeeded, which means orders.delivery_quote_id (and so this
    // deliveries row) was never created. That's expected, not an error: this
    // order simply isn't part of the delivery network (yet, or ever, if it's
    // a pickup-only/service order).
    const { data: delivery, error: deliveryError } = await supabase
      .from('deliveries')
      .select('id, status')
      .eq('order_id', orderId)
      .maybeSingle();

    if (deliveryError) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to look up delivery', detail: deliveryError.message }) };
    }
    if (!delivery) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: true, reason: 'no_delivery_for_order' }) };
    }
    if (delivery.status !== 'PENDING') {
      // Already advanced past PENDING (e.g. a second seller's fulfillment
      // update on the same order calling this again) -- correctly a no-op,
      // not an error. transitionDelivery()'s own transition map would also
      // reject this, but checking here avoids a pointless extra round trip.
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: true, reason: 'already_advanced', status: delivery.status }) };
    }

    // Stage 4 (2026-09-17): a bundled order must only advance once EVERY
    // seller with items on it has marked their own portion ready -- this
    // used to transition unconditionally the instant ANY seller called this
    // endpoint, which was only correct by accident for a single-seller order
    // (the only case exercised until Stage 4). Ports the exact order-wide
    // order_item_statuses aggregation seller-dashboard.html's old fulfillment
    // dropdown already did client-side (loadOrders()'s _mySellerStatus
    // derivation), server-side, so it's authoritative regardless of which
    // seller's click triggered this call. order_items (not orders.items
    // jsonb) is the real seller-set source here since this session's earlier
    // populate_order_items_on_payment fix made it reliably populated.
    const { data: orderItems, error: orderItemsError } = await supabase
      .from('order_items')
      .select('id, seller_id, product_id, selected_size')
      .eq('order_id', orderId);
    if (orderItemsError) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load order items', detail: orderItemsError.message }) };
    }
    if (orderItems && orderItems.length) {
      const { data: statusRows, error: statusError } = await supabase
        .from('order_item_statuses')
        .select('seller_id, status')
        .eq('order_id', orderId);
      if (statusError) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load order item statuses', detail: statusError.message }) };
      }
      const READY_STATUSES = ['fulfilled', 'delivered', 'refunded'];
      const sellersOnOrder = [...new Set(orderItems.map(i => i.seller_id).filter(Boolean))];
      const allSellersReady = sellersOnOrder.every(sellerId => {
        // Distinct lines (product + size), so a duplicated order_items row
        // can never make a seller look "not ready" forever.
        const sellerItemCount = new Set(orderItems.filter(i => i.seller_id === sellerId).map(i => `${i.product_id || i.id}|${i.selected_size || ''}`)).size;
        const sellerReadyCount = (statusRows || []).filter(s => s.seller_id === sellerId && READY_STATUSES.includes(s.status)).length;
        return sellerReadyCount >= sellerItemCount;
      });
      if (!allSellersReady) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: true, reason: 'awaiting_other_sellers' }) };
      }
    }
    // else: order_items unexpectedly empty for this order -- fall through to
    // today's behavior rather than stranding a legitimately single-seller
    // order over missing rows that shouldn't happen for a paid order.

    const result = await transitionDelivery(
      supabase,
      delivery.id,
      'READY_FOR_DISPATCH',
      { type: 'system' },
      { eventType: 'ORDER_READY', metadata: { order_id: orderId } }
    );

    if (!result.ok) {
      // A conflict here (another concurrent call already advanced it) is not
      // really a failure from this caller's point of view -- the delivery
      // ended up where it needed to be either way.
      if (result.reason === 'conflict') {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: true, reason: 'concurrent_advance' }) };
      }
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to advance delivery', detail: result.detail || result.reason }) };
    }

    // Delivery network Stage 11 -- try batching onto an already-moving
    // driver's route FIRST (cheaper for the pilot's 2-driver fleet than
    // always waiting on/tying up a separate idle driver), and only fall
    // through to Stage 8's idle-driver dispatch if no batchable route is
    // close enough. Same non-blocking guarantee as dispatch: this must never
    // turn a successful fulfillment update into an error response.
    // Multi-drop (2026-10-05): one shared rule for offering a ready order —
    // onto a trip it fits, else a free rider, else (no free rider) onto an
    // on-trip rider anyway (lib/batch-dispatch.js offerDelivery).
    try {
      const offered = await offerDelivery(supabase, delivery.id);
      if (offered.batched || offered.dispatched) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, delivery: result.delivery, batched: !!offered.batched, offerId: offered.offerId || null }) };
      }
      console.warn('advance-delivery-on-fulfillment: not offered yet', offered.reason, offered.detail || '');
    } catch (offerError) {
      console.warn('advance-delivery-on-fulfillment: offerDelivery threw', offerError && offerError.message);
    }

    // Not offered yet (no rider online / nothing fits): stays READY_FOR_DISPATCH;
    // the next rider heartbeat (sweepWaitingDeliveries) offers it again.
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, delivery: result.delivery }) };
  } catch (error) {
    console.error('advance-delivery-on-fulfillment error', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
