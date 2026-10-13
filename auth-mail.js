// auth-mail.js — the one "Check your email" panel for sign-up / sign-in
// (UmzilaAuthMail). Supabase "Confirm email" is on: a new account only works
// after the buyer taps the link we email. People didn't realise that, kept
// trying to sign in, and every attempt sent ANOTHER link — so inboxes filled
// with unopened emails. This panel:
//   • says plainly what to do (open your email, find Umzila, tap Confirm —
//     check Spam/Promotions), with an "Open Gmail" shortcut for Gmail users;
//   • remembers when a link was last sent to an address (localStorage), so
//     callers re-send only if none went out in the last 10 minutes
//     (UmzilaAuthMail.shouldResend / markSent), and the Resend button waits 60 s;
//   • notices when the buyer has confirmed (session appears — the link opens
//     signed in, also in another tab) and says so.
//
// UmzilaAuthMail.show(targetEl, email, { client, resend: () => Promise<{error}>,
//   onSignedIn?, onChangeEmail?, context? })
(function () {
  if (window.UmzilaAuthMail) return;
  var KEY = 'umz_confirm_sent_';
  var RECENT_MS = 10 * 60 * 1000, COOLDOWN_S = 60;
  function k(email) { return KEY + String(email || '').trim().toLowerCase(); }
  function lastSent(email) { try { return Number(localStorage.getItem(k(email))) || 0; } catch (e) { return 0; } }
  function markSent(email) { try { localStorage.setItem(k(email), String(Date.now())); } catch (e) {} }
  function shouldResend(email) { return Date.now() - lastSent(email) > RECENT_MS; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ago(ms) { var m = Math.round(ms / 60000); return m < 1 ? 'just now' : m === 1 ? '1 minute ago' : m + ' minutes ago'; }
  function mailLink(email) {
    var d = String(email || '').split('@')[1] || '';
    if (/^(gmail|googlemail)\.com$/i.test(d)) return { label: 'Open Gmail', href: 'https://mail.google.com/mail/u/0/#search/from%3Aumzila' };
    if (/^(outlook|hotmail|live)\.(com|co\.za)$/i.test(d)) return { label: 'Open Outlook', href: 'https://outlook.live.com/mail/' };
    if (/^(yahoo|ymail)\./i.test(d)) return { label: 'Open Yahoo Mail', href: 'https://mail.yahoo.com/' };
    if (/^icloud\.com$/i.test(d)) return { label: 'Open iCloud Mail', href: 'https://www.icloud.com/mail' };
    return null;
  }

  var CSS = '.uam{border:1.5px solid #bfdbfe;background:#eff6ff;border-radius:14px;padding:16px 16px 14px;color:#0f172a;text-align:left;font-size:14px;line-height:1.5;margin:8px 0}' +
    '.uam-h{display:flex;gap:10px;align-items:flex-start;margin-bottom:8px}.uam-ic{font-size:30px;line-height:1}' +
    '.uam-t{font-weight:800;font-size:16px;color:#0a2f66;margin:0 0 2px}.uam-s{margin:0;color:#334155}' +
    '.uam ol{margin:8px 0 10px 20px;padding:0;color:#334155}.uam ol li{margin:2px 0}' +
    '.uam-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}' +
    '.uam-btn{border:0;border-radius:999px;padding:10px 16px;font:inherit;font-weight:700;font-size:14px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}' +
    '.uam-primary{background:#0a2f66;color:#fff}.uam-ghost{background:#fff;color:#0a2f66;border:1.5px solid #bfdbfe}.uam-btn[disabled]{opacity:.55;cursor:default}' +
    '.uam-msg{margin-top:8px;font-size:13px;color:#475569;min-height:1em}.uam-ok{border-color:#86efac;background:#f0fdf4}.uam-ok .uam-t{color:#15803d}' +
    '.uam-link{background:none;border:0;padding:0;margin-top:8px;color:#475569;text-decoration:underline;font:inherit;font-size:13px;cursor:pointer}';
  function ensureCss() { if (document.getElementById('uamCss')) return; var st = document.createElement('style'); st.id = 'uamCss'; st.textContent = CSS; document.head.appendChild(st); }

  function show(target, email, opts) {
    if (!target) return;
    opts = opts || {};
    ensureCss();
    var sentAt = lastSent(email);
    var link = mailLink(email);
    target.style.display = 'block'; target.hidden = false;
    target.classList && target.classList.remove('hidden');
    target.style.color = 'inherit'; target.style.background = 'none'; target.style.border = '0'; target.style.padding = '0';
    target.innerHTML = '<div class="uam" role="status" aria-live="polite">' +
      '<div class="uam-h"><span class="uam-ic">✉️</span><div><p class="uam-t">Check your email to finish</p>' +
      '<p class="uam-s">We sent a sign-in link to <b>' + esc(email) + '</b>' + (sentAt ? ' (' + ago(Date.now() - sentAt) + ')' : '') + '. You need to tap it before you can sign in' + (opts.context ? ' ' + esc(opts.context) : '') + '.</p></div></div>' +
      '<ol><li>Open your email' + (link ? '' : ' app') + '.</li><li>Find the email from <b>Umzila</b> — if it isn’t there, check <b>Spam</b> or <b>Promotions</b>.</li><li>Tap <b>Confirm</b> in the email. You’ll come back to Umzila signed in.</li></ol>' +
      '<div class="uam-row">' + (link ? '<a class="uam-btn uam-primary" href="' + link.href + '" target="_blank" rel="noopener">' + link.label + ' ↗</a>' : '') +
      '<button type="button" class="uam-btn ' + (link ? 'uam-ghost' : 'uam-primary') + '" data-uam-resend>Resend the email</button></div>' +
      '<div class="uam-msg" data-uam-msg>Only the newest email’s link counts — no need to ask for more.</div>' +
      (opts.onChangeEmail ? '<button type="button" class="uam-link" data-uam-change>Use a different email</button>' : '') +
      '</div>';
    var box = target.querySelector('.uam'), btn = target.querySelector('[data-uam-resend]'), msg = target.querySelector('[data-uam-msg]');
    var timer = null;
    function cooldown() {
      var left = COOLDOWN_S - Math.floor((Date.now() - lastSent(email)) / 1000);
      if (left > 0) { btn.disabled = true; btn.textContent = 'Resend in ' + left + 's'; timer = setTimeout(cooldown, 1000); }
      else { btn.disabled = false; btn.textContent = 'Resend the email'; }
    }
    cooldown();
    btn.addEventListener('click', async function () {
      if (!opts.resend) return;
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        var r = await opts.resend();
        if (r && r.error) { msg.textContent = 'Couldn’t send just now — please wait a minute and try again.'; btn.disabled = false; btn.textContent = 'Resend the email'; return; }
        markSent(email);
        msg.textContent = 'Sent again to ' + email + '. Open the newest one.';
        cooldown();
      } catch (e) { msg.textContent = 'Couldn’t send just now — please try again.'; btn.disabled = false; btn.textContent = 'Resend the email'; }
    });
    var change = target.querySelector('[data-uam-change]');
    if (change) change.addEventListener('click', function () { clearTimeout(timer); stopPoll(); target.innerHTML = ''; target.style.display = 'none'; opts.onChangeEmail(); });

    // Confirmed? The link opens signed in (often in a new tab) — notice it here too.
    var poll = null;
    function stopPoll() { if (poll) clearInterval(poll); poll = null; }
    if (opts.client && opts.client.auth) {
      poll = setInterval(async function () {
        if (!document.body.contains(box)) { stopPoll(); return; }
        try {
          var s = await opts.client.auth.getSession();
          var sess = s && s.data && s.data.session;
          if (sess && sess.user && String(sess.user.email || '').toLowerCase() === String(email).toLowerCase()) {
            stopPoll(); clearTimeout(timer);
            box.className = 'uam uam-ok';
            box.innerHTML = '<div class="uam-h"><span class="uam-ic">✅</span><div><p class="uam-t">You’re signed in</p><p class="uam-s">Your email is confirmed. You can carry on.</p></div></div>';
            if (opts.onSignedIn) opts.onSignedIn(sess);
          }
        } catch (e) { /* keep waiting */ }
      }, 4000);
    }
  }

  window.UmzilaAuthMail = { show: show, shouldResend: shouldResend, markSent: markSent, lastSent: lastSent };
})();
