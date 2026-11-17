# Admin → Intelligence

Rebuilt 2026-11-17. The old page ranked everything by favourites, which nobody uses (one favourite in 30 days). It also showed raw event counts. The new page answers the questions that grow the business:

- What sells?
- Where do shoppers drop off?
- Which stores turn visitors into orders?
- Do customers come back?
- What do people want that we don't have?

## One source: `fin_intelligence(p_from date, p_to date) → jsonb`

The whole page comes from one database function (`docs/plans/sql/14_fin_intelligence.sql`).

**Access:** admin-only (`fin__assert_admin()` first, `EXECUTE` revoked from PUBLIC and anon). It is SECURITY DEFINER and capped at one year. The browser calls it once per period (7 / 30 / 90 days, SAST dates) and caches the result. The five tabs only re-render that one result.

**Where the numbers come from:**
- **Money and orders** come only from `fin__order_lines`, the Finances engine. That means paid only, test orders left out, SA days, manual ORD- orders by order date. This follows the rule in finances.md: never sum `orders.total` in the browser. The one exception is the value of *unpaid* checkouts, which is `orders.total` of `pending_payment` rows. It is not revenue, and that rule doesn't cover it.
- **Behaviour** comes from `user_events`:
  - `store_view`, `product_click` (= "looked at a product"), `add_to_cart`, `search`;
  - rows from staff accounts (admins plus any active `user_roles`) are left out;
  - one "person" is `user_id`, else `anonymous_id`.
- **Visitors** come from `site_visits`, with staff sessions left out (the same rule as `get_site_traffic`).
- **Customers:** one customer is one email address (lower-cased), else the order. Repeat, lapsed and time-between-orders figures use every paid order from 2024 up to the period end, so "came back" is true lifetime behaviour.

### What it returns

| Key | Contents |
|---|---|
| `headline` | Paid orders, order value (what customers paid), `umzila_net`, paying customers. Each also comes for the previous period of the same length (`*_prev`). |
| `funnel` | Visitors, then store visitors, product viewers, cart adders, then checkouts (distinct emails on any order created, paid or not), then paid customers. |
| `products` | Every product with activity or sales in the period: viewers, carters, orders, qty, goods (line subtotals), stock, service/house/visible flags. |
| `stores` | Every active non-house store: visitors, product viewers, carters, orders, goods, `last_sale` (all-time), listed, sold-out count. |
| `customers` | active / new / returning, `all_time`, `repeat_all_time`, `avg_days_between`, `one_and_done` (one order, first one 2+ weeks ago), `top` (10, by paid in period), `lapsed` (15 best customers with no order for 30+ days before the period end), `lapsed_count`. |
| `checkout_drop` | Unpaid checkouts started in the period, their value, how many were `recovered` (same email paid later), and `lost_people`. |
| `when` | Paid orders by ISO weekday and by hour, SAST. |
| `search` | Top terms and zero-result terms. A zero-result term is `metadata.result_count = 0` and not a `via` search. |
| `areas` | `delivery_area_requests` in the period, by city, plus the recent ones. |
| `ratings` | `delivery_feedback` count and average, plus recent ratings of 3 or lower with message and store. |

## The page (`admin.html`, Intelligence section)

- **What to do:**
  - headline cards with the change against the previous period;
  - a ranked list of actions built in the browser from simple rules, in `renderIntelTodo`:
    - lost checkouts;
    - lapsed regulars;
    - stores with 10+ visitors and 0 orders;
    - products seen by 5+ people with 0 orders;
    - cart adds that never sold;
    - best sellers with 5 or fewer left;
    - zero-result searches;
    - out-of-area requests;
    - low ratings;
    - stores with no sale in 30+ days;
    - the busiest day and hour;
  - the drop-off funnel.
- **Products:** best sellers, "Looked at, not bought" (3+ viewers), "Added to cart, not bought", "Selling but running low".
- **Stores:** a conversion table (visitors → viewed → cart → orders, sales, visitors-to-order %, last sale, listed / sold out). What each store is owed stays on Finances.
- **Customers:** come-back rate, one-and-done, days between orders, "Haven't ordered in 30+ days" (with mailto links), top customers.
- **Demand & timing:** orders by weekday and hour, "Searched, nothing found", top searches, out-of-area requests, delivery ratings.

Search terms are logged as people type ("m", "ma", "mak"…). `cleanTerms()` keeps only the longest of each chain and drops terms under 3 characters.

**The dashboard** uses the same RPC (30 days, shared cache) through `loadDashboardOverview()`:
- KPI row 2: Active Sellers, Paying Customers, Unpaid Checkouts. Tapping a card opens the matching Intelligence tab (`data-open-intel`).
- A "Best sellers — last 30 days" list.

These replaced the "Total Favourites" card and the "Top categories by favourites" and "Event breakdown" charts.

The **⚡ Re-rank products** button (formerly "Recalculate Rankings") still calls `recalculate-rankings.js`. It is unchanged.

## Removed

- **`netlify/functions/admin-analytics.js`:** its only caller was this page. It summed `orders.total` itself and ranked by favourites.
- **Favourites everywhere on the page,** the category charts, the event-type doughnut and the "recent new products" list.

`products.favourite_count` and the favourites feature themselves are untouched.

## Before changing it

- Any new money figure must come from `fin__order_lines` inside a `fin_*` function, never the browser.
- Keep the period comparison honest: `prev` is the same number of days immediately before.
- `user_events` only holds what the site logs. `product_click` is logged by `track-engagement.js` only. A new behaviour you want here must first be logged there or via `umzilaTrack`.
- The action rules' thresholds (10 visitors, 5 viewers, 5 left…) are deliberately simple constants in `renderIntelTodo`. Tune them there as volume grows.
