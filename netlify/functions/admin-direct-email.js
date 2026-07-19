// netlify/functions/admin-direct-email.js
//
// Admin-only: search the marketable-emails table and send a one-off email
// to a single known contact. Search results surface each contact's
// sources/consent/history so the admin can see where the email came from
// before sending — the whole point of tracking that in the first place.
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { renderMarketingEmail } = require('./lib/marketing-template');

const MAX_LEN = { subject: 80, headline: 60, body_message: 500, cta_text: 30 };

function clamp(str, max) {
  return String(str || '').trim().replace(/[<>]/g, '').slice(0, max);
}

function signUnsubscribe(email) {
  const secret = process.env.UNSUBSCRIBE_SECRET || '';
  return crypto.createHmac('sha256', secret).update(email.toLowerCase().trim()).digest('hex');
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

  // ── GET: search contacts ────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const q = new URLSearchParams(event.rawQuery || '').get('q') || '';
    let query = admin
      .from('subscribers')
      .select('email, name, sources, consent, unsubscribed, last_order_at, created_at')
      .order('updated_at', { ascending: false })
      .limit(20);
    if (q.trim()) query = query.or(`email.ilike.%${q.trim()}%,name.ilike.%${q.trim()}%`);

    const { data, error } = await query;
    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ contacts: data || [] }) };
  }

  // ── POST: send one email ────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return { statusCode: 400, headers, body: JSON.stringify({ error: 'email is required' }) };

  const subject     = clamp(body.subject, MAX_LEN.subject);
  const headline     = clamp(body.headline, MAX_LEN.headline);
  const body_message = clamp(body.body_message, MAX_LEN.body_message);
  const cta_text     = clamp(body.cta_text, MAX_LEN.cta_text) || 'Visit Umzila';
  if (!subject || !headline || !body_message) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Subject, headline, and message are required.' }) };
  }

  const { data: contact } = await admin.from('subscribers').select('email, unsubscribed').eq('email', email).maybeSingle();
  if (!contact) return { statusCode: 404, headers, body: JSON.stringify({ error: 'This email is not in the marketable-contacts table.' }) };
  if (contact.unsubscribed) return { statusCode: 400, headers, body: JSON.stringify({ error: 'This contact has unsubscribed — cannot send.' }) };

  if (body.action === 'preview') {
    const html = renderMarketingEmail({
      headline, bodyMessage: body_message, ctaText: cta_text, ctaUrl: SITE_BASE_URL || '/',
      shopName: null, codeRow: null, sellerShopName: null,
      siteUrl: SITE_BASE_URL, unsubscribeUrl: `${SITE_BASE_URL}/.netlify/functions/unsubscribe?e=preview%40example.com&t=preview`
    });
    return { statusCode: 200, headers, body: JSON.stringify({ html }) };
  }

  if (!RESEND_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email service not configured' }) };

  const unsubscribeUrl = `${SITE_BASE_URL}/.netlify/functions/unsubscribe?e=${encodeURIComponent(email)}&t=${signUnsubscribe(email)}`;
  const html = renderMarketingEmail({
    headline, bodyMessage: body_message, ctaText: cta_text, ctaUrl: SITE_BASE_URL || '/',
    shopName: null, codeRow: null, sellerShopName: null,
    siteUrl: SITE_BASE_URL, unsubscribeUrl
  });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Umzila <promos@umzila.store>', to: [email], subject, html })
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error('admin-direct-email: Resend error', res.status, errText);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Email send failed' }) };
  }

  await admin.from('marketing_campaigns').insert([{
    seller_id: null,
    created_by: user.id,
    discount_code_id: null,
    subject, headline, body_message,
    cta_text, cta_path: '/',
    audience: 'individual',
    status: 'sent',
    approved_by: user.id,
    approved_at: new Date().toISOString(),
    sent_at: new Date().toISOString(),
    recipient_count: 1,
    recipient_email: email
  }]);

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
