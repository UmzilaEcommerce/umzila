const { mailFrom } = require('./mail'); // sender: mail.umzila.store, replies to @umzila.store
// netlify/functions/lib/notify.js
//
// Delivery network Stage 14 (delivery-network-spec.md §O... see Stage 14
// write-up) — the single centralized place a delivery-status-change email
// gets sent, called from delivery-state.js's transitionDelivery() rather
// than scattered across dispatch/pickup/PIN functions (plan §168).
//
// Scope decision, not silently narrowed: the plan's §61 channel diagram
// lists EMAIL and IN-APP as the two available channels ("You already have
// Resend, so email can initially use that"). This build ships EMAIL only.
// There is no existing customer-facing in-app notification feed anywhere in
// this codebase (only `seller_notifications`, which is seller-facing), and
// track.html (Stage 12) already gives a customer live in-app status
// visibility by simply opening the page -- building a whole new in-app
// notification-center UI just to duplicate what track.html already shows,
// for a 2-rider pilot with no real customer volume yet, isn't justified.
// `channel` is still a real column on notification_log (checked against
// 'email'|'in_app') so a future in-app channel slots in without a schema
// change.
//
// Not every delivery_status transition gets an email (plan: "not every
// event necessarily needs an email, some are in-app only") -- only the ones
// a customer actually needs to act on or care about get sent here.
//
// Never blocks or fails the delivery transition it's called from: every
// failure mode (missing RESEND_API_KEY, missing customer email, Resend API
// error) is caught and logged, never thrown.

// The customer's step-by-step updates (2026-11-28 — "never leave them guessing"):
//   ASSIGNED   "<Rider> is collecting your order from <store>"
//   PICKED_UP  "<Rider> has your order" (+ PIN, + "1 drop before yours" on a shared trip)
//   IN_ROUTE   "You're next — heading to you now" — only when it comes 5+ min after the
//              collected email (shared trip); right after collecting it would just repeat it
//   NEARBY     not a delivery status: sent from the rider's live GPS (driver-heartbeat.js →
//              near_drop_deliveries, site_settings 'delivery_emails'.almost_there_km)
//   ARRIVING   "Your rider is outside" (the "I've arrived" tap)
//   DELIVERED / FAILED / CANCELLED
// Staff overrides that jump several steps pass { silent: true } to transitionDelivery for the
// in-between steps, so only the step they landed on emails.
const NOTIFIABLE_EVENTS = new Set(['ASSIGNED', 'PICKED_UP', 'IN_ROUTE', 'NEARBY', 'ARRIVING', 'DELIVERED', 'FAILED', 'CANCELLED']);
const IN_ROUTE_AFTER_PICKUP_MIN = 5;

const UMZILA_WA = '27797662768'; // same support WhatsApp number used elsewhere (profile.html)

function esc(s) {
  return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Shared visual chrome -- same header/body-card/footer structure already
// used by send-on-the-way.js, pulled out here so
// this and send-on-the-way.js's reconciled version don't each carry their
// own separate copy of the same boilerplate (CLAUDE.md: don't duplicate the
// same thing across files).
function emailShell(siteBaseUrl, headline, bodyHtml, ctaHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif">
<div style="max-width:580px;margin:30px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
  <div style="background:#0a2f66;padding:28px 36px;text-align:center">
    <div style="font-size:28px;font-weight:900;color:#fff;margin:0">Umzila</div>
    <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-top:4px">Durban&rsquo;s best local businesses</div>
  </div>
  <div style="padding:32px 36px">
    <h2 style="color:#0a2f66;margin:0 0 12px;font-size:22px">${headline}</h2>
    ${bodyHtml}
    ${ctaHtml || ''}
  </div>
  <div style="background:#f4f6fb;padding:16px 36px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0">
    <strong><a href="${esc(siteBaseUrl)}" style="color:#0a2f66;text-decoration:none">Umzila</a></strong> &mdash; Durban&rsquo;s best local businesses
  </div>
</div>
</body>
</html>`;
}

// The private tracking link (works without an account — guests, or buyers
// who signed up after ordering): deliveries.tracking_token.
function trackCta(siteBaseUrl, orderId, label, token) {
  return `<div style="text-align:center;margin:28px 0 8px">
      <a href="${esc(siteBaseUrl)}/track.html?order=${esc(orderId)}${token ? '&amp;t=' + esc(token) : ''}" style="display:inline-block;background:#0a2f66;color:#fff;padding:14px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px">${esc(label || 'Track your order')}</a>
    </div>`;
}

function pinBlock(pin) {
  if (!pin) return '';
  return `<div style="background:#f8faff;border-radius:10px;padding:14px 18px;margin:20px 0;text-align:center">
      <div style="font-size:12px;color:#6b7280;margin-bottom:4px">Your delivery PIN</div>
      <div style="font-size:26px;font-weight:800;letter-spacing:4px;color:#0a2f66">${esc(pin)}</div>
    </div>`;
}

// Plan §58/59 tone: fresh/warm, not "Order dispatched" / "Delivery successful".
const P = (html) => `<p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 8px">${html}</p>`;
const SMALL = (html) => `<p style="color:#6b7280;font-size:13px;line-height:1.6;margin:12px 0 0">${html}</p>`;
function vehicleLine(ctx) {
  return ctx.vehicle ? SMALL(`Look out for: <strong>${esc(ctx.vehicle)}</strong>`) : '';
}

// ctx (loaded by loadContext): rider first name, store names, drops before this one, vehicle.
function buildEmailContent(eventType, order, delivery, siteBaseUrl, ctx = {}) {
  const orderRef = order.order_number || String(order.id).slice(0, 8).toUpperCase();
  const hi = ctx.firstName ? `Hi ${esc(ctx.firstName)}, ` : '';
  const rider = ctx.riderName ? esc(ctx.riderName) : 'Your rider';
  const riderLc = ctx.riderName ? esc(ctx.riderName) : 'your rider';
  const stores = ctx.stores && ctx.stores.length ? esc(ctx.stores.join(' & ')) : 'the store';
  const track = (label) => trackCta(siteBaseUrl, order.id, label || 'Track your order', delivery.tracking_token);

  if (eventType === 'ASSIGNED') {
    return {
      subject: `${ctx.riderName ? ctx.riderName + ' is' : 'A rider is'} collecting your Umzila order`,
      html: emailShell(siteBaseUrl, 'A rider has your order 🛵',
        P(`${hi}${rider} has accepted order <strong>#${esc(orderRef)}</strong> and is heading to <strong>${stores}</strong> to collect it.`) +
        SMALL("We'll email you again the moment it's collected, when the rider is close, and when they're at your door."),
        track('Follow your order'))
    };
  }
  if (eventType === 'PICKED_UP') {
    const ahead = ctx.dropsAhead || 0;
    return {
      subject: ahead ? `${ctx.riderName || 'Your rider'} has collected your order` : `${ctx.riderName || 'Your rider'} has your order and is on the way 🛵`,
      html: emailShell(siteBaseUrl, ahead ? 'Collected ✓' : "It's on the way! 🛵",
        P(`${hi}${rider} has collected order <strong>#${esc(orderRef)}</strong> from ${stores}.`) +
        P(ahead
          ? `They have <strong>${ahead} other drop${ahead > 1 ? 's' : ''}</strong> nearby first — we'll email you when they're heading to you.`
          : "They're heading straight to you now.") +
        pinBlock(delivery.delivery_pin) +
        SMALL('Give this PIN to the rider when they arrive — it confirms the delivery.'),
        track('Track your order'))
    };
  }
  if (eventType === 'IN_ROUTE') {
    return {
      subject: "You're next — your Umzila rider is heading to you",
      html: emailShell(siteBaseUrl, "You're next! 🛵",
        P(`${hi}${rider} is now heading to you with order <strong>#${esc(orderRef)}</strong>.`) + pinBlock(delivery.delivery_pin),
        track('Watch them on the map'))
    };
  }
  if (eventType === 'NEARBY') {
    return {
      subject: `${ctx.riderName || 'Your rider'} is a few minutes away 🛵`,
      html: emailShell(siteBaseUrl, 'Almost there — get ready 👋',
        P(`${hi}${riderLc} is a few minutes away with order <strong>#${esc(orderRef)}</strong>. Please head to the gate or door and have your PIN ready.`) +
        pinBlock(delivery.delivery_pin) + vehicleLine(ctx),
        track('See where they are'))
    };
  }
  if (eventType === 'ARRIVING') {
    return {
      subject: `${ctx.riderName || 'Your rider'} is outside 📍`,
      html: emailShell(siteBaseUrl, 'Your rider is here 📍',
        P(`${hi}${riderLc} has arrived with order <strong>#${esc(orderRef)}</strong>. Please meet them at the gate or door and give them your PIN.`) +
        pinBlock(delivery.delivery_pin) + vehicleLine(ctx) +
        SMALL(`Can't find them? <a href="https://wa.me/${UMZILA_WA}?text=${encodeURIComponent('Hi Umzila! My rider for order #' + orderRef + ' is here but we can’t find each other.')}" style="color:#0a2f66;font-weight:700">WhatsApp us</a> and we'll connect you.`),
        '')
    };
  }
  if (eventType === 'DELIVERED') {
    return {
      subject: 'Delivered! Your Umzila order has arrived',
      html: emailShell(siteBaseUrl, "You're all set ✓",
        P(`${hi}order <strong>#${esc(orderRef)}</strong> has been delivered. Enjoy, and thanks for ordering with Umzila!`) +
        SMALL("We'll send a quick 1-tap rating in a few minutes — it really helps us get better."),
        '')
    };
  }
  if (eventType === 'FAILED') {
    return {
      subject: 'There was an issue with your delivery',
      html: emailShell(siteBaseUrl, 'We hit a snag',
        `<p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 8px">We're sorry — your order <strong>#${esc(orderRef)}</strong> could not be delivered as planned. Our team has been notified.</p><p style="color:#555;font-size:13px;line-height:1.6">If you have questions, reach us on WhatsApp and we'll sort it out.</p>`,
        `<div style="text-align:center;margin:24px 0 8px"><a href="https://wa.me/${UMZILA_WA}?text=${encodeURIComponent('Hi Umzila! My order #' + orderRef + " delivery didn't go through, can you help?")}" style="display:inline-block;background:#25d366;color:#fff;padding:14px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px">Message us on WhatsApp</a></div>`)
    };
  }
  if (eventType === 'CANCELLED') {
    return {
      subject: 'Your Umzila delivery was cancelled',
      html: emailShell(siteBaseUrl, 'Delivery cancelled',
        `<p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 8px">The delivery for order <strong>#${esc(orderRef)}</strong> has been cancelled. If you weren't expecting this, please reach out and we'll help sort it out.</p>`,
        '')
    };
  }
  return null;
}

// Rider first name (profiles via drivers), the stores on the order (house drinks seller left
// out), how many other drops come before this one on the trip, and — only from "almost there"
// on, like get_delivery_vehicle — the rider's vehicle. Every part is optional.
async function loadContext(supabase, delivery, order, eventType) {
  const ctx = { firstName: null, riderName: null, stores: [], dropsAhead: 0, vehicle: null };
  try {
    ctx.firstName = (String(order.customer_name || '').trim().split(/\s+/)[0] || '').replace(/^./, c => c.toUpperCase()) || null;
    const sellerIds = [...new Set((Array.isArray(order.items) ? order.items : []).map(i => i && i.seller_id).filter(Boolean))];
    if (sellerIds.length) {
      const { data: ss } = await supabase.from('sellers').select('shop_name, is_house').in('id', sellerIds);
      ctx.stores = (ss || []).filter(x => !x.is_house && x.shop_name).map(x => x.shop_name);
    }
    let driverId = null;
    if (delivery.route_id) {
      const [{ data: route }, { data: stops }] = await Promise.all([
        supabase.from('routes').select('driver_id').eq('id', delivery.route_id).maybeSingle(),
        supabase.from('route_stops').select('delivery_id, stop_type, status, seq_order').eq('route_id', delivery.route_id)
      ]);
      const mine = (stops || []).find(x => x.stop_type === 'drop' && x.delivery_id === delivery.id);
      if (mine) ctx.dropsAhead = (stops || []).filter(x => x.stop_type === 'drop' && x.delivery_id !== delivery.id && x.status !== 'completed' && x.seq_order < mine.seq_order).length;
      driverId = route && route.driver_id;
    }
    if (!driverId) { // ASSIGNED fires before the trip is saved: the accepted offer says who
      const { data: off } = await supabase.from('driver_offers').select('driver_id').eq('delivery_id', delivery.id)
        .eq('status', 'accepted').order('responded_at', { ascending: false }).limit(1).maybeSingle();
      driverId = off && off.driver_id;
    }
    if (driverId) {
      const { data: dr } = await supabase.from('drivers').select('user_id, vehicle_description').eq('id', driverId).maybeSingle();
      if (dr && dr.user_id) {
        const { data: pr } = await supabase.from('profiles').select('first_name').eq('user_id', dr.user_id).maybeSingle();
        const n = pr && String(pr.first_name || '').trim();
        if (n) ctx.riderName = n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
      }
      if (dr && ['NEARBY', 'ARRIVING'].includes(eventType)) ctx.vehicle = String(dr.vehicle_description || '').trim() || null;
    }
  } catch (e) { console.warn('notify: context load failed (email still goes)', e.message); }
  return ctx;
}

// notify(supabase, deliveryId, eventType, actor)
// `supabase` must be a service-role client (notification_log has no client
// write policy). Never throws -- returns { skipped: true, reason } or
// { skipped: false, status: 'sent'|'failed' } for callers that want to log it.
async function notify(supabase, deliveryId, eventType) {
  if (!NOTIFIABLE_EVENTS.has(eventType)) return { skipped: true, reason: 'not_notifiable' };

  const RESEND_KEY = process.env.RESEND_API_KEY || '';
  const SITE_BASE_URL = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');
  if (!RESEND_KEY) { console.warn('notify: RESEND_API_KEY not set — skipping', eventType, deliveryId); return { skipped: true, reason: 'no_resend_key' }; }

  try {
    const { data: delivery, error: deliveryError } = await supabase
      .from('deliveries')
      .select('id, order_id, delivery_pin, customer_id, tracking_token, route_id')
      .eq('id', deliveryId)
      .maybeSingle();
    if (deliveryError || !delivery) return { skipped: true, reason: 'delivery_not_found' };

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, order_number, customer_email, customer_name, items')
      .eq('id', delivery.order_id)
      .maybeSingle();
    if (orderError || !order || !order.customer_email) return { skipped: true, reason: 'no_customer_email' };

    // Dedup (plan §111) -- best-effort pre-check; the unique index on
    // notification_log is the real guarantee if two calls ever race.
    const { data: existing } = await supabase
      .from('notification_log')
      .select('id')
      .eq('delivery_id', deliveryId)
      .eq('event_type', eventType)
      .eq('channel', 'email')
      .maybeSingle();
    if (existing) return { skipped: true, reason: 'already_sent' };

    // "You're next" only makes sense on a shared trip: right after the collected email it would
    // just say the same thing again.
    if (eventType === 'IN_ROUTE') {
      const { data: pu } = await supabase.from('notification_log').select('created_at')
        .eq('delivery_id', deliveryId).eq('event_type', 'PICKED_UP').eq('channel', 'email').maybeSingle();
      if (pu && Date.now() - new Date(pu.created_at).getTime() < IN_ROUTE_AFTER_PICKUP_MIN * 60000) return { skipped: true, reason: 'just_collected' };
    }

    const ctx = await loadContext(supabase, delivery, order, eventType);
    const content = buildEmailContent(eventType, order, delivery, SITE_BASE_URL, ctx);
    if (!content) return { skipped: true, reason: 'no_template' };

    let sendStatus = 'sent';
    let providerMessageId = null;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...mailFrom('Umzila', 'orders'), to: [order.customer_email], subject: content.subject, html: content.html })
      });
      if (!res.ok) {
        sendStatus = 'failed';
        console.warn('notify: Resend error', eventType, deliveryId, res.status, await res.text().catch(() => ''));
      } else {
        const json = await res.json().catch(() => ({}));
        providerMessageId = json.id || null;
      }
    } catch (sendErr) {
      sendStatus = 'failed';
      console.warn('notify: Resend request threw', eventType, deliveryId, sendErr.message);
    }

    // Insert may violate the dedup unique index on a genuine race (two
    // transitions to the same event landing concurrently) -- that's exactly
    // what the index is for; swallow it rather than treating it as a bug.
    const { error: logError } = await supabase.from('notification_log').insert({
      delivery_id: deliveryId,
      order_id: delivery.order_id,
      recipient_id: delivery.customer_id,
      event_type: eventType,
      channel: 'email',
      status: sendStatus,
      provider_message_id: providerMessageId,
      sent_at: sendStatus === 'sent' ? new Date().toISOString() : null
    });
    if (logError) console.warn('notify: failed to log notification attempt (send itself already completed):', logError.message);

    return { skipped: false, status: sendStatus };
  } catch (e) {
    console.warn('notify: unexpected error', eventType, deliveryId, e.message);
    return { skipped: true, reason: 'unexpected_error' };
  }
}

module.exports = { notify, NOTIFIABLE_EVENTS, emailShell, esc, buildEmailContent };
