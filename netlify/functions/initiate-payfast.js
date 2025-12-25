import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// Environment variables (set these in Netlify dashboard)
const {
  PAYFAST_MERCHANT_ID,
  PAYFAST_MERCHANT_KEY,
  PAYFAST_PASSPHRASE = '',
  PAYFAST_SANDBOX = 'true',
  SITE_BASE_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

const PAYFAST_URL = PAYFAST_SANDBOX === 'true'
  ? 'https://sandbox.payfast.co.za/eng/process'
  : 'https://www.payfast.co.za/eng/process';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// PayFast requires this specific encoding
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

export async function handler(event) {
  // CORS headers
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const body = JSON.parse(event.body);
    const { cartItems, customerEmail, customerFirst = '', customerLast = '' } = body;

    if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Cart is empty' })
      };
    }

    if (!customerEmail) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Customer email is required' })
      };
    }

    // 1. Validate cart items and calculate total from database
    let totalAmount = 0;
    const validatedItems = [];
    
    for (const item of cartItems) {
      const { data: product, error } = await supabase
        .from('products')
        .select('id, price, stock, name, sale_price')
        .eq('id', item.product_id)
        .single();

      if (error || !product) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: `Product ${item.product_id} not found` })
        };
      }

      if (product.stock < item.quantity) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ 
            error: `Insufficient stock for ${product.name}. Available: ${product.stock}` 
          })
        };
      }

      const price = product.sale_price || product.price;
      const itemTotal = price * item.quantity;
      totalAmount += itemTotal;

      validatedItems.push({
        product_id: product.id,
        name: product.name,
        unit_price: price,
        quantity: item.quantity,
        total: itemTotal
      });
    }

    // Round to 2 decimal places
    totalAmount = Math.round(totalAmount * 100) / 100;

    // 2. Create unique payment ID
    const m_payment_id = `UMZILA-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // 3. Create order in database (with pending status)
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert([{
        m_payment_id,
        customer_email: customerEmail,
        customer_first: customerFirst, 
        customer_last: customerLast,
        total: totalAmount,
        raw_cart: validatedItems,
        status: 'pending_payment',
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (orderError) {
      console.error('Order creation error:', orderError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to create order' })
      };
    }

    // 4. Prepare PayFast parameters
    const pfParams = {
      merchant_id: PAYFAST_MERCHANT_ID,
      merchant_key: PAYFAST_MERCHANT_KEY,
      return_url: `${SITE_BASE_URL}/checkout-success.html?payment_status=COMPLETE&m_payment_id=${m_payment_id}`,
      cancel_url: `${SITE_BASE_URL}/checkout-cancel.html?payment_status=CANCELLED&m_payment_id=${m_payment_id}`,
      notify_url: `${SITE_BASE_URL}/.netlify/functions/payfast-itn`,
      name_first: customerFirst,
      name_last: customerLast,
      email_address: customerEmail,
      m_payment_id: m_payment_id,
      amount: totalAmount.toFixed(2),
      item_name: `Umzila Order #${m_payment_id}`,
      item_description: `${validatedItems.length} item(s) from Umzila`,
      email_confirmation: '1',
      confirmation_address: customerEmail
    };

    // 5. Generate signature
    const signature = generatePfSignature(pfParams, PAYFAST_PASSPHRASE);

    // 6. Return PayFast data to client
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        order_id: order.id,
        m_payment_id,
        payfast_url: PAYFAST_URL,
        params: pfParams,
        signature,
        amount: totalAmount
      })
    };

  } catch (error) {
    console.error('Server error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      })
    };
  }
}