/* order-bell.js — "CHA-CHING!" when a new order is paid (admin.html, logistics.html).
 *
 * Every 20 s (browsers slow a background tab to about once a minute — it still
 * rings) it asks for orders paid since it last looked (orders.payment_status =
 * 'paid', paid_at; staff RLS decides who can see them). For each new one it plays a
 * cash-register sound, shows a desktop notification and a banner at the top.
 *  - Sound: /cha-ching.mp3 if that file exists, else a cha-ching synthesised here.
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
  var client = null, since = null, timer = null, ctx = null, armed = false, mp3 = null, pill = null;

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
  function audio() {
    if (!ctx) { var A = window.AudioContext || window.webkitAudioContext; if (!A) return null; ctx = new A(); }
    return ctx;
  }
  function arm() {
    var c = audio(); if (!c) return;
    (c.state === 'suspended' ? c.resume() : Promise.resolve()).then(function () { armed = c.state === 'running'; render(); });
    if (mp3 === null) {
      mp3 = false;
      fetch('/cha-ching.mp3', { cache: 'force-cache' }).then(function (r) { return r.ok ? r.arrayBuffer() : null; })
        .then(function (b) { if (b) c.decodeAudioData(b, function (buf) { mp3 = buf; }, function () {}); }).catch(function () {});
    }
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, arm, { passive: true }); });

  function synth(c) {
    var t = c.currentTime + 0.02, out = c.createGain(); out.gain.value = 0.9; out.connect(c.destination);
    // "cha": the drawer — two short bursts of filtered noise
    [0, 0.07].forEach(function (d) {
      var len = Math.floor(c.sampleRate * 0.09), b = c.createBuffer(1, len, c.sampleRate), x = b.getChannelData(0);
      for (var i = 0; i < len; i++) x[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      var s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = b; f.type = 'bandpass'; f.frequency.value = 2600; f.Q.value = 0.9; g.gain.value = 0.55;
      s.connect(f); f.connect(g); g.connect(out); s.start(t + d);
    });
    // "ching!": a bright bell, then a second coin
    function bell(at, base, vol) {
      [1, 2.76, 5.4, 8.93].forEach(function (m, k) {
        var o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = base * m;
        g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(vol / (k + 1), at + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 1.4 / (k * 0.6 + 1));
        o.connect(g); g.connect(out); o.start(at); o.stop(at + 1.6);
      });
    }
    bell(t + 0.17, 1318.5, 0.5);
    bell(t + 0.30, 1760, 0.32);
  }
  function play() {
    var c = audio(); if (!c || !on()) return;
    if (c.state !== 'running') { c.resume().catch(function () {}); }
    if (mp3) { var s = c.createBufferSource(); s.buffer = mp3; s.connect(c.destination); s.start(); }
    else synth(c);
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
        } else if (a === 'test') { arm(); setTimeout(function () { play(); banner({ id: 'test', total: 123.45, customer_name: 'Test order', order_number: 'TEST' }); }, 60); }
      });
      document.body.appendChild(pill);
    }
    var o = on();
    var state = !o ? '🔕 Order sound off' : armed ? '🔔 Cha-ching on' : '🔔 Click anywhere to arm';
    pill.innerHTML = '<span title="Plays a cha-ching when an order is paid (this device)">' + state + '</span>' +
      '<button type="button" data-bell="toggle" style="border:0;border-radius:999px;padding:6px 10px;font:inherit;cursor:pointer;background:' + (o ? '#ecfdf5;color:#047857' : '#f1f5f9;color:#334155') + '">' + (o ? 'On' : 'Off') + '</button>' +
      (o ? '<button type="button" data-bell="test" style="border:0;border-radius:999px;padding:6px 10px;font:inherit;cursor:pointer;background:#0f172a;color:#fff">Test</button>' : '');
  }
})();
