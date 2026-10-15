// Spin & Win: someone who never ordered (a friend gave them the card, or a
// shared link). POST { name, email, phone, ref? } → same shape as spin-identify
// with state CAN_SPIN_FRIEND (their gift works on their first order).
// 409 has_orders when that email has already ordered (they use the order path).
const { createClient } = require('@supabase/supabase-js');
const { checkEmail, checkPhone } = require('./lib/contact-check');
const S = require('./lib/spin');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return S.reply(200, {});
  if (event.httpMethod !== 'POST') return S.reply(405, { error: 'method' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch { return S.reply(400, { error: 'bad_json' }); }
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) return S.reply(400, { error: 'bad_name', message: 'What should we call you?' });
  const em = checkEmail(b.email);
  if (!em.ok) return S.reply(400, { error: 'bad_email', message: em.error });
  const ph = checkPhone(b.phone);
  if (!ph.ok) return S.reply(400, { error: 'bad_phone', message: ph.error });
  const email = em.value.toLowerCase();
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  try {
    const orders = await S.paidOrders(admin, email, null);
    if (orders.length) return S.reply(409, { error: 'has_orders' });

    // Marketing contact (consent: they asked for the gift + its reminders)
    const { data: sub } = await admin.from('subscribers').select('id, sources, name').eq('email', email).maybeSingle();
    if (!sub) await admin.from('subscribers').insert({ email, name, sources: ['spin'], consent: 'soft_opt_in' });
    else if (!(sub.sources || []).includes('spin')) await admin.from('subscribers').update({ sources: [...(sub.sources || []), 'spin'], name: sub.name || name }).eq('id', sub.id);

    // The sharer's spin, if they came through a friend's link
    let refSpin = null;
    const ref = String(b.ref || '').trim().toLowerCase();
    if (ref) {
      const { data } = await admin.from('spins').select('id, email').eq('share_code', ref).maybeSingle();
      if (data && data.email.toLowerCase() !== email) refSpin = data.id;
    }

    const st = await S.getState(admin, { email, userId: null, name });
    const session = S.signSession({ e: email, u: null, v: 'friend', n: S.firstNameOf(name), nm: name, ph: ph.value, r: refSpin });
    const out = { spinSession: session, firstName: S.firstNameOf(name), emailMasked: st.emailMasked, state: st.state, lastOrder: null };
    if (st.gift) out.gift = st.gift;
    if (st.reason) out.reason = st.reason;
    return S.reply(200, out);
  } catch (e) {
    console.error('spin-friend', e);
    return S.reply(500, { error: 'server' });
  }
};
