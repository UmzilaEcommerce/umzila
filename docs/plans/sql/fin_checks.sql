-- fin_checks.sql — Finances workstream A tests. Runs in ONE rolled-back DO block (raises at the end),
-- so nothing it writes survives. Expected numbers are hand-computed from live data on 2026-11-16.
-- Run with the Supabase SQL editor / MCP execute_sql. Success = error 'ALL_FIN_CHECKS_PASSED: ...'.
do $t$
#variable_conflict use_column
declare
  v_admin uuid := '957a38d9-abfe-4b63-812a-11388cf8df11';   -- an admins row
  v_user  uuid := 'c56414f5-43bd-4c21-895e-d34188df4363';   -- a plain signed-in user (no admin, no user_roles)
  s jsonb; l jsonb; e jsonb; x jsonb; v_id uuid; v_n int; v_num numeric; v_txt text; ok text[] := '{}';
  v_r5 uuid; v_plate137 uuid; v_r110 uuid; v_velaphi uuid; v_pf_order uuid; v_paid_manual uuid; v_tmp uuid;
begin
  select id into v_r5 from orders where order_number = 'UMZILA-1794821590398-xbh5lqmgw';
  select id into v_plate137 from orders where order_number = 'UMZILA-1793106368038-rtkuxajgb';   -- 1 × R137 Velaphi plate
  select id into v_r110 from orders where order_number = 'UMZILA-1774960538430-4trvv2jrv';      -- R110 gross, fee 2.53 (EFT/Capitec pattern)
  select id into v_velaphi from orders where order_number = 'UMZILA-1791454382909-uhx2uww9e';   -- VELAPHI seller code, 152.60 − 15.26
  select id into v_paid_manual from orders where order_number = 'ORD-790502';
  v_pf_order := v_plate137;

  -- ── as admin ──
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- (10) October 2026 by hand: 16 paid orders (10 PayFast + 6 manual cash), gross 2075.05, actual fees 77.62, rider pay 379.66
  s := public.fin_summary('2026-10-01', '2026-10-31');
  if (s->>'orders')::int <> 16 then raise exception 'T10 orders: % (want 16)', s->>'orders'; end if;
  if (s->'totals'->>'gross')::numeric <> 2075.05 then raise exception 'T10 gross: %', s->'totals'->>'gross'; end if;
  if (s->'totals'->>'payfast_fees')::numeric <> 77.62 then raise exception 'T10 fees: %', s->'totals'->>'payfast_fees'; end if;
  if (s->'totals'->>'rider_pay')::numeric <> 379.66 then raise exception 'T10 rider pay: %', s->'totals'->>'rider_pay'; end if;
  if (s->'totals'->>'rider_cost')::numeric <> 0 then raise exception 'T10 rider pay must not be a cost by default'; end if;
  ok := array_append(ok, 'T10 Oct 2026 = 16 orders / R2075.05 / fees R77.62 / rider R379.66 (not a cost)'::text);

  -- (5) fin_summary totals = Σ fin_order_lines; (1) per-order identities
  l := public.fin_order_lines('2026-01-01', '2026-12-31');
  s := public.fin_summary('2026-01-01', '2026-12-31');
  select round(sum((e->'payment'->>'gross')::numeric), 2) into v_num from jsonb_array_elements(l) e;
  if v_num <> (s->'totals'->>'gross')::numeric then raise exception 'T5 gross % vs %', v_num, s->'totals'->>'gross'; end if;
  select round(sum((e->'umzila'->>'net')::numeric), 2) into v_num from jsonb_array_elements(l) e;
  if v_num <> (s->'totals'->>'umzila_gross_profit')::numeric then raise exception 'T5 gross profit % vs %', v_num, s->'totals'->>'umzila_gross_profit'; end if;
  if jsonb_array_length(l) <> (s->>'orders')::int then raise exception 'T5 order count'; end if;
  ok := array_append(ok, 'T5 summary totals = sum of order lines'::text);
  for e in select * from jsonb_array_elements(l) loop
    -- gross = goods after discount + delivery + tips + unexplained (unexplained flagged when ≠ 0)
    if abs((e->'payment'->>'gross')::numeric - ((e->'goods'->>'after_discount')::numeric + (e->'delivery'->>'shipping_total')::numeric
           + (e->>'tips')::numeric + (e->'umzila'->>'unexplained')::numeric)) > 0.01 then
      raise exception 'T1 identity broken on %', e->>'order_number'; end if;
    if abs((e->'umzila'->>'unexplained')::numeric) > 0.01 and not (e->'flags') ? 'totals_mismatch' then
      raise exception 'T1 mismatch not flagged on %', e->>'order_number'; end if;
    -- net = components
    if abs((e->'umzila'->>'net')::numeric - ((e->'umzila'->>'commission')::numeric + (e->'umzila'->>'house_value')::numeric
           - (e->'umzila'->>'house_cogs')::numeric + (e->'umzila'->>'delivery_income')::numeric + (e->'umzila'->>'tips_income')::numeric
           - (e->'umzila'->>'discounts_funded')::numeric - (e->'umzila'->>'fees_paid')::numeric - (e->'umzila'->>'refunds')::numeric
           - (e->'umzila'->>'rider_cost')::numeric - (e->'umzila'->>'tips_to_rider')::numeric + (e->'umzila'->>'unexplained')::numeric)) > 0.03 then
      raise exception 'T1 net components broken on % (net %)', e->>'order_number', e->'umzila'->>'net'; end if;
  end loop;
  ok := array_append(ok, 'T1 gross identity + net components hold for every order (mismatches flagged)'::text);

  -- (2) Σ owed + Σ commission = Σ non-house goods after seller discounts
  select round(sum((x->>'owed')::numeric + (x->>'commission')::numeric), 2), round(sum((x->>'goods_after_discount')::numeric), 2)
    into v_num, v_txt
    from jsonb_array_elements(l) e, jsonb_array_elements(e->'stores') x where not (x->>'is_house')::boolean;
  if v_num <> v_txt::numeric then raise exception 'T2 owed+commission % vs goods %', v_num, v_txt; end if;
  ok := array_append(ok, 'T2 owed + commission = store goods after seller discounts'::text);

  -- excluded R5 test order is not counted; its rider pay override is 0
  if exists (select 1 from jsonb_array_elements(l) e where (e->>'order_id')::uuid = v_r5) then raise exception 'R5 test order still counted'; end if;
  if (s->>'excluded_orders')::int < 1 then raise exception 'excluded_orders should be >= 1'; end if;
  select e into x from jsonb_array_elements(public.fin_order_lines('2026-11-16', '2026-11-16', true)) e where (e->>'order_id')::uuid = v_r5;
  if not (x->>'excluded')::boolean or (x->'delivery'->>'rider_pay')::numeric <> 0 or not (x->'delivery'->>'rider_pay_override')::boolean then
    raise exception 'R5 seed wrong: %', x->'delivery'; end if;
  ok := array_append(ok, 'R5 Apple Pay test excluded, rider pay overridden to 0'::text);

  -- (4) fee estimates: R5 Apple Pay → 2.48 (= actual), R314 card pattern → 13.86 (= actual)
  if (x->'payment'->>'fee_estimate')::numeric <> 2.48 or (x->'payment'->>'fee')::numeric <> 2.48 then raise exception 'T4 R5 fee %', x->'payment'; end if;
  select e into x from jsonb_array_elements(l) e where e->>'order_number' = 'UMZILA-1794480859977-0g9hd21pc';
  if (x->'payment'->>'fee_estimate')::numeric <> 13.86 or (x->'payment'->>'fee')::numeric <> 13.86 then raise exception 'T4 R314 fee %', x->'payment'; end if;
  -- Capitec / EFT 2 % min R2 + VAT: R110 → 2.53 once its method is set to cp; actual fee still wins
  perform public.fin_entry_save(jsonb_build_object('kind', 'adjustment', 'adjustment_type', 'payment_method_set', 'order_id', v_r110, 'adjustment_text', 'cp'));
  select e into x from jsonb_array_elements(public.fin_order_lines('2026-03-31', '2026-03-31')) e where (e->>'order_id')::uuid = v_r110;
  if x->'payment'->>'method_code' <> 'cp' or (x->'payment'->>'fee_estimate')::numeric <> 2.53 or not (x->'payment'->>'fee_actual')::boolean then
    raise exception 'T4 capitec %', x->'payment'; end if;
  ok := array_append(ok, 'T4 fee estimates: R5 card 2.48, R314 card 13.86, R110 Capitec 2.53 (actual wins)'::text);

  -- store price: plate sold at R137 → store owed R130, commission R7, not estimated
  select e into x from jsonb_array_elements(l) e where (e->>'order_id')::uuid = v_plate137;
  if (x->'umzila'->>'owed_to_stores')::numeric <> 125.69 or not (x->'estimates'->>'owed')::boolean then raise exception 'SP before: %', x->'umzila'; end if;
  x := public.fin_store_price_set('dbb0d565-42c0-4cb2-a695-4f082271e732', null, 130);
  if (x->>'markup_amount')::numeric <> 7 then raise exception 'SP set result %', x; end if;
  select e into x from jsonb_array_elements(public.fin_order_lines('2026-10-27', '2026-10-27')) e where (e->>'order_id')::uuid = v_plate137;
  if (x->'umzila'->>'owed_to_stores')::numeric <> 130 or (x->'umzila'->>'commission')::numeric <> 7 or (x->'estimates'->>'owed')::boolean then
    raise exception 'SP after: %', x->'umzila'; end if;
  if exists (select 1 from jsonb_array_elements(public.fin_store_prices_list(null, true)) r where r->>'product_id' = 'dbb0d565-42c0-4cb2-a695-4f082271e732') then
    raise exception 'SP: product still in the missing list'; end if;
  ok := array_append(ok, 'store price: R137 plate -> owed R130, commission R7, leaves the missing list'::text);

  -- seller-funded code: VELAPHI 152.60 − 15.26 → owed 152.60/1.09 − 15.26 = 124.74, Umzila funds 0
  select e into x from jsonb_array_elements(l) e where (e->>'order_id')::uuid = v_velaphi;
  if (x->'umzila'->>'owed_to_stores')::numeric <> 124.74 or x->'goods'->>'discount_funder' <> 'seller' or (x->'goods'->>'umzila_discount')::numeric <> 0 then
    raise exception 'seller discount %', x->'goods'; end if;
  ok := array_append(ok, 'seller promo code comes out of the store share (124.74)'::text);

  -- (3) two-drop route R77.50 splits 38.71 + 38.79 by delivery
  select sum((e->'delivery'->>'rider_pay')::numeric) into v_num from jsonb_array_elements(l) e
   where e->>'order_number' in ('UMZILA-1791454382909-uhx2uww9e', 'UMZILA-1791455566128-pab2a6wnf');
  if v_num <> 77.50 then raise exception 'T3 split %', v_num; end if;
  ok := array_append(ok, 'T3 two-drop route 77.50 = 38.79 + 38.71'::text);

  -- exclude toggle: excluded order disappears from totals, unmark restores
  v_num := (public.fin_summary('2026-10-27', '2026-10-27')->'totals'->>'gross')::numeric;
  perform public.fin_set_excluded(v_plate137, true, 'test of the toggle');
  perform public.fin_set_excluded(v_plate137, true, 'idempotent');
  if (public.fin_summary('2026-10-27', '2026-10-27')->'totals'->>'gross')::numeric <> v_num - 172.48 then raise exception 'exclude toggle'; end if;
  perform public.fin_set_excluded(v_plate137, false, null);
  if (public.fin_summary('2026-10-27', '2026-10-27')->'totals'->>'gross')::numeric <> v_num then raise exception 'unexclude'; end if;
  ok := array_append(ok, 'exclude toggle removes R172.48 and restores it (idempotent)'::text);

  -- (6) recurring expense once per overlapping month; (9) void keeps the row and removes it from totals
  v_id := (public.fin_entry_save(jsonb_build_object('kind', 'expense', 'category', 'Rider wages', 'amount', 100,
             'occurred_on', '2026-09-15', 'recurring', 'monthly'))->>'id')::uuid;
  if (public.fin_summary('2026-10-01', '2026-11-30')->'totals'->>'expenses')::numeric <> 200 then raise exception 'T6 two months'; end if;
  if (public.fin_summary('2026-09-20', '2026-09-25')->'totals'->>'expenses')::numeric <> 100 then raise exception 'T6 part month'; end if;
  if (public.fin_summary('2026-08-01', '2026-08-31')->'totals'->>'expenses')::numeric <> 0 then raise exception 'T6 before start'; end if;
  perform public.fin_entry_save(jsonb_build_object('id', v_id, 'recur_until', '2026-10-05'));
  if (public.fin_summary('2026-10-01', '2026-11-30')->'totals'->>'expenses')::numeric <> 100 then raise exception 'T6 recur_until'; end if;
  perform public.fin_entry_save(jsonb_build_object('kind', 'expense', 'category', 'PayFast payout fee', 'amount', 8.50,
             'occurred_on', '2026-10-10', 'seller_id', '2918b7a7-7c40-45f0-98c5-3821b3f81021', 'description', 'payout to Velaphi'));
  if (public.fin_summary('2026-10-01', '2026-10-31')->'totals'->>'expenses')::numeric <> 108.50 then raise exception 'payout fee entry'; end if;
  perform public.fin_entry_void(v_id, 'test');
  if (public.fin_summary('2026-10-01', '2026-10-31')->'totals'->>'expenses')::numeric <> 8.50 then raise exception 'T9 void'; end if;
  if not exists (select 1 from finance_entries where id = v_id and voided_at is not null) then raise exception 'T9 row gone'; end if;
  if jsonb_array_length(public.fin_entries_list('2026-10-01', '2026-10-31', true)) <= jsonb_array_length(public.fin_entries_list('2026-10-01', '2026-10-31', false)) then
    raise exception 'T9 voided rows not listed with include_voided'; end if;
  -- income entry raises net profit
  v_num := (public.fin_summary('2026-10-01', '2026-10-31')->'totals'->>'net_profit')::numeric;
  perform public.fin_entry_save(jsonb_build_object('kind', 'income', 'category', 'Prize', 'amount', 30000, 'occurred_on', '2026-10-14', 'description', 'Enspire'));
  if (public.fin_summary('2026-10-01', '2026-10-31')->'totals'->>'net_profit')::numeric <> v_num + 30000 then raise exception 'income'; end if;
  ok := array_append(ok, 'T6/T9 recurring months, recur_until, payout-fee entry, void keeps row, income adds to net'::text);

  -- validation
  begin perform public.fin_entry_save(jsonb_build_object('kind', 'expense', 'category', 'Nonsense', 'amount', 5, 'occurred_on', '2026-10-01'));
        raise exception 'bad category accepted'; exception when sqlstate '22023' then null; end;
  begin perform public.fin_entry_save(jsonb_build_object('kind', 'expense', 'category', 'Fuel', 'amount', 0, 'occurred_on', '2026-10-01'));
        raise exception 'zero amount accepted'; exception when sqlstate '22023' then null; end;
  begin perform public.fin_entry_save(jsonb_build_object('kind', 'adjustment', 'adjustment_type', 'refund', 'order_id', v_plate137, 'adjustment_value', 999));
        raise exception 'refund > paid accepted'; exception when sqlstate '22023' then null; end;
  perform public.fin_entry_save(jsonb_build_object('kind', 'adjustment', 'adjustment_type', 'refund', 'order_id', v_plate137, 'adjustment_value', 20));
  begin perform public.fin_entry_save(jsonb_build_object('kind', 'adjustment', 'adjustment_type', 'refund', 'order_id', v_plate137, 'adjustment_value', 5));
        raise exception 'second refund accepted'; exception when sqlstate '23505' then null; end;
  select e into x from jsonb_array_elements(public.fin_order_lines('2026-10-27', '2026-10-27')) e where (e->>'order_id')::uuid = v_plate137;
  if (x->>'refund')::numeric <> 20 or not (x->'flags') ? 'refund' then raise exception 'refund not applied'; end if;
  begin perform public.fin_settings_save('{"default_markup_percent": 300, "fee_rates": {"unknown": {"name": "x", "pct": 3}}}'::jsonb);
        raise exception 'bad settings accepted'; exception when sqlstate '22023' then null; end;
  -- settings save keeps store prices
  perform public.fin_settings_save((public.fin_settings_get()->'value') || '{"count_rider_pay_as_cost": true}'::jsonb);
  reset role;  -- fin__settings is internal (not executable by authenticated)
  if (public.fin__settings()->'store_prices'->>'dbb0d565-42c0-4cb2-a695-4f082271e732')::numeric <> 130 then raise exception 'settings save wiped store prices'; end if;
  set local role authenticated;
  if (public.fin_summary('2026-10-01', '2026-10-31')->'totals'->>'rider_cost')::numeric <> 379.66 then raise exception 'rider toggle on'; end if;
  ok := array_append(ok, 'validation (category, amount, refund cap, duplicate, settings) + settings save keeps store prices + rider toggle'::text);

  -- staff RPCs as admin
  s := public.fin_sales_by_period('2026-10-01', '2026-10-31', 'month');
  if (s->'totals'->>'orders')::int <> 16 then raise exception 'sales_by_period %', s->'totals'; end if;
  if jsonb_array_length(public.fin_top_products('2026-10-01', '2026-10-31', 5)) = 0 then raise exception 'top products empty'; end if;
  if not (public.fin_store_breakdown('2026-10-01', '2026-10-31')->'rows'->0 ? 'owed') then raise exception 'admin breakdown lacks owed'; end if;
  s := public.fin_delivery_breakdown('2026-10-01', '2026-10-31');
  if (s->'totals'->>'rider_pay')::numeric <> 379.66 then raise exception 'delivery breakdown rider %', s->'totals'; end if;
  perform public.get_ops_board();
  ok := array_append(ok, 'staff RPCs + get_ops_board run as admin'::text);

  -- (8) logistics_record_manual_payment
  begin perform public.logistics_record_manual_payment(v_pf_order, 'cash'); raise exception 'PayFast order accepted';
        exception when sqlstate '22023' then if sqlerrm <> 'NOT_MANUAL_ORDER' then raise; end if; end;
  begin perform public.logistics_record_manual_payment(v_paid_manual, 'cash'); raise exception 'paid order accepted';
        exception when sqlstate '22023' then if sqlerrm <> 'ALREADY_PAID' then raise; end if; end;
  reset role;
  insert into orders (order_number, total, order_status, payment_status, customer_name, items, created_at)
  values ('ORD-TEST01', 50, 'Delivered', 'pending', 'fin test', '[]'::jsonb, now() at time zone 'UTC') returning id into v_tmp;
  set local role authenticated;
  x := public.logistics_record_manual_payment(v_tmp, 'pos');
  if x->>'payment_status' <> 'paid' or x->>'payment_method_code' <> 'pos' or x->>'order_status' <> 'Delivered' then raise exception 'T8 record %', x; end if;
  ok := array_append(ok, 'T8 record payment: refuses PayFast + already-paid, marks ORD- paid (order_status untouched)'::text);

  -- (7) plain signed-in user: 42501 on admin and staff RPCs
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  begin perform public.fin_summary('2026-10-01', '2026-10-31'); raise exception 'non-admin got fin_summary'; exception when sqlstate '42501' then null; end;
  begin perform public.fin_sales_by_period('2026-10-01', '2026-10-31', 'day'); raise exception 'non-staff got sales'; exception when sqlstate '42501' then null; end;
  begin perform public.fin_store_price_set('dbb0d565-42c0-4cb2-a695-4f082271e732', null, 1); raise exception 'non-admin set price'; exception when sqlstate '42501' then null; end;
  if (select count(*) from finance_entries) <> 0 then raise exception 'non-admin can read finance_entries'; end if;
  if exists (select 1 from site_settings where key = 'finance') then raise exception 'non-admin can read finance settings'; end if;
  -- logistics role: sales yes, summary no, breakdown without money columns
  reset role;
  insert into user_roles (user_id, role, is_active) values (v_user, 'logistics', true);
  set local role authenticated;
  if (public.fin_sales_by_period('2026-10-01', '2026-10-31', 'month')->'totals'->>'orders')::int <> 16 then raise exception 'logistics sales'; end if;
  if (public.fin_store_breakdown('2026-10-01', '2026-10-31')->'rows'->0) ? 'owed' then raise exception 'logistics sees owed'; end if;
  begin perform public.fin_summary('2026-10-01', '2026-10-31'); raise exception 'logistics got fin_summary'; exception when sqlstate '42501' then null; end;
  ok := array_append(ok, 'T7 non-admin 42501; logistics: sales yes, summary no, breakdown without owed/commission'::text);

  -- anon: no execute on fin_*, no finance settings; public settings still readable (checkout + home)
  reset role;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
  begin perform public.fin_summary('2026-10-01', '2026-10-31'); raise exception 'anon got fin_summary'; exception when sqlstate '42501' then null; end;
  begin perform public.fin_sales_by_period('2026-10-01', '2026-10-31', 'day'); raise exception 'anon got sales'; exception when sqlstate '42501' then null; end;
  if exists (select 1 from site_settings where key = 'finance') then raise exception 'anon can read finance settings'; end if;
  if not exists (select 1 from site_settings where key = 'payments') or not exists (select 1 from site_settings where key = 'home') then
    raise exception 'anon lost public settings'; end if;
  reset role;
  ok := array_append(ok, 'anon: no fin_* execute, finance settings hidden, payments/home still readable'::text);

  raise exception 'ALL_FIN_CHECKS_PASSED: %', array_to_string(ok, ' | ');
end $t$;
