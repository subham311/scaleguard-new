import prisma from '../../config/database.js';
import { fetchShopifyData } from '../../services/shopifyDataService.js';
import { detectProductLanguage } from '../../utils/languageDetector.js';

// ─────────────────────────────────────────────────────────────────────────────
//  PLAN LIMITS — mirrors PricingPlan table values as a safe-fallback
// ─────────────────────────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  LIGHT:  { maxProducts: 20,  imagesPerProduct: 2 },
  GROWTH: { maxProducts: 75,  imagesPerProduct: 3 },
  PRO:    { maxProducts: 200, imagesPerProduct: 4 },
};

const DEFAULT_LIMITS = PLAN_LIMITS.LIGHT;

/**
 * Resolve the effective plan limits for a shop.
 * Priority: DB pricingPlan > plan name constant > default LIGHT.
 */
function resolvePlanLimits(subscription) {
  if (subscription?.pricingPlan) {
    return {
      maxProducts:     subscription.pricingPlan.maxProducts,
      imagesPerProduct: subscription.pricingPlan.imagesPerProduct,
    };
  }
  if (subscription?.plan) {
    const key = subscription.plan.toUpperCase();
    return PLAN_LIMITS[key] || DEFAULT_LIMITS;
  }
  return DEFAULT_LIMITS;
}

function getPricingAnomalySeverity(productTitle, price) {
  if (!productTitle || price <= 0) return null;
  const title = productTitle.toLowerCase();
  
  const luxuryKeywords = [
    'rolex', 'daytona', 'patek', 'audemars', 'luxury watch', 'diamond ring',
    'antique', 'fine art', 'painting', 'sculpture', 'estate', 'property',
    'house', 'car', 'vehicle', 'porsche', 'ferrari', 'lamborghini'
  ];
  const isLuxury = luxuryKeywords.some(kw => title.includes(kw));
  if (isLuxury) return null; // exempt
  
  // Check for extremely low price (decimal mistake)
  if (price >= 0.01 && price <= 0.99) {
    return 'CRITICAL';
  }
  
  const apparelKeywords = [
    'coat', 'jacket', 't-shirt', 'shirt', 'pants', 'trousers', 'shoes', 'sneakers',
    'dress', 'skirt', 'hoodie', 'sweater', 'jeans', 'blouse', 'cardigan', 'shorts', 
    'leggings', 'underwear', 'socks', 'scarf', 'hat', 'gloves', 'swimwear', 
    'activewear', 'sportswear'
  ];
  const isApparel = apparelKeywords.some(kw => title.includes(kw));
  
  if (isApparel) {
    if (price >= 10000) return 'CRITICAL';
    if (price >= 3000) return 'HIGH';
    if (price >= 1500) return 'WARNING';
  } else {
    if (price >= 20000) return 'CRITICAL';
    if (price >= 5000) return 'HIGH';
    if (price >= 3000) return 'WARNING';
  }
  
  return null;
}

function isInvalidTitle(title) {
  if (!title || title.trim().length === 0) return true;
  const t = title.trim();
  if (t.length <= 1) return true;
  if (/^[\d\s\-_\.]+$/.test(t)) return true;
  return false;
}

function isSerialTitle(title) {
  if (!title) return false;
  const t = title.toLowerCase().trim();

  // Exclude brand exceptions
  const exceptions = [
    /iphone\s+\d+/i,
    /rtx\s+\d+/i,
    /xbox\s+series\s+[a-z0-9]+/i,
    /cat\s+s\d+/i,
    /\b(oneplus|redmi|xiaomi|samsung|galaxy|pixel|huawei|realme|oppo|vivo|motorola|sony|playstation|nintendo|macbook|ipad|oyster|rolex|omega|garmin|thrustmaster)\b/i
  ];
  if (exceptions.some(regex => regex.test(t))) {
    return false;
  }

  // Contiguous sequence of 7+ digits
  if (/\d{7,}/.test(t)) {
    return true;
  }

  // Digits percentage check (35% AND sequence of 5+ digits)
  const nonSpaceChars = t.replace(/\s+/g, '');
  if (nonSpaceChars.length > 0) {
    const digitCount = (t.match(/\d/g) || []).length;
    const hasFiveDigitSeq = /\d{5,}/.test(t);
    if (hasFiveDigitSeq && (digitCount / nonSpaceChars.length) > 0.35) {
      return true;
    }
  }

  // NEW: Repeated numeric blocks pattern (e.g., "0001 0001", "123 456 789")
  // If title has 2+ separate numeric blocks of 3+ digits each, AND combined digits >= 30% of title
  const numericBlocks = t.match(/\d{3,}/g) || [];
  if (numericBlocks.length >= 2) {
    const totalDigits = numericBlocks.reduce((sum, block) => sum + block.length, 0);
    const nonSpaceChars = t.replace(/\s+/g, '');
    if (nonSpaceChars.length > 0 && (totalDigits / nonSpaceChars.length) > 0.3) {
      return true;
    }
  }

  return false;
}

function calculateProductPriority(product, collectionMap) {
  let score = 0;
  
  const title = product.title || '';
  const variants = product.variants || [];
  const imageCount = Array.isArray(product.images) ? product.images.length : 0;
  const description = product.body_html || '';
  const isPublished = product.published_at !== null && product.status === 'active';
  
  let totalInventory = 0;
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  const inventoryValues = [];
  
  for (const variant of variants) {
    const price = variant.price ? parseFloat(variant.price) : 0;
    const inv = typeof variant.inventory_quantity === 'number' ? variant.inventory_quantity : parseInt(variant.inventory_quantity || 0, 10);
    const validInv = Number.isFinite(inv) ? inv : 0;
    totalInventory += validInv;
    inventoryValues.push(validInv);
    
    if (price <= 0) {
      score += 1000; // CRITICAL: PRICING_ERROR
    } else {
      if (price < minPrice) minPrice = price;
      if (price > maxPrice) maxPrice = price;
      
      const pricingAnomaly = getPricingAnomalySeverity(title, price);
      if (pricingAnomaly === 'CRITICAL') {
        score += 1000;
      } else if (pricingAnomaly === 'HIGH') {
        score += 500;
      } else if (pricingAnomaly === 'WARNING') {
        score += 100;
      }
    }
    
    if (validInv > 5000) {
      score += 100; // HIGH: UNREALISTIC_INVENTORY
    }
  }
  
  // Ghost Listing: published product with no collection assignment (new definition)
  if (isPublished) {
    const productCollections = collectionMap ? collectionMap.get(String(product.id)) : null;
    if (!productCollections || productCollections.length === 0) {
      score += 1000; // CRITICAL: GHOST_LISTING
    }
  }
  
  if (imageCount === 0) {
    score += 1000; // CRITICAL: NO_PRODUCT_IMAGES
  } else if (imageCount >= 20) {
    score += 10; // MEDIUM: EXCESSIVE_IMAGE_COUNT
  }
  
  if (isInvalidTitle(title)) {
    score += 100; // HIGH: INVALID_PRODUCT_TITLE
  } else if (isSerialTitle(title)) {
    score += 100; // HIGH: SERIAL_PRODUCT_TITLE
  }
  
  if (!description || description.trim().length === 0) {
    score += 100; // HIGH: MISSING_DESCRIPTION
  }
  
  if (variants.length >= 4) {
    const highValues = inventoryValues.filter(v => v > 50);
    const uniqueHighValues = new Set(highValues);
    if (uniqueHighValues.size === 1 && highValues.length === variants.length) {
      score += 10; // MEDIUM: UNIFORM_INVENTORY
    }
  }
  
  return score;
}

export async function processDataSync(jobData) {
  const { shopId } = jobData;

  console.log(`🔄 Starting data sync for shop ${shopId}`);

  // ── Fetch shop + subscription ──────────────────────────────────────────────
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: {
      subscription: { include: { pricingPlan: true } },
    },
  });

  if (!shop || !shop.isActive) {
    throw new Error(`Shop ${shopId} not found or inactive`);
  }

  const limits = resolvePlanLimits(shop.subscription);
  const planName = shop.subscription?.pricingPlan?.name
    || shop.subscription?.plan
    || 'LIGHT';

  console.log(
    `📋 [DataSync] Plan: ${planName} | ` +
    `Max products: ${limits.maxProducts} | ` +
    `Max images/product: ${limits.imagesPerProduct}`
  );

  try {
    // ── Fetch latest data from Shopify ─────────────────────────────────────
    const shopifyData = await fetchShopifyData(shop);

    // ── PLAN-LIMITED PRODUCT INGESTION ─────────────────────────────────────
    if (shopifyData?.products) {
      // Dynamic Discovery Pass & Risk-First Ingestion
      // Pass collectionMap so Ghost Listing priority uses the new definition (no collections, not zero inventory)
      const prioritizedProducts = shopifyData.products
        .map(p => ({ product: p, priority: calculateProductPriority(p, shopifyData.collectionMap) }))
        .sort((a, b) => b.priority - a.priority)
        .map(item => item.product);

      // Enforce maxProducts LIMIT before iterating — cost control
      const productsToSync = prioritizedProducts.slice(0, limits.maxProducts);

      console.log(
        `📦 [DataSync] Syncing ${productsToSync.length} of ${shopifyData.products.length} products ` +
        `(limit: ${limits.maxProducts} for ${planName})`
      );

      // Purge deleted products that are no longer in the active products list
      const activeProductShopifyIds = productsToSync.map(p => String(p.id));
      const deletedProductsResult = await prisma.product.deleteMany({
        where: {
          shopId: shop.id,
          shopifyId: {
            notIn: activeProductShopifyIds,
          },
        },
      });
      if (deletedProductsResult.count > 0) {
        console.log(`🧹 [DataSync] Purged ${deletedProductsResult.count} deleted product(s) (with cascade delete for variants/performance).`);
      }

      for (const product of productsToSync) {
        // Get the full product image count
        const fullImageCount = Array.isArray(product.images) ? product.images.length : 0;

        // Detect product language at ingestion time
        const { lang: detectedLang } = detectProductLanguage(product.title, product.body_html);

        const productImages = Array.isArray(product.images) ? product.images.map(img => ({
          id: String(img.id),
          src: img.src,
          width: img.width || 0,
          height: img.height || 0,
          alt: img.alt || '',
          position: img.position
        })) : [];

        // Upsert product — store full image count and storefront published status
        const savedProduct = await prisma.product.upsert({
          where: { shopifyId: String(product.id) },
          create: {
            shopId: shop.id,
            shopifyId: String(product.id),
            title: product.title,
            description: product.body_html,
            imageCount: fullImageCount,
            published: product.published_at !== null && product.status === 'active',
            detectedLanguage: detectedLang,
            collectionIds: (shopifyData.collectionMap && shopifyData.collectionMap.get(String(product.id))) || [],
            images: productImages,
            productType: product.product_type || "",
            tags: product.tags || "",
            vendor: product.vendor || "",
          },
          update: {
            title: product.title,
            description: product.body_html,
            imageCount: fullImageCount,
            published: product.published_at !== null && product.status === 'active',
            detectedLanguage: detectedLang,
            collectionIds: (shopifyData.collectionMap && shopifyData.collectionMap.get(String(product.id))) || [],
            images: productImages,
            productType: product.product_type || "",
            tags: product.tags || "",
            vendor: product.vendor || "",
          },
        });

        // Upsert variants
        if (product.variants) {
          // Purge variants that are no longer present for this product
          const activeVariantShopifyIds = product.variants.map(v => String(v.id));
          const deletedVariantsResult = await prisma.variant.deleteMany({
            where: {
              productId: savedProduct.id,
              shopifyId: {
                notIn: activeVariantShopifyIds,
              },
            },
          });
          if (deletedVariantsResult.count > 0) {
            console.log(`🧹 [DataSync] Purged ${deletedVariantsResult.count} deleted variant(s) for product ${product.title}.`);
          }

          for (const variant of product.variants) {
            await prisma.variant.upsert({
              where: { shopifyId: String(variant.id) },
              create: {
                productId: savedProduct.id,
                shopifyId: String(variant.id),
                title: variant.title,
                price: variant.price ? parseFloat(variant.price) : null,
                inventory: variant.inventory_quantity || 0,
              },
              update: {
                title: variant.title,
                price: variant.price ? parseFloat(variant.price) : null,
                inventory: variant.inventory_quantity || 0,
              },
            });
          }
        }
      }
    }

    // ── PERFORMANCE LAYER (Optional) ───────────────────────────────────────
    if (shopifyData?.orders && shopifyData.orders.length > 0) {
      console.log(`📊 Processing performance data for ${shopifyData.orders.length} orders`);
      const performanceMap = new Map(); // shopifyProductId → { sales, quantity, count }

      for (const order of shopifyData.orders) {
        // Upsert order record
        await prisma.order.upsert({
          where: { shopifyId: String(order.id) },
          create: {
            shopId: shop.id,
            shopifyId: String(order.id),
            orderNumber: String(order.order_number),
            totalPrice: parseFloat(order.total_price),
            currency: order.currency,
            status: order.financial_status,
            orderedAt: new Date(order.created_at),
          },
          update: { status: order.financial_status },
        });

        // Track performance per product
        if (order.line_items) {
          for (const lineItem of order.line_items) {
            if (!lineItem.product_id) continue;
            const productId = String(lineItem.product_id);
            const current = performanceMap.get(productId) || { sales: 0, quantity: 0, count: 0 };
            performanceMap.set(productId, {
              sales:    current.sales + parseFloat(lineItem.price) * lineItem.quantity,
              quantity: current.quantity + lineItem.quantity,
              count:    current.count + 1,
            });
          }
        }
      }

      // Save aggregated performance metrics
      for (const [shopifyId, stats] of performanceMap.entries()) {
        const product = await prisma.product.findUnique({ where: { shopifyId } });
        if (product) {
          await prisma.performanceMetric.upsert({
            where: { productId: product.id },
            create: {
              productId:     product.id,
              totalSales:    stats.sales,
              totalQuantity: stats.quantity,
              orderCount:    stats.count,
            },
            update: {
              totalSales:    stats.sales,
              totalQuantity: stats.quantity,
              orderCount:    stats.count,
            },
          });
        }
      }
    }

    // ── Update shop timestamp and catalog count ─────────────────────────────
    await prisma.shop.update({
      where: { id: shopId },
      data: { 
        dataCollectedAt: new Date(),
        totalProductsCount: shopifyData?.products?.length || 0,
        primaryLocale: shopifyData?.primaryLocale || 'en',
      },
    });

    const syncedCount = Math.min(
      shopifyData?.products?.length || 0,
      limits.maxProducts
    );

    console.log(`✅ Data sync completed for shop ${shopId} (${syncedCount} products synced)`);
    return {
      success: true,
      productsCount: syncedCount,
      ordersCount: shopifyData?.orders?.length || 0,
      planLimits: limits,
    };

  } catch (error) {
    console.error(`❌ Data sync failed for shop ${shopId}:`, error);
    throw error;
  }
}
