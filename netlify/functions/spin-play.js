// Spin & Win: the spin itself. POST { spinSession, rating?, comment? }
// → { gift, code, expiresAt, shareCode, useUrl, emailMasked, test? }
// Re-checks eligibility server-side, saves the optional rating, picks the gift
// atomically (claim_spin_gift: admin schedule, else the default gift), creates
// a personal discount code (5 days) and emails it. Idempotent: a repeat call
// for the same spin returns the same result, never a second gift.
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const S = require('./lib/spin');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return S.reply(200, {});
  if (event.httpMethod !== 'POST') return S.reply(405, { error: 'method' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch { return S.reply(400, { error: 'bad_json' }); }
  const p = S.readSession(b.spinSession);
  if (!p || !p.e) return S.reply(401, { error: 'session_expired' });
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const email = String(p.e).toLowerCase();

  const resultOf = async (spin, summary) => {
    const { data: dc } = await admin.from('discount_codes').select('code, expires_at').eq('id', spin.discount_code_id).maybeSingle();
    return {
      gift: spin.gift_kind, code: dc && dc.code, expiresAt: dc && dc.expires_at, shareCode: spin.share_code,
      useUrl: S.useUrlFor(spin.gift_kind, summary), emailMasked: S.maskEmail(email), test: spin.test || undefined
    };
  };

  try {
    // Same person tapping twice / refreshing: hand back the spin from the last 15 minutes.
    const { data: recent } = await admin.from('spins').select('*').ilike('email', email).eq('outcome', 'won')
      .gte('created_at', new Date(Date.now() - 15 * 60000).toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (recent && recent.discount_code_id) return S.reply(200, await resultOf(recent, null));

    const st = await S.getState(admin, { email, userId: p.u, name: p.nm || p.n });
    const kind = st.kind;
    if (!kind || (kind === 'friend') !== (p.v === 'friend')) return S.reply(409, { error: 'not_eligible', state: st.state });

    const test = await S.isStaff(admin, email);
    const rating = Number.isInteger(b.rating) && b.rating >= 1 && b.rating <= 5 ? b.rating : null;
    const ins = await admin.from('spins').insert({
      email, user_id: p.u || null, name: p.nm || (st.firstName || null), phone: p.ph || null,
      kind, order_id: kind === 'order' ? st.orderId : null, outcome: 'pending',
      share_code: crypto.randomBytes(5).toString('hex'), referred_by_spin_id: kind === 'friend' ? (p.r || null) : null,
      rating, test
    }).select().single();
    if (ins.error) {
      if (ins.error.code === '23505') return S.reply(409, { error: 'busy' }); // a parallel request is finishing this spin
      throw ins.error;
    }
    const spin = ins.data;

    try {
      // Rating (order spins only, delivered orders) → delivery_feedback, like rate-delivery.js
      const sum = st.lastOrder;
      if (rating && kind === 'order' && sum && sum.deliveryId && sum.delivered) {
        const { data: del } = await admin.from('deliveries').select('id, order_id, customer_id, route_id').eq('id', sum.deliveryId).maybeSingle();
        if (del) {
          let sellerId = null, driverId = null;
          if (del.route_id) {
            const [{ data: route }, { data: stop }] = await Promise.all([
              admin.from('routes').select('driver_id').eq('id', del.route_id).maybeSingle(),
              admin.from('route_stops').select('seller_id').eq('route_id', del.route_id).eq('stop_type', 'pickup').eq('delivery_id', del.id).limit(1).maybeSingle()
            ]);
            driverId = (route && route.driver_id) || null; sellerId = (stop && stop.seller_id) || null;
          }
          const row = { delivery_id: del.id, order_id: del.order_id, customer_id: del.customer_id || null,
            feedback_type: rating >= 4 ? 'compliment' : 'complaint', category: 'Spin rating', rating, seller_id: sellerId, driver_id: driverId };
          const comment = typeof b.comment === 'string' ? b.comment.trim().slice(0, 500) : '';
          if (comment) row.message = comment;
          const { error: fbErr } = await admin.from('delivery_feedback').upsert(row, { onConflict: 'delivery_id' });
          if (fbErr) console.error('spin-play rating', fbErr);
        }
      }

      // The gift (atomic) and its code
      const { data: g, error: gErr } = await admin.rpc('claim_spin_gift', { p_test: test });
      if (gErr) throw gErr;
      const pick = (Array.isArray(g) ? g[0] : g) || { gift_kind: 'drink', schedule_id: null };
      const giftKind = S.GIFTS[pick.gift_kind] ? pick.gift_kind : 'drink';
      let code = null;
      for (let i = 0; i < 4 && !code; i++) {
        const row = await S.codeRowFor(admin, giftKind, { email, friend: kind === 'friend', test });
        const { data: dc, error } = await admin.from('discount_codes').insert(row).select('id, code, expires_at').single();
        if (!error) code = dc; else if (error.code !== '23505') throw error;
      }
      if (!code) throw new Error('code_insert_failed');
      const { data: won, error: upErr } = await admin.from('spins').update({
        outcome: 'won', gift_kind: giftKind, schedule_id: pick.schedule_id || null, discount_code_id: code.id
      }).eq('id', spin.id).select().single();
      if (upErr) throw upErr;

      const useUrl = S.useUrlFor(giftKind, sum);
      const sent = await S.sendGiftEmail('prize', email, { name: won.name || st.firstName, kind: giftKind, code: code.code, expiresAt: code.expires_at, useUrl, shareCode: won.share_code });
      if (sent) await admin.from('spins').update({ prize_email_at: new Date().toISOString() }).eq('id', spin.id);

      return S.reply(200, { gift: giftKind, code: code.code, expiresAt: code.expires_at, shareCode: won.share_code, useUrl, emailMasked: S.maskEmail(email), test: test || undefined });
    } catch (e) {
      // Nothing half-done: drop the pending row so they can tap again.
      await admin.from('spins').delete().eq('id', spin.id).eq('outcome', 'pending');
      throw e;
    }
  } catch (e) {
    console.error('spin-play', e);
    return S.reply(500, { error: 'server' });
  }
};
