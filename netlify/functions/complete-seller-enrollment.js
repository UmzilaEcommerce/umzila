// netlify/functions/complete-seller-enrollment.js
// Called by checkout-success.html after a successful seller enrollment payment.
// Verifies the payment was confirmed by PayFast ITN (via orders table),
// creates the seller's Supabase auth account, sets profile role to 'seller',
// and activates the sellers row.
const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
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
  const SITE_BASE_URL = (process.env.SITE_BASE_URL || '').replace(/\/$/, '');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('complete-seller-enrollment: missing env vars');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  // Accept pf_payment_id (new static-link flow) or m_payment_id (old SELLER- flow)
  const { pf_payment_id, m_payment_id, email, name, applicationId, password } = body;

  if ((!pf_payment_id && !m_payment_id) || !email || !name || !applicationId || !password) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'pf_payment_id (or m_payment_id), email, name, applicationId, and password are required' })
    };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // 1. Verify payment — the ITN must have updated the order row to paid before we proceed.
  //    Primary lookup: m_payment_id (SELLER- prefixed, created by initiate-seller-enrollment.js)
  //    Fallback: pf_payment_id (in case PayFast also returns it)
  let order = null;

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
    if (data && (data.order_status === 'paid' || data.payment_status === 'paid')) {
      order = data;
    }
  }

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

  // 2. Idempotency — if already processed, return success so client can redirect
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
  if (app.status === 'completed') {
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, alreadyProcessed: true }) };
  }

  // 3. Create Supabase auth user
  const { data: authData, error: authErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });

  if (authErr) {
    if (authErr.message && authErr.message.toLowerCase().includes('already registered')) {
      console.warn('complete-seller-enrollment: user already exists, continuing with existing user');
    } else {
      console.error('complete-seller-enrollment: createUser error', authErr);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create seller account: ' + authErr.message }) };
    }
  }

  // Resolve the user ID — either newly created or fetch existing
  let userId = authData && authData.user ? authData.user.id : null;

  if (!userId) {
    const { data: { users }, error: listErr } = await admin.auth.admin.listUsers();
    if (!listErr && users) {
      const existing = users.find(u => u.email === email);
      if (existing) userId = existing.id;
    }
  }

  if (!userId) {
    console.error('complete-seller-enrollment: could not resolve user ID for', email);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not resolve seller account' }) };
  }

  // 4. Upsert profile with role = 'seller'
  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts[0] || name;
  const lastName  = nameParts.slice(1).join(' ') || '';

  const { error: profileErr } = await admin
    .from('profiles')
    .upsert(
      { user_id: userId, email, first_name: firstName, last_name: lastName, role: 'seller' },
      { onConflict: 'user_id' }
    );

  if (profileErr) {
    console.error('complete-seller-enrollment: profile upsert error', profileErr);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update profile: ' + profileErr.message }) };
  }

  // 5. Mark application as completed
  const { error: appUpdateErr } = await admin
    .from('seller_applications')
    .update({ status: 'completed' })
    .eq('id', applicationId);

  if (appUpdateErr) {
    console.error('complete-seller-enrollment: application update error', appUpdateErr);
    // Non-fatal — continue to activate seller row
  }

  // 6. Find and activate the sellers row (created by approve-seller.js with user_id = null)
  if (app.shop_name) {
    const { data: sellerRow, error: sellerQueryErr } = await admin
      .from('sellers')
      .select('id')
      .eq('shop_name', app.shop_name)
      .is('user_id', null)
      .maybeSingle();

    if (!sellerQueryErr && sellerRow) {
      const { error: sellerUpdateErr } = await admin
        .from('sellers')
        .update({ user_id: userId, email, status: 'active' })
        .eq('id', sellerRow.id);

      if (sellerUpdateErr) {
        console.error('complete-seller-enrollment: seller update error', sellerUpdateErr);
      }
    } else {
      console.warn('complete-seller-enrollment: no unlinked sellers row found for shop_name', app.shop_name);
    }
  }

  // 7. Send welcome email via Resend (non-fatal)
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
          html: buildWelcomeEmail(name, email, app.shop_name || '', SITE_BASE_URL)
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
