-- Payment method picker — schema (Workstream A). Applied 2026-11-15 as migration pp_payment_picker_schema.
-- Everything here is inert until site_settings 'payments'.enabled = true (seeded false).
--   1) site_settings key 'payments' (master switch + options list) + a validation trigger
--   2) public.payment_attempts (one row per Pay press) — staff read only, writes = service role / definer RPCs
--   3) orders: payment_option_key, payment_method_code, payment_flag, payment_flag_attempt_id, payment_flag_resolved_at

-- ---------- 2) payment_attempts ----------
create table if not exists public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  m_payment_id text not null,
  user_id uuid,
  option_key text not null,
  payment_method_code text,
  kind text not null check (kind in ('redirect','saved_card','zero')),
  payment_method_id uuid references public.payment_methods(id) on delete set null,
  amount numeric not null,
  status text not null default 'started'
    check (status in ('started','paid','cancelled','failed','no_answer','paid_twice','refunded')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  pf_payment_id text,
  amount_gross numeric, amount_fee numeric, amount_net numeric,
  pf_response jsonb,
  device text check (device is null or device in ('apple','android','samsung','desktop','other')),
  note text
);
create index if not exists payment_attempts_order_idx  on public.payment_attempts(order_id, started_at desc);
create index if not exists payment_attempts_open_idx   on public.payment_attempts(started_at) where status = 'started';
create index if not exists payment_attempts_report_idx on public.payment_attempts(option_key, started_at);
create index if not exists payment_attempts_pm_idx     on public.payment_attempts(payment_method_id) where payment_method_id is not null;

alter table public.payment_attempts enable row level security;
revoke all on public.payment_attempts from public, anon, authenticated;
grant select on public.payment_attempts to authenticated;
drop policy if exists payment_attempts_staff_read on public.payment_attempts;
create policy payment_attempts_staff_read on public.payment_attempts for select to authenticated using (
  exists (select 1 from public.admins a where a.user_id = auth.uid())
  or exists (select 1 from public.user_roles r where r.user_id = auth.uid() and r.role = 'logistics' and r.is_active = true)
);

-- ---------- 3) orders columns ----------
alter table public.orders add column if not exists payment_option_key text;
alter table public.orders add column if not exists payment_method_code text;
alter table public.orders add column if not exists payment_flag text;
alter table public.orders add column if not exists payment_flag_attempt_id uuid references public.payment_attempts(id) on delete set null;
alter table public.orders add column if not exists payment_flag_resolved_at timestamptz;
do $$ begin
  alter table public.orders add constraint orders_payment_flag_check check (payment_flag is null or payment_flag in ('paid_twice','amount_mismatch'));
exception when duplicate_object then null; end $$;
create index if not exists orders_payment_flag_idx on public.orders(payment_flag_resolved_at) where payment_flag is not null;

-- ---------- 1) site_settings 'payments' ----------
-- Server-side validation of what the admin screen writes (RLS already limits writes to admins).
create or replace function public.site_settings_payments_validate()
 returns trigger language plpgsql set search_path to 'public', 'extensions'
as $function$
declare
  v jsonb := new.value; o jsonb; v_keys text[] := '{}'; v_null int := 0;
  v_codes text[] := array['cc','dc','cp','ef','ap','gp','sp','ss','zp','mp','mc','mt','pf','ab','nd','rc','mu','sc'];
begin
  if new.key <> 'payments' then return new; end if;
  if jsonb_typeof(v) <> 'object' then raise exception using message = 'PAYMENTS_INVALID', errcode = '22023', detail = 'value must be an object'; end if;
  if v ? 'enabled' and jsonb_typeof(v->'enabled') <> 'boolean' then
    raise exception using message = 'PAYMENTS_INVALID', errcode = '22023', detail = 'enabled must be true or false'; end if;
  if v ? 'itn_validate' and jsonb_typeof(v->'itn_validate') <> 'boolean' then
    raise exception using message = 'PAYMENTS_INVALID', errcode = '22023', detail = 'itn_validate must be true or false'; end if;
  if v ? 'no_answer_minutes' and (jsonb_typeof(v->'no_answer_minutes') <> 'number'
     or (v->>'no_answer_minutes')::numeric < 10 or (v->>'no_answer_minutes')::numeric > 120) then
    raise exception using message = 'PAYMENTS_INVALID', errcode = '22023', detail = 'no_answer_minutes must be 10-120'; end if;
  if jsonb_typeof(coalesce(v->'options', '[]'::jsonb)) <> 'array' then
    raise exception using message = 'PAYMENTS_INVALID', errcode = '22023', detail = 'options must be a list'; end if;
  for o in select * from jsonb_array_elements(coalesce(v->'options', '[]'::jsonb)) loop
    if coalesce(o->>'key', '') !~ '^[a-z_]{2,30}$' then
      raise exception using message = 'PAYMENTS_INVALID', errcode = '22023', detail = 'option key must be 2-30 letters a-z or _'; end if;
    if (o->>'key') = any (v_keys) then
      raise exception using message = 'PAYMENTS_INVALID', errcode = '22023', detail = 'option key used twice: ' || (o->>'key'); end if;
    v_keys := v_keys || (o->>'key');
    if length(btrim(coalesce(o->>'name', ''))) = 0 or length(o->>'name') > 60 then
      raise exception using message = 'PAYMENTS_INVALID', errcode = '22023', detail = 'option name required (max 60)'; end if;
    if length(coalesce(o->>'description', '')) > 140 then
      raise exception using message = 'PAYMENTS_INVALID', errcode = '22023', detail = 'description too long (max 140)'; end if;
    if o->'code' is null or jsonb_typeof(o->'code') = 'null' then v_null := v_null + 1;
    elsif not ((o->>'code') = any (v_codes)) then
      raise exception using message = 'PAYMENTS_INVALID', errcode = '22023', detail = 'unknown PayFast code: ' || (o->>'code'); end if;
    if o ? 'device' and jsonb_typeof(o->'device') <> 'null' and not ((o->>'device') in ('apple','android','samsung')) then
      raise exception using message = 'PAYMENTS_INVALID', errcode = '22023', detail = 'device must be empty, apple, android or samsung'; end if;
    if o ? 'active' and jsonb_typeof(o->'active') <> 'boolean' then
      raise exception using message = 'PAYMENTS_INVALID', errcode = '22023', detail = 'active must be true or false'; end if;
  end loop;
  if v_null > 1 then
    raise exception using message = 'PAYMENTS_INVALID', errcode = '22023', detail = 'only one catch-all option (no PayFast code) is allowed'; end if;
  return new;
end $function$;
revoke all on function public.site_settings_payments_validate() from public, anon, authenticated;
drop trigger if exists site_settings_payments_validate on public.site_settings;
create trigger site_settings_payments_validate before insert or update on public.site_settings
  for each row when (new.key = 'payments') execute function public.site_settings_payments_validate();

insert into public.site_settings (key, value, updated_at) values ('payments', jsonb_build_object(
  'enabled', false,
  'no_answer_minutes', 30,
  'itn_validate', true,
  'options', jsonb_build_array(
    jsonb_build_object('key','card',       'name','Card',             'description','Visa or Mastercard — saved cards pay in one tap', 'code','cc', 'active',true,  'position',1, 'device',null),
    jsonb_build_object('key','capitec',    'name','Capitec Pay',      'description','Approve in your Capitec app',                    'code','cp', 'active',true,  'position',2, 'device',null),
    jsonb_build_object('key','eft',        'name','Instant EFT',      'description','Pay from your bank account',                     'code','ef', 'active',true,  'position',3, 'device',null),
    jsonb_build_object('key','apple_pay',  'name','Apple Pay',        'description','Pay with Face ID or Touch ID',                   'code','ap', 'active',true,  'position',4, 'device','apple'),
    jsonb_build_object('key','google_pay', 'name','Google Pay',       'description','Pay with the cards in your Google account',      'code','gp', 'active',true,  'position',5, 'device','android'),
    jsonb_build_object('key','samsung_pay','name','Samsung Pay',      'description','Pay with Samsung Wallet',                        'code','sp', 'active',false, 'position',6, 'device','samsung'),
    jsonb_build_object('key','more',       'name','More ways to pay', 'description','Other methods on PayFast',                       'code',null, 'active',true,  'position',7, 'device',null)
  )), now())
on conflict (key) do nothing;
