-- 38_rider_pay_split.sql (2026-11-28) — the founder's rider pay split, ONE rule for every place
-- that needs a rider's pay: rider_pay_for_delivery(delivery_id).
--   Order paid while Finances → "External riders" is on (fin__rider_cost_at(paid time)):
--     rider = delivery fee the customer paid (shipping − priority) × rider_delivery_share_percent (90 %)
--             + rider_priority_share (R7) on a priority order.
--     Free delivery (customer paid R0 for delivery): the normal distance band is used as the fee,
--     so the rider is paid as usual and Umzila covers it.
--   Otherwise (staff riders): the old band — R34 first 3 road-km + R0.40/km, +R3 per extra store,
--   max R45, R39 if the distance is unknown.
-- Both percentages live in site_settings 'finance' (admin → Finances → Assumptions).
-- Used by: compute_driver_payout_on_route_completion (what is owed), lib/payout-formula.js
-- payoutForDelivery (the amount on an offer), fin__order_lines (Finances estimate while a trip is open).

create or replace function public.rider_pay_for_delivery(p_delivery uuid)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare
  cfg jsonb := coalesce((select value from site_settings where key = 'finance'), '{}'::jsonb);
  v_share numeric := coalesce((cfg->>'rider_delivery_share_percent')::numeric, 90);
  v_prio_share numeric := coalesce((cfg->>'rider_priority_share')::numeric, 7);
  r record; v_band numeric; v_fee numeric;
begin
  select d.id, o.id as order_id, coalesce(o.paid_at, o.created_at at time zone 'UTC') as paid_ts,
         coalesce(o.shipping_cost, 0) as shipping, coalesce(o.priority_fee, q.priority_fee, 0) as priority, q.distance_km,
         greatest(1, (select count(distinct oi.seller_id) from order_items oi join sellers s on s.id = oi.seller_id
                       where oi.order_id = o.id and not coalesce(s.is_house, false))) as stores
    into r
    from deliveries d join orders o on o.id = d.order_id left join delivery_quotes q on q.id = d.quote_id
   where d.id = p_delivery;
  if r.id is null then return 39; end if;

  v_band := case when r.distance_km is null then 39 else 34 + greatest(r.distance_km - 3, 0) * 0.40 end
            + 3 * greatest(r.stores - 1, 0);
  v_band := round(least(45, greatest(34, v_band)), 2);

  if not public.fin__rider_cost_at(r.paid_ts) then return v_band; end if;

  v_fee := greatest(r.shipping - r.priority, 0);
  if v_fee <= 0 then v_fee := v_band; end if;          -- free delivery: Umzila covers the rider
  return round(v_fee * v_share / 100 + case when r.priority > 0 then v_prio_share else 0 end, 2);
end $$;
revoke all on function public.rider_pay_for_delivery(uuid) from public, anon, authenticated;
grant execute on function public.rider_pay_for_delivery(uuid) to service_role;

-- What is owed when a trip finishes: one line per delivery from the one rule.
create or replace function public.compute_driver_payout_on_route_completion()
returns trigger language plpgsql security definer set search_path = public, extensions as $function$
declare
  v_pickups int; v_drops int; v_route_km numeric; v_route_minutes numeric;
  v_amount numeric := 0; v_lines jsonb := '[]'::jsonb; r record; v_fee numeric;
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    select count(*) filter (where stop_type = 'pickup'), count(*) filter (where stop_type = 'drop')
      into v_pickups, v_drops from route_stops where route_id = new.id;
    select coalesce(sum(ST_Distance(location, prev_location)), 0) / 1000.0 into v_route_km
      from (select location, lag(location) over (order by seq_order) as prev_location
              from route_stops where route_id = new.id) ordered;
    v_route_minutes := coalesce(greatest(extract(epoch from (now() - new.started_at)) / 60.0, 0), 0);

    for r in
      select d.id as delivery_id, q.distance_km,
             (select count(*) from route_stops rs where rs.route_id = new.id and rs.stop_type = 'pickup' and rs.delivery_id = d.id) as stores
        from route_stops s join deliveries d on d.id = s.delivery_id
        left join delivery_quotes q on q.id = d.quote_id
       where s.route_id = new.id and s.stop_type = 'drop'
    loop
      v_fee := public.rider_pay_for_delivery(r.delivery_id);
      v_amount := v_amount + v_fee;
      v_lines := v_lines || jsonb_build_object('delivery_id', r.delivery_id, 'road_km', r.distance_km, 'stores', r.stores, 'pay', v_fee);
    end loop;
    if v_amount = 0 then v_amount := 39; end if;

    update routes set total_distance_km = v_route_km, total_duration_min = v_route_minutes where id = new.id;

    insert into driver_payouts (route_id, driver_id, amount, calculation_basis)
    values (new.id, new.driver_id, v_amount,
      jsonb_build_object('method', 'rider_pay_for_delivery_2026_11_28',
        'rule', 'external riders: 90% of the delivery fee (+R7 priority); otherwise R34 first 3 road-km + R0.40/km, +R3 per extra store, max R45',
        'deliveries', v_lines, 'route_km', v_route_km, 'route_minutes', v_route_minutes,
        'pickups', v_pickups, 'drops', v_drops, 'route_completed_at', now()))
    on conflict (route_id) do nothing;
  end if;
  return new;
end;
$function$;

-- Finances: while a trip is still open, estimate a delivery's rider pay with the same rule.
do $patch$
declare f text; a int; b int; g text;
begin
  f := pg_get_functiondef('public.fin__order_lines(date, date, boolean)'::regprocedure);
  a := strpos(f, 'else round(case when c.km is null then coalesce((v_band->>''fallback'')::numeric, 39)');
  b := strpos(f, 'end as rider_pay,');
  if a = 0 or b = 0 or b < a then raise exception 'fin__order_lines rider estimate not found'; end if;
  g := substr(f, 1, a - 1) || 'else public.rider_pay_for_delivery(c.delivery_id) ' || substr(f, b);
  execute g;
end $patch$;

-- Defaults, editable in admin → Finances → Assumptions.
update site_settings set value = value || jsonb_build_object(
    'rider_delivery_share_percent', coalesce((value->>'rider_delivery_share_percent')::numeric, 90),
    'rider_priority_share', coalesce((value->>'rider_priority_share')::numeric, 7))
 where key = 'finance';
