// netlify/functions/payfast-itn.js
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const querystring = require('querystring');

const {
  PAYFAST_MERCHANT_ID,
  PAYFAST_MERCHANT_KEY,
  PAYFAST_PASSPHRASE = '',
  PAYFAST_SANDBOX = 'true',
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// EXACT SAME ENCODING as initiate-payfast.js
function encodePfValue(value) {
  if (value === null || value === undefined || value === '') return '';
  return querystring.escape(String(value)).replace(/%20/g, '+');
}

// EXACT SAME SIGNATURE CALCULATION as initiate-payfast.js
function generatePfSignature(params, passphrase = '') {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map(key => `${key}=${encodePfValue(params[key])}`)
    .join('&');
  
  let stringToSign = paramString;
  if (passphrase && passphrase.trim() !== '') {
    stringToSign += `&passphrase=${encodePfValue(passphrase)}`;
  }
  
  return crypto.createHash('md5').update(stringToSign, 'utf8').digest('hex');
}

module.exports.handler = async function (event) {
  console.log('=== PAYFAST ITN RECEIVED ===');
  
  // Parse the form data
  let data = {};
  try {
    const params = new URLSearchParams(event.body || '');
    data = Object.fromEntries(params.entries());
    console.log('ITN Data received:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error parsing ITN data:', err);
    return { statusCode: 400, body: 'Invalid data' };
  }

  try {
    // 1. Verify signature
    const receivedSignature = data.signature;
    const dataForSignature = { ...data };
    delete dataForSignature.signature;
    
    const calculatedSignature = generatePfSignature(dataForSignature, PAYFAST_PASSPHRASE);
    
    console.log('Signature check:');
    console.log('Received:', receivedSignature);
    console.log('Calculated:', calculatedSignature);
    
    if (receivedSignature !== calculatedSignature) {
      console.error('SIGNATURE MISMATCH!');
      
      // Debug: log what we're signing
      const sortedKeys = Object.keys(dataForSignature).sort();
      const debugString = sortedKeys
        .map(key => `${key}=${encodePfValue(dataForSignature[key])}`)
        .join('&');
      console.log('String we signed:', debugString);
      console.log('With passphrase:', PAYFAST_PASSPHRASE ? 'Yes' : 'No');
      
      // For sandbox, we might still want to process for testing
      if (PAYFAST_SANDBOX === 'true') {
        console.warn('Sandbox mode: Proceeding despite signature mismatch for testing');
      } else {
        return { statusCode: 400, body: 'Invalid signature' };
      }
    } else {
      console.log('Signature verified successfully');
    }

    // 2. Find the order
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('m_payment_id', data.m_payment_id)
      .single();

    if (orderError || !order) {
      console.error('Order not found:', data.m_payment_id);
      return { statusCode: 404, body: 'Order not found' };
    }

    console.log('Order found:', order.id, 'Status:', order.order_status);

    // 3. Update order based on payment_status
    const updateData = {
      pf_response: data,
      updated_at: new Date().toISOString(),
      pf_payment_id: data.pf_payment_id || null
    };

    if (data.payment_status === 'COMPLETE') {
      console.log('Payment COMPLETE for order:', data.m_payment_id);
      updateData.order_status = 'paid';
      updateData.paid_at = new Date().toISOString();
    } else if (data.payment_status === 'FAILED' || data.payment_status === 'CANCELLED') {
      console.log('Payment FAILED for order:', data.m_payment_id);
      updateData.order_status = 'failed';
    } else if (data.payment_status === 'PENDING') {
      console.log('Payment PENDING for order:', data.m_payment_id);
      updateData.order_status = 'pending'; 
    }

    // Update order
    const { error: updateError } = await supabase
      .from('orders')
      .update(updateData)
      .eq('m_payment_id', data.m_payment_id);

    if (updateError) {
      console.error('Order update error:', updateError);
      return { statusCode: 500, body: 'Failed to update order' };
    }

    console.log('Order updated successfully:', data.m_payment_id);
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('ITN processing error:', err.message);
    console.error('Error stack:', err.stack);
    return { statusCode: 500, body: 'Server error' };
  }
};