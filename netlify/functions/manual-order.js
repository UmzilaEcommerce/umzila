// netlify/functions/manual-order.js
//
// Orders that logistics/admin type in by hand (ORD-…) — logistics.html
// "New Order" and the "Paid: Cash / Card machine / EFT" buttons (2026-11-17).
// Staff only: Authorization: Bearer <session> of an admin (public.admins) or an
// active logistics/admin user_roles row (same rule as get_ops_board).
//
//   { action: 'quote',  lat, lon, items:[{product_id}] }
//        → { in_zone, zone_name, fee, km }  suggested delivery fee (same price
//          rule as checkout: lib/delivery-price + admin markup + zone promo cap)
//   { action: 'create', mode: 'deliver'|'done', customer, address, items,
//       delivery_fee, discount, coupon_code, notes, paid_by, email_customer, order_number }
//        → { ok, order_id, order_number, paid, tracking_url }
//   { action: 'pay', order_id, method }  record a cash/card-machine/EFT payment
//
// Two kinds of manual order:
//   deliver — "Deliver it, with tracking": exactly like a PayFast order once it
//             is paid. The order carries destination_geo, so when it turns paid
//             create_delivery_on_payment makes the deliveries row (tracking link),
//             populate_order_items_on_payment writes order_items, and the ONE
//             post-payment path (lib/complete-order-payment.js completeOrderPayment,
//             also used by the PayFast ITN and R0 orders) sends the confirmation
//             email with the tracking link, emails the store(s) + admins, takes
//             the stock and releases the delivery to riders. Not paid yet = it
//             waits (no rider) until a payment is recorded.
//   done    — "Already paid & delivered": recorded as paid + Delivered, no rider,
//             no store emails; the customer gets a receipt email (optional).
// Money is never PayFast here: pf_payment_id stays null and pf_response holds
// { manual: true, … } without amount_gross, which is how the finance engine
// (fin__order_lines) recognises a manual order. m_payment_id = order_number so
// completeOrderPayment can find the row.
const { createClient } = require('@supabase/supabase-js');
const { completeOrderPayment } = require('./lib/complete-order-payment');
const { checkEmail, checkPhone } = require('./lib/contact-check');
const { feeForRoadKm, withMarkup, FALLBACK_FEE } = require('./lib/delivery-price');
const { getRoadLeg } = require('./lib/road-distance');

const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (code, obj) => ({ statusCode: code, headers: H, body: JSON.stringify(obj) });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = { cash: 'Cash', pos: 'Card machine', eft_manual: 'EFT (manual)' };
const round2 = n => Math.round(n * 100) / 100;
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 300);

// Same EWKB decoder as get-delivery-quote.js (sellers.pickup_geo comes back as hex).
function parseGeographyPoint(hex) {
  if (!hex || typeof hex !== 'string') return null;
  try {
    const buf = Buffer.from(hex, 'hex');
    if (buf.length < 21) return null;
    const little = buf.readUInt8(0) === 1;
    const type = little ? buf.readUInt32LE(1) : buf.readUInt32BE(1);
    let offset = 5;
    if ((type & 0x20000000) !== 0) offset += 4;
    const lon = little ? buf.readDoubleLE(offset) : buf.readDoubleBE(offset);
    const lat = little ? buf.readDoubleLE(offset + 8) : buf.readDoubleBE(offset + 8);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  } catch (_) { return null; }
}

async function staffUser(supabase, event) {
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!tok) return null;
  const { data: { user } = {}, error } = await supabase.auth.getUser(tok);
  if (error || !user) return null;
  const [{ data: adm }, { data: role }] = await Promise.all([
    supabase.from('admins').select('user_id').eq('user_id', user.id).maybeSingle(),
    supabase.from('user_roles').select('user_id').eq('user_id', user.id).in('role', ['logistics', 'admin']).eq('is_active', true).limit(1)
  ]);
  return (adm || (role && role.length)) ? user : null;
}

// Load + check the lines against the database (prices, stock, store). Staff may
// type a different price (a deal agreed on the phone) — it is kept and marked.
async function buildItems(supabase, raw, { enforceStock, quoteOnly }) {
  const lines = (Array.isArray(raw) ? raw : []).slice(0, 40);
  if (!lines.length) throw { code: 400, error: 'Add at least one item.' };
  const pids = [...new Set(lines.map(l => str(l.product_id, 40)).filter(id => UUID_RE.test(id)))];
  if (pids.length !== new Set(lines.map(l => l.product_id)).size) throw { code: 400, error: 'Pick every item from the product list.' };
  const { data: prods, error } = await supabase.from('products')
    .select('id, name, price, sale, sale_price, stock, image, seller_id, delivery_class, listing_type, free_delivery, metadata, sellers(id, shop_name, free_delivery, is_house, pickup_geo)')
    .in('id', pids);
  if (error) throw { code: 500, error: 'Could not load the products.' };
  const vids = lines.map(l => str(l.variant_id, 40)).filter(id => UUID_RE.test(id));
  const { data: vars } = vids.length
    ? await supabase.from('product_variants').select('id, product_id, size, stock, price_override').in('id', vids)
    : { data: [] };
  const used = {}; // stock per product/variant across lines
  const items = [];
  for (const l of lines) {
    const p = (prods || []).find(x => x.id === l.product_id);
    if (!p) throw { code: 400, error: 'A product on this order no longer exists.' };
    if ((p.listing_type || 'product') === 'service') throw { code: 400, error: `"${p.name}" is a service — services can't be added by hand.` };
    const qty = Math.floor(Number(l.quantity));
    if (!(qty >= 1 && qty <= 99)) throw { code: 400, error: `Quantity for "${p.name}" must be 1–99.` };
    let v = null;
    if (l.variant_id) {
      v = (vars || []).find(x => x.id === l.variant_id && x.product_id === p.id);
      if (!v) throw { code: 400, error: `Pick the option for "${p.name}" again.` };
    }
    if (!v && !quoteOnly && p.metadata && p.metadata.option_required) {
      throw { code: 400, error: `Choose the ${String(p.metadata.option_label || 'option').replace(/^choose\s+/i, '')} for "${p.name}".` };
    }
    // Same price rule as validate-cart.js: variant override, then the sale price wins.
    let listPrice = Number(v ? (v.price_override || p.price) : p.price) || 0;
    if (p.sale && p.sale_price) listPrice = Number(p.sale_price) || listPrice;
    const typed = l.price === '' || l.price == null ? null : Number(l.price);
    if (typed != null && !(Number.isFinite(typed) && typed >= 0 && typed <= 100000)) throw { code: 400, error: `Price for "${p.name}" is not valid.` };
    const price = round2(typed != null ? typed : listPrice);
    const key = v ? 'v:' + v.id : 'p:' + p.id;
    used[key] = (used[key] || 0) + qty;
    const stock = Number(v && v.stock != null ? v.stock : p.stock) || 0;
    if (enforceStock && used[key] > stock) throw { code: 400, error: `Only ${stock} of "${p.name}${v && v.size ? ' · ' + v.size : ''}" in stock.` };
    items.push({
      id: p.id, product_id: p.id, variant_id: v ? v.id : null,
      name: p.name, title: p.name, item: p.name,
      size: (v && v.size) || 'One Size', image: p.image || '',
      price, quantity: qty, subtotal: round2(price * qty),
      seller_id: p.seller_id, listing_type: 'product',
      delivery_class: p.delivery_class || 'small',
      free_delivery: !!p.free_delivery || !!(p.sellers && p.sellers.free_delivery),
      ...(typed != null && Math.abs(typed - listPrice) > 0.004 ? { manual_price: true, list_price: listPrice } : {})
    });
  }
  return { items, prods: prods || [] };
}

async function quoteFor(supabase, lat, lon, items, prods) {
  const { data: zr, error: zErr } = await supabase.rpc('find_service_zone_for_point', { p_lat: lat, p_lon: lon });
  if (zErr) throw { code: 503, error: 'Could not check the delivery area — try again.' };
  const zone = Array.isArray(zr) ? zr[0] : zr;
  const inZone = !!zone && zone.zone_type !== 'restricted';
  const goods = items.filter(i => !(prods.find(p => p.id === i.product_id) || {}).sellers?.is_house);
  if (!goods.length) throw { code: 400, error: 'Drinks ride along with a store order — add something from a store.' };
  if (goods.every(i => i.free_delivery)) return { in_zone: inZone, zone_name: zone ? zone.name : null, fee: 0, km: null, free: true };
  const store = prods.find(p => p.id === goods[0].product_id);
  const pickup = store && store.sellers ? parseGeographyPoint(store.sellers.pickup_geo) : null;
  let km = null, fee = FALLBACK_FEE;
  if (pickup) {
    try { const leg = await getRoadLeg(supabase, pickup, { lat, lon }); if (leg) { km = round2(leg.distanceKm); fee = feeForRoadKm(leg.distanceKm); } } catch (_) { /* flat fallback */ }
  }
  const { data: pc } = await supabase.from('delivery_pricing_config').select('margin_percent').eq('is_active', true)
    .order('version', { ascending: false }).limit(1).maybeSingle();
  fee = withMarkup(fee, pc && pc.margin_percent);
  if (zone && zone.promo_active && zone.promo_cap_fee != null && (!zone.promo_expires_at || new Date(zone.promo_expires_at) > new Date())) {
    fee = Math.min(fee, Number(zone.promo_cap_fee));
  }
  return { in_zone: inZone, zone_name: zone ? zone.name : null, fee: round2(fee), km };
}

async function trackingUrl(supabase, site, orderId) {
  const { data: dl } = await supabase.from('deliveries').select('tracking_token').eq('order_id', orderId).maybeSingle();
  return dl && dl.tracking_token ? `${site}/track.html?order=${orderId}&t=${dl.tracking_token}` : null;
}

// Record a payment. New-style manual orders (pf_response.manual) still waiting
// as 'Pending' go through completeOrderPayment — the same path as PayFast.
// Older ORD- orders (made before 2026-11-17: stock + order_items were written at
// creation) and orders whose status has already moved on only get the payment
// columns set, so nothing is counted twice and no rider is sent late.
async function recordPayment(supabase, site, order, method, staffId, emailCustomer) {
  if (!METHODS[method]) throw { code: 400, error: 'Choose cash, card machine or EFT.' };
  if (!/^ORD-/i.test(order.order_number || '') || order.pf_payment_id) throw { code: 400, error: 'Only orders entered by hand can be marked paid here — online payments are confirmed by PayFast.' };
  if (order.payment_status === 'paid') throw { code: 409, error: 'This order is already paid.' };
  const pf = (order.pf_response && typeof order.pf_response === 'object') ? order.pf_response : {};
  const fullFlow = pf.manual === true && order.order_status === 'Pending';
  const now = new Date().toISOString();
  if (!fullFlow) {
    const { error } = await supabase.from('orders').update({ payment_status: 'paid', paid_at: now, payment_method_code: method })
      .eq('id', order.id).neq('payment_status', 'paid');
    if (error) throw { code: 500, error: 'Could not record the payment.' };
    return { full: false };
  }
  const done = pf.mode === 'done';
  if (order.m_payment_id !== order.order_number) {
    await supabase.from('orders').update({ m_payment_id: order.order_number }).eq('id', order.id);
  }
  await completeOrderPayment(supabase, {
    mPaymentId: order.order_number,
    pfPaymentId: null,
    pfResponse: { ...pf, manual: true, method, paid_recorded_by: staffId, paid_recorded_at: now, delivered: done, notify: done ? !!emailCustomer : true },
    siteUrl: site,
    pickerOn: false
  });
  const upd = { payment_method_code: method };
  if (done) upd.order_status = 'Delivered';
  await supabase.from('orders').update(upd).eq('id', order.id);
  return { full: true };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, {});
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return reply(500, { error: 'Server configuration error' });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const user = await staffUser(supabase, event);
  if (!user) return reply(403, { error: 'Logistics or admin staff only.' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }
  const site = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');

  try {
    if (b.action === 'quote') {
      const lat = Number(b.lat), lon = Number(b.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return reply(400, { error: 'Pick the address from the suggestions.' });
      const { items, prods } = await buildItems(supabase, (b.items || []).map(i => ({ product_id: i && i.product_id, quantity: 1 })), { enforceStock: false, quoteOnly: true });
      return reply(200, { ok: true, ...(await quoteFor(supabase, lat, lon, items, prods)) });
    }

    if (b.action === 'pay') {
      if (!UUID_RE.test(String(b.order_id || ''))) return reply(400, { error: 'Order missing.' });
      const { data: order } = await supabase.from('orders').select('*').eq('id', b.order_id).maybeSingle();
      if (!order) return reply(404, { error: 'Order not found.' });
      const r = await recordPayment(supabase, site, order, b.method, user.id, b.email_customer !== false);
      return reply(200, { ok: true, full: r.full, tracking_url: await trackingUrl(supabase, site, order.id) });
    }

    if (b.action !== 'create') return reply(400, { error: 'Unknown action' });

    const mode = b.mode === 'done' ? 'done' : b.mode === 'deliver' ? 'deliver' : null;
    if (!mode) return reply(400, { error: 'Choose how this order is handled.' });
    const c = b.customer || {}, a = b.address || {};
    const name = str(c.name, 120);
    if (!name) return reply(400, { error: 'Customer name is required.' });
    const em = checkEmail(str(c.email, 200));
    if (!em.ok) return reply(400, { error: em.error || 'Check the email address.', suggestion: em.suggestion || null });
    let phone = null;
    if (str(c.phone)) { const ph = checkPhone(str(c.phone, 40)); if (!ph.ok) return reply(400, { error: ph.error || 'Check the phone number.' }); phone = ph.value; }
    const paidBy = str(b.paid_by, 20);
    if (paidBy && !METHODS[paidBy]) return reply(400, { error: 'Unknown payment method.' });
    if (mode === 'done' && !paidBy) return reply(400, { error: 'An order that is already delivered must say how it was paid.' });

    const { items, prods } = await buildItems(supabase, b.items, { enforceStock: mode === 'deliver' });
    const subtotal = round2(items.reduce((s, i) => s + i.subtotal, 0));
    const discount = round2(Math.max(0, Number(b.discount) || 0));
    if (discount > subtotal) return reply(400, { error: 'The discount is bigger than the items.' });

    const street = str(a.street, 300);
    let geo = null, fee = Number(b.delivery_fee);
    if (mode === 'deliver') {
      const lat = Number(a.lat), lon = Number(a.lon);
      if (!street || !Number.isFinite(lat) || !Number.isFinite(lon)) return reply(400, { error: 'Pick the delivery address from the suggestions so the rider can find it.' });
      const q = await quoteFor(supabase, lat, lon, items, prods);
      if (!q.in_zone) return reply(400, { error: 'Umzila doesn’t deliver to this address (outside every Service Area). Use "Already paid & delivered" if it was handled another way.', code: 'OUTSIDE_AREA' });
      if (!Number.isFinite(fee) || b.delivery_fee === '' || b.delivery_fee == null) fee = q.fee;
      geo = `SRID=4326;POINT(${lon} ${lat})`;
    } else if (!Number.isFinite(fee) || b.delivery_fee === '' || b.delivery_fee == null) fee = 0;
    if (!(fee >= 0 && fee <= 1000)) return reply(400, { error: 'Delivery fee is not valid.' });
    fee = round2(fee);
    const total = round2(subtotal - discount + fee);

    // Order number: typed one (checked unique) or a fresh ORD-xxxxxx.
    let orderNumber = str(b.order_number, 40).toUpperCase();
    if (orderNumber) {
      if (!/^ORD-[A-Z0-9-]{3,30}$/.test(orderNumber)) return reply(400, { error: 'A typed order number must look like ORD-123456.' });
      const { data: clash } = await supabase.from('orders').select('id').or(`order_number.eq.${orderNumber},m_payment_id.eq.${orderNumber}`).limit(1);
      if (clash && clash.length) return reply(409, { error: `${orderNumber} is already used.` });
    } else {
      for (let i = 0; i < 6 && !orderNumber; i++) {
        const n = 'ORD-' + Math.floor(100000 + Math.random() * 900000);
        const { data: clash } = await supabase.from('orders').select('id').or(`order_number.eq.${n},m_payment_id.eq.${n}`).limit(1);
        if (!clash || !clash.length) orderNumber = n;
      }
      if (!orderNumber) return reply(500, { error: 'Could not make an order number — try again.' });
    }

    const nowIso = new Date().toISOString();
    const row = {
      order_number: orderNumber, m_payment_id: orderNumber,
      customer_name: name, customer_email: em.value, customer_phone: phone,
      delivery_address: street || null, city: str(a.city, 120) || null, province: str(a.province, 80) || null,
      postal_code: str(a.postal_code, 20) || null, delivery_instructions: str(a.details, 500) || null,
      destination_geo: geo,
      order_status: 'Pending', payment_status: 'pending',
      items, total, discount, shipping_cost: fee, delivery_class: 'small',
      coupon_code: str(b.coupon_code, 60).toUpperCase() || null,
      notes: str(b.notes, 1000) || null,
      user_id: null, // linked to the customer's verified account (if any) when paid — never the staff member
      source: 'manual',
      pf_response: { manual: true, mode, entered_by: user.id, entered_by_email: user.email || null, entered_at: nowIso, email_customer: b.email_customer !== false }
    };
    const { data: ins, error: insErr } = await supabase.from('orders').insert(row).select('*').single();
    if (insErr) { console.error('manual-order insert', insErr); return reply(500, { error: 'Could not save the order: ' + (insErr.message || 'database error') }); }

    // The order is saved; a problem recording the payment must not hide that.
    let paid = false, payError = null;
    if (paidBy) {
      try { await recordPayment(supabase, site, ins, paidBy, user.id, b.email_customer !== false); paid = true; }
      catch (e) { payError = (e && e.error) || 'The payment could not be recorded — open the order and press Paid again.'; console.error('manual-order pay after create', e); }
    }
    return reply(200, { ok: true, order_id: ins.id, order_number: orderNumber, paid, pay_error: payError, total, tracking_url: paid ? await trackingUrl(supabase, site, ins.id) : null });
  } catch (e) {
    if (e && e.code && e.error) return reply(e.code, { error: e.error });
    console.error('manual-order error', e);
    return reply(500, { error: 'Something went wrong — the order may not be saved. Check the Orders list before trying again.' });
  }
};
