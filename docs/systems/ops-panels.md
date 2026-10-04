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

**Adding an order to a trip (spec §32–35).** `lib/batch-dispatch.js#evaluateBatchCandidates` runs before idle dispatch: on Mark Ready, on every rider heartbeat (`sweepWaitingDeliveries`), and right after a rider accepts.
- Candidates come from `find_batchable_routes`: trips that are assigned, started or active, with a fresh rider position, fewer than 5 open orders, no other pending offer, and the rider hasn't declined this order.
- For each candidate, `planTrip()` tries every order of the not-yet-started stops (pickups before their own drop; started stops stay first) and keeps the **fastest whole trip** under these rules:
  - Legs are real road distances via `getRoadMatrix` (one OpenRouteService matrix call, cached in `route_distance_cache`), with straight-line × 1.3 only as a fallback. Time is km × 2 + 3 min per stop; a same-store pickup costs 0.
  - Nobody already on the trip ends up more than **8 min** later. If the added order is priority, only other priority customers keep that protection.
  - A priority order arrives no later than 8 min after its earliest possible time. That's how a quick close drop-off can still go first.
  - The new customer arrives within 60 min.
- The rider gets a `batch_addition` offer showing "Add to your trip · +km · +min · drop-off after <name>". The plan is stored in `driver_offers.insertion`.
- On accept, `respond-to-driver-offer.js` **re-plans** (the trip may have moved on) and applies the order with `apply_route_sequence()`. That function locks the route, inserts the new stops, renumbers the rest, refuses to move a started stop, and returns `plan_stale` if the trip changed (it re-plans once). If the order no longer fits, the rider gets 409 "no longer fits your trip" and the order goes back to waiting.
- Free riders are still the only ones offered a **new** trip (`find_nearest_eligible_drivers` skips busy riders); busy riders only ever get additions.

**Pay.** Every delivery on the trip pays its full band (R34–R45), summed by `compute_driver_payout_on_route_completion`. The R15 priority fee is Umzila's.

**Priority (checkout).** A "⚡ Priority delivery +R15" toggle appears once the address is priced; its **?** says only "delivered first, so it gets to you faster". The fee is `delivery_pricing_config.priority_fee` (admin pricing). Toggling re-quotes, and the quote total is what's charged. Priority is read from `delivery_quotes.priority_fee > 0`.

**Limits.**
- An order from 2 stores always gets its own fresh trip; it's never added to another rider's trip.
- Locally there's no ORS key, so planning falls back to straight-line distance. Live uses road distance.

## Gotchas

- **`saveOrder()` in logistics** must never write `user_id`, `created_at` or `payment_status` on an existing order. It writes `order_status` only when `statusChanged` is set by the status buttons. It used to hand the customer's order to the rep and overwrite `paid`.
- Manual status buttons are hidden for orders that have a network delivery; the state machine owns those. Delete is hidden for paid orders.
- Order detail shows the stored `orders.total` as "Charged". Never total it up in the browser; item shapes differ by order type:
  - checkout: `name/price/quantity/subtotal`;
  - legacy: `item/price/quantity`;
  - fees: `item_name/unit_price/total`.
- Admin mobile layout relies on CSS overrides for its many inline `grid-template-columns` styles (`main [style*="grid-template-columns"]` stacks at ≤600 px), and tables become horizontally scrollable at ≤900 px. If a new admin section looks wrong on a phone, give it real classes rather than adding more inline grids.
- The admin bottom bar (`.admin-bnav`) just clicks the matching sidebar `<li>`, so all existing section loaders keep working. Group headings are `li.menu-group` and are excluded from the section click handler.
