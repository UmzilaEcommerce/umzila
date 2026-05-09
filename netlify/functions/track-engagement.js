// netlify/functions/track-engagement.js
// Updates product engagement counters and logs to user_events.
// Called fire-and-forget from frontend — never blocks UI.
const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const COUNTER_MAP = {
  product_click: { col: 'click_count', inc: 1 },
  product_view:  { col: 'click_count', inc: 1 },
  add_to_cart:   { col: 'cart_count',  inc: 1 }
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

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { product_id, event_type, seller_id, category, anonymous_id } = body;
  if (!product_id || !event_type) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'product_id and event_type required' }) };
  }

  const mapping = COUNTER_MAP[event_type];
  if (!mapping) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown event_type' }) };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  let userId = null;
  const authHeader = event.headers && (event.headers['authorization'] || event.headers['Authorization']);
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const { data: { user } } = await admin.auth.getUser(authHeader.slice(7));
      if (user) userId = user.id;
    } catch (_) {}
  }

  const now = new Date().toISOString();

  await Promise.all([
    admin.from('user_events').insert({
      event_type,
      product_id,
      seller_id:   seller_id   || null,
      category:    category    || null,
      anonymous_id: anonymous_id || null,
      user_id:     userId,
      metadata:    {}
    }),
    admin.rpc('increment_product_engagement', {
      p_product_id:  product_id,
      p_counter_col: mapping.col,
      p_increment:   mapping.inc,
      p_engaged_at:  now
    })
  ]);

  return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
};
