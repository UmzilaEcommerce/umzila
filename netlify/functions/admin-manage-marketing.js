// netlify/functions/admin-manage-marketing.js
//
// Admin-only: review pending seller marketing campaigns, preview the actual
// rendered email, approve (sends immediately), cancel a scheduled one, or reject
// with a reason. Sending itself lives in lib/campaign-send.js (shared with the
// send-scheduled-campaigns.js scheduler). Structural sibling of admin-manage-ads.js.
const { createClient } = require('@supabase/supabase-js');
const { renderMarketingEmail } = require('./lib/marketing-template');
const { sendCampaign, slotsFor } = require('./lib/campaign-send');

exports.handler = async function (event) {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const RESEND_KEY   = process.env.RESEND_API_KEY || '';
  const SITE_BASE_URL = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server config error' }) };
  }

  // ── Auth: verify admin ──────────────────────────────────────────────────
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

  // ── GET: list campaigns (joined with seller + code info) ───────────────
  if (event.httpMethod === 'GET') {
    const statusFilter = new URLSearchParams(event.rawQuery || '').get('status');
    let q = admin
      .from('marketing_campaigns')
      .select('*, sellers(shop_name), discount_codes(code, type, amount, scope, expires_at, seller_id)')
      .order('created_at', { ascending: false })
      .limit(200);
    if (statusFilter) q = q.eq('status', statusFilter);

    const { data, error } = await q;
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ campaigns: data }) };
  }

  // ── POST: preview / approve+send / reject ───────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { campaign_id, action } = body;
  if (!campaign_id || !['preview', 'approve', 'reject', 'cancel'].includes(action)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'campaign_id and action (preview|approve|reject|cancel) required' }) };
  }

  const { data: campaign } = await admin
    .from('marketing_campaigns')
    .select('*, sellers(shop_name), discount_codes(*)')
    .eq('id', campaign_id).maybeSingle();
  if (!campaign) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Campaign not found' }) };

  if (action === 'preview') {
    const html = renderMarketingEmail(slotsFor(campaign, SITE_BASE_URL, `${SITE_BASE_URL}/.netlify/functions/unsubscribe?e=preview%40example.com&t=preview`));
    return { statusCode: 200, headers, body: JSON.stringify({ html }) };
  }

  if (campaign.status === 'sent' || campaign.status === 'sending') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'This campaign was already sent.' }) };
  }

  if (action === 'cancel') {
    const { data: c2, error } = await admin.from('marketing_campaigns').update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', campaign_id).eq('status', 'scheduled').select('id').maybeSingle();
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    if (!c2) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Only a scheduled campaign can be cancelled.' }) };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (action === 'reject') {
    const rejection_reason = String(body.rejection_reason || '').trim().slice(0, 300) || 'Not specified';
    const { error } = await admin.from('marketing_campaigns').update({
      status: 'rejected', rejection_reason, updated_at: new Date().toISOString()
    }).eq('id', campaign_id);
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // ── Approve = send immediately (claim first so it can't go twice) ─────
  const { data: claimed } = await admin.from('marketing_campaigns').update({ status: 'sending', updated_at: new Date().toISOString() })
    .eq('id', campaign_id).in('status', ['pending', 'approved', 'scheduled']).select('*, sellers(shop_name), discount_codes(*)').maybeSingle();
  if (!claimed) return { statusCode: 400, headers, body: JSON.stringify({ error: 'This campaign is already being sent.' }) };
  const r = await sendCampaign(admin, claimed, SITE_BASE_URL, user.id);
  if (!r.ok) {
    if (r.status !== 502) await admin.from('marketing_campaigns').update({ status: campaign.status }).eq('id', campaign_id);
    return { statusCode: r.status, headers, body: JSON.stringify({ error: r.error }) };
  }
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, recipient_count: r.recipient_count }) };
};
