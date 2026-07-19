// netlify/functions/admin-manage-marketing.js
//
// Admin-only: review pending seller marketing campaigns, preview the actual
// rendered email, approve (which sends immediately — no scheduler exists in
// this codebase) or reject with a reason. Structural sibling of
// admin-manage-ads.js.
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { renderMarketingEmail } = require('./lib/marketing-template');

function signUnsubscribe(email) {
  const secret = process.env.UNSUBSCRIBE_SECRET || '';
  return crypto.createHmac('sha256', secret).update(email.toLowerCase().trim()).digest('hex');
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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
  if (!campaign_id || !['preview', 'approve', 'reject'].includes(action)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'campaign_id and action (preview|approve|reject) required' }) };
  }

  const { data: campaign } = await admin
    .from('marketing_campaigns')
    .select('*, sellers(shop_name), discount_codes(*)')
    .eq('id', campaign_id).maybeSingle();
  if (!campaign) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Campaign not found' }) };

  const shopName = campaign.sellers ? campaign.sellers.shop_name : null;
  const ctaUrl = `${SITE_BASE_URL}${campaign.cta_path || '/'}`;

  if (action === 'preview') {
    const html = renderMarketingEmail({
      headline: campaign.headline, bodyMessage: campaign.body_message, ctaText: campaign.cta_text, ctaUrl,
      shopName, codeRow: campaign.discount_codes || null, sellerShopName: shopName,
      siteUrl: SITE_BASE_URL, unsubscribeUrl: `${SITE_BASE_URL}/.netlify/functions/unsubscribe?e=preview%40example.com&t=preview`
    });
    return { statusCode: 200, headers, body: JSON.stringify({ html }) };
  }

  if (campaign.status === 'sent') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'This campaign was already sent.' }) };
  }

  if (action === 'reject') {
    const rejection_reason = String(body.rejection_reason || '').trim().slice(0, 300) || 'Not specified';
    const { error } = await admin.from('marketing_campaigns').update({
      status: 'rejected', rejection_reason, updated_at: new Date().toISOString()
    }).eq('id', campaign_id);
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // ── Approve = send immediately ──────────────────────────────────────────
  if (!RESEND_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email service not configured' }) };

  // Mass sends only ever reach marketing-eligible contacts — never the
  // 'transactional' tier (stock alerts, seller applications, bare account
  // signups), who only ever gave an email for one specific purpose.
  const { data: subs, error: subsErr } = await admin
    .from('subscribers')
    .select('email')
    .eq('unsubscribed', false)
    .in('consent', ['opted_in', 'soft_opt_in']);
  if (subsErr) return { statusCode: 500, headers, body: JSON.stringify({ error: subsErr.message }) };

  const seen = new Set();
  const recipients = (subs || []).filter(s => {
    const email = (s.email || '').toLowerCase().trim();
    if (!email || seen.has(email)) return false;
    seen.add(email);
    return true;
  }).map(s => s.email.toLowerCase().trim());

  if (!recipients.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No subscribers to send to.' }) };
  }

  const batches = chunk(recipients, 100);
  for (const batch of batches) {
    const payload = batch.map(email => {
      const unsubscribeUrl = `${SITE_BASE_URL}/.netlify/functions/unsubscribe?e=${encodeURIComponent(email)}&t=${signUnsubscribe(email)}`;
      const html = renderMarketingEmail({
        headline: campaign.headline, bodyMessage: campaign.body_message, ctaText: campaign.cta_text, ctaUrl,
        shopName, codeRow: campaign.discount_codes || null, sellerShopName: shopName,
        siteUrl: SITE_BASE_URL, unsubscribeUrl
      });
      return { from: 'Umzila <promos@umzila.store>', to: [email], subject: campaign.subject, html };
    });

    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('admin-manage-marketing: Resend batch error', res.status, errText);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Email send failed partway through — please check Resend before retrying.' }) };
    }
  }

  const { error: updErr } = await admin.from('marketing_campaigns').update({
    status: 'sent',
    sent_at: new Date().toISOString(),
    recipient_count: recipients.length,
    approved_by: user.id,
    approved_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq('id', campaign_id);
  if (updErr) return { statusCode: 500, headers, body: JSON.stringify({ error: updErr.message }) };

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, recipient_count: recipients.length }) };
};
