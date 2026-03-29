const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

exports.handler = async function(event, context) {
    // Tell PayFast we received the notification
    const headers = {
        'Content-Type': 'text/plain'
    };

    // Immediately return 200 to prevent retries
    const immediateResponse = {
        statusCode: 200,
        headers,
        body: 'OK'
    };

    try {
        // Parse the POST data from PayFast
        const params = new URLSearchParams(event.body);
        const pfData = {};

        for (const [key, value] of params) {
            pfData[key] = value;
        }

        console.log('PayFast ITN received:', JSON.stringify(pfData, null, 2));

        // Initialize Supabase
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            console.error('Missing Supabase credentials');
            return immediateResponse;
        }

        const supabase = createClient(supabaseUrl, supabaseKey, {
            auth: { autoRefreshToken: false, persistSession: false }
        });

        // Verify the signature
        const passphrase = process.env.PAYFAST_PASSPHRASE || '';
        const signatureValid = verifySignature(pfData, passphrase);

        if (!signatureValid) {
            console.error('Invalid signature');
            return immediateResponse;
        }

        // Detect seller enrollment payments (from the static payf.st link)
        // These have item_name = "umzila seller sign up" and no m_payment_id
        const itemName = (pfData.item_name || '').toLowerCase();
        const isSellerEnrollment = itemName.includes('seller sign up') || itemName.includes('seller enrollment');

        if (pfData.payment_status === 'COMPLETE') {

            if (isSellerEnrollment && (!pfData.m_payment_id || pfData.m_payment_id.trim() === '')) {
                // Static link seller enrollment — no pre-created order row.
                // Insert one now using pf_payment_id as the identifier so
                // complete-seller-enrollment.js can verify payment.
                const { error: insertErr } = await supabase
                    .from('orders')
                    .insert({
                        m_payment_id:    pfData.pf_payment_id,
                        pf_payment_id:   pfData.pf_payment_id,
                        order_status:    'paid',
                        payment_status:  'paid',
                        customer_email:  pfData.email_address || '',
                        customer_name:   ((pfData.name_first || '') + ' ' + (pfData.name_last || '')).trim(),
                        total:           parseFloat(pfData.amount_gross || 100),
                        amount_gross:    parseFloat(pfData.amount_gross || 0),
                        amount_fee:      parseFloat(pfData.amount_fee || 0),
                        label:           'seller_enrollment',
                        items:           [{ item_name: 'Umzila Seller Enrollment Fee', quantity: 1, unit_price: 100, total: 100 }],
                        paid_at:         new Date().toISOString()
                    });

                if (insertErr) {
                    console.error('ITN: error inserting seller enrollment order', insertErr);
                } else {
                    console.log('ITN: seller enrollment order inserted for pf_payment_id', pfData.pf_payment_id);
                }

            } else {
                // Standard order (or old SELLER- prefixed enrollment) — update existing row
                const { error } = await supabase
                    .from('orders')
                    .update({
                        order_status:   'paid',
                        payment_status: 'paid',
                        pf_payment_id:  pfData.pf_payment_id,
                        amount_gross:   parseFloat(pfData.amount_gross || 0),
                        amount_fee:     parseFloat(pfData.amount_fee || 0),
                        amount_net:     parseFloat(pfData.amount_net || 0),
                        paid_at:        new Date().toISOString()
                    })
                    .eq('m_payment_id', pfData.m_payment_id);

                if (error) {
                    console.error('Error updating order:', error);
                } else {
                    console.log('Order marked as paid:', pfData.m_payment_id);
                }
            }

        } else if (pfData.payment_status === 'CANCELLED') {
            if (!isSellerEnrollment && pfData.m_payment_id) {
                const { error } = await supabase
                    .from('orders')
                    .update({
                        order_status:  'cancelled',
                        pf_payment_id: pfData.pf_payment_id
                    })
                    .eq('m_payment_id', pfData.m_payment_id);

                if (error) {
                    console.error('Error cancelling order:', error);
                }
            }
        }

        return immediateResponse;

    } catch (error) {
        console.error('ITN processing error:', error);
        return immediateResponse;
    }
};

// Verify PayFast signature
function verifySignature(pfData, passphrase = '') {
    // Create parameter string (excluding signature itself)
    let pfParamString = '';

    // Get all keys except signature
    const keys = Object.keys(pfData).filter(key => key !== 'signature');

    // Sort keys as they come from PayFast (in order received)
    for (const key of keys) {
        if (pfData[key] !== '') {
            pfParamString += `${key}=${encodeURIComponent(pfData[key].trim()).replace(/%20/g, '+').replace(/%[0-9a-f]{2}/gi, m => m.toUpperCase())}&`;
        }
    }

    // Remove last ampersand
    pfParamString = pfParamString.slice(0, -1);

    // Add passphrase if exists
    if (passphrase) {
        pfParamString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
    }

    // Calculate MD5 hash
    const calculatedSignature = crypto.createHash('md5').update(pfParamString).digest('hex');

    return calculatedSignature === pfData.signature;
}
