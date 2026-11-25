# Operations panels: rider app, logistics "Today", admin "Live now"

_Last reworked 2026-10-04. Read this before touching `logistics.html` (Deliver / Today / Orders) or the admin dashboard's live strip._

## What it does

Three screens share two staff-facing RPCs:

| Screen | Who | Data |
|---|---|---|
| `logistics.html` → **Deliver** (rider app) | any rep who goes online as a rider | `get_driver_board()` |
| `logistics.html` → **Today** + **Orders** | logistics reps, admins | `get_ops_board()` + `orders` |
| `admin.html` → Dashboard **Live now** strip | admins | `get_ops_board()` |

Everything that *changes* a delivery still goes through the existing Netlify functions and the delivery state machine (`transitionDelivery`): `driver-heartbeat`, `respond-to-driver-offer`, `advance-route`, `confirm-delivery-pin`. The RPCs are read-only.

## `get_driver_board()` — the rider's whole world in one call

SECURITY DEFINER, keyed on `drivers.user_id = auth.uid()` (a caller only ever sees their own driver row). Returns:

- `driver`: id, is_online, eligibility.
- `offers`: pending, unexpired `driver_offers` with payout, expiry, store name(s) + area, drop-off **area only**, distance/time from the quote, item count, parcel size. **Never the customer's name or phone.** A rider doesn't learn who until they accept.
- `route`: the rider's newest non-completed route with every stop:
  - pickup stops: store name, address, phone, and the items to collect (with `collected` from `route_stop_items`);
  - the drop stop: customer name, phone, address, area, postal code, delivery instructions/notes, short order ref, PIN-locked flag, and everything to hand over;
  - each stop's lat/lon, decoded from `route_stops.location`, used for the Navigate deep link.

Customer contact details therefore exist on the rider's phone only while that route is open.

The customer side gets only the rider's **first name** (`get_delivery_tracking(...).driver_name`, from `profiles.first_name`).

## Rider screen behaviour (and why)

- **Polling runs on every tab** while online (8 s board refresh). It used to run only on the Deliver tab, so offers were missed. Leaving the tab must not stop the intervals; don't re-add `stopDeliveryIntervals()` to `showPanel`.
- **Online state is resumed on page load** from `driver.is_online` (`resumeDeliveryState`). Before, a reload showed "offline" while dispatch still considered the rider online.
- **GPS** is a continuous `watchPosition({enableHighAccuracy:true})`. The heartbeat sends the freshest fix every 12 s on the drop leg (the customer is watching the map) and every 30 s otherwise. A status line warns when location is blocked or weak.
- **New offers** vibrate, play a beep (the AudioContext is unlocked by the "go online" tap) and badge the Deliver tab. The badge shows a count, or a dot while on a job.
- **Button labels match what the server does**:

  | Button | Server action | Delivery status |
  |---|---|---|
  | "I'm at the store" | `start_route` | `DRIVER_AT_PICKUP` |
  | "Collected — continue" | `complete_pickup` | — |
  | "Start trip to customer" | `start_delivery` | `IN_ROUTE` |
  | "I've arrived" | `arrive_at_drop` | — |
  | PIN | `confirm-delivery-pin` | — |

- **Item checkboxes** are local (`localChecked`) until "Collected" sends them. The board re-renders only when its JSON changes, so ticks survive the 8 s refresh.

## `get_ops_board()` — the live operations picture

Staff-only: admins, or an active `user_roles` row with logistics/admin, the same rule as the `orders_manage_staff` policy. It raises 42501 for anyone else. Returns:

- `deliveries`: every non-terminal delivery plus the last 2 days of finished ones. Each has `since` (the last `delivery_events` row = time in its current state), stores, customer, phone, area, address, total, fee, rider first name, `pin_locked` and `failure_reason`.
- `riders`: online means `is_online` and a heartbeat within 3 minutes. Also on-route and last seen.
- `delivery_status_by_order`: `{order_id: status}` for the last 120 days.

### Why Orders uses it

`orders.order_status` stays `'paid'` while the network delivers an order, and logistics staff can't read `deliveries` directly (RLS). So the old panel showed every network order as "Pending" forever. `orderState(o)` in `logistics.html` now prefers the live delivery status and falls back to the legacy manual statuses (Pending/Packaging/Fulfilled/Delivered/Returned) for old or manual orders. Seller enrollment payments (`items[].item_name` "Umzila Seller Enrollment Fee") are tagged "Seller fee" and never queued.

### "Needs attention" rules

These live in `attentionReason()` in logistics and `liveWhy()` in admin. Keep the two in step:

- `READY_FOR_DISPATCH` / `REASSIGNING` ≥ 3 min → no rider.
- `OFFERED` ≥ 3 min → offer unanswered.
- `PENDING` ≥ 45 min → store hasn't marked ready.
- Pickup stages ≥ 40 min.
- Road stages ≥ 60 min.
- PIN locked.
- Failed.

## Multi-drop trips (built 2026-10-05)

A route is a **trip**: up to 5 orders (`MAX_DELIVERIES_PER_TRIP` in `lib/route-insertion.js`), worked stop by stop.

**Current stop.** The rider always works the first stop (by `seq_order`) that isn't completed. Pickups at the same store that follow each other are one visit: "I'm at the store" activates all of them, and one "Collected" completes them in order. `advance-route.js` takes `stopId` and returns 409 `TRIP_CHANGED` if it isn't the current stop or group, so a stale screen can't act. Only the order whose stop it is changes status:
- pickups: ASSIGNED → DRIVER_AT_PICKUP → PICKED_UP;
- "Start trip to <name>": IN_ROUTE;
- arrive: NEXT_STOP → ARRIVING;
- PIN: `confirm-delivery-pin.js`, unchanged; it closes the trip only when every stop is done.

Other orders on the trip stay PICKED_UP until their turn.

**Customers on a shared trip.** `get_delivery_tracking` only looks at that order's own stops.
- The rider's position is only returned from IN_ROUTE onwards, so a waiting customer never sees the rider driving to someone else.
- `orders_ahead` is a yes/no flag, never a count, and always no for a priority order. While picked up, `track.html` shows "There is an order/s ahead of you."

**Adding an order to a trip (spec §32–35).** `lib/batch-dispatch.js#evaluateBatchCandidates` runs before idle dispatch: when a paid order is released to riders (automatically — no Mark Ready since 2026-11-15), on every rider heartbeat (`sweepWaitingDeliveries`), and right after a rider accepts.
- Candidates come from `find_batchable_routes`: trips that are assigned, started or active, with a fresh rider position, fewer than 5 open orders, no other pending offer, and the rider hasn't declined this order.
- For each candidate, `planTrip()` tries every order of the not-yet-started stops (pickups before their own drop; started stops stay first) and keeps the **fastest whole trip** under these rules:
  - Legs are real road distances via `getRoadMatrix` (one OpenRouteService matrix call, cached in `route_distance_cache`), with straight-line × 1.3 only as a fallback. Time is km × 2 + 3 min per stop; a same-store pickup costs 0.
  - Nobody already on the trip ends up more than **8 min** later. If the added order is priority, only other priority customers keep that protection.
  - A priority order arrives no later than 8 min after its earliest possible time. That's how a quick close drop-off can still go first.
  - The new customer arrives within 60 min.
- The rider gets a `batch_addition` offer showing "Add to your trip · +km · +min · drop-off after <name>". The plan is stored in `driver_offers.insertion`.
- On accept, `respond-to-driver-offer.js` **re-plans** (the trip may have moved on) and applies the order with `apply_route_sequence()`. That function locks the route, inserts the new stops, renumbers the rest, refuses to move a started stop, and returns `plan_stale` if the trip changed (it re-plans once). If the order no longer fits, the rider gets 409 "no longer fits your trip" and the order goes back to waiting.
- Free riders are still the only ones offered a **new** trip (`find_nearest_eligible_drivers` skips busy riders); busy riders only ever get additions.
- **No free rider → still offered (2026-10-05, "while it's us delivering, accept any order").** `offerDelivery()` runs on each sweep (heartbeat, offer answers, the minute job). It tries, in order:
  1. adding the order to a trip under the normal rules;
  2. a free rider;
  3. `evaluateBatchCandidates(…, { relaxed: true })`.

  Relaxed mode has no 5-order cap and no 60-min cap for the new customer, but existing customers keep their 8-min protection. Once a trip already has 5 orders the new stops go at the **end** (instant to plan, delays nobody). The offer stores `insertion.relaxed`, and accept re-plans in the same mode. It stays optional for the rider.
- A declined addition is never pushed back onto the same rider's trip. When that rider is free again, it can come back to them as a new trip from the normal free-rider dispatch.

**Pay.** Every delivery on the trip pays its full band (R34–R45), summed by `compute_driver_payout_on_route_completion`. The R15 priority fee is Umzila's.

**Priority (checkout).** A "⚡ Priority delivery +R15" toggle appears once the address is priced; its **?** says only "delivered first, so it gets to you faster". The fee is `delivery_pricing_config.priority_fee` (admin pricing). Toggling re-quotes, and the quote total is what's charged. Priority is read from `delivery_quotes.priority_fee > 0`.

**Limits.**
- An order from 2 stores always gets its own fresh trip; it's never added to another rider's trip.
- Locally there's no ORS key, so planning falls back to straight-line distance. Live uses road distance.

## Delivery timeslots and dispatch (added 2026-11-14 — see docs/systems/delivery-timeslots.md)

While `site_settings` `timeslots.enabled` is true, a delivery whose order has a run (`orders.slot_id`) is **held** until that run's rider-notice time (`slot_window_start − rider_notice_minutes`, default 30 → 11:30 for the 12:00 run; changed 2026-11-15 from the cut-off so riders have time to get to the store): `lib/dispatch.js getRunInfo()/isHeldForRun()` is the one rule, asked by `dispatchDelivery()`, `evaluateBatchCandidates()`, `offerDelivery()` and `sweepWaitingDeliveries()`; the result is `{ dispatched:false, reason:'waiting_for_run', detail:<release iso> }` and the delivery simply stays `READY_FOR_DISPATCH`. The offer and the trip's pickup stop show **"Be at the store by 12:00"** (`get_driver_board` `collect_by` = `orders.slot_window_start`); orders paid after the release (until the cut-off + grace) are added onto those trips by the normal batching. Stores still start preparing at the cut-off ("Do not prepare yet" → "Prepare now"). The heartbeat sweep pages past held deliveries so they never starve ready ones. Once released, same-run orders are grouped: while one run-mate has an unanswered fresh-trip offer the others return `waiting_for_run_mate` and then batch onto that rider's trip when it is accepted (respond-to-driver-offer re-sweeps). `lib/route-insertion.js planTrip()` runs in **run mode** when the added order shares a run (`slot_id|slot_run_date`, via `getRunKeys()`) with orders already on the trip: those run-mates are not protected from each other (no 8-minute rule, no 60-minute new-customer cap) — they were promised the same window — and there is no "must arrive by the window end" rule (customers are promised only the dispatch time). Priority works as everywhere: as early as possible, but it may slip back by up to 8 min when going to it first would send the rider out of the way (the strict "priority run-mates first" ordering was removed 2026-11-15). Orders of other runs / without a run keep every normal rule. The 5-order cap is unchanged. Admin manual redispatch (`dispatch-delivery.js`) is held too (no override) until the rider-notice time.

**No Mark Ready (2026-11-15).** Stores no longer tap anything. `create_delivery_on_payment` still creates the delivery `PENDING`; `lib/batch-dispatch.js releaseOrderDelivery()` (called by the after-paid hook in `complete-order-payment.js` via `timeslotAfterPaid`, release only — no route planning on the payment path) and `releasePendingDeliveries()` (start of every `sweepWaitingDeliveries`: rider heartbeat every 30 s, offer answers, and the once-a-minute `timeslot-tick`, which now sweeps whether timeslots are on or off) move it to `READY_FOR_DISPATCH` (event `ORDER_READY`, metadata `auto: true`). Exception: while `order_closed_store(order_id)` names a closed goods store the delivery stays `PENDING` until it opens. Staff screens: `PENDING` reads "Preparing"; "Not sent to riders" is flagged after 5 min; run deliveries waiting for their release are not flagged as "No rider". `advance-delivery-on-fulfillment.js` is kept for the old per-item dropdown but nothing on the dashboard calls it any more. Riders could always collect without the store's tap (`complete_pickup` never checked it). Timeslots off, or an order without a run, takes none of these branches.

## Money on the logistics screens (2026-11-16)

Logistics never adds up money in the browser any more. Every sales figure comes from staff-gated RPCs (`timeslot_is_staff()`), from the Finances engine (see `docs/systems/finances.md`; shapes in `docs/plans/finances-contract-changes.md`): paid orders only (`payment_status='paid'`, no seller enrolment fee), SAST days by paid time, orders marked as tests in Finances left out.

| Screen | Source |
|---|---|
| Today → "Paid orders today", "Sales today" | `fin_sales_by_period(today, today, 'day')` (the code also accepts a `get_ops_board().paid_today` field, which the board does not return today) (refetched at most once a minute). "Delivered today" uses the SAST day too. |
| Analytics | `fin_sales_by_period(from, to, day/week/month)` + `fin_top_products(from, to, 10)`. Shows paid orders, "paid by customers" (gross, incl. delivery) and goods. Costs/profit are admin-only (admin → Finances). |
| Stores | `sellers` (status `active` / `pending` / `disabled`, `is_house` → "House — Umzila's own" badge) + `fin_store_breakdown(from, to)` for sales and paid orders (7/30/90/365-day picker) + `fin_top_products` for each store's top item. |

If an RPC isn't deployed (PostgREST `PGRST202`) the screen shows "not available yet" / "—" rather than falling back to a browser sum.

**Creating a manual order and recording its payment (rebuilt 2026-11-17).**
- **Where it runs:** New Order and the "Paid: Cash / Card machine / EFT" buttons on an unpaid manual order (`ORD-…`, `m_payment_id` null or equal to the order number) go through `netlify/functions/manual-order.js`. See [manual-orders.md](manual-orders.md).
- **"Deliver it — with tracking" orders** carry `destination_geo`. Recording the payment runs `completeOrderPayment()`, which makes the delivery and sends the tracking email and the rider, the same as PayFast.
- **"Already paid & delivered" orders** have no location, so there is no delivery.
- **Older ORD- orders** only get `payment_status`/`paid_at`/`payment_method_code`.
- **No payment control in Edit:** the Edit order form has none (it was dead: `saveOrder()` strips it).
- **Unrelated limit:** `fin_top_products` caps `p_limit` at 100 (Stores asks for 200).
- **Edit form status select:** the Edit form's Order Status select is hidden for orders with a network delivery and now actually saves for the others (it was silently dropped before because `statusChanged` was never set).

**Baskets.** A carts row lingers after the buyer presses Pay, so a person used to show twice (Unfinished payments + Baskets with contact details). A contact basket is now skipped when the same email/account is under Unfinished payments or paid after the basket last changed.

## Gotchas

- **`saveOrder()` in logistics** must never write `user_id`, `created_at` or `payment_status` on an existing order (the payload no longer carries `payment_status` at all). It no longer inserts: new orders come only from manual-order.js. It writes `order_status` only when `statusChanged` is set (status buttons, or the Edit form's status select when it changed). It used to hand the customer's order to the rep and overwrite `paid`.
- Manual status buttons are hidden for orders that have a network delivery; the state machine owns those. Delete is hidden for paid orders.
- Order detail shows "Charged" = PayFast's `pf_response.amount_gross` when there is one, else the stored `orders.total` (`chargedOf()`), plus "Paid with …" (`paidWithLabel()`: manual codes cash/pos/eft_manual, else the option name from `site_settings` `payments`, else "PayFast"). Never total it up in the browser; item shapes differ by order type:
  - checkout: `name/price/quantity/subtotal`;
  - legacy: `item/price/quantity`;
  - fees: `item_name/unit_price/total`.
- Admin mobile layout relies on CSS overrides for its many inline `grid-template-columns` styles (`main [style*="grid-template-columns"]` stacks at ≤600 px), and tables become horizontally scrollable at ≤900 px. If a new admin section looks wrong on a phone, give it real classes rather than adding more inline grids.
- The admin bottom bar (`.admin-bnav`) just clicks the matching sidebar `<li>`, so all existing section loaders keep working. Group headings are `li.menu-group` and are excluded from the section click handler.

## Staff override: move a delivery along (added 2026-11-25)

logistics.html → order → "Move this delivery along" calls `staff-delivery-step.js` ({orderId, step}).

- It walks the delivery through every normal status up to the chosen step via `transitionDelivery` (actor 'admin'). There are no raw status writes.
- It keeps that order's route stops in step exactly like the rider app, and completes the trip (payout trigger) when all of its stops are done.
- "Delivered" skips the PIN.
- Never write `deliveries.status` directly for overrides; extend this function instead.

