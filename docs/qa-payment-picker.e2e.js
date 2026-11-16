// QA for the payment picker (docs/systems/payment-picker.md, plan docs/plans/payment-picker-checkout-plan.md §8 D / §11).
//
// Three modes — nobody pays in any automated mode (requests to payfast.co.za are captured and aborted):
//   node docs/qa-payment-picker.e2e.js checklist            print the full manual checklist (sandbox + LIVE per-method steps)
//   B=<deploy preview url> node docs/qa-payment-picker.e2e.js probes            HTTP probes, no browser
//   B=<deploy preview url> node docs/qa-payment-picker.e2e.js browser [name …]  puppeteer-core scenarios (picker must be ON)
// Optional env: STORE=<store slug with an in-stock item> (default velaphishisanyama), ADDR=<in-zone address>,
//               CHROME=<path to chrome.exe>.
//
// READ BEFORE RUNNING
// * The deploy preview and production share ONE Supabase project. site_settings.payments.enabled is therefore global.
//   Run the picker-on QA on the preview BEFORE the picker code is merged to main (production code does not read the
//   switch yet, so turning it on cannot change the live checkout), and switch it OFF again before merging.
//   After the merge the switch is live for everyone — there is no "admins only" mode.
// * A sandbox COMPLETE on the preview writes a real paid order into the live database: the store sees it, a delivery
//   row is created and riders may be offered it. Use a cheap item from Umzila's own store, tell the team, and mark
//   the order refunded (Admin → Delivery → Delivery Times → Mark for refund, or logistics) right after the check.
// * The preview must have PAYFAST_SANDBOX=true and the sandbox merchant credentials for the deploy-preview context
//   (the signer defaults to sandbox when the variable is unset; production must have it set to false).
// * Every automated browser scenario leaves a pending_payment order behind (Logistics → Baskets lists them) — that is
//   normal, the same as a buyer who walks away.

const B = (process.env.B || '').replace(/\/$/, '');
const STORE = process.env.STORE || 'velaphishisanyama';
const ADDR = process.env.ADDR || 'Florida Road, Morningside, Durban';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const mail = tag => `umzila.qa+pp-${tag}-${RUN}@example.com`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Checklist: the brief's acceptance tests + plan §8 B/D, mapped to how to run each on the preview.
// ─────────────────────────────────────────────────────────────────────────────
const SQL_ATTEMPTS = "select option_key, payment_method_code, kind, status, pf_payment_id, amount_gross, amount_fee, started_at, ended_at from payment_attempts where m_payment_id = '<m>' order by started_at;";
const CHECKLIST = [
  { id: 'A1', rule: 'P1', test: 'Checkout shows the options in admin order above Pay (Card, Capitec Pay, Instant EFT, [wallets on their devices], More ways to pay).',
    how: 'Preview, picker ON. Open checkout with one item. Compare Step 4 with Admin → Payments → Payment options. Auto: browser rowsAndOrder.' },
  { id: 'A2', rule: 'P2', test: 'First-time customer: nothing selected; Pay shows "Choose how you want to pay", no redirect.',
    how: 'Fresh incognito window. Auto: browser nothingSelected (checks no begin-payment call and no PayFast request).' },
  { id: 'A3', rule: 'P6', test: 'Capitec Pay / Card / Instant EFT open PayFast directly on that method.',
    how: 'Auto: browser capitecRedirect / eftRedirect / cardNew prove payment_method=cp/ef/cc is in the signed form and the sandbox page loads WITHOUT "signature mismatch" (run once with CAPTURE=0 to let the redirect through). That a method really opens on its own screen can only be proved LIVE (L-section).' },
  { id: 'A4', rule: 'P6', test: 'More ways to pay opens PayFast\'s normal list (no payment_method field at all).',
    how: 'Auto: browser moreWays (field absent, not empty).' },
  { id: 'A5', rule: 'P5', test: 'A request with a made-up code / unknown option is refused.',
    how: 'Auto: probes beginUnknownOption + beginInjectedCode (409 OPTION_UNAVAILABLE; a "code" field in the body is ignored).' },
  { id: 'A6', rule: 'P5', test: 'Switching Instant EFT off removes it on the next load; a request for it is refused.',
    how: 'Admin → Payments → switch Instant EFT off → reload checkout (row gone). Auto: probes beginSwitchedOff (any option with active:false → 409). Then with checkout already open on EFT, switch it off and press Pay → "That way to pay is not available right now. Choose another." and the list reloads. Switch it back on.' },
  { id: 'A7', rule: 'P10', test: 'Cancel on PayFast → back on checkout with cart, delivery time and details unchanged + "Payment not completed. Try again or choose another way to pay."',
    how: 'Sandbox: choose Capitec Pay, Pay, press "Cancel" on the PayFast page. Auto: browser cancelReturn (follows the signed cancel_url).' },
  { id: 'A8', rule: 'P8 P11', test: 'Cancel, then pay with another option → ONE order, two attempts (cancelled, paid).',
    how: 'Sandbox: A7, then choose Card → Add a new card → complete with the sandbox wallet. SQL: ' + SQL_ATTEMPTS + " Also: select count(*) from orders where customer_email = '<email>' and created_at > now() - interval '1 hour'; → 1." },
  { id: 'A9', rule: 'P12', test: 'Opening the return page by hand does not mark the order paid.',
    how: 'Open /checkout-success.html?m_payment_id=<a pending m> by hand → "Still confirming…" after ~32 s; SQL: payment_status stays pending.' },
  { id: 'A10', rule: 'P13', test: 'Two successful payments for one order → confirmed once, flagged "paid twice".',
    how: 'Sandbox: choose an option and press Pay; before paying, duplicate the PayFast tab (same signed form, same m_payment_id). Pay in tab 1, then pay in tab 2. Admin → Payments → Flagged orders shows both payments. Unit coverage: Worker A\'s payment-picker.test.js.' },
  { id: 'A11', rule: 'Server', test: 'Same ITN twice changes nothing the second time.',
    how: 'Sandbox dashboard → resend the ITN, or replay the logged body to /.netlify/functions/payfast-itn. SQL: order paid_at unchanged, one confirmation email, attempts unchanged. Unit: A\'s test.' },
  { id: 'A12', rule: 'P14', test: 'A paid order shows the option used and PayFast\'s fee in admin.',
    how: 'Admin → Payments → Report → Paid orders: "paid with" + fee + net for the A8 order.' },
  { id: 'A13', rule: 'P2', test: 'After paying with Card, the same customer\'s next checkout has Card selected.',
    how: 'Signed-in: next checkout preselects Card (my_last_payment_option). Guest: same browser — localStorage umz_pay_option kept by the success page.' },
  { id: 'A14', rule: 'P15', test: 'Options list made to fail → one "Pay on PayFast" button and the payment still goes through.',
    how: 'Auto: browser settingsFail (blocks the site_settings read).' },
  { id: 'A15', rule: 'Admin', test: '"Payment picker on" OFF → checkout exactly as today.',
    how: 'Switch off. Run docs/qa-guest-checkout.e2e.js against the preview (all scenarios). The PayFast form must have no payment_method and no custom_str3 attempt id; cancel goes through checkout-cancel.html only for old orders.' },
  { id: 'A16', rule: 'P4', test: 'A service or booking payment shows the same picker.',
    how: 'Nceks booking / voucher through /ncekeniquads/ → checkout Step 4 shows the options; voucher at R0 shows "Complete order" instead (P17).' },
  { id: 'A17', rule: 'P17', test: 'R0 order: no picker, PayFast not used.',
    how: 'Apply a gift voucher covering the cart → no options card, button "Complete order".' },
  { id: 'A18', rule: 'P18', test: 'Retry after a delivery cut-off: the timeslot rules decide.',
    how: 'Timeslots on: start a payment for a run 2 min before its cut-off, cancel on PayFast after the cut-off, press Pay → TIMESLOT_CLOSED message, next run selected, Pay again.' },
  { id: 'A19', rule: 'edge', test: 'Two quick taps → one attempt, one redirect.',
    how: 'Auto: browser doubleTap.' },
  { id: 'A20', rule: 'edge', test: 'Customer closes PayFast without paying → attempt becomes no_answer after 30 min; cart still there.',
    how: 'Pay, close the tab. After no_answer_minutes + 1 min: SQL ' + SQL_ATTEMPTS + ' → no_answer.' },
  { id: 'A21', rule: 'edge', test: 'Late success after "no answer" still confirms the order.',
    how: 'Set Admin → Payments → no-answer minutes 10; start a sandbox payment, wait 11 min on the PayFast page, then pay → order paid, attempt paid.' },
  { id: 'A22', rule: 'edge', test: 'Returning customer whose last option is now switched off → nothing selected.',
    how: 'After A13, switch Card off → next checkout has nothing selected. Switch it back on.' },
  { id: 'A23', rule: '§6.6', test: 'Device rules: iPhone Safari shows Apple Pay, Android Chrome shows Google Pay, Samsung Internet shows Google + Samsung Pay (if on), desktop shows none.',
    how: 'Real phones on the preview (headless Chrome has no ApplePaySession). Auto (partial): browser deviceRows (Android UA / desktop).' },
  { id: 'A24', rule: '§6.7', test: 'Saved card via Card → one tap, no PayFast page; attempt kind saved_card, paid; orders.payment_method_code = token.',
    how: 'Signed-in account with a sandbox-saved card. SQL as above.' },
  { id: 'D1', rule: 'plan §8 D', test: 'Success page shows "Paid R… with <option>" for a picker-paid order, clears sessionStorage umz_pending_order, keeps localStorage umz_pay_option.',
    how: 'After A8 (paid), DevTools → Application: umz_pending_order gone, umz_pay_option present. The line is hidden for orders paid with the picker off.' },
  { id: 'D2', rule: 'plan §8 D', test: 'Success page with an unpaid order removes umz_pay_option (when it belongs to that order).',
    how: 'A9 in a browser that has umz_pay_option → removed after polling gives up.' },
  { id: 'D3', rule: 'plan §4.7', test: 'checkout-cancel.html?m_payment_id=UMZILA-…&attempt=<uuid> → checkout.html?pf=cancel&…; seller enrolment cancel (no m_payment_id) still shows the message card.',
    how: 'Auto: browser cancelPage.' },
  { id: 'B1', rule: 'plan §8 B', test: 'Keyboard only through all four steps (arrow keys move the payment choice); 390 px and 1280 px layouts; Lighthouse accessibility ≥ 90.',
    how: 'Manual on the preview.' },
];

const LIVE = [
  'Only after the sandbox list above passes and the picker is merged OFF and two days of live orders went through the new checkout.',
  'There is no "admins only" mode: while the master switch is on, every customer sees the picker. So run the whole L-list in one quiet slot: switch the master on with only More ways to pay + the method under test on (add each method as it passes), and switch the master off again at the end if anything failed. Use an R5–R10 item for each.',
  'For each test: After it pays: check the order, then refund it in the PayFast dashboard (Transactions → the pf_payment_id → Refund, R2 ex VAT) and Mark for refund on the order.',
  'L1 Card, new card (save ON, nickname "QA"): PayFast opens on the card form only. Order paid; payment_methods has a new row; Report shows Card paid with its fee.',
  'L2 Card, saved card (the one from L1): one tap, no PayFast page; attempt kind saved_card, orders.payment_method_code = token.',
  'L3 Debit card through Card (cc). If PayFast refuses it: tell Ntando, then add an option "Debit card" with code dc in Admin (no code change) and repeat.',
  'L4 Capitec Pay (cp): PayFast opens straight on Capitec Pay (no list), approve in the Capitec app → order paid.',
  'L5 Instant EFT (ef): opens on the bank list for EFT only → order paid.',
  'L6 Apple Pay (ap) on an iPhone in Safari: row visible only there; PayFast opens on Apple Pay → paid.',
  'L7 Google Pay (gp) on Android Chrome: row visible; PayFast opens on Google Pay → paid. (L7b Samsung Pay on Samsung Internet only if the founder enabled it.)',
  'L8 More ways to pay: PayFast shows its full list; pay with any method → paid, attempt option_key more, payment_method_code null.',
  'L9 Cancel once on a live method and pay again with another → one order, two attempts.',
  'After all: Admin → Payments → Report for today shows every attempt with its status and each paid one with its PayFast fee. Then switch "Payment picker on" at a quiet time.',
];

function printChecklist() {
  console.log('PAYMENT PICKER QA — deploy preview + PayFast sandbox (see header of this file first)\n');
  for (const c of CHECKLIST) console.log(`[ ] ${c.id} (${c.rule}) ${c.test}\n      HOW: ${c.how}\n`);
  console.log('\nLIVE PER-METHOD TESTS (production, real money, refunded)\n');
  for (const l of LIVE) console.log('[ ] ' + l);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. HTTP probes (no browser, no payment). Needs B.
// ─────────────────────────────────────────────────────────────────────────────
async function clientConfig() {
  const r = await fetch(`${B}/.netlify/functions/get-client-config`);
  const c = await r.json();
  return { url: c.SUPABASE_URL || c.supabaseUrl, key: c.SUPABASE_ANON_KEY || c.supabaseAnonKey };
}
async function rest(cfg, path, init = {}) {
  const r = await fetch(`${cfg.url}/rest/v1/${path}`, { ...init, headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  let body = null; try { body = await r.json(); } catch (_) {}
  return { status: r.status, body };
}
async function begin(body) {
  const r = await fetch(`${B}/.netlify/functions/begin-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}
const fakeM = () => `UMZILA-${Date.now()}-qa${Math.random().toString(36).slice(2, 8)}`;
const payload = m => ({ m_payment_id: m, amount: '10.00', item_name: 'QA', return_url: `${B}/checkout-success.html`, cancel_url: `${B}/checkout.html?pf=cancel&m_payment_id=${m}`, notify_url: `${B}/.netlify/functions/payfast-itn`, email_address: mail('probe') });

async function probes() {
  const out = [];
  const check = (name, ok, info) => { out.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info ? JSON.stringify(info) : ''}`); };
  const cfg = await clientConfig();
  const st = await rest(cfg, 'site_settings?key=eq.payments&select=value');
  const settings = st.body && st.body[0] && st.body[0].value;
  check('settingsReadableAnon', st.status === 200 && !!settings, { status: st.status, enabled: settings && settings.enabled, options: settings && (settings.options || []).length });
  const enabled = !!(settings && settings.enabled);

  let r = await begin({ option_key: 'card' });
  check('beginBadRequest', r.status === 400, r);
  r = await begin({ m_payment_id: fakeM(), option_key: 'not_an_option', payload: payload('x') });
  check('beginUnknownOption', enabled ? r.status === 409 && r.body && r.body.code === 'OPTION_UNAVAILABLE' : r.status === 409 && r.body && r.body.code === 'PICKER_OFF', r);
  r = await begin({ m_payment_id: fakeM(), option_key: 'zz_made_up', code: 'cc', payment_method: 'cc', payload: { ...payload('x'), payment_method: 'cc' } });
  check('beginInjectedCode', r.status === 409, r);
  const off = settings && (settings.options || []).find(o => !o.active);
  if (enabled && off) {
    r = await begin({ m_payment_id: fakeM(), option_key: off.key, payload: payload('x') });
    check('beginSwitchedOff(' + off.key + ')', r.status === 409 && r.body && r.body.code === 'OPTION_UNAVAILABLE', r);
  } else console.log('SKIP  beginSwitchedOff (picker off or every option on — switch one off in Admin → Payments to test)');
  const on = settings && (settings.options || []).find(o => o.active);
  if (enabled && on) {
    r = await begin({ m_payment_id: fakeM(), option_key: on.key, payload: payload('x') });
    check('beginUnknownOrder', r.status === 404, r);
  }
  r = { status: (await fetch(`${B}/.netlify/functions/order-status?m=${fakeM()}`)).status };
  check('orderStatusUnknown404', r.status === 404, r);
  r = await rest(cfg, 'rpc/payment_attempt_cancelled', { method: 'POST', body: JSON.stringify({ p_attempt: '00000000-0000-4000-8000-000000000000', p_m_payment_id: fakeM() }) });
  check('cancelRpcNoMatchFalse', r.status === 200 && r.body === false, r);
  r = await rest(cfg, 'payment_attempts?select=id&limit=1');
  check('attemptsHiddenFromAnon', (r.status === 200 && Array.isArray(r.body) && r.body.length === 0) || r.status === 401 || r.status === 403, r);
  r = await rest(cfg, 'payment_attempts', { method: 'POST', body: JSON.stringify({ order_id: '00000000-0000-4000-8000-000000000000', m_payment_id: fakeM(), option_key: 'card', kind: 'redirect', amount: 1 }) });
  check('attemptsNoAnonInsert', r.status >= 400, r);
  r = await rest(cfg, 'rpc/my_last_payment_option', { method: 'POST', body: '{}' });
  check('lastOptionNotForAnon', r.status >= 400, r);
  for (const fn of ['admin_payment_flagged', 'admin_payment_report']) {
    r = await rest(cfg, 'rpc/' + fn, { method: 'POST', body: fn === 'admin_payment_report' ? JSON.stringify({ p_from: '2026-11-01', p_to: '2026-11-30' }) : '{}' });
    check(fn + 'NotForAnon', r.status >= 400, { status: r.status });
  }
  const failed = out.filter(o => !o.ok).length;
  console.log(`\n${out.length - failed}/${out.length} probes passed`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Browser scenarios (puppeteer-core, Chrome). Picker must be ON for everything except cancelPage.
//    Selectors follow plan §6.3/§6.6: #payOptions .pay-opt[data-key], #barError (or #paymentError), #payNowBtn(Mobile).
// ─────────────────────────────────────────────────────────────────────────────
async function newPage(b, { mobile = false, ua = null, blockSettings = false } = {}) {
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport(mobile ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1280, height: 900 });
  if (ua) await p.setUserAgent(ua);
  const log = { errors: [], payfast: [], begin: [], orders: 0, navs: [] };
  p.on('pageerror', e => log.errors.push('PAGEERR ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/favicon|status of 4/.test(m.text())) log.errors.push(m.text().slice(0, 160)); });
  p.on('framenavigated', f => { if (f === p.mainFrame()) log.navs.push(f.url()); });
  await p.setRequestInterception(true);
  p.on('request', r => {
    const u = r.url();
    if (/payfast\.co\.za/.test(u) && process.env.CAPTURE !== '0') {
      log.payfast.push({ url: u, fields: Object.fromEntries(new URLSearchParams(r.postData() || '')) });
      return r.abort();
    }
    if (blockSettings && /\/rest\/v1\/site_settings/.test(u) && /payments/.test(u)) return r.respond({ status: 503, contentType: 'application/json', body: '{"message":"forced by QA"}' });
    if (/\/rest\/v1\/orders/.test(u) && r.method() === 'POST') log.orders++;
    r.continue();
  });
  p.on('response', async res => {
    if (/begin-payment/.test(res.url()) && res.request().method() === 'POST') {
      let j = null; try { j = await res.json(); } catch (_) {}
      log.begin.push({ status: res.status(), kind: j && j.kind, code: j && j.code });
    }
  });
  return { p, ctx, log };
}

async function addFromStore(p, slug) {
  await p.goto(`${B}/${slug}`, { waitUntil: 'networkidle2' });
  await p.waitForSelector('[data-add]', { timeout: 20000 });
  await sleep(2200); await p.$eval('#spOverlay .sp-x', x => x.click()).catch(() => {});
  const id = await p.$eval('[data-add]', x => x.dataset.add);
  await p.click(`[data-add="${id}"]`); await sleep(900);
  await p.evaluate(() => {
    const d = document.querySelector('dialog.uq'); if (!d || !d.open) return;
    const inc = d.querySelector('[data-inc]'), chip = d.querySelector('[data-plate="0"]'), opt = d.querySelector('input[name="uqopt"]');
    if (inc) inc.click(); else if (chip) chip.click(); else if (opt && !opt.checked) opt.click();
    const add = d.querySelector('#uqAdd'); if (add && !add.disabled) add.click();
  });
  await sleep(800);
}

async function toCheckout(p, tag) {
  await addFromStore(p, STORE);
  await p.goto(`${B}/checkout.html`, { waitUntil: 'networkidle2' });
  await p.waitForSelector('#customerEmail', { visible: true, timeout: 30000 });
  const type = async (sel, v) => { await p.click(sel, { clickCount: 3 }); await p.type(sel, v, { delay: 5 }); };
  await type('#customerEmail', mail(tag)); await p.keyboard.press('Tab');
  await type('#firstName', 'Qa'); await type('#lastName', 'Picker'); await type('#phoneNumber', '0835551287');
  await p.keyboard.press('Tab'); await sleep(1500);
  const cont = await p.$('#continueToStep2Btn');
  if (cont && await cont.evaluate(x => !!x.offsetParent)) { await cont.click(); await sleep(1000); }
  if (await p.$eval('#shippingAddress', el => !!el.offsetParent).catch(() => false)) {
    await p.click('#shippingAddress'); await p.type('#shippingAddress', ADDR, { delay: 15 });
    if (await p.waitForSelector('.address-suggestion', { visible: true, timeout: 12000 }).then(() => true).catch(() => false)) { await p.click('.address-suggestion'); await sleep(2500); }
    if (await p.$eval('#addrConfirmYesBtn', el => !!el.offsetParent).catch(() => false)) { await p.click('#addrConfirmYesBtn'); await sleep(500); }
  }
  await p.waitForSelector('#payOptions .pay-opt', { timeout: 20000 }).catch(() => {});
  await sleep(1500);
}

const rows = p => p.$$eval('#payOptions .pay-opt', els => els.filter(e => e.offsetParent).map(e => ({ key: e.dataset.key, selected: e.getAttribute('aria-checked') === 'true', text: e.innerText.replace(/\s+/g, ' ').trim().slice(0, 60) })));
const choose = async (p, key) => { await p.$eval(`#payOptions .pay-opt[data-key="${key}"]`, e => { e.scrollIntoView({ block: 'center' }); e.click(); }); await sleep(600); };
const barText = p => p.evaluate(() => { const e = document.getElementById('barError') || document.getElementById('paymentError'); return e && e.offsetParent ? e.innerText.trim() : ''; });
async function pressPay(p, { mobile = false, taps = 1 } = {}) {
  const sel = mobile ? '#payNowBtnMobile' : '#payNowBtn';
  const label = await p.$eval(sel, x => x.textContent.trim()).catch(() => '');
  for (let i = 0; i < taps; i++) await p.$eval(sel, x => x.click()).catch(() => {});
  return label;
}
async function waitPayfast(log, n = 1, ms = 45000) { for (let t = 0; t < ms && log.payfast.length < n; t += 500) await sleep(500); return log.payfast[n - 1] || null; }

const SCEN = {
  async rowsAndOrder(b) {
    const { p, ctx, log } = await newPage(b);
    await toCheckout(p, 'rows');
    const r = await rows(p); await ctx.close();
    return { ok: r.length > 0 && r[r.length - 1].key === 'more' && !r.some(x => ['apple_pay', 'google_pay', 'samsung_pay'].includes(x.key)), r, log };
  },
  async nothingSelected(b) {
    const { p, ctx, log } = await newPage(b);
    await toCheckout(p, 'none');
    const r = await rows(p);
    await pressPay(p); await sleep(3000);
    const msg = await barText(p); await ctx.close();
    return { ok: !r.some(x => x.selected) && /Choose how you want to pay/i.test(msg) && log.begin.length === 0 && log.payfast.length === 0, r, msg, log };
  },
  async capitecRedirect(b) { return redirectFor(b, 'capitec', 'cp'); },
  async eftRedirect(b) { return redirectFor(b, 'eft', 'ef'); },
  async moreWays(b) { return redirectFor(b, 'more', null); },
  async cardNew(b) {
    const { p, ctx, log } = await newPage(b);
    await toCheckout(p, 'card');
    await choose(p, 'card');
    const label = await pressPay(p);
    const pf = await waitPayfast(log); await ctx.close();
    const f = pf && pf.fields;
    return { ok: !!f && f.payment_method === 'cc' && UUID.test(f.custom_str3 || ''), label, fields: f && pick(f), log };
  },
  async doubleTap(b) {
    const { p, ctx, log } = await newPage(b);
    await toCheckout(p, 'tap');
    await choose(p, 'more');
    await pressPay(p, { taps: 3 });
    await waitPayfast(log); await sleep(3000); await ctx.close();
    const ok200 = log.begin.filter(x => x.status === 200).length;
    return { ok: ok200 === 1 && log.payfast.length === 1 && log.orders <= 1, begin: log.begin, payfast: log.payfast.length, orders: log.orders, log };
  },
  async cancelReturn(b) {
    const { p, ctx, log } = await newPage(b);
    await toCheckout(p, 'cancel');
    await choose(p, 'capitec');
    await pressPay(p);
    const first = await waitPayfast(log);
    if (!first) { await ctx.close(); return { ok: false, why: 'no first redirect', log }; }
    const cancelUrl = first.fields.cancel_url;
    await p.goto(cancelUrl, { waitUntil: 'networkidle2' }); await sleep(4000);
    const msg = await barText(p);
    const r = await rows(p);
    const cartLines = await p.$$eval('#orderItems > *', els => els.length).catch(() => 0);
    const urlClean = !/pf=cancel/.test(p.url());
    await choose(p, 'eft'); await pressPay(p);
    const second = await waitPayfast(log, 2); await ctx.close();
    const ok = /cancel/.test(cancelUrl) && /attempt=/.test(cancelUrl) && /Payment not completed/i.test(msg)
      && r.some(x => x.key === 'capitec' && x.selected) && cartLines > 0 && !!second
      && second.fields.m_payment_id === first.fields.m_payment_id && second.fields.payment_method === 'ef'
      && second.fields.custom_str3 !== first.fields.custom_str3 && log.orders === 1;
    return { ok, cancelUrl, msg, restoredSelection: r.filter(x => x.selected).map(x => x.key), cartLines, urlClean, sameOrder: second && second.fields.m_payment_id === first.fields.m_payment_id, orderInserts: log.orders, log,
      sql: SQL_ATTEMPTS.replace('<m>', first.fields.m_payment_id) + '  -- expect: capitec cancelled, eft started' };
  },
  async settingsFail(b) {
    const { p, ctx, log } = await newPage(b, { blockSettings: true });
    await toCheckout(p, 'fail');
    const r = await rows(p);
    const label = await pressPay(p);
    const pf = await waitPayfast(log); await ctx.close();
    return { ok: r.length === 1 && r[0].key === 'more' && r[0].selected && /on PayFast/i.test(label) && !!pf && !('payment_method' in pf.fields), r, label, log };
  },
  async deviceRows(b) {
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
    const a = await newPage(b, { mobile: true, ua: android }); await toCheckout(a.p, 'dev-a'); const ra = await rows(a.p); await a.ctx.close();
    const d = await newPage(b); await toCheckout(d.p, 'dev-d'); const rd = await rows(d.p); await d.ctx.close();
    const keys = r => r.map(x => x.key);
    return { ok: !keys(rd).some(k => ['apple_pay', 'google_pay', 'samsung_pay'].includes(k)) && !keys(ra).includes('apple_pay'),
      android: keys(ra), desktop: keys(rd), note: 'google_pay shows on Android only when switched on in admin; Apple Pay needs a real iPhone', log: a.log };
  },
  async cancelPage(b) {
    const { p, ctx, log } = await newPage(b);
    const m = fakeM(), att = '3f2b1c9a-1111-4222-8333-444455556666';
    await p.goto(`${B}/checkout-cancel.html?m_payment_id=${m}&attempt=${att}`, { waitUntil: 'networkidle2' }).catch(() => {});
    await sleep(1500);
    const went = log.navs.some(u => u.includes('/checkout.html?pf=cancel') && u.includes(m) && u.includes('attempt=' + att));
    const { p: p2, ctx: c2 } = await newPage(b);
    await p2.goto(`${B}/checkout-cancel.html`, { waitUntil: 'networkidle2' });
    const stays = /checkout-cancel/.test(p2.url()) && /Payment not completed/i.test(await p2.$eval('h1', h => h.textContent));
    await ctx.close(); await c2.close();
    return { ok: went && stays, went, sellerEnrolmentStays: stays, navs: log.navs, log };
  },
};
function pick(f) { return { amount: f.amount, m_payment_id: f.m_payment_id, payment_method: 'payment_method' in f ? f.payment_method : '(absent)', custom_str3: f.custom_str3, subscription_type: f.subscription_type || null, cancel_url: f.cancel_url }; }
async function redirectFor(b, key, code) {
  const { p, ctx, log } = await newPage(b);
  await toCheckout(p, key);
  await choose(p, key);
  const label = await pressPay(p);
  const pf = await waitPayfast(log); await ctx.close();
  const f = pf && pf.fields;
  const ok = !!f && (code ? f.payment_method === code : !('payment_method' in f)) && UUID.test(f.custom_str3 || '')
    && /pf=cancel/.test(f.cancel_url || '') && /attempt=/.test(f.cancel_url || '') && !f.subscription_type; // a token is only ever asked for a new card
  return { ok, label, fields: f && pick(f), begin: log.begin, log };
}

async function browser(only) {
  const puppeteer = require('puppeteer-core');
  const b = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
  console.log('RUN', RUN, '— picker must be ON (Admin → Payments) for every scenario except cancelPage');
  for (const [name, fn] of Object.entries(SCEN)) {
    if (only.length && !only.includes(name)) continue;
    try {
      const r = await fn(b);
      const { log, ok, ...rest } = r;
      console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${name}\n    ${JSON.stringify(rest)}`);
      if (log && log.errors.length) console.log('    console errors:', JSON.stringify(log.errors.slice(0, 4)));
    } catch (e) { console.log(`\nFAIL  ${name}\n    crashed: ${e.message.split('\n')[0]}`); }
  }
  await b.close();
}

(async () => {
  const [mode, ...rest] = process.argv.slice(2);
  if (!mode || mode === 'checklist') return printChecklist();
  if (!B) { console.error('Set B=<deploy preview url>'); process.exit(1); }
  if (mode === 'probes') return probes();
  if (mode === 'browser') return browser(rest);
  console.error('Unknown mode: ' + mode);
})();
