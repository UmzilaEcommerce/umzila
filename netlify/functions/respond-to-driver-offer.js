// netlify/functions/respond-to-driver-offer.js
//
// Delivery network Stage 8 — a driver accepts or declines a driver_offers row
// created by lib/dispatch.js. Never trusts a client-supplied driverId: the
// offer's driver_id is always checked against the caller's OWN `drivers` row,
// resolved from their auth token.
//
// All deliveries.status changes still go exclusively through
// transitionDelivery() (lib/delivery-state.js).
const { createClient } = require('@supabase/supabase-js');
const { transitionDelivery } = require('./lib/delivery-state');

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

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: { user }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { offerId, response } = body;
  if (!offerId || typeof offerId !== 'string' || !['accept', 'decline'].includes(response)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "offerId and response ('accept'|'decline') required" }) };
  }

  // Resolve the caller's OWN driver row -- this is the only source of truth
  // for "is this offer theirs", never a client-supplied id.
  const { data: callerDriver, error: driverLookupError } = await admin
    .from('drivers')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (driverLookupError) {
    console.error('respond-to-driver-offer: driver lookup failed', driverLookupError.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to look up driver record' }) };
  }
  if (!callerDriver) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'No driver record for this account' }) };
  }

  const { data: offer, error: offerError } = await admin
    .from('driver_offers')
    .select('id, delivery_id, driver_id, status, expires_at')
    .eq('id', offerId)
    .maybeSingle();
  if (offerError) {
    console.error('respond-to-driver-offer: offer lookup failed', offerError.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to look up offer' }) };
  }
  if (!offer) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Offer not found' }) };
  }
  if (offer.driver_id !== callerDriver.id) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'This offer does not belong to you' }) };
  }
  if (offer.status !== 'pending') {
    return { statusCode: 409, headers, body: JSON.stringify({ error: 'This offer has already been responded to', status: offer.status }) };
  }
  if (new Date(offer.expires_at).getTime() <= Date.now()) {
    // Opportunistically mark it expired so it stops showing as an active
    // pending offer -- best-effort, the 409 below is returned either way.
    await admin.from('driver_offers').update({ status: 'expired' }).eq('id', offer.id).eq('status', 'pending');
    return { statusCode: 409, headers, body: JSON.stringify({ error: 'This offer has expired' }) };
  }

  const nowIso = new Date().toISOString();

  if (response === 'accept') {
    // Optimistic guard: only one concurrent 'accept'/'decline' can flip this
    // row from pending -- if 0 rows update, someone else (or the expiry
    // check above) already resolved it.
    const { data: claimed, error: claimError } = await admin
      .from('driver_offers')
      .update({ status: 'accepted', responded_at: nowIso })
      .eq('id', offer.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (claimError) {
      console.error('respond-to-driver-offer: accept update failed', claimError.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to accept offer' }) };
    }
    if (!claimed) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'This offer has already been responded to' }) };
    }

    const transitionResult = await transitionDelivery(
      admin,
      offer.delivery_id,
      'ASSIGNED',
      { type: 'driver', id: callerDriver.id },
      { eventType: 'DRIVER_ACCEPTED', metadata: { offer_id: offer.id } }
    );

    if (!transitionResult.ok) {
      // Don't leave the offer showing 'accepted' against a delivery that
      // never actually moved to ASSIGNED (e.g. it was cancelled concurrently)
      // -- revert so the offer's status stays truthful.
      const { error: revertError } = await admin
        .from('driver_offers')
        .update({ status: 'pending', responded_at: null })
        .eq('id', offer.id)
        .eq('status', 'accepted');
      if (revertError) console.warn('respond-to-driver-offer: failed to revert offer after transition failure', revertError.message);
      return {
        statusCode: transitionResult.reason === 'conflict' ? 409 : 500,
        headers,
        body: JSON.stringify({ error: 'Could not confirm assignment', detail: transitionResult.detail || transitionResult.reason })
      };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, response: 'accept', delivery: transitionResult.delivery }) };
  }

  // response === 'decline'
  const { data: claimed, error: claimError } = await admin
    .from('driver_offers')
    .update({ status: 'declined', responded_at: nowIso })
    .eq('id', offer.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (claimError) {
    console.error('respond-to-driver-offer: decline update failed', claimError.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to decline offer' }) };
  }
  if (!claimed) {
    return { statusCode: 409, headers, body: JSON.stringify({ error: 'This offer has already been responded to' }) };
  }

  // Sends the delivery back to the dispatch pool. Deliberately does NOT call
  // dispatchDelivery() again here -- re-offering to another driver is an
  // admin manual-redispatch action (dispatch-delivery.js) or a future
  // auto-retry stage, not this endpoint's job (a declining driver shouldn't
  // block on however long the next dispatch attempt takes).
  const transitionResult = await transitionDelivery(
    admin,
    offer.delivery_id,
    'READY_FOR_DISPATCH',
    { type: 'driver', id: callerDriver.id },
    { eventType: 'DRIVER_DECLINED', metadata: { offer_id: offer.id } }
  );

  if (!transitionResult.ok) {
    // The decline itself is already recorded and driver-facing; log and
    // report the transition problem without pretending nothing went wrong.
    console.warn('respond-to-driver-offer: decline recorded but delivery transition failed', transitionResult.reason, transitionResult.detail);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Offer declined, but the delivery could not be returned to the dispatch pool', detail: transitionResult.detail || transitionResult.reason })
    };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, response: 'decline', delivery: transitionResult.delivery }) };
};
