// netlify/functions/evaluate-batch-candidates.js
//
// Delivery network Stage 11 — thin admin-only HTTP wrapper around
// lib/batch-dispatch.js's evaluateBatchCandidates(), mirroring
// dispatch-delivery.js's exact structure for the idle-driver path. Not
// required to be wired into any UI as part of this stage (advance-
// delivery-on-fulfillment.js already calls evaluateBatchCandidates() inline,
// same as it does for dispatchDelivery()) -- this endpoint exists for an
// admin to manually re-check batch opportunities for a delivery, same
// rationale as dispatch-delivery.js.
const { createClient } = require('@supabase/supabase-js');
const { evaluateBatchCandidates } = require('./lib/batch-dispatch');

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
    const result = await evaluateBatchCandidates(admin, deliveryId);
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (error) {
    console.error('evaluate-batch-candidates error', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
