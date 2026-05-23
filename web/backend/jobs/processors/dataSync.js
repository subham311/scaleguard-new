import prisma from '../../config/database.js';
import { fetchShopifyData } from '../../services/shopifyDataService.js';

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
      // Enforce maxProducts LIMIT before iterating — cost control
      const productsToSync = shopifyData.products.slice(0, limits.maxProducts);

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

        // Upsert product — store full image count
        const savedProduct = await prisma.product.upsert({
          where: { shopifyId: String(product.id) },
          create: {
            shopId: shop.id,
            shopifyId: String(product.id),
            title: product.title,
            description: product.body_html,
            imageCount: fullImageCount,
            // Store collection IDs if present (used for fragmentation analysis)
            collectionIds: product.collections
              ? product.collections.map(c => c.id)
              : (product.collection_id ? [product.collection_id] : null),
          },
          update: {
            title: product.title,
            description: product.body_html,
            imageCount: fullImageCount,
            collectionIds: product.collections
              ? product.collections.map(c => c.id)
              : (product.collection_id ? [product.collection_id] : null),
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

    // ── Update shop timestamp ──────────────────────────────────────────────
    await prisma.shop.update({
      where: { id: shopId },
      data: { dataCollectedAt: new Date() },
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
