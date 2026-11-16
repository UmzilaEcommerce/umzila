-- Payment method picker — final-review fixes (2026-11-15). Applied as migration pp_payment_picker_review_fixes.
-- Still inert while site_settings 'payments'.enabled = false.
--
-- 1) The payment columns on orders are server-owned. orders_client_update_guard already blocks
--    browser UPDATEs, but the anon/authenticated INSERT policies had no column limits, so a
--    buyer could create a pending order that already carried payment_flag = 'paid_twice' (and
--    so appear in Admin → Payments → Flagged orders) or a made-up payment_option_key. Null them
--    on every client insert, the same way timeslot_guard_insert nulls the slot columns.
create or replace function public.orders_payment_columns_guard()
 returns trigger language plpgsql set search_path to 'public', 'extensions'
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
revoke all on function public.orders_payment_columns_guard() from public, anon, authenticated;
drop trigger if exists orders_payment_columns_guard on public.orders;
create trigger orders_payment_columns_guard before insert on public.orders
  for each row execute function public.orders_payment_columns_guard();
