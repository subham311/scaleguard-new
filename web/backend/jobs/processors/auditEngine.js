import prisma from '../../config/database.js';

const LAZY_INVENTORY_VALUES = new Set([999, 9999, 10000]);
const DESCRIPTION_MIN_CHARS = 350; // ~70 words
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

function getPricingAnomaly(productTitle, price) {
  if (!productTitle || price <= 0) return null;
  const title = productTitle.toLowerCase();
  
  const luxuryKeywords = [
    'rolex', 'daytona', 'patek', 'audemars', 'luxury watch', 'diamond ring',
    'antique', 'fine art', 'painting', 'sculpture', 'estate', 'property',
    'house', 'car', 'vehicle', 'porsche', 'ferrari', 'lamborghini'
  ];
  const isLuxury = luxuryKeywords.some(kw => title.includes(kw));
  if (isLuxury) return null;
  
  // Extremely low price check
  if (price >= 0.01 && price <= 0.99) {
    return {
      severity: 'CRITICAL',
      reason: `Standalone price of £${price.toFixed(2)} is extremely low (under £1.00). This is likely a decimal formatting error or currency configuration mistake.`,
      businessImpact: 'Extremely low pricing leads to massive loss of margin on orders, search ranking penalization, and low buyer trust.',
    };
  }
  
  const apparelKeywords = [
    'coat', 'jacket', 't-shirt', 'shirt', 'pants', 'trousers', 'shoes', 'sneakers',
    'dress', 'skirt', 'hoodie', 'sweater', 'jeans', 'blouse', 'cardigan', 'shorts', 
    'leggings', 'underwear', 'socks', 'scarf', 'hat', 'gloves', 'swimwear', 
    'activewear', 'sportswear'
  ];
  const isApparel = apparelKeywords.some(kw => title.includes(kw));
  
  if (isApparel) {
    if (price >= 10000) {
      return {
        severity: 'CRITICAL',
        threshold: 10000,
        reason: `Standalone price of £${price.toLocaleString()} exceeds the critical apparel sanity threshold of £10,000.`,
      };
    }
    if (price >= 3000) {
      return {
        severity: 'HIGH',
        threshold: 3000,
        reason: `Standalone price of £${price.toLocaleString()} exceeds the high apparel sanity threshold of £3,000.`,
      };
    }
    if (price >= 1500) {
      return {
        severity: 'MEDIUM',
        threshold: 1500,
        reason: `Standalone price of £${price.toLocaleString()} exceeds the warning apparel sanity threshold of £1,500.`,
      };
    }
  } else {
    if (price >= 20000) {
      return {
        severity: 'CRITICAL',
        threshold: 20000,
        reason: `Standalone price of £${price.toLocaleString()} exceeds the critical general retail sanity threshold of £20,000.`,
      };
    }
    if (price >= 5000) {
      return {
        severity: 'HIGH',
        threshold: 5000,
        reason: `Standalone price of £${price.toLocaleString()} exceeds the high general retail sanity threshold of £5,000.`,
      };
    }
    if (price >= 3000) {
      return {
        severity: 'MEDIUM',
        threshold: 3000,
        reason: `Standalone price of £${price.toLocaleString()} exceeds the warning general retail sanity threshold of £3,000.`,
      };
    }
  }
  
  return null;
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

function isKeywordStuffedTitle(title) {
  if (!title) return false;
  const t = title.trim();
  const tLower = t.toLowerCase();

  // 1. Check for excessive separators
  const commaCount = (t.match(/,/g) || []).length;
  const pipeCount = (t.match(/\|/g) || []).length;
  const slashCount = (t.match(/\//g) || []).length;
  if (commaCount >= 3 || pipeCount >= 3 || slashCount >= 3) {
    return true;
  }

  // 2. Repetitive wording (duplicate words of length >= 3)
  const words = tLower.split(/[\s,\|/\-_]+/).filter(w => w.length >= 3);
  const wordCounts = {};
  for (const w of words) {
    wordCounts[w] = (wordCounts[w] || 0) + 1;
    if (wordCounts[w] >= 3) {
      return true;
    }
  }

  // 3. Extreme length with low unique word ratio
  if (t.length > 80 && words.length > 10) {
    const uniqueWords = new Set(words);
    if (uniqueWords.size / words.length < 0.7) {
      return true;
    }
  }

  return false;
}

function isGenericDescription(html) {
  if (!html) return false;
  const text = html.replace(/<[^>]*>?/gm, '').toLowerCase().trim();
  return GENERIC_DESCRIPTION_KEYWORDS.some(kw => text.includes(kw));
}

function isDimensionalOrQuantityProduct(variants) {
  if (!variants || variants.length === 0) return false;
  
  // Dimensional pattern: e.g., "50x80", "50 x 80", "2 * 4"
  const dimRegex = /\d+\s*(?:x|\*)\s*\d+/i;
  
  // Unit pattern: e.g., "100ml", "2kg", "5 pack", "10pcs", "3 ft"
  const unitRegex = /\b\d+\s*(?:cm|mm|inch|inches|ft|feet|yard|meters?|pcs|pack|pieces|kg|g|ml|l|liter|litre|oz|lbs?|gal|gallons?)\b/i;
  
  // Word indicators: e.g., "pack", "pcs", "pieces", "set of", "pair", "dimension", "size", "custom", "volume"
  const wordIndicators = ['pack', 'pcs', 'pieces', 'set of', 'pair', 'dimension', 'size', 'custom', 'volume'];

  for (const variant of variants) {
    if (!variant.title) continue;
    const title = variant.title.toLowerCase();
    
    if (dimRegex.test(title)) return true;
    if (unitRegex.test(title)) return true;
    if (wordIndicators.some(indicator => title.includes(indicator))) return true;
  }
  
  return false;
}

function buildScoreExplanations(issues, scores) {
  const pricingIssues = issues.filter(i => ['PRICING_ERROR', 'ABSOLUTE_PRICING_ANOMALY'].includes(i.type));
  const titleIssues = issues.filter(i => ['INVALID_PRODUCT_TITLE', 'WEAK_PRODUCT_TITLE', 'SERIAL_PRODUCT_TITLE', 'KEYWORD_STUFFED_TITLE'].includes(i.type));
  const descIssues = issues.filter(i => ['MISSING_DESCRIPTION', 'WEAK_DESCRIPTION', 'GENERIC_DESCRIPTION'].includes(i.type));
  const imageIssues = issues.filter(i => ['NO_PRODUCT_IMAGES', 'LOW_IMAGE_COUNT', 'EXCESSIVE_IMAGE_COUNT'].includes(i.type));
  const consistencyIssues = issues.filter(i =>
    ['CATALOG_INCONSISTENCY', 'HIGH_FRAGMENTATION', 'INCONSISTENT_PRICE_POSITIONING', 'VARIANT_PRICE_GAP', 'COLLECTION_PRICE_OUTLIER'].includes(i.type)
  );
  const inventoryIssues = issues.filter(i =>
    ['UNIFORM_INVENTORY', 'GHOST_LISTING', 'UNREALISTIC_INVENTORY'].includes(i.type)
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
    readinessParts.push(`${inventoryIssues.length} inventory anomaly(ies) detected (ghost listings, uniform/unrealistic stock)`);
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

    let fallbackPlan = { maxProducts: 20, imagesPerProduct: 2, auditType: 'BASIC' };
    if (shop.subscription && shop.subscription.plan) {
      const planName = shop.subscription.plan.toUpperCase();
      if (planName === 'LIGHT') {
        fallbackPlan.maxProducts = 20; fallbackPlan.imagesPerProduct = 2;
      } else if (planName === 'GROWTH') {
        fallbackPlan.maxProducts = 75; fallbackPlan.imagesPerProduct = 5;
      } else if (planName === 'PRO') {
        fallbackPlan.maxProducts = 200; fallbackPlan.imagesPerProduct = 10;
      }
    }
    const plan = shop.subscription?.pricingPlan || fallbackPlan;

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

      // ── 1B. SERIAL NUMBER STYLE & KEYWORD STUFFING ────────────────────────
      if (isSerialTitle(product.title)) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'SERIAL_PRODUCT_TITLE',
          severity: 'HIGH',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            reason: 'Title contains serial-like numbers or excessive numeric sequences. This makes products look like uncurated database dumps rather than high-end retail items.',
            businessImpact: 'Unprofessional serial-like names reduce customer buying trust.',
            confidence: 'HIGH',
          },
        });
      }

      if (isKeywordStuffedTitle(product.title)) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'KEYWORD_STUFFED_TITLE',
          severity: 'MEDIUM',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            reason: 'Title appears keyword-stuffed or overloaded with repetitive wording or dividers. While title length itself is fine, overloaded structures look unprofessional.',
            businessImpact: 'Keyword stuffing harms storefront clarity and brand trust.',
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
      } else if (wordCount < 75 || textLen < DESCRIPTION_MIN_CHARS) {
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

          // Absolute Pricing Anomaly: context-aware dynamic safety threshold check
          const anomaly = getPricingAnomaly(product.title, variant.price);
          if (anomaly) {
            issues.push({
              auditRunId: auditRun.id,
              type: 'ABSOLUTE_PRICING_ANOMALY',
              severity: anomaly.severity,
              category: 'PRICING',
              affectedEntities: [variant.shopifyId],
              evidence: {
                title: `${product.title} — ${variant.title}`,
                price: variant.price,
                threshold: anomaly.threshold || 0,
                reason: anomaly.reason,
                businessImpact: anomaly.businessImpact || 'Extremely unrealistic standalone pricing triggers critical catalog risk and blocks checkout conversions.',
                confidence: 'HIGH',
              },
            });
          }
        }

        const inv = typeof variant.inventory === 'number' ? variant.inventory : 0;
        totalInventory += inv;
        inventoryValues.push(inv);

        // Enhanced UNREALISTIC_INVENTORY check (incorporating Lazy Inventory sentinel values)
        if (inv > UNREALISTIC_INVENTORY_THRESHOLD || LAZY_INVENTORY_VALUES.has(inv)) {
          const isLazyPattern = LAZY_INVENTORY_VALUES.has(inv);
          issues.push({
            auditRunId: auditRun.id,
            type: 'UNREALISTIC_INVENTORY',
            severity: isLazyPattern ? 'MEDIUM' : 'HIGH',
            category: 'INVENTORY',
            affectedEntities: [variant.shopifyId],
            evidence: {
              title: `${product.title} — ${variant.title}`,
              inventory: inv,
              threshold: UNREALISTIC_INVENTORY_THRESHOLD,
              isLazyPattern,
              reason: isLazyPattern
                ? `Inventory quantity ${inv} is a known bulk import / dropship placeholder value (999, 9999, or 10,000).`
                : `Inventory quantity appears unusually high for a retail storefront and may reduce storefront trust perception.`,
              businessImpact: isLazyPattern
                ? 'Placeholder stock values reduce customer trust and signal low-review imports.'
                : 'Extremely high stock may look artificial and reduce customer trust.',
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
              reason: `All variants share identical inventory values. This may indicate supplier-fed inventory feeds, bulk imports, or inventory levels that have not been reviewed manually.`,
              businessImpact: 'May indicate supplier-fed catalog. Review inventory to avoid low-trust dropshipping perception.',
              confidence: 'HIGH',
            },
          });
        }
      }

      // Ghost listing: published with no collections assigned
      let collections = [];
      if (product.collectionIds) {
        try {
          collections = Array.isArray(product.collectionIds)
            ? product.collectionIds
            : JSON.parse(String(product.collectionIds));
        } catch (e) {
          collections = [];
        }
      }
      
      if (product.published && collections.length === 0) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'GHOST_LISTING',
          severity: 'HIGH',
          category: 'INVENTORY',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            reason: 'Published product with no collection assignment.',
            businessImpact: 'Product is active but invisible to storefront customers because it is not assigned to any collections. This creates a ghost listing.',
            confidence: 'HIGH',
          },
        });
      }

      // Variant price gap (tiered)
      if (minPrice !== Infinity && maxPrice !== -Infinity && maxPrice > minPrice) {
        const ratio = maxPrice / minPrice;
        const isDimensional = isDimensionalOrQuantityProduct(product.variants);
        
        let gapSeverity = null;
        if (isDimensional) {
          // Suppress normal size/quantity differences. Only flag extreme ratios (>= 15x) as potential typo anomalies.
          if (ratio >= 15) gapSeverity = 'HIGH';
        } else {
          if (ratio >= 10) gapSeverity = 'CRITICAL';
          else if (ratio >= 5) gapSeverity = 'HIGH';
          else if (ratio >= 3) gapSeverity = 'LOW';
        }

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
              isDimensional,
              reason: isDimensional
                ? `Extreme variant price gap of ${ratio.toFixed(1)}× on a dimensional/quantity product (min $${minPrice.toFixed(2)}, max $${maxPrice.toFixed(2)}).`
                : `Variant prices vary by ${ratio.toFixed(1)}× (min $${minPrice.toFixed(2)}, max $${maxPrice.toFixed(2)}).`,
              businessImpact: isDimensional
                ? 'Extremely large price gap between dimensional variants suggests a potential configuration typo.'
                : 'Large pricing gaps between variants may confuse buyers or indicate a setup error.',
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

    // ── 7. PERSIST ISSUES & MERCHANT OVERRIDES ──────────────────────────────
    const overrides = await prisma.merchantOverride.findMany({
      where: { shopId },
    });
    const ignoredRuleTypes = new Set(overrides.map(o => o.ruleType));

    const filteredIssues = issues.filter(issue => !ignoredRuleTypes.has(issue.type));

    // Save ALL issues (unfiltered) to database to support immediate frontend restore toggling
    if (issues.length > 0) {
      await prisma.issue.createMany({ data: issues });
    }

    // ── 8. CALCULATE SCORES ────────────────────────────────────────────────
    const pricingIssues       = filteredIssues.filter(i => ['PRICING_ERROR', 'ABSOLUTE_PRICING_ANOMALY'].includes(i.type));
    const titleIssues         = filteredIssues.filter(i => ['INVALID_PRODUCT_TITLE', 'WEAK_PRODUCT_TITLE', 'SERIAL_PRODUCT_TITLE', 'KEYWORD_STUFFED_TITLE'].includes(i.type));
    const descIssues          = filteredIssues.filter(i => ['MISSING_DESCRIPTION', 'WEAK_DESCRIPTION', 'GENERIC_DESCRIPTION'].includes(i.type));
    const allImageIssues      = filteredIssues.filter(i => ['NO_PRODUCT_IMAGES', 'LOW_IMAGE_COUNT', 'EXCESSIVE_IMAGE_COUNT'].includes(i.type));
    const noImageIssues       = filteredIssues.filter(i => i.type === 'NO_PRODUCT_IMAGES');
    const allConsistencyIssues = filteredIssues.filter(i =>
      ['VARIANT_PRICE_GAP', 'CATALOG_INCONSISTENCY', 'HIGH_FRAGMENTATION', 'INCONSISTENT_PRICE_POSITIONING', 'COLLECTION_PRICE_OUTLIER'].includes(i.type)
    );
    const perfRiskIssues      = filteredIssues.filter(i => i.type === 'HIGH_PERFORMANCE_LOW_QUALITY');
    const criticalIssues      = filteredIssues.filter(i => i.severity === 'CRITICAL');
    const inventoryIssues     = filteredIssues.filter(i =>
      ['UNIFORM_INVENTORY', 'GHOST_LISTING', 'UNREALISTIC_INVENTORY'].includes(i.type)
    );

    const scores = {
      productDataQuality: Math.max(0,
        100
        - (pricingIssues.length * 15)
        - (titleIssues.filter(i => i.type === 'INVALID_PRODUCT_TITLE').length * 15)
        - (titleIssues.filter(i => i.type === 'WEAK_PRODUCT_TITLE').length * 5)
        - (titleIssues.filter(i => i.type === 'SERIAL_PRODUCT_TITLE').length * 8)
        - (titleIssues.filter(i => i.type === 'KEYWORD_STUFFED_TITLE').length * 4)
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
      catalogConsistency: Math.max(0, 100 
        - (allConsistencyIssues.length * 20)
        - (inventoryIssues.length * 15)
      ),
    };

    const baseReadiness = (scores.productDataQuality * 0.4) + (scores.visualTrust * 0.4) + (scores.catalogConsistency * 0.2);
    let conversionReadiness = Math.round(Math.max(0, baseReadiness - perfRiskIssues.length * 20));
    if (criticalIssues.length > 0) conversionReadiness = Math.min(conversionReadiness, 45);
    scores.conversionReadiness = conversionReadiness;

    const explanations = buildScoreExplanations(filteredIssues, scores);

    await prisma.auditRun.update({
      where: { id: auditRun.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    console.log(`✅ Phase 2 audit completed for shop ${shopId}. Found ${filteredIssues.length} issues.`);
    return { success: true, issuesCount: filteredIssues.length, auditRunId: auditRun.id, scores, explanations };

  } catch (error) {
    console.error(`❌ Audit run failed for shop ${shopId}:`, error);
    await prisma.auditRun.update({
      where: { id: auditRun.id },
      data: { status: 'FAILED', completedAt: new Date() },
    });
    throw error;
  }
}
