/* umzila-wa.js — every "WhatsApp Umzila" button on the buyer pages.
 *
 * Any link to Umzila's support number (wa.me/27797662768) is handled here on click:
 *  - the message says who is writing ("Hi Umzila, it's Khwezi! …") when the
 *    browser knows their first name: a name typed anywhere on Umzila
 *    (localStorage umz_guest_contact, presence.js umzilaGuestContact), a page
 *    hint (UmzilaWA.setName — track.html uses the order's name, profile.html the
 *    account's) or the signed-in Supabase session's metadata;
 *  - otherwise a slim one-line "Who's chatting?" bar asks for a first name once
 *    (Enter / → opens WhatsApp, "Skip" opens it without). The name is remembered
 *    via umzilaGuestContact so it links this browser in admin → People too.
 * Order links must carry the ORDER NUMBER (orders.order_number, UMZILA-…), never
 * the order's uuid — put it in the text or in data-wa-order.
 * No keys, no network calls.
 */
(function () {
  'use strict';
  var NUMBER = '27797662768';
  var NAME_KEY = 'umz_guest_contact';
  var SKIP_KEY = 'umz_wa_skip';
  var hinted = '';

  function clean(n) {
    n = String(n || '').trim().split(/\s+/)[0] || '';
    n = n.replace(/[^\p{L}'\-]/gu, '').slice(0, 30);
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : '';
  }
  function fromContact() {
    try { var c = JSON.parse(localStorage.getItem(NAME_KEY) || 'null'); return clean(c && c.name); } catch (e) { return ''; }
  }
  function fromSession() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!/^sb-.*-auth-token$/.test(k)) continue;
        var s = JSON.parse(localStorage.getItem(k) || 'null');
        var m = s && (s.user || (s.currentSession && s.currentSession.user)) && (s.user || s.currentSession.user).user_metadata;
        var n = m && (m.first_name || m.full_name || m.name);
        if (n) return clean(n);
      }
    } catch (e) {}
    return '';
  }
  function knownName() { return clean(hinted) || fromContact() || fromSession(); }

  function remember(name) {
    if (typeof window.umzilaGuestContact === 'function') { window.umzilaGuestContact({ name: name }); return; }
    try {
      var c = JSON.parse(localStorage.getItem(NAME_KEY) || 'null') || {};
      c.name = name; localStorage.setItem(NAME_KEY, JSON.stringify(c));
    } catch (e) {}
  }

  // "Hi Umzila! I need help…" → "Hi Umzila, it's Khwezi! I need help…"
  function withName(text, name) {
    text = String(text || 'Hi Umzila!');
    if (!name || text.indexOf("it's " + name) >= 0) return text;
    if (/^\s*Hi Umzila!?/i.test(text)) return text.replace(/^\s*Hi Umzila!?/i, "Hi Umzila, it's " + name + '!');
    return "Hi Umzila, it's " + name + '! ' + text;
  }
  function url(text) { return 'https://wa.me/' + NUMBER + '?text=' + encodeURIComponent(text); }
  function go(text, name) {
    var w = window.open(url(withName(text, name)), '_blank', 'noopener');
    if (!w) location.href = url(withName(text, name));
  }

  // ---------- the "Who's chatting?" bar ----------
  var CSS = '.uwa-bar{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translate(-50%,140%);z-index:2147483000;' +
    'width:min(440px,calc(100vw - 24px));background:#fff;border-radius:999px;box-shadow:0 12px 40px rgba(15,23,42,.22),0 0 0 1px rgba(15,23,42,.06);' +
    'display:flex;align-items:center;gap:8px;padding:6px 6px 6px 16px;transition:transform .28s cubic-bezier(.2,.9,.3,1.2);font-family:inherit}' +
    '.uwa-bar.on{transform:translate(-50%,0)}' +
    '.uwa-ic{flex:none;width:22px;height:22px;color:#25d366}' +
    '.uwa-in{flex:1;min-width:0;border:0;outline:0;background:transparent;font:inherit;font-size:16px;color:#0f172a;padding:8px 0}' +
    '.uwa-in::placeholder{color:#94a3b8}' +
    '.uwa-go{flex:none;border:0;border-radius:999px;background:#25d366;color:#fff;font:inherit;font-weight:700;font-size:15px;height:40px;padding:0 16px;cursor:pointer;display:flex;align-items:center;gap:6px}' +
    '.uwa-go:active{transform:scale(.97)}' +
    '.uwa-skip{flex:none;border:0;background:transparent;color:#64748b;font:inherit;font-size:13px;font-weight:600;cursor:pointer;padding:8px 6px}' +
    '@media (prefers-reduced-motion:reduce){.uwa-bar{transition:none}}';
  var bar = null, pendingText = '';
  function ensureBar() {
    if (bar) return bar;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    bar = document.createElement('form');
    bar.className = 'uwa-bar'; bar.setAttribute('role', 'dialog'); bar.setAttribute('aria-label', 'Your first name for WhatsApp');
    bar.innerHTML = '<svg class="uwa-ic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.05 2a9.9 9.9 0 0 0-8.5 14.95L2 22l5.2-1.5A9.9 9.9 0 1 0 12.05 2Zm0 18.1a8.2 8.2 0 0 1-4.2-1.15l-.3-.18-3.1.9.9-3-.2-.32a8.2 8.2 0 1 1 6.9 3.75Zm4.5-6.1c-.25-.12-1.47-.72-1.7-.8-.22-.09-.39-.13-.55.12-.17.25-.64.8-.78.96-.14.17-.29.19-.54.06a6.7 6.7 0 0 1-3.3-2.9c-.25-.43.25-.4.71-1.33.08-.16.04-.3-.02-.43-.06-.12-.55-1.33-.76-1.82-.2-.48-.4-.41-.55-.42h-.47a.9.9 0 0 0-.65.3 2.7 2.7 0 0 0-.85 2.02 4.7 4.7 0 0 0 1 2.5 10.8 10.8 0 0 0 4.13 3.65c1.54.66 2.14.72 2.9.6.47-.07 1.47-.6 1.67-1.18.2-.58.2-1.08.15-1.18-.06-.1-.22-.17-.47-.29Z"/></svg>' +
      '<input class="uwa-in" name="n" placeholder="Your first name, so we know who’s chatting" autocomplete="given-name" autocapitalize="words" enterkeyhint="go" maxlength="30">' +
      '<button type="button" class="uwa-skip">Skip</button>' +
      '<button type="submit" class="uwa-go" aria-label="Open WhatsApp">Chat →</button>';
    document.body.appendChild(bar);
    var input = bar.querySelector('.uwa-in');
    bar.addEventListener('submit', function (e) {
      e.preventDefault();
      var n = clean(input.value);
      if (!n) { input.focus(); input.placeholder = 'Just your first name — or tap Skip'; return; }
      remember(n); hide(); go(pendingText, n);
    });
    bar.querySelector('.uwa-skip').addEventListener('click', function () {
      try { sessionStorage.setItem(SKIP_KEY, '1'); } catch (e) {}
      hide(); go(pendingText, '');
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && bar.classList.contains('on')) hide(); });
    document.addEventListener('pointerdown', function (e) { if (bar.classList.contains('on') && !bar.contains(e.target) && !(e.target.closest && e.target.closest('a[href*="wa.me/' + NUMBER + '"]'))) hide(); });
    return bar;
  }
  function show(text) {
    pendingText = text; ensureBar();
    bar.querySelector('.uwa-in').value = '';
    requestAnimationFrame(function () { bar.classList.add('on'); setTimeout(function () { try { bar.querySelector('.uwa-in').focus({ preventScroll: true }); } catch (e) {} }, 120); });
  }
  function hide() { if (bar) bar.classList.remove('on'); }

  function textOf(a) {
    var t = '';
    try { t = new URL(a.href).searchParams.get('text') || ''; } catch (e) {}
    var ord = a.getAttribute('data-wa-order');
    if (ord && t.indexOf(ord) < 0) t = (t || 'Hi Umzila! I need help with my order.').replace(/\.?\s*$/, '') + ' (order #' + ord + ').';
    return t || 'Hi Umzila!';
  }

  function open(text) {
    var n = knownName();
    var skipped = false; try { skipped = sessionStorage.getItem(SKIP_KEY) === '1'; } catch (e) {}
    if (n || skipped) go(text, n); else show(text);
  }

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href*="wa.me/' + NUMBER + '"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    open(textOf(a));
  }, true);

  window.UmzilaWA = {
    setName: function (n) { hinted = n || ''; },
    open: open,          // UmzilaWA.open('Hi Umzila! I need help with order #UMZILA-…')
    url: function (text) { return url(withName(text, knownName())); },
    name: knownName
  };
})();
