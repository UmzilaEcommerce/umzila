// Live guest-checkout matrix: drives the real site up to PayFast and stops
// (the request to payfast.co.za is captured and aborted — nobody pays).
// Run: B=<site> node e2e-guest-checkout.js [scenario ...]
const puppeteer = require('puppeteer-core');
const B = process.env.B;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const mail = tag => `umzila.qa+${tag}-${RUN}@example.com`;
const IN_ZONE = 'Florida Road, Morningside, Durban';
const OUT_ZONE = 'Church Street, Pietermaritzburg';

async function newPage(b, mobile) {
  const ctx = await b.createBrowserContext(); // fresh guest every scenario
  const p = await ctx.newPage();
  await p.setViewport(mobile ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1280, height: 900 });
  const log = { errors: [], payfast: null, sig: [], orders: 0 };
  p.on('pageerror', e => log.errors.push('PAGEERR ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource: the server responded with a status of 4/.test(m.text())) log.errors.push(m.text().slice(0, 160)); });
  await p.setRequestInterception(true);
  p.on('request', r => {
    if (/payfast\.co\.za/.test(r.url())) {
      log.payfast = { url: r.url(), method: r.method(), fields: Object.fromEntries(new URLSearchParams(r.postData() || '')) };
      return r.abort();
    }
    if (/\/rest\/v1\/orders/.test(r.url()) && r.method() === 'POST') log.orders++;
    if (log.failSaveOnce && /generate-payfast-signature/.test(r.url()) && r.method() === 'POST' && /subscription_type/.test(r.postData() || '')) {
      log.failSaveOnce = false; log.forcedRefusal = true;
      return r.respond({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'forced by QA' }) });
    }
    r.continue();
  });
  p.on('response', async res => {
    if (/generate-payfast-signature/.test(res.url()) && res.request().method() === 'POST') log.sig.push(res.status());
  });
  return { p, ctx, log };
}

async function addFromStore(p, slug, n = 1) {
  await p.goto(`${B}/${slug}`, { waitUntil: 'networkidle2' });
  await p.waitForSelector('[data-add]', { timeout: 20000 });
  // store promo pop-up (shop.html STORE_PROMOS) — close it like a visitor would
  await sleep(2200); await p.$eval('#spOverlay .sp-x', b => b.click()).catch(() => {});
  const ids = await p.$$eval('[data-add]', bs => bs.map(b => b.dataset.add));
  for (let i = 0; i < n; i++) {
    await p.click(`[data-add="${ids[i]}"]`); await sleep(900);
    // Items with a choice open the shared sheet (product-sheet.js): plates get
    // a starch per plate, the +6 wings plate a starch chip, sized items a size.
    await p.evaluate(() => {
      const d = document.querySelector('dialog.uq'); if (!d || !d.open) return;
      const inc = d.querySelector('[data-inc]'), chip = d.querySelector('[data-plate="0"]'), opt = d.querySelector('input[name="uqopt"]');
      if (inc) inc.click(); else if (chip) chip.click(); else if (opt && !opt.checked) opt.click();
      const add = d.querySelector('#uqAdd'); if (add && !add.disabled) add.click();
    });
    await sleep(800);
  }
}

async function fillContact(p, { email, first = 'Qa', last = 'Guest', phone = '0835551287' }) {
  await p.waitForSelector('#customerEmail', { visible: true, timeout: 30000 });
  const type = async (sel, v) => { await p.click(sel, { clickCount: 3 }); await p.type(sel, v, { delay: 5 }); };
  await type('#customerEmail', email); await p.keyboard.press('Tab');
  await type('#firstName', first); await type('#lastName', last); await type('#phoneNumber', phone);
  await p.keyboard.press('Tab');
  await sleep(1500); // email-exists check
  const btn = await p.$('#continueToStep2Btn');
  if (btn && await btn.evaluate(b => !!b.offsetParent)) { await btn.click(); await sleep(1200); }
}

async function fillAddress(p, query) {
  await p.waitForSelector('#shippingAddress', { visible: true, timeout: 20000 });
  await p.click('#shippingAddress');
  await p.type('#shippingAddress', query, { delay: 15 });
  const got = await p.waitForSelector('.address-suggestion', { visible: true, timeout: 12000 }).then(() => true).catch(() => false);
  if (got) { await p.click('.address-suggestion'); await sleep(2500); }
  if (await p.$eval('#addrConfirmYesBtn', el => !!el.offsetParent).catch(() => false)) { await p.click('#addrConfirmYesBtn'); await sleep(500); }
  for (const [sel, v] of [['#city', 'Durban'], ['#postalCode', '4001']]) {
    const empty = await p.$eval(sel, el => !el.value).catch(() => false);
    if (empty) await p.type(sel, v);
  }
  // wait for the quote / zone verdict
  for (let i = 0; i < 40; i++) {
    const t = await p.$eval('#estimatedDeliveryTime', el => el.innerText).catch(() => '');
    const blocked = await p.$eval('#quoteNoticeBlock', el => !!el.offsetParent && el.innerText).catch(() => false);
    if (/Delivery target|closed/i.test(t) || blocked) return { suggestion: got, eta: t.replace(/\s+/g, ' ').slice(0, 110), blocked };
    await sleep(500);
  }
  return { suggestion: got, eta: 'NO QUOTE', blocked: false };
}

async function pay(p, log, { mobile, taps = 1 } = {}) {
  log.card = await p.evaluate(() => ({ saveVisible: !!document.getElementById('saveCardCheckboxGroup')?.offsetParent, saveOn: !!document.getElementById('saveCardCheckbox')?.checked, nickname: document.getElementById('cardNameInput')?.value || null })).catch(() => null);
  const sel = mobile ? '#payNowBtnMobile' : '#payNowBtn';
  await p.evaluate(s => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel);
  const before = await p.$eval(sel, b => ({ text: b.textContent.trim(), visible: !!b.offsetParent })).catch(() => null);
  for (let i = 0; i < taps; i++) await p.$eval(sel, b => b.click()).catch(() => {});
  const firstTapLabel = await p.$eval(sel, b => b.textContent.trim()).catch(() => '');
  for (let i = 0; i < 90 && !log.payfast; i++) {
    const err = await p.evaluate(() => {
      const ids = ['paymentError', 'accountPasswordError', 'detailsFormError'];
      for (const id of ids) { const e = document.getElementById(id); if (e && e.offsetParent && e.innerText.trim()) return id + ': ' + e.innerText.trim(); }
      return null;
    });
    if (err && i > 4) return { before, firstTapLabel, error: err };
    await sleep(500);
  }
  return { before, firstTapLabel, error: log.payfast ? null : 'TIMEOUT (no PayFast redirect)' };
}

function verdict(name, r) {
  const ok = r.expect === 'payfast' ? !!(r.log.payfast) : r.expect === 'blocked' ? !r.log.payfast && !!r.blockedOk : false;
  const pf = r.log.payfast ? r.log.payfast.fields : null;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log('   ', JSON.stringify({
    quote: r.addr && r.addr.eta, blocked: r.addr && r.addr.blocked ? String(r.addr.blocked).slice(0, 90) : undefined,
    firstTap: r.pay && r.pay.firstTapLabel, error: r.pay && r.pay.error, sig: r.log.sig, orderInserts: r.log.orders,
    payfast: pf ? { amount: pf.amount, m_payment_id: pf.m_payment_id, email: pf.email_address, subscription_type: pf.subscription_type || null, item: pf.item_name } : null, card: r.log.card,
    notes: r.notes, errors: r.log.errors.slice(0, 4)
  }));
}

const SCEN = {
  // 1. Phone, store page → its own checkout (?store=), one plate
  async velaphiMobileStore(b) {
    const { p, ctx, log } = await newPage(b, true);
    await addFromStore(p, 'velaphishisanyama', 1);
    await p.click('#cartBtn').catch(() => {}); await sleep(1000); const href = await p.$eval('a[href*="checkout.html?store="]', a => a.href).catch(() => B + '/checkout.html'); await p.goto(href, { waitUntil: 'networkidle2' }); if (false) await p.goto('x').catch(async () => {
      await p.click('#cartBtn'); await sleep(800);
      await p.click('a[href*="checkout.html?store="]');
    });
    await fillContact(p, { email: mail('m1') });
    const saveHidden = await p.$eval('#saveCardCheckboxGroup', el => !el.offsetParent).catch(() => 'n/a');
    const addr = await fillAddress(p, IN_ZONE);
    const payR = await pay(p, log, { mobile: true });
    await ctx.close();
    return { expect: 'payfast', log, addr, pay: payR, notes: { saveCardHiddenForGuest: saveHidden } };
  },
  // 2. Desktop, two stores in one cart via cart page, tip + note
  async multiStoreTipNote(b) {
    const { p, ctx, log } = await newPage(b, false);
    await addFromStore(p, 'velaphishisanyama', 1);
    await addFromStore(p, 'sweet-corner', 2);
    await p.goto(`${B}/cart.html`, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#checkoutBtn:not([disabled])', { timeout: 20000 });
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle2' }), p.click('#checkoutBtn')]);
    await fillContact(p, { email: mail('d2') });
    const addr = await fillAddress(p, IN_ZONE);
    // tip R20 + note
    await p.evaluate(() => { const t = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'R20'); t && t.click(); });
    await p.evaluate(() => { const n = [...document.querySelectorAll('button,a,summary')].find(b => /Add a note/i.test(b.textContent)); n && n.click(); });
    await sleep(400);
    if (await p.$('#orderNotes')) await p.type('#orderNotes', 'QA test — please ignore');
    // Stores too far apart → follow the 'Check out <store> only' button
    let followed = null;
    if (addr.blocked) {
      const links = await p.$$eval('#quoteNoticeBlock a[href*="store="]', as => as.map(a => ({ href: a.href, text: a.textContent.trim() })));
      followed = links.map(l => l.text);
      if (links[0]) {
        await p.goto(links[0].href, { waitUntil: 'networkidle2' });
        await fillContact(p, { email: mail('d2') });
        addr.after = await fillAddress(p, IN_ZONE);
      }
    }
    const payR = await pay(p, log, {});
    const cartLeft = await p.evaluate(() => JSON.parse(localStorage.getItem('ss_cart') || '[]').length).catch(() => null);
    await ctx.close();
    return { expect: 'payfast', log, addr, pay: payR, notes: { storeButtons: followed, linesStillInCart: cartLeft } };
  },
  // 1b. Safety net: the signer refuses save-card once -> checkout pays without saving the card
  async safetyNet(b) {
    const { p, ctx, log } = await newPage(b, false);
    log.failSaveOnce = true;
    await addFromStore(p, 'velaphishisanyama', 1);
    await p.goto(B + '/checkout.html', { waitUntil: 'networkidle2' });
    await fillContact(p, { email: mail('sn') });
    const addr = await fillAddress(p, IN_ZONE);
    const payR = await pay(p, log, {});
    await ctx.close();
    return { expect: 'payfast', log, addr, pay: payR, notes: { forcedRefusal: !!log.forcedRefusal } };
  },
  // 2b. Desktop, one store, two items via cart page, tip + note
  async sameStoreTipNote(b) {
    const { p, ctx, log } = await newPage(b, false);
    await addFromStore(p, 'sweet-corner', 2);
    await p.goto(B + '/cart.html', { waitUntil: 'networkidle2' });
    await p.waitForSelector('#checkoutBtn:not([disabled])', { timeout: 20000 });
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle2' }), p.click('#checkoutBtn')]);
    await fillContact(p, { email: mail('s2') });
    const addr = await fillAddress(p, IN_ZONE);
    await p.evaluate(() => { const t = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'R20'); t && t.click(); });
    await p.evaluate(() => { const n = [...document.querySelectorAll('button,a,summary')].find(b => /Add a note/i.test(b.textContent)); n && n.click(); });
    await new Promise(r => setTimeout(r, 400));
    if (await p.$('#orderNotes')) await p.type('#orderNotes', 'QA test - please ignore');
    const payR = await pay(p, log, {});
    await ctx.close();
    return { expect: 'payfast', log, addr, pay: payR };
  },
  // 3. Priority delivery on (when offered)
  async priority(b) {
    const { p, ctx, log } = await newPage(b, false);
    await addFromStore(p, 'velaphishisanyama', 1);
    await p.goto(`${B}/checkout.html`, { waitUntil: 'networkidle2' });
    await fillContact(p, { email: mail('p3') });
    const addr = await fillAddress(p, IN_ZONE);
    const offered = await p.$eval('#priorityCard', el => !!el.offsetParent).catch(() => false);
    if (offered) { await p.click('#priorityToggle'); await sleep(4000); }
    const payR = await pay(p, log, {});
    await ctx.close();
    return { expect: 'payfast', log, addr, pay: payR, notes: { priorityOffered: offered } };
  },
  // 4. Five fast taps on Pay → exactly one order + one PayFast redirect
  async tripleTap(b) {
    const { p, ctx, log } = await newPage(b, false);
    await addFromStore(p, 'velaphishisanyama', 1);
    await p.goto(`${B}/checkout.html`, { waitUntil: 'networkidle2' });
    await fillContact(p, { email: mail('t4') });
    const addr = await fillAddress(p, IN_ZONE);
    const payR = await pay(p, log, { taps: 5 });
    await ctx.close();
    return { expect: 'payfast', log, addr, pay: payR, notes: { orderInsertsShouldBe1: log.orders } };
  },
  // 5. Outside every delivery area → blocked, no order
  async outsideZone(b) {
    const { p, ctx, log } = await newPage(b, false);
    await addFromStore(p, 'velaphishisanyama', 1);
    await p.goto(`${B}/checkout.html`, { waitUntil: 'networkidle2' });
    await fillContact(p, { email: mail('o5') });
    const addr = await fillAddress(p, OUT_ZONE);
    const payR = await pay(p, log, {});
    await ctx.close();
    return { expect: 'blocked', log, addr, pay: payR, blockedOk: !!(addr.blocked || (payR.error && /deliver/i.test(payR.error))) && log.orders === 0 };
  },
  // 6. Typed address, no suggestion picked
  async typedAddressNoSuggestion(b) {
    const { p, ctx, log } = await newPage(b, false);
    await addFromStore(p, 'velaphishisanyama', 1);
    await p.goto(`${B}/checkout.html`, { waitUntil: 'networkidle2' });
    await fillContact(p, { email: mail('a6') });
    await p.waitForSelector('#shippingAddress', { visible: true });
    await p.type('#shippingAddress', '12 Florida Road, Morningside');
    await p.keyboard.press('Escape'); await p.click('#city');
    await p.type('#city', 'Durban'); await p.type('#postalCode', '4001');
    await sleep(2000);
    const payR = await pay(p, log, {});
    await ctx.close();
    return { expect: 'payfast', log, addr: { eta: 'typed only' }, pay: payR };
  },
  // 7. Nceks ride booking (service, no address) via the bespoke page
  async ncekesRide(b) {
    const { p, ctx, log } = await newPage(b, true);
    await p.goto(`${B}/ncekeniquads/`, { waitUntil: 'networkidle2' });
    await p.waitForFunction(() => document.querySelector('#times input[name="time"]:not([disabled])'), { timeout: 30000 });
    await p.evaluate(() => document.getElementById('booking').requestSubmit());
    await sleep(800);
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 }), p.click('#payLink')]);
    await fillContact(p, { email: mail('n7') });
    const needsAddr = await p.$eval('#shippingAddress', el => !!el.offsetParent).catch(() => false);
    const payR = await pay(p, log, { mobile: true });
    await ctx.close();
    return { expect: 'payfast', log, addr: { eta: needsAddr ? 'asked for address' : 'no address (service)' }, pay: payR };
  },
  // 8. Nceks gift voucher (digital) via the bespoke page
  async ncekesVoucher(b) {
    const { p, ctx, log } = await newPage(b, true);
    await p.goto(`${B}/ncekeniquads/`, { waitUntil: 'networkidle2' });
    await p.waitForSelector('#vAdd', { timeout: 30000 });
    await sleep(1500);
    await p.$eval('#vAdd', el => el.click()); await sleep(1500);
    await p.goto(`${B}/checkout.html`, { waitUntil: 'networkidle2' });
    await fillContact(p, { email: mail('v8') });
    const payR = await pay(p, log, { mobile: true });
    await ctx.close();
    return { expect: 'payfast', log, addr: { eta: 'voucher' }, pay: payR };
  },
  // 9. Guest using an email that already has an account
  async existingAccountEmail(b) {
    const { p, ctx, log } = await newPage(b, false);
    await addFromStore(p, 'velaphishisanyama', 1);
    await p.goto(`${B}/checkout.html`, { waitUntil: 'networkidle2' });
    await fillContact(p, { email: process.env.EXISTING_EMAIL });
    const addr = await fillAddress(p, IN_ZONE);
    const payR = await pay(p, log, {});
    await ctx.close();
    return { expect: 'payfast', log, addr, pay: payR, notes: { email: 'existing account' } };
  },
};

(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
  const only = process.argv.slice(2);
  console.log('RUN', RUN);
  for (const [name, fn] of Object.entries(SCEN)) {
    if (only.length && !only.includes(name)) continue;
    try { verdict(name, await fn(b)); }
    catch (e) { console.log(`\nFAIL  ${name}\n    crashed: ${e.message.split('\n')[0]}`); }
  }
  await b.close();
})();
