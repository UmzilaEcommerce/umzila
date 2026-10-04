// netlify/functions/hold-service-booking.js
//
// Places a 30-minute hold on a scheduled in-person service slot (e.g. a
// haircut, or 3 quads for a 1-hour ride). The hold's id goes into the cart
// item as booking_id; validate-cart.js re-checks it before payment and
// complete-order-payment.js confirms it once PayFast reports the payment.
//
// Server-side on purpose: the browser can't be trusted to pick a slot that
// is really inside the seller's hours, and guests (no account) can book too.
// Capacity itself is enforced by the service_bookings_enforce_capacity
// trigger (sellers.booking_capacity × overlapping bookings' units), so two
// buyers racing for the last quads can't both win.
//
// POST { productId, startAt (ISO), units?, replaceBookingId? }
//   → 200 { bookingId, startAt, endAt, units, holdExpiresAt }
//   → 409 { error, code: 'SLOT_FULL' }   400 for anything invalid
const { createClient } = require('@supabase/supabase-js');

const HOLD_MINUTES = 30;
const MIN_LEAD_MINUTES = 30;      // can't book a slot starting in under 30 min
const HORIZON_DAYS = 60;
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000; // Africa/Johannesburg, fixed UTC+2, no DST

function sastParts(d) {
  const s = new Date(d.getTime() + SAST_OFFSET_MS);
  return { year: s.getUTCFullYear(), month: s.getUTCMonth() + 1, day: s.getUTCDate(), minutes: s.getUTCHours() * 60 + s.getUTCMinutes(), dayOfWeek: s.getUTCDay() };
}
function toMinutes(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); }

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };
  const fail = (statusCode, error, extra) => ({ statusCode, headers, body: JSON.stringify(Object.assign({ error }, extra || {})) });
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return fail(400, 'Invalid request'); }
  const productId = typeof body.productId === 'string' ? body.productId : '';
  const start = new Date(body.startAt);
  const units = Number.isInteger(Number(body.units)) ? Number(body.units) : 1;
  if (!productId || isNaN(start.getTime())) return fail(400, 'Pick a time first.');
  if (units < 1 || units > 500) return fail(400, 'Invalid quantity.');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return fail(500, 'Server configuration error');
  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    // Optional sign-in — guests can book; a signed-in buyer's hold is linked to them.
    let buyerUserId = null;
    const auth = event.headers && (event.headers.authorization || event.headers.Authorization);
    const token = auth && auth.replace(/^Bearer\s+/i, '').trim();
    if (token) {
      const { data: u } = await supabase.auth.getUser(token);
      if (u && u.user) buyerUserId = u.user.id;
    }

    const { data: product } = await supabase.from('products')
      .select('id, name, seller_id, visible, listing_type, fulfillment_type, booking_mode, slot_duration_minutes')
      .eq('id', productId).maybeSingle();
    if (!product || !product.visible || product.listing_type !== 'service'
        || product.fulfillment_type !== 'in_person' || product.booking_mode !== 'scheduled') {
      return fail(400, 'This listing can\'t be booked online.');
    }
    const { data: seller } = await supabase.from('sellers')
      .select('id, status, booking_capacity, booking_start_interval_minutes')
      .eq('id', product.seller_id).maybeSingle();
    if (!seller || seller.status !== 'active') return fail(400, 'This store isn\'t taking bookings right now.');
    if (units > (seller.booking_capacity || 1)) {
      return fail(409, `Only ${seller.booking_capacity || 1} can be booked at once.`, { code: 'SLOT_FULL' });
    }

    const duration = product.slot_duration_minutes || 60;
    const end = new Date(start.getTime() + duration * 60000);
    const now = Date.now();
    if (start.getTime() < now + MIN_LEAD_MINUTES * 60000) return fail(400, 'That time has passed — pick a later one.');
    if (start.getTime() > now + HORIZON_DAYS * 86400000) return fail(400, 'That date is too far ahead.');

    // The slot must sit inside one of the seller's weekly windows (SAST),
    // on that window's start grid (every booking_start_interval_minutes,
    // defaulting to the service's own duration), and finish by its close.
    const sp = sastParts(start);
    const ep = sastParts(end);
    const sameDay = ep.year === sp.year && ep.month === sp.month && ep.day === sp.day;
    const endMin = sameDay ? ep.minutes : 24 * 60;
    const step = seller.booking_start_interval_minutes || duration;
    const { data: windows } = await supabase.from('seller_availability')
      .select('day_of_week, start_time, end_time').eq('seller_id', seller.id).eq('day_of_week', sp.dayOfWeek);
    const fits = (windows || []).some(w => {
      const ws = toMinutes(w.start_time), we = toMinutes(w.end_time);
      return sp.minutes >= ws && endMin <= we && (sp.minutes - ws) % step === 0;
    });
    if (!fits || start.getUTCSeconds() !== 0) return fail(400, 'That time isn\'t available — pick another.');

    // Changing an existing hold (new time / different quantity): release it
    // first so it doesn't count against the new one. Only an unpaid hold.
    let released = null;
    if (typeof body.replaceBookingId === 'string' && body.replaceBookingId) {
      const { data: rel } = await supabase.from('service_bookings').update({ status: 'cancelled' })
        .eq('id', body.replaceBookingId).eq('status', 'held').is('order_id', null)
        .select('id, hold_expires_at');
      released = (rel || [])[0] || null;
    }
    // If the new time can't be held, give the buyer their old hold back
    // (while it's still within its own 30 minutes) instead of leaving them
    // with nothing. Re-checked by the capacity trigger like any hold.
    const restoreReleased = async () => {
      if (!released || new Date(released.hold_expires_at).getTime() <= Date.now()) return;
      const { error: rErr } = await supabase.from('service_bookings').update({ status: 'held' }).eq('id', released.id).eq('status', 'cancelled');
      if (rErr) console.warn('hold-service-booking: could not restore the previous hold', rErr.message);
    };

    const { data: booking, error } = await supabase.from('service_bookings').insert({
      seller_id: seller.id,
      product_id: product.id,
      buyer_user_id: buyerUserId,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      units,
      status: 'held',
      hold_expires_at: new Date(now + HOLD_MINUTES * 60000).toISOString()
    }).select('id, start_at, end_at, units, hold_expires_at').single();

    if (error) {
      await restoreReleased();
      if (/BOOKING_SLOT_FULL/.test(error.message || '')) {
        return fail(409, units > 1 ? `Not enough left at that time for ${units}. Try fewer or another time.` : 'That time was just taken — pick another.', { code: 'SLOT_FULL' });
      }
      console.error('hold-service-booking: insert error', error);
      return fail(500, 'Could not hold that time. Please try again.');
    }

    return { statusCode: 200, headers, body: JSON.stringify({
      bookingId: booking.id, startAt: booking.start_at, endAt: booking.end_at,
      units: booking.units, holdExpiresAt: booking.hold_expires_at
    }) };
  } catch (err) {
    console.error('hold-service-booking error', err);
    return fail(500, 'Could not hold that time. Please try again.');
  }
};
