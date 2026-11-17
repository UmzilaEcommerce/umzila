# Finances: contract changes (Workstream A, 2026-11-16)

These notes replace plan §2.2–§2.4 wherever the two differ. The founder answers at the top of the plan override the plan. All of this is **live** on project ojwnjtcxbitwmtlsbjnx, and every call shape below was checked against live data. There are real sample responses in `docs/plans/fixtures/fin_summary.sample.json`.

## CHANGES THAT AFFECT B / C / D — read first

1. **Commission is a mark-up, not 15 %.**
   - "Owed to store" comes from a per-product **store price**, the amount the store gets per unit.
   - If a product has no store price, the store is owed the line price ÷ (1 + `default_markup_percent`/100). The default is 9. That line is flagged as an estimate.
   - Commission = goods after the store's own discount − owed.
   - The keys `commission_pct` and `commission_base` **do not exist**.
   - Example: the Velaphi plate sold at R137 with a store price of R130 → owed R130, commission R7.
   - **How a store price is applied to a line:** owed = line subtotal × store_price ÷ current selling price.
     - If the line was sold at today's price, this is exactly store_price × qty.
     - If the price has changed since the sale, or extras/picks were added, it scales. Those lines carry `scaled: true`.
   - **For the house seller (Umzila Drinks) the same store price means cost of goods.** It is store_price × qty, not scaled. All 8 drinks are seeded: small cans and 500 ml R15, 1.5 L R18, Appletiser R22, Liqui-Fruit R18.
2. **Store prices are stored in `site_settings` key `finance` → `store_prices`.**
   - The map looks like `{ "<product_id>": 130, "<product_id>:<variant_id>": 135 }`.
   - Variant keys are used when a line's `selected_size` matches `product_variants.size`.
   - Why here and not in `products.metadata`: products are public and seller-editable, and that would show customers the mark-up.
   - **Never write `store_prices` through the settings save.** Use the RPCs:
     - `fin_store_prices_list(p_seller_id uuid default null, p_missing_only boolean default false) → [ { product_id, name, seller_id, shop_name, is_house, visible, listing_type, sell_price, store_price|null, estimated_store_price, missing, variants:[{variant_id,size,sell_price,store_price}] (only variants with their own price), sold_qty_90d, sold_value_90d } ]`. Rows are sorted by sales value over the last 90 days, so the "products without a store price" list is `p_missing_only = true`. Disabled stores are left out.
     - `fin_store_price_set(p_product_id uuid, p_variant_id uuid default null, p_price numeric default null) → { product_id, variant_id, key, store_price, sell_price, is_house, markup_amount, markup_pct, warning|null }`.
       - Passing `p_price = null` clears the price.
       - `warning` is set when the store price (or cost) is above the selling price. The save still happens; show the warning.
3. **`site_settings` `finance` is admin-only.** Anon and normal users cannot read it; the `site_settings_select_all` policy is now `key <> 'finance'`.
   - B: read it with **`fin_settings_get()`** → `{ value (WITHOUT store_prices), store_prices_count, updated_at, updated_by, updated_by_name, payfast_defaults }`. `payfast_defaults` is for "reset to PayFast defaults".
   - B: save it with **`fin_settings_save(p_value jsonb)`**, which returns the same shape as get. It keeps the stored `store_prices` whatever you send.
   - Do not upsert `site_settings` directly for this key.
   - A save that fails validation raises `FINANCE_INVALID` (22023), with the reason in `details`.
4. **The assumption keys in `value`** (these replace the plan's §2.2 JSON):

   | Key | Default | Notes |
   |---|---|---|
   | `default_markup_percent` | 9 | 0–100 |
   | `vat_percent` | 15 | |
   | `seller_codes_funded_by` | `seller` | or `umzila` |
   | `manual_discount_funded_by` | `umzila` | the discount typed on a manual ORD- order with no code |
   | `tips_go_to` | **`umzila`** | or `rider` |
   | `count_rider_pay_as_cost` | **false** | the founder's toggle |
   | `fee_rates` | see below | |
   | `rider_pay_estimate` | `{min 34, included_km 3, per_km 0.40, max 45, fallback 39, per_extra_store 3}` | |
   | `expense_categories` | see below | |
   | `income_categories` | Prize, Grant, Sponsorship, Other | |
   | `test_emails` | | a hint only — it never excludes anything |

   - There is no `priority_goes_to` key. Priority, delivery fees and tips are all Umzila revenue.
   - `fee_rates` holds one entry per method key, each `{ name, pct, fixed, min, vat }`. The method keys are cc, dc, ap, gp, sp, cp, ef, cash, pos, eft_manual and **unknown** (unknown is required).
     - cp and ef are 2 %, min R2.
     - Card, Apple Pay, Google Pay and Samsung Pay are 3.2 % + R2.
     - All of these get +15 % VAT.
     - pos (card machine) is seeded at 0 because no rate was given; the founder should set it.
   - `expense_categories`: Rider wages, Fuel, **PayFast payout fee**, Marketing, Printing, Packaging, Software, Bank charges, Salaries, Other.
5. **Rider pay is not a cost by default.**
   - `delivery.rider_pay` is always reported, for information.
   - `umzila.rider_cost` is 0 unless `count_rider_pay_as_cost` is true.
   - Umzila net never subtracts rider pay while the toggle is off.
   - The summary shows `totals.rider_pay`, `rider_cost` and `rider_pay_counted`.
6. **Per-order "exclude as test" toggle:** `fin_set_excluded(p_order_id uuid, p_excluded boolean, p_note text default null) → { order_id, excluded, entry_id }`.
   - It is idempotent. Unmarking voids the live `exclude_test` entry.
   - **`fin_mark_tests` (the bulk exclude) was NOT built.** The founder said not to bulk-exclude.
   - Instead every order has `is_test_candidate` and the flag `looks_like_test`: the email is in `test_emails`, or the order has a "test item" line.
   - The summary insight `test_candidates` counts them, so the UI can offer one tap per order.
   - Seeded on the live data:
     - Only the R5 Apple Pay order (UMZILA-1794821590398-…) is excluded.
     - The same order has a `rider_pay_override = 0`.
7. **Payout fees:** record these as an ordinary expense with category "PayFast payout fee". `fin_entry_save` takes an optional `seller_id` on expense/income rows to link the store, and `fin_entries_list` returns `seller_id` and `shop_name`.
8. **`fin_summary(p_from, p_to, p_include_excluded boolean default false)`** has a 3rd argument. The include-test-orders toggle is server-side.

   `totals` has these keys (it replaces the plan's list):
   - Money in: `gross`, `goods_list`, `discounts_seller`, `discounts_umzila`, `delivery_customer` (without priority), `priority`, `tips`.
   - Store payouts: `owed_to_stores`, `owed_estimated` (the part of owed that is estimated).
   - Riders: `rider_pay`, `rider_pay_counted`, `rider_cost`, `tips_to_rider`.
   - Fees: `payfast_fees`, `payfast_fees_estimated`.
   - Drinks: `house_sales`, `house_cogs`.
   - Corrections: `refunds`, `unexplained`.
   - Umzila: `umzila_commission`, `umzila_delivery_income` (= delivery fees incl. priority), `umzila_house_margin`, `umzila_gross_profit`.
   - Other income and expenses: `other_income`, `other_income_detail{ total, entries[], enrolment_fees{count,amount}, ads{count,amount} }`, `expenses`, `expenses_detail{ total, entries, by_category[{category,amount,entries}], monthly_recurring }`.
   - `net_profit`.

   Waterfall the UI can show, which adds up exactly:
   - gross − owed_to_stores − payfast_fees − house_cogs − refunds − rider_cost − tips_to_rider = `umzila_gross_profit`.
   - Then + other_income − expenses = `net_profit`.

   Other top-level fields:
   - `by_store` rows: `{ seller_id, shop_name, slug, is_house, orders, goods_list, discounts, goods, owed, owed_estimated, commission, cogs, cogs_missing, margin, margin_pct }`.
   - `by_method` rows: `{ method_code, name, orders, gross, fees, fees_actual, fees_estimated, fees_est_orders, effective_pct, share_of_gross }`. `effective_pct` is a percentage (5.12 means 5.12 %). `share_of_gross` is a fraction from 0 to 1.
   - `by_day` / `by_week` rows: `{ day | week_start, orders, gross, umzila_gross_profit }`. Weeks start on Monday.
   - `estimated_share` = (estimated fees + estimated store payouts + estimated rider cost) ÷ (fees + payouts + rider cost).
   - `settings` = `{ default_markup_percent, count_rider_pay_as_cost, tips_go_to }`.
   - Insight keys: `tests_hidden, test_candidates, fees_share, small_orders, store_prices_missing, cogs_missing, mismatch, rider_pay_not_counted | delivery_loss, estimates, best_store, recurring_burn, profit`.
9. **Each element of `fin_order_lines(p_from, p_to, p_include_excluded default false)`** is the plan's element with these differences:
   - `customer_email` is added.
   - `order_status` is added.
   - `source` can be `payfast`, `manual`, `zero` or `other`.
   - `payment` gets `fee_actual` (bool), `fee_estimate` (what the rate table would give, even when the actual fee is known — use it for "fee actual vs estimate"), `fee_override` and `method_set_by_admin`.
   - `goods` gets `discount_code`, `seller_discount` and `umzila_discount`.
   - `stores[]` items are `{ seller_id, shop_name, slug, is_house, goods_list, seller_discount, goods_after_discount, owed, owed_est, owed_est_amount, payout_override, commission, cogs, cogs_missing, lines[] }`. "Payout" is now called **`owed`**.
     - `lines[]` items are `{ product_id, variant_id, name, size, qty, unit_price, subtotal, sell_price, store_price, owed|null, cogs|null, est, scaled, discount, from_items_json }`.
   - `delivery` gets `delivery_id`, `shipping_total`, `rider_pay_counted`, `dispatched_at`, `delivered_at` and `minutes_to_deliver`.
     - `free_delivery` is true when a delivery exists and the customer paid 0 delivery.
   - `umzila` = `{ commission, house_value, house_cogs, house_margin, delivery_income, tips_income, discounts_funded, fees_paid, refunds, rider_cost, tips_to_rider, unexplained, owed_to_stores, net }`. The components add up to `net` (tested to ±3c).
   - `estimates` = `{ owed, owed_est_amount, fee, rider_pay, cogs }`.
   - `flags` ⊂ `totals_mismatch, items_fallback, no_lines, cogs_missing, store_price_estimated, delivery_cancelled, refund, looks_like_test, excluded`.
   - `adjustments[]` items are `{ id, type, value, text, seller_id, note, by, at }`.
   - **Mismatch handling:** `unexplained` = gross − (goods − discount + delivery + tips). The order still counts at its cash `gross`. Today the only mismatch is ORD-606970: logistics stored a total without the R38.86 delivery.
10. **Dates are SAST.**
    - A manual ORD- order is dated by its **order date**, even when the payment was recorded later.
    - Every other order is dated by `paid_at`.
11. **`fin_entry_save(p jsonb)`** — insert, or update when `id` is given.
    - Fields: `kind, category, description, amount, occurred_on, recurring ('none'|'monthly'), recur_until, seller_id`. Adjustments use `order_id, adjustment_type, adjustment_value, adjustment_text` instead.
    - `category` must be one of the settings categories, compared case-insensitively.
    - Adjustment rules:
      - The category is filled in automatically and the date is the order's day.
      - `refund` must be more than 0 and no more than what was paid.
      - `*_override` must be 0 or more.
      - `payment_method_set` takes a `fee_rates` key in `adjustment_text`.
      - `seller_payout_override` needs `seller_id` when the order has more than one store.
    - There is one live adjustment of each type per order (per store for payout overrides); notes are unlimited. A second one raises `FIN_DUPLICATE` (23505).
    - Other validation errors raise `FIN_INVALID` (22023), with the reason in `details`.
    - The kind, order and adjustment type of an existing entry cannot be changed.
    - It returns the row plus `created_by_name`.
    - `fin_entry_void(p_id, p_reason)` needs a reason and returns the row. A missing entry, or one already removed, raises `NOT_FOUND` (P0002).
    - `fin_entries_list(p_from, p_to, p_include_voided default false)` rows are `{ id, kind, category, description, amount, occurred_on, recurring, recur_until, occurrences_in_range, amount_in_range, order_id, order_number, seller_id, shop_name, adjustment_type, adjustment_value, adjustment_text, created_by, created_by_name, created_at, updated_at, voided, voided_at, voided_by_name, void_reason }`.
      - Adjustments are listed by their order's day.
      - Seeded rows show `created_by_name 'System'`.
12. **Staff RPCs (C and D).**
    - **Logistics staff and admins** may call `fin_sales_by_period`, `fin_top_products`, `fin_store_breakdown` and `logistics_record_manual_payment`.
    - **Admins only:** `fin_delivery_breakdown` and all the other fin_* functions.
    - Anyone else gets `ADMIN_ONLY` or `STAFF_ONLY`, SQLSTATE 42501.
    - `fin_sales_by_period(p_from, p_to, p_gran 'day'|'week'|'month')` → `{ from, to, gran, rows:[{ period (start date), orders, gross, goods }], totals:{ orders, gross, goods, average_order } }`.
      - The range can be at most about 800 days.
      - `goods` = goods after discount.
      - **Oct 2026 = 16 orders, R2 075.05.**
    - `fin_top_products(p_from, p_to, p_limit default 10, max 100)` → `[ { product_id, name, shop_name, seller_id, is_house, orders, qty, goods } ]`.
    - `fin_store_breakdown(p_from, p_to)` → `{ from, to, is_admin, rows:[{ seller_id, shop_name, slug, is_house, orders, goods_list, discounts_seller, goods, (admin only: owed, owed_estimated, commission, cogs, margin_pct) }] }`.
      - Only stores with sales in the range are listed. Merge by `seller_id` for a full store list.
      - The house seller is included with `is_house: true`.
    - `fin_delivery_breakdown(p_from, p_to)` → `{ from, to, rider_pay_counted, orders:[{ order_id, order_number, day, customer_name, stores[], status, fee_customer, priority, shipping_total, rider_pay, rider_pay_est, rider_pay_override, margin (= shipping_total − rider_pay), free_delivery, minutes_to_deliver (delivered_at − dispatched_at) }], totals:{ deliveries, delivered, cancelled, fee_customer, priority, rider_pay, margin, free_delivery_orders, rider_pay_on_free, avg_minutes_to_deliver, delivered_share } }`.
    - `logistics_record_manual_payment(p_order_id, p_method 'cash'|'pos'|'eft_manual')` → `{ order_id, order_number, payment_status, payment_method_code, paid_at, order_status }`. It raises these errors, all 22023 except NOT_FOUND:

      | Error | When |
      |---|---|
      | `NOT_MANUAL_ORDER` | the order is not ORD-, or it has a PayFast id or m_payment_id |
      | `ALREADY_PAID` | the order is already paid |
      | `FIN_INVALID` | the method is not cash, pos or eft_manual |
      | `NOT_FOUND` (P0002) | the order does not exist |

      It never touches `order_status`.
13. **Changes C asked for:**
    - `get_ops_board().deliveries[].stores` now leaves out the house seller. It also finds the store of manual-order lines through `products.seller_id`.
    - `get_site_traffic().sources` leaves out orders excluded as tests.
14. **Dropped** — each one was grepped in the repo and in DB functions, views and triggers first:

    | Object | Why it was safe |
    |---|---|
    | Table `"Logistics"` | Both of its users already had user_roles admin rows. |
    | Table `user_roles_backup` | It only held a copy of a row that is still in user_roles. |
    | View `delivery_analytics_summary_v` and function `get_delivery_analytics_summary()` | Nothing read them. |

    **Kept:**
    - `discount_redemptions`, which `lib/complete-order-payment.js`, `lib/discounts.js` and `manage-discount-codes.js` use.
    - `route_profitability_v` / `get_route_profitability`, which admin.html still calls. C can retire them once Delivery Analytics reads `fin_delivery_breakdown`.
15. **Manual cash orders recorded:** the R460 the founder called "3 orders" is actually **4** orders, all set to paid, `cash`, `paid_at` = order date: ORD-790502 R12, ORD-496470 R12, ORD-631232 R56 and ORD-270760 R380.

## Not built / differences from the plan
- `fin_mark_tests`: not built (see 6).
- There is no `payout_paid` ledger. The founder said stores are settled instantly.
- `tips_go_to` defaults to `umzila`, not `rider`.
- Estimated rider pay before a route completes uses the band from `rider_pay_estimate` and the quote's `distance_km`. Today every delivered order has a real payout, so nothing in the live data is estimated.
