-- Delivery timeslots: schema (INERT: site_settings.timeslots.enabled = false)

-- Settings helpers -------------------------------------------------------
create or replace function public.timeslot_settings() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'enabled',        coalesce((v->>'enabled')::boolean, false),
    'cutoff_minutes', coalesce((v->>'cutoff_minutes')::int, 15),
    'grace_minutes',  coalesce((v->>'grace_minutes')::int, 5),
    'days_ahead',     coalesce((v->>'days_ahead')::int, 1),
    'busy_alert_at',  coalesce((v->>'busy_alert_at')::int, 6))
  from (select (select s.value from public.site_settings s where s.key = 'timeslots') as v) x;
$$;

create or replace function public.timeslot_enabled() returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((public.timeslot_settings()->>'enabled')::boolean, false);
$$;

create or replace function public.timeslot_cutoff_at(p_window_start timestamptz) returns timestamptz
language sql stable security definer set search_path = public, extensions as $$
  select p_window_start - make_interval(mins => (public.timeslot_settings()->>'cutoff_minutes')::int);
$$;

create or replace function public.timeslot_is_admin() returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

create or replace function public.timeslot_is_staff() returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid())
      or exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.is_active
                   and lower(r.role) in ('logistics','admin'));
$$;

-- Tables -------------------------------------------------------------------
create table if not exists public.delivery_slots (
  id uuid primary key default gen_random_uuid(),
  start_time time not null,
  end_time time not null check (end_time > start_time),
  days smallint[] not null default '{0,1,2,3,4,5,6}' check (array_length(days,1) >= 1),
  active boolean not null default true,
  max_orders integer null check (max_orders is null or max_orders > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Orders columns (before the delete guard references them) -------------------------
alter table public.orders
  add column if not exists slot_id uuid references public.delivery_slots(id),
  add column if not exists slot_run_date date,
  add column if not exists slot_window_start timestamptz,
  add column if not exists slot_window_end timestamptz,
  add column if not exists slot_pay_pressed_at timestamptz,
  add column if not exists slot_needs_attention boolean not null default false;
create index if not exists orders_slot_run_idx on public.orders (slot_id, slot_run_date) where slot_id is not null;

create or replace function public.delivery_slots_guard() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orders o where o.slot_id = old.id and o.payment_status = 'paid'
                 and o.order_status not in ('refunded','cancelled') and o.slot_window_start > now()) then
      raise exception 'SLOT_HAS_PAID_ORDERS';
    end if;
    return old;
  end if;
  if exists (select 1 from public.delivery_slots s
              where s.id is distinct from new.id and s.days && new.days
                and s.start_time < new.end_time and new.start_time < s.end_time) then
    raise exception 'SLOT_OVERLAP';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists delivery_slots_no_overlap on public.delivery_slots;
create trigger delivery_slots_no_overlap before insert or update on public.delivery_slots
  for each row execute function public.delivery_slots_guard();
drop trigger if exists delivery_slots_no_delete_with_orders on public.delivery_slots;
create trigger delivery_slots_no_delete_with_orders before delete on public.delivery_slots
  for each row execute function public.delivery_slots_guard();

create table if not exists public.delivery_slot_exceptions (
  id uuid primary key default gen_random_uuid(),
  run_date date not null,
  slot_id uuid null references public.delivery_slots(id) on delete cascade,
  note text, created_by uuid, created_at timestamptz not null default now(),
  unique nulls not distinct (run_date, slot_id)
);

create table if not exists public.delivery_runs (
  slot_id uuid not null references public.delivery_slots(id),
  run_date date not null,
  summary_claimed_at timestamptz, summary_sent_at timestamptz,
  summary_sent_to uuid[] not null default '{}',
  busy_alert_sent_at timestamptz,
  late_minutes integer, late_sent_at timestamptz,
  primary key (slot_id, run_date)
);

create table if not exists public.delivery_run_moves (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  from_slot_id uuid, from_run_date date, from_window_start timestamptz, from_window_end timestamptz,
  to_slot_id uuid, to_run_date date, to_window_start timestamptz, to_window_end timestamptz,
  reason text not null check (reason in ('late_payment','admin','admin_stop','refund')),
  actor_type text not null check (actor_type in ('system','admin')), actor_id uuid,
  customer_emailed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists delivery_run_moves_order_idx on public.delivery_run_moves(order_id);

create table if not exists public.admin_alert_emails (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  active boolean not null default true,
  created_at timestamptz default now(),
  created_by uuid
);

-- RLS ---------------------------------------------------------------------
alter table public.delivery_slots enable row level security;
alter table public.delivery_slot_exceptions enable row level security;
alter table public.delivery_runs enable row level security;
alter table public.delivery_run_moves enable row level security;
alter table public.admin_alert_emails enable row level security;

create policy delivery_slots_read on public.delivery_slots for select to anon, authenticated using (true);
create policy delivery_slots_admin_ins on public.delivery_slots for insert to authenticated with check (public.timeslot_is_admin());
create policy delivery_slots_admin_upd on public.delivery_slots for update to authenticated using (public.timeslot_is_admin()) with check (public.timeslot_is_admin());
create policy delivery_slots_admin_del on public.delivery_slots for delete to authenticated using (public.timeslot_is_admin());

create policy delivery_slot_exc_read on public.delivery_slot_exceptions for select to anon, authenticated using (true);
create policy delivery_slot_exc_admin_ins on public.delivery_slot_exceptions for insert to authenticated with check (public.timeslot_is_admin());
create policy delivery_slot_exc_admin_upd on public.delivery_slot_exceptions for update to authenticated using (public.timeslot_is_admin()) with check (public.timeslot_is_admin());
create policy delivery_slot_exc_admin_del on public.delivery_slot_exceptions for delete to authenticated using (public.timeslot_is_admin());

create policy delivery_runs_staff_read on public.delivery_runs for select to authenticated using (public.timeslot_is_staff());
create policy delivery_run_moves_staff_read on public.delivery_run_moves for select to authenticated using (public.timeslot_is_staff());
create policy delivery_run_moves_owner_read on public.delivery_run_moves for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id
                   and (o.user_id = auth.uid() or lower(o.customer_email) = public.my_verified_email())));

create policy admin_alert_emails_admin_all on public.admin_alert_emails for all to authenticated
  using (public.timeslot_is_admin()) with check (public.timeslot_is_admin());

revoke all on public.admin_alert_emails from anon;
revoke all on public.delivery_runs, public.delivery_run_moves from anon;

-- Seed (R2) + settings (inert) -------------------------------------------------
insert into public.delivery_slots (start_time, end_time)
select s, s + interval '1 hour' from (values ('12:00'::time),('14:00'),('16:00'),('18:00')) v(s)
where not exists (select 1 from public.delivery_slots);

insert into public.site_settings (key, value)
values ('timeslots', '{"enabled": false, "cutoff_minutes": 15, "grace_minutes": 5, "days_ahead": 1, "busy_alert_at": 6}'::jsonb)
on conflict (key) do nothing;
