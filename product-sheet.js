// Shared product pop-up + "pick per item" picker (docs/systems/product-sheet.md).
// One component for the home page and every default store page (shop.html),
// so a product looks and behaves the same everywhere. Two modes:
//   full  — the store quick view: gallery, title, price, options, assurances
//   quick — the home "+" sheet: just what's needed to add it
// Picks (products.metadata.picks = { label, unit, options, max }): every item
// comes with its own choice — e.g. a Velaphi plate with its own starch. With
// max 1 each "+" row IS one plate with that starch, so the plate count is the
// total (no separate quantity to misread); with max 2 (+6 wings plate) each
// plate is a row of chips, pick 1 or 2. A cart line stores picks as an array
// with one entry per item: [['Pap'], ['Pap'], ['Phuthu']].
(function () {
  if (window.UmzilaSheet) return;

  // ── picks helpers (also used by cart pages) ──────────────────────────────
  function cfgOf(meta) {
    const c = meta && meta.picks;
    if (!c || !Array.isArray(c.options) || !c.options.length) return null;
    return { label: c.label || 'option', unit: c.unit || 'item', options: c.options.slice(0, 12), max: Number(c.max) === 2 ? 2 : 1 };
  }
  const plural = (n, unit) => n + ' ' + unit + (n === 1 ? '' : 's');
  const lc = s => String(s || '').toLowerCase();
  const joinPick = pick => pick.map(lc).join(' & ');
  // "3 plates: 2 with pap · 1 with phuthu"  /  "2 plates — Plate 1: pap & jeqe · Plate 2: phuthu"
  function summary(picks, cfg) {
    picks = Array.isArray(picks) ? picks.filter(p => Array.isArray(p) && p.length) : [];
    if (!picks.length) return '';
    const unit = (cfg && cfg.unit) || 'item';
    if (cfg && cfg.max === 2) {
      if (picks.length === 1) return '1 ' + unit + ': ' + joinPick(picks[0]);
      return plural(picks.length, unit) + ' — ' + picks.map((p, i) => unit.charAt(0).toUpperCase() + unit.slice(1) + ' ' + (i + 1) + ': ' + joinPick(p)).join(' · ');
    }
    if (picks.length === 1) return '1 ' + unit + ' with ' + lc(picks[0][0]);
    const counts = {};
    picks.forEach(p => { counts[p[0]] = (counts[p[0]] || 0) + 1; });
    const parts = Object.keys(counts).map(k => counts[k] + ' with ' + lc(k));
    return plural(picks.length, unit) + ': ' + (Object.keys(counts).length === 1 && picks.length > 1 ? 'all with ' + lc(Object.keys(counts)[0]) : parts.join(' · '));
  }
  // Compact text for the store / rider / emails: "Pap ×2, Phuthu ×1" or "Pap & Jeqe; Phuthu"
  function short(picks, cfg) {
    picks = Array.isArray(picks) ? picks.filter(p => Array.isArray(p) && p.length) : [];
    if (cfg && cfg.max === 2) return picks.map(p => p.join(' & ')).join('; ');
    const counts = {};
    picks.forEach(p => { counts[p[0]] = (counts[p[0]] || 0) + 1; });
    return Object.keys(counts).map(k => k + ' ×' + counts[k]).join(', ');
  }
  // Cart "+": one more item with the same choice as the last one.
  const plusOne = picks => (Array.isArray(picks) && picks.length ? picks.concat([picks[picks.length - 1].slice()]) : picks);
  // Cart "−": drop the most recently added item.
  const minusOne = picks => (Array.isArray(picks) ? picks.slice(0, -1) : picks);
  window.UmzilaPicks = { cfgOf, summary, short, plusOne, minusOne };

  // ── styles (scoped under .uq so they never touch the page's own CSS) ────
  const CSS = `
.uq{--uq-ink:#15171A;--uq-ink2:#5A5E64;--uq-line:#E5E1D8;--uq-bg:#F6F5F1;--uq-card:#fff;--uq-navy:#0B3A5A;
  padding:0;border:0;background:var(--uq-card);color:var(--uq-ink);box-shadow:0 40px 90px -30px rgb(0 0 0/.5);overflow:auto;
  width:min(940px,calc(100% - 32px));max-height:calc(100% - 32px);border-radius:24px;font:400 1rem/1.55 "Hanken Grotesk","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.uq *,.uq *::before,.uq *::after{box-sizing:border-box}
.uq [hidden]{display:none!important}
.uq::backdrop{background:rgb(21 23 26/.45);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.uq[open]{animation:uqIn .35s cubic-bezier(.2,.9,.3,1)}
@keyframes uqIn{from{transform:translateY(20px) scale(.97);opacity:0}}
@keyframes uqUp{from{transform:translateY(100%)}}
.uq img{display:block;max-width:100%}
.uq button,.uq input{font:inherit;color:inherit}
.uq-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.uq-media{position:relative;min-height:420px;background:color-mix(in srgb,var(--uq-accent) 9%,#fff)}
.uq-media>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.uq-thumbs{position:absolute;left:12px;bottom:12px;z-index:2;display:flex;gap:6px;max-width:calc(100% - 24px);overflow-x:auto;scrollbar-width:none}
.uq-thumbs button{flex:0 0 auto;width:48px;height:48px;padding:0;border-radius:10px;overflow:hidden;border:2px solid #fff;background:#fff;cursor:pointer;opacity:.75}
.uq-thumbs button[aria-pressed="true"]{opacity:1;box-shadow:0 0 0 2px var(--uq-ink)}
.uq-thumbs img{width:100%;height:100%;object-fit:cover}
.uq-ph{position:absolute;inset:0;display:grid;align-content:end;padding:20px;font:800 clamp(1.4rem,3vw,2.2rem)/1.05 "Archivo","Arial Black",sans-serif}
.uq-body{display:grid;align-content:start;gap:16px;padding:28px}
.uq-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.uq-head h2{margin:6px 0 0;font:800 clamp(1.35rem,2.6vw,1.9rem)/1.05 "Archivo","Arial Black",sans-serif;font-stretch:114%;letter-spacing:-.015em}
.uq-store{color:var(--uq-ink2);font-size:.88rem}
.uq-x{flex:0 0 auto;display:grid;place-items:center;width:40px;height:40px;border-radius:50%;border:1.5px solid var(--uq-line);background:#fff;cursor:pointer;font-size:1.3rem;line-height:1}
.uq-x:hover{border-color:var(--uq-ink)}
.uq-price{display:flex;align-items:baseline;gap:10px}
.uq-price b{font:800 1.7rem/1 "Archivo","Arial Black",sans-serif;font-variant-numeric:tabular-nums}
.uq-price s{color:var(--uq-ink2);font-size:.9rem}
.uq-stock{font-size:.88rem;font-weight:600;color:#B7791F}
.uq-body p{margin:0;color:var(--uq-ink2);white-space:pre-line}
.uq-group{display:grid;gap:8px;margin:0;padding:0;border:0}
.uq-group legend{padding:0;margin-bottom:6px;font-weight:700;font-size:.95rem}
.uq-hint{margin:-4px 0 4px;color:var(--uq-ink2);font-size:.86rem}
.uq-opts{display:flex;flex-wrap:wrap;gap:8px}
.uq-opt{position:relative;display:inline-flex}
.uq-opt input{position:absolute;opacity:0;width:1px;height:1px}
.uq-opt span,.uq-chip{padding:.6rem 1rem;border-radius:999px;border:1.5px solid var(--uq-line);background:#fff;cursor:pointer;font-weight:600;font-size:.92rem;transition:background-color .15s,border-color .15s,color .15s}
.uq-opt span:hover,.uq-chip:hover{border-color:var(--uq-ink)}
.uq-opt input:checked+span,.uq-chip[aria-pressed="true"]{background:var(--uq-ink);border-color:var(--uq-ink);color:#fff}
.uq-opt input:focus-visible+span,.uq-chip:focus-visible{outline:3px solid var(--uq-navy);outline-offset:2px}
.uq-err{margin:0;color:#b91c1c;font-weight:600;font-size:.9rem}
.uq-rows{display:grid;gap:8px}
.uq-row{display:flex;align-items:center;gap:10px;padding:10px 10px 10px 14px;border-radius:14px;border:1.5px solid var(--uq-line);transition:border-color .15s,background-color .15s}
.uq-row.on{border-color:var(--uq-ink);background:var(--uq-bg)}
.uq-row .nm{flex:1;min-width:0;font-weight:600}
.uq-row .nm small{display:block;font-weight:500;color:var(--uq-ink2);font-size:.8rem}
.uq-step{display:inline-flex;align-items:center;gap:4px;padding:4px;border-radius:999px;border:1.5px solid var(--uq-line);background:#fff}
.uq-step button{width:36px;height:36px;border:0;border-radius:50%;background:var(--uq-bg);cursor:pointer;font-size:1.15rem;line-height:1}
.uq-step button:disabled{opacity:.35;cursor:not-allowed}
.uq-step output{min-width:2.2ch;text-align:center;font-weight:700;font-variant-numeric:tabular-nums}
.uq-plate{display:grid;gap:8px;padding:12px 14px;border-radius:14px;border:1.5px solid var(--uq-line)}
.uq-plate-h{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:.92rem}
.uq-plate-h button{border:0;background:none;color:var(--uq-ink2);cursor:pointer;font-size:.86rem;text-decoration:underline}
.uq-more{justify-self:start;padding:.55rem 1rem;border-radius:999px;border:1.5px dashed var(--uq-line);background:#fff;cursor:pointer;font-weight:600}
.uq-more:hover{border-color:var(--uq-ink)}
.uq-sum{margin:0;padding:10px 14px;border-radius:12px;background:var(--uq-bg);font-weight:600;font-size:.92rem}
.uq-buy{display:flex;gap:10px;align-items:center}
.uq-btn{display:inline-flex;align-items:center;justify-content:center;gap:.5em;flex:1;padding:1rem 1.3rem;border:0;border-radius:999px;cursor:pointer;font-weight:700;background:var(--uq-accent);color:#fff;box-shadow:0 10px 24px -14px var(--uq-accent);transition:transform .18s,filter .18s}
.uq-btn:active{transform:scale(.97)}
.uq-btn:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
.uq-btn.ink{background:var(--uq-ink)}
.uq-notify{display:flex;gap:8px}
.uq-notify input{flex:1;min-width:0;height:48px;padding:0 14px;border-radius:999px;border:1.5px solid var(--uq-line)}
.uq-assure{display:grid;gap:8px;margin:0;padding:14px;border-radius:14px;background:var(--uq-bg);list-style:none;font-size:.9rem}
.uq-assure li{display:flex;align-items:center;gap:10px}
.uq-assure svg{width:18px;height:18px;flex:0 0 auto;fill:none;stroke:var(--uq-navy);stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.uq-link{justify-self:start;padding:0;border:0;background:none;color:var(--uq-ink2);text-decoration:underline;cursor:pointer;font-size:.86rem}
.uq.quick{width:min(460px,calc(100% - 32px))}
.uq.quick .uq-grid{grid-template-columns:1fr}
.uq.quick .uq-media{display:none}
.uq-mini{display:flex;gap:12px;align-items:center}
.uq-mini img{width:56px;height:56px;border-radius:12px;object-fit:cover;background:var(--uq-bg)}
@media (max-width:760px){
  .uq,.uq.quick{width:100%;max-width:100%;max-height:94%;margin:auto 0 0;border-radius:24px 24px 0 0}
  .uq[open]{animation:uqUp .35s cubic-bezier(.2,.9,.3,1)}
  .uq-grid{grid-template-columns:1fr}
  .uq-media{min-height:0;aspect-ratio:4/3}
  .uq-body{padding:20px 20px calc(24px + env(safe-area-inset-bottom,0px))}
}
@media (prefers-reduced-motion:reduce){.uq[open]{animation:none}}`;
  const ICONS = {
    bike: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17h4l3-6h3l2 6"/><path d="M13 11 11 7H8"/></svg>',
    shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 3 8.3 7 9.5 4-1.2 7-5 7-9.5V6z"/><path d="m9 12 2 2 4-4"/></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 1-11.7 7.1L4 20l.9-4.3A8 8 0 1 1 20 12z"/></svg>'
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => 'R' + (Number(n) || 0).toFixed(2);

  let dlg = null, styled = false;
  function ensure() {
    if (!styled) {
      const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
      if (!document.querySelector('link[data-uq-fonts]')) {
        const ln = document.createElement('link'); ln.rel = 'stylesheet'; ln.dataset.uqFonts = '1';
        ln.href = 'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,700..900&family=Hanken+Grotesk:wght@400;500;600;700&display=swap';
        document.head.appendChild(ln);
      }
      styled = true;
    }
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'uq';
      dlg.setAttribute('aria-labelledby', 'uqTitle');
      document.body.appendChild(dlg);
      dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    }
    return dlg;
  }

  // product: { id, title, desc, price, was, images[], stock, store, location, accent,
  //   isService, serviceCta, soldOut, unpriced, freeDelivery, closedNote,
  //   options: { label, values[], required } | null, picks: cfg | null }
  // opts: { mode, user, initialPicks, editing, onAdd({ qty, size, picks }), onService(), onNotify(email), onCopy() }
  function open(product, opts) {
    opts = opts || {};
    const d = ensure();
    const p = product, quick = opts.mode === 'quick';
    const cfg = p.picks || null;
    const opt = !cfg && p.options && p.options.values && p.options.values.length ? p.options : null;
    const stockCap = p.stock != null && p.stock > 0 ? Math.min(p.stock, 99) : 99;
    d.style.setProperty('--uq-accent', p.accent || '#E8553A');
    d.classList.toggle('quick', quick);

    // state
    let seq = [];        // max 1: one starch per plate, in the order added
    let plates = [];     // max 2: [['Pap','Jeqe'], …]
    let qty = 1, picked = null;
    if (cfg && Array.isArray(opts.initialPicks) && opts.initialPicks.length) {
      if (cfg.max === 2) plates = opts.initialPicks.map(x => x.filter(o => cfg.options.includes(o)).slice(0, 2));
      else seq = opts.initialPicks.map(x => x[0]).filter(o => cfg.options.includes(o));
    }
    if (cfg && cfg.max === 2 && !plates.length) plates = [[]];
    if (opt && !opt.required) picked = opt.values[0];

    const media = !quick ? (p.images && p.images.length
      ? `<img id="uqMain" src="${esc(p.images[0])}" alt="${esc(p.title)}">` + (p.images.length > 1 ? `<div class="uq-thumbs">${p.images.map((u, i) => `<button type="button" data-img="${i}" aria-pressed="${i === 0}" aria-label="Image ${i + 1}"><img src="${esc(u)}" alt=""></button>`).join('')}</div>` : '')
      : `<div class="uq-ph">${esc(p.title)}</div>`) : '';
    const assure = [
      p.closedNote ? `${ICONS.clock}<span>${esc(p.closedNote)}</span>` : '',
      p.isService ? (p.serviceHint ? `${ICONS.cal}<span>${esc(p.serviceHint)}</span>` : '') : (p.freeDelivery ? `${ICONS.bike}<span>No delivery fee on this one</span>` : `${ICONS.bike}<span>Delivered by Umzila. Fee depends on distance.</span>`),
      `${ICONS.shield}<span>Secure checkout with PayFast</span>`,
      p.store ? `${ICONS.pin}<span>Sold by ${esc(p.store)}${p.location ? ', ' + esc(p.location) : ''}</span>` : ''
    ].filter(Boolean).map(x => `<li>${x}</li>`).join('');

    d.innerHTML = `<div class="uq-grid">
      <div class="uq-media">${media}</div>
      <form class="uq-body" method="dialog" novalidate>
        <div class="uq-head">
          ${quick ? `<div class="uq-mini">${p.images && p.images[0] ? `<img src="${esc(p.images[0])}" alt="">` : ''}<div><span class="uq-store">${esc(p.store || '')}</span><h2 id="uqTitle" style="font-size:1.2rem;margin-top:2px">${esc(p.title)}</h2></div></div>`
                  : `<div><span class="uq-store">${esc(p.store || '')}</span><h2 id="uqTitle">${esc(p.title)}</h2></div>`}
          <button class="uq-x" type="button" data-x aria-label="Close">×</button>
        </div>
        <div class="uq-price">${p.unpriced ? '<span class="uq-store">Price on request</span>' : `<b>${money(p.price)}</b>${p.was ? `<s>${money(p.was)}</s>` : ''}${cfg ? `<span class="uq-store">per ${esc(cfg.unit)}</span>` : ''}`}</div>
        ${!quick && !p.isService && !p.soldOut && p.stock > 0 && p.stock < 5 ? `<span class="uq-stock">Only ${p.stock} left</span>` : ''}
        ${!quick && p.desc ? `<p>${esc(p.desc)}</p>` : ''}
        <div id="uqChoose"></div>
        <p class="uq-sum" id="uqSum" hidden></p>
        <div class="uq-buy" id="uqBuy"${p.soldOut || p.unpriced ? ' hidden' : ''}>
          <div class="uq-step" id="uqQtyStep"${cfg || p.isService ? ' hidden' : ''} role="group" aria-label="Quantity"><button type="button" data-q="-1" aria-label="Less">−</button><output id="uqQty">1</output><button type="button" data-q="1" aria-label="More">+</button></div>
          <button class="uq-btn" type="submit" id="uqAdd">Add to cart</button>
        </div>
        <div class="uq-notify" id="uqNotify"${p.soldOut ? '' : ' hidden'}><input type="email" id="uqNotifyEmail" placeholder="Your email" autocomplete="email" aria-label="Email for a back-in-stock alert"${opts.user && opts.user.email ? ' hidden' : ''}><button class="uq-btn ink" type="button" id="uqNotifyBtn">${opts.user && opts.user.email ? 'Notify me when it’s back' : 'Notify me'}</button></div>
        ${!quick ? `<ul class="uq-assure">${assure}</ul>` : ''}
        ${!quick && opts.onCopy ? '<button class="uq-link" type="button" id="uqCopy">Copy link to this item</button>' : ''}
      </form></div>`;

    const $ = s => d.querySelector(s);
    const choose = $('#uqChoose'), sum = $('#uqSum'), add = $('#uqAdd');
    const unit = cfg ? cfg.unit : 'item';

    function currentPicks() {
      if (!cfg) return null;
      return cfg.max === 2 ? plates.filter(x => x.length).map(x => x.slice()) : seq.map(o => [o]);
    }
    function render() {
      if (p.isService) {
        choose.innerHTML = '';
        add.textContent = p.serviceCta || 'Set it up';
        add.disabled = false;
        return;
      }
      if (cfg && cfg.max !== 2) {
        // one row per option: each "+" is one more plate with that starch
        const counts = {}; seq.forEach(o => { counts[o] = (counts[o] || 0) + 1; });
        const total = seq.length;
        choose.innerHTML = `<fieldset class="uq-group"><legend>How many ${esc(unit)}s?</legend>
          <p class="uq-hint">Each ${esc(unit)} comes with its own ${esc(cfg.label)} — tap + for every ${esc(unit)} you want.</p>
          <div class="uq-rows">${cfg.options.map(o => {
            const n = counts[o] || 0;
            return `<div class="uq-row${n ? ' on' : ''}"><span class="nm">🍽 ${esc(unit.charAt(0).toUpperCase() + unit.slice(1))} with ${esc(lc(o))}</span>
              <span class="uq-step" role="group" aria-label="${esc(unit)}s with ${esc(lc(o))}"><button type="button" data-dec="${esc(o)}" aria-label="One less ${esc(unit)} with ${esc(lc(o))}"${n ? '' : ' disabled'}>−</button><output>${n}</output><button type="button" data-inc="${esc(o)}" aria-label="One more ${esc(unit)} with ${esc(lc(o))}"${total >= stockCap ? ' disabled' : ''}>+</button></span></div>`;
          }).join('')}</div></fieldset>`;
        sum.hidden = !total; sum.textContent = summary(currentPicks(), cfg);
        add.disabled = !total;
        add.textContent = total ? `${opts.editing ? 'Update' : 'Add'} ${plural(total, unit)} · ${money(total * p.price)}` : `Tap + to choose your ${unit}s`;
        return;
      }
      if (cfg && cfg.max === 2) {
        const ready = plates.filter(x => x.length).length;
        choose.innerHTML = `<div class="uq-group"><div style="font-weight:700;font-size:.95rem">Each ${esc(unit)} comes with 1 or 2 ${esc(cfg.label)}es</div>
          <div class="uq-rows">${plates.map((pl, i) => `<div class="uq-plate"><div class="uq-plate-h"><span>${esc(unit.charAt(0).toUpperCase() + unit.slice(1))} ${i + 1}${pl.length ? '' : ' — pick 1 or 2'}</span>${plates.length > 1 ? `<button type="button" data-rm="${i}">Remove</button>` : ''}</div>
            <div class="uq-opts">${cfg.options.map(o => `<button type="button" class="uq-chip" data-plate="${i}" data-opt="${esc(o)}" aria-pressed="${pl.includes(o)}">${esc(o)}</button>`).join('')}</div></div>`).join('')}</div>
          ${plates.length < stockCap ? `<button type="button" class="uq-more" data-another>+ Add another ${esc(unit)}</button>` : ''}</div>`;
        const allReady = plates.every(x => x.length);
        sum.hidden = !ready; sum.textContent = summary(currentPicks(), cfg);
        add.disabled = !allReady;
        add.textContent = allReady ? `${opts.editing ? 'Update' : 'Add'} ${plural(plates.length, unit)} · ${money(plates.length * p.price)}` : `Pick for ${unit} ${plates.findIndex(x => !x.length) + 1}`;
        return;
      }
      // normal product: option chips (sizes) + quantity
      choose.innerHTML = opt ? `<fieldset class="uq-group"><legend>${esc(opt.label || 'Size')}</legend><div class="uq-opts">${opt.values.map(v => `<label class="uq-opt"><input type="radio" name="uqopt" value="${esc(v)}"${v === picked ? ' checked' : ''}><span>${esc(v)}</span></label>`).join('')}</div></fieldset>` : '';
      $('#uqQty').textContent = qty;
      const [mi, pl] = d.querySelectorAll('#uqQtyStep button');
      mi.disabled = qty <= 1; pl.disabled = qty >= stockCap;
      add.disabled = !!(opt && !picked);
      add.textContent = opt && !picked ? `Choose ${lc(opt.label || 'a size').replace(/^choose (your )?/, 'your ')}` : (opts.editing ? 'Update' : 'Add to cart');
    }

    d.onclick = e => {
      if (e.target === d) { d.close(); return; }
      const t = e.target.closest('button,input');
      if (!t) return;
      if (t.dataset.x !== undefined) { d.close(); return; }
      if (t.dataset.img !== undefined) {
        const i = +t.dataset.img; const m = $('#uqMain'); if (m) m.src = p.images[i];
        d.querySelectorAll('.uq-thumbs button').forEach((b, bi) => b.setAttribute('aria-pressed', String(bi === i)));
        return;
      }
      if (t.dataset.inc) { if (seq.length < stockCap) seq.push(t.dataset.inc); render(); return; }
      if (t.dataset.dec) { const k = seq.lastIndexOf(t.dataset.dec); if (k > -1) seq.splice(k, 1); render(); return; }
      if (t.dataset.plate !== undefined) {
        const pl = plates[+t.dataset.plate], o = t.dataset.opt, k = pl.indexOf(o);
        if (k > -1) pl.splice(k, 1); else { pl.push(o); if (pl.length > 2) pl.shift(); }
        render(); return;
      }
      if (t.dataset.another !== undefined) { const last = plates[plates.length - 1] || []; plates.push(last.slice()); render(); return; }
      if (t.dataset.rm !== undefined) { plates.splice(+t.dataset.rm, 1); if (!plates.length) plates = [[]]; render(); return; }
      if (t.dataset.q) { qty = Math.max(1, Math.min(stockCap, qty + Number(t.dataset.q))); render(); return; }
      if (t.name === 'uqopt') { picked = t.value; render(); return; }
    };
    d.querySelector('form').onsubmit = e => {
      e.preventDefault();
      if (add.disabled) return;
      if (p.isService) { d.close(); if (opts.onService) opts.onService(); return; }
      const picks = currentPicks();
      const n = picks ? picks.length : qty;
      if (!n) return;
      d.close();
      if (opts.onAdd) opts.onAdd({ qty: n, size: picks ? 'One Size' : (picked || 'One Size'), picks, button: add });
    };
    const nb = $('#uqNotifyBtn');
    if (nb) nb.onclick = async () => {
      const em = (opts.user && opts.user.email) || ($('#uqNotifyEmail').value || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { $('#uqNotifyEmail').focus(); return; }
      nb.disabled = true;
      try { if (opts.onNotify) await opts.onNotify(em); d.close(); } finally { nb.disabled = false; }
    };
    const cp = $('#uqCopy'); if (cp) cp.onclick = () => opts.onCopy && opts.onCopy();

    render();
    if (!d.open) d.showModal();
    return d;
  }
  window.UmzilaSheet = { open, close: () => dlg && dlg.open && dlg.close() };
})();
