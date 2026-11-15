-- Applied 2026-11-15 as migration timeslots_rider_notice_collect_by.
-- 1) get_driver_board(): offers + stops gain 'collect_by' = orders.slot_window_start
--    (rider app shows "Be at the store by 12:00"; null for orders without a run).
--    Applied as an in-place patch of the live function body (see migration).
-- 2) timeslot_settings(): adds rider_notice_minutes (default 30).
create or replace function public.timeslot_settings()
 returns jsonb language sql stable security definer set search_path to 'public', 'extensions'
as $function$
  select jsonb_build_object(
    'enabled',        coalesce((v->>'enabled')::boolean, false),
    'cutoff_minutes', coalesce((v->>'cutoff_minutes')::int, 15),
    'grace_minutes',  coalesce((v->>'grace_minutes')::int, 5),
    'days_ahead',     coalesce((v->>'days_ahead')::int, 1),
    'busy_alert_at',  coalesce((v->>'busy_alert_at')::int, 6),
    'rider_notice_minutes', coalesce((v->>'rider_notice_minutes')::int, 30))
  from (select (select s.value from public.site_settings s where s.key = 'timeslots') as v) x;
$function$;
