// netlify/functions/lib/marketing-template.js
//
// The one place the marketing email's HTML exists. Sellers/admins only
// ever supply plain-text wording slots (subject, headline, message, CTA
// text/destination) — layout, colors, and the offer block's numbers are
// fixed and derived, never typed by the sender. Optional rich slots (photo,
// price/was, urgency line, highlights) come from the campaign row (2026-11-25).

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escWithBreaks(str) {
  return esc(str).replace(/\n/g, '<br>');
}

// Computes the offer/scope/expiry lines from the actual discount_codes row
// — never from anything a seller/admin typed — so the email can't say
// something the code doesn't actually do.
function deriveOfferLines(codeRow, sellerShopName) {
  if (!codeRow) return null;
  const offerLine = codeRow.type === 'percentage'
    ? `${codeRow.amount}% OFF`
    : `R${codeRow.amount} OFF`;

  let scopeLine;
  if (codeRow.seller_id) {
    scopeLine = codeRow.scope === 'products'
      ? `on selected items from ${sellerShopName || 'this seller'}`
      : `on everything from ${sellerShopName || 'this seller'}`;
  } else {
    scopeLine = codeRow.scope === 'products' ? 'on selected items' : 'on everything at Umzila';
  }

  const expiryLine = codeRow.expires_at
    ? `Expires ${new Date(codeRow.expires_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' })}`
    : null;

  return { offerLine, scopeLine, expiryLine };
}

const ACCENT = '#e0284f', NAVY = '#0a2f66', INK = '#111827';
function money(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '';
  return 'R' + (Math.round(x * 100) % 100 ? x.toFixed(2) : String(Math.round(x)));
}
function safeImg(u) { return /^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : ''; }

// slots: { headline, bodyMessage, ctaText, ctaUrl, shopName, codeRow, sellerShopName,
//          imageUrl, eyebrow, urgency, highlights[], offerPrice, offerWas, siteUrl, unsubscribeUrl }
// Conversion layout: photo → eyebrow → headline → price (old price struck through +
// "Save R…") → urgency strip → message → ✓ highlights → big button → code block →
// trust row. Every rich slot is optional; table-based so Gmail/Outlook/phone mail
// apps render it the same.
function renderMarketingEmail(slots) {
  const {
    headline, bodyMessage, ctaText, ctaUrl, shopName,
    codeRow, sellerShopName, siteUrl, unsubscribeUrl,
    imageUrl, eyebrow, urgency, highlights, offerPrice, offerWas
  } = slots;

  const lines = codeRow ? deriveOfferLines(codeRow, sellerShopName) : null;
  const img = safeImg(imageUrl);
  const hasPrice = offerPrice != null && offerPrice !== '' && Number(offerPrice) >= 0;
  const hasWas = hasPrice && offerWas != null && Number(offerWas) > Number(offerPrice);
  const hl = (Array.isArray(highlights) ? highlights : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 6);

  const heroImg = img ? `
  <tr><td style="padding:0"><a href="${esc(ctaUrl)}" style="display:block"><img src="${esc(img)}" width="600" alt="${esc(headline)}" style="display:block;width:100%;max-width:600px;height:auto;border:0"></a></td></tr>` : '';

  const priceBlock = hasPrice ? `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 6px"><tr>
        <td style="font-size:52px;line-height:1;font-weight:900;color:${ACCENT};letter-spacing:-1.5px;padding-right:14px">${esc(money(offerPrice))}</td>
        ${hasWas ? `<td style="vertical-align:middle">
          <div style="font-size:20px;color:#9ca3af;font-weight:700;text-decoration:line-through">${esc(money(offerWas))}</div>
          <div style="display:inline-block;margin-top:4px;background:#fef3c7;color:#92400e;border-radius:999px;padding:4px 11px;font-size:13px;font-weight:800">Save ${esc(money(Number(offerWas) - Number(offerPrice)))}</div>
        </td>` : ''}
      </tr></table>` : '';

  const urgencyStrip = urgency ? `
      <div style="margin:16px 0 4px;background:#fff7ed;border:1px solid #fed7aa;border-left:4px solid #f97316;border-radius:12px;padding:12px 14px;font-size:15px;font-weight:700;color:#9a3412">⏰ ${esc(urgency)}</div>` : '';

  const highlightList = hl.length ? `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0 4px;width:100%">
        ${hl.map(h => `<tr><td style="width:28px;vertical-align:top;padding:5px 0"><div style="width:20px;height:20px;border-radius:50%;background:#dcfce7;color:#15803d;font-size:13px;font-weight:900;line-height:20px;text-align:center">✓</div></td><td style="padding:5px 0;font-size:15.5px;color:${INK};line-height:1.45">${esc(h)}</td></tr>`).join('')}
      </table>` : '';

  const offerBlock = (codeRow && lines) ? `
      <div style="background:${NAVY};border-radius:14px;padding:20px 22px;text-align:center;margin:20px 0 4px">
        <div style="font-size:12px;color:rgba(255,255,255,0.75);text-transform:uppercase;letter-spacing:1.5px;font-weight:800">${esc(lines.offerLine)} · use code</div>
        <div style="font-size:30px;font-weight:900;color:#ffd700;margin:8px 0;letter-spacing:3px;font-family:ui-monospace,Menlo,monospace">${esc(codeRow.code)}</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.8)">${esc(lines.scopeLine)}${lines.expiryLine ? ' · ' + esc(lines.expiryLine) : ''}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:6px">One use per person. Apply it at checkout.</div>
      </div>` : '';

  const shopLine = shopName ? `<span style="display:inline-block;background:#f1f5f9;color:#334155;border-radius:999px;padding:5px 12px;font-size:12px;font-weight:700">From ${esc(shopName)}</span>` : '';
  const preheader = (eyebrow ? eyebrow + ' — ' : '') + String(bodyMessage || '').slice(0, 110);

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(headline)}</title></head>
<body style="margin:0;padding:0;background:#eef1f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 6px 28px rgba(15,23,42,.10)">
  <tr><td style="padding:16px 24px;border-bottom:1px solid #f1f5f9">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:22px;font-weight:900;color:${NAVY};letter-spacing:-.5px">umzila<span style="color:${ACCENT}">.</span></td>
      <td align="right">${shopLine}</td>
    </tr></table>
  </td></tr>${heroImg}
  <tr><td style="padding:26px 28px 8px">
      ${eyebrow ? `<div style="font-size:12px;font-weight:900;color:${ACCENT};text-transform:uppercase;letter-spacing:2px;margin-bottom:8px">${esc(eyebrow)}</div>` : ''}
      <h1 style="margin:0;color:${INK};font-size:30px;line-height:1.15;font-weight:900;letter-spacing:-.6px">${esc(headline)}</h1>
      ${priceBlock}
      ${urgencyStrip}
      <p style="color:#374151;font-size:16px;line-height:1.65;margin:16px 0 4px">${escWithBreaks(bodyMessage)}</p>
      ${highlightList}
      ${offerBlock}
  </td></tr>
  <tr><td style="padding:18px 28px 6px">
    <a href="${esc(ctaUrl)}" style="display:block;background:${ACCENT};color:#ffffff;text-align:center;padding:18px 20px;border-radius:14px;text-decoration:none;font-weight:800;font-size:18px;letter-spacing:.2px;box-shadow:0 8px 22px rgba(224,40,79,.35)">${esc(ctaText || 'Order now')} &rarr;</a>
    <div style="text-align:center;font-size:13px;color:#6b7280;margin-top:10px">Takes under a minute &middot; pay by card, Capitec Pay or EFT</div>
  </td></tr>
  <tr><td style="padding:18px 28px 24px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:14px"><tr>
      <td align="center" style="padding:14px 6px;font-size:12.5px;color:#334155;font-weight:700;width:33%">🛵<br>Delivered to you</td>
      <td align="center" style="padding:14px 6px;font-size:12.5px;color:#334155;font-weight:700;width:33%">🔒<br>Secure PayFast checkout</td>
      <td align="center" style="padding:14px 6px;font-size:12.5px;color:#334155;font-weight:700;width:33%">💬<br>Real people on WhatsApp</td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#f8fafc;padding:18px 28px;text-align:center;font-size:12px;color:#9ca3af;border-top:1px solid #eef1f6;line-height:1.7">
    <a href="${esc(siteUrl)}" style="color:${NAVY};text-decoration:none;font-weight:800">Umzila</a> &mdash; Durban&rsquo;s best local businesses, delivered<br>
    You get this because you signed up at umzila.store &middot; <a href="${esc(unsubscribeUrl)}" style="color:#9ca3af;text-decoration:underline">Unsubscribe</a>
  </td></tr>
</table>
</td></tr></table>
</body>
</html>`;
}

module.exports = { renderMarketingEmail, deriveOfferLines, esc, escWithBreaks };
