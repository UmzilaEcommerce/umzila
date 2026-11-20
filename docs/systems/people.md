# People (admin → Intelligence → People)

Built 2026-11-20. It lets an admin look up one person (by email, name or phone) and see when they were last on Umzila, the pages they opened each day, the products they looked at, their baskets, orders and codes. It works for guests as well as accounts.

## The problem it solves

Each browser has two permanent ids in localStorage, and before this they were never connected:

- `umz_presence_id` (a uuid): the visit counter. presence.js sends it to `touch_presence` about once a minute and it becomes `site_visits.session_id`. Visit history starts on 7 Oct 2026 and is kept for 120 days.
- `ss_anon_id` (`anon-…`): the basket and behaviour id. It is `carts.anonymous_id` for guest baskets and `user_events.anonymous_id` for product clicks, add-to-carts, searches and store views. Events go back to 30 Mar 2026.

A guest's email was only ever attached to the basket id, and only once they had a basket. So a guest who typed their email in the mystery-gift pop-up and never filled a basket could not be found at all, and nobody's visits could be tied to an email.

## How it works

- **`public.site_browsers`**: one row per browser.
  - It holds `anon_id` (pk), `presence_id` (unique), `user_id`, and `email` / `name` / `phone` (the latest typed on that browser), plus `contact_at`, `first_seen` and `last_seen`.
  - RLS is on with no policies, and anon/authenticated have no grants. Only the SECURITY DEFINER functions below touch it.
- **The heartbeat.** `touch_presence(p_session, p_page, p_anon, p_email, p_name, p_phone)` works as before and also upserts the `site_browsers` row.
  - The new parameters are optional, so an old cached presence.js still works.
  - The email is validated like `save_guest_cart`.
  - The row is rewritten at most every 2 minutes unless something changed.
- **presence.js**:
  - every beat sends `anonId()` plus the remembered `umz_guest_contact` (the email/name/phone from the pop-up, checkout, spin or a store promo);
  - `umzilaGuestContact()` fires a beat immediately, so the link is made the moment someone types their email.
- **Why past visits come along.** Both ids are permanent per browser. Once one beat links them, every earlier `site_visits` row and `user_events` row for that browser belongs to the person.
  - Past emails typed on a browser are still in its localStorage (`umz_guest_contact`, kept since Oct 2026), so a returning guest is identified on their first visit after this change, with their whole history.
- **Seeding.** On creation, `site_browsers` was filled from:
  - guest `carts` rows: basket id → email, name, phone;
  - `user_events` rows that carry both a basket id and a user_id (signed-in browsing).

  These rows have no `presence_id` until the browser returns, but their behaviour events link straight away.

## Admin functions (admins only: `people__assert_admin()` checks `admins`)

- `admin_find_people(q)`: up to 30 emails matching an email, name or phone fragment (phones compared on the last 9 digits). It searches across:
  - auth.users
  - site_browsers
  - carts
  - orders
  - subscribers
  - discount_codes
- `admin_person(email)`: names, phones, account, browsers, visits by day (up to 60 days), the latest 150 behaviour events, baskets, orders, codes and the subscriber row.
- `admin_recent_people(days)`: everyone we can name who was seen in the period, plus a count of browsers we can't name.
- Helpers (not callable by clients):
  - `people__ids(email)` resolves an email to its accounts, basket ids and visit ids;
  - `people__last_seen(email)` is the latest of visits, events, baskets, orders, mystery/free-item claims and sign-ins.

## Gotchas

- **A guest's email is self-typed, not proven.** Treat it as "who said they were using this phone". It is never used for anything except this admin view. Don't use it for access, codes or order linking: those keep using `my_verified_email()`.
- **One browser, one latest contact.** A shared phone shows under whoever typed last.
- **Promo codes are not visits.** Store-promo codes created in bulk (e.g. 7 and 14 Oct) are not counted as activity. Only mystery/free-item claims are.
- **Clearing the browser** or switching phones starts a new, unlinked browser until they type their email or sign in again.
- **Staff accounts appear too** (People is not filtered like Intelligence's money figures).
- **Privacy:** this is personal data under POPIA. The site has no privacy page yet. One should say that visits and activity are recorded and linked to the email you give.
