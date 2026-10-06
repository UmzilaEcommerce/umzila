// Per-item picks (products.metadata.picks) — server side of product-sheet.js.
// A cart line carries picks = one entry per item, e.g. [['Pap'], ['Pap'], ['Phuthu']]
// (or [['Pap','Jeqe']] on a plate that allows 2). validate-cart.js is the
// authority: the number of items IS picks.length, every item needs 1..max
// distinct allowed options, and the order line's `size` text becomes the
// readable breakdown the store, rider and emails already display.
function picksCfg(meta) {
  const c = meta && meta.picks;
  if (!c || !Array.isArray(c.options) || !c.options.length) return null;
  return { label: c.label || 'option', unit: c.unit || 'item', options: c.options.map(String), max: Number(c.max) === 2 ? 2 : 1 };
}

// Returns { picks } or { error }. `legacySize`: an old cart line saved as
// size "Pap" (before picks existed) becomes that starch on every item.
function normalizePicks(cfg, rawPicks, qty, legacySize) {
  let picks = rawPicks;
  if (!Array.isArray(picks) || !picks.length) {
    if (legacySize && cfg.options.includes(legacySize)) picks = Array.from({ length: Math.max(1, qty || 1) }, () => [legacySize]);
    else return { error: 'missing' };
  }
  if (picks.length > 99) return { error: 'too_many' };
  const out = [];
  for (const p of picks) {
    const arr = (Array.isArray(p) ? p : [p]).map(String).filter((v, i, a) => a.indexOf(v) === i);
    if (arr.length < 1 || arr.length > cfg.max || arr.some(v => !cfg.options.includes(v))) return { error: 'invalid' };
    out.push(arr);
  }
  return { picks: out };
}

// "Pap ×2, Phuthu ×1"  /  max 2: "Pap & Jeqe; Phuthu"
function picksText(cfg, picks) {
  if (cfg.max === 2) return picks.map(p => p.join(' & ')).join('; ');
  const counts = {};
  picks.forEach(p => { counts[p[0]] = (counts[p[0]] || 0) + 1; });
  return Object.keys(counts).map(k => `${k} ×${counts[k]}`).join(', ');
}

module.exports = { picksCfg, normalizePicks, picksText };
