import prisma from '../../config/database.js';
import { fetchShopifyData } from '../../services/shopifyDataService.js';

export async function processDataSync(jobData) {
  const { shopId } = jobData;
  
  console.log(`🔄 Starting data sync for shop ${shopId}`);
  
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
  });

  if (!shop || !shop.isActive) {
    throw new Error(`Shop ${shopId} not found or inactive`);
  }

  try {
    // Fetch latest data from Shopify
    const shopifyData = await fetchShopifyData(shop);
    
    // Save products and variants to local DB
    if (shopifyData?.products) {
      for (const product of shopifyData.products) {
        // Upsert product
        const savedProduct = await prisma.product.upsert({
          where: { shopifyId: String(product.id) },
          create: {
            shopId: shop.id,
            shopifyId: String(product.id),
            title: product.title,
            description: product.body_html,
            imageCount: product.images ? product.images.length : 0,
          },
          update: {
            title: product.title,
            description: product.body_html,
            imageCount: product.images ? product.images.length : 0,
          }
        });

        // Upsert variants
        if (product.variants) {
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
              }
            });
          }
        }
      }
    }
    
    // Performance Layer: Process Orders if available (Optional Layer)
    if (shopifyData?.orders && shopifyData.orders.length > 0) {
      console.log(`📊 Processing performance data for ${shopifyData.orders.length} orders`);
      const performanceMap = new Map(); // shopifyProductId -> { sales, quantity, count }

      for (const order of shopifyData.orders) {
        // Upsert order
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
          update: {
            status: order.financial_status,
          }
        });

        // Track performance per product
        if (order.line_items) {
          for (const lineItem of order.line_items) {
            if (!lineItem.product_id) continue;
            
            const productId = String(lineItem.product_id);
            const current = performanceMap.get(productId) || { sales: 0, quantity: 0, count: 0 };
            
            performanceMap.set(productId, {
              sales: current.sales + parseFloat(lineItem.price) * lineItem.quantity,
              quantity: current.quantity + lineItem.quantity,
              count: current.count + 1
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
              productId: product.id,
              totalSales: stats.sales,
              totalQuantity: stats.quantity,
              orderCount: stats.count,
            },
            update: {
              totalSales: stats.sales,
              totalQuantity: stats.quantity,
              orderCount: stats.count,
            }
          });
        }
      }
    }

    // Update data collected timestamp
    await prisma.shop.update({
      where: { id: shopId },
      data: { dataCollectedAt: new Date() },
    });

    console.log(`✅ Data sync completed for shop ${shopId}`);
    return {
      success: true,
      productsCount: shopifyData?.products?.length || 0,
      ordersCount: shopifyData?.orders?.length || 0,
    };
  } catch (error) {
    console.error(`❌ Data sync failed for shop ${shopId}:`, error);
    throw error;
  }
}
