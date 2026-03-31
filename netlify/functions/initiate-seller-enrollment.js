// netlify/functions/initiate-seller-enrollment.js
// Creates the seller's auth user + profile + links the sellers row BEFORE payment,
// then pre-creates a pending order row and returns an auto-submitting PayFast form.
// This ensures payfast-itn.js only needs to UPDATE the order to 'paid' on completion.
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const headers = {
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

  const SUPABASE_URL        = process.env.SUPABASE_URL || '';
  const SERVICE_KEY         = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const MERCHANT_ID         = (process.env.PAYFAST_MERCHANT_ID || '').toString().trim();
  const MERCHANT_KEY        = (process.env.PAYFAST_MERCHANT_KEY || '').toString().trim();
  const PASSPHRASE          = (process.env.PAYFAST_PASSPHRASE || '').toString().trim();
  const SANDBOX             = (process.env.PAYFAST_SANDBOX || 'true').toLowerCase() !== 'false';
  const SITE_BASE_URL       = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  if (!MERCHANT_ID || !MERCHANT_KEY) {
    return { statusCode: 500, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'PayFast merchant configuration missing' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { email, name, applicationId, password, phone, deliveryMethod, location } = body;
  if (!email || !name || !applicationId || !password) {
    return { statusCode: 400, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'email, name, applicationId, and password are required' }) };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // ── Step 1: Create Supabase auth user ──────────────────────────────────────
  const { data: authData, error: authErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });

  let userId = authData?.user?.id || null;

  if (authErr) {
    if (authErr.message && authErr.message.toLowerCase().includes('already registered')) {
      console.warn('initiate-seller-enrollment: user already exists, fetching existing user');
      const { data: { users }, error: listErr } = await admin.auth.admin.listUsers();
      if (!listErr && users) {
        const existing = users.find(u => u.email === email);
        if (existing) userId = existing.id;
      }
    } else {
      console.error('initiate-seller-enrollment: createUser error', authErr);
      return { statusCode: 500, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Failed to create seller account: ' + authErr.message }) };
    }
  }

  if (!userId) {
    console.error('initiate-seller-enrollment: could not resolve user ID for', email);
    return { statusCode: 500, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Could not resolve seller account' }) };
  }

  console.log('initiate-seller-enrollment: auth user ready, userId =', userId);

  // ── Step 2: Create or update profile with role='seller' ───────────────────
  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts[0] || name;
  const lastName  = nameParts.slice(1).join(' ') || '';

  const profileData = {
    user_id:    userId,
    email,
    first_name: firstName,
    last_name:  lastName,
    phone:      phone || null,
    role:       'seller'
  };

  // Check if profile already exists (partial index on user_id prevents standard upsert)
  const { data: existingProfile } = await admin.from('profiles')
    .select('id').eq('user_id', userId).maybeSingle();

  let profileId = existingProfile?.id || null;
  let profileErr;

  if (existingProfile) {
    const { error } = await admin.from('profiles')
      .update({ email, first_name: firstName, last_name: lastName, phone: phone || null, role: 'seller' })
      .eq('user_id', userId);
    profileErr = error;
  } else {
    const { data: newProfile, error } = await admin.from('profiles')
      .insert(profileData)
      .select('id')
      .single();
    profileErr = error;
    if (newProfile) profileId = newProfile.id;
  }

  if (profileErr) {
    console.error('initiate-seller-enrollment: profile error', profileErr);
    return { statusCode: 500, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Failed to create profile: ' + profileErr.message }) };
  }

  console.log('initiate-seller-enrollment: profile ready, profileId =', profileId);

  // ── Step 3: Fetch application + link sellers row ───────────────────────────
  const { data: app } = await admin.from('seller_applications')
    .select('id, shop_name, instagram, phone')
    .eq('id', applicationId)
    .maybeSingle();

  if (app) {
    // Link by application_id (set during admin approval) — reliable, no text-match fragility
    const { error: sellerErr, count } = await admin.from('sellers')
      .update({
        user_id:          userId,
        email,
        whatsapp_number:  phone || app.phone || null,
        location:         location || null,
        delivery_method:  deliveryMethod || null,
        social_instagram: app.instagram || null,
        status:           'pending_payment'
      })
      .eq('application_id', applicationId)
      .is('user_id', null)
      .select('id', { count: 'exact', head: true });

    if (sellerErr) {
      console.error('initiate-seller-enrollment: sellers update error', sellerErr);
      // Non-fatal — continue to create order and payment form
    } else if (count === 0) {
      // Fallback: approval may have pre-dated this column — try shop_name match
      const { error: fallbackErr } = await admin.from('sellers')
        .update({
          user_id:          userId,
          email,
          whatsapp_number:  phone || app.phone || null,
          location:         location || null,
          delivery_method:  deliveryMethod || null,
          social_instagram: app.instagram || null,
          status:           'pending_payment',
          application_id:   applicationId
        })
        .eq('shop_name', app.shop_name)
        .is('user_id', null);
      if (fallbackErr) {
        console.error('initiate-seller-enrollment: sellers fallback update error', fallbackErr);
      } else {
        console.log('initiate-seller-enrollment: sellers row linked via shop_name fallback for', app.shop_name);
      }
    } else {
      console.log('initiate-seller-enrollment: sellers row linked via application_id', applicationId);
    }
  } else {
    console.warn('initiate-seller-enrollment: no application found for applicationId', applicationId);
  }

  // ── Step 4: Create pending order row ──────────────────────────────────────
  // Split name into first/last for PayFast fields
  const mPaymentId = `SELLER-${applicationId}-${Date.now()}`;

  const { error: orderErr } = await admin.from('orders').insert({
    m_payment_id:    mPaymentId,
    user_id:         userId,
    profile_id:      profileId || undefined,
    customer_email:  email,
    customer_name:   name.trim(),
    customer_phone:  phone || null,
    total:           100,
    order_status:    'pending_payment',
    payment_status:  'pending',
    label:           'seller_enrollment',
    items:           [{ item_name: 'Umzila Seller Enrollment Fee', quantity: 1, unit_price: 100, total: 100 }]
  });

  if (orderErr) {
    console.error('initiate-seller-enrollment: insert order error', orderErr);
    return { statusCode: 500, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Failed to create enrollment order: ' + orderErr.message }) };
  }

  // ── Step 5: Build PayFast form ─────────────────────────────────────────────
  const pfHost    = SANDBOX ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';
  const actionUrl = `https://${pfHost}/eng/process`;

  const data = {
    merchant_id:          MERCHANT_ID,
    merchant_key:         MERCHANT_KEY,
    return_url:           `${SITE_BASE_URL}/checkout-success.html`,
    cancel_url:           `${SITE_BASE_URL}/checkout-cancel.html`,
    notify_url:           `${SITE_BASE_URL}/.netlify/functions/payfast-itn`,
    name_first:           firstName,
    name_last:            lastName,
    email_address:        email,
    cell_number:          phone || '',
    m_payment_id:         mPaymentId,
    amount:               (100).toFixed(2),
    item_name:            'Umzila Seller Enrollment',
    item_description:     '',
    custom_int1: '', custom_int2: '', custom_int3: '', custom_int4: '', custom_int5: '',
    custom_str1:          'seller_enrollment',
    custom_str2:          applicationId,
    custom_str3:          '', custom_str4: '', custom_str5: '',
    email_confirmation:   '1',
    confirmation_address: email
  };

  const orderedKeys = [
    'merchant_id','merchant_key','return_url','cancel_url','notify_url',
    'name_first','name_last','email_address','cell_number',
    'm_payment_id','amount','item_name','item_description',
    'custom_int1','custom_int2','custom_int3','custom_int4','custom_int5',
    'custom_str1','custom_str2','custom_str3','custom_str4','custom_str5',
    'email_confirmation','confirmation_address'
  ];

  function pfEncode(value) {
    const encoded = encodeURIComponent(String(value))
      .replace(/%20/g, '+')
      .replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    return encoded.replace(/%[0-9a-f]{2}/gi, m => m.toUpperCase());
  }

  // Skip empty fields — PayFast excludes empty params when computing ITN signature
  let pfOutput = '';
  orderedKeys.forEach(key => {
    let val = data[key];
    if (val === undefined || val === null) val = '';
    val = String(val).trim();
    if (val !== '') {
      pfOutput += `${key}=${pfEncode(val)}&`;
    }
  });
  if (pfOutput.endsWith('&')) pfOutput = pfOutput.slice(0, -1);

  let stringToSign = pfOutput;
  if (PASSPHRASE) stringToSign += `&passphrase=${pfEncode(PASSPHRASE)}`;

  const signature = crypto.createHash('md5').update(stringToSign).digest('hex');

  // Build auto-submitting HTML form
  const allKeys    = [...orderedKeys, 'signature'];
  const allData    = { ...data, signature };
  const inputsHtml = allKeys.map(key => {
    const val     = allData[key] !== undefined && allData[key] !== null ? allData[key] : '';
    const safeVal = String(val).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    return `<input type="hidden" name="${key}" value="${safeVal}" />`;
  }).join('\n');

  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Redirecting to PayFast…</title></head>
  <body>
    <form id="pf_form" action="${actionUrl}" method="post">
      ${inputsHtml}
      <noscript>
        <p>JavaScript is disabled — click the button below to continue to PayFast.</p>
        <input type="submit" value="Continue to PayFast" />
      </noscript>
    </form>
    <script>document.getElementById('pf_form').submit();</script>
  </body>
</html>`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    body: html
  };
};
