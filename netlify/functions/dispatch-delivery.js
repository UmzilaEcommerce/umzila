// netlify/functions/dispatch-delivery.js
//
// Delivery network Stage 8 — thin admin-only HTTP wrapper around
// lib/dispatch.js's dispatchDelivery(). The 2-rider pilot doesn't need a
// cron/polling dispatcher: advance-delivery-on-fulfillment.js already calls
// dispatchDelivery() inline the moment a delivery becomes READY_FOR_DISPATCH.
// This endpoint exists for the cases that path doesn't cover -- an admin
// manually redispatching a delivery that came back to READY_FOR_DISPATCH
// after a declined/expired offer, or any future cron this build might add --
// not required to be wired into any UI as part of this stage.
const { createClient } = require('@supabase/supabase-js');
const { dispatchDelivery } = require('./lib/dispatch');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  // ── Auth: verify admin (same pattern as admin-manage-ads.js) ──────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };

  const { data: adminRow } = await admin.from('admins').select('role').eq('user_id', user.id).maybeSingle();
  if (!adminRow || adminRow.role !== 'admin') {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { deliveryId } = body;
  if (!deliveryId || typeof deliveryId !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'deliveryId required' }) };
  }

  try {
    const result = await dispatchDelivery(admin, deliveryId);
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (error) {
    console.error('dispatch-delivery error', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
