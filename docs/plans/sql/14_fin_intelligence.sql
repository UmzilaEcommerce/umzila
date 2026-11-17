-- Admin → Intelligence (2026-11-17). One admin-only report for "what do I need to
-- know to grow the business": what sells, where shoppers drop off, which stores
-- convert, whether customers come back, and what people want that we don't have.
-- Money comes ONLY from fin__order_lines (the Finances engine, paid, tests left out);
-- behaviour from user_events (staff accounts left out). See docs/systems/intelligence.md.
create or replace function public.fin_intelligence(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $fn$
declare
  v_len int; v_pfrom date; v_pto date;
  v_ts_from timestamptz; v_ts_to timestamptz;
  cur jsonb; prev jsonb; hist jsonb;
  v_out jsonb;
begin
  perform public.fin__assert_admin();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception using message = 'FIN_INVALID', errcode = '22023', detail = 'from/to dates required (max 1 year)';
  end if;
  v_len := p_to - p_from + 1; v_pto := p_from - 1; v_pfrom := p_from - v_len;
  v_ts_from := p_from::timestamp at time zone 'Africa/Johannesburg';
  v_ts_to := (p_to + 1)::timestamp at time zone 'Africa/Johannesburg';
  cur  := public.fin__order_lines(p_from, p_to, false);
  prev := public.fin__order_lines(v_pfrom, v_pto, false);
  hist := public.fin__order_lines(date '2024-01-01', p_to, false);

  with
  staff as (select user_id from admins union select user_id from user_roles where is_active),
  staff_sessions as (select distinct session_id from site_visits where user_id in (select user_id from staff)),
  ev as (
    select e.event_type, e.product_id, e.seller_id, lower(trim(e.search_term)) term, e.metadata,
           coalesce(e.user_id::text, e.anonymous_id) who
      from user_events e
     where e.created_at >= v_ts_from and e.created_at < v_ts_to
       and (e.user_id is null or e.user_id not in (select user_id from staff))),
  co as (select x from jsonb_array_elements(cur) x where not coalesce((x->>'excluded')::boolean, false)),
  po as (select x from jsonb_array_elements(prev) x where not coalesce((x->>'excluded')::boolean, false)),
  ho as (
    select x, coalesce(nullif(lower(x->>'customer_email'), ''), x->>'order_id') cust, (x->>'day')::date d,
           coalesce((x->'payment'->>'gross')::numeric, 0) paid
      from jsonb_array_elements(hist) x where not coalesce((x->>'excluded')::boolean, false)),
  cl as (
    select o.x->>'order_id' order_id, l->>'product_id' pid, s->>'seller_id' sid,
           coalesce((s->>'is_house')::boolean, false) house,
           coalesce((l->>'qty')::numeric, 0) qty, coalesce((l->>'subtotal')::numeric, 0) sub
      from co o
      cross join lateral jsonb_array_elements(coalesce(o.x->'stores', '[]'::jsonb)) s
      cross join lateral jsonb_array_elements(coalesce(s->'lines', '[]'::jsonb)) l),

  -- ── products ──
  pe as (
    select product_id pid,
           count(distinct who) filter (where event_type = 'product_click') viewers,
           count(distinct who) filter (where event_type = 'add_to_cart') carters
      from ev where product_id is not null group by 1),
  ps as (
    select pid::uuid pid, count(distinct order_id) orders, sum(qty) qty, round(sum(sub), 2) goods
      from cl where pid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' group by 1),
  prod as (
    select p.id, p.name, s.shop_name, coalesce(s.is_house, false) house, p.visible,
           (coalesce(p.listing_type, 'product') = 'service') service, p.stock,
           coalesce(pe.viewers, 0) viewers, coalesce(pe.carters, 0) carters,
           coalesce(ps.orders, 0) orders, coalesce(ps.qty, 0) qty, coalesce(ps.goods, 0) goods
      from products p
      left join sellers s on s.id = p.seller_id
      left join pe on pe.pid = p.id
      left join ps on ps.pid = p.id
     where pe.pid is not null or ps.pid is not null),

  -- ── stores ──
  se as (select seller_id sid, count(distinct who) visitors from ev where event_type = 'store_view' and seller_id is not null group by 1),
  sp as (
    select p.seller_id sid,
           count(distinct ev.who) filter (where ev.event_type = 'product_click') viewers,
           count(distinct ev.who) filter (where ev.event_type = 'add_to_cart') carters
      from ev join products p on p.id = ev.product_id group by 1),
  ss as (select sid::uuid sid, count(distinct order_id) orders, round(sum(sub), 2) goods from cl where sid is not null group by 1),
  slast as (
    select (s->>'seller_id')::uuid sid, max(h.d) last_sale
      from ho h cross join lateral jsonb_array_elements(coalesce(h.x->'stores', '[]'::jsonb)) s
     where s->>'seller_id' is not null group by 1),
  sprod as (
    select seller_id sid, count(*) filter (where visible) listed,
           count(*) filter (where visible and coalesce(listing_type, 'product') <> 'service' and coalesce(stock, 0) <= 0) sold_out
      from products group by 1),
  store as (
    select s.id, s.shop_name, s.slug, coalesce(se.visitors, 0) visitors, coalesce(sp.viewers, 0) viewers,
           coalesce(sp.carters, 0) carters, coalesce(ss.orders, 0) orders, coalesce(ss.goods, 0) goods,
           slast.last_sale, coalesce(sprod.listed, 0) listed, coalesce(sprod.sold_out, 0) sold_out
      from sellers s
      left join se on se.sid = s.id left join sp on sp.sid = s.id left join ss on ss.sid = s.id
      left join slast on slast.sid = s.id left join sprod on sprod.sid = s.id
     where s.status = 'active' and not coalesce(s.is_house, false)),

  -- ── customers ──
  cust as (
    select cust, min(d) first_day, max(d) last_day, count(*) orders, round(sum(paid), 2) spent,
           max(x->>'customer_name') name, max(x->>'customer_email') email,
           count(*) filter (where d between p_from and p_to) orders_in,
           round(coalesce(sum(paid) filter (where d between p_from and p_to), 0), 2) spent_in
      from ho group by 1),
  gaps as (select d - lag(d) over (partition by cust order by d) gap from ho),

  -- ── checkouts that never got paid ──
  ab as (
    select o.id, lower(o.customer_email) em, coalesce(o.total, 0) total,
           (o.created_at at time zone 'UTC' at time zone 'Africa/Johannesburg')::date d
      from orders o
     where o.order_status = 'pending_payment' and o.label is distinct from 'seller_enrollment'
       and o.created_at >= (v_ts_from at time zone 'UTC') and o.created_at < (v_ts_to at time zone 'UTC')),
  ab2 as (
    select ab.*, exists (select 1 from cust c where c.cust = ab.em and c.last_day >= ab.d) recovered from ab),

  -- ── when orders come in (SAST) ──
  wh as (
    select extract(isodow from ((x->>'when')::timestamptz at time zone 'Africa/Johannesburg'))::int dow,
           extract(hour from ((x->>'when')::timestamptz at time zone 'Africa/Johannesburg'))::int hr
      from co where x->>'when' is not null),

  -- ── what people look for ──
  srch as (
    select term, count(*) n,
           count(*) filter (where (metadata->>'result_count') = '0' and coalesce(metadata->>'via', '') = '') zero
      from ev where event_type = 'search' and coalesce(term, '') <> '' group by 1),
  areas as (
    select r.created_at, coalesce(nullif(r.city, ''), '—') city, r.address, r.reason, r.cart_total
      from delivery_area_requests r where r.created_at >= v_ts_from and r.created_at < v_ts_to),
  fb as (
    select f.rating, f.message, f.created_at, s.shop_name
      from delivery_feedback f left join sellers s on s.id = f.seller_id
     where f.rating is not null and f.created_at >= v_ts_from and f.created_at < v_ts_to)

  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'days', v_len, 'prev_from', v_pfrom, 'prev_to', v_pto),
    'headline', jsonb_build_object(
      'orders', (select count(*) from co),
      'orders_prev', (select count(*) from po),
      'order_value', (select round(coalesce(sum((x->'payment'->>'gross')::numeric), 0), 2) from co),
      'order_value_prev', (select round(coalesce(sum((x->'payment'->>'gross')::numeric), 0), 2) from po),
      'goods', (select round(coalesce(sum((x->'goods'->>'after_discount')::numeric), 0), 2) from co),
      'umzila_net', (select round(coalesce(sum((x->'umzila'->>'net')::numeric), 0), 2) from co),
      'umzila_net_prev', (select round(coalesce(sum((x->'umzila'->>'net')::numeric), 0), 2) from po),
      'customers', (select count(*) from cust where orders_in > 0),
      'customers_prev', (select count(distinct coalesce(nullif(lower(x->>'customer_email'), ''), x->>'order_id')) from po)),
    'funnel', jsonb_build_object(
      'visitors', (select count(distinct v.session_id) from site_visits v
                    where v.day between p_from and p_to and v.session_id not in (select session_id from staff_sessions)),
      'store_visitors', (select count(distinct who) from ev where event_type = 'store_view'),
      'product_viewers', (select count(distinct who) from ev where event_type = 'product_click'),
      'cart_adders', (select count(distinct who) from ev where event_type = 'add_to_cart'),
      'checkouts', (select count(distinct coalesce(nullif(lower(o.customer_email), ''), o.id::text)) from orders o
                     where o.label is distinct from 'seller_enrollment'
                       and o.created_at >= (v_ts_from at time zone 'UTC') and o.created_at < (v_ts_to at time zone 'UTC')),
      'paid_customers', (select count(*) from cust where orders_in > 0)),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'shop', shop_name, 'house', house, 'visible', visible, 'service', service, 'stock', stock,
        'viewers', viewers, 'carters', carters, 'orders', orders, 'qty', qty, 'goods', goods)
        order by goods desc, viewers desc) from prod), '[]'::jsonb),
    'stores', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'name', shop_name, 'slug', slug, 'visitors', visitors, 'viewers', viewers, 'carters', carters,
        'orders', orders, 'goods', goods, 'last_sale', last_sale, 'listed', listed, 'sold_out', sold_out)
        order by goods desc, visitors desc) from store), '[]'::jsonb),
    'customers', jsonb_build_object(
      'active', (select count(*) from cust where orders_in > 0),
      'new', (select count(*) from cust where first_day between p_from and p_to),
      'returning', (select count(*) from cust where orders_in > 0 and first_day < p_from),
      'all_time', (select count(*) from cust),
      'repeat_all_time', (select count(*) from cust where orders >= 2),
      'avg_days_between', (select round(avg(gap)::numeric, 1) from gaps where gap is not null and gap > 0),
      'one_and_done', (select count(*) from cust where orders = 1 and first_day < p_to - 14),
      'top', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'email', email, 'orders', orders_in, 'spent', spent_in,
                 'first_day', first_day) order by spent_in desc) from (select * from cust where orders_in > 0 order by spent_in desc limit 10) t), '[]'::jsonb),
      'lapsed', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'email', email, 'orders', orders, 'spent', spent,
                 'last_day', last_day) order by spent desc) from (select * from cust where last_day < p_to - 30 order by spent desc limit 15) t), '[]'::jsonb),
      'lapsed_count', (select count(*) from cust where last_day < p_to - 30)),
    'checkout_drop', jsonb_build_object(
      'unpaid', (select count(*) from ab2),
      'unpaid_value', (select round(coalesce(sum(total), 0), 2) from ab2),
      'recovered', (select count(*) from ab2 where recovered),
      'lost_people', (select count(distinct coalesce(em, id::text)) from ab2 where not recovered)),
    'when', jsonb_build_object(
      'by_day', (select jsonb_agg(jsonb_build_object('dow', g, 'n', (select count(*) from wh where wh.dow = g)) order by g) from generate_series(1, 7) g),
      'by_hour', (select jsonb_agg(jsonb_build_object('h', g, 'n', (select count(*) from wh where wh.hr = g)) order by g) from generate_series(0, 23) g)),
    'search', jsonb_build_object(
      'total', (select coalesce(sum(n), 0) from srch),
      'top', coalesce((select jsonb_agg(jsonb_build_object('term', term, 'n', n, 'zero', zero) order by n desc) from (select * from srch order by n desc limit 15) t), '[]'::jsonb),
      'no_results', coalesce((select jsonb_agg(jsonb_build_object('term', term, 'n', zero) order by zero desc) from (select * from srch where zero > 0 order by zero desc limit 15) t), '[]'::jsonb)),
    'areas', jsonb_build_object(
      'count', (select count(*) from areas),
      'by_city', coalesce((select jsonb_agg(jsonb_build_object('city', city, 'n', n) order by n desc) from (select city, count(*) n from areas group by 1 order by 2 desc limit 8) t), '[]'::jsonb),
      'recent', coalesce((select jsonb_agg(jsonb_build_object('at', created_at, 'city', city, 'address', address, 'cart_total', cart_total) order by created_at desc) from (select * from areas order by created_at desc limit 8) t), '[]'::jsonb)),
    'ratings', jsonb_build_object(
      'count', (select count(*) from fb),
      'avg', (select round(avg(rating)::numeric, 2) from fb),
      'low', coalesce((select jsonb_agg(jsonb_build_object('rating', rating, 'message', message, 'at', created_at, 'shop', shop_name) order by created_at desc) from (select * from fb where rating <= 3 order by created_at desc limit 8) t), '[]'::jsonb))
  ) into v_out;
  return v_out;
end
$fn$;

revoke all on function public.fin_intelligence(date, date) from public, anon;
grant execute on function public.fin_intelligence(date, date) to authenticated;
