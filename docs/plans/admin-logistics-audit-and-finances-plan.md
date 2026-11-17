# Admin + Logistics audit, and the Finances page — plan

> ## ⚠️ FOUNDER ANSWERS (2026-11-16) — override everything below where they differ
>
> 1. **Commission is a MARK-UP, not 15 % of the sale.** Umzila adds its commission onto the store's price: the store's price for a plate is R130, Umzila sells it at R137, the R7 is Umzila's commission and the store is owed R130. Founder says "9 % added onto the prices for now" but the example is R7 on R130, so per-product amounts differ. **Build:** a per-product "store price" (what the store is owed per unit, per variant where variants have their own price) editable by admins in Finances and stored server-side (e.g. products.metadata.store_price / per-variant — architect's choice, justify). Where it is not filled in, fall back to the editable assumption default_markup_percent = 9 (store owed = price / 1.09) and flag the line as estimated. Commission = what the customer paid for the goods minus store owed. Show a "products without a store price" list so the founder can fill them in. The 15 % seller-terms rule is NOT the live model.
> 2. **Discounts:** a store's own promo codes come out of the store's share; Umzila's codes (mystery gift, spin, referral, platform) are Umzila's cost. (As defaulted.)
> 3. **Manual ORD- orders** = cash, no fee, store owed as per rule 1. The 3 delivered-but-pending ones were cash — record them as paid cash.
> 4. **Test orders:** do NOT bulk-exclude the 18. Some are real (e.g. a big lump sum = the founder recording several ice-cream orders as one). Exclude only the obvious tests (e.g. the R5 Apple Pay order) and give the founder an easy per-order "exclude as test" toggle. The R39.25 rider payout on the R5 test was NOT paid — override its rider pay to 0; no delivery was charged on it.
> 5. **Tips, rider pay, priority:** riders are currently Umzila staff. ALL money customers pay (tips, delivery fees, priority) is Umzila revenue. Rider pay is NOT an automatic per-order cost now — riders are paid as staff (the founder records wages/fuel as expenses). Make "count driver_payouts as a cost" an assumption toggle, default OFF, for when riders become contractors.
> 6. Priority fee: Umzila keeps it all.
> 7. **House drinks cost of goods:** small Coke R15, small Fanta R15, small Sprite R15, big bottles R18, Appletiser R22, Liqui Fruit R18 (map to the house products by name/size; anything unmatched is flagged "cost missing"); editable in Finances.
> 8. **PayFast fee rates (ex VAT, plus 15 % VAT):** card 3.2 % + R2; Apple Pay, Google Pay, Samsung Pay same as card; Capitec Pay 2 % (min R2); Instant EFT 2 % (min R2). Editable. The actual ITN amount_fee always wins.
> 9. **No per-store payout ledger.** Stores are settled instantly. Instead add a way to record **payout fees** (PayFast charges a fee on each payout to a store): a finance entry category "PayFast payout fee" (one-off entries, optionally linked to a store).
> 10. Enspire R30 000: the founder adds it via the page.
> 11. Drop the obsolete tables only if truly unused (grep the whole repo + DB functions/views/triggers first).

>


_Written 2026-11-16 by the lead architect pass. Read-only probes against the live project (no schema changes, no commits). Founder brief: "logistics and admin have inconsistencies, redundant and inaccurate stuff; I want a Finances page that takes the payment method and its fees into account, deducts them automatically, is editable (add/remove expenses, income, corrections), and shows whether we are making a profit."_

Companion docs to read before building: `CLAUDE.md` (Admin-manageable by default; analytics rules), `docs/systems/ops-panels.md`, `docs/systems/delivery-timeslots.md`, `docs/systems/payment-picker.md`, `docs/systems/house-addons.md`, `docs/systems/spin-wheel-spec.md`.

---

## 0. What the live data actually looks like (the ground every number below stands on)

Probed 2026-11-16 (read-only SQL). These facts decide most of the audit verdicts and all of the Finances formulas.

| Fact | Value | Why it matters |
|---|---|---|
| `orders` with `payment_status='paid'` | **66** (sum `total` R8 927.04) | This is the only honest "paid" filter. `order_status` moves on (Delivered/Fulfilled/paid) and must never be used for money. |
| …of which real PayFast payments (`pf_response` present, with `amount_gross/amount_fee/amount_net`) | **35** (gross R3 096.70, PayFast fees R182.01, net R2 914.69) | Actual fees exist for every PayFast order since day one — in `orders.pf_response`, not only in `payment_attempts`. |
| …of which manual `ORD-…` orders entered in logistics (no PayFast id, `paid_at` NULL) | **30** (~R5 830) | No fee, no payment method recorded, no `paid_at`. Their `order_items.seller_id` is **NULL on all 49 rows** (resolvable 49/49 via `products.seller_id`). |
| …of which seller enrolment fee | 1 (R100, `label='seller_enrollment'`) | Not a sale; other income. |
| Orders from the founder's own addresses (`nontandod23@…`, `ntandob38@…`) | **18 paid orders, R3 041.76** — a third of all "revenue" | Test/QA orders are mixed into every revenue figure on both portals. The R5 Apple Pay test of 2026-11-16 even completed a route and created a **R39.25 rider payout**. |
| Manual orders `Delivered/Fulfilled` but `payment_status='pending'` | 3 (R460) | Shown as delivered in logistics, counted as revenue nowhere. |
| `pending_payment` (abandoned) orders | 76 (R6 371) · 14 in the last 14 days | Must be excluded from every money figure; logistics Analytics includes them today. |
| `orders.total` ≠ PayFast `amount_gross` | 3 orders | `total` is browser-written; PayFast gross is the cash truth. |
| Network deliveries | 15 DELIVERED, 1 CANCELLED (order R54.50 still `paid` — no refund status exists anywhere) | Refunds need a manual adjustment entry. |
| Rider pay | `driver_payouts`: 14 rows, R571.57, all `status='pending'`, one per **route**; `calculation_basis.deliveries[]` carries `delivery_id` + `pay` per delivery | Per-order rider cost is recoverable from the JSON; two-drop routes (R77.50) must be split by delivery. |
| Customer delivery fee vs rider pay | `shipping_cost` = quote `total_delivery_fee` (includes `priority_fee`); `margin_percent` is **0** | Delivery is pass-through today: Umzila keeps only priority (R15 once so far) and loses the rider pay on free-delivery orders. |
| PayFast fee pattern | card ≈ (3.2 % × gross + R2.00) × 1.15 VAT (R5 → 2.48, R314 → 13.86); one Instant-EFT-looking order (R110 → 2.53 = 2 % × 1.15) | Fee *estimates* per method are feasible and verifiable; rates must be admin-editable. |
| `payment_attempts` | 1 paid (apple_pay, fee 2.48), 7 `no_answer` | Picker switched **on** at 09:41 2026-11-16; Admin → Payments → Report only sees these 8 rows. |
| Tips | R0 ever (`tip_amount`) | Keep the column in the model; nothing to show yet. |
| Discount codes | 124 seller promo codes (`seller_id` set, `percentage`), 36 mystery_gift, 3 platform %, 1 free_item, 1 referrer_reward; 5 used, all seller codes (ISIQALO…/VELAPHI…, R51.23 of discount on paid orders) | Who funds a discount depends on `discount_codes.seller_id` (seller) vs NULL (Umzila). |
| House seller | `Umzila Drinks` (`is_house`), 8 products, **1** order line sold (R32.90) | House goods are Umzila revenue minus cost of goods; no cost column exists anywhere. |
| Sellers | 11 active non-house + 1 house, 3 disabled, 7 pending | Admin "Active Sellers" shows 12. |
| `delivery_pricing_config` active v1 | per_seller_fee 3, priority_fee 15, margin_percent 0, large_overflow_fee 10 | `large_overflow_fee`, `free_delivery_threshold`, `default_units_per_trip` are legacy fields no code prices with any more (band is in `lib/delivery-price.js`). |
| `user_events` | 640 in 30 days (2 295 total) | admin-analytics' hard `limit(10000)` is safe for now; note it. |
| `driver_offers` | 15 accepted, 5 expired, 0 pending-and-expired | Admin → Deliveries "Stale unaccepted offers" can never show anything. |
| Obsolete tables | `"Logistics"` (2 rows, capital L), `user_roles_backup` (1), `discount_redemptions` (0 rows) | Candidates for removal after a code grep. |
| `site_settings` keys | `home`, `payments`, `timeslots` | Finance assumptions go in a new key `finance` (same pattern). RLS: `site_settings_select_all`, `site_settings_admin_write`. |
| Admin gate used by the newest RPCs | `timeslot_is_admin()` = row in `public.admins` (2 admins); staff gate `timeslot_is_staff()` adds active `user_roles` logistics/admin | Finance RPCs use `timeslot_is_admin()`; logistics-visible sales RPCs use `timeslot_is_staff()`. |

---

## 1. Audit findings

Priority: **P1** = a number the founder reads is wrong or misleading about money/ops · **P2** = redundant/obsolete/dead or mislabeled · **P3** = cosmetic or consistency.

### 1.1 admin.html

| # | Pri | Section · file:line | What it reads | Problem (with evidence) | Fix |
|---|---|---|---|---|---|
| A1 | P1 | Dashboard → "Total Revenue", "Product Sales", "Enrollment Fees", "Ad Revenue", "Total Orders" — `admin.html:546-556`, filled by `netlify/functions/admin-analytics.js getOverview()` L79-120 | `orders.total` for every `payment_status='paid'` row + `ad_campaigns.amount_paid` | Labelled "Revenue" but it is **cash through the till**: it contains the 85 % owed to stores, the delivery fee passed on to riders, priority, tips; it includes the founder's 18 test orders (R3 041.76 of R8 927) and the 30 manual orders with no method recorded; it ignores the 3 `total ≠ amount_gross` orders. "Revenue — last 30 days" chart (`getTrendsData`) buckets by `created_at` in **UTC**, not SAST, and by order date not pay date. | Replace KPI rows 2–3 and the two money charts with `fin_summary()` figures (§2.3): *Order value (incl. delivery)*, *Umzila gross profit*, *Net after costs*, paid orders — with the same test-exclusion the Finances page uses. Keep "Active Sellers", "Favourites". Link the cards to the Finances tab. `admin-analytics.js overview/trends` keep serving Intelligence but drop the money fields (or compute them from the same RPC) so there is one source. |
| A2 | P1 | Intelligence → Sellers "Est. Revenue" — `admin.html:3339-3361`, `admin-analytics.js getSellerIntelligence()` L255-263 | `orders.items[].seller_id` × `item.total||price × quantity`, paid orders, lifetime | Manual `ORD-…` orders' items carry **no `seller_id`** (49/49 `order_items` rows NULL too), so ~R5.8k of sales across 30 orders is attributed to nobody; checkout items are attributed at list price ignoring the order's discount; house drinks go to "Umzila Drinks" (correct) but nothing says it is Umzila's own. Mixed windows (visits = 30 d, revenue = lifetime). | Read per-store goods value from `fin_store_breakdown(from,to)` (§2.3; attribution = `order_items.seller_id` **else `products.seller_id`**), 30-day window to match the visits column, label "Goods sold (30 d)" and show "Owed to store" next to it. |
| A3 | P2 | Dashboard → "Active Sellers" — `getOverview` L93 | `sellers.status='active'` count | Counts the house seller (12 shown, 11 real stores). CLAUDE.md: anything counting stores ignores `is_house`. | Add `.eq('is_house', false)`. |
| A4 | P2 | Dashboard → "Carts w/ Items" — `getOverview` L96, L107 | every `carts` row with items | 57 = 46 guest baskets + 8 rows older than 30 days; a lifetime count of stale rows. Logistics → Baskets already shows this properly (14 days, contact details, unfinished payments). | Remove the card (or make it "Baskets with contact details, last 14 days" from the same rule logistics uses). |
| A5 | P2 | Dashboard → "Total Products", "Active Sale Items", "Low Stock (<5)", "Out of Stock" — `admin.html:539-541`, `1712-1714`, `3493-3519` | `productsCache` (all products) | 347 includes 100 hidden products, services (no stock concept), and the house seller's drinks; "Low stock" 71 counts services and hidden items; "Out of stock" the same. | Count `visible && listing_type='product'` only; show the house seller's stock separately ("Umzila Drinks stock") since it is Umzila's own inventory. |
| A6 | P2 | `updatePendingCount()` — `admin.html:1572-1605`, comment at `1715` | `orders` by `order_status in ('paid','Packaging')` | Dead code: `#statPending` no longer exists (card replaced by Open Deliveries). The localStorage `ORDERS_KEY` fallback is a leftover from the pre-Supabase prototype. | Delete the function and the `ORDERS_KEY` fallback. |
| A7 | P2 | Settings → "Change Password" (`admin.html:1248-1255`, `onclick="alert('Dummy only — no-op')"`), "Add Dummy User" (`1263`, `3112`), "Export Inventory (JSON)" (`1260`, `3104`) | — | Three dead controls. A dummy button on the live admin portal. | Replace Change Password with a real `supabaseClient.auth.updateUser({ password })` (re-auth with current password via `signInWithPassword` first). Remove Add Dummy User and the JSON export (Manage Products has the list; CSV export will live in Finances). Put the **Finance assumptions** card here or under Finances (§2.5). |
| A8 | P1 | Delivery Analytics → Summary — `admin.html:5960-5990`, view `delivery_analytics_summary_v` | all `deliveries`, `driver_payouts`, `delivery_quotes` | "Avg delivery time" = `delivered_at − deliveries.created_at`, which includes closed-store waits and timeslot run holds (an order paid at 21:00 for tomorrow's 12:00 run counts ~15 h); "PIN completion rate" is really delivered ÷ (delivered + failed); "Total rider payout" is **all-time** (incl. the R39.25 paid on the founder's R5 test) while "Total delivery revenue" is only DELIVERED quotes — the two are not comparable; no date range. Footnote still says these metrics are "deferred" although `delivery_events` timestamps exist. | Rebuild on `fin_delivery_breakdown(from,to)` (§2.3): per order customer fee (ex priority), priority, rider pay (from `calculation_basis`), margin; "Time to deliver" = `delivered_at − dispatched_at` (or the `ORDER_READY` event), "Delivered share" instead of "PIN completion rate". Keep compliments/complaints. Date range like Finances. |
| A9 | P2 | Delivery Analytics → Route Profitability — `admin.html:5992-6017`, view `route_profitability_v` | per route | "Revenue" (`total_delivery_fee`) already **contains** priority, then "Priority" is listed again; "Remaining" is fee − payout and ignores markup (0 today) and free-delivery orders (fee 0, payout R39.25 — a loss shown as −39.25 with no explanation). Route ids truncated to 8 chars are meaningless to the founder. | Show per **order** (customer sees orders, not routes): fee, priority, rider pay, margin, and flag "free delivery — rider paid by Umzila". Keep a small per-route table only if useful; derive from the same RPC. |
| A10 | P2 | Dashboard → Live now + Delivery Ops riders + Deliveries list — `admin.html:2385-2452`, `4780-4853`, `5052-5114` | `get_ops_board()`, `drivers`, `deliveries` | Three screens show riders/deliveries from three sources with different freshness (30 s / manual / manual); the riders table has a "Capabilities: Live / Scheduled" column (`4827`) — `can_do_scheduled_collections` drives no flow anywhere. `get_ops_board` `stores` includes the **house** seller, so an order with a drink reads "Velaphi Shisanyama + Umzila Drinks" (CLAUDE.md: ignore `is_house` when naming stores). | Drop the Capabilities column; in `get_ops_board` filter `where not s.is_house` in the `stores` subquery (both logistics Today and admin Live now benefit). Leave the three screens (they serve different jobs) but make Delivery Ops riders read the same `get_ops_board().riders` instead of a direct `drivers` select. |
| A11 | P2 | Deliveries → "Stale unaccepted offers" — `admin.html:4959`, `4993-5002` | `driver_offers` `status='pending'` and expired | The dispatcher marks offers `expired` itself (5 expired, 0 pending-and-expired, ever). The block can never render. | Remove, or change to "Offers that expired today" (`status='expired' and expires_at > today`) which is actually useful. |
| A12 | P1 | Payments → Report — `payments-admin.js loadReport()` L171-193, RPC `admin_payment_report` | `payment_attempts` only | Attempts exist only since the picker went on (2026-11-16 09:41): 8 rows. The 35 PayFast orders with real fees in `orders.pf_response` are invisible, so "PayFast fees" here is R2.48 while the true total is R182.01. With the picker off the report is empty forever. | Keep this tab as the **picker funnel** (started / paid / share) and relabel its heading "Payment attempts since the picker was switched on"; move money (fees per method, effective %) to Finances, which reads `orders.pf_response` first and `payment_attempts` only for method/option (§2.4). |
| A13 | P2 | Manage Shops — `admin.html:3715-3800` | `sellers` | Tabs are Active / Disabled / All: the 7 `pending` stores only appear under All with an amber pill and no "Pending" tab; the house seller is listed like any store (Disable Shop, free-delivery toggle, owners) with nothing marking it as Umzila's own. | Add a Pending tab; show a "House — Umzila's own" badge and hide Disable for `is_house`. |
| A14 | P2 | Intelligence → Insights "Revenue Snapshot" — `admin.html:3434-3440` | `overview` | "That's one order every ~N days" = `30 / totalOrders` with lifetime totals — meaningless. | Replace with Finances figures (orders per week in the window, average order value, best store, gross-profit margin %). |
| A15 | P3 | Dashboard → Visitors "Where orders come from" — `get_site_traffic` sources | `orders.source`, `sum(total)` | Fine, but "sales" is `orders.total` (incl. delivery/tips) and counts test orders. | Apply the same exclusion rule as Finances once `fin_excluded_order_ids()` exists (§2.3). |
| A16 | P3 | Delivery Pricing — `admin.html:5765-5930` | `delivery_pricing_config` | Shows/edits `per_seller_fee`, `large_overflow_fee`, `free_delivery_threshold`, `default_units_per_trip`, `max_bundle_leg_km` — only `priority_fee`, `margin_percent`, `max_service_distance_km` are read by current pricing (`lib/delivery-price.js`, `get-delivery-quote.js`); the R34/R0.40/R45 band itself is **hardcoded** in JS + the payout trigger. | Out of scope for this build but flag it: move the band (`min`, `included_km`, `per_km`, `max`, `fallback`, `per_extra_store`) into `delivery_pricing_config` and read it in `delivery-price.js`, `payout-formula.js` and `compute_driver_payout_on_route_completion`; hide the dead fields. Finances reads the band only to *estimate* rider pay before a route completes. |
| A17 | P3 | Spin & Win → Results — `netlify/functions/spin-admin.js` L65 | paid orders by `coupon_code` | Correct filter (`payment_status='paid'`). No change. | — |

### 1.2 logistics.html

| # | Pri | Section · file:line | What it reads | Problem (with evidence) | Fix |
|---|---|---|---|---|---|
| L1 | P1 | Analytics tab — `logistics.html:3191-3240` (`fetchRange`, `runAnalytics`) | every `orders` row in the date range, minus `order_status='Returned'`, summed in the browser | **Counts unpaid orders as revenue**: the 76 abandoned `pending_payment` orders (R6 371), the 3 unpaid manual orders, the enrolment fee; dates are UTC midnight boundaries (`T00:00:00Z`), period keys from the device clock; "Top 10 products" uses `items[].price × quantity` from JSON (ignores discounts, variant prices, picks). Live check for Oct 2026: this tab says 16 + abandoned ≈ 40 orders; truth is 16 paid. Breaks "do not trust frontend calculations for financial data". | Replace the tab body with two staff-readable RPCs: `fin_sales_by_period(from,to,gran)` and `fin_top_products(from,to)` (§2.3, `timeslot_is_staff()` gate, paid-only, SAST, same exclusions as Finances). The admin Finances page is the full picture; logistics keeps only orders + top products. |
| L2 | P1 | Stores tab — `logistics.html:3043-3100` | `sellers`, `products`, in-memory `ORDERS` | `s.status==='approved'` is never true (values are `active`/`pending`/`disabled`) → **every store shows "Pending"**; "revenue" sums `items.price × quantity` of all loaded orders incl. manual orders with `payment_status='pending'`; the house seller is listed as a store. | Badge from `status==='active'`; "House" badge for `is_house`; sales + order count from `fin_store_breakdown` (paid only, attribution via `order_items`/`products.seller_id`). |
| L3 | P2 | Today → "Paid orders today", "Sales today" — `logistics.html:1197-1204` | in-memory `ORDERS`, `created_at`, device-local midnight | Day boundary is the device clock, not SAST; "created" not "paid" (an order created 23:50 and paid 00:05 lands on the wrong day); includes test orders. | Read `get_ops_board()` → add `paid_today: {orders, total}` computed server-side in SAST by `paid_at` with the Finances exclusion; or call `fin_sales_by_period(today,today,'day')`. |
| L4 | P2 | Order detail → Edit → "Payment status" select — `logistics.html:1626-1627` (pending/paid/failed/refunded) | — | **Dead control**: `saveOrder()` deliberately strips `payment_status` on update (`logistics.html:986`, "never touch payment_status"). Staff change it, press Save, nothing happens, no message. Meanwhile 3 manual orders sit Delivered with `payment_status='pending'`. | Remove the select from Edit. Add one explicit action for manual orders only: **"Record payment: Cash / Card machine / EFT"** calling a new staff RPC `logistics_record_manual_payment(order_id, method)` that sets `payment_status='paid'`, `paid_at=now()`, `payment_method_code` (`cash`/`pos`/`eft_manual`) **only when** `order_number like 'ORD-%'` and `m_payment_id is null` (PayFast orders stay ITN-owned). New Order form gets the same "Paid by" choice (`co-payment-status` at `1790` becomes "Paid by: Not yet / Cash / Card machine / EFT"). Note: `orders_payment_columns_guard` nulls the payment columns for client inserts — staff are exempt via `timeslot_is_staff()`; the RPC is SECURITY DEFINER anyway. |
| L5 | P2 | Order detail "Charged" — `logistics.html:1400` | `orders.total` | For the 3 orders where PayFast's `amount_gross` differs, the screen shows the wrong amount. | Show `coalesce(pf_response.amount_gross, total)` and "Paid with …" (`payment_option_name(payment_option_key)` or "PayFast" / "Cash"). |
| L6 | P3 | Today / Orders — `attentionReason()` `1138` vs admin `liveWhy()` `2391` | `get_ops_board` | In step (both updated for No-Mark-Ready and run waits). The ops cards show the house seller as a second store (fix in `get_ops_board`, A10). | — (A10 covers it). |
| L7 | P3 | Baskets — `2060-2110` | `carts`, `orders pending_payment`, paid emails | Correct per the 2026-10-15 design. The admin "Carts w/ Items" card duplicates it badly (A4). | — |
| L8 | P3 | Settings panel — `3100-3120` | `localStorage scp_current_user` | Shows the cached login only. Harmless. | Show roles from `user_roles` as well. |

### 1.3 Database hygiene (no code reads them — confirm with a grep before dropping)

| # | Pri | Item | Evidence | Fix |
|---|---|---|---|---|
| D1 | P3 | table `"Logistics"` (capital L; id, user_id, created_at, role; 2 rows) | superseded by `user_roles` (`timeslot_is_staff`, `get_ops_board` use `user_roles`) | grep for `"Logistics"`/`from('Logistics')`; drop if unused. |
| D2 | P3 | `user_roles_backup` (1 row) | one-off backup | drop. |
| D3 | P3 | `discount_redemptions` (0 rows) | code may still insert (grep `discount_redemptions` in `validate-cart.js`/`complete-order-payment.js`); if nothing writes it, drop; if something does, it is the right place for "who funded this discount" and Finances should read it | decide after grep. |
| D4 | P1 | Founder test orders (18) + the R5 Apple Pay test and its route/payout | they are real rows with real PayFast fees (the R5 cost R2.48) | **Do not delete.** Mark them with a Finances adjustment `exclude_test` (§2.2) so they vanish from money figures but stay in ops history. Workstream A seeds these 18 (+ the R5 order) from the two founder emails, note "founder QA order", for the founder to review. |
| D5 | P2 | 3 manual orders Delivered/Fulfilled with `payment_status='pending'` (R460) | logistics shows them delivered | Logistics "Record payment" (L4) — founder confirms they were cash. |

---

## 2. Finances page — design

### 2.1 Principles
1. **Server-side truth only.** The page renders what SECURITY DEFINER RPCs return. The browser formats, filters already-returned rows and builds the CSV; it never sums `orders.items` or adds columns up.
2. **Source rows are never edited.** Corrections are `finance_entries` rows of kind `adjustment` pointing at an order, with a note, who and when. The original figure stays visible next to the override.
3. **Every assumption is in the database and editable in the portal** (`site_settings` key `finance`), with the formula shown next to the field.
4. **Estimated vs actual is always labelled** (`est` flag per figure, an "≈" in the UI, and an "estimated share" line in the summary).
5. **Dates are SAST**, order date = `coalesce(paid_at, created_at)`; range inclusive.

### 2.2 Data model

**New table `public.finance_entries`** — the one new table. Justification per CLAUDE.md: manual expenses/income/adjustments are many independent records with their own date, amount, author, void state and (for adjustments) an order link; a jsonb list in `site_settings` cannot be queried by date range, has no per-row audit and would be rewritten whole on every edit (two admins editing at once would lose rows). No existing table holds money events of this kind (`ad_campaigns`, `driver_payouts`, `discount_codes` are each one specific thing).

```sql
create table public.finance_entries (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('expense','income','adjustment')),
  category        text not null,              -- expenses: fuel, marketing, printing, salaries, software, packaging, rider_bonus, other…
                                              -- income: prize, grant, sponsorship, other; adjustments: see adjustment_type
  description     text not null default '',
  amount          numeric(12,2) not null check (amount >= 0),   -- always positive; kind decides the sign
  occurred_on     date not null,              -- SAST date; for recurring = first month
  recurring       text not null default 'none' check (recurring in ('none','monthly')),
  recur_until     date,                       -- null = still running
  order_id        uuid references public.orders(id) on delete set null,  -- adjustments only
  adjustment_type text check (adjustment_type in
                    ('exclude_test','refund','seller_payout_override','rider_pay_override',
                     'payment_fee_override','payment_method_set','cogs_override','note')),
  adjustment_value numeric(12,2),             -- the override amount (null for exclude_test / note)
  adjustment_text  text,                      -- e.g. the method key for payment_method_set
  created_by      uuid not null references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  voided_at       timestamptz,
  voided_by       uuid references auth.users(id),
  void_reason     text
);
create index on public.finance_entries (occurred_on) where voided_at is null;
create index on public.finance_entries (order_id) where voided_at is null;
alter table public.finance_entries enable row level security;
-- admins read; ALL writes only through the RPCs below (no direct insert/update policy)
create policy finance_entries_admin_read on public.finance_entries for select using (public.timeslot_is_admin());
```
Rows are never deleted: "remove" = `voided_at` (the list shows voided rows greyed under "Show removed"). A recurring monthly expense is one row expanded per month inside the RPC (`occurred_on` ≤ month ≤ `recur_until`).

**`site_settings` key `finance`** (admin-written through the existing `site_settings_admin_write` policy, validated by a trigger like `site_settings_payments_validate`):
```json
{
  "commission_pct": 15,
  "commission_base": "goods_after_seller_discount",
  "platform_codes_funded_by": "umzila",
  "seller_codes_funded_by": "seller",
  "tips_go_to": "rider",
  "priority_goes_to": "umzila",
  "fee_rates": {
    "cc":   { "name": "Card",          "pct": 3.2, "fixed": 2.00, "vat": true },
    "ap":   { "name": "Apple Pay",     "pct": 3.2, "fixed": 2.00, "vat": true },
    "gp":   { "name": "Google Pay",    "pct": 3.2, "fixed": 2.00, "vat": true },
    "sp":   { "name": "Samsung Pay",   "pct": 3.2, "fixed": 2.00, "vat": true },
    "token":{ "name": "Saved card",    "pct": 3.2, "fixed": 2.00, "vat": true },
    "cp":   { "name": "Capitec Pay",   "pct": 1.5, "fixed": 0,    "vat": true },
    "ef":   { "name": "Instant EFT",   "pct": 2.0, "fixed": 0,    "vat": true, "min": 2.00 },
    "cash": { "name": "Cash",          "pct": 0,   "fixed": 0,    "vat": false },
    "pos":  { "name": "Card machine",  "pct": 2.75,"fixed": 0,    "vat": true },
    "eft_manual": { "name": "EFT (manual)", "pct": 0, "fixed": 0, "vat": false },
    "unknown": { "name": "PayFast (method unknown)", "pct": 3.2, "fixed": 2.00, "vat": true }
  },
  "house_cogs": { "<product_id>": 12.50 },
  "rider_pay_estimate": { "min": 34, "included_km": 3, "per_km": 0.40, "max": 45, "fallback": 39, "per_extra_store": 3 },
  "expense_categories": ["Fuel","Marketing","Printing","Salaries","Software","Packaging","Rider bonus","Bank charges","Other"],
  "income_categories": ["Prize","Grant","Sponsorship","Other"],
  "test_emails": ["nontandod23@gmail.com","ntandob38@gmail.com"]
}
```
Defaults for `fee_rates` are PayFast's published South African pricing (ex VAT, VAT 15 % applied when `vat` is true) and they reproduce the live fees exactly for card (R5 → 2.48, R314 → 13.86) and one Instant-EFT-looking order (R110 → 2.53). The portal must show them as **"estimate rates — edit when PayFast changes pricing"**; actual fees always win when present. `test_emails` is only a convenience for the "mark as test" bulk action — it does not exclude anything by itself.

### 2.3 RPCs (all `SECURITY DEFINER`, `SET search_path = public, extensions`, `revoke execute … from public` then `grant … to authenticated`; `raise 'ADMIN_ONLY' errcode 42501` unless stated)

**`fin_order_lines(p_from date, p_to date, p_include_excluded boolean default false) → jsonb`** — the single per-order engine. Every other money RPC aggregates this (as a SQL CTE/function reuse, not a copy). One element per paid order:
```
{ order_id, order_number, when (paid_at||created_at, SAST iso), day (SAST date), customer_name,
  source ('payfast'|'manual'|'zero'), is_test (bool), excluded (bool, reason),
  payment: { option_key, method_code (orders.payment_method_code → attempts → 'cash'/'unknown'), method_name,
             gross, fee, fee_est (bool), net },
  goods:   { list_value, discount, discount_funder ('seller'|'umzila'|null), after_discount, house_value },
  stores:  [ { seller_id, shop_name, is_house, goods_list, goods_after_discount, seller_discount_share,
               commission, payout, payout_override (bool), cogs } ],
  delivery:{ has_delivery, status, fee_customer (shipping_cost − priority_fee), priority, markup_part,
             rider_pay, rider_pay_est (bool), rider_pay_override (bool), free_delivery (bool) },
  tips, refund (sum of refund adjustments),
  umzila:  { commission, delivery_margin (fee_customer + priority − rider_pay), house_margin (house_value − cogs),
             fees_paid, discounts_funded, net },
  adjustments: [ { id, type, value, note, by, at } ]
}
```
Inclusion: `payment_status='paid'` and `label is distinct from 'seller_enrollment'`; `excluded` = an un-voided `exclude_test` adjustment exists (rows still returned when `p_include_excluded`, flagged, so the UI can show "12 test orders hidden").

**`fin_summary(p_from date, p_to date) → jsonb`**
```
{ from, to, orders, excluded_orders, estimated_share (fraction of fee+rider figures that are estimates),
  totals: { gross, goods_list, discounts_seller, discounts_umzila, delivery_customer, priority, tips,
            seller_payouts, rider_pay, payfast_fees, house_sales, house_cogs, refunds,
            umzila_commission, umzila_delivery_margin, umzila_house_margin, umzila_gross_profit,
            other_income (finance_entries income + enrolment fees + paid ad_campaigns, each itemised),
            expenses (finance_entries, recurring expanded), net_profit },
  by_method: [ { method_code, name, orders, gross, fees, fees_est_orders, effective_pct } ],
  by_store:  [ { seller_id, shop_name, is_house, orders, goods, discounts, commission, payout, margin_pct } ],
  by_day:    [ { day, orders, gross, umzila_gross_profit, net } ],
  by_week:   [ { week_start, … same } ],
  insights:  [ { key, severity ('info'|'warn'|'good'), title, detail, amount } ]   -- see §2.6
}
```
**`fin_entries_list(p_from, p_to, p_include_voided boolean) → jsonb`**, **`fin_entry_save(p jsonb) → jsonb`** (insert or update by `id`; validates kind/category/amount/date; adjustments require `order_id` that exists and `adjustment_type`; `exclude_test` and `refund` may exist once per order), **`fin_entry_void(p_id uuid, p_reason text) → void`**. All stamp `created_by`/`voided_by = auth.uid()`.

**`fin_mark_tests(p_emails text[], p_note text) → int`** — creates `exclude_test` adjustments for every paid order whose `lower(customer_email)` is in the list (idempotent). Used by the "Mark founder test orders" button.

**`fin_sales_by_period(p_from, p_to, p_gran text) → jsonb`** and **`fin_top_products(p_from, p_to, p_limit int) → jsonb`** — gate `timeslot_is_staff()` (logistics may see sales, not costs). Rows: `{ period, orders, gross, goods }` and `{ product_id, name, shop_name, orders, qty, goods }` from `order_items` (fallback `products.seller_id`), same exclusions.

**`fin_store_breakdown(p_from, p_to) → jsonb`** — gate `timeslot_is_staff()`; the `by_store` array of `fin_summary` without commission/payout columns for non-admins (admins get everything). Feeds logistics Stores and Intelligence → Sellers.

**`fin_delivery_breakdown(p_from, p_to) → jsonb`** — per order: `fee_customer, priority, rider_pay (+est), margin, free_delivery, delivered_at − dispatched_at minutes`, plus totals; feeds the rebuilt Delivery Analytics.

**`logistics_record_manual_payment(p_order_id uuid, p_method text) → jsonb`** — gate `timeslot_is_staff()`; only `order_number like 'ORD-%' and m_payment_id is null and payment_status <> 'paid'`; sets `payment_status='paid'`, `paid_at=now()`, `payment_method_code=p_method` (`cash|pos|eft_manual`). Must not touch `order_status`. (Finding L4.)

### 2.4 Formulas — each with its source column

| Figure | Formula | Source | Est? |
|---|---|---|---|
| `gross` (cash in) | `coalesce((pf_response->>'amount_gross')::numeric, total)` | `orders` | no |
| `method_code` | `coalesce(orders.payment_method_code, (latest paid payment_attempts.payment_method_code), case when pf_payment_id is not null then 'unknown' when order_number like 'ORD-%' then 'cash' when total = 0 then 'zero' end)`; overridden by a `payment_method_set` adjustment | `orders`, `payment_attempts`, `finance_entries` | — |
| `fee` | actual: `abs((pf_response->>'amount_fee')::numeric)` (PayFast stores it negative; `payment_attempts.amount_fee` is positive — use orders first, attempts second); else estimate `greatest(min, gross×pct/100 + fixed) × (vat ? 1.15 : 1)` from `finance.fee_rates[method_code]`; overridden by `payment_fee_override` | `orders.pf_response`, `payment_attempts`, `site_settings.finance` | yes when no `pf_response` |
| `goods_list` | `sum(order_items.subtotal)`; if no `order_items` rows (should not happen — `populate_order_items_on_payment`), fall back to `sum(items[].subtotal or price×quantity)` and flag `items_fallback` | `order_items` | — |
| store attribution | `coalesce(order_items.seller_id, products.seller_id)` | `order_items`, `products` | — |
| `discount` | `coalesce(orders.discount, 0)`; funder: `discount_codes.seller_id is not null → 'seller'` (join `upper(code) = upper(orders.coupon_code)`), else `'umzila'`; no code row (manual order discount) → `'umzila'` | `orders`, `discount_codes` | — |
| seller's discount share | seller-funded: pro-rata across that seller's lines (`discount × seller_goods / goods_list`), never across other sellers or house lines | derived | — |
| `commission` (non-house store) | `(goods_store − seller_discount_share) × commission_pct/100` (`commission_base` setting; alternative `goods_list`) | `site_settings.finance` | — |
| `payout` (non-house store) | `(goods_store − seller_discount_share) − commission`; overridden by `seller_payout_override` | derived | — |
| house line | `house_value = goods` of `sellers.is_house` lines; `cogs = sum(house_cogs[product_id] × quantity)` (missing cost → 0 and flag `cogs_missing`); overridden by `cogs_override` | `order_items`, `sellers.is_house`, `site_settings.finance.house_cogs` | yes when cost missing |
| `fee_customer` | `coalesce(shipping_cost,0) − coalesce(priority_fee,0)` (live data: `shipping_cost` 53.84 = quote 38.84 + priority 15) | `orders` | — |
| `priority` | `coalesce(orders.priority_fee, 0)` (= `delivery_quotes.priority_fee`) | `orders` | — |
| `rider_pay` | actual: the element of `driver_payouts.calculation_basis->'deliveries'` whose `delivery_id = deliveries.id` → `pay` (route completed); fallback when the route is not completed yet: band estimate from `delivery_quotes.distance_km` with `rider_pay_estimate` (+ per extra store, `fallback` if null); no `deliveries` row (manual, self-arranged, services) → 0; overridden by `rider_pay_override`. Cancelled delivery → 0 | `driver_payouts`, `deliveries`, `route_stops`, `delivery_quotes` | yes until the route completes |
| `tips` | `coalesce(tip_amount,0)`; pass-through to the rider when `tips_go_to='rider'` (deducted) | `orders` | — |
| `refund` | sum of un-voided `refund` adjustments on the order | `finance_entries` | — |
| `umzila.net` per order | `gross − Σpayout − rider_pay − tips − fee − house_cogs − refund` | derived | inherits |
| `umzila_gross_profit` (period) | `Σ umzila.net` over included orders | — | — |
| `other_income` | `finance_entries kind='income'` in range + enrolment orders (`label='seller_enrollment'`, `payment_status='paid'`, net of their PayFast fee) + `ad_campaigns.amount_paid where payment_status='paid'` by `created_at` | `finance_entries`, `orders`, `ad_campaigns` | — |
| `expenses` | `finance_entries kind='expense'`: one-off rows by `occurred_on`; `recurring='monthly'` rows contribute once for every month that overlaps the range (`occurred_on` ≤ month ≤ `coalesce(recur_until, today)`), pro-rated **not** (whole months — simpler, stated in the UI) | `finance_entries` | — |
| `net_profit` | `umzila_gross_profit + other_income − expenses` | — | — |
| `effective_pct` per method | `fees / gross` for the method | — | — |
| `estimated_share` | `(Σ est fees + Σ est rider pay) / (Σ fees + Σ rider pay)` | — | — |

Consistency check the RPC must satisfy (unit test): for every order `gross = goods_after_discount + fee_customer + priority + tips` within 1c, else the order is flagged `totals_mismatch` and listed under "Check these" (the 3 known `total ≠ amount_gross` orders will show here, which is the point).

### 2.5 UI — `admin.html` → new sidebar item **Finances** (Growth group, right after Payments), all logic in new `/finances-admin.js` (same shell pattern as `timeslots-admin.js` / `payments-admin.js`: `window.loadFinancesAdmin`, a `#financesMount`, state object, `render()`, SAST helpers copied from `payments-admin.js`)

Range bar (top, sticky on mobile): presets Today · This week · This month · Last month · Last 30 days · Custom from/to; "Include test orders" toggle (off); "Export CSV" button.

1. **P&L card** (the answer first): big number *Net profit / loss* with colour, under it the waterfall as plain rows: Order value (cash in) → − owed to stores → − rider pay → − tips → − PayFast fees (≈ when estimated) → − drinks cost of goods → − refunds = **Umzila gross profit** → + other income → − expenses = **Net**. Each row shows the amount and "n orders" / "k entries"; an "≈ 38 % of fees are estimates" note when `estimated_share > 0`. Tapping a row filters the orders table to the orders contributing.
2. **By payment method** table: method, orders, gross, fees (actual / estimated split), effective %, share of gross. Footer: "Card fees are X % of card revenue; if those orders had paid with Capitec Pay you would have kept ~R…" (from `insights`).
3. **By store** table: store, orders, goods sold, discounts (seller-funded), commission earned, owed to store, margin %; house seller shown as "Umzila Drinks (ours)" with sales − cost of goods.
4. **Over time**: toggle Day / Week; bars for gross and net (Chart.js is already loaded on admin.html); table under it.
5. **Delivery economics** mini-card: fee charged vs rider pay vs priority → delivery margin; "free-delivery orders cost R… in rider pay"; link to Delivery Analytics.
6. **Orders** table (drill-down): one row per order: when, order, customer, store(s), paid with, gross, fee≈, owed to store, rider pay≈, Umzila net, flags (test · refund · est · mismatch); click → drawer with the full `fin_order_lines` element: every figure with its source ("PayFast ITN" / "estimate: 3.2 % + R2 + VAT" / "driver_payouts route …" / "override by Nomsa, 14 Nov") and buttons **Mark as test**, **Record refund**, **Override** (seller payout / rider pay / fee / cost of goods / payment method), **Add note** — each opens a small form (amount, note) → `fin_entry_save`. Overrides show "was R… → now R…" and can be removed (void).
7. **Expenses & other income** section: list for the range (date, category, description, amount, recurring badge, by whom), "+ Add expense", "+ Add income", "+ Add recurring monthly cost"; edit / remove (void) with reason; "Show removed". Validation: amount > 0, date required, category from the settings list or "Other" with text.
8. **Assumptions** (collapsible, with "last changed by/when" from `site_settings.updated_at`): commission %, commission base, who funds platform / seller codes, tips/priority destination, fee rates table (name, %, fixed, VAT, min) with "reset to PayFast defaults", rider-pay estimate band (read-only until A16 is done — shown "mirrors lib/delivery-price.js"), house cost of goods per product (list of the house seller's products with a cost box), expense/income categories, test emails + **"Mark orders from these emails as test"** (`fin_mark_tests`, shows how many it would affect first). Saving = upsert `site_settings` key `finance` (validated by trigger; errors shown inline like Payments).
9. **CSV export**: client builds it from `fin_order_lines` (one row per order with every number and its est/override flags) plus a second file for entries; filename `umzila-finances-<from>-<to>.csv`; UTF-8 BOM so Excel opens it.

Mobile: every table has a card layout under 600 px (real classes, not inline grids — `ops-panels.md` gotcha); the P&L card and the range bar are first.

Dashboard tie-in (A1): the four money cards read `fin_summary(this month)` and link to Finances.

### 2.6 Insights (computed in `fin_summary`, rules not AI — each returns `{key, severity, title, detail, amount}` only when the data supports it)
- `fees_share`: fees ÷ gross ≥ 4 % → "PayFast fees are X % of revenue (R…)". With a what-if: for orders paid by card, fee at the Capitec Pay rate → "switching card payers to Capitec Pay would have saved ~R…" (uses `fee_rates`).
- `delivery_loss`: Σ(rider_pay − fee_customer − priority) > 0 → "Delivery lost R… in this period (rider pay above what customers paid); n free-delivery orders cost R…". Suggest the markup % field.
- `small_orders`: orders with gross < R60 where fee ≥ 10 % of gross → "n small orders paid ≥ 10 % in fees — consider a minimum order or a small-order fee".
- `store_margin`: the store whose Umzila net per order is lowest/highest.
- `estimates`: `estimated_share > 0.25` → "a quarter of costs are estimates — complete routes / set drinks cost of goods".
- `tests_hidden`: n excluded orders.
- `mismatch`: orders flagged `totals_mismatch`.
- `recurring_burn`: monthly recurring expenses vs average monthly gross profit → "at the current rate you need R… gross profit a month to break even; you made R… last month".

### 2.7 Where data is missing and what the page does
| Gap | Handling |
|---|---|
| No payment method for pre-picker PayFast orders (35) | method `unknown` → shown as "PayFast (method unknown)"; fee is **actual** from `pf_response` so money is right, only the by-method split is lumped. Admin can set a method per order (`payment_method_set`) if they know it from the PayFast dashboard. |
| Manual `ORD-…` orders: no method, no `paid_at`, no fee | default `cash`, fee 0, date = `created_at`; logistics "Record payment" (L4) fixes future ones. |
| Rider pay before the route completes / for routes with no `driver_payouts` row | band estimate from the quote distance, flagged ≈; replaced by the actual once the trigger writes the row. Only 14 routes exist, all completed, so today this is 0 orders. |
| House cost of goods | none stored anywhere → 0 and a `cogs_missing` flag + an insight until the admin fills `house_cogs` (only 1 house line sold so far). |
| Refunds | no refund status in the schema; the `refund` adjustment is the record (amount + note, e.g. "cancelled delivery, refunded on PayFast 12 Nov"). The R54.50 cancelled-delivery order is the first candidate. |
| Delivery markup | `margin_percent` is 0; when it is set later, `markup_part = fee_customer − fee_customer/(1+m/100)` is informational only (the whole fee is already in gross). |
| Tips | always 0 so far; modelled as rider pass-through. |
| Seller-enrolment and ad income | tiny (R100, R50) — itemised under other income, not hidden. |
| Paid order with no `order_items` (should not exist) | JSON fallback + `items_fallback` flag; listed under "Check these". |

---

## 3. Workstreams (run in parallel; interface contracts are the §2.3 shapes — change them only by editing this file first)

### A — Database + RPCs (owner: `docs/plans/sql/10_finance_schema.sql`, `11_finance_rpcs.sql`, `12_audit_rpc_fixes.sql`; migrations applied with the same names)
Builds: `finance_entries` + RLS; `site_settings.finance` seed + `site_settings_finance_validate` trigger (keys, numeric ranges, known method codes); `fin_order_lines`, `fin_summary`, `fin_entries_list/save/void`, `fin_mark_tests`, `fin_sales_by_period`, `fin_top_products`, `fin_store_breakdown`, `fin_delivery_breakdown`, `logistics_record_manual_payment`; `get_ops_board` house-store filter (A10); grants/revokes. Seeds `exclude_test` adjustments for the founder's 18 orders + the R5 order with note "founder QA order (seeded 2026-11-16) — unmark if real".
Tests (SQL, rolled-back DO blocks + a persisted check script in `docs/plans/sql/finance_checks.sql`): (1) for every included order `gross = goods_after_discount + fee_customer + priority + tips` ±1c or flagged; (2) Σ`by_store.payout` + Σ`commission` = Σ non-house goods after seller discounts; (3) two-drop route R77.50 splits into 38.71 + 38.79 by delivery; (4) fee estimate reproduces 2.48 for R5 card and 13.86 for R314; (5) `fin_summary` totals = Σ `fin_order_lines`; (6) recurring expense counts once per overlapping month; (7) anon/authenticated non-admin get 42501; logistics role can call `fin_sales_by_period` but not `fin_summary`; (8) `logistics_record_manual_payment` refuses a PayFast order and an already-paid order; (9) void keeps the row and removes it from totals; (10) `fin_summary` for Oct 2026 by hand: 16 paid network orders, gross from `pf_response`, fees R…, rider pay from the 14 payout rows — write the expected numbers into the test.

### B — Finances page UI (owner: `finances-admin.js` (new), `admin.html` sidebar `<li data-section="finances">`, `<section id="section-finances">`, section map + loader hook, Dashboard money cards (A1), `docs/systems/finances.md` (new), CHANGELOG)
Builds §2.5 exactly, against mocked RPC JSON first (fixtures checked in under `docs/plans/fixtures/fin_summary.sample.json` produced by A from live data), then live. CSV builder. Mobile layout. No `supabase.from('orders')` anywhere in this file — RPCs and `site_settings` only.
Tests: renders with empty range, with estimates, with excluded orders; every button leads to a `fin_entry_save`/`fin_entry_void` call and a re-render; P&L rows sum to the net shown (assert in a console self-check in dev); CSV opens in Excel with ZAR amounts; 390 px layout; `node --check` on the file; no console errors.

### C — admin.html audit fixes (owner: `admin.html` except the Finances section, `netlify/functions/admin-analytics.js`, `payments-admin.js` heading only, CHANGELOG)
A2–A9, A11, A13, A14, A15 (after A's `fin_*` land; use fixtures meanwhile). Rebuild Delivery Analytics on `fin_delivery_breakdown`; Intelligence → Sellers on `fin_store_breakdown`; remove dead code/controls; real password change; "Active Sellers" excludes house; product counts visible-only; Manage Shops Pending tab + house badge; Payments Report heading.
Tests: each changed card's number checked against a SQL query written in the PR description; sections render with no RPC errors as an admin; nothing in the file still references `statPending`, `addDummyUser`, `exportInv`; mobile pass at 390 px for Delivery Analytics and Manage Shops.

### D — logistics.html audit fixes (owner: `logistics.html`, CHANGELOG, `docs/systems/ops-panels.md` update)
L1 (Analytics tab → `fin_sales_by_period` + `fin_top_products`), L2 (Stores badges + `fin_store_breakdown`), L3 (Today sales from server, SAST), L4 (remove dead payment-status select; "Record payment" action + New Order "Paid by"), L5 (Charged = PayFast gross; "Paid with"), L8.
Tests: logistics role (not admin) can open every tab without 42501; Analytics for Oct 2026 shows 16 paid orders, not 40; a store with `status='active'` shows Active; recording a cash payment on an `ORD-` order flips it to paid and it appears in Finances the same minute; the same action is refused on a PayFast order; `saveOrder()` still never writes `payment_status`.

Order of landing: A first (B/C/D can start on fixtures the same day); B, C, D independent; a final review pass checks C and D numbers against `fin_summary` for the same range.

---

## 4. Questions only the founder can answer (recommended default in bold so workers can proceed)

1. **Commission base.** 15 % of the goods value after a *seller-funded* promo discount, before any Umzila-funded code, and never on delivery/priority/tips? — **Yes (default `commission_base = goods_after_seller_discount`).** Alternative: 15 % of list price regardless of discounts.
2. **Who funds discounts?** Seller promo codes (ISIQALO…/VELAPHI…, `discount_codes.seller_id` set) reduce the seller's payout; platform codes (mystery gift, spin, referral, platform %) are Umzila's cost. — **Default as stated.** If instead Umzila has been paying stores the full list price even on their own promos, flip `seller_codes_funded_by` to `umzila` in Assumptions (no code change).
3. **Manual `ORD-…` orders**: treat as cash, no fee, Umzila still owes the store 85 %? — **Yes.** And the 3 delivered-but-unpaid ones (R460): were they paid in cash? (Record via logistics once built.)
4. **Founder test orders** (18 from `nontandod23@`, `ntandob38@` + the R5 Apple Pay order, R3 041.76): exclude all from finances? — **Seed them as excluded with a note; founder un-marks any that were real.** Was the R39.25 rider payout on the R5 test actually paid to a rider? (If not, a `rider_pay_override = 0` on it.)
5. **Tips**: 100 % to the rider? — **Yes (`tips_go_to = rider`).**
6. **Priority fee**: Umzila keeps all R15? — **Yes** (ops-panels.md already says so).
7. **House drinks cost of goods**: provide the buying price per product (8 products) — **until then 0 with a visible "cost missing" flag.**
8. **Capitec Pay / Instant EFT / card-machine fee rates**: the defaults are PayFast's public rates (card 3.2 % + R2, Capitec Pay 1.5 %, Instant EFT 2 %, all + VAT) — confirm against your PayFast merchant agreement; **editable in Assumptions, defaults stand.**
9. **Seller payouts**: are stores actually paid 85 % per order, or in batches? There is no payout ledger table; Finances shows "owed to store" per period. Do you want a "mark as paid out" per store per period (a `payout_paid` entry) in this build? — **Not in this build; add later as an `income`/`adjustment` kind if needed.**
10. **Enspire prize (R30 000, Oct 2026)**: book as `income / Prize` on its date? — **Yes, the founder adds it from the Expenses & other income section** (nothing hardcoded).
11. **Drop the obsolete tables** `"Logistics"`, `user_roles_backup`, `discount_redemptions` (if no code writes it)? — **Yes after the grep; not part of the Finances build.**
