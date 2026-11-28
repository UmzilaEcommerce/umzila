# Rider app (/rider), admin → Riders, and "External riders" in Finances

_Built 2026-11-28. Read this before touching `rider.html`, `riders-admin.js`, driver sign-up/eligibility, rider pay or the rider-cost switch in Finances._

## What it does

**/rider** (`rider.html`, routed by `netlify.toml` before `/:slug`; `rider` is in `seller_slug_reserved()`) is the riders' own app. They used to work from `logistics.html` → Deliver, which only staff can open, so a rider had to be given a logistics role. That role also exposes all orders, customers and baskets.

/rider gives a rider exactly two things:

1. **Deliver.** Go online/offline, get offers (with a buzz and a countdown), accept or decline, then work the trip stop by stop: "I'm at the store", tick items, "Collected", "Start trip", "I've arrived", then the PIN.
2. **Earnings.** Today, this week, this month and all time. Also:
   - what's owed and what's been paid;
   - the average per delivery and road km;
   - a 14-day chart;
   - recent deliveries (store, area, km, pay, paid or to-be-paid);
   - payments received (date + reference).

   Founder (2026-11-28): show riders amounts only. There is no pay-rule explainer, no tips card and no long help text; get_rider_home() still returns a rates object, but the page doesn't show it.

An **Account** tab covers name, phone, vehicle (editable; customers see it from "almost there"), tips, help on WhatsApp, and sign out.

It reads **only**:
- `get_driver_board()`: the rider's offers and own trip. Customer contact appears only on the active trip, as before.
- `get_rider_home()`: the rider's own status, totals, recent deliveries, payouts and rates.

Every change still goes through the existing functions: `driver-heartbeat`, `respond-to-driver-offer`, `advance-route` and `confirm-delivery-pin`. The trip logic is the same as `logistics.html` → Deliver; keep the two in step. The logistics tab still works for staff.

## Becoming a rider (security change)

- **The old gap:** `driver-heartbeat.js` used to create an **eligible** `drivers` row for any signed-in account on its first heartbeat. With a public page, anyone could have made themselves a rider and received customer names, phones and addresses.
- **Who self-registers now:** staff only (admins / active logistics or admin `user_roles`), so existing reps keep working. Anyone else gets 403 `NOT_RIDER`.
- **Applying:** a new rider signs up on /rider (email confirm as usual) and applies with first name, phone and vehicle. `rider_apply()` creates `drivers.eligibility_status = 'pending'`, and the page shows "you're on the list" and re-checks every 30 s.
- **Approving:** an admin approves it in **admin → Riders**, via `admin_rider_set_status(driver, 'eligible')`. They can also pause (`suspended`) and resume.
- **What pausing does:** it takes the rider offline and expires their pending offers.
- **Adding directly:** `admin_rider_add(email)` adds an existing account straight away as eligible.
- **The heartbeat gate:** going **online** requires `eligible`, so pending or suspended riders get 403 `RIDER_PENDING` / `RIDER_SUSPENDED`. Going offline always works.
- **The accept gate:** `respond-to-driver-offer` refuses an **accept** from a non-eligible rider. Dispatch already only offers to `eligibility_status = 'eligible'` (`find_nearest_eligible_drivers`).
- **Known gap:** `find_batchable_routes` does not check eligibility. A paused rider still on an open trip could still be offered an addition, which the accept check then refuses.

## Rider pay

**Since 2026-11-28 the amount per delivery is `rider_pay_for_delivery(delivery_id)`, the one rule.**
- If the order was paid while External riders was on: 90 % of the delivery fee the customer paid (shipping − priority) + R7 if priority. On free delivery, 90 % of the band (Umzila pays it).
- Otherwise: the band below.
- The two numbers live in finance.rider_delivery_share_percent / rider_priority_share (admin → Finances → Assumptions).
- The payout trigger, the offer amount (payout-formula.js payoutForDelivery) and the Finances estimate all call it. Change the rule only there.


- **Where the amount comes from:** each finished trip writes one `driver_payouts` row via the `compute_driver_payout_on_route_completion` trigger (unchanged). `calculation_basis.deliveries[]` holds the pay per delivery.
- **The rule:** R34 for the first 3 road-km, +R0.40/km, +R3 per extra store, max R45, R39 if the distance is unknown. Every delivery on a trip is paid in full, including free-delivery orders.
- **Change together:** the rule lives in the trigger, `lib/payout-formula.js`, `lib/delivery-price.js` and the `rates` object in `get_rider_home()`.
- **How the screens read it:** `rider__deliveries(driver)` (internal, no grants) expands those rows into one line per delivery for `get_rider_home()` and `admin_riders()`.
- **"On your current trip":** the sum of accepted offers' `payout_amount` on an unfinished route. It's an estimate; the trigger's figure is what's owed.
- **Paying a rider:** admin → Riders → "Mark R… paid" runs `admin_rider_pay(driver, reference)`. It sets every pending payout to `paid` with `paid_at`, `paid_reference` and `paid_by` (new columns). It records the payment; it doesn't move money. The rider sees it under "Payments to you".

## "External riders" in Finances (rider pay as a cost, by period)

**The old behaviour:** `site_settings` `finance.count_rider_pay_as_cost` was one global switch, so flipping it re-wrote the profit of **every** past order.

**The new behaviour:** it means "from now on".
- **Periods are kept by the server.** The BEFORE trigger `site_settings_finance_rider_periods` keeps `finance.rider_pay_cost_periods = [{from, to|null, by}]`. Switching on opens a period at `now()`; switching off closes the open one. Whatever a client sends for that key is ignored, because the trigger rebuilds it from the old row.
- **Per order:** `fin__order_lines` uses `fin__rider_cost_at(when_ts)`, the order's paid time (manual ORD- orders use the order date). So rider pay is a cost only for orders paid inside a period. Earlier orders never change, and orders paid while it was on keep their cost after it's switched off.
- **Per period:** `fin_summary` and `fin_delivery_breakdown` report `rider_pay_counted = fin__rider_cost_any(from, to)`, true if the range overlaps any period.
- **On screen:** Finances shows "Rider pay (external riders)" (counted) plus, for a mixed range, "not counted (staff riders)" for the rest. Assumptions lists the periods.
- **How it was installed:** the three finance functions were patched in place by text replacement (`docs/plans/sql/37_rider_panel.sql`), which refuses to run if a pattern isn't found. If those functions are rewritten, keep `fin__rider_cost_at(c.when_ts)` in the `rider_cost` line.
- **Verified 2026-11-28:** November's net profit was unchanged (R561.95) after the change. In a rolled-back test, switching on created a period starting at that moment (a fake 2020 period sent by the client was ignored), and switching off closed it.

## Files

`rider.html`, `riders-admin.js`, `admin.html` (Riders menu + section), `finances-admin.js` (External riders label + periods), `netlify/functions/driver-heartbeat.js`, `respond-to-driver-offer.js`, `netlify.toml`, `docs/plans/sql/37_rider_panel.sql`.
