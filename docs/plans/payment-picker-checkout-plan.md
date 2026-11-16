# Payment method picker + one-page checkout — implementation plan

Written 2026-11-15 by the lead designer for four parallel worker agents. Inputs: the founder's "Umzila payment method picker developer brief" (2026-11-14, rules P1–P18), the checkout redesign mockups (`Main.dc.html` 390 px / `Desktop.dc.html`) and the FOUNDER DECISIONS of 2026-11-15 (repeated in §0 — they override the brief and the mockups wherever they differ). Everything in CLAUDE.md stays binding (PayFast additive-only, ADMIN-MANAGEABLE BY DEFAULT, buyer identity from the Bearer token, email ownership via `my_verified_email()`, saved cards, codes, guest checkout, closed-store rules, timeslots).

Workers: read §0–§3 fully, then only your own workstream in §8 plus the interface contracts in §9. Do not touch files owned by another workstream. No live payments. Commit on your own branch, do not push.

---

## 0. Founder decisions (binding)

1. **Option order and set:** (a) **Card** first — selecting it reveals the buyer's **saved cards** (existing `payment_methods` tokens, charged through `charge-payfast-token.js`, no PayFast page) plus **"Add a new card"** (PayFast `cc`, with the existing "Save this card" switch + nickname); (b) **Capitec Pay** `cp`; (c) **Instant EFT** `ef`; (d) **Apple Pay** `ap`, **Google Pay** `gp`, **Samsung Pay** `sp` — shown only on devices that support them (device rule per option, see §6.6); (e) **More ways to pay** — no `payment_method`. Every option admin-managed (name, description, code, on/off, position, device rule). The founder enables every method on the PayFast account — build so all work.
2. **Only what is real:** no Umzila credit switch, no service fee, one saved address (profiles), customer copy = **"dispatched by 12:00"** (slot start) — never an arrival window. The mockups' "arrives inside the window", "Service fee R7", "Use R30 Umzila credit", "By 13:00" step are **not** built.
3. **PayFast functions: additive only.** `payment_method` goes into the signed payload in PayFast's documented position (§4.2); attempt + fee recording; paid-twice flagging. Existing field order, ITN checks and flows stay. Everything behind the master switch **"Payment picker on"** (`site_settings` key `payments` → `enabled`). Off = checkout + PayFast flow exactly as today.
4. **Checkout revamp keeps every existing behaviour** (§6.1 table). Re-layout + flow change, not a logic rewrite.
5. **Admin:** Payment options page (list / edit / on-off / reorder / add from PayFast code list / master switch), Flagged orders ("paid twice"), Report per option for a date range. Paid orders show the option used + PayFast fee.

### Recommendation on shipping the revamp (decision 4 asked for one)
**Ship the one-page checkout as the new default, in place in `checkout.html`, with no switch of its own.** The markup can't be dual-rendered without duplicating ~6,500 lines (forbidden by CLAUDE.md), and the revamp does not change any money logic — every pricing/order/payment function is reused unchanged. Safety net: (1) full QA on a Netlify deploy preview against the PayFast **sandbox** (founder sets `PAYFAST_SANDBOX=true` + sandbox merchant credentials for the *deploy-preview* context in Netlify env, so previews never hit the live account); (2) rollback = redeploy the previous commit (one click in Netlify). Sequence: merge the revamp with the picker switch **off**, watch two days of live orders, then flip "Payment picker on" after the live per-method tests (§11).

---

## 1. Answers to the brief's "Questions to answer before building" (from the code and DB)

| Question | Answer |
|---|---|
| How is a PayFast notification matched to an order today? | By `m_payment_id` only. `orders.m_payment_id` has a unique index (`orders_m_payment_id_key`); it equals `orders.order_number` = `UMZILA-<ms>-<random>` generated in the browser (`preparePendingOrderOnce`). `payfast-itn.js` verifies the MD5 signature over the raw body + passphrase, then (status `COMPLETE`) calls `lib/complete-order-payment.js completeOrderPayment({mPaymentId, pfPaymentId, pfResponse})` which `update … eq('m_payment_id')` sets `order_status='paid', payment_status='paid', pf_payment_id, pf_response (whole ITN), paid_at`, and runs the one-time tasks only if the row was not already paid (`alreadyPaid` guard = idempotency). Today's ITN runs **only the signature check** — no valid-host check, no amount comparison, no `/eng/query/validate` confirmation. The whole ITN is stored in `orders.pf_response`, which already contains `amount_gross`, `amount_fee` (negative string, e.g. `"-5.70"`), `amount_net`, `pf_payment_id`, `custom_str1..5`, `token`. Real-data note: order `UMZILA-1794489618825-ktj4i8kup` has `total 54.5` but `amount_gross 92.46` — `orders.total` is browser-written and editable later, so an amount comparison must **flag**, never refuse (§4.4). |
| Where do return and cancel links go? | `return_url = ${SITE}/checkout-success.html?m_payment_id=<m>&order_id=<uuid>`; `cancel_url = ${SITE}/checkout-cancel.html?m_payment_id=<m>` (a static page: "Payment Cancelled", "Try Again" = `history.back()`); `notify_url = ${SITE}/.netlify/functions/payfast-itn`. `checkout-success.html` polls `order-status.js?m=` until `paymentStatus === 'paid'` (8 × 4 s) and applies `ss_cart_after_paid`. The cart is **not** cleared before payment, so a cancel today already returns to a page whose cart is intact — but the pending order row is abandoned and the next Pay creates a **new** order. |
| Is the order created before the redirect? | Yes. `preparePendingOrderOnce()` validates, re-prices via `validate-cart.js`, then the **browser** inserts an `orders` row with `order_status='pending_payment'` (client-generated `id`; guests through the anon insert policy; the timeslot `trg_timeslot_guard_insert` runs here), then `submitToPayFast()` asks `generate-payfast-signature.js` to sign and posts the form. Each Pay press makes a new `m_payment_id` → P11 (retry = same order) needs the "reuse the pending order" rule in §4.3. Paid state only comes from the ITN (or `charge-payfast-token.js` / `complete-zero-total-order.js`, which call the same `completeOrderPayment`). |
| Do customers have accounts? | Yes (Supabase auth + `profiles`), and guests may check out (anon pending-only insert; verified guest signing path in `generate-payfast-signature.js`; linking by `my_verified_email()`/`claim_my_email_orders`). Saved cards = `payment_methods` (many per user). So "last option" is remembered on the account **derived from paid attempts** (RPC `my_last_payment_option()`, §3.3 — no new profile column) and in `localStorage umz_pay_option` for guests. |
| How are refunds done today? | By hand in the PayFast dashboard. `timeslot-admin.js { action:'mark_refund' }` sets `order_status='refunded'`, cancels the delivery and emails the customer; **the money moves only in PayFast** (R2 ex VAT per refund). Flagged "paid twice" orders follow the same path: admin refunds the extra `pf_payment_id` in PayFast, then presses "Mark resolved" in Admin → Payments (§7). |
| Which methods are enabled on the PayFast account? / Does `cc` take debit cards? | Not answerable from code. **Founder:** PayFast dashboard → Settings → Payment methods. PayFast's `cc` is "Credit & Cheque card" (Visa/Mastercard incl. most debit cards); `dc` is PayFast's separate "Debit card" rail. Keep the Card option on `cc`; the live test (§11) pays once with a debit card. If refused, add a second admin option "Debit card" with code `dc` — no code change needed. |

---

## 2. Target architecture in one paragraph

With **"Payment picker on"** the browser no longer calls `generate-payfast-signature` directly. It calls one new function, **`begin-payment.js`**, with the pending order's `m_payment_id`, the chosen `option_key` (never a PayFast code) and today's payload. The server loads the option from `site_settings` key `payments`, refuses anything not active (P5), re-checks the delivery run for a reused order (P18), inserts a **`payment_attempts`** row (P8), and then either (a) saved card → invokes the existing `charge-payfast-token.handler` in-process and marks the attempt paid, or (b) redirect → invokes the existing `generate-payfast-signature.handler` in-process with two trusted server-side fields (`trustedPaymentMethod` = the option's code or nothing, `trustedAttemptId` → `custom_str3`) and returns `{actionUrl, params}` for the browser to post. PayFast echoes `custom_str3` in the ITN, so `completeOrderPayment` matches the **order by `m_payment_id` exactly as today** and the **attempt by `custom_str3`** (P9) — nothing about today's matching changes. The ITN handler gains the `/eng/query/validate` confirmation and an amount comparison that flags, plus "paid twice" detection. A once-a-minute sweep (inside the existing `timeslot-tick`) marks attempts with no answer after 30 min. Cancel on PayFast returns straight to `checkout.html?pf=cancel&…` with everything restored (P10). With the switch **off**, none of this runs: checkout takes today's exact path.

---

## 3. Data model (exact names)

All SQL goes in one migration file `docs/plans/sql/6_payment_picker_schema.sql` (Workstream A), applied with `mcp__supabase__apply_migration` name `payment_picker_schema`. Everything is **inert** until `site_settings.payments.enabled = true`.

### 3.1 `public.site_settings` key `payments` (new row; no new table — CLAUDE.md rule)
```jsonc
{
  "enabled": false,                  // master switch "Payment picker on"
  "no_answer_minutes": 30,           // attempts with no ITN after this → 'no_answer'
  "itn_validate": true,              // POST the ITN back to PayFast /eng/query/validate (only while enabled)
  "options": [
    { "key": "card",        "name": "Card",             "description": "Visa or Mastercard — saved cards pay in one tap", "code": "cc", "active": true,  "position": 1, "device": null },
    { "key": "capitec",     "name": "Capitec Pay",      "description": "Approve in your Capitec app",                      "code": "cp", "active": true,  "position": 2, "device": null },
    { "key": "eft",         "name": "Instant EFT",      "description": "Pay from your bank account",                      "code": "ef", "active": true,  "position": 3, "device": null },
    { "key": "apple_pay",   "name": "Apple Pay",        "description": "Pay with Face ID or Touch ID",                     "code": "ap", "active": true,  "position": 4, "device": "apple" },
    { "key": "google_pay",  "name": "Google Pay",       "description": "Pay with the cards in your Google account",        "code": "gp", "active": true,  "position": 5, "device": "android" },
    { "key": "samsung_pay", "name": "Samsung Pay",      "description": "Pay with Samsung Wallet",                          "code": "sp", "active": false, "position": 6, "device": "samsung" },
    { "key": "more",        "name": "More ways to pay", "description": "Other methods on PayFast",                        "code": null, "active": true,  "position": 7, "device": null }
  ]
}
```
Rules: `key` = `^[a-z_]{2,30}$`, unique; `code` = one of PayFast's documented codes (`cc dc cp ef ap gp sp ss zp mp mc mt pf ab nd rc mu sc`) or `null` (exactly one option may have `null` code — the catch-all); `device` ∈ `null | 'apple' | 'android' | 'samsung'`. `key: 'card'` is special in the browser only (shows the saved-card sub-picker); the server treats it like any `cc` option. Readable by everyone (existing `site_settings_select_all`), written by admins (existing `site_settings_admin_write`) — same pattern as `timeslots`.

### 3.2 New table `public.payment_attempts` (necessary: one row per Pay press, nothing existing fits)
```sql
create table public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  m_payment_id text not null,                      -- copy of orders.m_payment_id (ITN matching key)
  user_id uuid,                                    -- orders.user_id at the time (null = guest)
  option_key text not null,                        -- site_settings option key, or 'legacy' (see 4.4)
  payment_method_code text,                        -- 'cc','cp',… ; null = More ways to pay / unknown
  kind text not null check (kind in ('redirect','saved_card','zero')),
  payment_method_id uuid references public.payment_methods(id) on delete set null, -- saved card used
  amount numeric not null,                         -- what the order owed when the attempt started
  status text not null default 'started' check (status in ('started','paid','cancelled','failed','no_answer','paid_twice','refunded')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  pf_payment_id text,
  amount_gross numeric, amount_fee numeric, amount_net numeric,   -- from the ITN; fee stored POSITIVE (abs of "-5.70")
  pf_response jsonb,                               -- only for paid_twice rows (the extra payment's ITN)
  device text,                                     -- 'apple'|'android'|'samsung'|'desktop'|'other' (browser-reported, display only)
  note text
);
create index payment_attempts_order_idx on public.payment_attempts(order_id, started_at desc);
create index payment_attempts_open_idx on public.payment_attempts(started_at) where status = 'started';
create index payment_attempts_report_idx on public.payment_attempts(option_key, started_at);
alter table public.payment_attempts enable row level security;
-- SELECT: staff only (admins + active logistics) — same predicate as orders_manage_staff. No INSERT/UPDATE/DELETE policies: service role + SECURITY DEFINER RPCs only.
```

### 3.3 `public.orders` — new columns (additive, all nullable)
| column | type | written by | meaning |
|---|---|---|---|
| `payment_option_key` | text | begin-payment (at attempt start), completeOrderPayment (confirms) | option the order was paid with (P14) |
| `payment_method_code` | text | same | PayFast code used; `'token'` for a saved card, `'zero'` for R0 orders, null for picker-off/legacy |
| `payment_flag` | text check in ('paid_twice','amount_mismatch') | completeOrderPayment / payfast-itn | the flag (P13 + §4.4) |
| `payment_flag_attempt_id` | uuid references payment_attempts | same | link to the extra / mismatched payment |
| `payment_flag_resolved_at` | timestamptz | admin RPC | admin pressed "Mark resolved" after refunding |

Fee/net per paid order = `orders.pf_response->>'amount_fee' / 'amount_net'` (already stored for every ITN-paid order, including before this build) — no duplicate column. `orders_client_update_guard` already blocks browsers from touching these.

### 3.4 RPCs (SECURITY DEFINER, `set search_path = public`)
| function | callable by | does |
|---|---|---|
| `my_last_payment_option()` → text | authenticated | `option_key` of the newest `payment_attempts` row with `status='paid'` whose order's `user_id = auth.uid()`; null if none. Revoke from anon. |
| `payment_attempt_cancelled(p_attempt uuid, p_m_payment_id text)` → boolean | anon, authenticated | sets `status='cancelled', ended_at=now()` **only if** `status='started'` and `m_payment_id` matches (the uuid + m_payment_id pair is only known to the payer's browser and PayFast). Returns true if changed. |
| `payment_order_recheck(p_order_id uuid)` → jsonb | service role only (revoke from public/anon/authenticated) | For a reused pending order (P18): `{ ok:true }` when the order has no slot or its `slot_id/slot_run_date` is still `open` per `timeslot_open_runs(timeslot_goods_sellers(order), now())`; else `{ ok:false, reason, closed_at, window_start, next_open }` in the same shape `trg_timeslot_guard_insert` puts in `DETAIL`. Also `ok:false, reason:'not_pending'` when `order_status <> 'pending_payment'` or `payment_status='paid'`. |
| `admin_payment_report(p_from date, p_to date)` → jsonb | admins (`timeslot_is_admin()` inside, else raise 42501) | one row per `option_key` for attempts started in [from, to] SAST: `{ option_key, name, started, paid, share (paid/started, 0 when started=0), total_paid (sum amount_gross of paid), total_fees (sum amount_fee of paid) }` + a `totals` row. Names resolved from `site_settings.payments.options` (unknown keys show the key). |
| `admin_payment_flagged()` → jsonb | admins | orders with `payment_flag is not null` (unresolved first): `{ order_id, order_number, m_payment_id, customer_name, customer_email, total, paid_at, flag, resolved_at, first: {pf_payment_id, amount_gross, amount_fee, option_key}, extra: {attempt_id, pf_payment_id, amount_gross, amount_fee, option_key, started_at} }`. |
| `admin_payment_resolve_flag(p_order_id uuid, p_note text)` → void | admins | `payment_flag_resolved_at = now()`, attempt `status='refunded'`, `note`. |
| `admin_paid_orders(p_from date, p_to date, p_limit int)` → jsonb | admins | paid orders in range: `{ order_id, order_number, paid_at, customer_name, total, option_key, payment_method_code, pf_payment_id, amount_gross, amount_fee, amount_net, flag }` (fee/net/gross from `pf_response`). |
| `admin_payment_attempts(p_order_id uuid)` → jsonb | admins | all attempts of one order (for the flagged detail and the paid-orders row expand). |

---

## 4. Server changes, function by function

### 4.1 NEW `netlify/functions/begin-payment.js` (Workstream A) — the only entry point when the picker is on
**Request** `POST`, headers `Content-Type: application/json`, optional `Authorization: Bearer <session>` (guests send none — exactly like today's signer).
```jsonc
{
  "m_payment_id": "UMZILA-1794489618825-ktj4i8kup",
  "option_key": "capitec",                 // never a PayFast code
  "payment_method_id": null,               // uuid of a saved card when option_key='card' and the buyer chose one
  "device": "android",                     // display only
  "payload": { /* exactly today's submitToPayFast payload: m_payment_id, amount, item_name, item_description,
                 return_url, cancel_url, notify_url, name_first, name_last, email_address, cell_number,
                 subscription_type (2 when "Save this card") */ }
}
```
**Steps (in order):**
1. Parse; `m_payment_id` must match `/^UMZILA-\d{10,}-[a-z0-9]{6,}$/i`; `option_key` must match `^[a-z_]{2,30}$` → else `400 {code:'BAD_REQUEST'}`.
2. Service-role client. Read `site_settings.payments`. If `!enabled` → `409 {code:'PICKER_OFF', message:'Please refresh the page.'}` (the browser then falls back to today's path on reload).
3. Find the option by key; must exist and be `active` → else `409 {code:'OPTION_UNAVAILABLE', message:'That way to pay is not available right now. Choose another.'}` (P5; also when `code` is not in the known PayFast code list — belt and braces).
4. Load the order by `m_payment_id` (`id, user_id, order_status, payment_status, total, customer_email, slot_id`). Not found → 404. `payment_status='paid'` → `200 {kind:'already_paid'}` (browser goes to success). `order_status <> 'pending_payment'` → `409 {code:'ORDER_CLOSED', message:'This order can no longer be paid. Please refresh checkout.'}`.
5. Identity: if a Bearer token is present, `auth.getUser(token)`; the order's `user_id` must equal the user (or be null for a guest order) → else 403. A guest (no token) may only pay an order with `user_id null` (the signer's guest path re-checks this and the amount — unchanged).
6. **P18:** `rpc('payment_order_recheck', {p_order_id})`; on `ok:false` with a slot reason → `409 {code:'TIMESLOT_CLOSED', details:{…}}` (same shape the browser already handles after the insert error).
7. **Double tap:** if a `payment_attempts` row for this order has `status='started'` and `started_at > now() - 8 s` → `409 {code:'ATTEMPT_IN_FLIGHT'}` (browser ignores silently).
8. Insert the attempt: `{ order_id, m_payment_id, user_id, option_key, payment_method_code: option.code, kind: (option_key==='card' && payment_method_id) ? 'saved_card' : 'redirect', payment_method_id, amount: Number(payload.amount) (saved card: order.total), device }`. Update `orders set payment_option_key, payment_method_code` (service role; the guard trigger lets it through).
9. **Saved card** (`kind='saved_card'`): `require('./charge-payfast-token').handler({ httpMethod:'POST', headers:event.headers, body: JSON.stringify({ m_payment_id, payment_method_id }) })`. On 200 success → attempt `status='paid', ended_at, pf_payment_id (from the response if any)`; `orders.payment_method_code='token'`; return `200 {kind:'charged', attempt_id}`. On failure → attempt `status='failed', note = error`; pass the function's status + `{code:'CHARGE_FAILED', message: <its error>}` through. **`charge-payfast-token.js` itself is not edited.**
10. **Redirect:** build `signerEvent = { httpMethod:'POST', headers: event.headers (Authorization passes through for the user/guest check), body: JSON.stringify({ payload, returnForm:false }), trustedPaymentMethod: option.code || null, trustedAttemptId: attempt.id }` and call `require('./generate-payfast-signature').handler(signerEvent)`. Non-200 → attempt `status='failed'`, return the signer's status with `{code:'SIGN_FAILED', message:'We could not reach PayFast. Check your connection and try again.'}` (the browser shows the brief's message). 200 → return `200 { kind:'redirect', attempt_id, actionUrl, params }` (params already include `payment_method` + `custom_str3` + `signature`).
11. Never log the passphrase/merchant key; log `attempt_id, option_key, kind` only.

### 4.2 `generate-payfast-signature.js` — additive (Workstream A)
- In `data`: add `payment_method: event.trustedPaymentMethod || ''` — **the client's `payload.payment_method` is ignored on purpose** (brief: "the server decides"; today's direct callers never sent it, so their signatures are byte-identical). Add `custom_str3: event.trustedAttemptId || payload.custom_str3 || payload.customStr3 || ''` (today's `custom_str3` client fallback kept).
- In `orderedKeys`: insert `'payment_method'` **immediately after `'confirmation_address'` and before `'subscription_type'`**. PayFast's custom-integration docs list the sections in this order: Merchant details → Customer details → Transaction details → Transaction options (`email_confirmation`, `confirmation_address`) → **Set payment method (`payment_method`)** → Recurring billing (`subscription_type`, …), and the signature string must follow the documented order with empty fields left out. (The docs site is JS-rendered and could not be fetched programmatically today; the worker **must** confirm on the sandbox by loading the PayFast page with `payment_method` set — a wrong position produces PayFast's "signature mismatch" page immediately and costs nothing.) Empty = omitted from both string and form (existing loop already does this), so "More ways to pay" leaves the field out completely (P6).
- No other change. Unit test: with `trustedPaymentMethod` unset, the signature for a fixed payload equals the pre-change value (snapshot in the test).

### 4.3 Pending-order reuse (P10/P11) — browser rule + server check
The browser (Workstream B) keeps `sessionStorage umz_pending_order = { m, orderId, fingerprint, slot_id, run_date, option_key, attempt_id }` after each insert. `fingerprint = hash(validatedCart ids/qty/size/picks, total, coupon, email, phone, address, slot_id+run_date, tip, priority, saveCard)`. On Pay: if the stored fingerprint equals the current one → **skip the insert and reuse `m`** (same order, new attempt — P11); else insert a new order as today (the old `pending_payment` row stays, as today — Logistics → Baskets lists it). `begin-payment` step 6 re-runs the run check for reused orders (P18) — a reused order never bypasses the timeslot rule. The entry is cleared on success (`checkout-success.html`) and when the fingerprint changes.

### 4.4 `payfast-itn.js` + `lib/complete-order-payment.js` — additive (Workstream A)
In `payfast-itn.js`, after the signature check and before `completeOrderPayment`, **only when `site_settings.payments.enabled`** (one small read; off = byte-for-byte today's behaviour):
- **Server confirmation** (`itn_validate`): `POST https://<pfHost>/eng/query/validate` with the raw body; response body `VALID` → continue; explicit `INVALID` → log `ITN: PayFast says INVALID`, mark the attempt (`custom_str3`) `failed` with note, **return 200 without completing**; network error/timeout (4 s) → log and continue (the passphrase signature already passed; never drop a real payment because PayFast's validate endpoint hiccupped).
- **Valid-host check: deliberately not added.** Netlify's client-IP header and PayFast's IP ranges are both moving targets; the passphrase-signed body + server confirmation cover forgery. Written down here so nobody "fixes" it later without reading this.
- Then call `completeOrderPayment` exactly as today.

In `completeOrderPayment` (shared by ITN, saved card, R0), additive blocks:
1. **Paid twice (P13):** before the `update`, if `existingOrder.payment_status === 'paid'` **and** `pfPaymentId` **and** `existingOrder.pf_payment_id` **and** they differ → do **not** overwrite the order; insert/upsert a `payment_attempts` row (`id = pfData.custom_str3` if it matches an attempt of this order, else a new row with `option_key:'legacy'`) with `status='paid_twice', pf_payment_id, amount_gross, amount_fee (abs), amount_net, pf_response`; `orders set payment_flag='paid_twice', payment_flag_attempt_id` (only if `payment_flag is null`); log; **return**. A repeat of the *same* ITN (same `pf_payment_id`) falls through to today's path (`alreadyPaid` → update is idempotent, tasks skipped) — unchanged.
2. **Attempt confirmation (P9/P14):** after the successful update, if `pfData.custom_str3` is a uuid → `update payment_attempts set status='paid', ended_at=now(), pf_payment_id, amount_gross, amount_fee=abs(), amount_net where id=custom_str3 and m_payment_id=mPaymentId and status <> 'paid'`; then `orders set payment_option_key = attempt.option_key, payment_method_code = attempt.payment_method_code` (confirms what begin-payment wrote). For the saved-card path (no `custom_str3`) begin-payment marks the attempt itself (§4.1 step 9). For R0 (`pfData.zero_total`) nothing to do except `payment_method_code='zero'` when the picker is on.
3. **Amount check (brief: compare before confirming):** if `pfData.amount_gross` is present and `|amount_gross − existingOrder.total| > 0.01` → **flag** (`payment_flag='amount_mismatch'`, `payment_flag_attempt_id` = the attempt) **and still complete** the order (the money was taken; the live data already shows legitimate mismatches because `orders.total` can be edited). Only when `payment_flag is null`.
All three are wrapped in try/catch and run only when the relevant data is present, so the picker-off path and the saved-card/R0 callers behave exactly as today.

### 4.5 No-answer sweep (Workstream A) — reuse the once-a-minute job
In `lib/timeslots.js runTick()`, **before** the timeslots-enabled read (next to `releasePendingDeliveries`, which already runs with timeslots off): `expirePaymentAttempts(supabase)` = `update payment_attempts set status='no_answer', ended_at=now() where status='started' and started_at < now() - make_interval(mins => <payments.no_answer_minutes or 30>)`. Idempotent, one statement. A late COMPLETE ITN still confirms the order and flips the attempt to `paid` (§4.4 step 2 does not check the previous status). `timeslot-tick.js` and `netlify.toml` are untouched.

### 4.6 `order-status.js` — additive (Workstream A)
Add to the response for paid orders: `paidWith: { option_key, name (from settings; 'Saved card' for 'token', null if unknown), amount_gross }`. Used by `checkout-success.html` ("Paid R210 with Capitec Pay").

### 4.7 `checkout-cancel.html` (Workstream D)
Kept only for payments started before this deploy. New body: read `m_payment_id`/`attempt` from the URL and `location.replace('/checkout.html?pf=cancel&m_payment_id=…&attempt=…')`; the old message stays as a `<noscript>` fallback. With the picker on, `cancel_url` points at `checkout.html` directly (§6.8).

### 4.8 Error codes / messages (the brief's Messages table + ours)
| code (JSON `code`) | HTTP | customer sees (browser copy) |
|---|---|---|
| `OPTION_UNAVAILABLE` | 409 | "That way to pay is not available right now. Choose another." (browser also reloads the options list) |
| `SIGN_FAILED`, network error, non-JSON | 5xx/— | "We could not reach PayFast. Check your connection and try again." |
| `TIMESLOT_CLOSED` | 409 | same wording as today's insert refusal ("Orders for dispatch by 12:00 closed at 11:45. The next delivery time is …") — reuse the existing handler |
| `CHARGE_FAILED` | passthrough | charge-payfast-token's own message ("PayFast declined the charge. Please pay another way.") |
| `ATTEMPT_IN_FLIGHT` | 409 | nothing (second tap ignored) |
| `PICKER_OFF` / `ORDER_CLOSED` | 409 | "Please refresh checkout." |
| `?pf=cancel` return | — | "Payment not completed. Try again or choose another way to pay." |
| Pay with nothing selected | — | bar: "Choose how you want to pay"; the options card gets the red outline |

---

## 5. Signature position, references and detection — summary table
| Concern | Decision |
|---|---|
| `payment_method` position in the signed string | after `confirmation_address`, before `subscription_type` (§4.2); empty → omitted entirely |
| Attempt reference to PayFast (P9) | `custom_str3 = payment_attempts.id` (uuid). `m_payment_id` stays the order's reference → today's ITN matching untouched. `custom_str1/2` remain reserved for seller enrolment / ad campaigns (unchanged). |
| Paid twice (P13) | `completeOrderPayment`: already paid + different `pf_payment_id` → flag, keep the first payment's data, extra payment stored on a `paid_twice` attempt row |
| Same ITN twice | unchanged: `alreadyPaid` guard; the update is idempotent |
| No answer | `runTick` sweep, 30 min (admin setting `no_answer_minutes`) |
| Fee capture (P14) | `amount_fee`/`amount_net`/`amount_gross` from the ITN onto the attempt; the order already keeps them in `pf_response` |
| Server confirmation | `/eng/query/validate`, picker-on only, explicit INVALID stops completion |
| Amount compare | flag `amount_mismatch`, never refuse |

---

## 6. Checkout page plan (`checkout.html`, Workstream B)

### 6.1 Every existing behaviour and where it lives after the revamp
| Behaviour (must keep) | Existing code reused | New home |
|---|---|---|
| Cart loading (ss_cart / buynow / carts row / `?store=` scope, `cartRest`, persist rules) | `loadCart, scopeCart, persistLocalCart, saveCartToServer, syncCartOnLogin, refreshCartItemsFromProducts` | unchanged |
| Guest checkout; sign-in at checkout (quick sign-in card, known-email password panel, email-not-confirmed → `UmzilaAuthMail`) | `checkEmailDebounced, setAccountCardState, handleAccountPasswordSubmit, expandInlineSignin, signInOrCreateAccount` | Step 1 card (`#step1Page` content moves inside `#stepDetails`) |
| Contact chip for signed-in buyers ("Change") | `renderContactCard, hasCompleteContact, loadProfileData` | Step 1 collapsed state |
| Multi-use code → inline sign-in panel | `renderPromoSignin, submitPromoSignin` | under the code box in Step 4 |
| Promo box always visible under Payment | `#promoCodePanel` open, `applyPromoCode`, `openPromoCodePanel` | Step 4, below the options, always open ("Have a code?") |
| Specials struck out; "Special price" row | `lineSaving, #saleRow` | summary lines + new "You save R54" line (= sale saving + discount) |
| House add-ons / drinks (never counted as a store) | `HOUSE_IDS, ensureHouseIds, cartExtras` | unchanged |
| Priority toggle "Delivered first on your run" | `#priorityCard, priorityToggle handler, fetchDeliveryQuote` | Step 2, under the address, once priced |
| Service-zone blocking + "Notify me when you deliver here" | `ensureDestination, ensureFreshQuote, renderQuoteNotice, requestDeliveryArea, state.deliveryBlock` | Step 2 notice (`#quoteNoticeBlock`) |
| Closed-store rules (goods only; skipped for slot orders) | `confirmClosedStores, waitsForOpenStore, ss_closed_order_note` | unchanged, invoked from `preparePendingOrderOnce` |
| Services / bookings / vouchers / digital (banner, intake edits, blockers gate) | `updateServiceBanner, openIntakeEditPanel, getCheckoutBlockers, renderCheckoutBlockers, loadRepSlotPickerCheckout` | Step 2 (banner + blockers); service-only cart hides the address form and Step 3 |
| R0 orders | `completeZeroTotalOrder` → `complete-zero-total-order.js` | Pay button "Complete order", no picker (P17) |
| Timeslot picker + `TIMESLOT_CLOSED` retry (select next, stop, Pay again) | `TS, tsRefresh, tsRenderPicker, tsReselect, tsPayLabel, tsPhrase`, insert-error handler | Step 3; the error handler is extracted into `handleTimeslotRefusal(details, refusedRun)` and reused for begin-payment's 409 |
| Terms agreement on Pay | `agreeAndRun, promptForTerms, applyTermsConsentUI` | bar / summary Pay button |
| Mystery gift free code | `applyStoredFreeGiftCode` | unchanged |
| input-guard (email/phone), guest contact memory | `UmzilaInput.ok`, `umzilaGuestContact`, `umz_guest_contact` prefill | Step 1 |
| presence/source tracking | `umzilaPresence.start(…, 'checkout')`, `umzilaSource()` on the order | unchanged |
| Saved address geo | `useSavedAddressLocation*`, `profiles.saved_address_geo` write | unchanged |
| Saved cards + "Save this card" switch + nickname | `loadPaymentMethods, renderPayChoices, syncPayChoice, paymentMethodLabel, defaultCardName, payWithSavedCard` | Step 4 — inside the **Card** option (sub-picker) |
| Tip pills | `#tipSection, clampTip` | small "Add a tip for your rider" row at the bottom of the order summary (kept, not in the mockup) |
| Marketing opt-in | `#marketingOptIn` | under the reassurance lines |
| Address nudge/confirm callout, time-saved block, shop branding banner | existing | Step 2 / header; `#timeSavedBlock` and `#deliveryAnchorNote` **dropped** (mockup has no room; the anchor line moves into the delivery row tooltip) |
| Mobile pay bar | `#mobilePayBar, refreshMobilePayBarVisibility, updateSummaryHeaderMeta` | always visible on mobile (no page-2 gating any more) |

### 6.2 Decisions on the mockup vs reality (flagged for the founder)
- **Guest email stays required** (mockup says optional). It is the only channel for the receipt and the private tracking link, PayFast's `email_address`, guest-order linking (`claim_my_email_orders`), email-locked codes/spin gifts, the guest-card token and the guest basket. Label: "Email — for your receipt and tracking link". Signed-in buyers never type it.
- **First name + surname stay two inputs** in one row (mockup: one "Full name"). `profiles.first_name/last_name`, `hasCompleteContact()`, PayFast `name_first/name_last` and the rider's "ask for …" all use the split; a heuristic split would corrupt data.
- **City / postal code / province stay in the data** but are filled from the HERE suggestion and shown as one grey line under the street ("Glenwood, Durban, 4001 · change") instead of three boxes; province is fixed KwaZulu-Natal (today's zone rule). They open as boxes only when the buyer types an address without picking a suggestion.
- **"Flat, res or block" (optional)** → prefixed into `delivery_address` ("Block C, Westville campus, …") and the profile address; no new column. **"Note for rider"** = the existing `#orderNotes` (writes `notes` + `delivery_instructions` as today); the duplicate `#deliveryInstructions` box is removed from the UI (element kept hidden so references don't break).
- **Reassurance lines** under Pay: "Payments are processed by PayFast. Umzila never sees your card or bank details." (always); "You get a 4-digit code to give the rider, so only you can receive this order." (physical items only — `profiles.delivery_pin` / `confirm-delivery-pin.js` exist); "Cancel for a full refund until 11:45." **only for slot orders**, using the selected run's `cutoff_at` (the wording already exists in the run-changed email). **Founder to confirm** that "full refund until the cut-off" is the policy for every slot order.
- **Delivery step copy:** "Dispatched by 12:00 · Order by 11:45" / "Order in the next 23 min" (existing `tsRenderPicker` strings); the mockup's "arrives hot inside the window" is **not** used.
- **Order-confirmed screen** in the mockup (handover code, steps) is **not** in scope — `checkout-success.html` only gains the "Paid R210 with …" line (Workstream D).
- **Pay never greyed out** (founder): remove the `dataset.tsOff` disabling in `syncPayChoice`; pressing Pay with no open run shows the bar error "No delivery time is open right now — the next one is …" (the server guard stays authoritative). `payBusy` still ignores extra taps while working (brief).

### 6.3 Page structure (both breakpoints; mobile = one column + sticky bar, desktop ≥ 769 px = steps left, order summary right)
```
<header> ‹ back · Umzila logo · 🔒 Secure
#shopBrandingBanner (unchanged, single-store carts)
<section id="orderSummaryCard">  mobile: collapsible header "Velaphi Shisanyama · 3 items · Show items ▾ … R210" (existing #summaryToggle)
                                desktop: right column, always open — items (#orderItems, struck-out was-prices, × remove), totals
<ol class="steps">
  <li id="stepDetails"  data-step>  <span class="step-num">1</span> Your details        [Change]
       collapsed: "Thando Mkhize · 071 234 5678 · thando@…"   open: #quickSigninCard, #customerEmail, #firstName+#lastName, #phoneNumber, #accountPasswordCard, #detailsFormError
  <li id="stepAddress"  data-step>  2 Deliver to
       collapsed (#addressCompactCard): "Home · 12 Ridge Road, Glenwood · 8.4 km · R35"  [Deliver somewhere else]
       open (#addressFormFull): #shippingAddress (HERE autocomplete), #addressUnit (new, optional), city/postal/province line, #orderNotes "Note for rider (optional)",
       zone line "We deliver inside our service areas — type your address to check", #quoteNoticeBlock, #priorityCard, #serviceDropoffBanner, #checkoutBlockersCard, #addrConfirmCallout
  <li id="stepTime"     data-step>  3 Delivery time           (hidden when !tsActive(): service-only carts, switch off → then #estimatedDeliveryTime ETA strip shows inside step 2)
       day chips (Today / Tomorrow) + run rows "Dispatched by 12:00 · Order in the next 23 min" (= tsRenderPicker output restyled), closed-today note
  <li id="stepPay"      data-step>  4 How do you want to pay?
       #payOptions (new): one row per option — radio ring, name, description, "Last used" tag; Card row expands #payChoices (saved cards + "Add a new card") and #newCardBox (save switch + nickname)
       #pickerError ("Choose how you want to pay")
       "Have a code?" → #promoCodePanel (always open) + #promoSignin panel + #promoMessage
       #marketingOptInGroup
</ol>
<div id="payDock">   mobile: fixed bottom bar; desktop: bottom of the order summary card
   savings line "You save R54" (sale savings + discount; hidden at 0)   ·   dispatch line "Today, dispatched by 12:00" (slot orders) / ETA text otherwise
   #barError (specific message)   ·   <button id="payNowBtn">Pay R210 with Capitec Pay</button>
   reassurance lines (6.2)
</div>
```
Existing element **ids are kept** (`#payNowBtn`, `#payWithSavedCardBtn`, `#payNowBtnMobile`, `#payWithSavedCardBtnMobile`, `#paymentError`, `#payChoices`, `#newCardBox`, `#saveCardCheckbox`, `#cardNameInput`, `#promoCodeInput`, `#orderItems`, `#totalAmount`, `#estimatedDeliveryTime`, `#priorityCard`, `#quoteNoticeBlock`, `#checkoutBlockersCard`, `#addressCompactCard`, `#addressFormFull`, `#contactSummary`, `#contactFormFull`, `#step1Page`, `#step2DeliveryPayment`, …) so the 150+ `elements.*` references and handlers keep working; `#step1Page`/`#step2DeliveryPayment` become plain wrappers that are never hidden (`showCheckoutPage()` becomes a no-op that only calls `refreshMobilePayBarVisibility()`, `advanceToStep2/goBackToStep1/guestSkipToStep2IfComplete` collapse into "scroll to the next incomplete step"). `#paymentError` and `#barError` are the same element (rename the id to `barError` and point `elements.paymentError` at it). The desktop and mobile Pay buttons stay as today (`mobilePairOf`) — the dock simply contains them.

### 6.4 Step completion ticks and the error behaviour
`refreshSteps()` (called on every input/change/cart/quote/TS/picker event, debounced 100 ms) computes:
- Step 1 complete = `detailsComplete()` — a **non-focusing** twin of `validateDetailsForm()` (same checks, returns `{ok, missing:[{el, label}]}`); signed-in with `hasCompleteContact()` = complete.
- Step 2 complete = service-only cart, **or** address present + `!state.deliveryBlock` + a fresh quote (`activeQuote()`) and no `getCheckoutBlockers()`.
- Step 3 complete = `!tsActive()` **or** `TS.selRun` (auto-selected earliest → complete immediately).
- Step 4 complete = picker off → saved card chosen or new card (always true); picker on → `state.payOption` set (and for `card` a saved card or "new card" chosen).
Complete → the number becomes a tick (`.step.done .step-num` → ✓, aria-label "Completed"). Collapsed steps show their summary line and a "Change" link.
Pressing Pay with something missing: `preparePendingOrderOnce` already returns early with a message — wrap its early exits so the **first** missing item gets `.is-invalid` (red border + the field's hint turns red, existing `showError` under it), its step opens and scrolls into view, and `#barError` says exactly what to add: "Add your phone number", "Add the street address we should deliver to", "Choose a delivery time", "Choose how you want to pay", "We don't deliver to this address yet — see the note under your address". Nothing is greyed out.

### 6.5 Returning customer = one tap
Already true for contact (`loadProfileData`), address (`addressCompactCard` + saved geo → quote on load), time (`tsReselect` earliest open). Add: payment preselection — picker on: `my_last_payment_option()` (signed in) else `localStorage umz_pay_option` (guest), applied only if that option is still active and allowed on this device (brief: switched-off last option → nothing selected); `card` preselects the most recent saved card (today's rule). Picker off: today's behaviour (most recent saved card). Nothing else is auto-selected; a first-time customer has **nothing** selected (P2).

### 6.6 The picker (`renderPayOptions()`)
- Source: `supabaseClient.from('site_settings').select('value').eq('key','payments').maybeSingle()` on load (anon-readable; one small query, no new function; a cold admin change applies on the next page load). `state.payCfg = value`. If the read fails or `enabled` is false → **picker off path** (today's panel, P15 handled below).
- Visible options = `options.filter(o => o.active && deviceAllows(o.device)).sort(position)`. `deviceClass()`: `'apple'` when `window.ApplePaySession && ApplePaySession.canMakePayments()`; `'samsung'` when `/SamsungBrowser/i.test(UA)`; `'android'` when `/Android/i.test(UA)`; else `'desktop'`. `deviceAllows(rule)`: `null` → true; `'apple'` → apple; `'android'` → android or samsung; `'samsung'` → samsung only.
- Rows: `<button role="radio" class="pay-opt" data-key>` with ring, `<strong>name</strong><small>description</small>`, "Last used" tag on the remembered one; whole row tappable; arrow keys move selection (roving tabindex). Text only, generic inline SVG icons (card/bank/phone) — no brand logos unless official files are added later.
- **Card row selected** → reveals the existing `#payChoices` (saved cards + "Add a new card") and `#newCardBox` (save switch + nickname) *inside* the row; a saved card selected ⇒ `state.payWithNewCard=false`, `state.selectedPaymentMethodId`; "Add a new card" ⇒ `payWithNewCard=true`. Guests/no cards → only the new-card box.
- **P15/P16:** settings unreadable, or `enabled` but zero active visible options with a code → render one option "Pay on PayFast" (key `more`, code null) preselected; the Pay button reads "Pay R210 on PayFast". If `enabled` is false → today's panel exactly (`renderPayChoices()`), no options list, today's `submitToPayFast` path.
- **P17:** `total <= 0` → hide `#payOptions`, Pay reads "Complete order" → `completeZeroTotalOrder` (unchanged).
- Pay label (`syncPayChoice`, extended): `Pay R210 with Capitec Pay` / `with card` / `with FNB debit` (saved card nickname) / `on PayFast` (more) / `Pay R210` when nothing is selected; the dispatch phrase moves out of the label into the dock line above it (`tsPayLabel()` is split into `tsDispatchLine()` + amount). Picker off keeps today's labels.

### 6.7 Pay flow with the picker on (`processPayment` / `payWithSavedCard` merge into `pay()`)
```
pay():
  payBusy guard → agreeAndRun (terms) → handleAccountPasswordSubmit() (sign-in branch, unchanged)
  picker on && !state.payOption → bar "Choose how you want to pay", outline #payOptions, return
  prepared = preparePendingOrder()   // validation, closed-store confirm, zone, validate-cart, blockers, R0 — unchanged
       └ inside: fingerprint check (4.3) → reuse umz_pending_order.m or insert (today's insert code + TIMESLOT handler)
  prepared.total <= 0 → completeZeroTotalOrder (unchanged)
  picker off → today's branches exactly (submitToPayFast / charge-payfast-token)
  picker on  → POST begin-payment { m_payment_id, option_key, payment_method_id (card+saved), device, payload: buildPayFastPayload(prepared) }
       200 kind:'redirect' → store umz_pending_order.attempt_id; build+submit the hidden form from params (today's form code, factored out of submitToPayFast as postPayFastForm(actionUrl, params)); remember umz_pay_option (guest) — NOTE: the "remember after a successful payment" rule is met by my_last_payment_option() for accounts; for guests the browser remembers at redirect time and checkout-success keeps it only if the order turns paid (clears it otherwise).
       200 kind:'charged'  → success animation (existing) → checkout-success.html?m_payment_id=…
       200 kind:'already_paid' → checkout-success.html
       409 OPTION_UNAVAILABLE → re-read settings, renderPayOptions(), clear selection, bar message (4.8)
       409 TIMESLOT_CLOSED → handleTimeslotRefusal(details) (select next run, stop; Pay again)
       409 ATTEMPT_IN_FLIGHT → ignore
       other → bar "We could not reach PayFast. Check your connection and try again."; attempt stays 'started' until the sweep marks no_answer (server) — acceptable
```
`buildPayFastPayload(prepared)` = today's `submitToPayFast` payload builder (same fields, `subscription_type: 2` when "Save this card" is on and the option is `card`/new card; **never** for Capitec/EFT/wallets — a token only makes sense for a card). `cancel_url` when the picker is on: `${CONFIG.siteUrl}/checkout.html?pf=cancel&m_payment_id=<m>&attempt=<id>` — the attempt id is not known before `begin-payment` runs, so send `cancel_url` without it and let **begin-payment append `&attempt=<id>`** to `payload.cancel_url` before signing (server-side, trusted). `return_url` unchanged. `?store=<id>` carts: append `&store=<id>` to `cancel_url` so the scoped checkout is restored.

### 6.8 Cancel return (P10) and state restore
On load with `?pf=cancel`: (1) `rpc('payment_attempt_cancelled', {p_attempt, p_m_payment_id})` best-effort; (2) show the bar message "Payment not completed. Try again or choose another way to pay." and open Step 4; (3) restore from `sessionStorage umz_pending_order` (same tab) — `option_key` → preselect, `slot_id/run_date` → `TS.sel` if still open (else the usual earliest + the closed message), and keep the fingerprint so the next Pay reuses the same order (P11). Contact/address/cart come back as today (profile, `umz_guest_contact`, `ss_cart`). Strip `pf`/`attempt` from the URL with `history.replaceState`. If sessionStorage is empty (new tab), everything still works — a new order is created on Pay.

### 6.9 Savings visible
`updateShippingAndTotal`: add `#saveLine` in the dock and summary = `saleSavings + discount` ("You save R54"), hidden when 0; keep `#saleRow`, `#discountRow`, `#totalBefore` struck total; items keep `<s class="was-amount">`.

### 6.10 Mobile dock / desktop summary
Mobile (≤ 768 px): `#payDock` fixed bottom, `env(safe-area-inset-bottom)`, contains total (`#mobilePayBarTotal`), savings, dispatch line, Pay button, reassurance (two lines collapse into one small line), `#barError`. Body padding-bottom ≈ 196 px as in the mockup. Desktop: the dock sits at the bottom of `#orderSummaryCard` (sticky `top: 24px` column). Totals/labels are written by `updateShippingAndTotal → updateSummaryHeaderMeta` as today.

---

## 7. Admin plan (`admin.html` + new `payments-admin.js`, Workstream C)

Sidebar item **"Payments"** (`data-section="payments"`, icon 💳) after "Delivery Pricing"; `<section id="section-payments">` with `#paymentsMount`; `document.querySelector('[data-section="payments"]').addEventListener('click', () => window.loadPaymentsAdmin?.())`; `<script src="/payments-admin.js">` next to `timeslots-admin.js`. Follow `timeslots-admin.js` exactly (IIFE, `supabaseClient` global, `esc`, `showToast`, phone-first CSS, bottom-sheet modals ≤ 640 px, `friendly()` error mapping). Three tabs inside the section:

1. **Payment options** — master switch "Payment picker on" (confirm dialog: "Off = checkout exactly as before. On = customers choose how to pay on Umzila and land on that method on PayFast. Only switch on methods that are enabled on the PayFast account and tested live."), `no_answer_minutes` (10–120), `itn_validate` switch; the option list ordered by position: drag handles or ▲/▼ buttons, on/off switch per row, Edit (name ≤ 40, description ≤ 90, device rule select: Everyone / Apple devices / Android / Samsung Internet), "Add option" (select a PayFast code from the documented list with its label, or "none — catch-all"; key auto-derived; validation: unique key, one catch-all only, code from the list). Saves = `site_settings.upsert({key:'payments', value, updated_at, updated_by})` (admin RLS, same as `timeslots`). Live preview line: "Customers will see: Card · Capitec Pay · Instant EFT · More ways to pay (Apple Pay on iPhones, Google Pay on Android)". The founder's PayFast fee table (ex VAT) shown as static help text per code.
2. **Flagged orders** — `admin_payment_flagged()`: card per order (order number, customer, total, paid at, flag label "Paid twice" / "Amount differs"), both payments side by side (pf_payment_id, gross, fee, option, time), "Refund in PayFast" instructions (PayFast dashboard → Transactions → pf_payment_id → Refund; R2 ex VAT), **"Mark resolved"** (note prompt) → `admin_payment_resolve_flag`. Resolved ones collapse under "Resolved".
3. **Report** — date range (default this month; quick picks 7 days / 30 days / this month), `admin_payment_report()`: table option · started · paid · share % · total paid · total fees · fee %; footer totals; "Paid orders" list under it (`admin_paid_orders`, newest first, 100): order no · when · customer · total · **paid with** · PayFast fee · net · flag; row expand → `admin_payment_attempts(order)` (every attempt with status/time). CSV download of both tables (client-side).

Dashboard: `section-dashboard` gets a one-line badge "Payments: N flagged" linking to the tab when `admin_payment_flagged()` has unresolved rows (cheap count on dashboard load).

---

## 8. Workstreams, file ownership, tests

| | A — Database + server | B — checkout.html revamp + picker | C — Admin | D — success/cancel pages + docs + QA harness |
|---|---|---|---|---|
| **Owns** | `docs/plans/sql/6_payment_picker_schema.sql` (+ apply), `netlify/functions/begin-payment.js` (new), `generate-payfast-signature.js`, `payfast-itn.js`, `lib/complete-order-payment.js`, `lib/timeslots.js` (sweep only), `order-status.js`, `netlify/functions/__tests__/payment-picker.test.js` (new) | `checkout.html` only | `admin.html` (sidebar li, section, listener, script tag), `payments-admin.js` (new) | `checkout-success.html`, `checkout-cancel.html`, `docs/CHANGELOG.md` entry, `docs/systems/payment-picker.md` (new), `CLAUDE.md` section "💳 PAYMENT PICKER", `docs/qa-payment-picker.e2e.js` (manual QA script/checklist) |
| **Must not touch** | checkout/admin/success pages | any server file, SQL | checkout, server, SQL | checkout.html, server, SQL, admin |
| **Depends on** | — (contracts in §9 are fixed; code against them) | §9 contracts (mock `begin-payment` responses locally until A lands) | §3.4 RPC names/shapes (write against the shapes; A applies the SQL) | §4.6 `order-status` shape |

### Tests per workstream (no live payments)
**A.** `node --test netlify/functions/__tests__/payment-picker.test.js`: (1) signer snapshot — fixed payload, no trusted fields ⇒ signature identical to a value captured from the current code before editing; with `trustedPaymentMethod:'cp'` ⇒ string-to-sign contains `…&confirmation_address=…&payment_method=cp&subscription_type=2…` in that order and omits it when null; client `payload.payment_method` is ignored. (2) ITN handler with bodies signed by a test passphrase (set env in the test): COMPLETE first time → `completeOrderPayment` called (mock supabase client recording calls); same body again → no post-payment tasks; COMPLETE with a different `pf_payment_id` for a paid order → flag path, no overwrite; `custom_str3` → attempt update; `amount_gross` ≠ total → `amount_mismatch` flag + completion; `/eng/query/validate` mocked `INVALID` → no completion, `VALID`/network error → completion. (3) begin-payment: option off → 409 `OPTION_UNAVAILABLE`; unknown key → 409; made-up code can't be injected (body has no code field); picker off → 409 `PICKER_OFF`; saved-card path calls the charge handler mock and marks the attempt; redirect path returns params with `payment_method` + `custom_str3`; cancel_url gets `&attempt=`. (4) SQL, in `DO` blocks that `raise` at the end so nothing persists: `payment_order_recheck` with `set_config('umzila.now', …)` at 11:44 (ok) / 11:45 (closed, next_open); `payment_attempt_cancelled` flips only `started`; `my_last_payment_option` as a user with paid attempts; sweep statement marks only `started` older than N minutes; `admin_payment_report` shares; RLS: anon cannot select/insert `payment_attempts`, non-admin cannot call admin RPCs (42501). `node --check` every changed function; `require()` each loads.
**B.** `node --check` of the inline script (extract with the existing approach in CHANGELOG), then on a deploy preview with `PAYFAST_SANDBOX=true`: picker off = today's behaviour (every row of §6.1 exercised by hand, including guest, sign-in at checkout, multi-use code panel, `?store=`, Buy Now, service-only cart, R0 voucher cart, closed store, outside-zone address + notify-me, priority toggle, TIMESLOT_CLOSED at a cut-off); picker on with sandbox options (`more` + `cc`; the sandbox's single wallet method may refuse `cp`/`ef` — then test those only for the redirect page loading without a signature error): nothing selected → message, no redirect; cancel on PayFast → back on checkout with cart/time/details and the message, same order reused (check `orders` count) and two attempts; two quick taps → one attempt; option switched off in admin → refused + list reloads; sandbox COMPLETE → success page shows "Paid … with …"; iPhone Safari shows Apple Pay row, Android Chrome shows Google Pay, desktop shows neither; keyboard-only run through all four steps; 390 px and 1280 px layouts; Lighthouse accessibility ≥ 90.
**C.** Manual on the preview: reorder, switch off, edit, add `dc`, master switch confirm, validation messages; flagged list with a hand-made flagged order (A's SQL test data on a branch); report numbers against a hand count; non-admin gets 42501 friendly message; phone width.
**D.** Success page with a paid sandbox order shows the paid-with line, clears `umz_pending_order`, keeps `umz_pay_option` only when paid; `checkout-cancel.html?m_payment_id=…&attempt=…` redirects to `checkout.html?pf=cancel&…`; docs complete (CHANGELOG entry says where in admin it lives; systems doc covers the flow, the inert-off guarantee, gotchas, and the founder checklist in §11).

---

## 9. Interface contracts (fixed — build against these)

1. **`site_settings.payments`** shape: §3.1 (A seeds it with `enabled:false`; B reads it anon; C writes it).
2. **`POST /.netlify/functions/begin-payment`**: request/response/codes exactly as §4.1 and §4.8. Response bodies always JSON with either `{kind, attempt_id, actionUrl?, params?}` or `{code, message, details?}`.
3. **Cancel return URL**: `/checkout.html?pf=cancel&m_payment_id=<m>&attempt=<uuid>[&store=<seller id>]` (A appends `attempt`; B reads; D's `checkout-cancel.html` redirects to it).
4. **RPCs**: `my_last_payment_option()`, `payment_attempt_cancelled(p_attempt uuid, p_m_payment_id text)` (B); `admin_payment_report(p_from date, p_to date)`, `admin_payment_flagged()`, `admin_payment_resolve_flag(p_order_id uuid, p_note text)`, `admin_paid_orders(p_from date, p_to date, p_limit int)`, `admin_payment_attempts(p_order_id uuid)` (C) — shapes in §3.4.
5. **`order-status.js`** adds `paidWith: { option_key, name, amount_gross } | null` (D).
6. **Browser storage keys**: `sessionStorage umz_pending_order` (B, cleared by D on success), `localStorage umz_pay_option` (B writes at redirect; D clears if the order is not paid, keeps if paid).
7. **PayFast fields**: `payment_method` only via `event.trustedPaymentMethod`; `custom_str3` = attempt uuid via `event.trustedAttemptId`; position after `confirmation_address` (A).
8. **Device classes**: `'apple' | 'android' | 'samsung' | 'desktop' | 'other'` (B sends; A stores; C shows the device rule labels).

---

## 10. Risks
- **Signature position of `payment_method`** could not be verified against the live docs page today (JS-rendered). Mitigation: the sandbox shows "signature mismatch" immediately if wrong, before any money; A's first manual check.
- **Sandbox cannot show real methods** (brief): `cp`/`ef`/`ap`/`gp` only prove the signature + redirect; the per-method behaviour needs the live tests in §11.
- **`cc` vs `dc`** for debit cards (brief question): live test; add a `dc` option in admin if needed (no code change).
- **Apple Pay / Google Pay via PayFast redirect** depend on the device *and* on PayFast having the method enabled; device detection only hides the row where it cannot work. Keep them off until each is tested live on a real phone.
- **Reused pending order** (P11) relies on the browser fingerprint; a stale fingerprint with a changed price would be caught by the signer's guest re-pricing and by validate-cart at insert for new orders, but a signed-in buyer's reused order uses `orders.total` from the first insert — the fingerprint includes the total, so a price change forces a new order. Acceptable.
- **Netlify env for previews**: if the deploy-preview context inherits live PayFast keys, QA would hit the live account. Founder task below.
- **`checkout.html` size**: a 6,500-line single file re-layout is the riskiest piece; B must diff-check that every function in §6.1 still has a caller and run the full manual matrix with the picker off before anything else.

## 11. Founder to-do list
1. PayFast dashboard → enable Capitec Pay, card, Instant EFT, Apple Pay, Google Pay (Samsung Pay optional); confirm which are live before switching any option on in Admin → Payments.
2. Netlify → Environment variables: set **deploy-preview context** `PAYFAST_SANDBOX=true`, `PAYFAST_MERCHANT_ID/KEY/PASSPHRASE` = sandbox values, so previews never touch live money. Confirm `SITE_BASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY` on production.
3. Decide the two flagged copy/scope items in §6.2: guest email required (recommended yes); "Cancel for a full refund until <cut-off>" shown on slot orders.
4. After merge (picker off): watch two days of live orders through the new checkout.
5. Live test per method (switch each option on for one test, R5–R10 order, then refund in PayFast, R2 ex VAT each): Card new (saved → check `payment_methods`), Card saved (one-tap), debit card through Card, Capitec Pay, Instant EFT, Apple Pay (iPhone), Google Pay (Android), More ways to pay. Check Admin → Payments → Report shows each attempt paid with its fee.
6. Flip "Payment picker on" at a quiet time; after a week read the report and reorder options if the numbers say so.
