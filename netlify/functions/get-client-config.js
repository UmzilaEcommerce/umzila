// netlify/functions/get-client-config.js
module.exports.handler = async function () {
  try {
    const payload = {
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
      // optional PayFast mapping
      payfastMerchantId: process.env.PAYFAST_MERCHANT_ID || '',
      payfastMerchantKey: process.env.PAYFAST_MERCHANT_KEY || '',
      payfastPassphrase: process.env.PAYFAST_PASSPHRASE || '',
      payfastSandbox: process.env.PAYFAST_SANDBOX === 'true'
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify(payload)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ error: err.message })
    };
  }
};
