// netlify/functions/identify-visitor.js
//
// People (docs/systems/people.md): someone opened Umzila from a link in one of
// our emails (?ut=<tag>, lib/visitor-tag.js). presence.js posts the tag with
// this browser's basket id; a genuine tag links the browser (site_browsers) to
// that email, so its past and future visits show under them in admin →
// Intelligence → People. Forged / old tags are ignored. Never says who the tag
// belongs to.
//
// POST { tag, anon } → 200 { ok:true|false }
const { createClient } = require('@supabase/supabase-js');
const { readVisitorTag } = require('./lib/visitor-tag');

const headers = { 'Content-Type': 'application/json' };
const reply = ok => ({ statusCode: 200, headers, body: JSON.stringify({ ok }) });

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(false); }
  const anon = typeof b.anon === 'string' ? b.anon : '';
  if (!/^anon-[a-z0-9]{6,40}$/.test(anon)) return reply(false);
  const email = readVisitorTag(b.tag);
  if (!email) return reply(false);

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const now = new Date().toISOString();
  const { error } = await supabase.from('site_browsers')
    .upsert({ anon_id: anon, email, contact_at: now, last_seen: now }, { onConflict: 'anon_id' });
  if (error) { console.error('identify-visitor', error.message); return reply(false); }
  return reply(true);
};
