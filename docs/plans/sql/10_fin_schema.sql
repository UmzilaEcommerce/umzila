-- 10_fin_schema.sql — Finances workstream A, part 1: schema + settings (applied 2026-11-16 as migration fin_schema)
-- * public.finance_entries: the ONE new table (manual expenses / other income / per-order adjustments).
-- * site_settings key 'finance' (admin-only read; validated by site_settings_finance_validate).
--   Holds the assumptions AND store_prices (per product / per variant "what the store is owed per unit";
--   for the house seller "Umzila Drinks" the same number is Umzila's cost of goods).
--   Why site_settings and not products.metadata / a new column: products + metadata are public-readable
--   (get-catalog, store pages) and seller-editable, so a store price there would show every customer the
--   mark-up and let sellers change what they are owed. site_settings 'finance' is admin-only (policy below).
-- Writes to finance_entries ONLY through the fin_* SECURITY DEFINER RPCs (11_fin_rpcs.sql).

create table if not exists public.finance_entries (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('expense','income','adjustment')),
  category         text not null default '' check (length(category) <= 60),
  description      text not null default '' check (length(description) <= 500),
  amount           numeric(12,2) not null default 0 check (amount >= 0),
  occurred_on      date not null,
  recurring        text not null default 'none' check (recurring in ('none','monthly')),
  recur_until      date,
  order_id         uuid references public.orders(id) on delete set null,
  seller_id        uuid references public.sellers(id) on delete set null,
  adjustment_type  text check (adjustment_type in
                     ('exclude_test','refund','seller_payout_override','rider_pay_override',
                      'payment_fee_override','payment_method_set','cogs_override','note')),
  adjustment_value numeric(12,2),
  adjustment_text  text check (length(adjustment_text) <= 60),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  voided_at        timestamptz,
  voided_by        uuid references auth.users(id) on delete set null,
  void_reason      text check (length(void_reason) <= 300),
  constraint finance_entries_adjustment_shape check (
    (kind = 'adjustment' and adjustment_type is not null and order_id is not null and recurring = 'none')
    or (kind <> 'adjustment' and adjustment_type is null)),
  constraint finance_entries_recur_until check (recur_until is null or (recurring = 'monthly' and recur_until >= occurred_on))
);
create index if not exists finance_entries_occurred_idx on public.finance_entries (occurred_on) where voided_at is null;
create index if not exists finance_entries_order_idx on public.finance_entries (order_id) where voided_at is null;
-- one live override of each kind per order (per order+store for payout overrides); notes unlimited
create unique index if not exists finance_entries_one_adjustment
  on public.finance_entries (order_id, adjustment_type, coalesce(seller_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where voided_at is null and kind = 'adjustment' and adjustment_type <> 'note';

alter table public.finance_entries enable row level security;
drop policy if exists finance_entries_admin_read on public.finance_entries;
create policy finance_entries_admin_read on public.finance_entries for select to authenticated using (public.timeslot_is_admin());
revoke all on public.finance_entries from public, anon, authenticated;
grant select on public.finance_entries to authenticated;   -- rows still filtered by the admin-only policy

-- site_settings: 'finance' is NOT public (mark-ups, store prices, cost of goods). Admins still read it
-- through the existing FOR ALL policy site_settings_admin_write.
drop policy if exists site_settings_select_all on public.site_settings;
create policy site_settings_select_all on public.site_settings for select using (key <> 'finance');

create or replace function public.site_settings_finance_validate()
 returns trigger language plpgsql set search_path to 'public', 'extensions'
as $function$
declare
  v jsonb := new.value; k text; r jsonb; x jsonb;
  fail text := null;
begin
  if new.key <> 'finance' then return new; end if;
  if jsonb_typeof(v) <> 'object' then fail := 'value must be an object'; end if;
  if fail is null and v ? 'default_markup_percent' and (jsonb_typeof(v->'default_markup_percent') <> 'number'
     or (v->>'default_markup_percent')::numeric < 0 or (v->>'default_markup_percent')::numeric > 100) then
    fail := 'default_markup_percent must be 0-100'; end if;
  if fail is null and v ? 'vat_percent' and (jsonb_typeof(v->'vat_percent') <> 'number'
     or (v->>'vat_percent')::numeric < 0 or (v->>'vat_percent')::numeric > 30) then
    fail := 'vat_percent must be 0-30'; end if;
  if fail is null and v ? 'count_rider_pay_as_cost' and jsonb_typeof(v->'count_rider_pay_as_cost') <> 'boolean' then
    fail := 'count_rider_pay_as_cost must be true or false'; end if;
  if fail is null and coalesce(v->>'tips_go_to', 'umzila') not in ('umzila','rider') then
    fail := 'tips_go_to must be umzila or rider'; end if;
  if fail is null and coalesce(v->>'seller_codes_funded_by', 'seller') not in ('seller','umzila') then
    fail := 'seller_codes_funded_by must be seller or umzila'; end if;
  if fail is null and coalesce(v->>'manual_discount_funded_by', 'umzila') not in ('seller','umzila') then
    fail := 'manual_discount_funded_by must be seller or umzila'; end if;
  if fail is null and jsonb_typeof(coalesce(v->'fee_rates', '{}'::jsonb)) <> 'object' then fail := 'fee_rates must be an object'; end if;
  if fail is null then
    for k, r in select * from jsonb_each(coalesce(v->'fee_rates', '{}'::jsonb)) loop
      if k !~ '^[a-z_]{2,20}$' then fail := 'fee_rates key must be 2-20 letters a-z or _: ' || k; exit; end if;
      if jsonb_typeof(r) <> 'object' then fail := 'fee_rates.' || k || ' must be an object'; exit; end if;
      if length(btrim(coalesce(r->>'name', ''))) = 0 or length(r->>'name') > 40 then fail := 'fee_rates.' || k || '.name required (max 40)'; exit; end if;
      if jsonb_typeof(coalesce(r->'pct', '0'::jsonb)) <> 'number' or coalesce((r->>'pct')::numeric, 0) not between 0 and 20 then fail := 'fee_rates.' || k || '.pct must be 0-20'; exit; end if;
      if jsonb_typeof(coalesce(r->'fixed', '0'::jsonb)) <> 'number' or coalesce((r->>'fixed')::numeric, 0) not between 0 and 50 then fail := 'fee_rates.' || k || '.fixed must be 0-50'; exit; end if;
      if jsonb_typeof(coalesce(r->'min', '0'::jsonb)) <> 'number' or coalesce((r->>'min')::numeric, 0) not between 0 and 50 then fail := 'fee_rates.' || k || '.min must be 0-50'; exit; end if;
      if r ? 'vat' and jsonb_typeof(r->'vat') <> 'boolean' then fail := 'fee_rates.' || k || '.vat must be true or false'; exit; end if;
    end loop;
  end if;
  if fail is null and not (coalesce(v->'fee_rates', '{}'::jsonb) ? 'unknown') then fail := 'fee_rates.unknown is required (used when the method is not known)'; end if;
  if fail is null and jsonb_typeof(coalesce(v->'store_prices', '{}'::jsonb)) <> 'object' then fail := 'store_prices must be an object'; end if;
  if fail is null then
    for k, x in select * from jsonb_each(coalesce(v->'store_prices', '{}'::jsonb)) loop
      if k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$' then
        fail := 'store_prices key must be <product_id> or <product_id>:<variant_id>'; exit; end if;
      if jsonb_typeof(x) <> 'number' or x::text::numeric < 0 or x::text::numeric > 100000 then
        fail := 'store_prices values must be numbers 0-100000'; exit; end if;
    end loop;
  end if;
  if fail is null then
    foreach k in array array['expense_categories','income_categories','test_emails'] loop
      if v ? k and (jsonb_typeof(v->k) <> 'array'
         or exists (select 1 from jsonb_array_elements(v->k) e where jsonb_typeof(e) <> 'string' or length(e #>> '{}') not between 1 and 60)) then
        fail := k || ' must be a list of short texts'; exit; end if;
    end loop;
  end if;
  if fail is null and v ? 'rider_pay_estimate' then
    r := v->'rider_pay_estimate';
    if jsonb_typeof(r) <> 'object' or exists (select 1 from jsonb_each(r) e where jsonb_typeof(e.value) <> 'number' or (e.value #>> '{}')::numeric < 0 or (e.value #>> '{}')::numeric > 1000) then
      fail := 'rider_pay_estimate values must be numbers 0-1000'; end if;
  end if;
  if fail is not null then
    raise exception using message = 'FINANCE_INVALID', errcode = '22023', detail = fail;
  end if;
  return new;
end $function$;
revoke execute on function public.site_settings_finance_validate() from public, anon, authenticated;
drop trigger if exists site_settings_finance_validate on public.site_settings;
create trigger site_settings_finance_validate before insert or update on public.site_settings
  for each row when (new.key = 'finance') execute function public.site_settings_finance_validate();

-- Seed (founder answers 2026-11-16). House drinks cost of goods go in store_prices too
-- (small Coke/Fanta/Sprite R15, 1.5 L bottles R18, Appletiser R22, Liqui-Fruit R18) — matched by name.
insert into public.site_settings (key, value, updated_at)
select 'finance', jsonb_build_object(
  'default_markup_percent', 9,
  'vat_percent', 15,
  'seller_codes_funded_by', 'seller',
  'manual_discount_funded_by', 'umzila',
  'tips_go_to', 'umzila',
  'count_rider_pay_as_cost', false,
  'fee_rates', jsonb_build_object(
    'cc',  jsonb_build_object('name','Card','pct',3.2,'fixed',2.00,'min',0,'vat',true),
    'dc',  jsonb_build_object('name','Debit card','pct',3.2,'fixed',2.00,'min',0,'vat',true),
    'ap',  jsonb_build_object('name','Apple Pay','pct',3.2,'fixed',2.00,'min',0,'vat',true),
    'gp',  jsonb_build_object('name','Google Pay','pct',3.2,'fixed',2.00,'min',0,'vat',true),
    'sp',  jsonb_build_object('name','Samsung Pay','pct',3.2,'fixed',2.00,'min',0,'vat',true),
    'cp',  jsonb_build_object('name','Capitec Pay','pct',2.0,'fixed',0,'min',2.00,'vat',true),
    'ef',  jsonb_build_object('name','Instant EFT','pct',2.0,'fixed',0,'min',2.00,'vat',true),
    'cash',jsonb_build_object('name','Cash','pct',0,'fixed',0,'min',0,'vat',false),
    'pos', jsonb_build_object('name','Card machine','pct',0,'fixed',0,'min',0,'vat',false),
    'eft_manual', jsonb_build_object('name','EFT (manual)','pct',0,'fixed',0,'min',0,'vat',false),
    'unknown', jsonb_build_object('name','PayFast (method unknown)','pct',3.2,'fixed',2.00,'min',0,'vat',true)),
  'rider_pay_estimate', jsonb_build_object('min',34,'included_km',3,'per_km',0.40,'max',45,'fallback',39,'per_extra_store',3),
  'expense_categories', jsonb_build_array('Rider wages','Fuel','PayFast payout fee','Marketing','Printing','Packaging','Software','Bank charges','Salaries','Other'),
  'income_categories', jsonb_build_array('Prize','Grant','Sponsorship','Other'),
  'test_emails', jsonb_build_array('nontandod23@gmail.com','ntandob38@gmail.com'),
  'store_prices', coalesce((
    select jsonb_object_agg(p.id::text, c.cost)
      from public.products p join public.sellers s on s.id = p.seller_id and s.is_house
      cross join lateral (select case
        when p.name ilike 'appletiser%' then 22
        when p.name ilike 'liqui%fruit%' then 18
        when p.name ~* '(coca|fanta|sprite).*1\.5 ?l' then 18
        when p.name ~* '(coca|fanta|sprite).*(440|500|330|300) ?ml' then 15
      end::numeric as cost) c
     where c.cost is not null), '{}'::jsonb)
), now()
where not exists (select 1 from public.site_settings where key = 'finance');
