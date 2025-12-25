// netlify/functions/payfast-itn.js
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const {
  PAYFAST_MERCHANT_ID,
  PAYFAST_MERCHANT_KEY,
  PAYFAST_PASSPHRASE = '',
  PAYFAST_SANDBOX = 'true',
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

const PAYFAST_VALIDATE_URL = PAYFAST_SANDBOX === 'true'
  ? 'https://sandbox.payfast.co.za/eng/query/validate'
  : 'https://www.payfast.co.za/eng/query/validate';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function encodePfValue(value) {
  return encodeURIComponent(String(value)).replace(/%20/g, '+');
}

function generatePfSignature(params, passphrase = '') {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map(key => `${key}=${encodePfValue(params[key])}`)
    .join('&');

  const stringToSign = passphrase
    ? `${paramString}&passphrase=${encodePfValue(passphrase)}`
    : paramString;

  return crypto.createHash('md5').update(stringToSign).digest('hex');
}

module.exports.handler = async function (event) {
  try {
    const params = new URLSearchParams(event.body || '');
    const data = Object.fromEntries(params.entries());

    // Verify signature
    const receivedSignature = data.signature;
    delete data.signature;
    const calculatedSignature = generatePfSignature(data, PAYFAST_PASSPHRASE);

    if (receivedSignature !== calculatedSignature) {
      console.error('Signature mismatch:', { receivedSignature, calculatedSignature });
      return { statusCode: 400, body: 'Invalid signature' };
    }

    // Server-to-server validation with PayFast
    if (typeof fetch !== 'function') {
      console.error('fetch is not available in runtime');
      return { statusCode: 500, body: 'Server error' };
    }

    const validateResponse = await fetch(PAYFAST_VALIDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        merchant_id: PAYFAST_MERCHANT_ID,
        merchant_key: PAYFAST_MERCHANT_KEY,
        m_payment_id: data.m_payment_id
      })
    });

    const validateText = await validateResponse.text();

    if (!validateText.includes('VALID')) {
      console.error('PayFast validation failed:', validateText);
      return { statusCode: 400, body: 'PayFast validation failed' };
    }

    // Find order by m_payment_id
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('m_payment_id', data.m_payment_id)
      .single();

    if (orderError || !order) {
      console.error('Order not found by m_payment_id:', data.m_payment_id, orderError);
      return { statusCode: 404, body: 'Order not found' };
    }

    // If already processed
    if (order.order_status === 'paid' || order.status === 'paid') {
      return { statusCode: 200, body: 'OK (already processed)' };
    }

    const paymentStatus = data.payment_status;

    if (paymentStatus === 'COMPLETE') {
      // Update order_status -> paid
      const { error: updateError } = await supabase
        .from('orders')
        .update({
          order_status: 'paid',
          pf_payment_id: data.pf_payment_id,
          pf_response: data,
          paid_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('m_payment_id', data.m_payment_id);

      if (updateError) {
        console.error('Order update error:', updateError);
        return { statusCode: 500, body: 'Failed to update order' };
      }

      // Reserve stock via RPC (if exists) using items column
      try {
        const { error: stockError } = await supabase.rpc('reserve_stock', {
          order_items: order.items
        });
        if (stockError) {
          console.error('Stock reservation error:', stockError);
        }
      } catch (e) {
        console.warn('reserve_stock RPC not present or error:', e);
      }

      console.log(`Order ${data.m_payment_id} marked as paid`);
    } else if (paymentStatus === 'FAILED' || paymentStatus === 'CANCELLED') {
      await supabase
        .from('orders')
        .update({
          order_status: 'failed',
          pf_response: data,
          updated_at: new Date().toISOString()
        })
        .eq('m_payment_id', data.m_payment_id);
    }

    return { statusCode: 200, body: 'OK' };
  } catch (error) {
    console.error('ITN processing error:', error);
    return { statusCode: 500, body: 'Server error' };
  }
};
