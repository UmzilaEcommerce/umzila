// netlify/functions/lib/road-distance.js
//
// Real road distance (and typical drive time) between two points, for
// delivery pricing. Replaces Google Routes (2026-10-04, founder decision):
//   - Provider: OpenRouteService directions (driving-car, OpenStreetMap
//     roads). Distance is what prices a delivery, and traffic doesn't change
//     distance, so a free routing engine is as accurate as a traffic-aware
//     one for the fee. Key: ORS_API_KEY (server-only, Netlify env).
//   - Cache: public.route_distance_cache. A store's distance to an address
//     never changes, so each leg is fetched ONCE and reused forever — keeps
//     usage far below the free daily limit. Points rounded to ~11 m.
//
// getRoadLeg(supabase, from, to) → { distanceKm, durationMin, cached } | null
// Never falls back to straight-line distance for pricing (plan §11): null
// means "couldn't route", and the caller decides (quote fails → checkout's
// class-based fallback price).
const round4 = n => Math.round(Number(n) * 1e4) / 1e4;

async function fetchOrs(from, to) {
  const key = process.env.ORS_API_KEY;
  if (!key) return { error: 'ORS_API_KEY not configured' };
  try {
    const res = await fetch('https://api.openrouteservice.org/v2/directions/driving-car', {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ coordinates: [[from.lon, from.lat], [to.lon, to.lat]], units: 'm', instructions: false })
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || !Array.isArray(json.routes) || !json.routes.length) {
      return { error: `OpenRouteService ${res.status}: ${json && json.error ? JSON.stringify(json.error).slice(0, 200) : 'no route'}` };
    }
    const s = json.routes[0].summary || {};
    // ORS omits distance/duration when both points snap to the same spot.
    const distance = Number(s.distance || 0), duration = Number(s.duration || 0);
    if (!Number.isFinite(distance) || distance < 0) return { error: 'OpenRouteService returned an invalid distance' };
    return { distance_m: Math.round(distance), duration_s: Number.isFinite(duration) ? Math.round(duration) : null };
  } catch (e) {
    return { error: 'OpenRouteService unreachable: ' + e.message };
  }
}

async function getRoadLeg(supabase, from, to) {
  const k = { from_lat: round4(from.lat), from_lon: round4(from.lon), to_lat: round4(to.lat), to_lon: round4(to.lon) };
  if (Object.values(k).some(v => !Number.isFinite(v))) return null;

  const { data: hit } = await supabase.from('route_distance_cache').select('distance_m, duration_s, hits')
    .eq('from_lat', k.from_lat).eq('from_lon', k.from_lon).eq('to_lat', k.to_lat).eq('to_lon', k.to_lon).maybeSingle();
  if (hit) {
    supabase.from('route_distance_cache').update({ hits: (hit.hits || 0) + 1 })
      .eq('from_lat', k.from_lat).eq('from_lon', k.from_lon).eq('to_lat', k.to_lat).eq('to_lon', k.to_lon)
      .then(() => {}, () => {});
    return { distanceKm: hit.distance_m / 1000, durationMin: hit.duration_s != null ? hit.duration_s / 60 : null, cached: true };
  }

  const r = await fetchOrs(from, to);
  if (r.error) { console.warn('road-distance:', r.error); return null; }
  const { error: insErr } = await supabase.from('route_distance_cache')
    .upsert({ ...k, distance_m: r.distance_m, duration_s: r.duration_s, provider: 'openrouteservice' }, { onConflict: 'from_lat,from_lon,to_lat,to_lon', ignoreDuplicates: true });
  if (insErr) console.warn('road-distance: cache write failed', insErr.message);
  return { distanceKm: r.distance_m / 1000, durationMin: r.duration_s != null ? r.duration_s / 60 : null, cached: false };
}

// Road distance between EVERY pair of points in one go (multi-drop trip
// planning, 2026-10-05). Cached pairs come from route_distance_cache; any
// missing pair triggers ONE OpenRouteService matrix call for the whole set,
// and every pair it returns is cached forever. Returns
// legAt(i, j) → { distanceKm, durationMin, road: true } or null when a pair
// couldn't be routed (the caller falls back to a straight-line estimate —
// fine for ordering stops, never used for pricing).
async function getRoadMatrix(supabase, points) {
  const pts = points.map(p => ({ lat: round4(p.lat), lon: round4(p.lon) }));
  const n = pts.length;
  const table = Array.from({ length: n }, () => new Array(n).fill(null));
  if (n < 2 || pts.some(p => !Number.isFinite(p.lat) || !Number.isFinite(p.lon))) return (i, j) => (table[i] && table[i][j]) || null;

  const lats = [...new Set(pts.map(p => p.lat))];
  const { data: rows } = await supabase.from('route_distance_cache')
    .select('from_lat, from_lon, to_lat, to_lon, distance_m, duration_s')
    .in('from_lat', lats).in('to_lat', lats);
  const key = (a, b) => `${a.lat},${a.lon}>${b.lat},${b.lon}`;
  const cached = new Map((rows || []).map(r => [`${r.from_lat},${r.from_lon}>${r.to_lat},${r.to_lon}`, r]));
  let missing = false;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j || (pts[i].lat === pts[j].lat && pts[i].lon === pts[j].lon)) { table[i][j] = { distanceKm: 0, durationMin: 0, road: true }; continue; }
    const hit = cached.get(key(pts[i], pts[j]));
    if (hit) table[i][j] = { distanceKm: hit.distance_m / 1000, durationMin: hit.duration_s != null ? hit.duration_s / 60 : null, road: true };
    else missing = true;
  }

  const apiKey = process.env.ORS_API_KEY;
  if (missing && apiKey) {
    try {
      const res = await fetch('https://api.openrouteservice.org/v2/matrix/driving-car', {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ locations: pts.map(p => [p.lon, p.lat]), metrics: ['distance', 'duration'], units: 'm' })
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json && Array.isArray(json.distances)) {
        const toCache = [];
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
          if (table[i][j]) continue;
          const d = json.distances[i] && json.distances[i][j];
          const t = json.durations && json.durations[i] ? json.durations[i][j] : null;
          if (!Number.isFinite(d)) continue;
          table[i][j] = { distanceKm: d / 1000, durationMin: Number.isFinite(t) ? t / 60 : null, road: true };
          toCache.push({ from_lat: pts[i].lat, from_lon: pts[i].lon, to_lat: pts[j].lat, to_lon: pts[j].lon,
                         distance_m: Math.round(d), duration_s: Number.isFinite(t) ? Math.round(t) : null, provider: 'openrouteservice' });
        }
        if (toCache.length) {
          const { error } = await supabase.from('route_distance_cache').upsert(toCache, { onConflict: 'from_lat,from_lon,to_lat,to_lon', ignoreDuplicates: true });
          if (error) console.warn('road-distance: matrix cache write failed', error.message);
        }
      } else {
        console.warn('road-distance: ORS matrix', res.status, json && json.error ? JSON.stringify(json.error).slice(0, 200) : 'no data');
      }
    } catch (e) {
      console.warn('road-distance: ORS matrix unreachable', e.message);
    }
  }
  return (i, j) => (table[i] && table[i][j]) || null;
}

module.exports = { getRoadLeg, getRoadMatrix };
