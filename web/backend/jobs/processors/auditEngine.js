import prisma from '../../config/database.js';

// ─────────────────────────────────────────────────────────────────────────────
//  LAZY-IMPORT INVENTORY SENTINELS (classic dropship values)
// ─────────────────────────────────────────────────────────────────────────────
const LAZY_INVENTORY_VALUES = new Set([999, 9999, 10000]);

// Minimum raw-text length for a meaningful product description
const DESCRIPTION_MIN_LENGTH = 80;

/**
 * Strip HTML tags and return raw text length.
 */
function rawTextLength(html) {
  if (!html) return 0;
  return html.replace(/<[^>]*>?/gm, '').trim().length;
}

/**
 * Calculate median of a numeric array.
 */
function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SCORE EXPLANATION BUILDER
//  Generates a human-readable explanation for each score category
//  based on the triggered rules.
// ─────────────────────────────────────────────────────────────────────────────
function buildScoreExplanations(issues, scores) {
  const pricingIssues   = issues.filter(i => i.type === 'PRICING_ERROR');
  const descIssues      = issues.filter(i => i.type === 'MISSING_DESCRIPTION' || i.type === 'WEAK_DESCRIPTION');
  const imageIssues     = issues.filter(i => i.type === 'LOW_IMAGE_COUNT');
  const consistencyIssues = issues.filter(i =>
    i.type === 'CATALOG_INCONSISTENCY' ||
    i.type === 'HIGH_FRAGMENTATION' ||
    i.type === 'INCONSISTENT_PRICE_POSITIONING'
  );
  const inventoryIssues = issues.filter(i =>
    i.type === 'LAZY_INVENTORY' ||
    i.type === 'UNIFORM_INVENTORY' ||
    i.type === 'GHOST_LISTING'
  );
  const perfIssues      = issues.filter(i => i.type === 'HIGH_PERFORMANCE_LOW_QUALITY');
  const deadInventory   = issues.filter(i => i.type === 'DEAD_INVENTORY');

  // --- Data Quality ---
  let dataQualityExplanation;
  if (pricingIssues.length === 0 && descIssues.length === 0) {
    dataQualityExplanation = 'Data Quality is strong. All products have valid pricing and sufficient descriptions.';
  } else {
    const parts = [];
    if (pricingIssues.length > 0)
      parts.push(`${pricingIssues.length} variant(s) have invalid or zero pricing`);
    if (descIssues.length > 0)
      parts.push(`${descIssues.length} product(s) have missing or insufficient descriptions (under ${DESCRIPTION_MIN_LENGTH} characters)`);
    dataQualityExplanation = `Data Quality is reduced because ${parts.join(' and ')}.`;
  }

  // --- Visual Trust ---
  let visualTrustExplanation;
  if (imageIssues.length === 0) {
    visualTrustExplanation = 'Visual Trust is healthy. Products meet the required image count for your plan.';
  } else {
    visualTrustExplanation = `Visual Trust is ${scores.visualTrust < 40 ? 'critically low' : 'reduced'} because ${imageIssues.length} product(s) contain insufficient imagery and low-confidence visual assets.`;
  }

  // --- Consistency ---
  let consistencyExplanation;
  const consistencyParts = [];
  if (consistencyIssues.find(i => i.type === 'HIGH_FRAGMENTATION'))
    consistencyParts.push('the catalog spans too many distinct product types (Flea Market Risk)');
  if (consistencyIssues.find(i => i.type === 'INCONSISTENT_PRICE_POSITIONING'))
    consistencyParts.push('extreme price variance (max > 20× median) suggests inconsistent positioning');
  if (consistencyIssues.find(i => i.type === 'CATALOG_INCONSISTENCY'))
    consistencyParts.push('some products show internal pricing variance > 10×');

  if (consistencyParts.length === 0) {
    consistencyExplanation = 'Catalog Consistency is excellent. No fragmentation or pricing anomalies detected.';
  } else {
    consistencyExplanation = `Consistency score is reduced because ${consistencyParts.join(', and ')}.`;
  }

  // --- Readiness ---
  let readinessExplanation;
  const readinessParts = [];
  if (inventoryIssues.length > 0)
    readinessParts.push(`${inventoryIssues.length} inventory anomaly(ies) detected (lazy imports, uniform stock, or ghost listings)`);
  if (perfIssues.length > 0)
    readinessParts.push(`${perfIssues.length} top-selling product(s) are missing visual trust`);
  if (deadInventory.length > 0)
    readinessParts.push(`${deadInventory.length} product(s) have high stock but zero sales (dead capital)`);

  if (readinessParts.length === 0) {
    readinessExplanation = 'Conversion Readiness is strong. No critical inventory or performance risks found.';
  } else {
    readinessExplanation = `Readiness is impacted because ${readinessParts.join(', and ')}.`;
  }

  return {
    dataQuality: { explanation: dataQualityExplanation },
    visualTrust: { explanation: visualTrustExplanation },
    consistency: { explanation: consistencyExplanation },
    readiness:   { explanation: readinessExplanation },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN AUDIT PROCESSOR
// ─────────────────────────────────────────────────────────────────────────────
export async function processAuditRun(jobData) {
  const { shopId } = jobData;
  console.log(`🔍 Starting commercial risk audit for shop ${shopId}`);

  const auditRun = await prisma.auditRun.create({
    data: {
      shopId,
      status: 'PROCESSING',
      startedAt: new Date(),
    },
  });

  try {
    const issues = [];

    // ── Fetch shop & plan ──────────────────────────────────────────────────
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      include: {
        subscription: { include: { pricingPlan: true } },
      },
    });

    if (!shop.subscription?.pricingPlan) {
      console.warn(`⚠️ Shop ${shopId} has no active plan. Applying LIGHT defaults.`);
    }

    const plan = shop.subscription?.pricingPlan || {
      maxProducts: 20,
      imagesPerProduct: 2,
      auditType: 'BASIC',
    };

    // ── Fetch local data limited by plan ───────────────────────────────────
    const products = await prisma.product.findMany({
      where: { shopId },
      include: { variants: true, performance: true },
      take: plan.maxProducts,
    });

    // ── Catalog-level aggregates (for niche-consistency rules) ────────────
    const allPrices = [];       // max price per product (for median calculation)
    const productTypes = new Set();

    // We'll collect product types from evidence stored on products.
    // Since the Product model doesn't have a `productType` field natively,
    // we'll derive fragmentation from existing issues if available, or pass
    // through Shopify raw data stored as collectionIds metadata.
    // For variance analysis, we work from the variant prices.

    // ── Per-product rules ──────────────────────────────────────────────────
    for (const product of products) {
      const variantCount = product.variants.length;

      // ── 1. WEAK DESCRIPTION ─────────────────────────────────────────────
      const textLen = rawTextLength(product.description);
      if (!product.description || textLen < DESCRIPTION_MIN_LENGTH) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'WEAK_DESCRIPTION',
          severity: 'MEDIUM',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            descriptionLength: textLen,
            threshold: DESCRIPTION_MIN_LENGTH,
          },
        });
      }

      // ── 2. IMAGE COUNT (existing rule, kept) ────────────────────────────
      if (product.imageCount < plan.imagesPerProduct) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'LOW_IMAGE_COUNT',
          severity: 'HIGH',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            imageCount: product.imageCount,
            required: plan.imagesPerProduct,
          },
        });
      }

      // ── 3. VARIANT-LEVEL INVENTORY & PRICING RULES ───────────────────────
      let minPrice = Infinity;
      let maxPrice = -Infinity;
      let totalInventory = 0;

      // For fake-scarcity / uniform-stock detection
      const inventoryValues = [];

      for (const variant of product.variants) {
        // a. Pricing Error
        if (variant.price === null || variant.price === undefined || variant.price <= 0) {
          issues.push({
            auditRunId: auditRun.id,
            type: 'PRICING_ERROR',
            severity: 'CRITICAL',
            category: 'PRICING',
            affectedEntities: [variant.shopifyId],
            evidence: { title: variant.title, price: variant.price },
          });
        } else {
          if (variant.price < minPrice) minPrice = variant.price;
          if (variant.price > maxPrice) maxPrice = variant.price;
        }

        const inv = typeof variant.inventory === 'number' ? variant.inventory : 0;
        totalInventory += inv;
        inventoryValues.push(inv);

        // b. Lazy Dropship Import Sentinel Values
        if (LAZY_INVENTORY_VALUES.has(inv)) {
          issues.push({
            auditRunId: auditRun.id,
            type: 'LAZY_INVENTORY',
            severity: 'MEDIUM',
            category: 'INVENTORY',
            affectedEntities: [variant.shopifyId],
            evidence: {
              title: `${product.title} — ${variant.title}`,
              inventory: inv,
              reason: `Inventory quantity ${inv} is a known lazy dropship import value.`,
            },
          });
        }
      }

      // c. Uniform Inventory Across 4+ Variants (Fake Scarcity)
      if (variantCount >= 4) {
        const uniqueInventoryValues = new Set(inventoryValues.filter(v => v > 50));
        if (uniqueInventoryValues.size === 1) {
          // Every single variant has the exact same stock > 50
          issues.push({
            auditRunId: auditRun.id,
            type: 'UNIFORM_INVENTORY',
            severity: 'LOW',
            category: 'INVENTORY',
            affectedEntities: [product.shopifyId],
            evidence: {
              title: product.title,
              variantCount,
              uniformValue: inventoryValues[0],
              reason: `All ${variantCount} variants share exactly ${inventoryValues[0]} units — suggests fake scarcity or lazy import.`,
            },
          });
        }
      }

      // d. Ghost Listing: Published product with 0 total inventory, no continue-selling
      //    We flag it based on totalInventory === 0. The `continue-selling` policy is
      //    not stored in our local DB, so we flag conservatively.
      if (totalInventory === 0 && product.imageCount >= 0) {
        // Only flag if the product itself is not a service/digital (no reliable way to tell
        // from local data, so we flag with LOW severity for merchant review)
        issues.push({
          auditRunId: auditRun.id,
          type: 'GHOST_LISTING',
          severity: 'LOW',
          category: 'INVENTORY',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            totalInventory: 0,
            reason: 'Published product with zero total inventory. Enable "Continue selling when out of stock" or unpublish.',
          },
        });
      }

      // e. Variant Price Inconsistency (existing rule)
      if (minPrice !== Infinity && maxPrice !== -Infinity && maxPrice > minPrice * 10) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'CATALOG_INCONSISTENCY',
          severity: 'LOW',
          category: 'PRICING',
          affectedEntities: [product.shopifyId],
          evidence: { minPrice, maxPrice, reason: 'Variant prices vary by more than 10×' },
        });
      }

      // Collect max price for catalog-level median calculation
      if (maxPrice !== -Infinity) allPrices.push(maxPrice);

      // ── 4. Performance Layer ─────────────────────────────────────────────
      if (product.performance) {
        const perf = product.performance;

        // High seller with poor imagery
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
              reason: 'Top seller missing visual trust',
            },
          });
        }

        // Dead inventory: high stock, zero sales
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
              reason: 'High stock but zero sales in 60 days',
            },
          });
        }
      }
    }

    // ── 5. CATALOG-LEVEL NICHE CONSISTENCY RULES ──────────────────────────
    const totalProductCount = products.length;

    // a. High Fragmentation: < 50 products but > 8 distinct product types
    //    We approximate product types from issue evidence / collectionIds.
    //    Since `productType` isn't stored locally, we use collectionIds count
    //    as a proxy for type diversity. If collectionIds is null everywhere,
    //    we skip this rule gracefully.
    const collectionSets = products
      .map(p => {
        if (!p.collectionIds) return null;
        try {
          const arr = Array.isArray(p.collectionIds)
            ? p.collectionIds
            : JSON.parse(String(p.collectionIds));
          return arr;
        } catch { return null; }
      })
      .filter(Boolean);

    // Only run fragmentation check if we have collection data
    if (collectionSets.length > 0 && totalProductCount < 50) {
      const allCollections = new Set(collectionSets.flat());
      if (allCollections.size > 8) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'HIGH_FRAGMENTATION',
          severity: 'MEDIUM',
          category: 'CONSISTENCY',
          affectedEntities: [], // catalog-level issue
          evidence: {
            totalProducts: totalProductCount,
            distinctCollections: allCollections.size,
            reason: `Store has ${totalProductCount} products spread across ${allCollections.size} distinct collections — Flea Market Risk detected.`,
          },
        });
      }
    }

    // b. Inconsistent Price Positioning: max > 20× median
    if (allPrices.length >= 3) {
      const medianPrice = median(allPrices);
      const maxCatalogPrice = Math.max(...allPrices);
      if (medianPrice > 0 && maxCatalogPrice > medianPrice * 20) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'INCONSISTENT_PRICE_POSITIONING',
          severity: 'MEDIUM',
          category: 'CONSISTENCY',
          affectedEntities: [], // catalog-level issue
          evidence: {
            medianPrice,
            maxCatalogPrice,
            ratio: (maxCatalogPrice / medianPrice).toFixed(1),
            reason: `Catalog max price ($${maxCatalogPrice.toFixed(2)}) is ${(maxCatalogPrice / medianPrice).toFixed(1)}× the median ($${medianPrice.toFixed(2)}) — signals inconsistent positioning.`,
          },
        });
      }
    }

    // ── Insert all issues ──────────────────────────────────────────────────
    if (issues.length > 0) {
      await prisma.issue.createMany({ data: issues });
    }

    // ── Calculate scores for the summary stored on the audit run ──────────
    const pricingIssues      = issues.filter(i => i.type === 'PRICING_ERROR');
    const descIssues         = issues.filter(i => i.type === 'WEAK_DESCRIPTION' || i.type === 'MISSING_DESCRIPTION');
    const imageIssues        = issues.filter(i => i.type === 'LOW_IMAGE_COUNT');
    const allConsistencyIssues = issues.filter(i =>
      ['CATALOG_INCONSISTENCY', 'HIGH_FRAGMENTATION', 'INCONSISTENT_PRICE_POSITIONING'].includes(i.type)
    );
    const perfRiskIssues     = issues.filter(i => i.type === 'HIGH_PERFORMANCE_LOW_QUALITY');
    const criticalIssues     = issues.filter(i => i.severity === 'CRITICAL');

    const scores = {
      productDataQuality: Math.max(0, 100 - (pricingIssues.length * 15) - (descIssues.length * 5)),
      visualTrust:        Math.max(0, 100 - (imageIssues.length * 20)),
      catalogConsistency: Math.max(0, 100 - (allConsistencyIssues.length * 20)),
    };

    const baseReadiness = (scores.productDataQuality * 0.4) + (scores.visualTrust * 0.4) + (scores.catalogConsistency * 0.2);
    let conversionReadiness = Math.round(Math.max(0, baseReadiness - perfRiskIssues.length * 20));
    if (criticalIssues.length > 0) conversionReadiness = Math.min(conversionReadiness, 45);
    scores.conversionReadiness = conversionReadiness;

    const explanations = buildScoreExplanations(issues, scores);

    // ── Mark audit run as completed ────────────────────────────────────────
    await prisma.auditRun.update({
      where: { id: auditRun.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    console.log(`✅ Commercial risk audit completed for shop ${shopId}. Found ${issues.length} issues.`);
    return {
      success: true,
      issuesCount: issues.length,
      auditRunId: auditRun.id,
      scores,
      explanations,
    };

  } catch (error) {
    console.error(`❌ Audit run failed for shop ${shopId}:`, error);
    await prisma.auditRun.update({
      where: { id: auditRun.id },
      data: { status: 'FAILED', completedAt: new Date() },
    });
    throw error;
  }
}
