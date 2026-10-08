// Marketing-email unsubscribe links (one place for every marketing sender).
// The link is on the site's own domain (SITE_BASE_URL/.netlify/functions/
// unsubscribe) — never a mailto to another domain (Resend flags mismatched
// link domains as spam-like). `t` is an HMAC of the email with
// UNSUBSCRIBE_SECRET (Netlify env), so a link can't unsubscribe anyone else.
// unsubscribe.js verifies it and sets subscribers.unsubscribed.
//
// unsubscribeHeaders() adds RFC 8058 one-click headers, so Gmail / Apple Mail
// show their own "Unsubscribe" button (they POST to the same URL).
const crypto = require('crypto');

function signUnsubscribe(email) {
  const secret = process.env.UNSUBSCRIBE_SECRET || '';
  return crypto.createHmac('sha256', secret).update(String(email || '').toLowerCase().trim()).digest('hex');
}

function unsubscribeUrl(siteUrl, email) {
  const base = String(siteUrl || process.env.SITE_BASE_URL || '').replace(/\/$/, '');
  return `${base}/.netlify/functions/unsubscribe?e=${encodeURIComponent(String(email || '').toLowerCase().trim())}&t=${signUnsubscribe(email)}`;
}

function unsubscribeHeaders(url) {
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

module.exports = { signUnsubscribe, unsubscribeUrl, unsubscribeHeaders };
