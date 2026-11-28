-- 36_basket_leads.sql (2026-11-28) — people who left their details and added something to a
-- basket stay listed until they pay, even after they empty the basket or the guest carts row is
-- deleted (emptying it, signing in and the nightly clean-up all delete guest rows — that's why
-- "baskets with contact details" used to vanish). Details come from the permanent per-browser
-- record public.site_browsers (written the moment they're typed, People system) as well as the
-- carts row; "added something" = user_events add_to_cart for that browser.
--   basket_leads__list(days)   internal
--   ops_basket_leads(days)     staff (logistics.html → Baskets → "Baskets with contact details")
--   campaign_basket_recipients()  Platform Campaign "Send to: people with an unfinished basket"
drop function if exists public.basket_leads__list(int);
create or replace function public.basket_leads__list(p_days int)
returns table (anon_id text, email text, name text, phone text, has_account boolean, items jsonb, basket_live boolean,
               last_activity timestamptz, unsubscribed boolean)
language sql stable security definer set search_path = public, auth as $$
  with since as (select now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 120))) as t),
  cart_rows as (            -- A: baskets that still have items
    select c.anonymous_id as anon_id, c.user_id, c.items, true as live, c.updated_at as at,
           coalesce(nullif(lower(trim(c.guest_email)), ''),
             (select lower(u.email) from auth.users u where u.id = c.user_id and u.email_confirmed_at is not null),
             (select lower(trim(b.email)) from site_browsers b where b.anon_id = c.anonymous_id and b.email like '%@%' order by b.contact_at desc nulls last limit 1)) as email,
           coalesce(nullif(trim(c.guest_name), ''),
             (select nullif(trim(concat_ws(' ', p.first_name, p.last_name)), '') from profiles p where p.user_id = c.user_id),
             (select nullif(trim(b.name), '') from site_browsers b where b.anon_id = c.anonymous_id order by b.contact_at desc nulls last limit 1)) as name,
           coalesce(nullif(trim(c.guest_phone), ''),
             (select nullif(trim(p.phone), '') from profiles p where p.user_id = c.user_id),
             (select nullif(trim(b.phone), '') from site_browsers b where b.anon_id = c.anonymous_id order by b.contact_at desc nulls last limit 1)) as phone
      from carts c, since
     where jsonb_typeof(c.items) = 'array' and jsonb_array_length(c.items) > 0 and c.updated_at >= since.t
  ),
  browser_rows as (         -- B: details typed on a browser that added to a basket, basket since emptied/gone
    select b.anon_id, b.user_id,
           coalesce((select jsonb_agg(jsonb_build_object('name', x.name, 'quantity', 1, 'earlier', true))
                       from (select distinct pr.name from user_events e join products pr on pr.id = e.product_id
                              where e.anonymous_id = b.anon_id and e.event_type = 'add_to_cart' and e.created_at >= since.t limit 6) x), '[]'::jsonb) as items,
           false as live,
           greatest(b.contact_at, (select max(e.created_at) from user_events e where e.anonymous_id = b.anon_id and e.event_type = 'add_to_cart')) as at,
           nullif(lower(trim(b.email)), '') as email, nullif(trim(b.name), '') as name, nullif(trim(b.phone), '') as phone
      from site_browsers b, since
     where (b.email like '%@%' or coalesce(trim(b.phone), '') <> '')
       and exists (select 1 from user_events e where e.anonymous_id = b.anon_id and e.event_type = 'add_to_cart' and e.created_at >= since.t)
       and not exists (select 1 from carts c where c.anonymous_id = b.anon_id and jsonb_typeof(c.items) = 'array' and jsonb_array_length(c.items) > 0)
  ),
  allrows as (select * from cart_rows where email is not null or phone is not null
              union all select * from browser_rows),
  staff as (
    select lower(u.email) as email from auth.users u
     where u.id in (select user_id from admins union select user_id from user_roles where is_active
                    union select user_id from drivers union select user_id from sellers where user_id is not null
                    union select user_id from seller_members)
  ),
  ranked as (
    select a.*, row_number() over (partition by coalesce(a.email, a.phone) order by a.live desc, a.at desc) as rn
      from allrows a
     where coalesce(a.email, '') not in (select s.email from staff s where s.email is not null)
       and (a.user_id is null or a.user_id not in (select user_id from admins union select user_id from user_roles where is_active
                                                   union select user_id from drivers union select user_id from sellers where user_id is not null
                                                   union select user_id from seller_members))
       and not exists (select 1 from orders o where o.payment_status = 'paid' and o.paid_at > a.at - interval '1 minute'
                         and ((a.email is not null and lower(o.customer_email) = a.email) or (a.phone is not null and o.customer_phone = a.phone)))
  )
  select r.anon_id, r.email, r.name, r.phone, r.user_id is not null, r.items, r.live, r.at,
         exists (select 1 from subscribers sb where r.email is not null and lower(sb.email) = r.email and sb.unsubscribed)
    from ranked r where r.rn = 1
   order by r.at desc
$$;
revoke all on function public.basket_leads__list(int) from public, anon, authenticated;

create or replace function public.ops_basket_leads(p_days int default 30)
returns setof jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.timeslot_is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return query select to_jsonb(l) from public.basket_leads__list(p_days) l;
end $$;
revoke all on function public.ops_basket_leads(int) from public, anon;
grant execute on function public.ops_basket_leads(int) to authenticated;

create or replace function public.campaign_basket_recipients()
returns table (email text, name text, basket_updated_at timestamptz, items int)
language sql stable security definer set search_path = public as $$
  select l.email, l.name, l.last_activity, jsonb_array_length(l.items)
    from public.basket_leads__list(30) l
   where l.email like '%@%' and not l.unsubscribed
$$;
revoke all on function public.campaign_basket_recipients() from public, anon, authenticated;
grant execute on function public.campaign_basket_recipients() to service_role;
