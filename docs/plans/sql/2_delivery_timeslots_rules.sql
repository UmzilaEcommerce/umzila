-- Delivery timeslots: rules + triggers (INERT while site_settings.timeslots.enabled = false)

-- "now" for rules. Clients (anon/authenticated) always get the real clock; staff/service/tests may
-- override with set_config('umzila.now', '<timestamptz>', true).
create or replace function public.timeslot_now() returns timestamptz
language sql stable set search_path = public, extensions as $$
  select case when coalesce(auth.role(), '') in ('anon', 'authenticated') then now()
              else coalesce(nullif(current_setting('umzila.now', true), '')::timestamptz, now()) end;
$$;

create or replace function public.timeslot_store_open_at(p_seller_id uuid, p_at timestamptz) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select case
    when not exists (select 1 from public.seller_availability a where a.seller_id = p_seller_id) then true
    else exists (select 1 from public.seller_availability a
                  where a.seller_id = p_seller_id
                    and a.day_of_week = extract(dow from x.l)::int
                    and a.start_time <= x.l::time
                    and (a.end_time > x.l::time or a.end_time <= a.start_time))
  end
  from (select p_at at time zone 'Africa/Johannesburg' as l) x;
$$;

-- Non-service, non-house sellers of an order's items (same item resolution as create_delivery_on_payment()).
create or replace function public.timeslot_goods_sellers(p_items jsonb) returns uuid[]
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(array_agg(distinct p.seller_id), '{}'::uuid[])
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) it
    join public.products p on p.id = nullif(coalesce(it->>'product_id', it->>'id'), '')::uuid
   where coalesce(it->>'listing_type', p.listing_type, 'product') <> 'service'
     and p.seller_id is not null
     and not exists (select 1 from public.sellers hs where hs.id = p.seller_id and hs.is_house);
$$;

create or replace function public.timeslot_self_arranged(p_sellers uuid[], p_dest geography) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select p_dest is not null and exists (
    select 1 from public.sellers s where s.id = any(p_sellers)
       and s.self_arranged_radius_km is not null and s.pickup_geo is not null
       and ST_Distance(s.pickup_geo, p_dest) <= s.self_arranged_radius_km * 1000);
$$;

-- THE one rule: which runs can a cart (its goods sellers) order for at time p_at.
create or replace function public.timeslot_open_runs(p_seller_ids uuid[], p_at timestamptz)
returns table (slot_id uuid, run_date date, window_start timestamptz, window_end timestamptz,
               cutoff_at timestamptz, state text, blocking_store text, paid_count integer)
language sql stable security definer set search_path = public, extensions as $$
  with cfg as (select public.timeslot_settings() as s),
  base as (
    select sl.id as sid, sl.active, sl.max_orders, d.rd, t.ws, t.we, t.co
      from cfg
      cross join public.delivery_slots sl
      cross join lateral generate_series(0, (cfg.s->>'days_ahead')::int) g
      cross join lateral (select ((p_at at time zone 'Africa/Johannesburg')::date + g) as rd) d
      cross join lateral (select (d.rd + sl.start_time) at time zone 'Africa/Johannesburg' as ws,
                                 (d.rd + sl.end_time) at time zone 'Africa/Johannesburg' as we,
                                 ((d.rd + sl.start_time) at time zone 'Africa/Johannesburg')
                                   - make_interval(mins => (cfg.s->>'cutoff_minutes')::int) as co) t
     where extract(dow from d.rd)::smallint = any (sl.days)
  ),
  x as (
    select b.*,
      exists (select 1 from public.delivery_slot_exceptions e where e.run_date = b.rd and e.slot_id is null) as paused,
      exists (select 1 from public.delivery_slot_exceptions e where e.run_date = b.rd and e.slot_id = b.sid) as skipped,
      exists (select 1 from public.delivery_runs r where r.slot_id = b.sid and r.run_date = b.rd
                 and r.summary_sent_at is not null) as sent,
      (select min(s.shop_name) from public.sellers s
        where s.id = any (coalesce(p_seller_ids, '{}'::uuid[])) and not s.is_house
          and (not public.timeslot_store_open_at(s.id, b.co) or not public.timeslot_store_open_at(s.id, b.ws))) as blocker,
      (select count(*)::int from public.orders o
        where o.slot_id = b.sid and o.slot_run_date = b.rd and o.payment_status = 'paid'
          and o.order_status not in ('refunded', 'cancelled')) as pc
    from base b
  )
  select x.sid, x.rd, x.ws, x.we, x.co,
    case when not x.active then 'off'
         when x.paused then 'paused'
         when x.skipped then 'skipped'
         when p_at >= x.co or x.sent then 'closed'
         when x.blocker is not null then 'store_closed'
         when x.max_orders is not null and x.pc >= x.max_orders then 'full'
         else 'open' end,
    case when x.active and not x.paused and not x.skipped and not (p_at >= x.co or x.sent) then x.blocker end,
    x.pc
  from x
  order by x.ws;
$$;

create or replace function public.timeslot_public_config() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select public.timeslot_settings() || jsonb_build_object('server_now', now());
$$;

create or replace function public.timeslot_runs_for_cart(p_seller_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_cfg jsonb := public.timeslot_settings(); v_runs jsonb; v_next jsonb;
begin
  if not coalesce((v_cfg->>'enabled')::boolean, false) then
    return jsonb_build_object('enabled', false, 'server_now', now());
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('slot_id', r.slot_id, 'run_date', r.run_date,
           'window_start', r.window_start, 'window_end', r.window_end, 'cutoff_at', r.cutoff_at,
           'state', r.state, 'blocking_store', r.blocking_store) order by r.window_start), '[]'::jsonb)
    into v_runs from public.timeslot_open_runs(p_seller_ids, now()) r;
  select r into v_next from jsonb_array_elements(v_runs) r where r->>'state' = 'open' limit 1;
  return jsonb_build_object('enabled', true, 'server_now', now(),
           'cutoff_minutes', v_cfg->'cutoff_minutes', 'grace_minutes', v_cfg->'grace_minutes',
           'runs', v_runs, 'next_open', v_next);
end $$;

-- (a) Atomic check-and-create at Pay ------------------------------------------------
create or replace function public.timeslot_guard_insert() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_client boolean := coalesce(auth.role(), '') in ('anon', 'authenticated');
  v_sellers uuid[]; v_r record; v_next record; v_now timestamptz := public.timeslot_now();
begin
  -- client-supplied slot values are never trusted
  if v_client then
    new.slot_window_start := null; new.slot_window_end := null;
    new.slot_pay_pressed_at := null; new.slot_needs_attention := false;
  end if;
  if not public.timeslot_enabled() or new.order_status <> 'pending_payment' then
    if v_client then new.slot_id := null; new.slot_run_date := null; end if;
    return new;
  end if;
  v_sellers := public.timeslot_goods_sellers(new.items);
  if coalesce(array_length(v_sellers, 1), 0) = 0 or public.timeslot_self_arranged(v_sellers, new.destination_geo) then
    if v_client then new.slot_id := null; new.slot_run_date := null; end if;
    return new;
  end if;
  if new.slot_id is null or new.slot_run_date is null then
    raise exception using message = 'TIMESLOT_REQUIRED', errcode = 'P0001';
  end if;
  perform 1 from public.delivery_slots where id = new.slot_id for update;
  select * into v_r from public.timeslot_open_runs(v_sellers, v_now) r
    where r.slot_id = new.slot_id and r.run_date = new.slot_run_date;
  if not found or v_r.state <> 'open' then
    select * into v_next from public.timeslot_open_runs(v_sellers, v_now) r where r.state = 'open' order by r.window_start limit 1;
    raise exception using message = 'TIMESLOT_CLOSED', errcode = 'P0001',
      detail = jsonb_build_object(
        'reason', coalesce(v_r.state, 'unknown'), 'closed_at', v_r.cutoff_at,
        'window_start', v_r.window_start, 'window_end', v_r.window_end,
        'next_open', case when v_next.slot_id is null then null else jsonb_build_object(
           'slot_id', v_next.slot_id, 'run_date', v_next.run_date, 'window_start', v_next.window_start,
           'window_end', v_next.window_end, 'cutoff_at', v_next.cutoff_at) end)::text;
  end if;
  new.slot_window_start := v_r.window_start;
  new.slot_window_end := v_r.window_end;
  new.slot_pay_pressed_at := v_now;
  new.slot_needs_attention := false;
  return new;
end $$;

drop trigger if exists trg_timeslot_guard_insert on public.orders;
create trigger trg_timeslot_guard_insert before insert on public.orders
  for each row execute function public.timeslot_guard_insert();

-- (b) slot columns are not customer-writable ------------------------------------------
create or replace function public.timeslot_guard_update() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated')
     and coalesce(current_setting('umzila.slot_write', true), '') <> '1'
     and (new.slot_id, new.slot_run_date, new.slot_window_start, new.slot_window_end,
          new.slot_pay_pressed_at, new.slot_needs_attention)
         is distinct from
         (old.slot_id, old.slot_run_date, old.slot_window_start, old.slot_window_end,
          old.slot_pay_pressed_at, old.slot_needs_attention) then
    raise exception using message = 'SLOT_COLUMNS_LOCKED', errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists trg_timeslot_guard_update on public.orders;
create trigger trg_timeslot_guard_update before update on public.orders
  for each row execute function public.timeslot_guard_update();

-- (c) Paid-time rule R11/R12/R13 (fires once: old.order_status is not yet 'paid') -------
create or replace function public.timeslot_on_paid() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cfg jsonb := public.timeslot_settings();
  v_paid timestamptz := coalesce(new.paid_at, public.timeslot_now());
  v_cutoff timestamptz; v_grace_end timestamptz; v_nxt record;
begin
  v_cutoff := new.slot_window_start - make_interval(mins => (v_cfg->>'cutoff_minutes')::int);
  v_grace_end := v_cutoff + make_interval(mins => (v_cfg->>'grace_minutes')::int);
  insert into public.delivery_runs (slot_id, run_date) values (new.slot_id, new.slot_run_date) on conflict do nothing;
  if coalesce(new.slot_pay_pressed_at, v_paid) < v_cutoff and v_paid <= v_grace_end then
    return new;                                                   -- R11
  end if;
  select * into v_nxt from public.timeslot_open_runs(public.timeslot_goods_sellers(new.items), v_paid) r
    where r.state = 'open' and r.window_start > new.slot_window_start
    order by r.window_start limit 1;
  if found then                                                   -- R12
    insert into public.delivery_run_moves (order_id, from_slot_id, from_run_date, from_window_start, from_window_end,
        to_slot_id, to_run_date, to_window_start, to_window_end, reason, actor_type)
      values (new.id, new.slot_id, new.slot_run_date, new.slot_window_start, new.slot_window_end,
        v_nxt.slot_id, v_nxt.run_date, v_nxt.window_start, v_nxt.window_end, 'late_payment', 'system');
    new.slot_id := v_nxt.slot_id; new.slot_run_date := v_nxt.run_date;
    new.slot_window_start := v_nxt.window_start; new.slot_window_end := v_nxt.window_end;
    insert into public.delivery_runs (slot_id, run_date) values (v_nxt.slot_id, v_nxt.run_date) on conflict do nothing;
  else                                                            -- R13
    insert into public.delivery_run_moves (order_id, from_slot_id, from_run_date, from_window_start, from_window_end,
        reason, actor_type)
      values (new.id, new.slot_id, new.slot_run_date, new.slot_window_start, new.slot_window_end, 'late_payment', 'system');
    new.slot_needs_attention := true;
  end if;
  return new;
end $$;

drop trigger if exists trg_timeslot_on_paid on public.orders;
create trigger trg_timeslot_on_paid before update of order_status on public.orders
  for each row
  when (new.order_status = 'paid' and old.order_status is distinct from 'paid' and new.slot_id is not null)
  execute function public.timeslot_on_paid();

-- Grants: internals are service-role only; trigger functions are not callable.
revoke execute on function public.timeslot_open_runs(uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.timeslot_open_runs(uuid[], timestamptz) to service_role;
revoke execute on function public.timeslot_store_open_at(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.timeslot_store_open_at(uuid, timestamptz) to service_role;
revoke execute on function public.timeslot_goods_sellers(jsonb) from public, anon, authenticated;
grant execute on function public.timeslot_goods_sellers(jsonb) to service_role;
revoke execute on function public.timeslot_self_arranged(uuid[], geography) from public, anon, authenticated;
grant execute on function public.timeslot_self_arranged(uuid[], geography) to service_role;
revoke execute on function public.timeslot_guard_insert() from public, anon, authenticated;
revoke execute on function public.timeslot_guard_update() from public, anon, authenticated;
revoke execute on function public.timeslot_on_paid() from public, anon, authenticated;
revoke execute on function public.delivery_slots_guard() from public, anon, authenticated;
