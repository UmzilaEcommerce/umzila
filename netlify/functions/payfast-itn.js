// netlify/functions/payfast-itn.js
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

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

// encode spaces as + for PayFast - MUST BE IDENTICAL TO INITIATE-PAYFAST.JS
function encodePfValue(value) {
  return encodeURIComponent(value === null || value === undefined ? '' : String(value)).replace(/%20/g, '+');
}

// Sort keys and build param string to sign - MUST BE IDENTICAL TO INITIATE-PAYFAST.JS
function generatePfSignature(params, passphrase = '') {
  // PayFast requires ALL parameters in the signature, even empty ones
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map(k => `${k}=${encodePfValue(params[k])}`)
    .join('&');
  
  if (passphrase && passphrase.trim() !== '') {
    return crypto.createHash('md5').update(paramString + `&passphrase=${encodePfValue(passphrase)}`, 'utf8').digest('hex');
  }
  return crypto.createHash('md5').update(paramString, 'utf8').digest('hex');
}

module.exports.handler = async function (event) {
  console.log('PayFast ITN received:', new Date().toISOString());
  
  // Log headers for debugging
  console.log('Headers:', JSON.stringify(event.headers, null, 2));
  
  // PayFast sends form-urlencoded data
  let data = {};
  try {
    const params = new URLSearchParams(event.body || '');
    data = Object.fromEntries(params.entries());
    console.log('Received PayFast data:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error parsing PayFast data:', err);
    return { statusCode: 400, body: 'Invalid data format' };
  }

  try {
    // 1. Verify signature
    const receivedSignature = data.signature;
    // Remove signature from data for recalculation
    const dataForSignature = { ...data };
    delete dataForSignature.signature;
    
    // Also remove any other fields that shouldn't be in signature
    // PayFast documentation says to remove 'signature' only
    
    const calculatedSignature = generatePfSignature(dataForSignature, PAYFAST_PASSPHRASE);
    
    console.log('Signature verification:');
    console.log('Received signature:', receivedSignature);
    console.log('Calculated signature:', calculatedSignature);
    console.log('Passphrase used:', PAYFAST_PASSPHRASE ? 'YES' : 'NO');
    
    if (receivedSignature !== calculatedSignature) {
      console.error('Signature mismatch!');
      console.error('Data for signature:', JSON.stringify(dataForSignature, null, 2));
      
      // Log the actual string that was hashed for debugging
      const sortedKeys = Object.keys(dataForSignature).sort();
      const paramString = sortedKeys
        .map(k => `${k}=${encodePfValue(dataForSignature[k])}`)
        .join('&');
      const stringToHash = PAYFAST_PASSPHRASE && PAYFAST_PASSPHRASE.trim() !== '' 
        ? paramString + `&passphrase=${encodePfValue(PAYFAST_PASSPHRASE)}`
        : paramString;
      console.error('String that was hashed:', stringToHash);
      
      return { statusCode: 400, body: 'Invalid signature' };
    }
    
    console.log('Signature verified successfully');

    // 2. Validate server-to-server with PayFast (optional but recommended)
    try {
      const validateResp = await fetch(PAYFAST_VALIDATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          merchant_id: PAYFAST_MERCHANT_ID,
          merchant_key: PAYFAST_MERCHANT_KEY,
          signature: calculatedSignature,
          m_payment_id: data.m_payment_id
        })
      });

      const validateText = await validateResp.text();
      console.log('PayFast validation response:', validateText);
      
      if (!validateText.includes('VALID')) {
        console.error('PayFast validation failed:', validateText);
        // Note: We don't return error here because some sandbox transactions might not validate
        // In production, you might want to be stricter
      } else {
        console.log('PayFast validation successful');
      }
    } catch (validateErr) {
      console.warn('PayFast validation request failed (might be OK for sandbox):', validateErr.message);
    }

    // 3. Find the order by m_payment_id
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('m_payment_id', data.m_payment_id)
      .single();

    if (orderError || !order) {
      console.error('Order not found:', data.m_payment_id, 'Error:', orderError);
      return { statusCode: 404, body: 'Order not found' };
    }

    console.log('Order found:', order.id, 'Current status:', order.order_status);

    // 4. Check if already paid to avoid duplicate processing
    if (order.order_status === 'paid' || order.order_status === 'completed') {
      console.log('Order already paid, returning OK');
      return { statusCode: 200, body: 'OK (already processed)' };
    }

    // 5. Update order based on payment_status
    let updateData = {
      pf_response: data,
      updated_at: new Date().toISOString()
    };

    if (data.payment_status === 'COMPLETE') {
      console.log('Payment COMPLETE for order:', data.m_payment_id);
      
      updateData.order_status = 'paid';
      updateData.pf_payment_id = data.pf_payment_id;
      updateData.paid_at = new Date().toISOString();
      
      // Process referral rewards if applicable
      if (order.customer_email) {
        try {
          // Get user profile by email
          const { data: profile } = await supabase
            .from('profiles')
            .select('user_id, referred_by')
            .eq('email', order.customer_email)
            .single();
          
          if (profile && profile.referred_by) {
            console.log('Processing referral reward for user:', profile.user_id);
            
            // Check if reward already processed
            const { data: existingReward } = await supabase
              .from('referral_tracking')
              .select('id, status')
              .eq('referee_id', profile.user_id)
              .eq('status', 'completed')
              .single();
            
            if (!existingReward) {
              // Create referral reward discount for referrer
              const referralCode = `REF${Date.now().toString().slice(-6)}${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
              const expiresAt = new Date();
              expiresAt.setMonth(expiresAt.getMonth() + 3);
              
              const { data: reward } = await supabase
                .from('discount_codes')
                .insert([{
                  code: referralCode,
                  amount: 40.00,
                  user_id: profile.referred_by,
                  used: false,
                  expires_at: expiresAt.toISOString(),
                  type: 'referral_reward',
                  created_at: new Date().toISOString()
                }])
                .select()
                .single();
              
              if (reward) {
                console.log('Created referral reward discount:', referralCode);
                
                // Update referral tracking
                await supabase
                  .from('referral_tracking')
                  .update({
                    status: 'completed',
                    completed_at: new Date().toISOString(),
                    reward_code: referralCode
                  })
                  .eq('referee_id', profile.user_id)
                  .eq('referrer_id', profile.referred_by);
              }
            }
          }
        } catch (referralErr) {
          console.warn('Referral processing error (non-critical):', referralErr.message);
        }
      }
      
    } else if (data.payment_status === 'FAILED' || data.payment_status === 'CANCELLED') {
      console.log('Payment FAILED/CANCELLED for order:', data.m_payment_id);
      updateData.order_status = 'failed';
    } else if (data.payment_status === 'PENDING') {
      console.log('Payment PENDING for order:', data.m_payment_id);
      updateData.order_status = 'pending';
    } else {
      console.log('Unknown payment status:', data.payment_status, 'for order:', data.m_payment_id);
      updateData.order_status = 'pending';
    }

    // Update the order
    const { error: updateError } = await supabase
      .from('orders')
      .update(updateData)
      .eq('m_payment_id', data.m_payment_id);

    if (updateError) {
      console.error('Order update error:', updateError);
      return { statusCode: 500, body: 'Failed to update order' };
    }

    // 6. If payment is complete, update stock
    if (data.payment_status === 'COMPLETE' && order.items) {
      try {
        console.log('Updating stock for order items');
        
        for (const item of order.items) {
          // First, check if there are variants for this product
          const { data: variants } = await supabase
            .from('product_variants')
            .select('*')
            .eq('product_id', item.product_id);
          
          if (variants && variants.length > 0) {
            // Update variant stock based on size if available
            // Note: You might need to store the selected size in order.items
            // For now, we'll update the first variant or you need to adjust
            if (item.size) {
              const { error: variantUpdateError } = await supabase
                .from('product_variants')
                .update({ 
                  stock: supabase.raw(`GREATEST(stock - ${item.quantity}, 0)`),
                  updated_at: new Date().toISOString()
                })
                .eq('product_id', item.product_id)
                .eq('size', item.size);
              
              if (variantUpdateError) {
                console.error('Variant stock update error:', variantUpdateError);
              }
            }
          }
          
          // Also update main product stock
          const { error: productUpdateError } = await supabase
            .from('products')
            .update({ 
              stock: supabase.raw(`GREATEST(stock - ${item.quantity}, 0)`),
              updated_at: new Date().toISOString()
            })
            .eq('id', item.product_id);
          
          if (productUpdateError) {
            console.error('Product stock update error:', productUpdateError);
          }
        }
        
        console.log('Stock updated successfully');
      } catch (stockErr) {
        console.error('Stock update error:', stockErr);
        // Don't fail the ITN if stock update fails - we can fix manually
      }
    }

    console.log('ITN processed successfully for order:', data.m_payment_id);
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('ITN processing error:', err);
    console.error('Error stack:', err.stack);
    return { statusCode: 500, body: 'Server error: ' + err.message };
  }
};