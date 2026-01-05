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
        
        for (const rawItem of cartItems) {
  // Normalize incoming fields so the rest of the logic can rely on stable names
  const item = {
    id: rawItem.id || rawItem.product_id || rawItem.productId || null,
    name: rawItem.name || rawItem.title || '',
    price: typeof rawItem.price !== 'undefined' ? rawItem.price : (rawItem.Price || 0),
    quantity: rawItem.quantity || rawItem.qty || rawItem.Qty || 1,
    size: rawItem.size || rawItem.variant_size || 'One Size',
    image: rawItem.image || rawItem.img || '',
    variant_id: rawItem.variant_id || rawItem.variantId || rawItem.variant || null,
    // keep any other fields if needed
    _raw: rawItem
  };

  // now use `item` instead of rawItem below
  const pid = item.id;
  const product = productMap[pid];
  if (!product) {
    hasChanges = true;
    console.log('Product not found:', pid);
    continue;
  }

  // default
  let itemPrice = product.price;
  let itemStock = Number.isFinite(product.stock) ? product.stock : Infinity;
  let maxQuantity = itemStock;

  // If item has variant_id use that, else try by size
  let variant = null;
  if (item.variant_id) variant = variantMap[item.variant_id];
  if (!variant && item.size) variant = variantMap[`${pid}::${item.size}`];

  if (variant) {
    itemPrice = variant.price_override || product.price;
    itemStock = variant.stock != null ? variant.stock : itemStock;
    maxQuantity = itemStock;
  }

  if (product.sale && product.sale_price) {
    itemPrice = product.sale_price;
  }

  const qty = Math.min(item.quantity || 1, itemStock || Infinity);
  if (qty <= 0) {
    hasChanges = true;
    continue;
  }

  if (typeof item.price !== 'undefined' && Number(item.price) !== Number(itemPrice)) {
    hasChanges = true;
  }

  validatedCart.push({
    id: product.id,
    product_id: product.id,
    name: item.name || product.name,
    price: itemPrice,
    quantity: qty,
    size: item.size || 'One Size',
    image: product.image || item.image,
    variant_id: item.variant_id,
    max_quantity: maxQuantity,
    subtotal: itemPrice * qty
  });

  total += itemPrice * qty;
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