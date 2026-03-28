// netlify/functions/complete-seller-enrollment.js
// Called by checkout-success.html after a successful SELLER- payment.
// Verifies the order is paid, creates the seller's Supabase auth account,
// sets their profile role to 'seller', and activates the sellers row.
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

  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('complete-seller-enrollment: missing env vars');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { m_payment_id, email, name, applicationId, password } = body;
  if (!m_payment_id || !email || !name || !applicationId || !password) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'm_payment_id, email, name, applicationId, and password are required' }) };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // 1. Verify payment — order must be in 'paid' status
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('id, order_status, payment_status')
    .eq('m_payment_id', m_payment_id)
    .or('payment_status.eq.paid,order_status.eq.paid')
    .maybeSingle();

  if (orderErr) {
    console.error('complete-seller-enrollment: order query error', orderErr);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to verify payment' }) };
  }
  if (!order) {
    return { statusCode: 402, headers, body: JSON.stringify({ error: 'Payment not verified. Please wait a moment and try again, or contact support.' }) };
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
    // If user already exists (e.g. partial previous run), try to fetch existing user
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
    // User already existed — look up by email
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
        // Non-fatal — profile and application are already updated
      }
    } else {
      console.warn('complete-seller-enrollment: no unlinked sellers row found for shop_name', app.shop_name);
    }
  }

  return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
};
