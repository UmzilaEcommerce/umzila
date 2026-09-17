// netlify/functions/lib/delivery-state.js
//
// Delivery network (plan §112, delivery-network-spec.md Stage 6) — the single
// place that validates and performs a delivery status transition. Every later
// stage (dispatch, pickup, PIN confirmation) must call transitionDelivery()
// here instead of writing a raw `UPDATE deliveries SET status = ...` — that's
// what prevents plan §81's "invalid status transitions" bug class (e.g.
// delivered -> pending). The database's own delivery_events triggers already
// log every status change unconditionally as a safety net; this module is
// about *preventing* an invalid change from happening in the first place,
// not just recording it after the fact.
//
// Does not touch payfast-itn.js, generate-payfast-signature.js,
// charge-payfast-token.js, checkout.html, or validate-cart.js.

const { notify } = require('./notify');

// Allowed next-states per current state. Deliberately generous on the
// exception paths (CANCELLED/FAILED/REASSIGNING reachable from most active,
// non-terminal states) per plan §81/82 — real operational exceptions need
// that flexibility. This is a first cut based on the plan's own state
// diagram (§112) and will get exercised (and, where wrong, corrected) as
// Stages 7-13 actually build dispatch/pickup/PIN against it — that's
// expected, not a sign this table is final.
const TRANSITIONS = {
  PENDING:              ['READY_FOR_DISPATCH', 'CANCELLED'],
  READY_FOR_DISPATCH:   ['OFFERED', 'CANCELLED'],
  OFFERED:              ['ASSIGNED', 'READY_FOR_DISPATCH', 'CANCELLED'], // declined/expired offer -> back to dispatch pool
  ASSIGNED:             ['DRIVER_AT_PICKUP', 'REASSIGNING', 'CANCELLED'],
  DRIVER_AT_PICKUP:     ['PARTIALLY_PICKED_UP', 'PICKED_UP', 'REASSIGNING', 'CANCELLED'],
  PARTIALLY_PICKED_UP:  ['PICKED_UP', 'REASSIGNING', 'CANCELLED'],
  PICKED_UP:            ['IN_ROUTE', 'REASSIGNING', 'FAILED'],
  IN_ROUTE:             ['NEXT_STOP', 'REASSIGNING', 'FAILED'],
  NEXT_STOP:            ['ARRIVING', 'IN_ROUTE', 'REASSIGNING', 'FAILED'], // IN_ROUTE: driver still working through other stops first
  ARRIVING:             ['PIN_REQUIRED', 'NEXT_STOP', 'FAILED'], // NEXT_STOP: arrival attempt didn't complete (customer not there yet, etc)
  // A wrong PIN entry (plan §163) must NOT transition the delivery at all --
  // it stays at PIN_REQUIRED. That's enforced simply by PIN_REQUIRED not
  // listing itself as a "transition" here; confirm-delivery-pin.js (Stage 13)
  // only calls transitionDelivery() on an actual PIN match.
  PIN_REQUIRED:         ['DELIVERED', 'FAILED'],
  DELIVERED:            [], // terminal
  CANCELLED:            [], // terminal
  FAILED:               ['RETURNED', 'REASSIGNING'],
  REASSIGNING:          ['ASSIGNED', 'READY_FOR_DISPATCH', 'CANCELLED'],
  RETURNED:             [] // terminal
};

function isValidTransition(fromStatus, toStatus) {
  const allowed = TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

// Performs the transition with an optimistic-concurrency guard (the UPDATE's
// WHERE clause requires the row to still be at the expected current status),
// so two callers racing to move the same delivery can't both "succeed" —
// exactly one UPDATE actually matches a row; the other gets rowCount 0 and
// must be treated as a conflict, not silently ignored.
//
// `actor` is { type: 'system'|'driver'|'customer'|'admin', id: uuid|null } --
// required so every transition is attributable, per plan §74/75's audit
// requirements. `eventType` is an optional plan-§60-style event name to log
// in addition to the database's own automatic STATUS_CHANGED event (e.g.
// 'DRIVER_ASSIGNED', 'ORDER_PICKED_UP') -- pass metadata for anything a
// caller wants attached to that specific event (route id, rep name, etc).
//
// Returns { ok: true, delivery } on success, or
// { ok: false, reason: 'invalid_transition' | 'not_found' | 'conflict' | 'db_error', detail? }
// on failure. Never throws for an expected failure mode -- callers decide
// what HTTP status/message that maps to.
async function transitionDelivery(supabase, deliveryId, toStatus, actor, options = {}) {
  if (!supabase || !deliveryId || !toStatus) {
    return { ok: false, reason: 'invalid_transition', detail: 'Missing supabase/deliveryId/toStatus' };
  }
  if (!actor || !['system', 'driver', 'customer', 'admin'].includes(actor.type)) {
    return { ok: false, reason: 'invalid_transition', detail: 'actor.type must be system/driver/customer/admin' };
  }

  const { data: current, error: readError } = await supabase
    .from('deliveries')
    .select('id, status, order_id, customer_id, route_id')
    .eq('id', deliveryId)
    .maybeSingle();

  if (readError) return { ok: false, reason: 'db_error', detail: readError.message };
  if (!current) return { ok: false, reason: 'not_found' };

  if (!isValidTransition(current.status, toStatus)) {
    return {
      ok: false,
      reason: 'invalid_transition',
      detail: `Cannot move delivery ${deliveryId} from ${current.status} to ${toStatus}`
    };
  }

  const patch = { status: toStatus };
  if (toStatus === 'ASSIGNED' && current.status === 'OFFERED') patch.dispatched_at = new Date().toISOString();
  if (toStatus === 'DELIVERED') patch.delivered_at = new Date().toISOString();
  if (toStatus === 'CANCELLED') patch.cancelled_at = new Date().toISOString();
  if (toStatus === 'FAILED' && options.failureReason) patch.failure_reason = options.failureReason;

  const { data: updated, error: updateError } = await supabase
    .from('deliveries')
    .update(patch)
    .eq('id', deliveryId)
    .eq('status', current.status) // optimistic concurrency guard
    .select('id, status, order_id, customer_id, route_id, dispatched_at, delivered_at, cancelled_at, failure_reason')
    .maybeSingle();

  if (updateError) return { ok: false, reason: 'db_error', detail: updateError.message };
  if (!updated) return { ok: false, reason: 'conflict', detail: 'Delivery status changed concurrently; retry.' };

  // The DB's own trigger already logged a generic STATUS_CHANGED event. This
  // is an *additional*, more specific named event when the caller supplies
  // one (plan §60's vocabulary) -- best-effort, never blocks the transition
  // that already succeeded above if this insert fails for some reason.
  if (options.eventType) {
    const { error: eventError } = await supabase.from('delivery_events').insert({
      delivery_id: deliveryId,
      event_type: options.eventType,
      actor_type: actor.type,
      actor_id: actor.id || null,
      metadata: options.metadata || null
    });
    if (eventError) console.warn('transitionDelivery: named event log failed (transition itself still succeeded):', eventError.message);
  }

  // Stage 14 (plan §168): customer notification is centralized here, on
  // every successful transition, rather than scattered across dispatch/
  // pickup/PIN functions. notify() itself decides whether toStatus is
  // actually notifiable and never throws -- awaited (not truly fire-and-
  // forget) because a Netlify Function's process can be frozen the instant
  // its handler's promise resolves, so an un-awaited call here could be cut
  // off mid-send; matches this codebase's existing dispatchDelivery() call
  // in advance-delivery-on-fulfillment.js, which is awaited but wrapped so
  // its own failure never fails the caller.
  try {
    await notify(supabase, deliveryId, toStatus);
  } catch (notifyError) {
    console.warn('transitionDelivery: notify() threw (transition itself still succeeded):', notifyError.message);
  }

  return { ok: true, delivery: updated };
}

module.exports = { TRANSITIONS, isValidTransition, transitionDelivery };
