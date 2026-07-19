// netlify/functions/subscribe.js
// Public newsletter signup — the only path allowed to grant 'opted_in'
// consent or clear a prior unsubscribe (an explicit re-subscribe). Source
// and consent are hardcoded here, never taken from the client, so a caller
// can't claim a marketing opt-in it didn't actually give.
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Please enter a valid email address.' }) };
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: existing } = await admin.from('subscribers').select('sources').eq('email', email).maybeSingle();
  const sources = existing && Array.isArray(existing.sources) && existing.sources.includes('newsletter')
    ? existing.sources
    : [...(existing ? existing.sources || [] : []), 'newsletter'];

  const { error } = await admin.from('subscribers').upsert({
    email, sources, consent: 'opted_in', unsubscribed: false, unsubscribed_at: null, updated_at: new Date().toISOString()
  }, { onConflict: 'email' });

  if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not save your email — please try again.' }) };

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
};
