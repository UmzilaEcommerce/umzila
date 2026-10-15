// Spin & Win: who is scanning? (docs/systems/spin-wheel.md)
// POST { mode: 'session' }                  + Authorization: Bearer <supabase token>
//      { mode: 'track', links: [{order, token}] }  private tracking links on this device
//      { mode: 'email', email }             → { needsPhoneCheck } | 404 not_found
//      { mode: 'verify', email, last4 }     → last 4 digits of the phone on their order
// Success → { spinSession, firstName, emailMasked, state, lastOrder, gift?, reason? }
// Nothing personal is returned until one of session / track / verify proves it.
const { createClient } = require('@supabase/supabase-js');
const { checkEmail } = require('./lib/contact-check');
const S = require('./lib/spin');

const MAX_FAILS_PER_HOUR = 5;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return S.reply(200, {});
  if (event.httpMethod !== 'POST') return S.reply(405, { error: 'method' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch { return S.reply(400, { error: 'bad_json' }); }
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const done = async (email, userId, via, name) => {
    const st = await S.getState(admin, { email, userId, name });
    const session = S.signSession({ e: email, u: userId || null, v: via, n: st.firstName || '' });
    const out = { spinSession: session, firstName: st.firstName, emailMasked: st.emailMasked, state: st.state, lastOrder: st.lastOrder || null };
    if (st.gift) out.gift = st.gift;
    if (st.reason) out.reason = st.reason;
    return S.reply(200, out);
  };

  try {
    if (b.mode === 'session') {
      const auth = event.headers.authorization || event.headers.Authorization || '';
      const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!tok) return S.reply(401, { error: 'no_session' });
      const { data: { user } = {}, error } = await admin.auth.getUser(tok);
      if (error || !user || !user.email || !user.email_confirmed_at) return S.reply(401, { error: 'no_session' });
      const email = user.email.toLowerCase();
      const orders = await S.paidOrders(admin, email, user.id);
      if (!orders.length) {
        // A signed-in account with no orders: friend path unless it already spun.
        const { count } = await admin.from('spins').select('id', { count: 'exact', head: true }).ilike('email', email).eq('outcome', 'won');
        if (!count) return S.reply(404, { error: 'not_found', canFriend: true });
      }
      const { data: prof } = await admin.from('profiles').select('first_name').eq('id', user.id).maybeSingle();
      return done(email, user.id, 'session', prof && prof.first_name);
    }

    if (b.mode === 'track') {
      const links = (Array.isArray(b.links) ? b.links : []).slice(0, 5).filter(l => l && l.order && l.token);
      for (const l of links) {
        const { data: d } = await admin.from('deliveries').select('order_id, tracking_token').eq('order_id', String(l.order)).maybeSingle();
        if (!d || d.tracking_token !== String(l.token)) continue;
        const { data: o } = await admin.from('orders').select('customer_email, customer_name, user_id').eq('id', d.order_id).maybeSingle();
        if (o && o.customer_email) return done(o.customer_email.toLowerCase(), o.user_id, 'track', o.customer_name);
      }
      return S.reply(404, { error: 'not_found' });
    }

    if (b.mode === 'email' || b.mode === 'verify') {
      const em = checkEmail(b.email);
      if (!em.ok) return S.reply(400, { error: 'bad_email', message: em.error });
      const email = em.value.toLowerCase();
      const orders = await S.paidOrders(admin, email, null);
      if (!orders.length) {
        const { count } = await admin.from('spins').select('id', { count: 'exact', head: true }).ilike('email', email).eq('outcome', 'won');
        return S.reply(404, { error: 'not_found', canFriend: !count });
      }
      const since = new Date(Date.now() - 3600e3).toISOString();
      const { count: fails } = await admin.from('spins').select('id', { count: 'exact', head: true }).ilike('email', email).eq('outcome', 'check_failed').gte('created_at', since);
      if ((fails || 0) >= MAX_FAILS_PER_HOUR) return S.reply(429, { error: 'rate_limited' });
      if (b.mode === 'email') return S.reply(200, { needsPhoneCheck: true });

      const last4 = S.digits(b.last4);
      const ok = last4.length === 4 && orders.some(o => S.digits(o.customer_phone).slice(-4) === last4);
      if (!ok) {
        await admin.from('spins').insert({ email, kind: 'check', outcome: 'check_failed' });
        return S.reply(400, { error: (fails || 0) + 1 >= MAX_FAILS_PER_HOUR ? 'rate_limited' : 'check_failed' });
      }
      return done(email, orders[0].user_id || null, 'email', orders[0].customer_name);
    }
    return S.reply(400, { error: 'bad_mode' });
  } catch (e) {
    console.error('spin-identify', e);
    return S.reply(500, { error: 'server' });
  }
};
