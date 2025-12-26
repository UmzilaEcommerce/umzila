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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// FIX 1A: Same encoding as initiate-payfast.js
function encodePfValue(value) {
  if (value === null || value === undefined) return '';
  return encodeURIComponent(String(value)).replace(/%20/g, '+');
}

// FIX 1B: Same signature calculation as initiate-payfast.js
function generatePfSignature(params, passphrase = '') {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map(key => `${key}=${encodePfValue(params[key])}`)
    .join('&');
  // append passphrase only if it's non-empty
  return passphrase ? crypto.createHash('md5').update(`${paramString}&passphrase=${encodePfValue(passphrase)}`, 'utf8').digest('hex') : crypto.createHash('md5').update(paramString, 'utf8').digest('hex');
}

module.exports.handler = async function (event) {
  console.log('=== PAYFAST ITN RECEIVED ===');
  
  let data = {};
  try {
    const params = new URLSearchParams(event.body || '');
    data = Object.fromEntries(params.entries());
  } catch (err) {
    console.error('Parse error:', err);
    return { statusCode: 400, body: 'Invalid data' };
  }

  try {
    // 1. Verify signature
    const receivedSignature = data.signature;
    const dataForSignature = { ...data };
    delete dataForSignature.signature;
    
    const calculatedSignature = generatePfSignature(dataForSignature, PAYFAST_PASSPHRASE);
    
    console.log('\n=== SIGNATURE CHECK ===');
    console.log('Received:', receivedSignature);
    console.log('Calculated:', calculatedSignature);
    console.log('Match:', receivedSignature === calculatedSignature);
    
    if (receivedSignature !== calculatedSignature) {
      console.error('SIGNATURE MISMATCH!');
      
      // Debug what we calculated
      const sortedKeys = Object.keys(dataForSignature).sort();
      const debugString = sortedKeys
        .map(key => `${key}=${encodePfValue(dataForSignature[key])}`)
        .join('&');
      console.log('String we hashed:', passphrase ? `${debugString}&passphrase=${encodePfValue(PAYFAST_PASSPHRASE)}` : debugString);
      
      return { statusCode: 400, body: 'Invalid signature' };
    }
    
    console.log('Signature verified successfully');

    // FIX 2E: Server-to-server validation with PayFast
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
    console.log('PayFast validation response:', validateText);
    
    if (!validateText.includes('VALID')) {
      console.error('PayFast server-to-server validation failed:', validateText);
      return { statusCode: 400, body: 'PayFast validation failed' };
    }

    // Find order by m_payment_id
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('m_payment_id', data.m_payment_id)
      .single();

    if (orderError || !order) {
      console.error('Order not found:', data.m_payment_id);
      return { statusCode: 404, body: 'Order not found' };
    }

    console.log('Order found:', order.id, 'Current status:', order.order_status);

    // Check if already paid
    if (order.order_status === 'paid') {
      console.log('Order already paid, returning OK');
      return { statusCode: 200, body: 'OK (already processed)' };
    }

    // Update order based on payment_status
    if (data.payment_status === 'COMPLETE') {
      console.log('Payment COMPLETE for order:', data.m_payment_id);
      
      const { error: updateError } = await supabase
        .from('orders')
        .update({
          order_status: 'paid',
          pf_payment_id: data.pf_payment_id || null,
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
        try {
          const { error: stockError } = await supabase.rpc('reserve_stock', { order_items: order.items });
          if (stockError) console.error('Stock reservation error:', stockError);
        } catch (e) {
          console.warn('reserve_stock RPC not present or failed', e);
        }
      }

      console.log(`Order ${data.m_payment_id} marked as paid`);
      
    } else if (data.payment_status === 'FAILED' || data.payment_status === 'CANCELLED') {
      console.log('Payment FAILED for order:', data.m_payment_id);
      
      await supabase.from('orders')
        .update({ 
          order_status: 'failed', 
          pf_response: data, 
          updated_at: new Date().toISOString() 
        })
        .eq('m_payment_id', data.m_payment_id);
    }

    console.log('ITN processed successfully for order:', data.m_payment_id);
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('ITN processing error:', err.message);
    console.error('Error stack:', err.stack);
    return { statusCode: 500, body: 'Server error' };
  }
};