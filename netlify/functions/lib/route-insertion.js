// netlify/functions/lib/route-insertion.js
//
// Multi-drop trip planner (founder 2026-10-05; delivery-network-spec.md §31–35).
// Decides whether a new order fits onto a rider's current trip and, if so, the
// best order of every stop that hasn't been started yet.
//
//   - Scores the WHOLE remaining trip's time — not "closest first" — so two
//     customers in opposite directions are ordered by total trip time.
//   - Legs are real road distances (lib/road-distance.js getRoadMatrix — one
//     OpenRouteService matrix call, cached forever); straight-line × 1.3 only
//     if routing is unavailable. Time = road km × 2 min (the checkout ETA's
//     rate) + 3 min per stop; a pickup right after a pickup at the SAME store
//     costs nothing extra (orders at one store are collected in one visit).
//   - Every not-yet-started stop may be re-ordered (pickups always before
//     their own drop); started stops (rider at the store / driving to that
//     customer / at their door) stay first, in place.
//   - Rules: at most MAX_DELIVERIES_PER_TRIP orders open on the trip; nobody
//     already on the trip is delivered more than MAX_DELAY_MIN later than
//     their plan before the change (unless the added order is priority —
//     then only other priority customers are protected); a priority order is delivered as early as
//     possible, except a stop that delays it by ≤ MAX_DELAY_MIN may go first
//     ("quickly drop the close one first"); the new order itself must arrive
//     within MAX_NEW_ORDER_WAIT_MIN.
// Pure planning — never writes. respond-to-driver-offer.js applies the result
// with apply_route_sequence().
const { getRoadMatrix } = require('./road-distance');

const MAX_DELIVERIES_PER_TRIP = 5;   // founder 2026-10-05 (can grow later — nothing else assumes 5)
const MAX_DELAY_MIN = 8;             // founder 2026-10-05
const MAX_NEW_ORDER_WAIT_MIN = 60;   // sanity cap for the added customer
const MIN_PER_KM = 2;                // same as checkout's delivery target
const STOP_MIN = 3;
const ROAD_FACTOR = 1.3;             // straight line → road, fallback only

function haversineKm(a, b) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * @param supabase  service-role client
 * @param input     get_route_plan_input(route) result
 * @param add       { deliveryId, sellerId, pickup:{lat,lon}, drop:{lat,lon}, customer, priority } or null
 * @returns { ok:true, order:[{id}|{new:'pickup'}|{new:'drop'}], addedMin, addedKm, afterName, newArrivalMin }
 *        | { ok:false, reason }
 */
async function planTrip(supabase, input, add) {
  const open = (input.stops || []).filter(s => s.status !== 'completed');
  const openDeliveries = new Set(open.map(s => s.delivery_id));
  if (add && openDeliveries.size + 1 > MAX_DELIVERIES_PER_TRIP) return { ok: false, reason: 'trip_full' };
  if (open.some(s => !Number.isFinite(s.lat) || !Number.isFinite(s.lon))) return { ok: false, reason: 'stop_without_location' };

  const locked = open.filter(s => s.status === 'active' || s.status === 'arriving');
  const free = open.filter(s => s.status === 'pending');

  // Points: 0 = start (rider, else the first open stop), then every stop.
  const nodes = [];
  const start = input.driver && Number.isFinite(input.driver.lat) && input.driver.fresh
    ? { lat: input.driver.lat, lon: input.driver.lon }
    : (open[0] || (add && add.pickup));
  if (!start) return { ok: false, reason: 'no_start' };
  nodes.push({ key: 'start', lat: start.lat, lon: start.lon });
  const mk = (s) => ({ key: s.id, type: s.type, seller: s.seller_id, delivery: s.delivery_id, lat: s.lat, lon: s.lon, customer: s.customer, priority: !!s.priority, existing: true });
  locked.forEach(s => nodes.push(mk(s)));
  free.forEach(s => nodes.push(mk(s)));
  if (add) {
    nodes.push({ key: 'new:pickup', type: 'pickup', seller: add.sellerId, delivery: add.deliveryId, lat: add.pickup.lat, lon: add.pickup.lon, customer: add.customer, priority: !!add.priority, existing: false });
    nodes.push({ key: 'new:drop', type: 'drop', seller: null, delivery: add.deliveryId, lat: add.drop.lat, lon: add.drop.lon, customer: add.customer, priority: !!add.priority, existing: false });
  }
  const idx = new Map(nodes.map((nd, i) => [nd.key, i]));

  // Leg times (min) between any two nodes.
  const legAt = await getRoadMatrix(supabase, nodes);
  const n = nodes.length;
  const km = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) continue;
    const leg = legAt(i, j);
    km[i][j] = leg ? leg.distanceKm : haversineKm(nodes[i], nodes[j]) * ROAD_FACTOR;
  }
  const dwell = (prev, cur) => (cur.type === 'pickup' && prev && prev.type === 'pickup' && prev.seller && prev.seller === cur.seller) ? 0 : STOP_MIN;

  // Walk a sequence of node indexes (after the locked prefix) → times.
  const lockedIdx = locked.map(s => idx.get(s.id));
  function simulate(seq) {
    let t = 0, d = 0, prevI = 0, prevNode = null;
    const arrival = {};
    for (const i of lockedIdx.concat(seq)) {
      t += km[prevI][i] * MIN_PER_KM + dwell(prevNode, nodes[i]);
      d += km[prevI][i];
      if (nodes[i].type === 'drop') arrival[nodes[i].delivery] = t;
      prevI = i; prevNode = nodes[i];
    }
    return { t, d, arrival };
  }

  // Baseline = the trip as planned now (no new order).
  const baseSeq = free.map(s => idx.get(s.id));
  const base = simulate(baseSeq);

  // Enumerate every order of the free + new stops (pickups before own drop;
  // a delivery's own pickups keep their relative order).
  const pool = baseSeq.concat(add ? [idx.get('new:pickup'), idx.get('new:drop')] : []);
  const pickupsOf = {};
  pool.forEach(i => { const nd = nodes[i]; if (nd.type === 'pickup') (pickupsOf[nd.delivery] = pickupsOf[nd.delivery] || []).push(i); });
  const results = [];
  const used = new Array(n).fill(false);
  const seq = [];
  (function dfs() {
    if (seq.length === pool.length) { results.push({ seq: seq.slice(), ...simulate(seq) }); return; }
    for (const i of pool) {
      if (used[i]) continue;
      const nd = nodes[i];
      if (nd.type === 'drop') {
        const ps = pickupsOf[nd.delivery] || [];
        if (ps.some(p => !used[p])) continue; // its pickups first
      } else {
        const ps = pickupsOf[nd.delivery] || [];
        const k = ps.indexOf(i);
        if (k > 0 && !used[ps[k - 1]]) continue; // keep a bundle's pickup order
      }
      used[i] = true; seq.push(i);
      dfs();
      seq.pop(); used[i] = false;
    }
  })();

  // Rules.
  // An added PRIORITY order bought precedence: it may push non-priority
  // customers back (founder: "closest first unless the other paid for
  // priority"); customers who bought priority themselves are always protected.
  const priorityByDelivery = {};
  nodes.forEach(nd => { if (nd.type === 'drop') priorityByDelivery[nd.delivery] = nd.priority; });
  const protectedDrops = Object.keys(base.arrival).filter(dl => !(add && add.priority) || priorityByDelivery[dl]);
  let feasible = results.filter(r =>
    protectedDrops.every(dl => r.arrival[dl] <= base.arrival[dl] + MAX_DELAY_MIN + 1e-9) &&
    (!add || r.arrival[add.deliveryId] <= MAX_NEW_ORDER_WAIT_MIN));
  if (!feasible.length) return { ok: false, reason: 'too_much_delay' };

  // Priority orders: no later than MAX_DELAY_MIN after their earliest possible arrival.
  const priorityDeliveries = [...new Set(nodes.filter(nd => nd.priority && nd.type === 'drop').map(nd => nd.delivery))];
  for (const pd of priorityDeliveries) {
    const best = Math.min(...feasible.map(r => r.arrival[pd]).filter(Number.isFinite));
    if (Number.isFinite(best)) feasible = feasible.filter(r => r.arrival[pd] <= best + MAX_DELAY_MIN + 1e-9);
  }
  feasible.sort((a, b) => (a.t - b.t) || (sumArrivals(a) - sumArrivals(b)));
  const best = feasible[0];

  const order = lockedIdx.concat(best.seq).map(i => {
    const key = nodes[i].key;
    return key === 'new:pickup' ? { new: 'pickup' } : key === 'new:drop' ? { new: 'drop' } : { id: key };
  });
  let afterName = null;
  if (add) {
    const full = lockedIdx.concat(best.seq);
    const pos = full.indexOf(idx.get('new:drop'));
    for (let k = pos - 1; k >= 0; k--) { const nd = nodes[full[k]]; if (nd.type === 'drop') { afterName = nd.customer || null; break; } }
  }
  return {
    ok: true,
    order,
    addedMin: Math.max(0, Math.round((best.t - base.t) * 10) / 10),
    addedKm: Math.max(0, Math.round((best.d - base.d) * 10) / 10),
    afterName,
    newArrivalMin: add ? Math.round(best.arrival[add.deliveryId]) : null,
    totalMin: Math.round(best.t)
  };
}
function sumArrivals(r) { return Object.values(r.arrival).reduce((s, v) => s + v, 0); }

module.exports = { planTrip, MAX_DELIVERIES_PER_TRIP, MAX_DELAY_MIN, MIN_PER_KM, STOP_MIN };
