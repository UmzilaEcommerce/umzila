// netlify/functions/check-email-exists.js
//
// Powers checkout's adaptive "create a password" vs "welcome back, sign in"
// field — the buyer types an email, this returns whether an account
// already exists for it. Returns ONLY a boolean, never any profile data,
// so it's safe to call before the buyer has authenticated.
const { createClient } = require('@supabase/supabase-js');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

exports.handler = async function (event, context) {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { email } = JSON.parse(event.body || '{}');
    const trimmed = (email || '').toString().trim().toLowerCase();

    if (!EMAIL_RE.test(trimmed)) {
      return { statusCode: 200, headers, body: JSON.stringify({ exists: false }) };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
    }

    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await supabase
      .from('profiles')
      .select('id')
      .ilike('email', trimmed)
      .limit(1);

    if (error) {
      console.error('check-email-exists: query error', error);
      return { statusCode: 200, headers, body: JSON.stringify({ exists: false }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ exists: !!(data && data.length) }) };

  } catch (err) {
    console.error('check-email-exists error', err);
    // Never block checkout on this check failing — default to "new".
    return { statusCode: 200, headers, body: JSON.stringify({ exists: false }) };
  }
};
