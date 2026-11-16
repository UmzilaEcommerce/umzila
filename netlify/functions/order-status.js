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
// GET ?m=<m_payment_id>  → { paymentStatus, hasPhysical, services: [...], trackPath? }
// trackPath (paid orders with a delivery): the private tracking link
// (/track.html?order=<id>&t=<token>) — guests have no account, so this link
// is how they follow their delivery.
const { createClient } = require('@supabase/supabase-js');

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const m = (event.queryStringParameters && event.queryStringParameters.m) || '';
  if (!/^UMZILA-\d{10,}-[a-z0-9]{6,}$/i.test(m)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid order reference' }) };
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: order } = await supabase.from('orders')
    .select('id, payment_status, items, slot_id, slot_run_date, slot_window_start, slot_window_end, slot_needs_attention').eq('m_payment_id', m).maybeSingle();
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
  let trackPath = null;
  if (order.payment_status === 'paid' && hasPhysical) {
    const { data: delivery } = await supabase.from('deliveries').select('tracking_token').eq('order_id', order.id).maybeSingle();
    if (delivery && delivery.tracking_token) trackPath = `/track.html?order=${order.id}&t=${delivery.tracking_token}`;
  }
  // Delivery timeslots: the run this order is in (null for orders without one, e.g. placed
  // while the feature was off, or services). moved_from = the window it was first sold.
  let run = null;
  if (order.slot_id && order.payment_status === 'paid') {
    let cutoffMin = 15;
    try {
      const { data: st } = await supabase.from('site_settings').select('value').eq('key', 'timeslots').maybeSingle();
      if (st && st.value && Number(st.value.cutoff_minutes) > 0) cutoffMin = Number(st.value.cutoff_minutes);
    } catch (_) {}
    let movedFrom = null;
    try {
      const { data: mv } = await supabase.from('delivery_run_moves').select('from_window_start, from_window_end, reason')
        .eq('order_id', order.id).order('created_at', { ascending: true }).limit(1);
      if (mv && mv[0] && mv[0].from_window_start) movedFrom = { window_start: mv[0].from_window_start, window_end: mv[0].from_window_end, reason: mv[0].reason };
    } catch (_) {}
    const ws = order.slot_window_start;
    run = {
      run_date: order.slot_run_date,
      window_start: order.slot_needs_attention ? null : ws,
      window_end: order.slot_needs_attention ? null : order.slot_window_end,
      cutoff_at: ws ? new Date(new Date(ws).getTime() - cutoffMin * 60000).toISOString() : null,
      needs_attention: !!order.slot_needs_attention,
      moved_from: movedFrom
    };
  }
  // Payment picker: how a paid order was paid ("Paid R210 with Capitec Pay"). null for
  // orders paid with the picker off, R0 orders, or when nothing is known.
  // Separate, guarded read so this endpoint never breaks on the payment columns.
  let paidWith = null;
  if (order.payment_status === 'paid') {
    try {
      const { data: pw } = await supabase.from('orders')
        .select('total, payment_option_key, payment_method_code, pf_response').eq('id', order.id).maybeSingle();
      if (pw && (pw.payment_option_key || pw.payment_method_code === 'token') && pw.payment_method_code !== 'zero') {
        let name = null;
        if (pw.payment_method_code === 'token') name = 'Saved card';
        else {
          const { data: ps } = await supabase.from('site_settings').select('value').eq('key', 'payments').maybeSingle();
          const opt = ((ps && ps.value && ps.value.options) || []).find(o => o && o.key === pw.payment_option_key);
          name = opt && opt.name ? String(opt.name) : null;
        }
        const g = pw.pf_response && pw.pf_response.amount_gross;
        const gross = g !== undefined && g !== null && String(g).trim() !== '' && Number.isFinite(Number(g)) ? Number(g)
          : (pw.payment_method_code === 'token' ? Number(pw.total) : null);
        paidWith = { option_key: pw.payment_option_key || null, name, amount_gross: gross };
      }
    } catch (_) { paidWith = null; }
  }
  return { statusCode: 200, headers, body: JSON.stringify({ paymentStatus: order.payment_status || 'pending', hasPhysical, services, trackPath, run, paidWith }) };
};
