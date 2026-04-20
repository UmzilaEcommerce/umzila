// netlify/functions/notify-seller-application.js
// Called by the frontend after a successful seller_applications insert.
// Sends a notification email to the admin (ADMIN_NOTIFY_EMAIL env var,
// defaults to umzilaecommerce@gmail.com) via Resend.
// No auth required — this is a one-way notification with no sensitive writes.

module.exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const RESEND_KEY    = process.env.RESEND_API_KEY || '';
  const ADMIN_EMAIL   = process.env.ADMIN_NOTIFY_EMAIL || 'umzilaecommerce@gmail.com';
  const SITE_BASE_URL = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');

  if (!RESEND_KEY) {
    console.warn('notify-seller-application: RESEND_API_KEY not set — skipping email');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: true }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { full_name, email, phone, shop_name, category, location, delivery_method } = body;

  const adminLink = `${SITE_BASE_URL}/admin.html`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif}
  .wrap{max-width:560px;margin:36px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.09)}
  .hdr{background:#0a2f66;padding:28px 36px;text-align:center}
  .hdr h1{color:#fff;margin:0 0 4px;font-size:20px;font-weight:700}
  .hdr p{color:rgba(255,255,255,0.7);margin:0;font-size:13px}
  .bd{padding:32px 36px}
  .bd h2{color:#0a2f66;margin:0 0 18px;font-size:18px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  td{padding:10px 12px;border-bottom:1px solid #f0f0f5;color:#333;vertical-align:top}
  td:first-child{width:38%;font-weight:600;color:#555;white-space:nowrap}
  .cta{text-align:center;margin:28px 0 8px}
  .btn{display:inline-block;background:#e0284f;color:#fff;padding:13px 32px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px}
  .ft{background:#f4f6fb;padding:16px 36px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0}
  .ft a{color:#0a2f66;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>New Seller Application</h1>
    <p>Someone wants to sell on Umzila</p>
  </div>
  <div class="bd">
    <h2>Application details</h2>
    <table>
      <tr><td>Name</td><td>${esc(full_name)}</td></tr>
      <tr><td>Email</td><td><a href="mailto:${esc(email)}" style="color:#0a2f66">${esc(email)}</a></td></tr>
      <tr><td>Phone</td><td>${esc(phone)}</td></tr>
      <tr><td>Shop Name</td><td>${esc(shop_name)}</td></tr>
      <tr><td>Category</td><td>${esc(category)}</td></tr>
      <tr><td>Location</td><td>${esc(location)}</td></tr>
      <tr><td>Delivery</td><td>${esc(delivery_method)}</td></tr>
    </table>
    <div class="cta">
      <a href="${esc(adminLink)}" class="btn">Review in Admin &rarr;</a>
    </div>
  </div>
  <div class="ft">
    <a href="${esc(adminLink)}">Umzila Admin</a> &mdash; campus marketplace
  </div>
</div>
</body>
</html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Umzila <noreply@umzila.store>',
        to: [ADMIN_EMAIL],
        subject: `New seller application — ${shop_name || 'unknown shop'}`,
        html
      })
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error('notify-seller-application: Resend error', res.status, txt);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, emailError: true }) };
    }

    console.log('notify-seller-application: email sent for', shop_name);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('notify-seller-application: fetch error', err);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, emailError: true }) };
  }
};

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
