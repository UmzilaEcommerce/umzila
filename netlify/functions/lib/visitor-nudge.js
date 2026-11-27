// netlify/functions/lib/visitor-nudge.js
//
// "Lunch reminder" (2026-11-27): once a day at site_settings 'visitor_nudge'.send_at (SAST,
// e.g. 13:00) email this morning's visitors who left an email (or are signed in) but have not
// paid today — so they can still make the next delivery run. Settings + copy are edited in
// admin.html → Marketing → Lunch reminder. Who gets it = visitor_nudge_recipients() (SQL,
// docs/plans/sql/32_visitor_nudge.sql: no staff/riders/store owners, no unsubscribed, nobody
// who paid since midnight). Called by send-scheduled-campaigns.js every 5 minutes; a
// marketing_campaigns row with audience 'morning_visitors:<day>' (unique index) is the
// once-a-day lock, and the email goes out only via lib/campaign-send.js sendCampaign
// (marketing stream, unsubscribe link, People link tag).
const { sendCampaign } = require('./campaign-send');

const LATE_LIMIT_MIN = 60; // never send more than an hour after send_at (e.g. after an outage)

function sastNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: (+parts.hour % 24) * 60 + +parts.minute, weekday: wd };
}
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : null; };

async function runVisitorNudge(admin, siteUrl) {
  const { data: row, error } = await admin.from('site_settings').select('value, updated_by').eq('key', 'visitor_nudge').maybeSingle();
  if (error || !row || !row.value || row.value.enabled !== true) return { skipped: 'off' };
  const s = row.value;
  const now = sastNow();
  const at = toMin(s.send_at);
  if (at == null || now.minutes < at || now.minutes > at + LATE_LIMIT_MIN) return { skipped: 'not_time' };
  if (Array.isArray(s.days) && s.days.length && !s.days.includes(now.weekday)) return { skipped: 'not_today' };
  if (!s.subject || !s.headline || !s.body) return { skipped: 'no_copy' };
  if (!row.updated_by) return { skipped: 'no_admin' }; // marketing_campaigns.created_by is required

  // Claim today's send (the unique index makes a second claim fail).
  const { data: claimed, error: claimErr } = await admin.from('marketing_campaigns').insert({
    created_by: row.updated_by, subject: s.subject, headline: s.headline, body_message: s.body,
    cta_text: s.cta_text || 'Order now', cta_path: /^\/(?!\/)/.test(s.cta_path || '') ? s.cta_path : '/',
    eyebrow: s.eyebrow || null, image_url: /^https:\/\//i.test(s.image_url || '') ? s.image_url : null,
    audience: 'morning_visitors:' + now.day, status: 'sending'
  }).select('*, sellers(shop_name), discount_codes(*)').maybeSingle();
  if (claimErr || !claimed) return { skipped: 'already_sent' };

  const { data: people, error: pErr } = await admin.rpc('visitor_nudge_recipients', {
    p_day: now.day, p_from: s.window_from || '05:00', p_to: s.window_to || '12:30'
  });
  if (pErr) {
    await admin.from('marketing_campaigns').delete().eq('id', claimed.id); // nothing sent — retry next run
    return { ok: false, error: pErr.message };
  }
  const recipients = (people || []).map(p => p.email);
  if (!recipients.length) {
    await admin.from('marketing_campaigns').update({ status: 'sent', sent_at: new Date().toISOString(), recipient_count: 0 }).eq('id', claimed.id);
    return { ok: true, recipient_count: 0 };
  }
  const r = await sendCampaign(admin, claimed, siteUrl, null, { recipients });
  if (!r.ok && r.status !== 502) await admin.from('marketing_campaigns').update({ status: 'cancelled', rejection_reason: r.error }).eq('id', claimed.id);
  return r;
}

module.exports = { runVisitorNudge };
