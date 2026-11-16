# Payment picker: contract changes and clarifications (Workstream A, 2026-11-15)

Nothing in §9 of the plan was broken. Below are the additions and clarifications that workers B, C and D and the reviewer should know about.

## Changes that affect other workstreams
1. **`admin_payment_report(p_from, p_to)` returns an object** (C): `{ from, to, rows: [ {option_key, name, started, paid, share, total_paid, total_fees} ], totals: { option_key:'totals', name:'Total', started, paid, share, total_paid, total_fees } }`.
   - `share` is 0 to 1 with 4 decimals.
   - `started` leaves out the extra-payment rows (`paid_twice` / `refunded`).
   - `total_paid` = the sum of `amount_gross`, falling back to the attempt `amount` for saved cards, where the ITN has no gross.
   - The rows follow the admin option position.
   - payments-admin.js already accepts this shape.
2. **Validation trigger on `site_settings` key `payments`** (C). An invalid save fails with `message = 'PAYMENTS_INVALID'`, SQLSTATE `22023`, and a readable reason in `details`. Checks:
   - `enabled` and `itn_validate` must be booleans.
   - `no_answer_minutes` must be a number from 10 to 120.
   - `options` must be an array. Each key must match `^[a-z_]{2,30}$` and be unique.
   - `name` is required, at most 60 characters. `description` is at most 140.
   - `code` must be in the PayFast list or null, and at most one option may have a null code.
   - `device` must be null, apple, android or samsung. `active` must be a boolean.
   - C's own stricter limits (40/90) still apply in the browser.
3. **Admin RPC errors** (C): a caller who is not an admin gets `message 'ADMIN_ONLY'`, SQLSTATE `42501`. `admin_payment_resolve_flag` on an order that is not flagged raises `NOT_FLAGGED` (`P0002`). For an `amount_mismatch` flag, resolving only stamps `payment_flag_resolved_at` and saves the note. The attempt is **not** marked refunded, because it is the real payment.
4. **Extra fields** (C):
   - `admin_payment_flagged().extra` also has `status` and `note`.
   - `admin_payment_attempts()` rows have `id, option_key, name, payment_method_code, kind, status, amount, started_at, ended_at, pf_payment_id, amount_gross, amount_fee, amount_net, device, note`.
   - `admin_paid_orders` returns an array, newest first, capped at 500.
   - `option_key 'legacy'` = an extra payment with no attempt reference. Its name shows as "Before the picker".
5. **begin-payment extra error codes** (B): `400 BAD_REQUEST`, `401 AUTH` (session expired), `403 FORBIDDEN` (the order belongs to another account, or a saved card without sign-in), `404 NOT_FOUND`, `500 SERVER_CONFIG`.
   - Treat any code not listed in §4.8 as "We could not reach PayFast…" or "Please refresh checkout."
   - For `TIMESLOT_CLOSED`, `details` = `{ reason, closed_at, window_start, window_end, next_open:{slot_id, run_date, window_start, window_end, cutoff_at}|null }`. This is the same shape as the insert trigger's DETAIL.
   - Sending `payment_method_id` with any option other than `card` returns 400.
6. **Server-side token rule** (B): begin-payment removes `subscription_type`, `billing_date`, `recurring_amount`, `frequency` and `cycles` for every option whose code is not `cc` or `dc`. B should still not send them; this is belt and braces.
7. **Guest orders** are always signed through the signer's guest path, with server re-pricing and the email check, even when the browser sends a Bearer token. If a signed-in buyer pays an account-less pending order and the amount differs, the result is `SIGN_FAILED`.
8. **`order-status.paidWith`** (D):
   - `null` for orders paid with the picker off, for R0 orders (`payment_method_code 'zero'`), and when nothing is known.
   - For a saved card: `{ option_key:'card', name:'Saved card', amount_gross: <order total> }`.
   - `name` can be null if the option was deleted from settings.
9. **Seed**: Samsung Pay is seeded `active:false`, following plan §3.1 exactly. Every other option is seeded active, with the master switch `enabled:false`.

## Internal additions (no other workstream calls these)
- `payment_attempt_start(p_order_id, p_option_key, p_code, p_kind, p_payment_method_id, p_amount, p_device)`: service role only. It locks the order row so two quick taps cannot both pass the 8-second rule, inserts the attempt and stamps `orders.payment_option_key` and `payment_method_code`.
- `payment_option_name(p_key)`: service role only; used inside the admin RPCs.
- A `CANCELLED` ITN that carries a `custom_str3` attempt id marks that attempt `cancelled`. Today's order update is unchanged.
- **Inert while off:** the paid-twice flag, the amount-mismatch flag, the `'zero'` marker and the `/eng/query/validate` call run only while `payments.enabled` is true. The attempt confirmation (custom_str3 → attempt `paid`) always runs when the ITN carries an attempt id. Only picker payments carry one, so a late ITN after the switch is turned off still confirms its attempt.
- File names: the migrations are `docs/plans/sql/6_pp_payment_picker_schema.sql` (migration `pp_payment_picker_schema`) and `7_pp_payment_picker_rpcs.sql` (migration `pp_payment_picker_rpcs`). The plan said `6_payment_picker_schema.sql`.
- The node tests live in the session scratchpad (`pp-tests/`), not in `netlify/functions/__tests__/`, as the lead instructed.
