// netlify/functions/approve-seller.js
// Uses the Supabase service role key (never exposed to the browser) to:
//   1. Insert a new row into the sellers table (user_id left null; seller links it on first login)
//   2. Mark the seller_applications row as approved
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

  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

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

  // Insert seller row — user_id is intentionally null; the seller will claim it on first login
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
    .update({ status: 'approved' })
    .eq('id', applicationId);

  if (appErr) {
    console.error('approve-seller: update application error', appErr);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Seller created but failed to update application: ' + appErr.message })
    };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
};
