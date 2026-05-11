import prisma from '../../config/database.js';

export async function processAuditRun(jobData) {
  const { shopId } = jobData;
  console.log(`🔍 Starting audit run for shop ${shopId}`);

  // Create an AuditRun record
  const auditRun = await prisma.auditRun.create({
    data: {
      shopId,
      status: 'PROCESSING',
      startedAt: new Date(),
    },
  });

  try {
    const issues = [];
    
    // Fetch shop subscription and privileges
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      include: {
        subscription: {
          include: { pricingPlan: true }
        }
      }
    });

    if (!shop.subscription || shop.subscription.status !== 'ACTIVE' || !shop.subscription.pricingPlan) {
      console.warn(`⚠️ Shop ${shopId} does not have an active subscription with privileges. Using defaults.`);
    }

    const plan = shop.subscription?.pricingPlan || {
      maxProducts: 20,
      imagesPerProduct: 2,
      auditType: 'BASIC'
    };

    // Fetch local data - limit by plan's maxProducts
    const products = await prisma.product.findMany({
      where: { shopId },
      include: { 
        variants: true,
        performance: true 
      },
      take: plan.maxProducts,
    });

    for (const product of products) {
      // Image Rule: Active products where imageCount < threshold defined in plan
      if (product.imageCount < plan.imagesPerProduct) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'LOW_IMAGE_COUNT',
          severity: 'HIGH',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: { title: product.title, imageCount: product.imageCount, required: plan.imagesPerProduct }
        });
      }

      // Description Rule: HTML description is null/empty or raw text length < threshold
      const descriptionThreshold = plan.auditType === 'BASIC' ? 50 : 100;
      const rawTextLength = product.description ? product.description.replace(/<[^>]*>?/gm, '').trim().length : 0;
      if (!product.description || rawTextLength < descriptionThreshold) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'MISSING_DESCRIPTION',
          severity: 'MEDIUM',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: { title: product.title, descriptionLength: rawTextLength, threshold: descriptionThreshold }
        });
      }

      let minPrice = Infinity;
      let maxPrice = -Infinity;

      for (const variant of product.variants) {
        // Pricing Rule: Price is null, undefined, or <= 0.00
        if (variant.price === null || variant.price === undefined || variant.price <= 0.00) {
          issues.push({
            auditRunId: auditRun.id,
            type: 'PRICING_ERROR',
            severity: 'CRITICAL',
            category: 'PRICING',
            affectedEntities: [variant.shopifyId],
            evidence: { title: variant.title, price: variant.price }
          });
        } else {
          if (variant.price < minPrice) minPrice = variant.price;
          if (variant.price > maxPrice) maxPrice = variant.price;
        }
      }

      // Consistency Rule: Catalog exhibits basic inconsistency
      if (minPrice !== Infinity && maxPrice !== -Infinity && maxPrice > (minPrice * 10)) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'CATALOG_INCONSISTENCY',
          severity: 'LOW',
          category: 'PRICING',
          affectedEntities: [product.shopifyId],
          evidence: { minPrice, maxPrice, reason: 'Variant prices vary by more than 10x' }
        });
      }
      
      // --- Performance Layer (Optional Layer) ---
      if (product.performance) {
        const perf = product.performance;
        
        // Rule: High Selling with Low Images (Waste of Ad Budget / Missed Conversion)
        if (perf.orderCount >= 3 && product.imageCount < plan.imagesPerProduct) {
          issues.push({
            auditRunId: auditRun.id,
            type: 'HIGH_PERFORMANCE_LOW_QUALITY',
            severity: 'CRITICAL',
            category: 'PERFORMANCE',
            affectedEntities: [product.shopifyId],
            evidence: { 
              title: product.title, 
              orders: perf.orderCount, 
              images: product.imageCount,
              reason: 'Top seller missing visual trust' 
            }
          });
        }
        
        // Rule: High Inventory with No Sales (Dead Capital)
        const totalInventory = product.variants.reduce((sum, v) => sum + (v.inventory || 0), 0);
        if (totalInventory > 50 && perf.orderCount === 0) {
          issues.push({
            auditRunId: auditRun.id,
            type: 'DEAD_INVENTORY',
            severity: 'LOW',
            category: 'INVENTORY',
            affectedEntities: [product.shopifyId],
            evidence: { 
              title: product.title, 
              inventory: totalInventory,
              reason: 'High stock but zero sales in 60 days' 
            }
          });
        }
      }
    }

    // Insert all issues
    if (issues.length > 0) {
      await prisma.issue.createMany({
        data: issues,
      });
    }

    // Mark audit run as completed
    await prisma.auditRun.update({
      where: { id: auditRun.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    console.log(`✅ Audit run completed for shop ${shopId}. Found ${issues.length} issues.`);
    return { success: true, issuesCount: issues.length, auditRunId: auditRun.id };

  } catch (error) {
    console.error(`❌ Audit run failed for shop ${shopId}:`, error);
    
    await prisma.auditRun.update({
      where: { id: auditRun.id },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
      },
    });

    throw error;
  }
}
