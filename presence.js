// Live visitor heartbeat for admin's "On the site now" counter.
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
})();
