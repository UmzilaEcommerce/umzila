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
async function addToCart(id, qty = 1, size = 'M', preferred_delivery = '') {
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
      service_turnaround: p.service_turnaround || null
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
    <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='${fg}' font-family='Arial, Helvetica, sans-serif' font-weight='700' font-size='${Math.round(Math.min(w,h)/10)}'>${text}</text>
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
  if (typeof loadFeaturedShops === 'function') {
    loadFeaturedShops();
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
const sectionPanel = document.getElementById('sectionPanel');
const panelTitle = document.getElementById('panelTitle');
const panelContent = document.getElementById('panelContent');
const panelClose = document.getElementById('panelClose');
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
        service_turnaround: row.service_turnaround || null
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
    d.innerHTML = `${img ? `<img class="suggestions-prod-img" src="${img}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="suggestions-prod-name">${title}</span>
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

if(searchInput){
  searchInput.addEventListener('input',(e)=>{
    const q=e.target.value;
    if(q && q.length>0) searchClear.style.display='block'; else searchClear.style.display='none';
    updateSuggestions(q);
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
 * Filtering / Sorting (updated for new price filters)
 ********************/
function applyFilters(){
  const f = state.filters;
  let out = state.products.filter(p=>{
    // Never show hidden or out-of-stock products
    if (!p.visible) return false;
    if ((p.stock || 0) <= 0) return false;
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
    if(f.search && !((p.title+(p.desc||'')+(p.category||'')).toLowerCase().includes(f.search.toLowerCase()))) return false;
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
  
  // Observe all product images
  document.addEventListener('DOMContentLoaded', () => {
    const lazyImages = document.querySelectorAll('img[data-src]');
    lazyImages.forEach(img => {
      lazyLoadObserver.observe(img);
    });
  });
  
  // Also observe dynamically added images
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
    return `<video src="${url}" autoplay muted loop playsinline style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0" aria-label="${title}"></video>`;
  }
  return `<img src="${svgPlaceholder(title,400,300,'#f0f0f0','#999')}" data-src="${url}" loading="lazy" alt="${title}" onerror="this.src='${svgPlaceholder(title,400,300)}'; this.removeAttribute('data-src')">`;
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
 * Weighted product scoring
 ********************/
function computeScore(p, opts) {
  opts = opts || {};
  var fc = Number(p.favourite_count) || 0;
  var pop = Number(p.popularity) || 50;
  var clicks = Number(p.click_count) || 0;
  var hasSale = !!(p.sale && p.salePrice && p.salePrice < p.price);
  var discountPct = hasSale ? Math.round(100 * (1 - p.salePrice / p.price)) : 0;
  var score = (fc * 3) + (pop * 1) + (clicks * 1) + (hasSale ? 10 : 0);
  if (opts.boostSale)   score += discountPct * 3;
  if (opts.boostAfford) score += (p.price < 200 ? 10 : 0);
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
    btn.querySelector('.fav-icon').textContent = active ? '❤️' : '🤍';
  });
}

async function toggleFavourite(btn) {
  if (!btn || btn.dataset.pending === 'true') return;
  btn.dataset.pending = 'true';

  const productId = btn.dataset.productId;
  const isFaved = btn.classList.contains('active');

  // Optimistic UI update
  btn.classList.toggle('active', !isFaved);
  btn.querySelector('.fav-icon').textContent = isFaved ? '🤍' : '❤️';
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
      btn.querySelector('.fav-icon').textContent = data.action === 'added' ? '❤️' : '🤍';
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
      btn.querySelector('.fav-icon').textContent = isFaved ? '❤️' : '🤍';
      btn.dataset.favCount = isFaved ? count + 1 : Math.max(0, count - 1);
    }
  } catch (_) {
    // Revert on network error
    btn.classList.toggle('active', isFaved);
    btn.querySelector('.fav-icon').textContent = isFaved ? '❤️' : '🤍';
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
  const stockText = isServiceCard ? '' : (totalStock > 0 ? `• ${totalStock} left` : '• Out of stock');
  return `<div class="product-card fade-up" data-id="${p.id}">
    <div class="product-media" role="button" aria-label="Open ${p.title}">
      <div class="badges">
        ${isServiceCard ? '<span class="badge" style="background:#7c3aed">🔧 Service</span>' : (p.badge?`<span class="badge ${p.badge === 'Sale' ? 'sale' : ''}">${p.badge}</span>`:'')}
        ${isOnSale && !p.badge && !isServiceCard ? '<span class="badge sale">Sale</span>' : ''}
      </div>
      ${mediaTagForCard(primaryImage, p.title)}
      ${secondaryImage && !isVideoUrl(primaryImage) ? `<img class="secondary" src="${svgPlaceholder(p.title,400,300,'#f0f0f0','#999')}" data-src="${secondaryImage}" loading="lazy" alt="${p.title} back" onerror="this.src='${svgPlaceholder(p.title,400,300)}'; this.removeAttribute('data-src')">` : ''}
      <button class="fav-btn" data-product-id="${p.id}" data-fav-count="${favCount}" aria-label="Add to favourites" onclick="event.stopPropagation();toggleFavourite(this)"><span class="fav-icon">🤍</span></button>
      <div class="quick-add" data-id="${p.id}">+ Quick add</div>
    </div>
    <div class="card-body">
      <div class="title">${p.title}</div>
      <div class="meta">
        <div style="font-size:13px">${p.color || ''} ${stockText}</div>
        <div class="price">
          ${isOnSale && originalPrice ?
            `<span class="original">${format(originalPrice)}</span>` : ''}
          ${format(displayPrice)}
        </div>
      </div>
      <div class="controls">
        ${isServiceCard ? '' : `<select class="size-select">${(p.size||['M']).map(s=>`<option>${s}</option>`).join('')}</select>`}
        <select class="qty"><option value="1">1</option><option value="2">2</option><option value="3">3</option></select>
        <button class="add-btn" data-id="${p.id}">Add</button>
      </div>
    </div>
  </div>`;
}

function renderAll(products){
  // Only render products that are visible and in stock
  const visible = (products || state.products).filter(p =>
    p.visible !== false && (p.listing_type === 'service' || (p.stock || 0) > 0)
  );
  if(resultCount) resultCount.textContent = visible.length;

  const userCats = getUserPreferenceCategories();

  // helpers
  function cards(list, minW){ return list.map(p=>`<div style="min-width:${minW||180}px;max-width:${minW||180}px">${makeCardHTML(p)}</div>`).join(''); }
  function showSection(id, has){ const el=document.getElementById(id); if(el) el.style.display = has ? '' : 'none'; }
  function scored(list, opts){ return list.slice().sort(function(a,b){ return computeScore(b, opts||{}) - computeScore(a, opts||{}); }); }

  // HOT DEALS — only sale items, scored by discount size + affordability
  const hotItems = scored(
    visible.filter(function(p){ return p.sale && p.salePrice && p.salePrice < p.price; }),
    { boostSale: true, boostAfford: true }
  ).slice(0,12);
  if(hotGrid) hotGrid.innerHTML = cards(hotItems, 170) || '<div style="padding:12px;color:var(--muted)">No hot deals right now</div>';
  showSection('hotSection', hotItems.length);

  // TRENDING ON CAMPUS — scored with personalization
  const trendingItems = scored(visible, { userCategories: userCats }).slice(0,12);
  if(trendingScroll) trendingScroll.innerHTML = cards(trendingItems, 170);
  showSection('trendingSection', trendingItems.length);

  // NEW DROPS — newest first (by created_at if available, fallback id)
  const newDropItems = visible.slice().sort(function(a,b){
    const da = a.created_at ? new Date(a.created_at).getTime() : Number(a.id) || 0;
    const db = b.created_at ? new Date(b.created_at).getTime() : Number(b.id) || 0;
    return db - da;
  }).slice(0,12);
  const ndScroll = document.getElementById('newDropsScroll');
  if(ndScroll) ndScroll.innerHTML = cards(newDropItems, 170);
  showSection('newDropsSection', newDropItems.length);

  // BACK TO SCHOOL — campus-relevant categories, base score
  const schoolCats = ['Clothing','Accessories & Gadgets','Home & Gifts','Services'];
  const schoolGroup = CATEGORIES.reduce(function(acc,g){
    if(schoolCats.indexOf(g.label) !== -1) return acc.concat([g.label]).concat(g.sub);
    return acc;
  }, []);
  const studentItems = scored(
    visible.filter(function(p){ return schoolGroup.indexOf(p.category) !== -1; })
  ).slice(0,12);
  const stScroll = document.getElementById('studentScroll');
  if(stScroll) stScroll.innerHTML = cards(studentItems, 170) || '<div style="padding:12px;color:var(--muted)">Loading…</div>';
  showSection('studentSection', studentItems.length);

  // UNDER R100 — price filtered + affordability boost
  const underR100Items = scored(
    visible.filter(function(p){ const pr=p.sale&&p.salePrice?p.salePrice:p.price; return pr<100; }),
    { boostAfford: true }
  ).slice(0,12);
  const ur100 = document.getElementById('underR100Scroll');
  if(ur100) ur100.innerHTML = cards(underR100Items, 170) || '<div style="padding:12px;color:var(--muted)">No products under R100</div>';
  showSection('underR100Section', underR100Items.length);

  // BEST SELLERS — composite score
  const bestItems = scored(visible).slice(0,12);
  const bsScroll = document.getElementById('bestSellersScroll');
  if(bsScroll) bsScroll.innerHTML = cards(bestItems, 170);
  showSection('bestSellersSection', bestItems.length);

  // POPULAR IN CLOTHING
  const clothingGroup = CATEGORIES.find(function(g){ return g.label==='Clothing'; });
  const clothingSubs = clothingGroup ? [clothingGroup.label].concat(clothingGroup.sub) : ['Clothing'];
  const clothingItems = scored(
    visible.filter(function(p){ return clothingSubs.indexOf(p.category) !== -1; })
  ).slice(0,10);
  const pcScroll = document.getElementById('popularClothingScroll');
  if(pcScroll) pcScroll.innerHTML = cards(clothingItems, 170) || '<div style="padding:12px;color:var(--muted)">No clothing products yet</div>';
  showSection('popularClothingSection', clothingItems.length);

  // POPULAR IN FOOD
  const foodGroup = CATEGORIES.find(function(g){ return g.label==='Food'; });
  const foodSubs = foodGroup ? [foodGroup.label].concat(foodGroup.sub) : ['Food'];
  const foodItems = scored(
    visible.filter(function(p){ return foodSubs.indexOf(p.category) !== -1; })
  ).slice(0,10);
  const pfScroll = document.getElementById('popularFoodScroll');
  if(pfScroll) pfScroll.innerHTML = cards(foodItems, 170) || '<div style="padding:12px;color:var(--muted)">No food products yet</div>';
  showSection('popularFoodSection', foodItems.length);

  // SERVICES
  const servicesGroup = CATEGORIES.find(function(g){ return g.label==='Services'; });
  const servicesSubs = servicesGroup ? [servicesGroup.label].concat(servicesGroup.sub) : ['Services'];
  const servicesItems = scored(
    visible.filter(function(p){ return servicesSubs.indexOf(p.category) !== -1; })
  ).slice(0,10);
  const svcScroll = document.getElementById('servicesScroll');
  if(svcScroll) svcScroll.innerHTML = cards(servicesItems, 170) || '<div style="padding:12px;color:var(--muted)">No services yet</div>';
  showSection('servicesSection', servicesItems.length);

  // ACCESSORIES & GADGETS
  const accGroup = CATEGORIES.find(function(g){ return g.label==='Accessories & Gadgets'; });
  const accSubs = accGroup ? [accGroup.label].concat(accGroup.sub) : ['Accessories & Gadgets'];
  const accItems = scored(
    visible.filter(function(p){ return accSubs.indexOf(p.category) !== -1; })
  ).slice(0,10);
  const accScroll = document.getElementById('accessoriesScroll');
  if(accScroll) accScroll.innerHTML = cards(accItems, 170) || '<div style="padding:12px;color:var(--muted)">No accessories yet</div>';
  showSection('accessoriesSection', accItems.length);

  // BEAUTY & SELF-CARE
  const beautyGroup = CATEGORIES.find(function(g){ return g.label==='Beauty & Self-Care'; });
  const beautySubs = beautyGroup ? [beautyGroup.label].concat(beautyGroup.sub) : ['Beauty & Self-Care'];
  const beautyItems = scored(
    visible.filter(function(p){ return beautySubs.indexOf(p.category) !== -1; })
  ).slice(0,10);
  const beautyScroll = document.getElementById('beautyScroll');
  if(beautyScroll) beautyScroll.innerHTML = cards(beautyItems, 170) || '<div style="padding:12px;color:var(--muted)">No beauty products yet</div>';
  showSection('beautySection', beautyItems.length);

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
    
    card.querySelectorAll('.add-btn').forEach(btn=>btn.addEventListener('click',(ev)=>{
      ev.stopPropagation();
      const id=btn.dataset.id ? Number(btn.dataset.id) : Number(btn.getAttribute('data-id'));
      const qty = Number(btn.previousElementSibling.value||1);

      const product = state.products.find(x=>x.id===id);
      if (!product) return;

      const isService = product.listing_type === 'service';
      const size = isService ? 'One Size' : (btn.parentElement.querySelector('.size-select')?.value || 'One Size');

      // Check stock (skip for services — unlimited)
      if (!isService) {
        const variantStock = getVariantStock(product, size);
        if (variantStock < qty) {
          alert(`Only ${variantStock} items available for size ${size}`);
          return;
        }
      }

      addToCart(product.id, qty, size);
    }));
    
    const q = card.querySelector('.quick-add');
    if (q) q.addEventListener('click',(ev)=>{
      ev.stopPropagation();
      const id = Number(q.dataset.id);
      const product = state.products.find(x=>x.id===id);
      if (!product) return;
      if (product.listing_type === 'service') {
        addToCart(product.id, 1, 'One Size');
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
  
  // Show modal
  quickAddModal.classList.add('open');
  quickAddStockError.style.display = 'none';
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
    const shortDescription = words.slice(0, 10).join(' ') + (words.length > 10 ? '...' : '');
    const fullDescription = currentModalProduct.desc || '';
    const hasLongDescription = words.length > 10;
    
    // Generate size options
    const sizes = currentModalProduct.size || ['M'];
    const sizeOptions = sizes.map(size => 
      `<div class="size-option" data-size="${size}">${size}</div>`
    ).join('');
    
    // Generate color options (if available)
    let colorOptionsHTML = '';
    if (currentModalProduct.color) {
      colorOptionsHTML = `
        <div class="product-modal-colors">
          <h3>Color</h3>
          <div class="color-options">
            <div class="color-option selected" data-color="${currentModalProduct.color}" style="background-color: ${currentModalProduct.color.toLowerCase() === 'black' ? '#000' : currentModalProduct.color.toLowerCase() === 'white' ? '#fff' : currentModalProduct.color.toLowerCase() === 'blue' ? '#3a86ff' : '#ddd'}"></div>
          </div>
        </div>
      `;
    }
    
    // Generate thumbnails
    const images = currentModalProduct.all_images || currentModalProduct.imgs || [];
    const thumbnails = images.map((img, index) => 
      `<div class="product-thumbnail ${index === 0 ? 'active' : ''}" data-image="${img}">
        <img src="${img}" alt="${currentModalProduct.title} thumbnail ${index + 1}" loading="lazy">
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
          <img src="${bImg}" alt="${bp.title}" loading="lazy" style="width:50px;height:50px;object-fit:cover;border-radius:8px;flex-shrink:0" onerror="this.style.display='none'">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${bp.title}</div>
            <div style="font-size:12px;color:#6b7280">${sameSeller ? 'Same store' : (bp.seller && bp.seller.shop_name ? bp.seller.shop_name : '')} · R${Number(bPrice).toFixed(0)}</div>
          </div>
          <button class="bundle-button" data-bundle-id="${bp.id}" data-bundle-title="${bp.title.replace(/"/g,'&quot;')}" style="font-size:12px;padding:5px 12px;background:#0a2f66;color:#fff;border:none;border-radius:999px;cursor:pointer;flex-shrink:0">+ Add</button>
        </div>`;
      }).join('');
      bundleSuggestionHTML = `
        <div class="bundle-suggestion" style="background:#f8faff;border-radius:10px;padding:12px 14px;margin:12px 0">
          <div style="font-size:12px;font-weight:700;color:#0a2f66;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">🤝 Frequently Bought Together</div>
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
            ? `<video src="${images[0]}" autoplay muted loop playsinline id="main-product-image" style="width:100%;height:100%;object-fit:contain;border-radius:8px"></video>`
            : `<img src="${images[0] || svgPlaceholder(currentModalProduct.title,400,300)}" alt="${currentModalProduct.title}" id="main-product-image" loading="lazy">`
          }
        </div>
        <div class="product-modal-thumbnails">
          ${thumbnails}
        </div>
      </div>
      <div class="product-modal-details">
        <h1 class="product-modal-title">${currentModalProduct.title}</h1>
        ${currentModalProduct.seller ? `
        <div class="product-modal-seller" style="display:flex;flex-direction:column;gap:6px;margin:6px 0 10px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:13px;color:#6b7280">Sold by</span>
            <a href="shop.html?shop=${encodeURIComponent(currentModalProduct.seller.shop_name)}" style="font-size:13px;font-weight:700;color:#0a2f66;text-decoration:none" target="_blank">${currentModalProduct.seller.shop_name} ↗</a>
          </div>
          ${currentModalProduct.seller.turnaround_time ? `
          <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;background:#f0f4ff;border-radius:8px;padding:6px 10px;flex-wrap:wrap">
            📦 <span>Usually ready for drop-off within: <strong>${currentModalProduct.seller.turnaround_time}</strong></span>
          </div>` : ''}
        </div>` : ''}
        ${currentModalProduct.listing_type === 'service' ? (() => {
          const ft = currentModalProduct.fulfillment_type;
          const ta = currentModalProduct.service_turnaround || 'TBD';
          let ftIcon = '', ftLabel = '';
          if (ft === 'item_dropoff') { ftIcon = '📦'; ftLabel = 'Drop off your item at the <strong>Umzila collection point, UKZN Westville campus</strong>'; }
          else if (ft === 'in_person') { ftIcon = '📍'; ftLabel = 'Meet in-person on campus'; }
          else if (ft === 'digital') { ftIcon = '💻'; ftLabel = 'Digital delivery'; }
          else { ftIcon = '🔧'; ftLabel = 'Service'; }
          return `<div style="background:#f5f3ff;border:1px solid #c4b5fd;border-radius:10px;padding:10px 14px;margin:8px 0;font-size:13px;color:#4c1d95">
            <div style="font-weight:700;margin-bottom:4px">🔧 Service listing</div>
            <div>${ftIcon} ${ftLabel}</div>
            <div style="margin-top:4px;color:#6b7280">⏱ Turnaround: <strong>${ta}</strong></div>
          </div>`;
        })() : ''}
        <div class="product-modal-rating">
          <div class="stars" style="color: #ffd700; font-size: 16px;">
            ${'★'.repeat(5)}
          </div>
          <span>5.0 (1 review)</span>
        </div>
        <div class="product-modal-price">
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
            <option value="Pickup from campus">Pickup from campus</option>
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
        
        <button class="product-modal-add-to-cart" id="modal-add-to-cart" data-id="${currentModalProduct.id}">Add to Cart</button>
        <button id="modal-share-btn" style="width:100%;padding:10px;border:1px solid #d9d9df;border-radius:999px;background:#fff;color:#0a2f66;font-size:14px;font-weight:600;cursor:pointer;margin-top:8px;transition:background 0.15s">🔗 Copy Link</button>

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
    
  } catch (error) {
    console.error('Error opening product modal:', error);
  }
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
  document.getElementById('modal-add-to-cart').addEventListener('click', function() {
    const productId = this.dataset.id;
    const quantity = parseInt(document.getElementById('quantity-value').textContent);
    const isService = currentModalProduct.listing_type === 'service';
    const selectedSize = isService
      ? 'One Size'
      : (document.querySelector('.size-option.selected')?.dataset.size || currentModalProduct.size?.[0]);
    const preferredDelivery = (document.getElementById('modal-delivery-pref')?.value || '');

    // Check stock (skip for services — unlimited)
    if (!isService) {
      const variantStock = getVariantStock(currentModalProduct, selectedSize);
      if (variantStock < quantity) {
        alert(`Only ${variantStock} items available for size ${selectedSize}`);
        return;
      }
    }

    // Persist preferred delivery to localStorage so checkout-success can update order notes
    if (preferredDelivery) localStorage.setItem('ss_preferred_delivery', preferredDelivery);

    addToCart(productId, quantity, selectedSize, preferredDelivery);
    showNotification(`Added ${quantity} "${currentModalProduct.title}" to cart!`);
    modal.classList.remove('active');
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
        shareBtn.textContent = '✓ Copied!';
        setTimeout(function(){ shareBtn.textContent = '🔗 Copy Link'; }, 2000);
      }).catch(function() { prompt('Copy this link:', url); });
    });
  }
}

// Close product modal
modalClose.addEventListener('click', () => {
  modal.classList.remove('active');
});

modal.addEventListener('click', (e) => {
  if (e.target === modal) {
    modal.classList.remove('active');
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
  // If we have products in state, use showFilteredView for a cleaner page-like UX
  let items=[];
  if(key.isShops) {
    // Shops — handled separately, fall through to panel
  } else {
    const prods = state.products;
    const clothingGroup = CATEGORIES.find(g=>g.label==='Clothing');
    const clothingSubs = clothingGroup ? [clothingGroup.label,...clothingGroup.sub] : [];
    const foodGroup = CATEGORIES.find(g=>g.label==='Food');
    const foodSubs = foodGroup ? [foodGroup.label,...foodGroup.sub] : [];
    function sc(list,opts){ return list.slice().sort(function(a,b){ return computeScore(b,opts||{}) - computeScore(a,opts||{}); }); }
    if(key.type==='hot') items=sc(prods.filter(function(p){ return p.sale&&p.salePrice&&p.salePrice<p.price; }),{boostSale:true,boostAfford:true});
    else if(key.type==='trending') items=sc(prods,{userCategories:getUserPreferenceCategories()});
    else if(key.type==='newDrops') items=prods.slice().sort(function(a,b){ var da=a.created_at?new Date(a.created_at).getTime():Number(a.id)||0; var db=b.created_at?new Date(b.created_at).getTime():Number(b.id)||0; return db-da; });
    else if(key.type==='student'){ const sg=CATEGORIES.reduce(function(a,g){ if(['Clothing','Accessories & Gadgets','Home & Gifts','Services'].indexOf(g.label)!==-1) return a.concat([g.label]).concat(g.sub); return a; },[]); items=sc(prods.filter(function(p){ return sg.indexOf(p.category)!==-1; })); }
    else if(key.type==='underR100') items=sc(prods.filter(function(p){ const pr=p.sale&&p.salePrice?p.salePrice:p.price; return pr<100; }),{boostAfford:true});
    else if(key.type==='bestSellers') items=sc(prods);
    else if(key.type==='clothing') items=sc(prods.filter(function(p){ return clothingSubs.indexOf(p.category)!==-1; }));
    else if(key.type==='food') items=sc(prods.filter(function(p){ return foodSubs.indexOf(p.category)!==-1; }));
    else if(key.type==='services'){ const sg=CATEGORIES.find(function(g){ return g.label==='Services'; }); const ss=sg?[sg.label].concat(sg.sub):['Services']; items=sc(prods.filter(function(p){ return ss.indexOf(p.category)!==-1; })); }
    else if(key.type==='accessories'){ const ag=CATEGORIES.find(function(g){ return g.label==='Accessories & Gadgets'; }); const as2=ag?[ag.label].concat(ag.sub):['Accessories & Gadgets']; items=sc(prods.filter(function(p){ return as2.indexOf(p.category)!==-1; })); }
    else if(key.type==='beauty'){ const bg=CATEGORIES.find(function(g){ return g.label==='Beauty & Self-Care'; }); const bs2=bg?[bg.label].concat(bg.sub):['Beauty & Self-Care']; items=sc(prods.filter(function(p){ return bs2.indexOf(p.category)!==-1; })); }
    else items=sc(prods);
    // Use filteredView instead of panel for products
    showFilteredView(items, key.title || 'Items');
    return;
  }

  // Shops panel fallback
  if(panelContent) panelContent.innerHTML='';
  if(panelTitle) panelTitle.textContent = key.title||'Items';
  items=state.products.slice();

  const BATCH = 24;
  let rendered = 0;
  panelContent.className='panel-grid';

  function renderBatch() {
    const batch = items.slice(rendered, rendered + BATCH);
    if(!batch.length) return;
    const frag = document.createDocumentFragment();
    batch.forEach(p => {
      const tmp = document.createElement('div');
      tmp.innerHTML = makeCardHTML(p);
      while(tmp.firstChild) frag.appendChild(tmp.firstChild);
    });
    panelContent.appendChild(frag);
    rendered += batch.length;
    attachProductListeners();
    if(rendered < items.length) observeSentinel();
  }

  let sentinelObserver = null;
  function observeSentinel() {
    const old = panelContent.querySelector('.section-sentinel');
    if(old) old.remove();
    if(sentinelObserver) sentinelObserver.disconnect();
    const sentinel = document.createElement('div');
    sentinel.className = 'section-sentinel';
    sentinel.style.cssText = 'height:1px;width:100%;grid-column:1/-1';
    panelContent.appendChild(sentinel);
    sentinelObserver = new IntersectionObserver(entries => {
      if(entries[0].isIntersecting){ sentinelObserver.disconnect(); renderBatch(); }
    }, { rootMargin: '200px' });
    sentinelObserver.observe(sentinel);
  }

  renderBatch();
  sectionPanel.classList.add('open');
  sectionPanel.setAttribute('aria-hidden','false');
}

// Wire up section "See more" buttons (new section-see-more class)
document.addEventListener('click', function(e){
  const btn = e.target.closest('.section-see-more');
  if(!btn) return;
  e.preventDefault();
  const sec = btn.dataset.section;
  const map = {
    hot:        { type:'hot',        title:'🔥 Hot Deals' },
    trending:   { type:'trending',   title:'📈 Trending on Campus' },
    newDrops:   { type:'newDrops',   title:'✨ New Drops' },
    student:    { type:'student',    title:'🎒 Back to School' },
    underR100:  { type:'underR100',  title:'💸 Under R100' },
    bestSellers:{ type:'bestSellers',title:'⭐ Best Sellers' },
    clothing:   { type:'clothing',   title:'👕 Popular in Clothing' },
    food:       { type:'food',       title:'🍕 Popular in Food' },
    services:   { type:'services',   title:'🛠️ Services' },
    accessories:{ type:'accessories',title:'⌚ Accessories & Gadgets' },
    beauty:     { type:'beauty',     title:'💄 Beauty & Self-Care' }
  };
  const sectionKey = map[sec] || { type:'all', title:'All Items' };
  // Track section view
  trackEvent('category_view', { category: sec, metadata: { section: sectionKey.title } });
  openSectionView(sectionKey);
});

// Legacy .see-more links (in case any remain)
document.querySelectorAll('.see-more').forEach(a=>a.addEventListener('click',e=>{
  e.preventDefault();
  const sec=a.dataset.section;
  const map = {
    hot:{type:'hot',title:'🔥 Hot Deals'},
    trending:{type:'trending',title:'📈 Trending on Campus'}
  };
  openSectionView(map[sec]||{type:'all',title:'All items'});
}));

panelClose.addEventListener('click', ()=>{ 
  sectionPanel.classList.remove('open'); 
  sectionPanel.setAttribute('aria-hidden','true'); 
  panelContent.innerHTML=''; 
});

/********************
 * Featured Shops
 ********************/
async function loadFeaturedShops() {
  if(!supabaseClient) return;
  const shopsScroll = document.getElementById('shopsScroll');
  const shopsSection = document.getElementById('featuredShopsSection');
  const seeAllBtn = document.getElementById('seeAllShopsBtn');
  if(!shopsScroll || !shopsSection) return;

  try {
    const { data: sellers, error } = await supabaseClient
      .from('sellers')
      .select('id, shop_name, description, logo_url')
      .not('user_id', 'is', null)
      .limit(20);
    if(error || !sellers || !sellers.length) return;

    shopsScroll.innerHTML = sellers.map(s => {
      const initials = (s.shop_name||'S').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
      const logoHtml = s.logo_url
        ? `<img src="${s.logo_url}" alt="${s.shop_name}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
        : `<div style="width:100%;height:100%;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:18px">${initials}</div>`;
      return `<a href="shop.html?shop=${encodeURIComponent(s.shop_name)}" class="shop-card" style="display:flex;flex-direction:column;align-items:center;gap:8px;text-decoration:none;flex-shrink:0;width:110px">
        <div style="width:64px;height:64px;border-radius:50%;overflow:hidden;border:2px solid #eaecf0;flex-shrink:0">${logoHtml}</div>
        <div style="font-size:12px;font-weight:700;color:var(--accent);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100px">${s.shop_name}</div>
        ${s.description ? `<div style="font-size:11px;color:var(--muted);text-align:center;line-height:1.3;max-width:100px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${s.description}</div>` : ''}
      </a>`;
    }).join('');

    shopsSection.style.display = 'block';
    shopsSection.dataset.hasData = 'true';

    // "All Shops" button is handled by index.html inline script (uses allShopsModal)
    // Store sellers for the modal to use
    if(seeAllBtn) {
      window._allSellers = sellers;
    }
  } catch(e) {
    console.warn('loadFeaturedShops error', e);
  }
}

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
  
  // Quick add modal close
  if (quickAddClose) {
    quickAddClose.addEventListener('click', () => {
      quickAddModal.classList.remove('open');
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
      quickAddModal.classList.remove('open');
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