// Live visitor heartbeat for admin's "On the site now" counter, plus
// umzilaTrack() (below) for behaviour events on pages without script.js.
// Each page calls umzilaPresence.start(supabaseClient, '<page label>') once its
// client exists. One anonymous id per browser (localStorage), a heartbeat about
// once a minute while the tab is visible (touch_presence RPC; signed-in visitors
// are linked by their session token server-side). Never blocks or breaks a
// page: every failure is ignored.
(function () {
  var KEY = 'umz_presence_id', BEAT_MS = 60000, MIN_GAP_MS = 15000;
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  var sid;
  try { sid = localStorage.getItem(KEY); if (!sid) { sid = newId(); localStorage.setItem(KEY, sid); } }
  catch (e) { sid = newId(); }

  var client = null, page = 'home', last = 0, timer = null;
  function beat(force) {
    if (!client || document.visibilityState === 'hidden') return;
    var now = Date.now();
    if (!force && now - last < MIN_GAP_MS) return;
    last = now;
    try {
      client.rpc('touch_presence', { p_session: sid, p_page: page }).then(function () {}, function () {});
    } catch (e) { /* ignore */ }
  }
  window.umzilaPresence = {
    start: function (sb, label) {
      if (!sb || typeof sb.rpc !== 'function') return;
      var first = !client;
      client = sb; if (label) page = String(label).slice(0, 60);
      beat(true);
      if (!first) return;
      timer = setInterval(function () { beat(false); }, BEAT_MS);
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') beat(false); });
    },
    // A page that changes what it shows (e.g. a product opened) can relabel itself.
    page: function (label) { if (label && label !== page) { page = String(label).slice(0, 60); beat(true); } }
  };

  // Behaviour events from pages without script.js (store pages, bespoke
  // storefronts) — same user_events rows and anonymous id (ss_anon_id) as
  // script.js trackEvent, so admin analytics see store visitors too.
  // Product clicks / add-to-carts go ONLY through track-engagement.js (it
  // logs the event and bumps the product counters — logging them here as well
  // would count them twice). Fire-and-forget; never throws.
  var COUNTER_EVENTS = { product_click: 1, product_view: 1, add_to_cart: 1 };
  function anonId() {
    try {
      var id = localStorage.getItem('ss_anon_id');
      if (!id) { id = 'anon-' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('ss_anon_id', id); }
      return id;
    } catch (e) { return null; }
  }
  window.umzilaTrack = function (eventType, data) {
    try {
      if (!client) return;
      data = data || {};
      client.auth.getSession().then(function (r) {
        var session = r && r.data && r.data.session;
        if (COUNTER_EVENTS[eventType]) {
          if (!data.product_id) return;
          var h = { 'Content-Type': 'application/json' };
          if (session) h.Authorization = 'Bearer ' + session.access_token;
          fetch('/.netlify/functions/track-engagement', { method: 'POST', headers: h, keepalive: true, body: JSON.stringify({
            product_id: data.product_id, event_type: eventType, seller_id: data.seller_id || null,
            category: data.category || null, anonymous_id: anonId()
          }) }).catch(function () {});
          return;
        }
        client.from('user_events').insert({
          event_type: eventType, product_id: data.product_id || null, seller_id: data.seller_id || null,
          category: data.category || null, anonymous_id: anonId(), user_id: session ? session.user.id : null,
          metadata: data.metadata || {}
        }).then(function () {}, function () {});
      }, function () {});
    } catch (e) { /* ignore */ }
  };

  // ── Page-switch feedback ──────────────────────────────────────────────
  // Tapping a link to another Umzila page (store ↔ home, back arrow, Check
  // out…) shows a thin progress bar at the top straight away, so a slow
  // connection never looks like a dead tap. Pages can also call
  // umzilaNavigating() before a JS redirect. Cleared when the page comes
  // back from the browser's back/forward cache.
  var bar = null, barTimer = null;
  function showBar() {
    try {
      if (!bar) {
        var st = document.createElement('style');
        st.textContent = '#umzNavBar{position:fixed;top:0;left:0;height:3px;width:0;z-index:2147483647;background:linear-gradient(90deg,#ff6b2c,#ffb347);box-shadow:0 0 8px rgba(255,107,44,.6);transition:width 2.5s cubic-bezier(.1,.7,.2,1),opacity .2s;pointer-events:none}';
        document.head.appendChild(st);
        bar = document.createElement('div'); bar.id = 'umzNavBar'; bar.setAttribute('aria-hidden', 'true');
        document.body.appendChild(bar);
      }
      bar.style.transition = 'none'; bar.style.width = '0'; bar.style.opacity = '1';
      void bar.offsetWidth;
      bar.style.transition = '';
      bar.style.width = '85%';
      clearTimeout(barTimer);
      barTimer = setTimeout(hideBar, 15000); // never leave it up forever
    } catch (e) { /* ignore */ }
  }
  function hideBar() { if (bar) { bar.style.opacity = '0'; bar.style.width = '0'; } }
  window.umzilaNavigating = showBar;
  document.addEventListener('click', function (e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    var url;
    try { url = new URL(a.href, location.href); } catch (err) { return; }
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search) return; // same page / #hash
    // Let the page's own handlers decide first (many links are intercepted).
    setTimeout(function () { if (!e.defaultPrevented) showBar(); }, 0);
  });
  window.addEventListener('pageshow', function (e) { if (e.persisted) hideBar(); });
})();
