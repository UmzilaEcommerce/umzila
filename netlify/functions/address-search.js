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
// The response shape matches what wireAddressAutocomplete()/applyAddress-
// Suggestion() already used, so the pages only changed their fetch URL.
// Identical requests are cached at Netlify's edge (an address's suggestions
// and coordinates don't change), which keeps HERE usage low.
const headers = { 'Content-Type': 'application/json' };
// Bias towards Durban (where every store and delivery is).
const BIAS = '-29.8587,31.0218';

const ok = (body, cacheSeconds) => ({
  statusCode: 200,
  headers: Object.assign({}, headers, cacheSeconds ? {
    'Cache-Control': `public, max-age=${Math.min(cacheSeconds, 3600)}`,
    'Netlify-CDN-Cache-Control': `public, s-maxage=${cacheSeconds}, durable`
  } : {}),
  body: JSON.stringify(body)
});
const fail = (statusCode, error) => ({ statusCode, headers, body: JSON.stringify({ error }) });

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return fail(405, 'Method Not Allowed');
  const KEY = process.env.HERE_API_KEY || '';
  if (!KEY) return fail(503, 'Address search not configured');
  const p = event.queryStringParameters || {};

  if (p.action === 'autocomplete') {
    const input = String(p.input || '').trim().slice(0, 120);
    if (input.length < 3) return ok({ suggestions: [] });
    const url = 'https://autocomplete.search.hereapi.com/v1/autocomplete?' + new URLSearchParams({
      q: input, in: 'countryCode:ZAF', at: BIAS, limit: '6', lang: 'en', apiKey: KEY
    });
    try {
      const res = await fetch(url);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) { console.warn('address-search autocomplete: HERE', res.status, data && data.title); return fail(502, 'Address search failed'); }
      const suggestions = (data.items || []).map(it => {
        const a = it.address || {};
        const line = [a.houseNumber, a.street].filter(Boolean).join(' ');
        const where = [a.district, a.city].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(', ');
        return {
          placeId: it.id,
          text: a.label || it.title || '',
          mainText: line || it.title || a.label || '',
          secondaryText: where || a.county || a.state || '',
          resultType: it.resultType || ''
        };
      }).filter(s => s.placeId);
      return ok({ suggestions }, 86400);
    } catch (e) {
      console.warn('address-search autocomplete failed', e.message);
      return fail(502, 'Address search failed');
    }
  }

  if (p.action === 'details') {
    const id = String(p.placeId || '').trim();
    if (!id || id.length > 300) return fail(400, 'placeId required');
    const url = 'https://lookup.search.hereapi.com/v1/lookup?' + new URLSearchParams({ id, lang: 'en', apiKey: KEY });
    try {
      const res = await fetch(url);
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || !d.position) { console.warn('address-search details: HERE', res.status, d && d.title); return fail(502, 'Address lookup failed'); }
      const a = d.address || {};
      return ok({
        housenumber: a.houseNumber || '',
        street: a.street || '',
        suburb: a.district || '',
        // Drivers need the suburb as well as the city ("Morningside, Durban"),
        // and checkout has one City field — so it carries both.
        city: [a.district, a.city].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(', '),
        state: a.state || '',
        postcode: a.postalCode || '',
        countrycode: (a.countryCode || '').toLowerCase().slice(0, 2) === 'za' || a.countryCode === 'ZAF' ? 'ZA' : (a.countryCode || ''),
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
