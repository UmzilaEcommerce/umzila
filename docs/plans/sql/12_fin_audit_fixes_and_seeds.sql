-- 12_fin_audit_fixes_and_seeds.sql — Finances workstream A, part 3 (applied 2026-11-16 as migration fin_audit_fixes_and_seeds)
-- 1. get_ops_board: 'stores' ignores the house seller (Umzila Drinks) and attributes manual-order lines
--    via products.seller_id when order_items.seller_id is NULL (audit A10).
-- 2. get_site_traffic: "Where orders come from" leaves out orders excluded as tests in Finances (audit A15).
-- 3. Drops unused objects (grepped repo + DB functions/views/triggers 2026-11-16):
--    table "Logistics" (2 role-marker rows; both users already have user_roles admin rows),
--    table user_roles_backup (1 row, a copy of an existing user_roles row),
--    view delivery_analytics_summary_v + function get_delivery_analytics_summary() (nothing reads them;
--    admin Delivery Analytics is rebuilt on fin_delivery_breakdown). discount_redemptions is KEPT
--    (written by lib/complete-order-payment.js, read by lib/discounts.js + manage-discount-codes.js).
--    route_profitability_v / get_route_profitability are KEPT (admin.html still reads them).
-- 4. Seeds per founder answers: the R5 Apple Pay test order excluded + its rider pay overridden to 0;
--    the 4 hand-entered ORD- orders that were Delivered/Fulfilled but payment 'pending' (R460) recorded as cash.
--    (The founder said "3"; the R460 he referred to is these 4: ORD-790502 R12, ORD-496470 R12, ORD-631232 R56, ORD-270760 R380.)

-- 1 ─ get_ops_board house filter (patched in place so the rest of the function is untouched)
do $$
declare d text;
begin
  d := pg_get_functiondef('public.get_ops_board()'::regprocedure);
  d := replace(d,
    'from order_items oi join sellers s on s.id = oi.seller_id where oi.order_id = d.order_id)',
    'from order_items oi left join products pr on pr.id = oi.product_id join sellers s on s.id = coalesce(oi.seller_id, pr.seller_id) where oi.order_id = d.order_id and not coalesce(s.is_house, false))');
  if position('not coalesce(s.is_house, false)' in d) = 0 then raise exception 'get_ops_board patch did not apply'; end if;
  execute d;
end $$;

-- 2 ─ get_site_traffic: skip test-excluded orders in the sources block
do $$
declare d text;
begin
  d := pg_get_functiondef('public.get_site_traffic(integer)'::regprocedure);
  d := replace(d,
    'where source is not null and payment_status = ''paid'' and created_at',
    'where source is not null and payment_status = ''paid'' and not exists (select 1 from finance_entries fe where fe.order_id = orders.id and fe.adjustment_type = ''exclude_test'' and fe.voided_at is null) and created_at');
  if position('exclude_test' in d) = 0 then raise exception 'get_site_traffic patch did not apply'; end if;
  execute d;
end $$;

-- 3 ─ unused objects
drop function if exists public.get_delivery_analytics_summary();
drop view if exists public.delivery_analytics_summary_v;
drop table if exists public."Logistics";
drop table if exists public.user_roles_backup;

-- 4 ─ seeds
insert into public.finance_entries (kind, category, description, amount, occurred_on, order_id, adjustment_type, adjustment_value)
select 'adjustment', 'exclude_test', 'founder QA order: R5 Apple Pay test (seeded 2026-11-16) — unmark if real', 0,
       public.fin__order_day(o), o.id, 'exclude_test', null
  from public.orders o
 where o.order_number = 'UMZILA-1794821590398-xbh5lqmgw'
   and not exists (select 1 from public.finance_entries e where e.order_id = o.id and e.adjustment_type = 'exclude_test' and e.voided_at is null);

insert into public.finance_entries (kind, category, description, amount, occurred_on, order_id, adjustment_type, adjustment_value)
select 'adjustment', 'rider_pay_override', 'R39.25 rider payout on the R5 test was not paid (founder 2026-11-16)', 0,
       public.fin__order_day(o), o.id, 'rider_pay_override', 0
  from public.orders o
 where o.order_number = 'UMZILA-1794821590398-xbh5lqmgw'
   and not exists (select 1 from public.finance_entries e where e.order_id = o.id and e.adjustment_type = 'rider_pay_override' and e.voided_at is null);

update public.orders
   set payment_status = 'paid', payment_method_code = 'cash', paid_at = coalesce(paid_at, created_at at time zone 'UTC')
 where order_number in ('ORD-790502', 'ORD-496470', 'ORD-631232', 'ORD-270760')
   and pf_payment_id is null and m_payment_id is null
   and payment_status is distinct from 'paid'
   and order_status in ('Delivered', 'Fulfilled');
