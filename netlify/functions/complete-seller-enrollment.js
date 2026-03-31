// netlify/functions/complete-seller-enrollment.js
// Called by checkout-success.html after a successful seller enrollment payment.
// Auth user + profile + sellers row were already created by initiate-seller-enrollment.js
// before payment. This function only needs to:
//   1. Verify the order is marked paid (by payfast-itn.js)
//   2. Activate the sellers row (status → 'active')
//   3. Mark the seller_applications row as 'completed'
//   4. Send the welcome email
const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const SUPABASE_URL  = process.env.SUPABASE_URL || '';
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const RESEND_KEY    = process.env.RESEND_API_KEY || '';
  const SITE_BASE_URL = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('complete-seller-enrollment: missing env vars');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { pf_payment_id, m_payment_id, email, name, applicationId } = body;

  if ((!pf_payment_id && !m_payment_id) || !email || !applicationId) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'pf_payment_id (or m_payment_id), email, and applicationId are required' })
    };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // 1. Find the order row — check if already paid, or mark it paid now using pf_payment_id.
  //    The ITN (payfast-itn.js) is the primary payment confirmer, but if it is delayed or
  //    the signature fails, we use pf_payment_id (present in PayFast's return URL) as
  //    evidence of payment and update the order ourselves.
  let order = null;

  // Look up by m_payment_id first (most reliable — we created this value)
  if (m_payment_id) {
    const { data, error } = await admin
      .from('orders')
      .select('id, order_status, payment_status')
      .eq('m_payment_id', m_payment_id)
      .maybeSingle();
    if (error) {
      console.error('complete-seller-enrollment: m_payment_id query error', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to verify payment' }) };
    }
    if (data) {
      if (data.order_status === 'paid' || data.payment_status === 'paid') {
        // Already paid (ITN fired)
        order = data;
      } else if (pf_payment_id && data.order_status !== 'cancelled') {
        // Not yet paid but we have a pf_payment_id from the PayFast return URL —
        // update the order to paid now (ITN fallback)
        const { error: updateErr } = await admin
          .from('orders')
          .update({
            order_status:   'paid',
            payment_status: 'paid',
            pf_payment_id,
            paid_at:        new Date().toISOString()
          })
          .eq('id', data.id);
        if (updateErr) {
          console.error('complete-seller-enrollment: order update error', updateErr);
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update order status' }) };
        }
        console.log('complete-seller-enrollment: order marked paid via pf_payment_id fallback', m_payment_id);
        order = { ...data, order_status: 'paid', payment_status: 'paid' };
      }
    }
  }

  // Fallback: look up by pf_payment_id (in case m_payment_id wasn't in URL)
  if (!order && pf_payment_id) {
    const { data, error } = await admin
      .from('orders')
      .select('id, order_status, payment_status')
      .eq('pf_payment_id', pf_payment_id)
      .maybeSingle();
    if (error) {
      console.error('complete-seller-enrollment: pf_payment_id query error', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to verify payment' }) };
    }
    if (data && (data.order_status === 'paid' || data.payment_status === 'paid')) {
      order = data;
    }
  }

  if (!order) {
    return {
      statusCode: 402,
      headers,
      body: JSON.stringify({ error: 'Payment not yet confirmed. Please wait a moment and try again, or contact support.' })
    };
  }

  // 2. Load application
  const { data: app, error: appQueryErr } = await admin
    .from('seller_applications')
    .select('id, status, shop_name')
    .eq('id', applicationId)
    .maybeSingle();

  if (appQueryErr) {
    console.error('complete-seller-enrollment: application query error', appQueryErr);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load application' }) };
  }
  if (!app) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Seller application not found' }) };
  }

  // 3. Get the seller's user_id from profiles
  const { data: profileRow, error: profileQueryErr } = await admin
    .from('profiles')
    .select('user_id, first_name, last_name')
    .eq('email', email)
    .maybeSingle();

  if (profileQueryErr) {
    console.error('complete-seller-enrollment: profile query error', profileQueryErr);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to look up seller profile' }) };
  }

  const userId = profileRow?.user_id || null;

  if (!userId) {
    console.error('complete-seller-enrollment: no profile found for email', email);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Seller account not found. Please contact support.' }) };
  }

  // 4. Activate the sellers row (always — idempotent update)
  const { error: sellerUpdateErr } = await admin
    .from('sellers')
    .update({ status: 'active' })
    .eq('user_id', userId);

  if (sellerUpdateErr) {
    console.error('complete-seller-enrollment: seller activate error', sellerUpdateErr);
  } else {
    console.log('complete-seller-enrollment: sellers row activated for user_id', userId);
  }

  // 5. Mark application as completed (skip if already done — but still send email below)
  const alreadyCompleted = app.status === 'completed';
  if (!alreadyCompleted) {
    const { error: appUpdateErr } = await admin
      .from('seller_applications')
      .update({ status: 'completed' })
      .eq('id', applicationId);
    if (appUpdateErr) {
      console.error('complete-seller-enrollment: application update error', appUpdateErr);
    }
  }

  // 6. Send welcome email — always attempt, even if application was already 'completed'.
  //    This covers cases where the user manually set everything in Supabase and email was
  //    never sent (e.g. ITN fallback path or manual data entry during testing).
  if (RESEND_KEY) {
    try {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Umzila Sellers <sellers@umzila.store>',
          to: [email],
          subject: "You're officially an Umzila seller!",
          html: buildWelcomeEmail(
            name || [profileRow?.first_name, profileRow?.last_name].filter(Boolean).join(' ') || email,
            email, app.shop_name || '', SITE_BASE_URL
          )
        })
      });
      if (!emailRes.ok) {
        const errText = await emailRes.text();
        console.error('complete-seller-enrollment: Resend welcome email error', emailRes.status, errText);
      } else {
        console.log('complete-seller-enrollment: welcome email sent to', email);
      }
    } catch (emailErr) {
      console.error('complete-seller-enrollment: failed to send welcome email', emailErr);
    }
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

function buildWelcomeEmail(name, email, shopName, siteUrl) {
  const site = siteUrl || '';
  const firstName = name.trim().split(/\s+/)[0] || name;
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
  .badge{display:inline-block;background:#e0284f;color:#fff;font-size:12px;font-weight:700;padding:4px 12px;border-radius:999px;margin-top:12px;letter-spacing:.5px}
  .bd{padding:36px 40px}
  .bd h2{color:#0a2f66;margin:0 0 14px;font-size:20px}
  .bd p{color:#444;line-height:1.7;margin:0 0 16px;font-size:15px}
  .cta{text-align:center;margin:28px 0 24px}
  .btn{display:inline-block;background:#e0284f;color:#fff;padding:15px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:16px}
  .info-box{background:#f0f4ff;border-radius:10px;padding:20px 24px;margin:24px 0}
  .info-box h3{color:#0a2f66;margin:0 0 14px;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  .info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e0e7f7;font-size:14px}
  .info-row:last-child{border-bottom:none;padding-bottom:0}
  .info-row .label{color:#666;font-weight:600}
  .info-row .val{color:#0a2f66;font-weight:700}
  .steps-box{background:#fff8f0;border:1px solid #ffe0b2;border-radius:10px;padding:20px 24px;margin:20px 0}
  .steps-box h3{color:#e65100;margin:0 0 12px;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  .steps-box ol{margin:0;padding-left:20px;color:#333;font-size:14px}
  .steps-box li{margin-bottom:10px;line-height:1.6}
  .note{font-size:13px;color:#888;line-height:1.6;background:#f9f9f9;border-radius:8px;padding:14px 18px;margin:20px 0}
  .ft{background:#f4f6fb;padding:20px 40px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0}
  .ft a{color:#0a2f66;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>Umzila Sellers</h1>
    <p>Your seller account is now active</p>
    <span class="badge">OFFICIAL SELLER</span>
  </div>
  <div class="bd">
    <h2>Welcome aboard, ${esc(firstName)}! 🎉</h2>
    <p>Your payment was confirmed and your seller account for <strong>${esc(shopName || 'your shop')}</strong> is now fully activated. You are officially an Umzila seller — congratulations!</p>

    <div class="cta">
      <a href="${site}/seller-dashboard.html" class="btn">Go to Seller Dashboard &rarr;</a>
    </div>

    <div class="info-box">
      <h3>Your login details</h3>
      <div class="info-row"><span class="label">Email</span><span class="val">${esc(email)}</span></div>
      <div class="info-row"><span class="label">Password</span><span class="val">The password you created before payment</span></div>
    </div>

    <div class="steps-box">
      <h3>Your next steps</h3>
      <ol>
        <li>Log in to your <a href="${site}/seller-dashboard.html" style="color:#e65100;font-weight:600">Seller Dashboard</a> using your email and password above</li>
        <li>Finish setting up your store — add a shop description, logo, and contact details</li>
        <li>Create your first product and start selling</li>
      </ol>
    </div>

    <div class="note">
      <strong>How to log in next time:</strong><br>
      Go to <a href="${site}" style="color:#0a2f66">umzila.store</a> &rarr; click <strong>About</strong> &rarr; select <strong>Sign In</strong> &rarr; enter your email and password &rarr; choose <strong>Seller Dashboard</strong> to get straight back in.
    </div>

    <p style="font-size:14px;color:#888">If you have any questions or need help setting up, reply to this email or contact us at <a href="mailto:support@umzila.store" style="color:#0a2f66">support@umzila.store</a>.</p>
  </div>
  <div class="ft">
    <strong><a href="${site}">Umzila</a></strong> &mdash; campus marketplace<br>
    <a href="mailto:sellers@umzila.store">sellers@umzila.store</a>
  </div>
</div>
</body>
</html>`;
}
