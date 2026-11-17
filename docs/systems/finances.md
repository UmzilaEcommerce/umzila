# Finances (admin → Finances)

_Built 2026-11-16/17. Plan: `docs/plans/admin-logistics-audit-and-finances-plan.md` (the FOUNDER ANSWERS block at its top overrides the rest). Real contract: `docs/plans/finances-contract-changes.md`. SQL copies: `docs/plans/sql/10_fin_schema.sql`, `11_fin_rpcs.sql`, `12_fin_audit_fixes_and_seeds.sql`; reconciliation queries: `docs/plans/sql/fin_checks.sql`; sample responses: `docs/plans/fixtures/fin_summary.sample.json`._

## What it does

The Finances page answers one question for the founder: is Umzila making money? For any period it shows what customers paid, what part of that belongs to the stores, what PayFast kept, what the house drinks cost, any refunds, and what is left for Umzila. It then adds other income (prizes, enrolment fees, ads) and takes off expenses (rider wages, fuel, payout fees, marketing and so on) to give a net profit or loss. Everything can be corrected by an admin: an order can be marked as a test, refunded, or have one of its figures overridden, and expenses and income can be added, edited and removed.

All the arithmetic happens in the database. The browser never adds up `orders` rows itself; it only formats what the `fin_*` functions return. That is deliberate: before this was built, every screen (admin dashboard, admin-analytics, logistics Analytics, logistics Stores) summed `orders.total` or `orders.items` its own way, with different filters, and they all disagreed.

## The pieces

- **`public.fin__order_lines(from, to, include_excluded)`** is the one engine. Every other figure is built from its output: one JSON element per paid order in the range, with the order split per store and per line, the payment fee, the delivery money, Umzila's share and a list of flags. The public wrappers are `fin_order_lines` (admin) and the summary/breakdown functions below.
- **`fin_summary(from, to, include_excluded)`** (admin) folds the order lines into `totals`, `by_store`, `by_method`, `by_day`, `by_week`, `insights` and adds the period's finance entries (other income, expenses, monthly recurring costs).
- **`fin_delivery_breakdown`** (admin) is delivery money per order (Admin → Delivery Analytics).
- **Staff functions** (admins and active logistics/admin `user_roles`): `fin_sales_by_period`, `fin_top_products`, `fin_store_breakdown` (admin-only columns `owed`, `commission`, `cogs`, `margin_pct` are added only for admins). Manual payments are recorded by `netlify/functions/manual-order.js` (2026-11-17, replaces `logistics_record_manual_payment`; see manual-orders.md).
- **`public.finance_entries`** is the one table for anything typed in by hand: `expense`, `income`, and per-order `adjustment` rows (`exclude_test`, `refund`, `payment_fee_override`, `seller_payout_override`, `rider_pay_override`, `cogs_override`, `payment_method_set`, `note`). Rows are never deleted: removing one sets `voided_at` and a reason. Admins can read it through RLS; every write goes through `fin_entry_save`, `fin_entry_void` and `fin_set_excluded`.
- **`site_settings` key `finance`** holds the assumptions and the store prices (see below). It is validated by the `site_settings_finance_validate` trigger (`FINANCE_INVALID`).
- **`finances-admin.js`** is the page. It follows the same pattern as `payments-admin.js`: it renders into `#financesMount` in `admin.html`, and it also draws the dashboard's "Money — this month" cards (`#finDashMount`) and the two 30-day charts.

## Which orders count, and on which day

Only orders with `payment_status = 'paid'` count (never `order_status`, which moves on to Delivered/Fulfilled). The seller enrolment fee (`label = 'seller_enrollment'`) is not a sale; it shows under other income. Orders with an `exclude_test` entry are left out unless "Include test orders" is switched on. Days are South African time. A hand-entered `ORD-` order is dated by its order date, even when its payment was recorded later; every other order is dated by `paid_at`.

Nothing is excluded automatically. Orders that look like tests (the email is in `test_emails`, or a line is a "test item") are flagged `looks_like_test` and counted in the `test_candidates` insight, so the founder can mark them one tap at a time. The founder said not to bulk-exclude, because some orders from her own addresses are real sales she recorded in one go.

## Formulas and where each number comes from

- **Gross (what the customer paid):** PayFast's `amount_gross` in `orders.pf_response` when there is one, else `payment_attempts.amount_gross`, else `orders.total`. `orders.total` is written by the browser and can differ from what PayFast received.
- **Goods:** the order's lines from `order_items` (written only by the `populate_order_items_on_payment` trigger), or `orders.items` when there are no rows (flag `items_fallback`). The store for a line is `order_items.seller_id`, or else `products.seller_id`, because hand-entered orders have no seller on their lines.
- **Discounts:** a code with `discount_codes.seller_id` set is the store's own promo. It comes out of the store's share (`seller_codes_funded_by`, default `seller`). Umzila's own codes (mystery gift, spin, referral, platform) and a discount typed on a manual order with no code (`manual_discount_funded_by`, default `umzila`) are Umzila's cost.
- **Owed to the store (commission is a mark-up):** the store sets a price, and Umzila sells the item for more. The store is owed its **store price**, and the difference is Umzila's commission. For a line, owed = line subtotal × store_price ÷ today's selling price. A line sold at today's price comes to exactly store_price × qty. When the price has changed since, or extras/picks were added, the figure scales and the line is marked `scaled`. When there is no store price, owed = subtotal ÷ (1 + `default_markup_percent`/100), with a default of 9 %, and the line is marked as an estimate. The store's own discount then comes off what it is owed. Commission = goods after the store's discount − owed.
- **House drinks (Umzila Drinks, `sellers.is_house`):** these are Umzila's own goods, so nothing is owed. The same store-price map holds their **cost of goods**, which is store_price × qty and is not scaled. A drink with no cost is flagged `cogs_missing`.
- **PayFast fee:** the actual ITN `amount_fee` (taken as a positive number) always wins. When it is missing, the fee is estimated from the `fee_rates` entry for the order's method: (pct % × gross + fixed, at least min) × (1 + VAT) when `vat` is true. The method comes from `orders.payment_method_code`, the payment attempt, or a `payment_method_set` adjustment. Orders paid before the payment picker existed carry no method and use `unknown`. Cash, card machine and manual EFT have no fee unless the founder sets one.
- **Delivery, priority, tips:** all of this is Umzila revenue while riders are staff. `umzila_delivery_income` = delivery fees + priority.
- **Rider pay:** this comes from `driver_payouts.calculation_basis.deliveries[]` (per delivery), estimated from `rider_pay_estimate` while a route is still open, or a `rider_pay_override`. It is always reported, but it is only a cost when `count_rider_pay_as_cost` is on (default off: riders are paid as staff, and their wages are recorded as expenses).
- **Umzila gross profit** = gross − owed to stores − PayFast fees − drinks cost of goods − refunds − rider cost (only when the toggle is on) − tips to rider (only when `tips_go_to = rider`).
- **Net profit** = gross profit + other income (income entries, enrolment fees, paid `ad_campaigns`) − expenses (one-off entries in the range, plus monthly entries × the months they cover in the range).
- **Unexplained** = gross − (goods − discount + delivery + tips). The order still counts at its cash gross, and the difference is shown so that the totals match the cash. Example: ORD-606970 was saved without its R38.86 delivery.

The waterfall on the page adds up exactly. `window.__finSelfCheck()` in the browser console lists any P&L row that does not reconcile with the server's totals; an empty list means everything matches.

## Settings (`site_settings.finance`)

| Key | Default |
|---|---|
| `default_markup_percent` | 9 |
| `vat_percent` | 15 |
| `seller_codes_funded_by` | seller |
| `manual_discount_funded_by` | umzila |
| `tips_go_to` | umzila |
| `count_rider_pay_as_cost` | false |

`fee_rates` has one entry per method key: cc, dc, ap, gp, sp, cp, ef, cash, pos, eft_manual and unknown (unknown is required). Card, Apple Pay, Google Pay and Samsung Pay are 3.2 % + R2; Capitec Pay and Instant EFT are 2 % with a R2 minimum. All of these get +15 % VAT. The card machine (`pos`) is seeded at 0 because no rate was given, so the founder must set it.

The other keys are `rider_pay_estimate`, `expense_categories` (which include "PayFast payout fee"), `income_categories`, `test_emails` (a hint only) and `store_prices`.

The page reads the settings with `fin_settings_get()`, which never returns `store_prices`, and saves them with `fin_settings_save()`, which always keeps the stored `store_prices`. Store prices and drink costs are only ever written one at a time with `fin_store_price_set(product, variant, price)`. The map key is `<product_id>`, or `<product_id>:<variant_id>` for a variant with its own price.

**Why store prices live in an admin-only setting and not in `products.metadata`:** `products` is publicly readable and sellers can edit it. A store price there would show every customer Umzila's mark-up, and a seller could change what they are owed. To keep the setting private, the public read policy on `site_settings` is `key <> 'finance'`: anon users and buyers can still read `home`, `payments` and `timeslots`, but not `finance`.

## Where things live in the portal

- **Admin → Finances (💰).** It has these parts:
  - a period bar and an "Include test orders" switch,
  - the profit & loss waterfall, with tap-to-filter,
  - "Worth knowing" insights,
  - breakdowns by payment method, by store, over time, and for delivery,
  - the Orders drill-down: a per-order Test switch, plus refund, override, note and remove-correction actions,
  - Expenses & other income: one-off or monthly, optionally linked to a store (for payout fees). The Enspire R30 000 prize is added here, by hand,
  - Store prices, with the "products without a store price" list,
  - Assumptions,
  - CSV export.
- **Admin dashboard → "Money — this month"** shows order value, Umzila gross profit, net after costs and paid orders. The 30-day charts come from `fin_summary.by_day`.
- **Admin → Intelligence** (and the dashboard's "Paying customers / Unpaid checkouts / Best sellers") reads `fin_intelligence(p_from, p_to)` (admin-only; built on `fin__order_lines`, see docs/systems/intelligence.md). **Admin → Delivery Analytics** reads `fin_delivery_breakdown`.
- **Logistics → Analytics, Stores and the Today KPIs** read the staff functions. In **Logistics → open a manual ORD- order → "Payment not recorded yet"**, staff record a cash, card-machine or EFT payment through `manual-order.js`. The New Order form can also record the payment when the order is created.

## Gotchas

- A refund is taken entirely off Umzila: what the store is owed is not reduced automatically. If the store gives the money back, add a `seller_payout_override` too.
- **Recording a manual payment** (`manual-order.js`, 2026-11-17) works only on `ORD-` orders that have no PayFast id and are not already paid.
  - It sets `paid_at = now()`, but Finances still dates manual orders by their order date.
  - A "Deliver it — with tracking" order *does* carry `destination_geo`, so its payment creates a delivery and dispatches a rider. That is on purpose.
  - The finance engine treats it as manual for three reasons: `pf_payment_id` stays null, `pf_response` has no `amount_gross`, and the number starts `ORD-`. Never give manual orders a PayFast-shaped `pf_response`.
- `fin_top_products` caps `p_limit` at 100. Logistics → Stores asks for 200 to find each store's top item, so a store whose best product is not in the top 100 shows no top item.
- Store prices are matched against **today's** selling price. Changing a product's price changes the "scaled" owed figure on older orders that have no store price for the old price.
- Every `fin_*` function is SECURITY DEFINER with `EXECUTE` revoked from PUBLIC and anon, and the role check (`fin__assert_admin` / `fin__assert_staff`, giving `ADMIN_ONLY` / `STAFF_ONLY` 42501) is the first statement. Keep it that way for any new one. Revoking from anon and authenticated alone does not remove the separate PUBLIC grant.
- The seller-terms pitch says "15 % per sale". The live model is the per-product mark-up described above. That wording is a separate matter for the founder; Finances does not use it.

## Before touching it again

1. Read `docs/plans/finances-contract-changes.md` for the exact response shapes. The callers in `finances-admin.js`, `admin.html`, `logistics.html` and `admin-analytics.js` read those field names.
2. Change the engine (`fin__order_lines`) and re-run `docs/plans/sql/fin_checks.sql`. The order-level `umzila` components must add up to `net` (±3c), and the summary waterfall must add up exactly.
3. Run the functions as an admin in a rolled-back block, set up with `set_config('request.jwt.claims', …)` and `set local role authenticated`. Compare the number of paid orders, the gross and the fees against raw `orders` SQL. As of 2026-11-17, all-time gross is R9 724 = PayFast/total gross R9 829 − R100 enrolment − the R5 test, and fees are R179.53 = R182.01 − R2.48 for the test.
4. Don't add a second money sum anywhere. A new screen calls the same functions.
