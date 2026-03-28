// netlify/functions/toggle-favourite.js
// Toggle a product favourite for logged-in or anonymous users.
// Creates a seller notification when a favourite is added.
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

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { product_id, anonymous_id } = body;
  if (!product_id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'product_id is required' }) };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Resolve the calling user from JWT if present
  let userId = null;
  const authHeader = event.headers && (event.headers['authorization'] || event.headers['Authorization']);
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const { data: { user } } = await admin.auth.getUser(token);
      if (user) userId = user.id;
    } catch (_) {}
  }

  // Load product to get name and seller
  const { data: product, error: prodErr } = await admin
    .from('products')
    .select('id, name, image, seller_id, favourite_count')
    .eq('id', product_id)
    .maybeSingle();

  if (prodErr || !product) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Product not found' }) };
  }

  let action = 'added';
  let newCount = Number(product.favourite_count || 0);

  if (userId) {
    // Logged-in: toggle (add or remove)
    const { data: existing } = await admin
      .from('product_favourites')
      .select('id')
      .eq('product_id', product_id)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      await admin.from('product_favourites').delete().eq('id', existing.id);
      action = 'removed';
      newCount = Math.max(0, newCount - 1);
    } else {
      await admin.from('product_favourites').insert({ product_id, user_id: userId });
      action = 'added';
      newCount += 1;
    }
  } else {
    // Anonymous: only add (no dedup without identity)
    const anonId = anonymous_id || null;
    await admin.from('product_favourites').insert({ product_id, user_id: null, anonymous_id: anonId });
    action = 'added';
    newCount += 1;
  }

  // Create seller notification when a favourite is added
  if (action === 'added' && product.seller_id) {
    let actorLabel = 'Someone';
    if (userId) {
      // Try to get a display name from profiles
      const { data: prof } = await admin
        .from('profiles')
        .select('first_name, email')
        .eq('user_id', userId)
        .maybeSingle();
      if (prof && prof.first_name) actorLabel = prof.first_name;
      else if (prof && prof.email) actorLabel = prof.email.split('@')[0];
    }

    await admin.from('seller_notifications').insert({
      seller_id:          product.seller_id,
      type:               'favourite',
      title:              `${actorLabel} favourited your item`,
      body:               `"${product.name}" was added to someone's favourites.`,
      image_url:          product.image || null,
      related_product_id: product.id,
      is_read:            false
    });
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, action, favourite_count: newCount })
  };
};
