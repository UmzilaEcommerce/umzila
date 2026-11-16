-- Applied 2026-11-16 as migration fix_orders_payment_columns_guard_definer.
-- orders_payment_columns_guard (added in 8_pp_payment_picker_review_fixes) ran as the
-- caller and called timeslot_is_staff(), which anon may not execute -> EVERY guest
-- order insert failed (PostgREST 401 / 42501, checkout said "Failed to create order").
-- Now SECURITY DEFINER; auth.role()/auth.uid() still read the caller's JWT.
create or replace function public.orders_payment_columns_guard()
 returns trigger language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') and not public.timeslot_is_staff() then
    new.payment_option_key := null;
    new.payment_method_code := null;
    new.payment_flag := null;
    new.payment_flag_attempt_id := null;
    new.payment_flag_resolved_at := null;
  end if;
  return new;
end $function$;
revoke execute on function public.orders_payment_columns_guard() from public, anon, authenticated;
