// Email link tags for People (admin → Intelligence → People, docs/systems/people.md).
// Every link to the site in a marketing / gift / promo email gets ?ut=<tag>:
// the recipient's email encrypted (AES-256-GCM, key derived from
// UNSUBSCRIBE_SECRET with its own "visitor:" label), so the link itself never
// shows the email and can't be forged.
// presence.js sends the tag to identify-visitor.js, which decrypts it and links
// that browser (site_browsers) to the email, then removes ?ut from the address
// bar so a shared link doesn't carry it on.
const crypto = require('crypto');

const b64 = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const norm = e => String(e || '').toLowerCase().trim();
const key = () => crypto.createHash('sha256').update('visitor:' + (process.env.UNSUBSCRIBE_SECRET || '')).digest();

function visitorTag(email) {
  const e = norm(email);
  if (!e || !process.env.UNSUBSCRIBE_SECRET) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(e, 'utf8'), c.final()]);
  return b64(Buffer.concat([iv, c.getAuthTag(), body]));
}

// → the email, or null when the tag is missing / forged.
function readVisitorTag(tag) {
  if (!process.env.UNSUBSCRIBE_SECRET || !/^[A-Za-z0-9_-]{40,600}$/.test(String(tag || ''))) return null;
  try {
    const raw = unb64(tag);
    const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const email = norm(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
  } catch (err) { return null; }
}

// Adds ut=<tag> to every href pointing at the site (SITE_BASE_URL host),
// except function links (unsubscribe, rating…). Leaves other links alone.
function tagLinks(html, email, siteUrl) {
  const tag = visitorTag(email);
  let host;
  try { host = new URL(siteUrl || process.env.SITE_BASE_URL || '').host; } catch (e) { return html; }
  if (!tag || !host || typeof html !== 'string') return html;
  return html.replace(/href="(https?:\/\/[^"]+)"/g, (whole, raw) => {
    try {
      const u = new URL(raw.replace(/&amp;/g, '&'));
      if (u.host !== host || u.pathname.startsWith('/.netlify/')) return whole;
      u.searchParams.set('ut', tag);
      return `href="${u.toString().replace(/&/g, '&amp;')}"`;
    } catch (e) { return whole; }
  });
}

module.exports = { visitorTag, readVisitorTag, tagLinks };
