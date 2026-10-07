// Email + phone checks (server side). The browser copy is /input-guard.js
// (UmzilaInput) — same rules, CHANGE BOTH TOGETHER.
//
// checkEmail(v)  → { ok, value (trimmed, lower-case), error?, suggestion? }
//   Rejects bad syntax and obvious typos of popular providers
//   ("gmail.comw", "gmial.com", "yahoo.con") with a suggested fix.
// checkPhone(v)  → { ok, value ('+27XXXXXXXXX'), pretty ('+27 83 123 4567'), error? }
//   South Africa is assumed: 083…, 83…, 27…, +27… and spaces/dashes all
//   become +27XXXXXXXXX. A number starting with + and another country code
//   is accepted as-is (8–15 digits). Obvious fakes (0000000, 1234567) fail.

// Providers people actually use here; a near-miss of one of these is a typo.
const POPULAR = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'live.com',
  'yahoo.co.za', 'webmail.co.za', 'mweb.co.za', 'vodamail.co.za', 'telkomsa.net', 'protonmail.com',
  'ukzn.ac.za', 'stu.ukzn.ac.za', 'dut4life.ac.za', 'dut.ac.za', 'mut.ac.za'];
// Real domains that happen to be one or two letters from a popular one.
const REAL = new Set(POPULAR.concat(['mail.com', 'ymail.com', 'email.com', 'me.com', 'mac.com', 'aol.com',
  'msn.com', 'gmx.com', 'gmx.net', 'zoho.com', 'proton.me', 'pm.me', 'yandex.com', 'rocketmail.com',
  'hotmail.co.za', 'outlook.co.za', 'live.co.za', 'yahoo.co.uk', 'hotmail.co.uk', 'live.co.uk',
  'outlook.co.uk', 'googlemail.com', 'icloud.co.za', 'iafrica.com', 'lantic.net', 'afrihost.co.za',
  'cybersmart.co.za', 'saol.com', 'unizulu.ac.za', 'ukzn.ac.za', 'wits.ac.za', 'uct.ac.za', 'up.ac.za']));
// Mistyped ".com" endings.
const BAD_COM = new Set(['con', 'cm', 'om', 'cmo', 'ocm', 'comw', 'comm', 'coom', 'cpm', 'cim', 'vom', 'xom',
  'comn', 'coms', 'cok', 'col', 'vcom', 'xcom', 'cc0m', 'c0m', 'clm', 'cin']);

function dist(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const m = []; for (let i = 0; i <= a.length; i++) m[i] = [i];
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) m[i][j] = Math.min(m[i][j], m[i - 2][j - 2] + 1);
  }
  return m[a.length][b.length];
}

function suggestDomain(domain) {
  if (REAL.has(domain)) return null;
  const labels = domain.split('.');
  const tld = labels[labels.length - 1];
  const base = labels.slice(0, -1).join('.');
  // gmail and icloud only ever end in .com
  if (/^(gmail|gmal|gmial|gmaill|gnail|gamil|gmai|gmali)$/.test(labels[0]) && labels.length >= 2) return 'gmail.com';
  if (labels[0] === 'icloud') return 'icloud.com';
  if (labels.length === 1) { // "gmail" with no ending
    const hit = POPULAR.find(p => p.split('.')[0] === domain);
    return hit || null;
  }
  if (BAD_COM.has(tld)) {
    const fixed = base + '.com';
    return REAL.has(fixed) ? fixed : (POPULAR.find(p => dist(p, fixed) <= 1) || fixed);
  }
  if (tld === 'coza' || domain.endsWith('.co.z') || domain.endsWith('.co.zaa') || domain.endsWith('.co.zs')) {
    return domain.replace(/\.(coza|co\.z|co\.zaa|co\.zs)$/, '.co.za');
  }
  // One slip anywhere, or two slips in the provider name with the right
  // ending (so real country domains like yahoo.ca are never "corrected").
  let best = null, bestD = 3;
  for (const p of POPULAR) {
    const d = dist(domain, p);
    if ((d === 1 || (d === 2 && p.split('.').pop() === tld)) && d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function checkEmail(raw) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase().replace(/\s+/g, '');
  if (!value) return { ok: false, value, error: 'Enter your email address.' };
  const at = value.lastIndexOf('@');
  if (at < 1 || value.indexOf('@') !== at) return { ok: false, value, error: 'That email is missing something — it should look like name@gmail.com.' };
  const local = value.slice(0, at), domain = value.slice(at + 1).replace(/\.+$/, '');
  const okLocal = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) && !/^\.|\.$|\.\./.test(local) && local.length <= 64;
  const okDomain = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/.test(domain) && domain.length <= 253;
  const sug = suggestDomain(domain);
  if (sug && sug !== domain) {
    const fix = local + '@' + sug;
    return { ok: false, value, suggestion: fix, error: `Check your email — did you mean ${fix}?` };
  }
  if (!okLocal || !okDomain) return { ok: false, value, error: 'That email doesn’t look right — it should look like name@gmail.com.' };
  return { ok: true, value: local + '@' + domain };
}

function checkPhone(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, value: '', error: 'Enter your phone number.' };
  if (/[a-z]/i.test(s)) return { ok: false, value: s, error: 'A phone number can only have digits, e.g. 083 123 4567.' };
  let d = s.replace(/\D/g, '');
  // '+44…' or '0044…' = another country; a plain 0… is always South African
  const intl = s.startsWith('+') || (/^00[1-9]/.test(d) && d.length >= 12);
  if (intl && !s.startsWith('+')) d = d.slice(2);
  if (intl && !d.startsWith('27')) {
    if (d.length >= 8 && d.length <= 15) return { ok: true, value: '+' + d, pretty: '+' + d };
    return { ok: false, value: s, error: 'That number doesn’t look right — check the digits.' };
  }
  if (d.startsWith('27') && d.length >= 11) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  if (!/^[1-8]\d{8}$/.test(d)) {
    return { ok: false, value: s, error: d.length < 9 ? 'That number is too short — SA numbers have 10 digits, e.g. 083 123 4567.' : d.length > 9 ? 'That number is too long — SA numbers have 10 digits, e.g. 083 123 4567.' : 'Enter a valid South African number, e.g. 083 123 4567.' };
  }
  const tail = d.slice(2);
  if (/^(\d)\1{6}$/.test(tail) || '01234567890'.includes(tail) || '98765432109'.includes(tail)) {
    return { ok: false, value: s, error: 'That number doesn’t look real — please use your actual number.' };
  }
  return { ok: true, value: '+27' + d, pretty: `+27 ${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5)}` };
}

module.exports = { checkEmail, checkPhone };
