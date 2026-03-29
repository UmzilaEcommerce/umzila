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

        if (pfData.payment_status === 'COMPLETE') {
            // Update the pre-created order row (works for both product orders
            // and seller enrollment orders created by initiate-seller-enrollment.js)
            const { error } = await supabase
                .from('orders')
                .update({
                    order_status:   'paid',
                    payment_status: 'paid',
                    pf_payment_id:  pfData.pf_payment_id,
                    pf_response:    pfData,
                    paid_at:        new Date().toISOString()
                })
                .eq('m_payment_id', pfData.m_payment_id);

            if (error) {
                console.error('ITN: error updating order:', error);
            } else {
                console.log('ITN: order marked as paid:', pfData.m_payment_id);
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
