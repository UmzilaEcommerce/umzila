// netlify/functions/send-rating-requests.js — scheduled every 5 min (netlify.toml).
//
// ~10 minutes after a delivery is completed, emails the customer the 1–5 star
// rating email (lib/rating-email.js → rate-delivery.js → delivery_feedback).
// Window: delivered between 10 min and 2 h ago, so a missed run catches up but
// old deliveries never get a surprise email. Exactly once per delivery: a
// notification_log row (event RATING_REQUEST, channel email) is claimed
// first — its unique index (coalesce(delivery_id, order_id), event_type,
// channel) stops a second send even if two runs overlap. Skipped when the
// customer already left feedback (e.g. on the tracking page) or has no email.
const { createClient } = require('@supabase/supabase-js');
const { buildRatingEmail } = require('./lib/rating-email');

const EVENT = 'RATING_REQUEST';

exports.handler = async () => {
  const SITE = (process.env.SITE_BASE_URL || '').replace(/\/$/, '');
  const KEY = process.env.RESEND_API_KEY;
  if (!SITE || !KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('send-rating-requests: missing config'); return { statusCode: 200, body: 'skipped' };
  }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const now = Date.now();
  const { data: dels, error } = await sb.from('deliveries')
    .select('id, order_id, customer_id, delivered_at, tracking_token')
    .eq('status', 'DELIVERED')
    .lte('delivered_at', new Date(now - 10 * 60000).toISOString())
    .gte('delivered_at', new Date(now - 2 * 3600000).toISOString())
    .limit(50);
  if (error) { console.error('send-rating-requests: load', error); return { statusCode: 500, body: 'error' }; }

  let sent = 0;
  for (const d of dels || []) {
    if (!d.tracking_token) continue;
    const [{ data: logged }, { data: fb }] = await Promise.all([
      sb.from('notification_log').select('id').eq('delivery_id', d.id).eq('event_type', EVENT).eq('channel', 'email').maybeSingle(),
      sb.from('delivery_feedback').select('id').eq('delivery_id', d.id).maybeSingle()
    ]);
    if (logged || fb) continue;
    const { data: order } = await sb.from('orders').select('customer_name, customer_email, order_number, m_payment_id, items').eq('id', d.order_id).maybeSingle();
    if (!order || !order.customer_email) continue;

    // Claim it first (unique index = exactly once), then send.
    const { data: claim, error: claimErr } = await sb.from('notification_log').insert({
      delivery_id: d.id, order_id: d.order_id, recipient_id: d.customer_id || null,
      event_type: EVENT, channel: 'email', status: 'failed' // flipped to 'sent' below once Resend accepts it (status allows only sent|failed)
    }).select('id').single();
    if (claimErr) continue; // another run got there first

    // Store name = the real store(s) on the order (never the house drinks store)
    const items = Array.isArray(order.items) ? order.items : [];
    const sellerIds = [...new Set(items.map(i => i.seller_id).filter(Boolean))];
    let storeName = 'your';
    if (sellerIds.length) {
      const { data: sellers } = await sb.from('sellers').select('id, shop_name, is_house').in('id', sellerIds);
      const real = (sellers || []).filter(s => !s.is_house).map(s => s.shop_name);
      if (real.length) storeName = real.join(' & ');
    }
    const mail = buildRatingEmail({
      siteUrl: SITE, deliveryId: d.id, token: d.tracking_token,
      customerName: order.customer_name, storeName: storeName === 'your' ? 'Umzila' : storeName,
      items: items.filter(i => (i.listing_type || 'product') !== 'service').map(i => ({ name: i.name || i.title || 'Item', qty: i.quantity || i.qty || 1 })),
      deliveredAt: d.delivered_at, orderRef: order.order_number || order.m_payment_id
    });
    let status = 'sent', msgId = null;
    try {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...mail, to: [order.customer_email] }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { status = 'failed'; console.warn('send-rating-requests: Resend', r.status, j.message); } else msgId = j.id || null;
    } catch (e) { status = 'failed'; console.warn('send-rating-requests: send threw', e.message); }
    await sb.from('notification_log').update({ status, provider_message_id: msgId, sent_at: status === 'sent' ? new Date().toISOString() : null }).eq('id', claim.id);
    if (status === 'sent') sent++;
  }
  console.log('send-rating-requests: sent', sent);
  return { statusCode: 200, body: JSON.stringify({ sent }) };
};
