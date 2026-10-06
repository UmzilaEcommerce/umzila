// Who every Umzila email is sent from (Resend). Two verified sending
// subdomains (DKIM + SPF), kept apart on purpose:
//   mail.umzila.store — transactional: orders, delivery, PINs, sellers,
//                       back-in-stock, mystery gift, referrals
//   news.umzila.store — marketing: campaigns, admin promos, basket nudges
// so spam complaints on a promo can never hurt order/PIN emails, and both
// stay apart from the main umzila.store domain. Neither subdomain has an
// inbox, so every email carries a reply-to: the Umzila inbox the founder
// reads (umzilaecommerce@gmail.com — founder 2026-10-06).
// Override with Netlify env MAIL_DOMAIN / NEWS_DOMAIN / MAIL_REPLY_TO.
const MAIL_DOMAIN = (process.env.MAIL_DOMAIN || 'mail.umzila.store').trim();
const NEWS_DOMAIN = (process.env.NEWS_DOMAIN || 'news.umzila.store').trim();
const REPLY_TO = (process.env.MAIL_REPLY_TO || 'umzilaecommerce@gmail.com').trim();

// mailFrom('Umzila', 'orders')          → Umzila <orders@mail.umzila.store>
// mailFrom('Umzila', 'promos', 'news')  → Umzila <promos@news.umzila.store>
function mailFrom(name, local, stream) {
  const domain = stream === 'news' ? NEWS_DOMAIN : MAIL_DOMAIN;
  return { from: `${name} <${local}@${domain}>`, reply_to: REPLY_TO };
}

module.exports = { mailFrom, MAIL_DOMAIN, NEWS_DOMAIN, REPLY_TO };
