-- 34_delivery_update_emails.sql (2026-11-28) — the "almost there" email is now its own
-- notification_log event 'NEARBY' (the "I've arrived" tap sends ARRIVING = "your rider is
-- outside"). It waits until the latest "collected"/"you're next" email is 2+ minutes old.
create or replace function public.near_drop_deliveries(p_driver uuid, p_lat double precision, p_lon double precision)
returns setof uuid language sql stable security definer set search_path = public, extensions as $$
  with cfg as (
    select coalesce((select (value->>'almost_there_km')::numeric from site_settings where key = 'delivery_emails'), 1.5) as km
  )
  select d.id
    from cfg, routes r
    join route_stops rs on rs.route_id = r.id
    join deliveries d on d.id = rs.delivery_id
   where cfg.km > 0
     and r.driver_id = p_driver
     and r.status in ('assigned', 'started', 'active')
     and rs.stop_type = 'drop' and rs.status = 'active'
     and d.status = 'IN_ROUTE'
     and rs.location is not null
     and st_dwithin(rs.location, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography, cfg.km * 1000)
     and (select max(n.created_at) from notification_log n where n.delivery_id = d.id and n.channel = 'email'
           and n.event_type in ('PICKED_UP', 'IN_ROUTE')) < now() - interval '2 minutes'
     and not exists (select 1 from notification_log n where n.delivery_id = d.id and n.channel = 'email' and n.event_type in ('NEARBY', 'ARRIVING'))
$$;
revoke all on function public.near_drop_deliveries(uuid, double precision, double precision) from public, anon, authenticated;
grant execute on function public.near_drop_deliveries(uuid, double precision, double precision) to service_role;
