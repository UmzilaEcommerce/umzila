// netlify/functions/rate-delivery.js
//
// 1–5 star rating from the post-delivery email (lib/rating-email.js).
// Each star in the email is a link here:
//   GET  ?d=<delivery id>&t=<deliveries.tracking_token>&r=<1-5>
//        → a small page that shows the stars and saves the rating from the
//          browser (POST), so link-scanning mail filters that "open" links
//          can never record a rating. ≤3 stars asks "what went wrong?";
//          4–5 offers an optional comment.
//   POST { d, t, r, comment? } → saves into delivery_feedback (one row per
//          delivery: tapping another star or adding a comment updates it).
// The tracking token is the delivery's private link secret (same as
// track.html), so only the customer who got the email can rate. Seller and
// driver are resolved from the delivery's route, never from the request.
// Shows in admin → Deliveries → Recent Feedback (rating + message).
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const MAX_COMMENT = 1000;
const html = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
const json = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sameToken(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function loadDelivery(admin, d, t) {
  if (!/^[0-9a-f-]{36}$/i.test(String(d || ''))) return null;
  const { data } = await admin.from('deliveries')
    .select('id, order_id, customer_id, status, route_id, tracking_token, orders(customer_name, items)')
    .eq('id', d).maybeSingle();
  if (!data || !sameToken(data.tracking_token, t)) return null;
  return data;
}

function page(d, t, r, info) {
  const first = String((info && info.name) || '').trim().split(/\s+/)[0] || '';
  const store = (info && info.store) || 'your order';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Rate your delivery · Umzila</title>
<style>
body{margin:0;background:#f4f6fb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a2e;display:flex;justify-content:center;padding:28px 16px}
.c{background:#fff;max-width:440px;width:100%;border-radius:18px;padding:28px 22px;box-shadow:0 6px 28px rgba(0,0,0,.08);text-align:center}
.b{font-weight:900;color:#0a2f66;font-size:20px;margin-bottom:6px}h1{font-size:20px;margin:6px 0 4px}p{color:#555;font-size:14.5px;line-height:1.55;margin:0 0 14px}
.stars{display:flex;justify-content:center;gap:6px;margin:14px 0 6px}.stars button{border:0;background:none;font-size:40px;line-height:1;cursor:pointer;color:#d1d5db;padding:2px}
.stars button.on{color:#f59e0b}.lbl{font-size:13px;color:#6b7280;min-height:18px;margin-bottom:12px}
textarea{width:100%;box-sizing:border-box;min-height:110px;border:1.5px solid #d1d5db;border-radius:12px;padding:12px;font:inherit;font-size:15px;resize:vertical}
.go{width:100%;margin-top:10px;padding:14px;border:0;border-radius:999px;background:#0a2f66;color:#fff;font-weight:800;font-size:15px;cursor:pointer}.go[disabled]{opacity:.6}
.msg{font-size:13.5px;margin-top:10px;min-height:18px}.ok{color:#15803d}.err{color:#b91c1c}
</style></head><body><div class="c">
<div class="b">Umzila</div>
<h1>${first ? 'Thanks, ' + esc(first) + '!' : 'Thanks for rating!'}</h1>
<p>How was ${esc(store)}?</p>
<div class="stars" id="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-r="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>
<div class="lbl" id="lbl"></div>
<div id="saved" class="msg"></div>
<div id="more" hidden>
  <p id="ask" style="margin:8px 0 10px;font-weight:600;color:#1a1a2e"></p>
  <textarea id="cm" maxlength="${MAX_COMMENT}" placeholder=""></textarea>
  <button class="go" id="send" type="button">Send</button>
  <div id="cmMsg" class="msg"></div>
</div>
</div>
<script>
(function(){
  var D=${JSON.stringify(String(d))}, T=${JSON.stringify(String(t))}, R=${Number(r) || 0};
  var LABEL={1:'Very poor',2:'Poor',3:'Okay',4:'Good',5:'Excellent'};
  var stars=[].slice.call(document.querySelectorAll('#stars button'));
  function paint(){ stars.forEach(function(b){ b.classList.toggle('on', +b.dataset.r<=R); }); document.getElementById('lbl').textContent=R?LABEL[R]:''; }
  function post(body){ return fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||'error'); return j; });}); }
  function save(){
    var s=document.getElementById('saved'); s.className='msg'; s.textContent='Saving…';
    post({d:D,t:T,r:R}).then(function(){
      s.className='msg ok'; s.textContent='Your '+R+'-star rating is saved.';
      var more=document.getElementById('more'); more.hidden=false;
      document.getElementById('ask').textContent = R<=3 ? 'Sorry it wasn\\u2019t great. What went wrong?' : 'Anything you\\u2019d like to add? (optional)';
      document.getElementById('cm').placeholder = R<=3 ? 'Tell us what happened — late, cold, missing items, the rider…' : 'What did you enjoy?';
    }).catch(function(e){ s.className='msg err'; s.textContent=e.message==='not_found'?'This rating link isn\\u2019t valid.':'Couldn\\u2019t save — please tap a star again.'; });
  }
  stars.forEach(function(b){ b.addEventListener('click', function(){ R=+b.dataset.r; paint(); save(); }); });
  document.getElementById('send').addEventListener('click', function(){
    var c=document.getElementById('cm').value.trim(), m=document.getElementById('cmMsg'), btn=this;
    if(!c){ m.className='msg err'; m.textContent='Type a few words first.'; return; }
    btn.disabled=true; m.className='msg'; m.textContent='Sending…';
    post({d:D,t:T,r:R,comment:c}).then(function(){ m.className='msg ok'; m.textContent='Thank you — we read every message.'; btn.textContent='Sent'; })
      .catch(function(){ m.className='msg err'; m.textContent='Couldn\\u2019t send — please try again.'; btn.disabled=false; });
  });
  paint(); if(R>=1&&R<=5) save();
})();
</script></body></html>`;
}

exports.handler = async (event) => {
  const SUPABASE_URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) return { statusCode: 500, headers: json, body: JSON.stringify({ error: 'config' }) };
  const admin = createClient(SUPABASE_URL, KEY, { auth: { persistSession: false } });

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    const del = await loadDelivery(admin, q.d, q.t);
    if (!del) return { statusCode: 404, headers: html, body: '<!DOCTYPE html><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font-family:system-ui;padding:30px;text-align:center">This rating link isn’t valid.</p>' };
    const items = (del.orders && del.orders.items) || [];
    let store = 'your order';
    const sellerId = items[0] && items[0].seller_id;
    if (sellerId) { const { data: s } = await admin.from('sellers').select('shop_name').eq('id', sellerId).maybeSingle(); if (s) store = 'your ' + s.shop_name + ' order'; }
    const r = Math.max(0, Math.min(5, parseInt(q.r, 10) || 0));
    return { statusCode: 200, headers: html, body: page(q.d, q.t, r, { name: del.orders && del.orders.customer_name, store }) };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: json, body: JSON.stringify({ error: 'Method not allowed' }) };
  let b; try { b = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: json, body: JSON.stringify({ error: 'bad_json' }) }; }
  const r = parseInt(b.r, 10);
  if (!(r >= 1 && r <= 5)) return { statusCode: 400, headers: json, body: JSON.stringify({ error: 'bad_rating' }) };
  const del = await loadDelivery(admin, b.d, b.t);
  if (!del) return { statusCode: 404, headers: json, body: JSON.stringify({ error: 'not_found' }) };
  if (del.status !== 'DELIVERED') return { statusCode: 409, headers: json, body: JSON.stringify({ error: 'not_delivered' }) };

  let sellerId = null, driverId = null;
  if (del.route_id) {
    const [{ data: route }, { data: stop }] = await Promise.all([
      admin.from('routes').select('driver_id').eq('id', del.route_id).maybeSingle(),
      admin.from('route_stops').select('seller_id').eq('route_id', del.route_id).eq('stop_type', 'pickup').eq('delivery_id', del.id).limit(1).maybeSingle()
    ]);
    driverId = route && route.driver_id || null; sellerId = stop && stop.seller_id || null;
  }
  const comment = typeof b.comment === 'string' ? b.comment.trim().slice(0, MAX_COMMENT) : '';
  const row = {
    delivery_id: del.id, order_id: del.order_id, customer_id: del.customer_id || null,
    feedback_type: r >= 4 ? 'compliment' : 'complaint', category: 'Email rating', rating: r,
    seller_id: sellerId, driver_id: driverId
  };
  if (comment) row.message = comment;
  const { error } = await admin.from('delivery_feedback').upsert(row, { onConflict: 'delivery_id' });
  if (error) { console.error('rate-delivery upsert', error); return { statusCode: 500, headers: json, body: JSON.stringify({ error: 'save_failed' }) }; }
  return { statusCode: 200, headers: json, body: JSON.stringify({ ok: true }) };
};
