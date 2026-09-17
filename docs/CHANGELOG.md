# Changelog

Dated log of drastic/significant changes — bug fixes touching core flows (checkout, cart, payments, auth, seller system), multi-file fixes, and new features. Newest first. See `CLAUDE.md`'s "Change Documentation & System Notes" section for when an entry here is required, and `docs/systems/` for full prose write-ups of whole systems.

---

## 2026-09-17 — Delivery network Stage 14 (notification system) built

**What happened:** Eleventh implementation stage, built entirely by me (touches the shared `lib/delivery-state.js` central to every delivery function, kept out of subagent hands). Plan §168 asks for centralized notification triggering rather than scattering calls across dispatch/pickup/PIN functions — `notify()` is now called from a single place, `transitionDelivery()` itself, so every future status-changing code path gets notifications automatically.

**Scope decision, made explicitly:** email only, not email+in-app. No customer-facing in-app notification feed exists anywhere in this codebase, and `track.html` (Stage 12) already gives customers live in-app status visibility — building a duplicate in-app notification center wasn't justified for a pilot with no real delivery volume yet. The `channel` column still supports `'in_app'` for later.

**What shipped:** new `notification_log` table with a unique dedup index (plan §111/169 — never double-send the same delivery-status email); new `netlify/functions/lib/notify.js` sending Resend emails for the 5 delivery states a customer actually needs to know about (`IN_ROUTE`, `ARRIVING`, `DELIVERED`, `FAILED`, `CANCELLED`), in the plan's specified warm/expressive tone, with the delivery PIN and a `track.html` link embedded directly in the relevant emails. `transitionDelivery()` now calls it on every successful transition (awaited, not fire-and-forget — a Netlify Function process can freeze the instant its handler resolves, so this matches the existing awaited-but-error-tolerant pattern already used for dispatch).

**Reconciled, not rewritten:** `send-on-the-way.js` (the existing service-collection "rep is on the way" email, a separate live system) had its own inline copy of the exact email header/footer chrome `lib/notify.js` also needs — per the plan's explicit "reconcile, don't duplicate... extend/wrap, don't rewrite" instruction, only that shared chrome now comes from `lib/notify.js`'s exported `emailShell()`/`esc()` helpers. The function's own trigger logic, auth, and rate-limiting are completely untouched. Verified byte-for-byte identical HTML output before/after via a side-by-side Node script — a true no-op refactor of a live path, not a behavior change.

**Verified:** all 3 touched files pass `node --check`; `notify()`'s two fast-paths (missing `RESEND_API_KEY`, non-notifiable event) unit-tested directly with a garbage Supabase client to guarantee no accidental real call; the dedup unique index tested for real against the database (exact duplicate correctly rejected, different event correctly allowed); `send-on-the-way.js`'s refactored output confirmed byte-identical to the original. Security advisor sweep clean relative to this stage. No PayFast/checkout/seller-dashboard/admin/logistics file touched.

**Known limitation, tracked not hidden:** no real Resend send was exercised end-to-end in this session's sandbox (no `RESEND_API_KEY` available locally) — verified at the unit/DB level only, same class of limitation already flagged for other frontend/integration work this session.

**Full write-up:** `docs/systems/delivery-network-spec.md` §P.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 17 (analytics) built — the full 196-section plan is now complete

**What happened:** Fifteenth and final implementation stage of the delivery network build. Unlike every other stage, the plan itself frames this one as explicitly lowest priority and "post-pilot-validation... not part of the launch checklist," since it needs real operational data to be meaningful — built anyway, structurally correct, per the founder's standing "nothing gets left out" instruction, with the honest caveat that it will show near-empty numbers until real delivery volume exists.

**What shipped:** two Postgres views (`route_profitability_v`, `delivery_analytics_summary_v`) over existing tables, no new tables. Exposed only through two admin-gated `SECURITY DEFINER` functions (cross-seller/cross-customer aggregates have no natural per-row RLS scoping, so the admin check lives inside the function, same pattern as `get_delivery_tracking`). New "📈 Delivery Analytics" admin tab: a KPI summary grid and a per-route profitability table matching the plan's own "ROUTE #348" breakdown example.

**Deliberately incomplete, documented not hidden:** average pickup time, rider acceptance time, and customer ETA accuracy (plan §99) need per-event timestamp diffing against `delivery_events` — a meaningfully bigger, harder-to-verify piece of SQL, left out and tracked (noted both in the docs and directly in the admin UI) rather than shipped untested. Per-service-zone analytics (plan §144) would need a real schema addition (deliveries don't currently retain which zone they matched) — not added casually for the lowest-priority stage of the build.

**Verified in the database:** both RPCs tested for real — non-admin correctly rejected, admin correctly sees results, and a constructed test scenario's exact arithmetic checked (a R40 delivery, R30 driver payout → R10 remaining, computed correctly). All test data cleaned up. Security advisor sweep clean relative to this stage.

**Full write-up:** `docs/systems/delivery-network-spec.md` §T.
**Commit:** *(pending — see this entry's own commit)*

**This closes the full 196-section delivery network plan.** All 17 stages are built (Stage 4's bundle engine remains a deliberate, founder-approved no-op; Stage 13b, found missing mid-session, was built rather than left out). What remains is entirely founder-side: the outstanding items in the spec's §C action list, and watching the system run once real delivery volume exists to validate what this stage's numbers actually show.

---

## 2026-09-17 — Delivery network Stage 13b (delivery feedback / compliments & complaints) built

**What happened:** Fourteenth implementation stage — the gap found and flagged while closing out Stage 11 (a real stage added during the original plan reconciliation, between Stage 13 and 14, that got missed while working through 12/13/14/15/16 in a different order). Built now, in full, per its original spec. Built entirely by me.

**What shipped:** new `delivery_feedback` table (one submission per delivery, enforced by a unique index) and `netlify/functions/submit-delivery-feedback.js` — the only place a row is created. Resolves `seller_id`/`driver_id` itself from the delivery's actual route rather than trusting the client, a deliberate tightening beyond the plan's literal "customer can insert their own" RLS wording: there is no client-facing INSERT policy at all, closing off a possible complaint-misattribution path before it could be a problem. Three frontend surfaces: `track.html` gets a post-delivery "How was your delivery? ♡ Loved it / Something went wrong" prompt (plan's exact copy) with category buttons for complaints; `seller-dashboard.html` gets a new "Feedback" tab scoped to the seller's own shop; `admin.html` folds a feedback list into the existing Stage 16 Deliveries section (as the plan itself said to do, not a separate admin build), each entry linking into the existing delivery-timeline drill-in.

**A testing mistake caught mid-session, not a product bug:** an RLS negative-test initially tried to reuse a `set_config('role', 'authenticated', ...)` call from a separate, earlier tool call — those settings don't carry across connections, so it silently ran as the bypass-RLS service connection and gave a false pass. Caught by checking the row actually existed afterward, and correctly re-verified within a single transaction (the same pattern already used successfully for every other RLS test this session).

**Verified:** all 4 touched files pass syntax checks; the seller_id/driver_id resolution logic tested against a real route; the one-per-delivery unique index tested for real; RLS re-verified correctly (unrelated user sees nothing, raw client INSERT correctly rejected). Security advisor sweep clean relative to this stage. No PayFast/checkout/logistics file touched, and no changes anywhere outside this stage's own three frontend surfaces plus the one new function.

**Known limitation, tracked not hidden:** no local Netlify dev environment to visually confirm any of the three frontend surfaces render correctly — same class of limitation as every other frontend piece this session.

**Full write-up:** `docs/systems/delivery-network-spec.md` §S.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 11 (optional dynamic batch offers) built — and a missed Stage 13b found

**What happened:** Thirteenth implementation stage. Explicitly marked optional by the plan itself, built anyway per the founder's standing "nothing gets left out" instruction. Built entirely by me (touches the shared dispatch/accept code path). While closing this out, found that "Stage 13b — Delivery feedback (compliments/complaints)" — a real stage added during the original plan reconciliation, between Stage 13 and 14 — was never built, having been missed while working through 12/13/14/15/16 in a different order. Tracked explicitly, not silently dropped; it's next.

**What shipped:** new `find_batchable_routes()` RPC (mirrors `find_nearest_eligible_drivers`'s exact pattern/lockdown) finds an already-moving driver's route close enough to a new pickup to add it as a batch stop. `netlify/functions/lib/batch-dispatch.js`'s `evaluateBatchCandidates()` tries this first when a delivery becomes `READY_FOR_DISPATCH`, only falling through to the existing idle-driver dispatch if nothing's close enough. `respond-to-driver-offer.js`'s accept path now branches on `offer_type` — a `'batch_addition'` offer appends (pickup, drop) stops to the end of the existing route instead of creating a new one, closing a gap that file's own Stage 10 comment had explicitly flagged and left open. Deliberately simplified to append-only (not the plan's fuller 3-option route-insertion comparison) — tracked as a future enhancement once a driver carries 3+ simultaneous stops.

**Founder input still pending, used as a placeholder, not invented silently:** the real ETA-impact threshold (already tracked in the spec's action list) has no live routing/duration available internally, so it's a straight-line-distance proxy (1.5km) until a real number is given and Google Routes is live.

**Verified in the database:** the new RPC tested for real (fresh nearby driver found; stale/not-yet-started routes correctly excluded); a full batch scenario mirrored at the SQL level end to end (existing route, new delivery, candidate found, offer created, stops correctly appended at the right sequence, delivery correctly linked to the shared route) — all cleaned up, zero leftover rows. Security advisor sweep clean relative to this stage. No PayFast/checkout/seller-dashboard/admin/logistics/track file touched.

**Known limitation, tracked not hidden:** no local Netlify dev environment to exercise the real HTTP path end to end — verified via direct SQL mirroring the JS's exact operations, plus syntax checks, not a live function invocation.

**Full write-up:** `docs/systems/delivery-network-spec.md` §R.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 15 (homepage active-delivery widget) built

**What happened:** Twelfth implementation stage. The plan itself notes this is "substantially delivered by Stage 12," kept as its own stage only for numbering — cosmetic polish per plan §50's exact state-by-state widget spec. Built entirely by me, small and self-contained, no new migration.

**What shipped:** a widget at the top of `index.html`, above the hero carousel, shown only to a signed-in customer with a non-terminal or recently-delivered `deliveries` row. Status-driven copy through "being prepared" → "with a driver" → "on the way"/"arrived" → "delivered ✓" (which then correctly disappears again 2 hours after `delivered_at`, per §50's "no need to permanently occupy homepage real estate").

**One deliberate scope narrowing:** §50's "During active travel" example text is a literal ETA ("Arriving in about 7 minutes") — this build has no ETA-recompute engine (consistent with the founder's own early instruction ruling out in-page routing machinery), so a fabricated minutes figure would be dishonest. Used honest status copy instead, the same principle `track.html`'s staleness label already applies.

**Verified:** `index.html`/`style.css` inline scripts syntax-check clean; the widget's exact `deliveries` query tested for real against the database as the owning customer, confirmed correct. No new migration or RLS change — reuses the existing `deliveries_select_own` policy.

**Full write-up:** `docs/systems/delivery-network-spec.md` §Q.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 16 (admin operations dashboard) built — closes Stage 13's PIN-unlock gap

**What happened:** Tenth implementation stage. The plan's own text for this stage was terse but its execution breakdown flagged it as the most parallelizable stage in the whole build (6 independent units, disjoint files/tables). Fixed a security prerequisite and built the pricing editor personally; dispatched two genuinely parallel subagents for the rest — same pattern as Stage 8, every claim independently re-verified against the real database and every diff hunk read personally before trusting it.

**Prerequisite gap found and fixed first:** `deliveries`, `delivery_events`, `delivery_quotes`, `driver_offers` had no admin RLS policy at all (unlike every other delivery-network table) — admins couldn't read them from the browser. Added the standard `*_admin_all` policy to all 4, verified with a real RLS test.

**What shipped, in `admin.html` only:**
- **Delivery Ops** — live Leaflet/OSM map of online drivers (new `list_online_driver_locations()` RPC, `SECURITY INVOKER`) + a riders roster with an eligible⇄suspended toggle.
- **Deliveries** — recent-deliveries list with a click-to-expand `delivery_events` timeline, and an exceptions view surfacing PIN-locked deliveries (with a real **Unlock PIN** action — clears the lock and logs a `PIN_UNLOCKED` event, closing the exact gap Stage 13 flagged and tracked), stale unaccepted offers, and failed deliveries.
- **Delivery Pricing** — `delivery_pricing_config` editor. Every save inserts a new version row and only flips the old one's `is_active` off; version numbers and their numeric fields are never mutated, so historical quotes stay accurate against what they were actually priced under.

**Verified:** RLS prerequisite tested directly (non-admin sees nothing, admin sees/writes everything); new RPC tested against real inserted-then-cleaned-up driver rows; the PIN-unlock query/update/event-log path tested end to end; the pricing-versioning insert/deactivate logic tested and restored to the original single-version production state (zero net data change). Security advisor sweep clean relative to this stage. Full `admin.html` diff read hunk-by-hunk, confirmed scoped to this stage only — no PayFast/checkout/seller-dashboard file touched.

**Known limitation, tracked not hidden:** `drivers` has 0 rows in production right now (dispatch has never fired against a real order yet), so the map/roster couldn't be visually smoke-tested — DB-level and syntax verification only, same class of limitation already flagged for `track.html` in Stage 12.

**Full write-up:** `docs/systems/delivery-network-spec.md` §O.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 12 (customer tracking) built

**What happened:** Ninth implementation stage, built entirely by me. Chosen next because Stage 13 had just closed the pipeline's last hard blocker, making this the customer-facing payoff of the whole build — and the founder had given an explicit spec for it earlier in the session (no in-page GPS turn-by-turn; show "last seen Xm ago" once the rider's position is more than 90s stale).

**What shipped:** `track.html` — a signed-in customer tracking page using Leaflet + OpenStreetMap tiles (free, keyless, consistent with the earlier decision to keep any Google Maps key server-only). Shows a friendly 5-stage status (collapsing the internal 16-state enum), the destination pin, and the assigned rider's last known position — greyed out with a "last seen Xm ago" label once older than 90s, never shown as falsely live. A "📍 Track delivery" link was added to each trackable order in `profile.html`. New `get_delivery_tracking()` RPC — a narrow `SECURITY DEFINER` function rather than a new broad RLS policy on `drivers`, so a tracking customer only ever sees a lat/lon + timestamp, never the driver's own identity/status fields. Also closed a small pre-existing gap: `deliveries.tracking_enabled` had existed since Stage 5 but nothing ever set it — the payment trigger now sets it `true` on every new delivery.

**Verified in the database:** RPC ownership check (returns nothing for a non-owning caller), correct destination/driver coordinate decoding, correct null-driver-position before assignment, and the >90s staleness condition exercised against a deliberately stale test fixture. All test data cleaned up. Security advisor sweep clean relative to this stage.

**Known limitation, tracked not hidden:** no local Netlify dev environment was available to live-browser-test `track.html` this session — verified via syntax check and real database-level RPC testing only, consistent with every other stage's frontend work this session. Founder should click through it once a real delivery exists.

**Full write-up:** `docs/systems/delivery-network-spec.md` §N.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 13 (PIN delivery confirmation) built — closes the pipeline end-to-end

**What happened:** Eighth implementation stage, built entirely by me (payment-adjacent: fires the Stage 10 payout trigger, so no subagent). Prioritized over Stages 11/12 because Stage 10 deliberately dead-ended at `ARRIVING`/`PIN_REQUIRED` with no way to actually complete a delivery — this was the one hard blocker left in the whole pipeline.

**What shipped:** `deliveries.pin_attempt_count`/`pin_locked_at` columns, and `confirm-delivery-pin.js` — the only function in the codebase permitted to set a delivery to `DELIVERED`, enforcing design principle #10 ("no PIN, no completed delivery") literally. Verifies caller identity via `route_stops → routes → drivers` (never trusts client-supplied ids). A wrong PIN never changes status; 5 wrong attempts locks the delivery (423, admin-unlock-only) — going beyond the plan's own text, which only asked for logging. On a correct PIN: transitions to `DELIVERED`, completes the drop stop, and completes the route (firing the Stage 10 payout trigger) if that was the last stop — checked generically ("are all stops done"), not hardcoded to one stop. `logistics.html`'s driver UI got a real PIN entry form replacing the Stage 10 "coming soon" placeholder.

**Verified in the database:** full lifecycle — correct PIN on first try enters `PIN_REQUIRED`; 4 wrong attempts confirmed to leave status unchanged; 5th wrong attempt confirmed to lock; after simulated admin unlock, correct PIN confirmed to reach `DELIVERED`, complete the stop and route, and auto-compute the exact correct payout via the existing trigger. Security advisor sweep clean relative to this stage — all findings present predate Stage 13.

**Known gap, tracked not hidden:** no admin UI yet to unlock a PIN-locked delivery (Stage 16) — today that means a direct DB update; acceptable for a 2-rider pilot.

**Full write-up:** `docs/systems/delivery-network-spec.md` §M.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stages 9+10 (routes, pickup checklist) built — two more gaps caught

**What happened:** Seventh implementation stage, built in the corrected dependency order (routes before route_stop_items, already flagged in the execution plan). Backend built directly (extends the payment-adjacent accept flow); the route/pickup UI delegated to one subagent against a precise contract, then reviewed in full.

**What shipped:** `routes`/`route_stops`/`route_stop_items`/`driver_payouts` tables, an automatic payout-on-route-completion trigger (correctly locked down from the start this time), `advance-route.js` (start route → pickup checklist with correct partial-pickup handling → start delivery leg → arrive) which deliberately stops before `DELIVERED` since PIN confirmation doesn't exist yet, and the corresponding `logistics.html` UI extending Stage 8's Delivery panel.

**Two more real gaps caught during my own review (this is now a clear pattern across Stages 5-10, not a one-off):** driver read access to `deliveries`/`order_items` was entirely missing (worked by accident only because the two test drivers are also admins — would have silently broken for any real future non-admin driver); and `route_stops.location` came back as raw unusable EWKB hex over the API, confirmed live, with no "Navigate to customer" link possible at all as a result. Both fixed — new RLS policies mirroring the existing pattern, and a new `SECURITY INVOKER` coordinate-decoding function that both stops' navigation links now use.

**Verified end-to-end in the database:** the full start→partial-pickup→full-pickup→start-delivery→arrive sequence with two real order items, confirming partial pickup correctly doesn't collapse the route; automatic payout computation verified against the exact expected amount; explicit confirmation nothing in this stage can reach `DELIVERED`.

**Full write-up:** `docs/systems/delivery-network-spec.md` §L.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 8 (rider dispatch) built — two real security gaps caught and fixed

**What happened:** Sixth implementation stage, built via two genuinely parallel subagents (backend dispatch functions; the `logistics.html` rider UI) working against contracts with zero file overlap — the first stage since address infrastructure safe to split this way. Both reviewed in full afterward.

**What shipped:** `drivers`/`driver_offers` tables, a nearest-eligible-driver RPC, new `dispatch.js`/`driver-heartbeat.js`/`respond-to-driver-offer.js`/`dispatch-delivery.js` functions, `advance-delivery-on-fulfillment.js` extended to trigger dispatch inline (no cron needed for this pilot's scale), and a new "Delivery" panel in `logistics.html` (online toggle, heartbeat, offer accept/decline).

**Two real security gaps caught during my own post-build verification (not self-reported by either agent):** the new dispatch RPC was directly callable by `anon`/`authenticated` despite an attempted `REVOKE FROM PUBLIC` — Supabase grants new functions to those roles separately from `PUBLIC`, a gotcha already documented in this project's memory from an earlier session. Then found **my own** Stage 5/6 trigger functions had the identical gap — repeated a mistake I'd previously documented. Both fixed via a full `get_advisors` sweep; trigger firing re-verified unaffected.

**One real data gap discovered by testing:** the dispatch chain couldn't be exercised at all until testing surfaced that Isqalo's `sellers.pickup_geo` is still `NULL` — the Stage 2 pickup-address UI exists but nobody's used it yet. Set a clearly-flagged placeholder to unblock testing; still needs founder confirmation (also affects Stage 3 pricing, not just dispatch).

**Verified end-to-end in the database, not per-file:** the full `READY_FOR_DISPATCH → offered → accepted → ASSIGNED` chain, the nearest-driver RPC, the concurrent-offer protection, and the complete event timeline. All test data cleaned up.

**Full write-up:** `docs/systems/delivery-network-spec.md` §K.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 7 (seller fulfillment hook) built — with a real design correction

**What happened:** Fifth implementation stage. The original execution plan called for a new "Mark ready" button and a check against `order_items.fulfillment_status`. Investigating before building surfaced that column is genuinely dead (no constraint, every row still `'pending'`, nothing ever writes to it) — and that `seller-dashboard.html` already has a real, working, multi-seller-aware fulfillment mechanism that solves exactly the problem Stage 7 needed to solve. Built a small hook into that existing mechanism instead of a duplicate one.

**What shipped:** new `netlify/functions/advance-delivery-on-fulfillment.js` — advances a linked delivery from `PENDING` to `READY_FOR_DISPATCH` once the existing seller-fulfillment code derives that every seller on an order is done, via Stage 6's `transitionDelivery()`. Wired into `seller-dashboard.html`'s existing `updateOrderFulfillment()`, fire-and-forget, never able to break the working flow it hooks into.

**Verified end-to-end in the database** — the first test in this build exercising Stages 5, 6, and 7 together (order → paid → delivery created → advanced to ready), not just in isolation.

**Full write-up:** `docs/systems/delivery-network-spec.md` §J.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 6 (delivery status state machine) built

**What happened:** Fourth implementation stage. Built entirely directly (no subagent — the enum, the auto-logging triggers, and the JS transition map are too tightly coupled to split across agents safely).

**What shipped:** `deliveries.status` is now a real Postgres enum (16 states, plan §112) — invalid values rejected by the type system itself. New `delivery_events` table, auto-populated by two DB triggers (on creation, and on any actual status change) so the audit trail can never be silently skipped by a future code path that forgets to log it. New shared `netlify/functions/lib/delivery-state.js` — every future stage must call its `transitionDelivery()` instead of writing raw status updates; it validates the transition against an explicit allowed-transitions map, guards against two callers racing to change the same delivery, and optionally logs a specific named event with actor attribution.

**Verified two ways, not just reviewed:** directly in the database (creation/status-change logging, idempotent no-op on a same-value re-set, invalid enum value correctly rejected), and via an 11-assertion logic test of the helper itself (valid/invalid transitions, concurrency conflict, named-event logging, actor validation) — all passed.

**Full write-up:** `docs/systems/delivery-network-spec.md` §I.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 5 (checkout integration / payment→delivery trigger) built

**What happened:** Third implementation stage — the one the plan itself flagged as highest-risk relative to the "never touch PayFast files" rules. Built entirely directly, no subagent, given that risk profile.

**Real bug caught during design (not shipped, then fixed):** verifying the trigger's assumptions surfaced that `orders.order_status` is also set to `'paid'` by a completely separate flow — `complete-seller-enrollment.js` (seller-enrollment fee payments share the `orders` table). A naive trigger would have created phantom delivery rows for those. Fixed by gating the trigger on `delivery_quote_id IS NOT NULL`, which also directly encodes the plan's own "delivery must be evaluated before payment" principle.

**What shipped:** `orders` gained `delivery_quote_id`/`priority_fee`; new `deliveries` table; a Postgres trigger (the founder-confirmed approach) creates the delivery job the instant an order is marked paid, PIN generated correctly for guests and signed-in customers alike. **Verified with a real transactional test in the database**, not just review: a synthetic seller-enrollment order correctly got no delivery row, a synthetic quoted product order correctly got one, and a simulated ITN retry correctly didn't duplicate it. `checkout.html` now writes the quote id onto the order only when the server actually confirmed it was applied — verified directly by simulating both the confirmed and rejected server responses.

**Not touched:** `payfast-itn.js`, `generate-payfast-signature.js`, `charge-payfast-token.js` (confirmed via `git status`). `complete-order-payment.js` read for reference only.

**Full write-up:** `docs/systems/delivery-network-spec.md` §H.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 3 (real road-distance pricing) built, not yet live

**What happened:** Second implementation stage. Built directly (migrations, `validate-cart.js`, `checkout.html`) plus one parallel subagent for the new pricing-engine function, independently verified (full line-by-line review including its custom EWKB coordinate parser) before acceptance.

**What shipped:** `delivery_pricing_config` (seeded with the founder-confirmed R36 road-distance tariff table) and `delivery_quotes` tables. New `netlify/functions/get-delivery-quote.js` — checks service-zone eligibility before calling the paid Google Routes API, refuses multi-seller carts cleanly (tracked, unreachable today), ports the existing fee-calculation logic (per-seller surcharge, free-delivery threshold, bulk stepping, custom overrides, fee cap) and swaps only the base fee from class-based to distance-tier-based. `validate-cart.js` now accepts an optional locked `quoteId` and uses it as the authoritative fee when valid, falling back to its existing unchanged behavior otherwise. `checkout.html` opportunistically requests a quote once a real address is picked, entirely non-blocking.

**Not live yet, by design:** the new pricing engine needs `GOOGLE_ROUTES_SERVER_KEY` (not yet provided) and returns a clear, specific error until it's added — no silent straight-line-distance fallback, per the plan's explicit rule against that. Verified live that today's checkout is completely unaffected either way (identical totals rendered with the new code in place).

**Full write-up:** `docs/systems/delivery-network-spec.md` §G.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network Stage 2 (address infrastructure) built

**What happened:** First actual implementation stage of the delivery network (see the two entries below for the planning that led here). Built directly (schema migrations, `checkout.html`) plus three subagents working in parallel on genuinely disjoint files, each independently verified (syntax-checked, RLS assumptions confirmed against live `pg_policies`, confirmed no PayFast files touched) before being accepted.

**What shipped:** `profiles`/`sellers`/`orders` gained geo/PIN/instruction columns (PIN backfilled for all 31 existing profiles); new `service_zones` table + two PostGIS RPC helpers. `checkout.html` and `profile.html` now capture real coordinates from the site's existing free OpenStreetMap Photon autocomplete (extended, not duplicated with a new provider) and invalidate them correctly if the address is hand-edited afterward — verified live end-to-end. `seller-dashboard.html` gained a pickup-address confirmation UI; `admin.html` gained a Service Areas editor (center+radius circle zones); new `netlify/functions/check-service-zone.js` does the eligibility check.

**One tracked gap (not blocking):** no formatted-address text column on `sellers` yet, only coordinates — deferred until Stage 16/8 actually need to display it, rather than adding a column speculatively now.

**Full write-up:** `docs/systems/delivery-network-spec.md` §F.
**Commit:** *(pending — see this entry's own commit)*

---

## 2026-09-17 — Delivery network: planning complete (audit + spec + execution plan), no implementation yet

**What happened:** Founder pasted a full 196-section delivery/logistics network design doc (address validation, service zones, road-distance pricing, multi-store bundling, rider dispatch/batching, route/stop state machines, customer tracking + PIN confirmation, notifications, admin ops, animation system, 20 final design principles). Asked for: an audit against the real schema, a concrete execution plan produced by Fable (`model: fable` via the Agent tool) fed with that audit, reconciliation against the full original plan to catch anything Fable's plan missed, and a persistent spec document to keep returning to across sessions.

**What was done:**
- Enabled PostGIS on the live Supabase project (`create extension postgis`).
- Full schema/codebase audit — key finding: a rich fulfillment state machine (`order_item_statuses`) already exists for *service* pickup/return (July 2026 build), plus a `rep_availability`/`logistics.html` rep app, plus a live, working delivery-fee tariff in `checkout.html`/`validate-cart.js` — none of which the original plan (written without schema access) could have known about.
- Wrote `docs/systems/delivery-network-spec.md`: full original plan preserved verbatim, founder's explicit modifications recorded (fixed R15 priority fee, use the live tariff not the plan's illustrative one, defer the bundle *engine* but design schema for it, no in-page GPS nav — just 90s position-staleness degradation on the customer map), a running "action needed from founder" list, and Fable's full execution plan (concrete migrations, files, parallelizable work units, and flagged concerns per stage).
- Reconciled Fable's plan against the full 196 sections and caught two real gaps Fable's plan didn't cover anywhere: compliments/complaints (§96–98) had no table/file/stage at all, and `driver_payouts` was referenced but never actually created in any migration. Both patched into the plan (new Stage 13b; `driver_payouts` added to Stage 10). Also added priority-aware dispatch ordering (§22) which Fable's simplified nearest-driver algorithm had dropped.

**Follow-up same day — all three judgment-call decisions resolved:** founder reviewed and decided all three: (1) Postgres trigger for "payment confirmed → delivery job created" confirmed as sufficient, with a narrow conditional pre-authorization to touch PayFast-adjacent files only if the trigger genuinely proves insufficient during build; (2) use the plan's own illustrative §12 R36 road-distance tariff table as the real live pricing, not a price-neutral layer on the old class-based tariff; (3) rejected exposing any Google Maps key in the browser — a second, narrow Fable consult confirmed a better approach was already half-built: `checkout.html` already has a free, keyless OpenStreetMap Photon-based address autocomplete live in production, which gets extended to `seller-dashboard.html`/`profile.html` instead of adding a Google browser key; Google's role shrinks to one server-only key (Routes API pricing, optionally Address Validation) restricted by API scope with a billing alert, never reachable from PayFast-adjacent functions. Fable flagged one real follow-up (not blocking): the public Photon instance has no SLA and should be self-hosted once usage across three pages is live, with a graceful manual-entry fallback on failure in the meantime.

**Not done yet:** no delivery-system code or tables have been written beyond enabling PostGIS. Stage 2 (address infrastructure) is next.

**Full write-up:** `docs/systems/delivery-network-spec.md` — this is the living reference; keep returning to it rather than re-deriving the plan.
**Commit:** `f84ae58` (spec + execution plan), plus a follow-up commit for the sign-off resolutions.

---

## 2026-09-16 — Fix signed-in Buy Now: unawaited cart sync overwrote it after load

**Reported as:** Logged-in buyer using Buy Now on a shop page saw the correct shop/price banner, but the order summary showed "1 item" with no item rendered, R0 total, and delivery stuck at R12 (the "small" class fallback). Paying said "cart is empty."

**Root cause:** `checkAuth()` (checkout.html) calls `updateAuthUI(user)`, which fires `syncCartOnLogin(user)` **without awaiting it**, right after `loadCart()` has already correctly rendered the buy-now item. `syncCartOnLogin()` has no concept of a buy-now cart — it only looks at `ss_cart` (empty during Buy Now) and the buyer's `carts` table row (possibly stale from earlier sessions) — and unconditionally overwrites `state.cart` with whatever it finds a moment later, after the correct render already happened. Its own item-mapping was also a fourth copy of the same incomplete-field bug (no `delivery_class`/`seller_id`/etc.), which is why delivery fell back to R12.

**Fix (`checkout.html` only):**
- Added `state.isBuyNow`, set true inside `loadCart()`'s buy-now branch.
- `syncCartOnLogin(user)` is now only called when `!state.isBuyNow` — a buy-now cart must stay fully isolated from the buyer's real cart.
- `syncCartOnLogin()`'s merge now re-fetches fresh product data via `refreshCartItemsFromProducts()` instead of trusting the stale/incomplete server-cart shape directly (fixes the same bug for the *normal* signed-in flow too).

**Full write-up:** `docs/systems/checkout-cart-loading.md`
**Commit:** `cb56c55`

---

## 2026-09-16 — Fix shop.html cart items dropping delivery/pricing data; add custom delivery price

**Reported as:** Buy Now on a shop page (Isqalo Shisanyama, R99 plate) sent the buyer to checkout with the wrong delivery fee (R12 "small" instead of the product's real R22 "medium").

**Root cause:** `shop.html` has its own separate, minimal cart-item builder (not shared with the main site's `script.js` — there's no shared JS module between pages) that only ever carried `id/title/price/qty/size/img/stock/maxQuantity`. It never included `delivery_class`, `seller_id`, `listing_type`, `free_delivery`, `units_per_trip` — for either "Add to Cart" *or* "Buy Now", and for both the product-modal button and the card's quick "+ Add" button (which used an even more minimal snapshot than the modal). checkout.html's own DB re-fetch usually backfilled `delivery_class`/`seller_id`, which is why it *usually* looked fine — but on any fetch failure it silently fell back to the untouched (missing) client data, producing the wrong fee or, worst case, letting a $0-priced item through.

**Fix:**
- `shop.html`: unified both entry points onto one `buildCartItem()` that carries the full field set; the card quick-add now resolves the full product record from `allProducts` (same as the modal already did) instead of a stripped-down snapshot; added a price-unavailable guard on both buttons. Also removed an unrelated pre-existing bug: a broken `updateCartCount()` call in a second, separate `<script>` block that threw `ReferenceError` on every page load (the function is scoped to the first block's IIFE and was never global; the badge is already correctly initialized from within that first block).
- `checkout.html`: both cart-loading paths (`refreshCartItemsFromProducts` for guest/buy-now, `loadAndValidateCartItems` for signed-in server cart) now backfill `listing_type`/`free_delivery`/`units_per_trip`/custom `delivery_price` too, and a failed product re-fetch now throws (surfaced as an explicit empty-cart error) instead of silently trusting incomplete client data.
- `netlify/functions/validate-cart.js`: server-authoritative rejection (400) if a physical product's resolved price is ≤0; mirrors the custom delivery price override logic exactly.
- `admin.html`: added "Custom Delivery Price (R)" to product create/edit, stored at `products.metadata.delivery_price` (no new column) — overrides the Small/Medium/Large class price for that product.

**Full write-up:** `docs/systems/checkout-cart-loading.md`
**Commit:** `d45f913`
