import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import fetch from 'node-fetch';

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
  // PayFast requires uppercase URL encoding and spaces as +
  return encodeURIComponent(String(value))
    .replace(/%[0-9a-f]{2}/g, match => match.toUpperCase())  // Ensure uppercase
    .replace(/%20/g, '+');  // Spaces as +
}

function generatePfSignature(params, passphrase = '') {
  // Define EXACT order as per PayFast documentation (same as initiate-payfast)
  const orderedKeys = [
    'merchant_id',
    'merchant_key',
    'return_url',
    'cancel_url',
    'notify_url',
    'name_first',
    'name_last',
    'email_address',
    'cell_number',
    'm_payment_id',
    'amount',
    'item_name',
    'item_description',
    'email_confirmation',
    'confirmation_address'
  ];
  
  // Filter out empty values and build string in correct order
  let paramString = '';
  
  orderedKeys.forEach(key => {
    if (params[key] !== undefined && params[key] !== '' && params[key] !== null) {
      if (paramString !== '') paramString += '&';
      paramString += `${key}=${encodePfValue(params[key])}`;
    }
  });
  
  // Add passphrase if exists
  const stringToSign = passphrase 
    ? `${paramString}&passphrase=${encodePfValue(passphrase)}`
    : paramString;
  
  return crypto.createHash('md5').update(stringToSign).digest('hex');
}

export async function handler(event) {
  // PayFast sends data as form-urlencoded
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

    // 2. Server-to-server validation with PayFast
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

    // 3. Find the order
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('m_payment_id', data.m_payment_id)
      .single();

    if (orderError || !order) {
      console.error('Order not found:', data.m_payment_id);
      return { statusCode: 404, body: 'Order not found' };
    }

    // 4. Check if already processed
    if (order.status === 'paid') {
      return { statusCode: 200, body: 'OK (already processed)' };
    }

    // 5. Verify payment status
    const paymentStatus = data.payment_status;
    
    if (paymentStatus === 'COMPLETE') {
      // Update order status
      const { error: updateError } = await supabase
        .from('orders')
        .update({
          status: 'paid',
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

      // Reserve stock (call the PostgreSQL function)
      const { error: stockError } = await supabase.rpc('reserve_stock', {
        order_items: order.raw_cart
      });

      if (stockError) {
        console.error('Stock reservation error:', stockError);
        // Log error but don't fail - we can handle stock manually
      }

      console.log(`Order ${data.m_payment_id} marked as paid`);
    } else if (paymentStatus === 'FAILED' || paymentStatus === 'CANCELLED') {
      // Mark as failed
      await supabase
        .from('orders')
        .update({
          status: 'failed',
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
}