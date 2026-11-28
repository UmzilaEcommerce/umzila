-- 37_rider_panel.sql (2026-11-28) — /rider (rider.html) + admin → Riders + "external riders"
-- pay periods in Finances. See docs/systems/rider-panel.md.

-- ── 1. Payout bookkeeping: who paid a rider, with what reference ──
alter table public.driver_payouts add column if not exists paid_reference text;
alter table public.driver_payouts add column if not exists paid_by uuid;

-- ── 2. Rider sign-up: a rider applies on /rider (pending), an admin approves ──
-- drivers.eligibility_status: 'pending' (applied), 'eligible' (approved), 'suspended'.
-- driver-heartbeat.js no longer creates rider rows for ordinary accounts (anyone could
-- have become an eligible rider and seen customer addresses); only staff still self-register.
create or replace function public.rider_apply(p_first_name text, p_phone text, p_vehicle text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode = '42501'; end if;
  if coalesce(trim(p_first_name), '') = '' or coalesce(trim(p_phone), '') = '' or coalesce(trim(p_vehicle), '') = '' then
    raise exception 'MISSING_DETAILS' using errcode = '22023';
  end if;
  update profiles set first_name = coalesce(nullif(first_name, ''), left(trim(p_first_name), 60)),
                      phone = coalesce(nullif(phone, ''), left(trim(p_phone), 30))
   where user_id = v_uid;
  select id into v_id from drivers where user_id = v_uid;
  if v_id is null then
    insert into drivers (user_id, is_online, eligibility_status, vehicle_description)
    values (v_uid, false, 'pending', left(trim(p_vehicle), 80)) returning id into v_id;
  else
    update drivers set vehicle_description = left(trim(p_vehicle), 80) where id = v_id;
  end if;
  return jsonb_build_object('driver_id', v_id);
end $$;
revoke all on function public.rider_apply(text, text, text) from public, anon;
grant execute on function public.rider_apply(text, text, text) to authenticated;

-- Rider edits their own vehicle (shown to customers from "almost there").
create or replace function public.rider_set_vehicle(p_vehicle text)
returns void language sql security definer set search_path = public as $$
  update drivers set vehicle_description = left(nullif(trim(p_vehicle), ''), 80) where user_id = auth.uid();
$$;
revoke all on function public.rider_set_vehicle(text) from public, anon;
grant execute on function public.rider_set_vehicle(text) to authenticated;

-- ── 3. Rider pay per finished delivery (own rows only) ──
-- Pay rule mirrors compute_driver_payout_on_route_completion + lib/payout-formula.js + lib/delivery-price.js
-- (change all together): R34 for the first 3 road-km, +R0.40/km, +R3 per extra store, max R45, R39 if unknown.
create or replace function public.rider__deliveries(p_driver uuid)
returns table (delivery_id uuid, route_id uuid, done_at timestamptz, day date, pay numeric, road_km numeric,
               stores text, area text, payout_id uuid, payout_status text, paid_at timestamptz)
language sql stable security definer set search_path = public as $$
  select (l->>'delivery_id')::uuid, dp.route_id, coalesce(d.delivered_at, dp.created_at),
         (coalesce(d.delivered_at, dp.created_at) at time zone 'Africa/Johannesburg')::date,
         coalesce((l->>'pay')::numeric, 0), (l->>'road_km')::numeric,
         (select string_agg(distinct s.shop_name, ' + ') from order_items oi join sellers s on s.id = oi.seller_id
           where oi.order_id = d.order_id and not coalesce(s.is_house, false)),
         nullif(trim(coalesce(d.destination_snapshot->>'city', '')), ''),
         dp.id, dp.status, dp.paid_at
    from driver_payouts dp
    cross join lateral jsonb_array_elements(coalesce(dp.calculation_basis->'deliveries', '[]'::jsonb)) l
    left join deliveries d on d.id = (l->>'delivery_id')::uuid
   where dp.driver_id = p_driver
$$;
revoke all on function public.rider__deliveries(uuid) from public, anon, authenticated;

-- Everything the /rider Earnings tab needs, for the signed-in rider only.
create or replace function public.get_rider_home()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); dr record; v_today date := (now() at time zone 'Africa/Johannesburg')::date;
  v_week date; v_month date; v_out jsonb;
begin
  if v_uid is null then return jsonb_build_object('status', 'signed_out'); end if;
  select d.*, p.first_name, p.phone into dr from drivers d left join profiles p on p.user_id = d.user_id where d.user_id = v_uid;
  if dr.id is null then
    return jsonb_build_object('status', 'not_rider',
      'profile', (select jsonb_build_object('first_name', first_name, 'phone', phone) from profiles where user_id = v_uid));
  end if;
  v_week := v_today - (extract(isodow from v_today)::int - 1);
  v_month := date_trunc('month', v_today)::date;
  with x as (select * from public.rider__deliveries(dr.id))
  select jsonb_build_object(
    'status', dr.eligibility_status,
    'rider', jsonb_build_object('id', dr.id, 'first_name', dr.first_name, 'phone', dr.phone, 'vehicle', dr.vehicle_description,
                                'is_online', dr.is_online, 'since', dr.created_at),
    'rates', jsonb_build_object('base', 34, 'included_km', 3, 'per_km', 0.40, 'per_extra_store', 3, 'max', 45, 'unknown_distance', 39),
    'totals', jsonb_build_object(
      'today', coalesce((select sum(pay) from x where day = v_today), 0),
      'today_n', (select count(*) from x where day = v_today),
      'week', coalesce((select sum(pay) from x where day >= v_week), 0),
      'week_n', (select count(*) from x where day >= v_week),
      'month', coalesce((select sum(pay) from x where day >= v_month), 0),
      'month_n', (select count(*) from x where day >= v_month),
      'all', coalesce((select sum(pay) from x), 0),
      'all_n', (select count(*) from x),
      'km_month', coalesce((select sum(road_km) from x where day >= v_month), 0),
      'owed', coalesce((select sum(amount) from driver_payouts where driver_id = dr.id and status = 'pending'), 0),
      'paid', coalesce((select sum(amount) from driver_payouts where driver_id = dr.id and status = 'paid'), 0),
      'in_progress', coalesce((select sum(o.payout_amount) from driver_offers o join routes r on r.id = o.route_id
                                where o.driver_id = dr.id and o.status = 'accepted' and r.status <> 'completed'), 0)),
    'days', (select coalesce(jsonb_agg(jsonb_build_object('day', g::date, 'pay', coalesce(s.pay, 0), 'n', coalesce(s.n, 0)) order by g), '[]'::jsonb)
               from generate_series(v_today - 13, v_today, interval '1 day') g
               left join (select day, sum(pay) pay, count(*) n from x group by day) s on s.day = g::date),
    'recent', (select coalesce(jsonb_agg(r order by r.done_at desc), '[]'::jsonb) from (
                 select jsonb_build_object('at', done_at, 'pay', pay, 'km', road_km, 'stores', stores, 'area', area, 'status', payout_status) r, done_at
                   from x order by done_at desc limit 30) r),
    'payouts', (select coalesce(jsonb_agg(jsonb_build_object('paid_at', paid_at, 'amount', amount, 'reference', paid_reference, 'n', n) order by paid_at desc), '[]'::jsonb)
                  from (select paid_at, paid_reference, sum(amount) amount, count(*) n from driver_payouts
                         where driver_id = dr.id and status = 'paid' group by paid_at, paid_reference order by paid_at desc limit 20) p)
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.get_rider_home() from public, anon;
grant execute on function public.get_rider_home() to authenticated;

-- ── 4. Admin → Riders ──
create or replace function public.admin_riders()
returns jsonb language plpgsql stable security definer set search_path = public, auth as $$
declare v_month date := date_trunc('month', (now() at time zone 'Africa/Johannesburg'))::date;
begin
  perform public.fin__assert_admin();
  return coalesce((select jsonb_agg(r order by (r->>'status') = 'pending' desc, r->>'name') from (
    select jsonb_build_object(
      'id', d.id, 'name', coalesce(nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), u.email),
      'email', u.email, 'phone', p.phone, 'vehicle', d.vehicle_description, 'status', d.eligibility_status,
      'online', d.is_online and d.last_seen_at > now() - interval '3 minutes', 'last_seen', d.last_seen_at, 'since', d.created_at,
      'is_staff', exists (select 1 from admins a where a.user_id = d.user_id) or exists (select 1 from user_roles ur where ur.user_id = d.user_id and ur.is_active),
      'month', coalesce((select sum(x.pay) from public.rider__deliveries(d.id) x where x.day >= v_month), 0),
      'month_n', (select count(*) from public.rider__deliveries(d.id) x where x.day >= v_month),
      'all_n', (select count(*) from public.rider__deliveries(d.id) x),
      'owed', coalesce((select sum(amount) from driver_payouts dp where dp.driver_id = d.id and dp.status = 'pending'), 0),
      'owed_n', (select count(*) from driver_payouts dp where dp.driver_id = d.id and dp.status = 'pending'),
      'paid', coalesce((select sum(amount) from driver_payouts dp where dp.driver_id = d.id and dp.status = 'paid'), 0),
      'last_paid', (select max(paid_at) from driver_payouts dp where dp.driver_id = d.id and dp.status = 'paid')) r
    from drivers d join auth.users u on u.id = d.user_id left join profiles p on p.user_id = d.user_id) s), '[]'::jsonb);
end $$;
revoke all on function public.admin_riders() from public, anon;
grant execute on function public.admin_riders() to authenticated;

create or replace function public.admin_rider_set_status(p_driver uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.fin__assert_admin();
  if p_status not in ('eligible', 'pending', 'suspended') then raise exception 'BAD_STATUS' using errcode = '22023'; end if;
  update drivers set eligibility_status = p_status,
                     is_online = case when p_status = 'eligible' then is_online else false end
   where id = p_driver;
  if p_status <> 'eligible' then
    update driver_offers set status = 'expired' where driver_id = p_driver and status = 'pending';
  end if;
end $$;
revoke all on function public.admin_rider_set_status(uuid, text) from public, anon;
grant execute on function public.admin_rider_set_status(uuid, text) to authenticated;

-- Add an existing account as an approved rider (they sign up on /rider first, or already have an account).
create or replace function public.admin_rider_add(p_email text)
returns uuid language plpgsql security definer set search_path = public, auth as $$
declare v_uid uuid; v_id uuid;
begin
  perform public.fin__assert_admin();
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email));
  if v_uid is null then raise exception 'NO_ACCOUNT' using errcode = 'P0002'; end if;
  insert into drivers (user_id, is_online, eligibility_status) values (v_uid, false, 'eligible')
  on conflict (user_id) do update set eligibility_status = 'eligible' returning id into v_id;
  return v_id;
end $$;
revoke all on function public.admin_rider_add(text) from public, anon;
grant execute on function public.admin_rider_add(text) to authenticated;

-- Mark everything owed to a rider as paid (one payment, one reference).
create or replace function public.admin_rider_pay(p_driver uuid, p_reference text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n int; v_amt numeric; v_now timestamptz := now();
begin
  perform public.fin__assert_admin();
  with u as (
    update driver_payouts set status = 'paid', paid_at = v_now, paid_reference = left(nullif(trim(p_reference), ''), 120), paid_by = auth.uid()
     where driver_id = p_driver and status = 'pending' returning amount)
  select count(*), coalesce(sum(amount), 0) into v_n, v_amt from u;
  return jsonb_build_object('payouts', v_n, 'amount', v_amt, 'paid_at', v_now);
end $$;
revoke all on function public.admin_rider_pay(uuid, text) from public, anon;
grant execute on function public.admin_rider_pay(uuid, text) to authenticated;

-- ── 5. "External riders" = periods when rider pay is a cost (Finances) ──
-- site_settings 'finance'.count_rider_pay_as_cost is now the switch for FROM NOW ON; flipping it
-- opens/closes a period in rider_pay_cost_periods [{from, to}] (server-kept: whatever a client
-- sends for that key is ignored). An order's rider pay is a cost only when it was paid inside a
-- period, so switching on never changes earlier orders and switching off never changes the
-- orders paid while it was on.
create or replace function public.site_settings_finance_rider_periods()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old boolean := case when tg_op = 'UPDATE' then coalesce((old.value->>'count_rider_pay_as_cost')::boolean, false) else false end;
  v_new boolean := coalesce((new.value->>'count_rider_pay_as_cost')::boolean, false);
  v_p jsonb := case when tg_op = 'UPDATE' then coalesce(old.value->'rider_pay_cost_periods', '[]'::jsonb) else '[]'::jsonb end;
  n int;
begin
  if new.key <> 'finance' then return new; end if;
  if jsonb_typeof(v_p) <> 'array' then v_p := '[]'::jsonb; end if;
  n := jsonb_array_length(v_p);
  if v_new and not v_old then
    v_p := v_p || jsonb_build_array(jsonb_build_object('from', now(), 'to', null, 'by', auth.uid()));
  elsif v_old and not v_new and n > 0 and (v_p->(n - 1)->>'to') is null then
    v_p := jsonb_set(v_p, array[(n - 1)::text, 'to'], to_jsonb(now()));
  end if;
  new.value := jsonb_set(new.value, '{rider_pay_cost_periods}', v_p);
  return new;
end $$;
drop trigger if exists site_settings_finance_rider_periods on public.site_settings;
create trigger site_settings_finance_rider_periods before insert or update on public.site_settings
  for each row when (new.key = 'finance') execute function public.site_settings_finance_rider_periods();

create or replace function public.fin__rider_cost_at(p_ts timestamptz)
returns boolean language sql stable security definer set search_path = public as $$
  select p_ts is not null and exists (
    select 1 from jsonb_array_elements(coalesce((select value->'rider_pay_cost_periods' from site_settings where key = 'finance'), '[]'::jsonb)) p
     where p_ts >= (p->>'from')::timestamptz and (p->>'to' is null or p_ts < (p->>'to')::timestamptz))
$$;
create or replace function public.fin__rider_cost_any(p_from date, p_to date)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from jsonb_array_elements(coalesce((select value->'rider_pay_cost_periods' from site_settings where key = 'finance'), '[]'::jsonb)) p
     where ((p->>'from')::timestamptz at time zone 'Africa/Johannesburg')::date <= p_to
       and (p->>'to' is null or ((p->>'to')::timestamptz at time zone 'Africa/Johannesburg')::date >= p_from))
$$;
revoke all on function public.fin__rider_cost_at(timestamptz) from public, anon, authenticated;
revoke all on function public.fin__rider_cost_any(date, date) from public, anon, authenticated;

-- Rewire the finance engine from the one global switch to the periods (text patch of the live
-- definitions; each pattern must be found exactly as expected or the migration stops).
do $patch$
declare f text; g text;
begin
  f := pg_get_functiondef('public.fin__order_lines(date, date, boolean)'::regprocedure);
  g := replace(f, 'case when v_rider_cost then c.rider_pay else 0 end as rider_cost',
                  'case when public.fin__rider_cost_at(c.when_ts) then c.rider_pay else 0 end as rider_cost');
  g := replace(g, '''rider_pay'', f.rider_est and v_rider_cost', '''rider_pay'', f.rider_est and public.fin__rider_cost_at(f.when_ts)');
  g := replace(g, '''rider_pay_counted'', v_rider_cost', '''rider_pay_counted'', public.fin__rider_cost_at(f.when_ts)');
  if g = f or position('v_rider_cost then' in g) > 0 then raise exception 'fin__order_lines patch did not apply'; end if;
  execute g;

  f := pg_get_functiondef('public.fin_summary(date, date, boolean)'::regprocedure);
  g := replace(f, 'v_rider_cost boolean := coalesce((cfg->>''count_rider_pay_as_cost'')::boolean, false);',
                  'v_rider_cost boolean := public.fin__rider_cost_any(p_from, p_to);');
  if g = f then raise exception 'fin_summary patch did not apply'; end if;
  execute g;

  f := pg_get_functiondef('public.fin_delivery_breakdown(date, date)'::regprocedure);
  g := replace(f, '''rider_pay_counted'', coalesce((public.fin__settings()->>''count_rider_pay_as_cost'')::boolean, false)',
                  '''rider_pay_counted'', public.fin__rider_cost_any(p_from, p_to)');
  if g = f then raise exception 'fin_delivery_breakdown patch did not apply'; end if;
  execute g;
end $patch$;
