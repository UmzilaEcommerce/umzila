/* announce.js — the site pop-up (e.g. "Black Friday: everything 10% off at Isiqalo").
   Settings = public.site_settings key 'announcement' (admin.html → Marketing → Site pop-up),
   served with the home catalogue by get-catalog.js and with each store by get-store.js
   (`announcement`, + version = last save). Where: the home page unless show_on_home = false,
   and the store pages listed in store_slugs (shop.html calls UmzilaAnnounce.show(a, 'store:<slug>');
   there a button linking to that same store just closes the pop-up). Shows once per browser per page per day (localStorage umz_ann_seen = version|SAST day); a re-save in
   admin shows it again. While it is open window.umzAnnounceOpen is true so the mystery-gift
   pop-up waits its turn. No-op when switched off, outside starts_at/ends_at, or on any error. */
(function () {
  'use strict';
  var KEY = 'umz_ann_seen';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var safeUrl = function (u) { u = String(u || '').trim(); return /^\/(?!\/)/.test(u) || /^https:\/\//i.test(u) ? u : ''; };
  var day = function () { return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }); };

  function shouldShow(a, page) {
    if (!a || a.enabled !== true || !a.title) return false;
    if (page === 'home' ? a.show_on_home === false : !(Array.isArray(a.store_slugs) && a.store_slugs.indexOf(String(page).slice(6)) !== -1)) return false;
    var now = Date.now();
    if (a.starts_at && new Date(a.starts_at).getTime() > now) return false;
    if (a.ends_at && new Date(a.ends_at).getTime() <= now) return false;
    if (navigator.webdriver) return false;
    try { if (localStorage.getItem(KEY + ':' + page) === a.version + '|' + day()) return false; } catch (e) {}
    return true;
  }

  function endsLabel(a) {
    if (!a.ends_at) return '';
    var d = new Date(a.ends_at), left = d.getTime() - Date.now();
    if (left <= 0) return '';
    if (left < 864e5) { var h = Math.floor(left / 36e5), m = Math.floor(left % 36e5 / 6e4); return 'Ends in ' + (h ? h + 'h ' : '') + m + 'm'; }
    return 'Ends ' + d.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'short', day: 'numeric', month: 'short' });
  }

  var CSS = '' +
    '.uan{position:fixed;inset:0;z-index:10050;display:flex;align-items:flex-end;justify-content:center;background:rgba(5,6,8,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);opacity:0;transition:opacity .25s ease}' +
    '.uan.in{opacity:1}' +
    '.uan-card{position:relative;width:100%;max-width:440px;max-height:92dvh;overflow:auto;background:#0b0b0e;color:#fff;border-radius:26px 26px 0 0;box-shadow:0 -10px 60px rgba(0,0,0,.5);transform:translateY(40px);transition:transform .35s cubic-bezier(.2,.8,.2,1);font-family:inherit;padding-bottom:env(safe-area-inset-bottom)}' +
    '.uan.in .uan-card{transform:none}' +
    '@media(min-width:700px){.uan{align-items:center}.uan-card{border-radius:26px;box-shadow:0 30px 80px rgba(0,0,0,.55)}}' +
    '.uan-hero{position:relative;height:210px;overflow:hidden;background:#141418}' +
    '.uan-hero img{width:100%;height:100%;object-fit:cover;display:block;transform:scale(1.04)}' +
    '.uan-hero:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(11,11,14,0) 35%,#0b0b0e 100%)}' +
    '.uan-x{position:absolute;top:12px;right:12px;z-index:2;width:38px;height:38px;border-radius:50%;border:0;background:rgba(0,0,0,.55);color:#fff;font-size:22px;line-height:38px;cursor:pointer;backdrop-filter:blur(4px)}' +
    '.uan-body{position:relative;padding:4px 24px 24px;margin-top:-46px;z-index:1}' +
    '.uan-kick{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#fff;background:#e11d2e;padding:6px 12px;border-radius:999px}' +
    '.uan-kick i{width:7px;height:7px;border-radius:50%;background:#fff;animation:uanP 1.4s ease-in-out infinite}' +
    '@keyframes uanP{50%{opacity:.25}}' +
    '.uan-t{margin:14px 0 6px;font-size:34px;line-height:1.02;font-weight:900;letter-spacing:-.02em}' +
    '.uan-t em{font-style:normal;color:#ff3b4a}' +
    '.uan-p{margin:0 0 10px;font-size:15.5px;line-height:1.45;color:#d6d6dc}' +
    '.uan-note{display:flex;gap:8px;align-items:flex-start;margin:0 0 18px;font-size:13px;color:#a3a3ad}' +
    '.uan-cta{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;box-sizing:border-box;padding:15px 18px;border-radius:14px;background:#e11d2e;color:#fff;font-size:16px;font-weight:800;text-decoration:none;border:0;cursor:pointer;box-shadow:0 10px 30px rgba(225,29,46,.35)}' +
    '.uan-cta:hover{background:#c81626}' +
    '.uan-later{display:block;width:100%;margin-top:8px;padding:10px;border:0;background:none;color:#9a9aa5;font-size:14px;cursor:pointer}' +
    '.uan-ends{display:inline-block;margin-left:8px;font-size:12px;font-weight:700;color:#ffb4ba;letter-spacing:.02em}' +
    '@media(prefers-reduced-motion:reduce){.uan,.uan-card{transition:none}.uan-kick i{animation:none}}';

  function open(a, page) {
    page = page || 'home';
    if (document.getElementById('uanRoot')) return;
    if (!document.getElementById('uanCss')) { var st = document.createElement('style'); st.id = 'uanCss'; st.textContent = CSS; document.head.appendChild(st); }
    var link = safeUrl(a.link), img = safeUrl(a.image), ends = endsLabel(a);
    // already on the page the button points to (e.g. the Isiqalo store) → the button just closes
    var here = link && link.charAt(0) === '/' && link.replace(/\/+$/, '').toLowerCase() === location.pathname.replace(/\/+$/, '').toLowerCase();
    var ctaText = here ? (a.store_cta_text || 'Start shopping') : (a.cta_text || 'Shop now');
    // *word* in the title is shown in red, e.g. "Everything *10% off*"
    var title = esc(a.title).replace(/\*([^*]+)\*/g, '<em>$1</em>');
    var root = document.createElement('div');
    root.className = 'uan'; root.id = 'uanRoot';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'uanT');
    root.innerHTML = '<div class="uan-card">' +
      (img ? '<div class="uan-hero"><img src="' + esc(img) + '" alt=""></div>' : '<div style="height:58px"></div>') +
      '<button class="uan-x" type="button" aria-label="Close">×</button>' +
      '<div class="uan-body">' +
        (a.kicker ? '<span class="uan-kick"><i></i>' + esc(a.kicker) + '</span>' : '') +
        (ends ? '<span class="uan-ends">' + esc(ends) + '</span>' : '') +
        '<h2 class="uan-t" id="uanT">' + title + '</h2>' +
        (a.body ? '<p class="uan-p">' + esc(a.body) + '</p>' : '') +
        (a.note ? '<p class="uan-note"><span>ⓘ</span><span>' + esc(a.note) + '</span></p>' : '') +
        (here ? '<button class="uan-cta" type="button">' + esc(ctaText) + ' <span aria-hidden="true">→</span></button>' : link ? '<a class="uan-cta" href="' + esc(link) + '">' + esc(ctaText) + ' <span aria-hidden="true">→</span></a>' : '') +
        '<button class="uan-later" type="button">Maybe later</button>' +
      '</div></div>';
    document.body.appendChild(root);
    window.umzAnnounceOpen = true;
    var prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(function () { root.classList.add('in'); });
    var close = function () {
      try { localStorage.setItem(KEY + ':' + page, a.version + '|' + day()); } catch (e) {}
      root.classList.remove('in');
      document.removeEventListener('keydown', onKey);
      setTimeout(function () { root.remove(); document.body.style.overflow = prevOverflow; window.umzAnnounceOpen = false; }, 260);
    };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    root.addEventListener('click', function (e) { if (e.target === root) close(); });
    root.querySelector('.uan-x').onclick = close;
    root.querySelector('.uan-later').onclick = close;
    var cta = root.querySelector('.uan-cta');
    if (here && cta) cta.onclick = close;
    else if (cta) cta.addEventListener('click', function () {
      try { localStorage.setItem(KEY + ':' + page, a.version + '|' + day()); } catch (e) {}
      if (window.umzilaTrack) try { umzilaTrack('announcement_click', { metadata: { link: link } }); } catch (e) {}
    });
  }

  async function start() {
    try {
      var cat = (typeof catalogPromise !== 'undefined') ? await catalogPromise : null;
      var a = cat && cat.announcement;
      var sb = (typeof supabaseClient !== 'undefined' && supabaseClient) || null;
      if (!a && sb) {
        var r = await sb.from('site_settings').select('value, updated_at').eq('key', 'announcement').maybeSingle();
        if (r && r.data) a = Object.assign({}, r.data.value, { version: r.data.updated_at });
      }
      if (shouldShow(a, 'home')) setTimeout(function () { open(a, 'home'); }, 1200);
    } catch (e) { /* the pop-up is never worth breaking the page */ }
  }
  window.UmzilaAnnounce = {
    preview: function (a) { open(Object.assign({ version: 'preview' }, a), 'preview'); },
    // store pages: show as soon as they land (if this store is ticked in admin)
    show: function (a, page) { try { if (shouldShow(a, page)) setTimeout(function () { open(a, page); }, 500); } catch (e) {} }
  };
  if (window.UMZ_ANNOUNCE_MANUAL) return; // admin.html: preview only
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
