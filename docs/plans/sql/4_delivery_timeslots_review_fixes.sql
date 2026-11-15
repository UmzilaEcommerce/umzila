-- Delivery timeslots: final-review fixes (2026-11-15). Still INERT (site_settings.timeslots.enabled = false).

-- 1. SECURITY (pre-existing hole found during the review): the policy "Users can update their own
--    orders" (auth.uid() = user_id, no column limits) let a signed-in buyer PATCH their own order to
--    order_status = 'paid' (trg_sync_payment_status then set payment_status = 'paid', and the
--    delivery / order_items / timeslot triggers fired), or edit total/items/etc. before paying.
--    The guard below is SECURITY INVOKER on purpose: `current_user` is 'anon'/'authenticated' only
--    for a DIRECT PostgREST write; inside a SECURITY DEFINER RPC (claim_order_with_token,
--    claim_my_email_orders, admin_move_order_run, trigger bodies) it is the function owner, so those
--    keep working. Service role / postgres are untouched. Staff (admins, active logistics/admin
--    user_roles — the same people orders_manage_staff lets write) are exempt.
--    Legitimate direct customer writes today (grep of every from('orders').update( in the repo):
--    profile.html -> order_status 'Returned' + notes, order_status 'Delivered';
--    checkout-success.html -> notes; seller-dashboard.html -> order_status
--    'Returned'/'Pending'/'Packaging'/'Fulfilled'/'Delivered' (RLS already limits it to own rows).
create or replace function public.orders_client_update_guard() returns trigger
language plpgsql security invoker set search_path = public, extensions as $$
declare
  v_allowed text[] := array['order_status', 'notes', 'updated_at'];
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;   -- service role, definer RPCs, triggers
  if public.timeslot_is_staff() then return new; end if;                      -- admins / logistics (orders_manage_staff)
  if (to_jsonb(new) - v_allowed) is distinct from (to_jsonb(old) - v_allowed) then
    raise exception using message = 'ORDER_COLUMNS_LOCKED', errcode = '42501',
      hint = 'Customers may only change order_status (fulfilment values) and notes.';
  end if;
  if new.order_status is distinct from old.order_status then
    if coalesce(old.order_status, '') = 'pending_payment'
       or new.order_status is null
       or new.order_status not in ('Pending', 'Packaging', 'Fulfilled', 'Delivered', 'Returned') then
      raise exception using message = 'ORDER_STATUS_LOCKED', errcode = '42501',
        hint = 'Payment states are set by the server only.';
    end if;
  end if;
  return new;
end $$;
-- trigger functions run regardless, but keep the grant explicit (calling it via RPC is impossible anyway)
grant execute on function public.orders_client_update_guard() to anon, authenticated, service_role;
drop trigger if exists orders_client_update_guard on public.orders;
-- name sorts before trg_sync_payment_status so it sees the client's raw NEW row
create trigger orders_client_update_guard before update on public.orders
  for each row execute function public.orders_client_update_guard();

-- Customers could also DELETE any of their own orders (paid ones included). No client code deletes
-- orders (logistics does, as staff, under orders_manage_staff) — limit it to unpaid attempts.
drop policy if exists "Enable delete for users based on user_id" on public.orders;
create policy "Users can delete their own unpaid orders" on public.orders for delete to authenticated
  using (auth.uid() = user_id and coalesce(order_status, '') = 'pending_payment'
         and coalesce(payment_status, 'pending') <> 'paid');

-- 2. Insert guard: a NULL order_status must not slip past the "pending_payment only" test.
create or replace function public.timeslot_guard_insert() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_client boolean := coalesce(auth.role(), '') in ('anon', 'authenticated');
  v_sellers uuid[]; v_r record; v_next record; v_now timestamptz := public.timeslot_now();
begin
  if v_client then
    new.slot_window_start := null; new.slot_window_end := null;
    new.slot_pay_pressed_at := null; new.slot_needs_attention := false;
  end if;
  if not public.timeslot_enabled() or coalesce(new.order_status, '') <> 'pending_payment' then
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
revoke execute on function public.timeslot_guard_insert() from public, anon, authenticated;

-- 3. Internal helpers are only ever called inside SECURITY DEFINER bodies — no need to expose them
--    over /rest/v1/rpc (advisor 0028/0029). timeslot_is_admin/is_staff stay callable by
--    authenticated: the new tables' RLS policies evaluate them as the signed-in user.
revoke execute on function public.timeslot_settings() from public, anon, authenticated;
revoke execute on function public.timeslot_enabled() from public, anon, authenticated;
revoke execute on function public.timeslot_cutoff_at(timestamptz) from public, anon, authenticated;
revoke execute on function public.timeslot_is_admin() from public, anon;
revoke execute on function public.timeslot_is_staff() from public, anon;
grant execute on function public.timeslot_is_admin() to authenticated, service_role;
grant execute on function public.timeslot_is_staff() to authenticated, service_role;
-- the new tables' default anon write grants are already blocked by RLS; drop them anyway
revoke insert, update, delete, truncate, references, trigger on public.delivery_slots, public.delivery_slot_exceptions from anon;
