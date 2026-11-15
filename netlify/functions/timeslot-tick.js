// netlify/functions/timeslot-tick.js
//
// Delivery timeslots: the once-a-minute job (netlify.toml "* * * * *"). Sends the run
// cut-off summaries, grace "Add to the run" messages, run-changed / needs-attention
// emails and busy alerts — all idempotent, see lib/timeslots.js runTick().
// Returns immediately (one small site_settings read) while timeslots are switched off.
// Scheduled functions can't be called by URL in production; admins trigger a run through
// timeslot-admin.js { action: 'tick' } instead.
const { createClient } = require('@supabase/supabase-js');
const { runTick } = require('./lib/timeslots');

exports.handler = async function () {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const site = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');
  if (!url || !key) { console.error('timeslot-tick: missing configuration'); return { statusCode: 500, body: 'config' }; }
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    const r = await runTick(supabase, site);
    if (!r.skipped) console.log('timeslot-tick', JSON.stringify(r));
    return { statusCode: 200, body: JSON.stringify(r) };
  } catch (e) {
    console.error('timeslot-tick error', e);
    return { statusCode: 500, body: 'error' };
  }
};
