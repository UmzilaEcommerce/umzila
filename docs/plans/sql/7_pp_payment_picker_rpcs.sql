-- Payment method picker — RPCs (Workstream A). Applied as migration pp_payment_picker_rpcs.
-- All SECURITY DEFINER, search_path pinned, EXECUTE revoked from PUBLIC first (the PUBLIC grant
-- is separate from anon/authenticated — see memory "Postgres PUBLIC grant revoke gotcha").

-- ---------- customer-facing ----------
create or replace function public.my_last_payment_option()
 returns text language sql stable security definer set search_path to 'public', 'extensions'
as $function$
  select a.option_key
    from public.payment_attempts a
    join public.orders o on o.id = a.order_id
   where a.status = 'paid' and a.option_key <> 'legacy'
     and auth.uid() is not null and o.user_id = auth.uid()
   order by coalesce(a.ended_at, a.started_at) desc
   limit 1;
$function$;

create or replace function public.payment_attempt_cancelled(p_attempt uuid, p_m_payment_id text)
 returns boolean language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
declare v_n int;
begin
  if p_attempt is null or coalesce(p_m_payment_id, '') = '' then return false; end if;
  update public.payment_attempts
     set status = 'cancelled', ended_at = now()
   where id = p_attempt and m_payment_id = p_m_payment_id and status = 'started';
  get diagnostics v_n = row_count;
  return v_n > 0;
end $function$;

-- ---------- server only (begin-payment.js, service role) ----------
-- P18: re-run the delivery-run rule for a reused pending order. Same DETAIL shape as
-- trg_timeslot_guard_insert's TIMESLOT_CLOSED.
create or replace function public.payment_order_recheck(p_order_id uuid)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions'
as $function$
declare
  o record; v_sellers uuid[]; v_r record; v_next record; v_now timestamptz := public.timeslot_now();
begin
  select id, order_status, payment_status, slot_id, slot_run_date, items, destination_geo
    into o from public.orders where id = p_order_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if coalesce(o.order_status, '') <> 'pending_payment' or coalesce(o.payment_status, '') = 'paid' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  if not public.timeslot_enabled() or o.slot_id is null or o.slot_run_date is null then
    return jsonb_build_object('ok', true);
  end if;
  v_sellers := public.timeslot_goods_sellers(o.items);
  if coalesce(array_length(v_sellers, 1), 0) = 0 then return jsonb_build_object('ok', true); end if;
  select * into v_r from public.timeslot_open_runs(v_sellers, v_now) r
   where r.slot_id = o.slot_id and r.run_date = o.slot_run_date;
  if found and v_r.state = 'open' then return jsonb_build_object('ok', true); end if;
  select * into v_next from public.timeslot_open_runs(v_sellers, v_now) r where r.state = 'open' order by r.window_start limit 1;
  return jsonb_build_object('ok', false,
    'reason', coalesce(v_r.state, 'unknown'), 'closed_at', v_r.cutoff_at,
    'window_start', v_r.window_start, 'window_end', v_r.window_end,
    'next_open', case when v_next.slot_id is null then null else jsonb_build_object(
       'slot_id', v_next.slot_id, 'run_date', v_next.run_date, 'window_start', v_next.window_start,
       'window_end', v_next.window_end, 'cutoff_at', v_next.cutoff_at) end);
end $function$;

-- Records one Pay press atomically: locks the order row so two quick taps can't both pass the
-- 8-second double-tap rule, inserts the attempt, and stamps the order with the option.
-- Returns { ok:true, attempt_id } or { ok:false, code:'ATTEMPT_IN_FLIGHT'|'ORDER_CLOSED'|'NOT_FOUND' }.
create or replace function public.payment_attempt_start(
  p_order_id uuid, p_option_key text, p_code text, p_kind text,
  p_payment_method_id uuid, p_amount numeric, p_device text)
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
declare o record; v_id uuid;
begin
  select id, m_payment_id, user_id, order_status, payment_status into o
    from public.orders where id = p_order_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if coalesce(o.order_status, '') <> 'pending_payment' or coalesce(o.payment_status, '') = 'paid' then
    return jsonb_build_object('ok', false, 'code', 'ORDER_CLOSED');
  end if;
  if exists (select 1 from public.payment_attempts a where a.order_id = p_order_id and a.status = 'started'
               and a.started_at > now() - interval '8 seconds') then
    return jsonb_build_object('ok', false, 'code', 'ATTEMPT_IN_FLIGHT');
  end if;
  insert into public.payment_attempts (order_id, m_payment_id, user_id, option_key, payment_method_code, kind,
                                       payment_method_id, amount, device)
  values (p_order_id, o.m_payment_id, o.user_id, p_option_key, p_code, p_kind, p_payment_method_id,
          coalesce(p_amount, 0),
          case when p_device in ('apple','android','samsung','desktop','other') then p_device else null end)
  returning id into v_id;
  update public.orders set payment_option_key = p_option_key, payment_method_code = p_code where id = p_order_id;
  return jsonb_build_object('ok', true, 'attempt_id', v_id);
end $function$;

-- ---------- admin ----------
create or replace function public.payment_option_name(p_key text)
 returns text language sql stable security definer set search_path to 'public', 'extensions'
as $function$
  select coalesce(
    (select o->>'name' from public.site_settings s, jsonb_array_elements(coalesce(s.value->'options','[]'::jsonb)) o
      where s.key = 'payments' and o->>'key' = p_key limit 1),
    case p_key when 'legacy' then 'Before the picker' else p_key end);
$function$;

create or replace function public.admin_payment_report(p_from date, p_to date)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions'
as $function$
declare v_from timestamptz; v_to timestamptz; v_rows jsonb; v_tot jsonb;
begin
  if not public.timeslot_is_admin() then raise exception using message = 'ADMIN_ONLY', errcode = '42501'; end if;
  v_from := (coalesce(p_from, current_date)::timestamp) at time zone 'Africa/Johannesburg';
  v_to   := ((coalesce(p_to, current_date) + 1)::timestamp) at time zone 'Africa/Johannesburg';
  with a as (
    select option_key, status, coalesce(amount_gross, amount) as gross, coalesce(amount_fee, 0) as fee
      from public.payment_attempts
     where started_at >= v_from and started_at < v_to and status <> 'paid_twice' and status <> 'refunded'
  ), g as (
    select option_key, count(*)::int as started, count(*) filter (where status = 'paid')::int as paid,
           coalesce(sum(gross) filter (where status = 'paid'), 0) as total_paid,
           coalesce(sum(fee) filter (where status = 'paid'), 0) as total_fees
      from a group by option_key
  ), pos as (
    select o->>'key' as k, (o->>'position')::numeric as p
      from public.site_settings s, jsonb_array_elements(coalesce(s.value->'options','[]'::jsonb)) o where s.key = 'payments'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'option_key', g.option_key, 'name', public.payment_option_name(g.option_key),
           'started', g.started, 'paid', g.paid,
           'share', case when g.started = 0 then 0 else round(g.paid::numeric / g.started, 4) end,
           'total_paid', round(g.total_paid, 2), 'total_fees', round(g.total_fees, 2))
         order by coalesce(pos.p, 999), g.option_key), '[]'::jsonb),
         jsonb_build_object('option_key', 'totals', 'name', 'Total',
           'started', coalesce(sum(g.started), 0), 'paid', coalesce(sum(g.paid), 0),
           'share', case when coalesce(sum(g.started), 0) = 0 then 0 else round(sum(g.paid)::numeric / sum(g.started), 4) end,
           'total_paid', round(coalesce(sum(g.total_paid), 0), 2), 'total_fees', round(coalesce(sum(g.total_fees), 0), 2))
    into v_rows, v_tot
    from g left join pos on pos.k = g.option_key;
  return jsonb_build_object('from', p_from, 'to', p_to, 'rows', v_rows, 'totals', v_tot);
end $function$;

create or replace function public.admin_payment_flagged()
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions'
as $function$
begin
  if not public.timeslot_is_admin() then raise exception using message = 'ADMIN_ONLY', errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'order_id', o.id, 'order_number', o.order_number, 'm_payment_id', o.m_payment_id,
      'customer_name', o.customer_name, 'customer_email', o.customer_email, 'total', o.total,
      'paid_at', o.paid_at, 'flag', o.payment_flag, 'resolved_at', o.payment_flag_resolved_at,
      'first', jsonb_build_object('pf_payment_id', o.pf_payment_id,
                 'amount_gross', nullif(o.pf_response->>'amount_gross', '')::numeric,
                 'amount_fee', abs(nullif(o.pf_response->>'amount_fee', '')::numeric),
                 'option_key', o.payment_option_key),
      'extra', case when a.id is null then null else jsonb_build_object('attempt_id', a.id, 'pf_payment_id', a.pf_payment_id,
                 'amount_gross', a.amount_gross, 'amount_fee', a.amount_fee, 'option_key', a.option_key,
                 'started_at', a.started_at, 'status', a.status, 'note', a.note) end)
      order by (o.payment_flag_resolved_at is not null), o.paid_at desc nulls last)
      from public.orders o
      left join public.payment_attempts a on a.id = o.payment_flag_attempt_id
     where o.payment_flag is not null), '[]'::jsonb);
end $function$;

create or replace function public.admin_payment_resolve_flag(p_order_id uuid, p_note text)
 returns void language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
declare o record;
begin
  if not public.timeslot_is_admin() then raise exception using message = 'ADMIN_ONLY', errcode = '42501'; end if;
  select id, payment_flag, payment_flag_attempt_id into o from public.orders where id = p_order_id for update;
  if not found or o.payment_flag is null then raise exception using message = 'NOT_FLAGGED', errcode = 'P0002'; end if;
  update public.orders set payment_flag_resolved_at = now() where id = p_order_id;
  if o.payment_flag_attempt_id is not null then
    -- 'refunded' only for the EXTRA payment of a paid-twice order; an amount-mismatch flag points
    -- at the real (kept) payment, which just gets the note.
    update public.payment_attempts
       set status = case when o.payment_flag = 'paid_twice' then 'refunded' else status end,
           note = nullif(left(btrim(coalesce(p_note, '')), 500), '')
     where id = o.payment_flag_attempt_id;
  end if;
end $function$;

create or replace function public.admin_paid_orders(p_from date, p_to date, p_limit int)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions'
as $function$
declare v_from timestamptz; v_to timestamptz;
begin
  if not public.timeslot_is_admin() then raise exception using message = 'ADMIN_ONLY', errcode = '42501'; end if;
  v_from := (coalesce(p_from, current_date)::timestamp) at time zone 'Africa/Johannesburg';
  v_to   := ((coalesce(p_to, current_date) + 1)::timestamp) at time zone 'Africa/Johannesburg';
  return coalesce((
    select jsonb_agg(x.j order by x.paid_at desc) from (
      select o.paid_at, jsonb_build_object(
        'order_id', o.id, 'order_number', o.order_number, 'paid_at', o.paid_at, 'customer_name', o.customer_name,
        'total', o.total, 'option_key', o.payment_option_key, 'payment_method_code', o.payment_method_code,
        'pf_payment_id', o.pf_payment_id,
        'amount_gross', nullif(o.pf_response->>'amount_gross', '')::numeric,
        'amount_fee', abs(nullif(o.pf_response->>'amount_fee', '')::numeric),
        'amount_net', nullif(o.pf_response->>'amount_net', '')::numeric,
        'flag', o.payment_flag) as j
        from public.orders o
       where o.payment_status = 'paid' and o.paid_at >= v_from and o.paid_at < v_to
       order by o.paid_at desc
       limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb);
end $function$;

create or replace function public.admin_payment_attempts(p_order_id uuid)
 returns jsonb language plpgsql stable security definer set search_path to 'public', 'extensions'
as $function$
begin
  if not public.timeslot_is_admin() then raise exception using message = 'ADMIN_ONLY', errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'option_key', a.option_key, 'name', public.payment_option_name(a.option_key),
      'payment_method_code', a.payment_method_code, 'kind', a.kind, 'status', a.status,
      'amount', a.amount, 'started_at', a.started_at, 'ended_at', a.ended_at, 'pf_payment_id', a.pf_payment_id,
      'amount_gross', a.amount_gross, 'amount_fee', a.amount_fee, 'amount_net', a.amount_net,
      'device', a.device, 'note', a.note) order by a.started_at)
      from public.payment_attempts a where a.order_id = p_order_id), '[]'::jsonb);
end $function$;

-- ---------- grants ----------
revoke all on function public.my_last_payment_option() from public, anon, authenticated;
revoke all on function public.payment_attempt_cancelled(uuid, text) from public, anon, authenticated;
revoke all on function public.payment_order_recheck(uuid) from public, anon, authenticated;
revoke all on function public.payment_attempt_start(uuid, text, text, text, uuid, numeric, text) from public, anon, authenticated;
revoke all on function public.payment_option_name(text) from public, anon, authenticated;
revoke all on function public.admin_payment_report(date, date) from public, anon, authenticated;
revoke all on function public.admin_payment_flagged() from public, anon, authenticated;
revoke all on function public.admin_payment_resolve_flag(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_paid_orders(date, date, int) from public, anon, authenticated;
revoke all on function public.admin_payment_attempts(uuid) from public, anon, authenticated;

grant execute on function public.my_last_payment_option() to authenticated;
grant execute on function public.payment_attempt_cancelled(uuid, text) to anon, authenticated;
grant execute on function public.admin_payment_report(date, date) to authenticated;
grant execute on function public.admin_payment_flagged() to authenticated;
grant execute on function public.admin_payment_resolve_flag(uuid, text) to authenticated;
grant execute on function public.admin_paid_orders(date, date, int) to authenticated;
grant execute on function public.admin_payment_attempts(uuid) to authenticated;
grant execute on function public.payment_order_recheck(uuid) to service_role;
grant execute on function public.payment_attempt_start(uuid, text, text, text, uuid, numeric, text) to service_role;
grant execute on function public.payment_option_name(text) to service_role;
