// netlify/functions/get-delivery-route.js
//
// The road route from the rider's live position to THIS customer, for the
// line on track.html's map. GET ?order=<order id>&t=<tracking token>
// (or a signed-in owner's Bearer token). Never takes coordinates from the
// browser: positions come from get_delivery_tracking(), which only returns the
// rider's position while they're heading to this customer
// (IN_ROUTE…PIN_REQUIRED) — so nobody can follow a rider to someone else.
// → { path: [[lat, lon], …], distanceKm, durationMin } | { path: null }
const { createClient } = require('@supabase/supabase-js');
const { getRoadPath } = require('./lib/road-distance');

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  const q = event.queryStringParameters || {};
  const order = String(q.order || ''), token = String(q.t || '');
  if (!UUID.test(order) || (token && !UUID.test(token))) return { statusCode: 400, headers, body: JSON.stringify({ error: 'bad_request' }) };

  // Run the tracking RPC as the caller: the private-link token, or the
  // signed-in owner's session (auth.uid()).
  const auth = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: auth ? { headers: { Authorization: 'Bearer ' + auth } } : undefined
  });
  const { data, error } = await sb.rpc('get_delivery_tracking', { p_order_id: order, p_token: token || null });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) return { statusCode: 404, headers, body: JSON.stringify({ path: null }) };
  const ok = n => Number.isFinite(Number(n)) && n !== null;
  if (!ok(row.driver_lat) || !ok(row.driver_lon) || !ok(row.destination_lat) || !ok(row.destination_lon)) {
    return { statusCode: 200, headers, body: JSON.stringify({ path: null }) };
  }
  const r = await getRoadPath({ lat: Number(row.driver_lat), lon: Number(row.driver_lon) }, { lat: Number(row.destination_lat), lon: Number(row.destination_lon) });
  return { statusCode: 200, headers, body: JSON.stringify(r || { path: null }) };
};
