// netlify/functions/confirm-delivery-pin.js
//
// Delivery network Stage 13 (delivery-network-spec.md §E) — the ONLY place
// a delivery may ever be marked DELIVERED. Plan §65/§163 and design
// principle #10 ("no PIN, no completed delivery") are enforced here, not
// as a suggestion: a wrong PIN never changes delivery status at all (stays
// PIN_REQUIRED), and after 5 wrong attempts the delivery is locked
// (pin_locked_at) and further attempts are refused outright -- this goes
// beyond the plan's own literal text (§163 only says "log the failed
// attempt" and defers limiting to "a future rule"), added now because an
// unlimited-attempt 4-digit PIN is a real, cheap-to-close security gap.
//
// Known limitation, not silently hidden: there is no admin UI yet (Stage
// 16, not built) to unlock a delivery once pin_locked_at is set -- it's
// recorded as a delivery_events row (PIN_LOCKED) so a future admin surface
// has the data, but unlocking today means a direct DB update. Acceptable
// for a 2-rider pilot where the founders can look up the real PIN
// themselves if truly stuck; tracked for Stage 16.
//
// On a match: marks the drop stop completed, and if that was the route's
// last remaining stop, marks the route completed too -- which fires
// Stage 10's compute_driver_payout_on_route_completion trigger. This
// generalizes correctly to a future multi-stop route (Stage 11) without
// rework: it checks "are ALL this route's stops completed", not "is this
// the only stop".
const { createClient } = require('@supabase/supabase-js');
const { transitionDelivery } = require('./lib/delivery-state');

const MAX_PIN_ATTEMPTS = 5;

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

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

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };

  const { data: callerDriver, error: driverLookupError } = await admin.from('drivers').select('id').eq('user_id', user.id).maybeSingle();
  if (driverLookupError) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to look up driver record' }) };
  if (!callerDriver) return { statusCode: 403, headers, body: JSON.stringify({ error: 'No driver record for this account' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const { deliveryId, pin } = body;
  if (!deliveryId || typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'deliveryId and a 4-digit pin are required' }) };
  }

  const { data: delivery, error: deliveryError } = await admin
    .from('deliveries')
    .select('id, status, delivery_pin, pin_attempt_count, pin_locked_at, route_id')
    .eq('id', deliveryId)
    .maybeSingle();
  if (deliveryError) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to look up delivery' }) };
  if (!delivery) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Delivery not found' }) };

  // Ownership: the caller must be the driver on the route this delivery's
  // drop stop belongs to -- never trust a client-supplied driver/route id.
  const { data: dropStop, error: stopError } = await admin
    .from('route_stops')
    .select('id, route_id, status')
    .eq('delivery_id', deliveryId)
    .eq('stop_type', 'drop')
    .maybeSingle();
  if (stopError) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to look up delivery route' }) };
  if (!dropStop) return { statusCode: 404, headers, body: JSON.stringify({ error: 'No route found for this delivery' }) };

  const { data: route, error: routeError } = await admin.from('routes').select('id, driver_id').eq('id', dropStop.route_id).maybeSingle();
  if (routeError || !route || route.driver_id !== callerDriver.id) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'This delivery is not assigned to you' }) };
  }

  if (delivery.pin_locked_at) {
    return { statusCode: 423, headers, body: JSON.stringify({ error: 'Too many incorrect attempts. This delivery is locked pending admin review.' }) };
  }
  if (!['ARRIVING', 'PIN_REQUIRED'].includes(delivery.status)) {
    return { statusCode: 409, headers, body: JSON.stringify({ error: `Delivery is not ready for PIN confirmation (currently ${delivery.status})` }) };
  }

  // First attempt at this stop formally enters PIN_REQUIRED (a no-op state-
  // wise if it's already there — transitionDelivery would just reject
  // PIN_REQUIRED->PIN_REQUIRED as invalid, so only attempt it from ARRIVING).
  if (delivery.status === 'ARRIVING') {
    const enterResult = await transitionDelivery(admin, deliveryId, 'PIN_REQUIRED', { type: 'driver', id: callerDriver.id }, { eventType: 'PIN_REQUIRED' });
    if (!enterResult.ok) {
      return { statusCode: enterResult.reason === 'conflict' ? 409 : 500, headers, body: JSON.stringify({ error: 'Could not start PIN confirmation', detail: enterResult.detail || enterResult.reason }) };
    }
  }

  const pinMatches = delivery.delivery_pin && pin === delivery.delivery_pin;

  if (!pinMatches) {
    const newAttemptCount = (delivery.pin_attempt_count || 0) + 1;
    const willLock = newAttemptCount >= MAX_PIN_ATTEMPTS;
    const patch = { pin_attempt_count: newAttemptCount };
    if (willLock) patch.pin_locked_at = new Date().toISOString();
    const { error: updateError } = await admin.from('deliveries').update(patch).eq('id', deliveryId);
    if (updateError) console.warn('confirm-delivery-pin: failed to record failed attempt', updateError.message);

    await admin.from('delivery_events').insert({
      delivery_id: deliveryId,
      event_type: willLock ? 'PIN_LOCKED' : 'PIN_FAILED',
      actor_type: 'driver',
      actor_id: callerDriver.id,
      metadata: { attempt_count: newAttemptCount }
    });

    if (willLock) {
      return { statusCode: 423, headers, body: JSON.stringify({ error: 'Too many incorrect attempts. This delivery is now locked pending admin review.' }) };
    }
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'PIN incorrect. Please try again.', attemptsRemaining: MAX_PIN_ATTEMPTS - newAttemptCount }) };
  }

  // ── Match: atomically mark delivered, complete the stop, and (if this was
  // the route's last stop) complete the route -- which fires the payout
  // trigger. Sequenced carefully, not a single DB transaction (Supabase JS
  // doesn't give us one across tables here), but each step is itself
  // guarded (transitionDelivery's optimistic-concurrency check; the stop/
  // route updates are simple terminal-state writes with low conflict risk).
  const transitionResult = await transitionDelivery(admin, deliveryId, 'DELIVERED', { type: 'driver', id: callerDriver.id }, { eventType: 'DELIVERED', metadata: { drop_stop_id: dropStop.id } });
  if (!transitionResult.ok) {
    return { statusCode: transitionResult.reason === 'conflict' ? 409 : 500, headers, body: JSON.stringify({ error: 'Could not confirm delivery', detail: transitionResult.detail || transitionResult.reason }) };
  }

  const nowIso = new Date().toISOString();
  await admin.from('route_stops').update({ status: 'completed', completed_at: nowIso }).eq('id', dropStop.id);

  const { data: remainingStops } = await admin.from('route_stops').select('status').eq('route_id', route.id);
  const allStopsCompleted = Array.isArray(remainingStops) && remainingStops.length > 0 && remainingStops.every(s => s.status === 'completed');
  if (allStopsCompleted) {
    await admin.from('routes').update({ status: 'completed', completed_at: nowIso }).eq('id', route.id).eq('status', 'active');
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, delivery: transitionResult.delivery, routeCompleted: allStopsCompleted }) };
};
