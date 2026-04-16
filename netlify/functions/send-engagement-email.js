const { createClient } = require('@supabase/supabase-js');

exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    // Verify JWT from Authorization header
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

    // Verify caller is admin or logistics using the user's JWT (anon key + user token)
    const supabaseAnon = createClient(supabaseUrl, process.env.SUPABASE_ANON_KEY || '', {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error: userErr } = await supabaseAnon.auth.getUser();
    if (userErr || !user) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };
    }

    // Check role using service role (bypasses RLS for the check itself)
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
        auth: { autoRefreshToken: false, persistSession: false }
    });

    const [{ data: adminRow }, { data: roleRow }] = await Promise.all([
        supabase.from('admins').select('id').eq('user_id', user.id).maybeSingle(),
        supabase.from('user_roles').select('role').eq('user_id', user.id).eq('is_active', true).in('role', ['admin', 'logistics']).maybeSingle()
    ]);

    if (!adminRow && !roleRow) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { customer_email, email_type, cart_items } = body;
    if (!customer_email || !email_type) {
        return { statusCode: 400, body: JSON.stringify({ error: 'customer_email and email_type required' }) };
    }
    if (!['free-delivery', 'discount'].includes(email_type)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'email_type must be free-delivery or discount' }) };
    }

    const esc = (s) => (s || '').toString().replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    const fmt = (n) => 'R' + (parseFloat(n) || 0).toFixed(2);

    const items = Array.isArray(cart_items) ? cart_items : [];

    const itemsHtml = items.length
        ? items.map(item => {
            const name = esc(item.name || item.title || 'Item');
            const qty  = item.quantity || item.qty || 1;
            const price = parseFloat(item.price || 0);
            const size  = item.size ? ` <span style="color:#888">· ${esc(item.size)}</span>` : '';
            return `<tr>
              <td style="padding:8px 0;font-size:14px;color:#1a1a2e;border-bottom:1px solid #f0f4ff">${name}${size}</td>
              <td style="padding:8px 0;font-size:14px;color:#555;text-align:center;border-bottom:1px solid #f0f4ff">&times;${qty}</td>
              <td style="padding:8px 0;font-size:14px;font-weight:700;color:#0a2f66;text-align:right;border-bottom:1px solid #f0f4ff">${fmt(price * qty)}</td>
            </tr>`;
        }).join('')
        : `<tr><td colspan="3" style="padding:12px 0;color:#888;font-size:13px">Your selected items</td></tr>`;

    let subject, headlineHtml, offerHtml;

    if (email_type === 'free-delivery') {
        subject = 'Your basket is waiting — free delivery inside!';
        headlineHtml = `<h2 style="color:#0a2f66;margin:0 0 8px;font-size:22px">You left something behind!</h2>
          <p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 20px">Good news — we're covering your delivery. Come back and complete your order with <strong>free delivery</strong>, on us.</p>`;
        offerHtml = `<div style="background:linear-gradient(135deg,#0a2f66,#1a4f8a);border-radius:12px;padding:20px 24px;text-align:center;margin:20px 0">
          <div style="font-size:13px;color:rgba(255,255,255,0.75);text-transform:uppercase;letter-spacing:1px;font-weight:700">Limited offer</div>
          <div style="font-size:26px;font-weight:900;color:#ffd700;margin:8px 0">FREE DELIVERY</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.75)">on your next order — no code needed</div>
        </div>`;
    } else {
        subject = 'Your basket is waiting — 10% off inside!';
        headlineHtml = `<h2 style="color:#0a2f66;margin:0 0 8px;font-size:22px">Come back and save 10%!</h2>
          <p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 20px">You left some items in your cart. Use the code below to get <strong>10% off</strong> your order when you complete checkout.</p>`;
        offerHtml = `<div style="background:linear-gradient(135deg,#0a2f66,#1a4f8a);border-radius:12px;padding:20px 24px;text-align:center;margin:20px 0">
          <div style="font-size:13px;color:rgba(255,255,255,0.75);text-transform:uppercase;letter-spacing:1px;font-weight:700">Your discount code</div>
          <div style="font-size:32px;font-weight:900;color:#ffd700;margin:8px 0;letter-spacing:3px">COMEBACK10</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.75)">10% off — apply at checkout</div>
        </div>`;
    }

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
    ${headlineHtml}
    ${offerHtml}

    ${items.length ? `
    <div style="font-size:11px;font-weight:800;color:#888;text-transform:uppercase;letter-spacing:1px;margin:20px 0 8px">Items in your cart</div>
    <div style="background:#f8faff;border-radius:10px;padding:14px 18px">
      <table style="width:100%;border-collapse:collapse"><tbody>${itemsHtml}</tbody></table>
    </div>` : ''}

    <div style="text-align:center;margin:28px 0 8px">
      <a href="${esc(SITE_BASE_URL)}" style="display:inline-block;background:#0a2f66;color:#fff;padding:14px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px">Complete my order</a>
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
                from:    'Umzila <orders@umzila.store>',
                to:      [customer_email],
                subject,
                html
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error('send-engagement-email: Resend error', res.status, errText);
            return { statusCode: 502, body: JSON.stringify({ error: 'Email send failed' }) };
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true })
        };
    } catch (e) {
        console.error('send-engagement-email: unexpected error', e);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
    }
};
