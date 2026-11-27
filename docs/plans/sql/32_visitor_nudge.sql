-- 32_visitor_nudge.sql — "Lunch reminder": one email a day (e.g. 13:00 SAST) to this
-- morning's visitors who left an email (or are signed in) but haven't paid today, so they
-- can still make the next delivery run. Settings = public.site_settings key 'visitor_nudge'
-- (admin.html → Marketing → Lunch reminder). Sent by send-scheduled-campaigns.js →
-- lib/visitor-nudge.js → lib/campaign-send.js sendCampaign (one marketing_campaigns row per
-- day, audience 'morning_visitors:<day>' — the unique index below is the once-a-day lock).

create unique index if not exists marketing_campaigns_morning_visitors_once
  on public.marketing_campaigns (audience) where audience like 'morning_visitors:%';

-- Who gets it. Morning visitor = their first page view on p_day (SAST) is in [p_from, p_to).
-- Email = what they typed on that browser (site_browsers) or their confirmed account email.
-- Left out: anyone with a PAID order since midnight SAST, unsubscribed people, and staff /
-- riders / store owners.
create or replace function public.visitor_nudge__list(p_day date, p_from time, p_to time)
returns table (email text, name text, first_visit timestamptz)
language sql stable security definer set search_path = public, auth as $$
  with v as (
    select s.session_id, (array_agg(s.user_id) filter (where s.user_id is not null))[1] as user_id, min(s.first_seen) as first_at
    from site_visits s where s.day = p_day group by s.session_id
  ), w as (
    select * from v
    where (v.first_at at time zone 'Africa/Johannesburg')::time >= p_from
      and (v.first_at at time zone 'Africa/Johannesburg')::time <  p_to
  ), e as (
    select lower(trim(b.email)) as email, nullif(trim(b.name), '') as name, w.first_at
      from w join site_browsers b on b.presence_id = w.session_id
     where coalesce(trim(b.email), '') like '%@%'
    union all
    select lower(u.email), null, w.first_at
      from w left join site_browsers b on b.presence_id = w.session_id
      join auth.users u on u.id = coalesce(w.user_id, b.user_id)
     where u.email_confirmed_at is not null
  ), staff as (
    select lower(u.email) as email from auth.users u
     where u.id in (select user_id from admins
                    union select user_id from user_roles where is_active
                    union select user_id from drivers
                    union select user_id from sellers where user_id is not null
                    union select user_id from seller_members)
  )
  select e.email, max(e.name), min(e.first_at)
    from e
   where e.email not in (select s.email from staff s where s.email is not null)
     and not exists (select 1 from subscribers sb where lower(sb.email) = e.email and sb.unsubscribed)
     and not exists (select 1 from orders o
                      where o.payment_status = 'paid'
                        and (lower(o.customer_email) = e.email
                             or o.user_id in (select u.id from auth.users u where lower(u.email) = e.email))
                        and o.paid_at >= (p_day::timestamp at time zone 'Africa/Johannesburg'))
   group by e.email
$$;
revoke all on function public.visitor_nudge__list(date, time, time) from public, anon, authenticated;

-- Server (service role) only: the send.
create or replace function public.visitor_nudge_recipients(p_day date, p_from time, p_to time)
returns table (email text, name text, first_visit timestamptz)
language sql stable security definer set search_path = public as $$
  select * from public.visitor_nudge__list(p_day, p_from, p_to)
$$;
revoke all on function public.visitor_nudge_recipients(date, time, time) from public, anon, authenticated;
grant execute on function public.visitor_nudge_recipients(date, time, time) to service_role;

-- Admin preview: who would get it right now, plus the last sends.
create or replace function public.admin_visitor_nudge_preview(p_day date, p_from time, p_to time)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.people__assert_admin();
  return jsonb_build_object(
    'people', coalesce((select jsonb_agg(jsonb_build_object('email', l.email, 'name', l.name, 'first_visit', l.first_visit) order by l.first_visit)
                          from public.visitor_nudge__list(p_day, p_from, p_to) l), '[]'::jsonb),
    'sends', coalesce((select jsonb_agg(jsonb_build_object('day', substr(c.audience, 18), 'status', c.status, 'sent_at', c.sent_at, 'count', c.recipient_count, 'subject', c.subject) order by c.created_at desc)
                         from (select * from marketing_campaigns where audience like 'morning_visitors:%' order by created_at desc limit 10) c), '[]'::jsonb));
end $$;
revoke all on function public.admin_visitor_nudge_preview(date, time, time) from public, anon;
grant execute on function public.admin_visitor_nudge_preview(date, time, time) to authenticated;

-- Default settings (off until an admin switches it on).
insert into public.site_settings (key, value)
values ('visitor_nudge', jsonb_build_object(
  'enabled', false, 'send_at', '13:00', 'window_from', '05:00', 'window_to', '12:30', 'days', jsonb_build_array(1,2,3,4,5,6,7),
  'subject', 'Lunch? Order by 13:45 for the 14:00 delivery 🍽️',
  'eyebrow', 'LUNCH RUN',
  'headline', 'Still thinking about lunch?',
  'body', 'You popped in this morning — order before 13:45 and your food leaves the store at 14:00. Your basket is still waiting for you.',
  'cta_text', 'Order lunch', 'cta_path', '/', 'image_url', ''))
on conflict (key) do nothing;
