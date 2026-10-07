// input-guard.js — checks every email + phone box on Umzila (UmzilaInput).
// The rules below are a COPY of netlify/functions/lib/contact-check.js —
// change both together (the server re-checks; this copy gives instant hints).
(function () {
  if (window.UmzilaInput) return;
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

  // ---------- browser UI ----------
  // Every <input type="email">, <input type="tel"> and [data-guard="email"|"phone"]
  // on the page (including ones added later) gets checked when the visitor
  // leaves the box: emails are lower-cased and typo-checked ("Did you mean
  // …@gmail.com? Use it"), phones become +27 83 123 4567. A wrong box gets a
  // red hint and setCustomValidity, and UmzilaInput.ok(el) lets a submit
  // handler stop + focus it. data-guard="off" opts a box out.
  var CSS = '.ug-bad{border-color:#dc2626!important;box-shadow:0 0 0 3px rgba(220,38,38,.12)!important}' +
    '.ug-hint{display:block;margin:6px 0 2px;font-size:13px;line-height:1.4;color:#b91c1c;font-weight:500;text-align:left}' +
    '.ug-hint button{margin-left:6px;padding:3px 10px;border:0;border-radius:999px;background:#b91c1c;color:#fff;font:inherit;font-size:12px;font-weight:700;cursor:pointer}';

  function kindOf(el) {
    if (!el || el.tagName !== 'INPUT') return null;
    var g = el.getAttribute('data-guard');
    if (g === 'off') return null;
    if (g === 'email' || g === 'phone') return g;
    if (el.type === 'email') return 'email';
    if (el.type === 'tel') return 'phone';
    return null;
  }
  function hintFor(el, create) {
    var id = el.getAttribute('data-ug-hint');
    var h = id && document.getElementById(id);
    if (h || !create) return h;
    h = document.createElement('div');
    h.className = 'ug-hint'; h.setAttribute('role', 'alert');
    h.id = 'ug' + Math.random().toString(36).slice(2, 9);
    el.setAttribute('data-ug-hint', h.id);
    // input sitting in a row with its button → put the hint under the row
    var p = el.parentNode, anchor = el;
    try {
      var cs = p && getComputedStyle(p);
      if (cs && /flex/.test(cs.display) && !/column/.test(cs.flexDirection)) anchor = p;
    } catch (e) {}
    anchor.parentNode.insertBefore(h, anchor.nextSibling);
    return h;
  }
  function clear(el) {
    el.classList.remove('ug-bad');
    el.removeAttribute('aria-invalid');
    try { el.setCustomValidity(''); } catch (e) {}
    var h = hintFor(el, false); if (h) h.remove();
    el.removeAttribute('data-ug-hint');
  }
  function show(el, r) {
    clear(el);
    el.classList.add('ug-bad');
    el.setAttribute('aria-invalid', 'true');
    try { el.setCustomValidity(r.error); } catch (e) {}
    var h = hintFor(el, true);
    h.textContent = r.error;
    if (r.suggestion) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = 'Use it';
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () {
        el.value = r.suggestion; clear(el);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      h.appendChild(b);
    }
  }
  // Check one box: tidies its value, shows/clears the hint. Empty + not
  // required = fine (the page decides whether the field is required).
  function check(el, opts) {
    var k = kindOf(el) || (opts && opts.kind);
    if (!k) return { ok: true, value: el.value };
    var raw = el.value;
    if (!String(raw).trim() && !(opts && opts.required)) { clear(el); return { ok: true, value: '' }; }
    var r = k === 'email' ? checkEmail(raw) : checkPhone(raw);
    if (r.ok) {
      var shown = k === 'phone' ? r.pretty : r.value;
      if (el.value !== shown && !el.readOnly) el.value = shown;
      clear(el);
    } else if (!(opts && opts.silent)) {
      show(el, r);
    }
    return r;
  }
  // For submit handlers: returns the clean value (email lower-case,
  // phone +27XXXXXXXXX) or null after showing the problem and focusing it.
  function ok(el, opts) {
    if (!el) return null;
    var r = check(el, Object.assign({ required: true }, opts || {}));
    if (r.ok) return r.value;
    try { el.focus({ preventScroll: false }); } catch (e) { el.focus(); }
    return null;
  }

  function wire(root) {
    var list = (root.querySelectorAll ? root.querySelectorAll('input') : []);
    for (var i = 0; i < list.length; i++) {
      var el = list[i], k = kindOf(el);
      if (!k || el.__ug) continue;
      el.__ug = true;
      if (k === 'phone') { el.setAttribute('inputmode', 'tel'); if (!el.getAttribute('autocomplete')) el.setAttribute('autocomplete', 'tel'); }
      if (k === 'email') { el.setAttribute('autocapitalize', 'off'); el.setAttribute('spellcheck', 'false'); if (!el.getAttribute('autocomplete')) el.setAttribute('autocomplete', 'email'); }
      el.addEventListener('blur', function () { check(this); });
      el.addEventListener('input', function () { if (this.classList.contains('ug-bad')) clear(this); });
    }
  }

  window.UmzilaInput = { checkEmail: checkEmail, checkPhone: checkPhone, check: check, ok: ok, clear: clear };

  function start() {
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    wire(document);
    try {
      new MutationObserver(function (ms) {
        for (var i = 0; i < ms.length; i++) for (var j = 0; j < ms[i].addedNodes.length; j++) {
          var n = ms[i].addedNodes[j]; if (n.nodeType !== 1) continue;
          if (n.tagName === 'INPUT') wire(n.parentNode || document); else wire(n);
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
