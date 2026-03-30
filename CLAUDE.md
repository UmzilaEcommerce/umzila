use existing tables on supabase as much as you can,only creating new tables if completely necessary.
do not edit or modify any of the netlify functions linked with payfast in any way, they work and are correct.
do not put any supabase keys in the frontend and use existing functions and code as much as possible before creating anything new, if creating something new, make sure there is no other option first.
if there are already duplicate stuff on supabase and files using separate tables for example, but for the same data, and you see flaws, fix all of that, delete tables or columns or anything to make it as minimal and viable and streamlined as possible. do not have files looking at different places for the same info or updating wrong tables unused by other files.

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