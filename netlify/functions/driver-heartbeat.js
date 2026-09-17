// netlify/functions/driver-heartbeat.js
//
// Delivery network Stage 8 — a driver's own client (logistics.html) calls
// this repeatedly while a rep has the delivery panel open, to report
// online/offline status and (while online) their current position. This is
// also how a rep's account *becomes* a driver in the first place: the first
// call for a given auth.uid() with no existing `drivers` row self-registers
// one, matching this repo's convention of not needing separate manual
// seeding (see toggle-favourite.js's identical anonymous/first-touch pattern
// for a different table).
//
// Never trusts a client-supplied driverId/userId -- the caller's identity is
// always resolved from their own auth token first.
const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const DRIVER_SELECT_COLUMNS = 'id, user_id, is_online, last_seen_at, last_location_at, heading, speed, vehicle_description, can_do_scheduled_collections, can_do_live_delivery, eligibility_status';

function toFiniteNumber(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (typeof body.isOnline !== 'boolean') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'isOnline (boolean) required' }) };
  }
  const isOnline = body.isOnline;

  // A location update only happens when BOTH lat and lon are valid finite
  // numbers in range -- going offline (or a heartbeat with no fix yet)
  // should never be blocked on having a location to send.
  const lat = toFiniteNumber(body.lat);
  const lon = toFiniteNumber(body.lon);
  const hasLocation = lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  const heading = toFiniteNumber(body.heading);
  const speed = toFiniteNumber(body.speed);

  const nowIso = new Date().toISOString();

  const { data: existing, error: lookupError } = await admin
    .from('drivers')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (lookupError) {
    console.error('driver-heartbeat: lookup failed', lookupError.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to look up driver record' }) };
  }

  let driverRow;
  if (!existing) {
    // First-ever heartbeat for this user -- self-register as a driver
    // (this is intentionally how a rep's account becomes a driver; no
    // separate onboarding/seeding step exists or is needed for the pilot).
    const insertPayload = { user_id: user.id, is_online: isOnline, last_seen_at: nowIso };
    if (hasLocation) {
      insertPayload.last_location = `SRID=4326;POINT(${lon} ${lat})`;
      insertPayload.last_location_at = nowIso;
      if (heading !== null) insertPayload.heading = heading;
      if (speed !== null) insertPayload.speed = speed;
    }
    const { data: inserted, error: insertError } = await admin
      .from('drivers')
      .insert(insertPayload)
      .select(DRIVER_SELECT_COLUMNS)
      .single();
    if (insertError) {
      console.error('driver-heartbeat: self-registration failed', insertError.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to register driver' }) };
    }
    driverRow = inserted;
  } else {
    const patch = { is_online: isOnline, last_seen_at: nowIso };
    if (hasLocation) {
      patch.last_location = `SRID=4326;POINT(${lon} ${lat})`;
      patch.last_location_at = nowIso;
      if (heading !== null) patch.heading = heading;
      if (speed !== null) patch.speed = speed;
    }
    const { data: updated, error: updateError } = await admin
      .from('drivers')
      .update(patch)
      .eq('id', existing.id)
      .select(DRIVER_SELECT_COLUMNS)
      .single();
    if (updateError) {
      console.error('driver-heartbeat: update failed', updateError.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update driver record' }) };
    }
    driverRow = updated;
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, driver: driverRow }) };
};
