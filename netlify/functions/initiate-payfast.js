import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const {
  PAYFAST_MERCHANT_ID,
  PAYFAST_MERCHANT_KEY,
  PAYFAST_PASSPHRASE = '',
  PAYFAST_SANDBOX = 'false', // use false for production
  SITE_BASE_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

const PAYFAST_URL = PAYFAST_SANDBOX === 'true'
  ? 'https://sandbox.payfast.co.za/eng/process'
  : 'https://www.payfast.co.za/eng/process';

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
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { cartItems, customerEmail, customerName = '' } = JSON.parse(event.body);

    if (!cartItems?.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Cart empty' }) };
    if (!customerEmail) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email required' }) };

    // Calculate total
    let totalAmount = 0;
    const validatedItems = [];

    for (const item of cartItems) {
      const { data: product } = await supabase.from('products').select('id, price, sale_price, stock, name').eq('id', item.product_id).single();
      if (!product) return { statusCode: 400, headers, body: JSON.stringify({ error: `Product ${item.product_id} not found` }) };
      if (product.stock < item.quantity) return { statusCode: 400, headers, body: JSON.stringify({ error: `Insufficient stock for ${product.name}` }) };

      const price = product.sale_price || product.price;
      totalAmount += price * item.quantity;

      validatedItems.push({ product_id: product.id, name: product.name, unit_price: price, quantity: item.quantity, total: price * item.quantity });
    }

    totalAmount = Math.round(totalAmount * 100) / 100;
    const m_payment_id = `UMZILA-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // Create order
    const { data: order, error: orderError } = await supabase.from('orders').insert([{
      customer_email: customerEmail,
      customer_name: customerName,
      total: totalAmount,
      items: validatedItems,
      order_status: 'pending_payment',
      m_payment_id,
      created_at: new Date().toISOString()
    }]).select().single();

    if (orderError) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create order' }) };

    // PayFast params
    const pfParams = {
      merchant_id: PAYFAST_MERCHANT_ID,
      merchant_key: PAYFAST_MERCHANT_KEY,
      return_url: `${SITE_BASE_URL}/checkout-success.html?payment_status=COMPLETE&m_payment_id=${m_payment_id}`,
      cancel_url: `${SITE_BASE_URL}/checkout-cancel.html?payment_status=CANCELLED&m_payment_id=${m_payment_id}`,
      notify_url: `${SITE_BASE_URL}/.netlify/functions/payfast-itn`,
      name_first: '',
      name_last: '',
      email_address: customerEmail,
      m_payment_id,
      amount: totalAmount.toFixed(2),
      item_name: `Umzila Order #${m_payment_id}`,
      item_description: `${validatedItems.length} item(s) from Umzila`,
      email_confirmation: '1',
      confirmation_address: customerEmail
    };

    const signature = generatePfSignature(pfParams, PAYFAST_PASSPHRASE);

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, order_id: order.id, m_payment_id, payfast_url: PAYFAST_URL, params: pfParams, signature, amount: totalAmount }) };

  } catch (err) {
    console.error('Payment function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
}
