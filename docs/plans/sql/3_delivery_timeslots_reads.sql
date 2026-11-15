-- Delivery timeslots: read/admin functions + slot columns on tracking / ops board.
-- (get_delivery_tracking / get_ops_board bodies = the live ones + the added slot fields only.)

drop function if exists public.get_delivery_tracking(uuid, uuid);
create function public.get_delivery_tracking(p_order_id uuid, p_token uuid default null)
returns table(delivery_id uuid, status delivery_status, delivery_pin text, destination_lat double precision,
  destination_lon double precision, driver_lat double precision, driver_lon double precision,
  driver_location_at timestamptz, pickup_stop_status text, drop_stop_status text, created_at timestamptz,
  dispatched_at timestamptz, driver_name text, delivery_note text, orders_ahead boolean,
  store_closed_name text, store_opens_at timestamptz,
  slot_window_start timestamptz, slot_window_end timestamptz, slot_cutoff_at timestamptz, slot_needs_attention boolean)
language plpgsql stable security definer set search_path to 'public', 'extensions'
as $function$
declare
  v_delivery deliveries%rowtype;
  v_driver_id uuid;
  v_show_position boolean;
  v_name text;
  v_note text;
  v_priority boolean;
  v_my_drop_seq int;
  v_ahead boolean := false;
  v_closed_name text;
  v_opens timestamptz;
  v_ws timestamptz; v_we timestamptz; v_attn boolean;
begin
  select * into v_delivery from deliveries d
    where d.order_id = p_order_id and d.tracking_enabled = true
      and ((auth.uid() is not null and d.customer_id = auth.uid())
           or (p_token is not null and d.tracking_token = p_token));
  if not found then return; end if;

  v_show_position := v_delivery.status in ('IN_ROUTE', 'NEXT_STOP', 'ARRIVING', 'PIN_REQUIRED');
  select nullif(trim(coalesce(v_delivery.delivery_instructions, o.notes, '')), '') into v_note from orders o where o.id = v_delivery.order_id;
  select o.slot_window_start, o.slot_window_end, o.slot_needs_attention into v_ws, v_we, v_attn from orders o where o.id = v_delivery.order_id;
  select coalesce(q.priority_fee, 0) > 0 into v_priority from delivery_quotes q where q.id = v_delivery.quote_id;
  if v_delivery.status = 'PENDING' then
    select c.shop_name, c.opens_at into v_closed_name, v_opens from order_closed_store(v_delivery.order_id) c;
  end if;

  if v_delivery.route_id is not null then
    select r.driver_id into v_driver_id from routes r where r.id = v_delivery.route_id;
    select initcap(nullif(trim(p.first_name), '')) into v_name
      from drivers dr join profiles p on p.user_id = dr.user_id where dr.id = v_driver_id;
    select rs.seq_order into v_my_drop_seq from route_stops rs
      where rs.route_id = v_delivery.route_id and rs.stop_type = 'drop' and rs.delivery_id = v_delivery.id limit 1;
    if not coalesce(v_priority, false) and v_delivery.status in ('ASSIGNED', 'DRIVER_AT_PICKUP', 'PARTIALLY_PICKED_UP', 'PICKED_UP') then
      select exists(select 1 from route_stops rs where rs.route_id = v_delivery.route_id and rs.stop_type = 'drop'
                      and rs.delivery_id <> v_delivery.id and rs.status <> 'completed' and rs.seq_order < v_my_drop_seq)
        into v_ahead;
    end if;
  end if;

  return query
  select
    v_delivery.id, v_delivery.status, v_delivery.delivery_pin::text,
    ST_Y(v_delivery.destination_geo::geometry), ST_X(v_delivery.destination_geo::geometry),
    case when v_show_position then (select ST_Y(dr.last_location::geometry) from drivers dr where dr.id = v_driver_id) else null end,
    case when v_show_position then (select ST_X(dr.last_location::geometry) from drivers dr where dr.id = v_driver_id) else null end,
    case when v_show_position then (select dr.last_location_at from drivers dr where dr.id = v_driver_id) else null end,
    (select rs.status from route_stops rs where rs.route_id = v_delivery.route_id and rs.stop_type = 'pickup' and rs.delivery_id = v_delivery.id
       order by (rs.status = 'completed'), rs.seq_order limit 1),
    (select rs.status from route_stops rs where rs.route_id = v_delivery.route_id and rs.stop_type = 'drop' and rs.delivery_id = v_delivery.id limit 1),
    v_delivery.created_at, v_delivery.dispatched_at,
    v_name, v_note, coalesce(v_ahead, false), v_closed_name, v_opens,
    v_ws, v_we, case when v_ws is not null then public.timeslot_cutoff_at(v_ws) end, coalesce(v_attn, false);
end;
$function$;

-- get_ops_board: live body + run_window_start / run_window_end on each delivery
create or replace function public.get_ops_board()
returns jsonb
language plpgsql stable security definer set search_path to 'public', 'extensions'
as $function$
declare
  v_staff boolean;
begin
  select exists(select 1 from admins a where a.user_id = auth.uid())
      or exists(select 1 from user_roles r where r.user_id = auth.uid() and r.is_active
                  and lower(r.role) in ('logistics', 'admin'))
    into v_staff;
  if not coalesce(v_staff, false) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'now', now(),
    'deliveries', coalesce((
      select jsonb_agg(x order by (x->>'created_at') desc) from (
        select jsonb_build_object(
          'id', d.id, 'order_id', d.order_id, 'order_number', o.order_number, 'status', d.status,
          'created_at', d.created_at, 'dispatched_at', d.dispatched_at, 'delivered_at', d.delivered_at,
          'since', coalesce((select max(e.created_at) from delivery_events e where e.delivery_id = d.id), d.created_at),
          'customer', o.customer_name, 'phone', o.customer_phone,
          'area', coalesce(d.destination_snapshot->>'city', o.city),
          'address', coalesce(d.destination_snapshot->>'address', o.delivery_address),
          'total', o.total, 'fee', o.shipping_cost,
          'stores', (select coalesce(jsonb_agg(distinct s.shop_name), '[]'::jsonb)
                       from order_items oi join sellers s on s.id = oi.seller_id where oi.order_id = d.order_id),
          'items', (select coalesce(sum(oi.quantity), 0) from order_items oi where oi.order_id = d.order_id),
                    'rider', (select initcap(nullif(trim(p.first_name), '')) from routes r join drivers dr on dr.id = r.driver_id
                      left join profiles p on p.user_id = dr.user_id where r.id = d.route_id),
          'pin_locked', d.pin_locked_at is not null, 'failure_reason', d.failure_reason,
          'store_closed', case when d.status = 'PENDING' then (select c.shop_name from order_closed_store(d.order_id) c) end,
          'store_opens_at', case when d.status = 'PENDING' then (select c.opens_at from order_closed_store(d.order_id) c) end,
          'run_window_start', o.slot_window_start, 'run_window_end', o.slot_window_end
        ) x
        from deliveries d join orders o on o.id = d.order_id
        where d.status not in ('DELIVERED', 'CANCELLED', 'FAILED', 'RETURNED')
           or d.created_at > now() - interval '2 days'
        limit 300
      ) t), '[]'::jsonb),
    'riders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', dr.id,
        'name', coalesce(initcap(nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '')), split_part(p.email, '@', 1), 'Rider'),
        'online', dr.is_online and dr.last_seen_at > now() - interval '3 minutes',
        'last_seen_at', dr.last_seen_at, 'eligible', dr.eligibility_status = 'eligible' and dr.can_do_live_delivery,
        'on_route', exists(select 1 from routes r where r.driver_id = dr.id and r.status <> 'completed'),
        'trip_orders', (select count(distinct s.delivery_id) from routes r join route_stops s on s.route_id = r.id
                          where r.driver_id = dr.id and r.status <> 'completed' and s.status <> 'completed'),
        'gps_at', dr.last_location_at
      ) order by dr.is_online desc, dr.last_seen_at desc nulls last)
      from drivers dr left join profiles p on p.user_id = dr.user_id), '[]'::jsonb),
    'delivery_status_by_order', coalesce((
      select jsonb_object_agg(d.order_id, d.status) from deliveries d
       where d.created_at > now() - interval '120 days'), '{}'::jsonb)
  );
end;
$function$;

-- Run sheet (staff) ------------------------------------------------------------------
create or replace function public.get_run_sheet(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_cfg jsonb := public.timeslot_settings(); v_busy int := (v_cfg->>'busy_alert_at')::int;
  v_cut int := (v_cfg->>'cutoff_minutes')::int; v_out jsonb := '[]'::jsonb;
  rec record; v_ws timestamptz; v_we timestamptz; v_co timestamptz; v_state text; v_paid int;
  v_stores jsonb; v_dr record; v_active boolean; v_total int; v_terminal int; v_moving int;
  v_paused boolean; v_skipped boolean;
begin
  if not public.timeslot_is_staff() then raise exception 'not allowed' using errcode = '42501'; end if;
  for rec in
    select sl.id as sid, (p_from + g) as rd
      from public.delivery_slots sl cross join generate_series(0, p_to - p_from) g
     where extract(dow from (p_from + g))::smallint = any (sl.days)
       and (sl.active or exists (select 1 from public.orders o where o.slot_id = sl.id and o.slot_run_date = p_from + g))
    union
    select o.slot_id, o.slot_run_date from public.orders o
     where o.slot_id is not null and o.slot_run_date between p_from and p_to
    order by 2, 1
  loop
    select min(o.slot_window_start), max(o.slot_window_end) into v_ws, v_we
      from public.orders o where o.slot_id = rec.sid and o.slot_run_date = rec.rd;
    select sl.active into v_active from public.delivery_slots sl where sl.id = rec.sid;
    if v_ws is null then
      select (rec.rd + sl.start_time) at time zone 'Africa/Johannesburg', (rec.rd + sl.end_time) at time zone 'Africa/Johannesburg'
        into v_ws, v_we from public.delivery_slots sl where sl.id = rec.sid;
    end if;
    v_co := v_ws - make_interval(mins => v_cut);
    select count(*) filter (where true),
           count(*) filter (where d.status in ('DELIVERED','CANCELLED','FAILED','RETURNED')),
           count(*) filter (where d.status in ('IN_ROUTE','NEXT_STOP','ARRIVING','PIN_REQUIRED','DELIVERED'))
      into v_total, v_terminal, v_moving
      from public.orders o left join public.deliveries d on d.order_id = o.id
     where o.slot_id = rec.sid and o.slot_run_date = rec.rd and o.payment_status = 'paid'
       and o.order_status not in ('refunded','cancelled');
    v_paid := v_total;
    select exists (select 1 from public.delivery_slot_exceptions e where e.run_date = rec.rd and e.slot_id is null),
           exists (select 1 from public.delivery_slot_exceptions e where e.run_date = rec.rd and e.slot_id = rec.sid)
      into v_paused, v_skipped;
    v_state := case
      when v_paid > 0 and v_terminal = v_paid then 'done'
      when now() >= v_we then 'done'
      when v_paused then 'paused'
      when v_skipped then 'skipped'
      when not coalesce(v_active, false) then 'off'
      when v_moving > 0 then 'out_for_delivery'
      when now() >= v_co then 'preparing'
      else 'taking_orders' end;
    select * into v_dr from public.delivery_runs r where r.slot_id = rec.sid and r.run_date = rec.rd;

    select coalesce(jsonb_agg(st order by st->>'shop_name'), '[]'::jsonb) into v_stores from (
      select jsonb_build_object('seller_id', s.id,
        'shop_name', case when s.is_house then 'Umzila stock' else s.shop_name end,
        'orders', (
          select jsonb_agg(jsonb_build_object(
            'order_id', o.id, 'order_number', o.order_number, 'customer_name', o.customer_name,
            'customer_phone', o.customer_phone,
            'address', concat_ws(', ', nullif(o.delivery_address, ''), nullif(o.city, ''), nullif(o.postal_code, '')),
            'items', (select jsonb_agg(jsonb_build_object('name', oi.product_name, 'size', oi.selected_size, 'qty', oi.quantity))
                        from public.order_items oi where oi.order_id = o.id and oi.seller_id = s.id),
            'delivery_status', (select dd.status::text from public.deliveries dd where dd.order_id = o.id),
            'needs_attention', o.slot_needs_attention,
            'moved_from', (select jsonb_build_object('window_start', m.from_window_start, 'window_end', m.from_window_end,
                                                      'reason', m.reason, 'at', m.created_at)
                             from public.delivery_run_moves m where m.order_id = o.id order by m.created_at asc limit 1)
          ) order by o.slot_needs_attention desc, o.order_number)
          from public.orders o
          where o.slot_id = rec.sid and o.slot_run_date = rec.rd and o.payment_status = 'paid'
            and o.order_status not in ('refunded','cancelled')
            and exists (select 1 from public.order_items oi where oi.order_id = o.id and oi.seller_id = s.id))
      ) st
      from public.sellers s
      where s.id in (select oi.seller_id from public.order_items oi join public.orders o on o.id = oi.order_id
                      where o.slot_id = rec.sid and o.slot_run_date = rec.rd and o.payment_status = 'paid'
                        and o.order_status not in ('refunded','cancelled'))
    ) q;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'slot_id', rec.sid, 'run_date', rec.rd, 'window_start', v_ws, 'window_end', v_we, 'cutoff_at', v_co,
      'state', v_state, 'paid_count', v_paid, 'busy', v_paid >= v_busy,
      'summary_sent_at', v_dr.summary_sent_at, 'late_minutes', v_dr.late_minutes, 'stores', v_stores,
      'needs_attention_count', (select count(*) from public.orders o where o.slot_id = rec.sid and o.slot_run_date = rec.rd
                                  and o.slot_needs_attention and o.payment_status = 'paid' and o.order_status not in ('refunded','cancelled'))));
  end loop;
  return (select coalesce(jsonb_agg(e order by e->>'window_start'), '[]'::jsonb) from jsonb_array_elements(v_out) e);
end $$;

create or replace function public.admin_affected_orders(p_slot_id uuid default null, p_run_date date default null)
returns table (order_id uuid, order_number text, customer_name text, customer_phone text,
               slot_id uuid, run_date date, window_start timestamptz, window_end timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not public.timeslot_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select o.id, o.order_number, o.customer_name, o.customer_phone, o.slot_id, o.slot_run_date,
           o.slot_window_start, o.slot_window_end
      from public.orders o
     where o.slot_id is not null and o.payment_status = 'paid' and o.order_status not in ('refunded','cancelled')
       and o.slot_window_end > now()
       and (p_slot_id is null or o.slot_id = p_slot_id)
       and (p_run_date is null or o.slot_run_date = p_run_date)
     order by o.slot_window_start, o.order_number;
end $$;

create or replace function public.admin_runs_for_order(p_order_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_items jsonb; v_sellers uuid[]; v_out jsonb;
begin
  if not public.timeslot_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select items into v_items from public.orders where id = p_order_id;
  v_sellers := public.timeslot_goods_sellers(v_items);
  select coalesce(jsonb_agg(jsonb_build_object('slot_id', u.slot_id, 'run_date', u.run_date,
           'window_start', u.window_start, 'window_end', u.window_end, 'cutoff_at', u.cutoff_at,
           'state', u.state, 'blocking_store', u.blocking_store) order by u.window_start), '[]'::jsonb)
    into v_out from (
      select distinct on (x.slot_id, x.run_date) x.* from (
        select 1 as src, r.* from public.timeslot_open_runs(v_sellers, now()) r
        union all
        select 2, r.* from public.timeslot_open_runs(v_sellers, now() + interval '1 day') r
      ) x where x.window_end > now() order by x.slot_id, x.run_date, x.src
    ) u;
  return v_out;
end $$;

create or replace function public.admin_move_order_run(p_order_id uuid, p_slot_id uuid, p_run_date date,
                                                       p_reason text default 'admin') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare o public.orders%rowtype; sl public.delivery_slots%rowtype; v_ws timestamptz; v_we timestamptz;
begin
  if not public.timeslot_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_reason not in ('admin', 'admin_stop') then p_reason := 'admin'; end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found or o.payment_status is distinct from 'paid' or o.order_status in ('refunded','cancelled') then
    raise exception 'ORDER_NOT_MOVABLE';
  end if;
  select * into sl from public.delivery_slots where id = p_slot_id;
  if not found or not (extract(dow from p_run_date)::smallint = any (sl.days)) then
    raise exception 'SLOT_NOT_FOUND_OR_DAY';
  end if;
  v_ws := (p_run_date + sl.start_time) at time zone 'Africa/Johannesburg';
  v_we := (p_run_date + sl.end_time) at time zone 'Africa/Johannesburg';
  perform set_config('umzila.slot_write', '1', true);
  insert into public.delivery_run_moves (order_id, from_slot_id, from_run_date, from_window_start, from_window_end,
      to_slot_id, to_run_date, to_window_start, to_window_end, reason, actor_type, actor_id)
    values (o.id, o.slot_id, o.slot_run_date, o.slot_window_start, o.slot_window_end,
            p_slot_id, p_run_date, v_ws, v_we, p_reason, 'admin', auth.uid());
  update public.orders set slot_id = p_slot_id, slot_run_date = p_run_date, slot_window_start = v_ws,
         slot_window_end = v_we, slot_needs_attention = false where id = o.id;
  insert into public.delivery_runs (slot_id, run_date) values (p_slot_id, p_run_date) on conflict do nothing;
  return jsonb_build_object('ok', true, 'window_start', v_ws, 'window_end', v_we);
end $$;

grant execute on function public.get_run_sheet(date, date) to authenticated, service_role;
grant execute on function public.admin_affected_orders(uuid, date) to authenticated, service_role;
grant execute on function public.admin_runs_for_order(uuid) to authenticated, service_role;
grant execute on function public.admin_move_order_run(uuid, uuid, date, text) to authenticated, service_role;
revoke execute on function public.get_run_sheet(date, date) from public, anon;
revoke execute on function public.admin_affected_orders(uuid, date) from public, anon;
revoke execute on function public.admin_runs_for_order(uuid) from public, anon;
revoke execute on function public.admin_move_order_run(uuid, uuid, date, text) from public, anon;
