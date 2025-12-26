// netlify/functions/payfast-itn.js
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const {
  PAYFAST_MERCHANT_ID,
  PAYFAST_MERCHANT_KEY,
  PAYFAST_PASSPHRASE = '', // MUST match initiate-payfast.js
  PAYFAST_SANDBOX = 'true',
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// EXACT SAME as initiate-payfast.js
function encodePfValue(value) {
  if (value === null || value === undefined) return '';
  return encodeURIComponent(String(value)); // %20 NOT +
}

// EXACT SAME as initiate-payfast.js
function generatePfSignature(params, passphrase = '') {
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys
    .map(key => `${key}=${encodePfValue(params[key])}`)
    .join('&');
  
  // ALWAYS include passphrase
  return crypto.createHash('md5').update(`${paramString}&passphrase=${encodePfValue(passphrase)}`, 'utf8').digest('hex');
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

  // Verify signature
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
    console.log('String we hashed:', `${debugString}&passphrase=${encodePfValue(PAYFAST_PASSPHRASE)}`);
    
    return { statusCode: 400, body: 'Invalid signature' };
  }
  
  console.log('Signature verified - ITN processed');
  return { statusCode: 200, body: 'OK' };
};