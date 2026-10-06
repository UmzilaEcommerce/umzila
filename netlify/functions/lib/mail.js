// Who every Umzila email is sent from (Resend).
// Sending goes through the dedicated subdomain mail.umzila.store (verified in
// Resend: DKIM + SPF), so the main umzila.store domain's reputation is kept
// apart from bulk/automated mail. The sending subdomain has no inbox, so every
// email carries a reply-to: the Umzila inbox the founder actually reads
// (umzilaecommerce@gmail.com — founder 2026-10-06). Override with Netlify env
// MAIL_DOMAIN / MAIL_REPLY_TO if either changes.
const MAIL_DOMAIN = (process.env.MAIL_DOMAIN || 'mail.umzila.store').trim();
const REPLY_TO = (process.env.MAIL_REPLY_TO || 'umzilaecommerce@gmail.com').trim();

// mailFrom('Umzila', 'orders') → { from: 'Umzila <orders@mail.umzila.store>', reply_to: 'umzilaecommerce@gmail.com' }
function mailFrom(name, local) {
  return { from: `${name} <${local}@${MAIL_DOMAIN}>`, reply_to: REPLY_TO };
}

module.exports = { mailFrom, MAIL_DOMAIN, REPLY_TO };
