use existing tables on supabase as much as you can,only creating new tables if completely necessary.
do not edit or modify any of the netlify functions linked with payfast drastically, they work and are correct.
do not put any supabase keys in the frontend and use existing functions and code as much as possible before creating anything new, if creating something new, make sure there is no other option first.
if there are already duplicate stuff on supabase and files using separate tables for example, but for the same data, and you see flaws, fix all of that, delete tables or columns or anything to make it as minimal and viable and streamlined as possible. do not have files looking at different places for the same info or updating wrong tables unused by other files.
never write the site in the frontend, always use SITE_BASE_URL variable in netlify.

📚 CHANGE DOCUMENTATION & SYSTEM NOTES — STANDING RULE (applies automatically, every session, no need to be asked)
Read `docs/CHANGELOG.md` and any relevant `docs/systems/*.md` FIRST when picking up work in an area not already understood this session — that's the fast path to current state instead of re-deriving it from the code every time.
Whenever a drastic change is made — a significant bug fix touching a core flow (checkout, cart, payments, auth, seller system), a multi-file fix, or a new feature — before considering the task done:
1. Add a dated entry to `docs/CHANGELOG.md` (create it if missing, newest entry first): what was broken/reported, the actual root cause (not just the symptom), what changed, and which files were touched.
2. If the change involved building or substantially reworking a whole system (not a one-off bug fix — e.g. a multi-stage feature build, or a tangled area like cart-loading that took real effort to untangle), create or update a dedicated doc at `docs/systems/<system-name>.md`, written in plain prose, not just a diff summary: what the system does end-to-end, the key pieces and how they connect, why non-obvious decisions were made, known limitations/gotchas, and what to check before touching it again. Link it from the CHANGELOG entry.
3. Update this file (CLAUDE.md) itself if the change affects the constraints/rules below (a new table, a new convention, a corrected assumption) — this file must always reflect current reality, not a snapshot from whenever it was last edited.
This is a durable, ongoing convention, not a one-time task — keep applying it without being reminded.

🚫 UMZILA SELLER SYSTEM — STRICT “DO NOT” RULES
🧱 ARCHITECTURE / SYSTEM INTEGRITY
Do not rewrite or replace existing working systems (checkout, PayFast, seller approval, auth flow)
Do not introduce parallel systems that duplicate existing logic (e.g. separate payment handling, separate order tables)
Do not change existing data flow unless absolutely necessary and justified
Do not create “temporary hacks” that bypass proper flows (e.g. skipping ITN verification)
Do not break backward compatibility with current frontend or database usage
Do not tightly couple unrelated systems (e.g. seller logic interfering with buyer checkout)
💳 PAYFAST / PAYMENTS (CRITICAL)

Do not change parameter ordering or signature logic (PayFast is extremely strict)
Do not manually verify payments on the frontend
Do not trust query params like payment_status=COMPLETE — always rely on ITN + database
Do not create a separate payment verification system
Do not skip writing to the orders table before payment
Do not assume a payment succeeded until orders.order_status = 'paid'
🔐 SECURITY / KEYS / ACCESS
Do not expose:
Supabase service role key
PayFast merchant key/passphrase
Any secret environment variables
Do not put any sensitive keys in frontend JavaScript
Do not bypass role checks (profiles.role)
Do not trust client-provided data for authorization
Do not allow direct access to seller-dashboard without verifying user role
Do not allow users to modify data they do not own (e.g. other sellers’ products/orders)
🗄️ DATABASE / SUPABASE
Do not create new tables unless absolutely necessary
Do not duplicate data across multiple tables unnecessarily
Do not store the same concept in two places (e.g. two “orders” tables)
Do not break existing schema relationships
Do not rename or delete existing columns without checking full system usage
Do not insert incomplete or inconsistent records
Do not assume nullable fields always exist — always check
Do not hardcode IDs or rely on fragile assumptions
🔁 DATA FLOW / STATE MANAGEMENT
Do not rely on frontend state as source of truth
Do not assume actions succeeded without backend confirmation
Do not skip validation before database writes
Do not create race conditions (e.g. duplicate inserts on refresh)
Do not allow duplicate seller creation for same application
Do not assume sequential execution in async flows
👤 AUTHENTICATION / ROLES
Do not allow seller-dashboard access without:
authenticated user
profiles.role === 'seller'
Do not mix admin and seller permissions
Do not assume user role without querying the database
Do not store role logic only in frontend (must be enforced logically)
Do not allow sellers to escalate privileges
🧾 SELLER SYSTEM LOGIC
Do not recreate seller records if one already exists
Do not unlink seller from application incorrectly
Do not overwrite seller data unintentionally
Do not allow sellers to edit other sellers’ shops/products
Do not allow product creation without required fields (name, price, stock, etc.)
Do not allow invalid pricing (e.g. sale price > original price)
🖼️ IMAGES / FILE UPLOADS
Do not rely only on image URLs — support proper uploads
Do not store broken or empty image URLs
Do not assume images always exist
Do not overwrite product images incorrectly when reordering
Do not lose the “primary image” (sort_order = 0) logic
🛒 PRODUCTS / LISTINGS
Do not allow products without:
title
price
stock
category
Do not break existing product display logic on main site
Do not remove compatibility with current products table
Do not ignore stock validation
Do not allow negative or invalid values
📦 ORDERS
Do not allow sellers to see orders that are not theirs
Do not modify entire order when seller should only update their portion
Do not overwrite payment status manually
Do not allow invalid status transitions (e.g. delivered → pending)
Do not break linkage between orders and products
❤️ FAVOURITES SYSTEM
Do not allow infinite duplicate favourites from same user
Do not assume user identity always exists
Do not break product performance when counting favourites
Do not block UI if favourites fail to load
Do not store favourites in a way that cannot scale
🔔 NOTIFICATIONS
Do not spam duplicate notifications
Do not create notifications without linking to relevant entity (product/order)
Do not block dashboard if notifications fail
Do not assume notification actor always exists (handle anonymous)
📊 ANALYTICS
Do not calculate analytics globally — must be per seller
Do not mix data across sellers
Do not trust frontend calculations for financial data
Do not display misleading or partial analytics without fallback
Do not break performance with heavy queries
🎨 UI / UX
Do not build desktop-only UI — must be mobile-friendly
Do not create confusing flows (everything should feel guided)
Do not hide critical actions behind unclear UI
Do not allow user to get stuck without feedback
Do not remove existing working UI unless replacing it properly
⚙️ PERFORMANCE / STABILITY
Do not create unnecessary API calls
Do not reload entire page when small updates can be handled locally
Do not block UI during async operations without loading states
Do not crash on empty or missing data
Do not assume network always succeeds
🧪 TESTING / SAFETY
Do not ship without testing:
seller onboarding
payment flow
dashboard access
product creation
order updates
Do not test only happy paths — include edge cases
Do not ignore console errors
Do not deploy unverified database changes
🧠 DEVELOPMENT DISCIPLINE
Do not write code without understanding existing system first
Do not duplicate logic that already exists elsewhere
Do not introduce new patterns inconsistent with current codebase
Do not over-engineer simple flows
Do not under-engineer critical flows (payments, auth, orders)
🔥 YOUR ORIGINAL RULES (REFINED)

You were already thinking correctly — here’s your original ones, sharpened:

Use existing Supabase tables wherever possible; only create new tables if there is no viable alternative
Do not modify any PayFast-related Netlify functions — they are correct and must remain untouched
Do not expose any Supabase or PayFast keys in frontend code
Reuse existing functions and logic before creating anything new
If creating something new, verify thoroughly that no existing solution already exists
🔗 STORE URLS (added 2026-10-03)
Every store's public link is umzila.store/<slug> using sellers.slug — never build store links from shop_name. sellers.slug is NOT NULL, unique, auto-generated for every new seller by the sellers_assign_slug trigger (whichever function inserts the row), unchanged when a shop is renamed, and only changeable by admins/service role (admin.html → Manage Shops → Store link). Reserved page names are listed in public.seller_slug_reserved() — add any new top-level page name there. Routing: netlify.toml rewrites /:slug → shop.html; legacy shop.html?shop=<name> links still work and are swapped for the clean URL. When adding a query that renders a store link, include slug in the select.

👥 STORE OWNERS (added 2026-10-03)
A store can have several equal owners: sellers.user_id (primary) + public.seller_members (co-owners). Any "stores I own" check must use public.my_seller_ids() (all ownership RLS already does). Only admins add/remove owners (admin_add/remove/list_seller_members). Sellers cannot change sellers.status/free_enrollment/application_id/self_arranged_radius_km/user_id, and nobody can self-assign profiles.role or is_admin (guard triggers).

📅 SERVICES, BOOKINGS, VOUCHERS (added 2026-10-03) — read docs/systems/service-orders.md first
Six service kinds (booking, in_person, dropoff_return, dropoff_kept, digital, voucher), one serviceKind() rule mirrored in 5 files — change them together. Booking capacity = sellers.booking_capacity × service_bookings.units, enforced by trigger; holds only via hold-service-booking.js; pickers read get_booking_load(). Gift vouchers are discount_codes type 'gift_voucher' (store credit, balance, 3 years). R0 orders complete via complete-zero-total-order.js (server re-pricing). Guests can check out (pending-only anon insert; verified guest path in generate-payfast-signature). Supabase query builders have NO .catch() — use { error }.

🏬 STORE PAGES (added 2026-10-04) — read docs/systems/store-pages.md first
shop.html is the default template for every store without a bespoke folder. Store sections = products.metadata.store_section (falls back to category; never change the main-site category for this). Store accent = sellers.theme_color. Opening hours = seller_availability (one set per store, same rows as booking hours); open/closed only via get_store_hours_status() (SAST, server-side). Saved stores = public.saved_stores (own rows; guests use localStorage ss_saved_stores, merged at sign-in). One cart for all of Umzila (ss_cart + carts row); a store page shows/checks out only its lines via checkout.html?store=<seller id> — every cart write must keep the other lines (scopeCart/cartRest/persistLocalCart, persistCart:false to validate-cart, ss_cart_after_paid on success). carts.items is always the server shape (product_id/quantity/name/image); ss_cart the browser shape (id/qty/title/img) — convert when crossing. Closed-store messaging is for GOODS only — services (any kind) never get a closed warning or checkout popup; a service-only store just shows when it opens. Every bespoke store keeps the Umzila strip ("‹ Umzila home" pill) + back-arrow.

🔐 BUYER IDENTITY (added 2026-10-04): server functions identify the buyer from the Authorization Bearer token, never from a userId in the request body (validate-cart.js, get-delivery-quote.js, hold-service-booking.js). Server-to-server callers pass event.trustedUserId to validate-cart.

📦 SOLD OUT (added 2026-10-04): products.visible means "listed", NOT "in stock" — nothing auto-hides at 0 stock any more. Stores show sold-out items ("Sold out · Notify me"); the homepage only browses/ranks/suggests browsableProducts() (listed + in stock) and shows sold-out items only in search results, last. Stock is enforced in validate-cart.js (physical stock is a hard cap) and addToCart — never rely on visible for stock.

🎟️ CODES & ACCOUNTS (added 2026-10-04): only reusable "once per person" codes (discount_codes.multi_use) need an account; one-off codes (gift vouchers, mystery gift, referral) stay guest-usable. A guest entering a multi-use code gets the inline create-password / sign-in panel under the code box (checkout.html renderPromoSignin / signInOrCreateAccount) — never send them away.

🗺️ ADDRESSES & DISTANCE (added 2026-10-04): address suggestions = HERE via netlify/functions/address-search.js (HERE_API_KEY, server-only); road distance = OpenRouteService via lib/road-distance.js (ORS_API_KEY), every leg cached forever in route_distance_cache — never call a routing API without going through it. No Google Maps/Places/Routes and no Photon anywhere. Physical delivery ONLY inside an active service_zones row (admin → Service Areas) — outside every zone there is no delivery and no fallback fee: checkout blocks Pay and offers "Notify me when you deliver here" (request-delivery-area.js → delivery_area_requests + email); validate-cart's finalCheck enforces it server-side. Province is KwaZulu-Natal only for now. Free delivery = products.free_delivery OR sellers.free_delivery (admin-only); "free over R…" is off (threshold null). Customer delivery price = netlify/functions/lib/delivery-price.js (2026-10-04): R34 for the first 3 road-km, +R0.40/km, max R45 (bundles included); without a live distance (routing down / store has no pickup pin) a flat R39 — validate-cart.js (authoritative) + checkout.html (preview mirror), change together. Rider pay = the same band per delivery (+R3 per extra store, max R45, paid even on free-delivery orders) — lib/payout-formula.js (offer estimate) + compute_driver_payout_on_route_completion trigger (authoritative), change together with delivery-price.js. Checkout locates a signed-in buyer's saved address on load (profiles.saved_address_geo, written on each order).

🚚 DELIVERY TRACKING (added 2026-10-04): every paid order with a destination + physical items gets a deliveries row in create_delivery_on_payment (stand-in quote if checkout attached none; self-arranged stores skipped) — never make delivery creation depend on the browser again. Sellers only "Mark Ready for Pickup"; nothing on the seller side writes orders.order_status. order_items is written ONLY by the populate_order_items_on_payment trigger (complete-order-payment.js skips if rows exist — never add another writer). Customers track via the private link /track.html?order=<id>&t=<deliveries.tracking_token> (success page, confirmation + delivery emails) or, signed in, their own orders. Guest orders are linked to an account only via claim_order_with_token (private link + same email) or claim_my_email_orders (CONFIRMED email only); devices remember links in localStorage ss_track_links.

💳 SAVED CARDS (added 2026-10-04): many per user (payment_methods, one PayFast token each, display_name = buyer's nickname). Checkout's "Save this card" switch is on by default and alone decides subscription_type=2. A card is only ever saved to orders.user_id or, for a guest, to the account that VERIFIED that email (verified_user_id_for_email / claim_my_email_orders) — never via profiles.email. Pressing Pay = agreeing to the Terms (agreeAndRun ticks the hidden checkbox).

✉️ EMAIL OWNERSHIP (added 2026-10-04): Supabase "Confirm email" is ON. Anything matched by email (orders, discount_codes, subscribers, guest-order linking) must use public.my_verified_email() — never auth.email(), the JWT email or profiles.email (user-editable; auto-confirmed/admin-created accounts never proved the address). Every signUp passes emailRedirectTo (current page) and handles "no session yet"; every signInWithPassword handles email_not_confirmed by re-sending the link.

🛵 OPS PANELS (added 2026-10-04) — read docs/systems/ops-panels.md first. Routes are multi-drop TRIPS (2026-10-05): up to 5 orders, stop-driven advance-route.js (current stop + stopId guard), additions planned by lib/route-insertion.js (8-min rule, priority rule) and applied only via apply_route_sequence(); customers on a shared trip see only their own stops (no rider position until IN_ROUTE). Priority = delivery_quotes.priority_fee > 0 (checkout toggle, fee in delivery_pricing_config). The rider app reads ONLY get_driver_board() (own driver row; customer contact only on the rider's active route; offers never show who). Staff screens (logistics Today/Orders, admin Live now) read get_ops_board() (admins + active logistics/admin user_roles). Order status shown to staff = live delivery status when one exists (orders.order_status stays 'paid'). Logistics saveOrder() never writes user_id/created_at/payment_status on an existing order. Customers see only the rider's first name (get_delivery_tracking.driver_name).

🔔 BACK-IN-STOCK (added 2026-10-04): "Notify me" inserts stock_alerts (one pending row per product+email; 23505 = already on the list; signed-in buyers use their account email, no typing). send-stock-alerts.js (scheduled every 15 min in netlify.toml) emails once the product is visible + in stock and stamps notified_at.

🎨 BESPOKE STOREFRONTS — see docs/systems/bespoke-storefronts.md. A folder named after a store's slug (e.g. /ncekeniquads/) overrides the generic shop page; it is a skin over Umzila data/cart/checkout, never its own payment flow.
