// Who every Umzila email is sent from (Resend).
// Sending goes through the dedicated subdomain mail.umzila.store (verified in
// Resend: DKIM + SPF), so the main umzila.store domain's reputation is kept
// apart from bulk/automated mail. Replies still go to the same @umzila.store
// address as before (reply_to), because the sending subdomain has no inbox.
// Override with Netlify env MAIL_DOMAIN / MAIL_REPLY_DOMAIN if that changes.
const MAIL_DOMAIN = (process.env.MAIL_DOMAIN || 'mail.umzila.store').trim();
const REPLY_DOMAIN = (process.env.MAIL_REPLY_DOMAIN || 'umzila.store').trim();

// mailFrom('Umzila', 'orders') → { from: 'Umzila <orders@mail.umzila.store>', reply_to: 'orders@umzila.store' }
function mailFrom(name, local) {
  return { from: `${name} <${local}@${MAIL_DOMAIN}>`, reply_to: `${local}@${REPLY_DOMAIN}` };
}

module.exports = { mailFrom, MAIL_DOMAIN, REPLY_DOMAIN };
