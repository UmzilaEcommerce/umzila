-- 35_campaign_basket_audience.sql (2026-11-28) — Platform Campaign "Send to: People with an
-- unfinished basket" (marketing_campaigns.audience = 'baskets', lib/campaign-send.js).
-- A basket = a carts row with items. Its email = the guest email on the row, else the account's
-- CONFIRMED email, else the email typed on that browser (site_browsers via anonymous_id).
-- Left out: staff / riders / store owners / co-owners, unsubscribed subscribers, and anyone who
-- has paid for an order since the basket was last touched.
create or replace function public.campaign_basket_recipients()
returns table (email text, name text, basket_updated_at timestamptz, items int)
language sql stable security definer set search_path = public, auth as $$
  with c as (
    select c.updated_at, jsonb_array_length(coalesce(c.items, '[]'::jsonb)) as n,
      lower(trim(coalesce(nullif(trim(c.guest_email), ''),
        (select u.email from auth.users u where u.id = c.user_id and u.email_confirmed_at is not null),
        (select b.email from site_browsers b where b.anon_id = c.anonymous_id and b.email like '%@%' order by b.contact_at desc nulls last limit 1)))) as email,
      coalesce(nullif(trim(c.guest_name), ''),
        (select nullif(trim(b.name), '') from site_browsers b where b.anon_id = c.anonymous_id order by b.contact_at desc nulls last limit 1)) as name
    from carts c
    where jsonb_typeof(c.items) = 'array' and jsonb_array_length(c.items) > 0
  ), staff as (
    select lower(u.email) as email from auth.users u
     where u.id in (select user_id from admins
                    union select user_id from user_roles where is_active
                    union select user_id from drivers
                    union select user_id from sellers where user_id is not null
                    union select user_id from seller_members)
  )
  select c.email, max(c.name), max(c.updated_at), max(c.n)::int
    from c
   where c.email like '%@%'
     and c.email not in (select s.email from staff s where s.email is not null)
     and not exists (select 1 from subscribers sb where lower(sb.email) = c.email and sb.unsubscribed)
     and not exists (select 1 from orders o where o.payment_status = 'paid' and lower(o.customer_email) = c.email and o.paid_at > c.updated_at)
   group by c.email
$$;
revoke all on function public.campaign_basket_recipients() from public, anon, authenticated;
grant execute on function public.campaign_basket_recipients() to service_role;
