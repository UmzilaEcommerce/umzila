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
        // Only public values (URL + anon key + flags). Every page waits on
        // this before it can load anything, so: browsers reuse it for an hour
        // (and keep using it while refreshing in the background for a day),
        // and Netlify's CDN answers it from the edge without running this
        // function (a visitor never waits on a cold start; 2,000 visitors =
        // a handful of invocations, not 2,000). A redeploy clears the CDN copy.
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
        "Netlify-CDN-Cache-Control": "public, durable, max-age=3600, stale-while-revalidate=86400"
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
