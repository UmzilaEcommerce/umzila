// netlify/functions/lib/reprice-order.js
//
// Re-prices a saved pending order server-side, exactly as checkout does,
// by running validate-cart.js over the order row's own items/coupon/quote.
// The `orders` row is written by the browser, so its `total` is never
// trusted where money is concerned — callers compare against `due` instead.
//
// Used by complete-zero-total-order.js (is anything owed?) and by
// generate-payfast-signature.js's guest path (is this the right amount?).
const validateCart = require('../validate-cart');

async function repriceOrder(supabase, mPaymentId) {
  const { data: order } = await supabase.from('orders')
    .select('id, user_id, items, coupon_code, customer_email, tip_amount, payment_status, order_status, delivery_quote_id')
    .eq('m_payment_id', mPaymentId).maybeSingle();
  if (!order) return { ok: false, status: 404, error: 'Order not found' };

  const res = await validateCart.handler({
    httpMethod: 'POST',
    body: JSON.stringify({
      cartItems: Array.isArray(order.items) ? order.items : [],
      userId: order.user_id || undefined,
      couponCode: order.coupon_code || undefined,
      customerEmail: order.customer_email || '',
      quoteId: order.delivery_quote_id || undefined,
      persistCart: false // pricing only — never rewrite the buyer's saved cart
    })
  });
  const priced = JSON.parse(res.body || '{}');
  if (res.statusCode !== 200) return { ok: false, status: res.statusCode || 400, error: priced.error || 'Could not confirm this order.', order };

  const subtotal = (priced.validatedCart || []).reduce((s, i) => s + Number(i.price) * Number(i.quantity), 0);
  const discount = priced.discount && priced.discount.valid ? Number(priced.discount.amount) || 0 : 0;
  const fees = priced.fees ? Number(priced.fees.total) || 0 : 0;
  const tip = Number(order.tip_amount) || 0;
  const due = Math.round((subtotal - discount + fees + tip) * 100) / 100;
  return { ok: true, order, subtotal, discount, fees, tip, due: Math.max(0, due) };
}

module.exports = { repriceOrder };
