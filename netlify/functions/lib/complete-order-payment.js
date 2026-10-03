// netlify/functions/lib/complete-order-payment.js
//
// "Mark this order paid, then run every one-time post-payment task" — extracted
// verbatim from payfast-itn.js's payment_status==='COMPLETE' handling so it can
// be called from a second, equally-authoritative trigger point: charge-payfast-
// token.js's synchronous PayFast API success response (the saved-card one-click
// flow), which has no real ITN to correlate back to an order (its request to
// PayFast's ad-hoc/subscriptions API never includes m_payment_id, so PayFast's
// ITN for that charge type can't be matched to a row the way the redirect
// flow's form-submitted m_payment_id can). Rather than let that charge type
// silently never get marked paid, both callers now share this one function.
//
// Deliberately NOT included here (stays payfast-itn.js-only): signature
// verification, the CANCELLED branch, and seller-enrollment/ad-campaign
// activation — none of those apply to a saved-card charge, which is only ever
// used for a regular buyer product/service order.
const { computeDiscount } = require('./discounts');

function esc(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// pfResponse is either the real ITN payload (payfast-itn.js) or the ad-hoc
// charge API's JSON response (charge-payfast-token.js) — read defensively
// throughout; every field on it is a fallback for data that primarily comes
// from the order row itself, so a caller supplying a sparse/different-shaped
// object here is safe by design, not just by luck.
async function completeOrderPayment(supabase, { mPaymentId, pfPaymentId, pfResponse, siteUrl }) {
    const pfData = pfResponse || {};

    // Fetch order before update — needed for idempotency check, coupon/cart data, confirmation + seller emails
    const { data: existingOrder } = await supabase
        .from('orders')
        .select('id, payment_status, user_id, customer_email, customer_name, coupon_code, items, total, discount, shipping_cost, order_number, label, delivery_address, city, province, postal_code, notes, pending_card_name')
        .eq('m_payment_id', mPaymentId)
        .maybeSingle();

    const alreadyPaid = existingOrder?.payment_status === 'paid';

    // Mark order paid
    const { error: orderErr } = await supabase
        .from('orders')
        .update({
            order_status:   'paid',
            payment_status: 'paid',
            pf_payment_id:  pfPaymentId,
            pf_response:    pfData,
            paid_at:        new Date().toISOString()
        })
        .eq('m_payment_id', mPaymentId);

    if (orderErr) {
        console.error('completeOrderPayment: error updating order:', orderErr);
        return;
    }
    console.log('completeOrderPayment: order marked as paid:', mPaymentId);

    // Run post-payment tasks only once (guard against ITN retries / a stray
    // ITN arriving after the saved-card path already completed this order)
    if (alreadyPaid || !existingOrder) return;

    // ── Backfill user_id if order was placed on buyer's behalf ─
    const buyerEmailForLookup = (existingOrder.customer_email || pfData.email_address || '').toLowerCase();
    let resolvedUserId = existingOrder.user_id || null;
    if (buyerEmailForLookup) {
        try {
            const { data: buyerProfile } = await supabase
                .from('profiles')
                .select('user_id')
                .ilike('email', buyerEmailForLookup)
                .maybeSingle();
            if (buyerProfile?.user_id && buyerProfile.user_id !== existingOrder.user_id) {
                await supabase.from('orders').update({ user_id: buyerProfile.user_id }).eq('id', existingOrder.id);
                console.log('completeOrderPayment: user_id corrected to buyer profile for order', existingOrder.id);
            }
            if (buyerProfile?.user_id) resolvedUserId = buyerProfile.user_id;
        } catch (e) { console.warn('completeOrderPayment: user_id backfill error:', e.message); }
    }

    // ── Capture PayFast token as a new saved payment method ───
    // Additive/best-effort only — never blocks order fulfillment. pfData.token
    // is only ever present on the redirect flow's ITN (a "save my card"
    // checkout); the saved-card charge path has no new token to capture here.
    // `onConflict` + `ignoreDuplicates` makes this INSERT ... ON CONFLICT DO
    // NOTHING — a defensive guard against ITN retries re-delivering the same
    // token, not an update path (last_used_at is only ever set by an actual
    // charge in charge-payfast-token.js, never here).
    if (pfData.token && resolvedUserId) {
        try {
            const { error: pmErr } = await supabase.from('payment_methods')
                .upsert(
                    { user_id: resolvedUserId, payfast_token: pfData.token, display_name: existingOrder.pending_card_name || null },
                    { onConflict: 'user_id,payfast_token', ignoreDuplicates: true }
                );
            if (pmErr) console.warn('completeOrderPayment: payment_methods save error:', pmErr.message);
            else console.log('completeOrderPayment: payment_methods saved for user_id', resolvedUserId);
        } catch (tokenErr) {
            console.warn('completeOrderPayment: payment_methods save error:', tokenErr.message);
        }
    }

    // ── Consume the coupon ──────────────────────────────────
    // Two code generations: legacy single-global-use codes (referral/mystery-
    // gift/gift) still just flip `used`, exactly as before. New multi-use
    // admin/seller codes instead record a per-buyer redemption row.
    if (existingOrder.coupon_code) {
        const { data: codeRow } = await supabase
            .from('discount_codes')
            .select('*')
            .eq('code', existingOrder.coupon_code)
            .maybeSingle();

        if (codeRow?.multi_use) {
            if (!resolvedUserId) {
                console.warn('completeOrderPayment: multi-use coupon on a guest order — skipping redemption record (should not happen, discount should have been 0)', existingOrder.coupon_code);
            } else {
                try {
                    const orderItems = Array.isArray(existingOrder.items)
                        ? existingOrder.items
                        : (typeof existingOrder.items === 'string' ? JSON.parse(existingOrder.items) : []);
                    const { matchedItems } = computeDiscount(codeRow, orderItems);
                    const { error: redErr } = await supabase.from('discount_redemptions').insert([{
                        discount_code_id: codeRow.id,
                        code: codeRow.code,
                        order_id: existingOrder.id,
                        order_number: existingOrder.order_number,
                        user_id: resolvedUserId,
                        email: buyerEmailForLookup || null,
                        discount_amount: existingOrder.discount || 0,
                        matched_items: matchedItems
                    }]);
                    // 23505 = unique violation on (discount_code_id, user_id) —
                    // an ITN retry hitting the same redemption again; expected, not an error.
                    if (redErr && redErr.code !== '23505') {
                        console.error('completeOrderPayment: error recording redemption:', redErr);
                    } else if (!redErr) {
                        console.log('completeOrderPayment: redemption recorded for coupon', codeRow.code, 'user', resolvedUserId);
                    }
                } catch (redemptionErr) {
                    console.error('completeOrderPayment: redemption recording error:', redemptionErr.message);
                }
            }
        } else if (codeRow?.type === 'gift_voucher') {
            // Gift vouchers are a balance, not a one-shot code: spending R350
            // of a R550 voucher leaves R200 on it. The optimistic amount match
            // keeps a concurrent second use from double-spending.
            const spent = Number(existingOrder.discount) || 0;
            const remaining = Math.max(0, Math.round((Number(codeRow.amount) - spent) * 100) / 100);
            const { error: gvErr } = await supabase
                .from('discount_codes')
                .update({ amount: remaining, used: remaining <= 0, used_at: remaining <= 0 ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
                .eq('id', codeRow.id)
                .eq('amount', codeRow.amount);
            if (gvErr) console.error('completeOrderPayment: gift voucher balance update error:', gvErr);
            else console.log('completeOrderPayment: gift voucher', codeRow.code, 'balance now', remaining);
        } else {
            const { error: dcErr } = await supabase
                .from('discount_codes')
                .update({ used: true, used_at: new Date().toISOString() })
                .eq('code', existingOrder.coupon_code)
                .eq('used', false); // idempotent — only updates if not already consumed
            if (dcErr) console.error('completeOrderPayment: error marking coupon used:', dcErr);
            else console.log('completeOrderPayment: coupon marked used:', existingOrder.coupon_code);
        }
    }

    // ── Clear buyer's Supabase cart ────────────────────────
    if (existingOrder.user_id) {
        try {
            await supabase
                .from('carts')
                .delete()
                .eq('user_id', existingOrder.user_id);
            console.log('completeOrderPayment: cart cleared for user:', existingOrder.user_id);
        } catch (cartErr) {
            console.warn('completeOrderPayment: cart clear error:', cartErr.message);
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
            console.warn('completeOrderPayment: referral_tracking conversion error:', refErr.message);
        }
    }

    // ── Send buyer order confirmation email ────────────────
    // Only for product orders, not seller enrollment
    if (pfData.custom_str1 !== 'seller_enrollment' && existingOrder.label !== 'seller_enrollment' && existingOrder.customer_email) {
        const RESEND_KEY = process.env.RESEND_API_KEY || '';
        if (RESEND_KEY) {
            try {
                const emailRes = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        from:    'Umzila <orders@umzila.store>',
                        to:      [existingOrder.customer_email],
                        subject: `Order confirmed — ${existingOrder.order_number || mPaymentId}`,
                        html:    buildOrderConfirmationEmail(existingOrder, pfData, mPaymentId, siteUrl)
                    })
                });
                if (!emailRes.ok) {
                    const t = await emailRes.text();
                    console.error('completeOrderPayment: order confirmation email failed', emailRes.status, t);
                } else {
                    console.log('completeOrderPayment: order confirmation email sent for order', existingOrder.order_number || mPaymentId);
                }
            } catch (emailErr) {
                console.error('completeOrderPayment: order confirmation email error', emailErr);
            }
        }

        // ── Create service order records (pending_acceptance) ──
        await createServiceOrderRecords(supabase, existingOrder).catch(
            e => console.error('completeOrderPayment: service order records error', e)
        );

        // ── Gift vouchers bought in this order → codes + email ──
        await issueGiftVouchers(supabase, existingOrder, siteUrl).catch(
            e => console.error('completeOrderPayment: gift voucher issue error', e)
        );

        // ── Send per-seller new order notification emails ──
        await sendSellerOrderNotifications(supabase, existingOrder, mPaymentId, siteUrl).catch(
            e => console.error('completeOrderPayment: seller notifications error', e)
        );

        // ── Send admin CHA-CHING! notification ──
        await sendAdminOrderNotification(supabase, existingOrder, mPaymentId, siteUrl).catch(
            e => console.error('completeOrderPayment: admin notification error', e)
        );
    }

    // ── Decrement product stock + populate order_items ─────
    try {
        const orderItems = Array.isArray(existingOrder.items)
            ? existingOrder.items
            : (typeof existingOrder.items === 'string' ? JSON.parse(existingOrder.items) : []);

        const orderItemInserts = [];
        for (const item of orderItems) {
            const pid = item.product_id || item.id;
            const qty = Number(item.quantity || item.qty || 1);
            if (!pid || qty <= 0) continue;

            // Update order_count ranking signal (fire-and-forget — never blocks completion).
            // Query builders have no .catch(): calling it threw here and aborted
            // this whole loop, so paid orders never decremented stock.
            supabase.rpc('increment_product_engagement', {
                p_product_id:  pid,
                p_counter_col: 'order_count',
                p_increment:   qty,
                p_engaged_at:  new Date().toISOString()
            }).then(({ error }) => { if (error) console.warn('completeOrderPayment: ranking update failed for', pid, error.message); });

            if (item.listing_type !== 'service') {
                // Decrement product-level stock
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
                    if (stockErr) console.warn('completeOrderPayment: stock decrement failed for product', pid);
                }

                // Decrement variant-level stock if variant_id present
                const vid = item.variant_id || item.variantId;
                if (vid) {
                    const { data: variant } = await supabase
                        .from('product_variants')
                        .select('stock')
                        .eq('id', vid)
                        .maybeSingle();
                    if (variant != null) {
                        const newVStock = Math.max(0, (Number(variant.stock) || 0) - qty);
                        const { error: vstockErr } = await supabase
                            .from('product_variants')
                            .update({ stock: newVStock })
                            .eq('id', vid);
                        if (vstockErr) console.warn('completeOrderPayment: variant stock decrement failed for variant', vid);
                    }
                }
            } else {
                console.log('completeOrderPayment: skipping stock decrement for service item', pid);
            }

            // Collect for order_items batch insert
            const unitPrice = parseFloat(item.price || item.unit_price || 0);
            orderItemInserts.push({
                order_id: existingOrder.id,
                product_id: pid,
                seller_id: item.seller_id || null,
                product_name: item.title || item.name || item.item_name || 'Item',
                quantity: qty,
                unit_price: unitPrice,
                subtotal: unitPrice * qty,
                selected_size: item.size || item.variant || null,
                fulfillment_status: 'pending'
            });
        }

        // Insert order_items rows in one batch
        if (orderItemInserts.length) {
            const { error: itemsErr } = await supabase
                .from('order_items')
                .insert(orderItemInserts);
            if (itemsErr) console.warn('completeOrderPayment: order_items insert error:', itemsErr.message);
            else console.log('completeOrderPayment: inserted', orderItemInserts.length, 'order_items for order', existingOrder.id);
        }
    } catch (stockError) {
        console.warn('completeOrderPayment: stock decrement error:', stockError.message);
    }
}

// ── Service kinds ────────────────────────────────────────────────────────────
// Every service line is one of these, derived from what validate-cart.js
// stamped onto the item from the listing. Same rules as serviceKind() in
// checkout.html / checkout-success.html / profile.html / seller-dashboard.html
// (no shared JS module in this codebase) — see docs/systems/service-orders.md.
//   booking        in-person at a booked time   (quad ride, booked haircut)
//   in_person      in-person, time arranged later (braids by chat)
//   dropoff_return rep collects item, seller works, rep returns it (shoe cleaning)
//   dropoff_kept   rep collects item, nothing comes back
//   digital        buyer sends details/files, seller delivers online (CV, printing)
//   voucher        gift voucher — code emailed straight away
function serviceKind(item) {
    if (!item || item.listing_type !== 'service') return null;
    if (item.is_voucher) return 'voucher';
    if (item.fulfillment_type === 'item_dropoff') return item.item_returned === false ? 'dropoff_kept' : 'dropoff_return';
    if (item.fulfillment_type === 'in_person') return (item.booking_start_at || item.booking_mode === 'scheduled') ? 'booking' : 'in_person';
    return 'digital';
}
function sastWhen(iso) {
    return new Date(iso).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}
// Buyer-facing "what happens next", per kind (HTML-safe: callers pass esc).
function buyerServiceSteps(item, esc) {
    const kind = serviceKind(item);
    const confirmStep = item.instant_confirm
        ? 'It\'s <strong>confirmed</strong> — no need to wait for the seller.'
        : 'The seller <strong>confirms within ' + (item.acceptance_deadline_hours || 24) + ' hours</strong>. If they can\'t, Umzila refunds you in full.';
    switch (kind) {
        case 'booking': return [
            item.booking_start_at ? 'You\'re booked for <strong>' + esc(sastWhen(item.booking_start_at)) + '</strong>' + ((item.booking_units || item.quantity) > 1 ? ' (' + esc(String(item.booking_units || item.quantity)) + ' booked)' : '') + '.' : 'Your time is booked.',
            confirmStep,
            item.service_location ? 'Go to <strong>' + esc(item.service_location) + '</strong> a few minutes before your time.' : 'Arrive a few minutes before your time.',
            'Show your order reference if asked. The seller marks it done afterwards.'
        ];
        case 'in_person': return [
            confirmStep,
            'Once confirmed, you and the seller get each other\'s contact details to agree on a time and place.',
            'Meet up — the seller marks the service done afterwards.'
        ];
        case 'dropoff_return': return [
            confirmStep,
            'An Umzila rep <strong>collects your item</strong> at the time you picked and photographs its condition.',
            'The seller does the work and adds before/after photos.',
            'A rep <strong>delivers it back</strong> to you at the return time you picked.'
        ];
        case 'dropoff_kept': return [
            confirmStep,
            'An Umzila rep <strong>collects your item</strong> at the time you picked.',
            'The seller completes the service — you\'ll see the completion photos in your order.'
        ];
        case 'voucher': return [
            'Your voucher code is in a <strong>separate email</strong> — star it so it\'s easy to find.',
            'It works on anything from this store and any balance stays on the code.'
        ];
        default: return [
            confirmStep,
            'The seller works on it using the details/files you sent.',
            'Your finished work appears in your order when it\'s done.'
        ];
    }
}

// ── Service order records creator ────────────────────────────────────────────
async function createServiceOrderRecords(supabase, order) {
    const items = Array.isArray(order.items) ? order.items : [];
    const serviceItems = items.filter(i => i.listing_type === 'service');
    if (!serviceItems.length) return;

    const now = new Date();
    // order.items is written by the browser at checkout, so per-listing
    // behaviour (instant confirmation) is re-read from products, not trusted.
    const serviceProductIds = [...new Set(serviceItems.map(i => i.product_id || i.id).filter(Boolean))];
    const { data: svcProducts } = serviceProductIds.length
        ? await supabase.from('products').select('id, instant_confirm, fulfillment_type, metadata').in('id', serviceProductIds)
        : { data: [] };
    const svcProductMap = {};
    (svcProducts || []).forEach(p => { svcProductMap[p.id] = p; });

    for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        if (item.listing_type !== 'service') continue;
        const productId = item.product_id || item.id || null;
        const productRow = svcProductMap[productId] || {};
        const isVoucher = !!(productRow.metadata && productRow.metadata.voucher === true);
        const instant = productRow.instant_confirm === true || isVoucher;
        const isDropoff = (productRow.fulfillment_type || item.fulfillment_type) === 'item_dropoff';
        const deadlineHours = item.acceptance_deadline_hours || 24;
        const deadline = new Date(now.getTime() + deadlineHours * 60 * 60 * 1000);
        const whenText = item.booking_start_at
            ? new Date(item.booking_start_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
            : null;
        const unitsText = item.booking_units && item.booking_units > 1 ? ` × ${item.booking_units}` : '';

        const { data: statusRow, error: insErr } = await supabase.from('order_item_statuses').insert([{
            order_id: order.id,
            item_index: idx,
            product_id: item.product_id || item.id || null,
            seller_id: item.seller_id || null,
            listing_type: 'service',
            // Instant-confirm listings (owner opted in, slot already
            // capacity-checked) skip the accept step entirely.
            // A gift voucher is fulfilled by the emailed code itself.
            service_status: isVoucher ? 'completed' : (instant ? 'accepted' : 'pending_acceptance'),
            accepted_at: instant ? now.toISOString() : null,
            service_completed_at: isVoucher ? now.toISOString() : null,
            acceptance_deadline: instant ? null : deadline.toISOString(),
            status: 'pending', // generic status enum is pending/fulfilled/delivered/disputed/refunded — 'pending_acceptance' is only valid for service_status
            // Snapshot the fulfillment shape at order time so a later seller
            // edit to the listing can't mutate an order already in flight.
            fulfillment_type: item.fulfillment_type || null,
            item_returned: item.item_returned !== false,
            // Only drop-off services involve a physical item handed over —
            // in-person/digital ones used to be saved as 'item' + rep
            // collect/deliver, which showed buyers collection steps for a haircut.
            intake_kind: isDropoff ? (item.intake_kind || 'item') : ((item.intake_kind && item.intake_kind !== 'item') ? item.intake_kind : 'none'),
            intake_response: item.intake || null,
            // Handoff/return choices, already clamped+priced server-side by
            // validate-cart.js (order.items is the checked-out snapshot) —
            // this stays a dumb copy, no re-validation logic added here.
            collection_method: !isDropoff ? 'none' : ((item.service_options && item.service_options.collection_method) || 'rep_collect'),
            collection_address: (item.service_options && item.service_options.collection_address) || null,
            collection_slot_start: (item.service_options && item.service_options.collection_slot_start) || null,
            collection_slot_end: (item.service_options && item.service_options.collection_slot_end) || null,
            return_method: (!isDropoff || item.item_returned === false) ? 'none' : ((item.service_options && item.service_options.return_method) || 'deliver'),
            return_address: item.item_returned === false ? null : ((item.service_options && item.service_options.return_address) || null),
            return_slot_start: item.item_returned === false ? null : ((item.service_options && item.service_options.return_slot_start) || null),
            return_slot_end: item.item_returned === false ? null : ((item.service_options && item.service_options.return_slot_end) || null)
        }]).select().single();
        if (insErr) console.error('completeOrderPayment: service record insert error', insErr);

        // Confirm any appointment slot hold taken at add-to-cart time — turns
        // the 30-minute hold into a real booking now that payment succeeded.
        // (Supabase query builders are thenables with no .catch() — read
        // { error } instead; a .catch() here threw and aborted this loop.)
        if (item.booking_id) {
            const { error: bookingErr } = await supabase.from('service_bookings')
                .update({ status: 'confirmed', order_id: order.id, order_item_status_id: statusRow ? statusRow.id : null, hold_expires_at: null })
                .eq('id', item.booking_id)
                .eq('product_id', productId)
                .eq('status', 'held');
            if (bookingErr) console.error('completeOrderPayment: booking confirm error', bookingErr);
        }

        // In-app notification for seller
        if (item.seller_id) {
            const { error: notifErr } = await supabase.from('seller_notifications').insert([{
                seller_id: item.seller_id,
                type: 'service_order',
                title: instant ? '📅 New booking confirmed' : '🔧 New service order — action required',
                body: instant
                    ? `"${item.name || item.title || 'service'}"${unitsText}${whenText ? ` on ${whenText}` : ''} is booked and paid.`
                    : `New service order for "${item.name || item.title || 'service'}"${unitsText}${whenText ? ` (${whenText})` : ''}. Please accept or decline within ${deadlineHours}h.`,
                related_order_id: order.id,
                metadata: { order_number: order.order_number, item_index: idx },
                is_read: false
            }]);
            if (notifErr) console.error('completeOrderPayment: service notification insert error', notifErr);
        }

        // Rep-pool broadcast for item_dropoff services only — nothing physical
        // to collect for in_person/digital, so no rep task is created for those.
        if (item.fulfillment_type === 'item_dropoff') {
            const dropoffBody = `"${item.name || item.title || 'service'}" — rep collection from buyer's address. Available once the seller accepts.`;
            const { error: repNotifErr } = await supabase.from('seller_notifications').insert([{
                seller_id: null,
                recipient_role: 'rep',
                recipient_user_id: null,
                type: 'service_dropoff_pending',
                title: '📦 New drop-off service to claim',
                body: dropoffBody,
                related_order_id: order.id,
                metadata: { order_number: order.order_number, item_index: idx },
                is_read: false
            }]);
            if (repNotifErr) console.error('completeOrderPayment: rep notification insert error', repNotifErr);
        }
    }
    console.log('completeOrderPayment: created service order records for order', order.id);
}

// ── Per-seller new order notification ────────────────────────────────────────
// Groups order items by their owning seller and sends one email per seller.
async function sendSellerOrderNotifications(supabase, order, mPaymentId, siteUrl) {
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) return;

    const RESEND_KEY = process.env.RESEND_API_KEY || '';
    if (!RESEND_KEY) return;

    // Collect all product IDs in this order
    const productIds = [...new Set(items.map(i => i.id || i.product_id).filter(Boolean))];
    if (!productIds.length) return;

    // Fetch products → get seller_id per product
    const { data: products, error: prodErr } = await supabase
        .from('products')
        .select('id, seller_id, instant_confirm')
        .in('id', productIds);

    if (prodErr || !products || !products.length) {
        console.warn('completeOrderPayment seller notify: product lookup failed', prodErr);
        return;
    }

    // Map product_id → seller_id
    const productToSeller = {};
    const instantProduct = {};
    products.forEach(p => { if (p.seller_id) productToSeller[p.id] = p.seller_id; instantProduct[p.id] = p.instant_confirm === true; });

    // Get unique seller IDs that appear in this order
    const sellerIds = [...new Set(Object.values(productToSeller))];
    if (!sellerIds.length) return;

    // Fetch active sellers with email
    const { data: sellers, error: sellerErr } = await supabase
        .from('sellers')
        .select('id, shop_name, email, user_id')
        .in('id', sellerIds)
        .eq('status', 'active');

    if (sellerErr || !sellers || !sellers.length) {
        console.warn('completeOrderPayment seller notify: seller lookup failed', sellerErr);
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
        // _instant comes from products (DB), never from the browser-written order.items.
        grouped[sellerId].push(Object.assign({}, item, { _instant: !!instantProduct[pid] }));
    });

    // Send one email per seller
    for (const [sellerId, sellerItems] of Object.entries(grouped)) {
        const seller = sellerMap[sellerId];
        if (!sellerItems.length) continue;
        // Store contact email plus every co-owner (seller_members) — each
        // owner of a store sees its orders in the dashboard, so they all get
        // told about new ones.
        // Many stores never saved a store email (sellers.email is null), and
        // those were silently skipped — fall back to the owner's account email.
        const recipients = seller.email ? [seller.email] : [];
        const { data: memberRows } = await supabase.from('seller_members').select('user_id').eq('seller_id', sellerId);
        const ownerRows = seller.user_id ? [{ user_id: seller.user_id }] : [];
        for (const m of ownerRows.concat(memberRows || [])) {
            const { data: u } = await supabase.auth.admin.getUserById(m.user_id);
            const e = u && u.user && u.user.email;
            if (e && !recipients.some(r => r.toLowerCase() === e.toLowerCase())) recipients.push(e);
        }
        if (!recipients.length) continue;

        const hasServices = sellerItems.some(i => i.listing_type === 'service');
        const allInstant = hasServices && sellerItems.filter(i => i.listing_type === 'service').every(i => i._instant);
        const allVouchers = hasServices && sellerItems.every(i => serviceKind(i) === 'voucher');
        const emailSubject = hasServices
            ? (allVouchers ? `🎁 Gift voucher sold — ${order.order_number || mPaymentId}`
                : allInstant ? `📅 New booking confirmed — ${order.order_number || mPaymentId}` : `🔧 New service order — accept required — ${order.order_number || mPaymentId}`)
            : `New order for ${seller.shop_name || 'your store'} — ${order.order_number || mPaymentId}`;
        const emailHtml = hasServices
            ? buildSellerServiceOrderEmail(seller, sellerItems, order, mPaymentId, siteUrl)
            : buildSellerOrderEmail(seller, sellerItems, order, mPaymentId, siteUrl);

        try {
            const res = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from:    'Umzila Sellers <sellers@umzila.store>',
                    to:      recipients,
                    subject: emailSubject,
                    html:    emailHtml
                })
            });
            if (!res.ok) {
                console.error('completeOrderPayment seller notify: email failed for', seller.email, res.status, await res.text());
            } else {
                console.log('completeOrderPayment seller notify: email sent to', seller.email, '—', sellerItems.length, 'item(s)');
            }
        } catch (e) {
            console.error('completeOrderPayment seller notify: email error for', seller.email, e);
        }
    }
}

function buildSellerOrderEmail(seller, sellerItems, order, mPaymentId, siteUrl) {
    const site     = siteUrl || '';
    const orderRef = order.order_number || mPaymentId || 'N/A';
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
    const customerName = esc(order.customer_name || 'Customer');
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
    <strong><a href="${esc(site)}">Umzila</a></strong> &mdash; Durban&rsquo;s best local businesses<br>
    <a href="mailto:sellers@umzila.store">sellers@umzila.store</a>
  </div>
</div>
</body>
</html>`;
}

// ── Order confirmation email builder ─────────────────────────────────────────
function buildOrderConfirmationEmail(order, pfData, mPaymentId, siteUrl) {
    const site      = siteUrl || '';
    const orderRef  = order.order_number || mPaymentId || 'N/A';
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
        const size  = (getSize(item) && !(isService && getSize(item) === 'One Size')) ? `<span style="color:#888;font-size:12px"> — ${esc(String(getSize(item)))}</span>` : '';
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

        let handoffLine = '';
        if (item.fulfillment_type === 'item_dropoff') {
            const opts = item.service_options || {};
            const collectPart = `rep collects from ${esc(opts.collection_address || 'your address')}`;
            const returnPart = item.item_returned === false
                ? null
                : `delivered to ${esc(opts.return_address || 'your address')}`;
            handoffLine = `<div style="font-size:12px;color:#166534;margin-top:3px">Handoff: ${collectPart}.${returnPart ? ` Return: ${returnPart}.` : ''}</div>`;
        }
        if (item.booking_start_at) {
            const when = new Date(item.booking_start_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
            handoffLine += `<div style="font-size:13px;color:#0a2f66;margin-top:3px;font-weight:700">📅 Booked for ${esc(when)}</div>`;
        }

        return `<tr>
          ${imgHtml}
          <td style="padding:10px 0;vertical-align:top">
            <div style="font-size:14px;font-weight:600;color:#1a1a2e;line-height:1.4">${name}${size}</div>
            <div style="font-size:13px;color:#666;margin-top:3px">${qty} × ${fmt(price)}</div>
            ${handoffLine}
          </td>
          <td style="padding:10px 0 10px 12px;vertical-align:top;text-align:right;white-space:nowrap">
            <div style="font-size:14px;font-weight:700;color:#0a2f66">${line}</div>
          </td>
        </tr>`;
    };

    const itemsHtml = items.map(renderItemRow).join('\n');

    // What happens next — one block per service line, worded for its kind
    // (a quad booking, a shoe clean and a gift voucher all differ).
    const kindIcon = { booking: '📅', in_person: '🤝', dropoff_return: '👟', dropoff_kept: '📦', digital: '💻', voucher: '🎁' };
    const serviceNextStepsHtml = serviceItems.length > 0 ? `
    <hr style="border:none;border-top:1px solid #eaecf0;margin:24px 0">
    ${serviceItems.map(item => `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:16px 20px;margin:12px 0">
      <div style="font-size:15px;font-weight:700;color:#166534;margin-bottom:8px">${kindIcon[serviceKind(item)] || '🔧'} ${esc(item.title || item.name || 'Your service')} — what happens next</div>
      <ol style="margin:0;padding-left:20px;color:#374151;font-size:13px;line-height:1.9">
        ${buyerServiceSteps(item, esc).map(st => `<li>${st}</li>`).join('')}
      </ol>
    </div>`).join('')}
    <div style="margin-top:4px;font-size:12px;color:#6b7280">Order ref: <strong>${esc(orderRef)}</strong> — track it under <em>My orders</em> in your Umzila profile.</div>` : '';

    // Opening line: only talk about delivery when something is delivered.
    const hasPhysical = items.some(i => (i.listing_type || 'product') !== 'service');
    const onlyVouchers = serviceItems.length > 0 && !hasPhysical && serviceItems.every(i => serviceKind(i) === 'voucher');
    const introText = hasPhysical
        ? 'We\'ve received your payment and your order is being prepared. Your items may come from one or more local stores — each seller prepares their items and our logistics team delivers them to you.'
        : onlyVouchers
            ? 'Payment received — your gift voucher code is on its way in a separate email.'
            : 'Payment received — you\'re all set. Here\'s exactly what happens next.';

    const discountRow = discount > 0
        ? `<tr><td style="padding:4px 0;color:#555;font-size:14px">Discount${order.coupon_code ? ` (${esc(order.coupon_code)})` : ''}</td><td style="padding:4px 0;text-align:right;color:#28a745;font-weight:600;font-size:14px">-${fmt(discount)}</td></tr>`
        : '';

    // Split the single logistics total into up to three rows — product
    // delivery, item collection, return delivery — each shown only when
    // nonzero, computed from the per-item service_fees snapshot.
    const serviceCollectionTotal = items.reduce((s, i) => s + ((i.service_fees && i.service_fees.collection) || 0), 0);
    const serviceReturnTotal     = items.reduce((s, i) => s + ((i.service_fees && i.service_fees.return_delivery) || 0), 0);
    const productDeliveryFee     = Math.max(0, shipping - serviceCollectionTotal - serviceReturnTotal);

    const feeRow = (label, amount) => amount > 0
        ? `<tr><td style="padding:4px 0;color:#555;font-size:14px">${label}</td><td style="padding:4px 0;text-align:right;color:#555;font-size:14px">${fmt(amount)}</td></tr>`
        : '';
    const shippingRow = productDeliveryFee > 0
        ? feeRow('Delivery fee', productDeliveryFee)
        : `<tr><td style="padding:4px 0;color:#555;font-size:14px">Delivery fee</td><td style="padding:4px 0;text-align:right;color:#555;font-size:14px">Free</td></tr>`;
    const collectionRow = feeRow('Item collection', serviceCollectionTotal);
    const returnDeliveryRow = feeRow('Return delivery', serviceReturnTotal);

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
    <p>${introText}</p>

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
        ${collectionRow}
        ${returnDeliveryRow}
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
    <strong><a href="${esc(site)}">Umzila</a></strong> &mdash; Durban&rsquo;s best local businesses<br>
    <a href="mailto:orders@umzila.store">orders@umzila.store</a>
  </div>
</div>
</body>
</html>`;
}

// ── Seller service order email builder ───────────────────────────────────────
function buildSellerServiceOrderEmail(seller, sellerItems, order, mPaymentId, siteUrl) {
    const site     = siteUrl || '';
    const orderRef = order.order_number || mPaymentId || 'N/A';
    const shopName = esc(seller.shop_name || 'Your Store');
    const fmt      = (n) => 'R' + (parseFloat(n) || 0).toFixed(2);
    const getName  = (i) => i.title || i.name || 'Service';
    const getPrice = (i) => parseFloat(i.price || i.unit_price || 0);
    const getQty   = (i) => parseInt(i.qty || i.quantity || 1, 10);
    const deadlineHours = sellerItems.find(i => i.acceptance_deadline_hours)?.acceptance_deadline_hours || 24;
    const allInstant = sellerItems.filter(i => i.listing_type === 'service').every(i => i._instant);
    const allVouchers = sellerItems.every(i => serviceKind(i) === 'voucher');
    const bookingWhen = (i) => i.booking_start_at
        ? new Date(i.booking_start_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
        : '';

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
            ${bookingWhen(item) ? `<div style="font-size:13px;color:#0a2f66;margin-top:3px;font-weight:700">📅 ${esc(bookingWhen(item))}</div>` : ''}
            <div style="font-size:13px;color:#666;margin-top:3px">Qty: ${getQty(item)} · ${fmt(getPrice(item))} each</div>
          </td>
          <td style="padding:10px 0 10px 12px;vertical-align:top;text-align:right;font-size:14px;font-weight:700;color:#0a2f66;white-space:nowrap">${fmt(getPrice(item) * getQty(item))}</td>
        </tr>`;
    }).join('');

    const customerName = esc(order.customer_name || 'Customer');

    // Drop-off services move a physical item customer -> seller -> customer;
    // in-person/digital ones don't, so they get the short version.
    const hasDropoff = sellerItems.some(i => (i.fulfillment_type || 'item_dropoff') === 'item_dropoff');
    const stepsHtml = hasDropoff
        ? `<li>The customer will be notified. Umzila collects the item from the customer and drops it off with you &mdash; or, for services where you collect items yourself, you pick it up from the customer.</li>
        <li>Complete the service and mark it done in your dashboard (with a completion note).</li>
        <li>The item goes back the same way: Umzila collects it from you and returns it to the customer, or you return it yourself if you collected it.</li>`
        : allInstant
        ? `<li>The customer has their confirmation and booked time.</li>
        <li>Welcome them at the booked time, then mark it done in your dashboard.</li>`
        : `<li>The customer will be notified.</li>
        <li>Complete the service and mark it done in your dashboard (with a completion note).</li>`;

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
    <h1>${allVouchers ? 'Umzila — Gift Voucher Sale' : 'Umzila — Service Order'}</h1>
    <p>${shopName}</p>
    <span class="badge">${allVouchers ? '🎁 VOUCHER SOLD' : allInstant ? '📅 BOOKED &amp; PAID' : '🔧 ACTION REQUIRED'}</span>
  </div>
  <div class="bd">
    ${allVouchers
      ? `<div class="urgency" style="background:#f0fdf4;border-color:#22c55e;color:#166534">🎁 Gift voucher sold &mdash; the code was emailed to the buyer. Nothing to do now; it can be spent on anything in your store.</div>`
      : allInstant
      ? `<div class="urgency" style="background:#f0fdf4;border-color:#22c55e;color:#166534">✅ Confirmed and paid &mdash; no action needed. Be ready at the booked time.</div>
    <p style="color:#374151;font-size:14px;margin:0 0 14px">A customer has booked with you. It's in the <strong>Bookings</strong> tab of your seller dashboard.</p>`
      : `<div class="urgency">⏰ Please accept or decline within <strong>${deadlineHours} hours</strong> — the buyer is waiting, and declined orders are refunded.</div>
    <p style="color:#374151;font-size:14px;margin:0 0 14px">A customer has placed a service order. Log in to your seller dashboard to <strong>accept or reject</strong> this request.</p>`}
    <div class="ref-box">Order reference: <strong>${esc(orderRef)}</strong> · Customer: ${customerName}</div>
    <table class="items-table"><tbody>${itemsHtml}</tbody></table>
    <div style="text-align:right;font-size:15px;font-weight:700;color:#0a2f66;margin-bottom:16px">Service total: ${fmt(serviceTotal)}</div>
    <div class="action-box">
      <div style="font-size:14px;font-weight:600;color:#0a2f66;margin-bottom:12px">${allInstant ? 'See all your upcoming bookings' : 'Log in to accept or reject this service order'}</div>
      <a href="${esc(site)}/seller-dashboard.html" class="btn">Go to Seller Dashboard &rarr;</a>
    </div>
    <div class="steps">
      <strong>${allInstant ? 'Next:' : 'Once accepted:'}</strong>
      <ol style="margin:8px 0 0;padding-left:18px">
        ${stepsHtml}
      </ol>
    </div>
    <p style="font-size:13px;color:#888;text-align:center">Questions? <a href="mailto:support@umzila.store" style="color:#0a2f66">support@umzila.store</a></p>
  </div>
  <div class="ft">
    <strong><a href="${esc(site)}">Umzila</a></strong> &mdash; Durban&rsquo;s best local businesses<br>
    <a href="mailto:sellers@umzila.store">sellers@umzila.store</a>
  </div>
</div>
</body>
</html>`;
}

// ── Admin CHA-CHING! order notification ──────────────────────────────────────
async function sendAdminOrderNotification(supabase, order, mPaymentId, siteUrl) {
    const RESEND_KEY = process.env.RESEND_API_KEY || '';
    if (!RESEND_KEY) return;

    const adminEmailsRaw = process.env.ADMIN_EMAILS || '';
    const adminEmails = adminEmailsRaw.split(',').map(e => e.trim()).filter(Boolean);
    if (!adminEmails.length) return;

    const orderRef   = order.order_number || mPaymentId || 'N/A';
    const total      = parseFloat(order.total || 0);
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

    const customerName   = escA(order.customer_name || 'Customer');
    const customerEmail  = escA(order.customer_email || '—');
    const deliveryType   = escA(order.label || 'Standard Delivery');
    const address        = [order.delivery_address, order.city, order.province, order.postal_code].filter(Boolean).map(escA).join(', ');
    const notes          = order.notes ? escA(order.notes) : '';
    const storeCount     = Object.keys(storeMap).length;
    const storeNames     = Object.keys(storeMap).map(escA).join(', ');
    const siteUrlSafe    = siteUrl || '';

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
    <strong><a href="${escA(siteUrlSafe)}">Umzila</a></strong> admin alert
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
            console.error('completeOrderPayment admin notify: email failed', res.status, await res.text());
        } else {
            console.log('completeOrderPayment admin notify: CHA-CHING! email sent for order', orderRef);
        }
    } catch (e) {
        console.error('completeOrderPayment admin notify: error', e);
    }
}

// ── Gift vouchers ────────────────────────────────────────────────────────────
// A listing with products.metadata.voucher = true is a gift voucher for its
// store. Each unit bought becomes one discount_codes row of type
// 'gift_voucher': store credit worth the price paid, usable on anything that
// store sells (rides, services, merch), spendable over several orders until
// the balance runs out (see the gift_voucher branch above), valid 3 years
// (the Consumer Protection Act minimum for prepaid vouchers).
const VOUCHER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
function voucherCode(prefix) {
    const crypto = require('crypto');
    const bytes = crypto.randomBytes(8);
    let out = '';
    for (let i = 0; i < 8; i++) out += VOUCHER_ALPHABET[bytes[i] % VOUCHER_ALPHABET.length];
    return `${prefix}-${out.slice(0, 4)}-${out.slice(4)}`;
}

async function issueGiftVouchers(supabase, order, siteUrl) {
    const items = Array.isArray(order.items) ? order.items : [];
    const ids = [...new Set(items.map(i => i.product_id || i.id).filter(Boolean))];
    if (!ids.length || !order.customer_email) return;
    // Voucher-ness and value come from products (DB), never order.items.
    const { data: prods } = await supabase.from('products')
        .select('id, name, price, sale, sale_price, seller_id, metadata').in('id', ids);
    const voucherProducts = {};
    (prods || []).forEach(p => { if (p.metadata && p.metadata.voucher === true) voucherProducts[p.id] = p; });
    if (!Object.keys(voucherProducts).length) return;

    const sellerIds = [...new Set(Object.values(voucherProducts).map(p => p.seller_id))];
    const { data: sellers } = await supabase.from('sellers').select('id, shop_name, slug').in('id', sellerIds);
    const sellerMap = {};
    (sellers || []).forEach(sr => { sellerMap[sr.id] = sr; });

    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 3);
    const issued = [];
    for (const item of items) {
        const product = voucherProducts[item.product_id || item.id];
        if (!product) continue;
        const seller = sellerMap[product.seller_id] || {};
        const value = Number(product.sale && product.sale_price ? product.sale_price : product.price) || 0;
        const qty = Math.max(1, parseInt(item.quantity || item.qty || 1, 10));
        const prefix = (seller.slug || 'GIFT').replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase() || 'GIFT';
        for (let n = 0; n < qty; n++) {
            for (let attempt = 0; attempt < 4; attempt++) {
                const code = voucherCode(prefix);
                const { error } = await supabase.from('discount_codes').insert([{
                    code, type: 'gift_voucher', amount: value, used: false, multi_use: false,
                    seller_id: product.seller_id, scope: 'order', status: 'active',
                    expires_at: expires.toISOString(),
                    referral_code: order.order_number || null // which order bought it
                }]);
                if (!error) { issued.push({ code, value, product, seller }); break; }
                if (error.code !== '23505') { console.error('issueGiftVouchers: insert error', error); break; }
            }
        }
    }
    if (!issued.length) return;

    const RESEND_KEY = process.env.RESEND_API_KEY || '';
    if (!RESEND_KEY) { console.warn('issueGiftVouchers: RESEND_API_KEY not set — codes issued but not emailed'); return; }
    const shopNames = [...new Set(issued.map(v => v.seller.shop_name).filter(Boolean))];
    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: 'Umzila <orders@umzila.store>',
                to: [order.customer_email],
                subject: `🎁 Your ${shopNames.join(' & ') || 'gift'} voucher${issued.length > 1 ? 's' : ''} — star this email`,
                html: buildGiftVoucherEmail(order, issued, expires, siteUrl)
            })
        });
        if (!res.ok) console.error('issueGiftVouchers: email failed', res.status, await res.text());
    } catch (e) {
        console.error('issueGiftVouchers: email error', e);
    }
}

function buildGiftVoucherEmail(order, vouchers, expires, siteUrl) {
    const site = siteUrl || '';
    const fmt = n => 'R' + Number(n).toFixed(0);
    const expiryLabel = expires.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });
    const blocks = vouchers.map(v => {
        const shop = v.seller.shop_name || 'this store';
        const storeUrl = `${site}/${v.seller.slug || ''}`;
        const useUrl = `${storeUrl}?voucher=${encodeURIComponent(v.code)}`;
        // The share text is plain lines so it pastes cleanly anywhere; on
        // WhatsApp the store link also unfurls into a preview card.
        const shareText = [
            `🎁 Gift voucher for ${shop}`,
            `Code: ${v.code}`,
            `Worth ${fmt(v.value)} — use it on anything at ${shop}: bookings, rides, services or merch.`,
            `Valid until ${expiryLabel}. Can be used over more than one order until the balance runs out.`,
            `Use it here: ${useUrl}`
        ].join('\n');
        const waUrl = 'https://wa.me/?text=' + encodeURIComponent(shareText);
        return `
    <div style="border:2px dashed #e0284f;border-radius:14px;padding:22px;margin:18px 0;text-align:center;background:#fff">
      <div style="font-size:12px;letter-spacing:2px;color:#888;font-weight:700">GIFT VOUCHER · ${esc(shop.toUpperCase())}</div>
      <div style="font-family:monospace;font-size:28px;font-weight:800;color:#e0284f;letter-spacing:3px;margin:10px 0;user-select:all;-webkit-user-select:all">${esc(v.code)}</div>
      <div style="font-size:22px;font-weight:800;color:#0a2f66">${fmt(v.value)}</div>
      <div style="font-size:13px;color:#555;margin-top:6px"><strong>Storewide at ${esc(shop)}</strong> — any booking, ride, service or merch. Valid until ${esc(expiryLabel)}.</div>
      <div style="margin-top:16px">
        <a href="${esc(useUrl)}" style="display:inline-block;background:#0a2f66;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700;font-size:14px;margin:4px">Use it at ${esc(shop)} &rarr;</a>
        <a href="${esc(waUrl)}" style="display:inline-block;background:#25d366;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700;font-size:14px;margin:4px">Send on WhatsApp</a>
      </div>
      <div style="text-align:left;margin-top:18px">
        <div style="font-size:12px;color:#888;font-weight:700;margin-bottom:6px">COPY &amp; PASTE TO SHARE (select all of the box)</div>
        <div style="white-space:pre-wrap;font-family:monospace;font-size:12.5px;line-height:1.6;color:#1a1a2e;background:#f4f6fb;border-radius:10px;padding:12px 14px;user-select:all;-webkit-user-select:all">${esc(shareText)}</div>
      </div>
    </div>`;
    }).join('');

    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif">
<div style="max-width:580px;margin:32px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.09)">
  <div style="background:#0a2f66;padding:28px 32px;text-align:center">
    <div style="font-size:40px">🎁</div>
    <h1 style="color:#fff;margin:6px 0 4px;font-size:22px">Your gift voucher${vouchers.length > 1 ? 's are' : ' is'} here</h1>
    <p style="color:rgba(255,255,255,.75);margin:0;font-size:13px">Order ${esc(order.order_number || '')}</p>
  </div>
  <div style="padding:26px 32px">
    <div style="background:#fff7ed;border:2px solid #fb923c;border-radius:10px;padding:12px 16px;font-size:14px;color:#9a3412;font-weight:700;text-align:center">
      ⭐ Star this email now so you can find your voucher later.
    </div>
    <p style="color:#374151;font-size:15px;line-height:1.6;margin:18px 0 0">Give it to someone special (or keep it for yourself). Whoever has the code can use it — just open the link or enter the code at checkout.</p>
    ${blocks}
    <p style="color:#888;font-size:12px;line-height:1.6;margin:0">Treat the code like cash: anyone with it can spend it. Lost it? Reply to this email and we'll help.</p>
  </div>
  <div style="background:#f4f6fb;padding:16px 32px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0">
    <strong><a href="${esc(site)}" style="color:#0a2f66;text-decoration:none">Umzila</a></strong> &mdash; Durban&rsquo;s best local businesses
  </div>
</div></body></html>`;
}

module.exports = { completeOrderPayment };
