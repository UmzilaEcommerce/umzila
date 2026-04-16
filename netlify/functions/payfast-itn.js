const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

exports.handler = async function(event, context) {
    const headers = { 'Content-Type': 'text/plain' };

    // Always return 200 immediately to prevent PayFast retries
    const immediateResponse = { statusCode: 200, headers, body: 'OK' };

    try {
        // Decode body (Netlify may base64-encode it)
        const rawBody = event.isBase64Encoded
            ? Buffer.from(event.body, 'base64').toString('utf-8')
            : (event.body || '');

        const params = new URLSearchParams(rawBody);
        const pfData = {};
        for (const [key, value] of params) {
            pfData[key] = value;
        }

        console.log('PayFast ITN received — m_payment_id:', pfData.m_payment_id, 'status:', pfData.payment_status);

        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            console.error('Missing Supabase credentials');
            return immediateResponse;
        }

        const supabase = createClient(supabaseUrl, supabaseKey, {
            auth: { autoRefreshToken: false, persistSession: false }
        });

        const passphrase = process.env.PAYFAST_PASSPHRASE || '';
        const signatureValid = verifySignature(rawBody, passphrase);

        if (!signatureValid) {
            console.error('Invalid PayFast signature — skipping update');
            return immediateResponse;
        }

        if (pfData.payment_status === 'COMPLETE') {
            // Fetch order before update — needed for idempotency check, coupon/cart data, confirmation + seller emails
            const { data: existingOrder } = await supabase
                .from('orders')
                .select('id, payment_status, user_id, customer_email, customer_name, coupon_code, items, total, discount, shipping_cost, order_number, label, delivery_address, city, province, postal_code, notes')
                .eq('m_payment_id', pfData.m_payment_id)
                .maybeSingle();

            const alreadyPaid = existingOrder?.payment_status === 'paid';

            // Mark order paid
            const { error: orderErr } = await supabase
                .from('orders')
                .update({
                    order_status:   'paid',
                    payment_status: 'paid',
                    pf_payment_id:  pfData.pf_payment_id,
                    pf_response:    pfData,
                    paid_at:        new Date().toISOString()
                })
                .eq('m_payment_id', pfData.m_payment_id);

            if (orderErr) {
                console.error('ITN: error updating order:', orderErr);
            } else {
                console.log('ITN: order marked as paid:', pfData.m_payment_id);

                // Run post-payment tasks only once (guard against ITN retries)
                if (!alreadyPaid && existingOrder) {

                    // ── Mark coupon as used ────────────────────────────────
                    if (existingOrder.coupon_code) {
                        const { error: dcErr } = await supabase
                            .from('discount_codes')
                            .update({ used: true, used_at: new Date().toISOString() })
                            .eq('code', existingOrder.coupon_code)
                            .eq('used', false); // idempotent — only updates if not already consumed
                        if (dcErr) console.error('ITN: error marking coupon used:', dcErr);
                        else console.log('ITN: coupon marked used:', existingOrder.coupon_code);
                    }

                    // ── Clear buyer's Supabase cart ────────────────────────
                    if (existingOrder.user_id) {
                        try {
                            await supabase
                                .from('carts')
                                .delete()
                                .eq('user_id', existingOrder.user_id);
                            console.log('ITN: cart cleared for user:', existingOrder.user_id);
                        } catch (cartErr) {
                            console.warn('ITN: cart clear error:', cartErr.message);
                        }
                    }

                    // ── Update referral_tracking to converted ──────────────
                    const buyerEmail = existingOrder.customer_email || pfData.email_address || '';
                    if (buyerEmail) {
                        try {
                            await supabase
                                .from('referral_tracking')
                                .update({ status: 'converted' })
                                .eq('referee_email', buyerEmail.toLowerCase())
                                .eq('status', 'signed_up'); // only advance, never overwrite
                        } catch (refErr) {
                            console.warn('ITN: referral_tracking conversion error:', refErr.message);
                        }
                    }

                    // ── Send buyer order confirmation email ────────────────
                    // Only for product orders, not seller enrollment
                    if (pfData.custom_str1 !== 'seller_enrollment' && existingOrder.label !== 'seller_enrollment' && existingOrder.customer_email) {
                        const RESEND_KEY    = process.env.RESEND_API_KEY || '';
                        const SITE_BASE_URL = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');
                        if (RESEND_KEY) {
                            try {
                                const emailRes = await fetch('https://api.resend.com/emails', {
                                    method: 'POST',
                                    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        from:    'Umzila <orders@umzila.store>',
                                        to:      [existingOrder.customer_email],
                                        subject: `Order confirmed — ${existingOrder.order_number || pfData.m_payment_id}`,
                                        html:    buildOrderConfirmationEmail(existingOrder, pfData, SITE_BASE_URL)
                                    })
                                });
                                if (!emailRes.ok) {
                                    const t = await emailRes.text();
                                    console.error('ITN: order confirmation email failed', emailRes.status, t);
                                } else {
                                    console.log('ITN: order confirmation email sent for order', existingOrder.order_number || pfData.m_payment_id);
                                }
                            } catch (emailErr) {
                                console.error('ITN: order confirmation email error', emailErr);
                            }
                        }

                        // ── Create service order records (pending_acceptance) ──
                        await createServiceOrderRecords(supabase, existingOrder).catch(
                            e => console.error('ITN: service order records error', e)
                        );

                        // ── Send per-seller new order notification emails ──
                        await sendSellerOrderNotifications(supabase, existingOrder, pfData).catch(
                            e => console.error('ITN: seller notifications error', e)
                        );

                        // ── Send admin CHA-CHING! notification ──
                        await sendAdminOrderNotification(supabase, existingOrder, pfData).catch(
                            e => console.error('ITN: admin notification error', e)
                        );
                    }

                    // ── Decrement product stock ────────────────────────────
                    try {
                        const orderItems = Array.isArray(existingOrder.items)
                            ? existingOrder.items
                            : (typeof existingOrder.items === 'string' ? JSON.parse(existingOrder.items) : []);

                        for (const item of orderItems) {
                            const pid = item.product_id || item.id;
                            const qty = Number(item.quantity || item.qty || 1);
                            if (!pid || qty <= 0) continue;
                            // Services don't have physical stock to decrement
                            if (item.listing_type === 'service') {
                                console.log('ITN: skipping stock decrement for service item', pid);
                                continue;
                            }

                            const { data: prod } = await supabase
                                .from('products')
                                .select('stock')
                                .eq('id', pid)
                                .maybeSingle();

                            if (prod != null) {
                                const newStock = Math.max(0, (Number(prod.stock) || 0) - qty);
                                const { error: stockErr } = await supabase
                                    .from('products')
                                    .update({ stock: newStock })
                                    .eq('id', pid);
                                if (stockErr) console.warn('ITN: stock decrement failed for product', pid);
                            }
                        }
                    } catch (stockError) {
                        console.warn('ITN: stock decrement error:', stockError.message);
                    }
                }
            }

            // ── Seller enrollment activation ───────────────────────────────
            // custom_str1 = 'seller_enrollment', custom_str2 = applicationId
            if (pfData.custom_str1 === 'seller_enrollment' && pfData.custom_str2) {
                await activateSellerEnrollment(supabase, pfData);
            }

        } else if (pfData.payment_status === 'CANCELLED') {
            const { error } = await supabase
                .from('orders')
                .update({
                    order_status:  'cancelled',
                    pf_payment_id: pfData.pf_payment_id
                })
                .eq('m_payment_id', pfData.m_payment_id);

            if (error) {
                console.error('ITN: error cancelling order:', error);
            }
        }

        return immediateResponse;

    } catch (error) {
        console.error('ITN processing error:', error);
        return immediateResponse;
    }
};

// ── Seller enrollment activation ─────────────────────────────────────────────
async function activateSellerEnrollment(supabase, pfData) {
    const applicationId = pfData.custom_str2;
    const email         = pfData.email_address;

    try {
        // Check application — skip if already completed (idempotency)
        const { data: app } = await supabase
            .from('seller_applications')
            .select('id, status, shop_name, full_name')
            .eq('id', applicationId)
            .maybeSingle();

        if (!app) {
            console.error('ITN seller activation: application not found', applicationId);
            return;
        }
        if (app.status === 'completed') {
            console.log('ITN seller activation: already completed, skipping');
            return;
        }

        // Get user from profile (created before payment by initiate-seller-enrollment)
        const { data: profile } = await supabase
            .from('profiles')
            .select('user_id')
            .eq('email', email)
            .maybeSingle();

        const userId = profile?.user_id || null;

        if (!userId) {
            console.error('ITN seller activation: no profile found for email', email);
            return;
        }

        // Activate the seller row
        const { error: sellerErr } = await supabase
            .from('sellers')
            .update({ status: 'active' })
            .eq('user_id', userId);

        if (sellerErr) {
            console.error('ITN seller activation: sellers update error', sellerErr);
        } else {
            console.log('ITN seller activation: sellers row set to active for user_id', userId);
        }

        // Mark application completed
        const { error: appErr } = await supabase
            .from('seller_applications')
            .update({ status: 'completed' })
            .eq('id', applicationId);

        if (appErr) {
            console.error('ITN seller activation: application update error', appErr);
        }

        // Send welcome email via Resend (non-fatal)
        const RESEND_KEY    = process.env.RESEND_API_KEY || '';
        const SITE_BASE_URL = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');

        if (RESEND_KEY && email) {
            const name      = pfData.name_first ? (pfData.name_first + ' ' + (pfData.name_last || '')).trim() : (app.full_name || '');
            const shopName  = app.shop_name || '';
            const firstName = name.split(/\s+/)[0] || name;

            try {
                const emailRes = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${RESEND_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        from:    'Umzila Sellers <sellers@umzila.store>',
                        to:      [email],
                        subject: "You're officially an Umzila seller!",
                        html:    buildWelcomeEmail(firstName, email, shopName, SITE_BASE_URL)
                    })
                });
                if (!emailRes.ok) {
                    const t = await emailRes.text();
                    console.error('ITN: Resend welcome email error', emailRes.status, t);
                } else {
                    console.log('ITN: welcome email sent to', email);
                }
            } catch (emailErr) {
                console.error('ITN: failed to send welcome email', emailErr);
            }
        }

        console.log('ITN: seller enrollment fully activated for', email);

    } catch (err) {
        console.error('ITN: activateSellerEnrollment error', err);
    }
}

// ── PayFast signature verification ───────────────────────────────────────────
// Uses the raw POST body to avoid re-encoding discrepancies between PHP urlencode
// and JS encodeURIComponent. PayFast signs the URL-encoded parameter string as-is.
function verifySignature(rawBody, passphrase = '') {
    let pfParamString = '';
    let receivedSignature = '';

    const pairs = rawBody.split('&');

    for (let pair of pairs) {
        if (pair.startsWith('signature=')) {
            receivedSignature = decodeURIComponent(pair.split('=')[1] || '');
        } else {
            pfParamString += pair + '&';
        }
    }

    // Remove trailing &
    pfParamString = pfParamString.slice(0, -1);

    if (passphrase) {
        pfParamString += `&passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}`;
    }

    const calculatedSignature = crypto
        .createHash('md5')
        .update(pfParamString)
        .digest('hex');

    return calculatedSignature === receivedSignature;
}

// ── Per-seller new order notification ────────────────────────────────────────
// Groups order items by their owning seller and sends one email per seller.
async function sendSellerOrderNotifications(supabase, order, pfData) {
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) return;

    const RESEND_KEY    = process.env.RESEND_API_KEY || '';
    const SITE_BASE_URL = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');
    if (!RESEND_KEY) return;

    // Collect all product IDs in this order
    const productIds = [...new Set(items.map(i => i.id || i.product_id).filter(Boolean))];
    if (!productIds.length) return;

    // Fetch products → get seller_id per product
    const { data: products, error: prodErr } = await supabase
        .from('products')
        .select('id, seller_id')
        .in('id', productIds);

    if (prodErr || !products || !products.length) {
        console.warn('ITN seller notify: product lookup failed', prodErr);
        return;
    }

    // Map product_id → seller_id
    const productToSeller = {};
    products.forEach(p => { if (p.seller_id) productToSeller[p.id] = p.seller_id; });

    // Get unique seller IDs that appear in this order
    const sellerIds = [...new Set(Object.values(productToSeller))];
    if (!sellerIds.length) return;

    // Fetch active sellers with email
    const { data: sellers, error: sellerErr } = await supabase
        .from('sellers')
        .select('id, shop_name, email')
        .in('id', sellerIds)
        .eq('status', 'active');

    if (sellerErr || !sellers || !sellers.length) {
        console.warn('ITN seller notify: seller lookup failed', sellerErr);
        return;
    }

    // Map seller_id → seller row
    const sellerMap = {};
    sellers.forEach(s => { sellerMap[s.id] = s; });

    // Group order items by seller_id
    const grouped = {};
    items.forEach(item => {
        const pid      = item.id || item.product_id;
        const sellerId = productToSeller[pid];
        if (!sellerId || !sellerMap[sellerId]) return;
        if (!grouped[sellerId]) grouped[sellerId] = [];
        grouped[sellerId].push(item);
    });

    // Send one email per seller
    for (const [sellerId, sellerItems] of Object.entries(grouped)) {
        const seller = sellerMap[sellerId];
        if (!seller.email || !sellerItems.length) continue;

        const hasServices = sellerItems.some(i => i.listing_type === 'service');
        const emailSubject = hasServices
            ? `🔧 New service order — accept required — ${order.order_number || pfData.m_payment_id}`
            : `New order for ${seller.shop_name || 'your store'} — ${order.order_number || pfData.m_payment_id}`;
        const emailHtml = hasServices
            ? buildSellerServiceOrderEmail(seller, sellerItems, order, pfData, SITE_BASE_URL)
            : buildSellerOrderEmail(seller, sellerItems, order, pfData, SITE_BASE_URL);

        try {
            const res = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from:    'Umzila Sellers <sellers@umzila.store>',
                    to:      [seller.email],
                    subject: emailSubject,
                    html:    emailHtml
                })
            });
            if (!res.ok) {
                console.error('ITN seller notify: email failed for', seller.email, res.status, await res.text());
            } else {
                console.log('ITN seller notify: email sent to', seller.email, '—', sellerItems.length, 'item(s)');
            }
        } catch (e) {
            console.error('ITN seller notify: email error for', seller.email, e);
        }
    }
}

function buildSellerOrderEmail(seller, sellerItems, order, pfData, siteUrl) {
    const site     = siteUrl || '';
    const orderRef = order.order_number || pfData.m_payment_id || 'N/A';
    const shopName = esc(seller.shop_name || 'Your Store');

    const fmt  = (n) => 'R' + (parseFloat(n) || 0).toFixed(2);
    const getName  = (i) => i.title || i.name || i.item_name  || 'Item';
    const getPrice = (i) => parseFloat(i.price || i.unit_price || 0);
    const getQty   = (i) => parseInt(i.qty   || i.quantity    || 1, 10);
    const getImg   = (i) => i.img || i.image_url || i.image   || '';
    const getSize  = (i) => i.size || i.variant  || '';

    const sellerTotal = sellerItems.reduce((s, i) => s + getPrice(i) * getQty(i), 0);

    const itemsHtml = sellerItems.map(item => {
        const img  = getImg(item);
        const name = esc(getName(item));
        const size = getSize(item) ? ` — ${esc(String(getSize(item)))}` : '';
        const qty  = getQty(item);
        const price = getPrice(item);

        const imgCell = img
            ? `<td style="padding:10px 12px 10px 0;vertical-align:top;width:68px"><img src="${esc(img)}" width="64" height="64" alt="${name}" style="border-radius:8px;object-fit:cover;display:block;border:1px solid #eaecf0"></td>`
            : `<td style="padding:10px 12px 10px 0;vertical-align:top;width:68px"><div style="width:64px;height:64px;background:#f0f4ff;border-radius:8px;text-align:center;line-height:64px;font-size:20px">🛍️</div></td>`;

        return `<tr>
          ${imgCell}
          <td style="padding:10px 0;vertical-align:top">
            <div style="font-size:14px;font-weight:600;color:#1a1a2e">${name}${size}</div>
            <div style="font-size:13px;color:#666;margin-top:3px">Qty: ${qty} &nbsp;·&nbsp; ${fmt(price)} each</div>
          </td>
          <td style="padding:10px 0 10px 12px;vertical-align:top;text-align:right;white-space:nowrap;font-size:14px;font-weight:700;color:#0a2f66">${fmt(price * qty)}</td>
        </tr>`;
    }).join('');

    // Customer delivery info
    const customerName = esc(order.customer_name || pfData.name_first || 'Customer');
    const deliveryType = esc(order.label || 'Standard Delivery');
    const address      = [order.delivery_address, order.city, order.province, order.postal_code].filter(Boolean).map(esc).join(', ');
    const notes        = order.notes ? esc(order.notes) : '';

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif}
  .wrap{max-width:580px;margin:40px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.09)}
  .hdr{background:#0a2f66;padding:30px 40px;text-align:center}
  .hdr h1{color:#fff;margin:0 0 4px;font-size:22px;font-weight:800}
  .hdr p{color:rgba(255,255,255,0.7);margin:0;font-size:13px}
  .badge{display:inline-block;background:#e0284f;color:#fff;font-size:12px;font-weight:700;padding:4px 14px;border-radius:999px;margin-top:12px;letter-spacing:.5px}
  .bd{padding:32px 40px}
  .bd h2{color:#0a2f66;margin:0 0 6px;font-size:19px;font-weight:700}
  .bd p{color:#555;line-height:1.7;margin:0 0 14px;font-size:14px}
  .ref-box{background:#f0f4ff;border-radius:8px;padding:12px 16px;margin:0 0 20px;font-size:13px;color:#0a2f66;font-weight:600}
  .section-label{font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.8px;margin:20px 0 8px}
  .info-box{background:#f8f9fa;border-radius:8px;padding:14px 18px;font-size:14px;color:#333;line-height:1.8}
  .info-box .row{display:flex;gap:8px}
  .info-box .lbl{color:#888;min-width:100px;flex-shrink:0}
  .info-box .val{color:#1a1a2e;font-weight:600}
  .items-table{width:100%;border-collapse:collapse;margin:8px 0 4px}
  .total-row{border-top:2px solid #eaecf0;padding-top:8px;margin-top:4px;font-size:15px;font-weight:800;color:#0a2f66}
  .divider{border:none;border-top:1px solid #eaecf0;margin:20px 0}
  .cta{text-align:center;margin:24px 0 8px}
  .btn{display:inline-block;background:#0a2f66;color:#fff !important;padding:14px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px}
  .note{font-size:12px;color:#aaa;text-align:center;margin-top:8px}
  .ft{background:#f4f6fb;padding:18px 40px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0}
  .ft a{color:#0a2f66;text-decoration:none}
  @media(max-width:480px){.bd{padding:24px 20px}.hdr{padding:24px 20px}.info-box .row{flex-direction:column;gap:2px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>Umzila Sellers</h1>
    <p>${shopName}</p>
    <span class="badge">🛒 NEW ORDER</span>
  </div>
  <div class="bd">
    <h2>You have a new order!</h2>
    <p>A customer just paid for items from your store. Here are the details — log in to your dashboard to manage fulfilment.</p>

    <div class="ref-box">Order reference: <strong>${esc(orderRef)}</strong></div>

    <div class="section-label">Items ordered from your store</div>
    <table class="items-table">
      <tbody>${itemsHtml}</tbody>
    </table>
    <div class="total-row" style="display:flex;justify-content:space-between;padding:10px 0 4px">
      <span>Your items total</span><span>${fmt(sellerTotal)}</span>
    </div>

    <hr class="divider">

    <div class="section-label">Customer details</div>
    <div class="info-box">
      <div class="row"><span class="lbl">Name</span><span class="val">${customerName}</span></div>
      <div class="row" style="margin-top:6px"><span class="lbl">Delivery</span><span class="val">${deliveryType}</span></div>
      ${address ? `<div class="row" style="margin-top:6px"><span class="lbl">Address</span><span class="val">${address}</span></div>` : ''}
      ${notes ? `<div class="row" style="margin-top:6px"><span class="lbl">Notes</span><span class="val">${notes}</span></div>` : ''}
    </div>

    <hr class="divider">

    <div class="section-label">Drop-off instructions</div>
    <div class="info-box" style="background:#fff8f0;border:1px solid #ffe0b2">
      <div style="font-size:14px;color:#333;line-height:1.9">
        <strong>1. Prepare your item(s)</strong><br>
        Pack securely and label the package clearly with the order reference: <strong>${esc(orderRef)}</strong><br><br>
        <strong>2. Arrange drop-off with Umzila logistics</strong><br>
        You will be contacted via WhatsApp to coordinate a convenient drop-off or collection time.<br><br>
        <strong>3. Mark as fulfilled in your dashboard</strong><br>
        Once you have handed over the item(s), log in and mark the order as fulfilled.
      </div>
    </div>

    <div class="cta">
      <a href="${esc(site)}/login-admin.html" class="btn">Log In to Dashboard &rarr;</a>
    </div>
    <p class="note">Your full order details, customer contact info, and fulfilment tools are in your seller dashboard.</p>
  </div>
  <div class="ft">
    <strong><a href="${esc(site)}">Umzila</a></strong> &mdash; campus marketplace<br>
    <a href="mailto:sellers@umzila.store">sellers@umzila.store</a>
  </div>
</div>
</body>
</html>`;
}

// ── Order confirmation email builder ─────────────────────────────────────────
function buildOrderConfirmationEmail(order, pfData, siteUrl) {
    const site      = siteUrl || '';
    const orderRef  = order.order_number || pfData.m_payment_id || 'N/A';
    const firstName = (order.customer_name || pfData.name_first || 'there').split(/\s+/)[0];
    const items     = Array.isArray(order.items) ? order.items : [];

    const fmt = (n) => 'R' + (parseFloat(n) || 0).toFixed(2);

    // Normalise field names — cart items use various conventions
    const getName  = (i) => i.title || i.name || i.item_name   || 'Item';
    const getPrice = (i) => parseFloat(i.price || i.unit_price  || 0);
    const getQty   = (i) => parseInt(i.qty   || i.quantity      || 1, 10);
    const getImg   = (i) => i.img || i.image_url || i.image     || '';
    const getSize  = (i) => i.size || i.variant  || '';

    const subtotal  = items.reduce((s, i) => s + getPrice(i) * getQty(i), 0);
    const discount  = parseFloat(order.discount || 0);
    const shipping  = parseFloat(order.shipping_cost || 0);
    const total     = parseFloat(order.total || subtotal - discount + shipping);

    const productItems = items.filter(i => i.listing_type !== 'service');
    const serviceItems = items.filter(i => i.listing_type === 'service');

    const renderItemRow = (item) => {
        const img   = getImg(item);
        const name  = esc(getName(item));
        const isService = item.listing_type === 'service';
        const size  = getSize(item) ? `<span style="color:#888;font-size:12px"> — ${esc(String(getSize(item)))}</span>` : '';
        const qty   = getQty(item);
        const price = getPrice(item);
        const line  = fmt(price * qty);
        const typeIcon = isService ? '🔧' : '🛍️';

        const imgHtml = img
            ? `<td style="padding:10px 12px 10px 0;vertical-align:top;width:72px">
                 <img src="${esc(img)}" width="68" height="68" alt="${name}" style="border-radius:8px;object-fit:cover;display:block;border:1px solid #eaecf0" />
               </td>`
            : `<td style="padding:10px 12px 10px 0;vertical-align:top;width:72px">
                 <div style="width:68px;height:68px;background:#f0f4ff;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:22px">${typeIcon}</div>
               </td>`;

        return `<tr>
          ${imgHtml}
          <td style="padding:10px 0;vertical-align:top">
            <div style="font-size:14px;font-weight:600;color:#1a1a2e;line-height:1.4">${name}${size}</div>
            <div style="font-size:13px;color:#666;margin-top:3px">${qty} × ${fmt(price)}</div>
          </td>
          <td style="padding:10px 0 10px 12px;vertical-align:top;text-align:right;white-space:nowrap">
            <div style="font-size:14px;font-weight:700;color:#0a2f66">${line}</div>
          </td>
        </tr>`;
    };

    const itemsHtml = items.map(renderItemRow).join('\n');

    // Build service next-steps section if order contains services
    const hasItemDropoff = serviceItems.some(i => i.fulfillment_type === 'item_dropoff');
    const serviceNextStepsHtml = serviceItems.length > 0 ? `
    <hr style="border:none;border-top:1px solid #eaecf0;margin:24px 0">
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:18px 20px;margin:16px 0">
      <div style="font-size:15px;font-weight:700;color:#166534;margin-bottom:10px">🔧 Your Service Order — What happens next</div>
      <ol style="margin:0;padding-left:20px;color:#374151;font-size:13px;line-height:2">
        <li>The seller will <strong>review and accept your service request within 24 hours</strong>.</li>
        ${hasItemDropoff ? `<li>Once accepted, <strong>bring your item to the Umzila collection point at UKZN Westville campus</strong>. Umzila will hand it to the seller.</li>` : ''}
        <li>The seller completes the service and marks it done with proof.</li>
        <li>Your item is returned to the campus collection point for you to collect or have delivered.</li>
      </ol>
      <div style="margin-top:12px;font-size:12px;color:#6b7280">Order ref: <strong>${esc(orderRef)}</strong> — check your seller dashboard or contact support if you need updates.</div>
    </div>` : '';

    const discountRow = discount > 0
        ? `<tr><td style="padding:4px 0;color:#555;font-size:14px">Discount${order.coupon_code ? ` (${esc(order.coupon_code)})` : ''}</td><td style="padding:4px 0;text-align:right;color:#28a745;font-weight:600;font-size:14px">-${fmt(discount)}</td></tr>`
        : '';

    const shippingRow = shipping > 0
        ? `<tr><td style="padding:4px 0;color:#555;font-size:14px">Delivery fee</td><td style="padding:4px 0;text-align:right;color:#555;font-size:14px">${fmt(shipping)}</td></tr>`
        : `<tr><td style="padding:4px 0;color:#555;font-size:14px">Delivery fee</td><td style="padding:4px 0;text-align:right;color:#555;font-size:14px">Included</td></tr>`;

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif}
  .wrap{max-width:580px;margin:40px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.09)}
  .hdr{background:#0a2f66;padding:30px 40px;text-align:center}
  .hdr h1{color:#fff;margin:0 0 4px;font-size:22px;font-weight:800;letter-spacing:-0.5px}
  .hdr p{color:rgba(255,255,255,0.7);margin:0;font-size:13px}
  .badge{display:inline-block;background:#28a745;color:#fff;font-size:12px;font-weight:700;padding:4px 14px;border-radius:999px;margin-top:12px;letter-spacing:.5px}
  .bd{padding:32px 40px}
  .bd h2{color:#0a2f66;margin:0 0 6px;font-size:19px;font-weight:700}
  .bd p{color:#555;line-height:1.7;margin:0 0 14px;font-size:14px}
  .ref-box{background:#f0f4ff;border-radius:8px;padding:12px 16px;margin:16px 0;font-size:13px;color:#0a2f66;font-weight:600}
  .items-table{width:100%;border-collapse:collapse;margin:20px 0}
  .divider{border:none;border-top:1px solid #eaecf0;margin:20px 0}
  .summary-table{width:100%;border-collapse:collapse}
  .total-row td{padding:8px 0;font-size:16px;font-weight:800;color:#0a2f66;border-top:2px solid #eaecf0}
  .cta{text-align:center;margin:24px 0 8px}
  .btn{display:inline-block;background:#e0284f;color:#fff !important;padding:14px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px}
  .ft{background:#f4f6fb;padding:18px 40px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0}
  .ft a{color:#0a2f66;text-decoration:none}
  @media(max-width:480px){.bd{padding:24px 20px}.hdr{padding:24px 20px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>Umzila</h1>
    <p>Your order has been confirmed</p>
    <span class="badge">✓ PAYMENT CONFIRMED</span>
  </div>
  <div class="bd">
    <h2>Thanks, ${esc(firstName)}! 🎉</h2>
    <p>We've received your payment and your order is now being processed. Your items may come from one or more campus sellers — each seller will prepare their items and hand them to our logistics team, who will bundle and deliver everything together to your selected area.</p>

    <div class="ref-box">Order reference: <strong>${esc(orderRef)}</strong></div>

    <table class="items-table">
      <tbody>
        ${itemsHtml}
      </tbody>
    </table>

    <hr class="divider">

    <table class="summary-table">
      <tbody>
        <tr><td style="padding:4px 0;color:#555;font-size:14px">Subtotal</td><td style="padding:4px 0;text-align:right;color:#555;font-size:14px">${fmt(subtotal)}</td></tr>
        ${discountRow}
        ${shippingRow}
        <tr class="total-row"><td>Total paid</td><td style="text-align:right">${fmt(total)}</td></tr>
      </tbody>
    </table>

    ${serviceNextStepsHtml}

    <div class="cta">
      <a href="${esc(site)}/profile.html" class="btn">View My Orders &rarr;</a>
    </div>

    <p style="font-size:13px;color:#888;text-align:center;margin-top:8px">
      Questions? <a href="mailto:support@umzila.store" style="color:#0a2f66">support@umzila.store</a>
    </p>
  </div>
  <div class="ft">
    <strong><a href="${esc(site)}">Umzila</a></strong> &mdash; campus marketplace<br>
    <a href="mailto:orders@umzila.store">orders@umzila.store</a>
  </div>
</div>
</body>
</html>`;
}

// ── Welcome email builder ─────────────────────────────────────────────────────
function esc(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildWelcomeEmail(firstName, email, shopName, siteUrl) {
    const site = siteUrl || '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif}
  .wrap{max-width:580px;margin:40px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.09)}
  .hdr{background:#0a2f66;padding:32px 40px;text-align:center}
  .hdr h1{color:#fff;margin:0 0 6px;font-size:22px;font-weight:700}
  .hdr p{color:rgba(255,255,255,0.75);margin:0;font-size:14px}
  .badge{display:inline-block;background:#e0284f;color:#fff;font-size:12px;font-weight:700;padding:4px 12px;border-radius:999px;margin-top:12px;letter-spacing:.5px}
  .bd{padding:36px 40px}
  .bd h2{color:#0a2f66;margin:0 0 14px;font-size:20px}
  .bd p{color:#444;line-height:1.7;margin:0 0 16px;font-size:15px}
  .cta{text-align:center;margin:28px 0 24px}
  .btn{display:inline-block;background:#e0284f;color:#fff;padding:15px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:16px}
  .info-box{background:#f0f4ff;border-radius:10px;padding:20px 24px;margin:24px 0}
  .info-box h3{color:#0a2f66;margin:0 0 14px;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  .info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e0e7f7;font-size:14px}
  .info-row:last-child{border-bottom:none;padding-bottom:0}
  .info-row .label{color:#666;font-weight:600}
  .info-row .val{color:#0a2f66;font-weight:700}
  .steps-box{background:#fff8f0;border:1px solid #ffe0b2;border-radius:10px;padding:20px 24px;margin:20px 0}
  .steps-box h3{color:#e65100;margin:0 0 12px;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  .steps-box ol{margin:0;padding-left:20px;color:#333;font-size:14px}
  .steps-box li{margin-bottom:10px;line-height:1.6}
  .note{font-size:13px;color:#888;line-height:1.6;background:#f9f9f9;border-radius:8px;padding:14px 18px;margin:20px 0}
  .ft{background:#f4f6fb;padding:20px 40px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0}
  .ft a{color:#0a2f66;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>Umzila Sellers</h1>
    <p>Your seller account is now active</p>
    <span class="badge">OFFICIAL SELLER</span>
  </div>
  <div class="bd">
    <h2>Welcome aboard, ${esc(firstName)}!</h2>
    <p>Your payment was confirmed and your seller account for <strong>${esc(shopName || 'your shop')}</strong> is now fully activated. You are officially an Umzila seller — congratulations!</p>
    <div class="cta">
      <a href="${site}/seller-dashboard.html" class="btn">Go to Seller Dashboard &rarr;</a>
    </div>
    <div class="info-box">
      <h3>Your login details</h3>
      <div class="info-row"><span class="label">Email</span><span class="val">${esc(email)}</span></div>
      <div class="info-row"><span class="label">Password</span><span class="val">The password you created before payment</span></div>
    </div>
    <div class="steps-box">
      <h3>Your next steps</h3>
      <ol>
        <li>Log in to your <a href="${site}/seller-dashboard.html" style="color:#e65100;font-weight:600">Seller Dashboard</a></li>
        <li>Finish setting up your store — add a shop description, logo, and contact details</li>
        <li>Create your first product and start selling</li>
      </ol>
    </div>
    <div class="note">
      <strong>How to log in next time:</strong><br>
      Go to <a href="${site}" style="color:#0a2f66">umzila.store</a> &rarr; click <strong>About</strong> &rarr; select <strong>Sign In</strong> &rarr; enter your email and password.
    </div>
    <p style="font-size:14px;color:#888">Questions? <a href="mailto:support@umzila.store" style="color:#0a2f66">support@umzila.store</a></p>
  </div>
  <div class="ft">
    <strong><a href="${site}">Umzila</a></strong> &mdash; campus marketplace<br>
    <a href="mailto:sellers@umzila.store">sellers@umzila.store</a>
  </div>
</div>
</body>
</html>`;
}

// ── Service order records creator ────────────────────────────────────────────
async function createServiceOrderRecords(supabase, order) {
    const items = Array.isArray(order.items) ? order.items : [];
    const serviceItems = items.filter(i => i.listing_type === 'service');
    if (!serviceItems.length) return;

    const now = new Date();
    for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        if (item.listing_type !== 'service') continue;
        const deadlineHours = item.acceptance_deadline_hours || 24;
        const deadline = new Date(now.getTime() + deadlineHours * 60 * 60 * 1000);

        const { error: insErr } = await supabase.from('order_item_statuses').insert([{
            order_id: order.id,
            item_index: idx,
            product_id: item.product_id || item.id || null,
            seller_id: item.seller_id || null,
            listing_type: 'service',
            service_status: 'pending_acceptance',
            acceptance_deadline: deadline.toISOString(),
            status: 'pending_acceptance'
        }]);
        if (insErr) console.error('ITN: service record insert error', insErr);

        // In-app notification for seller
        if (item.seller_id) {
            await supabase.from('seller_notifications').insert([{
                seller_id: item.seller_id,
                type: 'service_order',
                title: '🔧 New service order — action required',
                body: `New service order for "${item.name || item.title || 'service'}". You must accept within ${deadlineHours}h or it will be cancelled.`,
                related_order_id: order.id,
                metadata: { order_number: order.order_number, item_index: idx },
                is_read: false
            }]).catch(e => console.error('ITN: service notification insert error', e));
        }
    }
    console.log('ITN: created service order records for order', order.id);
}

// ── Seller service order email builder ───────────────────────────────────────
function buildSellerServiceOrderEmail(seller, sellerItems, order, pfData, siteUrl) {
    const site     = siteUrl || '';
    const orderRef = order.order_number || pfData.m_payment_id || 'N/A';
    const shopName = esc(seller.shop_name || 'Your Store');
    const fmt      = (n) => 'R' + (parseFloat(n) || 0).toFixed(2);
    const getName  = (i) => i.title || i.name || 'Service';
    const getPrice = (i) => parseFloat(i.price || i.unit_price || 0);
    const getQty   = (i) => parseInt(i.qty || i.quantity || 1, 10);
    const deadlineHours = sellerItems.find(i => i.acceptance_deadline_hours)?.acceptance_deadline_hours || 24;

    const serviceTotal = sellerItems.reduce((s, i) => s + getPrice(i) * getQty(i), 0);

    const itemsHtml = sellerItems.map(item => {
        const img = item.img || item.image_url || item.image || '';
        const name = esc(getName(item));
        const ft = item.fulfillment_type || 'item_dropoff';
        const ftLabel = ft === 'item_dropoff' ? '📦 Item drop-off' : ft === 'in_person' ? '📍 In-person' : '💻 Digital';
        const turnaround = item.service_turnaround ? ` · Turnaround: ${esc(item.service_turnaround)}` : '';
        const imgCell = img
            ? `<td style="padding:10px 12px 10px 0;vertical-align:top;width:68px"><img src="${esc(img)}" width="64" height="64" alt="${name}" style="border-radius:8px;object-fit:cover;display:block;border:1px solid #eaecf0"></td>`
            : `<td style="padding:10px 12px 10px 0;vertical-align:top;width:68px"><div style="width:64px;height:64px;background:#f0fdf4;border-radius:8px;text-align:center;line-height:64px;font-size:22px">🔧</div></td>`;
        return `<tr>${imgCell}
          <td style="padding:10px 0;vertical-align:top">
            <div style="font-size:14px;font-weight:700;color:#1a1a2e">${name}</div>
            <div style="font-size:12px;color:#16a34a;margin-top:3px;font-weight:600">${ftLabel}${turnaround}</div>
            <div style="font-size:13px;color:#666;margin-top:3px">Qty: ${getQty(item)} · ${fmt(getPrice(item))} each</div>
          </td>
          <td style="padding:10px 0 10px 12px;vertical-align:top;text-align:right;font-size:14px;font-weight:700;color:#0a2f66;white-space:nowrap">${fmt(getPrice(item) * getQty(item))}</td>
        </tr>`;
    }).join('');

    const customerName = esc(order.customer_name || pfData.name_first || 'Customer');

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif}
  .wrap{max-width:580px;margin:40px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.09)}
  .hdr{background:#166534;padding:28px 36px;text-align:center}
  .hdr h1{color:#fff;margin:0 0 4px;font-size:20px;font-weight:800}
  .hdr p{color:rgba(255,255,255,.75);margin:0;font-size:13px}
  .badge{display:inline-block;background:#16a34a;color:#fff;font-size:12px;font-weight:700;padding:4px 14px;border-radius:999px;margin-top:10px;letter-spacing:.5px;border:2px solid rgba(255,255,255,.3)}
  .bd{padding:28px 36px}
  .urgency{background:#fff7ed;border:2px solid #fb923c;border-radius:10px;padding:14px 18px;margin:0 0 20px;font-size:14px;color:#9a3412;font-weight:600;text-align:center}
  .ref-box{background:#f0fdf4;border-radius:8px;padding:10px 14px;margin:14px 0;font-size:13px;color:#166534;font-weight:600}
  .items-table{width:100%;border-collapse:collapse;margin:16px 0}
  .action-box{background:#f0f4ff;border-radius:10px;padding:18px 20px;margin:20px 0;text-align:center}
  .btn{display:inline-block;background:#0a2f66;color:#fff !important;padding:14px 32px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px}
  .steps{background:#f9fafb;border-radius:8px;padding:14px 18px;margin:16px 0;font-size:13px;color:#374151;line-height:1.8}
  .ft{background:#f4f6fb;padding:16px 36px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0}
  .ft a{color:#0a2f66;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>Umzila — Service Order</h1>
    <p>${shopName}</p>
    <span class="badge">🔧 ACTION REQUIRED</span>
  </div>
  <div class="bd">
    <div class="urgency">⏰ You must accept this service order within <strong>${deadlineHours} hours</strong> or it will be automatically cancelled.</div>
    <p style="color:#374151;font-size:14px;margin:0 0 14px">A customer has placed a service order. Log in to your seller dashboard to <strong>accept or reject</strong> this request.</p>
    <div class="ref-box">Order reference: <strong>${esc(orderRef)}</strong> · Customer: ${customerName}</div>
    <table class="items-table"><tbody>${itemsHtml}</tbody></table>
    <div style="text-align:right;font-size:15px;font-weight:700;color:#0a2f66;margin-bottom:16px">Service total: ${fmt(serviceTotal)}</div>
    <div class="action-box">
      <div style="font-size:14px;font-weight:600;color:#0a2f66;margin-bottom:12px">Log in to accept or reject this service order</div>
      <a href="${esc(site)}/seller-dashboard.html" class="btn">Go to Seller Dashboard &rarr;</a>
    </div>
    <div class="steps">
      <strong>Once accepted:</strong>
      <ol style="margin:8px 0 0;padding-left:18px">
        <li>The customer will be notified and will drop off their item at the Umzila campus collection point.</li>
        <li>Umzila will hand the item to you.</li>
        <li>Complete the service and mark it done in your dashboard (with a completion note).</li>
        <li>Hand the item back to Umzila for return to the customer.</li>
      </ol>
    </div>
    <p style="font-size:13px;color:#888;text-align:center">Questions? <a href="mailto:support@umzila.store" style="color:#0a2f66">support@umzila.store</a></p>
  </div>
  <div class="ft">
    <strong><a href="${esc(site)}">Umzila</a></strong> &mdash; campus marketplace<br>
    <a href="mailto:sellers@umzila.store">sellers@umzila.store</a>
  </div>
</div>
</body>
</html>`;
}

// ── Admin CHA-CHING! order notification ──────────────────────────────────────
async function sendAdminOrderNotification(supabase, order, pfData) {
    const RESEND_KEY    = process.env.RESEND_API_KEY || '';
    const SITE_BASE_URL = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');
    if (!RESEND_KEY) return;

    const adminEmailsRaw = process.env.ADMIN_EMAILS || '';
    const adminEmails = adminEmailsRaw.split(',').map(e => e.trim()).filter(Boolean);
    if (!adminEmails.length) return;

    const orderRef   = order.order_number || pfData.m_payment_id || 'N/A';
    const total      = parseFloat(order.total || pfData.amount_gross || 0);
    const fmt        = (n) => 'R' + (parseFloat(n) || 0).toFixed(2);
    const escA       = (s) => (s || '').toString().replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

    const items = Array.isArray(order.items) ? order.items : [];

    // Group items by seller, fetch shop names
    const productIds = [...new Set(items.map(i => i.id || i.product_id).filter(Boolean))];
    let storeMap = {};
    if (productIds.length) {
        const { data: products } = await supabase
            .from('products')
            .select('id, seller_id')
            .in('id', productIds);
        if (products && products.length) {
            const sellerIds = [...new Set(products.map(p => p.seller_id).filter(Boolean))];
            const { data: sellers } = await supabase
                .from('sellers')
                .select('id, shop_name')
                .in('id', sellerIds);
            const sellerNameMap = {};
            (sellers || []).forEach(s => { sellerNameMap[s.id] = s.shop_name || 'Unknown Store'; });
            const prodSellerMap = {};
            products.forEach(p => { prodSellerMap[p.id] = p.seller_id; });
            items.forEach(item => {
                const pid = item.id || item.product_id;
                const sellerId = prodSellerMap[pid];
                const shopName = sellerId ? (sellerNameMap[sellerId] || 'Unknown Store') : 'Unknown Store';
                if (!storeMap[shopName]) storeMap[shopName] = [];
                storeMap[shopName].push(item);
            });
        }
    }
    if (!Object.keys(storeMap).length && items.length) {
        storeMap['Unknown Store'] = items;
    }

    const getName  = (i) => i.title || i.name || i.item_name || i.item || 'Item';
    const getPrice = (i) => parseFloat(i.price || i.unit_price || 0);
    const getQty   = (i) => parseInt(i.qty || i.quantity || 1, 10);
    const getSize  = (i) => i.size || i.variant || '';

    const storesHtml = Object.entries(storeMap).map(([shopName, shopItems]) => {
        const storeTotal = shopItems.reduce((s, i) => s + getPrice(i) * getQty(i), 0);
        const itemsHtml = shopItems.map(item => {
            const size = getSize(item) ? ` <span style="color:#888">&middot; ${escA(String(getSize(item)))}</span>` : '';
            return `<tr>
              <td style="padding:6px 0;font-size:13px;color:#1a1a2e">${escA(getName(item))}${size}</td>
              <td style="padding:6px 0;font-size:13px;color:#555;text-align:center">&times;${getQty(item)}</td>
              <td style="padding:6px 0;font-size:13px;font-weight:700;color:#0a2f66;text-align:right">${fmt(getPrice(item) * getQty(item))}</td>
            </tr>`;
        }).join('');
        return `<div style="background:#f8faff;border-radius:10px;padding:14px 18px;margin-bottom:12px;border:1px solid #e8eef8">
          <div style="font-size:13px;font-weight:800;color:#0a2f66;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">&#127978; ${escA(shopName)}</div>
          <table style="width:100%;border-collapse:collapse"><tbody>${itemsHtml}</tbody></table>
          <div style="border-top:1px solid #dde6f5;margin-top:8px;padding-top:8px;display:flex;justify-content:space-between;font-size:13px;font-weight:700;color:#0a2f66">
            <span>Store subtotal</span><span>${fmt(storeTotal)}</span>
          </div>
        </div>`;
    }).join('');

    const customerName   = escA(order.customer_name || pfData.name_first || 'Customer');
    const customerEmail  = escA(order.customer_email || pfData.email_address || '—');
    const deliveryType   = escA(order.label || 'Standard Delivery');
    const address        = [order.delivery_address, order.city, order.province, order.postal_code].filter(Boolean).map(escA).join(', ');
    const notes          = order.notes ? escA(order.notes) : '';
    const storeCount     = Object.keys(storeMap).length;
    const storeNames     = Object.keys(storeMap).map(escA).join(', ');

    const adminHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#0a2f66;font-family:system-ui,-apple-system,sans-serif}
  .wrap{max-width:600px;margin:30px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.25)}
  .hdr{background:linear-gradient(135deg,#0a2f66 0%,#1a4f8a 100%);padding:36px 40px;text-align:center}
  .cha{font-size:42px;font-weight:900;color:#ffd700;letter-spacing:2px;margin:0;text-shadow:0 2px 8px rgba(0,0,0,0.3)}
  .sub{color:rgba(255,255,255,0.85);font-size:15px;margin:8px 0 0}
  .total-badge{display:inline-block;background:#ffd700;color:#0a2f66;font-size:26px;font-weight:900;padding:10px 28px;border-radius:999px;margin-top:16px}
  .bd{padding:28px 36px}
  .lbl{font-size:11px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:1px;margin:20px 0 8px}
  .ibox{background:#f8f9fb;border-radius:10px;padding:14px 18px;font-size:14px;color:#333;line-height:1.9;margin-bottom:16px}
  .row{display:flex;gap:10px}
  .k{color:#888;min-width:110px;flex-shrink:0;font-size:13px}
  .v{color:#1a1a2e;font-weight:600;font-size:13px}
  .divider{border:none;border-top:1px solid #eaecf0;margin:20px 0}
  .ft{background:#f4f6fb;padding:16px 36px;text-align:center;font-size:12px;color:#aaa}
  .ft a{color:#0a2f66;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <div class="cha">CHA-CHING! &#128176;</div>
    <div class="sub">New order just dropped on Umzila</div>
    <div class="total-badge">${fmt(total)}</div>
  </div>
  <div class="bd">
    <div class="lbl">Order Reference</div>
    <div class="ibox" style="font-size:16px;font-weight:800;color:#0a2f66">${escA(orderRef)}</div>

    <div class="lbl">Customer</div>
    <div class="ibox">
      <div class="row"><span class="k">Name</span><span class="v">${customerName}</span></div>
      <div class="row" style="margin-top:4px"><span class="k">Email</span><span class="v">${customerEmail}</span></div>
      <div class="row" style="margin-top:4px"><span class="k">Delivery</span><span class="v">${deliveryType}</span></div>
      ${address ? `<div class="row" style="margin-top:4px"><span class="k">Address</span><span class="v">${address}</span></div>` : ''}
      ${notes ? `<div class="row" style="margin-top:4px"><span class="k">Notes</span><span class="v">${notes}</span></div>` : ''}
    </div>

    <div class="lbl">Stores in this order (${storeCount}): ${storeNames}</div>
    ${storesHtml}

    <hr class="divider">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0">
      <span style="font-size:16px;font-weight:800;color:#0a2f66">Total paid</span>
      <span style="font-size:22px;font-weight:900;color:#0a2f66">${fmt(total)}</span>
    </div>
  </div>
  <div class="ft">
    <strong><a href="${escA(SITE_BASE_URL)}">Umzila</a></strong> admin alert
  </div>
</div>
</body>
</html>`;

    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from:    'Umzila Orders <orders@umzila.store>',
                to:      adminEmails,
                subject: `CHA-CHING! New order — ${fmt(total)} — ${orderRef}`,
                html:    adminHtml
            })
        });
        if (!res.ok) {
            console.error('ITN admin notify: email failed', res.status, await res.text());
        } else {
            console.log('ITN admin notify: CHA-CHING! email sent for order', orderRef);
        }
    } catch (e) {
        console.error('ITN admin notify: error', e);
    }
}
