// netlify/functions/lib/discounts.js
//
// Shared discount-code engine — required by validate-cart.js and
// payfast-itn.js. Not deployed as its own endpoint (lib/ files aren't
// picked up by Netlify as functions).
//
// Two code generations coexist in `discount_codes`:
//   - multi_use = false (referral / mystery-gift / gift codes): single
//     global use via the existing `used` boolean, exactly as before —
//     untouched, guest-usable, nothing here changes their behavior.
//   - multi_use = true (admin/seller-created promo codes): redemption is
//     tracked per real signed-in account in `discount_redemptions`.
//     Guests (no userId) can PREVIEW a multi_use code's value but can
//     never actually redeem it — identity has to be a verified account,
//     not a self-typed email, or "once per person" isn't enforceable.

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Loads a code and runs every eligibility check that doesn't depend on the
// cart contents (existence, status, expiry, email lock, first-order-only,
// redemption limits). Cart-dependent eligibility (scope/seller matching,
// the actual rand amount) is computeDiscount()'s job, run separately once
// validatedCart is available.
async function validateCode(supabase, { code, email, userId }) {
  if (!code) return { ok: false, reason: 'missing_code' };

  const { data: codeRow, error } = await supabase
    .from('discount_codes')
    .select('*')
    .eq('code', String(code).trim().toUpperCase())
    .maybeSingle();

  if (error || !codeRow) return { ok: false, reason: 'not_found' };
  if (codeRow.status === 'disabled') return { ok: false, reason: 'disabled' };
  if (codeRow.expires_at && new Date(codeRow.expires_at) < new Date()) {
    return { ok: false, reason: 'expired' };
  }

  // Email lock — both generations honor this (a mystery-gift code, or an
  // admin/seller code deliberately issued to one specific address).
  if (codeRow.email) {
    const buyerEmail = (email || '').trim().toLowerCase();
    if (!buyerEmail) return { ok: false, reason: 'email_required' };
    if (codeRow.email.trim().toLowerCase() !== buyerEmail) {
      return { ok: false, reason: 'email_mismatch' };
    }
  }

  // First-order-only — both generations honor this, moved server-side from
  // what used to be a client-only check in checkout.html.
  if (codeRow.first_order_only && userId) {
    const { count } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('order_status', 'paid');
    if (count && count > 0) return { ok: false, reason: 'not_first_order' };
  }

  if (!codeRow.multi_use) {
    // Legacy path — single global use, guest-usable, byte-identical to the
    // behavior that existed before this feature.
    if (codeRow.used) return { ok: false, reason: 'already_used' };
    return { ok: true, codeRow };
  }

  // Multi-use path — requires a real account. A guest can still see what
  // the code is worth (previewOnly), but it can't be redeemed until they
  // sign in, since "once per person" only means something against a
  // verified identity, not a text field anyone can retype.
  if (!userId) {
    return { ok: true, codeRow, previewOnly: true, requiresSignIn: true };
  }

  if (codeRow.max_redemptions != null) {
    const { count: totalCount } = await supabase
      .from('discount_redemptions')
      .select('id', { count: 'exact', head: true })
      .eq('discount_code_id', codeRow.id);
    if ((totalCount || 0) >= codeRow.max_redemptions) {
      return { ok: false, reason: 'fully_redeemed' };
    }
  }

  const perUserLimit = codeRow.per_user_limit || 1;
  const { count: userCount } = await supabase
    .from('discount_redemptions')
    .select('id', { count: 'exact', head: true })
    .eq('discount_code_id', codeRow.id)
    .eq('user_id', userId);
  if ((userCount || 0) >= perUserLimit) {
    return { ok: false, reason: 'already_redeemed_by_you' };
  }

  return { ok: true, codeRow };
}

// Computes the actual rand amount a valid code is worth against a
// server-priced cart (validate-cart.js's validatedCart — already clamped
// to real prices/stock, so this never trusts client-supplied numbers).
// `sellerShopName` is optional, used only for display copy.
function computeDiscount(codeRow, validatedCart, sellerShopName) {
  const cart = validatedCart || [];
  const productItems = cart.filter(i => (i.listing_type || 'product') !== 'service');

  const eligible = productItems.filter(item => {
    // THE WALL — a seller-owned code can only ever touch that seller's own
    // line items, unconditionally, regardless of what "scope" says.
    if (codeRow.seller_id && String(item.seller_id) !== String(codeRow.seller_id)) return false;
    if (codeRow.scope === 'products') {
      const ids = (codeRow.product_ids || []).map(String);
      if (!ids.includes(String(item.product_id || item.id))) return false;
    }
    return true;
  });

  const eligibleSubtotal = round2(eligible.reduce((s, i) => s + (i.price * i.quantity), 0));

  const scopeLabel = codeRow.seller_id
    ? (codeRow.scope === 'products'
        ? `selected items from ${sellerShopName || 'this seller'}`
        : `everything from ${sellerShopName || 'this seller'}`)
    : (codeRow.scope === 'products' ? 'selected items' : 'your whole order');

  if (!eligible.length || eligibleSubtotal <= 0) {
    return { amount: 0, eligibleSubtotal: 0, matchedItems: [], scopeLabel, reason: 'no_eligible_items' };
  }
  if (codeRow.min_order_amount && eligibleSubtotal < codeRow.min_order_amount) {
    return { amount: 0, eligibleSubtotal, matchedItems: [], scopeLabel, reason: 'below_minimum' };
  }

  let amount;
  if (codeRow.type === 'percentage' || codeRow.type === 'mystery_gift') {
    amount = round2(eligibleSubtotal * (codeRow.amount || 0) / 100);
    if (codeRow.max_discount_amount) amount = Math.min(amount, codeRow.max_discount_amount);
  } else {
    // fixed / referrer_reward — clamped to what's actually eligible, the
    // other half of the seller wall: a "R100 off" code mathematically
    // cannot bleed past that seller's own line items.
    amount = Math.min(codeRow.amount || 0, eligibleSubtotal);
  }
  amount = round2(Math.max(0, amount));

  // Per-line breakdown for the audit record — proportional to each
  // eligible line's share of the eligible subtotal.
  const matchedItems = eligible.map(item => {
    const lineSubtotal = round2(item.price * item.quantity);
    const lineShare = eligibleSubtotal > 0 ? round2(amount * (lineSubtotal / eligibleSubtotal)) : 0;
    return {
      product_id: item.product_id || item.id,
      seller_id: item.seller_id || null,
      name: item.name,
      quantity: item.quantity,
      line_subtotal: lineSubtotal,
      line_discount: lineShare
    };
  });

  return { amount, eligibleSubtotal, matchedItems, scopeLabel };
}

module.exports = { validateCode, computeDiscount, round2 };
