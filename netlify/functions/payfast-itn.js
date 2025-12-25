import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import fetch from 'node-fetch';

const {
  PAYFAST_MERCHANT_ID,
  PAYFAST_MERCHANT_KEY,
  PAYFAST_PASSPHRASE = '',
  PAYFAST_SANDBOX = 'false',
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

const PAYFAST_VALIDATE_URL = PAYFAST_SANDBOX === 'true'
  ? 'https://sandbox.payfast.co.za/eng/query/validate'
  : 'https://www.payfast.co.za/eng/query/validate';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function encodePfValue(value) {
  return encodeURIComponent(String(value)).replace(/%20/g, '+');
}

function generatePfSignature(params, passphrase = '') {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map(key => `${key}=${encodePfValue(params[key])}`)
    .join('&');
  
  return crypto.createHash('md5').update(paramString + (passphrase ? `&passphrase=${encodePfValue(passphrase)}` : '')).digest('hex');
}

export async function handler(event) {
  // PayFast sends form-urlencoded
  const params = new URLSearchParams(event.body);
  const data = Object.fromEntries(params.entries());

  try {
    // 1. Verify signature
    const receivedSignature = data.signature;
    delete data.signature;

    const calculatedSignature = generatePfSignature(data, PAYFAST_PASSPHRASE);
    if (receivedSignature !== calculatedSignature) {
      console.error('Signature mismatch:', { receivedSignature, calculatedSignature });
      return { statusCode: 400, body: 'Invalid signature' };
    }

    // 2. Validate server-to-server with PayFast
    const validateResp = await fetch(PAYFAST_VALIDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        merchant_id: PAYFAST_MERCHANT_ID,
        merchant_key: PAYFAST_MERCHANT_KEY,
        m_payment_id: data.m_payment_id
      })
    });

    const validateText = await validateResp.text();
    if (!validateText.includes('VALID')) {
      console.error('PayFast validation failed:', validateText);
      return { statusCode: 400, body: 'PayFast validation failed' };
    }

    // 3. Find the order by m_payment_id
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('m_payment_id', data.m_payment_id)
      .single();

    if (orderError || !order) {
      console.error('Order not found:', data.m_payment_id);
      return { statusCode: 404, body: 'Order not found' };
    }

    // 4. Check if already paid
    if (order.order_status === 'paid') return { statusCode: 200, body: 'OK (already processed)' };

    // 5. Update order based on payment_status
    if (data.payment_status === 'COMPLETE') {
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

      // Optional: call your reserve_stock RPC
      if (order.items) {
        const { error: stockError } = await supabase.rpc('reserve_stock', { order_items: order.items });
        if (stockError) console.error('Stock reservation error:', stockError);
      }

      console.log(`Order ${data.m_payment_id} marked as paid`);
    } else if (data.payment_status === 'FAILED' || data.payment_status === 'CANCELLED') {
      await supabase.from('orders')
        .update({ order_status: 'failed', pf_response: data, updated_at: new Date().toISOString() })
        .eq('m_payment_id', data.m_payment_id);
    }

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('ITN error:', err);
    return { statusCode: 500, body: 'Server error' };
  }
}
