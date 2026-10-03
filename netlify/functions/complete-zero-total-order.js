// netlify/functions/complete-zero-total-order.js
//
// Completes an order whose amount due is R0 — typically a gift voucher that
// covers the whole booking. PayFast can't take a R0 payment, so without this
// such an order could never be paid.
//
// This is NOT a payment-verification shortcut: nothing the browser says
// about the total is trusted. The order row (written by checkout) is
// re-priced here with validate-cart.js itself — same item prices, booking
// holds, fees and voucher/coupon maths that checkout uses — and only if that
// server-side total is really zero does it run the normal
// completeOrderPayment() (the same post-payment path PayFast's ITN uses).
//
// POST { m_payment_id }  → 200 { success: true } | 402 { error } when money is owed
const { createClient } = require('@supabase/supabase-js');
const { completeOrderPayment } = require('./lib/complete-order-payment');
const { repriceOrder } = require('./lib/reprice-order');

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };
  const fail = (statusCode, error) => ({ statusCode, headers, body: JSON.stringify({ error }) });
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  let mPaymentId;
  try { mPaymentId = String(JSON.parse(event.body || '{}').m_payment_id || ''); } catch { return fail(400, 'Invalid request'); }
  if (!/^UMZILA-[A-Za-z0-9-]+$/.test(mPaymentId)) return fail(400, 'Invalid order reference');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return fail(500, 'Server configuration error');
  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const priced = await repriceOrder(supabase, mPaymentId);
    if (!priced.order) return fail(404, 'Order not found');
    const order = priced.order;
    if (order.payment_status === 'paid') return { statusCode: 200, headers, body: JSON.stringify({ success: true, alreadyPaid: true }) };
    if (order.order_status !== 'pending_payment') return fail(409, 'This order can no longer be completed.');
    if (!priced.ok) return fail(priced.status, priced.error);
    if (!(priced.subtotal > 0) || priced.due > 0.004) {
      return fail(402, `R${priced.due.toFixed(2)} is still due — please pay with card.`);
    }

    const siteUrl = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');
    await completeOrderPayment(supabase, {
      mPaymentId,
      pfPaymentId: 'ZERO-' + order.id.slice(0, 8),
      pfResponse: { zero_total: true, covered_by: order.coupon_code || null, amount_gross: '0.00' },
      siteUrl
    });
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('complete-zero-total-order error', err);
    return fail(500, 'Could not complete the order. Please try again.');
  }
};
