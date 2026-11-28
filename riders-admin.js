/* Admin → Riders (2026-11-28). See docs/systems/rider-panel.md.
   Every rider (drivers rows): approve applications from /rider, pause / resume, add an
   existing account as a rider, and see + settle what each rider is owed.
   Reads/writes ONLY through admin-checked SECURITY DEFINER RPCs: admin_riders,
   admin_rider_set_status, admin_rider_add, admin_rider_pay. Amounts come from
   driver_payouts (written by the compute_driver_payout_on_route_completion trigger when a
   trip finishes) — never added up from orders in the browser.
   Uses the page's global `supabaseClient` (admin.html). */
(function () {
  'use strict';
  var TZ = 'Africa/Johannesburg';
  function sb() { return typeof supabaseClient !== 'undefined' ? supabaseClient : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(m) { try { if (typeof showToast === 'function') return showToast(m); } catch (e) { /* ignore */ } }
  function R(n) { return 'R' + (Number(n) || 0).toFixed(2); }
  function when(ts) { return ts ? new Intl.DateTimeFormat('en-ZA', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts)) : '—'; }
  function $(id) { return document.getElementById(id); }
  var STATUS = { eligible: ['Active', '#dcfce7', '#166534'], pending: ['Applied — waiting', '#fef3c7', '#92400e'], suspended: ['Paused', '#fee2e2', '#991b1b'] };

  async function load() {
    var mount = $('ridersMount'); if (!mount || !sb()) return;
    mount.innerHTML = '<p style="color:#6b7280">Loading riders…</p>';
    var r = await sb().rpc('admin_riders');
    if (r.error) { mount.innerHTML = '<p style="color:#b91c1c">Could not load riders: ' + esc(r.error.message) + '</p>'; return; }
    render(r.data || []);
  }

  function render(list) {
    var mount = $('ridersMount');
    var owed = list.reduce(function (s, x) { return s + (Number(x.owed) || 0); }, 0);
    var month = list.reduce(function (s, x) { return s + (Number(x.month) || 0); }, 0);
    var waiting = list.filter(function (x) { return x.status === 'pending'; }).length;
    var head = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px">' +
      box('Owed to riders now', R(owed), '#fef9c3') + box('Rider pay this month', R(month), '#f1f5f9') +
      box('Riders', String(list.filter(function (x) { return x.status === 'eligible'; }).length) + ' active', '#f1f5f9') +
      (waiting ? box('Applications', waiting + ' waiting', '#fef3c7') : '') + '</div>';
    var add = '<div class="card" style="margin-bottom:14px"><div style="font-weight:800;margin-bottom:6px">Add a rider</div>' +
      '<p style="font-size:13px;color:#6b7280;margin:0 0 10px">New riders apply at <b>/rider</b> and show up below to approve. To add someone directly, they need an Umzila account first — enter its email.</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><input id="rdAddEmail" type="email" placeholder="rider@email.com" style="flex:1;min-width:200px;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px">' +
      '<button class="small-btn" id="rdAddBtn" style="background:#0a2f66;color:#fff">Add as rider</button></div><div id="rdAddMsg" style="font-size:13px;margin-top:6px"></div></div>';
    var cards = list.length ? list.map(card).join('') : '<p style="color:#6b7280">No riders yet.</p>';
    mount.innerHTML = head + add + cards +
      '<p style="font-size:12px;color:#6b7280;margin-top:12px">A rider earns per delivery when their trip finishes: R34 for the first 3 road-km, +R0.40/km, +R3 per extra store, max R45 (R39 if the distance is unknown). “Mark paid” records that you paid them everything owed; it does not move money. Whether rider pay counts as a cost in your profit is set in Finances → Assumptions (“External riders”).</p>';
    $('rdAddBtn').onclick = addRider;
    mount.querySelectorAll('[data-rd-status]').forEach(function (b) { b.onclick = function () { setStatus(b.dataset.id, b.dataset.rdStatus); }; });
    mount.querySelectorAll('[data-rd-pay]').forEach(function (b) { b.onclick = function () { pay(b.dataset.rdPay, b.dataset.amount); }; });
  }
  function box(k, v, bg) { return '<div style="background:' + bg + ';border-radius:12px;padding:12px"><div style="font-size:12px;color:#6b7280">' + esc(k) + '</div><div style="font-size:20px;font-weight:800">' + esc(v) + '</div></div>'; }

  function card(x) {
    var st = STATUS[x.status] || [x.status, '#f3f4f6', '#374151'];
    var badge = '<span style="font-size:11px;font-weight:800;padding:3px 8px;border-radius:999px;background:' + st[1] + ';color:' + st[2] + '">' + esc(st[0]) + '</span>' +
      (x.online ? ' <span style="font-size:11px;font-weight:800;padding:3px 8px;border-radius:999px;background:#dcfce7;color:#166534">● Online</span>' : '') +
      (x.is_staff ? ' <span style="font-size:11px;font-weight:800;padding:3px 8px;border-radius:999px;background:#e0e7ff;color:#3730a3">Staff</span>' : '');
    var actions = [];
    if (x.status === 'pending') actions.push(btn('Approve', 'eligible', x.id, '#166534'));
    if (x.status === 'eligible') actions.push(btn('Pause', 'suspended', x.id, '#991b1b'));
    if (x.status === 'suspended') actions.push(btn('Resume', 'eligible', x.id, '#166534'));
    var payBox = Number(x.owed) > 0
      ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center"><input id="rdRef-' + esc(x.id) + '" placeholder="Payment reference (e.g. EFT 28 Nov)" style="flex:1;min-width:180px;padding:7px 9px;border:1px solid #d1d5db;border-radius:8px;font-size:13px">' +
        '<button class="small-btn" data-rd-pay="' + esc(x.id) + '" data-amount="' + esc(x.owed) + '" style="background:#0a2f66;color:#fff">Mark ' + R(x.owed) + ' paid</button></div>'
      : '';
    return '<div class="card" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">' +
      '<div><div style="font-weight:800;font-size:15px">' + esc(x.name) + ' ' + badge + '</div>' +
      '<div style="font-size:13px;color:#6b7280;margin-top:4px">' + [x.email, x.phone, x.vehicle].filter(Boolean).map(esc).join(' · ') + '</div>' +
      '<div style="font-size:12px;color:#9ca3af;margin-top:2px">Rider since ' + when(x.since) + ' · last seen ' + when(x.last_seen) + '</div></div>' +
      '<div style="display:flex;gap:6px;align-items:flex-start">' + actions.join('') + '</div></div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-top:10px;font-size:13px">' +
      cell('Owed now', R(x.owed) + (x.owed_n ? ' · ' + x.owed_n + ' trip' + (x.owed_n === 1 ? '' : 's') : ''), Number(x.owed) > 0) +
      cell('This month', R(x.month) + ' · ' + (x.month_n || 0) + ' deliveries') +
      cell('Paid so far', R(x.paid)) + cell('Last paid', when(x.last_paid)) + cell('All deliveries', String(x.all_n || 0)) + '</div>' + payBox + '</div>';
  }
  function cell(k, v, hl) { return '<div style="background:' + (hl ? '#fef9c3' : '#f8fafc') + ';border-radius:8px;padding:8px"><div style="color:#6b7280;font-size:11.5px">' + esc(k) + '</div><div style="font-weight:700">' + esc(v) + '</div></div>'; }
  function btn(label, status, id, color) { return '<button class="small-btn" data-rd-status="' + status + '" data-id="' + esc(id) + '" style="border-color:' + color + ';color:' + color + '">' + esc(label) + '</button>'; }

  async function setStatus(id, status) {
    var r = await sb().rpc('admin_rider_set_status', { p_driver: id, p_status: status });
    if (r.error) return toast('Could not update: ' + r.error.message);
    toast(status === 'eligible' ? 'Rider is active — they can go online now' : 'Rider paused — they can’t go online or accept offers');
    load();
  }
  async function addRider() {
    var email = ($('rdAddEmail').value || '').trim(), msg = $('rdAddMsg');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.style.color = '#b91c1c'; msg.textContent = 'Enter a valid email.'; return; }
    var r = await sb().rpc('admin_rider_add', { p_email: email });
    if (r.error) { msg.style.color = '#b91c1c'; msg.textContent = /NO_ACCOUNT/.test(r.error.message) ? 'No Umzila account with that email — ask them to create one at /rider first.' : r.error.message; return; }
    msg.style.color = '#065f46'; msg.textContent = 'Added — they can sign in at /rider and go online.';
    load();
  }
  async function pay(id, amount) {
    var ref = ($('rdRef-' + id) || {}).value || '';
    if (!window.confirm('Record that you paid this rider ' + R(amount) + '? Their owed trips will be marked paid.')) return;
    var r = await sb().rpc('admin_rider_pay', { p_driver: id, p_reference: ref });
    if (r.error) return toast('Could not record the payment: ' + r.error.message);
    toast('Recorded: ' + R(r.data && r.data.amount) + ' paid (' + ((r.data && r.data.payouts) || 0) + ' trips)');
    load();
  }

  window.loadRidersAdmin = load;
})();
