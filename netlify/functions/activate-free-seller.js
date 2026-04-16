// netlify/functions/activate-free-seller.js
// Free enrollment flow — no PayFast involved.
// Creates auth user + profile + links sellers row, then directly activates the seller.
// Limited to the first 20 free enrollments (tracked via sellers.free_enrollment flag).
const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const FREE_SLOT_LIMIT = 20;

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
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { email, name, applicationId, password, phone, deliveryMethod, location, shopName: bodyShopName } = body;
  if (!email || !name || !applicationId || !password) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'email, name, applicationId, and password are required' }) };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // ── Check free slot availability ──────────────────────────────────────────
  const { count: usedSlots, error: countErr } = await admin
    .from('sellers')
    .select('id', { count: 'exact', head: true })
    .eq('free_enrollment', true);

  if (countErr) {
    console.error('activate-free-seller: slot count error', countErr);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to check available slots' }) };
  }

  if ((usedSlots || 0) >= FREE_SLOT_LIMIT) {
    return {
      statusCode: 409,
      headers,
      body: JSON.stringify({ error: `All ${FREE_SLOT_LIMIT} free seller spots have been claimed. Please contact us at support@umzila.store to be notified when more become available.` })
    };
  }

  // ── Step 1: Create Supabase auth user ─────────────────────────────────────
  const { data: authData, error: authErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });

  let userId = authData?.user?.id || null;

  if (authErr) {
    if (authErr.message && authErr.message.toLowerCase().includes('already registered')) {
      console.warn('activate-free-seller: user already exists, fetching existing user');
      const { data: { users }, error: listErr } = await admin.auth.admin.listUsers();
      if (!listErr && users) {
        const existing = users.find(u => u.email === email);
        if (existing) userId = existing.id;
      }
    } else {
      console.error('activate-free-seller: createUser error', authErr);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create seller account: ' + authErr.message }) };
    }
  }

  if (!userId) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not resolve seller account' }) };
  }

  // ── Step 2: Create or update profile with role='seller' ───────────────────
  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts[0] || name;
  const lastName  = nameParts.slice(1).join(' ') || '';

  const { data: existingProfile } = await admin.from('profiles')
    .select('id').eq('user_id', userId).maybeSingle();

  let profileId = existingProfile?.id || null;

  if (existingProfile) {
    await admin.from('profiles')
      .update({ email, first_name: firstName, last_name: lastName, phone: phone || null, role: 'seller' })
      .eq('user_id', userId);
  } else {
    const { data: newProfile, error: profErr } = await admin.from('profiles')
      .insert({ user_id: userId, email, first_name: firstName, last_name: lastName, phone: phone || null, role: 'seller' })
      .select('id').single();
    if (profErr) {
      console.error('activate-free-seller: profile insert error', profErr);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create profile: ' + profErr.message }) };
    }
    if (newProfile) profileId = newProfile.id;
  }

  // ── Step 3: Fetch application + link and activate sellers row ─────────────
  const { data: app } = await admin.from('seller_applications')
    .select('id, shop_name, instagram, phone, full_name')
    .eq('id', applicationId)
    .maybeSingle();

  if (!app) {
    console.warn('activate-free-seller: no application found for', applicationId);
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Application not found. Please use the link sent to your email.' }) };
  }

  const resolvedShopName = app.shop_name || bodyShopName || '';

  // Link the sellers row and activate in one update
  const { error: sellerErr, count: sellerUpdateCount } = await admin.from('sellers')
    .update({
      user_id:          userId,
      email,
      whatsapp_number:  phone || app.phone || null,
      location:         location || null,
      delivery_method:  deliveryMethod || null,
      social_instagram: app.instagram || null,
      status:           'active',
      free_enrollment:  true
    })
    .eq('application_id', applicationId)
    .is('user_id', null)
    .select('id', { count: 'exact', head: true });

  if (sellerErr) {
    console.error('activate-free-seller: sellers update error', sellerErr);
  }

  // Fallback: try by shop_name if application_id match missed
  if (!sellerErr && (sellerUpdateCount === 0)) {
    const { error: fallbackErr } = await admin.from('sellers')
      .update({
        user_id:          userId,
        email,
        whatsapp_number:  phone || app.phone || null,
        location:         location || null,
        delivery_method:  deliveryMethod || null,
        social_instagram: app.instagram || null,
        status:           'active',
        free_enrollment:  true,
        application_id:   applicationId
      })
      .eq('shop_name', resolvedShopName)
      .is('user_id', null);
    if (fallbackErr) {
      console.error('activate-free-seller: sellers fallback update error', fallbackErr);
    } else {
      console.log('activate-free-seller: sellers row linked via shop_name fallback for', resolvedShopName);
    }
  } else if (!sellerErr) {
    console.log('activate-free-seller: sellers row linked and activated via application_id', applicationId);
  }

  // ── Step 4: Mark application as completed ────────────────────────────────
  await admin.from('seller_applications')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', applicationId);

  console.log('activate-free-seller: enrollment complete for', email, '— shop:', resolvedShopName);

  // ── Step 5: Send "lucky 20" welcome email ─────────────────────────────────
  if (RESEND_KEY) {
    try {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:    'Umzila Sellers <sellers@umzila.store>',
          to:      [email],
          subject: "You're officially on Umzila — for free!",
          html:    buildFreeWelcomeEmail(firstName, email, resolvedShopName, SITE_BASE_URL, usedSlots + 1)
        })
      });
      if (!emailRes.ok) {
        console.error('activate-free-seller: Resend error', emailRes.status, await emailRes.text());
      } else {
        console.log('activate-free-seller: welcome email sent to', email);
      }
    } catch (emailErr) {
      console.error('activate-free-seller: email error', emailErr);
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

function buildFreeWelcomeEmail(firstName, email, shopName, siteUrl, slotNumber) {
  const site = siteUrl || '';
  const slot = Math.min(slotNumber || 1, 20);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif}
  .wrap{max-width:580px;margin:40px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.09)}
  .hdr{background:linear-gradient(135deg,#0a2f66 0%,#1a4f8a 100%);padding:36px 40px;text-align:center}
  .hdr h1{color:#fff;margin:0 0 6px;font-size:22px;font-weight:700}
  .hdr p{color:rgba(255,255,255,0.75);margin:0;font-size:14px}
  .badge{display:inline-block;background:#ffd700;color:#0a2f66;font-size:13px;font-weight:800;padding:6px 18px;border-radius:999px;margin-top:14px;letter-spacing:.5px}
  .bd{padding:36px 40px}
  .bd h2{color:#0a2f66;margin:0 0 14px;font-size:22px;font-weight:800}
  .bd p{color:#444;line-height:1.7;margin:0 0 16px;font-size:15px}
  .lucky-box{background:linear-gradient(135deg,#fff8e1,#fff3cd);border:2px solid #ffd700;border-radius:12px;padding:20px 24px;margin:20px 0;text-align:center}
  .lucky-box .num{font-size:48px;font-weight:900;color:#0a2f66;line-height:1}
  .lucky-box .label{font-size:14px;color:#555;margin-top:6px}
  .cta{text-align:center;margin:28px 0 24px}
  .btn{display:inline-block;background:#e0284f;color:#fff;padding:15px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:16px}
  .info-box{background:#f0f4ff;border-radius:10px;padding:20px 24px;margin:24px 0}
  .info-box h3{color:#0a2f66;margin:0 0 14px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  .info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e0e7f7;font-size:14px}
  .info-row:last-child{border-bottom:none;padding-bottom:0}
  .info-row .lbl{color:#666;font-weight:600}
  .info-row .val{color:#0a2f66;font-weight:700}
  .perks{background:#f0fff4;border:1px solid #b2dfdb;border-radius:10px;padding:20px 24px;margin:20px 0}
  .perks h3{color:#1b5e20;margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  .perks ul{margin:0;padding-left:20px;color:#333;font-size:14px}
  .perks li{margin-bottom:10px;line-height:1.6}
  .steps-box{background:#fff8f0;border:1px solid #ffe0b2;border-radius:10px;padding:20px 24px;margin:20px 0}
  .steps-box h3{color:#e65100;margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
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
    <p>You made the cut</p>
    <span class="badge">&#127881; SELLER #${slot} OF 20 FREE SPOTS</span>
  </div>
  <div class="bd">
    <h2>Welcome, ${esc(firstName)}! You're in. &#127881;</h2>
    <p>You are one of the <strong>lucky 20 people</strong> who get to sell on Umzila completely free for an entire year. No payments, no catches — just your store, live on the platform.</p>

    <div class="lucky-box">
      <div class="num">#${slot}</div>
      <div class="label">You were seller spot <strong>#${slot}</strong> out of only 20 free spots available</div>
    </div>

    <p>Your shop <strong>${esc(shopName || 'your store')}</strong> is now <strong>officially live on Umzila</strong>. Log in to your seller dashboard to set it up and start selling.</p>

    <div class="cta">
      <a href="${esc(site)}/seller-dashboard.html" class="btn">Go to Seller Dashboard &rarr;</a>
    </div>

    <div class="info-box">
      <h3>Your login details</h3>
      <div class="info-row"><span class="lbl">Email</span><span class="val">${esc(email)}</span></div>
      <div class="info-row"><span class="lbl">Password</span><span class="val">The password you created during enrollment</span></div>
      <div class="info-row"><span class="lbl">Dashboard</span><span class="val"><a href="${esc(site)}/seller-dashboard.html" style="color:#0a2f66">${esc(site)}/seller-dashboard.html</a></span></div>
    </div>

    <div class="perks">
      <h3>What you get — free for 1 year</h3>
      <ul>
        <li>Your store live on Umzila, visible to all campus shoppers</li>
        <li>Create as many stores and products as you need</li>
        <li>Full access to your seller dashboard, orders, and analytics</li>
        <li>No enrollment fee, no monthly fee — completely free for 12 months</li>
      </ul>
    </div>

    <div class="steps-box">
      <h3>Your next steps</h3>
      <ol>
        <li>Click the button above to log in to your <a href="${esc(site)}/seller-dashboard.html" style="color:#e65100;font-weight:600">Seller Dashboard</a></li>
        <li>Finish setting up your store — add a logo, banner, and shop description</li>
        <li>Create your first product listing and go live</li>
        <li>Share your store link with your customers</li>
      </ol>
    </div>

    <div class="note">
      <strong>How to log in next time:</strong><br>
      Go to <a href="${esc(site)}" style="color:#0a2f66">umzila.store</a> &rarr; click <strong>About</strong> &rarr; select <strong>Sign In</strong> &rarr; enter your email and password &rarr; choose <strong>Seller Dashboard</strong>.
    </div>

    <p style="font-size:14px;color:#888">Questions? Reply to this email or reach us at <a href="mailto:support@umzila.store" style="color:#0a2f66">support@umzila.store</a></p>
  </div>
  <div class="ft">
    <strong><a href="${esc(site)}">Umzila</a></strong> &mdash; campus marketplace<br>
    <a href="mailto:sellers@umzila.store">sellers@umzila.store</a>
  </div>
</div>
</body>
</html>`;
}
