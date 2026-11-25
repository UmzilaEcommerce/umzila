-- Umzila's own stores (founder 2026-11-25: "Lumina is Umzila's store, all its profit is Umzila's").
-- site_settings 'finance' → own_store_ids = [seller uuid, …] (admin → Finances → Assumptions).
-- The finance engine treats those stores like the house drinks: nothing is owed to the store, the
-- store-price map holds the COST of the stock, and the whole margin is Umzila's. Unlike drinks, an
-- own-store line with no cost typed in gets an ESTIMATED cost (price ÷ (1 + default mark-up)) and is
-- flagged, so the profit is never overstated by counting the full sale price as margin.

create or replace function public.fin__own_store_ids()
 returns uuid[] language sql stable security definer set search_path to 'public', 'extensions'
as $$
  select coalesce(array(
    select x::uuid from jsonb_array_elements_text(
      case when jsonb_typeof(public.fin__settings()->'own_store_ids') = 'array' then public.fin__settings()->'own_store_ids' else '[]'::jsonb end) x
     where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '{}'::uuid[]);
$$;
revoke all on function public.fin__own_store_ids() from public, anon, authenticated;

do $mig$
declare d text; n text;
begin
  -- 1. the engine
  d := pg_get_functiondef('public.fin__order_lines'::regproc);
  n := replace(d, '  v_out jsonb;
begin', '  v_own uuid[] := public.fin__own_store_ids();
  v_out jsonb;
begin');
  n := replace(n, 'coalesce(s.is_house, false) as is_house,', '(coalesce(s.is_house, false) or li.seller_id = any(v_own)) as is_house, (li.seller_id = any(v_own) and not coalesce(s.is_house, false)) as own_store,');
  n := replace(n, 'case when l2.is_house and l2.sp is not null then round(l2.sp * l2.qty, 2) else 0::numeric end as cogs,
      (l2.is_house and l2.sp is null) as cogs_missing',
    'case when l2.is_house and l2.sp is not null then round(l2.sp * l2.qty, 2)
           when l2.own_store then round(l2.sub / (1 + v_markup / 100), 2) -- own store, no cost typed in: estimate
           else 0::numeric end as cogs,
      (l2.is_house and l2.sp is null) as cogs_missing');
  if n = d or n !~ 'v_own uuid' or n !~ 'when l2.own_store' then raise exception 'fin__order_lines anchors not found'; end if;
  execute n;

  -- 2. store-price list: own-store products are listed as "cost of goods" rows
  d := pg_get_functiondef('public.fin_store_prices_list'::regproc);
  n := replace(d, '''is_house'', s.is_house,', '''is_house'', coalesce(s.is_house, false) or s.id = any(public.fin__own_store_ids()), ''own_store'', s.id = any(public.fin__own_store_ids()) and not coalesce(s.is_house, false),');
  if n = d then raise exception 'fin_store_prices_list anchor not found'; end if;
  execute n;

  -- 3. saving a price: warn in "cost" words for own stores too
  d := pg_get_functiondef('public.fin_store_price_set'::regproc);
  n := replace(d, 'select is_house into v_house from sellers where id = p.seller_id;',
                  'select coalesce(is_house, false) or id = any(public.fin__own_store_ids()) into v_house from sellers where id = p.seller_id;');
  if n = d then raise exception 'fin_store_price_set anchor not found'; end if;
  execute n;

  -- 4. "owed to store" overrides never count an own store as a store to pay
  d := pg_get_functiondef('public.fin_entry_save'::regproc);
  n := replace(d, 'where oi.order_id = v_order.id and not coalesce(s.is_house, false);',
                  'where oi.order_id = v_order.id and not coalesce(s.is_house, false) and not (s.id = any(public.fin__own_store_ids()));');
  if n = d then raise exception 'fin_entry_save anchor not found'; end if;
  execute n;

  -- 5. validation of the new key
  d := pg_get_functiondef('public.site_settings_finance_validate'::regproc);
  n := replace(d, '  if fail is not null then
    raise exception using message = ''FINANCE_INVALID''',
'  if fail is null and v ? ''own_store_ids'' and (jsonb_typeof(v->''own_store_ids'') <> ''array''
     or exists (select 1 from jsonb_array_elements(v->''own_store_ids'') e
                 where jsonb_typeof(e) <> ''string''
                    or (e #>> ''{}'') !~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''
                    or not exists (select 1 from sellers s where s.id = (e #>> ''{}'')::uuid))) then
    fail := ''own_store_ids must be a list of existing store ids''; end if;
  if fail is not null then
    raise exception using message = ''FINANCE_INVALID''');
  if n = d then raise exception 'finance validate anchor not found'; end if;
  execute n;
end $mig$;

-- Seed: Lumina Shop is Umzila's own store.
update public.site_settings
   set value = jsonb_set(value, '{own_store_ids}', to_jsonb(array(select id::text from sellers where slug = 'lumina-shop'))),
       updated_at = now()
 where key = 'finance' and not (value ? 'own_store_ids');
