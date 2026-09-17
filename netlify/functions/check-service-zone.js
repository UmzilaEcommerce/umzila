// netlify/functions/check-service-zone.js
//
// Delivery network (plan §20): checks whether a lat/lon coordinate falls
// inside an approved Umzila service zone (service_zones table). Read-only
// public geo lookup — uses the anon key (RLS allows public SELECT on
// service_zones, and the RPC below is GRANTed to anon/authenticated), same
// as other public-facing read checks in this codebase (get-client-config.js).
//
// This function's only job is the zone eligibility check — no routing,
// pricing, or anything else lives here.
const { createClient } = require('@supabase/supabase-js');

function toFiniteNumber(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

exports.handler = async function (event, context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    // Liberal about input naming — this will be called from more than one page.
    const lat = toFiniteNumber(body.lat ?? body.latitude);
    const lon = toFiniteNumber(body.lon ?? body.lng ?? body.longitude);

    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid or missing lat/lon coordinates' })
      };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const { data, error } = await supabase.rpc('find_service_zone_for_point', {
      p_lat: lat,
      p_lon: lon
    });

    if (error) {
      console.error('check-service-zone: rpc error', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to check service zone' }) };
    }

    const zone = Array.isArray(data) ? data[0] : data;

    if (!zone || zone.zone_type === 'restricted') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          eligible: false,
          reason: "We can't deliver to this address yet. This location is currently outside Umzila's delivery area."
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        eligible: true,
        zone_id: zone.id,
        zone_name: zone.name,
        zone_type: zone.zone_type
      })
    };

  } catch (err) {
    console.error('check-service-zone error', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error', details: err.message }) };
  }
};
