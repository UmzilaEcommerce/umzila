// netlify/functions/begin-payment.js
//
// Payment method picker — the ONE entry point for "Pay" while site_settings
// 'payments'.enabled is true (docs/plans/payment-picker-checkout-plan.md §4.1,
// docs/systems/payment-picker.md). With the switch off it refuses (PICKER_OFF)
// and checkout uses today's direct generate-payfast-signature / charge-payfast-token path.
//
// The browser sends an option KEY, never a PayFast code: the code comes from the
// admin-managed list in site_settings (P5 "the server decides"). Each call records
// one payment_attempts row (P8) and then either
//   - saved card  → runs charge-payfast-token.handler in-process (unchanged file), or
//   - redirect    → runs generate-payfast-signature.handler in-process with two
//                   trusted fields: payment_method (the option's code, or none) and
//                   custom_str3 = attempt id (PayFast echoes it in the ITN — P9).
// Orders are still matched by m_payment_id exactly as before.
//
// POST { m_payment_id, option_key, payment_method_id?, device?, payload }
//  200 { kind:'redirect', attempt_id, actionUrl, params } | { kind:'charged', attempt_id } | { kind:'already_paid' }
//  4xx/5xx { code, message, details? }
const { createClient } = require('@supabase/supabase-js');

const PAYFAST_CODES = ['cc','dc','cp','ef','ap','gp','sp','ss','zp','mp','mc','mt','pf','ab','nd','rc','mu','sc'];
const CARD_CODES = ['cc', 'dc']; // a reusable token (subscription_type=2) only makes sense for a card
const M_RE = /^UMZILA-\d{10,}-[a-z0-9]{6,}$/i;
const KEY_RE = /^[a-z_]{2,30}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICES = ['apple', 'android', 'samsung', 'desktop', 'other'];

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });
const fail = (statusCode, code, message, details) => reply(statusCode, details ? { code, message, details } : { code, message });

function bearer(headers) {
  const h = (headers && (headers.authorization || headers.Authorization)) || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function parseJson(s) { try { return JSON.parse(s || '{}'); } catch (_) { return null; } }

// Append &attempt=<id> to the cancel URL (contract §9.3). Server-side, trusted.
function withAttempt(url, attemptId) {
  if (!url || typeof url !== 'string') return url;
  try {
    const u = new URL(url);
    u.searchParams.set('attempt', attemptId);
    return u.toString();
  } catch (_) {
    return url + (url.includes('?') ? '&' : '?') + 'attempt=' + encodeURIComponent(attemptId);
  }
}

exports._deps = {
  createClient,
  charge: () => require('./charge-payfast-token').handler,
  sign: () => require('./generate-payfast-signature').handler
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  const deps = exports._deps;

  // 1. Parse + shape checks
  const body = parseJson(event.body);
  if (!body) return fail(400, 'BAD_REQUEST', 'Bad request');
  const m = String(body.m_payment_id || '');
  const optionKey = String(body.option_key || '');
  const pmId = body.payment_method_id ? String(body.payment_method_id) : null;
  const device = DEVICES.includes(body.device) ? body.device : null;
  const payload = (body.payload && typeof body.payload === 'object') ? { ...body.payload } : {};
  if (!M_RE.test(m) || !KEY_RE.test(optionKey) || (pmId && !UUID_RE.test(pmId))) {
    return fail(400, 'BAD_REQUEST', 'Bad request');
  }
  if (payload.m_payment_id && String(payload.m_payment_id) !== m) return fail(400, 'BAD_REQUEST', 'Bad request');
  payload.m_payment_id = m;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return fail(500, 'SERVER_CONFIG', 'Server configuration error');
  const supabase = deps.createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    // 2. Master switch
    const { data: st, error: stErr } = await supabase.from('site_settings').select('value').eq('key', 'payments').maybeSingle();
    if (stErr) throw stErr;
    const cfg = (st && st.value) || {};
    if (cfg.enabled !== true) return fail(409, 'PICKER_OFF', 'Please refresh the page.');

    // 3. Option must be on the list, switched on, with a known code (or the catch-all)
    const option = (Array.isArray(cfg.options) ? cfg.options : []).find(o => o && o.key === optionKey);
    const code = option && option.code ? String(option.code) : null;
    if (!option || option.active !== true || (code && !PAYFAST_CODES.includes(code))) {
      return fail(409, 'OPTION_UNAVAILABLE', 'That way to pay is not available right now. Choose another.');
    }
    const savedCard = optionKey === 'card' && !!pmId;
    if (pmId && !savedCard) return fail(400, 'BAD_REQUEST', 'Bad request');

    // 4. Order
    const { data: order, error: oErr } = await supabase.from('orders')
      .select('id, user_id, order_status, payment_status, total, customer_email, slot_id')
      .eq('m_payment_id', m).maybeSingle();
    if (oErr) throw oErr;
    if (!order) return fail(404, 'NOT_FOUND', 'Order not found. Please refresh checkout.');
    if (order.payment_status === 'paid') return reply(200, { kind: 'already_paid' });
    if (order.order_status !== 'pending_payment') {
      return fail(409, 'ORDER_CLOSED', 'This order can no longer be paid. Please refresh checkout.');
    }

    // 5. Identity — from the Bearer token only, never from the body
    const token = bearer(event.headers);
    let user = null;
    if (token) {
      const { data: u, error: uErr } = await supabase.auth.getUser(token);
      if (uErr || !u || !u.user) return fail(401, 'AUTH', 'Your session has expired. Please sign in again.');
      user = u.user;
    }
    if (order.user_id && (!user || order.user_id !== user.id)) return fail(403, 'FORBIDDEN', 'This order belongs to another account.');
    if (savedCard && (!user || !order.user_id)) return fail(403, 'FORBIDDEN', 'Sign in to pay with a saved card.');

    // 6. P18 — every press (incl. a retry on a reused order) re-runs the delivery-run rule
    const { data: rc, error: rcErr } = await supabase.rpc('payment_order_recheck', { p_order_id: order.id });
    if (rcErr) throw rcErr;
    if (rc && rc.ok === false) {
      if (rc.reason === 'not_pending') return fail(409, 'ORDER_CLOSED', 'This order can no longer be paid. Please refresh checkout.');
      if (rc.reason === 'not_found') return fail(404, 'NOT_FOUND', 'Order not found. Please refresh checkout.');
      const { ok, ...details } = rc;
      return fail(409, 'TIMESLOT_CLOSED', 'That delivery time has closed. Please choose the next one.', details);
    }

    // 7 + 8. Double tap guard + insert the attempt (atomic, order row locked in the RPC)
    const amount = savedCard ? Number(order.total) : Number(payload.amount);
    const { data: started, error: sErr } = await supabase.rpc('payment_attempt_start', {
      p_order_id: order.id, p_option_key: optionKey, p_code: code,
      p_kind: savedCard ? 'saved_card' : 'redirect', p_payment_method_id: savedCard ? pmId : null,
      p_amount: Number.isFinite(amount) ? amount : 0, p_device: device
    });
    if (sErr) throw sErr;
    if (!started || started.ok !== true) {
      const c = started && started.code;
      if (c === 'ATTEMPT_IN_FLIGHT') return fail(409, 'ATTEMPT_IN_FLIGHT', 'Already working on it.');
      if (c === 'NOT_FOUND') return fail(404, 'NOT_FOUND', 'Order not found. Please refresh checkout.');
      return fail(409, 'ORDER_CLOSED', 'This order can no longer be paid. Please refresh checkout.');
    }
    const attemptId = started.attempt_id;
    const endAttempt = (fields) => supabase.from('payment_attempts')
      .update({ ended_at: new Date().toISOString(), ...fields }).eq('id', attemptId).eq('status', 'started');
    console.log('begin-payment: attempt', attemptId, 'option', optionKey, 'kind', savedCard ? 'saved_card' : 'redirect');

    // 9. Saved card — charge-payfast-token.js does the charge + completion (file not edited)
    if (savedCard) {
      let res;
      try {
        res = await deps.charge()({ httpMethod: 'POST', headers: event.headers, body: JSON.stringify({ m_payment_id: m, payment_method_id: pmId }) });
      } catch (e) { res = { statusCode: 500, body: JSON.stringify({ error: e.message || 'Server error' }) }; }
      const rb = parseJson(res && res.body) || {};
      if (res && res.statusCode === 200 && rb.success) {
        let pfId = null;
        try {
          const { data: paid } = await supabase.from('orders').select('pf_payment_id').eq('id', order.id).maybeSingle();
          pfId = paid && paid.pf_payment_id || null;
        } catch (_) {}
        await endAttempt({ status: 'paid', pf_payment_id: pfId, amount_gross: Number(order.total) });
        await supabase.from('orders').update({ payment_method_code: 'token' }).eq('id', order.id);
        return reply(200, { kind: 'charged', attempt_id: attemptId });
      }
      const msg = rb.error || 'PayFast declined the charge. Please pay another way.';
      await endAttempt({ status: 'failed', note: String(msg).slice(0, 300) });
      return fail((res && res.statusCode) || 502, 'CHARGE_FAILED', msg);
    }

    // 10. Redirect — sign with the trusted method + attempt id
    if (payload.cancel_url) payload.cancel_url = withAttempt(String(payload.cancel_url), attemptId);
    delete payload.payment_method; // the signer ignores it anyway; belt and braces
    if (!CARD_CODES.includes(code)) {
      // A reusable token only for a card option; never for Capitec/EFT/wallets/catch-all.
      delete payload.subscription_type; delete payload.billing_date; delete payload.recurring_amount;
      delete payload.frequency; delete payload.cycles;
    }
    // A guest order is always signed through the signer's guest path (server re-pricing +
    // email check), even if the buyer happens to be signed in.
    const signHeaders = { ...(event.headers || {}) };
    if (!order.user_id) { delete signHeaders.authorization; delete signHeaders.Authorization; }
    let sres;
    try {
      sres = await deps.sign()({
        httpMethod: 'POST', headers: signHeaders,
        body: JSON.stringify({ payload, returnForm: false }),
        trustedPaymentMethod: code || null,
        trustedAttemptId: attemptId
      });
    } catch (e) { sres = { statusCode: 500, body: '' }; }
    const sb = parseJson(sres && sres.body);
    if (!sres || sres.statusCode !== 200 || !sb || !sb.params || !sb.actionUrl) {
      const why = (sb && sb.error) || 'sign failed';
      await endAttempt({ status: 'failed', note: String(why).slice(0, 300) });
      const status = sres && sres.statusCode && sres.statusCode !== 200 ? sres.statusCode : 502;
      return fail(status, 'SIGN_FAILED', 'We could not reach PayFast. Check your connection and try again.');
    }
    return reply(200, { kind: 'redirect', attempt_id: attemptId, actionUrl: sb.actionUrl, params: sb.params });
  } catch (err) {
    console.error('begin-payment error', err && (err.message || err.code));
    return fail(500, 'SIGN_FAILED', 'We could not reach PayFast. Check your connection and try again.');
  }
};
