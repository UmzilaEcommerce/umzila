// netlify/functions/send-stock-alerts.js
//
// Back-in-stock emails. Buyers tap "Notify me" on a sold-out item (store
// page or homepage modal), which inserts a stock_alerts row (product_id,
// email; one pending row per product+email). This scheduled function
// (netlify.toml, every 15 minutes) finds pending alerts whose product is
// back — visible, stock > 0, store active — sends ONE email per address
// listing everything that's back for them, and stamps notified_at so each
// alert is sent once. A product that's still sold out keeps waiting.
//
// Scheduled functions can't be called by URL in production, so nobody can
// trigger sends from outside.
const { createClient } = require('@supabase/supabase-js');

const MAX_EMAILS_PER_RUN = 40;   // stays well inside Resend's rate limits
const SEND_GAP_MS = 600;

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => { const v = Math.round(Number(n || 0) * 100) / 100; return 'R' + (v % 1 ? v.toFixed(2) : String(v)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function renderEmail(items, site) {
  const rows = items.map(it => `
    <tr><td style="padding:12px 0;border-bottom:1px solid #eef1f6">
      <table role="presentation" style="width:100%;border-collapse:collapse"><tr>
        ${it.image ? `<td style="width:72px;padding-right:14px;vertical-align:top"><img src="${esc(it.image)}" width="72" height="72" alt="" style="display:block;width:72px;height:72px;object-fit:cover;border-radius:10px"></td>` : ''}
        <td style="vertical-align:top">
          <div style="font-size:15px;font-weight:700;color:#0a2f66">${esc(it.name)}</div>
          <div style="font-size:13px;color:#6b7280;margin:2px 0 8px">${esc(it.shop)} · ${esc(money(it.price))}${it.stock < 5 ? ` · only ${it.stock} left` : ''}</div>
          <a href="${esc(it.url)}" style="display:inline-block;background:#0a2f66;color:#fff;padding:8px 16px;border-radius:999px;text-decoration:none;font-weight:700;font-size:13px">View it</a>
        </td>
      </tr></table>
    </td></tr>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif">
<div style="max-width:580px;margin:30px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
  <div style="background:#0a2f66;padding:26px 32px;text-align:center">
    <div style="font-size:28px;font-weight:900;color:#fff">Umzila</div>
    <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-top:4px">Durban&rsquo;s best local businesses</div>
  </div>
  <div style="padding:28px 32px">
    <h2 style="color:#0a2f66;margin:0 0 8px;font-size:22px">${items.length === 1 ? 'It&rsquo;s back in stock!' : 'They&rsquo;re back in stock!'}</h2>
    <p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 8px">You asked us to tell you when ${items.length === 1 ? 'this was' : 'these were'} available again. Stock can go quickly, so grab ${items.length === 1 ? 'it' : 'them'} while you can.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse">${rows}</table>
  </div>
  <div style="background:#f4f6fb;padding:16px 32px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0">
    You got this because you tapped &ldquo;Notify me&rdquo; on Umzila. It&rsquo;s a one-off: we won&rsquo;t email you about ${items.length === 1 ? 'this item' : 'these items'} again unless you ask.<br>
    <strong><a href="${esc(site)}" style="color:#0a2f66;text-decoration:none">Umzila</a></strong> &mdash; Durban&rsquo;s best local businesses
  </div>
</div></body></html>`;
}

exports.handler = async function () {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY || '';
  const SITE = (process.env.SITE_BASE_URL || process.env.URL || '').replace(/\/$/, '');
  if (!supabaseUrl || !supabaseKey || !RESEND_KEY || !SITE) {
    console.error('send-stock-alerts: missing configuration');
    return { statusCode: 500, body: 'config' };
  }
  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const { data: alerts, error } = await supabase.from('stock_alerts')
      .select('id, email, product_id').is('notified_at', null).order('created_at').limit(1000);
    if (error) throw error;
    if (!alerts || !alerts.length) return { statusCode: 200, body: 'nothing pending' };

    const productIds = [...new Set(alerts.map(a => a.product_id))];
    const { data: products, error: pErr } = await supabase.from('products')
      .select('id, name, image, price, sale, sale_price, stock, visible, seller_id, product_images!fk_product_images_product(url, image_order)')
      .in('id', productIds).eq('visible', true).gt('stock', 0);
    if (pErr) throw pErr;
    if (!products || !products.length) return { statusCode: 200, body: 'nothing back yet' };

    const { data: sellers } = await supabase.from('sellers')
      .select('id, slug, shop_name, status').in('id', [...new Set(products.map(p => p.seller_id))]);
    const sellerById = Object.fromEntries((sellers || []).map(s => [s.id, s]));
    const back = {};
    products.forEach(p => {
      const s = sellerById[p.seller_id];
      if (!s || s.status !== 'active') return;
      const imgs = (p.product_images || []).slice().sort((a, b) => (a.image_order || 0) - (b.image_order || 0));
      const price = p.sale && Number(p.sale_price) > 0 ? Number(p.sale_price) : Number(p.price);
      back[p.id] = {
        name: p.name, shop: s.shop_name, price, stock: p.stock,
        image: (imgs[0] && imgs[0].url) || p.image || '',
        url: SITE + '/' + s.slug + '?product=' + p.id
      };
    });

    // One email per address, listing everything that's back for them.
    const byEmail = {};
    alerts.forEach(a => {
      if (!back[a.product_id]) return;
      const key = String(a.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key)) return;
      (byEmail[key] = byEmail[key] || { ids: [], products: new Set() });
      byEmail[key].ids.push(a.id);
      byEmail[key].products.add(a.product_id);
    });

    let sent = 0;
    for (const [email, entry] of Object.entries(byEmail)) {
      if (sent >= MAX_EMAILS_PER_RUN) break; // the rest go out on the next run
      const items = [...entry.products].map(id => back[id]);
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Umzila <orders@umzila.store>',
          to: [email],
          subject: items.length === 1 ? `Back in stock: ${items[0].name}` : `${items.length} items you wanted are back in stock`,
          html: renderEmail(items, SITE)
        })
      });
      if (!res.ok) { console.error('send-stock-alerts: Resend error', res.status, await res.text()); continue; }
      const { error: uErr } = await supabase.from('stock_alerts').update({ notified_at: new Date().toISOString() }).in('id', entry.ids);
      if (uErr) console.error('send-stock-alerts: could not mark sent', uErr.message);
      sent++;
      await sleep(SEND_GAP_MS);
    }
    console.log('send-stock-alerts: sent', sent);
    return { statusCode: 200, body: 'sent ' + sent };
  } catch (e) {
    console.error('send-stock-alerts error', e);
    return { statusCode: 500, body: 'error' };
  }
};

// Exposed for local testing of the email layout.
exports._renderEmail = renderEmail;
