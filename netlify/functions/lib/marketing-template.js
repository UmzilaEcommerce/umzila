// netlify/functions/lib/marketing-template.js
//
// The one place the marketing email's HTML exists. Sellers/admins only
// ever supply plain-text wording slots (subject, headline, message, CTA
// text/destination) — layout, colors, and the offer block's numbers are
// fixed and derived, never typed by the sender. Matches the visual
// language already used across every other Umzila transactional email
// (navy gradient header, #e0284f accent, pill CTA, white card).

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

// slots: { subject, headline, bodyMessage, ctaText, ctaUrl, shopName,
//          codeRow, sellerShopName, siteUrl, unsubscribeUrl }
function renderMarketingEmail(slots) {
  const {
    headline, bodyMessage, ctaText, ctaUrl, shopName,
    codeRow, sellerShopName, siteUrl, unsubscribeUrl
  } = slots;

  const lines = codeRow ? deriveOfferLines(codeRow, sellerShopName) : null;

  const offerBlock = (codeRow && lines) ? `
    <div style="background:linear-gradient(135deg,#0a2f66,#1a4f8a);border-radius:12px;
                padding:22px 24px;text-align:center;margin:24px 0">
      <div style="font-size:13px;color:rgba(255,255,255,0.75);text-transform:uppercase;
                  letter-spacing:1px;font-weight:700">${esc(lines.offerLine)}</div>
      <div style="font-size:32px;font-weight:900;color:#ffd700;margin:10px 0;letter-spacing:3px;
                  font-family:ui-monospace,Menlo,monospace">${esc(codeRow.code)}</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.75)">${esc(lines.scopeLine)}</div>
      ${lines.expiryLine ? `
      <div style="display:inline-block;margin-top:12px;background:#e0284f;color:#fff;
                  border-radius:999px;padding:4px 14px;font-size:12px;font-weight:800">
        ${esc(lines.expiryLine)}</div>` : ''}
    </div>` : '';

  const codeNote = codeRow
    ? `<div style="text-align:center;font-size:12px;color:#999;margin-top:10px">One use per person. Apply the code at checkout.</div>`
    : '';

  const shopPill = shopName
    ? `<div style="margin-top:14px;display:inline-block;background:rgba(255,255,255,0.12);
                border:1px solid rgba(255,255,255,0.25);border-radius:999px;padding:5px 16px;
                font-size:12px;font-weight:700;color:#fff;letter-spacing:0.5px">
      A promotion from ${esc(shopName)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif">
<div style="max-width:580px;margin:30px auto;background:#fff;border-radius:14px;overflow:hidden;
            box-shadow:0 4px 20px rgba(0,0,0,0.08)">

  <div style="background:linear-gradient(135deg,#0a2f66,#1a4f8a);padding:30px 36px;text-align:center">
    <div style="font-size:28px;font-weight:900;color:#fff">Umzila</div>
    <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-top:4px">campus marketplace</div>
    ${shopPill}
  </div>

  <div style="padding:32px 36px">
    <div style="font-size:11px;font-weight:800;color:#e0284f;text-transform:uppercase;
                letter-spacing:1.5px;margin-bottom:8px">Limited-time offer</div>
    <h2 style="color:#0a2f66;margin:0 0 10px;font-size:23px;letter-spacing:-0.3px;line-height:1.25">
      ${esc(headline)}</h2>
    <p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 6px">${escWithBreaks(bodyMessage)}</p>

    ${offerBlock}

    <div style="text-align:center;margin:28px 0 8px">
      <a href="${esc(ctaUrl)}" style="display:inline-block;background:#0a2f66;color:#fff;
         padding:14px 40px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px">
        ${esc(ctaText)}</a>
    </div>
    ${codeNote}
  </div>

  <div style="background:#f4f6fb;padding:16px 36px;text-align:center;font-size:12px;color:#aaa;
              border-top:1px solid #eaecf0">
    <strong><a href="${esc(siteUrl)}" style="color:#0a2f66;text-decoration:none">Umzila</a></strong>
    &mdash; campus marketplace<br>
    <a href="${esc(unsubscribeUrl)}" style="color:#aaa;text-decoration:underline">Unsubscribe</a>
    &nbsp;·&nbsp; You received this because you subscribed at umzila.store
  </div>
</div>
</body>
</html>`;
}

module.exports = { renderMarketingEmail, deriveOfferLines, esc, escWithBreaks };
