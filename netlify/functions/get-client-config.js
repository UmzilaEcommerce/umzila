// netlify/functions/get-client-config.js
module.exports.handler = async function () {
  try {
    const payload = {
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
      payfastSandbox: process.env.PAYFAST_SANDBOX === 'true',
      siteBaseUrl: (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '')
      // payfastMerchantId, payfastMerchantKey, payfastPassphrase intentionally excluded —
      // PayFast secrets must never be exposed to the frontend.
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        // Only public values (URL + anon key + flags) — let browsers reuse
        // them for 10 minutes instead of a function round trip on every page.
        "Cache-Control": "public, max-age=600"
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
