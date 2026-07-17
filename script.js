// Escapes untrusted text (seller-supplied product titles, etc.) before it's
// interpolated into an innerHTML template — this file renders many product
// cards via innerHTML and previously had no escaping helper at all.
function esc(s) {
  return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/********************
 * SAST (Africa/Johannesburg) time helpers — fixed UTC+2 year-round, no DST,
 * so this is simple offset math, no timezone library needed. Used anywhere
 * a time is shown to a buyer/rep or a day/time grid input is interpreted,
 * instead of trusting the browser's local timezone (which may not be SAST).
 ********************/
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

// Formats an ISO string or Date as SAST wall-clock time.
function formatSAST(input, opts) {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(input);
  return d.toLocaleString('en-ZA', Object.assign({ timeZone: 'Africa/Johannesburg' }, opts));
}

// Builds the real UTC instant for a SAST wall-clock y/m/d/hh/mm (month is 1-12).
function sastDate(y, m, d, hh, mm) {
  return new Date(Date.UTC(y, m - 1, d, hh || 0, mm || 0, 0, 0) - SAST_OFFSET_MS);
}

// Reads y/m/d/hh/mm/dayOfWeek as they'd appear on a SAST wall clock for a given instant.
function sastParts(input) {
  const d = input instanceof Date ? input : new Date(input);
  const shifted = new Date(d.getTime() + SAST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), dayOfWeek: shifted.getUTCDay()
  };
}

/********************
 * Supabase initialization via Netlify function
 ********************/
(async function initSupabaseClient(){
  try {
    const res = await fetch('/.netlify/functions/get-client-config');
    if (!res.ok) {
      console.error('Failed to load Supabase config', res.status, await res.text());
      return;
    }
    const cfg = await res.json();

    // Support multiple key styles (camelCase and UPPER_SNAKE)
    const supabaseUrl =
      cfg.supabaseUrl ||
      cfg.SUPABASE_URL ||
      cfg.supabase_url ||
      '';
    const supabaseAnonKey =
      cfg.supabaseAnonKey ||
      cfg.SUPABASE_ANON_KEY ||
      cfg.supabase_anon_key ||
      '';

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error('Missing Supabase config from server');
      return;
    }

    // Initialize Supabase client
    const supabaseClient = supabase.createClient(supabaseUrl, supabaseAnonKey);
    window.supabase = supabaseClient; // global

    // Notify other scripts
    document.dispatchEvent(new CustomEvent('supabase-ready', { detail: { supabase: supabaseClient } }));
    console.log('Supabase client initialized');
  } catch (err) {
    console.error('Error initializing Supabase client', err);
  }
})();

/********************
 * SECURITY FUNCTIONS
 ********************/
// Prevent price tampering - validate all prices on server
function validatePriceIntegrity(cartItem, serverPrice) {
  // Allow small rounding differences
  const priceDiff = Math.abs(cartItem.price - serverPrice);
  const allowedDiff = 0.01; // 1 cent tolerance
  
  if (priceDiff > allowedDiff) {
    console.warn(`Price mismatch for ${cartItem.name}: Client ${cartItem.price}, Server ${serverPrice}`);
    return serverPrice; // Use server price
  }
  
  return cartItem.price;
}

// Rate limiting for cart updates
const cartUpdateLimiter = {
  lastUpdate: 0,
  minInterval: 1000, // 1 second between updates
  
  canUpdate() {
    const now = Date.now();
    if (now - this.lastUpdate > this.minInterval) {
      this.lastUpdate = now;
      return true;
    }
    return false;
  }
};

// Sanitize cart data
function sanitizeCartData(cart) {
  return cart.map(item => {
    // Accept either item.id or item.product_id; normalize to id (string)
    const rawId = item.id || item.product_id || item.productId || item.product_id;
    const id = (typeof rawId === 'string' || typeof rawId === 'number') ? String(rawId) : null;

    // Price: accept numbers or numeric strings
    let price = 0;
    if (typeof item.price === 'number') {
      price = Number(item.price);
    } else if (typeof item.price === 'string' && item.price.trim() !== '') {
      const p = parseFloat(item.price.replace(/[^0-9.-]+/g, ''));
      price = Number.isFinite(p) ? p : 0;
    }

    const quantity = (typeof item.quantity === 'number') ? Math.max(1, Math.floor(item.quantity)) :
                     (typeof item.qty === 'number' ? Math.max(1, Math.floor(item.qty)) : 1);

    return {
      // keep both id and product_id so other code can use either
      id,
      product_id: id,
      name: typeof item.name === 'string' ? item.name.substring(0, 100) : '',
      price: Math.max(0, Number(price.toFixed ? Number(price).toFixed(2) : price)),
      quantity,
      size: typeof item.size === 'string' ? item.size.substring(0, 20) : 'One Size',
      image: typeof item.image === 'string' ? item.image.substring(0, 500) : '',
      variant_id: item.variant_id || item.variantId || null
    };
  })
  .filter(item => item.id && item.price > 0);
}

/********************
 * SECURE CART MANAGEMENT WITH SUPABASE SYNC
 ********************/

// Enhanced cart item structure
const cartItemStructure = {
  product_id: null,
  name: '',
  price: 0,
  quantity: 1,
  size: 'One Size',
  image: '',
  variant_id: null,
  stock: 0,
  max_quantity: 0,
  created_at: new Date().toISOString()
};

// Save cart to Supabase (if logged in) and localStorage
async function saveCartToServer() {
  if (!supabaseClient || !currentUser) return;
  
  // Rate limiting check
  if (!cartUpdateLimiter.canUpdate()) {
    console.log('Rate limited: skipping cart update');
    return;
  }
  
  try {
    const cartData = {
      items: state.cart.map(item => ({
        product_id: item.id,
        name: item.title,
        price: item.price,
        quantity: item.qty,
        size: item.size,
        image: item.img,
        variant_id: item.variantId || null,
        stock: item.stock || 0,
        max_quantity: item.maxQuantity || item.qty
      })),
      updated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    };
    
    // Sanitize data before sending
    const sanitizedItems = sanitizeCartData(cartData.items);
    
    // Upsert cart to Supabase
    const { data, error } = await supabaseClient
      .from('carts')
      .upsert({
        user_id: currentUser.id,
        items: sanitizedItems,
        updated_at: cartData.updated_at,
        expires_at: cartData.expires_at
      }, {
        onConflict: 'user_id'
      })
      .select()
      .single();
      
    if (error) {
      console.error('Error saving cart to server:', error);
    } else {
      console.log('Cart saved to server successfully');
    }
  } catch (error) {
    console.error('Error in saveCartToServer:', error);
  }
}

// Load cart from Supabase (if logged in) or localStorage
async function loadCartWithSync() {
  try {
    if (supabaseClient && currentUser) {
      // Load from Supabase
      const { data, error } = await supabaseClient
        .from('carts')
        .select('items')
        .eq('user_id', currentUser.id)
        .single();
        
      if (!error && data && data.items) {
        // Sanitize and validate server cart items
        const sanitizedItems = sanitizeCartData(data.items);
        
        // Convert server cart items to local format
        state.cart = sanitizedItems.map(item => ({
          id: item.product_id,
          title: item.name,
          price: item.price,
          qty: item.quantity,
          size: item.size,
          img: item.image,
          variantId: item.variant_id,
          stock: item.stock,
          maxQuantity: item.max_quantity
        }));
        
        // Validate prices against current product data
        await validateCartPrices();
        
        // Save to localStorage for consistency
        localStorage.setItem('ss_cart', JSON.stringify(state.cart));
      } else {
        // Fallback to localStorage
        const savedCart = localStorage.getItem('ss_cart');
        if (savedCart) {
          state.cart = JSON.parse(savedCart);
          // Sync to server
          await saveCartToServer();
        }
      }
    } else {
      // Not logged in, use localStorage only
      const savedCart = localStorage.getItem('ss_cart');
      if (savedCart) {
        state.cart = JSON.parse(savedCart);
      }
    }
    
    updateCartBadge();
    
  } catch (error) {
    console.error('Error loading cart:', error);
    const savedCart = localStorage.getItem('ss_cart');
    state.cart = savedCart ? JSON.parse(savedCart) : [];
  }
}

// Validate cart prices against current product data
async function validateCartPrices() {
  if (!supabaseClient || state.cart.length === 0) return;
  
  try {
    // Get all product IDs from cart
    const productIds = state.cart.map(item => item.id);
    
    // Fetch current product data
    const { data: products, error } = await supabaseClient
      .from('products')
      .select(`
        id,
        price,
        sale,
        sale_price,
        product_variants!fk_product_variants_product(*)
      `)
      .in('id', productIds);
      
    if (error || !products) return;
    
    // Create product map
    const productMap = {};
    products.forEach(product => {
      productMap[product.id] = product;
    });
    
    // Validate each cart item
    state.cart = state.cart.map(item => {
      const product = productMap[item.id];
      if (!product) return item;
      
      let correctPrice = product.price;
      
      // Check if product is on sale
      if (product.sale && product.sale_price) {
        correctPrice = product.sale_price;
      }
      
      // Check for variant price override
      if (item.variantId && product.product_variants) {
        const variant = product.product_variants.find(v => v.id === item.variantId);
        if (variant && variant.price_override) {
          correctPrice = variant.price_override;
        }
      }
      
      // Validate price integrity
      item.price = validatePriceIntegrity(item, correctPrice);
      return item;
    });
    
  } catch (error) {
    console.error('Error validating cart prices:', error);
  }
}

// Enhanced add to cart function with validation - FIXED TO WORK PROPERLY
async function addToCart(id, qty = 1, size = 'M', preferred_delivery = '', serviceExtra = null) {
  const p = state.products.find(x => x.id === id);
  if (!p) return;

  // Refuse hidden products
  if (!p.visible) return;
  const isService = p.listing_type === 'service';
  if (!isService && (p.stock || 0) <= 0) { showNotification('This item is out of stock.'); return; }

  // Check stock (skip for services)
  const variant = !isService ? p.variants?.find(v => v.size === size) : null;
  const variantId = variant ? variant.id : null;
  const variantStock = isService ? Infinity : (variant ? variant.stock : p.stock);

  if (!isService && variantStock < qty) {
    alert(`Only ${variantStock} items available for size ${size}`);
    return;
  }
  
  // Get correct price (use variant price_override if available)
  const price = variant && variant.price_override ? variant.price_override : 
                (p.sale && p.salePrice ? p.salePrice : p.price);
  
  const existing = state.cart.find(i => i.id === id && i.size === size);
  
  if (existing) {
    // Check if we can add more
    if (existing.qty + qty > variantStock) {
      alert(`Cannot add more items. Only ${variantStock - existing.qty} more available for size ${size}`);
      return;
    }
    existing.qty += qty;
  } else {
    state.cart.push({
      id,
      title: p.title,
      price,
      qty,
      size: isService ? 'One Size' : size,
      img: (p.primary_image || (p.imgs && p.imgs[0]) || svgPlaceholder(p.title)),
      variantId: isService ? null : variantId,
      stock: isService ? null : variantStock,
      maxQuantity: isService ? null : variantStock,
      preferred_delivery: isService ? '' : (preferred_delivery || ''),
      seller_id: (p.seller && p.seller.id) ? p.seller.id : null,
      listing_type: p.listing_type || 'product',
      fulfillment_type: p.fulfillment_type || null,
      service_turnaround: p.service_turnaround || null,
      item_returned: isService ? (p.item_returned !== false) : null,
      delivery_class: !isService ? (p.delivery_class || 'small') : null,
      free_delivery: !isService ? (p.free_delivery === true) : false,
      units_per_trip: !isService ? (p.units_per_trip || null) : null,
      intake: isService ? (serviceExtra && serviceExtra.intake) || null : null,
      booking_id: isService ? (serviceExtra && serviceExtra.booking_id) || null : null,
      booking_start_at: isService ? (serviceExtra && serviceExtra.booking_start_at) || null : null,
      service_options: isService ? (serviceExtra && serviceExtra.service_options) || null : null
    });
  }
  
  // Save to localStorage
  localStorage.setItem('ss_cart', JSON.stringify(state.cart));

  // Save to Supabase if logged in
  if (supabaseClient && currentUser) {
    await saveCartToServer();
  }

  updateCartBadge();

  // Track add to cart
  trackEvent('add_to_cart', {
    product_id: p.id,
    seller_id:  p.seller && p.seller.id ? p.seller.id : null,
    category:   p.category,
    metadata:   { qty: qty, size: size }
  });

  // Show success notification
  showNotification(`Added ${qty} ${p.title} to cart!`);
}

// Update cart badge
function updateCartBadge() {
  const totalItems = state.cart.reduce((sum, item) => sum + item.qty, 0);
  if (cartCount) cartCount.textContent = totalItems;
  
  // Update all cart count elements
  document.querySelectorAll('.cart-count').forEach(element => {
    element.textContent = totalItems;
  });

  // The bottom-nav badge is a small dot — hide it entirely at zero rather
  // than showing an empty "0", matching normal app-nav conventions.
  document.querySelectorAll('.mbn-badge').forEach(el => {
    el.style.display = totalItems > 0 ? 'flex' : 'none';
  });
}

// Clear cart from server and localStorage
async function clearCart() {
  state.cart = [];
  localStorage.removeItem('ss_cart');
  
  if (supabaseClient && currentUser) {
    try {
      await supabaseClient
        .from('carts')
        .delete()
        .eq('user_id', currentUser.id);
    } catch (error) {
      console.error('Error clearing server cart:', error);
    }
  }
  
  updateCartBadge();
}

// Initialize cart on page load
async function initializeCart() {
  await loadCartWithSync();
}

// Call this when user logs in
async function syncCartOnLogin(user) {
  // Get localStorage cart
  const localCart = JSON.parse(localStorage.getItem('ss_cart') || '[]');
  
  if (localCart.length > 0) {
    // Merge with server cart
    await loadCartWithSync();
    
    // Add localStorage items to server cart if not already present
    const serverIds = state.cart.map(item => `${item.id}-${item.size}`);
    
    localCart.forEach(item => {
      const itemKey = `${item.id}-${item.size}`;
      if (!serverIds.includes(itemKey)) {
        state.cart.push(item);
      }
    });
    
    // Save merged cart
    localStorage.setItem('ss_cart', JSON.stringify(state.cart));
    await saveCartToServer();
  } else {
    // No local cart, just load server cart
    await loadCartWithSync();
  }
  
  updateCartBadge();
}

/********************
 * MOBILE FUNCTIONALITY
 ********************/

// Mobile detection
const isMobile = () => window.innerWidth <= 768;

// Mobile search functionality
function initMobileSearch() {
  const mobileSearchIcon = document.getElementById('mobileSearchIcon');
  const mobileSearchClose = document.getElementById('mobileSearchClose');
  const mainSearchBar = document.getElementById('mainSearchBar');
  const searchInput = document.getElementById('searchInput');
  
  if (mobileSearchIcon && mainSearchBar && mobileSearchClose) {
    mobileSearchIcon.addEventListener('click', () => {
      mainSearchBar.classList.add('mobile-active');
      mobileSearchClose.style.display = 'block';
      searchInput.focus();
    });
    
    mobileSearchClose.addEventListener('click', () => {
      mainSearchBar.classList.remove('mobile-active');
      mobileSearchClose.style.display = 'none';
    });
    
    // Hide mobile search on window resize
    window.addEventListener('resize', () => {
      if (!isMobile()) {
        mainSearchBar.classList.remove('mobile-active');
        mobileSearchClose.style.display = 'none';
      }
    });
  }
}

// Mobile menu functionality
function initMobileMenu() {
  const mobileMenu = document.getElementById('mobileMenu');
  const mobileMenuClose = document.getElementById('mobileMenuClose');
  const mobileMenuOverlay = document.getElementById('mobileMenuOverlay');
  const mobileShopItem = document.getElementById('mobileShopItem');
  const mobileCategoriesList = document.getElementById('mobileCategoriesList');
  const mobileSignIn = document.getElementById('mobileSignIn');
  const mobileMenuIcon = document.getElementById('mobileMenuIcon');
  
  if (mobileMenuIcon) {
    // Show mobile menu icon on mobile
    if (isMobile()) {
      mobileMenuIcon.style.display = 'block';
    }
    
    mobileMenuIcon.addEventListener('click', () => {
      mobileMenu.classList.add('active');
      mobileMenuOverlay.classList.add('active');
      document.body.style.overflow = 'hidden';
    });
  }
  
  if (mobileMenu) {
    mobileMenuClose.addEventListener('click', () => {
      mobileMenu.classList.remove('active');
      mobileMenuOverlay.classList.remove('active');
      document.body.style.overflow = '';
    });
    
    mobileMenuOverlay.addEventListener('click', () => {
      mobileMenu.classList.remove('active');
      mobileMenuOverlay.classList.remove('active');
      document.body.style.overflow = '';
    });
    
    // Toggle categories in mobile menu
    if (mobileShopItem && mobileCategoriesList) {
      mobileShopItem.addEventListener('click', () => {
        mobileCategoriesList.classList.toggle('active');
      });
    }
    
    // Mobile sell on Umzila
    const mobileSellOnUmzila = document.getElementById('mobileSellOnUmzila');
    if (mobileSellOnUmzila) {
      mobileSellOnUmzila.addEventListener('click', (e) => {
        e.preventDefault();
        mobileMenu.classList.remove('active');
        mobileMenuOverlay.classList.remove('active');
        document.body.style.overflow = '';
        const sellBtn = document.getElementById('sellOnUmzilaBtn');
        if (sellBtn) sellBtn.click();
      });
    }

    // Mobile sign in
    if (mobileSignIn) {
      mobileSignIn.addEventListener('click', (e) => {
        e.preventDefault();
        mobileMenu.classList.remove('active');
        mobileMenuOverlay.classList.remove('active');
        document.body.style.overflow = '';
        showModal(document.getElementById('loginModal'));
      });
    }
  }
  
  // Update on resize
  window.addEventListener('resize', () => {
    if (mobileMenuIcon) {
      if (isMobile()) {
        mobileMenuIcon.style.display = 'block';
      } else {
        mobileMenuIcon.style.display = 'none';
        mobileMenu.classList.remove('active');
        mobileMenuOverlay.classList.remove('active');
      }
    }
  });
}

// Mobile filters functionality
function initMobileFilters() {
  const mobileFiltersToggle = document.getElementById('mobileFiltersToggle');
  const mobileFiltersContent = document.getElementById('mobileFiltersContent');
  const mobileApplyFilters = document.getElementById('mobileApplyFilters');
  const mobileClearFilters = document.getElementById('mobileClearFilters');
  const mobileCategorySelect = document.getElementById('mobileCategorySelect');
  const mobilePriceMin = document.getElementById('mobilePriceMin');
  const mobilePriceMax = document.getElementById('mobilePriceMax');
  const mobileSizesFilter = document.getElementById('mobileSizesFilter');
  const mobileSortSelect = document.getElementById('mobileSortSelect');
  const mobileDealsSelect = document.getElementById('mobileDealsSelect');
  
  if (mobileFiltersToggle && mobileFiltersContent) {
    mobileFiltersToggle.addEventListener('click', () => {
      const isActive = mobileFiltersContent.classList.contains('active');
      mobileFiltersContent.classList.toggle('active');
      mobileFiltersToggle.textContent = isActive ? 'Show Filters' : 'Hide Filters';
    });
    
    // Apply mobile filters
    if (mobileApplyFilters) {
      mobileApplyFilters.addEventListener('click', () => {
        // Apply category filter
        if (mobileCategorySelect) {
          state.filters.category = mobileCategorySelect.value;
        }
        
        // Apply price filter
        if (mobilePriceMin && mobilePriceMax) {
          state.filters.priceMin = mobilePriceMin.value === 'min' ? null : Number(mobilePriceMin.value);
          state.filters.priceMax = mobilePriceMax.value === 'max' ? null : Number(mobilePriceMax.value);
        }
        
        // Apply size filter
        if (mobileSizesFilter) {
          const selectedSizes = Array.from(mobileSizesFilter.querySelectorAll('.mobile-size-btn.active'))
            .map(btn => btn.dataset.size);
          state.filters.sizes = selectedSizes;
        }
        
        // Apply sort
        if (mobileSortSelect) {
          state.filters.sort = mobileSortSelect.value;
          if (topSort) topSort.value = mobileSortSelect.value;
          if (document.getElementById('sortSel')) document.getElementById('sortSel').value = mobileSortSelect.value;
        }
        
        // Apply deals filter
        if (mobileDealsSelect) {
          const dealsValue = mobileDealsSelect.value;
          if (dealsValue === 'deals') {
            state.filters.priceMax = 400;
            if (priceMax) priceMax.value = '400';
          } else if (dealsValue === 'student') {
            state.filters.priceMax = 200;
            if (priceMax) priceMax.value = '200';
          }
        }
        
        // Close mobile filters
        mobileFiltersContent.classList.remove('active');
        mobileFiltersToggle.textContent = 'Show Filters';
        
        // Apply filters
        applyFilters();
      });
    }
    
    // Clear mobile filters
    if (mobileClearFilters) {
      mobileClearFilters.addEventListener('click', () => {
        // Clear all mobile filter inputs
        if (mobileCategorySelect) mobileCategorySelect.value = 'All';
        if (mobilePriceMin) mobilePriceMin.value = 'min';
        if (mobilePriceMax) mobilePriceMax.value = 'max';
        if (mobileSizesFilter) {
          mobileSizesFilter.querySelectorAll('.mobile-size-btn').forEach(btn => {
            btn.classList.remove('active');
          });
        }
        if (mobileSortSelect) mobileSortSelect.value = 'popular';
        if (mobileDealsSelect) mobileDealsSelect.value = 'all';
        
        // Reset main filters
        state.filters = { 
          category:'All', 
          priceMin: null, 
          priceMax: null, 
          sizes:[], 
          type:'All', 
          color:'Any', 
          search:'', 
          sort:'popular',
          tag: 'Any'
        };
        
        // Reset UI elements
        if (priceMin) priceMin.value = 'min';
        if (priceMax) priceMax.value = 'max';
        document.querySelectorAll('input[name="size"]').forEach(i=>i.checked=false);
        const typeAllInput = document.querySelector('input[name="type"][value="All"]');
        if(typeAllInput) typeAllInput.checked=true;
        if (colorSel) colorSel.value='Any';
        if (tagSel) tagSel.value='Any';
        if (document.getElementById('sortSel')) document.getElementById('sortSel').value='popular';
        if (topSort) topSort.value='popular';
        if (searchInput) searchInput.value='';
        if (searchClear) searchClear.style.display='none';
        if (suggestions) suggestions.style.display='none';
        
        // Reset active category
        if (catList) {
          Array.from(catList.querySelectorAll('li')).forEach(li=>li.classList.remove('active'));
          catList.querySelector('li[data-cat="All"]').classList.add('active');
        }
        
        applyFilters();
      });
    }
  }
}

// Populate mobile filters
function populateMobileFilters() {
  const mobileCategorySelect = document.getElementById('mobileCategorySelect');
  const mobileSizesFilter = document.getElementById('mobileSizesFilter');
  
  // Populate mobile category select
  if (mobileCategorySelect && filterOptions.categories) {
    filterOptions.categories.forEach(category => {
      if (category !== 'All') {
        const option = document.createElement('option');
        option.value = category;
        option.textContent = category;
        mobileCategorySelect.appendChild(option);
      }
    });
  }
  
  // Populate mobile sizes filter
  if (mobileSizesFilter && filterOptions.sizes) {
    filterOptions.sizes.forEach(size => {
      const sizeBtn = document.createElement('button');
      sizeBtn.type = 'button';
      sizeBtn.className = 'mobile-size-btn';
      sizeBtn.dataset.size = size;
      sizeBtn.textContent = size;
      sizeBtn.addEventListener('click', () => {
        sizeBtn.classList.toggle('active');
      });
      mobileSizesFilter.appendChild(sizeBtn);
    });
  }
  
  // Populate mobile price dropdowns
  const mobilePriceMin = document.getElementById('mobilePriceMin');
  const mobilePriceMax = document.getElementById('mobilePriceMax');
  
  if (mobilePriceMin && mobilePriceMax && filterOptions.priceRange.max > 0) {
    const maxPrice = filterOptions.priceRange.max;
    
    // Clear existing options (keep first placeholder)
    while (mobilePriceMin.options.length > 1) mobilePriceMin.remove(1);
    while (mobilePriceMax.options.length > 1) mobilePriceMax.remove(1);
    
    // Create price options (increments of 50)
    for (let price = 0; price <= maxPrice; price += 50) {
      const optionText = price === 0 ? 'R0' : `R${price}`;
      
      const minOption = document.createElement('option');
      minOption.value = price;
      minOption.textContent = optionText;
      mobilePriceMin.appendChild(minOption);
      
      const maxOption = document.createElement('option');
      maxOption.value = price;
      maxOption.textContent = optionText;
      mobilePriceMax.appendChild(maxOption);
    }
    
    // Add "max" option at the end
    const maxOption = document.createElement('option');
    maxOption.value = maxPrice;
    maxOption.textContent = `R${maxPrice}`;
    mobilePriceMax.appendChild(maxOption);
  }
}

// Populate mobile menu categories — accordion style
function populateMobileMenuCategories() {
  const accordion = document.getElementById('mobileCatAccordion');
  if(!accordion) return;

  // Helper: close menu and apply category filter
  function applyMobileCat(cat) {
    const mm = document.getElementById('mobileMenu');
    const ov = document.getElementById('mobileMenuOverlay');
    if(mm) mm.classList.remove('active');
    if(ov) ov.classList.remove('active');
    document.body.style.overflow = '';
    state.filters.category = cat;
    state.filters.search = '';
    if(searchInput) searchInput.value = '';
    applyFilters();
    const fv = document.getElementById('filteredView');
    if(fv && fv.classList.contains('active'))
      fv.scrollIntoView({ behavior:'smooth', block:'start' });
  }

  // "All Products" item
  const allLi = accordion.querySelector('.mobile-cat-all');
  if(allLi){
    allLi.addEventListener('click', ()=>{ applyMobileCat('All'); });
  }

  // Category groups from CATEGORIES constant
  CATEGORIES.forEach(group=>{
    const emoji = CATEGORY_EMOJIS[group.label] || '';
    const groupLi = document.createElement('li');
    groupLi.className = 'mobile-cat-group';
    groupLi.innerHTML = `
      <div class="mobile-cat-group-header">
        <span>${emoji} ${group.label}</span>
        <span class="arrow">▼</span>
      </div>
      <ul class="mobile-cat-sub-list">
        <li data-cat="${group.label}" style="font-weight:700;color:var(--accent)">All ${group.label}</li>
        ${group.sub.map(s=>`<li data-cat="${s}">${s}</li>`).join('')}
      </ul>`;
    // Toggle open/close
    groupLi.querySelector('.mobile-cat-group-header').addEventListener('click', ()=>{
      groupLi.classList.toggle('open');
    });
    // Sub-item clicks
    groupLi.querySelectorAll('.mobile-cat-sub-list li').forEach(li=>{
      li.addEventListener('click', e=>{ e.stopPropagation(); applyMobileCat(li.dataset.cat); });
    });
    accordion.appendChild(groupLi);
  });
}

/********************
 * Helper: create SVG placeholder dataURI
 ********************/
function svgPlaceholder(text, w=400, h=300, bg='#ddd', fg='#222') {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>
    <rect width='100%' height='100%' fill='${bg}' />
    <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='${fg}' font-family='Arial, Helvetica, sans-serif' font-weight='700' font-size='${Math.round(Math.min(w,h)/10)}'>${esc(text)}</text>
  </svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/********************
 * Supabase initialization via Netlify function (already defined at top)
 ********************/
let supabaseClient = null;

// Listen for the supabase-ready event
document.addEventListener('supabase-ready', function(e) {
  supabaseClient = e.detail.supabase;
  console.log('Supabase client received via event');

  // Now that Supabase is ready, load products and check auth state
  if (typeof loadProducts === 'function') {
    loadProducts();
  }
  if (typeof checkInitialAuthState === 'function') {
    checkInitialAuthState();
  }
  if (typeof loadFilterOptions === 'function') {
    loadFilterOptions();
  }
});

/********************
 * State & basic helpers
 ********************/
let state = {
  products: [],
  filters: {
    category:'All',
    priceMin: null,
    priceMax: null,
    sizes:[],
    type:'All',
    color:'Any',
    search:'',
    sort:'popular',
    tag: 'Any'
  },
  cart: [],
  productVariants: {}, // Store variants by product_id
  userFavourites: new Set() // product IDs the logged-in user has favourited
};
window.state = state; // expose for inline scripts (category bubbles, etc.)

// ──────────────────────────────────────────────────────────────
// NEW CATEGORY STRUCTURE — campus/general marketplace
// ──────────────────────────────────────────────────────────────
const CATEGORIES = [
  {
    label: 'Clothing',
    sub: ['T-Shirts', 'Hoodies', 'Pants', 'Jackets', 'Dresses', 'Shoes', 'Hats & Caps', 'Activewear', 'Other Clothing']
  },
  {
    label: 'Food',
    sub: ['Breakfast', 'Baked Goods', 'Plates & Meals', 'Snacks', 'Drinks', 'Desserts', 'Other Food']
  },
  {
    label: 'Accessories & Gadgets',
    sub: ['Watches', 'Phone Accessories', 'Bags', 'Jewelry', 'Tech Accessories', 'Sunglasses', 'Other Accessories']
  },
  {
    label: 'Beauty & Self-Care',
    sub: ['Perfume', 'Skincare', 'Hair Products', 'Body Care', 'Makeup', 'Other Beauty']
  },
  {
    label: 'Services',
    sub: ['Tutoring', 'Photography', 'Graphic Design', 'Hair & Nails', 'Delivery', 'Other Services']
  },
  {
    label: 'Home & Gifts',
    sub: ['Home Decor', 'Custom Gifts', 'Art & Prints', 'Stationery', 'Other Home & Gifts']
  }
];

// All flat category values (for filtering)
const ALL_CAT_VALUES = ['All', ...CATEGORIES.flatMap(g => [g.label, ...g.sub])];

// Single source of truth for "which category strings belong to group X" —
// used by every section/filter that needs to match a top-level group plus
// its subcategories, so the membership list can't drift out of sync between
// call sites (previously reimplemented separately in renderAll/openSectionView).
function getCategoryGroupSubs(label){
  const group = CATEGORIES.find(g => g.label === label);
  return group ? [group.label, ...group.sub] : [label];
}

// "Back to School" is a curated cross-category bundle, not a single CATEGORIES
// group — kept as one named list so renderAll's homepage row and
// openSectionView's "see all" expansion can't drift apart.
const SCHOOL_GROUP_LABELS = ['Clothing', 'Accessories & Gadgets', 'Home & Gifts', 'Services'];
function getSchoolCategorySubs(){
  return SCHOOL_GROUP_LABELS.reduce((acc, label) => acc.concat(getCategoryGroupSubs(label)), []);
}

// Store current user referral info
let userReferralInfo = {
  code: null,
  link: null
};

// Store current auth user
let currentUser = null;

// Current product for quick add modal
let currentQuickAddProduct = null;

const $ = (s)=>document.querySelector(s);
const format = (n)=> 'R'+n.toFixed(2);

/* DOM refs */
const slides = document.getElementById('slides');
const dots = document.getElementById('dots');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const cartBtn = document.getElementById('cartBtn');
const cartCount = document.getElementById('cartCount');
const searchInput = document.getElementById('searchInput');
const suggestions = document.getElementById('suggestions');
const searchClear = document.getElementById('searchClear');
const priceMin = document.getElementById('priceMin');
const priceMax = document.getElementById('priceMax');
const catList = document.getElementById('catList');
const sizesFilter = document.getElementById('sizesFilter');
const typeFilter = document.getElementById('typeFilter');
const colorSel = document.getElementById('colorSel');
const tagSel = document.getElementById('tagSel');
const resultCount = document.getElementById('resultCount');
const topSort = document.getElementById('topSort');
const mysteryGrid = document.getElementById('mysteryGrid');
const hotGrid = document.getElementById('hotGrid');
const trendingScroll = document.getElementById('trendingScroll');
const bundlesScroll = document.getElementById('bundlesScroll');
const recScroll = document.getElementById('recScroll');
const filterSummary = document.getElementById('filterSummary');
const clearFilters = document.getElementById('clearFilters');
const sidebar = document.getElementById('sidebar');
const leftHamburger = document.getElementById('leftHamburger');
const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
const signBtn = document.getElementById('signBtn');
const modal = document.getElementById('productModal');
const modalClose = document.getElementById('closeProductModal');
const copyReferralBtn = document.getElementById('copyReferral');
const shareBtn = document.getElementById('shareBtn');
const userReferralCode = document.getElementById('userReferralCode');
const userReferralLink = document.getElementById('userReferralLink');
const referralCodeDisplay = document.getElementById('referralCodeDisplay');
const referralLinkDisplay = document.getElementById('referralLinkDisplay');
const profileBtnHeader = document.getElementById('profileBtnHeader');
const orderUpdatesBadge = document.getElementById('orderUpdatesBadge');
const quickAddModal = document.getElementById('quickAddModal');
const quickAddClose = document.getElementById('quickAddClose');
const quickAddSize = document.getElementById('quickAddSize');
const quickAddQty = document.getElementById('quickAddQty');
const quickAddSubmit = document.getElementById('quickAddSubmit');
const quickAddStockInfo = document.getElementById('quickAddStockInfo');
const quickAddStockError = document.getElementById('quickAddStockError');

// Modal elements
const loginModal = document.getElementById('loginModal');
const signupModal = document.getElementById('signupModal');
const forgotPasswordModal = document.getElementById('forgotPasswordModal');
const loginModalClose = document.getElementById('loginModalClose');
const signupModalClose = document.getElementById('signupModalClose');
const forgotPasswordModalClose = document.getElementById('forgotPasswordModalClose');
const modalLoginEmail = document.getElementById('modalLoginEmail');
const modalLoginPassword = document.getElementById('modalLoginPassword');
const modalLoginSubmit = document.getElementById('modalLoginSubmit');
const modalOpenSignup = document.getElementById('modalOpenSignup');
const modalSignupName = document.getElementById('modalSignupName');
const modalSignupEmail = document.getElementById('modalSignupEmail');
const modalSignupPassword = document.getElementById('modalSignupPassword');
const modalSignupSubmit = document.getElementById('modalSignupSubmit');
const modalOpenLogin = document.getElementById('modalOpenLogin');
const modalForgotPassword = document.getElementById('modalForgotPassword');
const modalForgotPasswordEmail = document.getElementById('modalForgotPasswordEmail');
const modalForgotPasswordSubmit = document.getElementById('modalForgotPasswordSubmit');
const modalForgotPasswordCancel = document.getElementById('modalForgotPasswordCancel');
const modalSignupReferralCode = document.getElementById('modalSignupReferralCode');

/********************
 * Checkout Redirection - DIRECT TO checkout.html
 ********************/
function redirectToCheckout() {
  if (state.cart.length === 0) {
    alert('Your cart is empty.');
    return;
  }
  
  // Save cart to localStorage to pass to checkout page
  try {
    // Include user info if logged in
    const checkoutData = {
      cart: state.cart,
      user: currentUser ? {
        id: currentUser.id,
        email: currentUser.email
      } : null,
      timestamp: new Date().toISOString()
    };
    
    localStorage.setItem('checkoutCart', JSON.stringify(checkoutData));
  } catch (e) {
    console.error('Failed to save cart:', e);
  }
  
  // Redirect to cart.html (cart page before checkout)
  window.location.href = 'cart.html';
}

/********************
 * Load product variants from Supabase
 ********************/
async function loadProductVariants() {
  if (!supabaseClient) return;
  
  try {
    const { data, error } = await supabaseClient
      .from('product_variants')
      .select('*');
    
    if (error) {
      console.warn('Error loading product variants:', error);
      return;
    }
    
    // Group variants by product_id
    const variantsByProduct = {};
    data.forEach(variant => {
      if (!variantsByProduct[variant.product_id]) {
        variantsByProduct[variant.product_id] = [];
      }
      variantsByProduct[variant.product_id].push(variant);
    });
    
    state.productVariants = variantsByProduct;
    console.info('Product variants loaded:', Object.keys(variantsByProduct).length);
  } catch (e) {
    console.error('Error loading variants:', e);
  }
}

/********************
 * Initialize product data from Supabase
 ********************/
async function loadProducts() {
  if(!supabaseClient) return;
  
  try {
    // First load variants
    await loadProductVariants();
    
    const { data, error } = await supabaseClient
      .from('products')
      .select(`
        *,
        product_images!fk_product_images_product(*),
        sellers(id, shop_name, logo_url, whatsapp_number, delivery_method, turnaround_time, status)
      `)
      .eq('visible', true)
      .order('created_at', { ascending: false });
    
    if(error) {
      console.warn('Error loading products:', error);
      return;
    }
    
    const mapped = data.map((row) => {
      const tags = row.tags || [];
      const sale = row.sale || false;
      const salePrice = row.sale_price || 0;
      const sizes = row.sizes || [];
      
      // Get images from product_images table with lazy loading support
      let allImages = [];
      if (row.product_images && Array.isArray(row.product_images) && row.product_images.length > 0) {
        const sortedImages = row.product_images.sort((a, b) => (a.image_order || 0) - (b.image_order || 0));
        allImages = sortedImages.map(img => img.url);
      } else if (row.image) {
        // Fallback to image column in products table
        allImages = [row.image];
      } else {
        // Fallback to placeholder
        const seed = encodeURIComponent((row.name||'product') + '_' + row.id);
        allImages = [
          `https://picsum.photos/seed/${seed}/400/300`,
          `https://picsum.photos/seed/${seed}_back/400/300`
        ];
      }
      
      // Get variants for this product
      const variants = state.productVariants[row.id] || [];
      
      // Calculate total stock from variants
      let totalStock = row.stock || 0;
      if (variants.length > 0) {
        totalStock = variants.reduce((sum, variant) => sum + (variant.stock || 0), 0);
      }
      
      // Get available sizes from variants
      const availableSizes = [];
      if (variants.length > 0) {
        variants.forEach(variant => {
          if (variant.size && !availableSizes.includes(variant.size)) {
            availableSizes.push(variant.size);
          }
        });
      } else if (sizes.length > 0) {
        availableSizes.push(...sizes);
      } else {
        availableSizes.push('S', 'M', 'L', 'XL');
      }
      
      return {
        id: row.id,
        title: row.name || 'Product',
        price: Number(row.price) || 0,
        sale: sale,
        salePrice: salePrice,
        category: row.category || 'All',
        primary_image: allImages[0] || null,
        secondary_image: allImages[1] || null,
        all_images: allImages,
        size: availableSizes,
        badge: row.badge || (sale ? 'Sale' : ''),
        stock: totalStock,
        variants: variants,
        visible: row.visible === true,
        type: 'New',
        color: '',
        tags: tags,
        popularity: Number(row.popularity || 50),
        desc: row.description || '',
        metadata: row.metadata || {},
        seller: row.sellers || null,
        favourite_count: Number(row.favourite_count || 0),
        listing_type: row.listing_type || 'product',
        fulfillment_type: row.fulfillment_type || null,
        service_turnaround: row.service_turnaround || null,
        item_returned: row.item_returned,
        booking_mode: row.booking_mode || null,
        slot_duration_minutes: row.slot_duration_minutes || null,
        service_location: row.service_location || null,
        intake_fields: Array.isArray(row.intake_fields) ? row.intake_fields : [],
        intake_kind: row.intake_kind || 'item',
        units_per_trip: row.units_per_trip || null,
        delivery_class: row.delivery_class || null,
        free_delivery: row.free_delivery === true,
        acceptance_deadline_hours: row.acceptance_deadline_hours || null
      };
    });
    
    // Only show products from active sellers (or platform products with no seller)
    const filtered = mapped.filter(p => !p.seller || p.seller.status === 'active');
    state.products = filtered;
    window._allProducts = filtered; // expose for back button
    applyFilters();

    /* Auto-open product modal from URL ?product= param */
    var productParam = new URLSearchParams(window.location.search).get('product');
    if (productParam) {
      var target = state.products.find(function(p){ return p.id === productParam; });
      if (target) openProductModal(target.id);
    }

    /* Deep-link into an expanded section from URL #section= hash */
    var sectionMatch = /^#section=([\w]+)/.exec(window.location.hash);
    if (sectionMatch && SECTION_KEY_MAP[sectionMatch[1]]) {
      openSectionView(SECTION_KEY_MAP[sectionMatch[1]]);
    }

    /* Load sponsored product IDs for boosting */
    if (window.supabase) {
      window.supabase.from('ad_campaigns')
        .select('product_id')
        .eq('type', 'sponsored_product')
        .eq('status', 'active')
        .gt('ends_at', new Date().toISOString())
        .then(function(res) {
          window._sponsoredProductIds = new Set((res.data || []).map(function(c){ return c.product_id; }));
          applyFilters(); // re-render with sponsored boosting
        });
    }
    
  } catch (e) {
    console.warn('Error loading products:', e);
  }
}

/********************
 * Referral System
 ********************/

// Generate a random referral code
function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Get or create referral code for user
async function getUserReferralInfo(userId) {
  if (!supabaseClient || !userId) return null;
  
  try {
    const { data: profileData, error: profileError } = await supabaseClient
      .from('profiles')
      .select('referral_code, id')
      .eq('user_id', userId)
      .maybeSingle();
    
    if (profileError) return null;
    
    let referralCode = null;
    
    if (!profileData) {
      const { data: userData } = await supabaseClient.auth.getUser();
      const userEmail = userData?.user?.email || '';
      
      referralCode = generateReferralCode();
      
      const { data: newProfile, error: createError } = await supabaseClient
        .from('profiles')
        .insert([{ 
          user_id: userId,
          email: userEmail,
          referral_code: referralCode,
          first_name: 'User',
          last_name: ''
        }])
        .select('referral_code')
        .single();
      
      if (createError) return null;
      referralCode = newProfile.referral_code;
    } else {
      referralCode = profileData.referral_code;
      
      if (!referralCode) {
        referralCode = generateReferralCode();
        
        const { error: updateError } = await supabaseClient
          .from('profiles')
          .update({ referral_code: referralCode })
          .eq('id', profileData.id);
        
        if (updateError) return null;
      }
    }
    
    return {
      code: referralCode,
      link: `${window.location.origin}?ref=${referralCode}`
    };
  } catch (e) {
    console.error('Error in getUserReferralInfo:', e);
    return null;
  }
}

// REMOVED: getReferrerFromCode, createRefereeDiscountCode, createReferrerRewardCode
// These were dead frontend functions that wrote directly to discount_codes via the anon key.
// All discount code creation is handled server-side by /.netlify/functions/process-referral.

// Check URL for referral parameter.
// Stores pending_referral as JSON { code, storedAt } so it can expire after 7 days.
function checkUrlForReferral() {
  const urlParams = new URLSearchParams(window.location.search);
  const refCode = urlParams.get('ref');

  if (refCode) {
    if (modalSignupReferralCode) {
      modalSignupReferralCode.value = refCode;
    }

    try {
      localStorage.setItem('pending_referral', JSON.stringify({ code: refCode, storedAt: Date.now() }));
    } catch (e) {}
  }
}

// Read pending referral, respecting 7-day expiry. Returns code string or null.
function readPendingReferral() {
  try {
    const raw = localStorage.getItem('pending_referral');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Support legacy plain-string storage
    if (typeof parsed === 'string') return parsed;
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    if (!parsed.storedAt || Date.now() - parsed.storedAt > SEVEN_DAYS) {
      localStorage.removeItem('pending_referral');
      return null;
    }
    return parsed.code || null;
  } catch (e) {
    localStorage.removeItem('pending_referral');
    return null;
  }
}

/********************
 * Update auth state handler
 ********************/
function updateAuthUI(user) {
  currentUser = user;
  
  const signBtn = document.getElementById('signBtn');
  const profileBtnHeader = document.getElementById('profileBtnHeader');
  const mobileSignIn = document.getElementById('mobileSignIn');
  
  if (user) {
    if (signBtn) signBtn.style.display = 'none';
    if (mobileSignIn) mobileSignIn.textContent = 'Profile';
    if (profileBtnHeader) {
      profileBtnHeader.style.display = 'inline-flex';
      profileBtnHeader.onclick = function() {
        window.location.href = 'profile.html';
      };
    }
    updateReferralBanner(user);
    
    // Sync cart on login
    syncCartOnLogin(user);
    // Restore favourite hearts for logged-in user
    loadUserFavourites();
  } else {
    if (signBtn) signBtn.style.display = 'inline-flex';
    if (mobileSignIn) mobileSignIn.textContent = 'Sign In / Sign Up';
    if (profileBtnHeader) profileBtnHeader.style.display = 'none';
    updateReferralBanner(null);
    // Clear favourite state on sign-out
    state.userFavourites = new Set();
    markFavourites();
  }
}

// Update referral banner
function updateReferralBanner(user) {
  const copyBtn = document.getElementById('copyReferral');
  const shareBtn = document.getElementById('shareBtn');
  const referralCodeDisplay = document.getElementById('referralCodeDisplay');
  const referralLinkDisplay = document.getElementById('referralLinkDisplay');
  const userReferralCodeEl = document.getElementById('userReferralCode');
  const userReferralLinkEl = document.getElementById('userReferralLink');
  
  if (!copyBtn || !shareBtn) return;
  
  const newCopyBtn = copyBtn.cloneNode(true);
  const newShareBtn = shareBtn.cloneNode(true);
  copyBtn.parentNode.replaceChild(newCopyBtn, copyBtn);
  shareBtn.parentNode.replaceChild(newShareBtn, shareBtn);
  
  const updatedCopyBtn = document.getElementById('copyReferral');
  const updatedShareBtn = document.getElementById('shareBtn');
  
  if (user) {
    getUserReferralInfo(user.id).then(info => {
      if (info) {
        userReferralInfo = info;
        userReferralCodeEl.textContent = info.code;
        userReferralLinkEl.textContent = info.link;
        referralCodeDisplay.style.display = 'block';
        referralLinkDisplay.style.display = 'block';
        
        updatedCopyBtn.addEventListener('click', function() {
          navigator.clipboard.writeText(info.code).then(() => {
            showNotification(`Referral code copied: ${info.code}`);
          });
        });
        
        updatedShareBtn.addEventListener('click', function() {
          if (navigator.share) {
            navigator.share({
              title: 'Join Umzila!',
              text: `Get 15% off your first order at Umzila with my referral code: ${info.code}`,
              url: info.link
            });
          } else {
            navigator.clipboard.writeText(info.link).then(() => {
              showNotification(`Referral link copied to clipboard: ${info.link}`);
            });
          }
        });
      }
    });
  } else {
    referralCodeDisplay.style.display = 'none';
    referralLinkDisplay.style.display = 'none';
    
    updatedCopyBtn.addEventListener('click', function() {
      showModal(loginModal);
    });
    
    updatedShareBtn.addEventListener('click', function() {
      showModal(loginModal);
    });
  }
}

/********************
 * Modal management
 ********************/
function showModal(modal) {
  if (modal) {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }
}

function hideModal(modal) {
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }
}

// Close buttons for modals
if (loginModalClose) {
  loginModalClose.addEventListener('click', () => hideModal(loginModal));
}

if (signupModalClose) {
  signupModalClose.addEventListener('click', () => hideModal(signupModal));
}

if (forgotPasswordModalClose) {
  forgotPasswordModalClose.addEventListener('click', () => hideModal(forgotPasswordModal));
}

// Close modals when clicking outside
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal')) {
    hideModal(e.target);
  }
});

/********************
 * AUTHENTICATION SYSTEM - UPDATED FOR MODALS
 ********************/

// Password validation
function checkPasswordRules(password) {
  const rules = {
    len: password && password.length >= 8,
    num: /[0-9]/.test(password || ''),
    spec: /[!@#$%^&*(),.?":{}|<>]/.test(password || '')
  };
  
  return rules.len && rules.num && rules.spec;
}

// Signup functionality with referral tracking
if (modalSignupSubmit) {
  modalSignupSubmit.addEventListener('click', async function(e) {
    e.preventDefault();
    
    const errorElement = document.getElementById('modalSignupError');
    const successElement = document.getElementById('modalSignupSuccess');
    
    if (errorElement) {
      errorElement.style.display = 'none';
      errorElement.textContent = '';
    }
    if (successElement) successElement.style.display = 'none';
    
    const name = (modalSignupName && modalSignupName.value || '').trim();
    const email = (modalSignupEmail && modalSignupEmail.value || '').trim();
    const password = (modalSignupPassword && modalSignupPassword.value) || '';
    const referralCode = modalSignupReferralCode ? modalSignupReferralCode.value : '';
    
    if (!name || !email || !password) {
      if (errorElement) {
        errorElement.textContent = 'Please complete all fields.';
        errorElement.style.display = 'block';
      }
      return;
    }
    
    if (!checkPasswordRules(password)) {
      if (errorElement) {
        errorElement.textContent = 'Password does not meet the requirements.';
        errorElement.style.display = 'block';
      }
      return;
    }
    
    const client = supabaseClient;
    if (!client || !client.auth) {
      if (errorElement) {
        errorElement.textContent = 'Auth client not available.';
        errorElement.style.display = 'block';
      }
      return;
    }
    
    const signupSubmit = modalSignupSubmit;
    signupSubmit.disabled = true;
    const originalText = signupSubmit.textContent;
    signupSubmit.textContent = 'Creating account...';
    
    try {
      const options = { 
        data: { 
          full_name: name 
        } 
      };
      
      const { data, error } = await client.auth.signUp({ 
        email, 
        password 
      }, options);
      
      if (error) {
        console.error('Signup error:', error);
        if (errorElement) {
          errorElement.textContent = error.message || 'Sign up failed.';
          errorElement.style.display = 'block';
        }
        return;
      }
      
      const userId = data?.user?.id;

      // Create profile with referral info
      if (userId && client.from) {
        try {
          await client.from('profiles').upsert([{
            user_id: userId,
            email: email,
            first_name: name.split(' ')[0] || name,
            last_name: name.split(' ').slice(1).join(' ') || '',
            referral_code: generateReferralCode()
          }], {
            onConflict: 'user_id',
            returning: 'minimal'
          });
        } catch (profileError) {
          console.warn('Profile creation failed:', profileError);
        }
      }

      // Process referral server-side — creates discount codes, tracking record, and sends emails.
      // Awaited so we can report accurate success/failure to the user.
      let referralMsg = '';
      if (referralCode) {
        try {
          const rfRes = await fetch('/.netlify/functions/process-referral', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              referral_code: referralCode,
              referee_email: email,
              referee_name: name.split(' ')[0] || 'there'
            })
          });
          if (rfRes.ok) {
            referralMsg = '<br><strong>Check your email — your 15% off code is on its way!</strong>';
            // Successfully processed — clear pending referral
            try { localStorage.removeItem('pending_referral'); } catch (e) {}
          } else {
            console.warn('process-referral returned non-ok status', rfRes.status);
            referralMsg = '<br>Your account was created but we could not issue the referral reward yet. Please contact support if needed.';
            // Keep pending_referral so it can be retried if needed
          }
        } catch (rfErr) {
          console.warn('process-referral network error', rfErr);
          referralMsg = '<br>Your account was created but we could not issue the referral reward yet. Please contact support if needed.';
        }
      }

      // Show success message
      if (successElement) {
        successElement.innerHTML = 'Account created! Check your email to verify your address.' + referralMsg;
        successElement.style.display = 'block';
      }

      // Clear forms
      if (modalSignupName) modalSignupName.value = '';
      if (modalSignupEmail) modalSignupEmail.value = '';
      if (modalSignupPassword) modalSignupPassword.value = '';
      if (modalSignupReferralCode) modalSignupReferralCode.value = '';

      // Clear stored referral only if no referral code was used (already cleared above on success)
      if (!referralCode) {
        try { localStorage.removeItem('pending_referral'); } catch (e) {}
      }
      
      // Close modal after success
      setTimeout(() => {
        hideModal(signupModal);
        if (data?.session) {
          updateAuthUI(data.user);
        }
      }, 2000);
      
    } catch (err) {
      console.error('Unexpected signup error:', err);
      if (errorElement) {
        errorElement.textContent = err?.message || 'Unexpected error during signup.';
        errorElement.style.display = 'block';
      }
    } finally {
      signupSubmit.disabled = false;
      signupSubmit.textContent = originalText;
    }
  });
}

// Login functionality
if (modalLoginSubmit) {
  modalLoginSubmit.addEventListener('click', async function(e) {
    e.preventDefault();
    
    const errorElement = document.getElementById('modalLoginError');
    const successElement = document.getElementById('modalLoginSuccess');
    
    if (errorElement) {
      errorElement.style.display = 'none';
      errorElement.textContent = '';
    }
    if (successElement) successElement.style.display = 'none';
    
    const email = (modalLoginEmail && modalLoginEmail.value || '').trim();
    const password = (modalLoginPassword && modalLoginPassword.value) || '';
    
    if (!email || !password) {
      if (errorElement) {
        errorElement.textContent = 'Please enter email and password.';
        errorElement.style.display = 'block';
      }
      return;
    }
    
    const client = supabaseClient;
    if (!client || !client.auth) {
      if (errorElement) {
        errorElement.textContent = 'Auth client not available.';
        errorElement.style.display = 'block';
      }
      return;
    }
    
    const loginSubmit = modalLoginSubmit;
    loginSubmit.disabled = true;
    const originalText = loginSubmit.textContent;
    loginSubmit.textContent = 'Signing in...';
    
    try {
      const { data, error } = await client.auth.signInWithPassword({ 
        email, 
        password 
      });
      
      if (error) {
        console.error('Login error:', error);
        if (errorElement) {
          errorElement.textContent = error.message || 'Wrong credentials or email not registered.';
          errorElement.style.display = 'block';
        }
        return;
      }
      
      const user = data?.user;
      if (!user) {
        if (errorElement) {
          errorElement.textContent = 'No user returned from auth.';
          errorElement.style.display = 'block';
        }
        return;
      }
      
      if (successElement) {
        successElement.textContent = 'Signed in successfully!';
        successElement.style.display = 'block';
      }
      
      updateAuthUI(user);
      
      setTimeout(() => {
        hideModal(loginModal);
        if (modalLoginEmail) modalLoginEmail.value = '';
        if (modalLoginPassword) modalLoginPassword.value = '';
      }, 1000);
      
    } catch (err) {
      console.error('Unexpected login error:', err);
      if (errorElement) {
        errorElement.textContent = err?.message || 'Unexpected error during sign in.';
        errorElement.style.display = 'block';
      }
    } finally {
      loginSubmit.disabled = false;
      loginSubmit.textContent = originalText;
    }
  });
}

// Forgot password functionality
if (modalForgotPassword) {
  modalForgotPassword.addEventListener('click', function(e) {
    e.preventDefault();
    hideModal(loginModal);
    showModal(forgotPasswordModal);
  });
}

if (modalForgotPasswordCancel) {
  modalForgotPasswordCancel.addEventListener('click', function(e) {
    e.preventDefault();
    hideModal(forgotPasswordModal);
    showModal(loginModal);
  });
}

if (modalForgotPasswordSubmit) {
  modalForgotPasswordSubmit.addEventListener('click', async function(e) {
    e.preventDefault();
    
    const email = modalForgotPasswordEmail.value.trim();
    const errorElement = document.getElementById('modalForgotPasswordError');
    const successElement = document.getElementById('modalForgotPasswordSuccess');
    
    if (!email) {
      if (errorElement) {
        errorElement.textContent = 'Please enter your email address.';
        errorElement.style.display = 'block';
      }
      return;
    }
    
    if (!supabaseClient) {
      if (errorElement) {
        errorElement.textContent = 'Auth client not available.';
        errorElement.style.display = 'block';
      }
      return;
    }
    
    const submitBtn = modalForgotPasswordSubmit;
    submitBtn.disabled = true;
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Sending...';
    
    try {
      const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password.html`
      });
      
      if (error) {
        console.error('Password reset error:', error);
        if (errorElement) {
          errorElement.textContent = error.message || 'Failed to send reset email.';
          errorElement.style.display = 'block';
        }
        return;
      }
      
      if (successElement) {
        successElement.textContent = 'Password reset email sent! Check your inbox.';
        successElement.style.display = 'block';
      }
      
      // Clear email field
      modalForgotPasswordEmail.value = '';
      
      // Close modal after 3 seconds
      setTimeout(() => {
        hideModal(forgotPasswordModal);
      }, 3000);
      
    } catch (err) {
      console.error('Unexpected reset error:', err);
      if (errorElement) {
        errorElement.textContent = err?.message || 'Unexpected error.';
        errorElement.style.display = 'block';
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });
}

// Modal navigation
if (modalOpenSignup) {
  modalOpenSignup.addEventListener('click', function(e) {
    e.preventDefault();
    hideModal(loginModal);
    showModal(signupModal);
  });
}

if (modalOpenLogin) {
  modalOpenLogin.addEventListener('click', function(e) {
    e.preventDefault();
    hideModal(signupModal);
    showModal(loginModal);
  });
}

/********************
 * Auth State Management
 ********************/
async function checkInitialAuthState() {
  if (!supabaseClient || !supabaseClient.auth) return;
  
  try {
    const { data } = await supabaseClient.auth.getUser();
    const user = data?.user;
    updateAuthUI(user);
  } catch (e) {
    console.warn('Auth state check failed:', e);
  }
}

// Listen for auth state changes
if (supabaseClient && supabaseClient.auth) {
  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    const user = session?.user || null;
    updateAuthUI(user);
    if (event === 'SIGNED_IN' && user) {
      mergeAnonFavourites(user.id).catch(() => {});
    }
  });
}

/********************
 * Merge anonymous favourites into user account on login
 ********************/
async function mergeAnonFavourites(userId) {
  if (!userId || !window.supabase) return;
  const anonId = getAnonId();
  if (!anonId) return;
  try {
    // Find all favourites from this anonymous session that have no owner yet
    const { data: anonFavs } = await window.supabase
      .from('product_favourites')
      .select('id, product_id')
      .eq('anonymous_id', anonId)
      .is('user_id', null);

    if (!anonFavs || !anonFavs.length) return;

    for (const fav of anonFavs) {
      // Check if the user already owns this product favourite
      const { data: existing } = await window.supabase
        .from('product_favourites')
        .select('id')
        .eq('product_id', fav.product_id)
        .eq('user_id', userId)
        .maybeSingle();

      if (existing) {
        // Duplicate — delete the anon record
        await window.supabase.from('product_favourites').delete().eq('id', fav.id);
      } else {
        // Claim it for the user
        await window.supabase
          .from('product_favourites')
          .update({ user_id: userId })
          .eq('id', fav.id);
      }
    }
  } catch (e) {
    console.warn('mergeAnonFavourites error', e);
  }
}

/********************
 * Product data (fallback)
 ********************/
const fallbackProducts = [
  { id:1, title:'Campus Hoodie — Charcoal', price:350, category:'Hoodies', imgs:['Hoodie+1','Hoodie+1+back'], size:['S','M','L','XL'], badge:'Hot', stock:3, type:'New', color:'Black', popularity: 95, desc:'Cozy campus hoodie — premium cotton blend.'},
  { id:2, title:'Graphic Tee — White', price:150, category:'T-Shirts', imgs:['Tee+1','Tee+1+back'], size:['S','M','L'], badge:'New', stock:12, type:'New', color:'White', popularity: 88, desc:'Lightweight graphic tee.'},
  { id:3, title:'Street Cap — Snapback', price:120, category:'Caps', imgs:['Cap+1','Cap+1+side'], size:['One'], badge:'Trending', stock:10, type:'Pre-owned', color:'Black', popularity:75, desc:'Classic snapback.'},
  { id:4, title:'Mystery Box #1', price:150, category:'Mystery Boxes', imgs:['Box+1'], size:['M'], badge:'Limited', stock:5, type:'New', color:'Mixed', popularity:70, desc:'Random goodies — value pack.'},
  { id:5, title:'Retro Joggers', price:299, category:'Bottoms', imgs:['Joggers+1','Joggers+back'], size:['M','L','XL'], badge:'Hot', stock:2, type:'New', color:'Blue', popularity:90, desc:'Comfort joggers with tapered leg.'},
  { id:6, title:'Beanie — Knit', price:100, category:'Accessories', imgs:['Beanie+1'], size:['One'], badge:'New', stock:20, type:'New', color:'Red', popularity:50, desc:'Warm knit beanie.'},
  { id:7, title:'Street Sneakers', price:450, category:'Tops', imgs:['Sneakers+1','Sneakers+side'], size:['8','9','10'], badge:'Hot', stock:4, type:'New', color:'White', popularity:92, desc:'Comfort sneakers.'},
  { id:8, title:'Bundle: Tee + Cap', price:420, category:'Bundles', imgs:['Bundle+1'], size:['M'], badge:'Bundle', stock:6, type:'New', color:'Black', popularity:78, desc:'Value combo pack.'},
  { id:9, title:'Pre-loved Vintage Tee', price:89, category:'T-Shirts', imgs:['Vintage+Tee'], size:['M','L'], badge:'Pre-owned', stock:1, type:'Pre-owned', color:'Green', popularity:60, desc:'Gently used vintage tee.'},
  { id:10, title:'Mystery Box #2', price:200, category:'Mystery Boxes', imgs:['Box+2'], size:['L'], badge:'Limited', stock:3, type:'New', color:'Mixed', popularity:65, desc:'Premium mystery box.'}
];

// convert imgs to picsum seeded urls (keeps visual randomness but consistent per product)
fallbackProducts.forEach(p=>{
  const base = encodeURIComponent(p.title.replace(/\s+/g,'_') + '_' + p.id);
  p.imgs = p.imgs.map((s,i)=>`https://picsum.photos/seed/${base}${i?'-'+i:''}/400/300`);
});

// set logos directly
document.getElementById('logoImg').src = 'umzila.webp';
document.getElementById('footerLogo').src = 'umzila.webp';

/********************
 * Store for filter options from Supabase - UPDATED FOR CORRECT FILTERING
 ********************/
let filterOptions = {
  categories: ['All'],
  sizes: [],
  types: ['All'],
  colors: ['Any'],
  tags: ['Any'],
  priceRange: { min: 0, max: 0 }
};

/********************
 * HERO init — clean clickable slides (no text overlay)
 ********************/
const heroPlaceholders = [
  `bannerPrinting.webp`,
  `thumbnail2.webp`,
  `bannerLaundry.webp`,
  `thumbnail1.webp`  // 4th slide fallback
];
Array.from(document.querySelectorAll('.slide')).forEach((el,idx)=>{
  el.style.backgroundImage = `url("${heroPlaceholders[idx]}")`;
  el.style.backgroundSize='cover';
  el.style.backgroundPosition='center';
  // Make slide clickable
  el.addEventListener('click', function(){
    const filterCat = el.dataset.filterCat;
    const section = el.dataset.href;
    const sectionFilter = el.dataset.filter;
    if(filterCat){
      // trigger category filter
      state.filters.category = filterCat;
      state.filters.search = '';
      if(searchInput) searchInput.value = '';
      applyFilters();
      // scroll to results
      const fv = document.getElementById('filteredView');
      if(fv) fv.scrollIntoView({ behavior:'smooth', block:'start' });
    } else if(sectionFilter === 'new-drops'){
      // scroll to new drops section
      const nd = document.getElementById('newDropsSection');
      if(nd) nd.scrollIntoView({ behavior:'smooth', block:'start' });
    } else if(section && section.startsWith('#')){
      const target = document.querySelector(section);
      if(target) target.scrollIntoView({ behavior:'smooth', block:'start' });
    } else if(section && !section.startsWith('#')){
      window.location.href = section;
    }
  });
});

let slideIndex = 0; const slideCount = slides ? slides.children.length : 0;
function makeDots(){ if(!dots) return; for(let i=0;i<slideCount;i++){ const d=document.createElement('div'); d.className='dot'; if(i===0) d.classList.add('active'); d.addEventListener('click',()=>goToSlide(i)); dots.appendChild(d);} }
function goToSlide(i){ slideIndex = i; if(slides) slides.style.transform = 'translateX('+(-i*100)+'%)'; Array.from(dots ? dots.children : []).forEach((d,idx)=>d.classList.toggle('active', idx===i)); }
makeDots(); let heroTimer = setInterval(()=>goToSlide((slideIndex+1)%slideCount),4500);
const heroEl = document.getElementById('hero');
if(heroEl){
  heroEl.addEventListener('mouseenter',()=>clearInterval(heroTimer));
  heroEl.addEventListener('mouseleave',()=>{ heroTimer = setInterval(()=>goToSlide((slideIndex+1)%slideCount),4500); });
}
if(prevBtn) prevBtn.addEventListener('click',()=>goToSlide((slideIndex-1+slideCount)%slideCount));
if(nextBtn) nextBtn.addEventListener('click',()=>goToSlide((slideIndex+1)%slideCount));

/********************
 * SEARCH — smart suggestions (categories + products) + clear/backspace
 ********************/
const CATEGORY_EMOJIS = {
  'Clothing':'👕','Food':'🍕','Accessories & Gadgets':'⌚',
  'Beauty & Self-Care':'💄','Services':'🛠️','Home & Gifts':'🏠'
};

function updateSuggestions(q){
  if(!suggestions) return;
  suggestions.innerHTML = '';
  if(!q){ suggestions.style.display='none'; return; }
  const ql = q.toLowerCase();
  const frag = document.createDocumentFragment();

  // 1. Category group matches — show first (browse shortcuts)
  CATEGORIES.forEach(group=>{
    const matchParent = group.label.toLowerCase().includes(ql);
    const matchSub = group.sub.some(s=>s.toLowerCase().includes(ql));
    if(matchParent || matchSub){
      const emoji = CATEGORY_EMOJIS[group.label] || '🏷️';
      const label = matchSub && !matchParent
        ? group.sub.find(s=>s.toLowerCase().includes(ql)) || group.label
        : group.label;
      const cat = matchSub && !matchParent
        ? (group.sub.find(s=>s.toLowerCase().includes(ql)) || group.label)
        : group.label;
      const d = document.createElement('div');
      d.className = 'suggestions-cat';
      d.innerHTML = `<span class="cat-emoji">${emoji}</span> Browse: <strong style="margin-left:3px">${label}</strong>`;
      d.addEventListener('click',()=>{
        searchInput.value='';
        searchClear.style.display='none';
        suggestions.style.display='none';
        state.filters.category = cat;
        state.filters.search = '';
        trackEvent('category_view', { category: cat, metadata: { via: 'search_suggestion' } });
        updateUserPreferences(cat);
        applyFilters();
      });
      frag.appendChild(d);
    }
  });

  // 2. Product title matches
  const products = state.products.length ? state.products : fallbackProducts;
  const seen = new Set();
  let prodCount = 0;
  products.forEach(p=>{
    if(prodCount >= 5) return;
    const title = p.title || '';
    if(!title.toLowerCase().includes(ql)) return;
    if(seen.has(title.toLowerCase())) return;
    seen.add(title.toLowerCase());
    prodCount++;
    const price = p.sale && p.salePrice ? p.salePrice : p.price;
    const img = p.primary_image || (p.imgs && p.imgs[0]) || '';
    const d = document.createElement('div');
    d.className = 'suggestions-prod';
    d.innerHTML = `${img ? `<img class="suggestions-prod-img" src="${esc(img)}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="suggestions-prod-name">${esc(title)}</span>
      <span class="suggestions-prod-price">R${Number(price).toFixed(2)}</span>`;
    d.addEventListener('click',()=>{
      searchInput.value = title;
      searchClear.style.display = 'block';
      suggestions.style.display = 'none';
      state.filters.search = title;
      trackEvent('search', { search_term: title, product_id: p.id, category: p.category, metadata: { via: 'suggestion_click' } });
      applyFilters();
    });
    frag.appendChild(d);
  });

  suggestions.appendChild(frag);
  suggestions.style.display = suggestions.children.length ? 'block' : 'none';
}

let _searchDebounceTimer = null;
if(searchInput){
  searchInput.addEventListener('input',(e)=>{
    const q=e.target.value;
    if(q && q.length>0) searchClear.style.display='block'; else searchClear.style.display='none';
    updateSuggestions(q);

    // Debounced live-filter of the results grid as the user types, in
    // addition to (not instead of) the suggestions dropdown above.
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(() => {
      state.filters.search = q;
      if (q.trim()) trackEvent('search', { search_term: q.trim(), metadata: { via: 'live_type' } });
      applyFilters();
    }, 250);
  });
}

// Clear button
if(searchClear){
  searchClear.addEventListener('click', ()=>{
    searchInput.value=''; searchClear.style.display='none';
    if(suggestions) suggestions.style.display='none';
    state.filters.search=''; applyFilters();
  });
}

// Backspace + Enter behavior
if(searchInput){
  searchInput.addEventListener('keydown',(e)=>{
    if(e.key==='Backspace'){
      setTimeout(()=>{
        const q=searchInput.value;
        if(!q){ searchClear.style.display='none'; if(suggestions) suggestions.style.display='none'; state.filters.search=''; applyFilters(); }
        else { updateSuggestions(q); }
      },0);
    }
    if(e.key==='Enter'){
      const term = searchInput.value.trim();
      state.filters.search = term;
      if(term) trackEvent('search', { search_term: term, metadata: { via: 'enter_key' } });
      applyFilters();
      if(suggestions) suggestions.style.display='none';
    }
  });
}

document.addEventListener('click',(e)=>{
  if(searchInput && suggestions && !searchInput.contains(e.target) && !suggestions.contains(e.target))
    suggestions.style.display='none';
});

/********************
 * Notify Me (back-in-stock alerts)
 ********************/
var _notifyProductId = null;

function openNotifyModal(productId, title) {
  _notifyProductId = productId;
  var modal = document.getElementById('notifyModal');
  var titleEl = document.getElementById('notifyModalTitle');
  var emailEl = document.getElementById('notifyEmailInput');
  var errEl   = document.getElementById('notifyError');
  var sucEl   = document.getElementById('notifySuccess');
  if (!modal) return;
  if (titleEl) titleEl.textContent = title ? 'Notify me when "' + title + '" is back' : 'Back in stock alert';
  if (emailEl) emailEl.value = '';
  if (errEl)   errEl.style.display = 'none';
  if (sucEl)   sucEl.style.display = 'none';
  modal.classList.add('active');
}

function closeNotifyModal() {
  var modal = document.getElementById('notifyModal');
  if (modal) modal.classList.remove('active');
  _notifyProductId = null;
}

(function initNotifyModal() {
  document.addEventListener('DOMContentLoaded', function() {
    var modal     = document.getElementById('notifyModal');
    var closeBtn  = document.getElementById('notifyModalClose');
    var submitBtn = document.getElementById('notifySubmitBtn');
    if (!modal) return;

    var closeNotify = closeNotifyModal;
    if (closeBtn) closeBtn.addEventListener('click', closeNotify);
    modal.addEventListener('click', function(e) { if (e.target === modal) closeNotify(); });

    if (submitBtn) {
      submitBtn.addEventListener('click', async function() {
        var email = (document.getElementById('notifyEmailInput') || {}).value;
        var errEl = document.getElementById('notifyError');
        var sucEl = document.getElementById('notifySuccess');
        if (!email || !email.includes('@')) {
          if (errEl) { errEl.textContent = 'Please enter a valid email.'; errEl.style.display = 'block'; }
          return;
        }
        if (!_notifyProductId) { closeNotify(); return; }
        submitBtn.disabled = true; submitBtn.textContent = '…';
        try {
          if (window.supabase) {
            await window.supabase.from('stock_alerts').insert({ product_id: _notifyProductId, email: email.trim().toLowerCase() });
          }
          if (sucEl) sucEl.style.display = 'block';
          if (errEl) errEl.style.display = 'none';
          setTimeout(closeNotify, 2000);
        } catch(err) {
          if (errEl) { errEl.textContent = 'Something went wrong. Please try again.'; errEl.style.display = 'block'; }
        } finally {
          submitBtn.disabled = false; submitBtn.textContent = 'Notify Me';
        }
      });
    }
  });
})();

// Global click delegation for notify-me-btn on product cards
document.addEventListener('click', function(e) {
  var btn = e.target.closest('.notify-me-btn');
  if (btn) {
    e.stopPropagation();
    openNotifyModal(btn.dataset.id, btn.dataset.title);
  }
});

/********************
 * Filtering / Sorting (updated for new price filters)
 ********************/
function applyFilters(){
  const f = state.filters;
  let out = state.products.filter(p=>{
    // Never show hidden products; services don't need physical stock
    if (!p.visible) return false;
    if (p.listing_type !== 'service' && (p.stock || 0) <= 0) return false;
    if(f.category!=='All'){
      // Match exact category OR parent group (e.g. "Clothing" matches all sub-cats)
      const group = CATEGORIES.find(g => g.label === f.category);
      const pCatLower = (p.category||'').toLowerCase().trim();
      // normalize: strip trailing 's' so snack≈snacks, baked good≈baked goods, etc.
      const norm = s => s.replace(/s$/i,'').trim();
      if(group){
        // parent selected — match if product.category is the parent OR any sub (case-insensitive + singular/plural)
        const groupLabelLower = group.label.toLowerCase();
        const subLowers = group.sub.map(s => s.toLowerCase());
        const subNorms  = subLowers.map(norm);
        const pCatNorm  = norm(pCatLower);
        if(pCatLower !== groupLabelLower && !subLowers.includes(pCatLower) && !subNorms.includes(pCatNorm)) return false;
      } else {
        if(pCatLower !== f.category.toLowerCase().trim() && norm(pCatLower) !== norm(f.category.toLowerCase().trim())) return false;
      }
    }

    // Price filtering with min and max
    const price = p.sale && p.salePrice ? p.salePrice : p.price;
    if(f.priceMin !== null && price < f.priceMin) return false;
    if(f.priceMax !== null && price > f.priceMax) return false;

    if(f.sizes.length && !f.sizes.some(s=>p.size && p.size.includes(s))) return false;
    if(f.type!=='All' && p.type!==f.type) return false;
    if(f.color!=='Any' && p.color!==f.color) return false;
    if(f.tag!=='Any' && p.tags && !p.tags.includes(f.tag)) return false;
    if(f.search && !((p.title+(p.desc||'')+(p.category||'')+(p.seller?.shop_name||'')).toLowerCase().includes(f.search.toLowerCase()))) return false;
    return true;
  });

  // Sorting
  if(f.sort==='price-asc') out.sort((a,b)=> {
    const priceA = a.sale && a.salePrice ? a.salePrice : a.price;
    const priceB = b.sale && b.salePrice ? b.salePrice : b.price;
    return priceA - priceB;
  });
  else if(f.sort==='price-desc') out.sort((a,b)=> {
    const priceA = a.sale && a.salePrice ? a.salePrice : a.price;
    const priceB = b.sale && b.salePrice ? b.salePrice : b.price;
    return priceB - priceA;
  });
  else if(f.sort==='new') out.sort((a,b)=>b.id - a.id);
  else out.sort((a,b)=> (b.popularity||0) - (a.popularity||0));

  // Decide: active search OR non-All category → show filtered grid view
  const isFiltered = f.search.trim() || f.category !== 'All';
  if(isFiltered){
    showFilteredView(out, f.search || f.category);
  } else {
    hideFilteredView();
    renderAll(out);
  }

  // Update filter summary
  let summaryParts = [];
  if(f.category !== 'All') summaryParts.push(f.category);
  if(f.priceMin !== null || f.priceMax !== null) {
    const minStr = f.priceMin !== null ? `R${f.priceMin}` : 'Min';
    const maxStr = f.priceMax !== null ? `R${f.priceMax}` : 'Max';
    summaryParts.push(`${minStr} - ${maxStr}`);
  }
  if(f.type !== 'All') summaryParts.push(f.type);
  if(f.color !== 'Any') summaryParts.push(f.color);
  if(f.tag !== 'Any') summaryParts.push(f.tag);
  if(f.sizes.length) summaryParts.push(`Sizes: ${f.sizes.join(',')}`);
  if(f.search) summaryParts.push(`"${f.search}"`);

  if(filterSummary) filterSummary.textContent = summaryParts.length > 0 ? summaryParts.join(' • ') : 'None';
}

/********************
 * Filtered / search results view helpers
 ********************/
function showFilteredView(products, label){
  const fv = document.getElementById('filteredView');
  const grid = document.getElementById('filteredGrid');
  const lbl = document.getElementById('filteredViewLabel');
  const cnt = document.getElementById('filteredCountLabel');
  const empty = document.getElementById('filteredEmpty');
  if(!fv || !grid) return;

  // Hide homepage sections
  ['hotSection','trendingSection','newDropsSection','studentSection','underR100Section',
   'bestSellersSection','popularClothingSection','popularFoodSection','featuredShopsSection']
    .forEach(id=>{ const el=document.getElementById(id); if(el) el.style.display='none'; });

  fv.classList.add('active');
  setMobileBottomNavActive('search');
  if(lbl) lbl.textContent = label || 'Results';
  if(cnt) cnt.textContent = `${products.length} item${products.length!==1?'s':''}`;

  if(!products.length){
    grid.innerHTML='';
    if(empty) empty.style.display='';
  } else {
    if(empty) empty.style.display='none';
    grid.innerHTML = products.map(p=>makeCardHTML(p)).join('');
    // Immediately resolve all lazy-load images in the filtered grid —
    // the IntersectionObserver wraps renderAll but not showFilteredView,
    // so images with data-src would never load without this.
    grid.querySelectorAll('img[data-src]').forEach(img => {
      img.src = img.dataset.src;
      img.removeAttribute('data-src');
    });
    attachProductListeners();
    runReveal();
  }
  if(resultCount) resultCount.textContent = products.length;
}

function hideFilteredView(){
  const fv = document.getElementById('filteredView');
  if(!fv) return;
  fv.classList.remove('active');
  setMobileBottomNavActive('home');
  // Re-render sections (renderAll will show/hide sections based on content)
  renderAll(state.products);
  const shops = document.getElementById('featuredShopsSection');
  if(shops && shops.dataset.hasData==='true') shops.style.display='';
}

/********************
 * Event listeners for new filter elements
 ********************/
priceMin.addEventListener('change',(e)=>{
  state.filters.priceMin = e.target.value === 'min' ? null : Number(e.target.value);
  applyFilters();
});

priceMax.addEventListener('change',(e)=>{
  state.filters.priceMax = e.target.value === 'max' ? null : Number(e.target.value);
  applyFilters();
});

catList.addEventListener('click',(e)=>{ 
  if(e.target.tagName==='LI'){ 
    Array.from(catList.querySelectorAll('li')).forEach(li=>li.classList.remove('active')); 
    e.target.classList.add('active'); 
    state.filters.category = e.target.dataset.cat; 
    applyFilters(); 
  }
});

colorSel.addEventListener('change', (e)=>{ 
  state.filters.color = e.target.value; 
  applyFilters(); 
});

tagSel.addEventListener('change', (e)=>{ 
  state.filters.tag = e.target.value; 
  applyFilters(); 
});

document.getElementById('sortSel').addEventListener('change', (e)=>{ 
  state.filters.sort = e.target.value; 
  topSort.value = e.target.value; 
  applyFilters(); 
});

topSort.addEventListener('change',(e)=>{ 
  state.filters.sort = e.target.value; 
  document.getElementById('sortSel').value = e.target.value; 
  applyFilters(); 
});

/********************
 * Clear filters function (updated for new filters)
 ********************/
clearFilters.addEventListener('click',()=>{
  state.filters = {
    category:'All',
    priceMin: null,
    priceMax: null,
    sizes:[],
    type:'All',
    color:'Any',
    search:'',
    sort:'popular',
    tag: 'Any'
  };

  // Reset UI elements
  priceMin.value = 'min';
  priceMax.value = 'max';
  document.querySelectorAll('input[name="size"]').forEach(i=>i.checked=false);
  document.querySelector('input[name="type"][value="All"]').checked=true;
  colorSel.value='Any';
  tagSel.value='Any';
  document.getElementById('sortSel').value='popular';
  topSort.value='popular';
  searchInput.value='';
  searchClear.style.display='none';
  suggestions.style.display='none';

  // Reset active category
  Array.from(catList.querySelectorAll('li')).forEach(li=>li.classList.remove('active'));
  catList.querySelector('li[data-cat="All"]').classList.add('active');

  hideFilteredView();
  applyFilters();
});

/********************
 * Deal buttons (updated for new price filters)
 ********************/
document.getElementById('dealsBtn').addEventListener('click',()=>{ 
  state.filters.priceMax = 400; 
  priceMax.value = '400'; 
  applyFilters(); 
});

document.getElementById('studentBtn').addEventListener('click',()=>{ 
  state.filters.priceMax = 200; 
  priceMax.value = '200'; 
  applyFilters(); 
});

/********************
 * Lazy Loading Implementation
 ********************/
function setupLazyLoading() {
  // Use Intersection Observer for lazy loading
  const lazyLoadObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
        }
        observer.unobserve(img);
      }
    });
  }, {
    rootMargin: '50px 0px',
    threshold: 0.1
  });
  
  // Observe dynamically added images (covers the initial render too, since
  // renderAll is always called at least once on load)
  const originalRenderAll = renderAll;
  renderAll = function(products) {
    originalRenderAll.call(this, products);
    
    // Set up lazy loading for newly added images
    setTimeout(() => {
      const newLazyImages = document.querySelectorAll('img[data-src]');
      newLazyImages.forEach(img => {
        lazyLoadObserver.observe(img);
      });
    }, 100);
  };
}

/********************
 * Media helpers
 ********************/
function isVideoUrl(url) {
  if (!url) return false;
  return /\.(mp4|webm|mov|ogg)(\?|$)/i.test(url);
}

function mediaTagForCard(url, title) {
  if (isVideoUrl(url)) {
    return `<video src="${esc(url)}" autoplay muted loop playsinline style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0" aria-label="${esc(title)}"></video>`;
  }
  return `<img src="${svgPlaceholder(title,400,300,'#f0f0f0','#999')}" data-src="${esc(url)}" loading="lazy" alt="${esc(title)}" onerror="this.src='${svgPlaceholder(title,400,300)}'; this.removeAttribute('data-src')">`;
}

/********************
 * Favourites helper
 ********************/
function getAnonId() {
  let id = localStorage.getItem('ss_anon_id');
  if (!id) {
    id = 'anon-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('ss_anon_id', id);
  }
  return id;
}

/********************
 * Behaviour tracking — fire-and-forget, never blocks UI
 ********************/
function trackEvent(eventType, data) {
  try {
    if (!window.supabase) return;
    data = data || {};
    var payload = {
      event_type:   eventType,
      product_id:   data.product_id   || null,
      seller_id:    data.seller_id    || null,
      category:     data.category     || null,
      subcategory:  data.subcategory  || null,
      search_term:  data.search_term  || null,
      anonymous_id: getAnonId(),
      metadata:     data.metadata     || {}
    };
    if (typeof currentUser !== 'undefined' && currentUser) payload.user_id = currentUser.id;
    window.supabase.from('user_events').insert(payload).then(function(){}).catch(function(){});

    // Update product engagement counters on the backend (also updates local state)
    var counterEvents = ['product_click', 'product_view', 'add_to_cart'];
    if (counterEvents.indexOf(eventType) !== -1 && data && data.product_id) {
      var engPayload = {
        product_id:   data.product_id,
        event_type:   eventType,
        seller_id:    data.seller_id  || null,
        category:     data.category   || null,
        anonymous_id: getAnonId()
      };
      var engHeaders = { 'Content-Type': 'application/json' };
      if (typeof currentUser !== 'undefined' && currentUser && window._supabaseAnonKey) {
        // Pass auth token so backend can resolve user
        try {
          window.supabase.auth.getSession().then(function(r) {
            if (r.data && r.data.session) engHeaders['Authorization'] = 'Bearer ' + r.data.session.access_token;
            fetch('/.netlify/functions/track-engagement', { method: 'POST', headers: engHeaders, body: JSON.stringify(engPayload) }).catch(function(){});
          }).catch(function(){
            fetch('/.netlify/functions/track-engagement', { method: 'POST', headers: engHeaders, body: JSON.stringify(engPayload) }).catch(function(){});
          });
        } catch (_) {
          fetch('/.netlify/functions/track-engagement', { method: 'POST', headers: engHeaders, body: JSON.stringify(engPayload) }).catch(function(){});
        }
      } else {
        fetch('/.netlify/functions/track-engagement', { method: 'POST', headers: engHeaders, body: JSON.stringify(engPayload) }).catch(function(){});
      }

      // Also update local product state so ranking changes reflect on next re-render
      if (state && state.products) {
        var prod = state.products.find(function(p) { return String(p.id) === String(data.product_id); });
        if (prod) {
          if (eventType === 'add_to_cart') {
            prod.cart_count = (Number(prod.cart_count) || 0) + 1;
          } else {
            prod.click_count = (Number(prod.click_count) || 0) + 1;
          }
          prod.last_engaged_at = new Date().toISOString();
        }
      }
    }
  } catch (_) {}
}

/********************
 * User preference tracking (sessionStorage, no server call)
 ********************/
function updateUserPreferences(category) {
  try {
    var prefs = JSON.parse(sessionStorage.getItem('um_prefs') || '[]');
    prefs.unshift(category);
    sessionStorage.setItem('um_prefs', JSON.stringify(prefs.slice(0, 20)));
  } catch (_) {}
}

function getUserPreferenceCategories() {
  try {
    var prefs = JSON.parse(sessionStorage.getItem('um_prefs') || '[]');
    var counts = {};
    prefs.forEach(function(c){ counts[c] = (counts[c] || 0) + 1; });
    return Object.entries(counts).sort(function(a,b){ return b[1]-a[1]; }).map(function(e){ return e[0]; }).slice(0,3);
  } catch (_) { return []; }
}

/********************
 * Weighted product scoring with Bayesian confidence adjustment
 *
 * Signal hierarchy (real money > intent > desire > curiosity):
 *   Orders×10  Carts×4  Favourites×3  Views×1
 *
 * Bayesian factor prevents a product with 1 order beating one with 200:
 *   confidence = n / (C + n)   where n = total interactions, C = 5
 *   score = raw×confidence + prior×(1−confidence)
 * New products blend toward the neutral prior (pop×0.5) until they have
 * enough volume to be trusted at full weight.
 ********************/
function computeScore(p, opts) {
  opts = opts || {};

  var views  = Number(p.click_count)     || 0;
  var carts  = Number(p.cart_count)      || 0;
  var orders = Number(p.order_count)     || 0;
  var favs   = Number(p.favourite_count) || 0;
  var pop    = Number(p.popularity)      || 50;

  // Time decay — products idle too long rank progressively lower
  var decay = 1.0;
  if (p.last_engaged_at) {
    var days = (Date.now() - new Date(p.last_engaged_at).getTime()) / 86400000;
    if      (days > 90) decay = 0.20;
    else if (days > 30) decay = 0.40;
    else if (days > 14) decay = 0.70;
    else if (days > 7)  decay = 0.85;
  }

  // Per-section weight overrides (defaults: orders dominate, views are weakest)
  var wO = opts.wOrders !== undefined ? opts.wOrders : 10;
  var wC = opts.wCarts  !== undefined ? opts.wCarts  : 4;
  var wF = opts.wFavs   !== undefined ? opts.wFavs   : 3;
  var wV = opts.wViews  !== undefined ? opts.wViews  : 1;

  var raw = orders*wO + carts*wC + favs*wF + views*wV + pop*0.5;

  // Bayesian confidence: blend raw score toward a neutral prior based on
  // how much evidence we have. C=5 means 5 total interactions = 50% trusted.
  var C = opts.bayesC !== undefined ? opts.bayesC : 5;
  var n = orders + carts + favs + views;
  var confidence = n > 0 ? n / (C + n) : 0;
  var prior = pop * 0.5;
  var score = (raw * confidence + prior * (1 - confidence)) * decay;

  // Section-specific boosts (applied after Bayesian normalisation)
  var hasSale = !!(p.sale && p.salePrice && p.salePrice < p.price);
  var discountPct = hasSale ? Math.round(100*(1-p.salePrice/p.price)) : 0;
  if (opts.boostSale)   score += discountPct * 2;
  if (opts.boostAfford) score += (p.price < 200 ? 8 : 0);
  if (opts.boostRecent && p.last_engaged_at) {
    var d = (Date.now() - new Date(p.last_engaged_at).getTime()) / 86400000;
    score += d < 3 ? 40 : d < 7 ? 25 : d < 14 ? 10 : 0;
  }
  if (opts.userCategories && opts.userCategories.length) {
    if (opts.userCategories.indexOf(p.category) !== -1) score += 15;
  }

  return score;
}

/********************
 * Smart bundle suggestions: same-store primary, cross-category fallback
 ********************/
var BUNDLE_COMPLEMENTS = {
  'Clothing':             ['Accessories & Gadgets', 'Footwear'],
  'Accessories & Gadgets':['Clothing', 'Beauty & Self-Care'],
  'Beauty & Self-Care':   ['Home & Gifts', 'Accessories & Gadgets'],
  'Food':                 ['Food'],
  'Home & Gifts':         ['Beauty & Self-Care'],
  'Services':             []
};

function getBundleSuggestions(currentProduct, allProducts, count) {
  count = count || 2;
  var pid = currentProduct.id;
  var sid = currentProduct.seller && currentProduct.seller.id;
  var cat = currentProduct.category;

  function scored(list) {
    return list.slice().sort(function(a,b){ return computeScore(b) - computeScore(a); });
  }
  function notIn(list, ids) {
    return list.filter(function(p){ return ids.indexOf(p.id) === -1; });
  }

  var chosen = [];

  // Tier 1: same seller, different category
  var t1 = scored(allProducts.filter(function(p){
    return p.id !== pid && sid && p.seller && p.seller.id === sid && p.category !== cat;
  }));
  chosen = chosen.concat(t1.slice(0, count));

  // Tier 2: same seller, same category (if still need more)
  if (chosen.length < count) {
    var t2 = scored(notIn(allProducts.filter(function(p){
      return p.id !== pid && sid && p.seller && p.seller.id === sid;
    }), chosen.map(function(p){ return p.id; })));
    chosen = chosen.concat(t2.slice(0, count - chosen.length));
  }

  // Tier 3: cross-store complementary category
  if (chosen.length < count) {
    var compCats = BUNDLE_COMPLEMENTS[cat] || [];
    var t3 = scored(notIn(allProducts.filter(function(p){
      return p.id !== pid && compCats.some(function(c){ return p.category && p.category.indexOf(c) !== -1; });
    }), chosen.map(function(p){ return p.id; })));
    chosen = chosen.concat(t3.slice(0, count - chosen.length));
  }

  // Tier 4: highest scoring anywhere
  if (chosen.length < count) {
    var t4 = scored(notIn(allProducts.filter(function(p){ return p.id !== pid; }),
      chosen.map(function(p){ return p.id; })));
    chosen = chosen.concat(t4.slice(0, count - chosen.length));
  }

  return chosen.slice(0, count);
}

async function loadUserFavourites() {
  if (!supabaseClient || !currentUser) return;
  try {
    const { data } = await supabaseClient
      .from('product_favourites')
      .select('product_id')
      .eq('user_id', currentUser.id);
    state.userFavourites = new Set((data || []).map(r => String(r.product_id)));
    markFavourites();
  } catch (e) {
    console.warn('loadUserFavourites failed', e);
  }
}

function markFavourites() {
  document.querySelectorAll('.fav-btn').forEach(btn => {
    const active = state.userFavourites.has(String(btn.dataset.productId));
    btn.classList.toggle('active', active);
  });
}

async function toggleFavourite(btn) {
  if (!btn || btn.dataset.pending === 'true') return;
  btn.dataset.pending = 'true';

  const productId = btn.dataset.productId;
  const isFaved = btn.classList.contains('active');

  // Optimistic UI update (the SVG heart's filled/unfilled state is driven
  // purely by the .active class in CSS now, no textContent swap needed)
  btn.classList.toggle('active', !isFaved);
  let count = parseInt(btn.dataset.favCount || '0', 10);
  count = isFaved ? Math.max(0, count - 1) : count + 1;
  btn.dataset.favCount = count;

  try {
    const headers = { 'Content-Type': 'application/json' };
    // Attach JWT if user is logged in
    if (window.supabase) {
      const { data: { session } } = await window.supabase.auth.getSession().catch(() => ({ data: {} }));
      if (session && session.access_token) headers['Authorization'] = 'Bearer ' + session.access_token;
    }
    const res = await fetch('/.netlify/functions/toggle-favourite', {
      method: 'POST',
      headers,
      body: JSON.stringify({ product_id: productId, anonymous_id: getAnonId() })
    });
    const data = await res.json();
    if (data.success) {
      btn.classList.toggle('active', data.action === 'added');
      btn.dataset.favCount = data.favourite_count;
      // Track favourite add/remove
      const favProd = state.products.find(function(x){ return String(x.id) === String(productId); });
      trackEvent(data.action === 'added' ? 'favourite_added' : 'favourite_removed', {
        product_id: productId,
        seller_id:  favProd && favProd.seller && favProd.seller.id ? favProd.seller.id : null,
        category:   favProd ? favProd.category : null
      });
    } else {
      // Revert on error
      btn.classList.toggle('active', isFaved);
      btn.dataset.favCount = isFaved ? count + 1 : Math.max(0, count - 1);
    }
  } catch (_) {
    // Revert on network error
    btn.classList.toggle('active', isFaved);
  }
  btn.dataset.pending = 'false';
}

/********************
 * Rendering helpers (updated with lazy loading)
 ********************/
function makeCardHTML(p){
  // Check if product is on sale
  const isOnSale = p.sale || false;
  const salePrice = p.salePrice || 0;
  const displayPrice = isOnSale ? salePrice : p.price;
  const originalPrice = isOnSale ? p.price : null;
  
  // Get images from product_images if available
  const primaryImage = p.primary_image || (p.imgs && p.imgs[0]) || svgPlaceholder(p.title,400,300);
  const secondaryImage = p.secondary_image || (p.imgs && p.imgs[1]) || null;
  
  // Get available stock
  const totalStock = p.stock || 0;
  
  // Determine loading attribute - lazy load all except first few items
  const shouldLazyLoad = true; // We'll use Intersection Observer for all
  
  const favCount = Number(p.favourite_count || 0);
  const isServiceCard = p.listing_type === 'service';
  const lowStock = !isServiceCard && totalStock > 0 && totalStock <= 5;
  const outOfStock = !isServiceCard && totalStock <= 0;
  // Service cards get a meta line summarizing fulfillment shape + turnaround
  // where product cards would show color/stock — and their "+" becomes a
  // labelled Book/Request pill, so the call-to-action verb itself signals
  // "this isn't an instant add-to-cart", not just the small Service badge.
  const isScheduledService = isServiceCard && p.fulfillment_type === 'in_person' && p.booking_mode === 'scheduled';
  const svcMetaLabel = isServiceCard ? ({
    item_dropoff: '📦 Drop-off service',
    in_person: isScheduledService ? '📅 Bookable session' : '📍 In-person',
    digital: '💻 Digital delivery'
  }[p.fulfillment_type] || '🔧 Service') : '';
  const metaParts = isServiceCard
    ? [svcMetaLabel, p.service_turnaround || ''].filter(Boolean)
    : [p.color || '', lowStock ? `${totalStock} left` : ''].filter(Boolean);
  const ctaLabel = isScheduledService ? 'Book' : 'Request';
  return `<div class="product-card fade-up" data-id="${p.id}">
    <div class="product-media" role="button" aria-label="Open ${esc(p.title)}">
      <div class="badges">
        ${(window._sponsoredProductIds && window._sponsoredProductIds.has(p.id)) ? '<span class="badge badge-sponsored">Sponsored</span>' : ''}
        ${isServiceCard ? '<span class="badge badge-service">Service</span>' : (p.badge?`<span class="badge ${p.badge === 'Sale' ? 'sale' : ''}">${esc(p.badge)}</span>`:'')}
        ${isOnSale && !p.badge && !isServiceCard ? '<span class="badge sale">Sale</span>' : ''}
      </div>
      ${mediaTagForCard(primaryImage, p.title)}
      ${secondaryImage && !isVideoUrl(primaryImage) ? `<img class="secondary" src="${svgPlaceholder(p.title,400,300,'#f0f0f0','#999')}" data-src="${esc(secondaryImage)}" loading="lazy" alt="${esc(p.title)} back" onerror="this.src='${svgPlaceholder(p.title,400,300)}'; this.removeAttribute('data-src')">` : ''}
      <button class="fav-btn" data-product-id="${p.id}" data-fav-count="${favCount}" aria-label="Add to favourites" onclick="event.stopPropagation();toggleFavourite(this)">
        <svg class="fav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 8.1c0-3-2.4-5.4-5.4-5.4-1.8 0-3.4.9-4.4 2.3-1-1.4-2.6-2.3-4.4-2.3-3 0-5.4 2.4-5.4 5.4 0 5.5 9.8 11.5 9.8 11.5s9.8-6 9.8-11.5z"/></svg>
      </button>
    </div>
    <div class="card-body">
      <div class="title">${esc(p.title)}</div>
      ${metaParts.length ? `<div class="meta-sub">${esc(metaParts.join(' · '))}</div>` : ''}
      <div class="price-row">
        <div class="price${isOnSale ? ' price-sale' : ''}">
          ${isOnSale && originalPrice ? `<span class="original">${format(originalPrice)}</span>` : ''}
          ${format(displayPrice)}
        </div>
        ${outOfStock ? '' : isServiceCard ? `<button class="add-circle add-pill" data-id="${p.id}" aria-label="${ctaLabel} ${esc(p.title)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${isScheduledService ? '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>' : '<path d="M4 12h16M14 6l6 6-6 6"/>'}</svg>
          <span>${ctaLabel}</span>
        </button>` : `<button class="add-circle" data-id="${p.id}" aria-label="Add ${esc(p.title)} to cart">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>`}
      </div>
      ${outOfStock ? `<button class="notify-me-btn" data-id="${p.id}" data-title="${esc(p.title)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        Notify Me
      </button>` : ''}
    </div>
  </div>`;
}

function renderAll(products){
  const visible = (products || state.products).filter(p =>
    p.visible !== false && (p.listing_type === 'service' || (p.stock || 0) > 0)
  );
  if(resultCount) resultCount.textContent = visible.length;

  const userCats = getUserPreferenceCategories();

  // Tracks which product IDs were shown in earlier sections.
  // Later sections apply a 0.7× score penalty to already-shown products,
  // pushing fresh items forward without hard-excluding anything.
  const _shownIds = new Set();

  function pinSponsored(list) {
    var ids = window._sponsoredProductIds || new Set();
    if (!ids.size) return list;
    var sp   = list.filter(function(p){ return ids.has(p.id); });
    var rest = list.filter(function(p){ return !ids.has(p.id); });
    return sp.concat(rest);
  }

  function cards(list, minW){ return pinSponsored(list).map(p=>`<div style="min-width:${minW||180}px;max-width:${minW||180}px">${makeCardHTML(p)}</div>`).join(''); }
  function showSection(id, has){ const el=document.getElementById(id); if(el) el.style.display = has ? '' : 'none'; }

  // Scores a list with section-specific opts and applies shown-ID diversity penalty
  function scored(list, opts, applyDiversity){
    var o = opts || {};
    return list.slice().sort(function(a, b){
      var sa = computeScore(a, o);
      var sb = computeScore(b, o);
      if (applyDiversity !== false) {
        if (_shownIds.has(a.id)) sa *= 0.7;
        if (_shownIds.has(b.id)) sb *= 0.7;
      }
      return sb - sa;
    });
  }

  function markShown(items){ items.forEach(function(p){ _shownIds.add(p.id); }); }

  // Helper: sum of a numeric field across an array of products
  function sumField(arr, field){ return arr.reduce(function(acc, p){ return acc + (Number(p[field]) || 0); }, 0); }

  // ── HOT DEALS ──────────────────────────────────────────────────────────────
  // Goal: surface sale items that are actually engaging. Reduce order dominance so a
  // mildly-ordered item on 40% discount beats a heavily-ordered item on 5% discount.
  const hotItems = scored(
    visible.filter(function(p){ return p.sale && p.salePrice && p.salePrice < p.price; }),
    { boostSale: true, boostAfford: true, wOrders: 3, wCarts: 5, wFavs: 3, wViews: 2 },
    false
  ).slice(0,12);
  if(hotGrid) hotGrid.innerHTML = cards(hotItems, 170) || '<div style="padding:12px;color:var(--muted)">No hot deals right now</div>';
  showSection('hotSection', hotItems.length);
  markShown(hotItems);

  // ── TRENDING ON CAMPUS ─────────────────────────────────────────────────────
  // Goal: catch what's suddenly popular — spikes in views/carts/favs this week.
  // Orders intentionally excluded (a product ordered 6 months ago isn't "trending").
  const trendingItems = scored(
    visible,
    { boostRecent: true, wOrders: 0, wCarts: 6, wFavs: 5, wViews: 3, bayesC: 3, userCategories: userCats }
  ).slice(0,12);
  if(trendingScroll) trendingScroll.innerHTML = cards(trendingItems, 170);
  showSection('trendingSection', trendingItems.length);
  markShown(trendingItems);

  // ── NEW DROPS ──────────────────────────────────────────────────────────────
  // Pure recency — no engagement scoring.
  const newDropItems = visible.slice().sort(function(a,b){
    const da = a.created_at ? new Date(a.created_at).getTime() : Number(a.id) || 0;
    const db = b.created_at ? new Date(b.created_at).getTime() : Number(b.id) || 0;
    return db - da;
  }).slice(0,12);
  const ndScroll = document.getElementById('newDropsScroll');
  if(ndScroll) ndScroll.innerHTML = cards(newDropItems, 170);
  showSection('newDropsSection', newDropItems.length);

  // ── BACK TO SCHOOL ─────────────────────────────────────────────────────────
  // Goal: campus-relevant items people are buying. Default weights apply (orders dominate).
  const schoolGroup = getSchoolCategorySubs();
  const studentItems = scored(
    visible.filter(function(p){ return schoolGroup.indexOf(p.category) !== -1; }),
    { wOrders: 10, wCarts: 5, wFavs: 4, wViews: 2 }
  ).slice(0,12);
  const stScroll = document.getElementById('studentScroll');
  if(stScroll) stScroll.innerHTML = cards(studentItems, 170) || '<div style="padding:12px;color:var(--muted)">Loading…</div>';
  showSection('studentSection', studentItems.length);
  markShown(studentItems);

  // ── UNDER R100 ─────────────────────────────────────────────────────────────
  // Goal: affordable items people actually buy. Orders still dominate but budget
  // engagement (carts/views) boosts items that haven't been ordered yet.
  const underR100Items = scored(
    visible.filter(function(p){ const pr=p.sale&&p.salePrice?p.salePrice:p.price; return pr<100; }),
    { boostAfford: true, wOrders: 8, wCarts: 6, wFavs: 3, wViews: 2 }
  ).slice(0,12);
  const ur100 = document.getElementById('underR100Scroll');
  if(ur100) ur100.innerHTML = cards(underR100Items, 170) || '<div style="padding:12px;color:var(--muted)">No products under R100</div>';
  showSection('underR100Section', underR100Items.length);
  markShown(underR100Items);

  // ── BEST SELLERS ───────────────────────────────────────────────────────────
  // Goal: pure purchase dominance. Orders weigh 20× here and Bayesian prior tightens
  // so products need fewer orders to qualify — this is explicitly about being bought.
  const bestItems = scored(
    visible,
    { wOrders: 20, wCarts: 3, wFavs: 2, wViews: 1, bayesC: 3 }
  ).slice(0,12);
  const bsScroll = document.getElementById('bestSellersScroll');
  if(bsScroll) bsScroll.innerHTML = cards(bestItems, 170);
  showSection('bestSellersSection', bestItems.length);
  markShown(bestItems);

  // ── POPULAR IN CLOTHING ────────────────────────────────────────────────────
  // Goal: best-selling + most-loved fashion. Orders lead, favourites matter here
  // too because people wishlist clothing before committing to buy.
  const clothingSubs = getCategoryGroupSubs('Clothing');
  const clothingItems = scored(
    visible.filter(function(p){ return clothingSubs.indexOf(p.category) !== -1; }),
    { wOrders: 10, wCarts: 5, wFavs: 5, wViews: 2 },
    false
  ).slice(0,10);
  const pcScroll = document.getElementById('popularClothingScroll');
  if(pcScroll) pcScroll.innerHTML = cards(clothingItems, 170) || '<div style="padding:12px;color:var(--muted)">No clothing products yet</div>';
  showSection('popularClothingSection', clothingItems.length);

  // ── POPULAR IN FOOD ────────────────────────────────────────────────────────
  // Goal: most-ordered food. Cart adds also matter because food is impulse-driven.
  // Favourites barely factor in — people order food, they don't wishlist it.
  const foodSubs = getCategoryGroupSubs('Food');
  const foodItems = scored(
    visible.filter(function(p){ return foodSubs.indexOf(p.category) !== -1; }),
    { wOrders: 12, wCarts: 7, wFavs: 2, wViews: 1 },
    false
  ).slice(0,10);
  const pfScroll = document.getElementById('popularFoodScroll');
  if(pfScroll) pfScroll.innerHTML = cards(foodItems, 170) || '<div style="padding:12px;color:var(--muted)">No food products yet</div>';
  showSection('popularFoodSection', foodItems.length);

  // ── SERVICES ───────────────────────────────────────────────────────────────
  // Goal: most-booked + most-browsed services. Views matter more here because
  // people research services carefully before ordering.
  const servicesSubs = getCategoryGroupSubs('Services');
  const servicesItems = scored(
    visible.filter(function(p){ return servicesSubs.indexOf(p.category) !== -1; }),
    { wOrders: 10, wCarts: 3, wFavs: 3, wViews: 3 },
    false
  ).slice(0,10);
  const svcScroll = document.getElementById('servicesScroll');
  if(svcScroll) svcScroll.innerHTML = cards(servicesItems, 170) || '<div style="padding:12px;color:var(--muted)">No services yet</div>';
  showSection('servicesSection', servicesItems.length);

  // ── ACCESSORIES & GADGETS ──────────────────────────────────────────────────
  // Goal: most-bought and most-wishlisted accessories. Orders dominate but
  // favourites are strong here — people window-shop accessories heavily.
  const accSubs = getCategoryGroupSubs('Accessories & Gadgets');
  const accItems = scored(
    visible.filter(function(p){ return accSubs.indexOf(p.category) !== -1; }),
    { wOrders: 10, wCarts: 5, wFavs: 5, wViews: 1 },
    false
  ).slice(0,10);
  const accScroll = document.getElementById('accessoriesScroll');
  if(accScroll) accScroll.innerHTML = cards(accItems, 170) || '<div style="padding:12px;color:var(--muted)">No accessories yet</div>';
  showSection('accessoriesSection', accItems.length);

  // ── BEAUTY & SELF-CARE ─────────────────────────────────────────────────────
  // Goal: most-bought and most-desired beauty. Favourites weighted higher than other
  // categories — beauty is highly aspiration-driven before the purchase decision.
  const beautySubs = getCategoryGroupSubs('Beauty & Self-Care');
  const beautyItems = scored(
    visible.filter(function(p){ return beautySubs.indexOf(p.category) !== -1; }),
    { wOrders: 9, wCarts: 4, wFavs: 6, wViews: 1 },
    false
  ).slice(0,10);
  const beautyScroll = document.getElementById('beautyScroll');
  if(beautyScroll) beautyScroll.innerHTML = cards(beautyItems, 170) || '<div style="padding:12px;color:var(--muted)">No beauty products yet</div>';
  showSection('beautySection', beautyItems.length);

  // ── DYNAMIC CATEGORY SECTION ORDERING ─────────────────────────────────────
  // Reorder the 5 category blocks so the highest-demand category floats to top.
  // Uses order_count as primary signal (matches the new weight philosophy).
  (function reorderCategorySections() {
    var catBlocks = [
      { id: 'popularClothingSection', score: sumField(clothingItems, 'order_count') * 10 + sumField(clothingItems, 'cart_count') * 4 + sumField(clothingItems, 'favourite_count') * 3 },
      { id: 'popularFoodSection',     score: sumField(foodItems,     'order_count') * 10 + sumField(foodItems,     'cart_count') * 4 + sumField(foodItems,     'favourite_count') * 3 },
      { id: 'servicesSection',        score: sumField(servicesItems, 'order_count') * 10 + sumField(servicesItems, 'cart_count') * 4 + sumField(servicesItems, 'favourite_count') * 3 },
      { id: 'accessoriesSection',     score: sumField(accItems,      'order_count') * 10 + sumField(accItems,      'cart_count') * 4 + sumField(accItems,      'favourite_count') * 3 },
      { id: 'beautySection',          score: sumField(beautyItems,   'order_count') * 10 + sumField(beautyItems,   'cart_count') * 4 + sumField(beautyItems,   'favourite_count') * 3 },
    ].sort(function(a, b){ return b.score - a.score; });

    var firstEl = document.getElementById(catBlocks[0].id);
    if (!firstEl) return;
    var parent = firstEl.parentNode;
    if (!parent) return;
    catBlocks.forEach(function(block) {
      var el = document.getElementById(block.id);
      if (el) parent.appendChild(el);
    });
  })();

  attachProductListeners();
  runReveal();
}

/********************
 * Get variant stock for specific size
 ********************/
function getVariantStock(product, size) {
  if (product.listing_type === 'service') return Infinity;
  if (!product.variants || product.variants.length === 0) {
    return product.stock || 0;
  }
  const variant = product.variants.find(v => v.size === size);
  return variant ? (variant.stock || 0) : 0;
}

/********************
 * Get variant for specific size
 ********************/
function getVariant(product, size) {
  if (!product.variants || product.variants.length === 0) {
    return null;
  }
  
  return product.variants.find(v => v.size === size) || null;
}

/********************
 * Product interactions: open modal, add to cart
 ********************/
function attachProductListeners(){ 
  document.querySelectorAll('.product-card').forEach(card=>{ 
    const media = card.querySelector('.product-media'); 
    if (media) media.addEventListener('click',()=>openProductModal(card.dataset.id)); 
    
    // Single "+" control per card: services always open the full product
    // modal (intake answers / slot selection must happen before anything is
    // added — silently adding at qty 1 skipped that entirely). Products with
    // size options open the quick-add modal to pick a size.
    const addCircle = card.querySelector('.add-circle');
    if (addCircle) addCircle.addEventListener('click',(ev)=>{
      ev.stopPropagation();
      const id = addCircle.dataset.id;
      const product = state.products.find(x=>String(x.id)===String(id));
      if (!product) return;
      if (product.listing_type === 'service') {
        openProductModal(product.id);
      } else {
        openQuickAddModal(product);
      }
    });
  });
  markFavourites();
}

/********************
 * Open quick add modal
 ********************/
function openQuickAddModal(product) {
  currentQuickAddProduct = product;
  
  // Populate size dropdown
  quickAddSize.innerHTML = '';
  product.size.forEach(size => {
    const option = document.createElement('option');
    option.value = size;
    option.textContent = size;
    quickAddSize.appendChild(option);
  });
  
  // Update stock info
  updateQuickAddStockInfo();
  
  // Show modal (two-step class add so the fade+scale transition can run)
  quickAddModal.classList.add('open');
  requestAnimationFrame(() => quickAddModal.classList.add('visible'));
  quickAddStockError.style.display = 'none';
}

function closeQuickAddModal() {
  quickAddModal.classList.remove('visible');
  setTimeout(() => quickAddModal.classList.remove('open'), 200);
}

/********************
 * Update quick add stock info
 ********************/
function updateQuickAddStockInfo() {
  if (!currentQuickAddProduct) return;
  
  const selectedSize = quickAddSize.value;
  const stock = getVariantStock(currentQuickAddProduct, selectedSize);
  quickAddStockInfo.textContent = `${stock} items available`;
  
  // Update max quantity
  const selectedQty = parseInt(quickAddQty.value);
  if (selectedQty > stock) {
    quickAddStockError.style.display = 'block';
  } else {
    quickAddStockError.style.display = 'none';
  }
}

/********************
 * UPDATED PRODUCT MODAL - REDESIGNED (as requested)
 ********************/
let currentModalProduct = null;

async function openProductModal(id) {
  currentModalProduct = state.products.find(x => x.id == id);
  if (!currentModalProduct) return;
  if (!currentModalProduct.visible) return;

  // Track product click
  trackEvent('product_click', {
    product_id: currentModalProduct.id,
    seller_id:  currentModalProduct.seller && currentModalProduct.seller.id ? currentModalProduct.seller.id : null,
    category:   currentModalProduct.category
  });

  try {
    // Smart bundle suggestions: same-store primary, cross-category fallback
    const bundleProducts = getBundleSuggestions(currentModalProduct, state.products, 2);
    const bundleProduct = bundleProducts[0] || null; // keep legacy var for compatibility
    
    // Generate description with "see more" functionality
    const words = currentModalProduct.desc ? currentModalProduct.desc.split(' ') : [];
    const shortDescription = esc(words.slice(0, 10).join(' ') + (words.length > 10 ? '...' : ''));
    const fullDescription = esc(currentModalProduct.desc || '');
    const hasLongDescription = words.length > 10;

    // Generate size options
    const sizes = currentModalProduct.size || ['M'];
    const sizeOptions = sizes.map(size =>
      `<div class="size-option" data-size="${esc(size)}">${esc(size)}</div>`
    ).join('');

    // Generate color options (if available)
    let colorOptionsHTML = '';
    if (currentModalProduct.color) {
      colorOptionsHTML = `
        <div class="product-modal-colors">
          <h3>Color</h3>
          <div class="color-options">
            <div class="color-option selected" data-color="${esc(currentModalProduct.color)}" style="background-color: ${currentModalProduct.color.toLowerCase() === 'black' ? '#000' : currentModalProduct.color.toLowerCase() === 'white' ? '#fff' : currentModalProduct.color.toLowerCase() === 'blue' ? '#3a86ff' : '#ddd'}"></div>
          </div>
        </div>
      `;
    }
    
    // Generate thumbnails
    const images = currentModalProduct.all_images || currentModalProduct.imgs || [];
    const thumbnails = images.map((img, index) =>
      `<div class="product-thumbnail ${index === 0 ? 'active' : ''}" data-image="${esc(img)}">
        <img src="${esc(img)}" alt="${esc(currentModalProduct.title)} thumbnail ${index + 1}" loading="lazy">
      </div>`
    ).join('');
    
    // Generate smart bundle suggestions HTML
    let bundleSuggestionHTML = '';
    if (bundleProducts && bundleProducts.length) {
      const bundleItems = bundleProducts.map(bp => {
        const bImg = bp.primary_image || (bp.imgs && bp.imgs[0]) || svgPlaceholder(bp.title,60,60);
        const bPrice = bp.sale && bp.salePrice ? bp.salePrice : bp.price;
        const sameSeller = bp.seller && currentModalProduct.seller && bp.seller.id === currentModalProduct.seller.id;
        return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f0f2f5">
          <img src="${esc(bImg)}" alt="${esc(bp.title)}" loading="lazy" style="width:50px;height:50px;object-fit:cover;border-radius:8px;flex-shrink:0" onerror="this.style.display='none'">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(bp.title)}</div>
            <div style="font-size:12px;color:#6b7280">${sameSeller ? 'Same store' : esc(bp.seller && bp.seller.shop_name ? bp.seller.shop_name : '')} · R${Number(bPrice).toFixed(0)}</div>
          </div>
          <button class="bundle-button" data-bundle-id="${bp.id}" data-bundle-title="${esc(bp.title)}" style="font-size:12px;padding:5px 12px;background:#0a2f66;color:#fff;border:none;border-radius:999px;cursor:pointer;flex-shrink:0">+ Add</button>
        </div>`;
      }).join('');
      bundleSuggestionHTML = `
        <div class="bundle-suggestion" style="background:#f8faff;border-radius:10px;padding:12px 14px;margin:12px 0">
          <div style="font-size:12px;font-weight:700;color:var(--color-ink-navy);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Frequently Bought Together</div>
          ${bundleItems}
          <div style="font-size:11px;color:#6b7280;margin-top:8px">Get free shipping when you buy 2+ items!</div>
        </div>`;
    }
    
    // Check if product is on sale
    const isOnSale = currentModalProduct.sale || false;
    const salePrice = currentModalProduct.salePrice || 0;
    const displayPrice = isOnSale ? salePrice : currentModalProduct.price;
    const originalPrice = isOnSale ? currentModalProduct.price : null;
    
    const modalContent = document.getElementById('productModalContent');
    modalContent.innerHTML = `
      <div class="product-modal-images">
        <div class="product-modal-main-image" id="main-product-image-wrap">
          ${isVideoUrl(images[0])
            ? `<video src="${esc(images[0])}" autoplay muted loop playsinline id="main-product-image" style="width:100%;height:100%;object-fit:contain;border-radius:8px"></video>`
            : `<img src="${images[0] ? esc(images[0]) : svgPlaceholder(currentModalProduct.title,400,300)}" alt="${esc(currentModalProduct.title)}" id="main-product-image" loading="lazy">`
          }
        </div>
        <div class="product-modal-thumbnails">
          ${thumbnails}
        </div>
      </div>
      <div class="product-modal-details">
        <h1 class="product-modal-title">${esc(currentModalProduct.title)}</h1>
        ${currentModalProduct.seller ? `
        <div class="product-modal-seller" style="display:flex;flex-direction:column;gap:6px;margin:6px 0 10px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:13px;color:#6b7280">Sold by</span>
            <a href="shop.html?shop=${encodeURIComponent(currentModalProduct.seller.shop_name)}" style="font-size:13px;font-weight:700;color:#0a2f66;text-decoration:none" target="_blank">${esc(currentModalProduct.seller.shop_name)} ↗</a>
          </div>
          ${currentModalProduct.seller.turnaround_time ? `
          <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;background:#f0f4ff;border-radius:8px;padding:6px 10px;flex-wrap:wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" style="flex-shrink:0"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/></svg>
            <span>Usually ready for drop-off within: <strong>${esc(currentModalProduct.seller.turnaround_time)}</strong></span>
          </div>` : ''}
        </div>` : ''}
        ${currentModalProduct.listing_type === 'service' ? (() => {
          const ft = currentModalProduct.fulfillment_type;
          const ta = currentModalProduct.service_turnaround || 'TBD';
          const ICONS = {
            item_dropoff: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/>',
            in_person: '<path d="M12 21s7-6.5 7-11.5A7 7 0 0 0 5 9.5C5 14.5 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.3"/>',
            digital: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
            service: '<path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 1 5.4-5.4l-3 3-2-2 3-3z"/>'
          };
          let ftIconPath = '', ftLabel = '';
          if (ft === 'item_dropoff') { ftIconPath = ICONS.item_dropoff; ftLabel = 'A rep collects your item from your address'; }
          else if (ft === 'in_person') { ftIconPath = ICONS.in_person; ftLabel = 'Meet in-person on campus'; }
          else if (ft === 'digital') { ftIconPath = ICONS.digital; ftLabel = 'Digital delivery'; }
          else { ftIconPath = ICONS.service; ftLabel = 'Service'; }
          const svgIcon = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" style="flex-shrink:0;vertical-align:-2px">${path}</svg>`;
          const locationLine = currentModalProduct.service_location
            ? `<div style="margin-top:4px;color:#6b7280">Location: <strong>${esc(currentModalProduct.service_location)}</strong></div>` : '';
          return `<div style="background:#f5f3ff;border:1px solid #c4b5fd;border-radius:10px;padding:10px 14px;margin:8px 0;font-size:13px;color:#4c1d95">
            <div style="font-weight:700;margin-bottom:4px;display:flex;align-items:center;gap:6px">${svgIcon(ICONS.service)} Service listing</div>
            <div style="display:flex;align-items:center;gap:6px">${svgIcon(ftIconPath)} <span>${ftLabel}</span></div>
            ${ft === 'item_dropoff' ? `<div style="margin-top:4px;color:#6b7280">${currentModalProduct.item_returned === false ? 'This item is not returned — it becomes part of your order.' : "You'll get your item back when it's done."}</div>` : ''}
            ${locationLine}
            <div style="margin-top:4px;color:#6b7280">Turnaround: <strong>${esc(ta)}</strong></div>
          </div>`;
        })() : ''}
        ${renderServicePurchaseInputs(currentModalProduct)}
        <div class="product-modal-rating">
          <div class="stars" style="color: #ffd700; font-size: 16px;">
            ${'★'.repeat(5)}
          </div>
          <span>5.0 (1 review)</span>
        </div>
        <div class="product-modal-price${isOnSale && originalPrice ? ' price-sale' : ''}">
          R${displayPrice.toFixed(2)}
          ${isOnSale && originalPrice ?
            `<span class="product-modal-original-price">R${originalPrice.toFixed(2)}</span>` : ''}
        </div>
        
        ${currentModalProduct.listing_type !== 'service' ? `<div class="product-modal-sizes">
          <h3>Size</h3>
          <div class="size-options">
            ${sizeOptions}
          </div>
        </div>` : ''}
        
        ${colorOptionsHTML}

        ${currentModalProduct.listing_type !== 'service' ? `<div class="product-modal-delivery-pref" style="margin:12px 0">
          <h3 style="font-size:14px;font-weight:700;margin-bottom:6px">Preferred Delivery <span style="font-size:11px;font-weight:400;color:#6b7280">(optional)</span></h3>
          <select id="modal-delivery-pref" style="width:100%;padding:9px 12px;border:1px solid #d9d9df;border-radius:8px;font-size:14px;color:#1a1a2e;background:#fff">
            <option value="">No preference</option>
            <option value="Delivery to my address">Delivery to my address / location</option>
          </select>
        </div>` : ''}

        <div class="product-modal-quantity">
          <h3>Quantity</h3>
          <div class="quantity-selector">
            <button class="quantity-btn" id="decrease-qty">-</button>
            <span class="quantity-value" id="quantity-value">1</span>
            <button class="quantity-btn" id="increase-qty">+</button>
          </div>
        </div>
        
        ${bundleSuggestionHTML}
        
        <button class="product-modal-add-to-cart" id="modal-add-to-cart" data-id="${currentModalProduct.id}">${currentModalProduct.listing_type === 'service' ? (currentModalProduct.fulfillment_type === 'in_person' && currentModalProduct.booking_mode === 'scheduled' ? 'Book This Time' : 'Send Request') : 'Add to Cart'}</button>
        <button id="modal-share-btn" style="width:100%;padding:10px;border:1px solid var(--color-border);border-radius:999px;background:#fff;color:var(--accent);font-size:14px;font-weight:600;cursor:pointer;margin-top:8px;transition:background 0.15s;display:flex;align-items:center;justify-content:center;gap:6px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.5-1.5"/></svg> Copy Link</button>

        <div class="product-modal-description">
          <h3>Description</h3>
          <div class="description-text ${hasLongDescription ? 'collapsed' : ''}" id="product-description">
            ${hasLongDescription ? shortDescription : fullDescription}
          </div>
          ${hasLongDescription ? '<button class="see-more-btn" id="see-more-btn">See More</button>' : ''}
        </div>
      </div>
    `;
    
    // Show modal
    modal.classList.add('active');

    // Add event listeners for the modal
    setupProductModalEvents(bundleProduct);
    wireServiceHandoffInputs();
    wireServiceIntakeFileUploads();

    // Appointment services: fetch availability + existing bookings and render
    // the day/time picker (needs a query, so it loads after the modal shows).
    if (currentModalProduct.listing_type === 'service' &&
        currentModalProduct.fulfillment_type === 'in_person' &&
        currentModalProduct.booking_mode === 'scheduled') {
      loadSlotPicker(currentModalProduct);
    }

  } catch (error) {
    console.error('Error opening product modal:', error);
  }
}

/********************
 * Service purchase-time inputs: intake questions / slot picker
 ********************/
function renderServicePurchaseInputs(p) {
  if (!p || p.listing_type !== 'service') return '';
  const fields = Array.isArray(p.intake_fields) ? p.intake_fields : [];
  const intakeKind = p.intake_kind || 'item';

  const intakeHtml = fields.length ? `<div class="product-modal-intake" style="margin:12px 0">
      <h3 style="font-size:14px;font-weight:700;margin-bottom:8px">${p.fulfillment_type === 'digital' ? 'What do you need to start?' : intakeKind === 'item' ? 'Tell us about your item' : 'What do you need to start?'}</h3>
      ${fields.map(f => {
        const req = f.required ? ' <span style="color:#dc2626">*</span>' : '';
        const labelAttr = String(f.label).replace(/"/g,'&quot;');
        if (f.type === 'file') {
          return `<div class="modal-intake-file-row" style="margin-bottom:8px" data-intake-label="${labelAttr}" data-required="${!!f.required}">
          <label style="display:block;font-size:12px;color:#374151;margin-bottom:4px">${esc(f.label)}${req}</label>
          <label class="modal-intake-dropzone" style="display:block;border:1.5px dashed #d9d9df;border-radius:8px;padding:14px;text-align:center;font-size:13px;color:#6b7280;cursor:pointer">
            <span class="modal-intake-dropzone-text">Tap to upload — PDF, image or doc, max 10 MB</span>
            <input type="file" class="modal-intake-file-input" accept=".pdf,.doc,.docx,.txt,image/*" style="display:none">
          </label>
        </div>`;
        }
        return `<div style="margin-bottom:8px">
          <label style="display:block;font-size:12px;color:#374151;margin-bottom:4px">${esc(f.label)}${req}</label>
          <input type="text" class="modal-intake-input" data-intake-label="${labelAttr}" data-required="${!!f.required}" style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #d9d9df;border-radius:8px;font-size:14px">
        </div>`;
      }).join('')}
    </div>` : '';

  if (p.fulfillment_type === 'digital') return intakeHtml;

  if (p.fulfillment_type === 'item_dropoff') {
    // The handoff/return block renders even with zero intake fields — unlike
    // intake, it's never optional-away, just skippable (defaults to free).
    // Nothing physical to collect when the buyer sends a file or nothing at
    // all — only 'item' intake has a collection leg.
    const showCollection = intakeKind === 'item';
    const showReturn = p.item_returned !== false;
    return `${intakeHtml}<div class="product-modal-handoff" style="margin:12px 0">
      ${showCollection ? `<h3 style="font-size:14px;font-weight:700;margin-bottom:8px">Getting your item to us</h3>
      <div style="font-size:13px;color:#374151;margin-bottom:8px">A rep collects it from your address — <strong>R15</strong></div>
      <div id="modal-collection-address-wrap" style="margin:8px 0 0">
        <label style="display:block;font-size:12px;color:#374151;margin-bottom:4px">Where should the rep collect?</label>
        <input type="text" id="modal-collection-address" placeholder="e.g. Santa Cruz Res, Block B, Room 214" style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #d9d9df;border-radius:8px;font-size:14px">
        <label style="display:block;font-size:12px;color:#374151;margin:8px 0 4px">When should they come?</label>
        <div id="modal-collection-slot-picker" style="font-size:13px;color:#6b7280">Loading available times…</div>
      </div>` : ''}
      ${showReturn ? `
      <h3 style="font-size:14px;font-weight:700;margin:${showCollection ? '16px' : '0'} 0 8px">${showCollection ? 'Getting it back to you' : 'Getting your order to you'}</h3>
      <div style="font-size:13px;color:#374151;margin-bottom:8px">Delivered back to you — <strong>R15</strong></div>
      <div id="modal-return-address-wrap" style="margin:8px 0 0">
        ${showCollection ? `<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;margin-bottom:6px;cursor:pointer">
          <input type="checkbox" id="modal-return-same-address"> Same as collection address
        </label>` : ''}
        <label style="display:block;font-size:12px;color:#374151;margin-bottom:4px">Where should we deliver it?</label>
        <input type="text" id="modal-return-address" placeholder="e.g. Santa Cruz Res, Block B, Room 214" style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #d9d9df;border-radius:8px;font-size:14px">
        <label style="display:block;font-size:12px;color:#374151;margin:8px 0 4px">When should we deliver?</label>
        <div id="modal-return-slot-picker" style="font-size:13px;color:#6b7280">Loading available times…</div>
      </div>` : ''}
      <div style="margin-top:10px;font-size:12px;color:#9ca3af">You can change these at checkout.</div>
    </div>`;
  }

  if (p.fulfillment_type === 'in_person' && p.booking_mode === 'scheduled') {
    return `<div class="product-modal-booking" style="margin:12px 0">
      <h3 style="font-size:14px;font-weight:700;margin-bottom:8px">Choose a time</h3>
      <div id="modal-slot-picker" style="font-size:13px;color:#6b7280">Loading available times…</div>
    </div>`;
  }

  return '';
}

// A paid collection/delivery leg needs a committed time, not just an
// address — these hold the modal's current picks (reset per modal open).
let selectedCollectionSlot = null;
let selectedReturnSlot = null;

// Wires the handoff block above — collection/return is always rep-collect/
// deliver now (no free campus choice left), so both slot pickers just load
// unconditionally, plus the "same as collection" address copy.
function wireServiceHandoffInputs() {
  selectedCollectionSlot = null;
  selectedReturnSlot = null;
  const collectWrap = document.getElementById('modal-collection-address-wrap');
  if (collectWrap) {
    loadRepSlotPicker(document.getElementById('modal-collection-slot-picker'), slot => { selectedCollectionSlot = slot; });
  }
  const returnWrap = document.getElementById('modal-return-address-wrap');
  if (returnWrap) {
    loadRepSlotPicker(document.getElementById('modal-return-slot-picker'), slot => { selectedReturnSlot = slot; });
  }
  const sameAddr = document.getElementById('modal-return-same-address');
  const collectAddr = document.getElementById('modal-collection-address');
  const returnAddr = document.getElementById('modal-return-address');
  if (sameAddr && collectAddr && returnAddr) {
    sameAddr.addEventListener('change', () => {
      if (sameAddr.checked) { returnAddr.value = collectAddr.value; returnAddr.disabled = true; }
      else { returnAddr.disabled = false; }
    });
  }
}

// Buyer-uploaded intake files (e.g. the document for a printing-style
// service) — uploads immediately on selection to the service-intake bucket
// (public, anon-writable — guests can buy these services too) and stores
// the answer as {type:'file', url, name} on the dropzone's dataset so the
// add-to-cart handler can read it the same way it reads text answers.
function wireServiceIntakeFileUploads() {
  document.querySelectorAll('.modal-intake-file-input').forEach(input => {
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file || !supabaseClient) return;
      const row = input.closest('.modal-intake-file-row');
      const dropzone = input.closest('.modal-intake-dropzone');
      const textEl = dropzone.querySelector('.modal-intake-dropzone-text');
      const addBtn = document.getElementById('modal-add-to-cart');
      const originalText = textEl.textContent;
      textEl.textContent = 'Uploading…';
      if (addBtn) addBtn.disabled = true;
      try {
        const path = `intake/${crypto.randomUUID()}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const { error } = await supabaseClient.storage.from('service-intake').upload(path, file, { upsert: false });
        if (error) throw error;
        const { data: pub } = supabaseClient.storage.from('service-intake').getPublicUrl(path);
        row.dataset.fileUrl = pub.publicUrl;
        row.dataset.fileName = file.name;
        textEl.textContent = `✓ ${file.name} · Replace`;
      } catch (e) {
        console.error('Intake file upload failed', e);
        textEl.textContent = originalText;
        showNotification('Upload failed — please try again.');
      } finally {
        if (addBtn) addBtn.disabled = false;
      }
    });
  });
}

let selectedBookingSlot = null; // {start, end} ISO strings — reset each time a booking modal opens

async function loadSlotPicker(p) {
  selectedBookingSlot = null;
  const container = document.getElementById('modal-slot-picker');
  if (!container) return;
  if (!currentUser) {
    container.innerHTML = '<a href="#" id="modal-slot-login-link" style="color:var(--accent);font-weight:600">Sign in</a> to see and book this seller\'s available times.';
    const link = document.getElementById('modal-slot-login-link');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); closeProductModal(); showModal(loginModal); });
    return;
  }
  if (!supabaseClient) return;
  const sellerId = p.seller && p.seller.id;
  if (!sellerId) { container.innerHTML = 'Booking unavailable for this listing.'; return; }

  const now = new Date();
  const horizonDays = 14;
  const rangeEnd = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  const [availRes, bookingsRes] = await Promise.all([
    supabaseClient.from('seller_availability').select('day_of_week,start_time,end_time').eq('seller_id', sellerId),
    supabaseClient.from('service_bookings').select('start_at,end_at,status')
      .eq('seller_id', sellerId).in('status', ['held', 'confirmed'])
      .gte('start_at', now.toISOString()).lte('start_at', rangeEnd.toISOString())
  ]);

  const availability = availRes.data || [];
  const bookings = bookingsRes.data || [];
  if (!availability.length) { container.innerHTML = "This seller hasn't set their availability yet."; return; }

  const durationMin = p.slot_duration_minutes || 60;
  const dayButtons = computeSlotDayButtons(availability, bookings, durationMin, horizonDays);

  if (!dayButtons.length) { container.innerHTML = 'No upcoming availability in the next 2 weeks.'; return; }

  let activeDayIdx = 0;
  function render() {
    const day = dayButtons[activeDayIdx];
    container.innerHTML =
      '<div style="display:flex;gap:6px;overflow-x:auto;padding-bottom:8px;margin-bottom:8px" id="modal-slot-days"></div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px" id="modal-slot-times"></div>' +
      '<div id="modal-slot-selected" style="margin-top:8px;font-size:12px;color:#059669;font-weight:600"></div>';
    const daysEl = document.getElementById('modal-slot-days');
    dayButtons.forEach((d, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = d.label;
      const active = i === activeDayIdx;
      btn.style.cssText = 'flex-shrink:0;padding:8px 12px;border-radius:999px;border:1.5px solid ' + (active ? 'var(--accent)' : '#e5e7eb') + ';background:' + (active ? '#f0f6ff' : '#fff') + ';color:' + (active ? 'var(--accent)' : '#374151') + ';font-size:12px;font-weight:600;cursor:pointer';
      btn.addEventListener('click', () => { activeDayIdx = i; render(); });
      daysEl.appendChild(btn);
    });
    const timesEl = document.getElementById('modal-slot-times');
    day.slots.forEach(slot => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const timeLabel = formatSAST(slot.start, { hour: '2-digit', minute: '2-digit' });
      btn.textContent = timeLabel;
      const isSelected = selectedBookingSlot && selectedBookingSlot.start === slot.start.toISOString();
      btn.style.cssText = 'padding:8px 14px;border-radius:8px;border:1.5px solid ' + (isSelected ? 'var(--accent)' : '#e5e7eb') + ';background:' + (isSelected ? 'var(--accent)' : '#fff') + ';color:' + (isSelected ? '#fff' : '#374151') + ';font-size:13px;font-weight:600;cursor:pointer';
      btn.addEventListener('click', () => {
        selectedBookingSlot = { start: slot.start.toISOString(), end: slot.end.toISOString() };
        render();
        const selEl = document.getElementById('modal-slot-selected');
        if (selEl) selEl.textContent = 'Selected: ' + day.label + ' at ' + timeLabel;
      });
      timesEl.appendChild(btn);
    });
  }
  render();
}

// Shared by loadSlotPicker (seller in_person appointments) and
// loadRepSlotPicker (rep collection/delivery windows) — turns raw
// availability rows + existing bookings into a list of open day/slot
// buttons, all computed in SAST regardless of the browser's own timezone.
function computeSlotDayButtons(availability, bookings, durationMin, horizonDays) {
  const now = new Date();
  const nowParts = sastParts(now);
  const todayMidnightSAST = sastDate(nowParts.year, nowParts.month, nowParts.day, 0, 0);

  function slotsForDay(dayDate) {
    const dp = sastParts(dayDate);
    const dayAvail = availability.filter(a => a.day_of_week === dp.dayOfWeek);
    if (!dayAvail.length) return [];
    const slots = [];
    dayAvail.forEach(a => {
      const [sh, sm] = a.start_time.split(':').map(Number);
      const [eh, em] = a.end_time.split(':').map(Number);
      let cursor = sastDate(dp.year, dp.month, dp.day, sh, sm);
      const end = sastDate(dp.year, dp.month, dp.day, eh, em);
      while (cursor.getTime() + durationMin * 60000 <= end.getTime()) {
        const slotStart = new Date(cursor);
        const slotEnd = new Date(cursor.getTime() + durationMin * 60000);
        if (slotStart > now) {
          const overlaps = bookings.some(b => {
            const bs = new Date(b.start_at), be = new Date(b.end_at);
            return slotStart < be && slotEnd > bs;
          });
          if (!overlaps) slots.push({ start: slotStart, end: slotEnd });
        }
        cursor = new Date(cursor.getTime() + durationMin * 60000);
      }
    });
    return slots;
  }

  const days = [];
  for (let i = 0; i < horizonDays; i++) days.push(new Date(todayMidnightSAST.getTime() + i * 24 * 60 * 60 * 1000));
  return days
    .map(d => ({ date: d, slots: slotsForDay(d), label: formatSAST(d, { weekday: 'short', day: 'numeric', month: 'short' }) }))
    .filter(d => d.slots.length);
}

// Rep collection/delivery slot picker — visual clone of loadSlotPicker, but
// sourced from the union of ALL active reps' rep_availability (no specific
// rep is assigned until claim-time post-payment, so there's no single
// resource to double-book-check the way seller appointments are). Mounted
// under the address field whenever rep_collect/deliver is chosen. Fixed
// 60-minute slots — collection/return isn't a long session like a haircut,
// just a pickup window.
async function loadRepSlotPicker(mountEl, onPick, existingSlot) {
  if (!mountEl) return;
  if (!currentUser) {
    mountEl.innerHTML = '<a href="#" class="rep-slot-login-link" style="color:var(--accent);font-weight:600">Sign in</a> to pick a collection/delivery time.';
    const link = mountEl.querySelector('.rep-slot-login-link');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); closeProductModal(); showModal(loginModal); });
    return;
  }
  if (!supabaseClient) return;
  mountEl.innerHTML = 'Loading available times…';

  const now = new Date();
  const horizonDays = 14;
  const rangeEnd = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);
  const durationMin = 60;

  const [availRes, bookingsRes] = await Promise.all([
    supabaseClient.from('rep_availability').select('day_of_week,start_time,end_time'),
    supabaseClient.from('service_bookings').select('start_at,end_at,status')
      .in('status', ['held', 'confirmed'])
      .gte('start_at', now.toISOString()).lte('start_at', rangeEnd.toISOString())
  ]);

  const availability = availRes.data || [];
  const bookings = bookingsRes.data || [];
  if (!availability.length) { mountEl.innerHTML = "No collection/delivery hours are set up yet — pick a free option instead, or check back soon."; return; }

  const dayButtons = computeSlotDayButtons(availability, bookings, durationMin, horizonDays);
  if (!dayButtons.length) { mountEl.innerHTML = 'No upcoming availability in the next 2 weeks — pick a free option instead.'; return; }

  let selected = existingSlot && existingSlot.start ? { start: existingSlot.start, end: existingSlot.end } : null;
  let activeDayIdx = 0;
  if (selected) {
    const idx = dayButtons.findIndex(d => d.slots.some(s => s.start.toISOString() === selected.start));
    if (idx > -1) activeDayIdx = idx;
  }

  function render() {
    const day = dayButtons[activeDayIdx];
    mountEl.innerHTML =
      '<div style="display:flex;gap:6px;overflow-x:auto;padding-bottom:8px;margin-bottom:8px" class="rep-slot-days"></div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px" class="rep-slot-times"></div>' +
      '<div class="rep-slot-selected" style="margin-top:8px;font-size:12px;color:#059669;font-weight:600"></div>';
    const daysEl = mountEl.querySelector('.rep-slot-days');
    dayButtons.forEach((d, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = d.label;
      const active = i === activeDayIdx;
      btn.style.cssText = 'flex-shrink:0;padding:8px 12px;border-radius:999px;border:1.5px solid ' + (active ? 'var(--accent)' : '#e5e7eb') + ';background:' + (active ? '#f0f6ff' : '#fff') + ';color:' + (active ? 'var(--accent)' : '#374151') + ';font-size:12px;font-weight:600;cursor:pointer';
      btn.addEventListener('click', () => { activeDayIdx = i; render(); });
      daysEl.appendChild(btn);
    });
    const timesEl = mountEl.querySelector('.rep-slot-times');
    day.slots.forEach(slot => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const timeLabel = formatSAST(slot.start, { hour: '2-digit', minute: '2-digit' });
      btn.textContent = timeLabel;
      const isSelected = selected && selected.start === slot.start.toISOString();
      btn.style.cssText = 'padding:8px 14px;border-radius:8px;border:1.5px solid ' + (isSelected ? 'var(--accent)' : '#e5e7eb') + ';background:' + (isSelected ? 'var(--accent)' : '#fff') + ';color:' + (isSelected ? '#fff' : '#374151') + ';font-size:13px;font-weight:600;cursor:pointer';
      btn.addEventListener('click', () => {
        selected = { start: slot.start.toISOString(), end: slot.end.toISOString() };
        render();
        const selEl = mountEl.querySelector('.rep-slot-selected');
        if (selEl) selEl.textContent = 'Selected: ' + day.label + ' at ' + timeLabel;
        if (onPick) onPick(selected);
      });
      timesEl.appendChild(btn);
    });
  }
  render();
}

/********************
 * Setup product modal events
 ********************/
function setupProductModalEvents(bundleProduct) {
  // Thumbnail click
  document.querySelectorAll('.product-thumbnail').forEach(thumb => {
    thumb.addEventListener('click', function() {
      const mediaUrl = this.dataset.image;
      const wrap = document.getElementById('main-product-image-wrap');
      if (wrap) {
        if (isVideoUrl(mediaUrl)) {
          wrap.innerHTML = `<video src="${mediaUrl}" autoplay muted loop playsinline id="main-product-image" style="width:100%;height:100%;object-fit:contain;border-radius:8px"></video>`;
        } else {
          wrap.innerHTML = `<img src="${mediaUrl}" alt="product" id="main-product-image" loading="lazy">`;
        }
      }
      document.querySelectorAll('.product-thumbnail').forEach(t => t.classList.remove('active'));
      this.classList.add('active');
    });
  });
  
  // Size selection
  document.querySelectorAll('.size-option').forEach(option => {
    option.addEventListener('click', function() {
      document.querySelectorAll('.size-option').forEach(o => o.classList.remove('selected'));
      this.classList.add('selected');
    });
  });
  
  // Color selection
  document.querySelectorAll('.color-option').forEach(option => {
    option.addEventListener('click', function() {
      document.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
      this.classList.add('selected');
    });
  });
  
  // Quantity controls
  document.getElementById('increase-qty').addEventListener('click', function() {
    const valueElement = document.getElementById('quantity-value');
    let value = parseInt(valueElement.textContent);
    valueElement.textContent = value + 1;
  });
  
  document.getElementById('decrease-qty').addEventListener('click', function() {
    const valueElement = document.getElementById('quantity-value');
    let value = parseInt(valueElement.textContent);
    if (value > 1) {
      valueElement.textContent = value - 1;
    }
  });
  
  // See more button
  const seeMoreBtn = document.getElementById('see-more-btn');
  if (seeMoreBtn) {
    seeMoreBtn.addEventListener('click', function() {
      const descriptionElement = document.getElementById('product-description');
      if (descriptionElement.classList.contains('collapsed')) {
        descriptionElement.textContent = currentModalProduct.desc;
        descriptionElement.classList.remove('collapsed');
        this.textContent = 'See Less';
      } else {
        const words = currentModalProduct.desc.split(' ');
        const shortDescription = words.slice(0, 10).join(' ') + '...';
        descriptionElement.textContent = shortDescription;
        descriptionElement.classList.add('collapsed');
        this.textContent = 'See More';
      }
    });
  }
  
  // Bundle buttons (multiple)
  document.querySelectorAll('.bundle-button').forEach(function(bundleButton) {
    bundleButton.addEventListener('click', function() {
      const bundleProductId = this.getAttribute('data-bundle-id');
      const bundleTitle = this.getAttribute('data-bundle-title') || '';
      const bundleProd = state.products.find(function(p){ return String(p.id) === String(bundleProductId); });
      if (!bundleProd) return;
      const selectedSize = document.querySelector('.size-option.selected')?.dataset.size || (currentModalProduct.size && currentModalProduct.size[0]);
      const bundleSize = bundleProd.size && bundleProd.size[0];
      addToCart(bundleProductId, 1, bundleSize);
      // Track bundle click
      trackEvent('bundle_click', {
        product_id: bundleProductId,
        seller_id:  bundleProd.seller && bundleProd.seller.id ? bundleProd.seller.id : null,
        category:   bundleProd.category,
        metadata:   { trigger_product_id: currentModalProduct.id }
      });
      showNotification(`Added "${bundleTitle || bundleProd.title}" to cart!`);
    });
  });
  
  // Modal add to cart
  document.getElementById('modal-add-to-cart').addEventListener('click', async function() {
    const productId = this.dataset.id;
    const isService = currentModalProduct.listing_type === 'service';
    let quantity = parseInt(document.getElementById('quantity-value').textContent);
    const selectedSize = isService
      ? 'One Size'
      : (document.querySelector('.size-option.selected')?.dataset.size || currentModalProduct.size?.[0]);
    const preferredDelivery = (document.getElementById('modal-delivery-pref')?.value || '');
    const btn = this;

    // Check stock (skip for services — unlimited)
    if (!isService) {
      const variantStock = getVariantStock(currentModalProduct, selectedSize);
      if (variantStock < quantity) {
        alert(`Only ${variantStock} items available for size ${selectedSize}`);
        return;
      }
    }

    let serviceExtra = null;
    if (isService) {
      // Intake questions (item_dropoff / digital) — validate required fields.
      // Text fields and file fields are collected the same way, into one
      // answer object; a file's answer is {type:'file', url, name}.
      const intakeInputs = document.querySelectorAll('.modal-intake-input');
      const intakeFileRows = document.querySelectorAll('.modal-intake-file-row');
      if (intakeInputs.length || intakeFileRows.length) {
        const intake = {};
        for (const input of intakeInputs) {
          const val = input.value.trim();
          if (input.dataset.required === 'true' && !val) {
            input.style.borderColor = '#dc2626';
            input.focus();
            return;
          }
          if (val) intake[input.dataset.intakeLabel] = val;
        }
        for (const row of intakeFileRows) {
          const url = row.dataset.fileUrl;
          if (row.dataset.required === 'true' && !url) {
            row.querySelector('.modal-intake-dropzone').style.borderColor = '#dc2626';
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            showNotification('Please upload ' + row.dataset.intakeLabel + ' first.');
            return;
          }
          if (url) intake[row.dataset.intakeLabel] = { type: 'file', url, name: row.dataset.fileName };
        }
        serviceExtra = Object.assign({}, serviceExtra, { intake });
      }

      // Item drop-off handoff/return — always rep-collect/deliver now (no
      // free campus collection-point choice left), both mandatory. No
      // collection leg at all when the buyer sends a file/nothing — the
      // address-wrap element doesn't exist in the DOM in that case.
      if (currentModalProduct.fulfillment_type === 'item_dropoff') {
        const hasCollectionUI = !!document.getElementById('modal-collection-address-wrap');
        const collectionMethod = hasCollectionUI ? 'rep_collect' : 'none';
        const collectionAddressInput = document.getElementById('modal-collection-address');
        const collectionAddress = collectionAddressInput ? collectionAddressInput.value.trim() : '';
        if (collectionMethod === 'rep_collect' && !collectionAddress) {
          collectionAddressInput.style.borderColor = '#dc2626';
          collectionAddressInput.focus();
          showNotification('Add your address so the rep knows where to go.');
          return;
        }
        if (collectionMethod === 'rep_collect' && !selectedCollectionSlot) {
          document.getElementById('modal-collection-slot-picker')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          showNotification('Please pick a collection time.');
          return;
        }

        const hasReturnUI = !!document.getElementById('modal-return-address-wrap');
        const returnMethod = hasReturnUI ? 'deliver' : 'none';
        const returnAddressInput = document.getElementById('modal-return-address');
        const returnAddress = returnAddressInput ? returnAddressInput.value.trim() : '';
        if (returnMethod === 'deliver' && !returnAddress) {
          returnAddressInput.style.borderColor = '#dc2626';
          returnAddressInput.focus();
          showNotification('Add your address so we know where to deliver it.');
          return;
        }
        if (returnMethod === 'deliver' && !selectedReturnSlot) {
          document.getElementById('modal-return-slot-picker')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          showNotification('Please pick a delivery time.');
          return;
        }

        serviceExtra = Object.assign({}, serviceExtra, {
          service_options: {
            collection_method: collectionMethod,
            collection_address: collectionMethod === 'rep_collect' ? collectionAddress : null,
            collection_slot_start: collectionMethod === 'rep_collect' ? selectedCollectionSlot?.start : null,
            collection_slot_end: collectionMethod === 'rep_collect' ? selectedCollectionSlot?.end : null,
            return_method: returnMethod,
            return_address: returnMethod === 'deliver' ? returnAddress : null,
            return_slot_start: returnMethod === 'deliver' ? selectedReturnSlot?.start : null,
            return_slot_end: returnMethod === 'deliver' ? selectedReturnSlot?.end : null
          }
        });
      }

      // Scheduled appointment — turn the selected slot into a booking hold
      if (currentModalProduct.fulfillment_type === 'in_person' && currentModalProduct.booking_mode === 'scheduled') {
        if (!currentUser) { closeProductModal(); showModal(loginModal); return; }
        if (!selectedBookingSlot) {
          const picker = document.getElementById('modal-slot-picker');
          if (picker) picker.scrollIntoView({ behavior: 'smooth', block: 'center' });
          showNotification('Please pick a time first.');
          return;
        }
        quantity = 1; // one booking = one slot, regardless of the quantity stepper
        btn.disabled = true;
        const holdExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        const { data: booking, error: bookingErr } = await supabaseClient.from('service_bookings').insert({
          seller_id: currentModalProduct.seller.id,
          product_id: currentModalProduct.id,
          buyer_user_id: currentUser.id,
          start_at: selectedBookingSlot.start,
          end_at: selectedBookingSlot.end,
          status: 'held',
          hold_expires_at: holdExpiresAt
        }).select().single();
        btn.disabled = false;
        if (bookingErr) {
          // Most likely the exclusion constraint caught a race — someone else just took this slot.
          showNotification("That time was just taken — please pick another.");
          loadSlotPicker(currentModalProduct);
          return;
        }
        serviceExtra = Object.assign({}, serviceExtra, { booking_id: booking.id, booking_start_at: booking.start_at });
      }
    }

    // Persist preferred delivery to localStorage so checkout-success can update order notes
    if (preferredDelivery) localStorage.setItem('ss_preferred_delivery', preferredDelivery);

    addToCart(productId, quantity, selectedSize, preferredDelivery, serviceExtra);
    showNotification(isService ? `"${currentModalProduct.title}" added — complete checkout to send your request!` : `Added ${quantity} "${currentModalProduct.title}" to cart!`);
    closeProductModal();
  });
  
  // Select first size and color by default
  if (document.querySelector('.size-option')) {
    document.querySelector('.size-option').classList.add('selected');
  }
  if (document.querySelector('.color-option')) {
    document.querySelector('.color-option').classList.add('selected');
  }

  // Share / Copy Link
  var shareBtn = document.getElementById('modal-share-btn');
  if (shareBtn && currentModalProduct) {
    shareBtn.addEventListener('click', function() {
      var url = currentModalProduct.seller && currentModalProduct.seller.shop_name
        ? window.location.origin + '/shop.html?shop=' + encodeURIComponent(currentModalProduct.seller.shop_name) + '&product=' + currentModalProduct.id
        : window.location.origin + '/?product=' + currentModalProduct.id;
      navigator.clipboard.writeText(url).then(function() {
        var originalHTML = shareBtn.innerHTML;
        shareBtn.textContent = '✓ Copied!';
        setTimeout(function(){ shareBtn.innerHTML = originalHTML; }, 2000);
      }).catch(function() { prompt('Copy this link:', url); });
    });
  }
}

// Close product modal
function closeProductModal() {
  modal.classList.remove('active');
}
modalClose.addEventListener('click', closeProductModal);

modal.addEventListener('click', (e) => {
  if (e.target === modal) closeProductModal();
});

// Escape key closes whichever unified modal is currently open — none of
// productModal/quickAddModal/notifyModal had this before.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (modal.classList.contains('active')) closeProductModal();
  else if (quickAddModal.classList.contains('open')) closeQuickAddModal();
  else {
    const notify = document.getElementById('notifyModal');
    if (notify && notify.classList.contains('active')) closeNotifyModal();
  }
});

/********************
 * Sidebar open/close behavior
 ********************/
function setSidebarCollapsed(collapsed){ 
  if(collapsed){ 
    sidebar.classList.add('collapsed'); 
    document.documentElement.style.setProperty('--sidebar-w','0px'); 
    document.getElementById('mainContent').classList.add('full'); 
  } else { 
    const needed = Math.min(Math.max(180, sidebar.scrollWidth || 220), 340); 
    document.documentElement.style.setProperty('--sidebar-w', needed+'px'); 
    sidebar.style.setProperty('--w', needed+'px'); 
    sidebar.classList.remove('collapsed'); 
    document.getElementById('mainContent').classList.remove('full'); 
  } 
  runReveal(); 
}

// Mobile sidebar functionality
const mobileSidebarClose = document.getElementById('mobileSidebarClose');
if (mobileSidebarClose) {
  mobileSidebarClose.addEventListener('click', () => {
    sidebar.classList.remove('mobile-active');
  });
}

// Show sidebar on mobile when hamburger is clicked (for filters)
if (leftHamburger) {
  leftHamburger.addEventListener('click', (e) => {
    if (isMobile()) {
      e.preventDefault();
      sidebar.classList.add('mobile-active');
    } else {
      setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
    }
  });
}

if (sidebarToggleBtn) {
  sidebarToggleBtn.addEventListener('click', (e) => {
    if (isMobile()) {
      e.preventDefault();
      sidebar.classList.add('mobile-active');
    } else {
      setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
    }
  });
}

// Start with sidebar OPEN
setSidebarCollapsed(false);

window.addEventListener('resize', ()=>{ 
  if(!sidebar.classList.contains('collapsed')){ 
    const needed = Math.min(Math.max(180, sidebar.scrollWidth || 220), 340); 
    document.documentElement.style.setProperty('--sidebar-w',needed+'px'); 
    sidebar.style.setProperty('--w',needed+'px'); 
  } 
  runReveal(); 
});

/********************
 * Full-screen "See more" panel
 ********************/
function openSectionView(key){
  // Renders into filteredView/filteredGrid for a clean page-like UX
  const prods = state.products;
  function sc(list,opts){ return list.slice().sort(function(a,b){ return computeScore(b,opts||{}) - computeScore(a,opts||{}); }); }
  let items;
  if(key.type==='hot') items=sc(prods.filter(function(p){ return p.sale&&p.salePrice&&p.salePrice<p.price; }),{boostSale:true,boostAfford:true});
  else if(key.type==='trending') items=sc(prods,{userCategories:getUserPreferenceCategories()});
  else if(key.type==='newDrops') items=prods.slice().sort(function(a,b){ var da=a.created_at?new Date(a.created_at).getTime():Number(a.id)||0; var db=b.created_at?new Date(b.created_at).getTime():Number(b.id)||0; return db-da; });
  else if(key.type==='student'){ const sg=getSchoolCategorySubs(); items=sc(prods.filter(function(p){ return sg.indexOf(p.category)!==-1; })); }
  else if(key.type==='underR100') items=sc(prods.filter(function(p){ const pr=p.sale&&p.salePrice?p.salePrice:p.price; return pr<100; }),{boostAfford:true});
  else if(key.type==='bestSellers') items=sc(prods);
  else if(key.type==='clothing'){ const cs=getCategoryGroupSubs('Clothing'); items=sc(prods.filter(function(p){ return cs.indexOf(p.category)!==-1; })); }
  else if(key.type==='food'){ const fs=getCategoryGroupSubs('Food'); items=sc(prods.filter(function(p){ return fs.indexOf(p.category)!==-1; })); }
  else if(key.type==='services'){ const ss=getCategoryGroupSubs('Services'); items=sc(prods.filter(function(p){ return ss.indexOf(p.category)!==-1; })); }
  else if(key.type==='accessories'){ const as2=getCategoryGroupSubs('Accessories & Gadgets'); items=sc(prods.filter(function(p){ return as2.indexOf(p.category)!==-1; })); }
  else if(key.type==='beauty'){ const bs2=getCategoryGroupSubs('Beauty & Self-Care'); items=sc(prods.filter(function(p){ return bs2.indexOf(p.category)!==-1; })); }
  else items=sc(prods);
  showFilteredView(items, key.title || 'Items');
}

// Shared key→section map: used by the "See more" click handler, the
// popstate handler, and initial deep-link resolution, so they can't drift.
const SECTION_KEY_MAP = {
  hot:        { type:'hot',        title:'Hot Deals' },
  trending:   { type:'trending',   title:'Trending on Campus' },
  newDrops:   { type:'newDrops',   title:'New Drops' },
  student:    { type:'student',    title:'Back to School' },
  underR100:  { type:'underR100',  title:'Under R100' },
  bestSellers:{ type:'bestSellers',title:'Best Sellers' },
  clothing:   { type:'clothing',   title:'Popular in Clothing' },
  food:       { type:'food',       title:'Popular in Food' },
  services:   { type:'services',   title:'Services' },
  accessories:{ type:'accessories',title:'Accessories & Gadgets' },
  beauty:     { type:'beauty',     title:'Beauty & Self-Care' }
};

// Wire up section "See more" buttons (new section-see-more class)
document.addEventListener('click', function(e){
  const btn = e.target.closest('.section-see-more');
  if(!btn) return;
  e.preventDefault();
  const sec = btn.dataset.section;
  const sectionKey = SECTION_KEY_MAP[sec] || { type:'all', title:'All Items' };
  // Track section view
  trackEvent('category_view', { category: sec, metadata: { section: sectionKey.title } });
  openSectionView(sectionKey);
  if (!isPopStateNav && sec) history.pushState({ section: sec }, '', '#section=' + sec);
});

// Minimal hash routing for section expansion — supports the browser Back
// button and deep links (#section=hot) without a full router.
let isPopStateNav = false;
window.addEventListener('popstate', function(){
  isPopStateNav = true;
  const m = /^#section=([\w]+)/.exec(location.hash);
  if (m && SECTION_KEY_MAP[m[1]]) {
    openSectionView(SECTION_KEY_MAP[m[1]]);
  } else {
    document.getElementById('backToHomeBtn')?.click();
  }
  isPopStateNav = false;
});

// Clear the section hash when leaving the expanded view (paired with the
// pushState above; index.html's own backToHomeBtn listener handles the
// actual view reset).
document.getElementById('backToHomeBtn')?.addEventListener('click', function(){
  if (!isPopStateNav && location.hash) history.pushState({}, '', location.pathname + location.search);
});

// Featured Shops rendering lives in index.html's inline script (richer:
// adds featured-ad boosting + per-seller product counts) — see the
// 'supabase-ready' listener there, which is now the sole populator of
// #shopsScroll/#featuredShopsSection.

/********************
 * Subscribe function
 ********************/
async function handleSubscribe(email){
  if(!email) return { success:false, error: 'no email' };
  if(!supabaseClient) {
    try{ localStorage.setItem('demo_subscribe_'+email, Date.now()); }catch(e){} 
    return { success: true, demo:true };
  }
  try {
    const { data, error } = await supabaseClient
      .from('subscribers')
      .insert([{ email, referral_code: null, referred_by: null }]);
    if(error) return { success:false, error };
    return { success:true, data };
  } catch(e){
    return { success:false, error:e };
  }
}

document.getElementById('subscribeBtn').addEventListener('click', async ()=>{ 
  const email=document.getElementById('newsEmail').value.trim(); 
  if(!email){ 
    alert('Enter your email'); 
    return;
  } 
  const res = await handleSubscribe(email); 
  if(res.success) { 
    alert('Thanks — subscription saved.'); 
    document.getElementById('newsEmail').value=''; 
  } else { 
    console.error(res.error); 
    alert('Could not save your email (check console).'); 
  } 
});

/********************
 * Load filter options from Supabase - UPDATED FOR CORRECT FILTERING
 ********************/
async function loadFilterOptions() {
  if (!supabaseClient) {
    console.warn('Supabase client not available for loading filter options');
    return;
  }

  try {
    // Get unique categories from products table
    const { data: categoriesData, error: categoriesError } = await supabaseClient
      .from('products')
      .select('category')
      .not('category', 'is', null);

    if (categoriesError) {
      console.error('Error loading categories:', categoriesError);
    }

    // Build hierarchical sidebar from CATEGORIES constant
    // also include any DB categories not in the static list (backward compat)
    const dbCats = categoriesData ? [...new Set(categoriesData.map(item => item.category).filter(Boolean))] : [];
    const allKnown = new Set(ALL_CAT_VALUES);
    const extraCats = dbCats.filter(c => !allKnown.has(c));
    filterOptions.categories = ALL_CAT_VALUES;

    if (catList) {
      catList.innerHTML = '<li data-cat="All" class="active" style="padding:10px 6px;font-weight:700;cursor:pointer;border-bottom:1px solid #f0f0f5">All Products</li>';

      // "All" item click
      catList.querySelector('li[data-cat="All"]').addEventListener('click', () => {
        Array.from(catList.querySelectorAll('li[data-cat]')).forEach(l => l.classList.remove('active'));
        catList.querySelector('li[data-cat="All"]').classList.add('active');
        state.filters.category = 'All';
        applyFilters();
      });

      // Helper: deactivate all data-cat items, mark active, and open parent group if needed
      function setActiveCat(catValue) {
        Array.from(catList.querySelectorAll('li[data-cat]')).forEach(l => l.classList.remove('active'));
        const target = catList.querySelector(`li[data-cat="${CSS.escape(catValue)}"]`);
        if (target) {
          target.classList.add('active');
          // Expand the accordion group that contains this item
          const parentGroup = target.closest('.sidebar-cat-group');
          if (parentGroup) parentGroup.classList.add('open');
        }
      }

      // Build accordion groups (desktop) — mobile uses mobileCatAccordion separately
      CATEGORIES.forEach(group => {
        const emoji = CATEGORY_EMOJIS[group.label] || '';
        const groupLi = document.createElement('li');
        groupLi.className = 'sidebar-cat-group';

        const header = document.createElement('div');
        header.className = 'sidebar-cat-group-header';
        header.innerHTML = `<span>${emoji} ${group.label}</span><span class="sidebar-arrow">▼</span>`;

        const subUl = document.createElement('ul');
        subUl.className = 'sidebar-cat-sub-list';

        // "All <Group>" item
        const parentLi = document.createElement('li');
        parentLi.dataset.cat = group.label;
        parentLi.className = 'sidebar-cat-parent';
        parentLi.textContent = `All ${group.label}`;
        parentLi.addEventListener('click', e => {
          e.stopPropagation();
          setActiveCat(group.label);
          state.filters.category = group.label;
          trackEvent('category_view', { category: group.label });
          updateUserPreferences(group.label);
          applyFilters();
        });
        subUl.appendChild(parentLi);

        // Sub-categories
        group.sub.forEach(sub => {
          const li = document.createElement('li');
          li.dataset.cat = sub;
          li.className = 'sidebar-cat-sub';
          li.textContent = sub;
          li.addEventListener('click', e => {
            e.stopPropagation();
            setActiveCat(sub);
            state.filters.category = sub;
            trackEvent('category_view', { category: group.label, subcategory: sub });
            updateUserPreferences(group.label);
            applyFilters();
          });
          subUl.appendChild(li);
        });

        // Toggle open/close on header click
        header.addEventListener('click', () => groupLi.classList.toggle('open'));

        groupLi.appendChild(header);
        groupLi.appendChild(subUl);
        catList.appendChild(groupLi);
      });

      // Any extra DB categories not in the static list
      if (extraCats.length) {
        const extraGroupLi = document.createElement('li');
        extraGroupLi.className = 'sidebar-cat-group';

        const extraHeader = document.createElement('div');
        extraHeader.className = 'sidebar-cat-group-header';
        extraHeader.innerHTML = `<span>Other</span><span class="sidebar-arrow">▼</span>`;

        const extraSubUl = document.createElement('ul');
        extraSubUl.className = 'sidebar-cat-sub-list';

        extraCats.forEach(cat => {
          const li = document.createElement('li');
          li.dataset.cat = cat;
          li.textContent = cat;
          li.addEventListener('click', e => {
            e.stopPropagation();
            setActiveCat(cat);
            state.filters.category = cat;
            applyFilters();
          });
          extraSubUl.appendChild(li);
        });

        extraHeader.addEventListener('click', () => extraGroupLi.classList.toggle('open'));
        extraGroupLi.appendChild(extraHeader);
        extraGroupLi.appendChild(extraSubUl);
        catList.appendChild(extraGroupLi);
      }
    }

    // Get price range from actual products
    const { data: priceData, error: priceError } = await supabaseClient
      .from('products')
      .select('price, sale_price')
      .order('price', { ascending: false })
      .limit(1);

    if (priceError) {
      console.error('Error loading price range:', priceError);
    } else if (priceData && priceData.length > 0) {
      const maxPrice = Math.ceil(priceData[0].price / 50) * 50; // Round up to nearest 50
      filterOptions.priceRange.max = maxPrice;
      filterOptions.priceRange.min = 0;
      
      // Populate price dropdowns
      populatePriceDropdowns(maxPrice);
    }

    // Get unique sizes from product_variants table
    const { data: variantsData, error: variantsError } = await supabaseClient
      .from('product_variants')
      .select('size')
      .not('size', 'is', null);

    if (variantsError) {
      console.error('Error loading variants:', variantsError);
    } else if (variantsData) {
      const uniqueSizes = [...new Set(variantsData.map(item => item.size).filter(Boolean))];
      uniqueSizes.sort();
      filterOptions.sizes = uniqueSizes;
      
      // Populate sizes filter
      if (sizesFilter) {
        sizesFilter.innerHTML = '';
        uniqueSizes.forEach(size => {
          const label = document.createElement('label');
          label.style.marginRight = '8px';
          label.style.display = 'inline-block';
          label.style.marginBottom = '8px';
          
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.name = 'size';
          input.value = size;
          input.style.marginRight = '4px';
          
          input.addEventListener('change', () => {
            state.filters.sizes = Array.from(sizesFilter.querySelectorAll('input[name="size"]:checked')).map(i => i.value);
            applyFilters();
          });
          
          label.appendChild(input);
          label.appendChild(document.createTextNode(size));
          sizesFilter.appendChild(label);
        });
      }
    }

    // Get unique types from metadata or products table
    const { data: productsData, error: productsError } = await supabaseClient
      .from('products')
      .select('type')
      .not('type', 'is', null);

    if (productsError) {
      console.error('Error loading types:', productsError);
    } else if (productsData) {
      const types = ['All', ...new Set(productsData.map(item => item.type).filter(Boolean))];
      filterOptions.types = types;
      
      // Populate type filter
      if (typeFilter) {
        typeFilter.innerHTML = '';
        types.forEach(type => {
          const label = document.createElement('label');
          label.style.marginRight = '8px';
          label.style.display = 'inline-block';
          label.style.marginBottom = '8px';
          
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = 'type';
          input.value = type;
          if (type === 'All') input.checked = true;
          
          input.addEventListener('change', () => {
            state.filters.type = type;
            applyFilters();
          });
          
          label.appendChild(input);
          label.appendChild(document.createTextNode(type));
          typeFilter.appendChild(label);
        });
      }
    }

    // Get unique colors from metadata or products table
    const { data: colorsData, error: colorsError } = await supabaseClient
      .from('products')
      .select('color')
      .not('color', 'is', null);

    if (colorsError) {
      console.error('Error loading colors:', colorsError);
    } else if (colorsData) {
      const colors = ['Any', ...new Set(colorsData.map(item => item.color).filter(Boolean))];
      filterOptions.colors = colors;
      
      // Populate color dropdown
      if (colorSel) {
        colorSel.innerHTML = '';
        colors.forEach(color => {
          const option = document.createElement('option');
          option.value = color;
          option.textContent = color;
          colorSel.appendChild(option);
        });
      }
    }

    // Get unique tags from tags column
    const { data: tagsData, error: tagsError } = await supabaseClient
      .from('products')
      .select('tags')
      .not('tags', 'is', null);

    if (tagsError) {
      console.error('Error loading tags:', tagsError);
    } else if (tagsData) {
      const tags = new Set(['Any']);
      tagsData.forEach(item => {
        if (item.tags && Array.isArray(item.tags)) {
          item.tags.forEach(tag => tags.add(tag));
        }
      });
      filterOptions.tags = Array.from(tags);
      
      // Populate tags dropdown
      if (tagSel) {
        tagSel.innerHTML = '';
        filterOptions.tags.forEach(tag => {
          const option = document.createElement('option');
          option.value = tag;
          option.textContent = tag;
          tagSel.appendChild(option);
        });
      }
    }

    console.log('Filter options loaded:', filterOptions);
    
    // Populate mobile filters and menu
    populateMobileFilters();
    populateMobileMenuCategories();
    
  } catch (error) {
    console.error('Error loading filter options:', error);
  }
}

/********************
 * Populate price dropdowns with options
 ********************/
function populatePriceDropdowns(maxPrice) {
  if (!priceMin || !priceMax) return;
  
  // Clear existing options (keep first placeholder)
  while (priceMin.options.length > 1) priceMin.remove(1);
  while (priceMax.options.length > 1) priceMax.remove(1);
  
  // Create price options (increments of 50)
  for (let price = 0; price <= maxPrice; price += 50) {
    const optionText = price === 0 ? 'R0' : `R${price}`;
    
    const minOption = document.createElement('option');
    minOption.value = price;
    minOption.textContent = optionText;
    priceMin.appendChild(minOption);
    
    const maxOption = document.createElement('option');
    maxOption.value = price;
    maxOption.textContent = optionText;
    priceMax.appendChild(maxOption);
  }
  
  // Also add "max" option at the end
  const maxOption = document.createElement('option');
  maxOption.value = maxPrice;
  maxOption.textContent = `R${maxPrice}`;
  priceMax.appendChild(maxOption);
}

/********************
 * Show notification function
 ********************/
function showNotification(message) {
  // Create notification element
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 100px;
    right: 20px;
    background-color: var(--accent);
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    z-index: 9999;
    box-shadow: var(--shadow);
    animation: slideIn 0.3s ease;
    font-size: 14px;
    font-weight: 600;
  `;
  
  notification.textContent = message;
  document.body.appendChild(notification);
  
  // Remove after 3 seconds
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => {
      if (notification.parentNode) {
        document.body.removeChild(notification);
      }
    }, 300);
  }, 3000);
}

/********************
 * Initialize mobile functionality
 ********************/
function initializeMobileFunctionality() {
  // Initialize mobile search
  initMobileSearch();

  // Initialize mobile menu
  initMobileMenu();

  // Initialize mobile filters
  initMobileFilters();

  // Initialize the app-style bottom nav
  initMobileBottomNav();
}

// Mobile bottom nav (Home / Search / Cart / Profile) — reuses existing
// header handlers rather than duplicating their logic. Active-state is set
// from the actual view-state functions (setMobileBottomNavActive, called by
// showFilteredView/hideFilteredView) so it's correct regardless of how the
// view was entered — section click, live search, or a #section= deep link.
function setMobileBottomNavActive(name) {
  const nav = document.getElementById('mobileBottomNav');
  if (!nav) return;
  nav.querySelectorAll('.mbn-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mbn === name);
  });
}

function initMobileBottomNav() {
  const nav = document.getElementById('mobileBottomNav');
  if (!nav) return;

  document.getElementById('mbnHome')?.addEventListener('click', () => {
    document.getElementById('clearFilters')?.click();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  document.getElementById('mbnSearch')?.addEventListener('click', () => {
    document.getElementById('mobileSearchIcon')?.click();
  });

  document.getElementById('mbnCart')?.addEventListener('click', () => {
    document.getElementById('cartBtn')?.click();
  });

  document.getElementById('mbnProfile')?.addEventListener('click', () => {
    const profileBtn = document.getElementById('profileBtnHeader');
    const signBtnEl = document.getElementById('signBtn');
    if (profileBtn && profileBtn.style.display !== 'none') profileBtn.click();
    else signBtnEl?.click();
  });
}

/********************
 * Initialize
 ********************/
document.addEventListener('DOMContentLoaded', function() {
  // Check URL for referral code
  checkUrlForReferral();
  
  // Setup lazy loading
  setupLazyLoading();
  
  // Initialize mobile functionality
  initializeMobileFunctionality();
  
  // Initialize sign button
  const signBtn = document.getElementById('signBtn');
  if (signBtn) {
    signBtn.addEventListener('click', function(e) {
      e.preventDefault();
      showModal(loginModal);
    });
  }
  
  // Initialize cart button to redirect to checkout
  if (cartBtn) {
    cartBtn.addEventListener('click', function(e) {
      e.preventDefault();
      redirectToCheckout();
    });
  }
  
  // Quick add modal close (button, click-outside)
  if (quickAddClose) {
    quickAddClose.addEventListener('click', closeQuickAddModal);
  }
  if (quickAddModal) {
    quickAddModal.addEventListener('click', (e) => {
      if (e.target === quickAddModal) closeQuickAddModal();
    });
  }
  
  // Quick add size change
  if (quickAddSize) {
    quickAddSize.addEventListener('change', updateQuickAddStockInfo);
  }
  
  // Quick add quantity change
  if (quickAddQty) {
    quickAddQty.addEventListener('change', updateQuickAddStockInfo);
  }
  
  // Quick add submit
  if (quickAddSubmit) {
    quickAddSubmit.addEventListener('click', function() {
      if (!currentQuickAddProduct) return;
      
      const selectedSize = quickAddSize.value;
      const quantity = parseInt(quickAddQty.value);
      const stock = getVariantStock(currentQuickAddProduct, selectedSize);
      
      if (quantity > stock) {
        quickAddStockError.style.display = 'block';
        return;
      }
      
      addToCart(currentQuickAddProduct.id, quantity, selectedSize);
      closeQuickAddModal();
    });
  }
  
  // Password validation on input
  if (modalSignupPassword) {
    modalSignupPassword.addEventListener('input', function() {
      // Simple validation - just check if it meets requirements
      const isValid = checkPasswordRules(this.value);
      const errorElement = document.getElementById('modalSignupPasswordError');
      if (errorElement) {
        if (!isValid && this.value.length > 0) {
          errorElement.textContent = 'Password must be at least 8 characters with 1 number and 1 special character.';
          errorElement.style.display = 'block';
        } else {
          errorElement.style.display = 'none';
        }
      }
    });
  }
  
  // Initialize cart
  initializeCart();
  
  // Load filter options
  loadFilterOptions();
  
  // Run reveal animations
  runReveal();
  
  // Save cart on unload
  window.addEventListener('beforeunload', () => {
    localStorage.setItem('ss_cart', JSON.stringify(state.cart));
  });
  
  // Check if we have a pending referral code (respects 7-day expiry)
  try {
    const pendingReferral = readPendingReferral();
    if (pendingReferral) {
      if (modalSignupReferralCode) {
        modalSignupReferralCode.value = pendingReferral;
      }
    }
  } catch (e) {}
});

function runReveal(){ 
  document.querySelectorAll('.fade-up').forEach(el=>{ 
    const rect = el.getBoundingClientRect(); 
    if(rect.top < window.innerHeight - 60) el.classList.add('show'); 
  }); 
}

window.addEventListener('scroll', runReveal); 
window.addEventListener('resize', runReveal);

// Add CSS for animations
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(100%);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);

// Force a fresh load when the user navigates back to this page via the
// browser back button (bfcache restore). This ensures category/filter state
// and product data are always current.
window.addEventListener('pageshow', function(e) {
  if (e.persisted) {
    window.location.reload();
  }
});