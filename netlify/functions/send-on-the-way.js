const { createClient } = require('@supabase/supabase-js');

const RESEND_RATE_LIMIT_MS = 2 * 60 * 60 * 1000; // 2h — a rep shouldn't be able to spam "we're off" repeatedly

function formatSAST(input, opts) {
    if (!input) return '';
    const d = input instanceof Date ? input : new Date(input);
    return d.toLocaleString('en-ZA', Object.assign({ timeZone: 'Africa/Johannesburg' }, opts));
}

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    const RESEND_KEY = process.env.RESEND_API_KEY || '';
    const SITE_BASE_URL = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');

    if (!supabaseUrl || !supabaseServiceKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server config error' }) };
    }
    if (!RESEND_KEY) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Email service not configured' }) };
    }

    const supabaseAnon = createClient(supabaseUrl, process.env.SUPABASE_ANON_KEY || '', {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: { user }, error: userErr } = await supabaseAnon.auth.getUser();
    if (userErr || !user) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
        auth: { autoRefreshToken: false, persistSession: false }
    });

    // Reps are admins for now — same check used to gate rep_availability writes.
    const { data: isAdmin } = await supabase.rpc('is_admin', { user_uuid: user.id });
    if (!isAdmin) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { status_id, leg } = body;
    if (!status_id || !['collect', 'deliver'].includes(leg)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'status_id and leg (collect|deliver) required' }) };
    }

    const { data: st, error: stErr } = await supabase
        .from('order_item_statuses')
        .select('id, order_id, item_index, fulfillment_type, service_status, collection_method, return_method, collection_slot_start, return_slot_start, otw_collect_sent_at, otw_deliver_sent_at')
        .eq('id', status_id)
        .maybeSingle();
    if (stErr || !st) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Service status not found' }) };
    }

    // A rep is only "on the way" if they're actually the one travelling —
    // buyer-dropoff / buyer-pickup legs have no rep trip to announce.
    const sentAtCol = leg === 'collect' ? 'otw_collect_sent_at' : 'otw_deliver_sent_at';
    if (leg === 'collect') {
        if (st.collection_method !== 'rep_collect') {
            return { statusCode: 400, body: JSON.stringify({ error: 'This item has no rep collection leg' }) };
        }
        // 'accepted' is the only status where a rep is actually about to go
        // collect — the seller hasn't even accepted the job before that.
        if (st.service_status !== 'accepted') {
            return { statusCode: 400, body: JSON.stringify({ error: 'Not ready for a collection on-the-way notice' }) };
        }
    } else {
        if (st.return_method !== 'deliver') {
            return { statusCode: 400, body: JSON.stringify({ error: 'This item has no rep delivery leg' }) };
        }
        // 'returned_to_umzila' means the rep already has the finished item in
        // hand and is now the one heading to the buyer.
        if (st.service_status !== 'returned_to_umzila') {
            return { statusCode: 400, body: JSON.stringify({ error: 'Not ready for a delivery on-the-way notice' }) };
        }
    }

    const lastSent = st[sentAtCol];
    if (lastSent && (Date.now() - new Date(lastSent).getTime()) < RESEND_RATE_LIMIT_MS) {
        return { statusCode: 409, body: JSON.stringify({ error: 'Already notified recently' }) };
    }

    const { data: order, error: orderErr } = await supabase
        .from('orders')
        .select('id, order_number, customer_email, items')
        .eq('id', st.order_id)
        .maybeSingle();
    if (orderErr || !order || !order.customer_email) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Order not found' }) };
    }

    const item = Array.isArray(order.items) ? order.items[st.item_index] : null;
    const itemName = item ? (item.title || item.name || 'your order') : 'your order';
    const orderRef = order.order_number || String(order.id).slice(0, 8).toUpperCase();
    const slotStart = leg === 'collect' ? st.collection_slot_start : st.return_slot_start;
    const slotLabel = slotStart
        ? `${formatSAST(slotStart, { weekday: 'short', day: 'numeric', month: 'short' })} around ${formatSAST(slotStart, { hour: '2-digit', minute: '2-digit', hour12: false })}`
        : null;

    const esc = (s) => (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const subject = "And we're off! 🛵 Your Umzila rep is on the move";
    const leadHtml = leg === 'collect'
        ? `<p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 8px">Your Umzila rep is heading out to collect <strong>${esc(itemName)}</strong> now${slotLabel ? ` — you picked <strong>${esc(slotLabel)}</strong>` : ''}. Have it ready to go!</p>`
        : `<p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 8px">Good news — <strong>${esc(itemName)}</strong> is finished and your Umzila rep is on the way to bring it to you${slotLabel ? `, around <strong>${esc(slotLabel)}</strong>` : ''}.</p>`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif">
<div style="max-width:580px;margin:30px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
  <div style="background:#0a2f66;padding:28px 36px;text-align:center">
    <div style="font-size:28px;font-weight:900;color:#fff;margin:0">Umzila</div>
    <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-top:4px">campus marketplace</div>
  </div>
  <div style="padding:32px 36px">
    <h2 style="color:#0a2f66;margin:0 0 12px;font-size:22px">And we're off! 🛵</h2>
    ${leadHtml}
    <div style="background:#f8faff;border-radius:10px;padding:14px 18px;margin:20px 0;font-size:13px;color:#555">
      Order <strong>#${esc(orderRef)}</strong>
    </div>
    <div style="text-align:center;margin:28px 0 8px">
      <a href="${esc(SITE_BASE_URL)}/profile.html" style="display:inline-block;background:#0a2f66;color:#fff;padding:14px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px">Track my order</a>
    </div>
  </div>
  <div style="background:#f4f6fb;padding:16px 36px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0">
    <strong><a href="${esc(SITE_BASE_URL)}" style="color:#0a2f66;text-decoration:none">Umzila</a></strong> &mdash; campus marketplace
  </div>
</div>
</body>
</html>`;

    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: 'Umzila <orders@umzila.store>',
                to: [order.customer_email],
                subject,
                html
            })
        });
        if (!res.ok) {
            const errText = await res.text();
            console.error('send-on-the-way: Resend error', res.status, errText);
            return { statusCode: 502, body: JSON.stringify({ error: 'Email send failed' }) };
        }
    } catch (e) {
        console.error('send-on-the-way: unexpected error', e);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
    }

    await supabase.from('order_item_statuses').update({ [sentAtCol]: new Date().toISOString() }).eq('id', status_id);

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
};
