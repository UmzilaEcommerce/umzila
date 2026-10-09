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
