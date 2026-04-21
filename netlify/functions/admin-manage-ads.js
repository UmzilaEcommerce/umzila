// netlify/functions/admin-manage-ads.js
// Admin-only: list all ad_campaigns, approve or reject hero banner campaigns.
const { createClient } = require('@supabase/supabase-js');

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

  // ── Auth: verify admin ─────────────────────────────────────────────────────
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

  // ── GET: list all campaigns with seller info ────────────────────────────────
  if (event.httpMethod === 'GET') {
    const statusFilter = new URLSearchParams(event.rawQuery || '').get('status');
    let q = admin
      .from('ad_campaigns')
      .select('*, sellers(shop_name, email)')
      .order('created_at', { ascending: false })
      .limit(200);
    if (statusFilter) q = q.eq('status', statusFilter);

    const { data, error } = await q;
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ campaigns: data }) };
  }

  // ── POST: approve or reject a campaign ────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { campaign_id, action } = body;
  if (!campaign_id || !['approve', 'reject'].includes(action)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'campaign_id and action (approve|reject) required' }) };
  }

  const { data: campaign } = await admin.from('ad_campaigns').select('id, status, starts_at, ends_at').eq('id', campaign_id).maybeSingle();
  if (!campaign) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Campaign not found' }) };

  if (action === 'approve') {
    // If no start/end set yet, start now with remaining duration calculated from amount
    const now = new Date();
    const starts = campaign.starts_at ? new Date(campaign.starts_at) : now;
    const ends   = campaign.ends_at   ? new Date(campaign.ends_at)   : new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const { error } = await admin.from('ad_campaigns').update({
      status: 'active',
      starts_at: starts.toISOString(),
      ends_at:   ends.toISOString()
    }).eq('id', campaign_id);
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  } else {
    const { error } = await admin.from('ad_campaigns').update({ status: 'rejected' }).eq('id', campaign_id);
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
