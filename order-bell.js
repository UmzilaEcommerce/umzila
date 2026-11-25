/* order-bell.js — "CHA-CHING!" when a new order is paid (admin.html, logistics.html).
 *
 * Every 20 s (browsers slow a background tab to about once a minute — it still
 * rings) it asks for orders paid since it last looked (orders.payment_status =
 * 'paid', paid_at; staff RLS decides who can see them). For each new one it plays a
 * cash-register sound, shows a desktop notification and a banner at the top.
 *  - Sound: /cha-ching.wav if the server returns an audio file there, else a cha-ching
 *    computed here as a WAV and played with an <audio> element.
 *  - Browsers only allow sound after you've clicked the page once since opening it:
 *    the pill (bottom-left) says "Click anywhere to arm" until then.
 *  - The pill switches it on/off (localStorage umz_bell, per device) and has Test.
 *  - Several open tabs on one device ring once (localStorage claim per order).
 * Phones: rings while the page is open on screen; a locked phone / closed tab can't
 * (that needs web push — the order emails still arrive).
 * No keys here: it uses the page's own signed-in Supabase client.
 */
(function () {
  'use strict';
  var KEY = 'umz_bell', SEEN = 'umz_bell_seen', POLL_MS = 20000;
  var client = null, since = null, timer = null, armed = false, pill = null;

  function on() { try { return localStorage.getItem(KEY) !== 'off'; } catch (e) { return true; } }
  function setOn(v) { try { localStorage.setItem(KEY, v ? 'on' : 'off'); } catch (e) {} render(); }
  function money(n) { return 'R' + (Number(n) || 0).toFixed(2); }
  function claim(id) {
    try {
      var seen = JSON.parse(localStorage.getItem(SEEN) || '[]');
      if (seen.indexOf(id) >= 0) return false;
      seen.push(id); localStorage.setItem(SEEN, JSON.stringify(seen.slice(-200)));
    } catch (e) {}
    return true;
  }

  // ---------- sound ----------
  // The cha-ching is computed once as a WAV in plain JS (no Web Audio) and played
  // with an <audio> element — the most reliable way to play a sound in every browser.
  // /cha-ching.wav (the founder's own sound, trimmed + boosted) replaces it only when the server really returns an audio file
  // (the site answers unknown paths with a page, which can't be played).
  var player = null, blocked = false;
  function makeWav() {
    var rate = 44100, n = Math.floor(rate * 1.6), pcm = new Float32Array(n), i;
    // "cha": the drawer — two short noise bursts, slightly filtered
    [0, 0.07].forEach(function (d) {
      var s0 = Math.floor(d * rate), len = Math.floor(0.09 * rate), prev = 0;
      for (i = 0; i < len && s0 + i < n; i++) { var w = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); prev = prev * 0.35 + w * 0.65; pcm[s0 + i] += (w - prev) * 0.55; }
    });
    // "ching!": a bright bell, then a second coin
    function bell(at, base, vol) {
      var s0 = Math.floor(at * rate);
      [1, 2.76, 5.4, 8.93].forEach(function (m, k) {
        var f = base * m, a = vol / (k + 1), decay = 1.4 / (k * 0.6 + 1);
        for (i = 0; s0 + i < n; i++) { var t = i / rate; if (t > decay * 1.2) break; pcm[s0 + i] += a * Math.min(1, t / 0.006) * Math.exp(-t * 5 / decay) * Math.sin(2 * Math.PI * f * t); }
      });
    }
    bell(0.17, 1318.5, 0.5);
    bell(0.30, 1760, 0.32);
    var peak = 0; for (i = 0; i < n; i++) peak = Math.max(peak, Math.abs(pcm[i]));
    var g = peak > 0 ? 0.9 / peak : 1, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    function str(o, s) { for (var j = 0; j < s.length; j++) v.setUint8(o + j, s.charCodeAt(j)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    for (i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i] * g)) * 32767, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  function getPlayer() {
    if (player) return player;
    player = new Audio(makeWav()); player.preload = 'auto'; player.volume = 1;
    fetch('/cha-ching.wav', { method: 'HEAD', cache: 'no-store' }).then(function (r) {
      if (r.ok && /^audio\//i.test(r.headers.get('content-type') || '')) player.src = '/cha-ching.wav';
    }).catch(function () {});
    return player;
  }
  // First click on the page: unlock audio (play silently once), so later rings can play in the background.
  function arm() {
    if (armed) return;
    var p = getPlayer(); p.muted = true;
    var r = p.play();
    (r && r.then ? r : Promise.resolve()).then(function () { if (p.muted) { p.pause(); p.currentTime = 0; p.muted = false; } armed = true; blocked = false; render(); }) // a Test click may already be playing it
      .catch(function () { p.muted = false; render(); });
  }
  ['pointerdown', 'keydown', 'touchend'].forEach(function (ev) { document.addEventListener(ev, arm, { passive: true }); });
  function play() {
    if (!on()) return;
    var p = getPlayer(); p.muted = false;
    try { p.currentTime = 0; } catch (e) {}
    var r = p.play();
    if (r && r.catch) r.then(function () { if (blocked) { blocked = false; render(); } }).catch(function (e) { console.warn('order-bell: sound blocked —', e && e.name); blocked = true; armed = false; render(); });
  }

  // ---------- banner + notification ----------
  function banner(o) {
    var b = document.createElement('div');
    b.setAttribute('role', 'status');
    b.style.cssText = 'position:fixed;left:50%;top:16px;transform:translate(-50%,-140%);z-index:2147483000;background:#0b1f14;color:#fff;border-radius:18px;padding:14px 20px;box-shadow:0 18px 50px rgba(0,0,0,.35),0 0 0 1px rgba(52,211,153,.4);font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;gap:14px;transition:transform .45s cubic-bezier(.2,.9,.3,1.25);max-width:calc(100vw - 24px);cursor:pointer';
    b.innerHTML = '<div style="font-size:30px">💸</div><div><div style="font-size:12px;font-weight:800;letter-spacing:.12em;color:#fcd34d">CHA-CHING!</div>' +
      '<div style="font-size:22px;font-weight:900;color:#34d399;line-height:1.15">' + money(o.total) + '</div>' +
      '<div style="font-size:13px;opacity:.85">' + String(o.customer_name || 'New order').replace(/[<>&]/g, '') + ' · ' + String(o.order_number || '').slice(-9) + '</div></div>';
    b.onclick = function () { b.remove(); };
    document.body.appendChild(b);
    requestAnimationFrame(function () { b.style.transform = 'translate(-50%,0)'; });
    setTimeout(function () { b.style.transform = 'translate(-50%,-160%)'; setTimeout(function () { b.remove(); }, 600); }, 9000);
  }
  function notify(o) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      new Notification('💸 Cha-ching! ' + money(o.total), { body: (o.customer_name || 'New order') + ' · ' + (o.order_number || ''), tag: 'umz-order-' + o.id, icon: '/favicon.svg' });
    } catch (e) { /* phones need a service worker for this — the banner + sound still work */ }
  }

  // ---------- polling ----------
  function tick() {
    if (!client) return;
    client.from('orders').select('id, order_number, total, customer_name, paid_at')
      .eq('payment_status', 'paid').gt('paid_at', since).order('paid_at', { ascending: true }).limit(10)
      .then(function (r) {
        if (r.error || !r.data) return;
        r.data.forEach(function (o, i) {
          since = o.paid_at > since ? o.paid_at : since;
          if (!claim(o.id)) return;
          setTimeout(function () { if (on()) play(); banner(o); if (on()) notify(o); }, i * 1800);
        });
      });
  }
  function start(sb) {
    if (client || !sb) return;
    client = sb;
    client.auth.getSession().then(function (r) {
      if (!r || !r.data || !r.data.session) { client = null; return; }
      // start from the newest paid order already there, so opening the page never rings for old ones
      client.from('orders').select('paid_at').eq('payment_status', 'paid').not('paid_at', 'is', null)
        .order('paid_at', { ascending: false }).limit(1).then(function (q) {
          if (q.error) { client = null; return; } // not staff: no bell
          since = (q.data && q.data[0] && q.data[0].paid_at) || new Date().toISOString();
          render();
          timer = setInterval(tick, POLL_MS);
          document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
        });
    });
  }
  document.addEventListener('supabase-ready', function (e) { start(e.detail && e.detail.supabase); }); // admin.html
  document.addEventListener('sb-ready', function (e) { start(e.detail); });                           // logistics.html
  if (window._sb) start(window._sb);

  // ---------- the pill ----------
  function render() {
    if (!client || !document.body) return;
    if (!pill) {
      pill = document.createElement('div');
      pill.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147482000;display:flex;align-items:center;gap:6px;background:#fff;border-radius:999px;padding:5px 6px 5px 12px;box-shadow:0 6px 22px rgba(15,23,42,.18),0 0 0 1px rgba(15,23,42,.06);font:600 13px system-ui,-apple-system,sans-serif;color:#0f172a';
      pill.addEventListener('click', function (e) {
        var a = e.target.getAttribute && e.target.getAttribute('data-bell');
        if (a === 'toggle') {
          var next = !on(); setOn(next);
          if (next) { arm(); try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (_) {} }
        } else if (a === 'test') { play(); setTimeout(function () { banner({ id: 'test', total: 123.45, customer_name: 'Test order', order_number: 'TEST' }); }, 60); }
      });
      document.body.appendChild(pill);
    }
    var o = on();
    var state = !o ? '🔕 Order sound off' : blocked ? '🔇 Sound blocked — click here, then Test' : armed ? '🔔 Cha-ching on' : '🔔 Click anywhere to arm';
    pill.innerHTML = '<span title="Plays a cha-ching when an order is paid (this device)">' + state + '</span>' +
      '<button type="button" data-bell="toggle" style="border:0;border-radius:999px;padding:6px 10px;font:inherit;cursor:pointer;background:' + (o ? '#ecfdf5;color:#047857' : '#f1f5f9;color:#334155') + '">' + (o ? 'On' : 'Off') + '</button>' +
      (o ? '<button type="button" data-bell="test" style="border:0;border-radius:999px;padding:6px 10px;font:inherit;cursor:pointer;background:#0f172a;color:#fff">Test</button>' : '');
  }
})();
