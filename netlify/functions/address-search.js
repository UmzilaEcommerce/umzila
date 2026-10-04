// netlify/functions/address-search.js
//
// Address suggestions for checkout, profile and the seller dashboard's
// pickup address — HERE Geocoding & Search (2026-10-04, founder decision:
// better Durban house-number coverage than Photon/OSM, and no Google key
// needed). Replaces google-places.js and every direct Photon call.
// Server-only key: HERE_API_KEY (Netlify env) — never sent to the browser.
//
//   GET ?action=autocomplete&input=<text>  → { suggestions: [{ placeId, text, mainText, secondaryText, resultType }] }
//   GET ?action=details&placeId=<id>       → { housenumber, street, suburb, city, state, postcode, countrycode, lat, lon, label }
//
// Search strategy (tested on real Durban addresses):
//   1. HERE Autocomplete, limited to the Durban metro (circle, ~80 km) —
//      best for "number + street" as people type ("400 Umgeni Road").
//   2. If that finds fewer than 3, HERE Discover (free-text search) in the
//      same area — handles "street + suburb" ("1 Ridge Road Umbilo") and
//      places by name ("Gateway", "Wushwini Arts Centre"), which
//      Autocomplete alone returned nothing for.
// The response shape matches what wireAddressAutocomplete()/applyAddress-
// Suggestion() already used, so the pages only changed their fetch URL.
// Identical requests are cached at Netlify's edge (an address's suggestions
// and coordinates don't change), which keeps HERE usage low.
const headers = { 'Content-Type': 'application/json' };
// Durban city centre; deliveries stop at 20 km, the area is generous so
// sellers further out (and their pickup addresses) still resolve.
const CENTRE = '-29.8587,31.0218';
const AREA = `circle:${CENTRE};r=80000`;
const MIN_BEFORE_DISCOVER = 3;

const ok = (body, cacheSeconds) => ({
  statusCode: 200,
  headers: Object.assign({}, headers, cacheSeconds ? {
    'Cache-Control': `public, max-age=${Math.min(cacheSeconds, 3600)}`,
    'Netlify-CDN-Cache-Control': `public, s-maxage=${cacheSeconds}, durable`
  } : {}),
  body: JSON.stringify(body)
});
const fail = (statusCode, error) => ({ statusCode, headers, body: JSON.stringify({ error }) });
const uniq = arr => arr.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

function toSuggestion(it) {
  const a = it.address || {};
  const line = [a.houseNumber, a.street].filter(Boolean).join(' ');
  const where = uniq([a.district, a.city]).join(', ');
  const isPlace = it.resultType === 'place';
  return {
    placeId: it.id,
    text: a.label || it.title || '',
    // A shop/centre shows its name first, then its street + area.
    mainText: isPlace ? (it.title || line) : (line || it.title || a.label || ''),
    secondaryText: isPlace ? uniq([line, where]).join(', ') : (where || a.county || a.state || ''),
    resultType: it.resultType || ''
  };
}

async function hereGet(host, path, params) {
  const res = await fetch(`https://${host}/v1/${path}?` + new URLSearchParams(params));
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) { console.warn(`address-search ${path}: HERE`, res.status, data && (data.title || data.error)); return null; }
  return data;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return fail(405, 'Method Not Allowed');
  const KEY = process.env.HERE_API_KEY || '';
  if (!KEY) return fail(503, 'Address search not configured');
  const p = event.queryStringParameters || {};

  if (p.action === 'autocomplete') {
    const input = String(p.input || '').trim().slice(0, 120);
    if (input.length < 3) return ok({ suggestions: [] });
    try {
      const auto = await hereGet('autocomplete.search.hereapi.com', 'autocomplete', { q: input, in: AREA, limit: '6', lang: 'en', apiKey: KEY });
      let items = (auto && auto.items) || [];
      if (items.length < MIN_BEFORE_DISCOVER) {
        const disc = await hereGet('discover.search.hereapi.com', 'discover', { q: input, in: AREA, limit: '6', lang: 'en', apiKey: KEY });
        const seen = new Set(items.map(i => i.id));
        items = items.concat(((disc && disc.items) || []).filter(i => i.id && !seen.has(i.id)));
      }
      if (!auto && !items.length) return fail(502, 'Address search failed');
      return ok({ suggestions: items.slice(0, 6).map(toSuggestion).filter(s => s.placeId) }, 86400);
    } catch (e) {
      console.warn('address-search autocomplete failed', e.message);
      return fail(502, 'Address search failed');
    }
  }

  if (p.action === 'details') {
    const id = String(p.placeId || '').trim();
    if (!id || id.length > 300) return fail(400, 'placeId required');
    try {
      const d = await hereGet('lookup.search.hereapi.com', 'lookup', { id, lang: 'en', apiKey: KEY });
      if (!d || !d.position) return fail(502, 'Address lookup failed');
      const a = d.address || {};
      return ok({
        housenumber: a.houseNumber || '',
        // A place (shop, centre) without a street number: keep its name on the address line.
        street: a.street || (d.resultType === 'place' ? (d.title || '') : ''),
        suburb: a.district || '',
        // Drivers need the suburb as well as the city ("Morningside, Durban"),
        // and checkout has one City field — so it carries both.
        city: uniq([a.district, a.city]).join(', '),
        state: a.state || '',
        postcode: a.postalCode || '',
        countrycode: a.countryCode === 'ZAF' ? 'ZA' : (a.countryCode || ''),
        label: a.label || d.title || '',
        lat: d.position.lat,
        lon: d.position.lng
      }, 604800);
    } catch (e) {
      console.warn('address-search details failed', e.message);
      return fail(502, 'Address lookup failed');
    }
  }

  return fail(400, 'Unknown action');
};
