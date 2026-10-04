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

module.exports = { getRoadLeg };
