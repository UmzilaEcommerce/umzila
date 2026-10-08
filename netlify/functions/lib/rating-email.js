// Post-delivery "rate your order" email: five star boxes, each a link to
// rate-delivery.js (?d=<delivery id>&t=<tracking token>&r=<1-5>), which saves
// the rating and asks "what went wrong?" for 3 stars or fewer. Plain, order-
// style layout from the transactional sender (mail.umzila.store).
const { mailFrom } = require('./mail');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ratingUrl(siteUrl, deliveryId, token, r) {
  const base = String(siteUrl || '').replace(/\/$/, '');
  return `${base}/.netlify/functions/rate-delivery?d=${encodeURIComponent(deliveryId)}&t=${encodeURIComponent(token)}&r=${r}`;
}

// { siteUrl, deliveryId, token, customerName, storeName, itemsText }
function buildRatingEmail(o) {
  const first = String(o.customerName || '').trim().split(/\s+/)[0] || 'there';
  const store = o.storeName || 'Umzila';
  const cell = r => `<td align="center" style="padding:0 3px">
      <a href="${esc(ratingUrl(o.siteUrl, o.deliveryId, o.token, r))}" style="display:block;width:52px;padding:10px 0 8px;border:1.5px solid #e5e7eb;border-radius:12px;text-decoration:none;background:#fffbeb">
        <span style="display:block;font-size:26px;line-height:1;color:#f59e0b">★</span>
        <span style="display:block;font-size:12px;font-weight:700;color:#374151;margin-top:4px">${r}</span>
      </a></td>`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:24px 20px;color:#222">
  <p style="margin:0 0 14px;font-size:15px;line-height:1.6">Hi ${esc(first)},</p>
  <p style="margin:0 0 14px;font-size:15px;line-height:1.6">Your <b>${esc(store)}</b> order${o.itemsText ? ' (' + esc(o.itemsText) + ')' : ''} was delivered. How was it?</p>
  <p style="margin:0 0 10px;font-size:14px;color:#555">Tap a star to rate — 1 is poor, 5 is excellent:</p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px"><tr>${[1, 2, 3, 4, 5].map(cell).join('')}</tr></table>
  <p style="margin:14px 0;font-size:13.5px;line-height:1.6;color:#555">If something wasn't right, tell us after you tap — we read every message and use it to improve deliveries.</p>
  <p style="margin:0;font-size:15px;line-height:1.6">Thank you for ordering with Umzila,<br>Umzila</p>
</div></body></html>`;
  const text = `Hi ${first},\n\nYour ${store} order${o.itemsText ? ' (' + o.itemsText + ')' : ''} was delivered. How was it?\n\nTap to rate (1 = poor, 5 = excellent):\n` +
    [1, 2, 3, 4, 5].map(r => `${r} star${r > 1 ? 's' : ''}: ${ratingUrl(o.siteUrl, o.deliveryId, o.token, r)}`).join('\n') +
    `\n\nIf something wasn't right, tell us after you tap.\n\nThank you for ordering with Umzila,\nUmzila`;
  return { ...mailFrom('Umzila', 'orders'), subject: `How was your ${store} order?`, html, text };
}

module.exports = { buildRatingEmail, ratingUrl };
