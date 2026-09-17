// netlify/functions/submit-delivery-feedback.js
//
// Delivery network Stage 13b (delivery-network-spec.md §E.1 Patch 3,
// plan §97/173/174) — the only place a delivery_feedback row is created.
// Never trusts a client-supplied seller_id/driver_id: both are resolved
// server-side from the delivery's own route (route_stops' pickup seller,
// routes.driver_id) so a customer can't misattribute a complaint/compliment
// to the wrong seller. This is why delivery_feedback has no client-facing
// INSERT RLS policy at all -- this function (service role) is the only path.
const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const MAX_MESSAGE_LENGTH = 1000;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { deliveryId, feedbackType, category, message } = body;
  if (!deliveryId || !['compliment', 'complaint'].includes(feedbackType)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "deliveryId and feedbackType ('compliment'|'complaint') required" }) };
  }
  const trimmedMessage = typeof message === 'string' ? message.trim().slice(0, MAX_MESSAGE_LENGTH) : null;
  const trimmedCategory = typeof category === 'string' && category.trim() ? category.trim().slice(0, 80) : null;

  const { data: delivery, error: deliveryError } = await admin
    .from('deliveries')
    .select('id, order_id, customer_id, status, route_id')
    .eq('id', deliveryId)
    .maybeSingle();
  if (deliveryError) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to look up delivery' }) };
  if (!delivery) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Delivery not found' }) };
  if (delivery.customer_id !== user.id) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'This delivery does not belong to you' }) };
  }
  if (delivery.status !== 'DELIVERED') {
    return { statusCode: 409, headers, body: JSON.stringify({ error: 'Feedback can only be submitted after delivery' }) };
  }

  // One submission per delivery -- the unique index is the real guarantee,
  // this is just a friendlier error than a raw 23505.
  const { data: existing } = await admin.from('delivery_feedback').select('id').eq('delivery_id', deliveryId).maybeSingle();
  if (existing) return { statusCode: 409, headers, body: JSON.stringify({ error: 'Feedback already submitted for this delivery' }) };

  // Resolve seller_id/driver_id server-side from the delivery's own route --
  // never from client input.
  let sellerId = null;
  let driverId = null;
  if (delivery.route_id) {
    const { data: route } = await admin.from('routes').select('driver_id').eq('id', delivery.route_id).maybeSingle();
    if (route) driverId = route.driver_id;
    const { data: pickupStop } = await admin
      .from('route_stops')
      .select('seller_id')
      .eq('route_id', delivery.route_id)
      .eq('stop_type', 'pickup')
      .eq('delivery_id', deliveryId)
      .maybeSingle();
    if (pickupStop) sellerId = pickupStop.seller_id;
  }

  const { data: inserted, error: insertError } = await admin
    .from('delivery_feedback')
    .insert({
      delivery_id: deliveryId,
      order_id: delivery.order_id,
      customer_id: user.id,
      feedback_type: feedbackType,
      category: trimmedCategory,
      message: trimmedMessage,
      seller_id: sellerId,
      driver_id: driverId
    })
    .select('id')
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Feedback already submitted for this delivery' }) };
    }
    console.error('submit-delivery-feedback: insert failed', insertError.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to submit feedback' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id: inserted.id }) };
};
