-- 11_fin_rpcs.sql — Finances workstream A, part 2: the RPCs (applied 2026-11-16 as migrations fin_rpcs_engine, fin_rpcs_admin, fin_rpcs_staff;
-- small in-place fixes fin_rpcs_engine_fix_discount_alias, fin_rpcs_engine_fix_manual_source, fin_rpcs_est_amount_after_discount — this file is the final source)
-- Contract: docs/plans/admin-logistics-audit-and-finances-plan.md §2.3 as amended by
-- docs/plans/finances-contract-changes.md (read that first — commission is a MARK-UP, not 15 %).
-- Every function: SECURITY DEFINER, search_path public, extensions; REVOKE FROM PUBLIC, anon, authenticated;
-- GRANT to authenticated only for the callable ones (each checks admin/staff inside).

-- ───────────────────────── helpers (internal, not callable by clients) ─────────────────────────
create or replace function public.fin__assert_admin()
 returns void language plpgsql stable security definer set search_path to 'public', 'extensions'
as $f$
begin
  if not public.timeslot_is_admin() then
    raise exception using message = 'ADMIN_ONLY', errcode = '42501';
  end if;
end $f$;

create or replace function public.fin__assert_staff()
 returns void language plpgsql stable security definer set search_path to 'public', 'extensions'
as $f$
begin
  if not public.timeslot_is_staff() then
    raise exception using message = 'STAFF_ONLY', errcode = '42501';
  end if;
end $f$;

create or replace function public.fin__user_name(p_uid uuid)
 returns text language sql stable security definer set search_path to 'public', 'extensions'
as $f$
  select case when p_uid is null then 'System' else coalesce(
    (select nullif(btrim(concat_ws(' ', initcap(p.first_name), initcap(p.last_name))), '') from profiles p where p.user_id = p_uid limit 1),
    (select split_part(u.email, '@', 1) from auth.users u where u.id = p_uid),
    'Unknown') end;
$f$;

create or replace function public.fin__settings()
 returns jsonb language sql stable security definer set search_path to 'public', 'extensions'
as $f$
  select coalesce((select value from site_settings where key = 'finance'), '{}'::jsonb);
$f$;

-- SAST sale day of an order: manual ORD- orders use the order date (they are often recorded as paid later)
create or replace function public.fin__order_day(p_order public.orders)
 returns date language sql stable security definer set search_path to 'public', 'extensions'
as $f$
  select ((case when p_order.order_number like 'ORD-%' and p_order.pf_payment_id is null
               then (p_order.created_at at time zone 'UTC')
               else coalesce(p_order.paid_at, p_order.created_at at time zone 'UTC') end)
          at time zone 'Africa/Johannesburg')::date;
$f$;

-- Expenses / other income in a range: one-off rows by occurred_on; monthly rows count once for every
-- calendar month that overlaps the range (from the month of occurred_on to recur_until, or today/p_to).
create or replace function public.fin__entries_in_range(p_from date, p_to date, p_include_voided boolean default false)
 returns table (entry public.finance_entries, occurrences int, amount_in_range numeric)
 language sql stable security definer set search_path to 'public', 'extensions'
as $f$
  select e, x.n, round(e.amount * x.n, 2)
    from finance_entries e
    cross join lateral (
      select case
        when e.kind = 'adjustment' then (case when e.occurred_on between p_from and p_to then 1 else 0 end)
        when e.recurring = 'none' then (case when e.occurred_on between p_from and p_to then 1 else 0 end)
        else (select count(*)::int from generate_series(
                date_trunc('month', e.occurred_on)::date,
                date_trunc('month', least(coalesce(e.recur_until, p_to), p_to))::date,
                interval '1 month') m
              where m::date <= p_to and (m + interval '1 month' - interval '1 day')::date >= p_from)
      end as n) x
   where x.n > 0 and (p_include_voided or e.voided_at is null);
$f$;

-- ───────────────────────── the per-order engine ─────────────────────────
create or replace function public.fin__order_lines(p_from date, p_to date, p_include_excluded boolean default false)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions'
as $f$
declare
  cfg jsonb := public.fin__settings();
  v_markup numeric := coalesce((cfg->>'default_markup_percent')::numeric, 9);
  v_vat numeric := coalesce((cfg->>'vat_percent')::numeric, 15);
  v_rider_cost boolean := coalesce((cfg->>'count_rider_pay_as_cost')::boolean, false);
  v_tips_rider boolean := coalesce(cfg->>'tips_go_to', 'umzila') = 'rider';
  v_seller_codes text := coalesce(cfg->>'seller_codes_funded_by', 'seller');
  v_manual_disc text := coalesce(cfg->>'manual_discount_funded_by', 'umzila');
  v_rates jsonb := coalesce(cfg->'fee_rates', '{}'::jsonb);
  v_sp jsonb := coalesce(cfg->'store_prices', '{}'::jsonb);
  v_band jsonb := coalesce(cfg->'rider_pay_estimate', '{}'::jsonb);
  v_tests text[] := array(select lower(t) from jsonb_array_elements_text(coalesce(cfg->'test_emails', '[]'::jsonb)) t);
  v_out jsonb;
begin
  with
  o as (
    select o.*,
      case when o.order_number like 'ORD-%' and o.pf_payment_id is null
                and not coalesce(jsonb_typeof(o.pf_response) = 'object' and o.pf_response ? 'amount_gross', false) then 'manual'
           when o.pf_payment_id is not null or (jsonb_typeof(o.pf_response) = 'object' and o.pf_response ? 'amount_gross') then 'payfast'
           when coalesce(o.total, 0) = 0 then 'zero'
           else 'other' end as src,
      public.fin__order_day(o) as day,
      case when o.order_number like 'ORD-%' and o.pf_payment_id is null then (o.created_at at time zone 'UTC')
           else coalesce(o.paid_at, o.created_at at time zone 'UTC') end as when_ts
    from orders o
    where o.payment_status = 'paid' and o.label is distinct from 'seller_enrollment'
  ),
  o2 as (select * from o where o.day between p_from and p_to),
  adj as (
    select e.order_id,
      bool_or(e.adjustment_type = 'exclude_test') as excl,
      max(e.adjustment_value) filter (where e.adjustment_type = 'rider_pay_override') as rider_ov,
      max(e.adjustment_value) filter (where e.adjustment_type = 'payment_fee_override') as fee_ov,
      max(e.adjustment_text)  filter (where e.adjustment_type = 'payment_method_set') as method_ov,
      max(e.adjustment_value) filter (where e.adjustment_type = 'cogs_override') as cogs_ov,
      coalesce(sum(e.adjustment_value) filter (where e.adjustment_type = 'refund'), 0) as refund,
      jsonb_object_agg(coalesce(e.seller_id::text, '*'), e.adjustment_value)
        filter (where e.adjustment_type = 'seller_payout_override') as payout_ov,
      jsonb_agg(jsonb_build_object('id', e.id, 'type', e.adjustment_type, 'value', e.adjustment_value,
        'text', e.adjustment_text, 'seller_id', e.seller_id, 'note', e.description,
        'by', public.fin__user_name(e.created_by), 'at', e.created_at) order by e.created_at) as list
    from finance_entries e
    where e.kind = 'adjustment' and e.voided_at is null and e.order_id in (select id from o2)
    group by e.order_id
  ),
  att as (
    select distinct on (a.order_id) a.order_id, a.payment_method_code, a.option_key, a.amount_gross, a.amount_fee
      from payment_attempts a
     where a.status = 'paid' and a.order_id in (select id from o2)
     order by a.order_id, a.ended_at desc nulls last
  ),
  li as (
    select oi.order_id, oi.product_id, coalesce(oi.seller_id, p.seller_id) as seller_id,
           coalesce(oi.product_name, p.name) as name, coalesce(oi.quantity, 1) as qty, oi.unit_price as unit,
           coalesce(oi.subtotal, oi.unit_price * oi.quantity, 0) as sub, oi.selected_size as size,
           null::uuid as variant_id, false as fb
      from order_items oi left join products p on p.id = oi.product_id
     where oi.order_id in (select id from o2)
    union all
    select o2.id, j.pid, coalesce(j.sid, p.seller_id), coalesce(e->>'name', e->>'item', p.name),
           j.qty, j.unit, coalesce(j.sub, j.unit * j.qty, 0), e->>'size', j.vid, true
      from o2
      cross join lateral jsonb_array_elements(case when jsonb_typeof(o2.items) = 'array' then o2.items else '[]'::jsonb end) e
      cross join lateral (select
          case when coalesce(e->>'product_id', e->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then coalesce(e->>'product_id', e->>'id')::uuid end as pid,
          case when e->>'seller_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (e->>'seller_id')::uuid end as sid,
          case when e->>'variant_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (e->>'variant_id')::uuid end as vid,
          coalesce(case when e->>'quantity' ~ '^[0-9]+$' then (e->>'quantity')::int end, 1) as qty,
          case when e->>'price' ~ '^-?[0-9.]+$' then (e->>'price')::numeric end as unit,
          case when e->>'subtotal' ~ '^-?[0-9.]+$' then (e->>'subtotal')::numeric end as sub) j
      left join products p on p.id = j.pid
     where not exists (select 1 from order_items x where x.order_id = o2.id)
  ),
  l2 as (
    select li.*, s.shop_name, s.slug, coalesce(s.is_house, false) as is_house,
           v.id as var_id,
           coalesce(v.price_override, case when p.sale and coalesce(p.sale_price, 0) > 0 then p.sale_price else p.price end) as sell,
           coalesce((v_sp->>(li.product_id::text || ':' || v.id::text))::numeric, (v_sp->>li.product_id::text)::numeric) as sp
      from li
      left join products p on p.id = li.product_id
      left join sellers s on s.id = li.seller_id
      left join lateral (select pv.id, pv.price_override from product_variants pv
                          where pv.product_id = li.product_id
                            and (pv.id = li.variant_id or lower(pv.size) = lower(li.size))
                          order by (pv.id = li.variant_id) desc nulls last limit 1) v on true
  ),
  l3 as (
    select l2.*,
      case when l2.is_house then 0::numeric
           when l2.sp is not null and l2.sell > 0 then round(l2.sub * l2.sp / l2.sell, 2)
           else round(l2.sub / (1 + v_markup / 100), 2) end as owed_list,
      (not l2.is_house and not (l2.sp is not null and l2.sell > 0)) as owed_est,
      (l2.sp is not null and l2.sell > 0 and l2.unit is distinct from l2.sell) as scaled,
      case when l2.is_house and l2.sp is not null then round(l2.sp * l2.qty, 2) else 0::numeric end as cogs,
      (l2.is_house and l2.sp is null) as cogs_missing
    from l2
  ),
  disc as (
    select o2.id as order_id, coalesce(o2.discount, 0) as d, o2.coupon_code, dc.seller_id as code_seller,
      case
        when coalesce(o2.discount, 0) <= 0 then null
        when o2.coupon_code is not null and dc.seller_id is not null and v_seller_codes = 'seller'
             and exists (select 1 from l3 where l3.order_id = o2.id and l3.seller_id = dc.seller_id and not l3.is_house) then 'seller'
        when o2.coupon_code is null and v_manual_disc = 'seller'
             and exists (select 1 from l3 where l3.order_id = o2.id and not l3.is_house) then 'seller'
        else 'umzila' end as funder
    from o2 left join discount_codes dc on o2.coupon_code is not null and upper(dc.code) = upper(o2.coupon_code)
  ),
  l4 as (
    select l3.*,
      case when disc.funder = 'seller' and not l3.is_house
                and (disc.code_seller is null or disc.coupon_code is null or l3.seller_id = disc.code_seller)
           then round(disc.d * l3.sub / nullif(sum(l3.sub) filter (where not l3.is_house
                       and (disc.code_seller is null or disc.coupon_code is null or l3.seller_id = disc.code_seller))
                       over (partition by l3.order_id), 0), 2)
           else 0 end as line_disc
    from l3 join disc on disc.order_id = l3.order_id
  ),
  st as (
    select l4.order_id, l4.seller_id, max(l4.shop_name) as shop_name, max(l4.slug) as slug, bool_or(l4.is_house) as is_house,
      sum(l4.sub) as goods_list, sum(coalesce(l4.line_disc, 0)) as seller_disc, sum(l4.owed_list) as owed_list,
      bool_or(l4.owed_est) as owed_est, sum(l4.owed_list - coalesce(l4.line_disc, 0)) filter (where l4.owed_est) as owed_est_list,
      sum(l4.cogs) as cogs, bool_or(l4.cogs_missing) as cogs_missing,
      jsonb_agg(jsonb_build_object('product_id', l4.product_id, 'variant_id', l4.var_id, 'name', l4.name, 'size', l4.size,
        'qty', l4.qty, 'unit_price', l4.unit, 'subtotal', l4.sub, 'sell_price', l4.sell, 'store_price', l4.sp,
        'owed', case when l4.is_house then null else l4.owed_list end, 'cogs', case when l4.is_house then l4.cogs end,
        'est', l4.owed_est or l4.cogs_missing, 'scaled', l4.scaled, 'discount', l4.line_disc, 'from_items_json', l4.fb)) as lines
    from l4 group by l4.order_id, l4.seller_id
  ),
  st2 as (
    select st.*,
      (select count(*) from st x where x.order_id = st.order_id and not x.is_house) as n_stores,
      adj.payout_ov, adj.cogs_ov
    from st left join adj on adj.order_id = st.order_id
  ),
  st3 as (
    select st2.*,
      case when st2.is_house then null
           else coalesce((st2.payout_ov->>st2.seller_id::text)::numeric,
                         case when st2.n_stores = 1 then (st2.payout_ov->>'*')::numeric end) end as owed_ov
    from st2
  ),
  st4 as (
    select st3.*,
      case when st3.is_house then 0 else round(coalesce(st3.owed_ov, st3.owed_list - st3.seller_disc), 2) end as owed
    from st3
  ),
  ord_st as (
    select st4.order_id,
      jsonb_agg(jsonb_build_object('seller_id', st4.seller_id, 'shop_name', coalesce(st4.shop_name, 'Unknown store'), 'slug', st4.slug,
        'is_house', st4.is_house, 'goods_list', round(st4.goods_list, 2), 'seller_discount', round(st4.seller_disc, 2),
        'goods_after_discount', round(st4.goods_list - st4.seller_disc, 2),
        'owed', st4.owed, 'owed_est', coalesce(st4.owed_est, false) and st4.owed_ov is null,
        'owed_est_amount', case when st4.owed_ov is null then round(coalesce(st4.owed_est_list, 0), 2) else 0 end,
        'payout_override', st4.owed_ov is not null,
        'commission', case when st4.is_house then 0 else round(st4.goods_list - st4.seller_disc - st4.owed, 2) end,
        'cogs', case when st4.is_house then st4.cogs else 0 end, 'cogs_missing', coalesce(st4.cogs_missing, false),
        'lines', st4.lines) order by st4.is_house, st4.shop_name) as stores,
      sum(st4.goods_list) as goods_list,
      sum(st4.seller_disc) as seller_disc,
      sum(st4.owed) as owed,
      sum(case when st4.is_house then 0 else st4.goods_list - st4.seller_disc - st4.owed end) as commission,
      sum(case when st4.is_house then st4.goods_list else 0 end) as house_value,
      sum(case when st4.is_house then st4.cogs else 0 end) as house_cogs_calc,
      bool_or(st4.cogs_missing) as cogs_missing,
      bool_or(st4.owed_est and st4.owed_ov is null) as owed_est,
      sum(case when st4.owed_ov is null then coalesce(st4.owed_est_list, 0) else 0 end) as owed_est_amount,
      count(*) filter (where not st4.is_house) as n_stores,
      bool_or(exists (select 1 from jsonb_array_elements(st4.lines) z where (z->>'from_items_json')::boolean)) as items_fallback,
      bool_or(exists (select 1 from jsonb_array_elements(st4.lines) z where z->>'name' ilike '%test item%')) as test_item
    from st4 group by st4.order_id
  ),
  dl as (
    select distinct on (d.order_id) d.order_id, d.id, d.status::text as status, d.route_id, d.quote_id,
           d.dispatched_at, d.delivered_at
      from deliveries d where d.order_id in (select id from o2)
     order by d.order_id, d.created_at desc
  ),
  dl2 as (
    select dl.*,
      (select (x->>'pay')::numeric from driver_payouts dp, jsonb_array_elements(coalesce(dp.calculation_basis->'deliveries', '[]'::jsonb)) x
        where dp.route_id = dl.route_id and x->>'delivery_id' = dl.id::text limit 1) as pay_actual,
      (select q.distance_km from delivery_quotes q where q.id = dl.quote_id) as km
    from dl
  ),
  base as (
    select o2.*, adj.excl, adj.rider_ov, adj.fee_ov, adj.method_ov, adj.cogs_ov, coalesce(adj.refund, 0) as refund, adj.list as adj_list,
      att.payment_method_code as att_method, att.option_key as att_option, att.amount_gross as att_gross, att.amount_fee as att_fee,
      ord_st.stores, coalesce(ord_st.goods_list, 0) as goods_list, coalesce(ord_st.seller_disc, 0) as seller_disc,
      coalesce(ord_st.owed, 0) as owed, coalesce(ord_st.commission, 0) as commission, coalesce(ord_st.house_value, 0) as house_value,
      coalesce(ord_st.house_cogs_calc, 0) as house_cogs_calc, coalesce(ord_st.cogs_missing, false) as cogs_missing,
      coalesce(ord_st.owed_est, false) as owed_est, coalesce(ord_st.owed_est_amount, 0) as owed_est_amount,
      coalesce(ord_st.n_stores, 0) as n_stores, coalesce(ord_st.items_fallback, false) as items_fallback,
      coalesce(ord_st.test_item, false) as test_item,
      disc.d as disc_amt, disc.funder,
      dl2.id as delivery_id, dl2.status as delivery_status, dl2.pay_actual, dl2.km, dl2.dispatched_at, dl2.delivered_at
    from o2
    left join adj on adj.order_id = o2.id
    left join att on att.order_id = o2.id
    left join ord_st on ord_st.order_id = o2.id
    left join disc on disc.order_id = o2.id
    left join dl2 on dl2.order_id = o2.id
  ),
  calc as (
    select b.*,
      round(coalesce(case when jsonb_typeof(b.pf_response) = 'object' and b.pf_response->>'amount_gross' ~ '^-?[0-9.]+$'
                          then (b.pf_response->>'amount_gross')::numeric end, b.att_gross, b.total, 0), 2) as gross,
      coalesce(b.method_ov, b.payment_method_code, b.att_method,
               case b.src when 'manual' then 'cash' when 'zero' then 'zero' else 'unknown' end) as method,
      abs(coalesce(case when jsonb_typeof(b.pf_response) = 'object' and b.pf_response->>'amount_fee' ~ '^-?[0-9.]+$'
                        then (b.pf_response->>'amount_fee')::numeric end, b.att_fee)) as fee_actual,
      coalesce(b.shipping_cost, 0) as shipping, coalesce(b.priority_fee, 0) as priority, coalesce(b.tip_amount, 0) as tips
    from base b
  ),
  calc2 as (
    select c.*,
      coalesce(v_rates->c.method, v_rates->'unknown', '{}'::jsonb) as rate,
      case when c.delivery_id is null then 0
           when c.rider_ov is not null then c.rider_ov
           when c.delivery_status = 'CANCELLED' then 0
           when c.pay_actual is not null then c.pay_actual
           else round(case when c.km is null then coalesce((v_band->>'fallback')::numeric, 39)
                      else least(coalesce((v_band->>'max')::numeric, 45),
                                 coalesce((v_band->>'min')::numeric, 34)
                                 + greatest(0, c.km - coalesce((v_band->>'included_km')::numeric, 3)) * coalesce((v_band->>'per_km')::numeric, 0.40)) end
                      + coalesce((v_band->>'per_extra_store')::numeric, 3) * greatest(0, c.n_stores - 1), 2) end as rider_pay,
      (c.delivery_id is not null and c.rider_ov is null and c.delivery_status <> 'CANCELLED' and c.pay_actual is null) as rider_est
    from calc c
  ),
  calc3 as (
    select c.*,
      case when c.method in ('cash', 'zero', 'eft_manual') or c.gross <= 0 then 0
           else round(greatest(coalesce((c.rate->>'min')::numeric, 0),
                               c.gross * coalesce((c.rate->>'pct')::numeric, 0) / 100 + coalesce((c.rate->>'fixed')::numeric, 0))
                      * case when coalesce((c.rate->>'vat')::boolean, false) then 1 + v_vat / 100 else 1 end, 2) end as fee_estimate,
      coalesce(c.cogs_ov, c.house_cogs_calc) as house_cogs,
      round(c.disc_amt - c.seller_disc, 2) as umzila_disc
    from calc2 c
  ),
  calc4 as (
    select c.*,
      round(coalesce(c.fee_ov, c.fee_actual, c.fee_estimate), 2) as fee,
      (c.fee_ov is null and c.fee_actual is null and c.src in ('payfast', 'other') and c.gross > 0) as fee_est,
      case when v_rider_cost then c.rider_pay else 0 end as rider_cost,
      case when v_tips_rider then c.tips else 0 end as tips_to_rider,
      round(c.gross - (c.goods_list - c.disc_amt + c.shipping + c.tips), 2) as unexplained
    from calc3 c
  ),
  fin as (
    select c.*,
      round(c.gross - c.owed - c.fee - c.house_cogs - c.refund - c.rider_cost - c.tips_to_rider, 2) as net,
      (lower(coalesce(c.customer_email, '')) = any (v_tests) or c.test_item) as test_candidate
    from calc4 c
    where p_include_excluded or not coalesce(c.excl, false)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'order_id', f.id, 'order_number', f.order_number,
    'when', to_char(f.when_ts at time zone 'Africa/Johannesburg', 'YYYY-MM-DD"T"HH24:MI:SS"+02:00"'),
    'day', f.day, 'customer_name', f.customer_name, 'customer_email', f.customer_email,
    'source', f.src, 'order_status', f.order_status,
    'is_test_candidate', f.test_candidate, 'excluded', coalesce(f.excl, false),
    'payment', jsonb_build_object(
      'option_key', coalesce(f.payment_option_key, f.att_option), 'method_code', f.method,
      'method_name', coalesce(f.rate->>'name', f.method), 'method_set_by_admin', f.method_ov is not null,
      'gross', f.gross, 'fee', f.fee, 'fee_actual', f.fee_actual is not null and f.fee_ov is null,
      'fee_est', f.fee_est, 'fee_estimate', f.fee_estimate, 'fee_override', f.fee_ov is not null,
      'net', round(f.gross - f.fee, 2)),
    'goods', jsonb_build_object(
      'list_value', round(f.goods_list, 2), 'discount', round(f.disc_amt, 2), 'discount_code', f.coupon_code,
      'discount_funder', f.funder, 'seller_discount', round(f.seller_disc, 2), 'umzila_discount', f.umzila_disc,
      'after_discount', round(f.goods_list - f.disc_amt, 2), 'house_value', round(f.house_value, 2)),
    'stores', coalesce(f.stores, '[]'::jsonb),
    'delivery', jsonb_build_object(
      'has_delivery', f.delivery_id is not null, 'delivery_id', f.delivery_id, 'status', f.delivery_status,
      'fee_customer', round(f.shipping - f.priority, 2), 'priority', round(f.priority, 2), 'shipping_total', round(f.shipping, 2),
      'free_delivery', f.delivery_id is not null and f.shipping = 0,
      'rider_pay', round(f.rider_pay, 2), 'rider_pay_est', f.rider_est, 'rider_pay_override', f.rider_ov is not null,
      'rider_pay_counted', v_rider_cost,
      'dispatched_at', f.dispatched_at, 'delivered_at', f.delivered_at,
      'minutes_to_deliver', case when f.dispatched_at is not null and f.delivered_at is not null
                                 then round(extract(epoch from (f.delivered_at - f.dispatched_at)) / 60.0) end),
    'tips', round(f.tips, 2), 'tips_to_rider', round(f.tips_to_rider, 2), 'refund', round(f.refund, 2),
    'umzila', jsonb_build_object(
      'commission', round(f.commission, 2), 'house_value', round(f.house_value, 2), 'house_cogs', round(f.house_cogs, 2),
      'house_margin', round(f.house_value - f.house_cogs, 2),
      'delivery_income', round(f.shipping, 2), 'tips_income', round(f.tips, 2),
      'discounts_funded', f.umzila_disc, 'fees_paid', f.fee, 'refunds', round(f.refund, 2),
      'rider_cost', round(f.rider_cost, 2), 'tips_to_rider', round(f.tips_to_rider, 2),
      'unexplained', f.unexplained, 'owed_to_stores', round(f.owed, 2), 'net', f.net),
    'estimates', jsonb_build_object('owed', f.owed_est, 'owed_est_amount', round(f.owed_est_amount, 2),
      'fee', f.fee_est, 'rider_pay', f.rider_est and v_rider_cost, 'cogs', f.cogs_missing and f.cogs_ov is null),
    'flags', to_jsonb(array_remove(array[
      case when abs(f.unexplained) > 0.01 then 'totals_mismatch' end,
      case when f.items_fallback then 'items_fallback' end,
      case when f.goods_list = 0 then 'no_lines' end,
      case when f.cogs_missing and f.cogs_ov is null then 'cogs_missing' end,
      case when f.owed_est then 'store_price_estimated' end,
      case when f.delivery_status = 'CANCELLED' then 'delivery_cancelled' end,
      case when f.refund > 0 then 'refund' end,
      case when f.test_candidate then 'looks_like_test' end,
      case when coalesce(f.excl, false) then 'excluded' end], null)),
    'adjustments', coalesce(f.adj_list, '[]'::jsonb)
  ) order by f.when_ts desc), '[]'::jsonb)
  into v_out from fin f;
  return v_out;
end $f$;

-- ───────────────────────── admin: per-order engine ─────────────────────────
create or replace function public.fin_order_lines(p_from date, p_to date, p_include_excluded boolean default false)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions'
as $f$
begin
  perform public.fin__assert_admin();
  if p_from is null or p_to is null or p_to < p_from then
    raise exception using message = 'FIN_INVALID', errcode = '22023', detail = 'from/to dates required, to on or after from';
  end if;
  return public.fin__order_lines(p_from, p_to, p_include_excluded);
end $f$;

-- ───────────────────────── admin: summary ─────────────────────────
create or replace function public.fin_summary(p_from date, p_to date, p_include_excluded boolean default false)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions'
as $f$
declare
  cfg jsonb := public.fin__settings();
  v_vat numeric := coalesce((cfg->>'vat_percent')::numeric, 15);
  v_cp jsonb := coalesce(cfg->'fee_rates'->'cp', '{"pct":2,"min":2,"fixed":0,"vat":true}'::jsonb);
  v_rider_cost boolean := coalesce((cfg->>'count_rider_pay_as_cost')::boolean, false);
  v_all jsonb; v_inc jsonb;
  t jsonb; v_other jsonb; v_exp jsonb; v_methods jsonb; v_stores jsonb; v_days jsonb; v_weeks jsonb;
  v_ins jsonb := '[]'::jsonb;
  v_gp numeric; v_other_total numeric; v_exp_total numeric; v_excluded int; v_est_share numeric;
  r record;
begin
  perform public.fin__assert_admin();
  if p_from is null or p_to is null or p_to < p_from then
    raise exception using message = 'FIN_INVALID', errcode = '22023', detail = 'from/to dates required, to on or after from';
  end if;
  v_all := public.fin__order_lines(p_from, p_to, true);
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_inc from jsonb_array_elements(v_all) e
   where p_include_excluded or not (e->>'excluded')::boolean;
  select count(*) into v_excluded from jsonb_array_elements(v_all) e where (e->>'excluded')::boolean;

  select jsonb_build_object(
    'gross', coalesce(round(sum((e->'payment'->>'gross')::numeric), 2), 0),
    'goods_list', coalesce(round(sum((e->'goods'->>'list_value')::numeric), 2), 0),
    'discounts_seller', coalesce(round(sum((e->'goods'->>'seller_discount')::numeric), 2), 0),
    'discounts_umzila', coalesce(round(sum((e->'goods'->>'umzila_discount')::numeric), 2), 0),
    'delivery_customer', coalesce(round(sum((e->'delivery'->>'fee_customer')::numeric), 2), 0),
    'priority', coalesce(round(sum((e->'delivery'->>'priority')::numeric), 2), 0),
    'tips', coalesce(round(sum((e->>'tips')::numeric), 2), 0),
    'owed_to_stores', coalesce(round(sum((e->'umzila'->>'owed_to_stores')::numeric), 2), 0),
    'owed_estimated', coalesce(round(sum((e->'estimates'->>'owed_est_amount')::numeric), 2), 0),
    'rider_pay', coalesce(round(sum((e->'delivery'->>'rider_pay')::numeric), 2), 0),
    'rider_pay_counted', v_rider_cost,
    'rider_cost', coalesce(round(sum((e->'umzila'->>'rider_cost')::numeric), 2), 0),
    'tips_to_rider', coalesce(round(sum((e->>'tips_to_rider')::numeric), 2), 0),
    'payfast_fees', coalesce(round(sum((e->'payment'->>'fee')::numeric), 2), 0),
    'payfast_fees_estimated', coalesce(round(sum((e->'payment'->>'fee')::numeric) filter (where (e->'payment'->>'fee_est')::boolean), 2), 0),
    'house_sales', coalesce(round(sum((e->'umzila'->>'house_value')::numeric), 2), 0),
    'house_cogs', coalesce(round(sum((e->'umzila'->>'house_cogs')::numeric), 2), 0),
    'refunds', coalesce(round(sum((e->>'refund')::numeric), 2), 0),
    'unexplained', coalesce(round(sum((e->'umzila'->>'unexplained')::numeric), 2), 0),
    'umzila_commission', coalesce(round(sum((e->'umzila'->>'commission')::numeric), 2), 0),
    'umzila_delivery_income', coalesce(round(sum((e->'umzila'->>'delivery_income')::numeric), 2), 0),
    'umzila_house_margin', coalesce(round(sum((e->'umzila'->>'house_margin')::numeric), 2), 0),
    'umzila_gross_profit', coalesce(round(sum((e->'umzila'->>'net')::numeric), 2), 0)
  ) into t from jsonb_array_elements(v_inc) e;
  v_gp := (t->>'umzila_gross_profit')::numeric;

  -- other income: finance entries + seller enrolment fees (net of PayFast fee) + paid ads
  with ent as (
    select (x.entry).id, (x.entry).category, (x.entry).description, (x.entry).occurred_on, (x.entry).recurring, x.occurrences, x.amount_in_range
      from public.fin__entries_in_range(p_from, p_to) x where (x.entry).kind = 'income'
  ), enrol as (
    select o.id, o.order_number, public.fin__order_day(o) as day,
           round(coalesce(case when o.pf_response->>'amount_gross' ~ '^-?[0-9.]+$' then (o.pf_response->>'amount_gross')::numeric end, o.total, 0)
                 - abs(coalesce(case when o.pf_response->>'amount_fee' ~ '^-?[0-9.]+$' then (o.pf_response->>'amount_fee')::numeric end, 0)), 2) as net
      from orders o where o.payment_status = 'paid' and o.label = 'seller_enrollment'
  ), ads as (
    select a.id, (a.created_at at time zone 'Africa/Johannesburg')::date as day, coalesce(a.amount_paid, 0) as amt
      from ad_campaigns a where a.payment_status = 'paid'
  )
  select jsonb_build_object(
    'total', round(coalesce((select sum(amount_in_range) from ent), 0)
                 + coalesce((select sum(net) from enrol where day between p_from and p_to), 0)
                 + coalesce((select sum(amt) from ads where day between p_from and p_to), 0), 2),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'category', category, 'description', description,
                 'occurred_on', occurred_on, 'recurring', recurring, 'occurrences', occurrences, 'amount', amount_in_range) order by occurred_on) from ent), '[]'::jsonb),
    'enrolment_fees', jsonb_build_object('count', (select count(*) from enrol where day between p_from and p_to),
                 'amount', coalesce((select sum(net) from enrol where day between p_from and p_to), 0)),
    'ads', jsonb_build_object('count', (select count(*) from ads where day between p_from and p_to),
                 'amount', coalesce((select sum(amt) from ads where day between p_from and p_to), 0))
  ) into v_other;
  v_other_total := (v_other->>'total')::numeric;

  select jsonb_build_object(
    'total', coalesce(round(sum(x.amount_in_range), 2), 0),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('category', c.category, 'amount', c.amt, 'entries', c.n) order by c.amt desc)
        from (select (y.entry).category, round(sum(y.amount_in_range), 2) as amt, count(*) as n
                from public.fin__entries_in_range(p_from, p_to) y where (y.entry).kind = 'expense' group by 1) c), '[]'::jsonb),
    'entries', count(*),
    'monthly_recurring', coalesce(round(sum((x.entry).amount) filter (where (x.entry).recurring = 'monthly'
                          and coalesce((x.entry).recur_until, p_to) >= p_to), 2), 0)
  ) into v_exp
  from public.fin__entries_in_range(p_from, p_to) x where (x.entry).kind = 'expense';
  v_exp_total := (v_exp->>'total')::numeric;

  t := t || jsonb_build_object('other_income', v_other_total, 'other_income_detail', v_other,
                               'expenses', v_exp_total, 'expenses_detail', v_exp,
                               'net_profit', round(v_gp + v_other_total - v_exp_total, 2));

  select coalesce(jsonb_agg(m order by (m->>'gross')::numeric desc), '[]'::jsonb) into v_methods from (
    select jsonb_build_object('method_code', e->'payment'->>'method_code', 'name', max(e->'payment'->>'method_name'),
      'orders', count(*), 'gross', round(sum((e->'payment'->>'gross')::numeric), 2),
      'fees', round(sum((e->'payment'->>'fee')::numeric), 2),
      'fees_actual', round(coalesce(sum((e->'payment'->>'fee')::numeric) filter (where not (e->'payment'->>'fee_est')::boolean), 0), 2),
      'fees_estimated', round(coalesce(sum((e->'payment'->>'fee')::numeric) filter (where (e->'payment'->>'fee_est')::boolean), 0), 2),
      'fees_est_orders', count(*) filter (where (e->'payment'->>'fee_est')::boolean),
      'effective_pct', case when sum((e->'payment'->>'gross')::numeric) > 0
                         then round(100 * sum((e->'payment'->>'fee')::numeric) / sum((e->'payment'->>'gross')::numeric), 2) else 0 end,
      'share_of_gross', case when (t->>'gross')::numeric > 0
                         then round(sum((e->'payment'->>'gross')::numeric) / (t->>'gross')::numeric, 4) else 0 end) m
    from jsonb_array_elements(v_inc) e group by e->'payment'->>'method_code') q;

  select coalesce(jsonb_agg(s order by (s->>'is_house')::boolean, (s->>'goods')::numeric desc), '[]'::jsonb) into v_stores from (
    select jsonb_build_object('seller_id', x->>'seller_id', 'shop_name', max(x->>'shop_name'), 'slug', max(x->>'slug'),
      'is_house', bool_or((x->>'is_house')::boolean), 'orders', count(distinct e->>'order_id'),
      'goods_list', round(sum((x->>'goods_list')::numeric), 2), 'discounts', round(sum((x->>'seller_discount')::numeric), 2),
      'goods', round(sum((x->>'goods_after_discount')::numeric), 2), 'owed', round(sum((x->>'owed')::numeric), 2),
      'owed_estimated', round(sum((x->>'owed_est_amount')::numeric), 2),
      'commission', round(sum((x->>'commission')::numeric), 2), 'cogs', round(sum((x->>'cogs')::numeric), 2),
      'cogs_missing', bool_or((x->>'cogs_missing')::boolean),
      'margin', round(sum((x->>'commission')::numeric) + case when bool_or((x->>'is_house')::boolean)
                      then sum((x->>'goods_after_discount')::numeric) - sum((x->>'cogs')::numeric) else 0 end, 2),
      'margin_pct', case when sum((x->>'goods_after_discount')::numeric) > 0 then round(100 * (
                      case when bool_or((x->>'is_house')::boolean) then sum((x->>'goods_after_discount')::numeric) - sum((x->>'cogs')::numeric)
                           else sum((x->>'commission')::numeric) end) / sum((x->>'goods_after_discount')::numeric), 2) else 0 end) s
    from jsonb_array_elements(v_inc) e cross join lateral jsonb_array_elements(e->'stores') x
    group by x->>'seller_id') q;

  select coalesce(jsonb_agg(d order by d->>'day'), '[]'::jsonb) into v_days from (
    select jsonb_build_object('day', e->>'day', 'orders', count(*), 'gross', round(sum((e->'payment'->>'gross')::numeric), 2),
      'umzila_gross_profit', round(sum((e->'umzila'->>'net')::numeric), 2)) d
    from jsonb_array_elements(v_inc) e group by e->>'day') q;

  select coalesce(jsonb_agg(w order by w->>'week_start'), '[]'::jsonb) into v_weeks from (
    select jsonb_build_object('week_start', date_trunc('week', (e->>'day')::date)::date, 'orders', count(*),
      'gross', round(sum((e->'payment'->>'gross')::numeric), 2), 'umzila_gross_profit', round(sum((e->'umzila'->>'net')::numeric), 2)) w
    from jsonb_array_elements(v_inc) e group by date_trunc('week', (e->>'day')::date)) q;

  -- share of costs that are estimates: (est fees + est store payouts + est rider pay if counted) / (fees + payouts + rider cost)
  select case when sum(c) > 0 then round(sum(ce) / sum(c), 4) else 0 end into v_est_share from (
    select (e->'payment'->>'fee')::numeric + (e->'umzila'->>'owed_to_stores')::numeric + (e->'umzila'->>'rider_cost')::numeric as c,
      case when (e->'payment'->>'fee_est')::boolean then (e->'payment'->>'fee')::numeric else 0 end
      + (e->'estimates'->>'owed_est_amount')::numeric
      + case when (e->'estimates'->>'rider_pay')::boolean then (e->'umzila'->>'rider_cost')::numeric else 0 end as ce
    from jsonb_array_elements(v_inc) e) z;

  -- insights (rules, not AI)
  if v_excluded > 0 and not p_include_excluded then
    v_ins := v_ins || jsonb_build_object('key', 'tests_hidden', 'severity', 'info',
      'title', v_excluded || ' test order' || case when v_excluded = 1 then ' is' else 's are' end || ' hidden',
      'detail', 'Orders marked "exclude as test" are left out of every figure. Switch on "Include test orders" to see them.', 'amount', null);
  end if;
  select count(*) as n, coalesce(sum((e->'payment'->>'gross')::numeric), 0) as g from jsonb_array_elements(v_inc) e
   where (e->'flags') ? 'looks_like_test' and not (e->>'excluded')::boolean into r;
  if r.n > 0 then
    v_ins := v_ins || jsonb_build_object('key', 'test_candidates', 'severity', 'info',
      'title', r.n || ' order' || case when r.n = 1 then '' else 's' end || ' may be tests',
      'detail', 'From a test email or with a test item. Only mark the ones that were not real sales.', 'amount', round(r.g, 2));
  end if;
  if (t->>'gross')::numeric > 0 and (t->>'payfast_fees')::numeric / (t->>'gross')::numeric >= 0.04 then
    select coalesce(sum((e->'payment'->>'fee')::numeric
             - round(greatest(coalesce((v_cp->>'min')::numeric, 0), (e->'payment'->>'gross')::numeric * coalesce((v_cp->>'pct')::numeric, 0) / 100 + coalesce((v_cp->>'fixed')::numeric, 0))
                     * case when coalesce((v_cp->>'vat')::boolean, true) then 1 + v_vat / 100 else 1 end, 2)), 0) as saved
      from jsonb_array_elements(v_inc) e
     where e->'payment'->>'method_code' in ('cc', 'dc', 'ap', 'gp', 'sp', 'unknown') and (e->'payment'->>'gross')::numeric > 0 into r;
    v_ins := v_ins || jsonb_build_object('key', 'fees_share', 'severity', 'warn',
      'title', 'PayFast fees are ' || round(100 * (t->>'payfast_fees')::numeric / (t->>'gross')::numeric, 1) || ' % of money in',
      'detail', case when r.saved > 0 then 'If the card payers had used Capitec Pay you would have kept about R' || round(r.saved, 2) || '.' else 'Fees include the fixed R2 per payment, which hurts small orders most.' end,
      'amount', (t->>'payfast_fees')::numeric);
  end if;
  select count(*) as n, coalesce(sum((e->'payment'->>'fee')::numeric), 0) as f from jsonb_array_elements(v_inc) e
   where (e->'payment'->>'gross')::numeric between 0.01 and 59.99 and (e->'payment'->>'fee')::numeric >= 0.1 * (e->'payment'->>'gross')::numeric into r;
  if r.n > 0 then
    v_ins := v_ins || jsonb_build_object('key', 'small_orders', 'severity', 'warn',
      'title', r.n || ' small order' || case when r.n = 1 then '' else 's' end || ' paid 10 % or more in fees',
      'detail', 'Orders under R60 lose a big share to the fixed fee — consider a minimum order or a small-order fee.', 'amount', round(r.f, 2));
  end if;
  if (t->>'owed_estimated')::numeric > 0 then
    v_ins := v_ins || jsonb_build_object('key', 'store_prices_missing', 'severity', 'warn',
      'title', 'R' || (t->>'owed_estimated') || ' of store payouts are estimated',
      'detail', 'Products without a store price use the default mark-up of ' || coalesce(cfg->>'default_markup_percent', '9') || ' %. Fill in store prices for exact commission.',
      'amount', (t->>'owed_estimated')::numeric);
  end if;
  select count(*) as n from jsonb_array_elements(v_inc) e where (e->'flags') ? 'cogs_missing' into r;
  if r.n > 0 then
    v_ins := v_ins || jsonb_build_object('key', 'cogs_missing', 'severity', 'warn', 'title', 'Drinks cost missing on ' || r.n || ' order' || case when r.n = 1 then '' else 's' end,
      'detail', 'A house drink sold has no cost price, so its whole price counts as profit.', 'amount', null);
  end if;
  select count(*) as n, coalesce(sum(abs((e->'umzila'->>'unexplained')::numeric)), 0) as a from jsonb_array_elements(v_inc) e where (e->'flags') ? 'totals_mismatch' into r;
  if r.n > 0 then
    v_ins := v_ins || jsonb_build_object('key', 'mismatch', 'severity', 'warn', 'title', r.n || ' order' || case when r.n = 1 then ' doesn''t' else 's don''t' end || ' add up',
      'detail', 'What PayFast received differs from items − discount + delivery + tips. The difference is shown as "unexplained" so totals still match the cash.', 'amount', round(r.a, 2));
  end if;
  if not v_rider_cost and (t->>'rider_pay')::numeric > 0 then
    v_ins := v_ins || jsonb_build_object('key', 'rider_pay_not_counted', 'severity', 'info',
      'title', 'Rider pay of R' || (t->>'rider_pay') || ' is not counted as a cost',
      'detail', 'Riders are staff — record their wages and fuel under Expenses. Switch "Count rider pay as a cost" on when riders become contractors.',
      'amount', (t->>'rider_pay')::numeric);
  elsif v_rider_cost and (t->>'rider_cost')::numeric > (t->>'umzila_delivery_income')::numeric then
    v_ins := v_ins || jsonb_build_object('key', 'delivery_loss', 'severity', 'warn',
      'title', 'Delivery lost R' || round((t->>'rider_cost')::numeric - (t->>'umzila_delivery_income')::numeric, 2),
      'detail', 'Rider pay was more than customers paid for delivery. Consider the delivery mark-up %.',
      'amount', round((t->>'rider_cost')::numeric - (t->>'umzila_delivery_income')::numeric, 2));
  end if;
  if v_est_share > 0.25 then
    v_ins := v_ins || jsonb_build_object('key', 'estimates', 'severity', 'info',
      'title', round(100 * v_est_share) || ' % of costs are estimates', 'detail', 'Fill in store prices and drinks costs to make these exact.', 'amount', null);
  end if;
  if jsonb_array_length(v_stores) > 0 then
    select x->>'shop_name' as n, (x->>'margin')::numeric as m from jsonb_array_elements(v_stores) x order by (x->>'margin')::numeric desc limit 1 into r;
    if r.m > 0 then
      v_ins := v_ins || jsonb_build_object('key', 'best_store', 'severity', 'good', 'title', r.n || ' earned Umzila the most',
        'detail', 'Commission (or drinks margin) from this store in the period.', 'amount', r.m);
    end if;
  end if;
  if (v_exp->>'monthly_recurring')::numeric > 0 then
    v_ins := v_ins || jsonb_build_object('key', 'recurring_burn', 'severity', 'info',
      'title', 'Running costs: R' || (v_exp->>'monthly_recurring') || ' a month',
      'detail', 'You need at least this much gross profit each month to break even. This period made R' || round(v_gp, 2) || ' gross profit.',
      'amount', (v_exp->>'monthly_recurring')::numeric);
  end if;
  if round(v_gp + v_other_total - v_exp_total, 2) > 0 then
    v_ins := v_ins || jsonb_build_object('key', 'profit', 'severity', 'good', 'title', 'Profit of R' || round(v_gp + v_other_total - v_exp_total, 2),
      'detail', 'After store payouts, fees, costs of goods, other income and expenses.', 'amount', round(v_gp + v_other_total - v_exp_total, 2));
  end if;

  return jsonb_build_object('from', p_from, 'to', p_to, 'orders', jsonb_array_length(v_inc), 'excluded_orders', v_excluded,
    'include_excluded', p_include_excluded, 'estimated_share', v_est_share, 'totals', t,
    'by_method', v_methods, 'by_store', v_stores, 'by_day', v_days, 'by_week', v_weeks, 'insights', v_ins,
    'settings', jsonb_build_object('default_markup_percent', coalesce((cfg->>'default_markup_percent')::numeric, 9),
      'count_rider_pay_as_cost', v_rider_cost, 'tips_go_to', coalesce(cfg->>'tips_go_to', 'umzila')));
end $f$;

-- ───────────────────────── admin: entries ─────────────────────────
create or replace function public.fin_entries_list(p_from date, p_to date, p_include_voided boolean default false)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions'
as $f$
begin
  perform public.fin__assert_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', (x.entry).id, 'kind', (x.entry).kind, 'category', (x.entry).category, 'description', (x.entry).description,
      'amount', (x.entry).amount, 'occurred_on', (x.entry).occurred_on, 'recurring', (x.entry).recurring,
      'recur_until', (x.entry).recur_until, 'occurrences_in_range', x.occurrences, 'amount_in_range', x.amount_in_range,
      'order_id', (x.entry).order_id, 'order_number', o.order_number,
      'seller_id', (x.entry).seller_id, 'shop_name', s.shop_name,
      'adjustment_type', (x.entry).adjustment_type, 'adjustment_value', (x.entry).adjustment_value, 'adjustment_text', (x.entry).adjustment_text,
      'created_by', (x.entry).created_by, 'created_by_name', public.fin__user_name((x.entry).created_by), 'created_at', (x.entry).created_at,
      'updated_at', (x.entry).updated_at,
      'voided', (x.entry).voided_at is not null, 'voided_at', (x.entry).voided_at,
      'voided_by_name', case when (x.entry).voided_at is not null then public.fin__user_name((x.entry).voided_by) end,
      'void_reason', (x.entry).void_reason)
      order by (x.entry).occurred_on desc, (x.entry).created_at desc)
    from public.fin__entries_in_range(p_from, p_to, p_include_voided) x
    left join orders o on o.id = (x.entry).order_id
    left join sellers s on s.id = (x.entry).seller_id), '[]'::jsonb);
end $f$;

create or replace function public.fin_entry_save(p jsonb)
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $f$
declare
  cfg jsonb := public.fin__settings();
  v_id uuid; cur finance_entries; v_kind text; v_type text; v_order orders; v_order_id uuid; v_seller uuid;
  v_amount numeric; v_value numeric; v_text text; v_date date; v_until date; v_rec text; v_cat text; v_desc text;
  v_stores int; v_gross numeric; v_row finance_entries;
  fail text := null;
begin
  perform public.fin__assert_admin();
  if p is null or jsonb_typeof(p) <> 'object' then fail := 'body must be an object'; end if;
  if fail is null and nullif(p->>'id', '') is not null then
    begin v_id := (p->>'id')::uuid; exception when others then fail := 'id is not valid'; end;
    if fail is null then
      select * into cur from finance_entries where id = v_id for update;
      if not found then raise exception using message = 'NOT_FOUND', errcode = 'P0002', detail = 'entry not found'; end if;
      if cur.voided_at is not null then fail := 'this entry was removed; add a new one instead'; end if;
    end if;
  end if;
  if fail is null then
    v_kind := coalesce(nullif(p->>'kind', ''), cur.kind);
    if cur.id is not null and v_kind <> cur.kind then fail := 'kind cannot be changed'; end if;
    if v_kind not in ('expense', 'income', 'adjustment') then fail := 'kind must be expense, income or adjustment'; end if;
  end if;
  if fail is null then
    v_desc := btrim(coalesce(p->>'description', cur.description, ''));
    if length(v_desc) > 500 then fail := 'description is too long (max 500)'; end if;
  end if;
  if fail is null and nullif(p->>'seller_id', '') is not null then
    begin v_seller := (p->>'seller_id')::uuid; exception when others then fail := 'seller_id is not valid'; end;
    if fail is null and not exists (select 1 from sellers where id = v_seller) then fail := 'store not found'; end if;
  elsif fail is null then
    v_seller := case when p ? 'seller_id' then null else cur.seller_id end;
  end if;

  if fail is null and v_kind in ('expense', 'income') then
    v_cat := btrim(coalesce(p->>'category', cur.category, ''));
    if v_cat = '' then fail := 'category is required';
    elsif not exists (select 1 from jsonb_array_elements_text(coalesce(cfg->(v_kind || '_categories'), '[]'::jsonb)) c where lower(c) = lower(v_cat)) then
      fail := 'category must be one of the ' || v_kind || ' categories in Assumptions (or Other)'; end if;
    if fail is null then
      begin v_amount := coalesce(p->>'amount', cur.amount::text)::numeric; exception when others then fail := 'amount must be a number'; end;
      if fail is null and (v_amount is null or v_amount <= 0 or v_amount > 10000000) then fail := 'amount must be more than 0'; end if;
    end if;
    if fail is null then
      begin v_date := coalesce(nullif(p->>'occurred_on', ''), cur.occurred_on::text)::date; exception when others then fail := 'date is not valid'; end;
      if fail is null and v_date is null then fail := 'date is required'; end if;
    end if;
    if fail is null then
      v_rec := coalesce(nullif(p->>'recurring', ''), cur.recurring, 'none');
      if v_rec not in ('none', 'monthly') then fail := 'recurring must be none or monthly'; end if;
    end if;
    if fail is null then
      begin v_until := case when p ? 'recur_until' then nullif(p->>'recur_until', '')::date else cur.recur_until end;
      exception when others then fail := 'end date is not valid'; end;
      if fail is null and v_rec = 'none' then v_until := null; end if;
      if fail is null and v_until is not null and v_until < v_date then fail := 'end date must be on or after the start date'; end if;
    end if;
    if fail is null then
      if cur.id is null then
        insert into finance_entries (kind, category, description, amount, occurred_on, recurring, recur_until, seller_id, created_by)
        values (v_kind, v_cat, v_desc, round(v_amount, 2), v_date, v_rec, v_until, v_seller, auth.uid()) returning * into v_row;
      else
        update finance_entries set category = v_cat, description = v_desc, amount = round(v_amount, 2), occurred_on = v_date,
          recurring = v_rec, recur_until = v_until, seller_id = v_seller, updated_at = now()
         where id = cur.id returning * into v_row;
      end if;
    end if;
  elsif fail is null then
    -- adjustment
    v_type := coalesce(nullif(p->>'adjustment_type', ''), cur.adjustment_type);
    if cur.id is not null and v_type <> cur.adjustment_type then fail := 'adjustment type cannot be changed'; end if;
    if fail is null and v_type not in ('exclude_test','refund','seller_payout_override','rider_pay_override',
                                       'payment_fee_override','payment_method_set','cogs_override','note') then
      fail := 'unknown adjustment type'; end if;
    if fail is null then
      begin v_order_id := coalesce(nullif(p->>'order_id', '')::uuid, cur.order_id); exception when others then fail := 'order_id is not valid'; end;
      if fail is null and cur.id is not null and v_order_id <> cur.order_id then fail := 'order cannot be changed'; end if;
      if fail is null then
        select * into v_order from orders where id = v_order_id;
        if v_order.id is null then fail := 'order not found';
        elsif v_order.payment_status <> 'paid' then fail := 'only paid orders can be adjusted'; end if;
      end if;
    end if;
    if fail is null then
      v_value := null; v_text := null;
      if v_type in ('refund','seller_payout_override','rider_pay_override','payment_fee_override','cogs_override') then
        begin v_value := coalesce(p->>'adjustment_value', cur.adjustment_value::text)::numeric; exception when others then fail := 'amount must be a number'; end;
        if fail is null and (v_value is null or v_value < 0 or v_value > 100000) then fail := 'amount must be 0 or more'; end if;
        if fail is null and v_type = 'refund' then
          v_gross := coalesce(case when v_order.pf_response->>'amount_gross' ~ '^-?[0-9.]+$' then (v_order.pf_response->>'amount_gross')::numeric end, v_order.total, 0);
          if v_value <= 0 then fail := 'refund must be more than 0';
          elsif v_value > v_gross + 0.005 then fail := 'refund cannot be more than the R' || round(v_gross, 2) || ' paid'; end if;
        end if;
      elsif v_type = 'payment_method_set' then
        v_text := coalesce(nullif(p->>'adjustment_text', ''), cur.adjustment_text);
        if v_text is null or not (coalesce(cfg->'fee_rates', '{}'::jsonb) ? v_text) then fail := 'payment method must be one of the fee-rate methods'; end if;
      end if;
    end if;
    if fail is null and v_type = 'seller_payout_override' then
      select count(distinct coalesce(oi.seller_id, pr.seller_id)) into v_stores
        from order_items oi left join products pr on pr.id = oi.product_id
        left join sellers s on s.id = coalesce(oi.seller_id, pr.seller_id)
       where oi.order_id = v_order.id and not coalesce(s.is_house, false);
      if v_seller is null and v_stores > 1 then fail := 'this order has more than one store — choose the store';
      elsif v_seller is not null and not exists (select 1 from order_items oi left join products pr on pr.id = oi.product_id
               where oi.order_id = v_order.id and coalesce(oi.seller_id, pr.seller_id) = v_seller) then
        fail := 'that store is not on this order'; end if;
    elsif fail is null then
      v_seller := null;
    end if;
    if fail is null then
      v_date := coalesce(public.fin__order_day(v_order), current_date);
      if cur.id is null then
        begin
          insert into finance_entries (kind, category, description, amount, occurred_on, order_id, seller_id,
                                       adjustment_type, adjustment_value, adjustment_text, created_by)
          values ('adjustment', v_type, v_desc, round(coalesce(v_value, 0), 2), v_date, v_order.id, v_seller,
                  v_type, round(v_value, 2), v_text, auth.uid()) returning * into v_row;
        exception when unique_violation then
          raise exception using message = 'FIN_DUPLICATE', errcode = '23505',
            detail = 'this order already has a live ' || replace(v_type, '_', ' ') || ' — remove it first';
        end;
      else
        update finance_entries set description = v_desc, amount = round(coalesce(v_value, 0), 2),
          adjustment_value = round(v_value, 2), adjustment_text = v_text, updated_at = now()
         where id = cur.id returning * into v_row;
      end if;
    end if;
  end if;

  if fail is not null then
    raise exception using message = 'FIN_INVALID', errcode = '22023', detail = fail;
  end if;
  return to_jsonb(v_row) || jsonb_build_object('created_by_name', public.fin__user_name(v_row.created_by));
end $f$;

create or replace function public.fin_entry_void(p_id uuid, p_reason text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $f$
declare v_row finance_entries;
begin
  perform public.fin__assert_admin();
  if length(btrim(coalesce(p_reason, ''))) = 0 or length(p_reason) > 300 then
    raise exception using message = 'FIN_INVALID', errcode = '22023', detail = 'a reason is required (max 300)';
  end if;
  update finance_entries set voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason), updated_at = now()
   where id = p_id and voided_at is null returning * into v_row;
  if v_row.id is null then
    raise exception using message = 'NOT_FOUND', errcode = 'P0002', detail = 'entry not found or already removed';
  end if;
  return to_jsonb(v_row);
end $f$;

-- one-tap "exclude as test" toggle (wraps exclude_test adjustments; idempotent)
create or replace function public.fin_set_excluded(p_order_id uuid, p_excluded boolean, p_note text default null)
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $f$
declare v_id uuid; v_n int;
begin
  perform public.fin__assert_admin();
  if p_excluded then
    select id into v_id from finance_entries
     where order_id = p_order_id and adjustment_type = 'exclude_test' and voided_at is null;
    if v_id is null then
      v_id := (public.fin_entry_save(jsonb_build_object('kind', 'adjustment', 'adjustment_type', 'exclude_test',
                 'order_id', p_order_id, 'description', coalesce(nullif(btrim(p_note), ''), 'marked as test'))) ->> 'id')::uuid;
    end if;
  else
    update finance_entries set voided_at = now(), voided_by = auth.uid(),
           void_reason = coalesce(nullif(btrim(p_note), ''), 'unmarked as test'), updated_at = now()
     where order_id = p_order_id and adjustment_type = 'exclude_test' and voided_at is null;
    get diagnostics v_n = row_count;
    v_id := null;
  end if;
  return jsonb_build_object('order_id', p_order_id, 'excluded', p_excluded, 'entry_id', v_id);
end $f$;

-- ───────────────────────── admin: assumptions + store prices ─────────────────────────
create or replace function public.fin_settings_get()
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions'
as $f$
declare s site_settings;
begin
  perform public.fin__assert_admin();
  select * into s from site_settings where key = 'finance';
  return jsonb_build_object('value', coalesce(s.value, '{}'::jsonb) - 'store_prices',
    'store_prices_count', (select count(*) from jsonb_object_keys(coalesce(s.value->'store_prices', '{}'::jsonb))),
    'updated_at', s.updated_at, 'updated_by', s.updated_by, 'updated_by_name', public.fin__user_name(s.updated_by),
    'payfast_defaults', jsonb_build_object(
      'cc', jsonb_build_object('name','Card','pct',3.2,'fixed',2.00,'min',0,'vat',true),
      'dc', jsonb_build_object('name','Debit card','pct',3.2,'fixed',2.00,'min',0,'vat',true),
      'ap', jsonb_build_object('name','Apple Pay','pct',3.2,'fixed',2.00,'min',0,'vat',true),
      'gp', jsonb_build_object('name','Google Pay','pct',3.2,'fixed',2.00,'min',0,'vat',true),
      'sp', jsonb_build_object('name','Samsung Pay','pct',3.2,'fixed',2.00,'min',0,'vat',true),
      'cp', jsonb_build_object('name','Capitec Pay','pct',2.0,'fixed',0,'min',2.00,'vat',true),
      'ef', jsonb_build_object('name','Instant EFT','pct',2.0,'fixed',0,'min',2.00,'vat',true),
      'unknown', jsonb_build_object('name','PayFast (method unknown)','pct',3.2,'fixed',2.00,'min',0,'vat',true)));
end $f$;

-- Saves the assumptions. store_prices are NEVER replaced here (use fin_store_price_set), so two admins
-- editing assumptions and store prices at the same time cannot wipe each other's prices.
create or replace function public.fin_settings_save(p_value jsonb)
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $f$
declare v_cur jsonb;
begin
  perform public.fin__assert_admin();
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception using message = 'FINANCE_INVALID', errcode = '22023', detail = 'value must be an object';
  end if;
  select value into v_cur from site_settings where key = 'finance' for update;
  insert into site_settings (key, value, updated_at, updated_by)
  values ('finance', (p_value - 'store_prices') || jsonb_build_object('store_prices', coalesce(v_cur->'store_prices', '{}'::jsonb)), now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  return public.fin_settings_get();
end $f$;

create or replace function public.fin_store_prices_list(p_seller_id uuid default null, p_missing_only boolean default false)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions'
as $f$
declare v_sp jsonb := coalesce(public.fin__settings()->'store_prices', '{}'::jsonb);
        v_markup numeric := coalesce((public.fin__settings()->>'default_markup_percent')::numeric, 9);
begin
  perform public.fin__assert_admin();
  return coalesce((
    select jsonb_agg(r order by (r->>'sold_value_90d')::numeric desc, r->>'shop_name', r->>'name') from (
      select jsonb_build_object(
        'product_id', p.id, 'name', p.name, 'seller_id', s.id, 'shop_name', s.shop_name, 'is_house', s.is_house,
        'visible', p.visible, 'listing_type', p.listing_type,
        'sell_price', case when p.sale and coalesce(p.sale_price, 0) > 0 then p.sale_price else p.price end,
        'store_price', (v_sp->>p.id::text)::numeric,
        'estimated_store_price', round((case when p.sale and coalesce(p.sale_price, 0) > 0 then p.sale_price else p.price end) / (1 + v_markup / 100), 2),
        'missing', (v_sp->>p.id::text) is null and not exists (select 1 from product_variants v where v.product_id = p.id and v_sp ? (p.id::text || ':' || v.id::text)),
        'variants', coalesce((select jsonb_agg(jsonb_build_object('variant_id', v.id, 'size', v.size,
              'sell_price', coalesce(v.price_override, case when p.sale and coalesce(p.sale_price, 0) > 0 then p.sale_price else p.price end),
              'store_price', (v_sp->>(p.id::text || ':' || v.id::text))::numeric) order by v.size)
            from product_variants v where v.product_id = p.id and v.price_override is not null), '[]'::jsonb),
        'sold_qty_90d', coalesce(sold.qty, 0), 'sold_value_90d', coalesce(sold.val, 0)) as r
      from products p join sellers s on s.id = p.seller_id
      left join lateral (select sum(oi.quantity) as qty, round(sum(oi.subtotal), 2) as val
                           from order_items oi join orders o on o.id = oi.order_id
                          where oi.product_id = p.id and o.payment_status = 'paid'
                            and coalesce(o.paid_at, o.created_at at time zone 'UTC') > now() - interval '90 days') sold on true
      where (p_seller_id is null or s.id = p_seller_id) and coalesce(s.status, '') <> 'disabled'
    ) q
    where not p_missing_only or (q.r->>'missing')::boolean), '[]'::jsonb);
end $f$;

create or replace function public.fin_store_price_set(p_product_id uuid, p_variant_id uuid default null, p_price numeric default null)
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $f$
declare p products; v_sell numeric; v_key text; v_cur jsonb; v_po numeric; v_house boolean;
begin
  perform public.fin__assert_admin();
  select * into p from products where id = p_product_id;
  if p.id is null then raise exception using message = 'NOT_FOUND', errcode = 'P0002', detail = 'product not found'; end if;
  select is_house into v_house from sellers where id = p.seller_id;
  v_sell := case when p.sale and coalesce(p.sale_price, 0) > 0 then p.sale_price else p.price end;
  if p_variant_id is not null then
    select price_override into v_po from product_variants where id = p_variant_id and product_id = p_product_id;
    if not found then raise exception using message = 'NOT_FOUND', errcode = 'P0002', detail = 'that size/variant is not on this product'; end if;
    v_sell := coalesce(v_po, v_sell);
    v_key := p_product_id::text || ':' || p_variant_id::text;
  else
    v_key := p_product_id::text;
  end if;
  if p_price is not null and (p_price < 0 or p_price > 100000) then
    raise exception using message = 'FIN_INVALID', errcode = '22023', detail = 'store price must be 0 or more';
  end if;
  select value into v_cur from site_settings where key = 'finance' for update;
  if v_cur is null then raise exception using message = 'FINANCE_MISSING', errcode = 'P0002', detail = 'finance settings row is missing'; end if;
  update site_settings set
    value = jsonb_set(v_cur, '{store_prices}',
              case when p_price is null then coalesce(v_cur->'store_prices', '{}'::jsonb) - v_key
                   else coalesce(v_cur->'store_prices', '{}'::jsonb) || jsonb_build_object(v_key, round(p_price, 2)) end),
    updated_at = now(), updated_by = auth.uid()
   where key = 'finance';
  return jsonb_build_object('product_id', p_product_id, 'variant_id', p_variant_id, 'key', v_key,
    'store_price', round(p_price, 2), 'sell_price', v_sell, 'is_house', coalesce(v_house, false),
    'markup_amount', case when p_price is not null then round(v_sell - p_price, 2) end,
    'markup_pct', case when p_price is not null and p_price > 0 then round(100 * (v_sell - p_price) / p_price, 2) end,
    'warning', case when p_price is not null and p_price > v_sell then
      case when coalesce(v_house, false) then 'cost is more than the selling price' else 'store price is more than the selling price — Umzila would lose on each sale' end end);
end $f$;

-- ───────────────────────── staff (logistics + admin) ─────────────────────────
create or replace function public.fin_sales_by_period(p_from date, p_to date, p_gran text default 'day')
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions'
as $f$
declare v jsonb;
begin
  perform public.fin__assert_staff();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then
    raise exception using message = 'FIN_INVALID', errcode = '22023', detail = 'choose a range of up to about two years';
  end if;
  if coalesce(p_gran, '') not in ('day', 'week', 'month') then
    raise exception using message = 'FIN_INVALID', errcode = '22023', detail = 'granularity must be day, week or month';
  end if;
  v := public.fin__order_lines(p_from, p_to, false);
  return jsonb_build_object('from', p_from, 'to', p_to, 'gran', p_gran,
    'rows', coalesce((select jsonb_agg(jsonb_build_object('period', per, 'orders', n, 'gross', g, 'goods', gd) order by per) from (
        select date_trunc(p_gran, (e->>'day')::date)::date as per, count(*) as n,
               round(sum((e->'payment'->>'gross')::numeric), 2) as g, round(sum((e->'goods'->>'after_discount')::numeric), 2) as gd
          from jsonb_array_elements(v) e group by 1) q), '[]'::jsonb),
    'totals', (select jsonb_build_object('orders', count(*), 'gross', coalesce(round(sum((e->'payment'->>'gross')::numeric), 2), 0),
                 'goods', coalesce(round(sum((e->'goods'->>'after_discount')::numeric), 2), 0),
                 'average_order', case when count(*) > 0 then round(avg((e->'payment'->>'gross')::numeric), 2) else 0 end)
                 from jsonb_array_elements(v) e));
end $f$;

create or replace function public.fin_top_products(p_from date, p_to date, p_limit int default 10)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions'
as $f$
declare v jsonb;
begin
  perform public.fin__assert_staff();
  if p_from is null or p_to is null or p_to < p_from then
    raise exception using message = 'FIN_INVALID', errcode = '22023', detail = 'from/to dates required';
  end if;
  v := public.fin__order_lines(p_from, p_to, false);
  return coalesce((select jsonb_agg(r order by (r->>'goods')::numeric desc) from (
    select jsonb_build_object('product_id', max(l->>'product_id'),
        'name', coalesce(max(p.name), max(l->>'name')), 'shop_name', max(x->>'shop_name'), 'seller_id', max(x->>'seller_id'),
        'is_house', bool_or((x->>'is_house')::boolean),
        'orders', count(distinct e->>'order_id'), 'qty', sum((l->>'qty')::numeric),
        'goods', round(sum((l->>'subtotal')::numeric), 2)) as r
      from jsonb_array_elements(v) e
      cross join lateral jsonb_array_elements(e->'stores') x
      cross join lateral jsonb_array_elements(x->'lines') l
      left join products p on p.id::text = l->>'product_id'
     group by coalesce(l->>'product_id', l->>'name')
     order by sum((l->>'subtotal')::numeric) desc
     limit greatest(1, least(coalesce(p_limit, 10), 100))) q), '[]'::jsonb);
end $f$;

create or replace function public.fin_store_breakdown(p_from date, p_to date)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions'
as $f$
declare v jsonb; v_admin boolean;
begin
  perform public.fin__assert_staff();
  if p_from is null or p_to is null or p_to < p_from then
    raise exception using message = 'FIN_INVALID', errcode = '22023', detail = 'from/to dates required';
  end if;
  v_admin := public.timeslot_is_admin();
  v := public.fin__order_lines(p_from, p_to, false);
  return jsonb_build_object('from', p_from, 'to', p_to, 'is_admin', v_admin,
    'rows', coalesce((select jsonb_agg(case when v_admin then r else r - 'owed' - 'owed_estimated' - 'commission' - 'cogs' - 'margin_pct' end
                        order by (r->>'is_house')::boolean, (r->>'goods')::numeric desc) from (
      select jsonb_build_object('seller_id', x->>'seller_id', 'shop_name', max(x->>'shop_name'), 'slug', max(x->>'slug'),
        'is_house', bool_or((x->>'is_house')::boolean), 'orders', count(distinct e->>'order_id'),
        'goods_list', round(sum((x->>'goods_list')::numeric), 2), 'discounts_seller', round(sum((x->>'seller_discount')::numeric), 2),
        'goods', round(sum((x->>'goods_after_discount')::numeric), 2),
        'owed', round(sum((x->>'owed')::numeric), 2), 'owed_estimated', round(sum((x->>'owed_est_amount')::numeric), 2),
        'commission', round(sum((x->>'commission')::numeric), 2), 'cogs', round(sum((x->>'cogs')::numeric), 2),
        'margin_pct', case when sum((x->>'goods_after_discount')::numeric) > 0 then round(100 * (
            case when bool_or((x->>'is_house')::boolean) then sum((x->>'goods_after_discount')::numeric) - sum((x->>'cogs')::numeric)
                 else sum((x->>'commission')::numeric) end) / sum((x->>'goods_after_discount')::numeric), 2) else 0 end) as r
      from jsonb_array_elements(v) e cross join lateral jsonb_array_elements(e->'stores') x
      group by x->>'seller_id') q), '[]'::jsonb));
end $f$;

create or replace function public.fin_delivery_breakdown(p_from date, p_to date)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions'
as $f$
declare v jsonb; v_rows jsonb;
begin
  perform public.fin__assert_admin();
  if p_from is null or p_to is null or p_to < p_from then
    raise exception using message = 'FIN_INVALID', errcode = '22023', detail = 'from/to dates required';
  end if;
  v := public.fin__order_lines(p_from, p_to, false);
  select coalesce(jsonb_agg(jsonb_build_object('order_id', e->>'order_id', 'order_number', e->>'order_number', 'day', e->>'day',
      'customer_name', e->>'customer_name', 'stores', (select jsonb_agg(x->>'shop_name') from jsonb_array_elements(e->'stores') x where not (x->>'is_house')::boolean),
      'status', e->'delivery'->>'status',
      'fee_customer', (e->'delivery'->>'fee_customer')::numeric, 'priority', (e->'delivery'->>'priority')::numeric,
      'shipping_total', (e->'delivery'->>'shipping_total')::numeric,
      'rider_pay', (e->'delivery'->>'rider_pay')::numeric, 'rider_pay_est', (e->'delivery'->>'rider_pay_est')::boolean,
      'rider_pay_override', (e->'delivery'->>'rider_pay_override')::boolean,
      'margin', round((e->'delivery'->>'shipping_total')::numeric - (e->'delivery'->>'rider_pay')::numeric, 2),
      'free_delivery', (e->'delivery'->>'free_delivery')::boolean,
      'minutes_to_deliver', e->'delivery'->'minutes_to_deliver') order by e->>'when' desc), '[]'::jsonb)
    into v_rows from jsonb_array_elements(v) e where (e->'delivery'->>'has_delivery')::boolean;
  return jsonb_build_object('from', p_from, 'to', p_to,
    'rider_pay_counted', coalesce((public.fin__settings()->>'count_rider_pay_as_cost')::boolean, false),
    'orders', v_rows,
    'totals', (select jsonb_build_object('deliveries', count(*),
        'delivered', count(*) filter (where r->>'status' = 'DELIVERED'),
        'cancelled', count(*) filter (where r->>'status' = 'CANCELLED'),
        'fee_customer', coalesce(round(sum((r->>'fee_customer')::numeric), 2), 0),
        'priority', coalesce(round(sum((r->>'priority')::numeric), 2), 0),
        'rider_pay', coalesce(round(sum((r->>'rider_pay')::numeric), 2), 0),
        'margin', coalesce(round(sum((r->>'margin')::numeric), 2), 0),
        'free_delivery_orders', count(*) filter (where (r->>'free_delivery')::boolean),
        'rider_pay_on_free', coalesce(round(sum((r->>'rider_pay')::numeric) filter (where (r->>'free_delivery')::boolean), 2), 0),
        'avg_minutes_to_deliver', round(avg((r->>'minutes_to_deliver')::numeric)),
        'delivered_share', case when count(*) > 0 then round(count(*) filter (where r->>'status' = 'DELIVERED')::numeric / count(*), 4) else 0 end)
      from jsonb_array_elements(v_rows) r));
end $f$;

-- Logistics "Record payment" for hand-entered ORD- orders only (PayFast orders stay ITN-owned).
create or replace function public.logistics_record_manual_payment(p_order_id uuid, p_method text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $f$
declare o orders;
begin
  perform public.fin__assert_staff();
  if coalesce(p_method, '') not in ('cash', 'pos', 'eft_manual') then
    raise exception using message = 'FIN_INVALID', errcode = '22023', detail = 'method must be cash, pos or eft_manual';
  end if;
  select * into o from orders where id = p_order_id for update;
  if o.id is null then raise exception using message = 'NOT_FOUND', errcode = 'P0002', detail = 'order not found'; end if;
  if coalesce(o.order_number, '') not like 'ORD-%' or o.pf_payment_id is not null or o.m_payment_id is not null then
    raise exception using message = 'NOT_MANUAL_ORDER', errcode = '22023', detail = 'only orders entered in logistics (ORD-…) can be marked paid here; online payments are confirmed by PayFast';
  end if;
  if o.payment_status = 'paid' then
    raise exception using message = 'ALREADY_PAID', errcode = '22023', detail = 'this order is already paid';
  end if;
  update orders set payment_status = 'paid', paid_at = now(), payment_method_code = p_method
   where id = p_order_id returning * into o;
  return jsonb_build_object('order_id', o.id, 'order_number', o.order_number, 'payment_status', o.payment_status,
    'payment_method_code', o.payment_method_code, 'paid_at', o.paid_at, 'order_status', o.order_status);
end $f$;

-- ───────────────────────── grants ─────────────────────────
do $g$
declare f text;
begin
  foreach f in array array[
    'fin__assert_admin()', 'fin__assert_staff()', 'fin__user_name(uuid)', 'fin__settings()', 'fin__order_day(public.orders)',
    'fin__entries_in_range(date,date,boolean)', 'fin__order_lines(date,date,boolean)',
    'fin_order_lines(date,date,boolean)', 'fin_summary(date,date,boolean)', 'fin_entries_list(date,date,boolean)',
    'fin_entry_save(jsonb)', 'fin_entry_void(uuid,text)', 'fin_set_excluded(uuid,boolean,text)',
    'fin_settings_get()', 'fin_settings_save(jsonb)', 'fin_store_prices_list(uuid,boolean)', 'fin_store_price_set(uuid,uuid,numeric)',
    'fin_sales_by_period(date,date,text)', 'fin_top_products(date,date,integer)', 'fin_store_breakdown(date,date)',
    'fin_delivery_breakdown(date,date)', 'logistics_record_manual_payment(uuid,text)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'fin_order_lines(date,date,boolean)', 'fin_summary(date,date,boolean)', 'fin_entries_list(date,date,boolean)',
    'fin_entry_save(jsonb)', 'fin_entry_void(uuid,text)', 'fin_set_excluded(uuid,boolean,text)',
    'fin_settings_get()', 'fin_settings_save(jsonb)', 'fin_store_prices_list(uuid,boolean)', 'fin_store_price_set(uuid,uuid,numeric)',
    'fin_sales_by_period(date,date,text)', 'fin_top_products(date,date,integer)', 'fin_store_breakdown(date,date)',
    'fin_delivery_breakdown(date,date)', 'logistics_record_manual_payment(uuid,text)']
  loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $g$;
