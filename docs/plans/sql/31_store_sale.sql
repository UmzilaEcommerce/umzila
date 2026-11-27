-- 31_store_sale.sql — store-wide % sale (applied 2026-11-27 as migration store_wide_sale).
-- Admin → Marketing → Store-wide sale (admin.html). Uses the EXISTING products.sale / sale_price
-- (validate-cart, checkout, cart, every card already price from them), so there is no second
-- pricing path. Each product the sale touches is tagged products.metadata.store_sale
-- {percent, label, at}; that tag is what (a) the "10% off" tag on cards/pop-up reads and
-- (b) ending the sale uses to undo exactly what it did. Items already on a sale of their own
-- (sale = true, 0 < sale_price < price, no store_sale tag) are specials and are never touched.

create or replace function public.admin_store_sale_apply(p_seller uuid, p_percent int, p_label text default null, p_skip uuid[] default '{}')
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $f$
declare v_applied int; v_specials text[]; v_label text := nullif(btrim(coalesce(p_label, '')), '');
begin
  perform public.fin__assert_admin();
  if p_seller is null or not exists (select 1 from public.sellers where id = p_seller) then
    raise exception using message = 'Pick a store.';
  end if;
  if p_percent is null or p_percent < 1 or p_percent > 90 then
    raise exception using message = '% off must be between 1 and 90.';
  end if;
  if v_label is not null and length(v_label) > 40 then
    raise exception using message = 'Keep the sale name under 40 characters.';
  end if;

  -- Specials (on sale by themselves) — reported, never changed.
  select coalesce(array_agg(name order by name), '{}') into v_specials from public.products
   where seller_id = p_seller and not (coalesce(metadata, '{}'::jsonb) ? 'store_sale')
     and sale and sale_price > 0 and sale_price < price;

  -- Items the admin left out that the sale had already touched go back to full price.
  update public.products set sale = false, sale_price = null, metadata = metadata - 'store_sale'
   where seller_id = p_seller and metadata ? 'store_sale' and id = any(coalesce(p_skip, '{}'));

  update public.products p set
    sale = true,
    sale_price = round(p.price * (100 - p_percent) / 100.0, 2),
    metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object('store_sale',
      jsonb_build_object('percent', p_percent, 'label', v_label, 'at', now()))
   where p.seller_id = p_seller and p.price > 0
     and not (p.id = any(coalesce(p_skip, '{}')))
     and ((coalesce(p.metadata, '{}'::jsonb) ? 'store_sale')
          or not (p.sale and p.sale_price > 0 and p.sale_price < p.price));
  get diagnostics v_applied = row_count;
  return jsonb_build_object('applied', v_applied, 'specials', to_jsonb(v_specials));
end $f$;

create or replace function public.admin_store_sale_end(p_seller uuid)
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $f$
declare v_n int;
begin
  perform public.fin__assert_admin();
  update public.products set sale = false, sale_price = null, metadata = metadata - 'store_sale'
   where seller_id = p_seller and metadata ? 'store_sale';
  get diagnostics v_n = row_count;
  return jsonb_build_object('ended', v_n);
end $f$;

revoke all on function public.admin_store_sale_apply(uuid, int, text, uuid[]) from public, anon;
revoke all on function public.admin_store_sale_end(uuid) from public, anon;
grant execute on function public.admin_store_sale_apply(uuid, int, text, uuid[]) to authenticated;
grant execute on function public.admin_store_sale_end(uuid) to authenticated;
