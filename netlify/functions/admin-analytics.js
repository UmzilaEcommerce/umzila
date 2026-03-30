// netlify/functions/admin-analytics.js
// Aggregated analytics endpoint for the admin dashboard.
// Uses service role key — never exposed to frontend.
// Auth: caller must pass a valid Supabase JWT for a user in the admins table.

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const SUPABASE_URL  = process.env.SUPABASE_URL || '';
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server config error' }) };

  // Verify admin via JWT
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  // Verify token belongs to an admin
  try {
    const userClient = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY || SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid token' }) };

    const { data: adminRow } = await admin.from('admins').select('role').eq('user_id', user.id).maybeSingle();
    if (!adminRow) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Not an admin' }) };
  } catch (e) {
    console.error('admin-analytics: auth error', e);
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Auth failed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) { body = {}; }
  const { type } = body;

  try {
    let result = {};

    if (type === 'overview') {
      result = await getOverview(admin);
    } else if (type === 'products') {
      result = await getProductIntelligence(admin);
    } else if (type === 'categories') {
      result = await getCategoryIntelligence(admin);
    } else if (type === 'sellers') {
      result = await getSellerIntelligence(admin);
    } else if (type === 'behaviour') {
      result = await getBehaviourData(admin);
    } else if (type === 'search') {
      result = await getSearchData(admin);
    } else if (type === 'trends') {
      result = await getTrendsData(admin);
    } else {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown analytics type' }) };
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };
  } catch (e) {
    console.error('admin-analytics: query error', type, e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Analytics query failed', detail: e.message }) };
  }
};

// ── Overview ─────────────────────────────────────────────────────────────────
async function getOverview(admin) {
  const [
    { data: orders },
    { count: productCount },
    { count: activeSellers },
    { count: totalUsers },
    { data: favSum }
  ] = await Promise.all([
    admin.from('orders').select('total, order_status').eq('order_status', 'paid'),
    admin.from('products').select('*', { count: 'exact', head: true }).eq('visible', true),
    admin.from('sellers').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    admin.from('profiles').select('*', { count: 'exact', head: true }),
    admin.from('products').select('favourite_count').not('favourite_count', 'is', null)
  ]);

  const paidOrders = orders || [];
  const totalRevenue = paidOrders.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const totalFavourites = (favSum || []).reduce((s, p) => s + (Number(p.favourite_count) || 0), 0);

  return {
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalOrders: paidOrders.length,
    totalProducts: productCount || 0,
    activeSellers: activeSellers || 0,
    totalUsers: totalUsers || 0,
    totalFavourites,
    avgOrderValue: paidOrders.length ? Math.round((totalRevenue / paidOrders.length) * 100) / 100 : 0
  };
}

// ── Product intelligence ──────────────────────────────────────────────────────
async function getProductIntelligence(admin) {
  const [{ data: topFav }, { data: topClicks }, { data: recentProducts }] = await Promise.all([
    admin.from('products')
      .select('id, name, category, favourite_count, click_count, price, sale_price, sale, sellers(shop_name)')
      .order('favourite_count', { ascending: false })
      .limit(20),
    admin.from('products')
      .select('id, name, category, favourite_count, click_count, price, sellers(shop_name)')
      .order('click_count', { ascending: false })
      .limit(20),
    admin.from('products')
      .select('id, name, category, created_at, favourite_count, click_count')
      .order('created_at', { ascending: false })
      .limit(10)
  ]);

  // Products with high favourites but low clicks (hidden gems / needs promotion)
  const allProds = topFav || [];
  const highFavLowClick = allProds
    .filter(p => (p.favourite_count || 0) >= 2 && (p.click_count || 0) < 5)
    .slice(0, 10);

  return { topFav: topFav || [], topClicks: topClicks || [], recentProducts: recentProducts || [], highFavLowClick };
}

// ── Category intelligence ─────────────────────────────────────────────────────
async function getCategoryIntelligence(admin) {
  const [{ data: products }, { data: events }] = await Promise.all([
    admin.from('products')
      .select('category, favourite_count, click_count, price, sale'),
    admin.from('user_events')
      .select('category, event_type')
      .in('event_type', ['category_view', 'product_click', 'add_to_cart'])
      .gte('created_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString())
      .limit(5000)
  ]);

  const cats = {};
  (products || []).forEach(p => {
    const c = p.category || 'Unknown';
    if (!cats[c]) cats[c] = { category: c, productCount: 0, totalFavourites: 0, totalClicks: 0, views: 0, cartAdds: 0 };
    cats[c].productCount++;
    cats[c].totalFavourites += Number(p.favourite_count) || 0;
    cats[c].totalClicks += Number(p.click_count) || 0;
  });

  (events || []).forEach(e => {
    const c = e.category || 'Unknown';
    if (!cats[c]) cats[c] = { category: c, productCount: 0, totalFavourites: 0, totalClicks: 0, views: 0, cartAdds: 0 };
    if (e.event_type === 'category_view') cats[c].views++;
    if (e.event_type === 'add_to_cart') cats[c].cartAdds++;
  });

  return { categories: Object.values(cats).sort((a, b) => b.totalFavourites - a.totalFavourites) };
}

// ── Seller intelligence ───────────────────────────────────────────────────────
async function getSellerIntelligence(admin) {
  const [{ data: sellers }, { data: products }, { data: orders }] = await Promise.all([
    admin.from('sellers').select('id, shop_name, status').eq('status', 'active').limit(100),
    admin.from('products').select('seller_id, favourite_count, click_count, name').limit(2000),
    admin.from('orders').select('items, total, order_status').eq('order_status', 'paid').limit(1000)
  ]);

  const sellerMap = {};
  (sellers || []).forEach(s => {
    sellerMap[s.id] = { id: s.id, shop_name: s.shop_name, productCount: 0, totalFavourites: 0, totalClicks: 0, revenue: 0 };
  });

  (products || []).forEach(p => {
    if (sellerMap[p.seller_id]) {
      sellerMap[p.seller_id].productCount++;
      sellerMap[p.seller_id].totalFavourites += Number(p.favourite_count) || 0;
      sellerMap[p.seller_id].totalClicks += Number(p.click_count) || 0;
    }
  });

  // Parse order revenue per seller from items JSON
  (orders || []).forEach(o => {
    const items = Array.isArray(o.items) ? o.items : [];
    items.forEach(item => {
      const sid = item.seller_id || item.sellerId;
      if (sid && sellerMap[sid]) {
        sellerMap[sid].revenue += Number(item.total || item.price || 0) * Number(item.quantity || item.qty || 1);
      }
    });
  });

  const list = Object.values(sellerMap).sort((a, b) => b.totalFavourites - a.totalFavourites);
  return { sellers: list };
}

// ── Behaviour data ────────────────────────────────────────────────────────────
async function getBehaviourData(admin) {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const [{ data: events }, { data: topClicked }, { data: topSearched }] = await Promise.all([
    admin.from('user_events')
      .select('event_type, created_at')
      .gte('created_at', since)
      .limit(10000),
    admin.from('user_events')
      .select('product_id')
      .eq('event_type', 'product_click')
      .gte('created_at', since)
      .limit(2000),
    admin.from('user_events')
      .select('search_term')
      .eq('event_type', 'search')
      .not('search_term', 'is', null)
      .gte('created_at', since)
      .limit(2000)
  ]);

  // Event counts per type
  const typeCounts = {};
  // Daily event counts (last 30 days)
  const dailyCounts = {};
  (events || []).forEach(e => {
    typeCounts[e.event_type] = (typeCounts[e.event_type] || 0) + 1;
    const day = e.created_at ? e.created_at.slice(0, 10) : 'unknown';
    dailyCounts[day] = (dailyCounts[day] || 0) + 1;
  });

  // Top clicked product IDs
  const clickMap = {};
  (topClicked || []).forEach(e => { if (e.product_id) clickMap[e.product_id] = (clickMap[e.product_id] || 0) + 1; });
  const topClickedIds = Object.entries(clickMap).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Fetch names for top clicked products
  let topClickedProducts = [];
  if (topClickedIds.length) {
    const { data: prods } = await admin.from('products')
      .select('id, name, category')
      .in('id', topClickedIds.map(x => x[0]));
    topClickedProducts = topClickedIds.map(([id, count]) => ({
      id, count, ...(prods || []).find(p => String(p.id) === String(id))
    }));
  }

  // Top searched terms
  const termMap = {};
  (topSearched || []).forEach(e => {
    const t = (e.search_term || '').toLowerCase().trim();
    if (t) termMap[t] = (termMap[t] || 0) + 1;
  });
  const topTerms = Object.entries(termMap).sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([term, count]) => ({ term, count }));

  return { typeCounts, dailyCounts, topClickedProducts, topTerms };
}

// ── Search data ───────────────────────────────────────────────────────────────
async function getSearchData(admin) {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { data: searches } = await admin.from('user_events')
    .select('search_term, metadata, created_at')
    .eq('event_type', 'search')
    .not('search_term', 'is', null)
    .gte('created_at', since)
    .limit(3000);

  const termMap = {};
  const zeroResults = {};
  (searches || []).forEach(e => {
    const t = (e.search_term || '').toLowerCase().trim();
    if (!t) return;
    termMap[t] = (termMap[t] || 0) + 1;
    const meta = e.metadata || {};
    if ((meta.result_count === 0 || meta.result_count === '0') && !meta.via) {
      zeroResults[t] = (zeroResults[t] || 0) + 1;
    }
  });

  const topTerms = Object.entries(termMap).sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([term, count]) => ({ term, count }));
  const noResults = Object.entries(zeroResults).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([term, count]) => ({ term, count }));

  return { topTerms, noResults };
}

// ── Trends data (for charts) ──────────────────────────────────────────────────
async function getTrendsData(admin) {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const [{ data: orders }, { data: events }] = await Promise.all([
    admin.from('orders')
      .select('created_at, total, order_status')
      .eq('order_status', 'paid')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(2000),
    admin.from('user_events')
      .select('created_at, event_type, category')
      .gte('created_at', since)
      .limit(10000)
  ]);

  // Daily revenue
  const dailyRevenue = {};
  const dailyOrders = {};
  (orders || []).forEach(o => {
    const day = o.created_at ? o.created_at.slice(0, 10) : 'unknown';
    dailyRevenue[day] = (dailyRevenue[day] || 0) + (Number(o.total) || 0);
    dailyOrders[day] = (dailyOrders[day] || 0) + 1;
  });

  // Daily events by category (top 5 categories by total views)
  const catDailyViews = {};
  (events || []).forEach(e => {
    if (e.event_type !== 'category_view' || !e.category) return;
    const day = e.created_at ? e.created_at.slice(0, 10) : 'unknown';
    if (!catDailyViews[e.category]) catDailyViews[e.category] = {};
    catDailyViews[e.category][day] = (catDailyViews[e.category][day] || 0) + 1;
  });

  // Daily total events
  const dailyEvents = {};
  (events || []).forEach(e => {
    const day = e.created_at ? e.created_at.slice(0, 10) : 'unknown';
    dailyEvents[day] = (dailyEvents[day] || 0) + 1;
  });

  return { dailyRevenue, dailyOrders, catDailyViews, dailyEvents };
}
