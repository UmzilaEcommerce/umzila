// netlify/functions/send-scheduled-campaigns.js
//
// Scheduled every 5 minutes (netlify.toml). Sends Platform Campaigns whose
// scheduled_for has arrived (admin.html → Marketing → Platform Campaign →
// "Schedule"). Each row is claimed first (status scheduled → sending, only if
// still scheduled), so two overlapping runs can never send it twice. A failed
// send goes back to 'scheduled' only if nothing was sent; otherwise it is left
// as 'sending' for an admin to check in Resend.
const { createClient } = require('@supabase/supabase-js');
const { sendCampaign } = require('./lib/campaign-send');

exports.handler = async function () {
  const SITE = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: due, error } = await admin.from('marketing_campaigns').select('id')
    .eq('status', 'scheduled').lte('scheduled_for', new Date().toISOString()).order('scheduled_for').limit(3);
  if (error) { console.error('send-scheduled-campaigns: read failed', error.message); return { statusCode: 500 }; }
  const out = [];
  for (const row of due || []) {
    const { data: claimed } = await admin.from('marketing_campaigns').update({ status: 'sending', updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', 'scheduled').select('*, sellers(shop_name), discount_codes(*)').maybeSingle();
    if (!claimed) continue;
    const r = await sendCampaign(admin, claimed, SITE, null);
    if (!r.ok && r.status !== 502) await admin.from('marketing_campaigns').update({ status: 'scheduled' }).eq('id', row.id); // nothing went out — retry next run
    out.push({ id: row.id, ...r });
    console.log('send-scheduled-campaigns', row.id, JSON.stringify(r));
  }
  return { statusCode: 200, body: JSON.stringify({ sent: out }) };
};
