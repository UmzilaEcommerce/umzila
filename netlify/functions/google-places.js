// netlify/functions/google-places.js
//
// Server-side proxy for Google's Places API (New) — autocomplete suggestions
// and place details (address components + lat/lon). Replaces the browser's
// direct OpenStreetMap Photon calls (checkout.html/profile.html/seller-
// dashboard.html) per the founder's 2026-09-17 decision: Photon's address
// suggestions weren't accurate enough for production. This is exactly the
// design already committed to back in the delivery-network build (§B item 8,
// §C item 4) when the founder rejected exposing any Google Maps key in the
// browser: a server-only key, never sent to the client, called from the
// browser only through this proxy.
//
// Reuses the SAME server-only key as the delivery-quote engine
// (GOOGLE_ROUTES_SERVER_KEY) -- one key, Routes API + Places API (New) both
// enabled on it in Google Cloud Console, restricted to just those two APIs.
//
// Two actions, both GET (kept simple/cacheable, no request body needed):
//   ?action=autocomplete&input=<query>          -> { suggestions: [...] }
//   ?action=details&placeId=<id>                -> { housenumber, street, city, state, postcode, countrycode, lat, lon }
//
// Response shape for both actions is deliberately normalized to match what
// this codebase's existing wireAddressAutocomplete()/applyAddressSuggestion()
// functions already expect from Photon (props: housenumber/street/city/
// postcode/state/countrycode, geometry-style lat/lon) -- so the three
// frontend files calling this only need their fetch URL/response-parsing
// changed, not their onSelect/applyAddressSuggestion logic.
const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// Same UKZN Westville campus bias point already used by every Photon call
// site in this codebase (checkout.html/profile.html/seller-dashboard.html).
const CAMPUS_LAT = -29.8175;
const CAMPUS_LON = 30.9436;
const BIAS_RADIUS_METERS = 20000; // ~20km — generous enough to cover the whole delivery service area without biasing away real matches further out

function findComponent(components, type) {
  return (components || []).find(c => Array.isArray(c.types) && c.types.includes(type));
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const GOOGLE_KEY = process.env.GOOGLE_ROUTES_SERVER_KEY || '';
  if (!GOOGLE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Address search not configured' }) };
  }

  const params = event.queryStringParameters || {};
  const action = params.action;

  if (action === 'autocomplete') {
    const input = (params.input || '').trim();
    if (input.length < 3) return { statusCode: 200, headers, body: JSON.stringify({ suggestions: [] }) };

    try {
      const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_KEY },
        body: JSON.stringify({
          input,
          includedRegionCodes: ['za'],
          locationBias: { circle: { center: { latitude: CAMPUS_LAT, longitude: CAMPUS_LON }, radius: BIAS_RADIUS_METERS } }
        })
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.warn('google-places autocomplete: Google API error', res.status, errText);
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Address search failed' }) };
      }
      const data = await res.json();
      const suggestions = (data.suggestions || [])
        .map(s => s.placePrediction)
        .filter(Boolean)
        .map(p => ({
          placeId: p.placeId,
          text: (p.text && p.text.text) || '',
          mainText: (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text) || '',
          secondaryText: (p.structuredFormat && p.structuredFormat.secondaryText && p.structuredFormat.secondaryText.text) || ''
        }));
      return { statusCode: 200, headers, body: JSON.stringify({ suggestions }) };
    } catch (e) {
      console.warn('google-places autocomplete: request failed', e.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Address search failed' }) };
    }
  }

  if (action === 'details') {
    const placeId = (params.placeId || '').trim();
    if (!placeId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'placeId required' }) };

    try {
      const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
        headers: { 'X-Goog-Api-Key': GOOGLE_KEY, 'X-Goog-FieldMask': 'addressComponents,location,formattedAddress' }
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.warn('google-places details: Google API error', res.status, errText);
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Address lookup failed' }) };
      }
      const data = await res.json();
      const comps = data.addressComponents || [];
      const streetNumber = findComponent(comps, 'street_number');
      const route = findComponent(comps, 'route');
      const city = findComponent(comps, 'locality') || findComponent(comps, 'sublocality') || findComponent(comps, 'postal_town');
      const province = findComponent(comps, 'administrative_area_level_1');
      const postcode = findComponent(comps, 'postal_code');
      const country = findComponent(comps, 'country');

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          housenumber: streetNumber ? streetNumber.longText : '',
          street: route ? route.longText : '',
          city: city ? city.longText : '',
          state: province ? province.longText : '',
          postcode: postcode ? postcode.longText : '',
          countrycode: country ? country.shortText : '',
          formattedAddress: data.formattedAddress || '',
          lat: data.location ? data.location.latitude : null,
          lon: data.location ? data.location.longitude : null
        })
      };
    } catch (e) {
      console.warn('google-places details: request failed', e.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Address lookup failed' }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: "action must be 'autocomplete' or 'details'" }) };
};
