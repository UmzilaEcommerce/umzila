/* Admin → Finances (profit & loss, payment fees, store owed, expenses/income, corrections).
   Plan: docs/plans/admin-logistics-audit-and-finances-plan.md §2 (workstream B) — the
   "FOUNDER ANSWERS (2026-11-16)" block overrides it; contract changes in
   docs/plans/finances-contract-changes.md. System notes: docs/systems/finances.md.
   Server-side truth only: every figure comes from the SECURITY DEFINER fin_* RPCs (admin-gated
   with timeslot_is_admin()); this file formats, filters already-returned rows and builds CSVs.
   It never reads `orders` and never adds money up for display (the one exception is a dev
   self-check that only logs a console warning when the server's P&L rows don't reconcile).
   Writes: fin_entry_save / fin_entry_void (expenses, income, per-order adjustments),
   fin_store_price_set (per-product store price), site_settings key 'finance' (assumptions,
   admin RLS + validation trigger). No keys in this file. Uses admin.html's global `supabaseClient`.
   Also: window.loadFinanceDashboard() fills the dashboard money cards (#finDashMount) and the
   two "last 30 days" charts from fin_summary. */
(function () {
  'use strict';
  var TZ = 'Africa/Johannesburg';
  var PAGE = 50;

  // Founder fee table (2026-11-16, ex VAT; VAT 15 % added when vat = true). Used only as the
  // "reset to PayFast defaults" values and as a fallback for labels — the server decides.
  var FEE_DEFAULTS = {
    cc: { name: 'Card', pct: 3.2, fixed: 2, vat: true, min: 0 },
    dc: { name: 'Debit card', pct: 3.2, fixed: 2, vat: true, min: 0 },
    ap: { name: 'Apple Pay', pct: 3.2, fixed: 2, vat: true, min: 0 },
    gp: { name: 'Google Pay', pct: 3.2, fixed: 2, vat: true, min: 0 },
    sp: { name: 'Samsung Pay', pct: 3.2, fixed: 2, vat: true, min: 0 },
    cp: { name: 'Capitec Pay', pct: 2, fixed: 0, vat: true, min: 2 },
    ef: { name: 'Instant EFT', pct: 2, fixed: 0, vat: true, min: 2 },
    cash: { name: 'Cash', pct: 0, fixed: 0, vat: false, min: 0 },
    pos: { name: 'Card machine', pct: 0, fixed: 0, vat: false, min: 0 },
    eft_manual: { name: 'EFT (manual)', pct: 0, fixed: 0, vat: false, min: 0 },
    unknown: { name: 'PayFast (method unknown)', pct: 3.2, fixed: 2, vat: true, min: 0 }
  };
  var DEFAULTS = {
    default_markup_percent: 12,
    count_rider_pay_as_cost: false,
    tips_go_to: 'umzila',
    seller_codes_funded_by: 'seller',
    manual_discount_funded_by: 'umzila',
    fee_rates: FEE_DEFAULTS,
    expense_categories: ['Fuel', 'Marketing', 'Printing', 'Salaries', 'Rider wages', 'Software', 'Packaging', 'PayFast payout fee', 'Bank charges', 'Other'],
    income_categories: ['Prize', 'Grant', 'Sponsorship', 'Other'],
    own_store_ids: []
  };
  var ADJ = {
    exclude_test: 'Marked as test',
    refund: 'Refund',
    seller_payout_override: 'Owed to store (override)',
    rider_pay_override: 'Rider pay (override)',
    payment_fee_override: 'Payment fee (override)',
    payment_method_set: 'Payment method set',
    cogs_override: 'Own stock cost (override)',
    note: 'Note'
  };
  var FLAG = {
    totals_mismatch: 'Totals differ', items_fallback: 'Items from order JSON', cogs_missing: 'Stock cost missing (estimated)',
    store_price_estimated: 'Store price estimated', no_lines: 'No items found', delivery_cancelled: 'Delivery cancelled',
    looks_like_test: 'Looks like a test'
  };
  var FLAG_HIDE = { excluded: 1, refund: 1 }; // shown as their own pills

  var S = {
    range: null, preset: 'month', includeTests: false,
    summary: null, summaryErr: null, lines: null, linesErr: null,
    entries: null, entriesErr: null, showVoided: false,
    prices: null, pricesErr: null, pricesAll: false, priceQ: '',
    settings: clone(DEFAULTS), settingsRow: null, settingsErr: null,
    house: null, sellers: null, feeDefaults: null,
    gran: 'day', filter: null, shown: PAGE, q: '', msgs: {}, loaded: false, loading: false, openAssump: false
  };

  // ---------- helpers ----------
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function sb() { return typeof supabaseClient !== 'undefined' ? supabaseClient : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(m) { try { if (typeof showToast === 'function') return showToast(m); } catch (e) { /* ignore */ } try { alert(m); } catch (e2) { /* ignore */ } }
  function $(id) { return document.getElementById(id); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function has(v) { return v !== null && v !== undefined && v !== ''; }
  var ZAR = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' });
  function money(v) { return has(v) ? ZAR.format(num(v)) : '—'; }
  function moneyE(v, est) { return (est ? '≈ ' : '') + money(v); }
  function pct(v) { return (Math.round(num(v) * 1000) / 10).toFixed(1).replace(/\.0$/, '') + '%'; }
  function sastDate(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date()); }
  function addDays(ymd, n) { var p = ymd.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10); }
  function dow(ymd) { var p = ymd.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); }
  function fmtD(ymd) { if (!ymd) return '—'; var p = String(ymd).slice(0, 10).split('-').map(Number); return new Intl.DateTimeFormat('en-ZA', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(Date.UTC(p[0], p[1] - 1, p[2]))); }
  function fmtShort(ymd) { if (!ymd) return ''; var p = String(ymd).slice(0, 10).split('-').map(Number); return new Intl.DateTimeFormat('en-ZA', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(Date.UTC(p[0], p[1] - 1, p[2]))); }
  function fmtWhen(ts) { if (!ts) return '—'; try { return new Intl.DateTimeFormat('en-ZA', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts)); } catch (e) { return String(ts); } }
  function list(d, k) { if (Array.isArray(d)) return d; if (d && k && Array.isArray(d[k])) return d[k]; if (d && Array.isArray(d.rows)) return d.rows; return []; }
  function o(v) { return v && typeof v === 'object' ? v : {}; }
  // First present value among several possible keys (tolerates small contract renames).
  function pick(obj) { obj = o(obj); for (var i = 1; i < arguments.length; i++) { var v = obj[arguments[i]]; if (v !== undefined && v !== null) return v; } return undefined; }
  function amountOf(v) { if (v && typeof v === 'object') return pick(v, 'total', 'amount', 'sum'); return v; }
  function itemsOf(v) { return v && typeof v === 'object' ? list(v, 'items') : []; }
  function msg(key) { var m = S.msgs[key]; return m ? '<div class="fn-msg ' + (m.ok ? 'ok' : 'bad') + '">' + esc(m.t) + '</div>' : ''; }
  function setMsg(key, t, ok) { S.msgs[key] = { t: t, ok: ok !== false }; }
  function friendly(err) {
    var m = (err && err.message) || String(err || 'Something went wrong');
    if (/FINANCE_INVALID|FIN_INVALID|INVALID/.test(m) && err && err.details) return 'The server refused this: ' + err.details;
    if (/PGRST202|42883|Could not find the function|function .* does not exist|PGRST205|42P01/i.test(m)) return 'This part of Finances isn’t set up in the database yet (the finance migration hasn’t been applied).';
    if (/ADMIN_ONLY|row-level security|permission denied|42501|not allowed|admins only/i.test(m)) return 'You don’t have permission to do that (admins only).';
    if (/Failed to fetch|NetworkError|network/i.test(m)) return 'Couldn’t reach the server. Check your connection and try again.';
    return m;
  }
  function missingFn(err) { return /PGRST202|42883|Could not find the function|function .* does not exist/i.test((err && err.message) || ''); }

  async function rpc(name, args) {
    var c = sb(); if (!c) throw new Error('Not connected');
    var r = await c.rpc(name, args || {});
    if (r.error) throw r.error;
    return r.data;
  }
  function settle(p) { return p.then(function (d) { return { d: d }; }, function (e) { return { e: e }; }); }

  // ---------- ranges ----------
  function presetRange(p) {
    var t = sastDate();
    if (p === 'today') return { from: t, to: t };
    if (p === 'week') return { from: addDays(t, -((dow(t) + 6) % 7)), to: t };
    if (p === 'last30') return { from: addDays(t, -29), to: t };
    if (p === 'lastmonth') { var first = t.slice(0, 8) + '01'; var end = addDays(first, -1); return { from: end.slice(0, 8) + '01', to: end }; }
    return { from: t.slice(0, 8) + '01', to: t };
  }
  function rangeLabel() { var r = S.range; return r.from === r.to ? fmtD(r.from) : fmtD(r.from) + ' – ' + fmtD(r.to); }

  // ---------- settings (site_settings key 'finance') ----------
  function normalise(v) {
    var out = Object.assign({}, clone(DEFAULTS), v || {});
    out.fee_rates = Object.keys(o(v && v.fee_rates)).length ? clone(v.fee_rates) : clone(FEE_DEFAULTS);
    if (!out.fee_rates.unknown) out.fee_rates.unknown = clone(FEE_DEFAULTS.unknown);
    Object.keys(out.fee_rates).forEach(function (k) {
      var r = o(out.fee_rates[k]);
      out.fee_rates[k] = { name: r.name || (FEE_DEFAULTS[k] && FEE_DEFAULTS[k].name) || k, pct: num(r.pct), fixed: num(r.fixed), vat: r.vat !== false, min: num(r.min) };
    });
    if (!Array.isArray(out.expense_categories) || !out.expense_categories.length) out.expense_categories = DEFAULTS.expense_categories.slice();
    if (!Array.isArray(out.income_categories) || !out.income_categories.length) out.income_categories = DEFAULTS.income_categories.slice();
    if (!Array.isArray(out.own_store_ids)) out.own_store_ids = [];
    if (out.expense_categories.indexOf('PayFast payout fee') < 0) out.expense_categories.push('PayFast payout fee');
    return out;
  }
  function validate(v) {
    var m = Number(v.default_markup_percent);
    if (!(m >= 0 && m <= 100)) return 'Default mark-up must be between 0 and 100 %.';
    var keys = Object.keys(v.fee_rates || {});
    for (var i = 0; i < keys.length; i++) {
      var r = v.fee_rates[keys[i]];
      if (!(r.pct >= 0 && r.pct <= 20)) return r.name + ': the % must be between 0 and 20.';
      if (!(r.fixed >= 0 && r.fixed <= 50)) return r.name + ': the fixed fee must be between R0 and R50.';
      if (!(r.min >= 0 && r.min <= 50)) return r.name + ': the minimum must be between R0 and R50.';
    }
    var cats = [v.expense_categories, v.income_categories];
    for (var k = 0; k < 2; k++) {
      if (!cats[k].length) return 'Keep at least one category.';
      for (var q = 0; q < cats[k].length; q++) if (!String(cats[k][q]).trim() || String(cats[k][q]).length > 60) return 'Categories need a name of at most 60 characters.';
    }
    return null;
  }
  // Assumptions are read/written through fin_settings_get / fin_settings_save (admin-checked; the save
  // never touches store_prices, which only fin_store_price_set changes). Re-read → mutate the fresh copy →
  // validate → save, so two admins editing at once don't undo each other.
  function applySettings(d) {
    d = o(d);
    S.settingsRow = { updated_at: d.updated_at, updated_by_name: d.updated_by_name };
    S.settings = normalise(d.value); S.settingsErr = null;
    if (d.payfast_defaults && typeof d.payfast_defaults === 'object') S.feeDefaults = d.payfast_defaults;
  }
  async function saveWith(mutate) {
    try {
      var cur = o(await rpc('fin_settings_get'));
      var raw = clone(o(cur.value)); delete raw.store_prices;
      var next = normalise(raw);
      if (mutate(next) === false) return { ok: false, error: 'Nothing changed' };
      var bad = validate(next); if (bad) return { ok: false, error: bad };
      var merged = Object.assign(raw, next); // keep keys this screen doesn't know about
      applySettings(await rpc('fin_settings_save', { p_value: merged }));
      return { ok: true };
    } catch (e) { return { ok: false, error: 'Couldn’t save: ' + friendly(e) }; }
  }
  async function loadSettings() {
    try { applySettings(await rpc('fin_settings_get')); }
    catch (e) { S.settingsErr = friendly(e); }
  }
  async function loadSellers() {
    var c = sb(); if (!c || S.sellers) return;
    var s = await c.from('sellers').select('id, shop_name, is_house, status').order('shop_name');
    S.sellers = s.error ? [] : (s.data || []);
  }

  // ---------- loads ----------
  async function loadMoney() {
    var rg = S.range;
    S.summary = null; S.lines = null; S.summaryErr = null; S.linesErr = null;
    var res = await Promise.all([
      settle(rpc('fin_summary', { p_from: rg.from, p_to: rg.to, p_include_excluded: S.includeTests })),
      settle(rpc('fin_order_lines', { p_from: rg.from, p_to: rg.to, p_include_excluded: S.includeTests }))
    ]);
    if (res[0].e) S.summaryErr = friendly(res[0].e); else S.summary = o(res[0].d);
    if (res[1].e) S.linesErr = friendly(res[1].e); else S.lines = list(res[1].d, 'orders');
    if (S.summary) selfCheck();
  }
  async function loadEntries() {
    S.entries = null; S.entriesErr = null;
    try { S.entries = list(await rpc('fin_entries_list', { p_from: S.range.from, p_to: S.range.to, p_include_voided: S.showVoided }), 'entries'); }
    catch (e) { S.entriesErr = friendly(e); }
  }
  // Store prices (and the house drinks' cost of goods — same map) come from fin_store_prices_list and are
  // saved one at a time with fin_store_price_set. One call lists everything; "missing" and the house
  // products are filtered from it here (a list to fill in, not money maths).
  async function loadPrices() {
    S.prices = null; S.pricesErr = null; S.house = null;
    try {
      var rows = list(await rpc('fin_store_prices_list', { p_seller_id: null, p_missing_only: false }), 'products');
      S.house = rows.filter(function (p) { return p.is_house; });
      S.prices = [];
      rows.filter(function (p) { return !p.is_house; }).forEach(function (p) {
        var base = { product_id: p.product_id, name: p.name, shop_name: p.shop_name, visible: p.visible, missing: !!p.missing, sold: num(p.sold_value_90d), est: p.estimated_store_price };
        S.prices.push(Object.assign({}, base, { variant_id: null, price: p.sell_price, store_price: p.store_price }));
        list(p.variants).forEach(function (v) { S.prices.push(Object.assign({}, base, { variant_id: v.variant_id, size: v.size, price: v.sell_price, store_price: v.store_price, est: null })); });
      });
    } catch (e) { S.pricesErr = friendly(e); }
  }
  function priceRows() { return (S.prices || []).filter(function (p) { return S.pricesAll || p.missing; }); }
  async function loadAll() {
    var mount = $('financesMount'); if (!mount) return;
    if (!sb()) { mount.innerHTML = '<p class="fn-muted">Supabase not available</p>'; return; }
    if (!S.range) S.range = presetRange(S.preset);
    if (!S.loaded) mount.innerHTML = '<p class="fn-muted">Loading…</p>';
    S.loading = true;
    await Promise.all([loadSettings().catch(function () { }), loadSellers().catch(function () { })]);
    S.loaded = true; render();
    await Promise.all([loadMoney(), loadEntries(), loadPrices()]);
    S.loading = false; render();
  }
  async function reloadMoney() { S.loading = true; render(); await Promise.all([loadMoney(), loadEntries()]); S.loading = false; render(); }

  // ---------- P&L (from fin_summary totals; the browser does not sum orders) ----------
  // Server: umzila_gross_profit = gross − owed_to_stores − payfast_fees − house_cogs − refunds − rider_cost − tips_to_rider
  //         net_profit = umzila_gross_profit + other_income − expenses
  // "External riders" periods (site_settings finance.rider_pay_cost_periods, kept by the server
  // when the switch is flipped — docs/systems/rider-panel.md).
  function riderPeriods(list) {
    list = Array.isArray(list) ? list : [];
    if (!list.length) return '';
    return '<br><b>Periods so far:</b> ' + list.map(function (p) { return esc(fmtWhen(p.from)) + ' → ' + (p.to ? esc(fmtWhen(p.to)) : 'now'); }).join('; ');
  }
  function T() { return o(S.summary && S.summary.totals); }
  function plRows() {
    var t = T(), s = S.summary || {};
    var counted = has(t.rider_pay_counted) ? !!t.rider_pay_counted : !!pick(s.settings, 'count_rider_pay_as_cost');
    var oiD = o(t.other_income_detail), exD = o(t.expenses_detail);
    var oiItems = list(oiD.entries).map(function (e) { return { label: e.category + (e.description ? ' (' + e.description + ')' : ''), amount: e.amount }; });
    if (num(o(oiD.enrolment_fees).amount)) oiItems.push({ label: 'Store sign-up fees ×' + num(oiD.enrolment_fees.count), amount: oiD.enrolment_fees.amount });
    if (num(o(oiD.ads).amount)) oiItems.push({ label: 'Paid ads ×' + num(oiD.ads.count), amount: oiD.ads.amount });
    var exItems = list(exD.by_category).map(function (c) { return { label: c.category, amount: c.amount }; });
    var feesEst = num(t.payfast_fees_estimated), owedEst = num(t.owed_estimated);
    var rows = [
      { key: 'gross', label: 'Order value (cash in)', amount: num(t.gross), sign: 1, note: 'What customers paid: goods, delivery, priority and tips (' + num(s.orders) + ' orders).' },
      { key: 'payouts', label: 'Owed to stores', amount: num(t.owed_to_stores), sign: -1, est: owedEst > 0, note: owedEst > 0 ? money(owedEst) + ' estimated with the default mark-up (no store price set)' : 'Store price per product' }
    ];
    if (counted) {
      rows.push({ key: 'rider', label: 'Rider pay (external riders)', amount: num(t.rider_cost), sign: -1, note: 'Only orders paid while “External riders” was on.' });
      if (num(t.rider_pay) - num(t.rider_cost) > 0.005) rows.push({ key: 'rider_staff', label: 'Rider pay — not counted (staff riders)', amount: num(t.rider_pay) - num(t.rider_cost), info: true, note: 'Orders paid while “External riders” was off.' });
    } else rows.push({ key: 'rider', label: 'Rider pay — not counted (riders are staff)', amount: num(t.rider_pay), info: true, note: 'Record wages and fuel under Expenses. Switch “External riders” on in Assumptions when riders are paid per delivery.' });
    if (num(t.tips_to_rider)) rows.push({ key: 'tips', label: 'Tips passed to riders', amount: num(t.tips_to_rider), sign: -1 });
    rows.push(
      { key: 'fees', label: 'PayFast fees', amount: num(t.payfast_fees), sign: -1, est: feesEst > 0, note: feesEst > 0 ? money(feesEst) + ' of this is estimated from the fee rates' : 'as reported by PayFast' },
      { key: 'cogs', label: 'Cost of our own stock', amount: num(t.house_cogs), sign: -1, note: num(t.house_sales) ? 'Our own stores (Umzila Drinks + own stores) sold ' + money(t.house_sales) : '' },
      { key: 'refunds', label: 'Refunds', amount: num(t.refunds), sign: -1 },
      { key: 'gp', label: 'Umzila gross profit', amount: num(t.umzila_gross_profit), total: true,
        note: 'Mark-up ' + money(t.umzila_commission) + ' · delivery & priority ' + money(t.umzila_delivery_income) + ' · own stores margin ' + money(t.umzila_house_margin) + (num(t.discounts_umzila) ? ' · Umzila codes −' + money(t.discounts_umzila) : '') },
      { key: 'income', label: 'Other income', amount: num(amountOf(t.other_income)), sign: 1, items: oiItems },
      { key: 'expenses', label: 'Expenses', amount: num(amountOf(t.expenses)), sign: -1, items: exItems, note: 'Monthly costs count once for every month the period touches.' },
      { key: 'net', label: 'Net profit / loss', amount: num(t.net_profit), total: true, big: true }
    );
    return rows;
  }
  // Dev self-check: the P&L rows must add up to the totals the server returned.
  function selfCheck() {
    try {
      var rows = plRows(), run = 0, bad = [];
      rows.forEach(function (r) {
        if (r.info) return;
        if (r.total) { if (Math.abs(run - r.amount) > 0.05) bad.push(r.label + ': rows give ' + run.toFixed(2) + ', server says ' + r.amount.toFixed(2)); run = r.amount; return; }
        run += (r.sign || 1) * r.amount;
      });
      if (bad.length) console.warn('[finances] P&L does not reconcile with fin_summary totals —', bad.join(' | '));
      return bad;
    } catch (e) { return []; }
  }

  // ---------- order line accessors ----------
  function L(l) {
    var p = o(l.payment), d = o(l.delivery), u = o(l.umzila), g = o(l.goods), est = o(l.estimates);
    var stores = list(l.stores);
    var flags = list(l.flags).filter(function (f) { return !FLAG_HIDE[f]; });
    var adj = list(l.adjustments).filter(function (a) { return !a.voided_at; });
    return {
      id: l.order_id, num: l.order_number || String(l.order_id || '').slice(0, 8), when: l.when, day: l.day, customer: l.customer_name || 'Customer', email: l.customer_email,
      source: l.source, excluded: !!l.excluded, testCandidate: !!l.is_test_candidate,
      method: p.method_name || p.method_code || '—', methodCode: p.method_code, gross: num(p.gross), fee: num(p.fee), feeEst: !!p.fee_est, net: p.net,
      stores: stores, storeNames: stores.map(function (s) { return s.is_house ? (s.shop_name || 'Umzila Drinks') + ' (ours)' : s.shop_name; }).filter(Boolean).join(' + ') || '—',
      payout: num(u.owed_to_stores), storeEst: !!est.owed, cogs: num(u.house_cogs), rider: num(d.rider_pay), riderEst: !!d.rider_pay_est, riderCounted: !!d.rider_pay_counted,
      delivery: d, goods: g, refund: num(l.refund), tips: num(l.tips), umz: num(u.net), umzObj: u, flags: flags, adj: adj, raw: l
    };
  }
  function filtered() {
    var rows = (S.lines || []).map(L);
    var f = S.filter, q = S.q.trim().toLowerCase();
    if (f === 'payouts') rows = rows.filter(function (r) { return r.payout > 0; });
    else if (f === 'rider') rows = rows.filter(function (r) { return r.rider > 0; });
    else if (f === 'fees') rows = rows.filter(function (r) { return r.fee > 0; });
    else if (f === 'cogs') rows = rows.filter(function (r) { return r.cogs > 0; });
    else if (f === 'refunds') rows = rows.filter(function (r) { return r.refund > 0; });
    else if (f === 'est') rows = rows.filter(function (r) { return r.feeEst || r.riderEst || r.storeEst; });
    else if (f === 'check') rows = rows.filter(function (r) { return ['totals_mismatch', 'items_fallback', 'no_lines'].some(function (k) { return r.flags.indexOf(k) >= 0; }); });
    else if (f === 'maybe') rows = rows.filter(function (r) { return r.testCandidate && !r.excluded; });
    else if (f === 'tests') rows = rows.filter(function (r) { return r.excluded; });
    else if (f && f.indexOf('method:') === 0) { var mc = f.slice(7); rows = rows.filter(function (r) { return (r.methodCode || '') === mc; }); }
    else if (f && f.indexOf('store:') === 0) { var sid = f.slice(6); rows = rows.filter(function (r) { return r.stores.some(function (s) { return String(s.seller_id) === sid; }); }); }
    if (q) rows = rows.filter(function (r) { return (r.num + ' ' + r.customer + ' ' + r.storeNames + ' ' + r.method).toLowerCase().indexOf(q) >= 0; });
    return rows;
  }
  var FILTER_LABEL = { payouts: 'orders with money owed to stores', rider: 'orders with rider pay', fees: 'orders with PayFast fees', cogs: 'orders with our own stock', refunds: 'refunded orders', est: 'orders with estimated figures', check: 'orders to check', tests: 'orders marked as test', maybe: 'orders that may be tests' };
  function filterLabel(f) {
    if (!f) return '';
    if (FILTER_LABEL[f]) return FILTER_LABEL[f];
    if (f.indexOf('method:') === 0) { var m = list(S.summary && S.summary.by_method).filter(function (x) { return x.method_code === f.slice(7); })[0]; return 'paid with ' + (m ? m.name : f.slice(7)); }
    if (f.indexOf('store:') === 0) { var s = list(S.summary && S.summary.by_store).filter(function (x) { return String(x.seller_id) === f.slice(6); })[0]; return 'from ' + (s ? s.shop_name : 'this store'); }
    return f;
  }

  // ---------- render ----------
  function render() {
    var mount = $('financesMount'); if (!mount) return;
    var h = rangeBar();
    if (S.summaryErr && S.linesErr && missingFn({ message: S.summaryErr })) {
      h += '<div class="fn-warn">' + esc(S.summaryErr) + ' The rest of the admin portal keeps working.</div>';
    }
    h += plCard() + insightsCard() + methodCard() + storeCard() + timeCard() + deliveryCard() + ordersCard() + entriesCard() + pricesCard() + assumptionsCard();
    mount.innerHTML = h;
    drawChart();
  }
  function rangeBar() {
    var rg = S.range, t = sastDate();
    var pre = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['last30', 'Last 30 days'], ['custom', 'Custom']];
    var h = '<div class="fn-range"><div class="fn-chips" role="group" aria-label="Period">' + pre.map(function (p) {
      return '<button type="button" class="fn-chip' + (S.preset === p[0] ? ' on' : '') + '" data-act="preset" data-p="' + p[0] + '">' + p[1] + '</button>';
    }).join('') + '</div>';
    if (S.preset === 'custom') h += '<div class="fn-form"><div class="fn-field"><label for="fnFrom">From</label><input type="date" id="fnFrom" value="' + esc(rg.from) + '" max="' + t + '"></div><div class="fn-field"><label for="fnTo">To</label><input type="date" id="fnTo" value="' + esc(rg.to) + '" max="' + t + '"></div><button type="button" class="fn-btn primary" data-act="range">Show</button></div>';
    h += '<div class="fn-rangeline"><b>' + esc(rangeLabel()) + '</b>' + (S.loading ? ' <span class="fn-muted">· loading…</span>' : '') +
      '<label class="fn-check"><input type="checkbox" data-act="tests"' + (S.includeTests ? ' checked' : '') + '> Include test orders</label>' +
      '<button type="button" class="fn-btn" data-act="csv"' + (S.lines ? '' : ' disabled') + '>⬇ Export CSV</button><button type="button" class="fn-btn" data-act="reload" aria-label="Refresh">↻</button></div>' + msg('range') + '</div>';
    return h;
  }
  function plCard() {
    var h = '<div class="fn-card"><div class="fn-h"><h3>Profit &amp; loss</h3><span class="fn-muted">South African time · paid orders only</span></div>';
    if (S.summaryErr) return h + '<div class="fn-warn">' + esc(S.summaryErr) + '</div></div>';
    if (!S.summary) return h + '<p class="fn-muted">Loading…</p></div>';
    var s = S.summary, t = T(), net = num(t.net_profit);
    h += '<div class="fn-net ' + (net >= 0 ? 'pos' : 'neg') + '"><span>' + (net >= 0 ? 'Net profit' : 'Net loss') + '</span><b>' + money(net) + '</b><small>' + num(s.orders) + ' paid orders' +
      (num(s.excluded_orders) ? ' · <a href="#" data-act="filter" data-f="tests">' + num(s.excluded_orders) + ' test order' + (num(s.excluded_orders) === 1 ? '' : 's') + (s.include_excluded ? ' included' : ' hidden') + '</a>' : '') + '</small></div>';
    h += '<div class="fn-wf">' + plRows().map(function (r) {
      var cls = 'fn-wfr' + (r.total ? ' tot' : '') + (r.big ? ' big' : '') + (r.info ? ' info' : '');
      var amt = r.total ? money(r.amount) : r.info ? money(r.amount) : (r.sign < 0 ? '− ' : '+ ') + money(Math.abs(r.amount));
      var clickable = ['gross', 'payouts', 'rider', 'tips', 'fees', 'cogs', 'refunds'].indexOf(r.key) >= 0;
      var sub = (r.note ? '<small>' + esc(r.note) + '</small>' : '') +
        (r.items && r.items.length ? '<small>' + r.items.map(function (i) { return esc(i.label || i.category || i.name || 'Item') + ' ' + money(i.amount); }).join(' · ') + '</small>' : '');
      return '<div class="' + cls + '"' + (clickable ? ' data-act="filter" data-f="' + (r.key === 'gross' ? '' : r.key) + '" role="button" tabindex="0" title="Show these orders"' : '') + '><div class="fn-wfl"><span>' + esc(r.label) + (r.est ? ' <span class="fn-pill warn">≈</span>' : '') + '</span>' + sub + '</div><b>' + (r.est ? '≈ ' : '') + amt + '</b></div>';
    }).join('') + '</div>';
    var es = num(s.estimated_share);
    if (es > 0) h += '<p class="fn-help">≈ ' + pct(es) + ' of the costs (fees, store payouts, counted rider pay) are estimates. <a href="#" data-act="filter" data-f="est">See which orders</a> · fill in store prices below to make them exact.</p>';
    return h + '</div>';
  }
  function insightsCard() {
    var ins = list(S.summary && S.summary.insights);
    if (!ins.length) return '';
    return '<div class="fn-card"><div class="fn-h"><h3>Worth knowing</h3></div><div class="fn-ins">' + ins.map(function (i) {
      return '<div class="fn-in ' + esc(i.severity || 'info') + '"><b>' + esc(i.title || '') + '</b>' + (i.detail ? '<div>' + esc(i.detail) + '</div>' : '') + '</div>';
    }).join('') + '</div></div>';
  }
  function table(cols, rows, foot) {
    return '<div class="fn-tw"><table class="fn-table"><thead><tr>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr' + (r.attrs || '') + '>' + r.cells.map(function (c, i) { return '<td data-label="' + esc(cols[i]) + '">' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
      '</tbody>' + (foot ? '<tfoot><tr>' + foot.map(function (c, i) { return '<td data-label="' + esc(cols[i]) + '">' + c + '</td>'; }).join('') + '</tr></tfoot>' : '') + '</table></div>';
  }
  function methodCard() {
    var h = '<div class="fn-card"><div class="fn-h"><h3>By payment method</h3></div>';
    if (!S.summary) return h + '<p class="fn-muted">' + (S.summaryErr ? '—' : 'Loading…') + '</p></div>';
    var rows = list(S.summary.by_method), gross = num(T().gross);
    if (!rows.length) return h + '<p class="fn-muted">No paid orders in this period.</p></div>';
    h += table(['Method', 'Orders', 'Paid', 'Fees', 'Fee %', 'Share'], rows.map(function (r) {
      var est = num(r.fees_est_orders);
      return { attrs: ' class="fn-click" data-act="filter" data-f="method:' + esc(r.method_code || '') + '"', cells: [esc(r.name || r.method_code || '—'), num(r.orders), money(r.gross), moneyE(r.fees, est) + (est ? '<small class="fn-muted"> incl. ' + money(r.fees_estimated) + ' est. on ' + est + '</small>' : ''), pct(num(r.effective_pct) / 100), has(r.share_of_gross) ? pct(r.share_of_gross) : (gross ? pct(num(r.gross) / gross) : '—')] };
    }));
    return h + '<p class="fn-help">PayFast’s own fee is used whenever it reported one; ≈ means the rate from Assumptions was used. Orders paid before the payment picker show as “method unknown”.</p></div>';
  }
  function storeCard() {
    var h = '<div class="fn-card"><div class="fn-h"><h3>By store</h3></div>';
    if (!S.summary) return h + '<p class="fn-muted">' + (S.summaryErr ? '—' : 'Loading…') + '</p></div>';
    var rows = list(S.summary.by_store);
    if (!rows.length) return h + '<p class="fn-muted">No store sales in this period.</p></div>';
    h += table(['Store', 'Orders', 'Goods sold', 'Store promos', 'Umzila earned', 'Owed to store', 'Margin'], rows.map(function (r) {
      var est = num(r.owed_estimated) > 0;
      var house = !!r.is_house;
      return { attrs: ' class="fn-click" data-act="filter" data-f="store:' + esc(r.seller_id) + '"', cells: [
        esc(r.shop_name || '—') + (house ? ' <span class="fn-pill info">ours</span>' : '') + (est ? ' <span class="fn-pill warn">≈</span>' : ''),
        num(r.orders), money(r.goods), money(r.discounts),
        house ? money(r.margin) + '<small class="fn-muted"> after ' + money(r.cogs) + ' cost' + (r.cogs_missing ? ' (some missing)' : '') + '</small>' : moneyE(r.commission, est),
        house ? '<span class="fn-muted">— (ours)</span>' : moneyE(r.owed, est),
        pct(num(r.margin_pct) / 100)] };
    }));
    return h + '<p class="fn-help">“Umzila earned” is the mark-up: what customers paid for the goods minus the store’s price. Store promo codes come out of the store’s share; Umzila’s codes (spin, mystery gift, platform) are Umzila’s cost. Umzila Drinks and our own stores (Assumptions → Umzila’s own stores) are ours: sales minus the cost of the stock.</p></div>';
  }
  function timeCard() {
    var h = '<div class="fn-card"><div class="fn-h"><h3>Over time</h3><div class="fn-chips"><button type="button" class="fn-chip' + (S.gran === 'day' ? ' on' : '') + '" data-act="gran" data-g="day">Day</button><button type="button" class="fn-chip' + (S.gran === 'week' ? ' on' : '') + '" data-act="gran" data-g="week">Week</button></div></div>';
    if (!S.summary) return h + '<p class="fn-muted">' + (S.summaryErr ? '—' : 'Loading…') + '</p></div>';
    var rows = timeRows();
    if (!rows.length) return h + '<p class="fn-muted">Nothing in this period.</p></div>';
    h += '<div class="fn-chart"><canvas id="fnChart" aria-label="Order value and profit over time" role="img"></canvas></div>';
    h += '<details class="fn-details"><summary>Table</summary>' + table([S.gran === 'week' ? 'Week of' : 'Day', 'Orders', 'Order value', 'Gross profit'], rows.map(function (r) {
      return { cells: [esc(fmtShort(r.k)), num(r.orders), money(r.gross), money(r.umzila_gross_profit)] };
    })) + '</details><p class="fn-help">Gross profit per day/week, before expenses and other income (those are for the whole period).</p>';
    return h + '</div>';
  }
  function timeRows() {
    var s = S.summary || {};
    var src = S.gran === 'week' ? list(s.by_week) : list(s.by_day);
    return src.map(function (r) { return Object.assign({ k: r.week_start || r.day || r.period }, r); });
  }
  function drawChart() {
    var cv = $('fnChart'); if (!cv || typeof Chart === 'undefined') return;
    try { var old = Chart.getChart(cv); if (old) old.destroy(); } catch (e) { /* ignore */ }
    var rows = timeRows();
    new Chart(cv, {
      type: 'bar',
      data: { labels: rows.map(function (r) { return fmtShort(r.k); }), datasets: [
        { label: 'Order value', data: rows.map(function (r) { return num(r.gross); }), backgroundColor: 'rgba(37,99,235,.35)', borderColor: '#2563eb', borderWidth: 1 },
        { label: 'Gross profit', data: rows.map(function (r) { return num(r.umzila_gross_profit); }), backgroundColor: '#059669' }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } }, tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + money(c.parsed.y); } } } }, scales: { y: { beginAtZero: true, ticks: { callback: function (v) { return 'R' + v; } } } } }
    });
  }
  function deliveryCard() {
    if (!S.summary) return '';
    var t = T(), cust = num(t.delivery_customer), pri = num(t.priority), rider = num(t.rider_pay), tips = num(t.tips);
    var counted = !!t.rider_pay_counted;
    var h = '<div class="fn-card"><div class="fn-h"><h3>Delivery</h3><a href="#" data-act="goto" data-s="delivery-analytics" class="fn-link">Delivery Analytics →</a></div><div class="fn-kvs">' +
      kv('Delivery fees charged', money(cust)) + kv('Priority fees', money(pri)) + kv('Tips' + (S.settings.tips_go_to === 'rider' ? ' (to riders)' : ''), money(tips)) +
      kv('Umzila delivery & priority income', money(t.umzila_delivery_income)) +
      kv('Rider pay (route payouts)' + (counted ? '' : ' — not counted'), money(rider)) + (counted ? kv('Delivery after rider pay', money(num(t.umzila_delivery_income) - num(t.rider_cost))) : '') + '</div>';
    return h + '<p class="fn-help">All delivery and priority money is Umzila’s' + (S.settings.tips_go_to === 'rider' ? '; tips go to the rider' : ', and so are tips') + '. Riders are paid as staff, so rider pay is shown for comparison and only counts as a cost when “Count rider pay as a cost” is on in Assumptions.</p></div>';
  }
  function kv(k, v) { return '<div class="fn-kv"><span>' + esc(k) + '</span><b>' + v + '</b></div>'; }
  function ordersCard() {
    var h = '<div class="fn-card" id="fnOrders"><div class="fn-h"><h3>Orders</h3><input type="search" class="fn-search" id="fnQ" placeholder="Search order, customer, store" value="' + esc(S.q) + '" aria-label="Search orders"></div>';
    if (S.linesErr) return h + '<div class="fn-warn">' + esc(S.linesErr) + '</div></div>';
    if (!S.lines) return h + '<p class="fn-muted">Loading…</p></div>';
    var rows = filtered();
    if (S.filter) h += '<div class="fn-filter">Showing ' + rows.length + ' ' + esc(filterLabel(S.filter)) + ' <button type="button" class="fn-btn sm" data-act="filter" data-f="">Show all</button></div>';
    var chips = [['est', 'Estimated'], ['check', 'Check these'], ['refunds', 'Refunds'], ['maybe', 'May be tests']];
    if (S.includeTests) chips.push(['tests', 'Test orders']);
    h += '<div class="fn-chips">' + chips.map(function (c) { return '<button type="button" class="fn-chip' + (S.filter === c[0] ? ' on' : '') + '" data-act="filter" data-f="' + (S.filter === c[0] ? '' : c[0]) + '">' + c[1] + '</button>'; }).join('') + '</div>';
    if (!rows.length) return h + '<p class="fn-muted">' + ((S.lines || []).length ? 'No orders match.' : 'No paid orders in this period.') + '</p></div>';
    h += table(['When', 'Order', 'Store', 'Paid with', 'Paid', 'Fee', 'Owed to store', 'Rider pay', 'Umzila net', 'Test'], rows.slice(0, S.shown).map(function (r) {
      var fl = r.flags.map(function (f) { return '<span class="fn-pill ' + (f === 'totals_mismatch' ? 'bad' : 'warn') + '">' + esc(FLAG[f] || f) + '</span>'; }).join('') +
        (r.refund ? '<span class="fn-pill info">Refund ' + money(r.refund) + '</span>' : '') + (r.adj.some(function (a) { return /override|method_set/.test(a.type || a.adjustment_type || ''); }) ? '<span class="fn-pill info">Override</span>' : '') + (r.excluded ? '<span class="fn-pill warn">Test — not counted</span>' : '');
      return { attrs: ' class="fn-click' + (r.excluded ? ' fn-dim' : '') + '" data-act="order" data-id="' + esc(r.id) + '"', cells: [
        esc(fmtWhen(r.when)),
        '<b>' + esc(r.num) + '</b><small class="fn-muted"> ' + esc(r.customer) + '</small>' + (fl ? '<div class="fn-tags">' + fl + '</div>' : ''),
        esc(r.storeNames), esc(r.method), money(r.gross), moneyE(r.fee, r.feeEst), moneyE(r.payout, r.storeEst), moneyE(r.rider, r.riderEst),
        '<b class="' + (r.umz < 0 ? 'fn-neg' : '') + '">' + money(r.umz) + '</b>',
        '<label class="fn-switch" title="Exclude this order from the figures (test order)"><input type="checkbox" data-act="test" data-id="' + esc(r.id) + '"' + (r.excluded ? ' checked' : '') + ' aria-label="Order ' + esc(r.num) + ' is a test order"><span></span></label>'] };
    }));
    if (rows.length > S.shown) h += '<div class="fn-actions"><button type="button" class="fn-btn" data-act="more">Show more (' + (rows.length - S.shown) + ' left)</button></div>';
    return h + '<p class="fn-help">Tap an order for every figure and where it comes from, and to record a refund, override or note. Switch “Test” on for orders that weren’t real sales — they stay in the order history but leave these figures.' + (S.includeTests ? '' : ' Test orders are hidden; tick “Include test orders” at the top to see and un-mark them.') + '</p></div>';
  }

  function entriesCard() {
    var h = '<div class="fn-card" id="fnEntries"><div class="fn-h"><h3>Expenses &amp; other income</h3><div class="fn-actions"><button type="button" class="fn-btn primary" data-act="entry-new" data-kind="expense">+ Expense</button><button type="button" class="fn-btn" data-act="entry-new" data-kind="income">+ Income</button><button type="button" class="fn-btn" data-act="entry-new" data-kind="expense" data-rec="monthly">+ Monthly cost</button></div></div>' + msg('entries');
    if (S.entriesErr) return h + '<div class="fn-warn">' + esc(S.entriesErr) + '</div></div>';
    if (!S.entries) return h + '<p class="fn-muted">Loading…</p></div>';
    var rows = S.entries.filter(function (e) { return e.kind !== 'adjustment'; });
    h += '<label class="fn-check"><input type="checkbox" data-act="voided"' + (S.showVoided ? ' checked' : '') + '> Show removed</label>';
    if (!rows.length) return h + '<p class="fn-muted">Nothing recorded for this period. Add the Enspire prize, wages, fuel, printing, PayFast payout fees…</p></div>';
    h += '<div class="fn-list">' + rows.map(function (e) {
      var v = !!e.voided_at;
      return '<div class="fn-item' + (v ? ' fn-dim' : '') + '"><div class="fn-item-top"><div class="fn-grow"><b>' + esc(e.category) + '</b>' + (e.description ? ' · ' + esc(e.description) : '') +
        '<div class="fn-sub">' + esc(fmtD(e.occurred_on)) + (e.recurring === 'monthly' ? ' · <span class="fn-pill info">Monthly' + (e.recur_until ? ' until ' + esc(fmtD(e.recur_until)) : '') + '</span>' : '') +
        (e.shop_name ? ' · ' + esc(e.shop_name) : '') + (e.created_by_name || e.by ? ' · by ' + esc(e.created_by_name || e.by) : '') +
        (v ? ' · removed ' + esc(fmtWhen(e.voided_at)) + (e.void_reason ? ' (' + esc(e.void_reason) + ')' : '') : '') + '</div></div>' +
        '<b class="' + (e.kind === 'expense' ? 'fn-neg' : 'fn-pos') + '">' + (e.kind === 'expense' ? '− ' : '+ ') + money(e.amount) + '</b></div>' +
        (v ? '' : '<div class="fn-actions"><button type="button" class="fn-btn sm" data-act="entry-edit" data-id="' + esc(e.id) + '">Edit</button><button type="button" class="fn-btn sm danger-o" data-act="void" data-id="' + esc(e.id) + '">Remove</button></div>') + '</div>';
    }).join('') + '</div>';
    return h + '<p class="fn-help">Removed entries are kept (greyed) for the record and no longer count. A monthly cost counts once for every month the chosen period touches.</p></div>';
  }

  function pricesCard() {
    var h = '<div class="fn-card" id="fnPrices"><div class="fn-h"><h3>Store prices' + (S.prices ? ' — ' + (S.prices || []).filter(function (p) { return p.missing && !p.variant_id; }).length + ' products missing' : '') + '</h3><label class="fn-check"><input type="checkbox" data-act="prices-all"' + (S.pricesAll ? ' checked' : '') + '> Show all products</label></div>' +
      '<p class="fn-help">The store price is what the store is owed per item (e.g. Umzila sells a plate for R137, the store’s price is R130, Umzila earns R7). Products without one use the default mark-up of ' + esc(S.settings.default_markup_percent) + ' % (store owed = price ÷ ' + (1 + num(S.settings.default_markup_percent) / 100).toFixed(2) + ') and show as ≈.</p>' + msg('prices');
    if (S.pricesErr) return h + '<div class="fn-warn">' + esc(S.pricesErr) + '</div></div>';
    if (!S.prices) return h + '<p class="fn-muted">Loading…</p></div>';
    var q = S.priceQ.trim().toLowerCase();
    var all = priceRows();
    var rows = all.filter(function (p) { return !q || ((p.name || '') + ' ' + (p.size || '') + ' ' + (p.shop_name || '')).toLowerCase().indexOf(q) >= 0; });
    h += '<input type="search" class="fn-search" id="fnPriceQ" placeholder="Search product or store" value="' + esc(S.priceQ) + '" aria-label="Search products">';
    if (!all.length) return h + '<p class="fn-muted">' + (S.pricesAll ? 'No products.' : 'Every product has a store price. ✓') + '</p></div>';
    h += '<div class="fn-list">' + rows.slice(0, 200).map(function (p) {
      var key = esc(p.product_id) + '|' + esc(p.variant_id || '');
      var sp = pick(p, 'store_price');
      return '<div class="fn-item fn-price"><div class="fn-grow"><b>' + esc(p.name || 'Product') + '</b>' + (p.size ? ' · ' + esc(p.size) : '') + (p.visible === false ? ' <span class="fn-pill info">hidden</span>' : '') +
        '<div class="fn-sub">' + esc(p.shop_name || '') + ' · sells at ' + money(p.price) + (has(sp) ? '' : has(p.est) ? ' · estimate ' + money(p.est) : '') + (p.sold ? ' · sold ' + money(p.sold) + ' in 90 days' : '') + '</div></div>' +
        '<div class="fn-pin"><label class="fn-sr" for="fnSp' + key + '">Store price</label><span>R</span><input type="number" inputmode="decimal" min="0" step="0.01" id="fnSp' + key + '" data-price="' + num(p.price) + '" value="' + (has(sp) ? esc(num(sp).toFixed(2)) : '') + '" placeholder="' + (num(p.price) / (1 + num(S.settings.default_markup_percent) / 100)).toFixed(2) + '"><button type="button" class="fn-btn sm primary" data-act="price-save" data-pid="' + esc(p.product_id) + '" data-vid="' + esc(p.variant_id || '') + '">Save</button></div></div>';
    }).join('') + '</div>' + (rows.length > 200 ? '<p class="fn-muted">Showing the first 200 — search to narrow.</p>' : '');
    return h + '</div>';
  }

  function assumptionsCard() {
    var st = S.settings, row = S.settingsRow;
    var h = '<div class="fn-card" id="fnAssump"><details class="fn-details"' + (S.openAssump ? ' open' : '') + ' data-act="assump"><summary><h3 style="display:inline">Assumptions</h3> <span class="fn-muted">' + (row && row.updated_at ? 'last changed ' + esc(fmtWhen(row.updated_at)) : 'not saved yet — defaults') + '</span></summary>';
    if (S.settingsErr) h += '<div class="fn-warn">Couldn’t load the finance settings: ' + esc(S.settingsErr) + '</div>';
    h += msg('assump') + '<div class="fn-grid">' +
      '<div class="fn-field"><label for="fnMarkup">Default mark-up % (products without a store price)</label><input type="number" inputmode="decimal" id="fnMarkup" min="0" max="100" step="0.1" value="' + esc(st.default_markup_percent) + '"><div class="fn-help">Store owed = price ÷ (1 + mark-up). 9 % → R137 plate owes the store ≈ R125.69. Lines using this are marked ≈.</div></div>' +
      '<div class="fn-field"><label class="fn-check"><input type="checkbox" id="fnRiderCost"' + (st.count_rider_pay_as_cost ? ' checked' : '') + '> External riders — take rider pay off profit</label><div class="fn-help">On: every order paid <b>from the moment you save</b> has its rider pay taken off Umzila’s profit (riders paid per delivery). Off: from then on it isn’t (staff riders — record wages/fuel as expenses). Earlier orders never change.' + riderPeriods(st.rider_pay_cost_periods) + '</div></div>' +
      '<div class="fn-field"><label for="fnSellerCodes">Store promo codes are paid by</label><select id="fnSellerCodes"><option value="seller"' + (st.seller_codes_funded_by !== 'umzila' ? ' selected' : '') + '>The store (comes off what it is owed)</option><option value="umzila"' + (st.seller_codes_funded_by === 'umzila' ? ' selected' : '') + '>Umzila</option></select></div>' +
      '<div class="fn-field"><label for="fnManualDisc">Discounts typed in by hand on logistics orders are paid by</label><select id="fnManualDisc"><option value="umzila"' + (st.manual_discount_funded_by !== 'seller' ? ' selected' : '') + '>Umzila</option><option value="seller"' + (st.manual_discount_funded_by === 'seller' ? ' selected' : '') + '>The store</option></select></div>' +
      '<div class="fn-field"><label for="fnTips">Tips go to</label><select id="fnTips"><option value="umzila"' + (st.tips_go_to !== 'rider' ? ' selected' : '') + '>Umzila (riders are staff)</option><option value="rider"' + (st.tips_go_to === 'rider' ? ' selected' : '') + '>The rider (taken off Umzila’s figures)</option></select></div>' +
      '<div class="fn-field" style="grid-column:1/-1"><label>Umzila’s own stores</label><div class="fn-help">Tick stores Umzila owns (e.g. Lumina). Nothing is owed to them: their whole margin is Umzila’s, and their “store price” is the cost of the stock (estimated with the mark-up above until you type it in).</div><div style="display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px">' +
        (S.sellers || []).filter(function (x) { return !x.is_house && x.status !== 'disabled'; }).map(function (x) { return '<label class="fn-check"><input type="checkbox" data-own="' + esc(x.id) + '"' + (st.own_store_ids.indexOf(x.id) >= 0 ? ' checked' : '') + '> ' + esc(x.shop_name || 'Store') + '</label>'; }).join('') + '</div></div>' +
      '<div class="fn-field"><label>Umzila’s own codes, delivery and priority</label><div class="fn-sub">Spin, mystery gift and platform codes are Umzila’s cost. Delivery and priority fees are Umzila revenue.</div></div>' +
      '</div><div class="fn-actions"><button type="button" class="fn-btn primary" data-act="assump-save">Save</button></div>';

    h += '<h4>Payment fee rates <span class="fn-muted">(estimates — PayFast’s actual fee always wins)</span></h4>' + msg('fees') +
      '<div class="fn-tw"><table class="fn-table fn-feetable"><thead><tr><th>Method</th><th>%</th><th>Fixed R</th><th>Min R</th><th>+ VAT</th></tr></thead><tbody>' +
      Object.keys(st.fee_rates).map(function (k) {
        var r = st.fee_rates[k];
        return '<tr data-code="' + esc(k) + '"><td data-label="Method">' + esc(r.name) + ' <small class="fn-muted">' + esc(k) + '</small></td>' +
          '<td data-label="%"><input type="number" inputmode="decimal" step="0.01" min="0" max="20" data-f="pct" value="' + esc(r.pct) + '" aria-label="' + esc(r.name) + ' percent"></td>' +
          '<td data-label="Fixed R"><input type="number" inputmode="decimal" step="0.01" min="0" max="50" data-f="fixed" value="' + esc(r.fixed) + '" aria-label="' + esc(r.name) + ' fixed fee"></td>' +
          '<td data-label="Min R"><input type="number" inputmode="decimal" step="0.01" min="0" max="50" data-f="min" value="' + esc(r.min) + '" aria-label="' + esc(r.name) + ' minimum"></td>' +
          '<td data-label="+ VAT"><input type="checkbox" data-f="vat"' + (r.vat ? ' checked' : '') + ' aria-label="' + esc(r.name) + ' plus VAT"></td></tr>';
      }).join('') + '</tbody></table></div><div class="fn-help">Fee = max(minimum, amount × % + fixed) × (1 + VAT ' + esc(num(st.vat_percent) || 15) + ' %) when VAT is ticked. Cash and manual EFT are never charged a fee. Apple, Google and Samsung Pay are charged like cards.</div>' +
      '<div class="fn-actions"><button type="button" class="fn-btn primary" data-act="fees-save">Save fee rates</button><button type="button" class="fn-btn" data-act="fees-reset">Reset to PayFast defaults</button></div>';

    h += '<h4>Our own stock — cost of goods <span class="fn-muted">(Umzila Drinks + our own stores)</span></h4>' + msg('cogs');
    if (S.pricesErr) h += '<div class="fn-warn">' + esc(S.pricesErr) + '</div>';
    else if (!S.house) h += '<p class="fn-muted">Loading…</p>';
    else if (!S.house.length) h += '<p class="fn-muted">No house products found.</p>';
    else h += '<div class="fn-list">' + S.house.map(function (p) {
      var c = p.store_price;
      return '<div class="fn-item fn-price"><div class="fn-grow"><b>' + esc(p.name) + '</b><div class="fn-sub">' + esc(p.shop_name || '') + ' · sells at ' + money(p.sell_price) + (has(c) ? ' · Umzila keeps ' + money(num(p.sell_price) - num(c)) + ' a unit' : ' · <span class="fn-pill warn">cost missing</span>' + (p.own_store && has(p.estimated_store_price) ? ' ≈ ' + money(p.estimated_store_price) + ' used' : '')) + '</div></div>' +
        '<div class="fn-pin"><label class="fn-sr" for="fnCogs' + esc(p.product_id) + '">Cost</label><span>R</span><input type="number" inputmode="decimal" min="0" step="0.01" id="fnCogs' + esc(p.product_id) + '" data-cogs="' + esc(p.product_id) + '" data-was="' + (has(c) ? esc(num(c).toFixed(2)) : '') + '" value="' + (has(c) ? esc(num(c).toFixed(2)) : '') + '"></div></div>';
    }).join('') + '</div><div class="fn-actions"><button type="button" class="fn-btn primary" data-act="cogs-save">Save costs</button></div>';

    h += '<h4>Categories</h4>' + msg('cats') + '<div class="fn-grid">' +
      '<div class="fn-field"><label for="fnExpCats">Expense categories (one per line)</label><textarea id="fnExpCats" rows="6">' + esc(st.expense_categories.join('\n')) + '</textarea></div>' +
      '<div class="fn-field"><label for="fnIncCats">Income categories (one per line)</label><textarea id="fnIncCats" rows="6">' + esc(st.income_categories.join('\n')) + '</textarea></div>' +
      '</div><div class="fn-actions"><button type="button" class="fn-btn primary" data-act="cats-save">Save categories</button></div>';
    return h + '</details></div>';
  }

  // ---------- modal ----------
  function modal(html, onReady) {
    closeModal();
    var m = document.createElement('div'); m.id = 'fnModal'; m.className = 'fn-modal';
    m.innerHTML = '<div class="fn-sheet" role="dialog" aria-modal="true">' + html + '</div>';
    m.addEventListener('click', function (e) { if (e.target === m) closeModal(); });
    document.body.appendChild(m);
    if (onReady) onReady(m);
    return m;
  }
  function closeModal() { var m = $('fnModal'); if (m) m.remove(); }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('fnModal')) closeModal(); });
  function formErr(m, t) { var e = m.querySelector('.fn-ferr'); if (e) { e.textContent = t; e.style.display = t ? 'block' : 'none'; } }

  // ---------- order drawer ----------
  function rateText(code) { var r = S.settings.fee_rates[code] || S.settings.fee_rates.unknown; if (!r) return 'rate from Assumptions'; return r.pct + ' %' + (r.fixed ? ' + R' + r.fixed : '') + (r.min ? ' (min R' + r.min + ')' : '') + (r.vat ? ' + VAT' : ''); }
  function src(t) { return '<small class="fn-src">' + esc(t) + '</small>'; }
  function adjOf(r, type) { return r.adj.filter(function (a) { return (a.type || a.adjustment_type) === type; })[0]; }
  function ovNote(r, type) { var a = adjOf(r, type); return a ? 'override' + (a.by || a.by_name ? ' by ' + (a.by_name || a.by) : '') + (a.at || a.created_at ? ', ' + fmtWhen(a.at || a.created_at) : '') + (a.note || a.description ? ' — ' + (a.note || a.description) : '') : ''; }
  function dRow(label, val, source) { return '<div class="fn-dr"><div><span>' + esc(label) + '</span>' + (source ? src(source) : '') + '</div><b>' + val + '</b></div>'; }
  function openOrder(id) {
    var l = (S.lines || []).filter(function (x) { return String(x.order_id) === String(id); })[0]; if (!l) return;
    var r = L(l), p = o(l.payment), g = r.goods, d = r.delivery, u = r.umzObj;
    var h = '<div class="fn-sh"><h3>' + esc(r.num) + '</h3><button type="button" class="fn-x" id="fnClose" aria-label="Close">×</button></div>' +
      '<p class="fn-sub">' + esc(r.customer) + ' · ' + esc(fmtWhen(r.when)) + ' · ' + esc(r.source === 'manual' ? 'entered in logistics' : r.source === 'zero' ? 'R0 order' : 'PayFast') + (r.excluded ? ' · <span class="fn-pill warn">test — not counted</span>' : '') + '</p>' +
      (r.testCandidate && !r.excluded ? '<p class="fn-help">This looks like a test (test email or test item). Mark it as test only if it wasn’t a real sale.</p>' : '');
    if (r.flags.length) h += '<div class="fn-tags">' + r.flags.map(function (f) { return '<span class="fn-pill ' + (f === 'totals_mismatch' ? 'bad' : 'warn') + '">' + esc(FLAG[f] || f) + '</span>'; }).join('') + '</div>';
    h += '<h4>Payment</h4>' + dRow('Paid with', esc(r.method), adjOf(r, 'payment_method_set') ? ovNote(r, 'payment_method_set') : (p.method_code === 'unknown' ? 'paid before the payment picker — set it if you know it' : '')) +
      dRow('Customer paid', money(r.gross), r.source === 'payfast' ? 'PayFast amount_gross' : 'order total') +
      dRow('Payment fee', moneyE(r.fee, r.feeEst), p.fee_override ? ovNote(r, 'payment_fee_override') + (has(p.fee_estimate) ? ' (rate estimate was ' + money(p.fee_estimate) + ')' : '') : r.feeEst ? 'estimate: ' + rateText(p.method_code) : p.fee_actual ? 'PayFast ITN (actual)' : 'no fee (' + r.method + ')');
    h += '<h4>Goods</h4>' + dRow('Goods at list price', money(g.list_value)) +
      (num(g.discount) ? dRow('Discount', '− ' + money(g.discount), g.discount_funder === 'seller' ? 'store promo — comes off the store’s share' : 'Umzila code — Umzila’s cost') : '') +
      r.stores.map(function (s) {
        if (s.is_house) return dRow((s.shop_name || 'Umzila Drinks') + ' (ours)', money(pick(s, 'goods_after_discount', 'goods_list')), 'cost of goods ' + money(s.cogs) + (s.cogs_missing ? ' — some costs not typed in (≈ estimated), set them in Assumptions' : '') + (adjOf(r, 'cogs_override') ? ' · ' + ovNote(r, 'cogs_override') : ''));
        var est = !!s.owed_est;
        return dRow(s.shop_name || 'Store', money(pick(s, 'goods_after_discount', 'goods_list')), (num(s.seller_discount) ? 'store promo ' + money(s.seller_discount) + ' · ' : '') + 'Umzila earns ' + moneyE(s.commission, est)) +
          dRow('Owed to ' + (s.shop_name || 'store'), moneyE(s.owed, est), s.payout_override ? ovNote(r, 'seller_payout_override') : est ? 'estimate: no store price set — default ' + S.settings.default_markup_percent + ' % mark-up' : 'store price per product');
      }).join('');
    if (d.has_delivery || num(d.fee_customer) || num(d.priority)) {
      h += '<h4>Delivery</h4>' + dRow('Delivery fee', money(d.fee_customer), d.free_delivery ? 'free delivery for the customer' : '') + (num(d.priority) ? dRow('Priority', money(d.priority)) : '') +
        dRow('Rider pay', moneyE(d.rider_pay, d.rider_pay_est), (d.rider_pay_override ? ovNote(r, 'rider_pay_override') : d.rider_pay_est ? 'estimate from distance — route not completed' : num(d.rider_pay) ? 'driver_payouts (completed route)' : 'no rider pay') + (num(d.rider_pay) && !d.rider_pay_counted ? ' · not counted as a cost (riders are staff)' : '') + (d.status === 'CANCELLED' ? ' · delivery cancelled' : ''));
    }
    if (r.tips) h += dRow('Tip', money(r.tips), num(l.tips_to_rider) ? 'passed to the rider' : 'Umzila revenue');
    if (r.refund) h += dRow('Refunded', '− ' + money(r.refund), ovNote(r, 'refund').replace(/^override/, 'recorded'));
    h += '<h4>Umzila</h4>' + dRow('Customer paid', money(r.gross)) + dRow('Owed to stores', '− ' + moneyE(u.owed_to_stores, r.storeEst)) +
      (num(u.fees_paid) ? dRow('Payment fee', '− ' + moneyE(u.fees_paid, r.feeEst)) : '') + (num(u.house_cogs) ? dRow('Own stock cost', '− ' + money(u.house_cogs)) : '') +
      (num(u.refunds) ? dRow('Refund', '− ' + money(u.refunds)) : '') + (num(u.rider_cost) ? dRow('Rider pay', '− ' + money(u.rider_cost)) : '') + (num(u.tips_to_rider) ? dRow('Tip to rider', '− ' + money(u.tips_to_rider)) : '') +
      dRow('Umzila net on this order', '<span class="' + (r.umz < 0 ? 'fn-neg' : 'fn-pos') + '">' + money(r.umz) + '</span>',
        'mark-up ' + money(u.commission) + ' · delivery & priority ' + money(u.delivery_income) + (num(u.house_margin) ? ' · own stores ' + money(u.house_margin) : '') + (num(u.discounts_funded) ? ' · Umzila codes −' + money(u.discounts_funded) : '') + (num(u.unexplained) ? ' · unexplained ' + money(u.unexplained) : ''));
    var adjAll = list(l.adjustments);
    if (adjAll.length) h += '<h4>Corrections &amp; notes</h4><div class="fn-list">' + adjAll.map(function (a) {
      var t = a.type || a.adjustment_type, v = !!a.voided_at;
      return '<div class="fn-item' + (v ? ' fn-dim' : '') + '"><div class="fn-item-top"><div class="fn-grow"><b>' + esc(ADJ[t] || t) + '</b>' + (has(a.value) || has(a.adjustment_value) ? ' · ' + money(pick(a, 'value', 'adjustment_value')) : '') + (a.text || a.adjustment_text ? ' · ' + esc(a.text || a.adjustment_text) : '') +
        '<div class="fn-sub">' + esc(a.note || a.description || '') + (a.by || a.by_name ? ' · ' + esc(a.by_name || a.by) : '') + (a.at || a.created_at ? ' · ' + esc(fmtWhen(a.at || a.created_at)) : '') + (v ? ' · removed' : '') + '</div></div>' +
        (v ? '' : '<button type="button" class="fn-btn sm danger-o" data-act="adj-void" data-id="' + esc(a.id) + '">Remove</button>') + '</div></div>';
    }).join('') + '</div>';
    h += '<div class="fn-actions">' +
      '<button type="button" class="fn-btn' + (r.excluded ? '' : ' danger-o') + '" data-act="d-test">' + (r.excluded ? 'Count this order again' : 'Mark as test') + '</button>' +
      (adjOf(r, 'refund') ? '' : '<button type="button" class="fn-btn" data-act="d-adj" data-t="refund">Record refund</button>') +
      '<button type="button" class="fn-btn" data-act="d-adj" data-t="override">Override a figure</button>' +
      '<button type="button" class="fn-btn" data-act="d-adj" data-t="note">Add note</button></div>';
    modal(h, function (m) {
      m.querySelector('#fnClose').onclick = closeModal;
      m.addEventListener('click', function (e) {
        var b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
        var a = b.dataset.act;
        if (a === 'd-test') { closeModal(); toggleTest(r.id, !r.excluded); }
        else if (a === 'd-adj') adjForm(r, b.dataset.t);
        else if (a === 'adj-void') voidEntry(b.dataset.id, 'correction');
      });
    });
  }
  function adjForm(r, kind) {
    var types = kind === 'override' ? [['payment_fee_override', 'Payment fee'], ['seller_payout_override', 'Owed to store'], ['rider_pay_override', 'Rider pay'], ['cogs_override', 'Own stock cost'], ['payment_method_set', 'Payment method']] : null;
    var sellers = r.stores.filter(function (s) { return !s.is_house; });
    var methods = Object.keys(S.settings.fee_rates).map(function (k) { return '<option value="' + esc(k) + '">' + esc(S.settings.fee_rates[k].name) + '</option>'; }).join('');
    var h = '<h3>' + (kind === 'refund' ? 'Record a refund' : kind === 'note' ? 'Add a note' : 'Override a figure') + ' · ' + esc(r.num) + '</h3>' +
      (types ? '<div class="fn-field"><label for="fnAT">What to override</label><select id="fnAT">' + types.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('') + '</select></div>' : '') +
      (types && sellers.length > 1 ? '<div class="fn-field" id="fnASw"><label for="fnAS">Store</label><select id="fnAS">' + sellers.map(function (s) { return '<option value="' + esc(s.seller_id) + '">' + esc(s.shop_name) + '</option>'; }).join('') + '</select></div>' : '') +
      (types ? '<div class="fn-field" id="fnAMw" style="display:none"><label for="fnAM">Payment method</label><select id="fnAM">' + methods + '</select></div>' : '') +
      (kind !== 'note' ? '<div class="fn-field" id="fnAVw"><label for="fnAV">' + (kind === 'refund' ? 'Amount refunded (R)' : 'Correct amount (R)') + '</label><input type="number" inputmode="decimal" min="0" step="0.01" id="fnAV"><div class="fn-help" id="fnAVh">' + (kind === 'refund' ? 'Comes off Umzila’s figures for this order.' : '') + '</div></div>' : '') +
      '<div class="fn-field"><label for="fnAN">Note</label><textarea id="fnAN" rows="3" maxlength="300" placeholder="' + (kind === 'refund' ? 'e.g. cancelled delivery, refunded on PayFast 12 Nov' : 'e.g. rider was not paid for this test') + '"></textarea></div>' +
      '<div class="fn-msg bad fn-ferr" style="display:none"></div><div class="fn-actions end"><button type="button" class="fn-btn" id="fnNo">Cancel</button><button type="button" class="fn-btn primary" id="fnYes">Save</button></div>';
    modal(h, function (m) {
      var sel = m.querySelector('#fnAT');
      function sync() {
        if (!sel) return; var t = sel.value;
        m.querySelector('#fnAMw').style.display = t === 'payment_method_set' ? '' : 'none';
        m.querySelector('#fnAVw').style.display = t === 'payment_method_set' ? 'none' : '';
        var sw = m.querySelector('#fnASw'); if (sw) sw.style.display = t === 'seller_payout_override' ? '' : 'none';
        var cur = { payment_fee_override: r.fee, rider_pay_override: r.rider, cogs_override: r.cogs, seller_payout_override: r.payout }[t];
        m.querySelector('#fnAVh').textContent = has(cur) ? 'Now ' + money(cur) + '. The original stays visible next to the override; remove the override to go back.' : '';
      }
      if (sel) { sel.addEventListener('change', sync); sync(); }
      m.querySelector('#fnNo').onclick = closeModal;
      m.querySelector('#fnYes').onclick = async function () {
        var btn = this, t = sel ? sel.value : kind, note = m.querySelector('#fnAN').value.trim();
        var vEl = m.querySelector('#fnAV'), val = vEl ? vEl.value.trim() : '';
        if (note.length < 3) return formErr(m, 'Add a short note so the next admin knows why.');
        var p = { kind: 'adjustment', category: ADJ[t] || t, adjustment_type: t, order_id: r.id, description: note, occurred_on: r.day || sastDate(), amount: 0 };
        if (t === 'payment_method_set') p.adjustment_text = m.querySelector('#fnAM').value;
        else if (t !== 'note') {
          if (!/^\d+(\.\d{1,2})?$/.test(val)) return formErr(m, 'Enter an amount in rand, e.g. 54.50 (0 is allowed).');
          var n = Number(val);
          if (t === 'refund' && !(n > 0)) return formErr(m, 'A refund must be more than R0.');
          if (t === 'refund' && n > r.gross + 0.001) return formErr(m, 'A refund can’t be more than the customer paid (' + money(r.gross) + ').');
          p.adjustment_value = n; p.amount = n;
        }
        if (t === 'seller_payout_override') { var ss = m.querySelector('#fnAS'); if (ss) p.seller_id = ss.value; } // one store: the server applies it to that store
        btn.disabled = true; btn.textContent = 'Saving…';
        try { await rpc('fin_entry_save', { p: p }); closeModal(); toast((ADJ[t] || 'Saved') + ' saved for ' + r.num + '.'); await reloadMoney(); }
        catch (e) { btn.disabled = false; btn.textContent = 'Save'; formErr(m, friendly(e)); }
      };
    });
  }
  async function toggleTest(id, on, box) {
    var l = (S.lines || []).filter(function (x) { return String(x.order_id) === String(id); })[0]; if (!l) return;
    var r = L(l);
    if (box) box.disabled = true;
    try {
      await rpc('fin_set_excluded', { p_order_id: id, p_excluded: !!on, p_note: on ? 'marked as test in Finances' : 'counted again in Finances' });
      toast(on ? r.num + ' marked as a test — it no longer counts.' + (S.includeTests ? '' : ' Tick “Include test orders” to see it again.') : r.num + ' counts again.');
      await reloadMoney();
    } catch (e) { if (box) { box.disabled = false; box.checked = !on; } toast(friendly(e)); }
  }

  // ---------- entries ----------
  function catOptions(kind, cur) {
    var cats = (kind === 'income' ? S.settings.income_categories : S.settings.expense_categories).slice();
    if (cur && cats.indexOf(cur) < 0) cats.push(cur);
    return cats.map(function (c) { return '<option' + (c === cur ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
  }
  function entryForm(e, kind, rec) {
    e = e || {}; kind = e.kind || kind; rec = e.recurring || rec || 'none';
    var stores = (S.sellers || []).filter(function (s) { return !s.is_house; });
    var h = '<h3>' + (e.id ? 'Edit ' : 'Add ') + (kind === 'income' ? 'income' : rec === 'monthly' ? 'monthly cost' : 'expense') + '</h3>' +
      '<div class="fn-field"><label for="fnEC">Category</label><select id="fnEC">' + catOptions(kind, e.category) + '</select></div>' +
      '<div class="fn-field" id="fnEOw" style="display:none"><label for="fnEO">Other — what is it?</label><input type="text" id="fnEO" maxlength="40"></div>' +
      '<div class="fn-field"><label for="fnED">Description</label><input type="text" id="fnED" maxlength="200" value="' + esc(e.description || '') + '" placeholder="' + (kind === 'income' ? 'e.g. Enspire Battle of Campuses — 3rd place' : 'e.g. Fuel for rider bikes') + '"></div>' +
      '<div class="fn-field"><label for="fnEA">Amount (R)</label><input type="number" inputmode="decimal" min="0.01" step="0.01" id="fnEA" value="' + (has(e.amount) ? esc(num(e.amount).toFixed(2)) : '') + '"></div>' +
      '<div class="fn-field"><label for="fnEW">' + (rec === 'monthly' ? 'First month (date)' : 'Date') + '</label><input type="date" id="fnEW" value="' + esc(e.occurred_on || sastDate()) + '"></div>' +
      (kind === 'expense' ? '<label class="fn-check"><input type="checkbox" id="fnER"' + (rec === 'monthly' ? ' checked' : '') + '> Repeats every month</label>' +
        '<div class="fn-field" id="fnEUw"' + (rec === 'monthly' ? '' : ' style="display:none"') + '><label for="fnEU">Until (leave empty if still running)</label><input type="date" id="fnEU" value="' + esc(e.recur_until || '') + '"></div>' +
        '<div class="fn-field" id="fnESw"><label for="fnES">Store (optional — e.g. a PayFast payout fee)</label><select id="fnES"><option value="">None</option>' + stores.map(function (s) { return '<option value="' + esc(s.id) + '"' + (String(e.seller_id || '') === String(s.id) ? ' selected' : '') + '>' + esc(s.shop_name) + '</option>'; }).join('') + '</select></div>' : '') +
      '<div class="fn-msg bad fn-ferr" style="display:none"></div><div class="fn-actions end"><button type="button" class="fn-btn" id="fnNo">Cancel</button><button type="button" class="fn-btn primary" id="fnYes">Save</button></div>';
    modal(h, function (m) {
      var cat = m.querySelector('#fnEC'), rc = m.querySelector('#fnER');
      function sync() { m.querySelector('#fnEOw').style.display = cat.value === 'Other' ? '' : 'none'; if (rc) m.querySelector('#fnEUw').style.display = rc.checked ? '' : 'none'; }
      cat.addEventListener('change', sync); if (rc) rc.addEventListener('change', sync); sync();
      m.querySelector('#fnNo').onclick = closeModal;
      m.querySelector('#fnYes').onclick = async function () {
        var btn = this, c = cat.value, other = m.querySelector('#fnEO').value.trim();
        var desc = m.querySelector('#fnED').value.trim(), amt = m.querySelector('#fnEA').value.trim(), when = m.querySelector('#fnEW').value;
        var monthly = rc && rc.checked, until = monthly ? m.querySelector('#fnEU').value : '';
        if (c === 'Other' && !desc && !other) return formErr(m, 'Say what this is (in “Other” or the description).');
        if (!/^\d+(\.\d{1,2})?$/.test(amt) || !(Number(amt) > 0)) return formErr(m, 'Enter an amount more than R0, e.g. 350 or 30000.');
        if (Number(amt) > 10000000) return formErr(m, 'That amount looks too big — check it.');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(when)) return formErr(m, 'Choose the date.');
        if (until && until < when) return formErr(m, '“Until” must be on or after the first month.');
        var p = { kind: kind, category: c, description: c === 'Other' && other ? (other + (desc ? ' — ' + desc : '')) : desc, amount: Number(amt), occurred_on: when, recurring: monthly ? 'monthly' : 'none', recur_until: until || null };
        if (e.id) p.id = e.id;
        var sEl = m.querySelector('#fnES'); if (sEl) p.seller_id = sEl.value || null;
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
          await rpc('fin_entry_save', { p: p }); closeModal();
          var out = when < S.range.from || when > S.range.to;
          setMsg('entries', (kind === 'income' ? 'Income' : 'Expense') + ' saved.' + (out && !monthly ? ' It is dated ' + fmtD(when) + ', outside the period shown.' : ''), true);
          await reloadMoney();
        } catch (er) { btn.disabled = false; btn.textContent = 'Save'; formErr(m, friendly(er)); }
      };
    });
  }
  function voidEntry(id, what) {
    modal('<h3>Remove this ' + (what || 'entry') + '?</h3><p>It stays on record (greyed, under “Show removed”) but stops counting.</p><div class="fn-field"><label for="fnVR">Reason</label><input type="text" id="fnVR" maxlength="200" placeholder="e.g. entered twice"></div><div class="fn-msg bad fn-ferr" style="display:none"></div><div class="fn-actions end"><button type="button" class="fn-btn" id="fnNo">Cancel</button><button type="button" class="fn-btn danger" id="fnYes">Remove</button></div>', function (m) {
      m.querySelector('#fnNo').onclick = closeModal;
      m.querySelector('#fnYes').onclick = async function () {
        var btn = this, reason = m.querySelector('#fnVR').value.trim();
        if (reason.length < 3) return formErr(m, 'Add a short reason.');
        btn.disabled = true; btn.textContent = 'Removing…';
        try { await rpc('fin_entry_void', { p_id: id, p_reason: reason }); closeModal(); setMsg('entries', 'Removed.', true); await reloadMoney(); }
        catch (e) { btn.disabled = false; btn.textContent = 'Remove'; formErr(m, friendly(e)); }
      };
    });
  }

  // ---------- assumptions / prices saves ----------
  async function saveAssump() {
    var mk = $('fnMarkup').value.trim(); if (!/^\d+(\.\d+)?$/.test(mk)) { setMsg('assump', 'Enter the mark-up as a number, e.g. 9.', false); return render(); }
    var rider = $('fnRiderCost').checked, sc = $('fnSellerCodes').value, md = $('fnManualDisc').value, tp = $('fnTips').value;
    var own = Array.prototype.map.call(document.querySelectorAll('#fnAssump [data-own]:checked'), function (i) { return i.dataset.own; });
    var res = await saveWith(function (v) { v.own_store_ids = own; v.default_markup_percent = Number(mk); v.count_rider_pay_as_cost = rider; v.seller_codes_funded_by = sc; v.manual_discount_funded_by = md; v.tips_go_to = tp; });
    setMsg('assump', res.ok ? 'Saved. Figures updated.' : res.error, res.ok); S.openAssump = true;
    if (res.ok) { await Promise.all([reloadMoney(), loadPrices()]); render(); } else render();
  }
  async function saveFees(reset) {
    var rates = {};
    if (reset) rates = Object.assign({}, clone(S.settings.fee_rates), clone(S.feeDefaults || FEE_DEFAULTS));
    else {
      var bad = null;
      document.querySelectorAll('#fnAssump .fn-feetable tr[data-code]').forEach(function (tr) {
        var k = tr.dataset.code, g = function (f) { return tr.querySelector('[data-f="' + f + '"]'); };
        var vals = ['pct', 'fixed', 'min'].map(function (f) { var s = g(f).value.trim(); if (s === '') return 0; if (!/^\d+(\.\d+)?$/.test(s)) bad = 'Fee rates must be numbers (no negatives).'; return Number(s); });
        rates[k] = { name: S.settings.fee_rates[k].name, pct: vals[0], fixed: vals[1], min: vals[2], vat: g('vat').checked };
      });
      if (bad) { setMsg('fees', bad, false); S.openAssump = true; return render(); }
    }
    if (reset && !(await confirmBox('Reset fee rates?', 'Card, Apple/Google/Samsung Pay: 3.2 % + R2 · Capitec Pay and Instant EFT: 2 % (min R2) · all + VAT.', 'Reset'))) return;
    var res = await saveWith(function (v) { v.fee_rates = rates; });
    setMsg('fees', res.ok ? 'Fee rates saved. Estimated fees updated.' : res.error, res.ok); S.openAssump = true;
    if (res.ok) await reloadMoney(); else render();
  }
  async function saveCogs() {
    var map = {}, bad = null;
    document.querySelectorAll('#fnAssump [data-cogs]').forEach(function (i) {
      var s = i.value.trim(); if (s === '') return;
      if (!/^\d+(\.\d{1,2})?$/.test(s)) bad = 'Costs must be amounts in rand, e.g. 15 or 18.50.'; else map[i.dataset.cogs] = Number(s);
    });
    if (bad) { setMsg('cogs', bad, false); S.openAssump = true; return render(); }
    var changed = [];
    document.querySelectorAll('#fnAssump [data-cogs]').forEach(function (i) { var now = i.value.trim(), was = i.dataset.was || ''; if ((now === '' ? '' : Number(now).toFixed(2)) !== was) changed.push(i.dataset.cogs); });
    if (!changed.length) { setMsg('cogs', 'Nothing changed.', true); S.openAssump = true; return render(); }
    var done = 0, err = null;
    for (var i = 0; i < changed.length && !err; i++) {
      try { await rpc('fin_store_price_set', { p_product_id: changed[i], p_variant_id: null, p_price: has(map[changed[i]]) ? map[changed[i]] : null }); done++; }
      catch (e) { err = friendly(e); }
    }
    setMsg('cogs', err ? 'Saved ' + done + ' of ' + changed.length + '. ' + err : 'Costs saved (' + done + ').', !err); S.openAssump = true;
    await Promise.all([loadPrices(), loadMoney()]); render();
  }
  async function saveCats() {
    function lines(id) { var seen = {}; return $(id).value.split('\n').map(function (s) { return s.trim(); }).filter(function (s) { if (!s || seen[s.toLowerCase()]) return false; seen[s.toLowerCase()] = 1; return true; }); }
    var ex = lines('fnExpCats'), inc = lines('fnIncCats');
    var res = await saveWith(function (v) { v.expense_categories = ex; v.income_categories = inc; });
    setMsg('cats', res.ok ? 'Categories saved.' : res.error, res.ok); S.openAssump = true; render();
  }
  async function savePrice(btn) {
    var pid = btn.dataset.pid, vid = btn.dataset.vid || null;
    var inp = btn.parentNode.querySelector('input'), s = inp.value.trim(), price = Number(inp.dataset.price);
    if (s !== '' && !/^\d+(\.\d{1,2})?$/.test(s)) { toast('Enter the store price in rand, e.g. 130 or 129.50.'); return; }
    var v = s === '' ? null : Number(s);
    if (v != null && price && v > price) { toast('The store price can’t be more than Umzila’s selling price (' + money(price) + ').'); return; }
    btn.disabled = true; btn.textContent = '…';
    try {
      var res = o(await rpc('fin_store_price_set', { p_product_id: pid, p_variant_id: vid, p_price: v }));
      setMsg('prices', v == null ? 'Store price cleared — the default mark-up is used.' : 'Saved: store owed ' + money(v) + ', Umzila earns ' + money(res.markup_amount) + ' per item' + (has(res.markup_pct) ? ' (' + num(res.markup_pct) + ' % mark-up)' : '') + '.' + (res.warning ? ' ⚠ ' + res.warning : ''), !res.warning);
      await Promise.all([loadPrices(), loadMoney()]); render();
    } catch (e) { btn.disabled = false; btn.textContent = 'Save'; toast(friendly(e)); }
  }
  function confirmBox(title, body, ok) {
    return new Promise(function (resolve) {
      modal('<h3>' + esc(title) + '</h3><p>' + esc(body) + '</p><div class="fn-actions end"><button type="button" class="fn-btn" id="fnNo">Cancel</button><button type="button" class="fn-btn primary" id="fnYes">' + esc(ok) + '</button></div>', function (m) {
        m.querySelector('#fnNo').onclick = function () { closeModal(); resolve(false); };
        m.querySelector('#fnYes').onclick = function () { closeModal(); resolve(true); };
      });
    });
  }

  // ---------- CSV (from the RPC rows; formula-injection safe) ----------
  function csvCell(v) {
    if (typeof v === 'number') return isFinite(v) ? String(Math.round(v * 100) / 100) : '';
    var s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r|%]/.test(s)) s = "'" + s; // a text cell that a spreadsheet would run as a formula
    return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function download(name, rows) {
    var csv = '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function n2(v) { return has(v) ? num(v) : ''; }
  function yn(b) { return b ? 'yes' : ''; }
  function exportCsv() {
    if (!S.lines) return;
    var rg = S.range;
    var rows = [['Order', 'When (SAST)', 'Day', 'Customer', 'Source', 'Test (excluded)', 'Paid with', 'Method code', 'Customer paid (R)', 'Fee (R)', 'Fee estimated', 'Goods list (R)', 'Discount (R)', 'Discount paid by', 'Stores', 'Owed to stores (R)', 'Owed estimated', 'Umzila mark-up (R)', 'Delivery fee (R)', 'Priority (R)', 'Tips (R)', 'Rider pay (R)', 'Rider pay estimated', 'Own stock cost (R)', 'Refund (R)', 'Umzila net (R)', 'Flags', 'Corrections']];
    S.lines.map(L).forEach(function (r) {
      var u = r.umzObj, g = r.goods, d = r.delivery;
      rows.push([r.num, fmtWhen(r.when), r.day || '', r.customer, r.source || '', yn(r.excluded), r.method, r.methodCode || '', n2(r.gross), n2(r.fee), yn(r.feeEst), n2(g.list_value), n2(g.discount), g.discount_funder || '', r.storeNames, n2(r.payout), yn(r.storeEst), n2(u.commission), n2(d.fee_customer), n2(d.priority), n2(r.tips), n2(r.rider), yn(r.riderEst), n2(r.cogs), n2(r.refund), n2(r.umz),
        r.flags.map(function (f) { return FLAG[f] || f; }).join('; '), r.adj.map(function (a) { var t = a.type || a.adjustment_type; return (ADJ[t] || t) + (has(pick(a, 'value', 'adjustment_value')) ? ' ' + num(pick(a, 'value', 'adjustment_value')).toFixed(2) : '') + (a.note || a.description ? ' (' + (a.note || a.description) + ')' : ''); }).join('; ')]);
    });
    download('umzila-finances-' + rg.from + '-' + rg.to + '.csv', rows);
    if (S.entries && S.entries.length) {
      var er = [['Kind', 'Category', 'Description', 'Amount (R)', 'Date', 'Repeats', 'Until', 'Store', 'Order', 'Removed', 'Removed reason']];
      S.entries.forEach(function (e) { er.push([e.kind, e.category, e.description || '', n2(e.amount), e.occurred_on || '', e.recurring === 'monthly' ? 'monthly' : '', e.recur_until || '', e.shop_name || '', e.order_number || '', e.voided_at ? fmtWhen(e.voided_at) : '', e.void_reason || '']); });
      setTimeout(function () { download('umzila-finance-entries-' + rg.from + '-' + rg.to + '.csv', er); }, 400);
    }
    if (S.summary) {
      var pr = [['Line', 'Amount (R)', 'Estimated']];
      plRows().forEach(function (r) { pr.push([r.label, r.info || r.total ? num(r.amount) : (r.sign || 1) * num(r.amount), yn(r.est)]); });
      setTimeout(function () { download('umzila-pnl-' + rg.from + '-' + rg.to + '.csv', pr); }, 800);
    }
  }

  // ---------- events ----------
  function wire() {
    var root = $('section-finances'); if (!root || root.dataset.wired) return; root.dataset.wired = '1';
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b || b.disabled || b.type === 'checkbox' || b.tagName === 'DETAILS') return;
      if (b.tagName === 'A') e.preventDefault();
      var a = b.dataset.act;
      var run = function (p) { Promise.resolve(p).catch(function (err) { toast(friendly(err)); }); };
      if (a === 'preset') {
        S.preset = b.dataset.p;
        if (S.preset === 'custom') { render(); return; }
        S.range = presetRange(S.preset); S.shown = PAGE; delete S.msgs.range; run(reloadMoney());
      } else if (a === 'range') {
        var f = $('fnFrom').value, t = $('fnTo').value;
        if (!f || !t) { setMsg('range', 'Choose both dates.', false); return render(); }
        if (f > t) { setMsg('range', '“From” must be on or before “To”.', false); return render(); }
        if ((Date.parse(t) - Date.parse(f)) / 864e5 > 731) { setMsg('range', 'Choose a period of two years or less.', false); return render(); }
        delete S.msgs.range; S.range = { from: f, to: t }; S.shown = PAGE; run(reloadMoney());
      }
      else if (a === 'reload') run(loadAll());
      else if (a === 'csv') exportCsv();
      else if (a === 'gran') { S.gran = b.dataset.g; render(); }
      else if (a === 'filter') { S.filter = b.dataset.f || null; S.shown = PAGE; render(); if (S.filter) { var oc = $('fnOrders'); if (oc) oc.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }
      else if (a === 'more') { S.shown += PAGE; render(); }
      else if (a === 'order') { if (e.target.closest('.fn-switch')) return; openOrder(b.dataset.id); }
      else if (a === 'entry-new') entryForm(null, b.dataset.kind, b.dataset.rec);
      else if (a === 'entry-edit') { var en = (S.entries || []).filter(function (x) { return String(x.id) === b.dataset.id; })[0]; if (en) entryForm(en); }
      else if (a === 'void') voidEntry(b.dataset.id, 'entry');
      else if (a === 'goto') { var li = document.querySelector('.menu li[data-section="' + b.dataset.s + '"]'); if (li) li.click(); }
      else if (a === 'assump-save') run(saveAssump());
      else if (a === 'fees-save') run(saveFees(false));
      else if (a === 'fees-reset') run(saveFees(true));
      else if (a === 'cogs-save') run(saveCogs());
      else if (a === 'cats-save') run(saveCats());
      else if (a === 'price-save') run(savePrice(b));
    });
    root.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-act]')) { e.preventDefault(); e.target.click(); }
    });
    root.addEventListener('change', function (e) {
      var t = e.target, a = t.dataset && t.dataset.act;
      if (a === 'tests') { S.includeTests = t.checked; S.shown = PAGE; if (!t.checked && S.filter === 'tests') S.filter = null; reloadMoney().catch(function (er) { toast(friendly(er)); }); }
      else if (a === 'voided') { S.showVoided = t.checked; loadEntries().then(render, function () { render(); }); }
      else if (a === 'prices-all') { S.pricesAll = t.checked; S.prices = null; render(); loadPrices().then(render, function () { render(); }); }
      else if (a === 'test') toggleTest(t.dataset.id, t.checked, t);
    });
    root.addEventListener('toggle', function (e) { if (e.target.dataset && e.target.dataset.act === 'assump') S.openAssump = e.target.open; }, true);
    var qT = null;
    root.addEventListener('input', function (e) {
      var t = e.target; if (t.id !== 'fnQ' && t.id !== 'fnPriceQ') return;
      clearTimeout(qT);
      qT = setTimeout(function () {
        if (t.id === 'fnQ') S.q = t.value; else S.priceQ = t.value;
        var id = t.id, pos = t.selectionStart; S.shown = PAGE; render();
        var n = $(id); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (er) { /* ignore */ } }
      }, 250);
    });
  }

  // ---------- dashboard cards + charts (A1) ----------
  async function loadDash() {
    var mount = $('finDashMount'); if (!mount || !sb()) return;
    var t = sastDate(), m = { from: t.slice(0, 8) + '01', to: t };
    var res = await Promise.all([settle(rpc('fin_summary', { p_from: m.from, p_to: m.to })), settle(rpc('fin_summary', { p_from: addDays(t, -29), p_to: t }))]);
    if (res[0].e) {
      mount.innerHTML = '<div class="fn-dash-err">💰 Money figures: ' + esc(friendly(res[0].e)) + '</div>';
    } else {
      var s = o(res[0].d), tt = o(s.totals), net = num(tt.net_profit);
      var card = function (label, val, sub, cls) { return '<a href="#" class="fn-dcard ' + (cls || '') + '" data-fin-open="1"><span>' + esc(label) + '</span><b>' + val + '</b><small>' + sub + '</small></a>'; };
      mount.innerHTML = '<div class="fn-dash-h"><span>💰 Money — this month</span><a href="#" data-fin-open="1">Finances →</a></div><div class="fn-dash">' +
        card('Order value (incl. delivery)', money(tt.gross), 'what customers paid') +
        card('Umzila gross profit', money(tt.umzila_gross_profit), 'after stores, fees, own stock cost', num(tt.umzila_gross_profit) >= 0 ? 'pos' : 'neg') +
        card('Net after costs', money(net), 'after expenses, plus other income', net >= 0 ? 'pos' : 'neg') +
        card('Paid orders', String(num(s.orders)), num(s.excluded_orders) ? esc(num(s.excluded_orders) + ' test hidden') : 'test orders excluded') + '</div>';
    }
    if (!res[1].e) drawDashCharts(list(o(res[1].d).by_day));
  }
  function drawDashCharts(days) {
    if (typeof Chart === 'undefined') return;
    var labels = days.map(function (r) { return String(r.day || '').slice(5); });
    var rc = $('chartRevenue'), oc = $('chartOrders');
    [rc, oc].forEach(function (c) { if (c) { try { var x = Chart.getChart(c); if (x) x.destroy(); } catch (e) { /* ignore */ } } });
    if (rc) new Chart(rc, { type: 'bar', data: { labels: labels, datasets: [
      { label: 'Order value', data: days.map(function (r) { return num(r.gross); }), backgroundColor: 'rgba(16,185,129,.35)' },
      { label: 'Umzila gross profit', data: days.map(function (r) { return num(r.umzila_gross_profit); }), backgroundColor: '#059669' }
    ] }, options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + money(c.parsed.y); } } } }, scales: { y: { beginAtZero: true } } } });
    if (oc) new Chart(oc, { type: 'bar', data: { labels: labels, datasets: [{ label: 'Paid orders', data: days.map(function (r) { return num(r.orders); }), backgroundColor: '#0ea5e9' }] }, options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } } });
  }
  window.loadFinanceDashboard = function () { loadDash().catch(function (e) { console.warn('[finances] dashboard', e); }); };
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-fin-open]'); if (!a) return;
    e.preventDefault();
    var li = document.querySelector('.menu li[data-section="finances"]'); if (li) li.click();
  });

  // ---------- CSS ----------
  function injectCss() {
    if ($('fnCss')) return;
    var R = '#section-finances ', M = '#fnModal ';
    var s = document.createElement('style'); s.id = 'fnCss';
    s.textContent = [
      '#section-finances{--fnb:#0a2f66}',
      R + '.fn-muted,' + M + '.fn-muted{color:#6b7280;font-size:13px}',
      R + '.fn-sub,' + M + '.fn-sub{font-size:12.5px;color:#6b7280;margin-top:3px}',
      R + '.fn-help,' + M + '.fn-help{font-size:12px;color:#6b7280;margin-top:6px;line-height:1.45}',
      R + '.fn-help a,' + R + '.fn-link,' + R + '.fn-net a{color:#1d4ed8;font-weight:700}',
      R + '.fn-range{position:sticky;top:0;z-index:20;background:#f8fafc;padding:8px 0 6px;margin-bottom:8px;border-bottom:1px solid #e5e7eb}',
      R + '.fn-chips{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px;-webkit-overflow-scrolling:touch}',
      R + '.fn-chip{flex:0 0 auto;border:1px solid #d1d5db;background:#fff;border-radius:999px;padding:8px 13px;font:inherit;font-size:13.5px;font-weight:700;color:#374151;cursor:pointer;min-height:38px}',
      R + '.fn-chip.on{background:var(--fnb);border-color:var(--fnb);color:#fff}',
      R + '.fn-rangeline{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px;font-size:14px}',
      R + '.fn-rangeline b{margin-right:auto}',
      R + '.fn-card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px;margin-bottom:14px;min-width:0}',
      R + '.fn-h{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}',
      R + '.fn-h h3,' + R + 'summary h3{margin:0;font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#374151}',
      R + 'h4,' + M + 'h4{margin:16px 0 6px;font-size:13px;font-weight:800;color:#374151}',
      R + '.fn-net{border-radius:12px;padding:14px;margin-bottom:10px;display:flex;flex-direction:column;gap:2px}',
      R + '.fn-net.pos{background:#ecfdf5;color:#065f46}' + R + '.fn-net.neg{background:#fef2f2;color:#991b1b}',
      R + '.fn-net span{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.05em}',
      R + '.fn-net b{font-size:30px;line-height:1.1}' + R + '.fn-net small{font-size:12.5px;color:#374151}',
      R + '.fn-wf{display:flex;flex-direction:column}',
      R + '.fn-wfr{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:9px 4px;border-bottom:1px solid #f1f5f9;font-size:14px}',
      R + '.fn-wfr[role=button]{cursor:pointer}' + R + '.fn-wfr[role=button]:hover{background:#f8fafc}',
      R + '.fn-wfr b{white-space:nowrap;font-variant-numeric:tabular-nums}',
      R + '.fn-wfl{display:flex;flex-direction:column;min-width:0}' + R + '.fn-wfl small{font-size:11.5px;color:#6b7280;margin-top:2px}',
      R + '.fn-wfr.tot{font-weight:800;border-top:2px solid #e5e7eb;background:#f8fafc}',
      R + '.fn-wfr.big{font-size:16px}' + R + '.fn-wfr.info{color:#6b7280;font-style:italic}',
      R + '.fn-ins{display:flex;flex-direction:column;gap:8px}',
      R + '.fn-in{border-radius:10px;padding:10px 12px;font-size:13.5px;line-height:1.4}',
      R + '.fn-in.info{background:#eff6ff;color:#1e3a8a}' + R + '.fn-in.warn{background:#fef3c7;color:#92400e}' + R + '.fn-in.good{background:#ecfdf5;color:#065f46}',
      R + '.fn-btn,' + M + '.fn-btn{border:1px solid #d1d5db;background:#fff;color:#111827;border-radius:10px;padding:9px 13px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;min-height:40px}',
      R + '.fn-btn.sm,' + M + '.fn-btn.sm{padding:6px 10px;font-size:13px;min-height:34px}',
      R + '.fn-btn.primary,' + M + '.fn-btn.primary{background:var(--fnb,#0a2f66);border-color:var(--fnb,#0a2f66);color:#fff}',
      M + '.fn-btn.primary{background:#0a2f66;border-color:#0a2f66}',
      R + '.fn-btn.danger,' + M + '.fn-btn.danger{background:#dc2626;border-color:#dc2626;color:#fff}',
      R + '.fn-btn.danger-o,' + M + '.fn-btn.danger-o{color:#b91c1c;border-color:#fca5a5}',
      R + '.fn-btn:disabled,' + M + '.fn-btn:disabled{opacity:.55;cursor:default}',
      R + '.fn-actions,' + M + '.fn-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}',
      M + '.fn-actions.end{justify-content:flex-end}',
      R + '.fn-pill,' + M + '.fn-pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;margin:2px 4px 0 0;font-style:normal}',
      R + '.fn-pill.warn,' + M + '.fn-pill.warn{background:#fef3c7;color:#92400e}' + R + '.fn-pill.info,' + M + '.fn-pill.info{background:#dbeafe;color:#1e40af}' + R + '.fn-pill.bad,' + M + '.fn-pill.bad{background:#fee2e2;color:#991b1b}',
      R + '.fn-tags,' + M + '.fn-tags{display:flex;flex-wrap:wrap;margin-top:3px}',
      R + '.fn-tw{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}',
      R + '.fn-table{width:100%;border-collapse:collapse;font-size:13.5px}',
      R + '.fn-table th,' + R + '.fn-table td{text-align:right;padding:8px 6px;border-bottom:1px solid #f1f5f9;vertical-align:top;font-variant-numeric:tabular-nums}',
      R + '.fn-table th:first-child,' + R + '.fn-table td:first-child{text-align:left}',
      R + '.fn-table td:nth-child(2){text-align:left}',
      R + '.fn-table th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;white-space:nowrap}',
      R + '.fn-table tr.fn-click{cursor:pointer}' + R + '.fn-table tr.fn-click:hover{background:#f8fafc}',
      R + '.fn-table input[type=number]{width:80px;padding:6px;border:1px solid #d1d5db;border-radius:6px;font:inherit;font-size:15px}',
      R + '.fn-dim{opacity:.55}' + M + '.fn-dim{opacity:.55}',
      R + '.fn-neg,' + M + '.fn-neg{color:#b91c1c}' + R + '.fn-pos,' + M + '.fn-pos{color:#047857}',
      R + '.fn-chart{position:relative;height:240px}',
      R + '.fn-details summary{cursor:pointer;font-weight:800;color:#374151;padding:6px 0;list-style-position:inside}',
      R + '.fn-kvs{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:4px 16px}',
      R + '.fn-kv{display:flex;justify-content:space-between;gap:8px;font-size:13.5px;padding:4px 0;border-bottom:1px dashed #f1f5f9}',
      R + '.fn-kv span{color:#6b7280}',
      R + '.fn-search{flex:1 1 200px;max-width:320px;padding:9px 10px;border:1px solid #d1d5db;border-radius:8px;font:inherit;font-size:16px;box-sizing:border-box;margin:4px 0}',
      R + '.fn-filter{background:#eff6ff;color:#1e3a8a;border-radius:8px;padding:6px 10px;font-size:13px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}',
      R + '.fn-list,' + M + '.fn-list{display:flex;flex-direction:column;gap:8px;margin-top:8px}',
      R + '.fn-item,' + M + '.fn-item{border:1px solid #e5e7eb;border-radius:12px;padding:10px 12px;background:#f9fafb;min-width:0;word-break:break-word}',
      R + '.fn-item-top,' + M + '.fn-item-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}',
      R + '.fn-grow,' + M + '.fn-grow{flex:1 1 auto;min-width:0}',
      R + '.fn-price{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      R + '.fn-pin{display:flex;gap:6px;align-items:center}',
      R + '.fn-pin input{width:96px;padding:8px;border:1px solid #d1d5db;border-radius:8px;font:inherit;font-size:16px}',
      R + '.fn-sr,' + M + '.fn-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}',
      R + '.fn-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:8px}',
      R + '.fn-form{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:8px}',
      R + '.fn-field,' + M + '.fn-field{display:flex;flex-direction:column;gap:4px;min-width:0;margin-bottom:10px}',
      R + '.fn-field label,' + M + '.fn-field label{font-size:12px;font-weight:700;color:#374151}',
      R + '.fn-field input,' + R + '.fn-field select,' + R + '.fn-field textarea,' + M + '.fn-field input,' + M + '.fn-field select,' + M + '.fn-field textarea{padding:10px;border:1px solid #d1d5db;border-radius:8px;font:inherit;font-size:16px;min-width:0;width:100%;box-sizing:border-box;background:#fff}',
      R + '.fn-check,' + M + '.fn-check{display:flex;gap:8px;align-items:center;font-size:14px;font-weight:700;margin:6px 0;color:#111827;cursor:pointer}',
      R + '.fn-check input,' + M + '.fn-check input{width:20px;height:20px;flex:0 0 auto}',
      R + '.fn-msg,' + M + '.fn-msg{font-size:13px;margin:8px 0;padding:8px 10px;border-radius:8px}',
      R + '.fn-msg.ok{background:#ecfdf5;color:#065f46}' + R + '.fn-msg.bad,' + M + '.fn-msg.bad{background:#fef2f2;color:#991b1b}',
      R + '.fn-warn{background:#fef3c7;color:#92400e;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:10px}',
      R + '.fn-switch{position:relative;display:inline-block;width:42px;height:24px}',
      R + '.fn-switch input{opacity:0;width:0;height:0;position:absolute}',
      R + '.fn-switch span{position:absolute;inset:0;background:#cbd5e1;border-radius:999px;transition:.15s;cursor:pointer}',
      R + '.fn-switch span:before{content:"";position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.15s}',
      R + '.fn-switch input:checked+span{background:#d97706}' + R + '.fn-switch input:checked+span:before{transform:translateX(18px)}',
      R + '.fn-switch input:focus-visible+span{outline:2px solid #2563eb;outline-offset:2px}',
      // phones: every table turns into stacked cards (real classes, no inline grids)
      '@media (max-width:600px){' +
        R + '.fn-table thead{display:none}' + R + '.fn-table,' + R + '.fn-table tbody,' + R + '.fn-table tfoot,' + R + '.fn-table tr,' + R + '.fn-table td{display:block;width:100%;box-sizing:border-box}' +
        R + '.fn-table tr{border:1px solid #e5e7eb;border-radius:12px;padding:8px 10px;margin-bottom:8px;background:#f9fafb}' +
        R + '.fn-table td{display:flex;justify-content:space-between;gap:10px;text-align:right!important;border:0;padding:4px 0}' +
        R + '.fn-table td:before{content:attr(data-label);color:#6b7280;font-size:12px;font-weight:700;text-align:left;flex:0 0 auto}' +
        R + '.fn-table td:first-child{font-weight:700}' +
        R + '.fn-net b{font-size:26px}' + R + '.fn-search{max-width:none}' + R + '.fn-rangeline b{flex:1 1 100%}' + R + '.fn-chart{height:200px}' +
      '}',
      // modal / bottom sheet
      '.fn-modal{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:12px}',
      '.fn-sheet{background:#fff;border-radius:16px;width:100%;max-width:560px;max-height:92vh;overflow:auto;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.3);box-sizing:border-box}',
      '.fn-sheet h3{margin:0 0 10px;font-size:17px}' + '.fn-sheet p{margin:0 0 10px;font-size:14px;line-height:1.45}',
      '.fn-sh{display:flex;justify-content:space-between;align-items:center;gap:10px}' + '.fn-sh h3{margin:0}',
      '.fn-x{border:0;background:#f3f4f6;border-radius:999px;width:36px;height:36px;font-size:20px;cursor:pointer}',
      M + '.fn-dr{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:14px}',
      M + '.fn-dr>div{display:flex;flex-direction:column;min-width:0}' + M + '.fn-dr b{white-space:nowrap;font-variant-numeric:tabular-nums}',
      M + '.fn-src{font-size:11.5px;color:#6b7280;margin-top:1px}',
      '@media (max-width:640px){.fn-modal{align-items:flex-end;padding:0}.fn-sheet{border-radius:16px 16px 0 0;max-width:none;padding-bottom:calc(18px + env(safe-area-inset-bottom))}}',
      // dashboard cards
      '#finDashMount{margin-bottom:14px}',
      '.fn-dash-h{display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:800;color:#374151;margin-bottom:8px}',
      '.fn-dash-h a{color:#1d4ed8;text-decoration:none}',
      '.fn-dash{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}',
      '.fn-dcard{display:flex;flex-direction:column;gap:3px;background:#fff;border:1px solid #e2e8f0;border-top:3px solid #10b981;border-radius:12px;padding:12px;text-decoration:none;color:#0f172a;min-width:0}',
      '.fn-dcard span{font-size:12px;font-weight:700;color:#64748b}' + '.fn-dcard b{font-size:20px;font-variant-numeric:tabular-nums}' + '.fn-dcard small{font-size:11.5px;color:#64748b}',
      '.fn-dcard.pos b{color:#047857}' + '.fn-dcard.neg b{color:#b91c1c}' + '.fn-dcard.neg{border-top-color:#dc2626}',
      '.fn-dash-err{background:#fef3c7;color:#92400e;border-radius:10px;padding:10px 12px;font-size:13px}',
      '@media (max-width:760px){.fn-dash{grid-template-columns:repeat(2,minmax(0,1fr))}.fn-dcard b{font-size:17px}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  window.loadFinancesAdmin = function () {
    injectCss(); wire();
    var p = loadAll(); if (p && p.catch) p.catch(function (e) { toast(friendly(e)); });
  };
  // Dev aid: window.__finSelfCheck() → list of P&L rows that don't reconcile (empty = fine).
  window.__finSelfCheck = function () { return S.summary ? selfCheck() : null; };

  // Dashboard money cards on first load: wait (briefly) for admin.html's supabaseClient + session.
  (function boot() {
    injectCss();
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      var c = sb();
      if (c && c.auth) {
        clearInterval(t);
        c.auth.getSession().then(function (r) { if (r && r.data && r.data.session) window.loadFinanceDashboard(); }, function () { });
      } else if (tries > 40) clearInterval(t);
    }, 500);
  })();
})();
