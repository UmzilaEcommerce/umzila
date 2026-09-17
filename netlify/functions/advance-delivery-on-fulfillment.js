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

    // Most orders won't have one yet -- no GOOGLE_ROUTES_SERVER_KEY means no
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

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, delivery: result.delivery }) };
  } catch (error) {
    console.error('advance-delivery-on-fulfillment error', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
