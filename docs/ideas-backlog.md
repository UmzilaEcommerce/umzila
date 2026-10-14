# Ideas backlog (agreed, not built yet)

Ideas the founder wants to keep for when Umzila expands. Each has the thinking already done. Read this before building any of them.

## Creator discount codes (decided 2026-10-09)

Each content creator gets their own code (e.g. `THANDI`). Customers use it without signing in. The creator earns per order that uses it.

**Founder's plan:** no sign-in needed, because friction loses sales. A reused code still means a sale.

**Pay the creator:** R7 per order, and possibly an upfront fee. My suggestion was R300–R500 upfront (or free meals for the content) plus R7 per order, with a bonus at a milestone (e.g. +R500 at 50 orders), rather than R1,000 upfront.

**Watch the margin.** A code's discount currently comes out of Umzila's pocket, because the store still gets its full price. A 10% code (~R10) plus R7 to the creator is R17 of the ~R39 Umzila earns per order. Suggested fixes:
- give a smaller customer perk (5%, or a free drink, which costs less than its shelf value);
- run each code for a campaign period (e.g. 30 days), not forever.

**How it would work:**
- `discount_codes` with `multi_use = true` normally requires an account (`lib/discounts.js validateCode` → `requiresSignIn`). Creator codes need a flag (e.g. a new `allow_guests` column) to skip that.
- Attribution:
  - `orders.coupon_code` already records which code was used;
  - links can also carry `?src=<creator>` (orders.source, built 2026-10-09);
  - an admin view of "orders per creator code + amount owed" would complete it.

## Bundles / multi-buy (discussed 2026-10-09)

**Founder's idea:** e.g. "3 plates, 15% off".

**Suggested instead:** "3 plates = free Coca-Cola 1.5L" (from Umzila Drinks). It costs Umzila about R18 in stock but feels like R32.90 to the customer, and it pushes the drinks Umzila already sells. A 15% discount on three plates is about R34, all from Umzila's margin.

**Also:** add-ons for the plate: extra wors, extra pap, chakalaka, sauces. Ask Velaphi which extras they'd sell. They could be Velaphi products, or house add-ons if Umzila supplies them.

**How it would work:** a rule that validate-cart applies server-side (never trust the browser), shown in the checkout totals breakdown like a discount line. A free drink could be added as an R0 house line when the rule matches.

## Scheduled delivery & weekly lunch pre-orders (idea 2026-10-14)

**Founder's idea:** customers choose when their food is delivered instead of "as soon as possible". For example, someone pre-orders lunch delivered to their work every weekday at 12:30, for the whole week, in one go. Umzila tells them each day that their order is coming.

**Why it's strong:**
- **Guaranteed repeat orders:** one checkout becomes 5 orders.
- **Planned rider trips:** all the 12:30 orders to the same office park or campus become one multi-drop trip (the trip planner can already carry 5 orders).
- **Calmer for stores:** they know the week's lunch orders in advance.

**How it would work (reusing what exists):**
- **Checkout:**
  - Add a "When?" choice: *As soon as possible* or *Schedule*.
  - Schedule offers a day (or several days) plus a time slot, only inside the store's opening hours (`seller_availability` / `get_store_hours_status`).
  - Weekly: the same basket on Mon–Fri (or the days picked) at the same time and address.
- **Orders:**
  - One `orders` row per delivery day, so nothing about payments, order_items, tracking or payouts changes.
  - Each row gets a `scheduled_for` time, and the days are linked by a group id.
  - Paying for the whole week up front is simplest: one PayFast payment, with each day's order created as paid.
  - Alternative: charge each day to a saved card (`payment_methods` tokens). This needs more care (failed charges, cancelling a day).
- **Kitchen and dispatch:**
  - The store sees the order as "for 12:30", not "now".
  - `create_delivery_on_payment` would hold the delivery until about `scheduled_for − (prep + travel)` before offering it to riders, instead of dispatching at once.
  - Similar to the after-hours "made when it opens" logic (`order_closed_store`).
- **Notifications:**
  - Morning of each day: "Your lunch from Velaphi arrives at 12:30 today."
  - When the rider leaves: the existing "on the way" email plus the tracking link.
  - WhatsApp would be even better, but that needs WhatsApp Business API costs. Email works today.
- **Customer control:** skip or cancel a single day up to a cut-off (e.g. 9:00 that morning), with a refund or store credit (gift-voucher style balance).

**Decisions needed before building:**
- Pay for the week up front, or charge daily?
- Cut-off and refund rules for a skipped day.
- Should a weekly bundle get a small perk (free drink on Friday) to push sign-ups?
- Which slots to offer (start with lunch 12:00–13:30 only)?
- Which stores take part (they must commit to being ready on time)?

**Start small:** a "Schedule for later today" option first (same order, later time). It tests the kitchen and rider timing with no recurring payments. Then the weekly lunch plan.
