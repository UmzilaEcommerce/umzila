// Spin & Win admin (admin.html → Spin & Win). Admins only (admins table, like
// manage-discount-codes.js). POST + Authorization: Bearer <token>
//   { action: 'status' }                         live gift, default, slots, recent spins, totals
//   { action: 'set_default', gift }
//   { action: 'add_slot', gift, startsAt, minutes, maxWinners? }
//   { action: 'cancel_slot', id }
//   { action: 'save_gift', kind?, emoji, label, title, sub, gift_type, amount,
//     min_order_amount?, max_discount_amount?, sort_order?, active }   (no kind = new gift)
const { createClient } = require('@supabase/supabase-js');
const S = require('./lib/spin');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return S.reply(200, {});
  if (event.httpMethod !== 'POST') return S.reply(405, { error: 'method' });
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!tok) return S.reply(401, { error: 'Unauthorized' });
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: { user } = {}, error: aErr } = await admin.auth.getUser(tok);
  if (aErr || !user) return S.reply(401, { error: 'Invalid session' });
  const { data: adminRow } = await admin.from('admins').select('role').eq('user_id', user.id).maybeSingle();
  if (!adminRow || adminRow.role !== 'admin') return S.reply(403, { error: 'Admins only' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch { return S.reply(400, { error: 'bad_json' }); }

  try {
    const gifts = await S.loadGifts(admin, true);
    const usable = k => gifts[k] && gifts[k].active;
    if (b.action === 'save_gift') return await saveGift(admin, b, gifts);
    if (b.action === 'set_default') {
      if (!usable(b.gift)) return S.reply(400, { error: 'Pick a gift that is switched on.' });
      await admin.from('spin_schedule').update({ status: 'cancelled' }).eq('is_default', true).eq('status', 'scheduled');
      const { error } = await admin.from('spin_schedule').insert({ gift_kind: b.gift, is_default: true, created_by: user.id });
      if (error) throw error;
      return S.reply(200, { ok: true });
    }
    if (b.action === 'add_slot') {
      if (!usable(b.gift)) return S.reply(400, { error: 'Pick a gift that is switched on.' });
      const start = new Date(b.startsAt), minutes = parseInt(b.minutes, 10);
      if (isNaN(start) || !(minutes > 0 && minutes <= 7 * 24 * 60)) return S.reply(400, { error: 'Pick a start time and a duration (minutes).' });
      const max = b.maxWinners ? parseInt(b.maxWinners, 10) : null;
      if (max !== null && !(max > 0)) return S.reply(400, { error: 'Max winners must be 1 or more (or empty).' });
      const { error } = await admin.from('spin_schedule').insert({ gift_kind: b.gift, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + minutes * 60000).toISOString(), max_winners: max, created_by: user.id });
      if (error) throw error;
      return S.reply(200, { ok: true });
    }
    if (b.action === 'cancel_slot') {
      const { error } = await admin.from('spin_schedule').update({ status: 'cancelled' }).eq('id', b.id).eq('is_default', false);
      if (error) throw error;
      return S.reply(200, { ok: true });
    }

    // status
    const nowIso = new Date().toISOString();
    const [{ data: def }, { data: slots }, { data: spins }] = await Promise.all([
      admin.from('spin_schedule').select('id, gift_kind, created_at').eq('is_default', true).eq('status', 'scheduled').maybeSingle(),
      admin.from('spin_schedule').select('*').eq('is_default', false).gte('ends_at', new Date(Date.now() - 7 * 864e5).toISOString()).order('starts_at', { ascending: true }).limit(100),
      admin.from('spins').select('id, created_at, email, name, kind, gift_kind, rating, test, discount_code_id, referred_by_spin_id, referral_reward_code_id, order_id').eq('outcome', 'won').order('created_at', { ascending: false }).limit(200)
    ]);
    const codeIds = (spins || []).map(s => s.discount_code_id).filter(Boolean);
    const { data: codes } = codeIds.length ? await admin.from('discount_codes').select('id, code, used, expires_at').in('id', codeIds) : { data: [] };
    const byId = Object.fromEntries((codes || []).map(c => [c.id, c]));
    const usedCodes = (codes || []).filter(c => c.used).map(c => c.code);
    let orderValue = 0, discountGiven = 0, ordersFromSpins = 0;
    if (usedCodes.length) {
      const { data: ords } = await admin.from('orders').select('total, discount, coupon_code').in('coupon_code', usedCodes).eq('payment_status', 'paid');
      for (const o of ords || []) { ordersFromSpins++; orderValue += Number(o.total) || 0; discountGiven += Number(o.discount) || 0; }
    }
    const real = (spins || []).filter(s => !s.test);
    const liveSlot = (slots || []).find(s => s.status === 'scheduled' && s.starts_at <= nowIso && s.ends_at > nowIso && (s.max_winners == null || s.winners < s.max_winners)) || null;
    return S.reply(200, {
      gifts: Object.fromEntries(Object.entries(gifts).map(([k, g]) => [k, { label: g.label, emoji: g.emoji, title: g.title, active: g.active }])),
      giftRows: Object.values(gifts),
      defaultGift: def ? def.gift_kind : 'drink',
      live: liveSlot ? { kind: liveSlot.gift_kind, endsAt: liveSlot.ends_at, winners: liveSlot.winners, maxWinners: liveSlot.max_winners } : { kind: def ? def.gift_kind : 'drink', isDefault: true },
      slots: slots || [],
      spins: (spins || []).slice(0, 60).map(s => ({ ...s, code: byId[s.discount_code_id] && byId[s.discount_code_id].code, used: !!(byId[s.discount_code_id] && byId[s.discount_code_id].used), expiresAt: byId[s.discount_code_id] && byId[s.discount_code_id].expires_at })),
      totals: {
        spins: real.length,
        used: real.filter(s => byId[s.discount_code_id] && byId[s.discount_code_id].used).length,
        ordersFromSpins, orderValue: Math.round(orderValue * 100) / 100, discountGiven: Math.round(discountGiven * 100) / 100,
        referralRewards: real.filter(s => s.referral_reward_code_id).length
      }
    });
  } catch (e) {
    console.error('spin-admin', e);
    return S.reply(500, { error: 'Something went wrong' });
  }
};

// Add or edit a wheel gift (public.spin_gifts). Every active gift is a slice
// on the wheel (max 8). A gift can't be switched off while it's the default or
// in a running/upcoming slot. Existing codes keep their value: an edit only
// changes gifts won from now on.
async function saveGift(admin, b, gifts) {
  const t = v => String(v == null ? '' : v).trim();
  const num = v => (v === '' || v == null ? null : Number(v));
  const row = {
    emoji: t(b.emoji) || '🎁', label: t(b.label), title: t(b.title), sub: t(b.sub),
    gift_type: t(b.gift_type), amount: num(b.amount),
    min_order_amount: num(b.min_order_amount), max_discount_amount: num(b.max_discount_amount),
    sort_order: parseInt(b.sort_order, 10) || 0, active: b.active !== false
  };
  if (!['percentage', 'fixed', 'free_drink'].includes(row.gift_type)) return S.reply(400, { error: 'Pick what the gift is (% off, R off or free drink).' });
  if (!row.label || row.label.length > 20) return S.reply(400, { error: 'Wheel label: 1–20 characters (it has to fit on the slice).' });
  if (!row.title || row.title.length > 60) return S.reply(400, { error: 'Title: 1–60 characters.' });
  if (row.sub.length > 160) return S.reply(400, { error: 'Description: at most 160 characters.' });
  if (row.emoji.length > 16) return S.reply(400, { error: 'Emoji: one emoji please.' });
  if (row.gift_type === 'free_drink') row.amount = 100;
  else if (!(row.amount > 0)) return S.reply(400, { error: 'Enter how much off (more than 0).' });
  if (row.gift_type === 'percentage' && row.amount > 100) return S.reply(400, { error: 'A % gift can be at most 100%.' });
  for (const k of ['min_order_amount', 'max_discount_amount']) {
    if (row[k] != null && !(row[k] >= 0)) return S.reply(400, { error: 'Minimum order / maximum discount must be numbers (or empty).' });
    if (row[k] === 0) row[k] = null;
  }
  if (row.gift_type === 'free_drink') { row.min_order_amount = null; row.max_discount_amount = null; }

  const kind = t(b.kind);
  const existing = kind ? gifts[kind] : null;
  if (kind && !existing) return S.reply(404, { error: 'Gift not found' });
  const othersActive = Object.values(gifts).filter(g => g.active && g.kind !== kind).length;
  if (row.active && othersActive >= 8) return S.reply(400, { error: 'The wheel holds at most 8 gifts. Switch one off first.' });
  if (!row.active) {
    if (!othersActive) return S.reply(400, { error: 'The wheel needs at least one gift switched on.' });
    if (existing) {
      const { data: inUse } = await admin.from('spin_schedule').select('id, is_default, ends_at').eq('gift_kind', kind).eq('status', 'scheduled');
      const nowMs = Date.now();
      if ((inUse || []).some(s => s.is_default)) return S.reply(400, { error: 'This is the default gift. Pick another default first.' });
      if ((inUse || []).some(s => new Date(s.ends_at).getTime() > nowMs)) return S.reply(400, { error: 'This gift is in a running or upcoming slot. Cancel the slot first.' });
    }
  }
  if (existing) {
    const { error } = await admin.from('spin_gifts').update(row).eq('kind', kind);
    if (error) throw error;
  } else {
    const base = (row.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'gift').slice(0, 18);
    let made = false;
    for (let i = 0; i < 5 && !made; i++) {
      const k = i ? (base + '_' + (i + 1)).slice(0, 24) : (base.length >= 2 ? base : base + '_g');
      const { error } = await admin.from('spin_gifts').insert({ kind: k, ...row });
      if (!error) made = true; else if (error.code !== '23505') throw error;
    }
    if (!made) return S.reply(400, { error: 'Couldn’t name this gift — try a different wheel label.' });
  }
  await S.loadGifts(admin, true);
  return S.reply(200, { ok: true });
}
