// netlify/functions/lib/campaign-send.js
//
// Sends one marketing_campaigns row to every marketing-eligible subscriber.
// Used by admin-manage-marketing.js (approve = send now) and
// send-scheduled-campaigns.js (scheduled_for reached). The row must already be
// claimed by the caller (status 'sending' or 'approved') so it can't go twice.
// Mass sends only reach opted_in / soft_opt_in, never unsubscribed, and every
// email carries the unsubscribe link + headers and the People link tag.
const { mailFrom } = require('./mail');
const { renderMarketingEmail } = require('./marketing-template');
const { unsubscribeUrl: makeUnsubUrl, unsubscribeHeaders } = require('./unsubscribe');
const { tagLinks } = require('./visitor-tag');

function chunk(arr, size) { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }

// The template's slots for a campaign row (shared with the previews).
function slotsFor(campaign, siteUrl, unsubscribeUrl) {
  const shopName = campaign.sellers ? campaign.sellers.shop_name : null;
  return {
    headline: campaign.headline, bodyMessage: campaign.body_message, ctaText: campaign.cta_text,
    ctaUrl: `${siteUrl}${campaign.cta_path || '/'}`, shopName,
    codeRow: campaign.discount_codes || null, sellerShopName: shopName,
    imageUrl: campaign.image_url, eyebrow: campaign.eyebrow, urgency: campaign.urgency,
    highlights: campaign.highlights, offerPrice: campaign.offer_price, offerWas: campaign.offer_was,
    siteUrl, unsubscribeUrl
  };
}

// opts.recipients: send to this list instead of every subscriber (the daily lunch reminder,
// lib/visitor-nudge.js) — unsubscribed people are still always left out.
// campaign.audience 'baskets': everyone with an unfinished basket who left an email
// (campaign_basket_recipients(), admin → Marketing → Platform Campaign → Send to).
async function sendCampaign(admin, campaign, siteUrl, approverId, opts = {}) {
  const RESEND_KEY = process.env.RESEND_API_KEY || '';
  if (!RESEND_KEY) return { ok: false, status: 500, error: 'Email service not configured' };

  let list;
  if (!Array.isArray(opts.recipients) && campaign.audience === 'baskets') {
    const { data: rows, error: bErr } = await admin.rpc('campaign_basket_recipients');
    if (bErr) return { ok: false, status: 500, error: bErr.message };
    opts = Object.assign({}, opts, { recipients: (rows || []).map(r => r.email) });
  }
  if (Array.isArray(opts.recipients)) {
    const { data: unsub, error: uErr } = await admin.from('subscribers').select('email').eq('unsubscribed', true);
    if (uErr) return { ok: false, status: 500, error: uErr.message };
    const out = new Set((unsub || []).map(s => (s.email || '').toLowerCase().trim()));
    list = opts.recipients.map(e => String(e || '').toLowerCase().trim()).filter(e => !out.has(e));
  } else {
    const { data: subs, error: subsErr } = await admin.from('subscribers').select('email')
      .eq('unsubscribed', false).in('consent', ['opted_in', 'soft_opt_in']);
    if (subsErr) return { ok: false, status: 500, error: subsErr.message };
    list = (subs || []).map(s => (s.email || '').toLowerCase().trim());
  }
  const seen = new Set();
  const recipients = list.filter(e => e && e.includes('@') && !seen.has(e) && seen.add(e));
  if (!recipients.length) return { ok: false, status: 400, error: campaign.audience === 'baskets' ? 'Nobody with a basket to send to.' : 'No subscribers to send to.' };

  for (const batch of chunk(recipients, 100)) {
    const payload = batch.map(email => {
      const unsubscribeUrl = makeUnsubUrl(siteUrl, email);
      const html = renderMarketingEmail(slotsFor(campaign, siteUrl, unsubscribeUrl));
      return { ...mailFrom('Umzila', 'promos', 'news'), to: [email], subject: campaign.subject, html: tagLinks(html, email, siteUrl), headers: unsubscribeHeaders(unsubscribeUrl) };
    });
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.error('campaign-send: Resend batch error', res.status, await res.text());
      return { ok: false, status: 502, error: 'Email send failed partway through — please check Resend before retrying.' };
    }
  }
  const now = new Date().toISOString();
  const upd = { status: 'sent', sent_at: now, recipient_count: recipients.length, updated_at: now };
  if (approverId) { upd.approved_by = approverId; upd.approved_at = now; }
  const { error: updErr } = await admin.from('marketing_campaigns').update(upd).eq('id', campaign.id);
  if (updErr) return { ok: false, status: 500, error: updErr.message };
  return { ok: true, recipient_count: recipients.length };
}

module.exports = { sendCampaign, slotsFor };
