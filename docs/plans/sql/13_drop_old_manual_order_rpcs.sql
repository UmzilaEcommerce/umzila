-- Run AFTER the manual-order.js build (2026-11-17) is deployed: the old logistics
-- page still calls these until then. Nothing else in the database calls them
-- (checked 2026-11-17). See docs/systems/manual-orders.md.
drop function if exists public.handle_logistics_order(uuid, jsonb);
drop function if exists public.logistics_record_manual_payment(uuid, text);
