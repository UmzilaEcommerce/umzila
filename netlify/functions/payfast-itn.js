const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

exports.handler = async function(event, context) {
    const headers = { 'Content-Type': 'text/plain' };

    // Always return 200 immediately to prevent PayFast retries
    const immediateResponse = { statusCode: 200, headers, body: 'OK' };

    try {
        const params = new URLSearchParams(event.body);
        const pfData = {};
        for (const [key, value] of params) {
            pfData[key] = value;
        }

        console.log('PayFast ITN received:', JSON.stringify(pfData, null, 2));

        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            console.error('Missing Supabase credentials');
            return immediateResponse;
        }

        const supabase = createClient(supabaseUrl, supabaseKey, {
            auth: { autoRefreshToken: false, persistSession: false }
        });

        const passphrase = process.env.PAYFAST_PASSPHRASE || '';
        const signatureValid = verifySignature(pfData, passphrase);

        if (!signatureValid) {
            console.error('Invalid PayFast signature — skipping update');
            return immediateResponse;
        }

        if (pfData.payment_status === 'COMPLETE') {
            // Mark order paid
            const { error: orderErr } = await supabase
                .from('orders')
                .update({
                    order_status:   'paid',
                    payment_status: 'paid',
                    pf_payment_id:  pfData.pf_payment_id,
                    pf_response:    pfData,
                    paid_at:        new Date().toISOString()
                })
                .eq('m_payment_id', pfData.m_payment_id);

            if (orderErr) {
                console.error('ITN: error updating order:', orderErr);
            } else {
                console.log('ITN: order marked as paid:', pfData.m_payment_id);
            }

            // ── Seller enrollment activation ───────────────────────────────
            // custom_str1 = 'seller_enrollment', custom_str2 = applicationId
            if (pfData.custom_str1 === 'seller_enrollment' && pfData.custom_str2) {
                await activateSellerEnrollment(supabase, pfData);
            }

        } else if (pfData.payment_status === 'CANCELLED') {
            const { error } = await supabase
                .from('orders')
                .update({
                    order_status:  'cancelled',
                    pf_payment_id: pfData.pf_payment_id
                })
                .eq('m_payment_id', pfData.m_payment_id);

            if (error) {
                console.error('ITN: error cancelling order:', error);
            }
        }

        return immediateResponse;

    } catch (error) {
        console.error('ITN processing error:', error);
        return immediateResponse;
    }
};

// ── Seller enrollment activation ─────────────────────────────────────────────
async function activateSellerEnrollment(supabase, pfData) {
    const applicationId = pfData.custom_str2;
    const email         = pfData.email_address;

    try {
        // Check application — skip if already completed (idempotency)
        const { data: app } = await supabase
            .from('seller_applications')
            .select('id, status, shop_name, full_name')
            .eq('id', applicationId)
            .maybeSingle();

        if (!app) {
            console.error('ITN seller activation: application not found', applicationId);
            return;
        }
        if (app.status === 'completed') {
            console.log('ITN seller activation: already completed, skipping');
            return;
        }

        // Get user from profile (created before payment by initiate-seller-enrollment)
        const { data: profile } = await supabase
            .from('profiles')
            .select('user_id')
            .eq('email', email)
            .maybeSingle();

        const userId = profile?.user_id || null;

        if (!userId) {
            console.error('ITN seller activation: no profile found for email', email);
            return;
        }

        // Activate the seller row
        const { error: sellerErr } = await supabase
            .from('sellers')
            .update({ status: 'active' })
            .eq('user_id', userId);

        if (sellerErr) {
            console.error('ITN seller activation: sellers update error', sellerErr);
        } else {
            console.log('ITN seller activation: sellers row set to active for user_id', userId);
        }

        // Mark application completed
        const { error: appErr } = await supabase
            .from('seller_applications')
            .update({ status: 'completed' })
            .eq('id', applicationId);

        if (appErr) {
            console.error('ITN seller activation: application update error', appErr);
        }

        // Send welcome email via Resend (non-fatal)
        const RESEND_KEY    = process.env.RESEND_API_KEY || '';
        const SITE_BASE_URL = (process.env.SITE_BASE_URL || '').replace(/\/$/, '');

        if (RESEND_KEY && email) {
            const name      = pfData.name_first ? (pfData.name_first + ' ' + (pfData.name_last || '')).trim() : (app.full_name || '');
            const shopName  = app.shop_name || '';
            const firstName = name.split(/\s+/)[0] || name;

            try {
                const emailRes = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${RESEND_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        from:    'Umzila Sellers <sellers@umzila.store>',
                        to:      [email],
                        subject: "You're officially an Umzila seller!",
                        html:    buildWelcomeEmail(firstName, email, shopName, SITE_BASE_URL)
                    })
                });
                if (!emailRes.ok) {
                    const t = await emailRes.text();
                    console.error('ITN: Resend welcome email error', emailRes.status, t);
                } else {
                    console.log('ITN: welcome email sent to', email);
                }
            } catch (emailErr) {
                console.error('ITN: failed to send welcome email', emailErr);
            }
        }

        console.log('ITN: seller enrollment fully activated for', email);

    } catch (err) {
        console.error('ITN: activateSellerEnrollment error', err);
    }
}

// ── PayFast signature verification ───────────────────────────────────────────
function verifySignature(pfData, passphrase = '') {
    let pfParamString = '';
    const keys = Object.keys(pfData).filter(key => key !== 'signature');

    for (const key of keys) {
        if (pfData[key] !== '') {
            pfParamString += `${key}=${encodeURIComponent(pfData[key].trim()).replace(/%20/g, '+').replace(/%[0-9a-f]{2}/gi, m => m.toUpperCase())}&`;
        }
    }

    pfParamString = pfParamString.slice(0, -1);

    if (passphrase) {
        pfParamString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
    }

    const calculatedSignature = crypto.createHash('md5').update(pfParamString).digest('hex');
    return calculatedSignature === pfData.signature;
}

// ── Welcome email builder ─────────────────────────────────────────────────────
function esc(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildWelcomeEmail(firstName, email, shopName, siteUrl) {
    const site = siteUrl || '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f4f6fb;font-family:system-ui,-apple-system,sans-serif}
  .wrap{max-width:580px;margin:40px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.09)}
  .hdr{background:#0a2f66;padding:32px 40px;text-align:center}
  .hdr h1{color:#fff;margin:0 0 6px;font-size:22px;font-weight:700}
  .hdr p{color:rgba(255,255,255,0.75);margin:0;font-size:14px}
  .badge{display:inline-block;background:#e0284f;color:#fff;font-size:12px;font-weight:700;padding:4px 12px;border-radius:999px;margin-top:12px;letter-spacing:.5px}
  .bd{padding:36px 40px}
  .bd h2{color:#0a2f66;margin:0 0 14px;font-size:20px}
  .bd p{color:#444;line-height:1.7;margin:0 0 16px;font-size:15px}
  .cta{text-align:center;margin:28px 0 24px}
  .btn{display:inline-block;background:#e0284f;color:#fff;padding:15px 36px;border-radius:999px;text-decoration:none;font-weight:700;font-size:16px}
  .info-box{background:#f0f4ff;border-radius:10px;padding:20px 24px;margin:24px 0}
  .info-box h3{color:#0a2f66;margin:0 0 14px;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  .info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e0e7f7;font-size:14px}
  .info-row:last-child{border-bottom:none;padding-bottom:0}
  .info-row .label{color:#666;font-weight:600}
  .info-row .val{color:#0a2f66;font-weight:700}
  .steps-box{background:#fff8f0;border:1px solid #ffe0b2;border-radius:10px;padding:20px 24px;margin:20px 0}
  .steps-box h3{color:#e65100;margin:0 0 12px;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  .steps-box ol{margin:0;padding-left:20px;color:#333;font-size:14px}
  .steps-box li{margin-bottom:10px;line-height:1.6}
  .note{font-size:13px;color:#888;line-height:1.6;background:#f9f9f9;border-radius:8px;padding:14px 18px;margin:20px 0}
  .ft{background:#f4f6fb;padding:20px 40px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eaecf0}
  .ft a{color:#0a2f66;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>Umzila Sellers</h1>
    <p>Your seller account is now active</p>
    <span class="badge">OFFICIAL SELLER</span>
  </div>
  <div class="bd">
    <h2>Welcome aboard, ${esc(firstName)}!</h2>
    <p>Your payment was confirmed and your seller account for <strong>${esc(shopName || 'your shop')}</strong> is now fully activated. You are officially an Umzila seller — congratulations!</p>
    <div class="cta">
      <a href="${site}/seller-dashboard.html" class="btn">Go to Seller Dashboard &rarr;</a>
    </div>
    <div class="info-box">
      <h3>Your login details</h3>
      <div class="info-row"><span class="label">Email</span><span class="val">${esc(email)}</span></div>
      <div class="info-row"><span class="label">Password</span><span class="val">The password you created before payment</span></div>
    </div>
    <div class="steps-box">
      <h3>Your next steps</h3>
      <ol>
        <li>Log in to your <a href="${site}/seller-dashboard.html" style="color:#e65100;font-weight:600">Seller Dashboard</a></li>
        <li>Finish setting up your store — add a shop description, logo, and contact details</li>
        <li>Create your first product and start selling</li>
      </ol>
    </div>
    <div class="note">
      <strong>How to log in next time:</strong><br>
      Go to <a href="${site}" style="color:#0a2f66">umzila.store</a> &rarr; click <strong>About</strong> &rarr; select <strong>Sign In</strong> &rarr; enter your email and password.
    </div>
    <p style="font-size:14px;color:#888">Questions? <a href="mailto:support@umzila.store" style="color:#0a2f66">support@umzila.store</a></p>
  </div>
  <div class="ft">
    <strong><a href="${site}">Umzila</a></strong> &mdash; campus marketplace<br>
    <a href="mailto:sellers@umzila.store">sellers@umzila.store</a>
  </div>
</div>
</body>
</html>`;
}
