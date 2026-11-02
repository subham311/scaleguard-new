import * as cheerio from 'cheerio';

/**
 * Analyzes the merchant's live customer-facing Shopify homepage.
 *
 * @param {string} shopDomain - The myshopify domain (e.g., example.myshopify.com)
 * @returns {Promise<Object>} Comprehensive Storefront Intelligence Report
 */
export async function analyzeStorefront(shopDomain) {
  if (!shopDomain) {
    throw new Error('shopDomain is required for storefront analysis');
  }

  const cleanDomain = shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const targetUrl = `https://${cleanDomain}`;
  const analyzedAt = new Date().toISOString();

  console.log(`🌐 [StorefrontAnalyzer] Analyzing live homepage for ${targetUrl}...`);

  let html = '';
  let finalUrl = targetUrl;
  let responseStatus = 200;
  let isPasswordProtected = false;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000); // 12s timeout

    const res = await fetch(targetUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 ScaleGuard-Audit/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    clearTimeout(timeoutId);
    responseStatus = res.status;
    finalUrl = res.url || targetUrl;
    html = await res.text();
  } catch (fetchError) {
    console.error(`❌ [StorefrontAnalyzer] Failed to fetch homepage ${targetUrl}:`, fetchError.message);
    return createFallbackReport({
      shopDomain: cleanDomain,
      analyzedAt,
      error: `Could not reach live storefront: ${fetchError.message}`,
      status: 'UNREACHABLE',
    });
  }

  const $ = cheerio.load(html);

  // Check if store is currently password protected
  if (
    finalUrl.includes('/password') ||
    $('form[action*="/password"]').length > 0 ||
    $('input[type="password"][name="password"]').length > 0 ||
    $('title').text().toLowerCase().includes('opening soon') ||
    $('title').text().toLowerCase().includes('password')
  ) {
    isPasswordProtected = true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. SEO BASICS (Title, Meta Description, H1 Hierarchy)
  // ─────────────────────────────────────────────────────────────────────────────
  const pageTitle = ($('title').first().text() || '').trim();
  const metaDescription = (
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    ''
  ).trim();

  const h1Elements = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const h2Elements = $('h2').map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const viewportMeta = $('meta[name="viewport"]').attr('content') || '';

  const seoFindings = [];
  let seoScore = 15;

  if (!pageTitle) {
    seoScore -= 6;
    seoFindings.push({
      title: 'Missing Homepage Title Tag',
      category: 'SEO_BASICS',
      severity: 'HIGH',
      detected: 'No <title> tag was found on the homepage.',
      whyItMatters: 'Search engines and social platforms rely on title tags to understand your store. Missing titles cause ad and organic traffic drop-offs.',
      recommendation: 'In Shopify Admin, go to Online Store > Preferences and set a descriptive Home page title (between 30 and 60 characters).',
    });
  } else if (pageTitle.length < 20) {
    seoScore -= 3;
    seoFindings.push({
      title: 'Short or Generic Homepage Title',
      category: 'SEO_BASICS',
      severity: 'MEDIUM',
      detected: `Homepage title is only ${pageTitle.length} characters: "${pageTitle}".`,
      whyItMatters: 'Short titles miss valuable branding and keyword opportunities, weakening your Google search visibility.',
      recommendation: 'Expand your homepage title in Online Store > Preferences to include your brand name and your primary product category.',
    });
  } else if (pageTitle.length > 70) {
    seoScore -= 2;
    seoFindings.push({
      title: 'Homepage Title Exceeds Recommended Length',
      category: 'SEO_BASICS',
      severity: 'LOW',
      detected: `Homepage title is ${pageTitle.length} characters long, which will be truncated in search results.`,
      whyItMatters: 'Search engines truncate titles longer than 60-70 characters with an ellipsis (...), hiding your full brand message.',
      recommendation: 'Keep your homepage title under 60 characters to ensure it displays cleanly in search engine results.',
    });
  }

  if (!metaDescription) {
    seoScore -= 6;
    seoFindings.push({
      title: 'Missing Homepage Meta Description',
      category: 'SEO_BASICS',
      severity: 'HIGH',
      detected: 'No homepage meta description is defined in the HTML headers.',
      whyItMatters: 'Without a meta description, Google extracts random snippets from your page. Visitors searching your brand see incomplete snippets.',
      recommendation: 'In Online Store > Preferences, enter a compelling 120-160 character meta description explaining what you sell and why customers should buy.',
    });
  } else if (metaDescription.length < 50) {
    seoScore -= 3;
    seoFindings.push({
      title: 'Brief Meta Description',
      category: 'SEO_BASICS',
      severity: 'LOW',
      detected: `Meta description is only ${metaDescription.length} characters: "${metaDescription}".`,
      whyItMatters: 'A brief description fails to highlight your key benefits, free shipping offers, or primary product selection.',
      recommendation: 'Expand your meta description in Online Store > Preferences to 120-160 characters with a clear call-to-action.',
    });
  }

  if (h1Elements.length === 0) {
    seoScore -= 3;
    seoFindings.push({
      title: 'Missing Primary H1 Heading',
      category: 'SEO_BASICS',
      severity: 'MEDIUM',
      detected: 'No <h1> heading was detected on the live homepage.',
      whyItMatters: 'The H1 heading is the most important on-page structural cue for accessibility and search engine relevancy.',
      recommendation: 'Ensure your theme hero or banner section includes a visible, descriptive <h1> heading.',
    });
  } else if (h1Elements.length > 1) {
    seoScore -= 2;
    seoFindings.push({
      title: 'Multiple H1 Headings Detected',
      category: 'SEO_BASICS',
      severity: 'LOW',
      detected: `Detected ${h1Elements.length} separate <h1> tags on the homepage.`,
      whyItMatters: 'Having multiple H1 tags dilutes the primary topic of your page for search engines and can create heading hierarchy confusion.',
      recommendation: 'Structure your theme so there is exactly one primary <h1>, with secondary sections using <h2> and <h3>.',
    });
  }

  seoScore = Math.max(0, seoScore);

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. HERO SECTION & VALUE PROPOSITION
  // ─────────────────────────────────────────────────────────────────────────────
  const heroFinding = [];
  let heroScore = 25;

  // Search for hero / banner section containers
  const heroSelectors = [
    '.banner', '.hero', '[class*="hero"]', '[class*="banner"]',
    '[class*="slideshow"]', 'section[id*="hero"]', 'section[id*="banner"]',
    'main section:first-of-type', '#MainContent section:first-of-type'
  ];

  let $hero = null;
  for (const sel of heroSelectors) {
    const el = $(sel).first();
    if (el.length > 0 && el.text().trim().length > 0) {
      $hero = el;
      break;
    }
  }

  const heroHeadline = h1Elements[0] || ($hero ? $hero.find('h1, h2, .banner__heading, [class*="heading"]').first().text().trim() : '');
  const heroText = $hero ? $hero.text().trim() : '';

  if (!$hero || heroText.length < 20) {
    heroScore -= 12;
    heroFinding.push({
      title: 'Weak or Missing Hero Section',
      category: 'HERO_AND_CTA',
      severity: 'CRITICAL',
      detected: 'No distinct hero section or prominent above-the-fold banner was identified on the homepage.',
      whyItMatters: 'Visitors decide within 3 seconds whether to stay on your store. Without an engaging hero section, bounce rate on ad traffic skyrockets.',
      recommendation: 'Add an engaging Hero or Image Banner section at the top of your homepage in the Shopify Theme Editor.',
    });
  } else if (!heroHeadline || heroHeadline.length < 5) {
    heroScore -= 8;
    heroFinding.push({
      title: 'Unclear Hero Value Proposition',
      category: 'HERO_AND_CTA',
      severity: 'HIGH',
      detected: 'The hero section does not present a clear, prominent headline explaining what makes your store unique.',
      whyItMatters: 'Without a clear value proposition, shoppers do not immediately grasp what you sell or why they should trust your brand.',
      recommendation: 'Add a bold headline in your hero banner that states your core product promise or primary value proposition.',
    });
  }

  heroScore = Math.max(0, heroScore);

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. CTA (CALL TO ACTION) CLARITY & VISIBILITY
  // ─────────────────────────────────────────────────────────────────────────────
  const ctaFindings = [];
  let ctaScore = 20;

  // Look for primary action buttons in the hero or top of page
  const ctaButtons = [];
  const searchArea = $hero ? $hero : $('body');
  
  searchArea.find('a.button, a.btn, button, [role="button"], a[class*="button"], a[class*="btn"]').each((_, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr('href') || '';
    if (text && text.length < 40) {
      ctaButtons.push({ text, href });
    }
  });

  const hasConversionCTA = ctaButtons.some(b => {
    const t = b.text.toLowerCase();
    return (
      t.includes('shop') || t.includes('buy') || t.includes('explore') ||
      t.includes('order') || t.includes('get') || t.includes('discover') ||
      t.includes('view') || t.includes('collection') || t.includes('browse')
    );
  });

  if (ctaButtons.length === 0) {
    ctaScore -= 15;
    ctaFindings.push({
      title: 'No Hero Call-To-Action (CTA) Button',
      category: 'HERO_AND_CTA',
      severity: 'CRITICAL',
      detected: 'No primary action button or link was found in the above-the-fold hero section.',
      whyItMatters: 'Without a prominent CTA button, visitors are left without a clear next step, leading to lost conversions from paid ads.',
      recommendation: 'Add a high-contrast primary button (such as "Shop New Arrivals" or "Explore Collection") in your hero section.',
    });
  } else if (!hasConversionCTA) {
    ctaScore -= 8;
    ctaFindings.push({
      title: 'Ambiguous or Weak CTA Copy',
      category: 'HERO_AND_CTA',
      severity: 'MEDIUM',
      detected: `Found buttons (${ctaButtons.slice(0, 2).map(b => `"${b.text}"`).join(', ')}), but none use direct action-oriented commerce wording.`,
      whyItMatters: 'Vague button copy ("Click Here", "Learn More") generates significantly lower click-through rates than commerce-oriented verbs ("Shop Now").',
      recommendation: 'Change your main button copy to direct, action-driven verbs like "Shop Collection" or "Explore Best Sellers".',
    });
  }

  // Check for dummy or broken CTA links
  const hasDummyLink = ctaButtons.some(b => b.href === '#' || b.href === '' || b.href === 'javascript:void(0)');
  if (hasDummyLink) {
    ctaScore -= 6;
    ctaFindings.push({
      title: 'Unlinked or Placeholder CTA Button',
      category: 'HERO_AND_CTA',
      severity: 'CRITICAL',
      detected: 'One or more primary buttons have an empty or placeholder link (href="#").',
      whyItMatters: 'Broken or inactive buttons frustrate buyers and create an instant impression of an abandoned or unfinished store.',
      recommendation: 'Link all hero buttons to an active collection (e.g., /collections/all) in your Theme Editor.',
    });
  }

  ctaScore = Math.max(0, ctaScore);

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. NAVIGATION & STORE STRUCTURE
  // ─────────────────────────────────────────────────────────────────────────────
  const navFindings = [];
  const navLinks = $('header nav a, header [role="navigation"] a, nav.header__inline-menu a')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(t => t.length > 0 && t.length < 35);
  
  const uniqueNavLinks = Array.from(new Set(navLinks));
  const hasSearch = $('form[action*="/search"], input[name="q"], [aria-label*="Search"], [class*="search"]').length > 0;
  const hasCart = $('a[href*="/cart"], [class*="cart"], [aria-label*="Cart"]').length > 0;

  if (uniqueNavLinks.length < 2) {
    navFindings.push({
      title: 'Minimal or Missing Header Navigation',
      category: 'VISUAL_PROFESSIONALISM',
      severity: 'HIGH',
      detected: `Only ${uniqueNavLinks.length} navigation link(s) detected in the store header.`,
      whyItMatters: 'Shoppers need clear navigational routes to browse catalog categories. Sparse menus make the store appear unbuilt.',
      recommendation: 'In Online Store > Navigation, assign a comprehensive Main Menu with links to key collections, About Us, and Contact.',
    });
  } else if (uniqueNavLinks.length > 8) {
    navFindings.push({
      title: 'Cluttered Header Navigation',
      category: 'VISUAL_PROFESSIONALISM',
      severity: 'LOW',
      detected: `Header contains ${uniqueNavLinks.length} top-level links, which may cause wrapping or clutter on standard screens.`,
      whyItMatters: 'Too many top-level menu items cause decision fatigue and can wrap awkwardly on smaller laptops.',
      recommendation: 'Consolidate secondary links into dropdown submenus to maintain a clean top-level menu (5-7 links optimal).',
    });
  }

  if (!hasCart) {
    navFindings.push({
      title: 'Cart Icon or Link Not Prominently Detected',
      category: 'VISUAL_PROFESSIONALISM',
      severity: 'HIGH',
      detected: 'Standard cart icon/link was not found in the header markup.',
      whyItMatters: 'Shoppers must always have immediate, one-click access to review their cart.',
      recommendation: 'Verify in your Shopify Theme Editor that the header cart icon is enabled and visible on all devices.',
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. TRUST SIGNALS & POLICY VISIBILITY (Footer & Links)
  // ─────────────────────────────────────────────────────────────────────────────
  const trustFindings = [];
  let trustScore = 25;

  const allPageLinks = $('a').map((_, el) => {
    return {
      text: $(el).text().toLowerCase().trim(),
      href: ($(el).attr('href') || '').toLowerCase(),
    };
  }).get();

  const hasLinkMatching = (keywords) => {
    return allPageLinks.some(l => 
      keywords.some(kw => l.text.includes(kw) || l.href.includes(kw))
    );
  };

  const hasShippingPolicy = hasLinkMatching(['shipping', 'delivery', '/policies/shipping-policy']);
  const hasRefundPolicy = hasLinkMatching(['refund', 'return', '/policies/refund-policy']);
  const hasContactInfo = hasLinkMatching(['contact', 'get in touch', '/pages/contact', 'mailto:']);
  const hasPrivacyPolicy = hasLinkMatching(['privacy', '/policies/privacy-policy']);
  const hasTerms = hasLinkMatching(['terms', '/policies/terms-of-service']);

  const missingPolicies = [];
  if (!hasShippingPolicy) {
    trustScore -= 7;
    missingPolicies.push('Shipping Policy');
  }
  if (!hasRefundPolicy) {
    trustScore -= 7;
    missingPolicies.push('Refund/Return Policy');
  }
  if (!hasContactInfo) {
    trustScore -= 6;
    missingPolicies.push('Contact Us');
  }
  if (!hasPrivacyPolicy) {
    trustScore -= 3;
    missingPolicies.push('Privacy Policy');
  }

  if (missingPolicies.length > 0) {
    trustFindings.push({
      title: `Missing Crucial Trust Links: ${missingPolicies.join(', ')}`,
      category: 'TRUST_SIGNALS',
      severity: missingPolicies.includes('Refund/Return Policy') || missingPolicies.includes('Shipping Policy') ? 'CRITICAL' : 'HIGH',
      detected: `The homepage does not link to standard merchant trust policies: ${missingPolicies.join(', ')}.`,
      whyItMatters: 'Customers and ad networks (Meta, Google) evaluate trust links before approving transactions. Missing return or shipping links creates immediate scam suspicion.',
      recommendation: 'Add clear links to your Shipping Policy, Refund Policy, and Contact Us page in your footer menu via Online Store > Navigation.',
    });
  }

  // Check for payment badge / trust marks in footer
  const footerText = $('footer').text().toLowerCase();
  const hasPaymentBadges = (
    $('footer [class*="payment"]').length > 0 ||
    $('footer svg[class*="icon--"]').length > 0 ||
    footerText.includes('visa') || footerText.includes('mastercard') ||
    footerText.includes('paypal') || footerText.includes('apple pay')
  );

  if (!hasPaymentBadges) {
    trustScore -= 2;
    trustFindings.push({
      title: 'Payment Method Icons Not Displayed in Footer',
      category: 'TRUST_SIGNALS',
      severity: 'LOW',
      detected: 'Payment provider icons (Visa, Mastercard, PayPal, Apple Pay) are not visible in the footer.',
      whyItMatters: 'Visible payment icons reassure first-time visitors that your checkout process uses trusted, recognized payment processors.',
      recommendation: 'Enable "Show payment icons" in your theme\'s Footer settings in the Theme Editor.',
    });
  }

  trustScore = Math.max(0, trustScore);

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. SOCIAL PROOF & REVIEWS VISIBILITY
  // ─────────────────────────────────────────────────────────────────────────────
  const socialProofFindings = [];
  let socialProofScore = 15;

  const reviewAppIndicators = [
    'jdgm', 'judge.me', 'loox', 'yotpo', 'okendo', 'stamped',
    'shopify-product-reviews', 'spr-badge', 'trustpilot', 'feefo',
    'junip', 'fera', 'review-widget'
  ];

  const htmlLower = html.toLowerCase();
  const detectedReviewApp = reviewAppIndicators.find(ind => htmlLower.includes(ind));

  const hasTestimonials = (
    $('[class*="testimonial"]').length > 0 ||
    $('[class*="review"]').length > 0 ||
    htmlLower.includes('customer reviews') ||
    htmlLower.includes('what our customers say')
  );

  if (!detectedReviewApp && !hasTestimonials) {
    socialProofScore -= 10;
    socialProofFindings.push({
      title: 'No Social Proof or Customer Reviews Detected on Homepage',
      category: 'SOCIAL_PROOF',
      severity: 'HIGH',
      detected: 'No customer review widgets (Judge.me, Loox, Yotpo) or testimonial sections were detected on the homepage.',
      whyItMatters: 'Over 92% of online shoppers check reviews before purchasing from an unfamiliar brand. Lacking social proof is a primary driver of paid ad bounce.',
      recommendation: 'Install a certified Shopify review app (e.g. Judge.me) or add a customer testimonial section to your homepage in the Theme Editor.',
    });
  }

  socialProofScore = Math.max(0, socialProofScore);

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. AESTHETICS & TYPOGRAPHY CONSISTENCY
  // ─────────────────────────────────────────────────────────────────────────────
  const aestheticFindings = [];
  
  // Extract external font stylesheets (Google Fonts, Adobe Fonts, Typekit)
  const fontLinks = $('link[href*="fonts.googleapis.com"], link[href*="use.typekit.net"]')
    .map((_, el) => $(el).attr('href'))
    .get();

  const fontFamilies = new Set();
  fontLinks.forEach(link => {
    const match = link.match(/family=([^&:]+)/);
    if (match) {
      match[1].split('|').forEach(f => fontFamilies.add(decodeURIComponent(f).replace(/\+/g, ' ')));
    }
  });

  if (fontFamilies.size > 3) {
    aestheticFindings.push({
      title: 'Excessive Font Families Detected',
      category: 'VISUAL_PROFESSIONALISM',
      severity: 'MEDIUM',
      detected: `Detected ${fontFamilies.size} different external font families loaded on the homepage (${Array.from(fontFamilies).join(', ')}).`,
      whyItMatters: 'Using more than 2-3 distinct font families causes visual inconsistency, impairs branding coherence, and slows page rendering.',
      recommendation: 'Standardize your theme typography to 1 primary heading font and 1 body font in Theme Settings > Typography.',
    });
  }

  // Check for placeholder theme demo text
  const placeholderPhrases = [
    'lorem ipsum', 'talk about your brand', 'share information about your brand',
    'heading goes here', 'subheading goes here', 'welcome to our store'
  ];

  const detectedPlaceholders = placeholderPhrases.filter(p => htmlLower.includes(p));
  if (detectedPlaceholders.length > 0) {
    aestheticFindings.push({
      title: 'Theme Placeholder Copy Detected',
      category: 'VISUAL_PROFESSIONALISM',
      severity: 'CRITICAL',
      detected: `Found default theme template text on the live homepage: "${detectedPlaceholders.join('", "')}".`,
      whyItMatters: 'Unedited theme placeholder text immediately marks a store as incomplete or amateur, destroying buyer confidence.',
      recommendation: 'Replace all template placeholder text with your actual brand storytelling and product highlights.',
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. COMPILE OVERALL ASSESSMENT & VERDICT
  // ─────────────────────────────────────────────────────────────────────────────
  const allFindings = [
    ...trustFindings,
    ...heroFinding,
    ...ctaFindings,
    ...seoFindings,
    ...socialProofFindings,
    ...aestheticFindings,
    ...navFindings,
  ];

  if (isPasswordProtected) {
    allFindings.unshift({
      title: 'Storefront is Password Protected',
      category: 'TRUST_SIGNALS',
      severity: 'CRITICAL',
      detected: 'Your online store is currently locked behind a password page.',
      whyItMatters: 'Customers and ad traffic cannot view products or complete checkout while the password page is active.',
      recommendation: 'When you are ready to launch, disable your password page in Shopify Admin under Online Store > Preferences.',
    });
  }

  const totalScore = Math.max(10, Math.min(100, Math.round(
    seoScore + heroScore + ctaScore + trustScore + socialProofScore + (navFindings.length === 0 ? 5 : 2)
  )));

  let overallVerdict = 'Needs Optimization';
  let verdictBadge = 'warning';
  if (totalScore >= 80 && !isPasswordProtected) {
    overallVerdict = 'Professional & High Trust';
    verdictBadge = 'success';
  } else if (totalScore >= 60 && !isPasswordProtected) {
    overallVerdict = 'Moderate Trust (Fixable Friction)';
    verdictBadge = 'attention';
  } else {
    overallVerdict = 'High Risk / Poor First Impression';
    verdictBadge = 'critical';
  }

  return {
    analyzedAt,
    targetUrl: finalUrl,
    shopDomain: cleanDomain,
    isPasswordProtected,
    overallScore: totalScore,
    overallVerdict,
    verdictBadge,
    scoresBreakdown: {
      heroAndValueProp: { score: heroScore, max: 25 },
      trustAndPolicies: { score: trustScore, max: 25 },
      ctaAndConversion: { score: ctaScore, max: 20 },
      seoFoundation:    { score: seoScore, max: 15 },
      socialProof:      { score: socialProofScore, max: 15 },
    },
    seoSnapshot: {
      pageTitle: pageTitle || '(None)',
      metaDescription: metaDescription || '(None)',
      h1Count: h1Elements.length,
      primaryH1: h1Elements[0] || '(None)',
      viewportConfigured: Boolean(viewportMeta),
    },
    trustSnapshot: {
      shippingPolicy: hasShippingPolicy,
      refundPolicy: hasRefundPolicy,
      contactInfo: hasContactInfo,
      privacyPolicy: hasPrivacyPolicy,
      termsOfService: hasTerms,
      paymentIconsVisible: hasPaymentBadges,
      socialProofDetected: Boolean(detectedReviewApp || hasTestimonials),
      reviewApp: detectedReviewApp || null,
    },
    heroSnapshot: {
      headlineDetected: Boolean(heroHeadline),
      headlineText: heroHeadline || null,
      primaryCtaDetected: ctaButtons.length > 0,
      primaryCtaText: ctaButtons[0]?.text || null,
    },
    findingsCount: allFindings.length,
    criticalCount: allFindings.filter(f => f.severity === 'CRITICAL').length,
    highCount: allFindings.filter(f => f.severity === 'HIGH').length,
    mediumCount: allFindings.filter(f => f.severity === 'MEDIUM').length,
    lowCount: allFindings.filter(f => f.severity === 'LOW').length,
    findings: allFindings,
  };
}

function createFallbackReport({ shopDomain, analyzedAt, error, status }) {
  return {
    analyzedAt,
    shopDomain,
    targetUrl: `https://${shopDomain}`,
    isPasswordProtected: false,
    overallScore: 50,
    overallVerdict: 'Scan Incomplete',
    verdictBadge: 'attention',
    error,
    status,
    scoresBreakdown: {
      heroAndValueProp: { score: 10, max: 25 },
      trustAndPolicies: { score: 10, max: 25 },
      ctaAndConversion: { score: 10, max: 20 },
      seoFoundation:    { score: 10, max: 15 },
      socialProof:      { score: 10, max: 15 },
    },
    seoSnapshot: null,
    trustSnapshot: null,
    heroSnapshot: null,
    findingsCount: 1,
    criticalCount: 0,
    highCount: 1,
    mediumCount: 0,
    lowCount: 0,
    findings: [
      {
        title: 'Could Not Scan Live Storefront',
        category: 'TRUST_SIGNALS',
        severity: 'HIGH',
        detected: error || 'Storefront HTTP request did not complete.',
        whyItMatters: 'ScaleGuard needs to access your live homepage to evaluate conversion readiness and storefront trust.',
        recommendation: 'Check that your store URL is accessible publicly and retry the audit.',
      }
    ],
  };
}
