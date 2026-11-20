-- People (admin → Intelligence → People), 2026-11-20. See docs/systems/people.md.
-- One row per browser: its visit id (presence.js umz_presence_id = site_visits.session_id),
-- its basket/behaviour id (ss_anon_id = carts.anonymous_id = user_events.anonymous_id),
-- the account signed in on it and the contact details typed on it (pop-up, checkout, spin…).
-- Linking both ids also links that browser's PAST visits and behaviour events.

create table if not exists public.site_browsers (
  anon_id     text primary key,
  presence_id uuid unique,
  user_id     uuid references auth.users(id) on delete set null,
  email       text,
  name        text,
  phone       text,
  contact_at  timestamptz,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);
create index if not exists site_browsers_email_idx on public.site_browsers (lower(email));
create index if not exists site_browsers_user_idx on public.site_browsers (user_id);
create index if not exists user_events_anon_idx on public.user_events (anonymous_id, created_at);
create index if not exists site_visits_user_idx on public.site_visits (user_id) where user_id is not null;
alter table public.site_browsers enable row level security;   -- no policies: only the functions below
revoke all on public.site_browsers from public, anon, authenticated;

-- Seed from what already links a basket id to a person.
insert into public.site_browsers (anon_id, email, name, phone, contact_at, first_seen, last_seen)
select anonymous_id, lower(guest_email), guest_name, guest_phone,
       case when guest_email is not null then updated_at end, created_at, updated_at
from public.carts
where user_id is null and anonymous_id ~ '^anon-[a-z0-9]{6,40}$'
on conflict (anon_id) do nothing;

insert into public.site_browsers as b (anon_id, user_id, first_seen, last_seen)
select distinct on (anonymous_id) anonymous_id, user_id,
       min(created_at) over (partition by anonymous_id), max(created_at) over (partition by anonymous_id)
from public.user_events
where user_id is not null and anonymous_id ~ '^anon-[a-z0-9]{6,40}$'
order by anonymous_id, created_at desc
on conflict (anon_id) do update set user_id = coalesce(b.user_id, excluded.user_id),
  first_seen = least(b.first_seen, excluded.first_seen), last_seen = greatest(b.last_seen, excluded.last_seen);

-- Heartbeat: same as before + the browser link (new params are optional, old callers still work).
drop function if exists public.touch_presence(uuid, text);
create or replace function public.touch_presence(p_session uuid, p_page text default 'home',
  p_anon text default null, p_email text default null, p_name text default null, p_phone text default null)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_page text := left(coalesce(nullif(trim(p_page), ''), 'home'), 60);
        v_email text; v_name text; v_phone text;
begin
  if p_session is null then return; end if;
  insert into site_presence as s (session_id, user_id, page, last_seen)
  values (p_session, auth.uid(), v_page, now())
  on conflict (session_id) do update
    set last_seen = now(), page = excluded.page, user_id = coalesce(excluded.user_id, s.user_id)
    where s.last_seen < now() - interval '20 seconds' or s.page is distinct from excluded.page
       or (excluded.user_id is not null and s.user_id is distinct from excluded.user_id);
  -- history: one row per browser/page/day, refreshed at most every 2 minutes
  insert into site_visits as v (day, session_id, page, user_id)
  values ((now() at time zone 'Africa/Johannesburg')::date, p_session, v_page, auth.uid())
  on conflict (day, session_id, page) do update
    set last_seen = now(), beats = v.beats + 1, user_id = coalesce(excluded.user_id, v.user_id)
    where v.last_seen < now() - interval '2 minutes'
       or (excluded.user_id is not null and v.user_id is distinct from excluded.user_id);
  -- browser link (People)
  if p_anon is not null and p_anon ~ '^anon-[a-z0-9]{6,40}$' then
    v_email := nullif(lower(trim(coalesce(p_email, ''))), '');
    if v_email is not null and (length(v_email) > 200 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then v_email := null; end if;
    v_name := left(nullif(trim(coalesce(p_name, '')), ''), 100);
    v_phone := left(nullif(trim(coalesce(p_phone, '')), ''), 30);
    update site_browsers set presence_id = null where presence_id = p_session and anon_id <> p_anon;
    insert into site_browsers as b (anon_id, presence_id, user_id, email, name, phone, contact_at)
    values (p_anon, p_session, auth.uid(), v_email, v_name, v_phone, case when v_email is not null then now() end)
    on conflict (anon_id) do update
      set presence_id = excluded.presence_id,
          user_id = coalesce(excluded.user_id, b.user_id),
          email = coalesce(excluded.email, b.email),
          name = coalesce(excluded.name, b.name),
          phone = coalesce(excluded.phone, b.phone),
          contact_at = case when excluded.email is not null and excluded.email is distinct from b.email then now() else b.contact_at end,
          last_seen = now()
      where b.last_seen < now() - interval '2 minutes'
         or b.presence_id is distinct from excluded.presence_id
         or (excluded.user_id is not null and b.user_id is distinct from excluded.user_id)
         or (excluded.email is not null and excluded.email is distinct from b.email)
         or (excluded.name is not null and excluded.name is distinct from b.name)
         or (excluded.phone is not null and excluded.phone is distinct from b.phone);
  end if;
  if random() < 0.02 then
    delete from site_presence where last_seen < now() - interval '10 minutes';
  end if;
end $function$;
grant execute on function public.touch_presence(uuid, text, text, text, text, text) to anon, authenticated;

-- ── Admin-only lookups ─────────────────────────────────────────────────────
create or replace function public.people__assert_admin() returns void
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not exists (select 1 from admins a where a.user_id = auth.uid()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
end $$;
revoke all on function public.people__assert_admin() from public, anon, authenticated;

-- Everything that belongs to one email: accounts, basket ids, visit ids.
create or replace function public.people__ids(p_email text,
  out users uuid[], out anons text[], out presences uuid[])
language plpgsql stable security definer set search_path to 'public' as $$
declare e text := lower(trim(p_email));
begin
  users := array(select id from auth.users where lower(email) = e);
  anons := array(
    select anon_id from site_browsers where lower(email) = e or user_id = any(users)
    union select anonymous_id from carts where lower(guest_email) = e and anonymous_id is not null
    union select distinct anonymous_id from user_events where user_id = any(users) and anonymous_id is not null);
  presences := array(select presence_id from site_browsers where anon_id = any(anons) and presence_id is not null);
end $$;
revoke all on function public.people__ids(text) from public, anon, authenticated;

-- Last real activity of one email (visits, behaviour, baskets, orders, gift claims).
create or replace function public.people__last_seen(p_email text) returns timestamptz
language plpgsql stable security definer set search_path to 'public' as $$
declare i record; e text := lower(trim(p_email));
begin
  select * into i from people__ids(e);
  return greatest(
    (select max(last_seen) from site_visits where session_id = any(i.presences) or user_id = any(i.users)),
    (select max(created_at) from user_events where anonymous_id = any(i.anons) or user_id = any(i.users)),
    (select max(last_seen) from site_browsers where anon_id = any(i.anons) and presence_id is not null),
    (select max(updated_at) from carts where anonymous_id = any(i.anons) or user_id = any(i.users)),
    (select max(created_at)::timestamptz from orders where lower(customer_email) = e or user_id = any(i.users)),
    (select max(created_at) from discount_codes where lower(email) = e and type in ('mystery_gift', 'free_item')),
    (select max(last_sign_in_at) from auth.users where id = any(i.users)));
end $$;
revoke all on function public.people__last_seen(text) from public, anon, authenticated;

-- Search by email, name or phone → up to 30 people.
create or replace function public.admin_find_people(p_q text) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare q text := lower(trim(coalesce(p_q, ''))); qd text;
begin
  perform people__assert_admin();
  if length(q) < 2 then return '[]'::jsonb; end if;
  qd := regexp_replace(q, '\D', '', 'g');
  if length(qd) >= 9 then qd := right(qd, 9); elsif length(qd) < 4 then qd := null; end if;
  return coalesce((
    with c(email, name, phone) as (
      select lower(email), raw_user_meta_data->>'full_name', phone from auth.users
      union all select lower(email), name, phone from site_browsers
      union all select lower(guest_email), guest_name, guest_phone from carts
      union all select lower(customer_email), customer_name, customer_phone from orders
      union all select lower(email), name, null from subscribers
      union all select lower(email), null, null from discount_codes
    ), hit as (
      select email, max(name) name, max(phone) phone from c
      where email is not null and email <> ''
      group by email
      having bool_or(email like '%' || q || '%' or lower(coalesce(name, '')) like '%' || q || '%'
             or (qd is not null and regexp_replace(coalesce(phone, ''), '\D', '', 'g') like '%' || qd || '%'))
      limit 30
    )
    select jsonb_agg(jsonb_build_object('email', h.email, 'name', h.name,
             'account', exists (select 1 from auth.users u where lower(u.email) = h.email),
             'last_seen', people__last_seen(h.email)) order by people__last_seen(h.email) desc nulls last)
    from hit h), '[]'::jsonb);
end $$;
revoke all on function public.admin_find_people(text) from public, anon;
grant execute on function public.admin_find_people(text) to authenticated;

-- Everything about one email.
create or replace function public.admin_person(p_email text) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare i record; e text := lower(trim(coalesce(p_email, '')));
begin
  perform people__assert_admin();
  select * into i from people__ids(e);
  return jsonb_build_object(
    'email', e,
    'last_seen', people__last_seen(e),
    'names', (select coalesce(jsonb_agg(distinct n), '[]'::jsonb) from (
        select raw_user_meta_data->>'full_name' n from auth.users where id = any(i.users)
        union select name from site_browsers where anon_id = any(i.anons)
        union select guest_name from carts where lower(guest_email) = e
        union select customer_name from orders where lower(customer_email) = e or user_id = any(i.users)) z where nullif(trim(n), '') is not null),
    'phones', (select coalesce(jsonb_agg(distinct p), '[]'::jsonb) from (
        select phone p from site_browsers where anon_id = any(i.anons)
        union select guest_phone from carts where lower(guest_email) = e
        union select customer_phone from orders where lower(customer_email) = e or user_id = any(i.users)) z where nullif(trim(p), '') is not null),
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('created_at', created_at, 'confirmed', email_confirmed_at is not null,
                   'last_sign_in', last_sign_in_at)), '[]'::jsonb) from auth.users where id = any(i.users)),
    'browsers', (select coalesce(jsonb_agg(jsonb_build_object('first_seen', first_seen, 'last_seen', last_seen,
                   'linked', presence_id is not null, 'contact_at', contact_at) order by last_seen desc), '[]'::jsonb)
                 from site_browsers where anon_id = any(i.anons)),
    'visits', (select coalesce(jsonb_agg(d order by d->>'day' desc), '[]'::jsonb) from (
        select jsonb_build_object('day', v.day, 'first', min(v.first_seen), 'last', max(v.last_seen),
                 'pages', jsonb_agg(jsonb_build_object('page', v.page, 'label', s.shop_name) order by v.first_seen)) d
        from site_visits v left join sellers s on v.page like 'store:%' and s.slug = substr(v.page, 7)
        where v.session_id = any(i.presences) or v.user_id = any(i.users)
        group by v.day order by v.day desc limit 60) z),
    'activity', (select coalesce(jsonb_agg(a order by a->>'at' desc), '[]'::jsonb) from (
        select jsonb_build_object('at', ev.created_at, 'type', ev.event_type, 'product', p.name,
                 'store', coalesce(s.shop_name, ps.shop_name), 'term', ev.search_term, 'category', ev.category) a
        from user_events ev
        left join products p on p.id = ev.product_id
        left join sellers s on s.id = ev.seller_id
        left join sellers ps on ps.id = p.seller_id
        where ev.anonymous_id = any(i.anons) or ev.user_id = any(i.users)
        order by ev.created_at desc limit 150) z),
    'baskets', (select coalesce(jsonb_agg(jsonb_build_object('updated_at', updated_at, 'account', user_id is not null,
                   'items', (select coalesce(jsonb_agg(jsonb_build_object('name', it->>'name', 'qty', it->>'quantity', 'price', it->>'price')), '[]'::jsonb)
                             from jsonb_array_elements(case when jsonb_typeof(items) = 'array' then items else '[]'::jsonb end) it))
                   order by updated_at desc), '[]'::jsonb)
                from carts where anonymous_id = any(i.anons) or user_id = any(i.users) or lower(guest_email) = e),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('order_number', order_number, 'created_at', created_at,
                   'payment_status', payment_status, 'order_status', order_status, 'total', total, 'source', source)
                   order by created_at desc), '[]'::jsonb)
               from orders where lower(customer_email) = e or user_id = any(i.users)),
    'codes', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'type', type, 'created_at', created_at,
                  'expires_at', expires_at, 'used', used, 'used_at', used_at) order by created_at desc), '[]'::jsonb)
              from discount_codes where lower(email) = e),
    'subscriber', (select jsonb_build_object('since', created_at, 'sources', sources, 'unsubscribed', unsubscribed)
                   from subscribers where lower(email) = e limit 1));
end $$;
revoke all on function public.admin_person(text) from public, anon;
grant execute on function public.admin_person(text) to authenticated;

-- People seen on the site in the last p_days, known ones by email + a count of unknown browsers.
create or replace function public.admin_recent_people(p_days int default 7) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare r jsonb; since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 120)));
begin
  perform people__assert_admin();
  with seen as (                                   -- (who, when, page) from visits + behaviour
      select coalesce(lower(u.email), lower(b.email)) email, v.session_id::text browser, v.last_seen seen_at, v.page
      from site_visits v
      left join auth.users u on u.id = v.user_id
      left join site_browsers b on b.presence_id = v.session_id
      where v.last_seen >= since
      union all
      select coalesce(lower(u.email), lower(b.email), lower(c.guest_email)), coalesce(b.presence_id::text, ev.anonymous_id), ev.created_at seen_at, null
      from user_events ev
      left join site_browsers b on b.anon_id = ev.anonymous_id
      left join carts c on c.anonymous_id = ev.anonymous_id and c.user_id is null
      left join auth.users u on u.id = coalesce(ev.user_id, b.user_id)
      where ev.created_at >= since and ev.anonymous_id is not null
    ), known as (
      select email, max(seen_at) last_seen, count(distinct (seen_at at time zone 'Africa/Johannesburg')::date) days,
             (array_agg(page order by seen_at desc) filter (where page is not null))[1] last_page
      from seen where email is not null group by email
    )
    select jsonb_build_object(
      'known', coalesce((select jsonb_agg(jsonb_build_object('email', k.email, 'last_seen', k.last_seen, 'days', k.days,
                 'last_page', k.last_page, 'store', s.shop_name,
                 'name', coalesce((select max(b.name) from site_browsers b where lower(b.email) = k.email),
                                  (select max(o.customer_name) from orders o where lower(o.customer_email) = k.email),
                                  (select max(u.raw_user_meta_data->>'full_name') from auth.users u where lower(u.email) = k.email)),
                 'account', exists (select 1 from auth.users u where lower(u.email) = k.email))
               order by k.last_seen desc)
               from known k left join sellers s on k.last_page like 'store:%' and s.slug = substr(k.last_page, 7)), '[]'::jsonb),
      'unknown_browsers', (select count(distinct browser) from seen where email is null)) into r;
  return r;
end $$;
revoke all on function public.admin_recent_people(int) from public, anon;
grant execute on function public.admin_recent_people(int) to authenticated;
