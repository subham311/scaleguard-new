import prisma from '../../config/database.js';

const LAZY_INVENTORY_VALUES = new Set([999, 9999, 10000]);
const DESCRIPTION_MIN_CHARS = 250; // ~50 words
const EXCESSIVE_IMAGE_THRESHOLD = 20;
const UNREALISTIC_INVENTORY_THRESHOLD = 5000;

// Severity sort order
const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

const GENERIC_DESCRIPTION_KEYWORDS = [
  'lorem ipsum', 'product description', 'coming soon', 'description here',
  'add your description', 'no description', 'tbd', 'to be added',
];

function rawTextLength(html) {
  if (!html) return 0;
  return html.replace(/<[^>]*>?/gm, '').trim().length;
}

function rawWordCount(html) {
  if (!html) return 0;
  return html.replace(/<[^>]*>?/gm, '').trim().split(/\s+/).filter(Boolean).length;
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isInvalidTitle(title) {
  if (!title || title.trim().length === 0) return true;
  const t = title.trim();
  if (t.length <= 1) return true;
  if (/^[\d\s\-_\.]+$/.test(t)) return true; // numeric/code only
  return false;
}

function isWeakTitle(title) {
  if (!title) return false;
  const t = title.trim();
  if (t.length < 5) return true;
  const words = t.split(/\s+/).filter(w => w.length > 1);
  if (words.length < 3) return true;
  return false;
}

function isGenericDescription(html) {
  if (!html) return false;
  const text = html.replace(/<[^>]*>?/gm, '').toLowerCase().trim();
  return GENERIC_DESCRIPTION_KEYWORDS.some(kw => text.includes(kw));
}

function buildScoreExplanations(issues, scores) {
  const pricingIssues = issues.filter(i => i.type === 'PRICING_ERROR');
  const titleIssues = issues.filter(i => i.type === 'INVALID_PRODUCT_TITLE' || i.type === 'WEAK_PRODUCT_TITLE');
  const descIssues = issues.filter(i => ['MISSING_DESCRIPTION', 'WEAK_DESCRIPTION', 'GENERIC_DESCRIPTION'].includes(i.type));
  const imageIssues = issues.filter(i => ['NO_PRODUCT_IMAGES', 'LOW_IMAGE_COUNT', 'EXCESSIVE_IMAGE_COUNT'].includes(i.type));
  const consistencyIssues = issues.filter(i =>
    ['CATALOG_INCONSISTENCY', 'HIGH_FRAGMENTATION', 'INCONSISTENT_PRICE_POSITIONING', 'VARIANT_PRICE_GAP', 'COLLECTION_PRICE_OUTLIER'].includes(i.type)
  );
  const inventoryIssues = issues.filter(i =>
    ['LAZY_INVENTORY', 'UNIFORM_INVENTORY', 'GHOST_LISTING', 'UNREALISTIC_INVENTORY'].includes(i.type)
  );
  const perfIssues = issues.filter(i => i.type === 'HIGH_PERFORMANCE_LOW_QUALITY');
  const deadInventory = issues.filter(i => i.type === 'DEAD_INVENTORY');

  // Data Quality
  let dataQualityExplanation = 'Data Quality covers product titles, descriptions, and pricing validity. ';
  if (pricingIssues.length === 0 && titleIssues.length === 0 && descIssues.length === 0) {
    dataQualityExplanation += 'All products have valid titles, pricing, and sufficient descriptions.';
  } else {
    const parts = [];
    if (pricingIssues.length > 0) parts.push(`${pricingIssues.length} variant(s) have invalid or zero pricing`);
    if (titleIssues.length > 0) parts.push(`${titleIssues.length} product(s) have weak or unusable titles`);
    if (descIssues.length > 0) parts.push(`${descIssues.length} product(s) have missing or insufficient descriptions`);
    dataQualityExplanation += `Score reduced because ${parts.join(', and ')}.`;
  }

  // Visual Trust
  let visualTrustExplanation = 'Visual Trust covers image count, missing images, and excessive imagery. ';
  if (imageIssues.length === 0) {
    visualTrustExplanation += 'All products meet the required image standards for your plan.';
  } else {
    const noImg = imageIssues.filter(i => i.type === 'NO_PRODUCT_IMAGES').length;
    const lowImg = imageIssues.filter(i => i.type === 'LOW_IMAGE_COUNT').length;
    const exImg = imageIssues.filter(i => i.type === 'EXCESSIVE_IMAGE_COUNT').length;
    const parts = [];
    if (noImg > 0) parts.push(`${noImg} product(s) have no images at all`);
    if (lowImg > 0) parts.push(`${lowImg} product(s) have insufficient images`);
    if (exImg > 0) parts.push(`${exImg} product(s) have excessive image counts`);
    visualTrustExplanation += `Score reduced because ${parts.join(', and ')}.`;
  }

  // Consistency
  let consistencyExplanation = 'Consistency covers pricing gaps between variants, inventory anomalies, and catalog coherence. ';
  const consistencyParts = [];
  if (consistencyIssues.find(i => i.type === 'HIGH_FRAGMENTATION'))
    consistencyParts.push('the catalog spans too many product types (Flea Market Risk)');
  if (consistencyIssues.find(i => i.type === 'INCONSISTENT_PRICE_POSITIONING' || i.type === 'COLLECTION_PRICE_OUTLIER'))
    consistencyParts.push('extreme price variance signals inconsistent positioning');
  if (consistencyIssues.find(i => i.type === 'VARIANT_PRICE_GAP' || i.type === 'CATALOG_INCONSISTENCY'))
    consistencyParts.push('some products show significant internal variant pricing variance');
  if (consistencyParts.length === 0) {
    consistencyExplanation += 'No fragmentation or pricing anomalies detected.';
  } else {
    consistencyExplanation += `Score reduced because ${consistencyParts.join(', and ')}.`;
  }

  // Readiness
  let readinessExplanation = 'Readiness is a combined score based on catalog quality, visual trust, pricing integrity, inventory credibility, and scaling risk. ';
  const readinessParts = [];
  if (inventoryIssues.length > 0)
    readinessParts.push(`${inventoryIssues.length} inventory anomaly(ies) detected (ghost listings, uniform/unrealistic stock, lazy imports)`);
  if (perfIssues.length > 0)
    readinessParts.push(`${perfIssues.length} top-selling product(s) are missing visual trust`);
  if (deadInventory.length > 0)
    readinessParts.push(`${deadInventory.length} product(s) have high stock but zero sales (dead capital)`);
  if (readinessParts.length === 0) {
    readinessExplanation += 'No critical inventory or performance risks found.';
  } else {
    readinessExplanation += `Score impacted because ${readinessParts.join(', and ')}.`;
  }

  return {
    dataQuality: { explanation: dataQualityExplanation },
    visualTrust: { explanation: visualTrustExplanation },
    consistency: { explanation: consistencyExplanation },
    readiness:   { explanation: readinessExplanation },
  };
}

export async function processAuditRun(jobData) {
  const { shopId } = jobData;
  console.log(`🔍 Starting Phase 2 commercial risk audit for shop ${shopId}`);

  const auditRun = await prisma.auditRun.create({
    data: { shopId, status: 'PROCESSING', startedAt: new Date() },
  });

  try {
    const issues = [];

    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      include: { subscription: { include: { pricingPlan: true } } },
    });

    const plan = shop.subscription?.pricingPlan || {
      maxProducts: 20,
      imagesPerProduct: 2,
      auditType: 'BASIC',
    };

    const products = await prisma.product.findMany({
      where: { shopId },
      include: { variants: true, performance: true },
      take: plan.maxProducts,
    });

    const allPrices = [];

    for (const product of products) {
      const variantCount = product.variants.length;

      // ── 1. TITLE VALIDATION ──────────────────────────────────────────────
      if (isInvalidTitle(product.title)) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'INVALID_PRODUCT_TITLE',
          severity: 'CRITICAL',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            reason: 'Title is missing, single-character, or numeric/code-only.',
            businessImpact: 'Customers cannot understand what is being sold.',
            confidence: 'HIGH',
          },
        });
      } else if (isWeakTitle(product.title)) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'WEAK_PRODUCT_TITLE',
          severity: 'HIGH',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            wordCount: product.title.trim().split(/\s+/).filter(Boolean).length,
            reason: 'Title is too short or vague to support search, trust, or purchase intent.',
            businessImpact: 'Weak titles reduce SEO performance and buyer confidence.',
            confidence: 'HIGH',
          },
        });
      }

      // ── 2. DESCRIPTION ───────────────────────────────────────────────────
      const textLen = rawTextLength(product.description);
      const wordCount = rawWordCount(product.description);

      if (!product.description || textLen === 0) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'MISSING_DESCRIPTION',
          severity: 'HIGH',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            descriptionLength: 0,
            businessImpact: 'No information to build buyer trust or purchase confidence.',
            confidence: 'HIGH',
          },
        });
      } else if (isGenericDescription(product.description)) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'GENERIC_DESCRIPTION',
          severity: 'MEDIUM',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            descriptionLength: textLen,
            businessImpact: 'Generic descriptions do not explain why customers should buy from your store.',
            confidence: 'MEDIUM',
          },
        });
      } else if (wordCount < 50 || textLen < DESCRIPTION_MIN_CHARS) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'WEAK_DESCRIPTION',
          severity: 'HIGH',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            descriptionLength: textLen,
            wordCount,
            threshold: DESCRIPTION_MIN_CHARS,
            businessImpact: 'Thin descriptions cannot convert paid or organic traffic.',
            confidence: 'HIGH',
          },
        });
      }

      // ── 3. IMAGE COUNT TIERS ─────────────────────────────────────────────
      if (product.imageCount === 0) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'NO_PRODUCT_IMAGES',
          severity: 'CRITICAL',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            imageCount: 0,
            businessImpact: 'Customers cannot evaluate the product. Do not run paid traffic.',
            confidence: 'HIGH',
          },
        });
      } else if (product.imageCount < plan.imagesPerProduct) {
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
            businessImpact: 'Too few images to build buyer confidence.',
            confidence: 'HIGH',
          },
        });
      } else if (product.imageCount >= EXCESSIVE_IMAGE_THRESHOLD) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'EXCESSIVE_IMAGE_COUNT',
          severity: 'MEDIUM',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            imageCount: product.imageCount,
            threshold: EXCESSIVE_IMAGE_THRESHOLD,
            businessImpact: 'Excessive imagery may overwhelm buyers and create decision hesitation.',
            confidence: 'MEDIUM',
          },
        });
      }

      // ── 4. VARIANT PRICING & INVENTORY ───────────────────────────────────
      let minPrice = Infinity;
      let maxPrice = -Infinity;
      let totalInventory = 0;
      const inventoryValues = [];

      for (const variant of product.variants) {
        if (variant.price === null || variant.price === undefined || variant.price <= 0) {
          issues.push({
            auditRunId: auditRun.id,
            type: 'PRICING_ERROR',
            severity: 'CRITICAL',
            category: 'PRICING',
            affectedEntities: [variant.shopifyId],
            evidence: {
              title: variant.title,
              price: variant.price,
              businessImpact: 'Zero or null pricing causes checkout failures.',
              confidence: 'HIGH',
            },
          });
        } else {
          if (variant.price < minPrice) minPrice = variant.price;
          if (variant.price > maxPrice) maxPrice = variant.price;
        }

        const inv = typeof variant.inventory === 'number' ? variant.inventory : 0;
        totalInventory += inv;
        inventoryValues.push(inv);

        // Lazy inventory sentinel values
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
              reason: `Inventory quantity ${inv} is a known bulk import / dropship sentinel value.`,
              businessImpact: 'Artificial stock quantities reduce customer trust and signal low-review imports.',
              confidence: 'HIGH',
            },
          });
        }

        // Unrealistic inventory
        if (inv > UNREALISTIC_INVENTORY_THRESHOLD) {
          issues.push({
            auditRunId: auditRun.id,
            type: 'UNREALISTIC_INVENTORY',
            severity: 'HIGH',
            category: 'INVENTORY',
            affectedEntities: [variant.shopifyId],
            evidence: {
              title: `${product.title} — ${variant.title}`,
              inventory: inv,
              threshold: UNREALISTIC_INVENTORY_THRESHOLD,
              reason: `Stock quantity of ${inv.toLocaleString()} units is unusually high.`,
              businessImpact: 'Extremely high stock may look artificial and reduce customer trust.',
              confidence: 'HIGH',
            },
          });
        }
      }

      // Uniform inventory (all variants same high stock)
      if (variantCount >= 4) {
        const highValues = inventoryValues.filter(v => v > 50);
        const uniqueHighValues = new Set(highValues);
        if (uniqueHighValues.size === 1 && highValues.length === variantCount) {
          issues.push({
            auditRunId: auditRun.id,
            type: 'UNIFORM_INVENTORY',
            severity: 'HIGH',
            category: 'INVENTORY',
            affectedEntities: [product.shopifyId],
            evidence: {
              title: product.title,
              variantCount,
              uniformValue: inventoryValues[0],
              reason: `All ${variantCount} variants share exactly ${inventoryValues[0]} units — suggests unreviewed bulk import.`,
              businessImpact: 'May indicate supplier-fed catalog. Review inventory to avoid low-trust dropshipping perception.',
              confidence: 'HIGH',
            },
          });
        }
      }

      // Ghost listing: published with zero total inventory
      if (totalInventory === 0) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'GHOST_LISTING',
          severity: 'HIGH',
          category: 'INVENTORY',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            totalInventory: 0,
            reason: 'Published product with zero total inventory.',
            businessImpact: 'Customers can browse but cannot purchase. Creates wasted browsing and reduces confidence.',
            confidence: 'HIGH',
          },
        });
      }

      // Variant price gap (tiered)
      if (minPrice !== Infinity && maxPrice !== -Infinity && maxPrice > minPrice) {
        const ratio = maxPrice / minPrice;
        let gapSeverity = null;
        if (ratio >= 10) gapSeverity = 'CRITICAL';
        else if (ratio >= 5) gapSeverity = 'HIGH';
        else if (ratio >= 3) gapSeverity = 'LOW';

        if (gapSeverity) {
          issues.push({
            auditRunId: auditRun.id,
            type: 'VARIANT_PRICE_GAP',
            severity: gapSeverity,
            category: 'PRICING',
            affectedEntities: [product.shopifyId],
            evidence: {
              title: product.title,
              minPrice,
              maxPrice,
              ratio: ratio.toFixed(1),
              reason: `Variant prices vary by ${ratio.toFixed(1)}× (min $${minPrice.toFixed(2)}, max $${maxPrice.toFixed(2)}).`,
              businessImpact: 'Large pricing gaps between variants may confuse buyers or indicate a setup error.',
              confidence: 'HIGH',
            },
          });
        }
      }

      if (maxPrice !== -Infinity) allPrices.push(maxPrice);

      // ── 5. PERFORMANCE LAYER ─────────────────────────────────────────────
      if (product.performance) {
        const perf = product.performance;
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
              reason: 'Top seller missing visual trust.',
              businessImpact: 'Top-performing product lacks imagery — risks conversion drop and refund risk.',
              confidence: 'HIGH',
            },
          });
        }
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
              reason: 'High stock but zero sales in 60 days.',
              businessImpact: 'Capital tied up in non-performing inventory.',
              confidence: 'MEDIUM',
            },
          });
        }
      }
    }

    // ── 6. CATALOG-LEVEL RULES ─────────────────────────────────────────────
    const totalProductCount = products.length;

    // High fragmentation
    const collectionSets = products
      .map(p => {
        if (!p.collectionIds) return null;
        try {
          return Array.isArray(p.collectionIds)
            ? p.collectionIds
            : JSON.parse(String(p.collectionIds));
        } catch { return null; }
      })
      .filter(Boolean);

    if (collectionSets.length > 0 && totalProductCount < 50) {
      const allCollections = new Set(collectionSets.flat());
      if (allCollections.size > 8) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'HIGH_FRAGMENTATION',
          severity: 'MEDIUM',
          category: 'CONSISTENCY',
          affectedEntities: [],
          evidence: {
            totalProducts: totalProductCount,
            distinctCollections: allCollections.size,
            reason: `Store has ${totalProductCount} products across ${allCollections.size} distinct collections — Flea Market Risk.`,
            businessImpact: 'Buyers cannot trust what your store stands for. Consolidate into focused collections.',
            confidence: 'MEDIUM',
          },
        });
      }
    }

    // Collection price outlier (replaces INCONSISTENT_PRICE_POSITIONING for catalog level)
    if (allPrices.length >= 3) {
      const medianPrice = median(allPrices);
      const maxCatalogPrice = Math.max(...allPrices);

      if (medianPrice > 0) {
        const catalogRatio = maxCatalogPrice / medianPrice;
        if (catalogRatio >= 20) {
          issues.push({
            auditRunId: auditRun.id,
            type: 'COLLECTION_PRICE_OUTLIER',
            severity: 'MEDIUM',
            category: 'CONSISTENCY',
            affectedEntities: [],
            evidence: {
              medianPrice,
              maxCatalogPrice,
              ratio: catalogRatio.toFixed(1),
              reason: `Highest-priced product is ${catalogRatio.toFixed(1)}× the median catalog price.`,
              businessImpact: 'Extreme price range undermines brand trust and confuses target audience.',
              confidence: 'MEDIUM',
            },
          });
        } else if (catalogRatio >= 10) {
          issues.push({
            auditRunId: auditRun.id,
            type: 'INCONSISTENT_PRICE_POSITIONING',
            severity: 'LOW',
            category: 'CONSISTENCY',
            affectedEntities: [],
            evidence: {
              medianPrice,
              maxCatalogPrice,
              ratio: catalogRatio.toFixed(1),
              reason: `Catalog price range is ${catalogRatio.toFixed(1)}× — check intentional premium positioning.`,
              businessImpact: 'May signal inconsistent brand positioning.',
              confidence: 'MEDIUM',
            },
          });
        }
      }
    }

    // ── 7. PERSIST ISSUES ──────────────────────────────────────────────────
    if (issues.length > 0) {
      await prisma.issue.createMany({ data: issues });
    }

    // ── 8. CALCULATE SCORES ────────────────────────────────────────────────
    const pricingIssues       = issues.filter(i => i.type === 'PRICING_ERROR');
    const titleIssues         = issues.filter(i => ['INVALID_PRODUCT_TITLE', 'WEAK_PRODUCT_TITLE'].includes(i.type));
    const descIssues          = issues.filter(i => ['MISSING_DESCRIPTION', 'WEAK_DESCRIPTION', 'GENERIC_DESCRIPTION'].includes(i.type));
    const allImageIssues      = issues.filter(i => ['NO_PRODUCT_IMAGES', 'LOW_IMAGE_COUNT', 'EXCESSIVE_IMAGE_COUNT'].includes(i.type));
    const noImageIssues       = issues.filter(i => i.type === 'NO_PRODUCT_IMAGES');
    const allConsistencyIssues = issues.filter(i =>
      ['VARIANT_PRICE_GAP', 'CATALOG_INCONSISTENCY', 'HIGH_FRAGMENTATION', 'INCONSISTENT_PRICE_POSITIONING', 'COLLECTION_PRICE_OUTLIER'].includes(i.type)
    );
    const perfRiskIssues      = issues.filter(i => i.type === 'HIGH_PERFORMANCE_LOW_QUALITY');
    const criticalIssues      = issues.filter(i => i.severity === 'CRITICAL');

    const scores = {
      productDataQuality: Math.max(0,
        100
        - (pricingIssues.length * 15)
        - (titleIssues.filter(i => i.type === 'INVALID_PRODUCT_TITLE').length * 15)
        - (titleIssues.filter(i => i.type === 'WEAK_PRODUCT_TITLE').length * 5)
        - (descIssues.filter(i => i.type === 'MISSING_DESCRIPTION').length * 10)
        - (descIssues.filter(i => i.type === 'WEAK_DESCRIPTION').length * 5)
        - (descIssues.filter(i => i.type === 'GENERIC_DESCRIPTION').length * 3)
      ),
      visualTrust: Math.max(0,
        100
        - (noImageIssues.length * 30)
        - (allImageIssues.filter(i => i.type === 'LOW_IMAGE_COUNT').length * 15)
        - (allImageIssues.filter(i => i.type === 'EXCESSIVE_IMAGE_COUNT').length * 5)
      ),
      catalogConsistency: Math.max(0, 100 - (allConsistencyIssues.length * 20)),
    };

    const baseReadiness = (scores.productDataQuality * 0.4) + (scores.visualTrust * 0.4) + (scores.catalogConsistency * 0.2);
    let conversionReadiness = Math.round(Math.max(0, baseReadiness - perfRiskIssues.length * 20));
    if (criticalIssues.length > 0) conversionReadiness = Math.min(conversionReadiness, 45);
    scores.conversionReadiness = conversionReadiness;

    const explanations = buildScoreExplanations(issues, scores);

    await prisma.auditRun.update({
      where: { id: auditRun.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    console.log(`✅ Phase 2 audit completed for shop ${shopId}. Found ${issues.length} issues.`);
    return { success: true, issuesCount: issues.length, auditRunId: auditRun.id, scores, explanations };

  } catch (error) {
    console.error(`❌ Audit run failed for shop ${shopId}:`, error);
    await prisma.auditRun.update({
      where: { id: auditRun.id },
      data: { status: 'FAILED', completedAt: new Date() },
    });
    throw error;
  }
}
