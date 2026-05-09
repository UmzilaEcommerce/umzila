// netlify/functions/recalculate-rankings.js
// Admin-triggered batch function that:
// 1. Syncs order_count from paid orders table (captures all historical + new orders)
// 2. Normalizes popularity (0-100) from weighted engagement across all products
const { createClient } = require('@supabase/supabase-js');

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
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Verify admin role
  const authHeader = event.headers && (event.headers['authorization'] || event.headers['Authorization']);
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const { data: { user } } = await admin.auth.getUser(authHeader.slice(7));
      if (user) {
        const { data: profile } = await admin.from('profiles').select('role').eq('user_id', user.id).maybeSingle();
        if (!profile || profile.role !== 'admin') {
          return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
        }
      } else {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
      }
    } catch (_) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  } else {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Step 1: Sync order_count from paid orders (full historical + new)
  const { error: orderSyncError } = await admin.rpc('sync_product_order_counts');
  if (orderSyncError) {
    console.error('order sync error:', orderSyncError);
  }

  // Step 2: Normalize popularity across all products from weighted engagement
  const { error: rankError } = await admin.rpc('normalize_product_popularity');
  if (rankError) {
    console.error('rank normalize error:', rankError);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Ranking normalization failed', detail: rankError.message }) };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, message: 'Rankings recalculated and order counts synced.' })
  };
};
