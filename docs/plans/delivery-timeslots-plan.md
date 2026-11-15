# Delivery timeslots — build plan (design only, 2026-11-14)

Source of truth for behaviour: `C:\Users\ntand\Downloads\Umzila delivery timeslots developer brief.md` (the brief). The older prototype (`Umzila Delivery Slots.html`: holds, capacity 6, 45-min cut-off, turnaround/cars maths) is superseded wherever it differs — no holds, no capacity at checkout, cut-off 15 min, grace 5 min.

Everything below is grounded in the code and the live database as of commit `33bcd23`. Line numbers are from that commit.

## ⚠️ FOUNDER DECISIONS (2026-11-14) — these OVERRIDE §2.2 and anything below that conflicts

1. **Dispatch: hold + group by run — YES.** A run's deliveries are not offered to riders until the run's cut-off; the seller's Mark Ready shows "Do not prepare yet" until then. Same-run orders go on one trip in "run mode" (no 8-min / per-customer protection among same-run orders). Workstream E is ON.
2. **Priority delivery: KEEP it while timeslots are on** (founder overrode the recommendation and the brief's "hide it"). The ⚡ Priority toggle stays visible and charged as today (delivery_pricing_config.priority_fee). Its meaning with slots: "Your order is delivered first in your window" — in run-mode trip planning, priority orders of the same run are sequenced first (keep lib/route-insertion's priority rule in run mode). Do NOT force priority_fee = 0. Update the priority card's help/subtitle copy when slots are on to "Delivered first in your delivery window". The "Delivery target: about N min" ETA strip IS replaced by the run picker while slots are on (the window is the promise).
3. **Stores with no seller_availability rows count as open at any time** (as recommended).
4. **Admin alert recipients: an in-portal list** (NOT Netlify ADMIN_EMAILS). Add an admin-only table `public.admin_alert_emails (id uuid pk, email text not null unique, active boolean not null default true, created_at timestamptz default now(), created_by uuid)` with RLS: admins only (select/insert/update/delete) — never publicly readable. Seed it with nothing; timeslot-tick falls back to ADMIN_EMAILS env only if the table has no active rows. Workstream C adds a small "Alert emails" card to the Delivery Times admin section (add / switch off / remove). Workstream A owns the table + the server lookup (lib/timeslots.js `adminAlertEmails(admin)`).
5. After-hours flow replaced for goods while slots are on (R18) — as recommended.
6. "Mark for refund" — as recommended (order_status 'refunded', delivery CANCELLED, email customer; actual refund manual in PayFast). Self-arranged-radius stores exempt from slots.
7. Deliveries run all seven days (slot days default all 7).

---

## 1. Fit analysis — where timeslots slot into the existing flow

### 1.1 The payment chain today (what we must not rewrite)

| Step | Where | What happens |
|---|---|---|
| Pay tap | `checkout.html:5675 processPayment()` / `:5719 payWithSavedCard()` | terms → account branch → `preparePendingOrder()` |
| Order creation | `checkout.html:5390 preparePendingOrderOnce()` | closed-store popup (`:5398 confirmClosedStores`), destination + fresh quote (`:5413-5425`), `validateCheckout()` (`:5426` → `validate-cart.js` with `finalCheck`), then a **browser-side insert into `orders`** (`:5496-5559`) with `order_status:'pending_payment'`, `m_payment_id = order_number = UMZILA-<ts>-<rand>`, `delivery_quote_id`, `priority_fee`, `destination_geo`. **Every Pay tap inserts a new row** (`:5477`, `:5496`) — an abandoned attempt is just an orphan `pending_payment` row. RLS: anon may insert only `pending_payment` (policy "Guests can insert pending orders"); signed-in users insert their own and **may update their own orders** (policy "Users can update their own orders"). |
| Sign / charge | `generate-payfast-signature.js` (signed-in path `:74-85` only verifies the token and signs the payload; guest path `:35-70` re-prices the order via `lib/reprice-order.js`), `charge-payfast-token.js:215`, `complete-zero-total-order.js:34,45` | none of these look at delivery timing |
| Payment confirmed | `payfast-itn.js:39-57` (signature check → `completeOrderPayment`), `charge-payfast-token.js:215`, `complete-zero-total-order.js:45` | all three call `lib/complete-order-payment.js completeOrderPayment()` |
| Mark paid | `complete-order-payment.js:35-63` | reads the order (`existingOrder`), `update orders set order_status='paid', payment_status='paid', paid_at=<JS now> where m_payment_id=…` (`:44-53`), then `if (alreadyPaid \|\| !existingOrder) return` (`:63`) — this is the existing **duplicate-ITN idempotency guard**; everything after it runs once. |
| DB triggers on that update | `orders`: `trg_sync_payment_status` (BEFORE), `trg_create_delivery_on_payment` (AFTER, `WHEN new.order_status='paid' and old is distinct from 'paid'`), `trg_populate_order_items_on_payment` (same WHEN), `clear_guest_carts_on_paid` | `create_delivery_on_payment()` builds a stand-in quote when checkout attached none, then inserts `deliveries` (`PENDING`, `on conflict (order_id) do nothing`). |
| Post-payment tasks | `complete-order-payment.js:65-350` | guest→account link, saved card, coupon, cart clear, **buyer confirmation email** (`:190-238`, subject `:225`, intro text `:862-866`, after-hours note `:203-217` + `:923`), service records, vouchers, **per-seller "New order" email** (`:535`, recipients `:602-609` = `sellers.email` + owner + `seller_members`), **admin CHA-CHING email** (`:1081`, recipients `process.env.ADMIN_EMAILS` `:1085`), stock decrement. |

**Consequence for timeslots.** The brief's three server moments map cleanly onto existing seams, none of which is a PayFast function:

1. **"Pay pressed" = the `orders` INSERT** at `checkout.html:5557`. The atomic check-and-create (brief, Server requirements) is a `BEFORE INSERT` trigger on `orders` — the row either passes the rule and gets its window stamped, or the insert fails and nothing exists. No new RPC, no change to the existing insert path, works identically for anon and signed-in inserts.
2. **"Payment confirmed" = the `UPDATE … order_status='paid'`** at `complete-order-payment.js:44-53`. R11/R12/R13 are a `BEFORE UPDATE OF order_status` trigger on `orders` with the same `WHEN (new.order_status='paid' and old.order_status is distinct from 'paid')` guard the two existing AFTER triggers use — so a **second ITN changes nothing** at the DB level (old is already `'paid'`, the trigger does not fire) and at the function level (`alreadyPaid` return at `:63`). Running BEFORE the AFTER triggers means `create_delivery_on_payment()` sees the final slot columns.
3. **Messaging** (grace "Add to run", "Run changed", busy alert, needs-attention) = one additive line in `completeOrderPayment` inside the `!alreadyPaid` block (`await timeslotAfterPaid(...)` from a new lib) plus the once-a-minute job as the safety net. The PayFast functions' ordering, signature logic and validation are untouched.

### 1.2 Checkout page (`checkout.html`)

- **Where the picker goes:** the delivery step already has an ETA strip `#estimatedDeliveryTime` (`:1409`) and the priority card with `#priorityToggle` (`:1415`), driven by `updateEstimatedDelivery()` (`:4601`) → `refreshEstimatedTime()` (`:4663`, "Delivery target: about N min", constants `:4642-4643`) and `renderPriorityCard()` (`:4652`). With timeslots on, the picker **replaces** the ETA strip's content (the "road km × 2 + 45 min" promise is exactly the untrue "a driver is on it" promise the brief removes) and the priority card is hidden (brief: "Not in this version: Priority or express delivery"; `state.priorityDelivery` forced false so `get-delivery-quote` never prices it).
- **Which carts get a picker:** `cartHasProducts(state.cart)` (`:5413`) is the existing "needs delivery" test; `waitsForOpenStore()` (`:5599`) = "goods, not services"; `HOUSE_IDS` (house drinks) are excluded from store counting (`:4603`). Picker store list = goods sellers minus house sellers, the same set the closed-store code already computes at `:4609`.
- **Pay button label:** `:2604` sets `payNowBtn.textContent`; `#payNowBtn` at `:1667` ("Agree & pay"). Becomes "Pay R142 · Today 12:00–13:00".
- **After-hours popup:** `confirmClosedStores()` (`:5610`) and the closed variant of the ETA strip (`:4671-4679`) exist because today an order can be placed for a closed store. Under R18 a run is only offered when every store is open at the cut-off and the window start, so with timeslots on the popup is **skipped** and the strip's closed branch is not used (the picker says "Deliveries are closed for today. The next delivery time is tomorrow, 12:00–13:00" instead). `localStorage ss_closed_order_note` is not written.
- **Refusal at Pay:** the insert error from the trigger (`error.message === 'TIMESLOT_CLOSED'`, `error.details` = JSON with the next open run) is caught where `:5561-5564` currently throws "Failed to create order". Checkout shows the brief's sentence, re-fetches the run list, selects the next run, and **stops** — the customer presses Pay again (`:5691`/`:5731` are re-entered; `payBusy` is already released by the `finally`).
- **Server time:** the RPC returns `server_now`; the page keeps `offset = server_now - Date.now()` and renders countdowns from it; it re-fetches the list every 30 s and at each cut-off boundary. The device clock never decides anything (R21).
- **Not touched:** `validate-cart.js` (pricing/finalCheck authority, `:550-569`) — timeslots are not a price. `get-delivery-quote.js` — a quote stays a quote; it just no longer carries a priority fee while slots are on.

### 1.3 Deliveries, dispatch, rider app, trips

- A paid goods order always gets a `deliveries` row (`PENDING`) from `create_delivery_on_payment()`; sellers' "Mark Ready for Pickup" (`seller-dashboard.html:3797` → `markOrderReady` → `advance-delivery-on-fulfillment.js`) checks every real store is ready (`:80-111`, house sellers skipped `:96-100`), transitions to `READY_FOR_DISPATCH` (`:116`) and immediately calls `offerDelivery()` (`lib/batch-dispatch.js:112`: add to a trip → free rider → relaxed add). `driver-heartbeat.js:132-145` re-offers waiting deliveries via `sweepWaitingDeliveries()` (`batch-dispatch.js:127`, oldest `READY_FOR_DISPATCH` first).
- **Nothing in this chain knows about time.** Two consequences the brief's run model needs (both **founder decisions**, §2.2): (a) a store that marks ready at 10:30 for a 12:00 run would get a rider offered at 10:30 — so dispatch should skip run deliveries until the run's cut-off; (b) six orders in one run are six separate offers; the existing insertion rules (`lib/route-insertion.js`: nobody on the trip ends up >8 min later, new customer ≤60 min, relaxed mode only when no free rider — see `docs/systems/ops-panels.md`) can refuse to add a same-run order onto the same trip, leaving it waiting. Same-run orders share one promised window, so they should be plannable together without the 8-min protection.
- Everything downstream is unchanged: offers, `advance-route.js`, `confirm-delivery-pin.js`, `notify.js` (IN_ROUTE "Your Umzila order is on the way" `:88`, ARRIVING `:96`, DELIVERED `:104` — all consistent with the brief's "Out for delivery"/"Delivered" rows, which say "keep whatever way the site marks orders today"), rider pay, feedback. "Out for delivery" = `IN_ROUTE`, "Delivered" = PIN → `DELIVERED`. No "Mark delivered" button is needed on the run sheet.

### 1.4 Customer status surfaces

| Surface | Today | With a run on the order |
|---|---|---|
| `checkout-success.html:251` | "The store is preparing your order — track it live below." | "Order confirmed. Arriving today between 12:00 and 13:00." (+ moved / needs-attention notes). Data from `order-status.js` (`:25-57`, service-role read; gains a `run` object). |
| `track.html:254-267 statusMeta`, `:630-638` | PENDING/READY/OFFERED → "Preparing your order"; PENDING + closed store → "made when it opens"; `:743` "Your rider is on the way to collect your order" | PENDING before cut-off → Confirmed wording; PENDING/READY/OFFERED/ASSIGNED… after cut-off → "The store is preparing your order. Arriving between…"; IN_ROUTE+ → "on the way… arrives by 13:00"; DELIVERED unchanged. Needs `get_delivery_tracking` to return the window + cut-off (§3.6). Slot wording wins over `store_closed_name` when a slot exists. |
| `index.html:1154-1181` home widget | "Your order is being prepared" / "with a driver" | same mapping (reads `get_delivery_tracking` at `:1139`) |
| `profile.html:1472` | 'Preparing' badge | "Arriving 12:00–13:00" / "Preparing" by cut-off |
| Confirmation email (`complete-order-payment.js:225`, `:862-866`, `:923`) | "your order is being prepared… our logistics team delivers" + closed-store note | subject "Order confirmed — arriving today 12:00–13:00 — UMZILA-…", first line the same sentence; closed-store note suppressed when a slot exists (R18 guarantees open). |

Audit result for the brief's wording test: the exact phrase "a driver is on it" does not appear anywhere (grep over `*.html`/`*.js`); the equivalents that must change for slot orders are `checkout.html:4683` (delivery target), `checkout-success.html:251`, `track.html:267`/`:743`, `index.html:1179`, `complete-order-payment.js:863`. `profile.html:657` ("When a driver hands you an order…", PIN help) is fine.

### 1.5 Seller dashboard (`seller-dashboard.html`)

`loadOrders()` (`:3633`) selects paid orders (`:3653-3658`, `payment_status='paid'` — R14 already holds), filters to this seller's products, pulls `order_item_statuses` (`:3681`) and `deliveries.status` (`:3689`), then `renderOrders()` (`:3866`) lists active orders (`isPastOrder` `:3859`) with the Mark Ready button (`:3797`). Timeslots add: slot columns to the select, grouping of active orders by `(slot_run_date, slot_window_start)` with the brief's header, "Do not prepare yet" before the cut-off (Mark Ready hidden) and "Prepare now" from it, and a "Run summary" card fed by `seller_notifications` rows (type `run_summary` / `run_addition`) that the cut-off job writes. Orders without a slot (pre-feature, services, manual) render exactly as today in an "Other orders" group.

### 1.6 Staff: admin console and logistics

- `admin.html` Delivery menu group (`:491-496`: Delivery Ops, Deliveries, Service Areas, Delivery Pricing, Delivery Analytics), section loaders wired at `:3032-3037`. Settings pattern to copy: Home Page tab reads/writes `site_settings` key `home` (`:5351-5380`, save `:5565`) — admin-only write RLS already exists (`site_settings_admin_write`), public read (`site_settings_select_all`). Delivery Pricing (`:5728`, `:5870`) shows the versioned-config pattern we do **not** need here (one jsonb key is enough).
- New admin section **"Delivery Times"** (slots, settings, date controls, run sheet, needs attention, running late) — all in `admin.html` + a new `timeslots-admin.js` page script so the 6 000-line file grows by a shell only.
- `logistics.html` Orders/Today (`:900-902`, `:1156 get_ops_board`, `:1238 orderState`) keep working unchanged; the run sheet is an admin page (the driver uses admin.html on the phone — the brief). Optional later: show the window on logistics Today cards via `get_ops_board` (§3.6 adds the fields; no logistics.html change in v1).

### 1.7 Refunds and cancellation

Refunds are manual in the PayFast dashboard; staff record a status. There is no customer cancel button for goods (profile.html only has "Returned"/"Delivered" confirmations `:1569`, `:1587`). Per R20: **no customer button**; the run sheet's "Mark for refund" sets `orders.order_status='refunded'`, cancels the `deliveries` row through `transitionDelivery(…,'CANCELLED')` (server-side, `lib/delivery-state.js`) and emails the customer; the money is refunded by hand in PayFast as today.

### 1.8 Scheduler

`netlify.toml` already schedules `send-stock-alerts` (*/15), `send-rating-requests` (*/5), `send-spin-emails` (*/30); the pattern is `send-stock-alerts.js:54-63` (service-role client, `SITE_BASE_URL`, `mailFrom`). `pg_cron` exists in the DB (5 jobs) but `pg_net` does not, so emails cannot be sent from Postgres — the cut-off job is a Netlify scheduled function at `* * * * *`.

---

## 2. Answers and decisions

### 2.1 The brief's "Questions to answer before building" — answered from the code

| Question | Answer |
|---|---|
| Are store opening hours stored? | **Yes.** `seller_availability` (seller_id, day_of_week 0–6, start_time, end_time; one set per store, SAST), read by `get_store_hours_status(uuid[])` and `order_closed_store(order_id)`. Public SELECT. **Gap:** only Nceks Quad Biking (services), Isiqalo Kitchen and Velaphi Shisanyama have 7 rows; Sneaker Cleaners has 1; every other active store (Lemé, Nellerh hub, Water distribution centre, Sweet Corner, Shazi Media, Lumina Shop, Umzila store, Umzila Drinks) has none. Today "no hours" means "never closed" (`has_hours=false`). R18 is buildable; see decision 4 for the no-hours rule. |
| How is an order marked delivered, and by whom? | The rider: PIN confirmation (`confirm-delivery-pin.js`) or the last stop of `advance-route.js` sets `deliveries.status='DELIVERED'`; `orders.order_status` stays `'paid'` (ops-panels.md). Manual/cash orders: logistics sets `order_status` 'Delivered'. Brief: keep it; no "Mark delivered" button needed. |
| How are refunds done? | Manually in the PayFast dashboard; admin/logistics only record a status (`'refunded'` is one of the MANUAL_DONE statuses the seller dashboard treats as past, `seller-dashboard.html:3858`). No refund API call exists. |
| Can one cart hold items from more than one store? | **Yes** — one cart for all of Umzila; checkout prices a per-store surcharge (+R3/store), `get-delivery-quote` refuses stores too far apart (`multi_seller` block, `checkout.html:3510`), a 2-store order always gets its own trip. House drinks (`sellers.is_house`) ride along and never count as a store. R18 must therefore check **every goods store** in the cart (excluding house). |
| Is priority delivery live? | **Yes** — "⚡ Priority delivery +R15" toggle (`checkout.html:1415`, `renderPriorityCard :4652`), fee from `delivery_pricing_config.priority_fee` (active row = 15), stored on `delivery_quotes.priority_fee` / `orders.priority_fee`, used by `get_delivery_tracking` (`orders_ahead`) and route insertion. Hide while timeslots are on (decision 3). |
| Which days does Umzila deliver? | Nothing in code restricts days; the delivery network runs whenever a rider is online. Default all seven (R2); `delivery_slots.days` is editable per slot anyway. |
| Which addresses get admin alerts? | Netlify env `ADMIN_EMAILS` (comma list), used by `sendAdminOrderNotification` (`complete-order-payment.js:1085`) and `lib/spin.js:57`. Reuse it (decision 5). |

### 2.2 Decisions that need the founder (each with the recommended answer)

1. **Hold rider dispatch until the cut-off?** Today a "Mark Ready" dispatches at once. Recommended: **yes** — a delivery whose order has a run is not offered (`offerDelivery`/`sweepWaitingDeliveries` skip it) until `window_start − cutoff_minutes`; the seller's Mark Ready button is also hidden until then ("Do not prepare yet"). Stores can still press it from the cut-off, and the driver is offered the run's orders from 11:45 as the brief's timeline says.
2. **Group a run's orders onto one trip even when the 8-min / 60-min insertion rules would refuse?** Recommended: **yes, "run mode"** — when the order being added and the orders on the trip share a run, the trip is planned fastest-overall with no per-customer protection (they were all promised the same window), capped at `MAX_DELIVERIES_PER_TRIP` only in non-relaxed mode. Orders from different runs keep today's rules. If **no**, v1 keeps today's dispatch exactly and the driver groups by hand (a 12:00-run order may wait for the rider to free up).
3. **Priority delivery and the ETA strip while timeslots are on.** Recommended: hide the priority toggle, force `priority_fee = 0` on new orders, and replace the "Delivery target: about N min" strip with the run picker (the window **is** the promise). Keep `delivery_pricing_config.priority_fee` for later. With the master switch off both come back exactly as today.
4. **R18 and stores without opening hours.** Recommended: a store with no `seller_availability` rows counts as **open at any time** (matches today's `has_hours=false` → never "closed"), and before switch-on the founder enters hours for every goods store in the seller dashboard (Hours) or admin. Alternative (stricter, not recommended): no hours = no runs offered, which would block most stores on day one.
5. **Admin alert recipients.** Recommended: keep using Netlify `ADMIN_EMAILS` (the "admin-manageable" rule is met by Netlify env, and `site_settings` is publicly readable, so staff addresses must not live there). If an in-portal list is wanted later it needs an admin-only table.
6. **After-hours flow is replaced for goods while slots are on.** Today a buyer may order from a closed store after agreeing "made when it opens" (popup, strip, emails, tracking). With slots on, a store closed at the cut-off or window start simply has no run (R18) and the popup is skipped; a store closed *now* but open by the cut-off is offered normally with no warning. Recommended: **yes**, this is what R18 means. Services keep their own flow (R19).
7. **"Mark for refund" semantics.** Recommended: sets `orders.order_status='refunded'`, cancels the delivery row (`CANCELLED`), removes the order from run lists and the seller's active list, emails the customer "Refund on its way (3–5 working days)". The actual refund stays manual in PayFast as today. Also: stores with `self_arranged_radius_km` (they deliver themselves — none active today) are **exempt** from slots, same rule as `create_delivery_on_payment()`.

Everything else in the brief is answerable from the code and is designed below without a question.

---

## 3. Data model and server rules

Principle: reuse `orders`, `site_settings`, `seller_availability`, `seller_notifications`, `notification_log`, `deliveries`; add only what has no existing home (recurring windows, date exceptions, per-run state, move history). All timestamps `timestamptz` (UTC); SAST only for rules/display via `at time zone 'Africa/Johannesburg'`, the same idiom as `get_store_hours_status`.

### 3.1 Settings — `site_settings` key `'timeslots'` (existing table, no new rows elsewhere)

```jsonc
{ "enabled": false, "cutoff_minutes": 15, "grace_minutes": 5, "days_ahead": 1, "busy_alert_at": 6 }
```
Read by everyone (existing public SELECT), written only by admins (existing policy). Helper `timeslot_settings()` returns the jsonb with defaults merged (`coalesce` per key) so a missing key never breaks a trigger. `timeslot_enabled()` = `(timeslot_settings()->>'enabled')::boolean`. Both `STABLE`, `SET search_path = ''`.

### 3.2 New tables

```sql
create table public.delivery_slots (
  id uuid primary key default gen_random_uuid(),
  start_time time not null,           -- SAST wall clock
  end_time   time not null check (end_time > start_time),
  days       smallint[] not null default '{0,1,2,3,4,5,6}' check (array_length(days,1) >= 1),  -- 0=Sun … 6=Sat (same as seller_availability.day_of_week)
  active     boolean not null default true,
  max_orders integer null check (max_orders is null or max_orders > 0),   -- R16, empty by default
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- R4: trigger delivery_slots_no_overlap (BEFORE INSERT/UPDATE): raise 'SLOT_OVERLAP' if another slot shares a day and tstzrange overlaps (checked on all slots, on or off, so switching one on can never create an overlap).
-- Delete guard: trigger delivery_slots_no_delete_with_orders (BEFORE DELETE): raise 'SLOT_HAS_PAID_ORDERS' if exists paid order with slot_id = old.id and slot_window_start > now().
-- RLS: select for everyone (anon, authenticated); insert/update/delete only admins (exists(select 1 from admins where user_id = auth.uid())).
-- Seed (R2): 12:00–13:00, 14:00–15:00, 16:00–17:00, 18:00–19:00, all days, active.

create table public.delivery_slot_exceptions (
  id uuid primary key default gen_random_uuid(),
  run_date date not null,
  slot_id uuid null references public.delivery_slots(id) on delete cascade,  -- null = whole date paused (R5)
  note text, created_by uuid, created_at timestamptz not null default now(),
  unique nulls not distinct (run_date, slot_id)
);
-- RLS: select everyone; write admins only.

create table public.delivery_runs (                 -- per-run state, created lazily (first paid order or the job)
  slot_id uuid not null references public.delivery_slots(id),
  run_date date not null,
  summary_claimed_at timestamptz, summary_sent_at timestamptz, summary_sent_to uuid[] not null default '{}',  -- seller ids already emailed
  busy_alert_sent_at timestamptz,
  late_minutes integer, late_sent_at timestamptz,
  primary key (slot_id, run_date)
);
-- RLS: staff read (same rule as orders_manage_staff); writes only via SECURITY DEFINER functions / service role.

create table public.delivery_run_moves (            -- history (brief: "Record every move")
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  from_slot_id uuid, from_run_date date, from_window_start timestamptz, from_window_end timestamptz,
  to_slot_id uuid,   to_run_date date,   to_window_start timestamptz,   to_window_end timestamptz,   -- all null = marked for refund / needs attention
  reason text not null check (reason in ('late_payment','admin','admin_stop','refund')),
  actor_type text not null check (actor_type in ('system','admin')), actor_id uuid,
  customer_emailed_at timestamptz,
  created_at timestamptz not null default now()
);
-- RLS: staff read; customer may read rows for their own orders (auth.uid() = orders.user_id or verified email) so profile/track can show "moved from"; writes only via functions.
```

### 3.3 `orders` — new columns (the only existing table that changes)

```sql
alter table public.orders
  add column slot_id uuid references public.delivery_slots(id),
  add column slot_run_date date,
  add column slot_window_start timestamptz,   -- as sold (copy; a slot edit never changes it)
  add column slot_window_end timestamptz,     -- as sold
  add column slot_pay_pressed_at timestamptz, -- stamped by the insert trigger (orders.created_at is timestamp WITHOUT time zone — not used for rules)
  add column slot_needs_attention boolean not null default false;
create index orders_slot_run_idx on public.orders (slot_id, slot_run_date) where slot_id is not null;
```
"Time payment was confirmed" = existing `orders.paid_at` (set by `completeOrderPayment`; the trigger uses `coalesce(new.paid_at, now())`). "If it was moved: original run, reason, time" = `delivery_run_moves` (first row for the order is the original). The cut-off is **not** stored on the order: the brief says a change to cut-off minutes applies to every run whose cut-off has not passed, so it is always `slot_window_start − cutoff_minutes` (computed by `timeslot_cutoff_at(window_start)`), with `delivery_runs.summary_sent_at` as the "never reopens" floor.

### 3.4 Core rule function — the single source of truth for "which runs can this cart order for at time T"

```sql
-- Store open at an instant: no rows = always open (decision 4); house sellers ignored.
create function public.timeslot_store_open_at(p_seller_id uuid, p_at timestamptz) returns boolean  -- STABLE

create function public.timeslot_open_runs(p_seller_ids uuid[], p_at timestamptz)
returns table (slot_id uuid, run_date date, window_start timestamptz, window_end timestamptz, cutoff_at timestamptz,
               state text,            -- 'open' | 'closed' | 'skipped' | 'paused' | 'off' | 'store_closed' | 'full'
               blocking_store text,   -- shop_name when state = 'store_closed'
               paid_count integer)
language sql stable security definer set search_path = '';
```
Logic (all in SAST): `today = (p_at at time zone 'Africa/Johannesburg')::date`; for `d in today .. today + days_ahead` × every slot whose `days @> extract(dow from d)`: `window_start = (d + start_time) at time zone 'Africa/Johannesburg'`, same for end; `cutoff_at = window_start − cutoff_minutes`. State, first match wins: `off` (not active) → `paused` (exception with slot_id null) → `skipped` (exception for slot) → `closed` (`p_at >= cutoff_at` **or** `delivery_runs.summary_sent_at is not null`) → `store_closed` (any non-house goods seller not open at `cutoff_at` or at `window_start`) → `full` (`max_orders` set and paid_count ≥ max_orders) → `open`. `paid_count` = orders with this slot/run, `payment_status='paid'`, `order_status not in ('refunded','cancelled')`. Ordered by `window_start`. **Execute granted only to `service_role`** (tests and server code pass any `p_at`).

Public wrappers (what pages call; `now()` is fixed inside, clients cannot pass a time):
```sql
create function public.timeslot_runs_for_cart(p_seller_ids uuid[]) returns jsonb  -- anon + authenticated
-- { enabled, server_now, cutoff_minutes, grace_minutes, runs: [ {slot_id, run_date, window_start, window_end, cutoff_at, state, blocking_store} ], next_open: {…}|null }
-- runs = every candidate run (so the page can say why nothing is open); when enabled=false → { enabled:false } only.
create function public.timeslot_public_config() returns jsonb  -- { enabled, cutoff_minutes, grace_minutes, days_ahead, server_now } — checkout + seller dashboard
```

### 3.5 Triggers on `orders`

**(a) Atomic check-and-create at Pay** — `trg_timeslot_guard_insert BEFORE INSERT ON orders`:
```
if not timeslot_enabled() then return new;                      -- master switch: off = today exactly
if new.order_status <> 'pending_payment' then return new;        -- logistics manual orders (ORD-…) untouched
goods := non-service items (coalesce(i->>'listing_type','product') <> 'service') whose seller is not is_house, resolved from products by product_id/id
if goods empty then return new;                                  -- services/bookings: no slot (R19)
if self_arranged store within radius (same test as create_delivery_on_payment) then return new;   -- decision 7
if new.slot_id is null or new.slot_run_date is null then raise exception 'TIMESLOT_REQUIRED' using errcode='P0001';   -- R9
r := the row from timeslot_open_runs(goods seller ids, now()) with new.slot_id/new.slot_run_date;
if r is null or r.state <> 'open' then
  raise exception 'TIMESLOT_CLOSED' using errcode='P0001',
    detail = jsonb of { reason: r.state, closed_at: r.cutoff_at, window_start, window_end, next_open: first open run } ::text;   -- R7, R10
new.slot_window_start := r.window_start; new.slot_window_end := r.window_end;   -- server copies, client values ignored
new.slot_pay_pressed_at := now(); new.slot_needs_attention := false;
if (priority) new.priority_fee := 0;   -- decision 3 (only when enabled)
return new;
```
`now()` = transaction time, so "11:45:00 exactly" is refused (`p_at >= cutoff_at`). PostgREST surfaces `message`, `details`, `hint`, `code` to supabase-js — checkout keys on `message === 'TIMESLOT_CLOSED'` and parses `details`. For R16 (`max_orders`, build last): add `perform 1 from delivery_slots where id = new.slot_id for update` before the state check so two simultaneous pays cannot both pass a full count.

**(b) Slot columns are not customer-writable** — `trg_timeslot_guard_update BEFORE UPDATE ON orders`: if any `slot_*` column changes and not (`auth.role() = 'service_role'` or `current_setting('umzila.slot_write', true) = '1'`) → raise 'SLOT_COLUMNS_LOCKED'. Needed because the policy "Users can update their own orders" exists, and "a way for customers to change their own slot" is out of scope. The move/refund functions set the local config before writing.

**(c) Paid-time rule R11/R12/R13** — `trg_timeslot_on_paid BEFORE UPDATE OF order_status ON orders FOR EACH ROW WHEN (new.order_status = 'paid' and old.order_status is distinct from 'paid' and new.slot_id is not null)`:
```
paid_at   := coalesce(new.paid_at, now());
cutoff    := new.slot_window_start - cutoff_minutes; grace_end := cutoff + grace_minutes;
insert into delivery_runs (slot_id, run_date) values (new.slot_id, new.slot_run_date) on conflict do nothing;
if new.slot_pay_pressed_at < cutoff and paid_at <= grace_end then return new;        -- R11: stays (incl. grace)
nxt := first row of timeslot_open_runs(goods sellers of this order, paid_at) with state='open' and window_start > new.slot_window_start;
if nxt found then                                                                   -- R12
  insert delivery_run_moves (order_id, from_*, to_*, reason 'late_payment', actor 'system');
  new.slot_id := nxt.slot_id; new.slot_run_date := nxt.run_date; new.slot_window_start/end := nxt.*;
  insert into delivery_runs (…) on conflict do nothing;
else                                                                                -- R13
  insert delivery_run_moves (order_id, from_*, to_* null, reason 'late_payment', actor 'system');
  new.slot_needs_attention := true;
end if; return new;
```
Idempotency: the `WHEN` clause cannot fire twice for one order (second ITN: `old.order_status` is already `'paid'`), and `completeOrderPayment` itself returns after the update on `alreadyPaid`. The trigger is BEFORE, so the two AFTER triggers (`create_delivery_on_payment`, `populate_order_items_on_payment`) and `get_delivery_tracking` see the final run. Tests inject time by writing `slot_pay_pressed_at` and `paid_at` explicitly (service role) before/with the update.

### 3.6 Read functions for pages (SECURITY DEFINER where today's equivalents are)

- `get_delivery_tracking(p_order_id, p_token)` — **add** output columns `slot_window_start, slot_window_end, slot_cutoff_at, slot_needs_attention` (DROP + CREATE with the same body plus the join; callers `track.html:587`, `index.html:1139` ignore unknown columns).
- `get_ops_board()` — **add** `run_window_start/run_window_end` to each delivery object (cheap; logistics/admin may show it later; no UI change required in v1).
- `order-status.js` (Netlify, service role) — **add** `run: { run_date, window_start, window_end, cutoff_at, needs_attention, moved_from: {window_start, window_end, reason} | null } | null` to its JSON (read from `orders` + latest `delivery_run_moves`).
- `get_run_sheet(p_from date, p_to date) returns jsonb` — staff-only (same check as `get_ops_board`): for every run in range (slots × dates, plus any run that has orders even if the slot is now off/skipped): `{ slot_id, run_date, window_start, window_end, cutoff_at, state: 'taking_orders'|'preparing'|'out_for_delivery'|'done'|'skipped'|'paused'|'off', paid_count, busy (paid_count >= busy_alert_at), summary_sent_at, late_minutes, stores: [ { seller_id, shop_name, orders: [ { order_id, order_number, customer_name, customer_phone, address (delivery_address, city, postal_code), items: [ {name, size, qty} ], delivery_status, needs_attention, moved_from } ] } ] }`. `out_for_delivery` = any delivery in the run `IN_ROUTE+`, `done` = all delivered/cancelled or `now() > window_end`. House items are listed under "Umzila stock" per order.
- `admin_affected_orders(p_slot_id uuid, p_run_date date default null) returns setof …` — paid orders in future runs of a slot (or one run / one date) — the warning list when switching off / skipping / pausing.
- `admin_runs_for_order(p_order_id) returns jsonb` — runs an admin may move an order to: `timeslot_open_runs(order's sellers, now())` for today..today+days_ahead+1, every state returned (admin may knowingly pick a closed one; UI warns).

### 3.7 Write functions (admin, SECURITY DEFINER, admin check inside, `set_config('umzila.slot_write','1',true)`)

- `admin_move_order_run(p_order_id uuid, p_slot_id uuid, p_run_date date, p_reason text default 'admin') returns jsonb` — paid orders only; computes window from the slot; writes `orders.slot_*`, clears `slot_needs_attention`, inserts `delivery_run_moves` (actor admin = `auth.uid()`, `customer_emailed_at null`), upserts `delivery_runs`. The "Run changed" email is sent by the tick (§3.8) within a minute, or at once when the admin page calls the tick endpoint after the move.
- `admin_mark_order_refund(p_order_id uuid)` is **not** SQL: cancelling the delivery must go through `transitionDelivery` (Node). It lives in `netlify/functions/timeslot-admin.js` (§3.9).

### 3.8 The once-a-minute job — `netlify/functions/timeslot-tick.js` (scheduled `* * * * *`; also POST-able by an admin to run now)

Every step is idempotent and claim-first:
1. **Exit** unless `timeslot_enabled()`.
2. **Cut-off summaries** (R-Stores). `select` runs with `cutoff_at <= now()`, `run_date >= today−1`, `summary_sent_at is null` and (`summary_claimed_at is null` or older than 3 min). For each: **claim** (`update delivery_runs set summary_claimed_at = now() where … and summary_claimed_at is null returning *` after an `insert … on conflict do nothing`). Load paid orders (R14 filter). If none → `summary_sent_at = now()`, nothing sent (edge case "No paid orders at the cut-off"). Else per store not yet in `summary_sent_to`: build totals (name + size/picks → qty) then the orders one by one; email store recipients (`sellers.email` + owner + `seller_members` — same resolution as `complete-order-payment.js:602-609`, re-implemented in `lib/timeslots.js sellerRecipients()`); insert `seller_notifications` (type `run_summary`, metadata {slot_id, run_date, totals}); append seller to `summary_sent_to`. Then one admin email with the full run (all stores + Umzila stock) to `ADMIN_EMAILS`; then `summary_sent_at = now()`. A crash mid-way re-tries only the stores not yet in `summary_sent_to` — a store never gets two summaries, and none is lost.
3. **Grace additions** (R-Stores "During the payment grace"). Paid orders with `slot_id`, `paid_at > cutoff_at` of their (current) run, `paid_at <= grace_end`, no `notification_log` row `(order_id, 'TS_GRACE_ADD')`: email the store(s) + admins "Add to the 12:00 run" with the items; insert the log row; `seller_notifications` type `run_addition`. Unique index `notification_log (order_id, event_type) where event_type like 'TS_%'` makes the double-send impossible even if the hook (§3.9) and the tick race.
4. **Run changed emails**. `delivery_run_moves` with `to_slot_id not null and customer_emailed_at is null`: send, stamp. Needs-attention rows (`to_slot_id null`, reason late_payment): email customer "Umzila will contact you", admins "needs attention", stamp; log `TS_NEEDS_ATTENTION`.
5. **Busy alerts** (R17). Runs with `paid_count >= busy_alert_at` and `busy_alert_sent_at is null`: claim via `update … returning`, email admins once.
6. **Running late** is not here (sent synchronously by `timeslot-admin.js`).

The same handler is exported as `runTick(supabase, siteUrl)` so `timeslot-admin.js` can call it after a move.

### 3.9 Netlify functions and libs

- `netlify/functions/lib/timeslots.js` (A): `getSettings`, `fmtWindow(start,end)` ("Today 12:00–13:00" / "Tomorrow …" / "Sun 16 Nov 12:00–13:00" in SAST), `runLabel`, `loadRunOrders(slotId, runDate)` (R14 filter), `itemTotals(orders, sellerId)`, `sellerRecipients(supabase, seller)`, `adminEmails()`, `logOnce(orderId, eventType)` (insert into `notification_log`, 23505 = already sent), `timeslotAfterPaid(supabase, orderId, siteUrl)` = steps 3–5 of the tick for one order (grace add, run-changed/needs-attention, busy alert), `runTick`.
- `netlify/functions/lib/timeslot-mail.js` (D): pure HTML builders (contract in §4, workstream D).
- `netlify/functions/timeslot-tick.js` (A): scheduled + admin POST.
- `netlify/functions/timeslot-admin.js` (A): admin-only (Bearer token → `admins` table check, like `spin-admin.js`): `{ action: 'mark_refund', orderId }` → `orders.order_status='refunded'` (slot_write flag), `transitionDelivery(CANCELLED)` if a delivery exists, `delivery_run_moves` reason 'refund', customer email; `{ action: 'running_late', slotId, runDate, minutes }` → email every paid customer in the run, stamp `delivery_runs.late_minutes/late_sent_at`; `{ action: 'tick' }` → `runTick`.
- `netlify/functions/order-status.js` (A): add `run`.
- Additive hooks in `lib/complete-order-payment.js` (D, 3 small edits): (1) after the paid update, if `existingOrder.slot_id`, re-select `slot_window_start, slot_window_end, slot_needs_attention` (the trigger may have moved it) → used for the subject (`:225`) and intro (`:862`), and suppress the closed-store note (`:203-217`) when a slot exists; (2) one line `await timeslotAfterPaid(supabase, existingOrder.id, siteUrl).catch(log)` next to the other post-payment tasks (`:241-258`). `existingOrder` select (`:37`) gains `slot_id`. Nothing else in the file changes; `payfast-itn.js`, `generate-payfast-signature.js`, `charge-payfast-token.js`, `complete-zero-total-order.js` are **not edited**.
- Dispatch (E, only if decisions 1–2 are yes): `lib/batch-dispatch.js` — `offerDelivery()`/`sweepWaitingDeliveries()` skip deliveries whose order has `slot_window_start − cutoff > now()` (one select on `orders`); run-mode insertion in `lib/route-insertion.js planTrip()` (skip the 8-min protection between orders sharing `(slot_id, slot_run_date)`); `advance-delivery-on-fulfillment.js` unchanged (READY_FOR_DISPATCH still set on Mark Ready; the gate is in the offer).

### 3.10 Master switch — "off = exactly today"

`timeslot_enabled()` false ⇒ all three order triggers return `new` untouched; `timeslot_runs_for_cart` returns `{enabled:false}` so checkout renders the ETA strip, priority card and closed-store popup as today; the tick exits; `order-status.run` is null; `get_delivery_tracking` returns null slot columns so every page falls through to its current wording; the seller dashboard shows the flat list; admin pages still show (so slots can be prepared before switch-on). Orders paid before switch-on have `slot_id null` and behave as today (edge case "Order paid before the feature was switched on").

---

## 4. Workstreams (parallel; strict file ownership — no two workstreams touch one file)

### A — Database, rules, scheduler, server libs
**Owns:** the migration SQL (kept at `docs/plans/delivery-timeslots.sql` for review; applied with `apply_migration` names `delivery_timeslots_schema`, `delivery_timeslots_rules`, `delivery_timeslots_reads`), `netlify/functions/lib/timeslots.js`, `netlify/functions/timeslot-tick.js`, `netlify/functions/timeslot-admin.js`, `netlify/functions/order-status.js`, `netlify.toml` (one schedule block), `docs/systems/delivery-timeslots.md`, the `docs/CHANGELOG.md` entry (written last, after integration).
**Provides (contracts):** everything in §3.1–3.8: `timeslot_runs_for_cart(uuid[]) → jsonb`, `timeslot_public_config() → jsonb`, `timeslot_open_runs(uuid[], timestamptz)` (service role), the three `orders` triggers with error messages `TIMESLOT_REQUIRED` / `TIMESLOT_CLOSED` (+ `details` JSON `{reason, closed_at, window_start, window_end, next_open:{slot_id, run_date, window_start, window_end, cutoff_at}|null}`), `get_run_sheet(date,date)`, `admin_affected_orders`, `admin_runs_for_order`, `admin_move_order_run`, the added columns on `get_delivery_tracking` / `get_ops_board`, `order-status.js` `run` object, `timeslot-admin.js` actions `mark_refund | running_late | tick` (POST, `Authorization: Bearer <admin session>`, JSON `{ ok:true }` or `{ error }`).
**Consumes:** `lib/timeslot-mail.js` builders from D (A stubs them with plain-text bodies until D lands; the require path and signatures are fixed below).
**Covers acceptance tests:** R7/R8 list at 11:44/11:45/17:50 (unit, time-injected), R10 refusal at 11:46 (insert as anon with `now()` — verified in the sandbox deploy; unit-tested by calling `timeslot_open_runs` at 11:46), R11 11:48 grace, R12 11:52 move, duplicate ITN, R13 needs attention, R15/R17 20 orders + one busy alert, store summary once with correct totals / none when empty, R18 closed store at 17:45, slot edit leaves sold window, cut-off change applies only to open runs, device clock irrelevance (server-side by construction).
**Order:** first — B, C, D build against A's contracts; A ships the migration on the live DB with `enabled:false` (inert) as soon as it passes unit tests so the others can test against real RPCs.

### B — Checkout picker and Pay integration
**Owns:** `checkout.html` only.
**Builds:** `loadTimeslotConfig()` on init (one `timeslot_public_config` RPC alongside the existing warm-ups at `:5787`); when enabled: picker component inside `#estimatedDeliveryTime`'s place (grouped by day, earliest open selected, "Order in the next N min" under 60 min / "Order by 13:45" otherwise, 5-min red warning "Pay in the next 4 min to get this time", closed-today / nothing-open messages, Pay disabled when nothing open — R9); refresh via `timeslot_runs_for_cart(goodsSellerIds)` on load, every 30 s, at every cut-off boundary, and whenever the cart's seller set changes (reuse the seller-id derivation at `:4603/:4609`); server-anchored countdown; Pay button label with the window (`:2604`); `orderData` gains `slot_id`, `slot_run_date` (`:5497`); `priority_fee` forced 0 and `renderPriorityCard()` hidden, `refreshEstimatedTime()` short-circuits to the picker, `confirmClosedStores()` returns true without a popup — all only when `enabled`; the `TIMESLOT_CLOSED` / `TIMESLOT_REQUIRED` errors at `:5561` become the brief's sentence + auto-select next run + re-enable Pay (no automatic retry); the "How delivery works" note ("Order by 11:45 and get it between 12:00 and 13:00", from the selected run). Services-only carts: no picker (`cartHasProducts` false). `?store=` scoped checkouts and Buy Now work unchanged (the picker only depends on `state.cart`'s sellers).
**Consumes:** A's `timeslot_public_config`, `timeslot_runs_for_cart`, trigger error contract.
**Covers:** 11:44 list+select, 11:45 switch to 14:00, 17:50 tomorrow only, all slots off → closed message + Pay disabled, service-only → no picker, device clock 3 h wrong, switch off → identical page (every new branch is behind `state.timeslots.enabled`), Pay refused → "12:00 to 13:00 closed at 11:45. The next delivery time is 14:00 to 15:00" and no charge without a second tap.
**Order:** can start on the UI with a mocked RPC response immediately; integrates once A's migration is live (inert) — toggling `enabled` locally is a `site_settings` update on a test row only in a Supabase branch or against `netlify dev` with a dev project.

### C — Admin console
**Owns:** `admin.html` (menu item under Delivery `:491-496`, `<section id="section-delivery-times">` shell, loader wiring at `:3032-3037`, one `<script src="/timeslots-admin.js">`), new `timeslots-admin.js`.
**Builds (all phone-friendly; follow the ops-panels.md gotcha — real CSS classes, no inline grid templates):**
1. *Slots list* — window, computed cut-off (from settings), days chips, on/off switch, max orders; add/edit modal; direct `delivery_slots` writes under admin RLS; surface `SLOT_OVERLAP` / `SLOT_HAS_PAID_ORDERS` messages; a slot with paid future orders shows "switch off instead of delete".
2. *Settings card* — the five values → `site_settings` upsert key `timeslots` (copy the Home Page save at `:5565`); "Timeslots on" is a clearly labelled master switch with a confirm.
3. *Date controls* — skip one run (slot + date), pause a date → `delivery_slot_exceptions`; list + remove.
4. *Affected-orders warning* — on switch-off / skip / pause, call `admin_affected_orders`; show the list with per-order and "all" actions: **Move** (opens `admin_runs_for_order` → `admin_move_order_run`, then POST `timeslot-admin` `{action:'tick'}` so the "Run changed" email goes now) and **Mark for refund** (POST `timeslot-admin` `{action:'mark_refund'}`). The same Move action is available on any order in the run sheet ("customer phoned").
5. *Run sheet* — `get_run_sheet(today, tomorrow)`: per run window, cut-off, state pill, paid count, busy mark, "Running late" button (minutes prompt → `timeslot-admin` `{action:'running_late'}`), "No orders" when empty; orders grouped by store with order number, customer name, phone (tel: link), address, items; needs-attention orders highlighted at the top with Move/Refund.
**Consumes:** A's RPCs and `timeslot-admin.js`.
**Covers:** skipping today's 14:00 removes it from checkout (via A's rule — C verifies with the run sheet + B's page), keeps paid orders, lists them in the warning, Move sends the email; slot edit 12:00→12:30 leaves a paid order at 12:00–13:00 (visible in the run sheet); every setting changeable without code.
**Order:** starts immediately on markup/CSS; data wiring after A's inert migration is live.

### D — Seller dashboard, emails, customer wording
**Owns:** `seller-dashboard.html`, `netlify/functions/lib/complete-order-payment.js` (the three additive edits in §3.9 only), `netlify/functions/lib/timeslot-mail.js`, `checkout-success.html`, `track.html`, `index.html` (widget wording at `:1154-1181` only), `profile.html` (`:1472` badge only).
**Provides (contract A requires):** `lib/timeslot-mail.js` exporting pure functions returning `{ subject, html }`:
- `storeRunSummary({ shopName, run:{window_start, window_end, cutoff_at, run_date}, totals:[{name, size, qty}], orders:[{order_number, customer_first_name, items:[{name,size,qty,note}], notes}], siteUrl })`
- `adminRunSummary({ run, stores:[{shopName, totals, orders}], houseItems:[{name,qty}], siteUrl })`
- `storeRunAddition({ shopName, run, order })` and `adminRunAddition(...)` — "Add to the 12:00 run"
- `customerRunChanged({ firstName, orderNumber, fromRun, toRun, cutoffAt, siteUrl })` — old window, new window, "cancel for a full refund until 13:45 — reply to this email or WhatsApp …"
- `customerNeedsAttention({ firstName, orderNumber, siteUrl })`, `adminNeedsAttention({ order, siteUrl })`
- `adminBusy({ run, paidCount, busyAt, siteUrl })`
- `customerRunningLate({ firstName, orderNumber, run, minutes })`, `customerRefunded({ firstName, orderNumber, total })`
All use `notify.js`'s exported `emailShell`/`esc` for consistent chrome; every send in A uses `mailFrom('Umzila','orders')` / `mailFrom('Umzila Sellers','sellers')` (transactional, never the news stream).
**Builds:** seller dashboard grouping by run with header "12:00 run · start preparing at 11:45 · collection about 12:00", "Do not prepare yet" (Mark Ready hidden) → "Prepare now" (Mark Ready shown) using `timeslot_public_config().server_now` and a 30-s timer, "Run summary" card from `seller_notifications` (`run_summary`, `run_addition`) with the item totals; `isPastOrder` unchanged. Confirmation email subject/first line with the window; moved/needs-attention variants. `checkout-success.html` reads `order-status.run` → "Order confirmed. Arriving today between 12:00 and 13:00." / moved note / "Umzila will contact you". `track.html` + `index.html` widget + `profile.html` map `(deliveries.status, slot_window_*, slot_cutoff_at, now)` → Confirmed / Preparing / Out for delivery / Delivered wording (slot present) and leave today's wording when no slot. Remove the "driver is on it"-class sentences for slot orders listed in §1.4.
**Consumes:** A's `order-status.run`, `get_delivery_tracking` slot columns, `seller_notifications` rows, `timeslot_public_config`.
**Covers:** store receives exactly one summary with correct totals (template correctness; A covers once-ness), "Run changed" email content + cancel route wording, no page/email with instant-driver wording for slot orders, service/booking orders unchanged in dashboard and emails.
**Order:** `timeslot-mail.js` first (A depends on it for real tests), then the dashboard, then the wording pages once A's read functions are live.

### E — Dispatch integration (only after decisions 1–2; otherwise skipped)
**Owns:** `netlify/functions/lib/batch-dispatch.js`, `netlify/functions/lib/route-insertion.js`, `docs/systems/ops-panels.md` (one paragraph).
**Builds:** the cut-off gate in `offerDelivery()`/`sweepWaitingDeliveries()` (skip and log `waiting_for_run` when `slot_window_start − cutoff_minutes > now()`); run-mode insertion (no 8-min protection among same-run orders). `advance-delivery-on-fulfillment.js` untouched.
**Covers:** store marks ready at 10:30 → no offer until 11:45; six same-run orders land on one rider's trip. Tested locally with the existing dispatch test approach (straight-line fallback, no ORS key).

**Integration owner (parent):** flips nothing live until §5 passes on the deploy preview; adds the CLAUDE.md standing paragraph (tables, master switch, "never build a second slot/ETA system", `timeslot_open_runs` is the one rule) after A's doc exists.

---

## 5. Test plan — every acceptance test → how it is verified

Time-injected tests run as SQL against a **Supabase branch** (or inside `begin … rollback` with the service role) using `timeslot_open_runs(ids, '2026-11-16 11:44+02')` etc. and explicit `slot_pay_pressed_at`/`paid_at` values; UI/payment tests run on `netlify dev` + a deploy preview with PayFast sandbox (`PAYFAST_SANDBOX=true`) and the DB switch on for that environment only.

| Acceptance test (brief) | How verified |
|---|---|
| 11:44 lists 12:00–13:00 and selects it (R7, R8) | SQL: `timeslot_open_runs` at 11:44 → 12:00 row `state='open'`, first in order. UI: B's picker with a mocked `server_now` of 11:44 shows it selected. |
| 11:45 no longer lists it, selects 14:00 (R7) | SQL at 11:45:00 → 12:00 `closed`, 14:00 first `open`. UI: countdown hits 0 → re-fetch → selection moves, message shown. |
| Pay request at 11:46 for 12:00 run, bypassing the page (R10) | SQL (branch, as `anon` via `set role anon` + a JWT-less insert mirroring checkout's payload): `insert into orders (…, slot_id, slot_run_date)` with the DB clock at 11:46 (test: temporarily call the guard's inner check with `p_at`; live: run on the preview at a real 11:46 once) → `TIMESLOT_CLOSED`, no row. Also: insert with `slot_id null` → `TIMESLOT_REQUIRED`. |
| Pay 11:44, confirmed 11:48 → 12:00 run (R11) | SQL: insert order with `slot_pay_pressed_at='…11:44'`, then `update orders set order_status='paid', paid_at='…11:48'` → slot unchanged, `delivery_run_moves` empty, `notification_log TS_GRACE_ADD` written by the tick/hook once (run tick twice → still one row). |
| Pay 11:44, confirmed 11:52 → 14:00 run, "Run changed" email, cancel route (R12) | SQL as above with `paid_at='…11:52'` → `slot_window_start` = 14:00, one `delivery_run_moves` row reason `late_payment`; tick → Resend call made once (log row), `customer_emailed_at` stamped. Cancel route: email body names "until 13:45" and the contact; admin "Mark for refund" on that order → `order_status='refunded'`, delivery `CANCELLED`. Repeated on the preview with the sandbox by delaying the ITN (sandbox ITNs can be re-posted by hand; or hold the order in `pending_payment` and post the ITN after the grace). |
| Same ITN twice → one confirmed order in one run | Node script calling `payfast-itn` handler twice with the same signed sandbox body (or `completeOrderPayment` twice): second run returns at `alreadyPaid`; trigger `WHEN` does not fire; exactly one `delivery_run_moves`/`notification_log` row; `deliveries` has one row (`on conflict do nothing`). |
| 17:50 → only tomorrow's runs (R8) | SQL at 17:50 → every today row `closed`, tomorrow rows `open`. UI copy "Deliveries are closed for today. The next delivery time is tomorrow, 12:00 to 13:00." |
| Every slot off → closed message, payment disabled (R9) | Set all `active=false`; RPC returns no open run; picker shows the message; Pay disabled; a forced insert → `TIMESLOT_CLOSED` (`reason:'off'`). |
| 20 paid orders in one run, exactly one busy alert at the 6th (R15, R17) | SQL loop inserting+paying 20 orders (service role); no refusal (`max_orders null`); `delivery_runs.busy_alert_sent_at` set once; tick run repeatedly → one admin email (log). |
| At 11:45 a store with 3 paid orders gets exactly one summary with correct totals; a store with none gets nothing | Seed two stores, 3 orders (mixed qty/sizes) for one; run the tick at ≥11:45 three times → one claim, one email per store (store 2: none), `summary_sent_to` = [store1], totals assert (e.g. 2× "Beef plate / Pap", 1× "Wings"); admin summary once. Simulated crash: stop after store 1 in a two-store run → next tick emails only store 2. |
| Skipping today's 14:00 removes it from checkout, keeps paid orders, shows them in the warning; moving one sends "Run changed" (R5) | Insert exception → RPC state `skipped`; paid orders untouched; `admin_affected_orders` lists them; `admin_move_order_run` + tick → one email, one moves row (reason `admin`, actor id set). |
| Slot 12:00→12:30 edit leaves a paid order at 12:00–13:00 | Update `delivery_slots.start_time`; order's `slot_window_start` unchanged; run sheet shows the order under its sold window; new RPC rows show 12:30. |
| Cart whose store is closed at 17:45 is not offered the 18:00 run (R18) | `seller_availability` for the test store ends 17:30; RPC at 16:00 → 18:00 row `store_closed`, `blocking_store` = its name; 16:00 run `open`. Also a store with no hours → every run `open`. |
| Service or booking order checks out with no picker (R19) | B: cart of one Nceks booking → `cartHasProducts` false → no picker, no slot columns; A: insert with services only passes the guard with `slot_id null`. |
| Device clock 3 h wrong (R21) | B: set the OS clock +3 h in a browser profile; list and deadlines unchanged (`server_now` offset); countdown correct. |
| "Timeslots on" off → checkout exactly as today | `enabled:false`: run the existing checkout smoke (`docs/qa-guest-checkout.e2e.js`) + a visual diff of the delivery step; inserts carry no slot columns; triggers no-op (assert `slot_pay_pressed_at is null`). |
| No page or email contains "a driver is on it" or similar for delivery orders | grep for the §1.4 phrases after D's work (for slot orders) + a manual read of the five emails and four pages with a slot order. |
| Edge: cut-off minutes change applies only to runs whose cut-off has not passed; a sent summary never reopens | SQL: 15→30 at 11:40 → 12:00 run now `closed` (cutoff 11:30); 15→5 at 11:47 with `summary_sent_at` set → still `closed`; without summary → `open` again until 11:55 (documented behaviour). |
| Edge: late payment, no later run in range (R13) | Last run of the day, `paid_at` past grace, `days_ahead=0` → `slot_needs_attention=true`, moves row with null `to_*`; tick → customer + admin emails once; run sheet highlights it; `admin_move_order_run` clears the flag. |
| Edge: order at 23:59 → "today/tomorrow" by SAST date | `timeslot_open_runs(ids, '2026-11-16 23:59+02')` → run_dates 16th (all closed) and 17th. |
| Edge: payment fails/abandoned → never in a run list | `pending_payment` rows are excluded by every list (R14 filter); `get_run_sheet` count unchanged; PayFast CANCELLED ITN path (`payfast-itn.js:71`) untouched. |

Before switch-on (brief, Rollout 3–4): wording changes live but inert, slots + hours entered, switch flipped after the last cut-off of the day by the founder in Admin → Delivery Times.
