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

const NOTIFIABLE_EVENTS = new Set(['IN_ROUTE', 'ARRIVING', 'DELIVERED', 'FAILED', 'CANCELLED']);

const UMZILA_WA = '27797662768'; // same support WhatsApp number used elsewhere (profile.html)

function esc(s) {
  return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Shared visual chrome -- same header/body-card/footer structure already
// used by send-on-the-way.js and send-referral-email.js, pulled out here so
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
    <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-top:4px">campus marketplace</div>
  </div>
  <div style="padding:32px 36px">
    <h2 style="color:#0a2f66;margin:0 0 12px;font-size:22px">${headline}</h2>
    ${bodyHtml}
    ${ctaHtml || ''}
  </div>
  <div style="background:#f4f6fb;padding:16px 36px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0">
    <strong><a href="${esc(siteBaseUrl)}" style="color:#0a2f66;text-decoration:none">Umzila</a></strong> &mdash; campus marketplace
  </div>
</div>
</body>
</html>`;
}

function trackCta(siteBaseUrl, orderId, label) {
  return `<div style="text-align:center;margin:28px 0 8px">
      <a href="${esc(siteBaseUrl)}/track.html?order=${esc(orderId)}" style="display:inline-block;background:#0a2f66;color:#fff;padding:14px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px">${esc(label || 'Track your order')}</a>
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
function buildEmailContent(eventType, order, delivery, siteBaseUrl) {
  const orderRef = order.order_number || String(order.id).slice(0, 8).toUpperCase();

  if (eventType === 'IN_ROUTE') {
    return {
      subject: 'Your Umzila order is on the way',
      html: emailShell(siteBaseUrl, "You're on your way! 🛵",
        `<p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 8px">Your order <strong>#${esc(orderRef)}</strong> has been collected and is now on its way to you.</p>${pinBlock(delivery.delivery_pin)}<p style="color:#555;font-size:13px;line-height:1.6">When your driver arrives, please provide the PIN above so they can confirm the delivery.</p>`,
        trackCta(siteBaseUrl, order.id, 'Track your order'))
    };
  }
  if (eventType === 'ARRIVING') {
    return {
      subject: 'Your rider is almost there!',
      html: emailShell(siteBaseUrl, "You're up next 👋",
        `<p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 8px">Your Umzila rider is arriving now with order <strong>#${esc(orderRef)}</strong>.</p>${pinBlock(delivery.delivery_pin)}`,
        trackCta(siteBaseUrl, order.id, 'Track your order'))
    };
  }
  if (eventType === 'DELIVERED') {
    return {
      subject: 'Delivered! Your Umzila order has arrived',
      html: emailShell(siteBaseUrl, "You're all set ✓",
        `<p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 8px">Order <strong>#${esc(orderRef)}</strong> has been delivered. Thanks for shopping with Umzila!</p>`,
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
      .select('id, order_id, delivery_pin, customer_id')
      .eq('id', deliveryId)
      .maybeSingle();
    if (deliveryError || !delivery) return { skipped: true, reason: 'delivery_not_found' };

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, order_number, customer_email')
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

    const content = buildEmailContent(eventType, order, delivery, SITE_BASE_URL);
    if (!content) return { skipped: true, reason: 'no_template' };

    let sendStatus = 'sent';
    let providerMessageId = null;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Umzila <orders@umzila.store>', to: [order.customer_email], subject: content.subject, html: content.html })
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

module.exports = { notify, NOTIFIABLE_EVENTS, emailShell, esc };
