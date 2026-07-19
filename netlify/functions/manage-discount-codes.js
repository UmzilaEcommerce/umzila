// netlify/functions/manage-discount-codes.js
//
// Admin and seller discount-code management — create / list / disable.
// Same auth scaffold as admin-manage-ads.js. Every field a seller can set
// is either forced or re-verified server-side — the client's claimed scope
// is never trusted, since a seller-owned code must never be able to
// discount another seller's line items (enforced again at redemption time
// by netlify/functions/lib/discounts.js's computeDiscount()).
const { createClient } = require('@supabase/supabase-js');

const RESERVED_PREFIXES = ['WELCOME', 'REFERRAL', 'MYSTERY', 'GIFT'];
const CODE_RE = /^[A-Z0-9]{4,20}$/;

exports.handler = async function (event) {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server config error' }) };
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };

  const { data: adminRow } = await admin.from('admins').select('role').eq('user_id', user.id).maybeSingle();
  const isAdmin = !!adminRow && adminRow.role === 'admin';

  let ownedSellerIds = [];
  if (!isAdmin) {
    const { data: shops } = await admin.from('sellers').select('id, shop_name').eq('user_id', user.id);
    ownedSellerIds = (shops || []).map(s => s.id);
    if (!ownedSellerIds.length) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
    }
  }

  // ── GET: list codes ─────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    let q = admin
      .from('discount_codes')
      .select('*')
      .eq('multi_use', true)
      .order('created_at', { ascending: false })
      .limit(200);
    if (!isAdmin) q = q.in('seller_id', ownedSellerIds);

    const { data: codes, error } = await q;
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };

    // Redemption counts, joined in a second query (avoids a heavier SQL join
    // for what's a small admin/seller-facing list).
    const ids = (codes || []).map(c => c.id);
    let counts = {};
    if (ids.length) {
      const { data: redemptions } = await admin
        .from('discount_redemptions')
        .select('discount_code_id')
        .in('discount_code_id', ids);
      (redemptions || []).forEach(r => { counts[r.discount_code_id] = (counts[r.discount_code_id] || 0) + 1; });
    }

    const enriched = (codes || []).map(c => ({ ...c, redemptions: counts[c.id] || 0 }));
    return { statusCode: 200, headers, body: JSON.stringify({ codes: enriched }) };
  }

  // ── POST: create or disable ─────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (body.action === 'disable') {
    const { code_id } = body;
    if (!code_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'code_id required' }) };

    const { data: existing } = await admin.from('discount_codes').select('id, seller_id').eq('id', code_id).maybeSingle();
    if (!existing) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Code not found' }) };
    if (!isAdmin && !ownedSellerIds.includes(existing.seller_id)) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
    }

    const { error } = await admin.from('discount_codes').update({ status: 'disabled' }).eq('id', code_id);
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (body.action !== 'create') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  }

  // ── Create ───────────────────────────────────────────────────────────────
  let { code, type, amount, scope, product_ids, expires_at, max_redemptions, min_order_amount, seller_id } = body;

  code = String(code || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Code must be 4-20 letters/numbers.' }) };
  }
  if (RESERVED_PREFIXES.some(p => code.startsWith(p))) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'That prefix is reserved for automated codes — pick another.' }) };
  }
  if (!['percentage', 'fixed'].includes(type)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'type must be percentage or fixed' }) };
  }
  amount = Number(amount);
  if (!(amount > 0)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'amount must be greater than 0' }) };
  if (!['order', 'products'].includes(scope)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'scope must be order or products' }) };
  }
  if (!expires_at) return { statusCode: 400, headers, body: JSON.stringify({ error: 'expires_at is required' }) };
  const expiresDate = new Date(expires_at);
  if (isNaN(expiresDate.getTime()) || expiresDate <= new Date()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'expires_at must be a future date' }) };
  }

  const insertRow = {
    code,
    type,
    amount,
    scope,
    expires_at: expiresDate.toISOString(),
    multi_use: true,
    per_user_limit: 1,
    status: 'active',
    created_by: user.id,
    used: false
  };

  if (isAdmin) {
    // Admin — largely unrestricted.
    if (type === 'percentage' && amount > 100) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Percentage cannot exceed 100.' }) };
    }
    const maxOut = new Date(); maxOut.setMonth(maxOut.getMonth() + 12);
    if (expiresDate > maxOut) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Expiry cannot be more than 12 months out.' }) };

    insertRow.seller_id = seller_id || null;
    if (max_redemptions != null) insertRow.max_redemptions = Math.max(1, Math.min(100000, Number(max_redemptions) || 0));
    if (min_order_amount != null) insertRow.min_order_amount = Number(min_order_amount) || null;

    if (scope === 'products') {
      const ids = Array.isArray(product_ids) ? product_ids.map(String) : [];
      if (!ids.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Select at least one product.' }) };
      const { data: found } = await admin.from('products').select('id').in('id', ids);
      if (!found || found.length !== ids.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'One or more products could not be found.' }) };
      }
      insertRow.product_ids = ids;
    }
  } else {
    // Seller — everything below is forced/re-verified, never trusted from the client.
    if (type === 'percentage' && amount > 90) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Sellers can offer up to 90% off — 100% is reserved for platform codes.' }) };
    }
    const requestedSellerId = ownedSellerIds.includes(seller_id) ? seller_id : ownedSellerIds[0];
    insertRow.seller_id = requestedSellerId;
    insertRow.per_user_limit = 1;

    const maxOut = new Date(); maxOut.setMonth(maxOut.getMonth() + 6);
    if (expiresDate > maxOut) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Expiry cannot be more than 6 months out.' }) };

    if (max_redemptions != null) insertRow.max_redemptions = Math.max(1, Math.min(10000, Number(max_redemptions) || 0));

    if (scope === 'products') {
      const ids = Array.isArray(product_ids) ? product_ids.map(String) : [];
      if (!ids.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Select at least one product.' }) };
      // Re-queried and ownership-checked — any id that doesn't come back
      // owned by this seller is a hard rejection, never silently dropped
      // (silently dropping would let a seller believe a code covers
      // something it doesn't).
      const { data: owned } = await admin.from('products').select('id').in('id', ids).eq('seller_id', requestedSellerId);
      const ownedIds = new Set((owned || []).map(p => String(p.id)));
      const unowned = ids.filter(id => !ownedIds.has(id));
      if (unowned.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'You can only apply codes to your own products.' }) };
      }
      insertRow.product_ids = ids;
    }
    // scope === 'order' for a seller is enforced entirely by seller_id being
    // set — computeDiscount() intersects with item.seller_id unconditionally,
    // so this can never reach another seller's line items.
  }

  const { data: created, error: insErr } = await admin.from('discount_codes').insert([insertRow]).select().single();
  if (insErr) {
    if (insErr.code === '23505') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'That code is already taken.' }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: insErr.message }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, code: created }) };
};
