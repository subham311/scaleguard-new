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

    // 2. Get products for breakdown (limited by plan)
    const products = await prisma.product.findMany({
      where: { shopId: shop.id },
      include: { variants: true },
      take: plan?.maxProducts || 50,
    });

    // 3. Calculate Scores & Verdict (Fail-closed initialization)
    let scores = {
      productDataQuality: 0,
      visualTrust: 0,
      catalogConsistency: 0,
      conversionReadiness: 0,
    };

    let criticalIssuesExist = false;

    // Score explanations ("why") – populated after audit issues are loaded
    let scoreExplanations = {
      dataQuality: { explanation: 'No audit data yet. Run a sync to get your first report.' },
      visualTrust: { explanation: 'No audit data yet.' },
      consistency: { explanation: 'No audit data yet.' },
      readiness:   { explanation: 'No audit data yet.' },
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

    // Fetch active overrides
    const overrides = await prisma.merchantOverride.findMany({
      where: { shopId: shop.id },
    });
    const ignoredRuleTypes = new Set(overrides.map(o => o.ruleType));

    if (latestAudit) {
      // Recalculate scores and verdict on filtered issues dynamically
      const issues = latestAudit.issues.filter(i => !ignoredRuleTypes.has(i.type));
      criticalIssuesExist = issues.some(i => i.severity === 'CRITICAL');
      
      // Calculate deductions
      const criticalIssues = issues.filter(i => i.severity === 'CRITICAL');
      const pricingIssues = issues.filter(i => ['PRICING_ERROR', 'ABSOLUTE_PRICING_ANOMALY'].includes(i.type));
      const titleIssues = issues.filter(i => ['INVALID_PRODUCT_TITLE', 'WEAK_PRODUCT_TITLE', 'SERIAL_PRODUCT_TITLE', 'KEYWORD_STUFFED_TITLE'].includes(i.type));
      const descIssues = issues.filter(i =>
        ['MISSING_DESCRIPTION', 'WEAK_DESCRIPTION', 'GENERIC_DESCRIPTION', 'SPEC_DUMP_DESCRIPTION', 'SUPPLIER_DESCRIPTION', 'MISSING_SIZE_GUIDE', 'MISSING_PRODUCT_SPECIFICATION'].includes(i.type)
      );
      const noImageIssues = issues.filter(i => i.type === 'NO_PRODUCT_IMAGES');
      const imageIssues = issues.filter(i => ['NO_PRODUCT_IMAGES', 'LOW_IMAGE_COUNT', 'EXCESSIVE_IMAGE_COUNT', 'DUPLICATE_IMAGES', 'LIMITED_IMAGE_DIVERSITY', 'LOW_QUALITY_IMAGE', 'INCONSISTENT_PRIMARY_IMAGE', 'INCONSISTENT_STORE_VISUALS'].includes(i.type));
      const consistencyIssues = issues.filter(i =>
        ['CATALOG_INCONSISTENCY', 'HIGH_FRAGMENTATION', 'INCONSISTENT_PRICE_POSITIONING', 'VARIANT_PRICE_GAP', 'COLLECTION_PRICE_OUTLIER', 'INCOMPLETE_ORGANIZATION', 'MISSING_RECOMMENDED_METAFIELDS'].includes(i.type)
      );
      const perfRiskIssues = issues.filter(i => i.type === 'HIGH_PERFORMANCE_LOW_QUALITY');
      const inventoryIssues = issues.filter(i =>
        ['UNIFORM_INVENTORY', 'GHOST_LISTING', 'UNREALISTIC_INVENTORY'].includes(i.type)
      );
      const deadInventoryIssues = issues.filter(i => i.type === 'DEAD_INVENTORY');

      // Category Scoring (Phase 2 tiered)
      scores.productDataQuality = Math.max(0,
        100
        - (pricingIssues.length * 15)
        - (titleIssues.filter(i => i.type === 'INVALID_PRODUCT_TITLE').length * 15)
        - (titleIssues.filter(i => i.type === 'WEAK_PRODUCT_TITLE').length * 5)
        - (titleIssues.filter(i => i.type === 'SERIAL_PRODUCT_TITLE').length * 8)
        - (titleIssues.filter(i => i.type === 'KEYWORD_STUFFED_TITLE').length * 4)
        - (descIssues.filter(i => i.type === 'MISSING_DESCRIPTION').length * 10)
        - (descIssues.filter(i => i.type === 'WEAK_DESCRIPTION').length * 5)
        - (descIssues.filter(i => i.type === 'GENERIC_DESCRIPTION').length * 3)
        - (descIssues.filter(i => i.type === 'SPEC_DUMP_DESCRIPTION').length * 15)
        - (descIssues.filter(i => i.type === 'SUPPLIER_DESCRIPTION').length * 10)
        - (descIssues.filter(i => i.type === 'MISSING_SIZE_GUIDE').length * 10)
        - (descIssues.filter(i => i.type === 'MISSING_PRODUCT_SPECIFICATION').length * 5)
      );
      scores.visualTrust = Math.max(0,
        100
        - (noImageIssues.length * 30)
        - (imageIssues.filter(i => i.type === 'LOW_IMAGE_COUNT').length * 15)
        - (imageIssues.filter(i => i.type === 'EXCESSIVE_IMAGE_COUNT').length * 5)
        - (imageIssues.filter(i => i.type === 'DUPLICATE_IMAGES').length * 10)
        - (imageIssues.filter(i => i.type === 'LIMITED_IMAGE_DIVERSITY').length * 5)
        - (imageIssues.filter(i => i.type === 'LOW_QUALITY_IMAGE').length * 15)
        - (imageIssues.filter(i => i.type === 'INCONSISTENT_PRIMARY_IMAGE').length * 20)
        - (imageIssues.filter(i => i.type === 'INCONSISTENT_STORE_VISUALS').length * 5)
      );
      scores.catalogConsistency = Math.max(0, 100 
        - (consistencyIssues.length * 20)
        - (inventoryIssues.length * 15)
      );

      // Build "why" explanations for each score category
      const buildExplanation = (score, parts, goodMsg) =>
        parts.length === 0
          ? goodMsg
          : `Score reduced because ${parts.join(', and ')}.`;

      // Phase 2: Rich score explanations describing what each metric covers
      const dqParts = [
        pricingIssues.filter(i => i.type === 'PRICING_ERROR').length > 0 && `${pricingIssues.filter(i => i.type === 'PRICING_ERROR').length} variant(s) have invalid pricing`,
        pricingIssues.filter(i => i.type === 'ABSOLUTE_PRICING_ANOMALY').length > 0 && `${pricingIssues.filter(i => i.type === 'ABSOLUTE_PRICING_ANOMALY').length} variant(s) have unrealistic standalone pricing`,
        titleIssues.filter(i => i.type === 'INVALID_PRODUCT_TITLE').length > 0 && `${titleIssues.filter(i => i.type === 'INVALID_PRODUCT_TITLE').length} product(s) have unusable titles`,
        titleIssues.filter(i => i.type === 'WEAK_PRODUCT_TITLE').length > 0 && `${titleIssues.filter(i => i.type === 'WEAK_PRODUCT_TITLE').length} product(s) have weak titles`,
        titleIssues.filter(i => i.type === 'SERIAL_PRODUCT_TITLE').length > 0 && `${titleIssues.filter(i => i.type === 'SERIAL_PRODUCT_TITLE').length} product(s) have serial-like titles`,
        titleIssues.filter(i => i.type === 'KEYWORD_STUFFED_TITLE').length > 0 && `${titleIssues.filter(i => i.type === 'KEYWORD_STUFFED_TITLE').length} product(s) have keyword-stuffed titles`,
        descIssues.filter(i => i.type === 'MISSING_DESCRIPTION').length > 0 && `${descIssues.filter(i => i.type === 'MISSING_DESCRIPTION').length} product(s) are missing descriptions`,
        descIssues.filter(i => i.type === 'WEAK_DESCRIPTION').length > 0 && `${descIssues.filter(i => i.type === 'WEAK_DESCRIPTION').length} product(s) have thin descriptions`,
        descIssues.filter(i => i.type === 'GENERIC_DESCRIPTION').length > 0 && `${descIssues.filter(i => i.type === 'GENERIC_DESCRIPTION').length} product(s) have generic descriptions`,
        descIssues.filter(i => i.type === 'SPEC_DUMP_DESCRIPTION').length > 0 && `${descIssues.filter(i => i.type === 'SPEC_DUMP_DESCRIPTION').length} product(s) have spec-dump descriptions`,
        descIssues.filter(i => i.type === 'SUPPLIER_DESCRIPTION').length > 0 && `${descIssues.filter(i => i.type === 'SUPPLIER_DESCRIPTION').length} product(s) have supplier-style descriptions`,
        descIssues.filter(i => i.type === 'MISSING_SIZE_GUIDE').length > 0 && `${descIssues.filter(i => i.type === 'MISSING_SIZE_GUIDE').length} fashion product(s) are missing size guides`,
        descIssues.filter(i => i.type === 'MISSING_PRODUCT_SPECIFICATION').length > 0 && `${descIssues.filter(i => i.type === 'MISSING_PRODUCT_SPECIFICATION').length} product(s) are missing specifications`,
      ].filter(Boolean);

      const vtParts = [
        noImageIssues.length > 0 && `${noImageIssues.length} product(s) have no images at all`,
        imageIssues.filter(i => i.type === 'LOW_IMAGE_COUNT').length > 0 && `${imageIssues.filter(i => i.type === 'LOW_IMAGE_COUNT').length} product(s) have too few images`,
        imageIssues.filter(i => i.type === 'EXCESSIVE_IMAGE_COUNT').length > 0 && `${imageIssues.filter(i => i.type === 'EXCESSIVE_IMAGE_COUNT').length} product(s) have excessive image counts`,
        imageIssues.filter(i => i.type === 'DUPLICATE_IMAGES').length > 0 && `${imageIssues.filter(i => i.type === 'DUPLICATE_IMAGES').length} product(s) contain duplicate images`,
        imageIssues.filter(i => i.type === 'LIMITED_IMAGE_DIVERSITY').length > 0 && `${imageIssues.filter(i => i.type === 'LIMITED_IMAGE_DIVERSITY').length} product(s) show limited image diversity`,
        imageIssues.filter(i => i.type === 'LOW_QUALITY_IMAGE').length > 0 && `${imageIssues.filter(i => i.type === 'LOW_QUALITY_IMAGE').length} product(s) contain low-quality images`,
        imageIssues.filter(i => i.type === 'INCONSISTENT_PRIMARY_IMAGE').length > 0 && `${imageIssues.filter(i => i.type === 'INCONSISTENT_PRIMARY_IMAGE').length} product(s) have non-product primary images`,
        imageIssues.filter(i => i.type === 'INCONSISTENT_STORE_VISUALS').length > 0 && `${imageIssues.filter(i => i.type === 'INCONSISTENT_STORE_VISUALS').length} product(s) have visually inconsistent primary images`,
      ].filter(Boolean);

      const cParts = [
        consistencyIssues.find(i => i.type === 'HIGH_FRAGMENTATION') && 'catalog spans too many product types (Flea Market Risk)',
        consistencyIssues.find(i => ['COLLECTION_PRICE_OUTLIER', 'INCONSISTENT_PRICE_POSITIONING'].includes(i.type)) && 'extreme catalog price variance signals inconsistent positioning',
        consistencyIssues.find(i => ['VARIANT_PRICE_GAP', 'CATALOG_INCONSISTENCY'].includes(i.type)) && 'some products have significant variant pricing gaps',
        consistencyIssues.filter(i => i.type === 'INCOMPLETE_ORGANIZATION').length > 0 && `${consistencyIssues.filter(i => i.type === 'INCOMPLETE_ORGANIZATION').length} product(s) have incomplete vendor, tag, or type organization`,
        consistencyIssues.filter(i => i.type === 'MISSING_RECOMMENDED_METAFIELDS').length > 0 && `${consistencyIssues.filter(i => i.type === 'MISSING_RECOMMENDED_METAFIELDS').length} product(s) are missing recommended metafields`,
      ].filter(Boolean);

      const rParts = [
        inventoryIssues.length > 0 && `${inventoryIssues.length} inventory anomaly(ies) detected`,
        perfRiskIssues.length > 0 && `${perfRiskIssues.length} top-selling product(s) are missing visual trust`,
        deadInventoryIssues.length > 0 && `${deadInventoryIssues.length} product(s) have high stock but zero sales`,
      ].filter(Boolean);

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

      scoreExplanations = {
        dataQuality: {
          score: scores.productDataQuality,
          explanation: `Data Quality covers product titles, descriptions, and pricing validity. ${dqParts.length === 0 ? 'All products have valid titles, pricing, and sufficient descriptions.' : 'Score reduced because ' + dqParts.join(', and ') + '.'}`,
        },
        visualTrust: {
          score: scores.visualTrust,
          explanation: `Visual Trust covers image count, missing images, and excessive imagery. ${vtParts.length === 0 ? 'All products meet image standards for your plan.' : 'Score reduced because ' + vtParts.join(', and ') + '.'}`,
        },
        consistency: {
          score: scores.catalogConsistency,
          explanation: `Consistency covers pricing gaps between variants, inventory anomalies, and catalog coherence. ${cParts.length === 0 ? 'No fragmentation or pricing anomalies detected.' : 'Score reduced because ' + cParts.join(', and ') + '.'}`,
        },
        readiness: {
          score: scores.conversionReadiness,
          explanation: `Readiness is a combined score based on catalog quality, visual trust, pricing integrity, inventory credibility, and scaling risk. ${rParts.length === 0 ? 'No critical inventory or performance risks found.' : 'Score impacted because ' + rParts.join(', and ') + '.'}`,
        },
      };

      // Severity sort order for max-severity grouping
      const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

      // Group issues by type to avoid repeating the same issue type multiple times
      const groupedIssues = issues.reduce((acc, issue) => {
        if (!acc[issue.type]) {
          acc[issue.type] = {
            id: issue.id, // Use the first issue ID as the group ID
            type: issue.type,
            severity: issue.severity, // Start with first severity seen
            affectedEntities: new Set(issue.affectedEntities || []),
          };
        } else {
          // Combine affected entities
          (issue.affectedEntities || []).forEach(e => acc[issue.type].affectedEntities.add(e));
          // Escalate to highest severity seen across all issues of this type
          const currentRank = SEVERITY_RANK[acc[issue.type].severity] ?? 4;
          const newRank = SEVERITY_RANK[issue.severity] ?? 4;
          if (newRank < currentRank) {
            acc[issue.type].severity = issue.severity;
          }
        }
        return acc;
      }, {});

      // Map grouped issues for frontend with affected product details
      issuesList = Object.values(groupedIssues).map(issueGroup => {
        let recommendation = 'Fix this issue in your Shopify Admin.';
        let evidence = 'Detected during catalog scan.';
        
        const affectedEntitiesArray = Array.from(issueGroup.affectedEntities);

        if (issueGroup.type === 'NO_PRODUCT_IMAGES') {
          recommendation = 'This product has no visible product imagery. Do not run paid traffic to this product until images are added — customers cannot evaluate what they are buying.';
          evidence = `${affectedEntitiesArray.length} product(s) have zero images.`;
        } else if (issueGroup.type === 'LOW_IMAGE_COUNT') {
          recommendation = 'This product has too few images to build buyer confidence. Weak visual trust can reduce conversion efficiency and waste paid traffic. Add more images before running ads.';
          evidence = `${affectedEntitiesArray.length} product(s) have fewer than ${plan?.imagesPerProduct || 3} images.`;
        } else if (issueGroup.type === 'EXCESSIVE_IMAGE_COUNT') {
          recommendation = 'This product contains an unusually high number of images. Excessive or repetitive imagery may overwhelm buyers and create decision hesitation. Curate to the best 6–10 images.';
          evidence = `${affectedEntitiesArray.length} product(s) have 20 or more images.`;
        } else if (issueGroup.type === 'INVALID_PRODUCT_TITLE') {
          recommendation = 'This product title is not commercially usable. Customers may not understand what is being sold, which weakens store credibility and purchase confidence. Fix before running any traffic.';
          evidence = `${affectedEntitiesArray.length} product(s) have missing, single-character, or numeric-only titles.`;
        } else if (issueGroup.type === 'WEAK_PRODUCT_TITLE') {
          recommendation = 'This product title is too vague to support search, trust, or purchase intent. Use a clear, descriptive title that explains what the product is before running traffic.';
          evidence = `${affectedEntitiesArray.length} product(s) have titles with fewer than 3 meaningful words.`;
        } else if (issueGroup.type === 'PRICING_ERROR') {
          recommendation = 'Critical: Resolve $0 or null pricing immediately. These products are effectively unsellable and will cause checkout failures. Fix in Shopify Admin before running any ads.';
          evidence = `Found invalid pricing on ${affectedEntitiesArray.length} variant(s).`;
        } else if (issueGroup.type === 'MISSING_DESCRIPTION') {
          recommendation = 'This product has no description. Customers do not have enough information to trust the product or make a confident purchase decision. Add a full description before scaling.';
          evidence = `${affectedEntitiesArray.length} product(s) have no description text at all.`;
        } else if (issueGroup.type === 'WEAK_DESCRIPTION') {
          recommendation = 'This product description is too thin to support paid or organic traffic. Add benefits, materials, sizing, use cases, and trust-building details before scaling.';
          evidence = `${affectedEntitiesArray.length} product(s) have descriptions under 75 words.`;
        } else if (issueGroup.type === 'GENERIC_DESCRIPTION') {
          recommendation = 'This description appears generic and does not explain why the customer should buy this product from your store. Rewrite with specific product benefits and differentiators.';
          evidence = `${affectedEntitiesArray.length} product(s) have boilerplate or placeholder descriptions.`;
        } else if (issueGroup.type === 'SPEC_DUMP_DESCRIPTION') {
          recommendation = 'Why this was flagged: The description is primarily a list of specifications (materials, dimensions, etc.) without copywriting. Why it matters: Customers trust benefits and copy over raw data sheets. Impact: Weakens purchase confidence, drops conversion rate, and wastes ad spend. Recommended action: Rewrite to lead with product benefits and store differentiation, putting technical specifications at the bottom.';
          evidence = `${affectedEntitiesArray.length} product(s) have specification-only descriptions.`;
        } else if (issueGroup.type === 'SUPPLIER_DESCRIPTION') {
          recommendation = 'Why this was flagged: Contains AliExpress, Temu, or bulk-import template phrases. Why it matters: Boilerplate warnings or dropship shipping notices destroy brand authenticity. Impact: Lowers buyer trust, triggers price-shopping behavior, and lowers ROI on paid traffic. Recommended action: Strip out all template, translation, or delivery errors, and write custom branded copy.';
          evidence = `${affectedEntitiesArray.length} product(s) contain supplier boilerplate content.`;
        } else if (issueGroup.type === 'VARIANT_PRICE_GAP') {
          recommendation = 'This product has large pricing gaps between variants. This may confuse buyers or indicate a pricing setup error. Review variant pricing before running traffic.';
          evidence = `${affectedEntitiesArray.length} product(s) have variants with 3× or greater price gaps.`;
        } else if (issueGroup.type === 'CATALOG_INCONSISTENCY') {
          recommendation = 'Review pricing strategy for these items. Extreme variant price gaps often indicate errors that confuse buyers and reduce purchase confidence.';
          evidence = `${affectedEntitiesArray.length} product(s) show significant internal pricing variance.`;
        } else if (issueGroup.type === 'HIGH_PERFORMANCE_LOW_QUALITY') {
          recommendation = 'Immediate Risk: These top-selling products are missing visual trust. Fix images now to maintain conversion momentum and prevent refund risks.';
          evidence = `${affectedEntitiesArray.length} high-performing product(s) have sub-standard catalog quality.`;
        } else if (issueGroup.type === 'DEAD_INVENTORY') {
          recommendation = 'Capital Risk: High stock levels with zero sales in 60 days. Consider markdowns or clearing this inventory to free capital for better-performing items.';
          evidence = `${affectedEntitiesArray.length} stagnant product(s) are tying up warehouse capital.`;
        } else if (issueGroup.type === 'UNIFORM_INVENTORY') {
          recommendation = 'All variants share identical inventory values. This may indicate supplier-fed inventory feeds, bulk imports, or inventory levels that have not been reviewed manually.';
          evidence = `${affectedEntitiesArray.length} product(s) have 4+ variants all holding identical stock.`;
        } else if (issueGroup.type === 'UNREALISTIC_INVENTORY') {
          recommendation = 'Inventory quantity is either placeholder stock (like 999, 9999, or 10,000) or appears unusually high for a storefront. This reduces buyer trust and may look like dropshipping. Update to actual stock.';
          evidence = `${affectedEntitiesArray.length} variant(s) show placeholder or unusually high inventory.`;
        } else if (issueGroup.type === 'GHOST_LISTING') {
          recommendation = 'This product is published but not assigned to any storefront collection. Customers cannot discover it through normal browsing or navigation. Assign it to a collection or unpublish it to clean up your catalog.';
          evidence = `${affectedEntitiesArray.length} product(s) have no collection assignment.`;
        } else if (issueGroup.type === 'HIGH_FRAGMENTATION') {
          recommendation = 'Niche Coherence Risk (Flea Market Effect): Your catalog spans too many product types for its size. Buyers cannot trust what your store stands for. Consolidate or split into focused collections.';
          evidence = 'Store has fewer than 50 products but more than 8 distinct collections — signals unfocused positioning.';
        } else if (issueGroup.type === 'COLLECTION_PRICE_OUTLIER') {
          recommendation = 'This product is priced far above similar products in the same catalog. Make sure the price is intentional and supported by premium positioning — otherwise it signals a setup error.';
          evidence = 'One or more products are priced 20× or more above the median catalog price.';
        } else if (issueGroup.type === 'INCONSISTENT_PRICE_POSITIONING') {
          recommendation = 'Price Positioning Risk: Your catalog price range is wide. Buyers at the low end and high end may be completely different audiences — review whether this is intentional.';
          evidence = 'The highest-priced product is more than 10× the median catalog price.';
        } else if (issueGroup.type === 'ABSOLUTE_PRICING_ANOMALY') {
          recommendation = 'Pricing Risk: The product price is either extremely low (under £1.00) or exceeds standard sanity thresholds for its category. Review pricing in Shopify Admin to prevent margins loss or checkout conversion issues.';
          evidence = `${affectedEntitiesArray.length} variant(s) have absolute pricing anomalies.`;
        } else if (issueGroup.type === 'SERIAL_PRODUCT_TITLE') {
          recommendation = 'This product title contains excessive numeric sequences or serial-like patterns. This makes your store look like a low-quality catalog dump rather than a curated retail brand. Rewrite with readable titles.';
          evidence = 'Title carries long numeric blocks or a serial-number pattern.';
        } else if (issueGroup.type === 'KEYWORD_STUFFED_TITLE') {
          recommendation = 'This product title appears keyword-stuffed or overloaded with repetitive wording or dividers. While title length itself is fine, overloaded structures look unprofessional and reduce buyer trust. Curate for readability.';
          evidence = 'Title has repetitive words or excessive separation characters.';
        } else if (issueGroup.type === 'DUPLICATE_IMAGES') {
          recommendation = 'Why this was flagged: Identical or near-identical images exist in this product\'s gallery. Why it matters: Duplicate imagery looks cluttered and unprofessional, suggesting a lack of manual curation. Impact: Lowers buyer trust and conversion rates. Recommended action: Remove duplicate images in Shopify Admin, keeping only unique angles/perspectives.';
          evidence = `${affectedEntitiesArray.length} product(s) have duplicate images.`;
        } else if (issueGroup.type === 'LIMITED_IMAGE_DIVERSITY') {
          recommendation = 'Why this was flagged: Multiple images provide little visual variation. Why it matters: Buyers expect to see alternative angles, detail close-ups, or lifestyle contexts. Impact: Limited diversity creates purchasing hesitation. Recommended action: Add diverse product shots (lifestyle, zoom, packaging, sizing context) to build visual trust.';
          evidence = `${affectedEntitiesArray.length} product(s) show limited image diversity.`;
        } else if (issueGroup.type === 'LOW_QUALITY_IMAGE') {
          recommendation = 'Why this was flagged: Pixelated, blurry, or low-resolution images detected. Why it matters: High-resolution imagery is the single most critical factor for online purchase decisions. Impact: Lowers conversion rates, increases returns risk, and ruins advertising efficiency. Recommended action: Replace with high-quality images (at least 800x800 px) in Shopify Admin.';
          evidence = `${affectedEntitiesArray.length} product(s) contain blurry or low-resolution images.`;
        } else if (issueGroup.type === 'INCONSISTENT_PRIMARY_IMAGE') {
          recommendation = 'Why this was flagged: Primary image represents a size chart, packaging, or placeholder instead of the product. Why it matters: The primary image is the first visual buyers see in collection lists and advertisements. Impact: Drives immediate bounce rates and drops click-through rates. Recommended action: Re-order product images so the actual product photo is at position 1.';
          evidence = `${affectedEntitiesArray.length} product(s) have non-product primary images.`;
        } else if (issueGroup.type === 'INCONSISTENT_STORE_VISUALS') {
          recommendation = 'Why this was flagged: Product\'s primary image aspect ratio is visually inconsistent with the store catalog standard. Why it matters: Visual uniformity across collection grids provides a premium, curated feel. Impact: Aspect ratio mismatch makes the store look cluttered and untrustworthy. Recommended action: Crop or edit product primary images to match the store\'s dominant aspect ratio.';
          evidence = `${affectedEntitiesArray.length} product(s) have visually inconsistent primary images.`;
        } else if (issueGroup.type === 'MISSING_SIZE_GUIDE') {
          recommendation = 'Why this was flagged: Sizing chart, measurements, or sizing guidance could not be found for this fashion or apparel product. Why it matters: Sizing uncertainty is the #1 reason for clothing returns and abandoned checkouts. Impact: Increases sizing support inquiries, reduces conversion rate, and raises merchant refund rates. Recommended action: Add a sizing chart image or text measurements table to the product description in Shopify Admin.';
          evidence = `${affectedEntitiesArray.length} apparel/footwear product(s) are missing size guides.`;
        } else if (issueGroup.type === 'MISSING_PRODUCT_SPECIFICATION') {
          recommendation = 'Why this was flagged: Material details, item dimensions, or technical specifications are missing from the product details. Why it matters: Buyers require raw specifications (materials, size measurements, package inclusions) to verify fit and quality. Impact: Lowers conversion rates due to unanswered buyer questions. Recommended action: Add clear specifications (e.g. \'Material: 100% Cotton\') to the product description.';
          evidence = `${affectedEntitiesArray.length} product(s) have no dimensions, materials, or specifications.`;
        } else if (issueGroup.type === 'INCOMPLETE_ORGANIZATION') {
          recommendation = 'Why this was flagged: This product is missing basic catalog categorization data (vendor, tags, type, or collection assignment). Why it matters: Buyers use filters, search queries, and collection pages to browse catalogs. Impact: Weak organization results in poor search findability and broken navigation menus. Recommended action: In Shopify Admin, assign a product type, vendor, and tags, and add it to at least one collection.';
          evidence = `${affectedEntitiesArray.length} product(s) have incomplete vendor, type, tag, or collection metadata.`;
        } else if (issueGroup.type === 'MISSING_RECOMMENDED_METAFIELDS') {
          recommendation = 'Why this was flagged: Multiple standard merchandising metafields (color, material, fabric, age group, or product features) are not defined. Why it matters: Detailed attributes power shopping comparison features and search index indexing. Impact: Reduces faceted search visibility and drops customer click-through. Recommended action: Add detailed color, material, age group/gender, and feature specifications to the product information.';
          evidence = `${affectedEntitiesArray.length} product(s) are missing recommended metafield attributes (fabric, color, age group, features).`;
        }

        // Get affected products with id, shopifyId, and title for deep-linking
        const items = products
          .filter(p => 
            affectedEntitiesArray.includes(p.shopifyId) || 
            (p.variants && p.variants.some(v => affectedEntitiesArray.includes(v.shopifyId)))
          )
          .map(p => ({ id: p.id, shopifyId: p.shopifyId, title: p.title }));

        // Sort severity: CRITICAL > HIGH > MEDIUM > LOW
        const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

        return {
          id: issueGroup.id,
          type: issueGroup.type.replace(/_/g, ' '),
          rawType: issueGroup.type,
          severity: issueGroup.severity,
          recommendation,
          evidence,
          affectedCount: items.length, // More accurate than affectedEntitiesArray.length
          items,
          // keep legacy field for compatibility
          affectedProductTitles: items.map(p => p.title),
        };
      }).filter(issue => issue.items && issue.items.length > 0)
      .sort((a, b) => {
        const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        const sA = SEVERITY_ORDER[a.severity?.toUpperCase()] ?? 4;
        const sB = SEVERITY_ORDER[b.severity?.toUpperCase()] ?? 4;
        if (sA !== sB) return sA - sB;
        return (b.affectedCount || 0) - (a.affectedCount || 0);
      });

      // Map product breakdown (all products with their issues)
      productBreakdown = products.map(p => {
        const productIssues = issues.filter(i => 
          (i.affectedEntities && i.affectedEntities.includes(p.shopifyId)) ||
          (p.variants && p.variants.some(v => i.affectedEntities && i.affectedEntities.includes(v.shopifyId)))
        );
        
        return {
          id: p.id,
          title: p.title,
          issueType: productIssues.length > 0 ? productIssues[0].type.replace(/_/g, ' ') : 'Healthy',
          severity: productIssues.length > 0 ? productIssues[0].severity : 'NONE',
          descriptionQualityScore: p.descriptionQualityScore || 0,
          completenessScore: p.completenessScore || 0,
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

    // Fetch latest manual or scheduled sync/audit jobs to get sync state
    const latestJob = await prisma.job.findFirst({
      where: {
        shopId: shop.id,
        jobType: { in: ['DATA_SYNC', 'AUDIT_RUN'] },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const planName = subscription?.pricingPlan?.name?.toUpperCase() 
      || subscription?.plan?.toUpperCase() 
      || 'LIGHT';

    const PLAN_LIMITS = {
      LIGHT: { maxProducts: 20, imagesPerProduct: 2, scanFrequency: 'Weekly' },
      GROWTH: { maxProducts: 75, imagesPerProduct: 3, scanFrequency: 'Daily' },
      PRO: { maxProducts: 200, imagesPerProduct: 4, scanFrequency: 'Every 3 Hours' }
    };
    const defaultLimits = PLAN_LIMITS[planName] || PLAN_LIMITS.LIGHT;

    let cooldownMs = 24 * 60 * 60 * 1000;
    if (planName === 'PRO') cooldownMs = 3 * 60 * 60 * 1000; // 3 hours
    else if (planName === 'GROWTH') cooldownMs = 8 * 60 * 60 * 1000;

    const lastSync = await prisma.job.findFirst({
      where: {
        shopId: shop.id,
        jobType: 'DATA_SYNC',
        status: 'COMPLETED',
      },
      orderBy: {
        completedAt: 'desc',
      },
    });

    let nextSyncAvailableAt = null;
    let isCooldownActive = false;
    let cooldownRemainingMs = 0;

    if (lastSync && lastSync.completedAt) {
      const elapsed = Date.now() - new Date(lastSync.completedAt).getTime();
      if (elapsed < cooldownMs) {
        nextSyncAvailableAt = new Date(new Date(lastSync.completedAt).getTime() + cooldownMs).toISOString();
        isCooldownActive = true;
        cooldownRemainingMs = cooldownMs - elapsed;
      }
    }

    // Plan details for dashboard visibility
    const planDetails = {
      plan: planName,
      maxProducts: plan?.maxProducts || defaultLimits.maxProducts,
      imagesPerProduct: plan?.imagesPerProduct || defaultLimits.imagesPerProduct,
      productsAnalyzed: products.length,
      scanFrequency: planName === 'PRO' ? 'Every 3 Hours' : planName === 'GROWTH' ? 'Daily' : 'Weekly',
      nextSyncAvailableAt,
      isCooldownActive,
      cooldownRemainingMs,
      latestJob: latestJob ? {
        id: latestJob.id,
        jobType: latestJob.jobType,
        status: latestJob.status,
        createdAt: latestJob.createdAt,
        startedAt: latestJob.startedAt,
        completedAt: latestJob.completedAt,
        error: latestJob.error,
      } : null,
    };

    res.json({
      shop: {
        id: shop.id,
        domain: shop.shopDomain,
        dataCollectedAt: shop.dataCollectedAt,
        totalProductsCount: shop.totalProductsCount || 0,
      },
      subscription: subscription || null,
      verdict: latestAudit ? verdict : 'Waiting for Sync',
      storeRecommendation: latestAudit ? storeRecommendation : 'Initial audit required to determine readiness.',
      isDataSufficient,
      dataIssues,
      scores: latestAudit ? scores : null,
      scoreExplanations: latestAudit ? scoreExplanations : null,
      issues: issuesList,
      products: productBreakdown,
      plan: planDetails.plan,
      planDetails,
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

// Get all merchant overrides
router.get('/overrides', authenticateFlexible, async (req, res) => {
  try {
    const shop = req.shop;
    const overrides = await prisma.merchantOverride.findMany({
      where: { shopId: shop.id },
    });
    res.json({ success: true, overrides });
  } catch (error) {
    console.error('Get overrides error:', error);
    res.status(500).json({ error: 'Failed to get overrides' });
  }
});

// Toggle a merchant override
router.post('/overrides', authenticateFlexible, async (req, res) => {
  try {
    const shop = req.shop;
    const { ruleType, isIgnored } = req.body;

    if (!ruleType) {
      return res.status(400).json({ error: 'ruleType is required' });
    }

    const ALLOWED_OVERRIDES = ['UNREALISTIC_INVENTORY', 'UNIFORM_INVENTORY'];
    if (!ALLOWED_OVERRIDES.includes(ruleType)) {
      return res.status(403).json({ error: 'This rule type cannot be overridden.' });
    }

    if (isIgnored) {
      // Create override
      await prisma.merchantOverride.upsert({
        where: {
          shopId_ruleType: {
            shopId: shop.id,
            ruleType: ruleType,
          },
        },
        create: {
          shopId: shop.id,
          ruleType: ruleType,
        },
        update: {},
      });
    } else {
      // Remove override
      await prisma.merchantOverride.deleteMany({
        where: {
          shopId: shop.id,
          ruleType: ruleType,
        },
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Toggle override error:', error);
    res.status(500).json({ error: 'Failed to toggle override' });
  }
});



export default router;

