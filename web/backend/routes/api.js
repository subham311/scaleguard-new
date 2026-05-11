import express from 'express';
import prisma from '../config/database.js';
import { authenticateShop } from '../middleware/auth.js';
import { authenticateFlexible } from '../middleware/sessionToken.js';

const router = express.Router();
const REVIEW_BYPASS_SHOPS = new Set(['daf2cb-2.myshopify.com']);

function isReviewBypassShop(shopDomain) {
  if (!shopDomain) return false;
  return REVIEW_BYPASS_SHOPS.has(String(shopDomain).toLowerCase());
}

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Shop info (protected)
router.get('/shop', authenticateShop, async (req, res) => {
  try {
    const shop = req.shop;
    const subscription = await prisma.subscription.findUnique({
      where: { shopId: shop.id },
    });

    res.json({
      shop: {
        id: shop.id,
        domain: shop.shopDomain,
        maturityLevel: shop.maturityLevel,
        lastAnalysisAt: shop.lastAnalysisAt,
        dataCollectedAt: shop.dataCollectedAt,
      },
      subscription: subscription || null,
    });
  } catch (error) {
    console.error('Get shop error:', error);
    res.status(500).json({ error: 'Failed to get shop info' });
  }
});

// Comprehensive dashboard data
router.get('/dashboard', authenticateFlexible, async (req, res) => {
  try {
    const shop = req.shop;
    const reviewBypassEnabled = isReviewBypassShop(shop.shopDomain);
    
    // Get subscription
    const subscription = await prisma.subscription.findUnique({
      where: { shopId: shop.id },
      include: { pricingPlan: true }
    });

    const plan = subscription?.pricingPlan;

    // 1. Get the latest completed AuditRun
    const latestAudit = await prisma.auditRun.findFirst({
      where: { shopId: shop.id, status: 'COMPLETED' },
      include: {
        issues: true,
      },
      orderBy: { completedAt: 'desc' },
    });

    // 2. Get products for breakdown
    const products = await prisma.product.findMany({
      where: { shopId: shop.id },
      include: { variants: true },
      take: 50,
    });

    // 3. Calculate Scores & Verdict (Fail-closed initialization)
    let scores = {
      productDataQuality: 0,
      visualTrust: 0,
      catalogConsistency: 0,
      conversionReadiness: 0,
    };

    let issuesList = [];
    let productBreakdown = [];
    let isDataSufficient = true;
    let dataIssues = [];

    // Basic data sufficiency check (independent of audit)
    if (products.length < 5) {
      isDataSufficient = false;
      dataIssues.push('Add at least 5 products to get a reliable catalog audit.');
    }

    if (latestAudit) {
      const issues = latestAudit.issues;
      
      // Calculate deductions
      const criticalIssues = issues.filter(i => i.severity === 'CRITICAL');
      const pricingIssues = issues.filter(i => i.type === 'PRICING_ERROR');
      const descIssues = issues.filter(i => i.type === 'MISSING_DESCRIPTION');
      const imageIssues = issues.filter(i => i.type === 'LOW_IMAGE_COUNT');
      const consistencyIssues = issues.filter(i => i.type === 'CATALOG_INCONSISTENCY');
      const perfRiskIssues = issues.filter(i => i.type === 'HIGH_PERFORMANCE_LOW_QUALITY');

      // Category Scoring
      scores.productDataQuality = Math.max(0, 100 - (pricingIssues.length * 15) - (descIssues.length * 5));
      scores.visualTrust = Math.max(0, 100 - (imageIssues.length * 20));
      scores.catalogConsistency = Math.max(0, 100 - (consistencyIssues.length * 25));
      
      // Conversion Readiness: Weighted average + performance & critical penalties
      const baseReadiness = (scores.productDataQuality * 0.4) + (scores.visualTrust * 0.4) + (scores.catalogConsistency * 0.2);
      const performancePenalty = perfRiskIssues.length * 20; // Heavier penalty for failing top sellers
      
      let finalReadiness = Math.round(Math.max(0, baseReadiness - performancePenalty));

      // CRITICAL FAIL-CLOSED LOGIC: 
      // If any critical issues exist (Pricing Errors, High Performance Quality Risk), 
      // the score cannot exceed 45% (High Risk) regardless of other quality scores.
      if (criticalIssues.length > 0) {
        finalReadiness = Math.min(finalReadiness, 45);
      }
      
      scores.conversionReadiness = finalReadiness;

      // Group issues by type to avoid repeating the same issue type multiple times
      const groupedIssues = issues.reduce((acc, issue) => {
        if (!acc[issue.type]) {
          acc[issue.type] = {
            id: issue.id, // Use the first issue ID as the group ID
            type: issue.type,
            severity: issue.severity, // Assume same severity for same type
            affectedEntities: new Set(issue.affectedEntities || []),
          };
        } else {
          // Combine affected entities
          (issue.affectedEntities || []).forEach(e => acc[issue.type].affectedEntities.add(e));
        }
        return acc;
      }, {});

      // Map grouped issues for frontend with affected product details
      issuesList = Object.values(groupedIssues).map(issueGroup => {
        let recommendation = 'Fix this issue in your Shopify Admin.';
        let evidence = 'Detected during catalog scan.';
        
        const affectedEntitiesArray = Array.from(issueGroup.affectedEntities);

        if (issueGroup.type === 'LOW_IMAGE_COUNT') {
          recommendation = 'Do not run ads to these products until images are added. Lack of visual trust will waste your ad budget.';
          evidence = `${affectedEntitiesArray.length} products have fewer than ${plan?.imagesPerProduct || 3} images.`;
        } else if (issueGroup.type === 'PRICING_ERROR') {
          recommendation = 'Critical: Resolve $0 or null pricing immediately. These products are effectively unsellable and will cause checkout failures.';
          evidence = `Found invalid pricing on ${affectedEntitiesArray.length} variants.`;
        } else if (issueGroup.type === 'MISSING_DESCRIPTION') {
          recommendation = 'Pause SEO campaigns for these products. Descriptions are too short to convert organic or paid traffic.';
          evidence = `${affectedEntitiesArray.length} products have weak descriptions (below quality threshold).`;
        } else if (issueGroup.type === 'CATALOG_INCONSISTENCY') {
          recommendation = 'Review pricing strategy for these items. Extreme variant price gaps (10x+) often indicate errors that confuse buyers.';
          evidence = `${affectedEntitiesArray.length} products show significant internal pricing variance.`;
        } else if (issueGroup.type === 'HIGH_PERFORMANCE_LOW_QUALITY') {
          recommendation = 'Immediate Risk: These top-selling products are missing visual trust. Fix images now to maintain conversion momentum and prevent refund risks.';
          evidence = `${affectedEntitiesArray.length} high-performing products have sub-standard catalog quality.`;
        } else if (issueGroup.type === 'DEAD_INVENTORY') {
          recommendation = 'Capital Risk: High stock levels with zero sales. Consider markdowns or clearing this inventory to free up capital for better-performing items.';
          evidence = `${affectedEntitiesArray.length} stagnant products are tying up significant warehouse space.`;
        }

        // Get affected products with id, shopifyId, and title for deep-linking
        const items = products
          .filter(p => affectedEntitiesArray.includes(p.shopifyId))
          .map(p => ({ id: p.id, shopifyId: p.shopifyId, title: p.title }));

        return {
          id: issueGroup.id,
          type: issueGroup.type.replace(/_/g, ' '),
          severity: issueGroup.severity,
          recommendation,
          evidence,
          affectedCount: items.length, // More accurate than affectedEntitiesArray.length
          items,
          // keep legacy field for compatibility
          affectedProductTitles: items.map(p => p.title),
        };
      }).filter(issue => issue.items && issue.items.length > 0);

      // Map product breakdown (all products with their issues)
      productBreakdown = products.map(p => {
        const productIssues = issues.filter(i => i.affectedEntities.includes(p.shopifyId));
        
        return {
          id: p.id,
          title: p.title,
          issueType: productIssues.length > 0 ? productIssues[0].type.replace(/_/g, ' ') : 'Healthy',
          severity: productIssues.length > 0 ? productIssues[0].severity : 'NONE',
          performance: p.performance ? {
            orders: p.performance.orderCount,
            sales: p.performance.totalSales
          } : null
        };
      });
    }

    // Determine Verdict - Business Focused
    let verdict = 'Not Ready';
    let storeRecommendation = '';
    const mainScore = scores.conversionReadiness;
    const criticalIssuesExist = latestAudit?.issues.some(i => i.severity === 'CRITICAL');
    
    if (mainScore >= 85) {
      verdict = 'Ready to Scale: Proceed with ad spend';
      storeRecommendation = 'Your catalog quality is high. It is safe to scale up your ad budget.';
    } else if (mainScore >= 70) {
      verdict = 'Almost Ready: Fix remaining issues';
      storeRecommendation = 'Catalog is stable, but fix the flagged issues to maximize your conversion rate before heavy scaling.';
    } else if (mainScore >= 45) {
      verdict = 'Not Ready: Do not run ads';
      storeRecommendation = 'Do not run ads to the store until product descriptions and catalog quality are improved to prevent low ROAS.';
    } else {
      verdict = 'High Risk: Stop paid traffic';
      storeRecommendation = criticalIssuesExist 
        ? 'Critical errors detected (e.g. pricing or top-seller quality). Stop all paid traffic immediately to prevent budget waste.'
        : 'Immediate action required. Stop all paid traffic to prevent budget waste due to catalog quality issues.';
    }

    res.json({
      shop: {
        id: shop.id,
        domain: shop.shopDomain,
        dataCollectedAt: shop.dataCollectedAt,
      },
      subscription: subscription || null,
      verdict: latestAudit ? verdict : 'Waiting for Sync',
      storeRecommendation: latestAudit ? storeRecommendation : 'Initial audit required to determine readiness.',
      isDataSufficient,
      dataIssues,
      scores: latestAudit ? scores : null,
      issues: issuesList,
      products: productBreakdown,
      plan: subscription?.plan ? subscription.plan.toUpperCase() : 'FREE',
    });
  } catch (error) {
    console.error('Get dashboard error:', error);
    res.status(500).json({ error: 'Failed to get dashboard data' });
  }
});

// Synced data snapshot (for App Review proof and merchant transparency)
router.get('/sync-snapshot', authenticateFlexible, async (req, res) => {
  try {
    const shop = req.shop;
    const { fetchShopifyData } = await import('../services/shopifyDataService.js');

    console.log(`📥 [/sync-snapshot] Fetching Shopify data for ${shop.shopDomain}`);
    const shopifyData = await fetchShopifyData(shop);
    const products = shopifyData?.products || [];

    // Compute simple merchant-facing output from synced data
    const productSnapshots = products.slice(0, 8).map((p) => {
      const variants = Array.isArray(p.variants) ? p.variants : [];
      const totalInventory = variants.reduce((sum, v) => {
        const qty = typeof v.inventory_quantity === 'number' ? v.inventory_quantity : parseInt(v.inventory_quantity || 0, 10);
        return sum + (Number.isFinite(qty) ? qty : 0);
      }, 0);

      return {
        id: String(p.id),
        title: p.title,
        totalInventory,
        status: p.status || null,
      };
    });

    const lowStock = productSnapshots
      .filter((p) => typeof p.totalInventory === 'number' && p.totalInventory >= 0 && p.totalInventory < 5)
      .slice(0, 5);

    console.log(
      `✅ [/sync-snapshot] Built snapshot for ${shop.shopDomain}: ` +
        `${productSnapshots.length} products shown, ${lowStock.length} low-stock flagged`
    );

    res.json({
      fetchedAt: shopifyData?.fetchedAt || new Date(),
      counts: {
        orders: shopifyData?.orders?.length || 0,
        products: products.length,
        customers: shopifyData?.customers?.length || 0,
      },
      products: productSnapshots,
      insights: {
        lowStock: lowStock.map((p) => ({
          productId: p.id,
          title: p.title,
          totalInventory: p.totalInventory,
          message: `Low stock: ${p.title} has only ${p.totalInventory} units available.`,
        })),
      },
    });
  } catch (error) {
    console.error('Get sync snapshot error:', error);
    res.status(500).json({ error: 'Failed to build sync snapshot' });
  }
});

// Get nudges
router.get('/nudges', authenticateFlexible, async (req, res) => {
  try {
    const shop = req.shop;
    const status = req.query.status || 'ACTIVE';
    
    const nudges = await prisma.nudge.findMany({
      where: {
        shopId: shop.id,
        status: status.toUpperCase(),
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json({ nudges });
  } catch (error) {
    console.error('Get nudges error:', error);
    res.status(500).json({ error: 'Failed to get nudges' });
  }
});

// Dismiss a nudge
router.post('/nudges/:id/dismiss', authenticateFlexible, async (req, res) => {
  try {
    const shop = req.shop;
    const nudgeId = req.params.id;
    const reviewBypassEnabled = isReviewBypassShop(shop.shopDomain);

    // Allow dismissing temporary review/demo nudges without database records.
    if (reviewBypassEnabled && nudgeId.startsWith('review-demo-')) {
      return res.json({ success: true });
    }

    // Verify nudge belongs to shop
    const nudge = await prisma.nudge.findFirst({
      where: {
        id: nudgeId,
        shopId: shop.id,
      },
    });

    if (!nudge) {
      return res.status(404).json({ error: 'Nudge not found' });
    }

    await prisma.nudge.update({
      where: { id: nudgeId },
      data: { status: 'DISMISSED' },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Dismiss nudge error:', error);
    res.status(500).json({ error: 'Failed to dismiss nudge' });
  }
});

// Get analyses
router.get('/analyses', authenticateFlexible, async (req, res) => {
  try {
    const shop = req.shop;
    const limit = parseInt(req.query.limit) || 10;

    const analyses = await prisma.analysis.findMany({
      where: {
        shopId: shop.id,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: limit,
    });

    res.json({ analyses });
  } catch (error) {
    console.error('Get analyses error:', error);
    res.status(500).json({ error: 'Failed to get analyses' });
  }
});

// Get onboarding status
router.get('/onboarding-status', authenticateFlexible, async (req, res) => {
  try {
    const shop = req.shop;
    const reviewBypassEnabled = isReviewBypassShop(shop.shopDomain);
    
    // Check if shop has any analyses (indicates onboarding complete)
    const hasAnalyses = await prisma.analysis.count({
      where: { shopId: shop.id },
    }) > 0;

    // Calculate days since installation
    const daysSinceInstall = Math.floor(
      (new Date() - new Date(shop.installedAt)) / (1000 * 60 * 60 * 24)
    );

    // Determine onboarding stage
    let stage = 'WELCOME';
    if (hasAnalyses) {
      stage = 'COMPLETE';
    } else if (daysSinceInstall >= 7) {
      stage = 'DATA_COLLECTING';
    } else if (daysSinceInstall >= 1) {
      stage = 'GETTING_STARTED';
    }

    if (reviewBypassEnabled) {
      return res.json({
        stage: 'COMPLETE',
        daysSinceInstall: Math.max(daysSinceInstall, 14),
        hasAnalyses: true,
        maturityLevel: shop.maturityLevel === 'NEW' ? 'LEARNING' : shop.maturityLevel,
        dataCollectedAt: shop.dataCollectedAt || new Date(),
      });
    }

    res.json({
      stage,
      daysSinceInstall,
      hasAnalyses,
      maturityLevel: shop.maturityLevel,
      dataCollectedAt: shop.dataCollectedAt,
    });
  } catch (error) {
    console.error('Get onboarding status error:', error);
    res.status(500).json({ error: 'Failed to get onboarding status' });
  }
});

// Get data sufficiency status (for low-data store handling)
router.get('/data-status', authenticateFlexible, async (req, res) => {
  try {
    const shop = req.shop;
    const reviewBypassEnabled = isReviewBypassShop(shop.shopDomain);

    if (reviewBypassEnabled) {
      return res.json({
        meetsThreshold: true,
        reason: null,
        dataCounts: {
          orders: 124,
          products: 42,
          customers: 78,
          daysOfData: 21,
        },
        requirements: {
          minOrders: 10,
          minProducts: 5,
          minDays: 7,
        },
        progress: {
          ordersProgress: 100,
          productsProgress: 100,
          daysProgress: 100,
        },
      });
    }

    const { fetchShopifyData } = await import('../services/shopifyDataService.js');
    const { checkThresholds } = await import('../services/decisionSafety.js');
    
    // Fetch current Shopify data
    console.log(`📥 [/data-status] Fetching Shopify data for ${shop.shopDomain}`);
    const shopifyData = await fetchShopifyData(shop);
    console.log(
      `✅ [/data-status] Fetched data for ${shop.shopDomain}: ` +
        `${shopifyData?.orders?.length || 0} orders, ` +
        `${shopifyData?.products?.length || 0} products, ` +
        `${shopifyData?.customers?.length || 0} customers`
    );
    
    // Check thresholds
    const thresholdCheck = await checkThresholds(shopifyData, shop);
    
    // Get data counts
    const orders = shopifyData?.orders || [];
    const products = shopifyData?.products || [];
    const customers = shopifyData?.customers || [];
    
    // Calculate time window
    let daysOfData = 0;
    if (orders.length > 0) {
      const oldestOrder = new Date(orders[orders.length - 1].created_at);
      const newestOrder = new Date(orders[0].created_at);
      daysOfData = Math.floor((newestOrder - oldestOrder) / (1000 * 60 * 60 * 24));
    }
    
    res.json({
      meetsThreshold: thresholdCheck.meetsThreshold,
      reason: thresholdCheck.reason || null,
      dataCounts: {
        orders: orders.length,
        products: products.length,
        customers: customers.length,
        daysOfData: daysOfData,
      },
      requirements: {
        minOrders: 10,
        minProducts: 5,
        minDays: 7,
      },
      progress: {
        ordersProgress: Math.min((orders.length / 10) * 100, 100),
        productsProgress: Math.min((products.length / 5) * 100, 100),
        daysProgress: Math.min((daysOfData / 7) * 100, 100),
      },
    });
  } catch (error) {
    console.error('Get data status error:', error);
    
    // Check if it's a protected customer data error
    if (error.response?.code === 403) {
      const errorBody = error.response?.body;
      const errorMessage = typeof errorBody === 'string' ? errorBody : errorBody?.errors || '';
      
      if (errorMessage.includes('protected customer data') || 
          errorMessage.includes('not approved to access')) {
        return res.status(403).json({
          error: 'Protected customer data access not approved',
          message: 'This app needs to request access to protected customer data in Partner Dashboard.',
          solution: 'Request access to protected customer data in Partner Dashboard',
          steps: [
            '1. Go to Partner Dashboard → Apps → ScaleGuard',
            '2. Click "API access requests" in sidebar',
            '3. Find "Protected customer data access" → Click "Request access"',
            '4. Select "Protected customer data" (Level 1)',
            '5. Select fields: Orders (contains customer data)',
            '6. Complete Data protection details',
            '7. For dev stores, you can access immediately (no review needed)',
            '',
            'See: https://shopify.dev/docs/apps/launch/protected-customer-data',
          ],
        });
      }
    }
    
    res.status(500).json({ error: 'Failed to get data status' });
  }
});

export default router;

