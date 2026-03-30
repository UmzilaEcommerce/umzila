// netlify/functions/approve-seller.js
// Uses the Supabase service role key (never exposed to the browser) to:
//   1. Insert a new row into the sellers table (user_id left null; seller links it on first login)
//   2. Mark the seller_applications row as approved
//   3. Send a congratulations + enrollment link email via Resend
const { createClient } = require('@supabase/supabase-js');

module.exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const SUPABASE_URL   = process.env.SUPABASE_URL || '';
  const SERVICE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const RESEND_KEY     = process.env.RESEND_API_KEY || '';
  const SITE_BASE_URL  = (process.env.SITE_BASE_URL || '').replace(/\/$/, '');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('approve-seller: missing env vars');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { applicationId, shopName } = body;
  if (!applicationId || !shopName || !shopName.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'applicationId and shopName are required' }) };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Fetch the application so we have the applicant's email and name for the enrollment email
  const { data: app, error: fetchErr } = await admin
    .from('seller_applications')
    .select('id, full_name, email, shop_name')
    .eq('id', applicationId)
    .maybeSingle();

  if (fetchErr) {
    console.error('approve-seller: fetch application error', fetchErr);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load application: ' + fetchErr.message }) };
  }
  if (!app) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Application not found' }) };
  }

  // Insert seller row — user_id is intentionally null; the seller will claim it after payment
  const { error: sellerErr } = await admin
    .from('sellers')
    .insert({ shop_name: shopName.trim(), user_id: null });

  if (sellerErr) {
    console.error('approve-seller: insert sellers error', sellerErr);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to create seller shop: ' + sellerErr.message })
    };
  }

  // Mark application approved
  const { error: appErr } = await admin
    .from('seller_applications')
    .update({ status: 'approved', updated_at: new Date().toISOString() })
    .eq('id', applicationId);

  if (appErr) {
    console.error('approve-seller: update application error', appErr);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Seller created but failed to update application: ' + appErr.message })
    };
  }

  // Send enrollment email via Resend (non-fatal if it fails)
  if (RESEND_KEY && app.email) {
    const applicantName = app.full_name || shopName;
    const enrollmentLink = `${SITE_BASE_URL}/enroll-seller.html?applicationId=${encodeURIComponent(app.id)}&email=${encodeURIComponent(app.email)}&name=${encodeURIComponent(applicantName)}`;

    try {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Umzila <noreply@umzila.store>',
          to: [app.email],
          subject: "You've been approved to sell on Umzila!",
          html: buildApprovalEmail(applicantName, shopName.trim(), enrollmentLink, SITE_BASE_URL)
        })
      });

      if (!emailRes.ok) {
        const errText = await emailRes.text();
        console.error('approve-seller: Resend error', emailRes.status, errText);
      } else {
        console.log('approve-seller: enrollment email sent to', app.email);
      }
    } catch (emailErr) {
      console.error('approve-seller: failed to send email', emailErr);
    }
  } else if (!RESEND_KEY) {
    console.warn('approve-seller: RESEND_API_KEY not set — enrollment email not sent');
  }

  return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
};

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildApprovalEmail(name, shopName, enrollmentLink, siteUrl) {
  const site = siteUrl || '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif}
  .wrap{max-width:580px;margin:40px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.09)}
  .hdr{background:#0a2f66;padding:32px 40px;text-align:center}
  .hdr h1{color:#fff;margin:0 0 6px;font-size:22px;font-weight:700}
  .hdr p{color:rgba(255,255,255,0.75);margin:0;font-size:14px}
  .bd{padding:36px 40px}
  .bd h2{color:#0a2f66;margin:0 0 14px;font-size:20px}
  .bd p{color:#444;line-height:1.7;margin:0 0 16px;font-size:15px}
  .steps{background:#f0f4ff;border-radius:10px;padding:20px 24px;margin:24px 0}
  .steps h3{color:#0a2f66;margin:0 0 12px;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  .steps ol{margin:0;padding-left:20px;color:#333;font-size:14px}
  .steps li{margin-bottom:10px;line-height:1.6}
  .cta{text-align:center;margin:28px 0 20px}
  .btn{display:inline-block;background:#e0284f;color:#fff;padding:15px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:16px}
  .note{font-size:12px;color:#999;line-height:1.6;margin:0 0 8px}
  .ft{background:#f4f6fb;padding:20px 40px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0}
  .ft a{color:#0a2f66;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>Umzila Sellers</h1>
    <p>Your application has been approved</p>
  </div>
  <div class="bd">
    <h2>Congratulations, ${esc(name)}!</h2>
    <p>Great news — your application to sell on Umzila has been <strong>approved</strong>. Your shop <strong>${esc(shopName)}</strong> is ready to be activated.</p>
    <p>Click the button below to complete your enrollment, pay the one-time R100 activation fee, and get access to your seller dashboard.</p>

    <div class="steps">
      <h3>What happens next</h3>
      <ol>
        <li>Click the link below to open your personalised enrollment page</li>
        <li>Fill in your phone number, delivery method, and create a password</li>
        <li>Complete the R100 once-off activation payment via PayFast</li>
        <li>Log in to your seller dashboard and finish setting up your shop</li>
      </ol>
    </div>

    <div class="cta">
      <a href="${esc(enrollmentLink)}" class="btn">Complete Enrollment &rarr;</a>
    </div>

    <p class="note">This link is unique to you — it contains your application details. Do not share it with anyone.</p>
    <p class="note">If you did not apply to sell on Umzila, you can safely ignore this email.</p>
  </div>
  <div class="ft">
    <strong><a href="${esc(site)}">Umzila</a></strong> &mdash; campus marketplace<br>
    Questions? <a href="mailto:support@umzila.store">support@umzila.store</a>
  </div>
</div>
</body>
</html>`;
}
