/* Admin → Delivery Times (delivery timeslots console).
   Plan: docs/plans/delivery-timeslots-plan.md (workstream C). Loaded by admin.html.
   Reads/writes ONLY through admin-checked RLS (delivery_slots, delivery_slot_exceptions,
   admin_alert_emails, site_settings key 'timeslots'), SECURITY DEFINER RPCs
   (get_run_sheet, admin_affected_orders, admin_runs_for_order, admin_move_order_run) and
   netlify/functions/timeslot-admin.js (Bearer token). No keys in this file.
   Uses the page's global `supabaseClient` (admin.html). */
(function () {
  'use strict';
  var TZ = 'Africa/Johannesburg';
  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DEFAULTS = { enabled: false, cutoff_minutes: 15, grace_minutes: 5, days_ahead: 1, busy_alert_at: 6, rider_notice_minutes: 30 };
  var STATE_LABEL = { taking_orders: 'Taking orders', preparing: 'Preparing', out_for_delivery: 'Out for delivery', done: 'Done', skipped: 'Skipped', paused: 'Paused', off: 'Slot off' };

  var S = { slots: [], settings: Object.assign({}, DEFAULTS), settingsRow: null, exceptions: [], alerts: [], sheet: [], attention: [], affected: null, loaded: false, busy: false, undo: null, msgs: {} };
  var timer = null;

  function sb() { return typeof supabaseClient !== 'undefined' ? supabaseClient : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(m) { try { if (typeof showToast === 'function') return showToast(m); } catch (e) { /* ignore */ } try { alert(m); } catch (e2) { /* ignore */ } }
  function $(id) { return document.getElementById(id); }

  // ---------- time helpers (all SAST, display only; the server decides everything) ----------
  function sastDate(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date()); }
  function addDays(ymd, n) { var p = ymd.split('-').map(Number); var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)); return d.toISOString().slice(0, 10); }
  function hm(t) { return t ? String(t).slice(0, 5) : ''; }
  function fmtT(ts) { return ts ? new Intl.DateTimeFormat('en-ZA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts)) : '—'; }
  function fmtD(ymd) { if (!ymd) return '—'; var p = String(ymd).slice(0, 10).split('-').map(Number); return new Intl.DateTimeFormat('en-ZA', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(Date.UTC(p[0], p[1] - 1, p[2]))); }
  function fmtWin(a, b) { return fmtT(a) + '–' + fmtT(b); }
  function dayLabel(ymd) { var t = sastDate(); return ymd === t ? 'Today' : ymd === addDays(t, 1) ? 'Tomorrow' : fmtD(ymd); }
  function minusMin(t, m) { var p = hm(t).split(':').map(Number); var x = ((p[0] * 60 + p[1] - m) % 1440 + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); }
  function winOf(o) { return o.window_start ? fmtWin(o.window_start, o.window_end) : ''; }

  // ---------- server calls ----------
  async function api(body) {
    var c = sb(); if (!c) throw new Error('Not connected');
    var r0 = await c.auth.getSession(); var session = r0 && r0.data && r0.data.session;
    if (!session) throw new Error('Not signed in');
    var r = await fetch('/.netlify/functions/timeslot-admin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify(body) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || j.error) throw new Error(j.error || ('Error ' + r.status));
    return j;
  }
  function list(d) { if (Array.isArray(d)) return d; if (d && Array.isArray(d.runs)) return d.runs; if (d && Array.isArray(d.orders)) return d.orders; return []; }
  function friendly(err) {
    var m = (err && err.message) || String(err || 'Something went wrong');
    if (/SLOT_OVERLAP/.test(m)) return 'That slot overlaps another slot on one of the same days (switched-off slots count too). Change the times or the days.';
    if (/SLOT_HAS_PAID_ORDERS/.test(m)) return 'This slot has paid orders in future runs, so it can’t be deleted. Switch it off instead, then move or refund those orders.';
    if (/row-level security|permission denied|42501/i.test(m)) return 'You don’t have permission to do that (admins only).';
    if (/does not exist|PGRST202|42883/.test(m)) return 'The delivery-times database objects aren’t available yet (' + m + ').';
    return m;
  }

  // ---------- load ----------
  async function loadAll(quiet) {
    var c = sb(); var mount = $('timeslotsMount'); if (!mount) return;
    if (!c) { mount.innerHTML = '<p class="ts-muted">Supabase not available</p>'; return; }
    if (!S.loaded && !quiet) mount.innerHTML = '<p class="ts-muted">Loading…</p>';
    var today = sastDate();
    try {
      var res = await Promise.all([
        c.from('delivery_slots').select('*').order('start_time', { ascending: true }),
        c.from('site_settings').select('value, updated_at').eq('key', 'timeslots').maybeSingle(),
        c.from('delivery_slot_exceptions').select('*').gte('run_date', today).order('run_date', { ascending: true }),
        c.from('admin_alert_emails').select('*').order('created_at', { ascending: true }),
        c.rpc('get_run_sheet', { p_from: today, p_to: addDays(today, 1) })
      ]);
      var errs = [];
      if (res[0].error) errs.push('slots: ' + res[0].error.message); else S.slots = res[0].data || [];
      if (res[1].error) errs.push('settings: ' + res[1].error.message); else { S.settingsRow = res[1].data; S.settings = Object.assign({}, DEFAULTS, (res[1].data && res[1].data.value) || {}); }
      if (res[2].error) errs.push('date controls: ' + res[2].error.message); else S.exceptions = res[2].data || [];
      if (res[3].error) errs.push('alert emails: ' + res[3].error.message); else S.alerts = res[3].data || [];
      S.sheetErr = null;
      if (res[4].error) { S.sheetErr = res[4].error.message; S.sheet = []; } else S.sheet = list(res[4].data);
      S.loadErrs = errs;
      // Best effort: every paid order flagged "needs attention" (may fall outside today/tomorrow).
      try {
        var a = await c.from('orders').select('id,order_number,customer_name,customer_phone,delivery_address,slot_window_start,slot_window_end,slot_run_date,slot_id').eq('slot_needs_attention', true).eq('payment_status', 'paid').order('paid_at', { ascending: false }).limit(50);
        S.attention = a.error ? [] : (a.data || []);
      } catch (e) { S.attention = []; }
      S.loaded = true;
    } catch (e) {
      mount.innerHTML = '<p style="color:#dc2626">Couldn’t load Delivery Times: ' + esc(friendly(e)) + '</p>'; return;
    }
    render();
  }

  // ---------- render ----------
  function msg(key) { var m = S.msgs[key]; return m ? '<div class="ts-msg ' + (m.ok ? 'ok' : 'bad') + '">' + esc(m.t) + (m.undo ? ' <button type="button" class="ts-link" data-act="undo">Undo</button>' : '') + '</div>' : ''; }
  function setMsg(key, t, ok, undo) { S.msgs[key] = { t: t, ok: ok !== false, undo: !!undo }; }

  function render() {
    var mount = $('timeslotsMount'); if (!mount) return;
    var st = S.settings;
    var h = '';
    if (S.loadErrs && S.loadErrs.length) h += '<div class="ts-warn">Some parts couldn’t load: ' + esc(S.loadErrs.join(' · ')) + '. If the delivery-times database setup isn’t finished yet, refresh in a moment.</div>';
    h += '<div class="ts-master ' + (st.enabled ? 'on' : 'off') + '"><div><b>Timeslots are ' + (st.enabled ? 'ON' : 'OFF') + '</b><div class="ts-sub">' +
      (st.enabled ? 'Customers pick a delivery window at checkout.' : 'Checkout works exactly as before. You can prepare slots and settings first.') + '</div></div>' +
      '<button type="button" class="ts-btn ' + (st.enabled ? 'danger' : 'primary') + '" data-act="master">' + (st.enabled ? 'Switch off…' : 'Switch on…') + '</button></div>';
    h += msg('master');
    h += affectedHtml();
    h += attentionHtml();
    h += '<div class="ts-card"><div class="ts-h"><h3>🚀 Send an order to riders now</h3></div><p class="ts-sub">Fast-forward any paid order (with or without a run): it is offered to riders straight away instead of waiting for its run time or a closed store.</p>' +
      '<div class="ts-actions"><input type="text" id="tsReleaseNum" placeholder="Order number, e.g. UMZILA-…" autocomplete="off" style="flex:1;min-width:0;padding:10px;border:1px solid #d1d5db;border-radius:10px;font:inherit"><button type="button" class="ts-btn primary" data-act="release-num">Send now</button></div></div>';
    h += '<div class="ts-card"><div class="ts-h"><h3>Run sheet · today &amp; tomorrow</h3><div class="ts-actions"><button type="button" class="ts-btn" data-act="tick">Run cut-off job now</button><button type="button" class="ts-btn" data-act="reload">↻ Refresh</button></div></div>' + msg('sheet') + sheetHtml() + '</div>';
    h += '<div class="ts-card"><div class="ts-h"><h3>Slots</h3><button type="button" class="ts-btn primary" data-act="slot-new">+ Add slot</button></div>' + msg('slots') + slotsHtml() + '</div>';
    h += '<div class="ts-card"><div class="ts-h"><h3>Date controls</h3></div>' + dateCtlHtml() + '</div>';
    h += '<div class="ts-card"><div class="ts-h"><h3>Settings</h3></div>' + settingsHtml() + '</div>';
    h += '<div class="ts-card"><div class="ts-h"><h3>Alert emails</h3></div>' + alertsHtml() + '</div>';
    mount.innerHTML = h;
  }

  function slotsHtml() {
    if (!S.slots.length) return '<p class="ts-muted">No slots yet. Add one to get started.</p>';
    var cut = Number(S.settings.cutoff_minutes) || 0;
    return '<div class="ts-list">' + S.slots.map(function (s) {
      var days = (s.days || []).slice().sort();
      var chips = [0, 1, 2, 3, 4, 5, 6].map(function (d) { return '<span class="ts-day' + (days.indexOf(d) >= 0 ? ' on' : '') + '">' + DAY_NAMES[d] + '</span>'; }).join('');
      return '<div class="ts-item' + (s.active ? '' : ' dim') + '"><div class="ts-item-top"><div><b class="ts-big">' + hm(s.start_time) + '–' + hm(s.end_time) + '</b><div class="ts-sub">Cut-off ' + minusMin(s.start_time, cut) + ' (' + cut + ' min before)' + (s.max_orders ? ' · max ' + s.max_orders + ' orders' : ' · no order limit') + '</div></div>' +
        '<label class="ts-switch" title="Switch this slot on or off"><input type="checkbox" data-act="slot-toggle" data-id="' + esc(s.id) + '"' + (s.active ? ' checked' : '') + '><span></span></label></div>' +
        '<div class="ts-days">' + chips + '</div>' +
        '<div class="ts-actions"><button type="button" class="ts-btn" data-act="slot-edit" data-id="' + esc(s.id) + '">Edit</button><button type="button" class="ts-btn danger-o" data-act="slot-del" data-id="' + esc(s.id) + '">Delete</button></div></div>';
    }).join('') + '</div>';
  }

  function dateCtlHtml() {
    var today = sastDate();
    var slotOpts = S.slots.map(function (s) { return '<option value="' + esc(s.id) + '">' + hm(s.start_time) + '–' + hm(s.end_time) + (s.active ? '' : ' (off)') + '</option>'; }).join('');
    var h = '<p class="ts-sub">Skipping a run or pausing a date stops <b>new</b> orders only. Orders already paid stay put until you move or refund them (you’ll get a list).</p>';
    h += '<div class="ts-form"><div class="ts-field"><label>Skip one run — slot</label><select id="tsSkipSlot">' + (slotOpts || '<option value="">No slots</option>') + '</select></div>' +
      '<div class="ts-field"><label>Date</label><input type="date" id="tsSkipDate" min="' + today + '" value="' + today + '"></div>' +
      '<button type="button" class="ts-btn primary" data-act="skip-add">Skip this run</button></div>';
    h += '<div class="ts-form"><div class="ts-field"><label>Pause a whole date</label><input type="date" id="tsPauseDate" min="' + today + '" value="' + today + '"></div>' +
      '<button type="button" class="ts-btn primary" data-act="pause-add">Pause this date</button></div>';
    h += msg('dates');
    if (!S.exceptions.length) return h + '<p class="ts-muted">Nothing skipped or paused.</p>';
    h += '<div class="ts-list">' + S.exceptions.map(function (x) {
      var sl = x.slot_id ? S.slots.filter(function (s) { return s.id === x.slot_id; })[0] : null;
      var label = x.slot_id ? 'Skipped run ' + (sl ? hm(sl.start_time) + '–' + hm(sl.end_time) : '(deleted slot)') : 'Date paused — no runs';
      return '<div class="ts-item row"><div><b>' + esc(dayLabel(String(x.run_date).slice(0, 10))) + ' · ' + esc(String(x.run_date).slice(0, 10)) + '</b><div class="ts-sub">' + esc(label) + '</div></div><button type="button" class="ts-btn" data-act="exc-del" data-id="' + esc(x.id) + '">Remove</button></div>';
    }).join('') + '</div>';
    return h;
  }

  function settingsHtml() {
    var st = S.settings;
    function f(id, label, val, min, max, help) { return '<div class="ts-field"><label for="' + id + '">' + label + '</label><input type="number" inputmode="numeric" id="' + id + '" min="' + min + '" max="' + max + '" step="1" value="' + esc(val) + '"><div class="ts-help">' + help + '</div></div>'; }
    return '<div class="ts-grid">' +
      f('tsSetCut', 'Cut-off minutes', st.cutoff_minutes, 0, 240, 'How long before the window start a run stops taking orders.') +
      f('tsSetGrace', 'Payment grace minutes', st.grace_minutes, 0, 60, 'After the cut-off, a payment started in time can still arrive this long.') +
      f('tsSetDays', 'Days ahead', st.days_ahead, 0, 6, '1 = customers can order for today and tomorrow.') +
      f('tsSetBusy', 'Busy alert at (orders)', st.busy_alert_at, 1, 500, 'Paid orders in one run that trigger the admin alert (once per run).') +
      f('tsSetRider', 'Tell riders (minutes before)', st.rider_notice_minutes, 0, 180, 'How long before the run starts riders are offered its trips (30 = 11:30 for the 12:00 run). Orders paid after that are added to their trips. Riders are told to be at the store by the start time.') +
      '</div><div class="ts-actions"><button type="button" class="ts-btn primary" data-act="settings-save">Save settings</button></div>' +
      '<p class="ts-sub">Changing the cut-off applies to every run whose cut-off hasn’t passed. A run whose summary has been sent never reopens. The “Timeslots on” switch is at the top of this page.</p>' + msg('settings');
  }

  function alertsHtml() {
    var h = '<p class="ts-sub">These people get the run summaries, “add to the run”, busy and needs-attention emails. If nobody here is switched on, the server falls back to the ADMIN_EMAILS setting.</p>';
    h += '<div class="ts-form"><div class="ts-field grow"><label for="tsAlertEmail">Add an email</label><input type="email" id="tsAlertEmail" placeholder="name@example.com" autocomplete="off"></div><button type="button" class="ts-btn primary" data-act="alert-add">Add</button></div>' + msg('alerts');
    if (!S.alerts.length) return h + '<p class="ts-muted">No alert emails in the list yet.</p>';
    return h + '<div class="ts-list">' + S.alerts.map(function (a) {
      return '<div class="ts-item row' + (a.active ? '' : ' dim') + '"><div class="ts-email"><b>' + esc(a.email) + '</b><div class="ts-sub">' + (a.active ? 'Receiving alerts' : 'Switched off') + '</div></div>' +
        '<div class="ts-actions"><label class="ts-switch"><input type="checkbox" data-act="alert-toggle" data-id="' + esc(a.id) + '"' + (a.active ? ' checked' : '') + '><span></span></label><button type="button" class="ts-btn danger-o" data-act="alert-del" data-id="' + esc(a.id) + '">Remove</button></div></div>';
    }).join('') + '</div>';
  }

  function orderBtns(o) {
    return '<div class="ts-actions"><button type="button" class="ts-btn primary" data-act="release" data-oid="' + esc(o.order_id || o.id) + '" data-onum="' + esc(o.order_number || '') + '">🚀 Send to riders now</button><button type="button" class="ts-btn" data-act="move" data-oid="' + esc(o.order_id || o.id) + '" data-onum="' + esc(o.order_number || '') + '">Move to another run</button><button type="button" class="ts-btn danger-o" data-act="refund" data-oid="' + esc(o.order_id || o.id) + '" data-onum="' + esc(o.order_number || '') + '">Mark for refund</button></div>';
  }
  function itemsText(items) { return (items || []).map(function (i) { return (i.qty || i.quantity || 1) + '× ' + (i.name || i.title || 'Item') + (i.size ? ' (' + i.size + ')' : ''); }).join(', '); }
  function phoneLink(p) { return p ? '<a href="tel:' + esc(String(p).replace(/[^\d+]/g, '')) + '">' + esc(p) + '</a>' : '<span class="ts-muted">no phone</span>'; }

  function attentionHtml() {
    var fromSheet = [];
    S.sheet.forEach(function (r) { (r.stores || []).forEach(function (st) { (st.orders || []).forEach(function (o) { if (o.needs_attention) fromSheet.push(o); }); }); });
    var seen = {}; var all = [];
    fromSheet.concat(S.attention.map(function (o) { return { order_id: o.id, order_number: o.order_number, customer_name: o.customer_name, customer_phone: o.customer_phone, address: o.delivery_address }; })).forEach(function (o) {
      var k = o.order_id || o.id; if (!k || seen[k]) return; seen[k] = 1; all.push(o);
    });
    if (!all.length) return '';
    return '<div class="ts-card attn"><div class="ts-h"><h3>⚠ Needs attention (' + all.length + ')</h3></div><p class="ts-sub">Paid late with no later run available. Pick a run for each, or refund.</p><div class="ts-list">' + all.map(function (o) {
      return '<div class="ts-item"><b>' + esc(o.order_number) + '</b> · ' + esc(o.customer_name || 'Customer') + '<div class="ts-sub">' + phoneLink(o.customer_phone) + (o.address ? ' · ' + esc(o.address) : '') + '</div>' + orderBtns(o) + '</div>';
    }).join('') + '</div></div>';
  }

  function sheetHtml() {
    if (S.sheetErr) return '<p class="ts-muted">Run sheet unavailable: ' + esc(S.sheetErr) + '</p>';
    if (!S.sheet.length) return '<p class="ts-muted">No runs for today or tomorrow' + (S.settings.enabled ? '' : ' (timeslots are off)') + '.</p>';
    var busyAt = Number(S.settings.busy_alert_at) || 6;
    var byDay = {}; S.sheet.forEach(function (r) { (byDay[r.run_date] = byDay[r.run_date] || []).push(r); });
    return Object.keys(byDay).sort().map(function (d) {
      return '<div class="ts-day-h">' + esc(dayLabel(String(d).slice(0, 10))) + ' · ' + esc(String(d).slice(0, 10)) + '</div>' + byDay[d].sort(function (a, b) { return String(a.window_start).localeCompare(String(b.window_start)); }).map(function (r) {
        var cnt = Number(r.paid_count) || 0; var busy = r.busy || cnt >= busyAt;
        var stCls = { taking_orders: 'ok', preparing: 'warn', out_for_delivery: 'info', done: 'mute' }[r.state] || 'mute';
        var h = '<div class="ts-run"><div class="ts-run-top"><div><b class="ts-big">' + esc(winOf(r)) + '</b><div class="ts-sub">Cut-off ' + esc(fmtT(r.cutoff_at)) + (r.late_minutes ? ' · told customers ' + r.late_minutes + ' min late' : '') + '</div></div>' +
          '<div class="ts-pills"><span class="ts-pill ' + stCls + '">' + esc(STATE_LABEL[r.state] || r.state || '') + '</span><span class="ts-pill mute">' + cnt + ' paid</span>' + (busy ? '<span class="ts-pill bad">Busy</span>' : '') + '</div></div>';
        if (!cnt && !(r.stores || []).length) h += '<p class="ts-muted">No orders</p>';
        (r.stores || []).forEach(function (st) {
          h += '<div class="ts-store"><div class="ts-store-h">' + esc(st.shop_name || 'Store') + ' <span class="ts-muted">· ' + (st.orders || []).length + ' order' + ((st.orders || []).length === 1 ? '' : 's') + '</span></div>';
          (st.orders || []).forEach(function (o) {
            h += '<div class="ts-order' + (o.needs_attention ? ' attn' : '') + '"><div><b>' + esc(o.order_number) + '</b> · ' + esc(o.customer_name || 'Customer') + (o.needs_attention ? ' <span class="ts-pill bad">Needs attention</span>' : '') + (o.delivery_status ? ' <span class="ts-pill mute">' + esc(String(o.delivery_status).replace(/_/g, ' ').toLowerCase()) + '</span>' : '') + '</div>' +
              '<div class="ts-sub">' + phoneLink(o.customer_phone) + '</div><div class="ts-sub">' + esc(o.address || '') + '</div><div class="ts-items">' + esc(itemsText(o.items)) + '</div>' +
              (o.moved_from ? '<div class="ts-sub">Moved from ' + esc(typeof o.moved_from === 'string' ? o.moved_from : winOf(o.moved_from)) + '</div>' : '') + orderBtns(o) + '</div>';
          });
          h += '</div>';
        });
        if (cnt || (r.stores || []).length) h += '<div class="ts-actions"><button type="button" class="ts-btn" data-act="late" data-slot="' + esc(r.slot_id) + '" data-date="' + esc(String(r.run_date).slice(0, 10)) + '" data-win="' + esc(winOf(r)) + '">🕒 Running late</button><button type="button" class="ts-btn" data-act="release-run" data-slot="' + esc(r.slot_id) + '" data-date="' + esc(String(r.run_date).slice(0, 10)) + '" data-win="' + esc(winOf(r)) + '">🚀 Send whole run to riders now</button></div>';
        return h + '</div>';
      }).join('');
    }).join('');
  }

  function affectedHtml() {
    var a = S.affected; if (!a) return '';
    var rows = a.rows;
    var h = '<div class="ts-card warn"><div class="ts-h"><h3>⚠ ' + esc(a.title) + '</h3><button type="button" class="ts-btn" data-act="aff-close">Dismiss</button></div>';
    if (a.loading) return h + '<p class="ts-muted">Checking for paid orders…</p></div>';
    if (a.error) return h + '<p style="color:#b91c1c">Couldn’t check paid orders: ' + esc(a.error) + '. Please check the run sheet by hand.</p></div>';
    if (!rows.length) return h + '<p class="ts-sub">No paid orders are affected. ✓</p></div>';
    h += '<p class="ts-sub">New orders have stopped, but these <b>' + rows.length + '</b> paid order' + (rows.length === 1 ? '' : 's') + ' are still in the affected run' + (rows.length === 1 ? '' : 's') + '. Move each one, or refund it.</p>';
    h += '<div class="ts-actions"><button type="button" class="ts-btn primary" data-act="aff-move-all">Move all to…</button><button type="button" class="ts-btn danger-o" data-act="aff-refund-all">Mark all for refund</button></div>';
    h += '<div class="ts-list">' + rows.map(function (o) {
      var id = o.order_id || o.id;
      return '<div class="ts-item"><b>' + esc(o.order_number) + '</b> · ' + esc(o.customer_name || 'Customer') + '<div class="ts-sub">' + phoneLink(o.customer_phone) + ' · ' + esc(winOf(o) || (o.run_date ? o.run_date : '')) + (o.run_date ? ' · ' + esc(dayLabel(String(o.run_date).slice(0, 10))) : '') + '</div>' + orderBtns({ order_id: id, order_number: o.order_number }) + '</div>';
    }).join('') + '</div>' + msg('aff') + '</div>';
    return h;
  }

  // ---------- affected orders ----------
  async function showAffected(title, slotId, runDate) {
    S.affected = { title: title, rows: [], loading: true, params: [slotId, runDate] }; render();
    var c = sb();
    try {
      var rows = [];
      if (slotId || !runDate) {
        var r = await c.rpc('admin_affected_orders', { p_slot_id: slotId || null, p_run_date: runDate || null });
        if (r.error) throw r.error; rows = list(r.data);
      } else {
        // pause a date: ask per slot (fallback if the RPC doesn't accept a null slot)
        var r2 = await c.rpc('admin_affected_orders', { p_slot_id: null, p_run_date: runDate });
        if (!r2.error) rows = list(r2.data);
        else {
          for (var i = 0; i < S.slots.length; i++) {
            var rr = await c.rpc('admin_affected_orders', { p_slot_id: S.slots[i].id, p_run_date: runDate });
            if (rr.error) throw rr.error; rows = rows.concat(list(rr.data));
          }
        }
      }
      S.affected = { title: title, rows: rows, params: [slotId, runDate] };
    } catch (e) { S.affected = { title: title, rows: [], error: friendly(e), params: [slotId, runDate] }; }
    render();
  }

  // ---------- modal ----------
  function modal(html, onReady) {
    closeModal();
    var o = document.createElement('div'); o.id = 'tsModal'; o.className = 'ts-modal';
    o.innerHTML = '<div class="ts-sheet" role="dialog" aria-modal="true">' + html + '</div>';
    o.addEventListener('click', function (e) { if (e.target === o) closeModal(); });
    document.body.appendChild(o);
    if (onReady) onReady(o);
    return o;
  }
  function closeModal() { var o = $('tsModal'); if (o) o.remove(); }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  function confirmBox(title, body, okLabel, danger) {
    return new Promise(function (resolve) {
      modal('<h3>' + esc(title) + '</h3><div class="ts-body">' + body + '</div><div class="ts-actions end"><button type="button" class="ts-btn" id="tsNo">Cancel</button><button type="button" class="ts-btn ' + (danger ? 'danger' : 'primary') + '" id="tsYes">' + esc(okLabel) + '</button></div>', function (o) {
        o.querySelector('#tsNo').onclick = function () { closeModal(); resolve(false); };
        o.querySelector('#tsYes').onclick = function () { closeModal(); resolve(true); };
      });
    });
  }

  // ---------- actions ----------
  async function masterSwitch() {
    var on = !S.settings.enabled;
    var ok = await confirmBox(on ? 'Switch timeslots ON?' : 'Switch timeslots OFF?',
      on ? '<p>From now, customers must choose a delivery window at checkout, and stores are told what to prepare at each cut-off.</p><p><b>Best done after the last cut-off of the day</b> so the first run on the new system is tomorrow’s first slot. Orders already paid are left as they are.</p>'
        : '<p>Checkout goes back to working exactly as it did before: no delivery windows, no cut-offs, no run summaries.</p><p>Orders already placed with a window keep it, but nothing will manage the runs any more.</p>',
      on ? 'Yes, switch on' : 'Yes, switch off', !on);
    if (!ok) return;
    var res = await saveSettings(Object.assign({}, S.settings, { enabled: on }));
    setMsg('master', res.ok ? ('Timeslots are now ' + (on ? 'ON' : 'OFF') + '.') : res.error, res.ok);
    render();
  }

  async function saveSettings(next) {
    var c = sb();
    try {
      var u = await c.auth.getUser(); var user = u && u.data && u.data.user;
      var existing = (S.settingsRow && S.settingsRow.value) || {};
      var value = Object.assign({}, existing, next);
      var r = await c.from('site_settings').upsert({ key: 'timeslots', value: value, updated_at: new Date().toISOString(), updated_by: user ? user.id : null }).select('value, updated_at').single();
      if (r.error) throw r.error;
      S.settingsRow = r.data; S.settings = Object.assign({}, DEFAULTS, r.data.value || {});
      return { ok: true };
    } catch (e) { return { ok: false, error: 'Couldn’t save: ' + friendly(e) }; }
  }

  async function settingsSave() {
    function n(id) { var v = $(id).value.trim(); return /^\d+$/.test(v) ? parseInt(v, 10) : NaN; }
    var v = { cutoff_minutes: n('tsSetCut'), grace_minutes: n('tsSetGrace'), days_ahead: n('tsSetDays'), busy_alert_at: n('tsSetBusy'), rider_notice_minutes: n('tsSetRider') };
    var bad = null;
    if (!(v.cutoff_minutes >= 0 && v.cutoff_minutes <= 240)) bad = 'Cut-off minutes must be a whole number from 0 to 240.';
    else if (!(v.grace_minutes >= 0 && v.grace_minutes <= 60)) bad = 'Payment grace must be a whole number from 0 to 60.';
    else if (!(v.days_ahead >= 0 && v.days_ahead <= 6)) bad = 'Days ahead must be a whole number from 0 to 6.';
    else if (!(v.busy_alert_at >= 1 && v.busy_alert_at <= 500)) bad = 'Busy alert must be at least 1.';
    else if (!(v.rider_notice_minutes >= 0 && v.rider_notice_minutes <= 180)) bad = 'Tell riders must be a whole number of minutes from 0 to 180.';
    if (bad) { setMsg('settings', bad, false); render(); return; }
    if (S.settings.enabled && v.cutoff_minutes !== Number(S.settings.cutoff_minutes)) {
      var ok = await confirmBox('Change the cut-off?', '<p>Timeslots are live. The new cut-off applies at once to every run whose cut-off hasn’t passed (a run whose summary was already sent never reopens).</p>', 'Save', false);
      if (!ok) return;
    }
    setMsg('settings', 'Saving…', true); render();
    var res = await saveSettings(v);
    setMsg('settings', res.ok ? 'Saved ✓' : res.error, res.ok); render();
  }

  // slots
  function slotForm(s) {
    var days = s ? (s.days || []) : [0, 1, 2, 3, 4, 5, 6];
    return '<h3>' + (s ? 'Edit slot' : 'Add slot') + '</h3><div class="ts-body"><div class="ts-form"><div class="ts-field"><label>Starts</label><input type="time" id="tsfStart" value="' + (s ? hm(s.start_time) : '12:00') + '"></div><div class="ts-field"><label>Ends</label><input type="time" id="tsfEnd" value="' + (s ? hm(s.end_time) : '13:00') + '"></div></div>' +
      '<div class="ts-field"><label>Days it runs</label><div class="ts-daypick">' + [0, 1, 2, 3, 4, 5, 6].map(function (d) { return '<label class="ts-dchip"><input type="checkbox" value="' + d + '"' + (days.indexOf(d) >= 0 ? ' checked' : '') + '><span>' + DAY_NAMES[d] + '</span></label>'; }).join('') + '</div></div>' +
      '<div class="ts-field"><label>Maximum orders (optional)</label><input type="number" inputmode="numeric" min="1" id="tsfMax" placeholder="No limit" value="' + (s && s.max_orders ? s.max_orders : '') + '"><div class="ts-help">Leave empty for no limit. Customers see the run as full once this many paid orders are in it.</div></div>' +
      '<label class="ts-check"><input type="checkbox" id="tsfActive"' + (!s || s.active ? ' checked' : '') + '> Slot is on</label><div class="ts-msg bad" id="tsfErr" style="display:none"></div></div>' +
      '<div class="ts-actions end"><button type="button" class="ts-btn" id="tsfCancel">Cancel</button><button type="button" class="ts-btn primary" id="tsfSave">Save slot</button></div>';
  }
  function openSlotForm(id) {
    var s = id ? S.slots.filter(function (x) { return x.id === id; })[0] : null;
    modal(slotForm(s), function (o) {
      o.querySelector('#tsfCancel').onclick = closeModal;
      o.querySelector('#tsfSave').onclick = async function () {
        var err = o.querySelector('#tsfErr'); err.style.display = 'none';
        var start = o.querySelector('#tsfStart').value, end = o.querySelector('#tsfEnd').value;
        var days = Array.prototype.map.call(o.querySelectorAll('.ts-daypick input:checked'), function (i) { return Number(i.value); });
        var mx = o.querySelector('#tsfMax').value.trim();
        var problem = !start || !end ? 'Enter a start and an end time.' : end <= start ? 'The end time must be after the start time.' : !days.length ? 'Pick at least one day.' : (mx && !/^[1-9]\d*$/.test(mx)) ? 'Maximum orders must be a whole number of 1 or more, or empty.' : null;
        if (problem) { err.textContent = problem; err.style.display = 'block'; return; }
        var row = { start_time: start, end_time: end, days: days, max_orders: mx ? parseInt(mx, 10) : null, active: o.querySelector('#tsfActive').checked, updated_at: new Date().toISOString() };
        var btn = o.querySelector('#tsfSave'); btn.disabled = true; btn.textContent = 'Saving…';
        var q = s ? sb().from('delivery_slots').update(row).eq('id', s.id) : sb().from('delivery_slots').insert(row);
        var r = await q;
        btn.disabled = false; btn.textContent = 'Save slot';
        if (r.error) { err.textContent = friendly(r.error); err.style.display = 'block'; return; }
        closeModal(); setMsg('slots', 'Slot saved ✓', true);
        var wasOn = s && s.active, nowOff = !row.active;
        var timesChanged = s && (hm(s.start_time) !== start || hm(s.end_time) !== end);
        await loadAll(true);
        if (s && ((wasOn && nowOff) || s.days.join() !== days.join())) await showAffected('Paid orders in this slot’s future runs', s.id, null);
        else if (timesChanged) { setMsg('slots', 'Slot saved ✓ Paid orders already sold keep the window they bought; the new times apply to new orders only.', true); render(); }
      };
    });
  }
  async function slotToggle(id, checked, box) {
    var s = S.slots.filter(function (x) { return x.id === id; })[0]; if (!s) return;
    if (!checked) {
      var ok = await confirmBox('Switch this slot off?', '<p>' + hm(s.start_time) + '–' + hm(s.end_time) + ' will stop taking new orders. Orders already paid stay until you move or refund them — you’ll see a list.</p>', 'Switch off', true);
      if (!ok) { box.checked = true; return; }
    }
    var r = await sb().from('delivery_slots').update({ active: checked, updated_at: new Date().toISOString() }).eq('id', id);
    if (r.error) { box.checked = !checked; setMsg('slots', friendly(r.error), false); render(); return; }
    setMsg('slots', 'Slot ' + hm(s.start_time) + ' is now ' + (checked ? 'on' : 'off') + '.', true);
    await loadAll(true);
    if (!checked) await showAffected('Paid orders in the ' + hm(s.start_time) + ' slot (future runs)', id, null);
  }
  async function slotDelete(id) {
    var s = S.slots.filter(function (x) { return x.id === id; })[0]; if (!s) return;
    var ok = await confirmBox('Delete this slot?', '<p>' + hm(s.start_time) + '–' + hm(s.end_time) + ' will be removed for good. If it has paid orders in future runs, it can’t be deleted — switch it off instead.</p>', 'Delete', true);
    if (!ok) return;
    var r = await sb().from('delivery_slots').delete().eq('id', id);
    if (r.error) {
      if (/SLOT_HAS_PAID_ORDERS/.test(r.error.message || '')) {
        var off = await confirmBox('Can’t delete — switch it off?', '<p>This slot has paid orders in future runs. Switch it off instead? You’ll then get a list of those orders to move or refund.</p>', 'Switch off instead', false);
        if (off) { var u = await sb().from('delivery_slots').update({ active: false, updated_at: new Date().toISOString() }).eq('id', id); if (u.error) setMsg('slots', friendly(u.error), false); else { await loadAll(true); await showAffected('Paid orders in the ' + hm(s.start_time) + ' slot (future runs)', id, null); return; } }
        else setMsg('slots', friendly(r.error), false);
      } else setMsg('slots', friendly(r.error), false);
      render(); return;
    }
    setMsg('slots', 'Slot deleted.', true); await loadAll(true);
  }

  // date controls
  async function addException(slotId, date) {
    var c = sb(); var u = await c.auth.getUser(); var user = u && u.data && u.data.user;
    var r = await c.from('delivery_slot_exceptions').insert({ run_date: date, slot_id: slotId, created_by: user ? user.id : null }).select('id').single();
    if (r.error) { setMsg('dates', /23505|duplicate/.test(r.error.message || r.error.code || '') ? 'That is already skipped/paused.' : friendly(r.error), false); render(); return; }
    S.undo = r.data.id;
    setMsg('dates', slotId ? 'Run skipped. New orders can’t pick it.' : 'Date paused. No runs that day.', true, true);
    await loadAll(true);
    await showAffected(slotId ? 'Paid orders in the skipped run' : 'Paid orders on the paused date', slotId, date);
  }
  async function skipAdd() {
    var slotId = $('tsSkipSlot').value, date = $('tsSkipDate').value;
    if (!slotId) { setMsg('dates', 'Pick a slot.', false); return render(); }
    if (!date || date < sastDate()) { setMsg('dates', 'Pick today or a later date.', false); return render(); }
    var s = S.slots.filter(function (x) { return x.id === slotId; })[0];
    var ok = await confirmBox('Skip this run?', '<p>' + (s ? hm(s.start_time) + '–' + hm(s.end_time) : 'Run') + ' on ' + esc(date) + ' will stop taking new orders. Paid orders stay until you move or refund them.</p>', 'Skip run', true);
    if (ok) await addException(slotId, date);
  }
  async function pauseAdd() {
    var date = $('tsPauseDate').value;
    if (!date || date < sastDate()) { setMsg('dates', 'Pick today or a later date.', false); return render(); }
    var ok = await confirmBox('Pause this date?', '<p>Every run on ' + esc(date) + ' will stop taking new orders. Paid orders stay until you move or refund them.</p>', 'Pause date', true);
    if (ok) await addException(null, date);
  }
  async function removeException(id) {
    var r = await sb().from('delivery_slot_exceptions').delete().eq('id', id);
    setMsg('dates', r.error ? friendly(r.error) : 'Removed — that run/date takes orders again.', !r.error);
    if (!r.error) S.undo = null;
    await loadAll(true);
  }

  // move / refund
  function runPickState(r) {
    var st = r.state || 'open';
    return { open: 'open', closed: 'past cut-off', skipped: 'skipped', paused: 'paused', off: 'slot off', store_closed: 'store closed' + (r.blocking_store ? ' (' + r.blocking_store + ')' : ''), full: 'full' }[st] || st;
  }
  async function pickRun(orderId, title) {
    var res = await sb().rpc('admin_runs_for_order', { p_order_id: orderId });
    if (res.error) { toast('Couldn’t load runs: ' + friendly(res.error)); return null; }
    var runs = list(res.data);
    if (!runs.length) { toast('No runs available for this order.'); return null; }
    return new Promise(function (resolve) {
      var h = '<h3>' + esc(title) + '</h3><div class="ts-body"><p class="ts-sub">Pick the run. Runs marked in red aren’t normally open to customers — you can still choose one knowingly.</p><div class="ts-runs">' + runs.map(function (r, i) {
        var open = (r.state || 'open') === 'open';
        return '<label class="ts-runopt' + (open ? '' : ' closed') + '"><input type="radio" name="tsRun" value="' + i + '"' + (i === 0 && open ? ' checked' : '') + '><span><b>' + esc(dayLabel(String(r.run_date).slice(0, 10))) + ' ' + esc(winOf(r)) + '</b><span class="ts-sub"> ' + (open ? 'open · cut-off ' + esc(fmtT(r.cutoff_at)) : esc(runPickState(r))) + '</span></span></label>';
      }).join('') + '</div><div class="ts-msg bad" id="tsPickErr" style="display:none"></div></div><div class="ts-actions end"><button type="button" class="ts-btn" id="tsNo">Cancel</button><button type="button" class="ts-btn primary" id="tsYes">Move &amp; email customer</button></div>';
      modal(h, function (o) {
        o.querySelector('#tsNo').onclick = function () { closeModal(); resolve(null); };
        o.querySelector('#tsYes').onclick = function () {
          var sel = o.querySelector('input[name=tsRun]:checked');
          if (!sel) { var e = o.querySelector('#tsPickErr'); e.textContent = 'Pick a run first.'; e.style.display = 'block'; return; }
          var r = runs[Number(sel.value)];
          if ((r.state || 'open') !== 'open' && !window.confirm('This run is ' + runPickState(r) + '. Move the order there anyway?')) return;
          closeModal(); resolve(r);
        };
      });
    });
  }
  async function moveOne(orderId, run) {
    var r = await sb().rpc('admin_move_order_run', { p_order_id: orderId, p_slot_id: run.slot_id, p_run_date: String(run.run_date).slice(0, 10), p_reason: 'admin' });
    if (r.error) throw r.error;
    return r.data;
  }
  async function afterMoves() { try { await api({ action: 'tick' }); } catch (e) { toast('Moved, but the customer email will go out within a minute (' + e.message + ')'); } }
  async function moveOrder(orderId, onum) {
    var run = await pickRun(orderId, 'Move order ' + (onum || '') + ' to…'); if (!run) return;
    try { await moveOne(orderId, run); await afterMoves(); toast('Order moved ✓ — customer emailed'); }
    catch (e) { toast('Couldn’t move: ' + friendly(e)); return; }
    await refreshAffected();
  }
  async function refundOrder(orderId, onum) {
    var ok = await confirmBox('Mark order ' + (onum || '') + ' for refund?', '<p>The order is marked refunded, its delivery is cancelled, it leaves the run and the customer is emailed.</p><p><b>You still have to refund the money by hand in PayFast.</b></p>', 'Mark for refund', true);
    if (!ok) return;
    try {
      var j = await api({ action: 'mark_refund', orderId: orderId });
      var dc = j && j.deliveryCancelled;
      toast(dc && dc !== true ? 'Order marked for refund — now refund it in PayFast. The delivery could not be cancelled (' + dc + '): check Delivery Ops.' : 'Order marked for refund — now refund it in PayFast');
    }
    catch (e) { toast('Couldn’t mark for refund: ' + e.message); return; }
    await refreshAffected();
  }
  // Fast-forward (timeslot-admin.js release_now / release_run)
  var RELEASE_TXT = { offered: 'offered to a rider', batched: 'added to a rider’s trip', waiting_rider: 'released — no rider free right now, it goes to the first one who is', already_moving: 'already with a rider', not_paid: 'not paid (or refunded) — not sent', no_delivery: 'has no delivery (collection / service) — nothing to send', failed: 'could not be sent' };
  function releaseSummary(results) {
    if (!results || !results.length) return 'No paid orders in that run.';
    return results.map(function (r) { return (r.order_number || 'Order') + ': ' + (RELEASE_TXT[r.status] || r.status) + (r.status === 'failed' && r.detail ? ' (' + r.detail + ')' : ''); }).join(' · ');
  }
  async function releaseOrder(orderId, onum) {
    var ok = await confirmBox('Send ' + (onum || 'this order') + ' to riders now?', '<p>It is offered to riders straight away instead of waiting for its run’s rider-notice time (and without waiting for a closed store to open). The rider is told to collect now.</p>', 'Send now');
    if (!ok) return;
    try { var j = await api(orderId ? { action: 'release_now', orderId: orderId } : { action: 'release_now', orderNumber: onum }); toast(releaseSummary(j.results)); }
    catch (e) { toast('Couldn’t send it: ' + e.message); return; }
    await loadAll(true);
  }
  async function releaseRun(slotId, runDate, win) {
    var ok = await confirmBox('Send the whole ' + (win || '') + ' run to riders now?', '<p>Every paid order in this run is offered to riders straight away. Orders paid later for this run still wait for the normal time.</p>', 'Send run now');
    if (!ok) return;
    try { var j = await api({ action: 'release_run', slotId: slotId, runDate: runDate }); toast(releaseSummary(j.results)); }
    catch (e) { toast('Couldn’t send the run: ' + e.message); return; }
    await loadAll(true);
  }
  async function releaseByNumber() {
    var el = $('tsReleaseNum'); var v = el ? el.value.trim() : '';
    if (!v) { toast('Type the order number first'); return; }
    await releaseOrder(null, v);
  }
  async function refreshAffected() {
    var a = S.affected; await loadAll(true);
    if (a && a.params) await showAffected(a.title, a.params[0], a.params[1]);
  }

  async function affBulk(kind) {
    var rows = (S.affected && S.affected.rows) || []; if (!rows.length) return;
    var ids = rows.map(function (o) { return o.order_id || o.id; });
    var ok, run = null, done = 0, fails = [];
    if (kind === 'move') {
      run = await pickRun(ids[0], 'Move all ' + ids.length + ' orders to…'); if (!run) return;
      for (var i = 0; i < ids.length; i++) { try { await moveOne(ids[i], run); done++; } catch (e) { fails.push((rows[i].order_number || ids[i]) + ': ' + friendly(e)); } }
      if (done) await afterMoves();
    } else {
      ok = await confirmBox('Mark all ' + ids.length + ' orders for refund?', '<p>Each order is marked refunded, its delivery cancelled and the customer emailed. <b>You still have to refund each one by hand in PayFast.</b></p>', 'Mark all for refund', true);
      if (!ok) return;
      for (var j = 0; j < ids.length; j++) { try { await api({ action: 'mark_refund', orderId: ids[j] }); done++; } catch (e2) { fails.push((rows[j].order_number || ids[j]) + ': ' + e2.message); } }
    }
    setMsg('aff', done + ' of ' + ids.length + ' done' + (fails.length ? '. Problems: ' + fails.join(' · ') : ' ✓'), !fails.length);
    toast(done + ' of ' + ids.length + ' done' + (fails.length ? ' — some failed, see the list' : ' ✓'));
    var keepMsg = S.msgs.aff; await refreshAffected(); S.msgs.aff = keepMsg; render();
  }

  // running late
  function runningLate(slotId, date, win) {
    modal('<h3>Running late — ' + esc(win) + '</h3><div class="ts-body"><p class="ts-sub">Every paid customer in this run gets an email saying their order is running late.</p><div class="ts-field"><label for="tsLateMin">How many minutes late?</label><input type="number" inputmode="numeric" id="tsLateMin" min="1" max="240" value="15"></div><div class="ts-msg bad" id="tsLateErr" style="display:none"></div></div><div class="ts-actions end"><button type="button" class="ts-btn" id="tsNo">Cancel</button><button type="button" class="ts-btn primary" id="tsYes">Send to customers</button></div>', function (o) {
      o.querySelector('#tsNo').onclick = closeModal;
      o.querySelector('#tsYes').onclick = async function () {
        var v = o.querySelector('#tsLateMin').value.trim(); var err = o.querySelector('#tsLateErr');
        if (!/^\d+$/.test(v) || +v < 1 || +v > 240) { err.textContent = 'Enter a whole number of minutes from 1 to 240.'; err.style.display = 'block'; return; }
        var b = o.querySelector('#tsYes'); b.disabled = true; b.textContent = 'Sending…';
        try { var j = await api({ action: 'running_late', slotId: slotId, runDate: date, minutes: parseInt(v, 10) }); closeModal(); setMsg('sheet', 'Running-late email sent' + (j && j.sent != null ? ' to ' + j.sent + ' customer(s)' : '') + ' ✓', true); await loadAll(true); }
        catch (e) { b.disabled = false; b.textContent = 'Send to customers'; err.textContent = e.message; err.style.display = 'block'; }
      };
    });
  }

  async function tickNow() {
    setMsg('sheet', 'Running the cut-off job…', true); render();
    try { await api({ action: 'tick' }); setMsg('sheet', 'Cut-off job ran ✓ (summaries, late-payment moves and alerts are processed once each).', true); }
    catch (e) { setMsg('sheet', 'Cut-off job failed: ' + e.message, false); }
    await loadAll(true);
  }

  // alert emails
  async function alertAdd() {
    var el = $('tsAlertEmail'); var v = (el.value || '').trim().toLowerCase();
    if (window.UmzilaInput && window.UmzilaInput.ok && !window.UmzilaInput.ok(el)) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) { setMsg('alerts', 'Enter a valid email address.', false); return render(); }
    var u = await sb().auth.getUser(); var user = u && u.data && u.data.user;
    var r = await sb().from('admin_alert_emails').insert({ email: v, active: true, created_by: user ? user.id : null });
    setMsg('alerts', r.error ? (/23505|duplicate/.test(r.error.message || r.error.code || '') ? 'That email is already in the list.' : friendly(r.error)) : v + ' added ✓', !r.error);
    await loadAll(true);
  }
  async function alertToggle(id, on) {
    var r = await sb().from('admin_alert_emails').update({ active: on }).eq('id', id);
    setMsg('alerts', r.error ? friendly(r.error) : (on ? 'Alerts switched on.' : 'Alerts switched off for that address.'), !r.error);
    await loadAll(true);
  }
  async function alertDel(id) {
    var a = S.alerts.filter(function (x) { return x.id === id; })[0];
    var ok = await confirmBox('Remove this email?', '<p>' + esc(a ? a.email : '') + ' will no longer get delivery-times alerts.</p>', 'Remove', true);
    if (!ok) return;
    var r = await sb().from('admin_alert_emails').delete().eq('id', id);
    setMsg('alerts', r.error ? friendly(r.error) : 'Removed.', !r.error);
    await loadAll(true);
  }

  // ---------- events ----------
  function wire() {
    var root = $('section-delivery-times'); if (!root || root.dataset.wired) return; root.dataset.wired = '1';
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b || b.type === 'checkbox') return;
      var a = b.dataset.act, id = b.dataset.id;
      var run = function (p) { Promise.resolve(p).catch(function (err) { toast(friendly(err)); }); };
      if (a === 'reload') run(loadAll(true));
      else if (a === 'master') run(masterSwitch());
      else if (a === 'tick') run(tickNow());
      else if (a === 'slot-new') openSlotForm(null);
      else if (a === 'slot-edit') openSlotForm(id);
      else if (a === 'slot-del') run(slotDelete(id));
      else if (a === 'skip-add') run(skipAdd());
      else if (a === 'pause-add') run(pauseAdd());
      else if (a === 'exc-del') run(removeException(id));
      else if (a === 'undo') { if (S.undo) { var u = S.undo; S.undo = null; run(removeException(u)); } }
      else if (a === 'settings-save') run(settingsSave());
      else if (a === 'move') run(moveOrder(b.dataset.oid, b.dataset.onum));
      else if (a === 'refund') run(refundOrder(b.dataset.oid, b.dataset.onum));
      else if (a === 'release') run(releaseOrder(b.dataset.oid, b.dataset.onum));
      else if (a === 'release-run') run(releaseRun(b.dataset.slot, b.dataset.date, b.dataset.win));
      else if (a === 'release-num') run(releaseByNumber());
      else if (a === 'late') runningLate(b.dataset.slot, b.dataset.date, b.dataset.win);
      else if (a === 'aff-close') { S.affected = null; render(); }
      else if (a === 'aff-move-all') run(affBulk('move'));
      else if (a === 'aff-refund-all') run(affBulk('refund'));
      else if (a === 'alert-add') run(alertAdd());
      else if (a === 'alert-del') run(alertDel(id));
    });
    root.addEventListener('change', function (e) {
      var t = e.target; if (!t.dataset || !t.dataset.act) return;
      if (t.dataset.act === 'slot-toggle') slotToggle(t.dataset.id, t.checked, t).catch(function (err) { toast(friendly(err)); });
      else if (t.dataset.act === 'alert-toggle') alertToggle(t.dataset.id, t.checked).catch(function (err) { toast(friendly(err)); });
    });
    root.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.id === 'tsAlertEmail') { e.preventDefault(); alertAdd().catch(function (err) { toast(friendly(err)); }); } });
  }

  function injectCss() {
    if ($('tsCss')) return;
    var s = document.createElement('style'); s.id = 'tsCss';
    s.textContent = [
      '#section-delivery-times{--tsb:#0a2f66}',
      '#section-delivery-times .ts-muted{color:#6b7280;font-size:13px}',
      '#section-delivery-times .ts-sub{font-size:12.5px;color:#6b7280;margin-top:3px}',
      '#section-delivery-times .ts-help{font-size:11.5px;color:#6b7280;margin-top:3px}',
      '#section-delivery-times .ts-card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px;margin-bottom:14px}',
      '#section-delivery-times .ts-card.warn{background:#fffbeb;border-color:#f59e0b}',
      '#section-delivery-times .ts-card.attn{background:#fef2f2;border-color:#ef4444}',
      '#section-delivery-times .ts-h{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}',
      '#section-delivery-times .ts-h h3{margin:0;font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#374151}',
      '#section-delivery-times .ts-master{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;border-radius:14px;padding:14px;margin-bottom:14px;color:#fff}',
      '#section-delivery-times .ts-master.on{background:linear-gradient(150deg,#047857,#059669)}',
      '#section-delivery-times .ts-master.off{background:linear-gradient(150deg,#374151,#4b5563)}',
      '#section-delivery-times .ts-master .ts-sub{color:rgba(255,255,255,.85)}',
      '#section-delivery-times .ts-master b{font-size:17px}',
      '#section-delivery-times .ts-btn,#tsModal .ts-btn{border:1px solid #d1d5db;background:#fff;color:#111827;border-radius:10px;padding:10px 14px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;min-height:42px}',
      '#section-delivery-times .ts-btn.primary,#tsModal .ts-btn.primary{background:var(--tsb,#0a2f66);border-color:var(--tsb,#0a2f66);color:#fff}',
      '#section-delivery-times .ts-btn.danger,#tsModal .ts-btn.danger{background:#dc2626;border-color:#dc2626;color:#fff}',
      '#section-delivery-times .ts-btn.danger-o{color:#b91c1c;border-color:#fca5a5}',
      '#section-delivery-times .ts-btn:disabled,#tsModal .ts-btn:disabled{opacity:.6;cursor:default}',
      '#section-delivery-times .ts-master .ts-btn{border-color:#fff}',
      '#section-delivery-times .ts-actions,#tsModal .ts-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}',
      '#tsModal .ts-actions.end{justify-content:flex-end}',
      '#section-delivery-times .ts-list{display:flex;flex-direction:column;gap:10px;margin-top:8px}',
      '#section-delivery-times .ts-item{border:1px solid #e5e7eb;border-radius:12px;padding:12px;background:#f9fafb}',
      '#section-delivery-times .ts-item.dim{opacity:.65}',
      '#section-delivery-times .ts-item.row{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}',
      '#section-delivery-times .ts-item-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}',
      '#section-delivery-times .ts-email{min-width:0;word-break:break-all}',
      '#section-delivery-times .ts-big{font-size:18px}',
      '#section-delivery-times .ts-days{display:flex;gap:4px;flex-wrap:wrap;margin-top:8px}',
      '#section-delivery-times .ts-day{font-size:11.5px;font-weight:700;padding:3px 7px;border-radius:999px;background:#e5e7eb;color:#9ca3af}',
      '#section-delivery-times .ts-day.on{background:#dbeafe;color:#1e40af}',
      '#section-delivery-times .ts-form{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:10px 0}',
      '#section-delivery-times .ts-field,#tsModal .ts-field{display:flex;flex-direction:column;gap:4px;min-width:0;margin-bottom:8px}',
      '#section-delivery-times .ts-field.grow{flex:1 1 220px}',
      '#section-delivery-times .ts-field label,#tsModal .ts-field label{font-size:12px;font-weight:700;color:#374151}',
      '#section-delivery-times input[type=time],#section-delivery-times input[type=date],#section-delivery-times input[type=number],#section-delivery-times input[type=email],#section-delivery-times select,#tsModal input[type=time],#tsModal input[type=number]{padding:10px;border:1px solid #d1d5db;border-radius:8px;font:inherit;font-size:15px;min-width:0;width:100%;box-sizing:border-box;background:#fff}',
      '#section-delivery-times .ts-form .ts-field{flex:1 1 140px}',
      '#section-delivery-times .ts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}',
      '#section-delivery-times .ts-msg,#tsModal .ts-msg{font-size:13px;margin:8px 0;padding:8px 10px;border-radius:8px}',
      '#section-delivery-times .ts-msg.ok{background:#ecfdf5;color:#065f46}',
      '#section-delivery-times .ts-msg.bad,#tsModal .ts-msg.bad{background:#fef2f2;color:#991b1b}',
      '#section-delivery-times .ts-link{background:none;border:0;color:#1d4ed8;font:inherit;font-weight:700;text-decoration:underline;cursor:pointer;padding:0 4px}',
      '#section-delivery-times .ts-warn{background:#fef3c7;color:#92400e;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:12px}',
      '#section-delivery-times .ts-day-h{font-weight:800;color:#0a2f66;margin:14px 0 6px;font-size:15px}',
      '#section-delivery-times .ts-run{border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin-bottom:10px;background:#fff}',
      '#section-delivery-times .ts-run-top{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:flex-start}',
      '#section-delivery-times .ts-pills{display:flex;gap:6px;flex-wrap:wrap}',
      '#section-delivery-times .ts-pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:700;white-space:nowrap}',
      '#section-delivery-times .ts-pill.ok{background:#d1fae5;color:#065f46}#section-delivery-times .ts-pill.warn{background:#fef3c7;color:#92400e}#section-delivery-times .ts-pill.info{background:#dbeafe;color:#1e40af}#section-delivery-times .ts-pill.mute{background:#f3f4f6;color:#4b5563}#section-delivery-times .ts-pill.bad{background:#fee2e2;color:#991b1b}',
      '#section-delivery-times .ts-store{margin-top:10px}',
      '#section-delivery-times .ts-store-h{font-weight:800;font-size:13px;padding:6px 0;border-bottom:2px solid #e5e7eb}',
      '#section-delivery-times .ts-order{padding:10px 0;border-bottom:1px solid #f1f5f9;font-size:14px;word-break:break-word}',
      '#section-delivery-times .ts-order.attn{background:#fef2f2;padding:10px;border-radius:8px}',
      '#section-delivery-times .ts-order a{color:#1d4ed8;font-weight:700}',
      '#section-delivery-times .ts-items{font-size:13px;margin-top:3px}',
      '#section-delivery-times .ts-switch{position:relative;display:inline-block;width:46px;height:26px;flex:0 0 auto}',
      '#section-delivery-times .ts-switch input{opacity:0;width:0;height:0;position:absolute}',
      '#section-delivery-times .ts-switch span{position:absolute;inset:0;background:#cbd5e1;border-radius:999px;transition:.15s;cursor:pointer}',
      '#section-delivery-times .ts-switch span:before{content:"";position:absolute;width:20px;height:20px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.15s}',
      '#section-delivery-times .ts-switch input:checked+span{background:#059669}',
      '#section-delivery-times .ts-switch input:checked+span:before{transform:translateX(20px)}',
      '.ts-modal{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:12px}',
      '.ts-sheet{background:#fff;border-radius:16px;width:100%;max-width:480px;max-height:92vh;overflow:auto;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.3)}',
      '.ts-sheet h3{margin:0 0 10px;font-size:17px}',
      '.ts-sheet p{margin:0 0 10px;font-size:14px;line-height:1.45}',
      '.ts-sheet .ts-sub{font-size:12.5px;color:#6b7280}',
      '.ts-sheet .ts-form{display:flex;gap:10px}.ts-sheet .ts-form .ts-field{flex:1}',
      '.ts-daypick{display:flex;gap:6px;flex-wrap:wrap}',
      '.ts-dchip input{position:absolute;opacity:0}.ts-dchip span{display:inline-block;padding:8px 11px;border-radius:999px;background:#e5e7eb;font-weight:700;font-size:13px;cursor:pointer}.ts-dchip input:checked+span{background:#0a2f66;color:#fff}',
      '.ts-check{display:flex;gap:8px;align-items:center;font-size:14px;font-weight:700;margin:6px 0}',
      '.ts-runs{display:flex;flex-direction:column;gap:8px;margin:8px 0}',
      '.ts-runopt{display:flex;gap:10px;align-items:flex-start;border:1px solid #d1d5db;border-radius:10px;padding:10px;cursor:pointer;font-size:14px}',
      '.ts-runopt.closed{border-color:#fca5a5;background:#fef2f2}',
      '@media (max-width:640px){.ts-modal{align-items:flex-end;padding:0}.ts-sheet{border-radius:16px 16px 0 0;max-width:none}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  window.loadTimeslotsAdmin = function () {
    injectCss(); wire();
    var p = loadAll(false); if (p && p.catch) p.catch(function (e) { toast(friendly(e)); });
    clearInterval(timer);
    timer = setInterval(function () {
      var root = $('section-delivery-times');
      if (!root || root.style.display === 'none' || $('tsModal') || document.hidden) return;
      var ae = document.activeElement; if (ae && /INPUT|SELECT|TEXTAREA/.test(ae.tagName) && root.contains(ae)) return;
      loadAll(true).catch(function () { });
    }, 60000);
  };
})();
