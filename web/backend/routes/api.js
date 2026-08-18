import express from 'express';
import prisma from '../config/database.js';
import { authenticateShop } from '../middleware/auth.js';
import { authenticateFlexible } from '../middleware/sessionToken.js';
import { sendSupportEmail } from '../services/emailService.js';

const router = express.Router();
const REVIEW_BYPASS_SHOPS = new Set(['daf2cb-2.myshopify.com']);

// Helper to check if a domain has extended trial approval (via .env or hardcoded list)
function isExtendedTrialDomain(shopDomain) {
  if (!shopDomain) return false;
  const domain = String(shopDomain).toLowerCase();
  const envDomains = (process.env.TRIAL_EXTENDED_DOMAINS || '')
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);
  return envDomains.includes(domain);
}

function isReviewBypassShop(shopDomain) {
  if (!shopDomain) return false;
  return REVIEW_BYPASS_SHOPS.has(String(shopDomain).toLowerCase());
}

const RECOMMENDATION_TEMPLATES = {
  NO_PRODUCT_IMAGES: {
    why: "The product has no images in its gallery.",
    matters: "Customers cannot evaluate the product visually before buying.",
    trust: "Presents a high risk of being a scam or low-quality listing.",
    conversion: "Prevents any sales as checkout conversion is near zero without visuals.",
    paid: "Running ads to image-less products completely wastes ad budget.",
    action: "Upload at least 3 unique, high-resolution product photos in Shopify Admin."
  },
  LOW_IMAGE_COUNT: {
    why: "Product has too few images to build buyer confidence.",
    matters: "Buyers expect to see alternative angles, detail close-ups, or lifestyle contexts before committing to a purchase.",
    trust: "Weakens perceived store curation and professionalism — buyers associate low image count with uncurated dropshipping stores.",
    conversion: "Reduces conversion rates significantly as customers feel they don't have the full picture of what they're buying.",
    paid: "Lowers return on ad spend (ROAS) on social media campaigns where visual variety drives higher engagement.",
    action: "Add more product images to build buyer confidence. Include: different product angles (front, back, side), close-up detail shots showing texture and material quality, fit or scale images showing the product in context, lifestyle images showing the product being used, packaging images showing what the customer will receive, and material or fabric close-ups where relevant. If you do not have enough product photos, consider using AI image tools to create cleaner lifestyle or presentation images based on the real product — but make sure the images accurately represent what the customer will receive."
  },
  EXCESSIVE_IMAGE_COUNT: {
    why: "Product contains an unusually high number of images (20+).",
    matters: "Repetitive or bloated galleries overwhelm shoppers and slow down page loading.",
    trust: "Looks like an uncurated supplier bulk-import.",
    conversion: "Triggers decision fatigue and cart abandonment.",
    paid: "Increases bounce rate on paid traffic landings due to slow load speed.",
    action: "Curate the gallery down to the best 6-12 unique, high-quality images."
  },
  INVALID_PRODUCT_TITLE: {
    why: "Title is missing, single-character, or numeric/code-only.",
    matters: "Customers cannot understand what product is actually being sold.",
    trust: "Signals a broken storefront structure or low-quality automated imports.",
    conversion: "Blocks checkout conversions due to absolute confusion.",
    paid: "Ads will be rejected or perform poorly due to unreadable title copy.",
    action: "Add a clear, human-readable product title in your Shopify Admin."
  },
  WEAK_PRODUCT_TITLE: {
    why: "Title is too short or vague (under 3 meaningful words).",
    matters: "Does not provide enough context about the product features or type.",
    trust: "Reduces storefront professional appeal.",
    conversion: "Lowers buyer purchase intent and internal search matching.",
    paid: "Decreases paid search ad click-through rates.",
    action: "Expand the title with descriptive details such as category, material, or fit."
  },
  PRICING_ERROR: {
    why: "Product price is £0.00, negative, or not defined.",
    matters: "Makes the product unsellable or leads to checkout errors.",
    trust: "Creates a high-risk perception of a glitchy or fake storefront.",
    conversion: "Blocks all purchase conversions entirely.",
    paid: "Wastes ad spend due to immediate check-out bounces.",
    action: "Assign a valid, realistic price in Shopify Admin before launching traffic."
  },
  MISSING_DESCRIPTION: {
    why: "The description is completely empty.",
    matters: "Buyers have zero text context to understand features or fit.",
    trust: "Signals a lazy or incomplete storefront.",
    conversion: "Forces customers to look elsewhere for product details, dropping conversion.",
    paid: "Lowers ad relevance scores and organic SEO visibility.",
    action: "Write a complete description detailing product features, benefits, and specifications."
  },
  WEAK_DESCRIPTION: {
    why: "Description is too thin (under 75 words) and does not provide enough information for a confident purchase decision.",
    matters: "Buyers need detailed product information to understand what they are buying and feel confident before checkout.",
    trust: "Thin descriptions signal a lazy or uncurated storefront, reducing buyer trust and brand authority.",
    conversion: "Creates buyer hesitation and lowers product checkout rates — buyers seek out competitors with better information.",
    paid: "Reduces advertising ROI because paid traffic lands on a page that cannot close the sale.",
    action: "Add more useful product information to build buyer confidence. Your description should include: the material and fabric composition, fit and sizing guidance (how does it fit — true to size, runs large, slim fit?), key customer benefits and what problems the product solves, specific use cases and occasions the product is suited for, care instructions (washing, maintenance, storage), trust-building details (quality guarantees, craftsmanship notes, brand values), and what makes this product different from cheaper alternatives. The description should help the customer understand the product clearly and feel confident before buying."
  },
  GENERIC_DESCRIPTION: {
    why: "Description consists of boilerplate or placeholder text.",
    matters: "Fails to differentiate your product or store from competitors.",
    trust: "Resembles unoriginal dropshipping template storefronts.",
    conversion: "Reduces customer excitement and purchase intent.",
    paid: "Diminishes ad conversion rate and ROAS.",
    action: "Rewrite the description to highlight your unique brand value and product benefits."
  },
  SPEC_DUMP_DESCRIPTION: {
    why: "Description is primarily a raw list of technical specifications.",
    matters: "Lacks benefit-focused copywriting or purchase reassurance.",
    trust: "Suggests a factory-direct import rather than a curated consumer brand.",
    conversion: "Reduces conversion because it doesn't emotionalize the purchase.",
    paid: "Ad traffic bounces quickly from specification-heavy detail sheets.",
    action: "Rewrite the description to lead with key benefits, moving specs to the bottom."
  },
  SUPPLIER_DESCRIPTION: {
    why: "Contains dropship boilerplate phrases, Temu/AliExpress shipping templates, or translation errors.",
    matters: "Clearly reveals dropshipping model markers to customers.",
    trust: "Immediately damages storefront trust and brand authenticity.",
    conversion: "Lowers checkout conversion by triggering price-comparison behavior.",
    paid: "Severely drops ROI on search and social advertising.",
    action: "Remove all dropship boilerplate text and replace with curated branded copy."
  },
  REPETITIVE_GENERIC_DESCRIPTION: {
    why: "Description uses repetitive headings, boilerplate templates, or stuffs the product title repeatedly.",
    matters: "Repetitive AI/template-style content signals a lack of original brand creation.",
    trust: "Reduces store legitimacy, making it look like a mass-generated template site.",
    conversion: "Deters shoppers seeking genuine product details or sizing advice.",
    paid: "Decreases paid campaign ROI and conversion rates.",
    action: "Rewrite the description to use diverse phrasing, natural headings, and highlight actual product advantages."
  },
  VARIANT_PRICE_GAP: {
    why: "Significant pricing discrepancies (3x or greater) exist between product variants.",
    matters: "Creates unexpected price surges at checkout selection.",
    trust: "Triggers pricing bait-and-switch suspicion.",
    conversion: "Leads to cart abandonment when variant prices jump.",
    paid: "Increases bounce rate from ad landings due to checkout sticker shock.",
    action: "Review variant prices in Shopify Admin and align to consistent thresholds."
  },
  CATALOG_INCONSISTENCY: {
    why: "Product pricing structures differ significantly within the same line.",
    matters: "Creates brand pricing coherence for the merchant catalog.",
    trust: "Triggers merchant credibility doubts.",
    conversion: "Confuses buyers, reducing overall catalog browse conversion.",
    paid: "Hurts ad retargeting efficiency due to inconsistent pricing signals.",
    action: "Review catalog pricing structure and apply uniform pricing brackets."
  },
  HIGH_PERFORMANCE_LOW_QUALITY: {
    why: "Stellar-performing products are missing basic image curation or metadata.",
    matters: "Traffic is being sent to sub-optimal listing layouts.",
    trust: "Wastes organic and paid traction on low-trust visuals.",
    conversion: "Limits conversion potential on your most popular products.",
    paid: "Suppresses overall ad conversion rates.",
    action: "Prioritize adding rich image galleries and complete metadata for top-sellers."
  },
  DEAD_INVENTORY: {
    why: "High stock levels are recorded for products with zero sales in 60 days.",
    matters: "Merchant capital and storage spaces are tied up in non-performing stock.",
    trust: "Signals stale or out-of-date product catalogs.",
    conversion: "Unsold stock creates catalog bloat and distracts buyers.",
    paid: "Wastes remarketing focus on low-interest items.",
    action: "Run promotional discount campaigns or bundles to clear stagnant stock."
  },
  UNIFORM_INVENTORY: {
    why: "All variants share identical high inventory values (e.g. 100, 1000).",
    matters: "Indicates automated supplier-fed listings rather than manual inventory management.",
    trust: "Triggers dropshipping template storefront perception.",
    conversion: "Lowers urgency factors (e.g., 'only 2 left' notifications look fake).",
    paid: "Reduces conversion value from paid campaigns.",
    action: "Update inventory levels to actual manual counts in Shopify Admin."
  },
  UNREALISTIC_INVENTORY: {
    why: "Inventory quantity is set to massive placeholders (like 999 or 10,000).",
    matters: "Placeholder values signal automated bulk-import templates.",
    trust: "Undermines store credibility and reveals supplier dependency.",
    conversion: "Weakens customer trust in stock availability.",
    paid: "Ad traffic converts poorly due to dropship cues.",
    action: "Adjust variant stock counts to realistic, curated storefront quantities."
  },
  GHOST_LISTING: {
    why: "Product is active/published but not assigned to any storefront collections.",
    matters: "Customers cannot find the product through normal navigation menus.",
    trust: "Creates orphaned, uncurated page sections.",
    conversion: "Prevents organic sales conversion due to poor browse visibility.",
    paid: "Paid traffic landing pages work, but organic cross-sells fail.",
    action: "Assign the product to at least one active collection in Shopify Admin."
  },
  HIGH_FRAGMENTATION: {
    why: "Catalog spans too many distinct collections compared to total product count.",
    matters: "Creates a scattered, unfocused 'flea market' catalog structure.",
    trust: "Confuses buyers about the store's niche and credibility.",
    conversion: "Dilutes page browsing depth and cross-sell conversions.",
    paid: "Reduces average order value (AOV) from ad landing funnels.",
    action: "Consolidate products into fewer, high-relevance collections."
  },
  COLLECTION_PRICE_OUTLIER: {
    why: "Product is priced 20x or more above the median catalog price.",
    matters: "Extreme pricing range signals setup errors or lack of catalog focus.",
    trust: "Undermines brand premium authenticity.",
    conversion: "Disrupts buyer price expectations and slows checkout rates.",
    paid: "paid traffic segments are misaligned with catalog pricing.",
    action: "Review catalog price tiers and verify target audience alignment."
  },
  INCONSISTENT_PRICE_POSITIONING: {
    why: "Pricing ranges are widely dispersed (10x difference from median).",
    matters: "Signals conflicting brand positions (budget vs. luxury).",
    trust: "Confuses customers about store branding and target audience.",
    conversion: "Dilutes cart conversion rates due to inconsistent pricing cues.",
    paid: "Wastes ad spend due to mismatch between ad promise and catalog range.",
    action: "Align products to a unified pricing standard representing your brand."
  },
  ABSOLUTE_PRICING_ANOMALY: {
    why: "Pricing is extremely low or exceeds realistic brackets for its type.",
    matters: "Signals pricing entry typos or setup errors.",
    trust: "Merchants look unprofessional or suspicious.",
    conversion: "Cart checkouts bounce due to lack of pricing logic.",
    paid: "Causes high bounce rates on product details pages.",
    action: "Update pricing to standard market ranges in Shopify Admin."
  },
  SERIAL_PRODUCT_TITLE: {
    why: "Title carries long numeric sequences or serial-number patterns.",
    matters: "Indicates automated supplier bulk imports without editorial curation.",
    trust: "Resembles low-quality, untrustworthy supplier databases.",
    conversion: "Damages buyer purchase interest and title readability.",
    paid: "Decreases click-through rate (CTR) on paid marketing campaigns.",
    action: "Rewrite title to be reader-friendly, moving code models to specifications."
  },
  KEYWORD_STUFFED_TITLE: {
    why: "Title is overloaded with repetitive words or divider characters.",
    matters: "Looks spammy and unprofessional to prospective buyers.",
    trust: "Reduces perceived brand quality and curation.",
    conversion: "Repels buyers due to cluttered and confusing naming conventions.",
    paid: "Triggers ad network policy rejections for keyword stuffing.",
    action: "Clean up the product title for human readability, focusing on a single product name."
  },
  DUPLICATE_IMAGES: {
    why: "Near-identical or exact duplicate images exist in the product gallery.",
    matters: "Bloats the gallery without adding alternative visual details.",
    trust: "Displays poor manual review and curation habits.",
    conversion: "Triggers customer browsing fatigue and distraction.",
    paid: "Wastes paid landing impressions on repetitive visual assets.",
    action: "Delete duplicate image entries from the product in Shopify Admin."
  },
  LIMITED_IMAGE_DIVERSITY: {
    why: "Images have minimal variation (same angle, zoom level, or setup).",
    matters: "Does not help the buyer evaluate fit, scale, or texture.",
    trust: "Reduces visual credibility and listing quality.",
    conversion: "Increases purchasing friction and returns frequency.",
    paid: "Hurts shopping campaign conversions.",
    action: "Add varied visual assets (lifestyle, close-up, packaging, scale context)."
  },
  LOW_QUALITY_IMAGE: {
    why: "blurry, pixelated, or low-resolution images are present.",
    matters: "Visuals are the single most critical factor in online commerce.",
    trust: "Creates immediate buyer suspicion of a low-quality or scam store.",
    conversion: "Drops listing conversion rate and increases customer support questions.",
    paid: "Drastically lowers Return on Ad Spend (ROAS).",
    action: "Replace low-resolution imagery with clear photos (minimum 800x800 px)."
  },
  BELOW_RECOMMENDED_RESOLUTION: {
    why: "Images are clear, but below the recommended 800x800px standard.",
    matters: "Recommended resolution ensures detail zoom features function cleanly for storefront shoppers.",
    trust: "Restricts professional presentation quality on high-resolution displays.",
    conversion: "Reduces conversion when customers cannot zoom in to inspect details.",
    paid: "Fails to maximize Return on Ad Spend (ROAS) on visual channels.",
    action: "Upload high-definition product photography of at least 800x800 px."
  },
  POOR_PRESENTATION: {
    why: "Images show poor composition, awkward cropping, or supplier-style filenames.",
    matters: "Merchandising requires clean, intentional presentation to look like a premium boutique.",
    trust: "Supplier filenames and awkward visual crops reveal low-cost import roots.",
    conversion: "Reduces storefront conversion rates.",
    paid: "Hurts CTR and conversion on visual ad networks.",
    action: "Rename image files to SEO-friendly descriptive names and crop/compose imagery professionally."
  },
  INCONSISTENT_PRIMARY_IMAGE: {
    why: "Primary image is a size guide, box packaging, or placeholder.",
    matters: "The first image is what displays in catalog lists and advertisements.",
    trust: "Reduces store professional layout appeal.",
    conversion: "Bounces collection page searchers immediately.",
    paid: "Triggers low click-through rates (CTR) on social media ads.",
    action: "Re-arrange product media so the clear product photo is in position 1."
  },
  INCONSISTENT_STORE_VISUALS: {
    why: "Product primary image aspect ratio conflicts with dominant store catalog standard.",
    matters: "Visual mismatch ruins catalog collection grids.",
    trust: "Reduces store curated design feel.",
    conversion: "Creates visual friction while browsing categories.",
    paid: "Lowers general browsing conversions.",
    action: "Crop or pad images to match the store's standard ratio (e.g. 1:1)."
  },
  MISSING_SIZE_GUIDE: {
    why: "Size charts or measurements are missing for apparel or footwear.",
    matters: "Sizing concerns are the #1 driver of checkout hesitation and returns.",
    trust: "Signals lack of standard fashion merchandising detail.",
    conversion: "Causes checkout abandonment due to sizing uncertainty.",
    paid: "Ad clicks fail to convert because buyers are unsure of fit.",
    action: "Add a sizing table image or text chart to the description."
  },
  MISSING_PRODUCT_SPECIFICATION: {
    why: "Technical details, dimensions, or materials are missing.",
    matters: "Buyers need specifications to verify suitability and fit.",
    trust: "Reduces listing completeness and product authority.",
    conversion: "Causes buyers to search elsewhere for product specs.",
    paid: "Lowers ad conversion rates.",
    action: "Add standard specs (e.g. materials, sizing, dimensions) to the description."
  },
  INCOMPLETE_ORGANIZATION: {
    why: "Product is missing basic type, vendor, tags, or collections.",
    matters: "Breaks automated search catalog indexes and filters.",
    trust: "Makes the catalog feel unorganized and hard to navigate.",
    conversion: "Prevents search page matching, lowering general conversions.",
    paid: "Paid traffic landing pages work, but category browsing fails.",
    action: "Fill in product type, vendor, and tags in Shopify Admin."
  },
  MISSING_RECOMMENDED_METAFIELDS: {
    why: " merchandising metafields (color, material, fabric, age) are undefined.",
    matters: "Fails to support search filter widgets or comparison listings.",
    trust: "Lowers product authority and technical completeness.",
    conversion: "Decreases product search discoverability.",
    paid: "Lowers conversion rate for shopping comparison platforms.",
    action: "Define Shopify standard metafields for colors, materials, and features."
  },
  DELIVERY_RISK_CRITICAL: {
    why: "Delivery timeline estimate is extremely long (over 21 days) or overseas dropshipping is combined with poor tracking communication.",
    matters: "Slow delivery times trigger payment disputes, order cancellations, chargeback risk, and severely reduce customer trust.",
    trust: "Destroys merchant authenticity and signals a low-trust overseas supplier model to customers.",
    conversion: "Drops checkout conversion significantly and raises support inquiry and refund rates.",
    paid: "Drastically lowers ROAS — paid traffic that converts to frustrated customers damages your long-term ad account performance.",
    action: "Offer local warehouse fulfillment where possible, or add explicit delivery/tracking notifications and a clear shipping timeline policy on the product page. If long delivery is an intentional part of your business model (dropshipping, made-to-order, or handmade products), make the shipping timeline very clear before purchase to reduce refunds, chargebacks and customer complaints. Note: Long delivery times are often associated with low-trust dropshipping experiences — even if excluded from the health score, ScaleGuard will continue to show an advisory reminder for this risk.",
    advisory: "Long delivery times are often associated with low-trust dropshipping experiences, especially when products appear generic or supplier-sourced. Even if this issue is acknowledged as intentional, make the shipping timeline very clear before purchase to reduce refunds, chargebacks and customer complaints."
  },
  DELIVERY_RISK_HIGH: {
    why: "Delivery timeline is slow (15-21 days) and lacks clear tracking reassurance.",
    matters: "Buyers expect fast or highly visible delivery details.",
    trust: "Raises dropshipping suspicion and buyer hesitation.",
    conversion: "Lowers checkout conversion rate.",
    paid: "Reduces advertising conversion efficiency.",
    action: "Shorten shipping times or add tracking policy reassurance to the page."
  },
  DELIVERY_RISK_MEDIUM: {
    why: "Delivery estimate is moderate (10-14 days) or locally shipped but missing detailed delivery policy copy.",
    matters: "Moderate waiting times require reassuring copy to convert.",
    trust: "May prompt cart abandonment due to shipping uncertainty.",
    conversion: "Increases support inquiry rate and cart bounce rate.",
    paid: "Restricts full advertising ROI conversion.",
    action: "Add a clear shipping timelines policy block to the description."
  },
  DELIVERY_RISK_LOW: {
    why: "Fast delivery estimate (<=9 days) with clear shipping expectations.",
    matters: "Fast shipping is a major sales driver.",
    trust: "Builds buyer confidence and repeat customers.",
    conversion: "Improves checkout conversion rates.",
    paid: "Boosts ROI on paid advertising.",
    action: "Highlight fast delivery badges on the storefront."
  },
  LONG_DELIVERY_NO_COMM: {
    why: "Shipping timeline exceeds 10 days but the product page has no clear tracking or delivery expectation information for the customer.",
    matters: "Vague shipping details combined with long delivery times are one of the primary triggers for customer disputes, refund requests, and chargebacks.",
    trust: "Creates buyer anxiety and significantly increases the risk of chargebacks, negative reviews, and loss of future purchases.",
    conversion: "Causes checkout hesitation and shopping cart abandonment — buyers want to know when their order will arrive before committing.",
    paid: "Reduces conversion value from shopping and social ads — paid traffic that doesn't convert due to delivery uncertainty wastes your budget.",
    action: "Add a clear shipping timeline, tracking information policy, and delivery expectation block to the product description or page. Let customers know: when the order will be dispatched, estimated arrival timeframe, whether tracking is provided, and what to do if there is a delay. Clear communication about long delivery times dramatically reduces support requests and chargebacks."
  },
  CATALOG_DUMP_RISK: {
    why: "Catalog has high rate of unpolished titles, descriptions, and placeholder inventories.",
    matters: "Bulk-dumped directories look like untrustworthy dropship templates.",
    trust: "Destroys consumer trust and brand credibility.",
    conversion: "Wastes marketing traffic and drops checkout conversions.",
    paid: "Drastically lowers Return on Ad Spend (ROAS).",
    action: "Curate titles for readability, rewrite generic descriptions, and assign collections/tags."
  }
};

// ── Merchant-friendly display names ──────────────────────────────────────────
const DISPLAY_NAMES = {
  NO_PRODUCT_IMAGES:                'No Product Images',
  LOW_IMAGE_COUNT:                  'Insufficient Product Images',
  EXCESSIVE_IMAGE_COUNT:            'Excessive Image Count',
  INVALID_PRODUCT_TITLE:            'Invalid Product Title',
  WEAK_PRODUCT_TITLE:               'Weak Product Title',
  SERIAL_PRODUCT_TITLE:             'Serial / Code-Based Title',
  KEYWORD_STUFFED_TITLE:            'Keyword-Stuffed Title',
  PRICING_ERROR:                    'Invalid Pricing',
  ABSOLUTE_PRICING_ANOMALY:         'Pricing Anomaly',
  MISSING_DESCRIPTION:              'Missing Description',
  WEAK_DESCRIPTION:                 'Thin Description',
  GENERIC_DESCRIPTION:              'Generic Description',
  SPEC_DUMP_DESCRIPTION:            'Specification-Only Description',
  SUPPLIER_DESCRIPTION:             'Supplier-Style Description',
  REPETITIVE_GENERIC_DESCRIPTION:   'Repetitive / Template Description',
  VARIANT_PRICE_GAP:                'Variant Price Gap',
  CATALOG_INCONSISTENCY:            'Catalog Price Inconsistency',
  HIGH_PERFORMANCE_LOW_QUALITY:     'Top Seller Missing Visual Trust',
  DEAD_INVENTORY:                   'Dead Inventory',
  UNIFORM_INVENTORY:                'Uniform Inventory (Dropship Signal)',
  UNREALISTIC_INVENTORY:            'Unrealistic Inventory',
  GHOST_LISTING:                    'Ghost Listing (No Collection)',
  HIGH_FRAGMENTATION:               'Catalog Fragmentation (Flea Market Risk)',
  COLLECTION_PRICE_OUTLIER:         'Collection Price Outlier',
  INCONSISTENT_PRICE_POSITIONING:   'Inconsistent Price Positioning',
  DUPLICATE_IMAGES:                 'Duplicate Images',
  LIMITED_IMAGE_DIVERSITY:          'Limited Image Diversity',
  LOW_QUALITY_IMAGE:                'Low Quality Images',
  BELOW_RECOMMENDED_RESOLUTION:     'Below Recommended Image Resolution',
  POOR_PRESENTATION:                'Poor Product Presentation',
  INCONSISTENT_PRIMARY_IMAGE:       'Inconsistent Primary Image',
  INCONSISTENT_STORE_VISUALS:       'Inconsistent Store Visuals',
  MISSING_SIZE_GUIDE:               'Missing Size Guide',
  MISSING_PRODUCT_SPECIFICATION:    'Missing Product Specifications',
  INCOMPLETE_ORGANIZATION:          'Incomplete Product Organization',
  MISSING_RECOMMENDED_METAFIELDS:   'Missing Recommended Attributes',
  DELIVERY_RISK_CRITICAL:           'Critical Delivery Risk',
  DELIVERY_RISK_HIGH:               'High Delivery Risk',
  DELIVERY_RISK_MEDIUM:             'Moderate Delivery Risk',
  DELIVERY_RISK_LOW:                'Low Delivery Risk',
  LONG_DELIVERY_NO_COMM:            'Long Delivery Without Clear Communication',
  CATALOG_DUMP_RISK:                'Catalog Dump Risk',
};

// ── Commercial impact bucket classification ───────────────────────────────────
// Groups each issue type by its primary commercial impact category.
const IMPACT_BUCKETS = {
  // Trust Blockers — things that make customers not trust the store
  TRUST_BLOCKER: [
    'NO_PRODUCT_IMAGES', 'INVALID_PRODUCT_TITLE', 'PRICING_ERROR', 'MISSING_DESCRIPTION',
    'SUPPLIER_DESCRIPTION', 'HIGH_PERFORMANCE_LOW_QUALITY', 'INCONSISTENT_PRIMARY_IMAGE',
    'CATALOG_DUMP_RISK', 'GHOST_LISTING', 'ABSOLUTE_PRICING_ANOMALY',
  ],
  // Conversion Blockers — things that stop customers from buying
  CONVERSION_BLOCKER: [
    'WEAK_DESCRIPTION', 'GENERIC_DESCRIPTION', 'SPEC_DUMP_DESCRIPTION', 'REPETITIVE_GENERIC_DESCRIPTION',
    'LOW_IMAGE_COUNT', 'MISSING_SIZE_GUIDE', 'MISSING_PRODUCT_SPECIFICATION',
    'WEAK_PRODUCT_TITLE', 'SERIAL_PRODUCT_TITLE', 'KEYWORD_STUFFED_TITLE',
  ],
  // Paid Traffic Risks — things that reduce ROAS when running ads
  PAID_TRAFFIC_RISK: [
    'LOW_QUALITY_IMAGE', 'BELOW_RECOMMENDED_RESOLUTION', 'POOR_PRESENTATION',
    'VARIANT_PRICE_GAP', 'COLLECTION_PRICE_OUTLIER', 'INCONSISTENT_PRICE_POSITIONING',
    'CATALOG_INCONSISTENCY', 'DELIVERY_RISK_CRITICAL', 'DELIVERY_RISK_HIGH',
  ],
  // Fulfillment & Delivery — shipping and trust risks
  FULFILLMENT_RISK: [
    'DELIVERY_RISK_MEDIUM', 'DELIVERY_RISK_LOW', 'LONG_DELIVERY_NO_COMM',
    'UNIFORM_INVENTORY', 'UNREALISTIC_INVENTORY', 'DEAD_INVENTORY',
  ],
  // Catalog Organization — metadata and structure issues
  CATALOG_ORGANIZATION: [
    'INCOMPLETE_ORGANIZATION', 'MISSING_RECOMMENDED_METAFIELDS', 'HIGH_FRAGMENTATION',
  ],
  // Visual Presentation — image quality and consistency
  VISUAL_PRESENTATION: [
    'EXCESSIVE_IMAGE_COUNT', 'DUPLICATE_IMAGES', 'LIMITED_IMAGE_DIVERSITY',
    'INCONSISTENT_STORE_VISUALS',
  ],
};

function getImpactBucket(issueType) {
  for (const [bucket, types] of Object.entries(IMPACT_BUCKETS)) {
    if (types.includes(issueType)) return bucket;
  }
  return 'CATALOG_ORGANIZATION'; // fallback
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

    // ── Trial-Safe Limits ───────────────────────────────────────────────────
    const trialEndsAt = subscription?.trialEndsAt;
    const isTrial = trialEndsAt ? new Date(trialEndsAt) > new Date() : false;
    const isExtendedDomain = isExtendedTrialDomain(shop.shopDomain);

    // Trial product caps per plan (reduced vs full paid limits)
    const TRIAL_PRODUCT_CAPS = { LIGHT: 20, GROWTH: 50, PRO: 100 };
    const dashPlanName = (subscription?.plan || 'LIGHT').toUpperCase();
    const dashTrialCap = TRIAL_PRODUCT_CAPS[dashPlanName] || 20;
    const fullProductLimit = plan?.maxProducts || 50;
    const effectiveDashProductLimit = (isTrial && !isExtendedDomain)
      ? Math.min(fullProductLimit, dashTrialCap)
      : fullProductLimit;

    // Days remaining in trial (for dashboard display)
    const trialDaysRemaining = isTrial
      ? Math.max(0, Math.ceil((new Date(trialEndsAt) - new Date()) / (1000 * 60 * 60 * 24)))
      : 0;

    const trialInfo = isTrial
      ? {
          isTrial: true,
          trialEndsAt,
          daysRemaining: trialDaysRemaining,
          trialProductCap: isExtendedDomain ? fullProductLimit : dashTrialCap,
          isExtendedAccess: isExtendedDomain,
          aiEnabled: false,
          scanFrequency: 'Daily / Manual (Trial Safe)',
        }
      : null;

    // 1. Get the latest completed AuditRun
    const latestAudit = await prisma.auditRun.findFirst({
      where: { shopId: shop.id, status: 'COMPLETED' },
      include: {
        issues: true,
      },
      orderBy: { completedAt: 'desc' },
    });

    // 2. Get products for breakdown (limited by plan — with trial cap applied)
    const products = await prisma.product.findMany({
      where: { shopId: shop.id },
      include: { variants: true },
      take: effectiveDashProductLimit,
    });

    let scores = {
      productDataQuality: 0,
      visualTrust: 0,
      catalogConsistency: 0,
      conversionReadiness: 0,
      fulfillmentTrust: 0,
      dropshippingPerception: 0,
      catalogMaintenance: 0,
      trustScore: 0,
      trustClassification: 'Waiting for Sync'
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
    let commercialRecommendations = [];
    let quickWins = [];
    let highImpactFixes = [];

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
      
      // Defensive helper: ensure affectedEntities is always an array
      // (Prisma/SQLite may store JSON arrays as strings)
      const safeEntities = (entities) => {
        if (Array.isArray(entities)) return entities;
        if (typeof entities === 'string') {
          try { return JSON.parse(entities); } catch { return []; }
        }
        return [];
      };
      
      // Calculate deductions
      const criticalIssues = issues.filter(i => i.severity === 'CRITICAL');
      const pricingIssues = issues.filter(i => ['PRICING_ERROR', 'ABSOLUTE_PRICING_ANOMALY'].includes(i.type));
      const titleIssues = issues.filter(i => ['INVALID_PRODUCT_TITLE', 'WEAK_PRODUCT_TITLE', 'SERIAL_PRODUCT_TITLE', 'KEYWORD_STUFFED_TITLE'].includes(i.type));
      const descIssues = issues.filter(i =>
        ['MISSING_DESCRIPTION', 'WEAK_DESCRIPTION', 'GENERIC_DESCRIPTION', 'SPEC_DUMP_DESCRIPTION', 'SUPPLIER_DESCRIPTION', 'REPETITIVE_GENERIC_DESCRIPTION', 'MISSING_SIZE_GUIDE', 'MISSING_PRODUCT_SPECIFICATION'].includes(i.type)
      );
      const noImageIssues = issues.filter(i => i.type === 'NO_PRODUCT_IMAGES');
      const imageIssues = issues.filter(i => ['NO_PRODUCT_IMAGES', 'LOW_IMAGE_COUNT', 'EXCESSIVE_IMAGE_COUNT', 'DUPLICATE_IMAGES', 'LIMITED_IMAGE_DIVERSITY', 'LOW_QUALITY_IMAGE', 'BELOW_RECOMMENDED_RESOLUTION', 'POOR_PRESENTATION', 'INCONSISTENT_PRIMARY_IMAGE', 'INCONSISTENT_STORE_VISUALS'].includes(i.type));
      const consistencyIssues = issues.filter(i =>
        ['HIGH_FRAGMENTATION', 'INCONSISTENT_PRICE_POSITIONING', 'VARIANT_PRICE_GAP', 'COLLECTION_PRICE_OUTLIER', 'INCOMPLETE_ORGANIZATION', 'MISSING_RECOMMENDED_METAFIELDS'].includes(i.type)
      );
      const perfRiskIssues = issues.filter(i => i.type === 'HIGH_PERFORMANCE_LOW_QUALITY');
      const inventoryIssues = issues.filter(i =>
        ['UNIFORM_INVENTORY', 'GHOST_LISTING', 'UNREALISTIC_INVENTORY'].includes(i.type)
      );
      const deadInventoryIssues = issues.filter(i => i.type === 'DEAD_INVENTORY');

      // Category Scoring (Nuanced, catalog-share proportional)
      const totalScannedCount = Math.max(1, products.length);

      const avgProdDescScore = products.length > 0
        ? products.reduce((sum, p) => sum + (p.descriptionQualityScore || 0), 0) / products.length
        : 80;
      const avgProdCompScore = products.length > 0
        ? products.reduce((sum, p) => sum + (p.completenessScore || 0), 0) / products.length
        : 80;

      const baseDataQuality = Math.round((avgProdDescScore * 0.6) + (avgProdCompScore * 0.4));
      const pricingAffectedShare = new Set(pricingIssues.flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount;
      const titleAffectedShare = new Set(titleIssues.flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount;
      const descAffectedShare = new Set(descIssues.flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount;

      const dataQualityDeductions = (pricingAffectedShare * 30) + (titleAffectedShare * 20) + (descAffectedShare * 20);
      scores.productDataQuality = Math.max(15, Math.min(100, Math.round(baseDataQuality - dataQualityDeductions)));

      const noImgShare = new Set(noImageIssues.flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount;
      const lowImgShare = new Set(imageIssues.filter(i => i.type === 'LOW_IMAGE_COUNT').flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount;
      const dupImgShare = new Set(imageIssues.filter(i => i.type === 'DUPLICATE_IMAGES').flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount;
      const lowQualImgShare = new Set(imageIssues.filter(i => i.type === 'LOW_QUALITY_IMAGE').flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount;
      const poorPresShare = new Set(imageIssues.filter(i => i.type === 'POOR_PRESENTATION').flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount;
      const excessiveImgShare = new Set(imageIssues.filter(i => i.type === 'EXCESSIVE_IMAGE_COUNT').flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount;
      const limitedDiversityShare = new Set(imageIssues.filter(i => i.type === 'LIMITED_IMAGE_DIVERSITY').flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount;
      const belowRecResShare = new Set(imageIssues.filter(i => i.type === 'BELOW_RECOMMENDED_RESOLUTION').flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount;
      const inconsistentPrimaryShare = new Set(imageIssues.filter(i => i.type === 'INCONSISTENT_PRIMARY_IMAGE').flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount;
      const inconsistentVisualsShare = new Set(imageIssues.filter(i => i.type === 'INCONSISTENT_STORE_VISUALS').flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount;

      // Visual Trust deductions — each factor is weighted proportionally.
      // Deductions are intentionally capped so that no single issue type can
      // single-handedly collapse the score to the floor minimum.
      const visualTrustDeductions =
        Math.min(noImgShare * 40, 35) +          // No images: serious, capped at 35
        Math.min(lowImgShare * 18, 18) +          // Too few images
        Math.min(dupImgShare * 14, 12) +          // Duplicate images
        Math.min(lowQualImgShare * 18, 18) +      // Low quality images
        Math.min(poorPresShare * 10, 10) +         // Poor presentation
        Math.min(excessiveImgShare * 6, 6) +       // Excessive image count
        Math.min(limitedDiversityShare * 10, 10) + // Limited diversity
        Math.min(belowRecResShare * 7, 7) +        // Below recommended resolution
        Math.min(inconsistentPrimaryShare * 14, 12) + // Inconsistent primary
        Math.min(inconsistentVisualsShare * 7, 7);    // Inconsistent store visuals
      scores.visualTrust = Math.max(20, Math.min(100, Math.round(100 - visualTrustDeductions)));

      const consistencyAffectedShare = new Set(consistencyIssues.flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount;
      // Normalize inventory affected entities to product-level counts
      // UNREALISTIC_INVENTORY uses variant IDs, so map them back to product IDs
      const inventoryAffectedProducts = new Set();
      inventoryIssues.forEach(i => {
        safeEntities(i.affectedEntities).forEach(entityId => {
          if (i.type === 'UNREALISTIC_INVENTORY') {
            // Variant-level entity — find the parent product
            const parentProduct = products.find(p => p.variants && p.variants.some(v => v.shopifyId === entityId));
            if (parentProduct) inventoryAffectedProducts.add(parentProduct.shopifyId);
          } else {
            // Product-level entity (GHOST_LISTING, UNIFORM_INVENTORY)
            inventoryAffectedProducts.add(entityId);
          }
        });
      });
      const inventoryAffectedShare = inventoryAffectedProducts.size / totalScannedCount;

      // Consistency deductions — proportional to catalog share affected.
      // Fragmentation adds a flat penalty but overall deduction is moderated.
      let consistencyDeduction = Math.min(consistencyAffectedShare * 30, 35) + Math.min(inventoryAffectedShare * 22, 22);
      if (consistencyIssues.some(i => i.type === 'HIGH_FRAGMENTATION')) consistencyDeduction += 10;

      scores.catalogConsistency = Math.max(20, Math.min(100, Math.round(100 - consistencyDeduction)));

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
        descIssues.filter(i => i.type === 'REPETITIVE_GENERIC_DESCRIPTION').length > 0 && `${descIssues.filter(i => i.type === 'REPETITIVE_GENERIC_DESCRIPTION').length} product(s) have repetitive generic descriptions`,
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
        imageIssues.filter(i => i.type === 'BELOW_RECOMMENDED_RESOLUTION').length > 0 && `${imageIssues.filter(i => i.type === 'BELOW_RECOMMENDED_RESOLUTION').length} product(s) contain clear but below-recommended resolution images`,
        imageIssues.filter(i => i.type === 'POOR_PRESENTATION').length > 0 && `${imageIssues.filter(i => i.type === 'POOR_PRESENTATION').length} product(s) contain poorly presented/cropped images`,
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

      // Conversion Readiness: Weighted average of all health metrics + penalties.
      // Visual Trust weight reduced slightly so image issues alone don't collapse readiness.
      const baseReadiness = (scores.productDataQuality * 0.35) + (scores.visualTrust * 0.35) + (scores.catalogConsistency * 0.30);
      const performancePenalty = Math.round((perfRiskIssues.length / totalScannedCount) * 25);
      
      let finalReadiness = Math.round(Math.max(20, baseReadiness - performancePenalty));

      // CRITICAL FAIL-CLOSED LOGIC:
      // If any critical issues exist (Pricing Errors, High Performance Quality Risk),
      // the score is capped at 50 to reflect significant risk without being overly harsh.
      if (criticalIssues.length > 0) {
        finalReadiness = Math.min(finalReadiness, 50);
      }
      
      scores.conversionReadiness = finalReadiness;

      // Dynamic calculation of Section 6 scores
      scores.fulfillmentTrust = (() => {
        const fIssues = issues.filter(i => ['DELIVERY_RISK_MEDIUM', 'DELIVERY_RISK_HIGH', 'DELIVERY_RISK_CRITICAL'].includes(i.type));
        const longDelNoCommIssues = issues.filter(i => i.type === 'LONG_DELIVERY_NO_COMM');
        
        let riskDeductionShare = 0;
        
        for (const issue of fIssues) {
          const ev = typeof issue.evidence === 'string' ? JSON.parse(issue.evidence) : issue.evidence;
          const model = ev?.fulfillmentModel;
          const affectedRatio = Math.min(1, safeEntities(issue.affectedEntities).length / totalScannedCount);
          
          if (model === 'OVERSEAS_DROPSHIP') {
            riskDeductionShare += affectedRatio * 20;
          }
          
          if (issue.type === 'DELIVERY_RISK_CRITICAL') {
            riskDeductionShare += affectedRatio * 35;
          } else if (issue.type === 'DELIVERY_RISK_HIGH') {
            riskDeductionShare += affectedRatio * 20;
          } else if (issue.type === 'DELIVERY_RISK_MEDIUM') {
            riskDeductionShare += affectedRatio * 10;
          }
        }
        
        const longDelShare = new Set(longDelNoCommIssues.flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount;
        riskDeductionShare += longDelShare * 20;
        
        return Math.max(20, Math.min(100, Math.round(100 - riskDeductionShare)));
      })();

      scores.dropshippingPerception = (() => {
        let deduction = 0;
        
        const unrealisticInv = issues.filter(i => i.type === 'UNREALISTIC_INVENTORY');
        const uniqueUnrealisticProds = new Set();
        unrealisticInv.forEach(i => {
          safeEntities(i.affectedEntities).forEach(vid => {
            const prod = products.find(p => p.variants && p.variants.some(v => v.shopifyId === vid));
            if (prod) uniqueUnrealisticProds.add(prod.shopifyId);
          });
        });
        deduction += (uniqueUnrealisticProds.size / totalScannedCount) * 25;
        
        const supplierDesc = issues.filter(i => i.type === 'SUPPLIER_DESCRIPTION');
        deduction += (new Set(supplierDesc.flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount) * 30;
        
        const lowQualityImg = issues.filter(i => i.type === 'LOW_QUALITY_IMAGE');
        deduction += (new Set(lowQualityImg.flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount) * 20;
        
        const duplicateImg = issues.filter(i => i.type === 'DUPLICATE_IMAGES');
        deduction += (new Set(duplicateImg.flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount) * 15;
        
        const dropshipDelivery = issues.filter(i => {
          const ev = typeof i.evidence === 'string' ? JSON.parse(i.evidence) : i.evidence;
          return ['DELIVERY_RISK_MEDIUM', 'DELIVERY_RISK_HIGH', 'DELIVERY_RISK_CRITICAL'].includes(i.type) && 
            ev?.fulfillmentModel === 'OVERSEAS_DROPSHIP';
        });
        deduction += (new Set(dropshipDelivery.flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount) * 30;
        
        if (issues.some(i => i.type === 'HIGH_FRAGMENTATION')) deduction += 15;
        
        return Math.max(15, Math.min(100, Math.round(100 - deduction)));
      })();

      scores.catalogMaintenance = (() => {
        let deduction = 0;
        
        const dIssues = issues.filter(i => ['WEAK_DESCRIPTION', 'MISSING_DESCRIPTION', 'GENERIC_DESCRIPTION', 'REPETITIVE_GENERIC_DESCRIPTION'].includes(i.type));
        deduction += (new Set(dIssues.flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount) * 20;
        
        const tIssues = issues.filter(i => ['WEAK_PRODUCT_TITLE', 'INVALID_PRODUCT_TITLE', 'SERIAL_PRODUCT_TITLE', 'KEYWORD_STUFFED_TITLE'].includes(i.type));
        deduction += (new Set(tIssues.flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount) * 20;
        
        const ghostListings = issues.filter(i => i.type === 'GHOST_LISTING');
        deduction += (new Set(ghostListings.flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount) * 25;
        
        const imageIssuesList = issues.filter(i => ['NO_PRODUCT_IMAGES', 'LOW_IMAGE_COUNT', 'BELOW_RECOMMENDED_RESOLUTION', 'POOR_PRESENTATION'].includes(i.type));
        deduction += (new Set(imageIssuesList.flatMap(i => safeEntities(i.affectedEntities))).size / totalScannedCount) * 20;
        
        return Math.max(20, Math.min(100, Math.round(100 - deduction)));
      })();

      scores.trustScore = (() => {
        const pDQ = scores.productDataQuality;
        const vT = scores.visualTrust;
        const cC = scores.catalogConsistency;
        const fT = scores.fulfillmentTrust;
        const cR = scores.conversionReadiness;
        
        let score = Math.round(
          (pDQ * 0.25) +
          (vT * 0.20) +
          (cC * 0.15) +
          (fT * 0.25) +
          (cR * 0.15)
        );
        
        if (issues.some(i => i.type === 'CATALOG_DUMP_RISK')) {
          score -= 15;
        }
        
        return Math.max(15, Math.min(100, score));
      })();

      scores.trustClassification = (() => {
        const trustVal = scores.trustScore;
        const maintVal = scores.catalogMaintenance;
        const perceptionVal = scores.dropshippingPerception;
        const fulfillVal = scores.fulfillmentTrust;
        
        const avg = (trustVal + maintVal + perceptionVal + fulfillVal) / 4;
        
        let classification = 'Fair';
        if (avg >= 85) {
          classification = 'Excellent';
        } else if (avg >= 70) {
          classification = 'Good';
        } else if (avg >= 55) {
          classification = 'Fair';
        } else if (avg >= 40) {
          classification = 'At Risk';
        } else {
          classification = 'High Risk';
        }
        
        if (trustVal < 40 || fulfillVal < 40) {
          if (classification === 'Excellent' || classification === 'Good' || classification === 'Fair') {
            classification = 'At Risk';
          }
        }
        if (trustVal < 25 || fulfillVal < 25) {
          classification = 'High Risk';
        }
        
        return classification;
      })();

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

      // Add RECOMMENDATION_TEMPLATES constant here
      const RECOMMENDATION_TEMPLATES = {
        NO_PRODUCT_IMAGES: { why: "No visible images", matters: "Customers cannot evaluate product", trust: "High", conversion: "Critical", paid: "Stop traffic", action: "Add product images" },
        LOW_IMAGE_COUNT: { why: "Insufficient images", matters: "Weak visual trust", trust: "Medium", conversion: "High", paid: "Reduce spend", action: "Add more images" },
        EXCESSIVE_IMAGE_COUNT: { why: "Too many images", matters: "Decision hesitation", trust: "Low", conversion: "Medium", paid: "N/A", action: "Curate images" },
        INVALID_PRODUCT_TITLE: { why: "Unusable title", matters: "Weak credibility", trust: "High", conversion: "High", paid: "Stop traffic", action: "Fix title" },
        WEAK_PRODUCT_TITLE: { why: "Vague title", matters: "Supports search poorly", trust: "Medium", conversion: "Medium", paid: "Low ROI", action: "Rewrite title" },
        PRICING_ERROR: { why: "Invalid pricing", matters: "Checkout failures", trust: "Critical", conversion: "Critical", paid: "Stop traffic", action: "Fix price" },
        MISSING_DESCRIPTION: { why: "No description", matters: "Insufficient info", trust: "High", conversion: "High", paid: "Stop traffic", action: "Add description" },
        WEAK_DESCRIPTION: { why: "Thin description", matters: "Weak purchase intent", trust: "Medium", conversion: "Medium", paid: "Low ROI", action: "Expand copy" },
        GENERIC_DESCRIPTION: { why: "Placeholder description", matters: "Lack of differentiation", trust: "Medium", conversion: "Medium", paid: "Low ROI", action: "Write custom copy" },
        SPEC_DUMP_DESCRIPTION: { why: "Specification-only", matters: "No benefits-led copy", trust: "Medium", conversion: "Medium", paid: "Low ROI", action: "Add benefits" },
        SUPPLIER_DESCRIPTION: { why: "Supplier boilerplate", matters: "Lowers brand authenticity", trust: "High", conversion: "High", paid: "High risk", action: "Remove boilerplate" },
        VARIANT_PRICE_GAP: { why: "Large pricing gaps", matters: "Confuses buyers", trust: "Low", conversion: "Medium", paid: "N/A", action: "Review pricing" },
        CATALOG_INCONSISTENCY: { why: "Pricing variance", matters: "Inconsistent positioning", trust: "Low", conversion: "Medium", paid: "N/A", action: "Standardize pricing" },
        HIGH_PERFORMANCE_LOW_QUALITY: { why: "Top sellers lacking trust", matters: "Lost sales potential", trust: "High", conversion: "High", paid: "Risk to ROAS", action: "Improve images/desc" },
        DEAD_INVENTORY: { why: "Stagnant inventory", matters: "Ties up capital", trust: "N/A", conversion: "N/A", paid: "Capital risk", action: "Mark down/clear" },
        UNIFORM_INVENTORY: { why: "Identical inventory levels", matters: "May indicate system feeds", trust: "Low", conversion: "Low", paid: "N/A", action: "Review stock levels" },
        UNREALISTIC_INVENTORY: { why: "Placeholder inventory", matters: "Dropshipping signals", trust: "Medium", conversion: "Medium", paid: "N/A", action: "Update to actual stock" },
        GHOST_LISTING: { why: "No collection assignment", matters: "Discovery issues", trust: "Low", conversion: "High", paid: "Traffic sink", action: "Assign to collection" },
        HIGH_FRAGMENTATION: { why: "Broad product mix", matters: "Unfocused branding", trust: "Low", conversion: "Medium", paid: "Broad positioning risk", action: "Consolidate catalog" },
        COLLECTION_PRICE_OUTLIER: { why: "Extreme pricing", matters: "Positioning signals", trust: "Medium", conversion: "Low", paid: "N/A", action: "Verify intent" },
        INCONSISTENT_PRICE_POSITIONING: { why: "Wide price range", matters: "Audience confusion", trust: "Medium", conversion: "Low", paid: "N/A", action: "Align pricing" },
        ABSOLUTE_PRICING_ANOMALY: { why: "Sanity check failure", matters: "Margin/checkout issues", trust: "High", conversion: "High", paid: "Stop traffic", action: "Check pricing" },
        SERIAL_PRODUCT_TITLE: { why: "Numeric sequences", matters: "Unprofessional look", trust: "Medium", conversion: "Low", paid: "N/A", action: "Rewrite title" },
        KEYWORD_STUFFED_TITLE: { why: "Overloaded keywords", matters: "Unprofessional feel", trust: "Medium", conversion: "Low", paid: "N/A", action: "Simplify title" },
        DUPLICATE_IMAGES: { why: "Duplicate files", matters: "Cluttered gallery", trust: "Low", conversion: "Low", paid: "N/A", action: "Delete duplicates" },
        LIMITED_IMAGE_DIVERSITY: { why: "Lack of variation", matters: "Low visual trust", trust: "Medium", conversion: "Medium", paid: "N/A", action: "Add lifestyle/detail shots" },
        LOW_QUALITY_IMAGE: { why: "Blurry images", matters: "Purchase barrier", trust: "High", conversion: "High", paid: "Traffic waste", action: "Replace with HD image" },
        INCONSISTENT_PRIMARY_IMAGE: { why: "Primary image is not product", matters: "Search/Ad performance", trust: "High", conversion: "High", paid: "Low CTR", action: "Reorder images" },
        INCONSISTENT_STORE_VISUALS: { why: "Aspect ratio mismatch", matters: "Visual clutter", trust: "Low", conversion: "Low", paid: "N/A", action: "Crop/Edit to match" },
        MISSING_SIZE_GUIDE: { why: "No sizing info", matters: "High returns risk", trust: "High", conversion: "High", paid: "Refund/Support risk", action: "Add size chart" },
        MISSING_PRODUCT_SPECIFICATION: { why: "No technical details", matters: "Unanswered buyer questions", trust: "Low", conversion: "Medium", paid: "N/A", action: "Add specifications" },
        INCOMPLETE_ORGANIZATION: { why: "Missing metadata", matters: "Search findability", trust: "Low", conversion: "Medium", paid: "N/A", action: "Fix tags/type/vendor" },
        MISSING_RECOMMENDED_METAFIELDS: { why: "Metafield gaps", matters: "Faceted search issues", trust: "Low", conversion: "Low", paid: "N/A", action: "Add attributes" },
        DELIVERY_RISK_CRITICAL: { why: "Critical shipping risk", matters: "Conversion drop", trust: "High", conversion: "High", paid: "High bounce rate", action: "Improve fulfillment" },
        DELIVERY_RISK_HIGH: { why: "High shipping risk", matters: "Trust impact", trust: "Medium", conversion: "Medium", paid: "High abandonment", action: "Update policy" },
        DELIVERY_RISK_MEDIUM: { why: "Medium shipping risk", matters: "N/A", trust: "Low", conversion: "Low", paid: "N/A", action: "Monitor shipping" },
        DELIVERY_RISK_LOW: { why: "Low shipping risk", matters: "N/A", trust: "Low", conversion: "Low", paid: "N/A", action: "Routine check" },
        LONG_DELIVERY_NO_COMM: { why: "Slow shipping without comm", matters: "Refund/support risk", trust: "High", conversion: "High", paid: "High chargeback risk", action: "Add shipping info" },
        CATALOG_DUMP_RISK: { why: "Catalog dump pattern", matters: "Store trust loss", trust: "High", conversion: "High", paid: "Low ROAS", action: "Curate your catalog" },
      };

       issuesList = Object.values(groupedIssues).map(issueGroup => {
        let recommendation = 'Fix this issue in your Shopify Admin.';
        let evidence = 'Detected during catalog scan.';
        
        const affectedEntitiesArray = Array.from(issueGroup.affectedEntities);

        const template = RECOMMENDATION_TEMPLATES[issueGroup.type];
        if (template) {
          recommendation = `Why this was flagged: ${template.why}\nWhy it matters: ${template.matters}\nImpact on trust: ${template.trust}\nImpact on conversion: ${template.conversion}\nImpact on paid traffic: ${template.paid}\nRecommended action: ${template.action}`;
        }

        // Calibrate action text dynamically for SPEC_DUMP_DESCRIPTION if specs are already at the bottom
        if (issueGroup.type === 'SPEC_DUMP_DESCRIPTION' && template) {
          const groupIssues = issues.filter(i => i.type === 'SPEC_DUMP_DESCRIPTION');
          const hasSpecsAtBottom = groupIssues.some(i => {
            const ev = typeof i.evidence === 'string' ? JSON.parse(i.evidence) : i.evidence;
            return ev && ev.specsAreAtBottom === true;
          });
          if (hasSpecsAtBottom) {
            const actionText = "Focus on adding emotional benefits, trust signals (warranties/guarantees), sizing/usage details, and unique product differentiation to improve copy quality rather than just listing technical features.";
            recommendation = `Why this was flagged: ${template.why}\nWhy it matters: ${template.matters}\nImpact on trust: ${template.trust}\nImpact on conversion: ${template.conversion}\nImpact on paid traffic: ${template.paid}\nRecommended action: ${actionText}`;
          }
        }

        // Calibrate action text and evidence dynamically for INCOMPLETE_ORGANIZATION
        if (issueGroup.type === 'INCOMPLETE_ORGANIZATION' && template) {
          const groupIssues = issues.filter(i => i.type === 'INCOMPLETE_ORGANIZATION');
          const allMissingFields = new Set();
          groupIssues.forEach(i => {
            const ev = typeof i.evidence === 'string' ? JSON.parse(i.evidence) : i.evidence;
            if (ev && Array.isArray(ev.missingFields)) {
              ev.missingFields.forEach(f => allMissingFields.add(f));
            }
          });
          const fieldsStr = allMissingFields.size > 0 
            ? Array.from(allMissingFields).join(', ') 
            : 'vendor, type, tag, or collection metadata';
          evidence = `${affectedEntitiesArray.length} product(s) have incomplete organization. Missing fields: ${fieldsStr}.`;
          
          const actionText = `Fill in the missing fields (${fieldsStr}) in Shopify Admin to ensure proper search findability and collection routing.`;
          recommendation = `Why this was flagged: ${template.why}\nWhy it matters: ${template.matters}\nImpact on trust: ${template.trust}\nImpact on conversion: ${template.conversion}\nImpact on paid traffic: ${template.paid}\nRecommended action: ${actionText}`;
        }

        // Keep evidence strings dynamically computed as before
        if (issueGroup.type === 'NO_PRODUCT_IMAGES') {
          evidence = `${affectedEntitiesArray.length} product(s) have zero images.`;
        } else if (issueGroup.type === 'LOW_IMAGE_COUNT') {
          evidence = `${affectedEntitiesArray.length} product(s) have fewer than ${plan?.imagesPerProduct || 3} images.`;
        } else if (issueGroup.type === 'EXCESSIVE_IMAGE_COUNT') {
          evidence = `${affectedEntitiesArray.length} product(s) have 20 or more images.`;
        } else if (issueGroup.type === 'INVALID_PRODUCT_TITLE') {
          evidence = `${affectedEntitiesArray.length} product(s) have missing, single-character, or numeric-only titles.`;
        } else if (issueGroup.type === 'WEAK_PRODUCT_TITLE') {
          evidence = `${affectedEntitiesArray.length} product(s) have titles with fewer than 3 meaningful words.`;
        } else if (issueGroup.type === 'PRICING_ERROR') {
          evidence = `Found invalid pricing on ${affectedEntitiesArray.length} variant(s).`;
        } else if (issueGroup.type === 'MISSING_DESCRIPTION') {
          evidence = `${affectedEntitiesArray.length} product(s) have no description text at all.`;
        } else if (issueGroup.type === 'WEAK_DESCRIPTION') {
          evidence = `${affectedEntitiesArray.length} product(s) have descriptions under 75 words.`;
        } else if (issueGroup.type === 'GENERIC_DESCRIPTION') {
          evidence = `${affectedEntitiesArray.length} product(s) have boilerplate or placeholder descriptions.`;
        } else if (issueGroup.type === 'SPEC_DUMP_DESCRIPTION') {
          evidence = `${affectedEntitiesArray.length} product(s) have specification-only descriptions.`;
        } else if (issueGroup.type === 'SUPPLIER_DESCRIPTION') {
          evidence = `${affectedEntitiesArray.length} product(s) contain supplier boilerplate content.`;
        } else if (issueGroup.type === 'REPETITIVE_GENERIC_DESCRIPTION') {
          evidence = `${affectedEntitiesArray.length} product(s) have repetitive generic descriptions or AI-style copywriting.`;
        } else if (issueGroup.type === 'VARIANT_PRICE_GAP') {
          evidence = `${affectedEntitiesArray.length} product(s) have variants with 3x or greater price gaps.`;
        } else if (issueGroup.type === 'CATALOG_INCONSISTENCY') {
          evidence = `${affectedEntitiesArray.length} product(s) show significant internal pricing variance.`;
        } else if (issueGroup.type === 'HIGH_PERFORMANCE_LOW_QUALITY') {
          evidence = `${affectedEntitiesArray.length} high-performing product(s) have sub-standard catalog quality.`;
        } else if (issueGroup.type === 'DEAD_INVENTORY') {
          evidence = `${affectedEntitiesArray.length} stagnant product(s) are tying up warehouse capital.`;
        } else if (issueGroup.type === 'UNIFORM_INVENTORY') {
          evidence = `${affectedEntitiesArray.length} product(s) have 4+ variants all holding identical stock.`;
        } else if (issueGroup.type === 'UNREALISTIC_INVENTORY') {
          evidence = `${affectedEntitiesArray.length} variant(s) show placeholder or unusually high inventory.`;
        } else if (issueGroup.type === 'GHOST_LISTING') {
          evidence = `${affectedEntitiesArray.length} product(s) have no collection assignment.`;
        } else if (issueGroup.type === 'HIGH_FRAGMENTATION') {
          evidence = 'Store has fewer than 50 products but more than 8 distinct collections — signals unfocused positioning.';
        } else if (issueGroup.type === 'COLLECTION_PRICE_OUTLIER') {
          evidence = 'One or more products are priced 20x or more above the median catalog price.';
        } else if (issueGroup.type === 'INCONSISTENT_PRICE_POSITIONING') {
          evidence = 'The highest-priced product is more than 10x the median catalog price.';
        } else if (issueGroup.type === 'ABSOLUTE_PRICING_ANOMALY') {
          evidence = `${affectedEntitiesArray.length} variant(s) have absolute pricing anomalies.`;
        } else if (issueGroup.type === 'SERIAL_PRODUCT_TITLE') {
          evidence = 'Title carries long numeric blocks or a serial-number pattern.';
        } else if (issueGroup.type === 'KEYWORD_STUFFED_TITLE') {
          evidence = 'Title has repetitive words or excessive separation characters.';
        } else if (issueGroup.type === 'DUPLICATE_IMAGES') {
          evidence = `${affectedEntitiesArray.length} product(s) have duplicate images.`;
        } else if (issueGroup.type === 'LIMITED_IMAGE_DIVERSITY') {
          evidence = `${affectedEntitiesArray.length} product(s) show limited image diversity.`;
        } else if (issueGroup.type === 'LOW_QUALITY_IMAGE') {
          evidence = `${affectedEntitiesArray.length} product(s) contain blurry or low-resolution images.`;
        } else if (issueGroup.type === 'BELOW_RECOMMENDED_RESOLUTION') {
          evidence = `${affectedEntitiesArray.length} product(s) contain clear but below recommended resolution images.`;
        } else if (issueGroup.type === 'POOR_PRESENTATION') {
          evidence = `${affectedEntitiesArray.length} product(s) contain poorly cropped or supplier-style images.`;
        } else if (issueGroup.type === 'INCONSISTENT_PRIMARY_IMAGE') {
          evidence = `${affectedEntitiesArray.length} product(s) have non-product primary images.`;
        } else if (issueGroup.type === 'INCONSISTENT_STORE_VISUALS') {
          evidence = `${affectedEntitiesArray.length} product(s) have visually inconsistent primary images.`;
        } else if (issueGroup.type === 'MISSING_SIZE_GUIDE') {
          evidence = `${affectedEntitiesArray.length} apparel/footwear product(s) are missing size guides.`;
        } else if (issueGroup.type === 'MISSING_PRODUCT_SPECIFICATION') {
          evidence = `${affectedEntitiesArray.length} product(s) have no dimensions, materials, or specifications.`;
        } else if (issueGroup.type === 'INCOMPLETE_ORGANIZATION') {
          // Already handled dynamically above, keep fallback empty or pass
        } else if (issueGroup.type === 'MISSING_RECOMMENDED_METAFIELDS') {
          evidence = `${affectedEntitiesArray.length} product(s) are missing recommended metafield attributes (fabric, color, age group, features).`;
        } else if (issueGroup.type === 'DELIVERY_RISK_CRITICAL') {
          evidence = `${affectedEntitiesArray.length} product(s) have critical delivery risk.`;
        } else if (issueGroup.type === 'DELIVERY_RISK_HIGH') {
          evidence = `${affectedEntitiesArray.length} product(s) have high delivery risk.`;
        } else if (issueGroup.type === 'DELIVERY_RISK_MEDIUM') {
          evidence = `${affectedEntitiesArray.length} product(s) have medium delivery risk.`;
        } else if (issueGroup.type === 'DELIVERY_RISK_LOW') {
          evidence = `${affectedEntitiesArray.length} product(s) have low delivery risk.`;
        } else if (issueGroup.type === 'LONG_DELIVERY_NO_COMM') {
          evidence = `${affectedEntitiesArray.length} product(s) have long delivery times without shipping tracking policies.`;
        } else if (issueGroup.type === 'CATALOG_DUMP_RISK') {
          evidence = 'Catalog dump risk patterns detected (high rate of weak/serial titles, placeholder inventory, or missing metadata).';
        }

        const items = products
          .filter(p => 
            affectedEntitiesArray.includes(p.shopifyId) || 
            (p.variants && p.variants.some(v => affectedEntitiesArray.includes(v.shopifyId)))
          )
          .map(p => ({ id: p.id, shopifyId: p.shopifyId, title: p.title }));

        return {
          id: issueGroup.id,
          type: DISPLAY_NAMES[issueGroup.type] || issueGroup.type.replace(/_/g, ' '),
          rawType: issueGroup.type,
          severity: issueGroup.severity,
          impactBucket: getImpactBucket(issueGroup.type),
          recommendation,
          evidence,
          affectedCount: items.length,
          items,
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

      // ── 7.2 COMMERCIAL RECOMMENDATIONS ────────────────────────────────────
      commercialRecommendations = [];
      
      const supplierIssuesCount = issues.filter(i => i.type === 'SUPPLIER_DESCRIPTION').length;
      if (supplierIssuesCount > 0) {
        commercialRecommendations.push(`${supplierIssuesCount} product(s) contain supplier-style descriptions.`);
      }
      
      if (scores.productDataQuality < 70) {
        commercialRecommendations.push("Improve product descriptions before running Meta Ads.");
      }
      
      const inventoryAnomalyCount = issues.filter(i => ['UNREALISTIC_INVENTORY', 'UNIFORM_INVENTORY'].includes(i.type)).length;
      if (inventoryAnomalyCount > 0) {
        commercialRecommendations.push("Inventory patterns may reduce customer trust.");
      }
      
      const slowShippingCount = issues.filter(i => ['DELIVERY_RISK_HIGH', 'DELIVERY_RISK_CRITICAL', 'LONG_DELIVERY_NO_COMM'].includes(i.type)).length;
      if (slowShippingCount > 0) {
        commercialRecommendations.push("High shipping times can damage customer retention; improve fulfillment options.");
      }
      
      const imageQualityCount = issues.filter(i => i.type === 'LOW_QUALITY_IMAGE').length;
      if (imageQualityCount > 0) {
        commercialRecommendations.push("Low quality product images are dragging down store perception.");
      }

      // ── 7.3 QUICK WINS & HIGH-IMPACT FIXES ENGINE ────────────────────────
      const possibleRecommendations = [];
      
      const ghostCount = issues.filter(i => i.type === 'GHOST_LISTING').length;
      if (ghostCount > 0) {
        possibleRecommendations.push({
          title: `Fix ${ghostCount} ghost listing(s)`,
          action: `Assign these published products to storefront collections in Shopify Admin.`,
          effort: 'Low',
          impact: 'High',
          count: ghostCount,
          priority: 9.0
        });
      }
      
      const sizeGuideCount = issues.filter(i => i.type === 'MISSING_SIZE_GUIDE').length;
      if (sizeGuideCount > 0) {
        possibleRecommendations.push({
          title: `Add size guides to ${sizeGuideCount} products`,
          action: `Provide sizing charts or fit tables for apparel or footwear items.`,
          effort: 'Medium',
          impact: 'High',
          count: sizeGuideCount,
          priority: 2.67
        });
      }
      
      const weakDescCount = issues.filter(i => ['WEAK_DESCRIPTION', 'MISSING_DESCRIPTION'].includes(i.type)).length;
      if (weakDescCount > 0) {
        possibleRecommendations.push({
          title: `Improve descriptions on ${weakDescCount} products`,
          action: `Expand descriptions to include benefits, usage, and trust details.`,
          effort: 'Medium',
          impact: 'High',
          count: weakDescCount,
          priority: 2.0
        });
      }
      
      const lowImgCount = issues.filter(i => i.type === 'LOW_QUALITY_IMAGE').length;
      if (lowImgCount > 0) {
        possibleRecommendations.push({
          title: `Replace low-quality images on ${lowImgCount} products`,
          action: `Upload clear, high-resolution product photography (minimum 800x800 px).`,
          effort: 'Medium',
          impact: 'High',
          count: lowImgCount,
          priority: 2.33
        });
      }
      
      const incompleteOrgCount = issues.filter(i => i.type === 'INCOMPLETE_ORGANIZATION').length;
      if (incompleteOrgCount > 0) {
        possibleRecommendations.push({
          title: `Fix metadata on ${incompleteOrgCount} products`,
          action: `Assign missing product types, vendors, or tags in Shopify Admin.`,
          effort: 'Low',
          impact: 'Medium',
          count: incompleteOrgCount,
          priority: 6.0
        });
      }
      
      const duplicateImgCount = issues.filter(i => i.type === 'DUPLICATE_IMAGES').length;
      if (duplicateImgCount > 0) {
        possibleRecommendations.push({
          title: `Remove duplicate images from ${duplicateImgCount} products`,
          action: `Delete repeated near-identical files to clean product galleries.`,
          effort: 'Low',
          impact: 'Medium',
          count: duplicateImgCount,
          priority: 5.0
        });
      }

      // Split into Quick Wins (low effort AND small volume <= 20 products) vs High-Impact Fixes (larger volume or medium/high effort)
      const sortedRecs = possibleRecommendations.sort((a, b) => b.priority - a.priority);
      
      quickWins = sortedRecs
        .filter(w => w.effort === 'Low' && w.count <= 20)
        .slice(0, 5)
        .map(w => ({
          title: w.title,
          action: w.action,
          effort: w.effort,
          impact: w.impact,
          count: w.count,
        }));

      highImpactFixes = sortedRecs
        .filter(w => w.count > 20 || w.effort !== 'Low')
        .slice(0, 5)
        .map(w => ({
          title: w.title,
          action: w.action,
          effort: w.effort,
          impact: w.impact,
          count: w.count,
        }));

      // Fallback: If no quickWins under strict filters, include top sorted items
      if (quickWins.length === 0 && sortedRecs.length > 0) {
        quickWins = sortedRecs.slice(0, 3).map(w => ({
          title: w.title,
          action: w.action,
          effort: w.effort,
          impact: w.impact,
          count: w.count,
        }));
      }

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

    // Determine Verdict - Commercial Guidance Focused
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
      verdict = 'Not Ready — Fix key issues before scaling ads';
      storeRecommendation = 'Product descriptions, catalog quality, and trust signals should be improved before increasing paid traffic to reduce the risk of low ROAS.';
    } else {
      verdict = 'High Risk: Review before scaling paid traffic';
      storeRecommendation = criticalIssuesExist 
        ? 'Critical errors detected (e.g. pricing or top-seller quality). Fix priority issues before increasing ad spend to protect your ROAS.'
        : 'Significant catalog and trust issues detected. Work through the priority fixes below before scaling paid traffic to prevent wasted ad spend.';
    }

    // ── Store Readiness Narrative ─────────────────────────────────────────────
    // Empowering, action-focused narrative for merchants.
    let storeReadinessNarrative = null;
    if (latestAudit && issuesList.length > 0) {
      const criticalOrHighCount = issuesList.filter(i => ['CRITICAL', 'HIGH'].includes(i.severity?.toUpperCase())).length;
      const totalAffectedProducts = new Set(issuesList.flatMap(i => i.items?.map(p => p.shopifyId) || [])).size;
      
      if (mainScore >= 85) {
        storeReadinessNarrative = `Your store is in good shape. A small number of issues have been flagged for your review, but overall your catalog meets the readiness standards for scaling ad spend. ScaleGuard has prioritized any remaining actions for you below.`;
      } else if (mainScore >= 70) {
        storeReadinessNarrative = `Your store has several trust and conversion opportunities that are worth addressing before increasing ad spend. These issues are fixable, and ScaleGuard has prioritized the highest-impact actions first. Resolving the ${criticalOrHighCount} critical and high-priority issues will make the biggest difference to your conversion rate and ad performance.`;
      } else if (mainScore >= 45) {
        storeReadinessNarrative = `Your store has a number of trust and conversion risks that should be reviewed before increasing ad spend. These issues are fixable — ScaleGuard has identified the highest-priority actions first. Approximately ${totalAffectedProducts} products are affected by at least one issue. Focus on the critical and high-priority items to improve your readiness score and ad performance.`;
      } else {
        storeReadinessNarrative = `Your store currently has significant trust and conversion risks that are likely to result in poor ad performance if left unaddressed. These issues are fixable — ScaleGuard has prioritized the most important actions so you know where to start before scaling ad spend. Work through the priority fixes below to improve your readiness score.`;
      }
    } else if (latestAudit && issuesList.length === 0) {
      storeReadinessNarrative = `Excellent — no significant issues detected in your catalog. Your store meets the readiness standards for scaling ad spend. Continue monitoring with regular audits to maintain this standard as you grow.`;
    }

    // ── Impact Bucket Summary ─────────────────────────────────────────────────
    // Groups issues by commercial impact for the bucket summary section.
    let impactBucketSummary = null;
    if (latestAudit && issuesList.length > 0) {
      const bucketLabels = {
        TRUST_BLOCKER: { label: 'Trust Blockers', icon: '🔴', description: 'Issues that make customers question the legitimacy or quality of your store.' },
        CONVERSION_BLOCKER: { label: 'Conversion Blockers', icon: '🟠', description: 'Issues that prevent customers from feeling confident enough to complete a purchase.' },
        PAID_TRAFFIC_RISK: { label: 'Paid Traffic Risks', icon: '🟡', description: 'Issues that reduce your Return on Ad Spend and waste paid traffic budget.' },
        FULFILLMENT_RISK: { label: 'Fulfillment & Delivery', icon: '📦', description: 'Shipping timeline risks, poor communication, and inventory trust signals.' },
        CATALOG_ORGANIZATION: { label: 'Catalog Organization', icon: '🔵', description: 'Missing metadata, tags, and organizational structure that affects discoverability.' },
        VISUAL_PRESENTATION: { label: 'Visual Presentation', icon: '🟣', description: 'Image quality, consistency, and diversity issues affecting store aesthetics.' },
      };

      const bucketCounts = {};
      for (const issue of issuesList) {
        const bucket = issue.impactBucket || 'CATALOG_ORGANIZATION';
        if (!bucketCounts[bucket]) {
          bucketCounts[bucket] = { issueCount: 0, affectedProducts: new Set(), highestSeverity: 'LOW' };
        }
        bucketCounts[bucket].issueCount++;
        (issue.items || []).forEach(p => bucketCounts[bucket].affectedProducts.add(p.shopifyId));
        const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        if ((SEVERITY_RANK[issue.severity] ?? 4) < (SEVERITY_RANK[bucketCounts[bucket].highestSeverity] ?? 4)) {
          bucketCounts[bucket].highestSeverity = issue.severity;
        }
      }

      impactBucketSummary = Object.entries(bucketCounts)
        .map(([bucket, data]) => ({
          bucket,
          label: bucketLabels[bucket]?.label || bucket,
          icon: bucketLabels[bucket]?.icon || '⚫',
          description: bucketLabels[bucket]?.description || '',
          issueCount: data.issueCount,
          affectedProductCount: data.affectedProducts.size,
          highestSeverity: data.highestSeverity,
        }))
        .sort((a, b) => {
          const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
          return (SEVERITY_RANK[a.highestSeverity] ?? 4) - (SEVERITY_RANK[b.highestSeverity] ?? 4);
        });
    }

    // ── Delivery Advisory (Persistent) ────────────────────────────────────────
    // Even if the merchant has overridden DELIVERY_RISK_CRITICAL, we still
    // show a persistent advisory to remind them of the risk.
    let deliveryAdvisory = null;
    if (latestAudit) {
      const allIssues = latestAudit.issues || [];
      const hasCriticalDelivery = allIssues.some(i => i.type === 'DELIVERY_RISK_CRITICAL');
      const isDeliveryRiskOverridden = ignoredRuleTypes.has('DELIVERY_RISK_CRITICAL');
      
      if (hasCriticalDelivery && isDeliveryRiskOverridden) {
        deliveryAdvisory = {
          type: 'DELIVERY_RISK_ADVISORY',
          title: 'Delivery Risk Advisory (Acknowledged)',
          message: 'Long delivery times are often associated with low-trust dropshipping experiences, especially when products appear generic or supplier-sourced. If delivery cannot be improved, make the shipping timeline very clear before purchase to reduce refunds, chargebacks and customer complaints.',
          isAcknowledged: true,
        };
      }
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
      PRO: { maxProducts: 200, imagesPerProduct: 5, scanFrequency: 'Every 3 Hours' }
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
      trialInfo,
      verdict: latestAudit ? verdict : 'Waiting for Sync',
      storeRecommendation: latestAudit ? storeRecommendation : 'Initial audit required to determine readiness.',
      storeReadinessNarrative: storeReadinessNarrative,
      impactBucketSummary: impactBucketSummary,
      deliveryAdvisory: deliveryAdvisory,
      isDataSufficient,
      dataIssues,
      scores: latestAudit ? scores : null,
      scoreExplanations: latestAudit ? scoreExplanations : null,
      commercialRecommendations: latestAudit ? commercialRecommendations : [],
      quickWins: latestAudit ? quickWins : [],
      highImpactFixes: latestAudit ? highImpactFixes : [],
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

    const ALLOWED_OVERRIDES = [
      'UNREALISTIC_INVENTORY',
      'UNIFORM_INVENTORY',
      'DELIVERY_RISK_CRITICAL',   // Merchants can acknowledge as intentional (dropshipping / made-to-order)
      'LONG_DELIVERY_NO_COMM',    // Closely related to DELIVERY_RISK_CRITICAL
    ];

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

// Submit a support inquiry (subscriber only)
router.post('/support', authenticateFlexible, async (req, res) => {
  try {
    const shop = req.shop;
    
    // Get subscription and check status
    const subscription = await prisma.subscription.findUnique({
      where: { shopId: shop.id },
    });

    if (!subscription || subscription.status !== 'ACTIVE') {
      return res.status(403).json({
        error: 'Active subscription required',
        upgradeRequired: true,
      });
    }

    const { name, email, subject, message } = req.body;

    // Validation
    if (!name || !email || !subject || !message) {
      return res.status(400).json({
        error: 'All fields (name, email, subject, message) are required.',
      });
    }

    // Call email service to send the inquiry
    await sendSupportEmail({
      name,
      email,
      subject,
      message,
      shopDomain: shop.shopDomain,
    });

    res.json({
      success: true,
      message: 'We have received your enquiry and will get back to you within 48 hours.',
    });
  } catch (error) {
    console.error('Support route error:', error);
    res.status(500).json({ error: 'Failed to submit support inquiry.' });
  }
});

export default router;

