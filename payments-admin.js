/* Admin → Payments (payment method picker console).
   Plan: docs/plans/payment-picker-checkout-plan.md §7 (workstream C). Loaded by admin.html.
   Reads/writes ONLY through admin-checked RLS (site_settings key 'payments', same policy as
   'timeslots') and SECURITY DEFINER RPCs: admin_payment_flagged, admin_payment_resolve_flag,
   admin_payment_report, admin_paid_orders, admin_payment_attempts. No keys in this file.
   Uses the page's global `supabaseClient` (admin.html).
   Three tabs: Payment options (master switch + list) · Flagged orders · Report.
   Also: window.loadPaymentsBadge() fills the dashboard "Payments: N flagged" line. */
(function () {
  'use strict';
  var TZ = 'Africa/Johannesburg';

  // PayFast's documented payment_method codes (developer brief, 2026-11-14). The server
  // (begin-payment.js) refuses any code that is not in its own list too.
  var CODES = [
    { code: 'cc', label: 'Card (credit & cheque)', key: 'card' },
    { code: 'dc', label: 'Debit card', key: 'debit_card' },
    { code: 'cp', label: 'Capitec Pay', key: 'capitec' },
    { code: 'ef', label: 'Instant EFT', key: 'eft' },
    { code: 'ap', label: 'Apple Pay', key: 'apple_pay' },
    { code: 'gp', label: 'Google Pay', key: 'google_pay' },
    { code: 'sp', label: 'Samsung Pay', key: 'samsung_pay' },
    { code: 'ss', label: 'SnapScan', key: 'snapscan' },
    { code: 'zp', label: 'Zapper', key: 'zapper' },
    { code: 'mp', label: 'Scan to Pay', key: 'scan_to_pay' },
    { code: 'mc', label: 'Mobicred', key: 'mobicred' },
    { code: 'mt', label: 'MoreTyme', key: 'moretyme' },
    { code: 'pf', label: 'Payflex', key: 'payflex' },
    { code: 'ab', label: 'Absa Pay', key: 'absa_pay' },
    { code: 'nd', label: 'Nedbank Direct EFT', key: 'nedbank_eft' },
    { code: 'rc', label: 'Store card', key: 'store_card' },
    { code: 'mu', label: 'Mukuru', key: 'mukuru' },
    { code: 'sc', label: 'SCode', key: 'scode' }
  ];
  var CODE_SET = {}; CODES.forEach(function (c) { CODE_SET[c.code] = c; });
  // Founder's fee table (payfast.io/fees, checked 14 Nov 2026, ex VAT) — help text only.
  var FEES = { cc: '3.2% + R2', cp: '2%, minimum R2', ef: '2%, minimum R2' };
  var DEVICES = [
    { v: '', label: 'Everyone', short: '' },
    { v: 'apple', label: 'Apple devices only (iPhone, iPad, Mac Safari)', short: 'on iPhones' },
    { v: 'android', label: 'Android phones only (Samsung included)', short: 'on Android' },
    { v: 'samsung', label: 'Samsung Internet only', short: 'on Samsung' }
  ];
  var DEFAULTS = {
    enabled: false, no_answer_minutes: 30, itn_validate: true,
    options: [
      { key: 'card', name: 'Card', description: 'Visa or Mastercard — saved cards pay in one tap', code: 'cc', active: true, position: 1, device: null },
      { key: 'capitec', name: 'Capitec Pay', description: 'Approve in your Capitec app', code: 'cp', active: true, position: 2, device: null },
      { key: 'eft', name: 'Instant EFT', description: 'Pay from your bank account', code: 'ef', active: true, position: 3, device: null },
      { key: 'apple_pay', name: 'Apple Pay', description: 'Pay with Face ID or Touch ID', code: 'ap', active: true, position: 4, device: 'apple' },
      { key: 'google_pay', name: 'Google Pay', description: 'Pay with the cards in your Google account', code: 'gp', active: true, position: 5, device: 'android' },
      { key: 'samsung_pay', name: 'Samsung Pay', description: 'Pay with Samsung Wallet', code: 'sp', active: false, position: 6, device: 'samsung' },
      { key: 'more', name: 'More ways to pay', description: 'Other methods on PayFast', code: null, active: true, position: 7, device: null }
    ]
  };
  var BUILT_IN = { card: 1, capitec: 1, eft: 1, apple_pay: 1, google_pay: 1, samsung_pay: 1, more: 1 };
  var FLAG_LABEL = { paid_twice: 'Paid twice', amount_mismatch: 'Amount differs' };
  var STATUS_LABEL = { started: 'Started', paid: 'Paid', cancelled: 'Cancelled', failed: 'Failed', no_answer: 'No answer', paid_twice: 'Paid twice', refunded: 'Refunded' };

  var S = {
    tab: 'options', settings: clone(DEFAULTS), settingsRow: null, settingsErr: null, loaded: false,
    flagged: null, flaggedErr: null, report: null, reportErr: null, paid: null, paidErr: null,
    range: null, attempts: {}, open: {}, msgs: {}, busy: false
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function sb() { return typeof supabaseClient !== 'undefined' ? supabaseClient : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(m) { try { if (typeof showToast === 'function') return showToast(m); } catch (e) { /* ignore */ } try { alert(m); } catch (e2) { /* ignore */ } }
  function $(id) { return document.getElementById(id); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(v) { if (v == null || v === '') return '—'; return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(num(v)); }
  function pct(v) { return (Math.round(num(v) * 1000) / 10).toFixed(1).replace(/\.0$/, '') + '%'; }
  function sastDate(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date()); }
  function addDays(ymd, n) { var p = ymd.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10); }
  function fmtWhen(ts) { if (!ts) return '—'; try { return new Intl.DateTimeFormat('en-ZA', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts)); } catch (e) { return String(ts); } }
  function list(d, k) { if (Array.isArray(d)) return d; if (d && k && Array.isArray(d[k])) return d[k]; if (d && Array.isArray(d.rows)) return d.rows; return []; }
  function friendly(err) {
    var m = (err && err.message) || String(err || 'Something went wrong');
    // site_settings_payments_validate trigger (server-side check of what this screen writes)
    if (/PAYMENTS_INVALID/.test(m)) return 'The server refused these settings' + (err && err.details ? ': ' + err.details : '') + '.';
    if (/PGRST202|42883|Could not find the function|function .* does not exist/i.test(m)) return 'This part of Payments isn’t set up in the database yet (the payment-picker migration hasn’t been applied). Everything else keeps working.';
    if (/row-level security|permission denied|42501|not allowed|admins only/i.test(m)) return 'You don’t have permission to do that (admins only).';
    if (/Failed to fetch|NetworkError|network/i.test(m)) return 'Couldn’t reach the server. Check your connection and try again.';
    return m;
  }
  function optName(key) {
    if (key === 'legacy') return 'Before the picker';
    var o = (S.settings.options || []).filter(function (x) { return x.key === key; })[0];
    return o ? o.name : (key || '—');
  }
  function paidWith(r) {
    if (r.payment_method_code === 'token') return 'Saved card' + (r.option_key && r.option_key !== 'card' ? ' (' + optName(r.option_key) + ')' : '');
    if (r.payment_method_code === 'zero') return 'Nothing to pay (R0)';
    if (r.option_key) return optName(r.option_key);
    return 'Not recorded (picker off)';
  }
  function sorted(opts) { return (opts || []).slice().sort(function (a, b) { return num(a.position) - num(b.position); }); }
  function msg(key) { var m = S.msgs[key]; return m ? '<div class="pp-msg ' + (m.ok ? 'ok' : 'bad') + '">' + esc(m.t) + '</div>' : ''; }
  function setMsg(key, t, ok) { S.msgs[key] = { t: t, ok: ok !== false }; }

  // ---------- settings ----------
  function normalise(v) {
    var out = Object.assign({}, clone(DEFAULTS), v || {});
    if (!Array.isArray(out.options)) out.options = clone(DEFAULTS.options);
    out.options = sorted(out.options).map(function (o, i) { return Object.assign({}, o, { position: i + 1, device: o.device || null, code: o.code || null, active: !!o.active }); });
    return out;
  }
  function validate(v) {
    var keys = {}, catchAll = 0, codes = {};
    var opts = v.options || [];
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      if (!/^[a-z_]{2,30}$/.test(o.key || '')) return 'Option “' + (o.name || o.key) + '” has an invalid key.';
      if (keys[o.key]) return 'Two options share the key “' + o.key + '”.';
      keys[o.key] = 1;
      var nm = String(o.name || '').trim();
      if (!nm) return 'Every option needs a name.';
      if (nm.length > 40) return '“' + nm + '”: the name can be at most 40 characters.';
      if (String(o.description || '').length > 90) return '“' + nm + '”: the description can be at most 90 characters.';
      if (o.code == null) catchAll++;
      else if (!CODE_SET[o.code]) return '“' + nm + '” uses “' + o.code + '”, which is not a PayFast code.';
      else if (codes[o.code]) return 'Two options use the PayFast code “' + o.code + '”.';
      else codes[o.code] = 1;
      if ([null, 'apple', 'android', 'samsung'].indexOf(o.device) < 0) return '“' + nm + '” has an unknown device rule.';
    }
    if (catchAll > 1) return 'Only one option can be the catch-all (no PayFast code).';
    var m = Number(v.no_answer_minutes);
    if (!(m >= 10 && m <= 120) || Math.round(m) !== m) return '“No answer after” must be a whole number from 10 to 120 minutes.';
    return null;
  }
  // Re-reads the row first, applies the change to the fresh copy, validates, then writes —
  // so two admins editing at once don't silently undo each other's changes.
  async function saveWith(mutate) {
    var c = sb(); if (!c) return { ok: false, error: 'Not connected' };
    try {
      var cur = await c.from('site_settings').select('value, updated_at').eq('key', 'payments').maybeSingle();
      if (cur.error) throw cur.error;
      var next = normalise(cur.data && cur.data.value);
      var r0 = mutate(next); if (r0 === false) return { ok: false, error: 'Nothing changed' };
      next.options = sorted(next.options).map(function (o, i) { return Object.assign({}, o, { position: i + 1 }); });
      var bad = validate(next); if (bad) return { ok: false, error: bad };
      var u = await c.auth.getUser(); var user = u && u.data && u.data.user;
      var r = await c.from('site_settings').upsert({ key: 'payments', value: next, updated_at: new Date().toISOString(), updated_by: user ? user.id : null }).select('value, updated_at').single();
      if (r.error) throw r.error;
      S.settingsRow = r.data; S.settings = normalise(r.data.value); S.settingsErr = null;
      return { ok: true };
    } catch (e) { return { ok: false, error: 'Couldn’t save: ' + friendly(e) }; }
  }

  async function loadSettings() {
    var c = sb(); if (!c) { S.settingsErr = 'Supabase not available'; return; }
    var r = await c.from('site_settings').select('value, updated_at').eq('key', 'payments').maybeSingle();
    if (r.error) { S.settingsErr = friendly(r.error); return; }
    S.settingsRow = r.data; S.settings = normalise(r.data && r.data.value); S.settingsErr = null;
  }

  // ---------- RPC loads ----------
  async function rpc(name, args) {
    var c = sb(); if (!c) throw new Error('Not connected');
    var r = await c.rpc(name, args || {});
    if (r.error) throw r.error;
    return r.data;
  }
  async function loadFlagged() {
    try { S.flagged = list(await rpc('admin_payment_flagged'), 'orders'); S.flaggedErr = null; }
    catch (e) { S.flagged = null; S.flaggedErr = friendly(e); }
    updateBadge();
  }
  function defaultRange() { var t = sastDate(); return { from: t.slice(0, 8) + '01', to: t }; }
  async function loadReport() {
    var rg = S.range || (S.range = defaultRange());
    S.report = null; S.paid = null; S.reportErr = null; S.paidErr = null; S.attempts = {}; S.open = {};
    var res = await Promise.all([
      rpc('admin_payment_report', { p_from: rg.from, p_to: rg.to }).then(function (d) { return { d: d }; }, function (e) { return { e: e }; }),
      rpc('admin_paid_orders', { p_from: rg.from, p_to: rg.to, p_limit: 100 }).then(function (d) { return { d: d }; }, function (e) { return { e: e }; })
    ]);
    if (res[0].e) S.reportErr = friendly(res[0].e); else S.report = reportShape(res[0].d);
    if (res[1].e) S.paidErr = friendly(res[1].e); else S.paid = list(res[1].d, 'orders');
  }
  function isTotalsRow(r) { return r && (r.option_key == null || r.option_key === 'totals' || r.option_key === '__totals' || r.is_total === true); }
  function reportShape(d) {
    var rows = [], totals = null;
    if (Array.isArray(d)) { d.forEach(function (r) { if (isTotalsRow(r)) totals = r; else rows.push(r); }); }
    else if (d && typeof d === 'object') { rows = list(d, 'rows').filter(function (r) { return !isTotalsRow(r); }); totals = d.totals || null; }
    if (!totals) {
      totals = { started: 0, paid: 0, total_paid: 0, total_fees: 0 };
      rows.forEach(function (r) { totals.started += num(r.started); totals.paid += num(r.paid); totals.total_paid += num(r.total_paid); totals.total_fees += num(r.total_fees); });
    }
    return { rows: rows, totals: totals };
  }
  function shareOf(r) { if (r.share != null && r.share !== '') return num(r.share); return num(r.started) ? num(r.paid) / num(r.started) : 0; }
  function feePctOf(r) { return num(r.total_paid) ? num(r.total_fees) / num(r.total_paid) : 0; }

  async function loadAll() {
    var mount = $('paymentsMount'); if (!mount) return;
    if (!sb()) { mount.innerHTML = '<p class="pp-muted">Supabase not available</p>'; return; }
    if (!S.loaded) mount.innerHTML = '<p class="pp-muted">Loading…</p>';
    await loadSettings();
    S.loaded = true;
    render();
    await loadTab(S.tab);
  }
  async function loadTab(tab) {
    if (tab === 'flagged') { await loadFlagged(); render(); }
    else if (tab === 'report') { await loadReport(); render(); }
    else { loadFlagged().then(render, function () { }); }
  }

  // ---------- render ----------
  function render() {
    var mount = $('paymentsMount'); if (!mount) return;
    var unresolved = (S.flagged || []).filter(function (f) { return !f.resolved_at; }).length;
    var h = '<div class="pp-tabs" role="tablist">' +
      tabBtn('options', 'Payment options') + tabBtn('flagged', 'Flagged orders' + (unresolved ? ' <span class="pp-count">' + unresolved + '</span>' : '')) + tabBtn('report', 'Report') + '</div>';
    if (S.tab === 'options') h += optionsHtml();
    else if (S.tab === 'flagged') h += flaggedHtml();
    else h += reportHtml();
    mount.innerHTML = h;
  }
  function tabBtn(k, label) { return '<button type="button" role="tab" class="pp-tab' + (S.tab === k ? ' on' : '') + '" aria-selected="' + (S.tab === k) + '" data-act="tab" data-tab="' + k + '">' + label + '</button>'; }

  function previewLine(st) {
    var on = sorted(st.options).filter(function (o) { return o.active; });
    if (!on.length) return 'No option is switched on — customers will see one “Pay on PayFast” button.';
    var all = on.filter(function (o) { return !o.device; }).map(function (o) { return o.name; });
    var dev = on.filter(function (o) { return o.device; }).map(function (o) { var d = DEVICES.filter(function (x) { return x.v === o.device; })[0]; return o.name + ' ' + (d ? d.short : ''); });
    return 'Customers will see: ' + (all.join(' · ') || '(nothing for everyone)') + (dev.length ? ' (' + dev.join(', ') + ')' : '');
  }

  function optionsHtml() {
    var st = S.settings, h = '';
    if (S.settingsErr) h += '<div class="pp-warn">Couldn’t load the payment settings: ' + esc(S.settingsErr) + '. Showing the defaults; saving may not work until this is fixed.</div>';
    else if (!S.settingsRow) h += '<div class="pp-warn">The payment settings haven’t been saved yet — showing the starting list. Customers see today’s checkout until you switch the picker on.</div>';
    h += '<div class="pp-master ' + (st.enabled ? 'on' : 'off') + '"><div><b>Payment picker is ' + (st.enabled ? 'ON' : 'OFF') + '</b><div class="pp-sub">' +
      (st.enabled ? 'Customers choose how to pay on Umzila and land on that method on PayFast.' : 'Checkout works exactly as before. You can prepare the options first.') + '</div></div>' +
      '<button type="button" class="pp-btn ' + (st.enabled ? 'danger' : 'primary') + '" data-act="master">' + (st.enabled ? 'Switch off…' : 'Switch on…') + '</button></div>' + msg('master');

    h += '<div class="pp-card"><div class="pp-h"><h3>Options at checkout</h3><button type="button" class="pp-btn primary" data-act="opt-add">+ Add option</button></div>';
    h += '<p class="pp-sub">' + esc(previewLine(st)) + '</p><p class="pp-help">Changes apply on the customer’s next checkout page load. Switch an option off if PayFast has trouble with that method. Only switch on methods that are enabled on the PayFast account and tested live.</p>' + msg('opts');
    var opts = sorted(st.options);
    if (!opts.length) h += '<p class="pp-muted">No options yet.</p>';
    h += '<div class="pp-list">' + opts.map(function (o, i) {
      var c = o.code ? CODE_SET[o.code] : null;
      var dev = DEVICES.filter(function (x) { return x.v === (o.device || ''); })[0];
      return '<div class="pp-item' + (o.active ? '' : ' dim') + '"><div class="pp-item-top">' +
        '<div class="pp-pos"><button type="button" class="pp-arrow" data-act="up" data-key="' + esc(o.key) + '" aria-label="Move ' + esc(o.name) + ' up"' + (i === 0 ? ' disabled' : '') + '>▲</button><span>' + (i + 1) + '</span><button type="button" class="pp-arrow" data-act="down" data-key="' + esc(o.key) + '" aria-label="Move ' + esc(o.name) + ' down"' + (i === opts.length - 1 ? ' disabled' : '') + '>▼</button></div>' +
        '<div class="pp-grow"><b>' + esc(o.name) + '</b><div class="pp-sub">' + esc(o.description || '') + '</div>' +
        '<div class="pp-tags"><span class="pp-pill mute">' + (o.code ? 'PayFast code ' + esc(o.code) + (c ? ' · ' + esc(c.label) : '') : 'No code — PayFast shows every method') + '</span>' +
        (o.device ? '<span class="pp-pill info">' + esc(dev ? dev.label : o.device) + '</span>' : '') +
        (o.key === 'card' ? '<span class="pp-pill info">Shows saved cards</span>' : '') +
        '<span class="pp-pill mute">Fee ' + esc(o.code ? (FEES[o.code] || 'see payfast.io/fees') : 'depends on the method') + '</span></div></div>' +
        '<label class="pp-switch" title="Switch this option on or off"><input type="checkbox" data-act="opt-toggle" data-key="' + esc(o.key) + '" aria-label="' + esc(o.name) + ' on or off"' + (o.active ? ' checked' : '') + '><span></span></label></div>' +
        '<div class="pp-actions"><button type="button" class="pp-btn" data-act="opt-edit" data-key="' + esc(o.key) + '">Edit</button>' +
        (BUILT_IN[o.key] ? '' : '<button type="button" class="pp-btn danger-o" data-act="opt-del" data-key="' + esc(o.key) + '">Remove</button>') + '</div></div>';
    }).join('') + '</div></div>';

    h += '<div class="pp-card"><div class="pp-h"><h3>Settings</h3></div><div class="pp-grid">' +
      '<div class="pp-field"><label for="ppNoAnswer">Mark “no answer” after (minutes)</label><input type="number" inputmode="numeric" id="ppNoAnswer" min="10" max="120" step="1" value="' + esc(st.no_answer_minutes) + '"><div class="pp-help">A payment with no word from PayFast after this long counts as “no answer” in the report. A late success still confirms the order. 10–120.</div></div>' +
      '<div class="pp-field"><label class="pp-check"><input type="checkbox" id="ppItnValidate"' + (st.itn_validate ? ' checked' : '') + '> Double-check every payment with PayFast</label><div class="pp-help">Asks PayFast to confirm each payment notification before the order is marked paid (only while the picker is on). Leave this on.</div></div>' +
      '</div><div class="pp-actions"><button type="button" class="pp-btn primary" data-act="settings-save">Save settings</button></div>' + msg('settings') + '</div>';
    return h;
  }

  function payBox(title, p, order) {
    if (!p) return '<div class="pp-pay"><div class="pp-pay-h">' + esc(title) + '</div><p class="pp-muted">Not recorded</p></div>';
    return '<div class="pp-pay"><div class="pp-pay-h">' + esc(title) + '</div>' +
      '<div class="pp-kv"><span>PayFast no.</span><b class="pp-mono">' + esc(p.pf_payment_id || '—') + '</b></div>' +
      '<div class="pp-kv"><span>Paid</span><b>' + money(p.amount_gross) + '</b></div>' +
      '<div class="pp-kv"><span>PayFast fee</span><b>' + money(p.amount_fee) + '</b></div>' +
      '<div class="pp-kv"><span>Option</span><b>' + esc(p.option_key ? optName(p.option_key) : '—') + '</b></div>' +
      '<div class="pp-kv"><span>When</span><b>' + esc(fmtWhen(p.started_at || (order && order.paid_at))) + '</b></div></div>';
  }
  function flagCard(f) {
    var isTwice = f.flag === 'paid_twice';
    var h = '<div class="pp-item' + (f.resolved_at ? ' dim' : '') + '"><div class="pp-item-top"><div class="pp-grow"><b>' + esc(f.order_number || f.m_payment_id || f.order_id) + '</b> · ' + esc(f.customer_name || 'Customer') +
      '<div class="pp-sub">' + esc(f.customer_email || '') + (f.customer_email ? ' · ' : '') + 'Order total ' + money(f.total) + ' · paid ' + esc(fmtWhen(f.paid_at)) + '</div></div>' +
      '<span class="pp-pill ' + (f.resolved_at ? 'ok' : 'bad') + '">' + esc(FLAG_LABEL[f.flag] || f.flag || 'Flagged') + (f.resolved_at ? ' · resolved' : '') + '</span></div>';
    if (isTwice) h += '<div class="pp-pays">' + payBox('First payment (kept)', f.first, f) + payBox('Extra payment (refund this)', f.extra, null) + '</div>';
    else h += '<div class="pp-pays">' + payBox('Payment', f.extra || f.first, f) + '</div><p class="pp-sub">PayFast took ' + money((f.extra || f.first || {}).amount_gross) + ' but the order total is ' + money(f.total) + '. The order was still confirmed. Check the order; refund the difference in PayFast if it was overcharged.</p>';
    if (!f.resolved_at) {
      if (isTwice) h += '<div class="pp-steps"><b>How to refund:</b> PayFast dashboard → Transactions → search <span class="pp-mono">' + esc((f.extra && f.extra.pf_payment_id) || 'the extra payment number') + '</span> → Refund (PayFast charges R2 ex VAT). Then press “Mark resolved”.</div>';
      h += '<div class="pp-actions"><button type="button" class="pp-btn primary" data-act="resolve" data-oid="' + esc(f.order_id) + '" data-onum="' + esc(f.order_number || '') + '">Mark resolved…</button>' + attemptsBtn(f.order_id) + '</div>';
    } else {
      h += '<div class="pp-sub">Resolved ' + esc(fmtWhen(f.resolved_at)) + (f.note ? ' · ' + esc(f.note) : '') + '</div><div class="pp-actions">' + attemptsBtn(f.order_id) + '</div>';
    }
    return h + attemptsHtml(f.order_id) + '</div>';
  }
  function attemptsBtn(oid) { return '<button type="button" class="pp-btn" data-act="attempts" data-oid="' + esc(oid) + '">' + (S.open[oid] ? 'Hide attempts' : 'All payment attempts') + '</button>'; }
  function attemptsHtml(oid) {
    if (!S.open[oid]) return '';
    var a = S.attempts[oid];
    if (!a) return '<p class="pp-muted">Loading attempts…</p>';
    if (a.error) return '<p class="pp-bad">' + esc(a.error) + '</p>';
    if (!a.rows.length) return '<p class="pp-muted">No payment attempts recorded for this order (paid before the picker, or with the picker off).</p>';
    return '<div class="pp-attempts">' + a.rows.map(function (t) {
      return '<div class="pp-att"><div><b>' + esc(optName(t.option_key)) + '</b> <span class="pp-pill ' + ({ paid: 'ok', paid_twice: 'bad', failed: 'bad', no_answer: 'warn', cancelled: 'mute', refunded: 'info' }[t.status] || 'mute') + '">' + esc(STATUS_LABEL[t.status] || t.status) + '</span></div>' +
        '<div class="pp-sub">' + esc(fmtWhen(t.started_at)) + (t.ended_at ? ' → ' + esc(fmtWhen(t.ended_at)) : '') + ' · ' + esc(t.kind === 'saved_card' ? 'saved card' : t.kind || '') + (t.device ? ' · ' + esc(t.device) : '') +
        ' · ' + money(t.amount_gross != null ? t.amount_gross : t.amount) + (t.amount_fee != null ? ' · fee ' + money(t.amount_fee) : '') + (t.pf_payment_id ? ' · PayFast ' + esc(t.pf_payment_id) : '') + (t.note ? ' · ' + esc(t.note) : '') + '</div></div>';
    }).join('') + '</div>';
  }

  function flaggedHtml() {
    var h = '<div class="pp-card"><div class="pp-h"><h3>Flagged orders</h3><button type="button" class="pp-btn" data-act="reload">↻ Refresh</button></div>' +
      '<p class="pp-sub">“Paid twice” = PayFast took two successful payments for one order; the order was confirmed once. Refund the extra one in PayFast, then mark it resolved. “Amount differs” = PayFast’s amount didn’t match the order total.</p>' + msg('flagged');
    if (S.flaggedErr) return h + '<div class="pp-warn">' + esc(S.flaggedErr) + '</div></div>';
    if (!S.flagged) return h + '<p class="pp-muted">Loading…</p></div>';
    var open = S.flagged.filter(function (f) { return !f.resolved_at; });
    var done = S.flagged.filter(function (f) { return f.resolved_at; });
    h += open.length ? '<div class="pp-list">' + open.map(flagCard).join('') + '</div>' : '<p class="pp-muted">Nothing needs attention. ✓</p>';
    if (done.length) h += '<details class="pp-details"><summary>Resolved (' + done.length + ')</summary><div class="pp-list">' + done.map(flagCard).join('') + '</div></details>';
    return h + '</div>';
  }

  function reportHtml() {
    var rg = S.range || (S.range = defaultRange());
    var h = '<div class="pp-card"><div class="pp-h"><h3>Report</h3></div>' +
      '<div class="pp-form"><div class="pp-field"><label for="ppFrom">From</label><input type="date" id="ppFrom" value="' + esc(rg.from) + '" max="' + sastDate() + '"></div>' +
      '<div class="pp-field"><label for="ppTo">To</label><input type="date" id="ppTo" value="' + esc(rg.to) + '" max="' + sastDate() + '"></div>' +
      '<button type="button" class="pp-btn primary" data-act="range">Show</button></div>' +
      '<div class="pp-actions"><button type="button" class="pp-btn" data-act="quick" data-days="7">Last 7 days</button><button type="button" class="pp-btn" data-act="quick" data-days="30">Last 30 days</button><button type="button" class="pp-btn" data-act="quick" data-days="month">This month</button></div>' + msg('range') +
      '<p class="pp-help">Dates are South African time. “Started” counts each press of Pay; “Paid” are the ones PayFast confirmed. Amounts and fees come from PayFast’s notifications.</p></div>';

    h += '<div class="pp-card"><div class="pp-h"><h3>Per payment option</h3>' + (S.report && S.report.rows.length ? '<button type="button" class="pp-btn" data-act="csv-report">⬇ CSV</button>' : '') + '</div>';
    if (S.reportErr) h += '<div class="pp-warn">' + esc(S.reportErr) + '</div>';
    else if (!S.report) h += '<p class="pp-muted">Loading…</p>';
    else if (!S.report.rows.length) h += '<p class="pp-muted">No payment attempts in this period.</p>';
    else {
      var T = S.report.totals;
      h += '<div class="pp-tablewrap"><table class="pp-table"><thead><tr><th>Option</th><th>Started</th><th>Paid</th><th>Share paid</th><th>Total paid</th><th>PayFast fees</th><th>Fee %</th></tr></thead><tbody>' +
        S.report.rows.map(function (r) {
          return '<tr><td>' + esc(r.name || optName(r.option_key)) + '</td><td>' + num(r.started) + '</td><td>' + num(r.paid) + '</td><td>' + pct(shareOf(r)) + '</td><td>' + money(r.total_paid) + '</td><td>' + money(r.total_fees) + '</td><td>' + pct(feePctOf(r)) + '</td></tr>';
        }).join('') + '</tbody><tfoot><tr><td>Total</td><td>' + num(T.started) + '</td><td>' + num(T.paid) + '</td><td>' + pct(shareOf(T)) + '</td><td>' + money(T.total_paid) + '</td><td>' + money(T.total_fees) + '</td><td>' + pct(feePctOf(T)) + '</td></tr></tfoot></table></div>';
    }
    h += '</div>';

    h += '<div class="pp-card"><div class="pp-h"><h3>Paid orders' + (S.paid && S.paid.length >= 100 ? ' (newest 100)' : '') + '</h3>' + (S.paid && S.paid.length ? '<button type="button" class="pp-btn" data-act="csv-paid">⬇ CSV</button>' : '') + '</div>';
    if (S.paidErr) h += '<div class="pp-warn">' + esc(S.paidErr) + '</div>';
    else if (!S.paid) h += '<p class="pp-muted">Loading…</p>';
    else if (!S.paid.length) h += '<p class="pp-muted">No paid orders in this period.</p>';
    else h += '<div class="pp-list">' + S.paid.map(function (r) {
      return '<div class="pp-item"><div class="pp-item-top"><div class="pp-grow"><b>' + esc(r.order_number || r.order_id) + '</b> · ' + esc(r.customer_name || 'Customer') +
        '<div class="pp-sub">' + esc(fmtWhen(r.paid_at)) + ' · total ' + money(r.total) + '</div></div>' + (r.flag ? '<span class="pp-pill bad">' + esc(FLAG_LABEL[r.flag] || r.flag) + '</span>' : '') + '</div>' +
        '<div class="pp-kvs"><div class="pp-kv"><span>Paid with</span><b>' + esc(paidWith(r)) + '</b></div><div class="pp-kv"><span>PayFast took</span><b>' + money(r.amount_gross) + '</b></div><div class="pp-kv"><span>PayFast fee</span><b>' + money(r.amount_fee) + '</b></div><div class="pp-kv"><span>Net</span><b>' + money(r.amount_net) + '</b></div></div>' +
        '<div class="pp-actions">' + attemptsBtn(r.order_id) + '</div>' + attemptsHtml(r.order_id) + '</div>';
    }).join('') + '</div>';
    return h + '</div>';
  }

  // ---------- modal ----------
  function modal(html, onReady) {
    closeModal();
    var o = document.createElement('div'); o.id = 'ppModal'; o.className = 'pp-modal';
    o.innerHTML = '<div class="pp-sheet" role="dialog" aria-modal="true">' + html + '</div>';
    o.addEventListener('click', function (e) { if (e.target === o) closeModal(); });
    document.body.appendChild(o);
    if (onReady) onReady(o);
    var f = o.querySelector('input,select,textarea'); if (f) try { f.focus(); } catch (e) { /* ignore */ }
    return o;
  }
  function closeModal() { var o = $('ppModal'); if (o) o.remove(); }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('ppModal')) closeModal(); });
  function confirmBox(title, body, okLabel, danger) {
    return new Promise(function (resolve) {
      modal('<h3>' + esc(title) + '</h3><div class="pp-body">' + body + '</div><div class="pp-actions end"><button type="button" class="pp-btn" id="ppNo">Cancel</button><button type="button" class="pp-btn ' + (danger ? 'danger' : 'primary') + '" id="ppYes">' + esc(okLabel) + '</button></div>', function (o) {
        o.querySelector('#ppNo').onclick = function () { closeModal(); resolve(false); };
        o.querySelector('#ppYes').onclick = function () { closeModal(); resolve(true); };
      });
    });
  }

  // ---------- actions ----------
  async function masterSwitch() {
    var on = !S.settings.enabled;
    var active = S.settings.options.filter(function (o) { return o.active; });
    var ok = await confirmBox(on ? 'Switch the payment picker ON?' : 'Switch the payment picker OFF?',
      '<p>Off = checkout exactly as before. On = customers choose how to pay on Umzila and land on that method on PayFast.</p><p>Only switch on methods that are enabled on the PayFast account and tested live.</p>' +
      (on ? '<p class="pp-sub">Customers will see: ' + esc(previewLine(S.settings).replace(/^Customers will see: /, '')) + '</p>' + (active.length ? '' : '<p class="pp-bad">No option is switched on, so customers will get one “Pay on PayFast” button.</p>') : '<p class="pp-sub">Payments already started keep working; flagged orders and the report stay here.</p>'),
      on ? 'Yes, switch on' : 'Yes, switch off', !on);
    if (!ok) return;
    var res = await saveWith(function (v) { v.enabled = on; });
    setMsg('master', res.ok ? ('The payment picker is now ' + (on ? 'ON' : 'OFF') + '.') : res.error, res.ok);
    render();
  }
  async function settingsSave() {
    var raw = $('ppNoAnswer').value.trim(); var m = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (!(m >= 10 && m <= 120)) { setMsg('settings', '“Mark no answer after” must be a whole number from 10 to 120.', false); render(); return; }
    var iv = $('ppItnValidate').checked;
    var res = await saveWith(function (v) { v.no_answer_minutes = m; v.itn_validate = iv; });
    setMsg('settings', res.ok ? 'Settings saved.' : res.error, res.ok); render();
  }
  async function toggleOpt(key, on, box) {
    if (box) box.disabled = true;
    var res = await saveWith(function (v) { var o = v.options.filter(function (x) { return x.key === key; })[0]; if (!o) return false; o.active = on; });
    var o = S.settings.options.filter(function (x) { return x.key === key; })[0];
    setMsg('opts', res.ok ? ((o ? o.name : key) + ' is now ' + (on ? 'on' : 'off') + '.') : res.error, res.ok); render();
  }
  async function moveOpt(key, dir) {
    var res = await saveWith(function (v) {
      var opts = sorted(v.options); var i = opts.map(function (x) { return x.key; }).indexOf(key); var j = i + dir;
      if (i < 0 || j < 0 || j >= opts.length) return false;
      var t = opts[i]; opts[i] = opts[j]; opts[j] = t;
      v.options = opts.map(function (o, k) { return Object.assign({}, o, { position: k + 1 }); });
    });
    if (!res.ok && res.error !== 'Nothing changed') setMsg('opts', res.error, false); else delete S.msgs.opts;
    render();
  }
  async function delOpt(key) {
    var o = S.settings.options.filter(function (x) { return x.key === key; })[0]; if (!o) return;
    if (!(await confirmBox('Remove “' + o.name + '”?', '<p>It disappears from checkout on the next page load. Past payments made with it stay in the report. You can add it again later from the PayFast code list.</p>', 'Remove', true))) return;
    var res = await saveWith(function (v) { var n = v.options.length; v.options = v.options.filter(function (x) { return x.key !== key; }); if (v.options.length === n) return false; });
    setMsg('opts', res.ok ? (o.name + ' removed.') : res.error, res.ok); render();
  }
  function deviceSelect(cur) { return '<select id="ppfDevice">' + DEVICES.map(function (d) { return '<option value="' + d.v + '"' + ((cur || '') === d.v ? ' selected' : '') + '>' + esc(d.label) + '</option>'; }).join('') + '</select>'; }
  function optForm(o, adding) {
    var used = {}; var hasCatch = false;
    S.settings.options.forEach(function (x) { if (x.code) used[x.code] = 1; else hasCatch = true; });
    var codeField;
    if (adding) {
      var choices = CODES.filter(function (c) { return !used[c.code]; }).map(function (c) { return '<option value="' + c.code + '">' + esc(c.label) + ' (' + c.code + ')' + '</option>'; }).join('');
      if (!hasCatch) choices += '<option value="__none">None — catch-all: PayFast shows every method</option>';
      codeField = '<div class="pp-field"><label for="ppfCode">PayFast method</label>' + (choices ? '<select id="ppfCode"><option value="">Choose…</option>' + choices + '</select>' : '<p class="pp-muted">Every PayFast code is already in the list.</p>') + '<div class="pp-help" id="ppfFee">Only add methods that are enabled on the PayFast account.</div></div>';
    } else {
      var c = o.code ? CODE_SET[o.code] : null;
      codeField = '<div class="pp-field"><label>PayFast method</label><div class="pp-sub">' + (o.code ? esc(c ? c.label : o.code) + ' (code ' + esc(o.code) + ') · fee ' + esc(FEES[o.code] || 'see payfast.io/fees') : 'None — catch-all, PayFast shows every method') + '</div><div class="pp-help">The code can’t be changed. To use another method, add a new option and switch this one off.</div></div>';
    }
    return '<h3>' + (adding ? 'Add a payment option' : 'Edit ' + esc(o.name)) + '</h3><div class="pp-body">' + codeField +
      '<div class="pp-field"><label for="ppfName">Name customers see</label><input type="text" id="ppfName" maxlength="40" value="' + esc(o ? o.name : '') + '" autocomplete="off"><div class="pp-help"><span id="ppfNameN">' + (o ? String(o.name || '').length : 0) + '</span>/40</div></div>' +
      '<div class="pp-field"><label for="ppfDesc">Line under the name</label><input type="text" id="ppfDesc" maxlength="90" value="' + esc(o ? o.description || '' : '') + '" autocomplete="off"><div class="pp-help"><span id="ppfDescN">' + (o ? String(o.description || '').length : 0) + '</span>/90' + ((!o || o.code == null) ? ' · For the catch-all, name only methods that are enabled on the PayFast account.' : '') + '</div></div>' +
      '<div class="pp-field"><label for="ppfDevice">Who sees it</label>' + deviceSelect(o ? o.device : null) + '<div class="pp-help">Apple Pay only works on Apple devices, Google Pay on Android. Other customers simply don’t see it.</div></div>' +
      (adding ? '<label class="pp-check"><input type="checkbox" id="ppfActive"> Switch on now (otherwise it is added switched off)</label>' : '') +
      '<div class="pp-msg bad" id="ppfErr" style="display:none"></div></div>' +
      '<div class="pp-actions end"><button type="button" class="pp-btn" id="ppNo">Cancel</button><button type="button" class="pp-btn primary" id="ppfSave">' + (adding ? 'Add option' : 'Save') + '</button></div>';
  }
  function openOptForm(key) {
    var adding = !key;
    var o = adding ? null : S.settings.options.filter(function (x) { return x.key === key; })[0];
    if (!adding && !o) return;
    modal(optForm(o, adding), function (m) {
      var err = m.querySelector('#ppfErr');
      function fail(t) { err.textContent = t; err.style.display = 'block'; }
      m.querySelector('#ppNo').onclick = closeModal;
      ['Name', 'Desc'].forEach(function (k) { var i = m.querySelector('#ppf' + k); i.addEventListener('input', function () { m.querySelector('#ppf' + k + 'N').textContent = i.value.length; }); });
      var codeSel = m.querySelector('#ppfCode');
      if (codeSel) codeSel.addEventListener('change', function () {
        var v = codeSel.value, c = CODE_SET[v];
        var nm = m.querySelector('#ppfName');
        if (c && !nm.value.trim()) { nm.value = c.label.replace(/ \(credit & cheque\)$/, ''); m.querySelector('#ppfNameN').textContent = nm.value.length; }
        if (v === '__none' && !nm.value.trim()) { nm.value = 'More ways to pay'; m.querySelector('#ppfNameN').textContent = nm.value.length; }
        var dev = m.querySelector('#ppfDevice');
        if (v === 'ap') dev.value = 'apple'; else if (v === 'gp') dev.value = 'android'; else if (v === 'sp') dev.value = 'samsung';
        m.querySelector('#ppfFee').textContent = c ? ('PayFast fee: ' + (FEES[v] || 'see payfast.io/fees') + ' (ex VAT). Only add methods that are enabled on the PayFast account.') : 'Customers choose the method on PayFast’s own page.';
      });
      m.querySelector('#ppfSave').onclick = async function () {
        var btn = this;
        var name = m.querySelector('#ppfName').value.trim(), desc = m.querySelector('#ppfDesc').value.trim(), device = m.querySelector('#ppfDevice').value || null;
        if (!name) return fail('Add the name customers will see.');
        if (name.length > 40) return fail('The name can be at most 40 characters.');
        if (desc.length > 90) return fail('The line under the name can be at most 90 characters.');
        var code = null, newKey = null;
        if (adding) {
          if (!codeSel || !codeSel.value) return fail('Choose the PayFast method.');
          code = codeSel.value === '__none' ? null : codeSel.value;
          var base = code ? CODE_SET[code].key : 'more';
          var taken = {}; S.settings.options.forEach(function (x) { taken[x.key] = 1; });
          newKey = base; var n = 2; while (taken[newKey]) { newKey = (base + '_' + 'abcdefghij'.charAt(n - 2)).slice(0, 30); n++; }
        }
        btn.disabled = true; btn.textContent = 'Saving…';
        var active = adding ? !!m.querySelector('#ppfActive').checked : null;
        var res = await saveWith(function (v) {
          if (adding) {
            if (v.options.some(function (x) { return x.key === newKey; })) newKey = newKey.slice(0, 26) + '_' + 'xyz'.charAt(Math.floor(Math.random() * 3));
            v.options.push({ key: newKey, name: name, description: desc, code: code, active: active, position: v.options.length + 1, device: device });
          } else {
            var t = v.options.filter(function (x) { return x.key === key; })[0]; if (!t) return false;
            t.name = name; t.description = desc; t.device = device;
          }
        });
        if (!res.ok) { btn.disabled = false; btn.textContent = adding ? 'Add option' : 'Save'; return fail(res.error); }
        closeModal(); setMsg('opts', adding ? (name + ' added' + (active ? ' and switched on.' : ' (switched off — switch it on when it has been tested).')) : (name + ' saved.'), true); render();
      };
    });
  }

  function resolveFlag(oid, onum) {
    modal('<h3>Mark ' + esc(onum || 'this order') + ' resolved?</h3><div class="pp-body"><p>Do this after you’ve refunded the extra payment in PayFast (or checked that nothing needs refunding).</p>' +
      '<div class="pp-field"><label for="ppNote">Note (what you did)</label><textarea id="ppNote" rows="3" maxlength="300" placeholder="e.g. Refunded R92.46 in PayFast on 15 Nov"></textarea><div class="pp-help">Saved with the order. Max 300 characters.</div></div><div class="pp-msg bad" id="ppNoteErr" style="display:none"></div></div>' +
      '<div class="pp-actions end"><button type="button" class="pp-btn" id="ppNo">Cancel</button><button type="button" class="pp-btn primary" id="ppYes">Mark resolved</button></div>', function (m) {
      m.querySelector('#ppNo').onclick = closeModal;
      m.querySelector('#ppYes').onclick = async function () {
        var btn = this, note = m.querySelector('#ppNote').value.trim(), er = m.querySelector('#ppNoteErr');
        if (note.length < 3) { er.textContent = 'Add a short note so the next admin knows what was done.'; er.style.display = 'block'; return; }
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
          await rpc('admin_payment_resolve_flag', { p_order_id: oid, p_note: note });
          closeModal(); setMsg('flagged', (onum || 'Order') + ' marked resolved.', true);
          await loadFlagged(); render();
        } catch (e) { btn.disabled = false; btn.textContent = 'Mark resolved'; er.textContent = friendly(e); er.style.display = 'block'; }
      };
    });
  }
  async function toggleAttempts(oid) {
    if (S.open[oid]) { delete S.open[oid]; render(); return; }
    S.open[oid] = true; render();
    if (S.attempts[oid] && !S.attempts[oid].error) return;
    try { S.attempts[oid] = { rows: list(await rpc('admin_payment_attempts', { p_order_id: oid }), 'attempts') }; }
    catch (e) { S.attempts[oid] = { rows: [], error: friendly(e) }; }
    render();
  }
  async function setRange(from, to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) { setMsg('range', 'Choose both dates.', false); render(); return; }
    if (from > to) { setMsg('range', '“From” must be on or before “To”.', false); render(); return; }
    if ((Date.parse(to) - Date.parse(from)) / 864e5 > 366) { setMsg('range', 'Choose a period of a year or less.', false); render(); return; }
    delete S.msgs.range; S.range = { from: from, to: to };
    S.report = null; S.paid = null; render();
    await loadReport(); render();
  }
  function quick(days) {
    var t = sastDate();
    if (days === 'month') return setRange(t.slice(0, 8) + '01', t);
    return setRange(addDays(t, -(Number(days) - 1)), t);
  }

  // ---------- CSV (client-side, from what is on screen) ----------
  function csvCell(v) { var s = v == null ? '' : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function download(name, rows) {
    var csv = '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function r2(v) { return v == null || v === '' ? '' : num(v).toFixed(2); }
  function csvReport() {
    if (!S.report) return; var rg = S.range;
    var rows = [['Option', 'Option key', 'Started', 'Paid', 'Share paid %', 'Total paid (R)', 'PayFast fees (R)', 'Fee %']];
    S.report.rows.forEach(function (r) { rows.push([r.name || optName(r.option_key), r.option_key, num(r.started), num(r.paid), (shareOf(r) * 100).toFixed(1), r2(r.total_paid), r2(r.total_fees), (feePctOf(r) * 100).toFixed(2)]); });
    var T = S.report.totals; rows.push(['Total', '', num(T.started), num(T.paid), (shareOf(T) * 100).toFixed(1), r2(T.total_paid), r2(T.total_fees), (feePctOf(T) * 100).toFixed(2)]);
    download('umzila-payments-report-' + rg.from + '-to-' + rg.to + '.csv', rows);
  }
  function csvPaid() {
    if (!S.paid) return; var rg = S.range;
    var rows = [['Order', 'Paid at (SAST)', 'Customer', 'Order total (R)', 'Paid with', 'Option key', 'PayFast code', 'PayFast payment no.', 'PayFast took (R)', 'PayFast fee (R)', 'Net (R)', 'Flag']];
    S.paid.forEach(function (r) { rows.push([r.order_number, fmtWhen(r.paid_at), r.customer_name, r2(r.total), paidWith(r), r.option_key, r.payment_method_code, r.pf_payment_id, r2(r.amount_gross), r2(r.amount_fee), r2(r.amount_net), r.flag ? (FLAG_LABEL[r.flag] || r.flag) : '']); });
    download('umzila-paid-orders-' + rg.from + '-to-' + rg.to + '.csv', rows);
  }

  // ---------- dashboard badge ----------
  function updateBadge() {
    var b = $('paymentsFlagBadge'); if (!b) return;
    var n = (S.flagged || []).filter(function (f) { return !f.resolved_at; }).length;
    if (!n) { b.hidden = true; return; }
    b.hidden = false;
    b.innerHTML = '💳 <b>Payments: ' + n + ' flagged</b> <span>— an order was paid twice or the amount differs. Review →</span>';
  }
  window.loadPaymentsBadge = function () {
    if (!sb()) return;
    loadFlagged().catch(function () { /* badge stays hidden */ });
  };
  function openFlaggedFromBadge() {
    S.tab = 'flagged';
    var li = document.querySelector('.menu li[data-section="payments"]'); if (li) li.click();
  }

  // ---------- events ----------
  function wire() {
    var root = $('section-payments'); if (!root || root.dataset.wired) return; root.dataset.wired = '1';
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b || b.type === 'checkbox' || b.disabled) return;
      var a = b.dataset.act, key = b.dataset.key;
      var run = function (p) { Promise.resolve(p).catch(function (err) { toast(friendly(err)); }); };
      if (a === 'tab') { S.tab = b.dataset.tab; render(); run(loadTab(S.tab)); }
      else if (a === 'reload') run(loadTab(S.tab));
      else if (a === 'master') run(masterSwitch());
      else if (a === 'settings-save') run(settingsSave());
      else if (a === 'opt-add') openOptForm(null);
      else if (a === 'opt-edit') openOptForm(key);
      else if (a === 'opt-del') run(delOpt(key));
      else if (a === 'up') run(moveOpt(key, -1));
      else if (a === 'down') run(moveOpt(key, 1));
      else if (a === 'resolve') resolveFlag(b.dataset.oid, b.dataset.onum);
      else if (a === 'attempts') run(toggleAttempts(b.dataset.oid));
      else if (a === 'range') run(setRange($('ppFrom').value, $('ppTo').value));
      else if (a === 'quick') run(quick(b.dataset.days));
      else if (a === 'csv-report') csvReport();
      else if (a === 'csv-paid') csvPaid();
    });
    root.addEventListener('change', function (e) {
      var t = e.target; if (!t.dataset || t.dataset.act !== 'opt-toggle') return;
      toggleOpt(t.dataset.key, t.checked, t).catch(function (err) { toast(friendly(err)); });
    });
  }
  function wireBadge() {
    var b = $('paymentsFlagBadge'); if (!b || b.dataset.wired) return; b.dataset.wired = '1';
    b.addEventListener('click', function (e) { e.preventDefault(); openFlaggedFromBadge(); });
  }

  function injectCss() {
    if ($('ppCss')) return;
    var R = '#section-payments ';
    var s = document.createElement('style'); s.id = 'ppCss';
    s.textContent = [
      '#section-payments{--ppb:#0a2f66}',
      R + '.pp-muted{color:#6b7280;font-size:13px}',
      R + '.pp-sub,#ppModal .pp-sub{font-size:12.5px;color:#6b7280;margin-top:3px}',
      R + '.pp-help,#ppModal .pp-help{font-size:11.5px;color:#6b7280;margin-top:3px}',
      R + '.pp-bad,#ppModal .pp-bad{color:#b91c1c;font-size:13px}',
      R + '.pp-tabs{display:flex;gap:6px;overflow-x:auto;margin-bottom:12px;padding-bottom:2px;-webkit-overflow-scrolling:touch}',
      R + '.pp-tab{flex:0 0 auto;border:1px solid #d1d5db;background:#fff;border-radius:999px;padding:9px 14px;font:inherit;font-size:14px;font-weight:700;color:#374151;cursor:pointer;min-height:40px}',
      R + '.pp-tab.on{background:var(--ppb);border-color:var(--ppb);color:#fff}',
      R + '.pp-count{display:inline-block;background:#dc2626;color:#fff;border-radius:999px;padding:0 7px;font-size:12px;margin-left:4px}',
      R + '.pp-card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px;margin-bottom:14px;min-width:0}',
      R + '.pp-h{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}',
      R + '.pp-h h3{margin:0;font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#374151}',
      R + '.pp-master{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;border-radius:14px;padding:14px;margin-bottom:14px;color:#fff}',
      R + '.pp-master.on{background:linear-gradient(150deg,#047857,#059669)}',
      R + '.pp-master.off{background:linear-gradient(150deg,#374151,#4b5563)}',
      R + '.pp-master .pp-sub{color:rgba(255,255,255,.85)}',
      R + '.pp-master b{font-size:17px}',
      R + '.pp-master .pp-btn{border-color:#fff}',
      R + '.pp-btn,#ppModal .pp-btn{border:1px solid #d1d5db;background:#fff;color:#111827;border-radius:10px;padding:10px 14px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;min-height:42px}',
      R + '.pp-btn.primary,#ppModal .pp-btn.primary{background:var(--ppb,#0a2f66);border-color:var(--ppb,#0a2f66);color:#fff}',
      R + '.pp-btn.danger,#ppModal .pp-btn.danger{background:#dc2626;border-color:#dc2626;color:#fff}',
      R + '.pp-btn.danger-o{color:#b91c1c;border-color:#fca5a5}',
      R + '.pp-btn:disabled,#ppModal .pp-btn:disabled{opacity:.6;cursor:default}',
      R + '.pp-actions,#ppModal .pp-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}',
      '#ppModal .pp-actions.end{justify-content:flex-end}',
      R + '.pp-list{display:flex;flex-direction:column;gap:10px;margin-top:8px}',
      R + '.pp-item{border:1px solid #e5e7eb;border-radius:12px;padding:12px;background:#f9fafb;min-width:0;word-break:break-word}',
      R + '.pp-item.dim{opacity:.7}',
      R + '.pp-item-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}',
      R + '.pp-grow{flex:1 1 auto;min-width:0}',
      R + '.pp-pos{display:flex;flex-direction:column;align-items:center;gap:2px;font-weight:800;color:#374151;flex:0 0 auto}',
      R + '.pp-arrow{border:1px solid #d1d5db;background:#fff;border-radius:8px;width:36px;height:30px;font-size:12px;cursor:pointer;color:#374151}',
      R + '.pp-arrow:disabled{opacity:.35;cursor:default}',
      R + '.pp-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}',
      R + '.pp-pill,#ppModal .pp-pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:700}',
      R + '.pp-pill.ok{background:#d1fae5;color:#065f46}' + R + '.pp-pill.warn{background:#fef3c7;color:#92400e}' + R + '.pp-pill.info{background:#dbeafe;color:#1e40af}' + R + '.pp-pill.mute{background:#f3f4f6;color:#4b5563}' + R + '.pp-pill.bad{background:#fee2e2;color:#991b1b}',
      R + '.pp-switch{position:relative;display:inline-block;width:46px;height:26px;flex:0 0 auto}',
      R + '.pp-switch input{opacity:0;width:0;height:0;position:absolute}',
      R + '.pp-switch span{position:absolute;inset:0;background:#cbd5e1;border-radius:999px;transition:.15s;cursor:pointer}',
      R + '.pp-switch span:before{content:"";position:absolute;width:20px;height:20px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.15s}',
      R + '.pp-switch input:checked+span{background:#059669}',
      R + '.pp-switch input:checked+span:before{transform:translateX(20px)}',
      R + '.pp-switch input:focus-visible+span{outline:2px solid #2563eb;outline-offset:2px}',
      R + '.pp-form{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:6px 0}',
      R + '.pp-form .pp-field{flex:1 1 140px}',
      R + '.pp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}',
      R + '.pp-field,#ppModal .pp-field{display:flex;flex-direction:column;gap:4px;min-width:0;margin-bottom:10px}',
      R + '.pp-field label,#ppModal .pp-field label{font-size:12px;font-weight:700;color:#374151}',
      R + 'input[type=date],' + R + 'input[type=number],#ppModal input[type=text],#ppModal select,#ppModal textarea{padding:10px;border:1px solid #d1d5db;border-radius:8px;font:inherit;font-size:16px;min-width:0;width:100%;box-sizing:border-box;background:#fff}',
      R + '.pp-check,#ppModal .pp-check{display:flex;gap:8px;align-items:center;font-size:14px;font-weight:700;margin:6px 0;color:#111827}',
      R + '.pp-check input,#ppModal .pp-check input{width:20px;height:20px}',
      R + '.pp-msg,#ppModal .pp-msg{font-size:13px;margin:8px 0;padding:8px 10px;border-radius:8px}',
      R + '.pp-msg.ok{background:#ecfdf5;color:#065f46}',
      R + '.pp-msg.bad,#ppModal .pp-msg.bad{background:#fef2f2;color:#991b1b}',
      R + '.pp-warn{background:#fef3c7;color:#92400e;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:12px}',
      R + '.pp-pays{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:10px}',
      R + '.pp-pay{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:10px}',
      R + '.pp-pay-h{font-weight:800;font-size:12.5px;color:#374151;margin-bottom:6px}',
      R + '.pp-kvs{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:4px 12px;margin-top:8px}',
      R + '.pp-kv{display:flex;justify-content:space-between;gap:8px;font-size:13px;padding:2px 0}',
      R + '.pp-kv span{color:#6b7280}',
      R + '.pp-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;word-break:break-all}',
      R + '.pp-steps{background:#eff6ff;color:#1e3a8a;border-radius:8px;padding:8px 10px;font-size:13px;margin-top:10px;line-height:1.45}',
      R + '.pp-details{margin-top:12px}' + R + '.pp-details summary{cursor:pointer;font-weight:800;color:#374151;padding:6px 0}',
      R + '.pp-attempts{margin-top:8px;border-top:1px dashed #d1d5db;padding-top:8px;display:flex;flex-direction:column;gap:8px}',
      R + '.pp-att{font-size:13px}',
      R + '.pp-tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}',
      R + '.pp-table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:560px}',
      R + '.pp-table th,' + R + '.pp-table td{text-align:right;padding:8px 6px;border-bottom:1px solid #f1f5f9;white-space:nowrap}',
      R + '.pp-table th:first-child,' + R + '.pp-table td:first-child{text-align:left;white-space:normal}',
      R + '.pp-table th{font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280}',
      R + '.pp-table tfoot td{font-weight:800;border-top:2px solid #e5e7eb}',
      '#paymentsFlagBadge{display:block;background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;border-radius:12px;padding:10px 12px;margin-bottom:12px;font-size:14px;text-decoration:none;cursor:pointer}',
      '#paymentsFlagBadge[hidden]{display:none}',
      '#paymentsFlagBadge span{color:#7f1d1d;font-size:13px}',
      '.pp-modal{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:12px}',
      '.pp-sheet{background:#fff;border-radius:16px;width:100%;max-width:480px;max-height:92vh;overflow:auto;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.3);box-sizing:border-box}',
      '.pp-sheet h3{margin:0 0 10px;font-size:17px}',
      '.pp-sheet p{margin:0 0 10px;font-size:14px;line-height:1.45}',
      '@media (max-width:640px){.pp-modal{align-items:flex-end;padding:0}.pp-sheet{border-radius:16px 16px 0 0;max-width:none;padding-bottom:calc(18px + env(safe-area-inset-bottom))}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  window.loadPaymentsAdmin = function () {
    injectCss(); wire();
    var p = loadAll(); if (p && p.catch) p.catch(function (e) { toast(friendly(e)); });
  };

  // Dashboard badge on first load: wait (briefly) for admin.html's supabaseClient + session.
  (function boot() {
    injectCss(); wireBadge();
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      var c = sb();
      if (c && c.auth) {
        clearInterval(t);
        c.auth.getSession().then(function (r) { if (r && r.data && r.data.session) window.loadPaymentsBadge(); }, function () { });
      } else if (tries > 40) clearInterval(t);
    }, 500);
  })();
})();
