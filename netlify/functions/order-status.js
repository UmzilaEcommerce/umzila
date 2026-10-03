// netlify/functions/order-status.js
//
// checkout-success.html polls this to learn when an order is paid. It used
// to read `orders` directly, which only works for a signed-in buyer — RLS
// gives guests (anon) no SELECT on orders, so a guest's success page never
// saw "paid" and never showed their booking / service next steps.
//
// The m_payment_id (UMZILA-<ms>-<random>) is only known to whoever placed
// the order, and this returns nothing personal: payment status plus the
// service lines needed to render next steps.
//
// GET ?m=<m_payment_id>  → { paymentStatus, services: [...] }
const { createClient } = require('@supabase/supabase-js');

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const m = (event.queryStringParameters && event.queryStringParameters.m) || '';
  if (!/^UMZILA-\d{10,}-[a-z0-9]{6,}$/i.test(m)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid order reference' }) };
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: order } = await supabase.from('orders')
    .select('payment_status, items').eq('m_payment_id', m).maybeSingle();
  if (!order) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Order not found' }) };

  const items = Array.isArray(order.items) ? order.items : [];
  const services = order.payment_status === 'paid'
    ? items.filter(i => i.listing_type === 'service').map(i => ({
        name: i.name || i.title || 'Service',
        quantity: i.quantity || i.qty || 1,
        listing_type: 'service',
        fulfillment_type: i.fulfillment_type || null,
        booking_start_at: i.booking_start_at || null,
        booking_end_at: i.booking_end_at || null,
        service_options: i.fulfillment_type === 'item_dropoff' ? (i.service_options || null) : null,
        item_returned: i.item_returned,
        intake_kind: i.intake_kind || null,
        service_turnaround: i.service_turnaround || null,
        booking_mode: i.booking_mode || null,
        booking_units: i.booking_units || null,
        instant_confirm: !!i.instant_confirm,
        is_voucher: !!i.is_voucher,
        service_location: i.service_location || null,
        acceptance_deadline_hours: i.acceptance_deadline_hours || null
      }))
    : [];
  const hasPhysical = items.some(i => (i.listing_type || 'product') !== 'service');
  return { statusCode: 200, headers, body: JSON.stringify({ paymentStatus: order.payment_status || 'pending', hasPhysical, services }) };
};
