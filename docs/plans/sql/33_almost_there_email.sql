-- 33_almost_there_email.sql — the "Your rider is a few minutes away" email goes out from the
-- rider's live GPS (driver-heartbeat.js, every ~12 s on a drop leg) once they are within
-- site_settings 'delivery_emails'.almost_there_km of the customer (admin.html → Delivery Pricing →
-- "Almost there" email; 0 = off, the email then goes when the rider taps "I've arrived", as before).
-- notify() logs it as ARRIVING in notification_log, so the arrival tap does not send it again.

-- Which of this rider's current drops are close enough. Only the drop the rider is heading to
-- (route_stops.status 'active', delivery IN_ROUTE), only once the "on the way" email is 2+ minutes
-- old (two emails seconds apart when the next drop is round the corner helps nobody), never twice.
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
     and exists (select 1 from notification_log n where n.delivery_id = d.id and n.event_type = 'IN_ROUTE' and n.channel = 'email'
                  and n.created_at < now() - interval '2 minutes')
     and not exists (select 1 from notification_log n where n.delivery_id = d.id and n.event_type = 'ARRIVING' and n.channel = 'email')
$$;
revoke all on function public.near_drop_deliveries(uuid, double precision, double precision) from public, anon, authenticated;
grant execute on function public.near_drop_deliveries(uuid, double precision, double precision) to service_role;

insert into public.site_settings (key, value) values ('delivery_emails', '{"almost_there_km": 1.5}'::jsonb)
on conflict (key) do nothing;
