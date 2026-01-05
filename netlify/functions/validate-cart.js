const { createClient } = require('@supabase/supabase-js');

exports.handler = async function(event, context) {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }
    
    try {
        const { cartItems, userId } = JSON.parse(event.body);
        
        if (!cartItems || !Array.isArray(cartItems)) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid cart items' })
            };
        }
        
        // Initialize Supabase
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        if (!supabaseUrl || !supabaseKey) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Server configuration error' })
            };
        }
        
        const supabase = createClient(supabaseUrl, supabaseKey);
        
        // Get product IDs from cart
        const productIds = cartItems.map(item => item.id);
        
        // Fetch current product prices and stock
        const { data: products, error: productsError } = await supabase
            .from('products')
            .select(`
                id,
                price,
                sale,
                sale_price,
                stock,
                name,
                image,
                product_variants!fk_product_variants_product(
                    id,
                    size,
                    price_override,
                    stock
                )
            `)
            .in('id', productIds);
            
        if (productsError) {
            console.error('Error fetching products:', productsError);
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to validate cart' })
            };
        }
        
        // Create product map
        const productMap = {};
        products.forEach(product => {
            productMap[product.id] = product;
        });
        
        // Validate each cart item
        const validatedCart = [];
        let total = 0;
        let hasChanges = false;
        
        for (const item of cartItems) {
            const product = productMap[item.id];
            
            if (!product) {
                // Product no longer exists
                hasChanges = true;
                continue;
            }
            
            let itemPrice = product.price;
            let itemStock = product.stock;
            let maxQuantity = itemStock;
            
            // Check for variant
            if (product.product_variants && product.product_variants.length > 0) {
                const variant = product.product_variants.find(v => 
                    v.size === item.size || 
                    (item.variant_id && v.id === item.variant_id)
                );
                
                if (variant) {
                    itemPrice = variant.price_override || product.price;
                    itemStock = variant.stock || product.stock;
                    maxQuantity = itemStock;
                }
            }
            
            // Check for sale
            if (product.sale && product.sale_price) {
                itemPrice = product.sale_price;
            }
            
            // Validate quantity doesn't exceed stock
            const quantity = Math.min(item.quantity || 1, itemStock);
            
            if (quantity <= 0) {
                // Out of stock
                hasChanges = true;
                continue;
            }
            
            // Check if price has changed
            if (itemPrice !== item.price) {
                hasChanges = true;
            }
            
            validatedCart.push({
                id: product.id,
                name: product.name,
                price: itemPrice,
                quantity: quantity,
                size: item.size || 'One Size',
                image: product.image || item.image,
                variant_id: item.variant_id,
                max_quantity: maxQuantity,
                subtotal: itemPrice * quantity
            });
            
            total += itemPrice * quantity;
        }
        
        // If user is authenticated, update their cart in database
        if (userId) {
            const cartData = {
                items: validatedCart.map(item => ({
                    product_id: item.id,
                    name: item.name,
                    price: item.price,
                    quantity: item.quantity,
                    size: item.size,
                    image: item.image,
                    variant_id: item.variant_id,
                    max_quantity: item.max_quantity
                })),
                updated_at: new Date().toISOString()
            };
            
            await supabase
                .from('carts')
                .upsert({
                    user_id: userId,
                    ...cartData
                }, {
                    onConflict: 'user_id'
                });
        }
        
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                validatedCart,
                total,
                hasChanges,
                message: hasChanges ? 'Cart has been updated with current prices and stock' : 'Cart is valid'
            })
        };
        
    } catch (error) {
        console.error('Cart validation error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: 'Internal server error',
                details: error.message 
            })
        };
    }
};