// Spin & Win: scheduled (netlify.toml, every 30 min).
// 1. Reminder on day 3 and a last-day email (from 08:00 SAST on the expiry
//    day) while the gift code is unused. Never to unsubscribed emails or
//    staff test spins.
// 2. Referral rewards: a friend who came through someone's spin link placed
//    their first paid order with their spin code → the sharer gets R20 off
//    (over R60, sign-in needed: multi_use + max 1 redemption), max 5 a month,
//    never for the same phone number.
const { createClient } = require('@supabase/supabase-js');
const S = require('./lib/spin');

const DAY = 864e5;

exports.handler = async () => {
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const now = new Date();
  let reminders = 0, finals = 0, rewards = 0;

  // ── 1. reminders ──
  const { data: live } = await admin.from('spins')
    .select('id, email, name, gift_kind, share_code, created_at, reminder_email_at, final_email_at, discount_code_id, order_id, user_id')
    .eq('outcome', 'won').eq('test', false).not('discount_code_id', 'is', null)
    .gte('created_at', new Date(now - 8 * DAY).toISOString())
    .or('reminder_email_at.is.null,final_email_at.is.null');
  for (const s of live || []) {
    const { data: dc } = await admin.from('discount_codes').select('code, used, expires_at, status').eq('id', s.discount_code_id).maybeSingle();
    if (!dc || dc.used || dc.status !== 'active' || new Date(dc.expires_at) <= now) continue;
    const { data: sub } = await admin.from('subscribers').select('unsubscribed').eq('email', s.email.toLowerCase()).maybeSingle();
    if (sub && sub.unsubscribed) continue;
    const exp = new Date(dc.expires_at);
    // expiry day starts at 00:00 SAST; "last day" email from 08:00 SAST
    const lastDayFrom = new Date(exp.getTime() - (23 * 3600e3 + 59 * 60e3 + 59e3) + 8 * 3600e3);
    let variant = null;
    if (!s.final_email_at && now >= lastDayFrom) variant = 'final';
    else if (!s.reminder_email_at && !s.final_email_at && now - new Date(s.created_at) >= 3 * DAY) variant = 'reminder';
    if (!variant) continue;
    let summary = null;
    if (s.order_id) { const { data: o } = await admin.from('orders').select('id, created_at').eq('id', s.order_id).maybeSingle(); summary = await S.orderSummary(admin, o); }
    const ok = await S.sendGiftEmail(variant, s.email, { name: s.name, kind: s.gift_kind, code: dc.code, expiresAt: dc.expires_at, useUrl: S.useUrlFor(s.gift_kind, summary), shareCode: s.share_code });
    if (ok) {
      await admin.from('spins').update(variant === 'final' ? { final_email_at: now.toISOString(), reminder_email_at: s.reminder_email_at || now.toISOString() } : { reminder_email_at: now.toISOString() }).eq('id', s.id);
      variant === 'final' ? finals++ : reminders++;
    }
  }

  // ── 2. referral rewards ──
  const { data: friends } = await admin.from('spins')
    .select('id, email, name, phone, discount_code_id, referred_by_spin_id')
    .eq('kind', 'friend').eq('outcome', 'won').eq('test', false)
    .not('referred_by_spin_id', 'is', null).is('referral_rewarded_at', null);
  for (const f of friends || []) {
    const { data: fdc } = await admin.from('discount_codes').select('used').eq('id', f.discount_code_id).maybeSingle();
    if (!fdc || !fdc.used) continue; // not converted (yet)
    const { data: sharer } = await admin.from('spins').select('id, email, name, phone, user_id').eq('id', f.referred_by_spin_id).maybeSingle();
    const stamp = { referral_rewarded_at: now.toISOString() };
    let ok = !!sharer && sharer.email.toLowerCase() !== f.email.toLowerCase();
    // same phone = same person
    if (ok && f.phone) {
      const { data: sharerOrders } = await admin.from('orders').select('customer_phone').ilike('customer_email', sharer.email).limit(20);
      const phones = new Set([sharer.phone, ...(sharerOrders || []).map(o => o.customer_phone)].map(S.digits).filter(Boolean).map(d => d.slice(-9)));
      if (phones.has(S.digits(f.phone).slice(-9))) ok = false;
    }
    // max 5 a month per sharer
    if (ok) {
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      const { data: mine } = await admin.from('spins').select('id').ilike('email', sharer.email);
      const ids = (mine || []).map(m => m.id);
      const { count } = ids.length ? await admin.from('spins').select('id', { count: 'exact', head: true })
        .in('referred_by_spin_id', ids).not('referral_reward_code_id', 'is', null).gte('referral_rewarded_at', monthStart) : { count: 0 };
      if ((count || 0) >= S.REFERRAL_MONTHLY_CAP) ok = false;
    }
    if (ok) {
      const exp = new Date(Date.now() + 30 * DAY);
      let code = null;
      for (let i = 0; i < 4 && !code; i++) {
        const { data: dc, error } = await admin.from('discount_codes').insert({
          code: S.randomCode('GIFT', 6), email: sharer.email.toLowerCase(), type: 'fixed', amount: 20, min_order_amount: 60,
          scope: 'order', expires_at: exp.toISOString(), multi_use: true, max_redemptions: 1, per_user_limit: 1, status: 'active'
        }).select('id, code, expires_at').single();
        if (!error) code = dc; else if (error.code !== '23505') { console.error('referral code', error); break; }
      }
      if (!code) continue; // try again next run
      stamp.referral_reward_code_id = code.id;
      await S.sendGiftEmail('referral', sharer.email, { name: sharer.name, kind: 'r20', code: code.code, expiresAt: code.expires_at, useUrl: '/', friendName: S.firstNameOf(f.name) });
      rewards++;
    }
    await admin.from('spins').update(stamp).eq('id', f.id);
  }

  console.log('send-spin-emails', { reminders, finals, rewards });
  return { statusCode: 200, body: JSON.stringify({ reminders, finals, rewards }) };
};
