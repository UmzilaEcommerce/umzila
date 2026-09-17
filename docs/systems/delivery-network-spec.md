# Umzila Delivery Network — Master Spec

Status: **STAGES 1-10 COMPLETE (INCLUDING STAGE 9), 2026-09-17** (audit §A; address infra §F; quote engine §G; checkout integration/payment trigger §H; state machine §I; seller fulfillment hook §J; rider dispatch §K; routes/pickup §L). Stage 4 (bundle engine) is a confirmed no-op by design (§B item 2). Everything built so far is verified — real transactional tests directly in the database (full order→paid→dispatch→offer→accept→route→pickup→delivery-leg→arrival chain, exercised end-to-end more than once), logic tests of the JS involved, and repeated live security-advisor sweeps — not just code review. **Nothing is visibly live to real customers yet**: pricing is still gated on `GOOGLE_ROUTES_SERVER_KEY` (§C). Isqalo's real pickup address is now set (founder-provided, §C). Founder has also flagged Photon's address-suggestion accuracy as not good enough for production — tracked as a concrete future task (server-side Google Places proxy, §C item 4), continuing with Photon for now. Real security/access gaps have been caught and fixed at every stage from 5 through 10 (see §K, §L) — this is a pattern worth noting, not just a one-off: **every stage's own end-to-end verification has found something the previous review pass missed.** Next: Stage 11 (optional dynamic batch offers) or Stage 12 (customer tracking) — Stage 13 (PIN confirmation) is the more urgent one architecturally, since Stage 10 already dead-ends waiting for it.
Owner note: this is the living reference document for the delivery network build. Keep coming back to this file across sessions instead of re-explaining the plan. Update it as stages complete (see `docs/CHANGELOG.md` policy in `CLAUDE.md`).

---

## 0. How to use this document

1. **§A "Audit findings"** — what already exists in this codebase/Supabase project that the delivery network must build on or around. Written 2026-09-17.
2. **§B "Explicit modifications to the original plan"** — decisions the founder (user) made in chat that override or narrow the original plan below. These are binding — Fable and any implementation work must follow these, not the plain reading of §D where they conflict.
3. **§C "ACTION NEEDED FROM YOU"** — a running list of things only the founder can provide (API keys, service-area polygons, etc.). Each item stays here, worded as a reminder, until the founder confirms it's done — then it gets removed. **Check this section at the start of every session touching the delivery build.**
4. **§E "Execution plan"** — the staged, concrete implementation plan, grounded in the actual schema (§A) and the modifications (§B). Produced by Fable from the original plan + audit, then reconciled by Claude against the full original plan to make sure nothing was dropped.
5. **§D "Original plan (verbatim)"** — the founder's full pasted plan, preserved as-is for reference. Do not edit this section; if the plan needs to change, record the change in §B instead.

---

## A. Audit findings (2026-09-17)

### A.1 Supabase — what's already there

**PostGIS:** was not installed; **enabled 2026-09-17** (`create extension postgis with schema extensions`) per §B. Available but previously unused: `postgis`, `pgrouting`, `postgis_topology`, `earthdistance`, `address_standardizer`. `pgrouting` is available if in-house road routing is ever wanted instead of a Google Routes API call, but the plan calls for Google Routes API — pgrouting is not needed for the pilot.

**No existing geo/lat-lng columns anywhere.** `orders`, `profiles`, `sellers` all store addresses as **plain text** (`address`, `city`, `province`, `postal_code`, `delivery_address`, `pickup_address`) — no `latitude`/`longitude`, no `geography`/`geometry` columns, no `place_id`. Address validation + geocoding is a from-scratch addition, not an extension of something existing.

**`orders` table already has delivery-adjacent columns** (text-only, no engine behind them yet): `delivery_address`, `pickup_address`, `city`, `province`, `postal_code`, `delivery_class`, `delivery_zone`, `seller_count`, `shipping_cost`, `tip_amount`, `label`. `delivery_class` and `shipping_cost` are written by the **existing, working** checkout delivery-fee calculation (see `docs/systems/checkout-cart-loading.md`) — that calculation (small/medium/large class pricing, R12/R22/R50, per-seller surcharge, quantity-aware stepping) is **"the current tariff table"** the founder referred to. It lives in `checkout.html`'s `calculateDeliveryFee()`/`calculateServiceFees()` and is mirrored server-side in `netlify/functions/validate-cart.js`'s `computeFees()`. The delivery network's pricing engine should **absorb/replace this in place**, not duplicate it — same constants, same shape, extended with road-distance-aware tiers instead of a flat per-class price. As of today this file also supports a per-product custom delivery price override (`products.metadata.delivery_price`) — the new pricing engine should preserve that capability.

**`order_items`**: per-seller line items already exist (`seller_id`, `product_id`, `quantity`, `unit_price`, `fulfillment_status`). Good — multi-store cart grouping (§14 of the original plan) has a real foundation; it does not need to be invented from `orders.items` jsonb alone.

**`order_item_statuses`**: this is the big find. A **full fulfillment/collection state machine already exists here** for *service* orders (printing, made-to-order, in-person services) — built July 2026 ("services v2"). Columns: `status`, `service_status`, `accepted_at`, `acceptance_deadline`, `item_received_at`, `handed_to_seller_at`, `service_completed_at`, `collection_method`, `return_method`, `collection_address`/`return_address`, `collection_slot_start/end`, `return_slot_start/end`, `assigned_rep_id`, `intake_kind`, `intake_response` (jsonb), `proof_urls`, `completion_note`, `dispute_reason`, `returned_at`, `returned_to_umzila_at`, `otw_collect_sent_at`, `otw_deliver_sent_at`, `confirmations` (jsonb). This is conceptually **the same shape as the "route stop" / "delivery event" concepts in §112–§116 of the plan**, just scoped to service pickup/return legs, not general product delivery. Fable's execution plan must explicitly decide: extend this table's model to general delivery stops, or build a parallel `delivery_stops` table and leave this one alone for services. Recommendation to Fable: **do not touch `order_item_statuses`'s existing service-collection behavior** (it's live, working, and `CLAUDE.md` explicitly forbids breaking working systems) — build new tables for product-delivery routing/stops, and only cross-reference `order_item_statuses` where a single order legitimately mixes a service leg and a product-delivery leg.

**`rep_availability`** (`rep_id`, `day_of_week`, `start_time`, `end_time`) and **`logistics.html`**: this is the existing "rep" app — reps claim unassigned service-collection jobs (`assigned_rep_id` on `order_item_statuses`), set their weekly recurring availability, mark items received/handed-to-seller/completed. **`rep_id` and `assigned_rep_id` are bare UUIDs with no FK constraint** — they reference `auth.users.id` directly (via whatever role-check gates access, likely the `Logistics` table below), not a dedicated `reps`/`drivers` table. This is the closest existing thing to a "rider," but it is built entirely around scheduled service slots, not live GPS/on-demand product delivery. **Recommendation to Fable:** the new `drivers`/`riders` concept for product delivery should be its own table (per plan §26/§180), but strongly consider whether the *person* can be the same individual/role as a "rep" (founder + partner doing both today) — i.e. one human, two capabilities (`can_do_scheduled_collections`, `can_do_live_delivery`), not two disconnected identity systems. Confirm with founder before deciding.

**`Logistics` table**: just `id, user_id, role (default 'admin'), created_at` — a thin role-marker table, presumably granting `logistics.html` access. RLS-enabled but (per an earlier advisor check this session) **has RLS enabled with zero policies** — flagged as a pre-existing security gap, unrelated to this build but worth fixing whenever this table is next touched.

**`sellers`**: `location` is free text (no lat/lng), `delivery_method` is free text. Isqalo Shisanyama's `seller_id` is `2918b7a7-7c40-45f0-98c5-3821b3f81021` (found this session). No pickup coordinate exists yet — §9 of the plan ("seller only enters pickup address") is entirely new work.

**`profiles`**: has `address`/`city`/`province`/`postal_code`/`delivery_zone` (text) but no PIN column, no coordinates. §63–§65 (delivery PIN) is new; the migration-safe "generate PIN if missing" approach in §64 is directly usable as written.

**No `payment_methods`-style dedicated tables exist yet for**: delivery quotes, deliveries, routes, route stops, driver locations, driver offers, delivery events, service zones, delivery pricing config, driver payouts, delivery-specific notifications. All of §106's conceptual list is genuinely new, **except** where it overlaps `order_item_statuses`'s existing service machinery (see above) — confirmed by checking every existing table's actual columns, not just names.

**PayFast / checkout**: the existing checkout flow (`checkout.html` → `orders` insert with `order_status: 'pending_payment'` → PayFast → `netlify/functions/payfast-itn.js` confirms `order_status='paid'`) is the untouchable core per `CLAUDE.md`. §105 of the plan ("delivery quote locking," server reconstructs trusted total before PayFast) must be implemented as an **addition to** `validate-cart.js`/`preparePendingOrder()` in `checkout.html` — the same files already fixed twice this session for cart/delivery-fee bugs — **not** a parallel checkout path. See `docs/systems/checkout-cart-loading.md` before touching either file.

**Resend**: already wired for email (referenced in multiple `netlify/functions/*.js` — `send-referral-email.js`, `send-engagement-email.js`, `send-on-the-way.js`). `send-on-the-way.js` in particular already sends a rep-on-the-way email for the service-collection flow — likely reusable/extendable for delivery notifications rather than building a new email pipeline from scratch.

### A.2 What this means for the plan's own audit ask (§184–§186, §196)

The plan explicitly says: *"the next implementation step should not be 'create all these tables' — it should be audit → map existing → map new onto it → identify minimum changes."* That audit is now done (above). The conceptual table list in §106/§182 should be treated as a **wishlist to reconcile against real gaps**, not a literal migration list — several of those "new" tables (delivery events, stop states) have partial prior art in `order_item_statuses` that a from-scratch design would miss.

---

## B. Explicit modifications to the original plan (founder decisions, 2026-09-17)

These are binding overrides. Where §D (the original plan) and this section conflict, this section wins.

1. **GPS / rider navigation (plan §41, §72–§73):** Do **not** attempt in-page turn-by-turn navigation. Riders (founder + partner, for the foreseeable future) will continue to hand off to Google Maps for turn-by-turn — that's fine and expected; it is a known, accepted limitation while the founders are the only riders. **Do build one cheap, specific thing now:** on the *customer-facing* tracking map, apply the same staleness logic the plan already specifies for rider online/offline heartbeats (§25) to the displayed rider position — if the last position update is more than **90 seconds** old, the map must stop presenting a live-looking marker and instead show a "last seen Xm ago" state. This is explicitly in scope for the pilot; in-page navigation and any "keep the site foregrounded while riding" workaround are explicitly **out of scope** until Umzila hires contractor riders (plan §102 territory).
2. **Bundle engine (plan Stage 4, §14–§18):** **Do not build the bundle *engine*** (inter-store route feasibility scoring, split-delivery decisioning) for the pilot. Per plan §188, the pilot is Isqalo alone — one store, one pickup location, nothing to bundle. **Do** design the schema so multi-store fits in later without a rework (i.e., deliveries/routes/stops must be modeled as store-and-order-agnostic from day one — a route already supports N pickups and M drops structurally — just don't build the *decision logic* that chooses to combine or split stores). Revisit building the actual bundle engine once a second store is onboarded.
3. **PostGIS:** enabled 2026-09-17 (§A.1). Use `geography(Point, 4326)` columns for all coordinates (addresses, driver locations, service-zone polygons) rather than plain `numeric` lat/lng pairs, so `ST_DWithin`/`ST_Contains`/`ST_Distance` are available directly in SQL.
4. ~~Pricing tariff: use the existing class-based tariff, layer distance pricing on top~~ — **SUPERSEDED 2026-09-17.** Founder reviewed Fable's "layer, price-neutral at launch" recommendation (Stage 3, cross-cutting decision #6) and explicitly overrode it: **use the plan's own illustrative §12 road-distance table as the real, live tariff** — `0–3km→R36, 3–5km→R45–48, 5–7km→R55, 7–10km→R65, 10–13km→R75, 13–16km→R85, 16–20km→R100, 20km+→extended-zone logic`. This is the actual base-fee mechanism for the new delivery-network engine (§13's "Base fee + Distance cost" — the distance tiers *are* the base fee here), not an addition on top of `DELIVERY_CLASS_PRICES`. `delivery_pricing_config.distance_tiers` (Stage 3) is seeded with these real values from day one, not zero-surcharge placeholders. Other existing modifiers untouched by this change and still layered on top as designed: `PER_SELLER_FEE`, `FREE_DELIVERY_THRESHOLD`, `MAX_DELIVERY_FEE`, bulk-quantity stepping (`DEFAULT_UNITS_PER_TRIP`, keyed off `delivery_class` for capacity-per-trip purposes only, not price), the per-product custom `delivery_price` override, and the priority fee. Stage 3 implementation must work out the precise interaction (recommended default: for network-covered orders, distance-tier lookup replaces the class-price lookup as the base fee; `delivery_class` continues to feed bulk-stepping capacity only). The old class-based tariff remains live and unchanged for any seller/order not yet covered by the new delivery network.
5. **Priority fee:** **fixed R15**, not the plan's illustrative "+R20" (§21, §27). Priority fee belongs to Umzila (plan §21/§103) — unaffected by this change.
6. **Fable has genuine free rein.** If Fable (or any subsequent implementation review) identifies a real problem with the plan or with these modifications, it should say so and propose a fix rather than silently building around it or silently complying against its own judgment. Surface disagreements explicitly in the execution plan output rather than picking one option unannounced.
7. **Scale reality check:** Umzila is still very small — the founder and a partner are the only riders for now, delivering personally to validate the model before expanding. The build should stay genuinely simple where the plan allows optionality (e.g., skip anything speculative/analytics-heavy for the MVP list in plan §187) rather than over-engineering for a scale that doesn't exist yet. This does not relax rule #1 below — it's a tiebreaker for scope questions, not a license to cut corners on anything the founder explicitly asked for.
8. **Address autocomplete: no Google key in the browser, ever — SUPERSEDED Stage 2 approach, 2026-09-17.** Founder rejected exposing a referrer-restricted Google Maps browser key (correctly — Fable confirmed referrer restriction is a known-weak control; the key stays visible in page source regardless). Corrected design, confirmed by Fable: **`checkout.html` already has a working, free, keyless client-side address autocomplete using OpenStreetMap's Photon API** (`wireAddressAutocomplete()`/`applyAddressSuggestion()`, hitting the public `photon.komoot.io` endpoint, South-Africa-boxed with a UKZN Westville bias, already live). Stage 2 extends this *same existing implementation* to `seller-dashboard.html` (pickup address) and `profile.html` (saved address) rather than building a second autocomplete system — and captures the coordinates Photon's GeoJSON responses already include per suggestion (`geometry.coordinates`), which weren't being stored before simply because no geo columns existed yet. **Google's role shrinks to one server-side-only key**, called exclusively from Netlify Functions, never sent to the browser: the Routes API for road-distance pricing (always server-side in every version of this plan), and optionally the Address Validation/Geocoding API as a checkout-time re-validation step per plan §124. Key scoping per Fable: restrict by API (Routes ± Address Validation only, nothing else enabled) rather than by IP (Netlify's outbound IPs aren't stable enough to pin), set a billing quota/alert regardless, and never let this key's env var be reachable from any function that also touches PayFast. **One real risk flagged, not blocking Stage 2 but tracked:** `photon.komoot.io` is komoot's free public demo instance — solid OSM data coverage for Durban/Westville, but no SLA and no guarantee it tolerates sustained production traffic once three pages depend on it instead of one. Mitigation for Stage 2: every Photon call needs a graceful fallback to plain manual address entry on timeout/failure (not an error state) — this is good practice regardless of the reliability question. **Near-term follow-up, not required before Stage 2 ships:** self-host Photon (open-source, deployable from an OSM extract) once usage across all three pages is live, rather than depending indefinitely on the free public instance. **Update 2026-09-17:** founder has since flagged Photon's suggestion accuracy as genuinely not good enough for production (not just a reliability/self-hosting concern) — self-hosting Photon won't fix that, it's a data-quality issue, not an uptime one. Confirmed direction: keep Photon for now (testing), replace with a **server-side Google Places Autocomplete proxy** (private key, never browser-exposed — same property this whole decision was about) once Google is set up. See §C item 4.
9. **Delivery-job creation via Postgres trigger: confirmed, 2026-09-17.** Founder reviewed Fable's Stage 5 design (an `AFTER UPDATE OF order_status` trigger on `orders`, firing when `order_status` becomes `'paid'`, idempotent against PayFast's ITN retries) and confirmed it directly: *"the postgres is enough it will be reliable and consistant."* Proceed with the trigger-only approach as designed — `payfast-itn.js`, `generate-payfast-signature.js`, `charge-payfast-token.js` are not touched for this. **Conditional fallback, also explicitly authorized:** if the trigger genuinely proves insufficient during Stage 5 build/test (not hypothetically — an actual observed gap), founder has pre-authorized "slightly edit[ing] relevant files" as a narrow fallback. This authorization is scoped tightly: minimal, precise, reviewed changes only, and — given how strict this project's own rules are about this exact file set — confirm with the founder what specifically needs to change and why before making the edit, rather than treating this as a blanket license once Stage 5 starts.
10. **Rule #1, non-negotiable:** nothing named in the original plan (§D) gets silently dropped from the *design*, even where implementation is deliberately staged or deferred. If something is deferred (like the bundle engine), it must still be accounted for structurally and tracked as a named, explicit deferral — not forgotten. Time is not a constraint; completeness is. If the plan must be split into multiple implementation passes to guarantee nothing is missed, that's expected and fine.

---

## C. ACTION NEEDED FROM YOU

**Check this list at the start of every session touching this build.** Each item is used as a placeholder in code/config until you provide it — I'll keep reminding you here until you tell me it's done, then I'll remove it. (Consolidated 2026-09-17 after Fable's execution plan — merges the initial list with what Fable identified stage-by-stage.)

1. **One Google API key — server-side only, no browser key needed at all** (superseded 2026-09-17, see §B item 8). Private key, Netlify env var only, never sent to frontend. Restrict it in Google Cloud Console to only the Routes API (± Address Validation/Geocoding if that optional re-validation step is built) — nothing else enabled — and set a billing quota/alert on the project. Needed for Stage 2/3's road-distance pricing calls. **Status: not provided — placeholder env var name `GOOGLE_ROUTES_SERVER_KEY` will be used in code until the real value is added in Netlify.**
2. **Isqalo Shisanyama's real pickup address**, for geocoding into `sellers.pickup_geo`. Needed for Stage 2. **Status: not provided — will use a placeholder point until confirmed.**
3. **Initial service-zone boundary** for the Durban Workshop area (real polygon, or an accepted-as-temporary radius circle around Isqalo). Needed for Stage 2. **Status: not provided — will use a placeholder radius circle until real boundaries are given (can also be drawn later via the admin service-zone editor, which now exists — see §F).**
~~3b. Isqalo's real pickup address~~ — **RESOLVED 2026-09-17.** Founder set the real address via Stage 2's `seller-dashboard.html` pickup UI (`sellers.pickup_geo` now `POINT(31.0269074 -29.8520038)`, confirmed replacing the earlier placeholder). Removed from this list.
4. **Photon address-suggestion accuracy — founder feedback, 2026-09-17: not accurate enough for real use.** Photon's suggestions (the free, keyless autocomplete built in Stage 2, extended in Stages 3/8's design) aren't good enough for production — founder wants Google's address verification/autocomplete as the real experience. **Explicitly deferred, not urgent**: continue using Photon for now (testing purposes, and it's already wired end-to-end), switch once Google is set up. **When that happens, do not simply add back a browser-exposed Google key** (that was already rejected, correctly, in §B item 8) — the right design is a **server-side Google Places Autocomplete proxy**: a new Netlify function using the same private server-only key already planned for the Routes API, called from the browser instead of hitting Google directly. This keeps the "no Google key in the browser, ever" property while getting Google's actual address quality. Tracked here as a concrete future task, not yet built.
4. **Confirmation that your and your partner's existing rep/`Logistics` accounts are the same two people to seed as the first `drivers` rows** (Stage 8) — i.e. one human identity, two capabilities (scheduled collections + live delivery), not two separate logins.
5. **Batching ETA-impact threshold** (Stage 11) — the max extra wait you're willing to impose on an existing customer to justify adding a nearby order to a rider's route (e.g. "+10 min max"). The plan deliberately leaves this as your call, not something to invent silently.
6. **Initial driver payout formula/target economics** (Stage 8/10) — at minimum a starting number/formula so `driver_payouts` can compute anything (e.g. "R per km + R per stop," or a target % of delivery revenue per route). §102 of the plan deliberately leaves this open.
7. **Support contact info** (phone/WhatsApp) for the tracking page's "Need help?" entry point (Stage 12/16).
All three of the plan's highest-judgment-call decisions are now resolved (2026-09-17, see §B items 4, 8, 9):
- ~~Trigger-based PayFast integration~~ — **confirmed**, Postgres trigger only, no PayFast file edits (narrow conditional fallback pre-authorized if genuinely needed — see §B item 9).
- ~~Pricing: layer vs. replace~~ — **resolved**: use the plan's own §12 illustrative R36 distance-tariff table as the real, live numbers (see §B item 4).
- ~~Google browser key exposure~~ — **resolved**: no browser-facing Google key at all; reuse the existing free Photon-based autocomplete client-side, one server-only Google key for road-distance pricing (see §B item 8).

Nothing else identified yet — more may surface as each stage actually starts.

---

## E. Execution plan

Produced by Fable (2026-09-17), then reconciled by Claude against the full 196-section plan in §D. Fable's plan is reproduced in full below in "E.2 — Fable's plan (as delivered)". Two real gaps were found during reconciliation and are patched in "E.1 — Reconciliation patches" — both are additive to Fable's stage numbering, nothing in Fable's plan was wrong, these were simply not covered anywhere.

### E.1 Reconciliation patches (Claude, 2026-09-17)

**Patch 1 — Priority dispatch ordering was dropped (plan §22).** Fable's Stage 8 `dispatch-delivery.js` deliberately simplifies §24's full ranking to nearest-online-driver for the 2-rider pilot (reasonable). But it doesn't mention priority at all, and §22 explicitly requires priority orders to get elevated dispatch treatment. Cheap fix, folded into Stage 8: `dispatch-delivery.js`'s candidate query orders by `(deliveries.priority_fee > 0) DESC, ST_Distance(driver.last_location, pickup) ASC` — priority orders get first look among available drivers. No new table needed.

**Patch 2 — `driver_payouts` table was never created.** Fable's plan references `driver_payouts` in Stage 8's founder-inputs ("initial payout formula") and Stage 17's analytics views, but no stage's Migrations section actually defines the table. Added to **Stage 10** (route completion is the natural trigger point, matching §102's "calculated by route, not a crude percentage"):
- New `driver_payouts`: `id, route_id uuid references routes(id) unique, driver_id uuid references drivers(id), amount numeric, calculation_basis jsonb (snapshot of km/stops/time/formula version used, for auditability/disputes per §74), status text default 'pending' check in ('pending','paid'), paid_at timestamptz, created_at`.
- Trigger or `netlify/functions/lib` helper, fired on `routes.status → 'completed'`, computes `amount` from the founder-provided payout formula (§C item 7) against the route's actual final `total_distance_km`/stop count/duration — never a static percentage of what the customer paid, per §102.

**Patch 3 — Compliments/complaints has no stage at all (plan §96–98, §173–174).** This is a full gap, not a simplification — added as a new stage between Stage 13 (PIN) and Stage 14 (notifications), since feedback collection is triggered by the PIN-confirmed `DELIVERED` event and feeds the same notification/event infrastructure:

**Stage 13b — Delivery feedback (compliments/complaints)** *(new, added in reconciliation)*
- **Migrations**: new `delivery_feedback`: `id, delivery_id uuid references deliveries(id), order_id uuid references orders(id), customer_id uuid nullable (guest support, same reasoning as the PIN fix), feedback_type text check in ('compliment','complaint'), category text nullable (§97's "missing item"/"late"/etc — free-form for pilot, categorized dropdown once volume justifies it), message text, seller_id uuid references sellers(id), driver_id uuid nullable references drivers(id), created_at`. RLS: customer can insert their own (matched by `delivery_id` ownership), sellers can read rows where `seller_id` matches their own (§76's "Feedback" section, §174), admin reads all.
- **Files**: `track.html` — post-`DELIVERED` prompt (§97's "Loved it" / "Something went wrong" two-button UI), reusing Stage 12's page rather than a new one. `seller-dashboard.html` — feedback list scoped to `seller_id` (§76). `admin.html` — feedback view joined with `delivery_events` timeline for investigation (§98's "was it store prep, rider wait, route length" analysis) — natural fit inside Stage 16's Unit F (exceptions/issues view), extended to include feedback, not a separate admin build.
- **Parallelizable units**: [ ] A: `delivery_feedback` migration + RLS; [ ] B: `track.html` prompt UI (buildable against fixture data); [ ] C: `seller-dashboard.html` feedback list; [ ] D: fold into Stage 16 Unit F's admin view.
- **Dependencies**: Stage 6 (delivery status), Stage 13 (PIN/`DELIVERED` is the trigger point). Independent of Stage 14 otherwise, though it can share `lib/notify.js`'s infrastructure if a "thanks for your feedback" acknowledgment is ever wanted (not required for pilot).
- **Founder inputs needed**: none beyond design/copy tone (§97's exact wording is already specified in the plan and can be used as-is).
- **Concerns/flags**: none — genuinely just a missing stage, not a design problem.

**Patch 4 — noted, not fixed (tracked deferral, consistent with the bundle-engine precedent).** §76–77's seller-facing "live delivery reassurance" (driver name, live status, optional map in the seller's own dashboard) is only partially covered — Stage 7 only builds "mark ready," and Stage 16's live map is admin-only. Given §B.7's scale reality (founder + partner are the only riders; the founder effectively *is* the admin), this is deferred rather than built now, **the same way the bundle engine is deferred** — tracked here explicitly so it isn't silently dropped: `seller-dashboard.html` should get a lightweight "Order #1024 — driver: [name], status: [status]" read-only line once a second admin/operator exists and this distinction actually matters. Revisit alongside Stage 4's bundle-engine revisit.

---

### E.2 Fable's plan (as delivered)

*(Reproduced in full below, unedited except for markdown heading-level adjustment to nest under this section. See E.1 above for the two gaps patched during reconciliation — everything else below is Fable's own output.)*

#### Cross-cutting design decisions (apply to every stage below)

Confirmed via direct codebase inspection during Fable's pass: no `supabase/migrations` folder exists in the repo (schema changes are applied directly, likely via the Supabase MCP tool or dashboard — recommend starting a `supabase/migrations/*.sql` folder now for auditability, consistent with the `docs/CHANGELOG.md` convention already adopted); `netlify/functions/lib/complete-order-payment.js` (1047 lines) is a **shared** module used by both `payfast-itn.js` and `charge-payfast-token.js` to finalize orders — this is the real seam for "payment confirmed → delivery job created," not either PayFast file itself; `netlify/functions/get-client-config.js` already hands the frontend `supabaseAnonKey` and `SITE_BASE_URL` via a safe proxy pattern — this is the template to extend for a browser-restricted Google Maps key; **guest checkout is real and extensive in `checkout.html`** (dozens of guest-path branches) — this directly affects PIN design (see Stage 5, and Patch 3's identical reasoning above).

1. **Geo columns**: `geography(Point,4326)` for all point coordinates; `geography(Polygon,4326)` for service-zone boundaries, one row per named area (e.g. "Durban Core", "Umhlanga Extended", "Hillcrest Extended") rather than one multi-polygon — simpler admin editing, `zone_type` column distinguishes core/extended/restricted.
2. **`order_item_statuses` stays untouched.** It is the live service-collection state machine and must not be extended or reused for product delivery. New tables (`deliveries`, `routes`, `route_stops`, `route_stop_items`) are built for product-delivery routing. They cross-reference `order_item_statuses` only conceptually (an order could in theory mix a service leg and a product leg) — not wired for the pilot since Isqalo sells food only, no services. This is flagged as a tracked future integration point, not dropped.
3. **Bundling vs. batching — these are different things and the plan's own language blurs them.** *Bundling* (§14–18) = combining items from **different stores** into one delivery. *Batching* (§30–39) = combining **different customers' orders** onto one rider's route. §B.2 only defers the bundle **engine** (irrelevant with one store). Batching is **not** deferred — it's needed even in the pilot the moment two orders are active at once with two riders. Every stage below keeps this distinction explicit.
4. **Driver identity = rep identity.** Per the audit's own recommendation: one human (founder, partner), two capability flags (`can_do_scheduled_collections`, `can_do_live_delivery`) on a new `drivers` table keyed by `user_id → auth.users.id` — the same identity space `rep_id`/`assigned_rep_id` already use. Confirm with founder before Stage 8 migrations (listed in Founder inputs).
5. **PIN lives on `deliveries`, not solely on `profiles`.** The original plan (§63–64) assumes a profile-based PIN. Confirmed guest checkout is real in `checkout.html`, so a profile-only PIN would silently fail for guests. Corrected design: `deliveries.delivery_pin` is generated at delivery-creation time (copied from `profiles.delivery_pin` for a signed-in returning customer if present, else freshly generated) — one authoritative value per delivery, works for guests and accounts alike. `profiles.delivery_pin` (Stage 2) becomes a "default to copy from" convenience only, never queried at verification time.
6. **Pricing: layer, don't replace.** Per §B.4, use the live tariff (`DELIVERY_CLASS_PRICES`, `PER_SELLER_FEE`, `FREE_DELIVERY_THRESHOLD`, `MAX_DELIVERY_FEE`, `DEFAULT_UNITS_PER_TRIP`, `LARGE_OVERFLOW_FEE`) as the base. Add a new, admin-configurable `distance_tiers` surcharge on top, seeded at **zero surcharge for every tier at launch** so Stage 3 ships price-neutral versus today, and the founder tunes real distance pricing from `admin.html` once live. This is a reasoned recommendation, not a unilateral call — flagged for explicit founder sign-off since §B.4 left the door open for full replacement instead.
7. **PayFast files stay untouched, literally.** `payfast-itn.js`, `generate-payfast-signature.js`, `charge-payfast-token.js` are never edited. The "payment confirmed → delivery job created" step (§23) is implemented as a **Postgres trigger** on `orders` (`AFTER UPDATE OF order_status`) that fires when `order_status` becomes `'paid'`, written idempotently (existence check) to survive PayFast's known ITN retries. This is the single biggest CLAUDE.md-compliance decision in this plan — flagged for explicit founder confirmation in Stage 5.

#### Stage 1 — Audit existing system
**Status: COMPLETE.** This is §A of the spec doc. No further work; every later stage cites it.

#### Stage 2 — Address infrastructure

**CORRECTED 2026-09-17 per §B items 8–9 (founder decisions) — see notes inline below; Fable's original text follows unaltered where still accurate.**

**Migrations**
- `profiles`: add `delivery_pin char(4)` (nullable, backfilled per §64 in a one-time server-side script — not client-triggered), `delivery_instructions text`, `saved_address_geo geography(Point,4326)`, `saved_address_place_id text`.
- `sellers`: add `pickup_geo geography(Point,4326)`, `pickup_place_id text`, `pickup_confirmed_at timestamptz`.
- `orders`: add `destination_geo geography(Point,4326)`, `destination_place_id text`, `delivery_instructions text` (order-level snapshot per §123, separate from the profile default), `address_validated_at timestamptz`.
- New `service_zones`: `id uuid pk, name text, zone_type text check in ('core','extended','restricted'), boundary geography(Polygon,4326), active boolean default true, notes text, created_at`.
- RLS: `service_zones` public-readable (needed for pre-auth checkout eligibility checks), admin-only write via the `Logistics` table role check — **and fix `Logistics`'s pre-existing zero-policy RLS gap as part of this pass**, since this is the first stage that needs a working admin-write policy anywhere near it.

**Files**
- ~~`netlify/functions/geocode-address.js` — server-side Place Details/Address Validation proxy~~ **CORRECTED**: client-side address suggestion is **not** a new Google-backed function — it's the existing free, keyless Photon-based `wireAddressAutocomplete()`/`applyAddressSuggestion()` already live in `checkout.html`, extended (same implementation, not a rewrite) to `seller-dashboard.html` and `profile.html`. Each selected suggestion's coordinates come directly from Photon's own GeoJSON response (`geometry.coordinates`) — captured and stored now that geo columns exist, no separate geocoding call needed for this step. Add a graceful fallback to plain manual text entry on Photon timeout/failure everywhere this is used (not an error state).
- `netlify/functions/geocode-address.js` (new, smaller scope than originally described) — **optional** server-side re-validation/refinement step per plan §124, using Google's Address Validation/Geocoding API with the sole server-only key. Not required to ship Stage 2; can follow once the core Photon-based flow works.
- `netlify/functions/check-service-zone.js` (new) — `ST_Contains` lookup against `service_zones`, returns eligibility + zone_type + reason string (§20 wording). Takes the coordinates already captured client-side (from Photon), no Google call needed for this check.
- `checkout.html` — extend the existing Photon-based autocomplete to also capture/store `destination_geo`/coordinates on the pending order draft (today it only fills text fields).
- `profile.html` — same extension, for saved address + delivery instructions editing; PIN display area.
- `seller-dashboard.html` — pickup-address entry/confirmation UI (§9) reusing the same Photon-based autocomplete pattern, writing `sellers.pickup_geo`.
- `admin.html` — "Service Areas" section; a JSON/polygon textarea editor is sufficient for one shop, one zone — a drawing UI is not required for the pilot.

**Parallelizable units**
- [ ] A: migrations (profile/seller/order columns + `service_zones` + `Logistics` RLS fix)
- [ ] B: `check-service-zone.js` (needs no Google key at all — can go fully live immediately, no founder input blocking it); optional `geocode-address.js` re-validation step (needs the server-only Google key, can be deferred)
- [ ] C: extend the existing Photon autocomplete in `checkout.html` to capture+store coordinates (buildable and testable immediately — no key of any kind needed)
- [ ] D: `seller-dashboard.html` pickup-address UI, reusing C's pattern
- [ ] E: `admin.html` service-zone editor shell

**Dependencies**: Unit A before B/D/E write real data. **Unlike the original draft, Google keys no longer block any of Stage 2 from going live** — only the optional Address Validation re-validation step in B needs the server key, and it's not required for Stage 2 to ship. Full Stage 2 (zones + coordinate capture working end-to-end for Isqalo + one Durban zone) must finish before Stage 3.

**Founder inputs needed**
- ~~Google Places/Maps browser key~~ — no longer needed, see §B item 8.
- Google Routes **server** key (private, Netlify env var only, never sent to frontend) — needed for Stage 3's pricing, optionally for Stage 2's Address Validation re-check.
- Isqalo's real pickup address
- Initial zone boundary — acceptable pilot simplification: a simple radius circle around Isqalo if a real polygon isn't ready yet, upgraded later

**Concerns/flags**
- Never let client-computed lat/lng be trusted for pricing — Stage 3 always re-validates server-side.
- Photon reliability tracked as a near-term follow-up (self-host once usage across 3 pages is live) — see §B item 8. Not blocking Stage 2.

#### Stage 3 — Delivery quote engine

**CORRECTED 2026-09-17 per §B item 4 — founder confirmed using the plan's §12 R36 table as the real tariff, not a price-neutral layer. Seed data below updated accordingly; rest of Fable's design (quote locking, server-side recomputation) is unchanged.**

**Migrations**
- New `delivery_pricing_config`: `id, version int, effective_from timestamptz, per_seller_fee numeric default 3, free_delivery_threshold numeric default 600, max_delivery_fee numeric default 80, default_units_per_trip jsonb default '{"small":8,"medium":4,"large":2}', large_overflow_fee numeric default 10, priority_fee numeric default 15, distance_tiers jsonb, is_active boolean default true, created_by uuid references auth.users, created_at`. **Seed row v1 with real §12 values** — `distance_tiers = [{"max_km":3,"fee":36},{"max_km":5,"fee":47},{"max_km":7,"fee":55},{"max_km":10,"fee":65},{"max_km":13,"fee":75},{"max_km":16,"fee":85},{"max_km":20,"fee":100}]` (using the midpoint R47 for the plan's "R45–48" 3–5km range — admin-editable from Stage 16 once live), plus an `extended_zone_fee`/flag for the plan's "20km+ → extended-zone logic" case, resolved against `service_zones.zone_type` rather than distance alone. `class_prices` dropped from this table entirely — distance tiers are now the base-fee mechanism, not an addition to the small/medium/large lookup (see §B item 4 for exactly how `delivery_class` still feeds bulk-stepping capacity only).
- New `delivery_quotes`: `id, customer_id uuid nullable (guest support), pickup_seller_ids uuid[], destination_geo geography(Point,4326), destination_snapshot jsonb, distance_km numeric, duration_min numeric, delivery_class text, base_fee numeric, distance_surcharge numeric, per_seller_fee_total numeric, priority_fee numeric, total_delivery_fee numeric, pricing_config_version int references delivery_pricing_config(version), expires_at timestamptz, status text default 'active', created_at`.
- RLS: `delivery_quotes` readable only by its owning `customer_id` or service role; never client-writable.

**Files**
- `netlify/functions/get-delivery-quote.js` (new) — calls Google Routes API server-side (private key), applies `delivery_pricing_config`, writes a `delivery_quotes` row, returns `quote_id` + total only (§139 — no breakdown shown to customer).
- `netlify/functions/validate-cart.js` (**extend, carefully**) — `computeFees()` gets a new optional path: if a valid unexpired `quote_id` is present, reconstruct the total from the locked quote instead of recomputing (§105's "server reconstructs trusted total"). Must be fully backward-compatible: orders without a `quote_id` keep today's exact behavior.
- `checkout.html` — request a quote once address + cart are known; display only the final total; carry `quote_id` through `preparePendingOrder()` into the same `shipping_cost` field that already flows into PayFast signature generation — **no new field is added to the signature payload itself.**

**Parallelizable units**
- [ ] A: `delivery_pricing_config` + `delivery_quotes` migrations + seed data
- [ ] B: `get-delivery-quote.js` (depends on A's schema + Google Routes key; logic can be stubbed/tested before the key arrives)
- [ ] C: `validate-cart.js` quote-aware extension (depends on A's quote shape; must be reviewed specifically against "never skip ITN, never trust client totals")
- [ ] D: `checkout.html` UI wiring (buildable against B's documented response contract before B is finished)

**Dependencies**: Needs Stage 2's validated destination + zone check. Tightly coupled to Stage 5 — in practice these land together and should be tested end-to-end (quote → validate-cart → PayFast total match) before either is called done.

**Founder inputs needed**
- ~~Confirmation of the "layer, don't replace" pricing decision~~ — resolved, see §B item 4.
- Google Routes server key (if not already supplied in Stage 2)

**Concerns/flags**
- Google Routes API calls cost money per call; recommend short-TTL caching of quotes keyed by (pickup store, destination rounded to ~50m, delivery class) to avoid re-billing identical lookups during one checkout session. Not required for pilot volume, cheap to add now.
- `get-delivery-quote.js`/`validate-cart.js` must never accept a client-supplied `distance_km` or fee — always recomputed server-side, no exceptions.

#### Stage 4 — Multi-store bundle engine (schema only — engine explicitly deferred per §B.2)

**Migrations**: none beyond what Stage 3/10 already provide — `delivery_quotes.pickup_seller_ids` is already an array; `route_stops` (Stage 10) already models N pickups/M drops. Nothing needs to be added for the deferral itself.

**Files**: none — no bundle decision logic is written now.

**Parallelizable units**: none — genuinely a no-op stage for the pilot.

**Dependencies**: Stage 3 and Stage 10's schemas must remain store-count-agnostic (verified true above).

**Founder inputs needed**: none yet.

**Concerns/flags**
- **Must be tracked, not silently dropped, per rule #1.** Concretely: `get-delivery-quote.js`, when `pickup_seller_ids.length > 1`, should currently refuse with the §20 "needs separate deliveries" message rather than attempt naive summing — this path is unreachable today (Isqalo is the only store) but should carry a `// TODO(bundle-engine, deferred per delivery-network-spec.md §B.2)` comment so it isn't forgotten when store #2 onboards.
- When a second store is added, this becomes a real stage: inter-store route-distance scoring (§15), split-delivery decisioning (§137), and the "negligible = free, material = surcharge" logic (§17), reusing the Google Routes plumbing Stage 3 already built.

#### Stage 5 — Checkout integration

**Migrations**
- `orders`: add `delivery_quote_id uuid references delivery_quotes(id)`, `priority_fee numeric default 0`.
- New `deliveries`: `id, order_id uuid references orders(id) unique, quote_id references delivery_quotes(id), customer_id uuid nullable, status text, destination_geo geography(Point,4326), destination_snapshot jsonb, delivery_instructions text, delivery_pin char(4) not null, tracking_enabled boolean default false, route_id uuid nullable, created_at, dispatched_at, delivered_at, cancelled_at, failure_reason text`. (`status` retyped to the Stage 6 enum once it exists.)
- **Trigger** on `orders` (`AFTER UPDATE OF order_status` → `'paid'`): idempotently inserts a `deliveries` row if none exists for that `order_id`. This is the entire "delivery job created" mechanism — it lives in the database, not in any PayFast file.

**Files**
- `checkout.html` — the existing pre-payment `orders` insert now also writes `delivery_quote_id`, `priority_fee`, and generates/copies `delivery_pin` for the delivery that will be auto-created by the trigger.
- **No changes** to `payfast-itn.js`, `generate-payfast-signature.js`, `charge-payfast-token.js`.
- `netlify/functions/lib/complete-order-payment.js` — read-only review pass only, to confirm the exact point `order_status` flips to `'paid'` matches the trigger's assumption (e.g. rules out a partial-update/upsert path that wouldn't fire an `AFTER UPDATE OF order_status`).

**Parallelizable units**
- [ ] A: `deliveries` migration + trigger + idempotency test (testable against a fixture order, no real checkout involved)
- [ ] B: `checkout.html` wiring — small, surgical diff; given this file's documented history of fragile cart/delivery-fee bugs (`docs/systems/checkout-cart-loading.md`), recommend this specific diff go to whoever last worked that file, not a fresh agent unfamiliar with its landmines

**Dependencies**: Stage 3 (`quote_id` must be valid at insert time). This stage is a **hard prerequisite for Stages 6–17** — nothing downstream can exist without a `deliveries` row.

**Founder inputs needed**: ~~explicit sign-off on the trigger-based integration approach~~ — **confirmed 2026-09-17**, see §B item 9 (includes a narrow, conditional pre-authorization to edit PayFast-adjacent files only if the trigger genuinely proves insufficient during build/test).

**Concerns/flags**
- This is the highest-risk stage relative to the PayFast "do not touch" rules. The trigger must be idempotent against PayFast's known ITN retry behavior.
- The plan's §101 financial-separation ask is satisfied without duplicating order data: customer-facing charges (`shipping_cost`, new `priority_fee`) stay on `orders` (what the customer paid); operational cost/payout breakdown lives on `deliveries`/`driver_payouts` (Stage 8/10) — different concerns, not a duplicate "second orders table."

#### Stage 6 — Delivery/order state machine

**Migrations**
- Postgres enum `delivery_status`: `PENDING, READY_FOR_DISPATCH, OFFERED, ASSIGNED, DRIVER_AT_PICKUP, PARTIALLY_PICKED_UP, PICKED_UP, IN_ROUTE, NEXT_STOP, ARRIVING, PIN_REQUIRED, DELIVERED, CANCELLED, FAILED, REASSIGNING, RETURNED` (§112 verbatim). Retype `deliveries.status` against it.
- New `delivery_events`: `id, delivery_id references deliveries(id), event_type text (§60 list), actor_type text check in ('system','driver','customer','admin'), actor_id uuid nullable, metadata jsonb, created_at`. Insert-only.
- Trigger: `AFTER UPDATE OF status ON deliveries` auto-inserts a `delivery_events` row — no code path can change status without leaving a timeline entry.

**Files**
- `netlify/functions/lib/delivery-state.js` (new, shared) — allowed-transitions map + `transitionDelivery(deliveryId, newStatus, actor)` helper. Every later function (dispatch, pickup, PIN-confirm) calls this instead of writing raw `UPDATE`s — this is what prevents §81's "invalid status transitions" bug class (e.g. delivered → pending).

**Parallelizable units**
- [ ] A: enum + `delivery_events` + auto-logging trigger
- [ ] B: `lib/delivery-state.js` transition map (can be written/unit-tested independently, just needs A's final enum values to compile against)

**Dependencies**: Stage 5's `deliveries` table. **This stage's enum values must be locked and communicated before parallelizing Stages 7+** — it's the fixed point the rest of the build hangs off.

**Founder inputs needed**: none.

**Concerns/flags**
- `route_stops.status` (Stage 10) and `deliveries.status` must not become two independently-drifting sources of truth — `delivery-state.js` should be the only place one derives from changes in the other, never duplicated logic in two files.

#### Stage 7 — Seller pickup workflow

**Migrations**: none new — reuse `order_items.fulfillment_status` (verify its existing CHECK constraint includes a `'ready_for_pickup'`-equivalent value before relying on it; extend the constraint if not).

**Files**
- `seller-dashboard.html` — "Mark ready" action (§40) inside the existing order-list rendering.
- `netlify/functions/mark-order-ready.js` (new) — writes `fulfillment_status`, and when all items for a delivery are ready, calls `delivery-state.js` to transition `PENDING → READY_FOR_DISPATCH`. The button calls this function rather than the client writing Supabase directly, so Stage 6's transition validation is enforced.

**Parallelizable units**
- [ ] A: `seller-dashboard.html` UI (buildable against a stubbed function response)
- [ ] B: `mark-order-ready.js` (depends on Stage 6)

**Dependencies**: Stage 6. Independent of Stages 8–13 otherwise.

**Founder inputs needed**: none.

**Concerns/flags**: none — `seller-dashboard.html` already scopes orders by `seller_id` per the audit, so no new RLS work; keep the seller surface exactly as narrow as §40 (no logistics controls), consistent with CLAUDE.md. (See Patch 4 above re: §76–77's fuller seller delivery-visibility — deferred, tracked.)

#### Stage 8 — Rider system

**Migrations**
- New `drivers`: `id uuid pk default gen_random_uuid(), user_id uuid references auth.users(id) unique, is_online boolean default false, last_seen_at timestamptz, last_location geography(Point,4326), last_location_at timestamptz, heading numeric, speed numeric, vehicle_description text, can_do_scheduled_collections boolean default true, can_do_live_delivery boolean default true, eligibility_status text default 'eligible' check in ('pending','eligible','suspended'), created_at`. RLS: self-service (own `user_id`) + admin.
- New `driver_offers`: `id, route_id uuid nullable, delivery_id uuid nullable references deliveries(id), driver_id references drivers(id), offer_type text check in ('new_route','batch_addition'), payout_amount numeric, distance_impact_km numeric, duration_impact_min numeric, status text default 'pending' check in ('pending','accepted','declined','expired'), expires_at timestamptz, created_at, responded_at`.

**Files**
- `logistics.html` — **extend the existing rep app**, don't build a second one: online/offline toggle, throttled heartbeat submission, and a new "delivery offers" panel next to the existing service-collection job list.
- `netlify/functions/driver-heartbeat.js` (new) — validated/rate-limited location writes.
- `netlify/functions/dispatch-delivery.js` (new) — on `READY_FOR_DISPATCH`, finds online drivers where `last_seen_at > now() - interval '90 seconds'` (reusing §B.1's staleness threshold for consistency), orders by priority first then `ST_Distance` to the pickup (see Patch 1 above), offers to the nearest. **Deliberately does not implement §24's full multi-factor ranking** — nearest-online-eligible-driver (with a priority-first tiebreak) is the entire v1 algorithm, since there are only 2 possible riders.

**Parallelizable units**
- [ ] A: `drivers` + `driver_offers` migrations + RLS (bundle the `Logistics` RLS fix in here too, since this stage adds real write access right next to it)
- [ ] B: `driver-heartbeat.js` + `logistics.html` online-toggle/heartbeat UI
- [ ] C: `dispatch-delivery.js` (depends on A's schema; can be built/tested against fixture rows in parallel with B)
- [ ] D: `logistics.html` offers panel (buildable against stubbed offers while C is in progress)

**Dependencies**: Stage 6 + Stage 7's `READY_FOR_DISPATCH` trigger point. Founder confirmation on rep/driver identity unity should land before Unit A.

**Founder inputs needed**: explicit confirmation that the existing rep accounts (already used for `rep_id`/`assigned_rep_id`/`Logistics.user_id`) are the same 2 people to seed as the first `drivers` rows.

**Concerns/flags**
- §24's full ranking formula is deliberately simplified for the 2-rider pilot per §B.7 — tracked as a named future revisit once a 3rd rider exists, not dropped.
- The `Logistics` table's zero-policy RLS gap is pre-existing and out of this build's original scope, but leaving it broken while adding real driver-auth writes next to it would be irresponsible — fixing it here.

#### Stage 9 — Pickup management

**Migrations**
- New `route_stop_items`: `id, route_stop_id uuid, order_item_id uuid references order_items(id), collected boolean default false, collected_at timestamptz`. This is the product-delivery equivalent of §37/38's individual pickup confirmation, deliberately separate from `order_item_statuses`.

**Files**
- `logistics.html` — pickup checklist (§36): checkbox per `order_item` at a pickup stop; unchecked items stay "not ready" without collapsing the route (§38).

**Parallelizable units**
- [ ] A: `route_stop_items` migration
- [ ] B: `logistics.html` checklist UI (buildable against fixture stop rows before Stage 10 is fully wired)

**Dependencies**: **This genuinely depends on Stage 10's `route_stops` existing first**, despite the original plan numbering Stage 9 before Stage 10 — `route_stop_items.route_stop_id` needs something to reference. Flagging this as a build-order correction: build Stage 10's `route_stops` table before Stage 9's `route_stop_items`, though UI/UX design for Stage 9 can proceed in parallel with Stage 10's backend.

**Founder inputs needed**: none new.

**Concerns/flags**: the sequencing note above is the only issue.

#### Stage 10 — Route and multi-drop system

**Migrations**
- New `routes`: `id, driver_id references drivers(id), status text check in ('created','assigned','started','active','completing','completed'), started_at, completed_at, total_distance_km, total_duration_min, created_at`.
- New `route_stops`: `id, route_id references routes(id), stop_type text check in ('pickup','drop'), seq_order int, seller_id uuid nullable references sellers(id), delivery_id uuid nullable references deliveries(id), location geography(Point,4326), status text check in ('pending','ready','active','arriving','completed','failed','skipped'), arrived_at, completed_at, failed_at, failure_reason text`.
- `deliveries.route_id` FK now populated (column existed nullable since Stage 5).
- **`driver_payouts` table — see Patch 2 above (added in reconciliation, not in Fable's original stage list).**
- RLS: `routes`/`route_stops` readable/writable by the assigned driver's `user_id` + admin; customers never query these directly.

**Files**
- `logistics.html` — ordered stop list, "start route," per-stop arrive/complete actions, Google Maps hand-off link per stop (§41 — explicitly **not** in-app navigation per §B.1).
- `netlify/functions/accept-driver-offer.js` (new) — driver accepts a `driver_offers` row → creates or appends to a `routes`/`route_stops` set, transitions `deliveries.status` via `delivery-state.js`.

**Parallelizable units**
- [ ] A: `routes` + `route_stops` + `driver_payouts` migrations + RLS
- [ ] B: `accept-driver-offer.js` (depends on A + Stage 8's `driver_offers`)
- [ ] C: `logistics.html` route/stop UI (buildable against fixture rows while B is in progress)

**Dependencies**: Stage 8. Blocks Stage 9, Stage 11 (needs routes to insert into), Stage 12 (needs `route_stops` for "customer becomes next stop").

**Founder inputs needed**: payout formula (Patch 2/§C item 7).

**Concerns/flags**: the only issue is the Stage 9/10 ordering note above; otherwise low-risk. This design is exactly what keeps Stage 4's "bundle engine slots in later" property true.

#### Stage 11 — Optional dynamic batch offers

**Migrations**: none beyond `driver_offers` (Stage 8) — `offer_type='batch_addition'` already modeled.

**Files**
- `netlify/functions/evaluate-batch-candidates.js` (new) — for a newly-`READY_FOR_DISPATCH` delivery, checks active routes' driver positions via `ST_Distance`, computes a simplified route-insertion impact (**append-to-end-of-current-stops only** — §33's 3-option insertion comparison is more machinery than 2 riders currently need, flagged as a deliberate simplification), and creates a `batch_addition` offer if under a configurable ETA-impact threshold (§86/132).
- `logistics.html` — batch offer card (§32/129: "Add to route"/"No thanks"), reusing most of Stage 8's offer-card component.

**Parallelizable units**
- [ ] A: `evaluate-batch-candidates.js`
- [ ] B: `logistics.html` batch-offer UI (reuse Stage 8's component)

**Dependencies**: Stage 10 + Stage 8.

**Founder inputs needed**: the ETA-impact threshold number (e.g. "don't offer a batch that would push an existing customer's ETA past +X minutes") — §86/132 explicitly leave this as an operational number for the founder, not something to invent silently.

**Concerns/flags**
- Full route-insertion-point optimization (§33) is simplified to append-only for the pilot — tracked as a named future enhancement once a driver regularly carries 3+ simultaneous stops, not dropped.
- Gate this function to only run when at least one active route exists with fewer than N stops, to avoid excess Google Routes calls as volume grows (trivial at 2-rider scale, worth stating so it isn't forgotten later).

#### Stage 12 — Customer tracking

**Migrations**: none beyond existing (`deliveries.tracking_enabled`, `drivers.last_location`/`last_location_at`).

**Files**
- `track.html` (new, standalone page — matches the repo's existing `shop.html`/`checkout.html` no-shared-module convention): status timeline (§48), PIN display (§45/46) from `deliveries.delivery_pin`, live map gated on `tracking_enabled=true` + this delivery being the active/next `route_stops` entry (§43/118).
- **§B.1's 90-second staleness rule is implemented exactly here**: if `now() - drivers.last_location_at > 90s`, the live-looking marker is replaced with a "last seen Xm ago" state — this is explicitly in scope and must not be treated as optional map polish.
- Live data via Supabase Realtime subscription scoped to this customer's own delivery, with periodic revalidation as backup (§69–71).
- `index.html` + `script.js` — homepage widget (§49–50/91) with a "Track order" link; per the existing constraint that `script.js` only loads on `index.html`, this logic belongs there, not in a new shared module.

**Parallelizable units**
- [ ] A: `track.html` shell + timeline + PIN display (buildable against fixture delivery states — good candidate for the `frontend-design` skill given §51/56's explicit "premium, not cartoon" brand direction)
- [ ] B: `track.html` live map + Realtime + staleness logic (depends on Stage 8/10 having real data)
- [ ] C: RLS scoping `deliveries`/`route_stops`/`drivers` visibility to the tracking customer — security-critical, review independently of A/B
- [ ] D: `index.html`/`script.js` homepage widget — fully independent, only needs `deliveries.status`
- [ ] E: SVG/animation system for state-based illustrations (§52–53/93) and the easter-egg framework (§55/94–95) — independent visual asset work, explicitly a pluggable "state → animation" map so future eggs slot in without touching tracking logic. **Accessibility note (§54, folded in here): every animation needs a `prefers-reduced-motion` fallback that conveys the identical information statically — this is part of Unit E's definition of done, not a separate task.**

**Dependencies**: Stage 6, Stage 8, Stage 10. Independent of Stage 9/11.

**Founder inputs needed**: none new (design direction only).

**Concerns/flags**
- A naive Realtime subscription to "all `route_stops` for this route" to show route progress would leak other customers' delivery existence/sequence to this customer — violates §118's separation and CLAUDE.md's data-ownership rule. Subscribe only to this delivery's own row plus the minimal `route_stops`/`drivers` fields needed for the map, never the full stop list.

#### Stage 13 — PIN delivery confirmation

**Migrations**: `deliveries.pin_attempt_count int default 0`, `deliveries.pin_locked_at timestamptz nullable` (rate-limiting, see concern below).

**Files**
- `netlify/functions/confirm-delivery-pin.js` (new, service-role, security-critical) — single transaction: verifies requesting driver owns the active stop, delivery is in an arriving-eligible state, PIN matches. On match: `delivery-state.js` → `DELIVERED`, sets `delivered_at`, completes the `route_stop`, advances the route, logs the event, triggers Stage 14's notification (and Stage 13b's feedback prompt eligibility — see Patch 3) — matching §66's atomicity requirement exactly. On mismatch: increments `pin_attempt_count`, logs a failed-attempt event, returns "PIN INCORRECT" without changing state (§163); after 5 failed attempts, sets `pin_locked_at` and surfaces an admin-intervention exception (§81's "Failed PIN" category).
- `logistics.html` — PIN entry UI (§65).

**Parallelizable units**
- [ ] A: `confirm-delivery-pin.js` — atomicity/security-critical, **not** a good split-into-pieces candidate; build and review as one unit
- [ ] B: `logistics.html` PIN UI (buildable against a stubbed response)

**Dependencies**: Stage 6, Stage 10.

**Founder inputs needed**: none new.

**Concerns/flags**
- The 5-attempt lockout is Fable's addition beyond the plan's literal text (§163 only says "log the failed attempt" and defers limiting to "a future rule"). A 4-digit PIN with unlimited guesses is a real, cheap-to-fix security gap — building the limit now rather than deferring it, consistent with the project's general security posture.

*(Stage 13b — Delivery feedback — inserted here per Patch 3 above; not in Fable's original numbering.)*

#### Stage 14 — Notification system

**Migrations**
- New `notification_log`: `id, delivery_id references deliveries(id) nullable, order_id uuid nullable, recipient_id uuid, event_type text (§60), channel text check in ('email','in_app'), status text check in ('sent','failed'), provider_message_id text, sent_at, created_at`. Unique constraint on `(coalesce(delivery_id,order_id), event_type, channel)` for dedup (§111/169).

**Files**
- `netlify/functions/lib/notify.js` (new, shared) — central `notify(event_type, id, context)`: dedup-checks `notification_log`, sends via Resend (reusing the existing pattern from `send-referral-email.js`/`send-engagement-email.js`), logs the attempt. Called from `delivery-state.js` on relevant transitions — keeps triggering centralized per §168, not scattered across dispatch/pickup/PIN functions.
- `send-on-the-way.js` — audit-flagged as reusable; **reconcile, don't duplicate**: generalize it into (or have it call) `lib/notify.js`'s on-the-way template rather than maintaining two separate "on the way" email code paths for services vs. product delivery. This is a direct match for CLAUDE.md's "fix duplicate stuff looking at the same info" rule.

**Parallelizable units**
- [ ] A: `notification_log` migration
- [ ] B: `lib/notify.js` core + §57–59 copy (in-app vs. email tone split)
- [ ] C: `send-on-the-way.js` reconciliation — small but should be done by whoever understands its current service-collection usage, to avoid breaking that live path; extend/wrap, don't rewrite

**Dependencies**: Stage 6. Resend already wired (no founder input needed).

**Founder inputs needed**: none new.

**Concerns/flags**: reconciling `send-on-the-way.js` now (rather than leaving two parallel "on the way" email systems) is a direct CLAUDE.md compliance action, not scope creep.

#### Stage 15 — Homepage active-delivery widget

Substantially delivered by Stage 12/Unit D; kept as its own stage for tracking per original numbering.

**Migrations**: none new. **Files**: `index.html`, `script.js` polish (§50's per-state copy, disappear/transform-after-delivery behavior).

**Parallelizable units**: single unit, cosmetic polish atop Stage 12's plumbing.

**Dependencies**: Stage 12 functionally complete.

**Founder inputs needed**: none. **Concerns/flags**: none significant.

#### Stage 16 — Admin operations dashboard

**Migrations**: none new — reads existing tables.

**Files**
- `admin.html` — LIVE OPERATIONS (map reusing `track.html`'s map logic where practical), DELIVERIES (list + `delivery_events` timeline drill-in), RIDERS (`drivers` + status + current route), pricing config editor (`delivery_pricing_config` CRUD — **new version row on every save, never mutate a version already referenced by a locked quote**, so historical orders stay accurate against the version they were quoted under), service zones editor (Stage 2's `service_zones`), exceptions/issues view (§81's category list, sourced from `delivery_events` + `pin_locked_at` + unaccepted `driver_offers`, **extended per Patch 3 to include `delivery_feedback`/complaints**).

**Parallelizable units**
- [ ] A: Live operations map (needs `drivers.last_location`, `route_stops`)
- [ ] B: Deliveries list + timeline drill-in (needs `deliveries`, `delivery_events`)
- [ ] C: Riders panel (needs `drivers`)
- [ ] D: Pricing config editor (needs `delivery_pricing_config`)
- [ ] E: Service zones editor (needs `service_zones`)
- [ ] F: Exceptions + feedback view (needs `delivery_events`, `driver_offers`, `delivery_feedback`)

Six genuinely independent units touching disjoint `admin.html` sections and disjoint tables — the strongest parallelization opportunity in the whole plan.

**Dependencies**: everything from Stage 2 onward. Built last for real.

**Founder inputs needed**: confirmation `admin.html`'s existing role-check pattern (likely `Logistics.role='admin'`) is the one to reuse — don't invent a second admin-auth check.

**Concerns/flags**: none beyond the pricing-version-immutability note above.

#### Stage 17 — Analytics / optimisation

**Migrations**: prefer Postgres views over new tables for route-profitability-style aggregates (§100), computed from `deliveries`/`routes`/`driver_payouts`/`notification_log` — avoids duplicating data per CLAUDE.md.

**Files**: `admin.html` analytics section (§99–100, §143–144).

**Parallelizable units**: per-metric views, independently addable.

**Dependencies**: needs real operational data from Stages 5–14 live to be meaningful. Naturally last, and — per §B.7's scale-reality-check and §187's own MVP list, which already excludes "advanced analytics" — should be treated as explicitly post-pilot-validation, not part of the Isqalo launch checklist.

**Founder inputs needed**: none for pilot; revisit once volume exists.

**Concerns/flags**: none — correctly sequenced last by both the original plan and the founder's own guidance.

#### File/path reference summary
- Existing files touched: `checkout.html`, `profile.html`, `seller-dashboard.html`, `admin.html`, `logistics.html`, `index.html`, `script.js`, `netlify/functions/validate-cart.js`, `netlify/functions/send-on-the-way.js`
- New Netlify functions: `geocode-address.js`, `check-service-zone.js`, `get-delivery-quote.js`, `mark-order-ready.js`, `driver-heartbeat.js`, `dispatch-delivery.js`, `accept-driver-offer.js`, `evaluate-batch-candidates.js`, `confirm-delivery-pin.js`, `netlify/functions/lib/delivery-state.js`, `netlify/functions/lib/notify.js`
- New page: `track.html` (standalone, no shared JS module, per repo convention)
- Files explicitly never touched: `netlify/functions/payfast-itn.js`, `netlify/functions/generate-payfast-signature.js`, `netlify/functions/charge-payfast-token.js`

---

## F. Stage 2 — what actually shipped (2026-09-17)

Built directly (migrations, `checkout.html`) plus three parallel subagents on genuinely disjoint files (`check-service-zone.js`, `seller-dashboard.html`, `admin.html`) — each verified independently (syntax-checked, RLS assumptions confirmed against real `pg_policies`, PayFast files confirmed untouched) before being accepted.

**Migrations (live in Supabase, project `ojwnjtcxbitwmtlsbjnx`):**
- `profiles`: `delivery_pin` (backfilled for all 31 existing profiles), `delivery_instructions`, `saved_address_geo`, `saved_address_place_id`.
- `sellers`: `pickup_geo`, `pickup_place_id` (present but unused — Photon doesn't provide place_ids the way Google does), `pickup_confirmed_at`.
- `orders`: `destination_geo`, `destination_place_id`, `delivery_instructions`, `address_validated_at`.
- New `service_zones` table + RLS (public read, admin-only write via the `admins` table — **not** `Logistics`, confirmed unused anywhere else in the codebase; deprioritized fixing its RLS gap since it isn't actually load-bearing for anything).
- Two RPC helper functions: `find_service_zone_for_point(lat, lon)` (used by `check-service-zone.js`) and `upsert_service_zone_circle(...)` (used by `admin.html`'s zone editor to build a circular polygon from center+radius without raw PostGIS in JS).
- **Note for future PostGIS migrations on this project:** PostGIS types live in the `extensions` schema, not `public` — any new `SECURITY DEFINER` function using geometry/geography types needs `set search_path = public, extensions` or it'll fail with `type "geometry" does not exist`.

**Files:**
- `checkout.html`: the existing free Photon autocomplete now also captures the picked suggestion's coordinates (`state.destinationGeo`), invalidates them if the address is hand-edited afterward, and writes `destination_geo`/`address_validated_at`/`delivery_instructions` (reusing the existing order-notes field's value rather than adding a second free-text box) into the order insert. Verified live: typed "Varsity Drive Westville" → picked the real Photon suggestion → `state.destinationGeo` populated with real coordinates → manually appending text to the field correctly cleared it again.
- `profile.html`: same Photon pattern added for the saved address field, plus a new "Your Delivery PIN" card displaying `profiles.delivery_pin`, plus a delivery-instructions textarea. Saves are non-destructive — editing name/phone without touching the address field doesn't blank out previously-saved coordinates.
- `seller-dashboard.html`: new "Pickup Address" section in the shop-settings panel — search, pick, confirmed instantly (no separate save button, matching plan §9's "seller only confirms" framing), with a "Change" action to redo it.
- `admin.html`: new "Service Areas" section — create/edit zones by center+radius (calls `upsert_service_zone_circle`), list/toggle-active/delete, gated by the same `isAdminAuthenticated()` UX check every other admin write uses (real enforcement is the RLS policy).
- `netlify/functions/check-service-zone.js` (new): public POST endpoint, `{lat, lon}` → `{eligible, zone_id, zone_name, zone_type}` or `{eligible:false, reason: "..."}` using plan §20's exact wording. Uses the anon key (public read-only check), not the service role.

**One tracked gap, not blocking:** `sellers` has no formatted-address *text* column — only `pickup_geo` (coordinates). `seller-dashboard.html` shows the real address text right after a fresh pick, falling back to a same-device `localStorage` echo (never treated as source of truth) or plain "✓ Address confirmed" on a fresh session elsewhere. This will matter once Stage 16 (admin ops) or Stage 8 (dispatch) needs to *display* a pickup address as readable text — revisit then with a proper `pickup_address_text` column rather than adding one speculatively now.

**Verified NOT touched:** `payfast-itn.js`, `generate-payfast-signature.js`, `charge-payfast-token.js` — confirmed via `git status` across the whole Stage 2 diff.

---

## G. Stage 3 — what actually shipped (2026-09-17)

Built directly (migrations, `validate-cart.js`, `checkout.html`) plus one parallel subagent (`get-delivery-quote.js`, the largest single new file in the build so far — 414 lines) — verified independently (syntax-checked, reviewed line-by-line including its custom EWKB point parser, confirmed no PayFast files touched, confirmed `node-fetch` is a real project dependency) before being accepted.

**Migrations (live):**
- `delivery_pricing_config`: one active row (version 1), seeded with the founder-confirmed R36 tariff (§B item 4) — `distance_tiers` exactly as specified, plus a placeholder `extended_zone_fee` (R100, same as the last named tier) for the plan's unspecified "20km+ → extended-zone logic" case, admin-editable once Stage 16 ships. Public read, admin-only write.
- `delivery_quotes`: locked pre-payment quotes, service-role-writable only, customers can read their own.

**Files:**
- `netlify/functions/get-delivery-quote.js` (new): the actual pricing engine. Checks service-zone eligibility *before* calling the (paid) Google Routes API. Refuses multi-seller carts with the plan's exact §20 wording (tracked `TODO(bundle-engine)`, unreachable today). Ports `validate-cart.js`'s existing fee-calculation supporting logic (per-seller surcharge, free-delivery exclusion/threshold, bulk-quantity stepping, custom per-product override, max-fee cap) verbatim, swapping only the base-fee source from class lookup to distance-tier lookup. Never falls back to straight-line distance on a Routes API failure — hard errors instead, per plan §11. Currently returns a clear, specific 500 ("missing GOOGLE_ROUTES_SERVER_KEY") until that key is added — code-complete, not live.
- `validate-cart.js`: now accepts an optional `quoteId`. When present and the referenced quote is still active, unexpired, and belongs to the requesting customer (or is a guest quote), its `total_delivery_fee` becomes the authoritative `fees.total` instead of the existing `computeFees()` recomputation. Falls through to today's exact unchanged behavior whenever no quote is supplied or it doesn't check out — fully backward compatible, verified by reading the diff against a fresh checkout of the untouched fallback path.
- `checkout.html`: opportunistically requests a quote the moment a real address is picked (via the Photon autocomplete already wired in Stage 2), storing `state.deliveryQuoteId` only on success. **Deliberately non-blocking** — any failure (missing key today, network error, ineligible address, anything) leaves `deliveryQuoteId` null and checkout proceeds exactly as before. Verified live: picked a real address, confirmed `state.deliveryQuoteId` correctly stayed null (no function exists to call yet in the local harness), confirmed the order summary rendered the identical R22/R121 figures as every prior test this session — Stage 3 changes nothing observable about the live site until the Google key lands.

**Verified NOT touched:** `payfast-itn.js`, `generate-payfast-signature.js`, `charge-payfast-token.js`.

---

## H. Stage 5 — what actually shipped (2026-09-17)

Built entirely directly (migrations, `checkout.html`) — no subagent, since this is the stage the plan itself flagged as highest-risk relative to the PayFast "do not touch" rules and warranting hands-on handling.

**A real bug caught during design, not left for later:** while verifying the trigger's assumptions, found that `orders.order_status` is also set to `'paid'` by `complete-seller-enrollment.js` — a completely separate flow (seller-enrollment fee payments) sharing the same `orders` table via a genuine `UPDATE` statement. A naive "create a delivery on any order_status→paid transition" trigger would have created phantom `deliveries` rows for seller-enrollment payments, which have no cart, no destination, nothing to deliver. Fixed by gating the trigger on `delivery_quote_id IS NOT NULL` — which also happens to directly encode the plan's own §2 principle ("delivery must be evaluated before payment"): no quote means delivery was never evaluated, so correctly, no delivery job gets created.

**Migrations (live, and tested directly in the database, not just reasoned about):**
- `orders`: `delivery_quote_id`, `priority_fee`.
- New `deliveries` table (one row per order that went through a real quote) + RLS (customer reads their own; guest/tracking-page access is an explicitly deferred Stage 12 concern, not solved here).
- `create_delivery_on_payment()` trigger function + `trg_create_delivery_on_payment` (`AFTER UPDATE OF order_status`, `WHEN (NEW.order_status = 'paid' AND OLD IS DISTINCT FROM 'paid')` — fires only on the actual transition, not on every retry that re-sets the same value). PIN generation matches the plan's corrected design (Fable's Stage 5 note): copies the customer's `profiles.delivery_pin` if signed in, else generates a fresh 4-digit PIN — works identically for guests.
- **Verified with a real transactional test, not just code review:** inserted a synthetic seller-enrollment-shaped order and confirmed no `deliveries` row was created; inserted a synthetic quoted product order and confirmed a correct `deliveries` row was created (real PIN, `status='PENDING'`); re-fired the UPDATE to simulate a PayFast ITN retry and confirmed no duplicate row (`on conflict (order_id) do nothing` + the `WHEN` clause's natural no-op on a same-value re-set). All test data cleaned up afterward — confirmed zero leftover rows.

**Files:**
- `checkout.html`: `validateCheckout()` now tracks `state.appliedDeliveryQuoteId` — set **only** when the server's response (`result.quoteApplied`) confirms it actually used that quote, never from the client's own optimistic `state.deliveryQuoteId`. The order insert writes this (not the raw client-side quote id) into `delivery_quote_id`, so a stale/rejected/mismatched quote id can never reach the trigger. Verified directly: simulated both a server-confirmed-applied response and a server-rejected response, confirmed `state.appliedDeliveryQuoteId` came out correct in both cases.

**Verified NOT touched:** `payfast-itn.js`, `generate-payfast-signature.js`, `charge-payfast-token.js`. `complete-order-payment.js` was read for reference only (confirming the trigger's `UPDATE`-based assumption), never edited.

---

## I. Stage 6 — what actually shipped (2026-09-17)

Built entirely directly, no subagent (small, tightly-coupled: the enum values, the auto-logging triggers, and the JS transition map all have to agree with each other exactly — not a good split-across-agents task).

**Migrations (live, verified with a real transactional test):**
- `delivery_status` Postgres enum, 16 states from plan §112 verbatim. `deliveries.status` retyped to it (safe — table had 0 rows).
- New `delivery_events` table (append-only, RLS scoped to the owning customer).
- `trg_log_delivery_created` (`AFTER INSERT ON deliveries`) and `trg_log_delivery_status_change` (`AFTER UPDATE OF status`, only fires on an actual value change) — together mean **every** delivery's timeline has a real starting point and **every** status change is captured, regardless of which future code path causes it.
- **Verified directly in the database:** creation logged exactly once; a real status change logged exactly once; re-setting the same status value again correctly did *not* double-log; an invalid enum value was correctly rejected by Postgres itself (`invalid_text_representation`), not just by application code. All test data cleaned up, confirmed zero leftover rows.

**Files:**
- `netlify/functions/lib/delivery-state.js` (new, shared): `TRANSITIONS` map (allowed next-states per current state — generous on the exception paths CANCELLED/FAILED/REASSIGNING per plan §81/82, since real operational exceptions need that flexibility; explicitly designed to get corrected as Stages 7-13 actually exercise it, not treated as final) and `transitionDelivery(supabase, deliveryId, toStatus, actor, options)` — validates the transition, applies an optimistic-concurrency guard (`UPDATE ... WHERE status = <the status just read>`, so two racing callers can't both silently succeed), sets the relevant timestamp columns (`dispatched_at`/`delivered_at`/`cancelled_at`) automatically, and optionally logs a specific named event with actor attribution on top of the database's own automatic generic logging.
- **Verified with an 11-assertion logic test** (mocked Supabase client, not committed — scratch-only): valid transition succeeds and returns the updated row; invalid transition rejected without touching the DB; a simulated concurrent status change surfaces as an explicit `conflict`, never silently ignored; a named event gets logged with the correct `event_type`/`actor_type`/`actor_id`; an invalid `actor.type` is rejected before any DB call. All 11 passed.

**A deliberate design note worth remembering:** a wrong PIN entry (plan §163) must never change delivery status at all — enforced simply by `PIN_REQUIRED` not listing itself as a valid destination in its own transition list. Stage 13's PIN-confirmation function must only call `transitionDelivery()` on an actual match, never on a failed attempt (which should instead just increment a retry counter directly).

**Verified NOT touched:** no PayFast file, `checkout.html`, or `validate-cart.js` were touched this stage.

---

## J. Stage 7 — what actually shipped, and a real design correction (2026-09-17)

Built entirely directly, no subagent — this stage's whole value came from tracing existing, subtle logic correctly, not from writing a lot of new code.

**The correction:** Fable's original Stage 7 plan called for a new "Mark ready" button/UI and a new function checking `order_items.fulfillment_status`. Investigating before building surfaced two things that changed the design:
1. `order_items.fulfillment_status` is **genuinely dead** — no CHECK constraint exists on it, and all 46 existing rows are still `'pending'`; nothing in the codebase writes anything else to it, ever.
2. `seller-dashboard.html` already has a real, working, **multi-seller-aware** fulfillment mechanism (`updateOrderFulfillment()`) that derives `orders.order_status` from every seller's own `order_item_statuses` rows on a shared order — specifically built so one seller's update can't clobber another seller's already-recorded progress. This is exactly the "all sellers on this order must be ready" problem Stage 7 needed to solve, already solved.

Building a second, parallel "ready" mechanism next to this would have been precisely the kind of duplication `CLAUDE.md` calls out. Instead, Stage 7 hooks one small server-side call into the *existing* mechanism's already-correct aggregation point.

**Files:**
- `netlify/functions/advance-delivery-on-fulfillment.js` (new): takes `{orderId}`, looks up whether a `deliveries` row exists for it (most orders won't yet — no Google key means no quote ever succeeded), and if it's still `PENDING`, calls Stage 6's `transitionDelivery()` to move it to `READY_FOR_DISPATCH`. A conflict (another concurrent call already advanced it) or an already-advanced delivery are both treated as a success/no-op, not an error.
- `seller-dashboard.html`: `updateOrderFulfillment()` now calls this function, fire-and-forget, immediately after it derives `orders.order_status` — only when that derived status is `'Fulfilled'` or `'Delivered'`. Deliberately non-blocking, matching every other opportunistic hook in this build: a failure here can never break the existing "order status updated" flow that already succeeded.

**Verified end-to-end in the database** (order → paid → Stage 5's trigger creates a `PENDING` delivery → the exact transition this function performs → `READY_FOR_DISPATCH`), the first test this build that exercises Stages 5, 6, and 7 together rather than each in isolation. All cleaned up, zero leftover rows.

**Verified NOT touched:** no PayFast file, `checkout.html`, or `validate-cart.js`.

---

## K. Stage 8 — what actually shipped, two real security gaps caught, and one real data gap discovered (2026-09-17)

Built via two genuinely parallel subagents (backend dispatch/offer functions; the `logistics.html` rider panel) working against contracts I specified — the first stage since Stage 2 with zero file overlap between work streams. Both reviewed in full afterward, not just trusted.

**Migrations (live):** `drivers` (self-registers on first heartbeat — "same accounts as reps for now" per founder decision, kept structurally independent so a future non-rep rider is just a new row) and `driver_offers`, plus `find_nearest_eligible_drivers(seller_id, max_age_seconds)` (nearest-first ranking, 90s staleness matching the customer-tracking rule) and a partial unique index preventing two concurrent dispatch attempts from double-offering the same delivery.

**Files:**
- `netlify/functions/lib/dispatch.js` (new): `dispatchDelivery()` — checks READY_FOR_DISPATCH, no existing pending offer, a usable quote (multi-seller carts correctly refused, same tracked TODO as Stage 3), the seller's pickup location, finds the nearest eligible online driver, creates the offer, transitions to `OFFERED`. Rolls back the offer if the transition fails, so `driver_offers` can never show a live pending row against a delivery that didn't actually move. Payout is an explicitly-commented placeholder (75% of the quoted fee) pending the founder's real formula.
- `netlify/functions/driver-heartbeat.js`, `netlify/functions/respond-to-driver-offer.js`, `netlify/functions/dispatch-delivery.js` (new) — reviewed in full; correct identity verification (never trusts a client-supplied driver/user id), correct optimistic-concurrency guards on offer acceptance, correct rollback-on-partial-failure.
- `advance-delivery-on-fulfillment.js` (Stage 7, extended): now calls `dispatchDelivery()` inline, same request, immediately after a delivery reaches `READY_FOR_DISPATCH` — a seller marking an order fulfilled can reach an actual driver offer with no separate cron needed for this pilot's scale. Still fully non-blocking on dispatch failure.
- `logistics.html`: new "Delivery" panel (online/offline toggle, 30s heartbeat while online, 10s offer polling, accept/decline). Verified purely additive (`git diff`: 221 insertions, 0 deletions) and that the one edit to existing code (`showPanel()`, to stop polling when navigating away) didn't touch any other panel's behavior.

**Two real security gaps caught and fixed during my own verification (not in either subagent's own self-testing):**
1. `find_nearest_eligible_drivers` was directly callable via `/rest/v1/rpc/` by `anon`/`authenticated` despite the building agent's own `REVOKE FROM PUBLIC` — Supabase grants new public-schema functions to those roles separately from `PUBLIC`, so revoking from `PUBLIC` alone doesn't touch it. This exact gotcha is already recorded in this project's own memory from an earlier session; caught it again here anyway. Fixed: `REVOKE ... FROM anon, authenticated, public; GRANT ... TO service_role`. This function reveals which drivers are online and their distance from a seller — real information to keep locked down.
2. **My own** Stage 5/6 trigger functions (`create_delivery_on_payment`, `log_delivery_created`, `log_delivery_status_change`) had the identical gap — I made the same mistake I'd documented from a prior session. Caught via a full `get_advisors` security sweep after Stage 8 landed, fixed the same way. Trigger firing itself was re-verified unaffected by the permission change (full Stage 5→6→7 chain re-tested after the fix).
Also tightened `upsert_service_zone_circle` (Stage 2, mine) with a pinned `search_path` — a lower-severity advisor finding, fixed while already doing a security pass on this build.

**One real data gap discovered by testing, not by inspection:** the full dispatch chain couldn't be tested at all until it surfaced that `sellers.pickup_geo` for Isqalo is still `NULL` — nobody has actually used Stage 2's pickup-address UI yet. Set a clearly-commented placeholder (the same campus coordinate already used as this build's Photon search-bias point) so testing could proceed — **flagged in §C item 3b, needs your confirmation**. This also means Stage 3's quote pricing has the same unmet prerequisite, not just Stage 8 — worth using the real UI (or giving me the address directly) before either goes live.

**Verified end-to-end in the database** (not just per-file): `find_nearest_eligible_drivers` returning the right driver; the full `READY_FOR_DISPATCH → offer created → OFFERED → accepted → ASSIGNED` chain; the partial unique index correctly blocking a concurrent duplicate offer; the full `delivery_events` timeline populated correctly throughout. All test data cleaned up, confirmed zero leftover rows across `drivers`/`driver_offers`/`deliveries`/`orders`/`delivery_quotes`.

**Verified NOT touched:** no PayFast file, `checkout.html`, `validate-cart.js`, or `seller-dashboard.html`.

---

## L. Stages 9+10 — routes, pickup checklist, and two more gaps caught (2026-09-17)

Built in the corrected dependency order (routes/route_stops before route_stop_items, per §E's own reconciliation note). Backend and route-creation logic built directly (extends the payment-adjacent accept flow); the route/pickup UI delegated to one subagent, working against a precise contract — then two more real gaps found and fixed during my own review of its report, same pattern as every stage since Stage 5.

**Migrations (live, tested end-to-end including full route completion and payout computation):** `routes`, `route_stops`, `route_stop_items` (Stage 9's pickup checklist, deliberately separate from the existing `order_item_statuses` service-collection machinery), `driver_payouts` (finally created — referenced since Stage 8's plan but never actually built until now), and a trigger that computes the payout the moment a route completes (still the Stage 8 placeholder 75%-of-quoted-fee formula, locked down correctly from the start this time — no advisor finding, unlike Stage 8's first pass).

**Files:**
- `respond-to-driver-offer.js` (extended): accepting an offer now creates the actual route + 2 stops (pickup, drop), links them back to the delivery and the offer (for payout summing later). Treated as part of accepting, not best-effort — if route creation fails, the whole acceptance rolls back rather than leaving a driver "assigned" with nothing to do.
- `netlify/functions/advance-route.js` (new): the four driver actions — start route, complete pickup (handles partial pickup correctly per plan §38, doesn't collapse the stop), start the delivery leg, arrive at drop. **Deliberately stops at `ARRIVING`/`PIN_REQUIRED`** — nothing in this build may mark a delivery `DELIVERED` outside of PIN confirmation (design principle #10), so this is the correct, planned dead end until Stage 13 exists, not a gap.
- `logistics.html`: the route/pickup UI, extending Stage 8's "Delivery" panel rather than adding a new one.

**Two more real gaps caught during my own review, not self-reported by the building agent:**
1. **Driver read access to `deliveries`/`order_items` was entirely missing** — caught this while briefing the UI agent (before it even started), fixed with two new RLS policies mirroring the existing `route_stops_select_own` pattern. This "worked" by pure accident today only because the pilot's two test drivers are also admins (who have broad access via unrelated policies) — it would have silently broken the moment a real non-admin driver was added, directly contradicting this whole build's "a future rider is just a new row" design goal. The UI agent's own report (written before my fix landed, a genuine timing race between two things happening in parallel) still described this as an open blocker and had built a working fallback/honest-error-state around it — that fallback stays in the code as defense-in-depth even though the real fix means it shouldn't trigger anymore.
2. **`route_stops.location` (PostGIS geography) is not usable from the browser** — confirmed by the UI agent hitting the real API directly (not assumed): it comes back as raw EWKB hex over PostgREST, not coordinates. No lat/lon-returning function existed. Added `get_route_stop_coordinates()` (`SECURITY INVOKER` — the caller's own RLS on `route_stops` applies automatically inside it, so no separate ownership check was needed) and rewired both stops' "Navigate" links to use it. This also fixed a real product gap the UI agent had explicitly flagged and left unfixed: there was no "Navigate to customer" link at all for the drop stop (only the pickup stop had a text-address fallback available) — now both stops have a reliable, coordinate-based Maps link.

**Verified end-to-end in the database** (not per-file): the full `start_route → partial pickup → full pickup → start_delivery → arrive_at_drop` action sequence, using two real order_items and confirming partial pickup correctly does NOT collapse the route or advance past `PARTIALLY_PICKED_UP`; the earlier full dispatch→accept→route→complete chain including automatic payout computation (verified the exact payout amount, not just that a row appeared); explicit confirmation the delivery can never reach `DELIVERED` through this stage's code. `get_route_stop_coordinates()` verified against a real inserted point (exact lat/lon match). All test data cleaned up every time, zero leftover rows confirmed after each run.

**Verified NOT touched:** no PayFast file, `checkout.html`, `validate-cart.js`, `seller-dashboard.html`, or `admin.html`.

---

## D. Original plan (verbatim, as pasted by founder 2026-09-17)

> Preserved in full below for reference. Do not edit — record any changes as new entries in §B instead.

# Umzila Delivery Network

## Full System, Routing, Bundling, Rider, Tracking, Notification and Operations Plan

---

# 1. The vision

Umzila should eventually have a delivery infrastructure that feels more polished than a normal marketplace courier system while remaining simple enough that customers never need to understand how complicated it is underneath.

The customer should feel:

> "Umzila knows where my order is, tells me what is happening, gives me a clear ETA, and makes the whole process feel smooth."

The seller should feel:

> "I prepare the order and Umzila takes care of the rest."

The rider should feel:

> "I know exactly what I'm collecting, where I'm going, what I'll earn, and what to do next."

The admin should feel:

> "I can see and intervene in the entire network."

The system should therefore be divided into four experiences:

```text
                         UMZILA DELIVERY NETWORK
                                  │
             ┌────────────────────┼────────────────────┐
             │                    │                    │
         CUSTOMER               RIDER                SELLER
             │                    │                    │
       Simple updates        Clear jobs/routes    Prepare orders
       ETA / tracking        Pickup / dropoff     View delivery
       Delivery PIN          Earnings             Feedback
             │                    │                    │
             └────────────────────┼────────────────────┘
                                  │
                              ADMIN
                                  │
                    Full operational control
```

The fifth component is the invisible engine underneath all of them:

```text
                 ┌───────────────────────────┐
                 │   UMZILA LOGISTICS ENGINE  │
                 │                           │
                 │ Address Validation        │
                 │ Service Areas             │
                 │ Routing                   │
                 │ Delivery Pricing          │
                 │ Cart Bundling             │
                 │ Dispatch                  │
                 │ Route Optimisation        │
                 │ Rider Payout              │
                 │ Notifications             │
                 │ Tracking                  │
                 │ PIN Verification          │
                 │ Analytics                 │
                 └───────────────────────────┘
```

---

# 2. The most important architectural principle

Delivery must be evaluated **before the customer pays**.

The incorrect sequence would be:

```text
Customer pays
   ↓
Umzila figures out delivery
   ↓
Maybe finds a rider
```

That creates problems.

The correct sequence is:

```text
Customer enters address
        ↓
Address is validated
        ↓
Umzila determines service eligibility
        ↓
Cart is evaluated for delivery/bundling
        ↓
Road routes are calculated
        ↓
Delivery fee is calculated
        ↓
Optional priority is calculated
        ↓
Customer sees final total
        ↓
Customer pays
        ↓
Delivery job is created
        ↓
Rider dispatch begins
```

The customer therefore never pays for an order without Umzila already knowing that it can deliver it under the current rules.

---

# 3. Customer experience philosophy

The customer does **not** need to know:

* how many stores the rider is visiting
* how many other customers are on the route
* how the route was optimised
* how much the rider is being paid
* whether Umzila saved money through batching
* which routing provider was used
* what the delivery-zone algorithm decided
* why a different rider was considered
* internal service-area boundaries
* route scores
* bundle compatibility calculations

None of that increases customer satisfaction.

The customer needs to know:

**Can you deliver to me?**

**How much is delivery?**

**When should I expect it?**

**What is happening now?**

**Is someone actually on the way?**

**How do I know when it has arrived?**

That is the experience we should optimise.

---

# 4. Address entry

Address collection starts the logistics process.

The customer sees:

```text
Deliver to

[ Start typing your address... ]
```

As they type, Umzila should provide recognised address/place suggestions.

For example:

```text
12 Example Road, Durban
12 Example Road, Berea, Durban
12 Example Road, Morningside, Durban
```

The customer selects one.

The system stores a structured address rather than trusting arbitrary text.

Conceptually:

```text
Customer input
      ↓
Address suggestion
      ↓
Customer selects
      ↓
Validated geographic location
      ↓
Latitude / Longitude
      ↓
Delivery engine
```

Google's Places and Address Validation services are suitable building blocks for this kind of flow. The exact API implementation should be decided after inspecting the current project and choosing the appropriate Google products and restrictions.

---

# 5. Don't rely on postal code alone

Postal code should **not** be the main delivery restriction mechanism.

A postal code is too broad.

A single postal area can cover locations that differ considerably in actual road accessibility and operational suitability.

Instead, Umzila should use:

### Primary method

**Geographical coordinates + service-area polygons/geofences**

### Supporting information

**Postal code, suburb, city and address components**

So the logic becomes:

```text
Address
 ↓
Coordinates
 ↓
Which Umzila service polygon contains this point?
 ↓
Is that zone active?
 ↓
Distance / route rules
 ↓
Deliverable?
```

Postal code can still be stored and used as an additional rule.

It just shouldn't be the only rule.

---

# 6. Service areas

Umzila should have an internal service-zone system.

Rather than saying:

> Durban = deliver

we define operational coverage.

For example:

```text
                         UMHLANGA
                       ┌───────────┐
                       │ APPROVED  │
                       │ EXTENDED  │
                       └───────────┘


              ┌───────────────────────────┐
              │                           │
              │       CORE ZONE           │
              │      DURBAN AREA          │
              │                           │
              │           ● SHOP          │
              │                           │
              │                           │
              └───────────────────────────┘


                         HILLCREST
                       ┌───────────┐
                       │ APPROVED  │
                       │ EXTENDED  │
                       └───────────┘
```

There should be no requirement that every approved destination must physically lie within one simple circle.

Instead Umzila can maintain:

### Core zones

Normal service.

### Extended approved zones

Outside the core radius but explicitly serviced.

### Restricted/unavailable zones

Currently not serviced.

This allows Umzila to expand coverage safely without rewriting the delivery system.

---

# 7. The 10 km principle

For the initial Isqalo implementation, a reasonable design assumption is:

**approximately 10 km as the normal operating envelope**

but that does not necessarily mean:

> a hard 10 km circle and nothing beyond it.

Instead:

```text
Normal area
       ↓
Road / geographic evaluation
       ↓
Inside normal service rules?
       ↓
YES → continue

Outside?
       ↓
Check approved extended service zone
       ↓
YES → continue

NO → unavailable
```

This is much more flexible.

Hillcrest or Umhlanga could therefore be explicitly approved even if they fall outside the normal local area.

---

# 8. Safety and restricted areas

Umzila should not automatically decide that an entire neighbourhood is "unsafe" based on its name.

That would be both technically unreliable and unnecessarily blunt.

Instead, Umzila should maintain operational coverage based on its own delivery policies and continually review those zones.

The system can use:

* service polygons
* road-accessibility rules
* maximum route distance
* delivery success rates
* incident history
* operational decisions
* rider availability

The important technical principle is:

> **The delivery engine should check whether a coordinate is inside an approved operating zone, not make a social judgement about a neighbourhood.**

An admin should be able to modify service zones without changing code.

---

# 9. Store address

A seller only needs to enter:

## Pickup address

```text
Isqalo Shisanyama

[ Search address ]

✓ Address confirmed
```

Umzila stores:

```text
store_id
formatted_address
latitude
longitude
place_id
```

That becomes the origin for routing.

The seller does **not** choose:

* delivery price
* delivery distance
* radius
* vehicle
* rider
* rider compensation
* priority
* routing rules

The seller's logistics responsibility ends at:

> "This is where the driver collects the order."

---

# 10. Delivery quote engine

After address validation, Umzila calculates the customer's delivery quote.

The engine takes:

```text
Customer destination
+
Store pickup location(s)
+
Service zone
+
Bundle configuration
+
Road distances
+
Route durations
+
Umzila pricing rules
+
Priority selection
```

and outputs:

```text
Can deliver? YES
Delivery fee: RXX
Priority fee: RXX
Estimated delivery window: XX–XX
Quote ID: XXXXX
```

This quote exists **before payment**.

---

# 11. Road distance, not straight-line distance

The system must not calculate delivery pricing using:

```text
distanceBetweenPoints()
```

based purely on latitude and longitude.

It needs road distance.

Example:

```text
Straight line:
Shop ───────────── Customer
       6.3 km


Actual roads:

Shop
  \
   \
    ────────┐
            │
            └──────── Customer

Actual road distance:
9.8 km
```

The 9.8 km figure should be the logistics distance.

A routing API such as Google's Routes API can provide actual route distance and duration.

---

# 12. The local R36 concept

The initial pricing model can begin with:

```text
0–3 km → R36
```

Then progressively increase according to road distance.

An initial modelling table could look approximately like:

| Road distance | Starting customer delivery price |
| ------------: | -------------------------------: |
|        0–3 km |                              R36 |
|        3–5 km |                          R45–R48 |
|        5–7 km |                              R55 |
|       7–10 km |                              R65 |
|      10–13 km |                              R75 |
|      13–16 km |                              R85 |
|      16–20 km |                             R100 |
|        20 km+ |              Extended-zone logic |

These are working assumptions rather than a final tariff.

The implementation should use a central pricing engine so that the actual tariff can be adjusted later without rewriting checkout.

---

# 13. Delivery pricing architecture

Do not scatter pricing through the frontend.

Instead:

```text
                 DELIVERY PRICING ENGINE
                          │
          ┌───────────────┼───────────────┐
          │               │               │
      Base fee       Distance cost    Bundle cost
          │               │               │
          └───────────────┼───────────────┘
                          │
                    Priority fee
                          │
                          ↓
                  CUSTOMER TOTAL
```

The frontend only displays the resulting quote.

---

# 14. Multi-store carts

This is a core Umzila capability.

Suppose:

```text
Customer Cart

Isqalo
 ├─ Meat product
 └─ Drink

Store B
 └─ Product

Store C
 └─ Product
```

The system groups items by shop.

```text
ORDER
 │
 ├── Store A
 │
 ├── Store B
 │
 └── Store C
```

Each store has a pickup coordinate.

Umzila then evaluates whether those pickup locations can reasonably form one delivery.

---

# 15. Bundle feasibility engine

The system calculates actual road travel between pickup locations.

Example:

```text
Isqalo
   │
   │ 2.0 km
   ↓
Store B
   │
   │ 2.4 km
   ↓
Customer
```

This may be an efficient bundle.

Now compare:

```text
Isqalo
   │
   │ 2.0 km
   ↓
Store B
   │
   │ 14 km
   ↓
Store C
   │
   │ 9 km
   ↓
Customer
```

That may no longer be sensible as one route.

The system can decide:

```text
ONE DELIVERY
```

or:

```text
SPLIT DELIVERY
```

or:

```text
CANNOT DELIVER THIS COMBINATION
```

before payment.

---

# 16. The customer does not need to know bundling happened

This is important.

Suppose their order includes:

* one item from Isqalo
* one item from another nearby shop

The customer should not be shown:

> "Your order has been combined with two other customer orders."

That is operational information with little customer value.

Instead the customer simply sees:

```text
Delivery

R59
```

Their experience remains simple.

---

# 17. When bundling requires extra delivery cost

If Store B is close enough that the route impact is negligible:

**no extra customer delivery charge may be necessary.**

If Store B materially increases the route:

```text
Base delivery:
R59

Additional bundle logistics:
R15

Total delivery:
R74
```

Or the system could determine:

> These products will be delivered separately.

The important thing is that the customer sees only the final outcome.

---

# 18. Bundle engine should be independently designed

Bundling should not be hidden inside checkout.

It should have its own subsystem.

```text
                BUNDLE ENGINE

Cart
 ↓
Group by store
 ↓
Resolve pickup coordinates
 ↓
Calculate inter-store routes
 ↓
Test route combinations
 ↓
Evaluate route time
 ↓
Evaluate delivery economics
 ↓
Determine bundle feasibility
 ↓
One route / split route / unavailable
 ↓
Return final delivery structure
```

This will become increasingly important as Umzila adds more sellers.

---

# 19. Customer checkout

The customer should see a very simple final experience.

For example:

```text
DELIVERY ADDRESS

✓ 14 Example Road, Durban

────────────────────────

DELIVERY

R59

────────────────────────

PRIORITY DELIVERY

[ Add Priority +R20 ]

────────────────────────

TOTAL

R299

[ PAY NOW ]
```

No route diagrams.

No multi-store logistics explanation.

No driver payout.

No dispatch explanation.

No internal zone information.

---

# 20. Unavailable delivery

There is one exception where explanation adds value.

When delivery isn't available, explain the actual reason.

For example:

> **We can't deliver to this address yet.**
>
> This location is currently outside Umzila's delivery area.

Or:

> **This basket needs separate deliveries.**
>
> Some items are currently too far apart to be combined into one delivery.

Or:

> **We can't complete delivery to this address right now.**
>
> Please check the address or choose another delivery location.

That is useful because it tells the customer what happened.

---

# 21. Priority delivery

Priority becomes an optional customer add-on.

Example:

```text
Standard Delivery
R59

Priority Delivery
+R20

[ Add Priority ]
```

The priority fee belongs to Umzila.

It should affect operational prioritisation.

It should not simply be passed through to the rider.

---

# 22. Priority does not mean impossible promises

Priority means:

> Umzila gives this order elevated treatment within dispatch and routing.

It should not mean:

> guaranteed arrival in 15 minutes

unless Umzila is operationally able to guarantee that.

Priority should influence:

* dispatch order
* route insertion
* rider candidate ranking
* batching decisions
* possibly route position

but not override physical reality.

---

# 23. Order is paid → now logistics begins

Once payment succeeds:

```text
PAYMENT CONFIRMED
        ↓
DELIVERY JOB CREATED
        ↓
STORE ORDERS CREATED / UPDATED
        ↓
DISPATCH
```

At this point, the logistics engine has all the necessary information.

---

# 24. Rider dispatch

The rider system should evaluate available riders.

Inputs:

```text
Rider location
Rider online status
Heartbeat age
Current route
Current deliveries
Distance to first pickup
Route compatibility
Number of active pickups
Estimated impact of new job
Priority
Vehicle eligibility
```

The system should calculate an internal ranking.

But it should not just say:

> closest rider wins.

The best rider is the one that makes the most sense **for the actual route**.

---

# 25. Rider availability and heartbeat

Each rider has:

```text
is_online
last_seen_at
last_location_at
latitude
longitude
```

The rider app periodically sends a heartbeat.

For example:

```text
19:42:01 heartbeat
19:42:08 heartbeat
19:42:15 heartbeat
```

If the heartbeat becomes stale:

```text
RIDER ONLINE
     ↓
heartbeat expires
     ↓
RIDER OFFLINE
```

This prevents a delivery from being offered to a rider who looks online in the database but is no longer active.

---

# 26. Driver validation

Before a driver can receive/accept deliveries, Umzila should validate whatever operational requirements are eventually required for the delivery network.

The architecture should have a driver eligibility state.

For example:

```text
ACCOUNT
   ↓
PROFILE
   ↓
DRIVER STATUS
   ↓
ELIGIBLE FOR DELIVERY?
```

That can later incorporate Umzila's actual onboarding requirements.

---

# 27. Rider job offer

The first rider selected receives a popup.

```text
┌───────────────────────────────────────┐
│           NEW DELIVERY                │
│                                       │
│           Isqalo Shisanyama          │
│                                       │
│           3 orders                    │
│           2 pickup locations          │
│                                       │
│           Estimated route             │
│           14.2 km                     │
│                                       │
│           Estimated time              │
│           43 minutes                  │
│                                       │
│           YOUR PAYOUT                 │
│           R145                        │
│                                       │
│              [ ACCEPT ]               │
└───────────────────────────────────────┘
```

The payout is already calculated.

The rider isn't negotiating the job.

---

# 28. Offer expansion

If Rider A doesn't accept:

```text
Rider A
   ↓
No acceptance
   ↓
Rider B
   ↓
No acceptance
   ↓
Rider C
   ↓
...
```

The system can expand the candidate pool progressively.

This avoids spamming every rider in Durban immediately.

---

# 29. If only one rider is online

The system can still offer it.

```text
ONLINE RIDERS
      │
      └── 1
          ↓
     Offer directly
```

Popup:

> New Umzila delivery available.

The system does not need to pretend there is a complex competition if nobody else is available.

---

# 30. Multi-stop delivery

A rider may eventually carry several deliveries.

For example:

```text
ROUTE 348

Pickup:
Isqalo

Stops:
1. Customer A
2. Customer B
3. Customer C
4. Customer D
5. Customer E
```

However, batching should **not** simply maximise the number of orders.

A five-order route that takes two hours to reach its final customer may be operationally poor depending on the products and promised delivery time.

---

# 31. Batching decision

Before adding another delivery to a rider, the system should check:

### Distance

Is the pickup near their existing route?

### Direction

Does the new pickup lie in a sensible direction?

### Rider state

Is the rider currently stationary or already actively travelling?

### Current workload

How many deliveries are already being carried?

### Customer ETA

How long would the new order take to reach its customer?

### Product characteristics

Could the order reasonably remain in transit that long?

### Route impact

How much additional time/distance does the new order create?

### Priority

Is the new order priority?

### Pickup readiness

Is the store ready?

The important one you added is:

> **How much longer does this make customers wait?**

That needs to be an explicit part of the batching algorithm.

---

# 32. Batching should never be forced onto the rider

This is a critical change.

The system may identify:

> This new order fits extremely well into your current route.

But that does **not** automatically add it.

Instead:

```text
SYSTEM DETECTS GOOD BATCH
          ↓
RIDER IS OFFERED OPTIONAL ADDITION
          ↓
RIDER SEES EXTRA PAY
          ↓
      ┌───────────────┐
      │ ACCEPT        │
      │ DECLINE       │
      └───────────────┘
```

Example:

```text
NEW DELIVERY OPPORTUNITY

This order is near your current route.

Additional distance:
+2.4 km

Additional estimated time:
+7 min

Extra payout:
+R18

[ ADD TO ROUTE ] [ NO THANKS ]
```

That is a much healthier rider relationship.

---

# 33. Rider route insertion

Suppose current route:

```text
Shop
 ↓
Customer A
 ↓
Customer B
 ↓
Customer C
```

New order:

```text
Store X → Customer D
```

The system evaluates possible insertion points.

```text
Option 1
A → D → B → C

Option 2
A → B → D → C

Option 3
A → B → C → D
```

It calculates:

* additional distance
* additional time
* impact on customer ETA
* payout
* priority
* feasibility

Then presents the best acceptable option to the rider.

---

# 34. Rider should be free to decline

Declining a suggested batch should not automatically mean the rider has rejected their existing job.

It simply means:

> "Don't add this additional work."

The current route continues.

This is important because riders may have practical reasons the system cannot fully understand.

---

# 35. New orders while the rider is already underway

This is where Umzila becomes dynamic.

Suppose the rider has:

```text
Order A
Order B
```

and both have been picked up.

Then another order is paid.

Its pickup location is:

**900 metres from the rider's current position.**

The system can notice:

```text
New order
↓
Pickup close to rider
↓
Route impact low
↓
Customer ETA acceptable
↓
Good candidate for batch
```

The rider receives:

> Nearby delivery available.
>
> Pickup is 900 m away.
>
> Additional payout: RXX
>
> [ ADD TO ROUTE ]

This makes the system flexible instead of rigid.

---

# 36. Pickup operations

Drops should not be the only thing with explicit delivery states.

Pickups need a structured process too.

When rider arrives at a store:

```text
AT PICKUP
```

The app shows:

```text
ISQALO SHISANYAMA

Orders to collect:

☐ Order #1024
☐ Order #1028
☐ Order #1031
```

The rider picks up each package.

After receiving one:

```text
☑ Order #1024
☐ Order #1028
☐ Order #1031
```

Then another:

```text
☑ Order #1024
☑ Order #1028
☐ Order #1031
```

Finally:

```text
☑ Order #1024
☑ Order #1028
☑ Order #1031

ALL PICKUPS COMPLETE

[ START ROUTE ]
```

---

# 37. Why individual pickup confirmation matters

A store could accidentally hand over:

* 2 of 3 orders
* wrong order
* incomplete package

The rider needs to know exactly what they have.

Supabase should store individual pickup confirmations.

Therefore:

```text
Order A → picked up
Order B → picked up
Order C → not picked up
```

is a meaningful state.

The system should not assume:

> "Driver visited store = everything collected."

---

# 38. Partial pickup

If only some orders are ready:

```text
Store

Order A ✓
Order B ✓
Order C ✕

```

The rider can pick up A and B.

The system remains aware that C wasn't collected.

The route doesn't have to collapse.

---

# 39. Recommend more batches after partial pickup

This supports another one of your ideas.

Suppose the rider is already carrying A and B.

Order C isn't ready.

Instead of simply making the rider wait, Umzila can check:

> Are there other nearby orders available that make sense?

For example:

```text
Order C
Not ready

Potential alternative:

Store D
1.1 km away
+R24 payout
+5 min route impact
```

The rider can choose whether to take it.

This can keep drivers productive while remaining flexible.

---

# 40. Store readiness

Eventually, sellers should be able to indicate:

```text
Order ready
```

But the seller interface should stay simple.

The seller can see:

```text
NEW ORDER

Prepare:
Order #1024
Order #1025

[ MARK READY ]
```

Once ready:

```text
✓ READY FOR PICKUP
```

This is enough.

No logistics controls are needed.

---

# 41. Driver gets navigation

Once pickup is ready:

```text
[ NAVIGATE TO STORE ]
```

The rider gets navigation to the pickup location.

After all required pickup items are collected:

```text
[ START DELIVERY ROUTE ]
```

---

# 42. Route sequence

A route can include:

```text
PICKUP
   ↓
PICKUP
   ↓
DROP
   ↓
DROP
   ↓
DROP
```

rather than assuming:

```text
PICKUP → one customer
```

That is necessary for bundles.

---

# 43. Customer tracking activation

Customers should only see live rider tracking when their order reaches the appropriate stage.

Before that, they see a simple status.

For example:

> **Your order is moving through delivery.**
>
> We'll let you know when your driver is heading your way.

Then:

```text
CUSTOMER BECOMES NEXT STOP
          ↓
TRACKING ACTIVATED
          ↓
LIVE DRIVER LOCATION
          ↓
ETA
```

---

# 44. Do not tell customers their exact stop number

Agreed.

Remove:

> "You're stop #4 of 7."

There is little customer benefit to that.

It can actually create anxiety.

Instead:

> **Your driver is finishing a few nearby deliveries first.**

or:

> **Your order is coming up next. We'll let you know when the driver is on the way.**

And when activated:

> **Your driver is on the way to you.**

That is enough.

---

# 45. Customer tracking page

The tracking page should feel like part of Umzila's brand rather than a generic courier page.

Conceptually:

```text
┌────────────────────────────────────────┐
│                                        │
│            Your Umzila order           │
│                                        │
│         Driver is on the way           │
│                                        │
│                 🚗                     │
│                  ╲                     │
│                   ╲                    │
│                    ● You               │
│                                        │
│             ETA 6–7 min                │
│                                        │
│────────────────────────────────────────│
│                                        │
│           DELIVERY PIN                 │
│                                        │
│              4 8 2 7                   │
│                                        │
│ When you receive your order,           │
│ just say 4827 to your driver.          │
│                                        │
└────────────────────────────────────────┘
```

The PIN should be prominent.

Not hidden in an account page.

---

# 46. Exact PIN copy

When the order is actively on the way:

> **Delivery PIN**
>
> **4827**
>
> When you receive your order, just say **4827** to your driver.

That is simple and useful.

The system should never ask the customer to perform unnecessary actions.

---

# 47. The customer journey should feel alive

The customer shouldn't be staring at a static text page.

The tracking interface can have a series of lightweight visual states.

For example:

```text
ORDER RECEIVED
      ↓
PREPARING
      ↓
READY
      ↓
DRIVER ASSIGNED
      ↓
ON THE WAY
      ↓
ARRIVING
      ↓
DELIVERED
```

The current step becomes visually brighter.

Previous steps remain completed.

Future steps remain muted.

---

# 48. Tracking timeline

Example:

```text
✓ Order received
✓ Payment confirmed
✓ Your order is being prepared
✓ Collected by driver
● Driver is heading your way
○ Arriving
○ Delivered
```

The current state is prominent.

The customer doesn't need operational details beyond that.

---

# 49. Index page delivery widget

This should also appear on the main Umzila homepage.

Immediately below the hero section:

```text
┌───────────────────────────────────────────────┐
│ Your order is on the way                      │
│                                               │
│ Estimated arrival                            │
│ 6–7 minutes                                   │
│                                               │
│                         [ Track order ]       │
└───────────────────────────────────────────────┘
```

This should not cover the screen.

It should be a compact, premium-looking strip/card.

---

# 50. Index widget behavior

If an order is active:

### If no ETA yet

```text
Your order is being prepared

[ Track order ]
```

### When driver assigned

```text
Your order is with a driver

[ Track order ]
```

### During active travel

```text
Arriving in about 7 minutes

[ Track order ]
```

### After delivery

The active widget disappears or transforms into:

> **Order delivered ✓**

with no need to permanently occupy homepage real estate.

---

# 51. Tracking page visual language

The current Umzila blue should influence the experience, but the tracking interface should remain neutral and modern.

Potential design language:

```text
Soft whites
Cool blue
Deep navy
Muted grey
Very subtle gradients
Rounded cards
Fine borders
Soft shadows
Minimal motion
```

The intention is:

**premium + alive**

rather than:

**cartoon delivery app**.

---

# 52. Animation system

This can become one of Umzila's differentiators.

Each delivery state can have a small visual animation.

For example:

### Order received

A subtle package being passed between two people.

### Preparing

A package/product being prepared.

### Driver assigned

A small vehicle preparing to leave.

### On the way

A vehicle travelling across a minimal route.

### Arriving

The vehicle gradually approaches the destination.

### Delivered

A package changes from moving state to completed state.

The animations should be small and loop gently.

They should never dominate the page.

---

# 53. Animation implementation

SVG and lightweight CSS/JS animations are preferable where practical.

Potential approach:

```text
SVG illustration
+
CSS animation
+
state-based React/JS rendering
```

Even while the current site is still HTML/CSS/JS, we can implement the concept without requiring a full animation framework.

For more complex animations, a future implementation can use a suitable lightweight animation format.

---

# 54. Accessibility

The creative animation system should also have a graceful fallback.

If a user has:

```text
prefers-reduced-motion: reduce
```

then animations should become minimal or static.

The customer should still get the exact same information.

The experience should never depend on motion to communicate state.

---

# 55. Easter eggs

The idea of subtle delivery easter eggs is strong **provided they are rare and contextual**.

For example:

If ETA falls within a narrow range:

```text
6–7 min
```

the tracking interface could temporarily show a small "67" gesture animation for a few seconds.

It should be:

* unexpected
* subtle
* short
* non-disruptive
* easy to ignore

The important principle is:

> Easter eggs decorate the experience; they do not define it.

There should not be memes appearing constantly.

---

# 56. Creative delivery personality

The brand voice should be:

**fresh, confident, useful, slightly playful**

not:

**forced jokes**

or:

**corporate courier language**

For the app:

> "Your driver is on the way."

could become:

> "You're up. Your driver is heading your way."

That feels more alive without becoming silly.

---

# 57. Notification copy system

Notifications should have two distinct styles.

### Customer app/site

Fresh, expressive, concise.

### Email

Professional, elegant, warm.

The email should still feel distinctly Umzila without being informal.

---

# 58. Example customer in-app copy

Instead of:

> Order dispatched.

Use:

> **Your order is moving.**

Instead of:

> Driver is approaching.

Use:

> **You're up next. Your driver is heading your way.**

Instead of:

> Delivery successful.

Use:

> **You're all set. Order delivered.**

Instead of:

> Wait for delivery.

Use:

> **We're on the way.**

The copy should always communicate something useful.

---

# 59. Example email copy

Email can remain more polished.

### Subject

> Your Umzila order is on the way

### Body

> Your order has been collected and is now on its way to you.
>
> Estimated arrival: 18:35–18:45
>
> When your driver arrives, please provide your delivery PIN:
>
> **4827**
>
> You can follow your delivery here:
>
> **Track your order**

Elegant and useful.

No memes.

No gimmicky language.

---

# 60. Notification lifecycle

Every meaningful delivery state should have an event.

For example:

```text
ORDER_PLACED
PAYMENT_CONFIRMED
STORE_PREPARING
ORDER_READY
DRIVER_ASSIGNED
DRIVER_ACCEPTED
AT_PICKUP
ORDER_PICKED_UP
ROUTE_STARTED
CUSTOMER_NEXT
DRIVER_NEARBY
DRIVER_ARRIVING
DELIVERED
FAILED_DELIVERY
CANCELLED
```

Not every event necessarily needs an email.

Some are in-app only.

---

# 61. Notification channels

The underlying architecture should be channel-independent:

```text
                 EVENT
                   │
          ┌────────┼────────┐
          │        │        │
        EMAIL    IN-APP   FUTURE
                           WhatsApp/
                           Push
```

You already have **Resend**, so email can initially use that.

The system should not hard-code notification logic directly into every page.

---

# 62. Event-driven notifications

For example:

```text
delivery.status
     changes
        ↓
Supabase event
        ↓
notification service
        ↓
determine message
        ↓
email / in-app notification
```

That is much cleaner than:

```text
some JavaScript file
   ↓
send random email
```

---

# 63. Delivery PIN generation

Every customer profile gets a 4-digit PIN.

Example:

```text
Customer A → 4827
Customer B → 1934
Customer C → 4827
```

The PIN does not need to be globally unique.

That is perfectly acceptable.

It only has to function as the customer's delivery confirmation credential within their delivery context.

---

# 64. Existing Supabase customers

Because existing profiles already exist, migration logic should:

```text
Find profile
   ↓
Does delivery PIN exist?
   │
   ├── YES → leave it
   │
   └── NO → generate random 4 digits
```

This should run in a controlled database/server-side migration rather than relying on each user's browser to generate the PIN.

---

# 65. PIN completion process

Driver arrives.

Driver sees:

```text
Customer:
John

[ Enter delivery PIN ]

_ _ _ _
```

Customer says:

> 4827

Driver enters it.

The server-side operation verifies:

```text
driver is assigned
+
delivery is active
+
customer matches
+
PIN matches
```

Then:

```text
DELIVERY = DELIVERED
```

---

# 66. What happens immediately after PIN confirmation

The system should atomically:

```text
Mark delivery completed
        ↓
Timestamp delivery
        ↓
Record PIN verification
        ↓
Update route stop
        ↓
Determine next stop
        ↓
Activate next customer if applicable
        ↓
Send notification
        ↓
Refresh rider route
```

This should happen as one coherent operation so the system doesn't end up in a state where:

> "Customer received order"

but:

> next customer was never activated.

---

# 67. Customer tracking visibility

The customer should be able to see:

### Before dispatch

```text
Order received
Preparing
```

### During earlier stops

```text
Your order is in delivery.

Your driver is completing a few deliveries nearby.
We'll let you know when they're heading your way.
```

### When active

```text
Your driver is on the way.

ETA 8 min.
```

### At arrival

```text
Your driver is almost there.

Your delivery PIN:
4827
```

### After PIN

```text
Delivered ✓
```

---

# 68. No route-number anxiety

The customer should never see:

> "You are fourth."

They shouldn't be encouraged to think:

> "Why am I fourth?"

Instead the message tells them only what matters:

> **We're finishing a few deliveries nearby, then we're heading to you.**

That is enough context.

---

# 69. Supabase Realtime

The application should use Supabase Realtime to keep live state synchronised.

Relevant changes might include:

```text
delivery status
route stop status
rider location
driver assignment
pickup status
notification state
```

The customer tracking page listens for relevant changes.

The driver page listens for:

* new offers
* route updates
* new batch opportunities
* reassignment
* stop completion
* route changes

The seller dashboard listens for:

* order updates
* preparation status
* delivery status

Admin listens broadly enough to monitor the network.

---

# 70. Fresh Supabase data

The frontend should not trust local state as the final authority.

For example:

React might think:

```text
status = picked_up
```

but the page should still ultimately reflect the current Supabase record.

The basic principle is:

```text
LOCAL UI STATE
      ↓
temporary display

SUPABASE
      ↓
authoritative persistent state
```

Realtime pushes changes quickly.

Periodic refresh/revalidation protects against missed events or stale connections.

---

# 71. Why both Realtime and refreshing are useful

Realtime gives:

**speed**

Refreshing/revalidation gives:

**correctness**

So:

```text
Realtime
→ update immediately

Periodic query/revalidation
→ ensure state is still correct

Supabase database
→ source of truth
```

This is stronger than relying entirely on a websocket event being delivered perfectly.

---

# 72. Driver location data

The rider periodically submits:

```text
driver_id
latitude
longitude
heading
speed
timestamp
```

The system stores a current live position.

A separate historical record can eventually be retained when useful.

The customer tracking page only needs the latest location.

---

# 73. Don't overload the database

GPS doesn't need to be written every second.

A reasonable starting architecture is periodic updates while actively delivering.

For example:

```text
active delivery
→ frequent location heartbeat

idle
→ much less frequent heartbeat
```

The exact interval should be tested based on battery, bandwidth and map smoothness.

---

# 74. Driver route history

A route can contain:

```text
Route
 ├─ Start
 ├─ Pickup A
 ├─ Pickup B
 ├─ Drop A
 ├─ Drop B
 └─ Drop C
```

Each important event has a timestamp.

This is valuable for:

* support
* disputes
* performance analysis
* payout validation
* route optimisation
* operational debugging

---

# 75. Delivery event timeline

Every delivery should build a timeline.

Example:

```text
19:02 Order received
19:03 Payment confirmed
19:05 Store preparing
19:19 Order ready
19:21 Driver assigned
19:25 Driver reached store
19:27 Order picked up
19:39 Driver heading to customer
19:45 PIN verified
19:45 Delivered
```

This becomes extremely powerful later.

---

# 76. Seller dashboard

The seller should have a simple dashboard.

## Active orders

```text
NEW

Order #1024
2 items

[ View order ]
```

## Orders being prepared

```text
PREPARING

Order #1024

[ Mark ready ]
```

## Active deliveries

```text
OUT FOR DELIVERY

Order #1024
Driver assigned
```

## Delivered

```text
DELIVERED

Order #1019
✓
```

## Feedback

```text
Compliment
"Excellent food."

Complaint
"Missing item."
```

That is almost everything the seller needs.

---

# 77. Seller live delivery reassurance

Seller sees active delivery information like:

```text
Order #1024
Driver: Thabo
Status: On route
```

They can optionally see a live map in their dashboard.

But the seller should not have the power to:

* change the route
* change price
* select driver
* assign vehicle
* modify payout
* override service area

Those belong to Umzila.

---

# 78. Admin dashboard

The admin system should be much more detailed.

Main sections:

```text
LIVE OPERATIONS
DELIVERIES
RIDERS
SHOPS
CUSTOMERS
SERVICE AREAS
PRICING
ISSUES
FEEDBACK
ANALYTICS
```

---

# 79. Admin live map

The admin map should show:

```text
      ● Rider
        │
        │
        ↓
     ● Customer

● Store

        ● Rider
          │
          ↓
       ● Customer
```

With routes and statuses.

The admin should be able to zoom into a route and understand:

* rider location
* current stop
* remaining stops
* active order
* pickup status
* exceptions

---

# 80. Admin dispatch screen

A delivery waiting for a rider could show:

```text
DELIVERY #1024

Pickup:
Isqalo

Destination:
Customer area

Priority:
YES

Delivery:
R59

Rider payout:
R42

STATUS:
Awaiting driver
```

Then candidate riders:

```text
Rider A
1.4 km
Available
Recommended

Rider B
3.8 km
Available

Rider C
7.2 km
Busy
```

This gives admin visibility into why a dispatch is happening.

---

# 81. Admin exception handling

Important exception categories:

```text
No rider available
Store not ready
Customer unavailable
Invalid address
Route unavailable
Driver disconnected
Failed PIN
Order missing
Order damaged
Route delayed
Delivery cancelled
```

The admin console should make these obvious.

---

# 82. Driver reassignment

If a rider goes offline while carrying orders:

```text
Driver unavailable
       ↓
Determine affected deliveries
       ↓
Freeze route
       ↓
Find alternative rider
       ↓
Offer reassignment
       ↓
New driver accepts
       ↓
Customer informed
```

The customer message should be reassuring:

> We're arranging another driver for your order. We'll keep you updated.

Not:

> DRIVER FAILURE ERROR 502

---

# 83. Route insertion economics

The route engine should not ask only:

> "Does this order fit?"

It should ask:

> "Does this order fit well enough to justify the additional work?"

For example:

```text
Existing route
12.8 km

New order adds:
+2.1 km
+6 min

Customer ETA impact:
+1 min

Extra rider payout:
+R16
```

This may be an excellent opportunity.

Another:

```text
Existing route
12.8 km

New order adds:
+9.8 km
+31 min

Customer ETA impact:
+22 min
```

That probably deserves a different operational treatment.

The rider shouldn't be forced into it.

---

# 84. Existing route versus new route

The system should compare at least two states:

```text
CURRENT ROUTE
```

versus:

```text
CURRENT ROUTE + NEW DELIVERY
```

Then quantify:

```text
additional km
additional minutes
ETA impact
payout impact
priority impact
```

This is where route intelligence becomes useful.

---

# 85. Route efficiency

Eventually Umzila can optimise routes based on:

```text
distance
time
customer ETA
priority
pickup readiness
driver payout
Umzila margin
```

This is better than simply saying:

> closest first.

---

# 86. But customer ETA should always have a ceiling

There should be internal rules such as:

> Don't accept another batch if doing so would push an existing customer's ETA beyond an acceptable threshold.

That prevents the system from chasing every possible incremental rand at the expense of customers.

This should become a core batching rule.

---

# 87. Product-aware delivery

Different products may behave differently.

For Isqalo:

food may be time-sensitive.

For clothing:

waiting 90 minutes may be much less consequential.

For future Umzila sellers:

```text
food
clothing
electronics
beauty
household goods
```

could all share the delivery engine while eventually having different operational constraints.

The underlying order can therefore eventually carry a:

`delivery_handling_profile`

without hard-coding every shop.

---

# 88. Priority versus batching

Priority customers should be considered differently during batching.

Example:

```text
Normal Customer A
Priority Customer B
Normal Customer C
```

The route engine can consider whether B should be inserted ahead of A.

However:

Priority should not automatically cause every existing customer's delivery to become unreasonable.

The system has to balance:

```text
priority promise
+
existing customer ETA
+
route cost
```

---

# 89. Customer ETA

The ETA calculation should come from actual route information.

Conceptually:

```text
Current driver position
+
remaining route
+
next stop
+
road travel duration
=
customer ETA
```

Not:

```text
distance / arbitrary average speed
```

The exact ETA model can become more sophisticated later.

---

# 90. ETA ranges are better than fake precision

Instead of:

> 7 minutes 13 seconds

display:

> **6–8 min**

or:

> **Arriving around 18:42**

That feels more honest.

Internally the system can still maintain precise calculations.

---

# 91. Customer homepage tracking state

The homepage widget is not just decoration.

It should act as an immediate re-entry point into the order.

Example:

```text
┌───────────────────────────────────────┐
│ Your Umzila order                     │
│                                       │
│ Order received                        │
│                                       │
│ [ Track order ]                       │
└───────────────────────────────────────┘
```

Later:

```text
┌───────────────────────────────────────┐
│ Your Umzila order                     │
│                                       │
│ Arriving in 6–7 min                   │
│                                       │
│ [ Track order ]                       │
└───────────────────────────────────────┘
```

The homepage becomes a subtle live order hub.

---

# 92. Customer order timeline design

A polished timeline could be:

```text
● Order received
│
● Preparing
│
● Ready
│
● Collected
│
● On the way
│
● Delivered
```

Current:

```text
BRIGHT
```

Completed:

```text
NORMAL / CHECK
```

Upcoming:

```text
MUTED
```

---

# 93. Creative state animations

The timeline and hero animation can respond to the current delivery state.

Example:

```text
Order received
→ package being passed

Preparing
→ package being prepared

Driver assigned
→ rider arriving at pickup

On the way
→ vehicle travelling

Arriving
→ vehicle approaching

Delivered
→ package handoff / completion
```

The exact illustrations can be custom Umzila SVG artwork.

That gives the tracking page its own visual identity.

---

# 94. Easter egg framework

Do not hard-code individual memes directly into the tracking page.

Build a small concept:

```text
TRACKING EASTER EGG ENGINE
```

which receives:

```text
current state
ETA
time/context
```

and optionally chooses one subtle animation.

For example:

```text
ETA = 6–7 min
AND user hasn't recently seen egg
→ display 67 animation for 5 sec
```

Potential future easter eggs can be added without rewriting the tracking system.

---

# 95. Important rule for Easter eggs

They should never:

* interrupt tracking
* cover the PIN
* hide ETA
* delay the page
* interfere with accessibility
* appear constantly
* make the app look unserious

The delivery should still look like a legitimate logistics product.

The delight happens around the information.

---

# 96. Customer support entry points

The tracking page should eventually have something like:

> Need help?

with a simple support action.

Potential categories:

```text
My order is late
My order is missing something
I can't meet the driver
I have another delivery problem
```

This can later automatically attach:

* order
* route
* driver
* delivery
* timestamp

to the support request.

---

# 97. Compliments and complaints

After delivery:

```text
How was your Umzila delivery?

♡ Loved it
Tell us what went well

Something went wrong
Tell us what happened
```

A compliment can be tied to:

* store
* rider
* delivery

A complaint can also identify the category.

---

# 98. Why this matters operationally

Suppose a customer says:

> "The food arrived cold."

Admin can determine:

Was:

* store preparation late?
* rider waiting?
* route too long?
* too many batches?
* customer delay?
* delivery sequencing bad?

The system can eventually learn from these outcomes.

---

# 99. Delivery analytics

Admin should eventually see:

```text
Average delivery time
Average pickup time
Average rider acceptance time
Average route distance
Average stops per route
Average customer ETA accuracy
Failed deliveries
PIN completion rate
Complaints
Compliments
Rider payout
Delivery revenue
Delivery margin
```

This allows Umzila to tune the network based on evidence rather than intuition.

---

# 100. Route profitability analytics

One particularly valuable dashboard:

```text
ROUTE #348

5 deliveries
18.2 km
54 min

Customer delivery revenue
R248

Priority revenue
R20

Driver payout
R161

Gross logistics revenue remaining
R107
```

The exact financial presentation can be adjusted later based on accounting treatment.

But the architecture should distinguish these values.

---

# 101. Financial separation

An order should be capable of representing:

```text
product_subtotal
discount_total
delivery_fee
priority_fee
other_customer_addons
order_total
```

Separate delivery accounting can track:

```text
driver_payout
umzila_delivery_revenue
umzila_priority_revenue
```

This prevents the entire delivery system becoming one giant `delivery_price` column.

---

# 102. Rider payout principle

The standard delivery fee should generally result in the rider receiving the majority of that delivery revenue, subject to Umzila's actual business economics.

But rider pay should be calculated by route rather than a crude permanent percentage.

For example:

```text
5 deliveries
+
2 pickups
+
18 km route
+
54 min
```

could generate:

```text
R161 rider payout
```

while customer charges and Umzila margin are calculated separately.

---

# 103. Add-on revenue

Customer-facing add-ons such as:

```text
priority delivery
```

should be separately accounted for.

The current intended principle is:

**Priority/add-on revenue belongs to Umzila unless Umzila later deliberately changes the payout model.**

That keeps the system financially transparent.

---

# 104. Delivery quote locking

Once the customer receives the delivery price, the price should be associated with a quote.

Conceptually:

```text
delivery_quote

quote_id
customer
destination
stores
route
price
expires_at
pricing_version
```

Checkout then uses that quote.

This prevents the browser from simply submitting:

```text
delivery_fee = 0
```

and expecting the server to believe it.

---

# 105. Payment security

The customer's browser should never be trusted for the authoritative total.

The secure payment flow should be:

```text
Customer checkout
       ↓
Delivery quote
       ↓
Server validates quote
       ↓
Server reconstructs trusted total
       ↓
PayFast payment
       ↓
Payment callback
       ↓
Order confirmed
       ↓
Delivery job created
```

This fits much better with the existing effort you have already made around Supabase validation and secure Netlify functions.

---

# 106. Supabase role

Supabase should be the central persistent state layer.

It should hold authoritative information for:

```text
profiles
stores
addresses
orders
order items
delivery quotes
deliveries
routes
route stops
drivers
driver assignments
driver offers
driver locations
delivery events
notifications
service zones
pricing configuration
driver payouts
feedback
```

That is a conceptual list only.

The actual table design must come from an audit of your current schema.

---

# 107. Frontend role

The current HTML/CSS/JS site should become the interface to this system.

The frontend:

* requests data
* displays state
* subscribes to changes
* sends permitted user actions
* refreshes stale information

It should not independently invent authoritative delivery state.

---

# 108. Netlify/server function role

Netlify functions can handle secure operations such as:

* Google API calls that should remain protected
* delivery quote creation
* pricing validation
* route calculations
* dispatch logic
* secure PIN validation
* notification processing
* payment operations

The exact division between Netlify functions and Supabase Edge Functions should be determined after inspecting the existing codebase.

---

# 109. API keys

Since Umzila already uses Netlify environment variables for sensitive configuration, Google credentials can be managed through the same type of environment-variable architecture, subject to the API's required browser/server restrictions.

The important distinction is:

**not every key should be treated as if it is safe to expose publicly.**

Keys that need server-side protection should remain there.

---

# 110. Resend notification infrastructure

Because Resend is already in place, email should use the existing infrastructure where possible.

We do not need to introduce another email provider simply for delivery.

The system can create reusable notification templates:

```text
order_confirmed
order_preparing
order_ready
driver_assigned
order_collected
driver_heading_to_customer
delivery_completed
delivery_problem
```

---

# 111. Notification deduplication

A customer should not receive duplicate emails because the same status was accidentally written twice.

Notifications should carry a unique event/context identifier.

Conceptually:

```text
delivery_id
event_type
recipient
channel
sent_at
```

with appropriate uniqueness/idempotency.

---

# 112. Delivery state machine

The final delivery status should be explicit.

For example:

```text
PENDING
   ↓
READY_FOR_DISPATCH
   ↓
OFFERED
   ↓
ASSIGNED
   ↓
DRIVER_AT_PICKUP
   ↓
PARTIALLY_PICKED_UP
   ↓
PICKED_UP
   ↓
IN_ROUTE
   ↓
NEXT_STOP
   ↓
ARRIVING
   ↓
PIN_REQUIRED
   ↓
DELIVERED
```

Exceptional states:

```text
CANCELLED
FAILED
REASSIGNING
RETURNED
```

---

# 113. Route state machine

Routes themselves have separate states:

```text
CREATED
   ↓
ASSIGNED
   ↓
STARTED
   ↓
ACTIVE
   ↓
COMPLETING
   ↓
COMPLETED
```

This distinction matters because:

**delivery state** and **route state** are not the same thing.

---

# 114. Stop state machine

Each stop can have:

```text
PENDING
READY
ACTIVE
ARRIVING
COMPLETED
FAILED
SKIPPED
```

This is how five deliveries can exist inside one route cleanly.

---

# 115. Pickup stop

A pickup stop should also have its own state:

```text
PENDING
ARRIVED
COLLECTING
PARTIALLY_COLLECTED
COMPLETED
```

with individual order items/orders having their own pickup status.

---

# 116. The important relationship

The conceptual relationship becomes:

```text
                    ORDER
                      │
                      ↓
                  DELIVERY
                      │
                      ↓
                    ROUTE
                      │
                ┌─────┼─────┐
                ↓     ↓     ↓
              STOP  STOP   STOP
               │
               ↓
          PICKUP / DROP
```

One order:

**one delivery**

One driver route:

**many deliveries**

One route:

**many stops**

This is the core architecture.

---

# 117. Bundle architecture

A bundle may involve:

```text
Order 1024
   ↓
Store A pickup

Order 1025
   ↓
Store B pickup

Order 1026
   ↓
Store A pickup
```

These can potentially become:

```text
ROUTE

Store A
 ↓
Store B
 ↓
Customer A
 ↓
Customer B
 ↓
Customer C
```

The customer still experiences their own order normally.

---

# 118. Customer sees their own delivery, not the whole route

This distinction should be maintained everywhere.

Customer:

```text
Your order
Driver
ETA
PIN
Status
```

Rider:

```text
Entire route
All active stops
All required pickups
Payout
Navigation
```

Seller:

```text
Their own orders
Their own active deliveries
```

Admin:

```text
Everything operationally necessary
```

That separation is crucial.

---

# 119. Data permissions

Supabase Row Level Security should enforce those boundaries.

For example:

A customer should be able to access:

```text
their order
their delivery
their address
their notifications
their tracking information
```

but not:

```text
another customer's order
another customer's address
another driver's entire route
```

A seller should see:

```text
their shop's relevant orders
```

A rider should see:

```text
deliveries assigned/offered to them
```

An admin has broader operational access.

---

# 120. Live tracking privacy

The customer's access token/session should only expose the driver's tracking information when appropriate.

Before active tracking:

```text
tracking_enabled = false
```

Once customer becomes active:

```text
tracking_enabled = true
```

After completion:

```text
tracking_enabled = false
```

The tracking page can still show:

> Delivered

without continuing to expose the driver's live location.

---

# 121. Driver tracking privacy

The customer's interface should not expose unnecessary rider information.

Possible information:

* rider first name
* profile photo, if appropriate
* vehicle description
* live location

Potentially avoid exposing:

* rider phone number by default
* home address
* personal information
* complete route history

This should remain a product/security decision later.

---

# 122. Customer delivery address instructions

This should absolutely exist.

When saving the address:

```text
Delivery instructions

[ Blue gate. Ring the bell. Unit 4. ]
```

or:

> Call when outside.

or:

> Reception at the main entrance.

These instructions should attach to the order snapshot.

---

# 123. Address snapshot

If the customer changes their profile address later, an old order shouldn't suddenly change.

Therefore:

```text
PROFILE ADDRESS
       ↓
CHECKOUT
       ↓
ORDER ADDRESS SNAPSHOT
```

The historical delivery should preserve the actual address used at payment.

---

# 124. Address validation should happen again when needed

The system should not rely entirely on a validation performed months earlier.

At checkout, the selected address should be evaluated for the current order.

That ensures:

* correct destination
* current service coverage
* correct store grouping
* correct routing

---

# 125. Delivery eligibility should be dynamic

Even if an address is normally deliverable, the system can eventually account for:

* temporary service restrictions
* route problems
* extreme operational conditions
* unavailable extended zones

This should be an admin-controlled operational decision rather than permanently hardcoded.

---

# 126. Smart idea: delivery promise

Before payment, Umzila can eventually calculate a delivery expectation.

For example:

> **Estimated delivery: 35–50 min**

This lets the customer make an informed purchase decision.

It is more useful than showing only a price.

The customer still doesn't need to know *why* it's 35–50 minutes.

---

# 127. Smart idea: realistic preparation + route ETA

The delivery promise should consider:

```text
shop preparation time
+
pickup travel
+
other necessary pickups
+
customer route
```

This is stronger than:

> driver's driving time only.

For food, this becomes particularly useful.

---

# 128. Smart idea: store readiness prediction

Eventually, Umzila can learn:

```text
Isqalo
Average preparation time = 14 min
```

Then dispatch can anticipate readiness.

For example:

```text
Order paid
↓
Expected ready in 14 min
↓
Best rider ETA to store = 11 min
```

That's more efficient than sending somebody to sit outside the shop for 14 minutes.

This is a future optimisation.

---

# 129. Smart idea: route insertion offer

The optional batching feature can become one of the strongest rider tools.

Example:

```text
You currently have:
2 active deliveries

New nearby order detected.

Additional distance:
+1.8 km

Additional ETA impact:
+5 min

Extra payout:
+R15

[ Add to route ]
[ Skip ]
```

This creates a genuine incentive for riders to accept useful additional work.

---

# 130. Smart idea: rider route control with system assistance

The system should suggest.

The rider can accept/reject.

But once accepted, Umzila manages the route.

This gives:

```text
AI/algorithmic assistance
+
human rider judgement
```

rather than:

```text
algorithm dictatorship
```

That's a good fit for a real delivery network.

---

# 131. Smart idea: do not optimise only for Umzila margin

The system must balance:

```text
Customer experience
+
Rider economics
+
Umzila economics
```

A route that makes Umzila R10 more but causes a customer to wait an extra 25 minutes may be a bad route.

The system should therefore track customer ETA impact.

---

# 132. Smart idea: customer delay protection

A batching candidate can have a rule:

> Do not offer this batch if accepting it causes an existing customer's expected arrival to move beyond an acceptable threshold.

That protects customers from overly aggressive batching.

---

# 133. Smart idea: route direction

Distance alone isn't enough.

Example:

```text
Current route:
        → → → →

New pickup:
         →

Good

New pickup:
← ← ←

Bad
```

The new job might be only 1 km away geographically but in the opposite direction.

The route engine should consider route direction and insertion cost.

---

# 134. Smart idea: pickup clustering

If several orders are waiting at the same shop:

```text
Isqalo

Order A
Order B
Order C
Order D
```

the dispatch system should strongly consider grouping those pickups for one rider rather than four separate trips.

This should be automatic operational intelligence.

---

# 135. Smart idea: cross-store pickup clustering

Likewise:

```text
Store A
     ↓ 1.2 km
Store B
     ↓ 1.0 km
Store C
```

could become one pickup chain when customer ETAs permit it.

That directly supports Umzila's marketplace-with-a-twist concept.

---

# 136. Smart idea: bundle economics before customer checkout

Before confirming:

```text
Store A
Store B
Store C
```

the system should calculate:

```text
Can one route serve all?
What is the route?
What is incremental distance?
What is incremental rider cost?
What should customer pay?
Is it still commercially sensible?
```

The customer only gets:

> Delivery RXX

unless there's a problem.

---

# 137. Smart idea: bundle splitting

Suppose:

```text
Order
├── Store A
├── Store B
└── Store C
```

and C is too far away.

Instead of rejecting the whole cart, Umzila can potentially construct:

```text
Delivery 1
Store A + Store B

Delivery 2
Store C
```

and show the customer:

> **Delivery 1 — R59**
>
> **Delivery 2 — R45**

This would be the clean customer-facing version.

The customer doesn't need to know why C was split unless necessary.

---

# 138. Smart idea: bundle compatibility in real time

A customer may add an item from another shop.

The cart can quietly recalculate.

Before:

```text
Delivery R59
```

After adding another nearby store:

```text
Delivery R59
```

The customer sees no unnecessary explanation.

If the new item makes delivery significantly different:

```text
Delivery R69
```

and the total simply updates.

The logistics engine handles the complexity.

---

# 139. Smart idea: pricing transparency without logistics overload

Customers should always understand:

> what they are paying

but not necessarily:

> why the routing algorithm made that exact decision.

So show:

```text
Delivery R69
```

not:

```text
Base R36 + Store B detour R13 + Store C route cost R20
```

unless a more detailed breakdown is genuinely needed.

---

# 140. Smart idea: order history delivery replay

Later, customers could view:

> Delivered at 18:46

and optionally see the delivery timeline again.

This creates a persistent, polished order experience.

---

# 141. Smart idea: shareable experience

The tracking page can eventually have a tasteful:

> Your order has arrived.

The customer may naturally screenshot or share the animation.

The important thing is not to explicitly force social sharing.

Make the experience interesting enough that people want to share it voluntarily.

---

# 142. Smart idea: brandable delivery moments

Different states can have subtle Umzila visual signatures.

For example:

```text
ORDER RECEIVED
→ soft package animation

ON THE WAY
→ blue route line

ARRIVING
→ subtle movement pulse

DELIVERED
→ short handoff/completion animation
```

That gives delivery its own "Umzila feel."

---

# 143. Admin delivery map and analytics should eventually connect

An admin can see:

```text
Which areas generate the most orders?
Which routes are inefficient?
Which stores create long pickup chains?
Which riders accept batches?
Which areas have more failed deliveries?
```

This eventually informs business decisions.

---

# 144. Service-area analytics

For every destination zone:

```text
orders
deliveries
average distance
average ETA
failure rate
complaints
delivery margin
```

Umzila can later determine whether an extended zone is operationally worth continuing.

---

# 145. Pricing iteration

The pricing engine should be configuration-driven.

The first version might say:

```text
0–3km → R36
3–5km → ...
```

Later Umzila can change it from an admin configuration panel without changing frontend code.

---

# 146. No surge pricing

The initial architecture should deliberately exclude surge pricing.

There is no need for:

```text
high demand
↓
price increases automatically
```

for the first implementation.

Keep the system predictable.

---

# 147. Priority remains simpler

Priority is:

```text
Customer chooses priority
↓
Priority fee added
↓
Order receives priority flag
↓
Dispatch gives it elevated treatment
```

Simple enough for the customer and useful operationally.

---

# 148. Initial system diagram

The whole system can therefore be represented as:

```text
CUSTOMER
   │
   ├── Address
   │
   ↓
ADDRESS VALIDATION
   │
   ↓
SERVICE AREA CHECK
   │
   ↓
CART / STORE GROUPING
   │
   ↓
BUNDLE ENGINE
   │
   ├── Store distance
   ├── Route feasibility
   ├── Customer ETA
   └── Split / combine
   │
   ↓
DELIVERY PRICING
   │
   ├── Base
   ├── Distance
   ├── Bundle impact
   └── Priority
   │
   ↓
CHECKOUT
   │
   ↓
PAYMENT
   │
   ↓
DELIVERY JOB
   │
   ↓
DISPATCH ENGINE
   │
   ↓
RIDER OFFER
   │
   ├── Accept
   │
   └── Expand offer
   │
   ↓
PICKUP ROUTE
   │
   ↓
DELIVERY ROUTE
   │
   ├── Customer A
   ├── Customer B
   ├── Customer C
   └── ...
   │
   ↓
CUSTOMER-SPECIFIC TRACKING
   │
   ↓
PIN VERIFICATION
   │
   ↓
DELIVERED
   │
   ↓
NEXT STOP
```

---

# 149. Complete customer journey diagram

```text
                  UMZILA CUSTOMER

                       START
                         │
                         ↓
                  Browse products
                         │
                         ↓
                       Cart
                         │
                         ↓
                  Enter address
                         │
                         ↓
              Google address suggestions
                         │
                         ↓
              Customer selects address
                         │
                         ↓
                 Address validated
                         │
                 ┌───────┴────────┐
                 │                │
              Invalid           Valid
                 │                │
                 ↓                ↓
          Fix address       Service area
                                 │
                       ┌─────────┴─────────┐
                       │                   │
                    Allowed             Not allowed
                       │                   │
                       ↓                   ↓
                 Bundle engine      Explain why
                       │
                       ↓
                  Price engine
                       │
                       ↓
                   Customer sees
                   final total
                       │
                       ↓
                     PAY
                       │
                       ↓
               Payment confirmed
                       │
                       ↓
                 Store prepares
                       │
                       ↓
                  Driver assigned
                       │
                       ↓
                  Items collected
                       │
                       ↓
                Customer notified
                       │
                       ↓
             Driver heading to them
                       │
                       ↓
                 Live tracking
                       │
                       ↓
                  Driver arrives
                       │
                       ↓
                  Customer says PIN
                       │
                       ↓
                PIN verified
                       │
                       ↓
                 DELIVERED ✓
```

---

# 150. Complete rider journey

```text
                     RIDER

                     LOGIN
                       │
                       ↓
               Validation / eligibility
                       │
                       ↓
                     ONLINE
                       │
                       ↓
                  Heartbeat active
                       │
                       ↓
               Delivery opportunity
                       │
                       ↓
                  Offer received
                       │
               ┌───────┴────────┐
               │                │
            ACCEPT            DECLINE
               │                │
               ↓                ↓
          Route created      Next offer
               │
               ↓
            Navigate
               │
               ↓
             Pickup
               │
               ↓
       Check each order
               │
       ┌───────┴─────────┐
       │                 │
      Ready            Not ready
       │                 │
       ↓                 ↓
   Pick up         Leave pending
       │
       ↓
  More pickups?
       │
       ↓
   Route begins
       │
       ↓
Delivery stop
       │
       ↓
PIN required
       │
       ↓
PIN verified
       │
       ↓
Delivered
       │
       ↓
Next stop
```

---

# 151. Complete dispatch diagram

```text
                  NEW PAID DELIVERY
                         │
                         ↓
                Delivery requirements
                         │
                         ↓
               Find eligible riders
                         │
                         ↓
              Calculate candidate score
                         │
                ┌────────┴────────┐
                │                 │
            Rider 1            Rider 2
             1.4 km             4.8 km
                │
                ↓
              OFFER
                │
         ┌──────┴──────┐
         │             │
      ACCEPT         DECLINE
         │             │
         ↓             ↓
      ASSIGN        Next rider
         │
         ↓
        ROUTE
```

---

# 152. Complete batching diagram

```text
                 NEW ORDER
                     │
                     ↓
           Find nearby active riders
                     │
                     ↓
          Is rider already underway?
                     │
               ┌─────┴─────┐
               │           │
              No          Yes
               │           │
               ↓           ↓
       Check normal      Check route
       dispatch          insertion
                           │
                           ↓
                  Calculate:
                  distance
                  time
                  ETA impact
                  payout
                  priority
                           │
                           ↓
                    Good candidate?
                      /        \
                    NO          YES
                    │            │
                    ↓            ↓
               Don't offer   Ask rider
                             │
                      ┌──────┴──────┐
                      │             │
                   ACCEPT        DECLINE
                      │             │
                      ↓             ↓
                 Add route       Continue
```

---

# 153. Complete pickup diagram

```text
                   ARRIVE STORE
                       │
                       ↓
                Pickup screen
                       │
          ┌────────────┼────────────┐
          ↓            ↓            ↓
       Order A      Order B      Order C
          │            │            │
       Pick up      Pick up      Not ready
          │            │            │
          ↓            ↓            ↓
          ✓            ✓            ✕
          │            │            │
          └────────────┴────────────┘
                       │
             Everything ready?
                 /         \
               YES          NO
                │            │
                ↓            ↓
           Start route    Continue with
                          collected items
                             │
                             ↓
                     Check nearby batches
```

---

# 154. Customer-specific tracking diagram

```text
                  DRIVER ROUTE

              Pickup
                │
                ↓
             Stop A
                │
                ↓
             Stop B
                │
                ↓
             Stop C
                │
                ↓
             Stop D


Customer C sees:

Before C is active:
"Your driver is completing a few deliveries nearby."

When C activates:
"Your driver is on the way."

Live GPS:
       DRIVER
          ↓
       ETA 7 min
          ↓
      CUSTOMER

After PIN:
"Delivered ✓"

Then GPS access ends.
```

---

# 155. System-wide state relationship

The entire network should behave roughly like this:

```text
ORDER
  │
  ├── PAYMENT
  │
  ├── STORE PREPARATION
  │
  └── DELIVERY
        │
        ├── QUOTE
        ├── DRIVER
        ├── ROUTE
        ├── STOPS
        ├── TRACKING
        ├── PIN
        ├── EVENTS
        └── NOTIFICATIONS
```

This separation prevents the order table from becoming responsible for everything.

---

# 156. What happens when a new order appears mid-route

Example:

Rider already has:

```text
A
B
```

New order:

```text
C
```

System sees:

```text
C pickup
900m from current route
```

It calculates:

```text
+2.2 km
+6 min
Existing customer ETA impact +1 min
Additional payout +R18
```

Then asks:

> **Nearby delivery available**
>
> Add it to your route for **+R18**?
>
> [ Add ] [ Skip ]

This is exactly the kind of dynamic behaviour the system should encourage.

---

# 157. What happens when rider has too much work

Suppose:

```text
10 customers
```

would mean:

```text
~2 hours for the final customer
```

The system should not automatically conclude:

> "10 orders = one route."

Instead:

```text
10 orders
   ↓
calculate total route time
   ↓
calculate each customer ETA
   ↓
evaluate product sensitivity
   ↓
evaluate priority
   ↓
evaluate batching feasibility
   ↓
potentially split into:
Route A
Route B
Route C
```

This is much safer.

---

# 158. Priority can influence route splitting

Suppose:

```text
10 orders

2 priority
8 normal
```

The system could split the route intelligently so that priority isn't buried at the end of a huge route.

Again, the exact routing algorithm comes later.

The important thing is that the architecture supports it.

---

# 159. Delivery quote and route are different objects

This is important.

A **quote** answers:

> How much will the customer pay before checkout?

A **route** answers:

> How will the delivery actually be executed after payment?

They are related but not identical.

```text
QUOTE
↓
price / feasibility

ROUTE
↓
driver / pickups / stops / tracking
```

The route may change after payment because driver availability and live orders change.

The customer's paid price should not silently mutate just because the routing engine found a better route later.

---

# 160. That creates an important commercial rule

Once the customer has paid:

**Umzila owns the logistics optimisation risk.**

If Umzila finds a better route later:

the customer doesn't suddenly pay more.

If Umzila needs another rider:

the customer doesn't suddenly pay more.

If Umzila batches efficiently:

the customer doesn't need to know.

This is part of what makes the marketplace experience feel polished.

---

# 161. Rider payout can remain route-aware

The customer price can be fixed from the quote.

The rider payout can be calculated from the actual route.

For example:

```text
CUSTOMER
Paid R69

Actual final route:
15.4 km
3 stops
2 pickups

RIDER
Earns R47
```

The exact formula can be refined later.

This allows Umzila to optimise operational efficiency without exposing that complexity to customers.

---

# 162. Delivery revenue model

Conceptually:

```text
              CUSTOMER PAYMENT
                     │
          ┌──────────┴──────────┐
          │                     │
      DELIVERY                 PRIORITY
        FEE                     FEE
          │                     │
          ↓                     ↓
     Logistics pool          Umzila
          │
     ┌────┴────┐
     │         │
   Rider    Umzila
   payout    margin
```

The actual financial architecture must later account for refunds, cancellations, taxes, payment fees, and other applicable accounting requirements.

---

# 163. Failed PIN

If the rider enters the wrong PIN:

```text
PIN INCORRECT

Try again.
```

The delivery remains active.

It should not become delivered.

The system should log the failed attempt.

A future rule can limit suspicious repeated attempts and trigger admin review if necessary.

---

# 164. Wrong customer scenario

The delivery record should already be associated with:

```text
customer_id
```

The rider should be working from the route stop assigned to that delivery.

This reduces the chance of the wrong order being handed over.

---

# 165. Delivery instructions

Customer sees:

```text
Delivery instructions

Blue gate.
Ring bell.
```

The rider sees those instructions when approaching the stop.

That is a high-value feature because it solves an actual delivery problem without adding customer complexity.

---

# 166. Driver arrival

The rider can eventually have:

```text
[ ARRIVED ]
```

The system records arrival.

Customer can receive:

> **Your driver is here.**

and the PIN remains visible.

---

# 167. Driver nearby

Before arrival:

```text
ETA < threshold
```

could trigger:

> **Almost there.**

This should be carefully rate-limited so it doesn't spam customers.

---

# 168. Notifications should be state-driven

A useful architecture is:

```text
STATUS CHANGES
      ↓
CREATE EVENT
      ↓
EVENT HANDLER
      ↓
DECIDE WHETHER NOTIFICATION IS REQUIRED
      ↓
SEND
      ↓
LOG
```

That provides one central notification system.

---

# 169. Notification logging

Store:

```text
notification_id
recipient
channel
event
delivery_id
sent_at
status
provider_message_id
```

This makes it possible to investigate:

> "Why didn't I receive my delivery email?"

---

# 170. Email + in-app notification consistency

The same event should drive both.

For example:

```text
CUSTOMER_NEXT
```

creates:

```text
In-app:
"Your driver is heading to you."

Email:
"Your Umzila order is on the way."
```

Different wording, same underlying event.

---

# 171. Customer notification timeline

The account/order area could eventually contain:

```text
Order received
✓
Payment confirmed
✓
Preparing
✓
Collected
✓
Driver heading your way
✓
Delivered
✓
```

This means even if an email was missed, the customer can still see the history.

---

# 172. Admin notification control

Admin should be able to see notification failures:

```text
Customer #1024
CUSTOMER_NEXT
Email:
FAILED
```

This should not silently disappear.

---

# 173. Delivery complaints

If a customer complains:

```text
COMPLAINT #194

Order #1024
Store: Isqalo
Rider: Thabo
Delivery time: 19:42

Category:
Missing item
```

Admin can see the complete timeline.

That dramatically improves support quality.

---

# 174. Compliment system

Compliments can become useful positive signals.

For example:

> "Driver was very friendly."

could be associated with the rider.

> "Food was excellent."

could be associated with the seller/store.

This gives Umzila useful qualitative feedback.

---

# 175. The architecture should be extensible

Today's:

```text
Isqalo Shisanyama
```

becomes tomorrow:

```text
Isqalo
Store B
Store C
Store D
Store E
```

without redesigning the delivery layer.

The system should always use IDs and relationships:

```text
store_id
customer_id
driver_id
order_id
delivery_id
route_id
stop_id
```

rather than names embedded in logic.

---

# 176. Future Umzila shop domains

When:

```text
isqaloshisanyama.umzila.store
```

exists, its delivery still connects to:

```text
store_id = XXXXX
```

The domain is a storefront identity.

The delivery engine remains shared across the entire marketplace.

---

# 177. Future FBU compatibility

This architecture also fits Umzila's eventual fulfilment model.

A third-party seller could later store stock at an Umzila warehouse.

Then the pickup origin is simply:

```text
Warehouse location
```

instead of:

```text
Seller premises
```

The route engine doesn't care.

This is another reason to separate the concepts:

**product ownership**

from:

**pickup location**

from:

**delivery destination**.

---

# 178. What belongs to the seller

Very little.

```text
Products
Stock
Product quality
Pickup address
Order preparation
Customer feedback
```

That's basically it.

---

# 179. What belongs to Umzila

Almost everything logistics-related:

```text
Delivery pricing
Service area
Route calculation
Bundle decisions
Priority
Dispatch
Rider selection
Rider payout
Vehicle decisions
Tracking
Notifications
PIN confirmation
Exceptions
Support
Analytics
```

That is the proper division of responsibility.

---

# 180. What belongs to the rider

The rider should control:

```text
Online/offline
Accept/decline available jobs
Accept/decline optional batch suggestions
Pickup confirmations
Delivery PIN submission
Route progression
Issue reporting
```

But the system controls:

```text
which jobs are offered
route calculation
payout
customer pricing
service area
```

---

# 181. What belongs to the customer

The customer controls:

```text
destination
delivery instructions
standard/priority selection
checkout/payment
PIN knowledge
support/feedback
```

The customer does not control:

```text
rider
route
vehicle
batching
store pickup sequence
```

This makes the experience much simpler.

---

# 182. The core data domains

Again, without touching your actual Supabase schema yet, the conceptual model looks like:

```text
USERS / PROFILES
      │
      ├── CUSTOMER
      ├── SELLER
      ├── RIDER
      └── ADMIN

STORES
      │
      └── PICKUP LOCATION

ADDRESSES
      │
      └── VALIDATED DESTINATION

ORDERS
      │
      └── ORDER ITEMS

DELIVERY QUOTES
      │
      └── PRE-PAYMENT

DELIVERIES
      │
      └── CUSTOMER DELIVERY

ROUTES
      │
      └── ROUTE STOPS

DRIVERS
      │
      └── LIVE LOCATION

DISPATCH OFFERS
      │
      └── ACCEPT / DECLINE

DELIVERY EVENTS
      │
      └── TIMELINE

NOTIFICATIONS
      │
      └── EMAIL / IN-APP

SERVICE ZONES
      │
      └── DELIVERY ELIGIBILITY

PRICING
      │
      └── CONFIGURATION

PAYOUTS
      │
      └── DRIVER COMPENSATION

FEEDBACK
      │
      └── COMPLAINT / COMPLIMENT
```

---

# 183. The implementation should not blindly create all those tables

This is very important.

That is the conceptual design.

Your existing Umzila database already contains:

* products
* orders
* carts
* profiles
* payment-related information
* potentially shop relationships

So the actual implementation should first inspect the current structure.

Then determine:

```text
Existing table can be extended
vs.
New table required
vs.
Existing relationship needs correction
```

This prevents unnecessary rebuilding.

---

# 184. What the technical audit needs to inspect

Before implementation:

### Supabase

* all relevant tables
* columns
* foreign keys
* indexes
* RLS policies
* triggers
* functions
* existing enum/status values
* product/store relationships
* order/order-item relationships

### Current frontend

* index.html
* cart
* checkout
* order status
* profile
* seller dashboard
* admin dashboard
* login/auth

### Netlify functions

* checkout/payment
* PayFast ITN
* cart validation
* order creation
* Supabase connection
* Resend/email

The current implementation will determine exactly where the new delivery layer should connect.

---

# 185. Current stack assumption

The implementation plan must be based on the fact that Umzila currently remains:

```text
HTML
CSS
JavaScript
Supabase
Netlify
```

React + Vite has not been built yet.

Therefore, the delivery system should not assume React components already exist.

The system should be designed so the current site can adopt it now.

The eventual React migration can move the UI over later.

---

# 186. Recommended implementation sequence

The build should happen in controlled stages.

## Stage 1 — Audit existing system

Understand what already exists.

## Stage 2 — Address infrastructure

Build:

```text
validated addresses
geolocation
delivery instructions
service-zone checks
```

## Stage 3 — Delivery quote engine

Build:

```text
distance
routing
delivery eligibility
pricing
quote
```

## Stage 4 — Multi-store bundle engine

Build:

```text
store grouping
inter-store routing
bundle feasibility
split delivery logic
```

## Stage 5 — Checkout integration

Connect the validated quote to actual payment.

## Stage 6 — Delivery/order states

Build the delivery state machine.

## Stage 7 — Seller pickup workflow

Orders → ready → pickup.

## Stage 8 — Rider system

Online state → heartbeat → offers → acceptance.

## Stage 9 — Pickup management

Individual order pickup confirmations.

## Stage 10 — Route and multi-drop system

Routes → stops → sequencing.

## Stage 11 — Optional dynamic batch offers

Check suitability → ask rider → extra payout.

## Stage 12 — Customer tracking

Live tracking only when appropriate.

## Stage 13 — PIN delivery confirmation

Profile PIN → rider input → Supabase confirmation.

## Stage 14 — Notification system

Resend + in-app events.

## Stage 15 — Homepage active-delivery widget

Tracking re-entry directly from index.

## Stage 16 — Admin operations dashboard

Full logistics view.

## Stage 17 — Analytics / optimisation

Route economics, ETA accuracy, batching performance.

---

# 187. MVP versus future features

The first working Isqalo version should focus on:

```text
Address validation
Service-area validation
Road routing
R36-based pricing
Delivery quote
Payment integration
Driver availability
Driver offers
Pickup confirmation
Basic multi-stop
Customer tracking
4-digit PIN
Realtime status
Resend notifications
Seller active orders
Admin dashboard
```

Then add:

```text
Dynamic batch offers
Advanced route insertion
Preparation prediction
Advanced analytics
Historical route optimisation
Service-zone analytics
More sophisticated delivery pricing
```

This keeps the first implementation manageable without designing us into a dead end.

---

# 188. The Isqalo pilot

The first real test should be:

```text
ONE SHOP
      ↓
ISQALO SHISANYAMA
      ↓
DURBAN WORKSHOP
      ↓
CUSTOMERS IN APPROVED AREA
```

This allows us to test:

* address validation
* delivery radius/zone
* R36 pricing
* routing
* pickup
* one driver
* multiple customers
* tracking
* PIN delivery
* notifications

before introducing a large number of shops.

---

# 189. Then test multiple stores

After Isqalo works:

```text
Isqalo
+
Store B
```

Test:

```text
nearby stores
```

Then:

```text
Isqalo
+
Store B
+
Store C
```

Test:

```text
bundle
```

Then:

```text
far store
```

Test:

```text
split delivery
```

That specifically validates the bundle engine.

---

# 190. Then test multi-customer routing

Start:

```text
1 driver
1 customer
```

Then:

```text
1 driver
2 customers
```

Then:

```text
1 driver
5 customers
```

Then dynamic:

```text
5 customers
+
new order while route is active
```

That is where the optional rider batch mechanism gets tested.

---

# 191. Then test exceptions

We should deliberately simulate:

```text
No driver
Driver declines
Driver disconnects
Store not ready
Partial pickup
Wrong PIN
Customer unavailable
Route changes
New order arrives
Priority order arrives
Bundle becomes invalid
```

A logistics system isn't really finished when the happy path works.

It is finished when the ugly paths are predictable.

---

# 192. Success criteria

The initial Isqalo system should eventually satisfy:

### Customer

Can enter a genuine address.

Can see whether delivery is available.

Knows delivery cost before payment.

Can pay the correct total.

Can see order progress.

Gets proactive notifications.

Can track the rider when appropriate.

Sees their PIN prominently.

Can confirm receipt through PIN.

Can submit feedback.

### Seller

Can enter pickup address.

Can prepare orders.

Can mark orders ready.

Can see active deliveries.

Can see delivered orders.

Can receive complaints/compliments.

Nothing else operational is required.

### Rider

Can go online.

Receives suitable offers.

Sees payout before accepting.

Can accept/decline.

Can navigate to pickup.

Can confirm each pickup.

Can manage multiple deliveries.

Gets optional batch opportunities.

Sees extra payout before accepting a batch.

Can enter customer PIN.

Can complete the route.

### Admin

Can see everything.

Can see active riders.

Can see deliveries.

Can monitor routes.

Can manage service areas.

Can investigate issues.

Can see payout/revenue information.

Can intervene when required.

---

# 193. The deeper strategic idea

The most interesting part of this isn't actually the tracking map.

The real Umzila advantage could eventually become:

```text
MARKETPLACE
      +
SMART BUNDLING
      +
LOCAL DELIVERY NETWORK
      +
DYNAMIC RIDER DISPATCH
      +
CUSTOMER EXPERIENCE
```

The customer simply sees:

> Order → Prepare → On the way → Arriving → Delivered

But underneath:

```text
Multiple stores
Multiple orders
Multiple customers
Multiple pickup locations
Multiple riders
Dynamic routes
Real-time locations
```

are being coordinated.

That is the actual infrastructure being built.

---

# 194. The ultimate Umzila delivery architecture

```text
                         UMZILA
                           │
              ┌────────────┴────────────┐
              │                         │
         MARKETPLACE                LOGISTICS
              │                         │
       Products / Stores        Address validation
       Cart / Checkout          Service zones
       Payments                 Pricing
                                Bundling
                                Dispatch
                                Riders
                                Routes
                                Tracking
                                PIN
                                Notifications
              │                         │
              └────────────┬────────────┘
                           │
                    CUSTOMER EXPERIENCE
                           │
          ┌────────────────┼────────────────┐
          │                │                │
       CUSTOMER          RIDER            SELLER
          │                │                │
       Simple          Powerful          Simple
       polished        operational       informative
       tracking        dashboard         dashboard
```

The complexity is hidden underneath.

That is exactly what we want.

---

# 195. Final design principles

The system should permanently follow these principles:

### 1. Delivery is calculated before payment.

Never discover delivery feasibility after payment.

### 2. Road distance matters.

Don't use straight-line distance for pricing or route decisions.

### 3. Postal code assists; geography decides.

Use coordinates and service zones rather than treating postal code as sufficient.

### 4. Umzila controls logistics.

Sellers provide products and pickup locations.

### 5. Bundling is its own system.

Do not bury bundle decisions inside checkout.

### 6. Batching is optional for riders.

The system suggests useful additions; riders decide.

### 7. Customer ETA matters.

Never optimise batching purely for mileage or Umzila margin.

### 8. Customer simplicity is paramount.

Expose useful information, not internal logistics complexity.

### 9. Tracking begins when the customer actually needs it.

Do not show them the rider wandering around other deliveries.

### 10. PIN confirmation is authoritative.

No PIN, no completed delivery.

### 11. Supabase is the source of persistent truth.

Realtime gives speed; fresh queries/revalidation provide correctness.

### 12. Driver payout is known before the offer.

Riders should know what they are accepting.

### 13. Customer price and rider payout are separate calculations.

This allows proper economics.

### 14. Priority is an explicit product.

Priority increases dispatch importance without requiring surge pricing.

### 15. Every operational event should be traceable.

The delivery timeline is essential for support and analytics.

### 16. Exceptions are part of the product.

No rider, failed PIN, late store, reassignment and missing package all need defined behaviour.

### 17. The experience should feel distinctly Umzila.

The tracking interface, animation, writing and subtle easter eggs should turn "waiting for a delivery" into a small part of the product experience itself.

### 18. The implementation must fit the existing application.

The first version is built around the existing HTML/CSS/JavaScript + Supabase + Netlify architecture.

### 19. Do not redesign the database from imagination.

The actual Supabase schema must be inspected before writing migrations.

### 20. Build for the marketplace you want, but validate with the one shop you have.

Isqalo is the pilot. The architecture is Umzila-wide.

---

# 196. Final note on what this plan is

This plan is a **systems design created from the product requirements and brainstorming**, not a claim that Umzila's existing code or Supabase database already has these structures.

It has deliberately **not assumed the exact existing schema, table names, columns, RLS policies, relationships, JavaScript architecture, Netlify functions, or checkout implementation**.

It has also deliberately left the initial delivery tariff, service-zone boundaries, payout formula, priority price, maximum distance and similar commercial variables configurable rather than pretending we already know the correct answer.

The next implementation step therefore should not be:

> "Create all these tables."

It should be:

```text
CURRENT UMZILA
      ↓
SUPABASE AUDIT
      ↓
CURRENT HTML / JS AUDIT
      ↓
CURRENT NETLIFY FUNCTIONS AUDIT
      ↓
MAP EXISTING SYSTEM
      ↓
MAP NEW DELIVERY SYSTEM ONTO IT
      ↓
IDENTIFY MINIMUM CHANGES
      ↓
WRITE DATABASE MIGRATIONS
      ↓
IMPLEMENT
      ↓
TEST
      ↓
ITERATE
```

The purpose of this document is to give us a **stable target architecture**.

Only after the actual Umzila codebase and Supabase structure have been inspected should the detailed implementation plan be written, because then we can distinguish what Umzila already does from what the new delivery network actually needs to add.

