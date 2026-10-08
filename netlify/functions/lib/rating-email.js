// Post-delivery "rate your order" email — sent ~10 min after delivery by
// send-rating-requests.js (scheduled). Five star boxes, each a link to
// rate-delivery.js (?d=<delivery id>&t=<tracking token>&r=<1-5>), which saves
// the rating and asks "what went wrong?" for 3 stars or fewer.
// Transactional design from mail.umzila.store: a receipt-style card (store,
// items, delivered time, order ref), no promo language or hero images, so it
// reads as an order email and stays in the main inbox.
const { mailFrom } = require('./mail');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ratingUrl(siteUrl, deliveryId, token, r) {
  const base = String(siteUrl || '').replace(/\/$/, '');
  return `${base}/.netlify/functions/rate-delivery?d=${encodeURIComponent(deliveryId)}&t=${encodeURIComponent(token)}&r=${r}`;
}

// { siteUrl, deliveryId, token, customerName, storeName, items:[{name, qty}],
//   deliveredAt (Date|string), orderRef }
function buildRatingEmail(o) {
  const first = String(o.customerName || '').trim().split(/\s+/)[0] || 'there';
  const store = o.storeName || 'your store';
  const items = Array.isArray(o.items) ? o.items : [];
  const when = o.deliveredAt ? new Intl.DateTimeFormat('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(o.deliveredAt)) : '';
  const navy = '#0a2f66', ink = '#111827', muted = '#6b7280', line = '#e5e7eb';
  const star = r => `<td align="center" width="20%" style="padding:0 4px">
      <a href="${esc(ratingUrl(o.siteUrl, o.deliveryId, o.token, r))}" style="display:block;padding:12px 0 10px;border:1px solid ${line};border-radius:10px;background:#ffffff;text-decoration:none">
        <span style="display:block;font-size:24px;line-height:1;color:#f5a623">&#9733;</span>
        <span style="display:block;font-size:13px;font-weight:600;color:${ink};margin-top:6px">${r}</span>
      </a></td>`;
  const itemRows = items.slice(0, 8).map(it => `<tr>
      <td style="padding:6px 0;font-size:14px;color:${ink}">${esc(it.name)}</td>
      <td align="right" style="padding:6px 0;font-size:14px;color:${muted};white-space:nowrap">&times; ${esc(it.qty || 1)}</td></tr>`).join('');

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">
<title>How was your ${esc(store)} order?</title></head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Your ${esc(store)} order was delivered — tap a star to rate it.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8"><tr><td align="center" style="padding:28px 14px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    <tr><td style="padding:0 4px 16px;font-size:20px;font-weight:800;letter-spacing:-.3px;color:${navy}">umzila</td></tr>
    <tr><td style="background:#ffffff;border:1px solid ${line};border-radius:14px;padding:28px 26px">
      <p style="margin:0 0 6px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#16a34a">&#10003; Delivered${when ? ' &middot; ' + esc(when) : ''}</p>
      <h1 style="margin:0 0 10px;font-size:22px;line-height:1.3;color:${ink};font-weight:700">How was your order, ${esc(first)}?</h1>
      <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#374151">Your rating helps ${esc(store)} and our delivery team keep getting better. It takes one tap.</p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 6px"><tr>${[1, 2, 3, 4, 5].map(star).join('')}</tr></table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px"><tr>
        <td style="font-size:12px;color:${muted};padding:2px 4px">Poor</td><td align="right" style="font-size:12px;color:${muted};padding:2px 4px">Excellent</td></tr></table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${line}">
        <tr><td colspan="2" style="padding:16px 0 4px;font-size:13px;font-weight:600;color:${muted};text-transform:uppercase;letter-spacing:.04em">${esc(store)}</td></tr>
        ${itemRows}
        ${o.orderRef ? `<tr><td colspan="2" style="padding:12px 0 0;font-size:12px;color:${muted}">Order ${esc(o.orderRef)}</td></tr>` : ''}
      </table>
    </td></tr>
    <tr><td style="padding:16px 6px 0;font-size:12px;line-height:1.6;color:${muted}">
      Something not right? Reply to this email or tap a low rating and tell us — we read every message.<br>
      You're receiving this because you placed an order on Umzila.
    </td></tr>
  </table>
</td></tr></table></body></html>`;

  const text = `Hi ${first},\n\nYour ${store} order was delivered${when ? ' (' + when + ')' : ''}. How was it?\n\nRate it (1 = poor, 5 = excellent):\n` +
    [1, 2, 3, 4, 5].map(r => `${r}: ${ratingUrl(o.siteUrl, o.deliveryId, o.token, r)}`).join('\n') +
    `\n\n${items.map(i => `${i.name} x ${i.qty || 1}`).join('\n')}${o.orderRef ? '\nOrder ' + o.orderRef : ''}\n\nSomething not right? Reply to this email.\n\nUmzila`;
  return { ...mailFrom('Umzila', 'orders'), subject: `How was your ${store} order?`, html, text };
}

module.exports = { buildRatingEmail, ratingUrl };
