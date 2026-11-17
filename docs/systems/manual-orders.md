# Manual orders (logistics "New Order")

Rebuilt 2026-11-17. These are orders that staff type in by hand: phone or WhatsApp orders, cash at the stall, a card-machine sale. They get an `ORD-…` number. This note covers what happens end to end and why it is built this way.

## Where it lives

- **Logistics → New Order** (`logistics.html` `openCreateModal`). The button is in the header, on Overview and on Orders.
- **Logistics → open an unpaid ORD- order → "Payment not recorded yet" → Paid: Cash / Card machine / EFT.**
- **Server:** `netlify/functions/manual-order.js`. It is the only thing that creates a manual order or records its payment. Admins (`public.admins`) and active logistics/admin `user_roles` can call it, which is the same rule as `get_ops_board`. The page sends the staff session as `Authorization: Bearer`. It never inserts into `orders` itself any more.

## The two ways an order is handled

The form starts with one choice.

### 1. 🛵 "Deliver it — with tracking"

This behaves like a PayFast order once it is paid.

- **The address is required** and must be picked from the HERE suggestions (`address-search.js`, the same as checkout), so the order carries `destination_geo`.
- **The address must be inside an active Service Area** (`find_service_zone_for_point`). Outside every zone it is refused, the same as checkout.
- **The delivery fee is suggested by the server** (`action: 'quote'`). It uses the same rule as checkout: `lib/delivery-price` from the first store's pickup to the address by road (`lib/road-distance`, cached), plus the admin delivery markup, capped by a zone promo, or free for free-delivery items. Staff can type a different fee.
- **Stock is a hard cap**, the same as validate-cart.
- **"Not paid yet"** saves the order with `order_status 'Pending'` and `payment_status 'pending'`. No rider, no emails, and no delivery row. Pressing **Paid: …** later does everything below.
- **Paid** (at creation or later) runs `completeOrderPayment()`. That is the same function the PayFast ITN and R0 orders use. Setting `order_status 'paid'` fires the normal triggers:
  - `create_delivery_on_payment` makes a stand-in quote plus the `deliveries` row (tracking token and PIN).
  - `populate_order_items_on_payment` writes `order_items`.
  - `completeOrderPayment` then:
    - links the order to the customer's account if they have **verified** that email;
    - consumes the code typed in "Code used";
    - takes the stock;
    - emails the customer the confirmation with the **live tracking link**;
    - emails the store(s) and admins;
    - calls `timeslotAfterPaid` → `releaseOrderDelivery`, which offers the trip to riders. A closed store waits until it opens.
- From then on it is a normal delivery. The customer gets the on-the-way and delivered emails, and the rating email from `send-rating-requests.js`.

### 2. ✅ "Already paid & delivered"

This just records the sale.

- **Payment method is required.** The address is optional and no location is stored, so no delivery row is ever made.
- **It runs the same `completeOrderPayment()`** with `pfResponse.delivered = true`. The order items, stock, account link and code are handled the same way.
- **What it sends:**
  - the customer email is a **receipt** (subject "Your Umzila receipt — ORD-…", header "Your order was delivered", badge "PAID & DELIVERED", no tracking button);
  - no store or admin alerts;
  - nothing is sent if staff untick "Email the customer a receipt" (`notify: false`).
- **The order is then set to `order_status 'Delivered'`.**

## How the pieces connect

- **`m_payment_id` = the order number.** `completeOrderPayment` finds orders by `m_payment_id`. `logistics.html isManualOrder()` treats `m_payment_id` null **or** equal to the order number as manual.
- **Money is never PayFast:**
  - `pf_payment_id` stays null;
  - `pf_response` is `{ manual: true, mode, method, entered_by, … }` with no `amount_gross`. That is exactly how `fin__order_lines` recognises a manual order (dated by order date, method from `payment_method_code`, no PayFast fee);
  - `payment_method_code` = `cash | pos | eft_manual` is written after completion;
  - `source = 'manual'` (Admin → Visitors orders per source).
- **Items are built on the server** in the checkout shape: `id`/`product_id`/`variant_id`/`seller_id`/`name`/`title`/`item`/`price`/`quantity`/`size`/`listing_type`.
  - **Store visibility:** sellers see the order because `orders_seller_read` matches `items->>'id'`.
  - **Prices:** these follow validate-cart (variant `price_override`, then the sale price). A typed price that differs is kept and marked `manual_price` + `list_price`.
  - **Options and services:** "must choose" options are enforced. Services can't be added by hand.
- **`user_id` is never the staff member.** It is null and filled from the verified email when paid. The old form set `user_id = CURRENT_USER_ID`, so every manual order showed up as the logistics rep's own order.
- **The insert uses `order_status 'Pending'`, not `pending_payment`.** This keeps it out of the timeslot insert guard (manual orders are dispatched now, not on a run) and visible in logistics, which hides `pending_payment`.

## Older ORD- orders (before 2026-11-17)

These were inserted by the browser with stock and `order_items` written at creation (`handle_logistics_order`). The `pay` action spots them because `pf_response.manual` is missing. It also catches any order whose status has already moved past `Pending`. For those it only sets `payment_status`/`paid_at`/`payment_method_code`: no emails, no rider, and no second stock decrement.

The old RPCs `handle_logistics_order` and `logistics_record_manual_payment` were dropped on 2026-11-17 after this code went live (migration `drop_old_manual_order_rpcs`, same SQL as `docs/plans/sql/13_drop_old_manual_order_rpcs.sql`). Do not bring them back: manual orders go only through manual-order.js.

## Gotchas / check before touching

- **`lib/complete-order-payment.js` is shared with PayFast.** The manual branches only switch on when `pfData.manual === true`: `delivered` changes the wording and skips store/admin mails, and `notify === false` skips the buyer email. Keep it that way.
- **Tracking and rider dispatch come from the triggers**, not from this function. If `create_delivery_on_payment` changes, re-check manual "deliver" orders.
- **There is no PayFast payment link for manual orders.** Online payment means the customer orders on the site.
- **Tested in a rolled-back transaction as `service_role` (2026-11-17)**, with timeslots on:
  - a "deliver" order turned paid makes a PENDING delivery with a tracking token and PIN, plus `order_items` with `seller_id`;
  - a "done" order makes no delivery and ends `paid/Delivered`;
  - `fin__order_lines` reports both as `source: manual`.
- **Not tested live:** the emails and the rider offer. The function was not run against production, to avoid real emails.
