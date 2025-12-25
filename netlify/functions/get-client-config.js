// netlify/functions/get-client-config.js
module.exports.handler = async function () {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify({
      SUPABASE_URL: process.env.SUPABASE_URL || null,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || null
    })
  };
};
