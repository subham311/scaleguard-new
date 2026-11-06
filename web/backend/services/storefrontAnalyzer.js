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
  // Target document head title specifically and exclude any SVG accessibility titles
  let pageTitle = $('head > title, head title').first().text().trim();
  if (!pageTitle) {
    const nonSvgTitles = $('title').filter((_, el) => $(el).parents('svg').length === 0);
    if (nonSvgTitles.length > 0) {
      pageTitle = $(nonSvgTitles[0]).text().trim();
    }
  }
  // Fallback to og:title or twitter:title if document title is absent in head
  if (!pageTitle) {
    pageTitle = (
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      ''
    ).trim();
  }

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
      detected: 'No <title> tag was found in the homepage document head.',
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
    'main section:first-of-type', '#MainContent section:first-of-type',
    'main > div:first-of-type', '#MainContent > div:first-of-type'
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
  const heroSubhead = $hero ? $hero.find('p, [class*="subheading"], [class*="caption"], .banner__text').first().text().trim() : '';
  const heroText = $hero ? $hero.text().trim() : '';

  if (!$hero || heroText.length < 20) {
    heroScore -= 15;
    heroFinding.push({
      title: 'Weak or Missing Hero Section',
      category: 'HERO_AND_CTA',
      severity: 'CRITICAL',
      detected: 'No distinct hero section or prominent above-the-fold banner was identified on the homepage.',
      whyItMatters: 'Visitors decide within 3 seconds whether to stay on your store. Without an engaging hero section, bounce rate on ad traffic skyrockets.',
      recommendation: 'Add an engaging Hero or Image Banner section at the top of your homepage in the Shopify Theme Editor.',
    });
  } else {
    // 2.1 Headline Quality Check (Max 8 pts)
    if (!heroHeadline || heroHeadline.length < 5) {
      heroScore -= 8;
      heroFinding.push({
        title: 'Unclear or Missing Hero Headline',
        category: 'HERO_AND_CTA',
        severity: 'HIGH',
        detected: 'The hero section does not present a clear, prominent headline explaining what your store offers.',
        whyItMatters: 'Without a prominent headline, shoppers do not immediately grasp your primary product category or store identity.',
        recommendation: 'Add a bold headline in your hero banner that states your core product promise or primary value proposition.',
      });
    }

    // 2.2 Supporting Value Proposition Copy Check (Max 7 pts)
    if (!heroSubhead || heroSubhead.length < 15) {
      heroScore -= 5;
      heroFinding.push({
        title: 'Hero Lacks Supporting Value Proposition Copy',
        category: 'HERO_AND_CTA',
        severity: 'MEDIUM',
        detected: `Hero displays a headline ("${heroHeadline || 'Headline'}") but lacks supporting copy explaining brand benefits or product value.`,
        whyItMatters: 'A headline alone announces a category, but supporting copy explains why shoppers should choose your store over competitors.',
        recommendation: 'Add 1-2 supporting sentences beneath your hero headline highlighting customer benefits (e.g., quality craftsmanship, warranty, or brand guarantee).',
      });
    }

    // 2.3 Customer Benefit / Commercial Differentiation Check (Max 5 pts)
    const benefitKeywords = [
      'guarantee', 'warranty', 'crafted', 'premium', 'quality', 'sustainable',
      'handcrafted', 'exclusive', 'free shipping', 'curated', 'authentic',
      'designed', 'comfort', 'luxury', 'engineered', 'satisfaction', 'satisfy',
      'durable', 'handmade', 'money back', 'secure'
    ];
    const hasBenefitSignal = benefitKeywords.some(kw => heroText.toLowerCase().includes(kw));
    if (!hasBenefitSignal) {
      heroScore -= 3;
      heroFinding.push({
        title: 'Hero Copy Lacks Clear Customer Benefit',
        category: 'HERO_AND_CTA',
        severity: 'LOW',
        detected: `Hero copy states product presence ("${heroHeadline || 'Collection'}") but does not communicate clear customer benefits or store differentiation.`,
        whyItMatters: 'Stating a tangible customer benefit in the hero section builds instant purchase intent and reduces immediate bounce from ad traffic.',
        recommendation: 'Refine your hero copy to highlight a specific value proposition or customer benefit (e.g., "Premium quality apparel crafted for timeless comfort").',
      });
    }
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
  let topNavLinks = [];

  // Specifically target primary desktop navigation containers, excluding mobile drawers
  const desktopNavContainers = $('header nav.header__inline-menu, header nav:not([class*="drawer"]):not([class*="mobile"]), header [role="navigation"]:not([class*="drawer"]):not([class*="mobile"])');

  if (desktopNavContainers.length > 0) {
    const $primaryNav = $(desktopNavContainers[0]);
    const topLis = $primaryNav.find('> ul > li, > ol > li, > div > ul > li');
    if (topLis.length > 0) {
      topLis.each((_, li) => {
        const text = $(li).children('summary, a, button, span').first().text().trim() ||
                     $(li).find('.header__menu-item').first().text().trim();
        if (text && text.length < 40) {
          topNavLinks.push(text);
        }
      });
    }
  }

  // Fallback for flat navigation structures
  if (topNavLinks.length === 0) {
    $('header nav:not([class*="drawer"]):not([class*="mobile"]) > a, header [role="navigation"]:not([class*="drawer"]):not([class*="mobile"]) > a').each((_, a) => {
      const text = $(a).text().trim();
      if (text && text.length < 40) topNavLinks.push(text);
    });
  }

  topNavLinks = Array.from(new Set(topNavLinks));
  const hasSearch = $('form[action*="/search"], input[name="q"], [aria-label*="Search"], [class*="search"]').length > 0;
  const hasCart = $('a[href*="/cart"], [class*="cart"], [aria-label*="Cart"]').length > 0;

  if (topNavLinks.length < 2) {
    navFindings.push({
      title: 'Minimal or Missing Header Navigation',
      category: 'VISUAL_PROFESSIONALISM',
      severity: 'HIGH',
      detected: `Only ${topNavLinks.length} visible top-level navigation item(s) detected in the store header.`,
      whyItMatters: 'Shoppers need clear navigational routes to browse catalog categories. Sparse menus make the store appear unbuilt.',
      recommendation: 'In Online Store > Navigation, assign a comprehensive Main Menu with links to key collections, About Us, and Contact.',
    });
  } else if (topNavLinks.length > 8) {
    navFindings.push({
      title: 'Cluttered Header Navigation',
      category: 'VISUAL_PROFESSIONALISM',
      severity: 'LOW',
      detected: `Header contains ${topNavLinks.length} visible top-level links (${topNavLinks.slice(0, 5).join(', ')}...), which may cause wrapping or clutter on standard screens.`,
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

  // Check for visible theme code / Liquid errors
  const liquidErrorRegex = /Liquid error(?: \([^)]+\))?: [^<>\n]+/gi;
  const rawLiquidErrors = html.match(liquidErrorRegex) || [];
  const uniqueLiquidErrors = Array.from(new Set(rawLiquidErrors.map(e => e.trim())));

  if (uniqueLiquidErrors.length > 0) {
    trustScore -= 10;
    trustFindings.push({
      title: 'Visible Theme Code / Liquid Errors Detected',
      category: 'TRUST_SIGNALS',
      severity: 'CRITICAL',
      detected: `Found ${uniqueLiquidErrors.length} visible Liquid template error(s) on the live storefront: "${uniqueLiquidErrors.slice(0, 3).join('", "')}".`,
      whyItMatters: 'Visible Liquid errors occur when theme code references missing snippets, corrupted assets, or invalid calculations. Seeing raw code errors immediately destroys customer trust and signals an unmaintained or insecure storefront.',
      recommendation: 'Open your Shopify Theme code editor and repair or remove the missing snippet calls or math errors at the indicated theme lines.',
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
  // 7. AESTHETICS, SECTION FLOW & TYPOGRAPHY CONSISTENCY
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

  // Tiered Placeholder Detection: Critical demo text vs. Medium generic copy
  const criticalPlaceholders = [
    'lorem ipsum', 'talk about your brand', 'share information about your brand',
    'heading goes here', 'subheading goes here', 'add your own text here'
  ].filter(p => htmlLower.includes(p));

  const genericCopyPhrases = [
    'welcome to our store', 'welcome to my store'
  ].filter(p => htmlLower.includes(p));

  if (criticalPlaceholders.length > 0) {
    aestheticFindings.push({
      title: 'Theme Demo Placeholder Copy Detected',
      category: 'VISUAL_PROFESSIONALISM',
      severity: 'CRITICAL',
      detected: `Found unedited theme demo placeholder text on the live homepage: "${criticalPlaceholders.join('", "')}".`,
      whyItMatters: 'Unedited demo template text immediately marks a store as incomplete or amateur, destroying buyer confidence.',
      recommendation: 'Replace all template placeholder text with your actual brand storytelling and product highlights.',
    });
  }

  if (genericCopyPhrases.length > 0) {
    aestheticFindings.push({
      title: 'Generic Announcement / Header Copy Detected',
      category: 'VISUAL_PROFESSIONALISM',
      severity: 'MEDIUM',
      detected: `Found generic default text: "${genericCopyPhrases.join('", "')}" in the announcement bar or header.`,
      whyItMatters: 'Announcement bars are prime above-the-fold real estate. Generic greeting copy underutilizes valuable space that could communicate conversion incentives like free shipping thresholds, discount codes, or satisfaction guarantees.',
      recommendation: 'Update your announcement bar in the Theme Editor with a clear customer incentive (e.g., "Free Shipping on Orders Over $50" or "Sign Up for 10% Off").',
    });
  }

  // Section Flow & Layout Repetition Analyzer
  const sections = [];
  $('main > div, main > section, #MainContent > div, #MainContent > section, [id*="shopify-section-template-"]').each((_, el) => {
    const id = $(el).attr('id') || '';
    const cls = $(el).attr('class') || '';
    const heading = $(el).find('h1, h2, h3').first().text().trim();
    
    let type = 'other';
    const idAndCls = (id + ' ' + cls).toLowerCase();
    if (idAndCls.includes('featured_collection') || idAndCls.includes('featured-collection') || idAndCls.includes('collection-list') || idAndCls.includes('product-grid')) {
      type = 'featured_collection';
    } else if (idAndCls.includes('banner') || idAndCls.includes('hero') || idAndCls.includes('slideshow')) {
      type = 'hero_banner';
    } else if (idAndCls.includes('rich_text') || idAndCls.includes('rich-text')) {
      type = 'rich_text';
    } else if (idAndCls.includes('testimonial') || idAndCls.includes('review')) {
      type = 'testimonial';
    } else if (idAndCls.includes('featured_product') || idAndCls.includes('featured-product')) {
      type = 'featured_product';
    }

    if ($(el).text().trim().length > 30) {
      sections.push({ id, type, heading });
    }
  });

  let maxConsecutiveCollections = 0;
  let currentConsecutive = 0;
  sections.forEach(s => {
    if (s.type === 'featured_collection') {
      currentConsecutive++;
      if (currentConsecutive > maxConsecutiveCollections) {
        maxConsecutiveCollections = currentConsecutive;
      }
    } else {
      currentConsecutive = 0;
    }
  });

  if (maxConsecutiveCollections >= 4) {
    aestheticFindings.push({
      title: 'Repetitive Homepage Section Layout',
      category: 'VISUAL_PROFESSIONALISM',
      severity: 'MEDIUM',
      detected: `Detected ${maxConsecutiveCollections} consecutive product collection grids without visual breaks or contrasting content blocks.`,
      whyItMatters: 'Stacking multiple collection grids consecutively creates visual monotony and scroll fatigue. Shoppers lose focus, and product hierarchy is diluted before reaching key trust signals or reviews.',
      recommendation: 'Break up consecutive product grids with visual dividers, promotional banners, lifestyle imagery, brand storytelling, or tabbed collection displays.',
    });
  }

  if (sections.length > 14) {
    aestheticFindings.push({
      title: 'Excessive Homepage Length & Scroll Depth',
      category: 'VISUAL_PROFESSIONALISM',
      severity: 'LOW',
      detected: `Homepage contains ${sections.length} stacked sections, creating an exceptionally deep page scroll.`,
      whyItMatters: 'Extremely long homepages slow down mobile rendering and lead to steep drop-offs before visitors reach testimonials, value propositions, or policy links.',
      recommendation: 'Curate your homepage to 6-10 high-impact sections, moving secondary product categories into main navigation menus.',
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

  // Transparent scoring: Overall score equals the exact mathematical sum of visible category scores (100 Max)
  trustScore = Math.max(0, trustScore);
  heroScore = Math.max(0, heroScore);
  ctaScore = Math.max(0, ctaScore);
  seoScore = Math.max(0, seoScore);
  socialProofScore = Math.max(0, socialProofScore);

  const totalScore = Math.max(10, Math.min(100, Math.round(
    seoScore + heroScore + ctaScore + trustScore + socialProofScore
  )));

  const criticalCount = allFindings.filter(f => f.severity === 'CRITICAL').length;
  const highCount = allFindings.filter(f => f.severity === 'HIGH').length;

  let overallVerdict = 'Needs Optimization';
  let verdictBadge = 'warning';

  // Strict Severity Gating: Genuinely Critical issues prevent "Professional & High Trust"
  if (isPasswordProtected) {
    overallVerdict = 'Store Locked (Password Active)';
    verdictBadge = 'critical';
  } else if (criticalCount > 0) {
    overallVerdict = 'Needs Attention: Critical Issues Detected';
    verdictBadge = 'critical';
  } else if (totalScore >= 80 && highCount <= 1) {
    overallVerdict = 'Professional & High Trust';
    verdictBadge = 'success';
  } else if (totalScore >= 60) {
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
      liquidErrorsDetected: uniqueLiquidErrors.length > 0,
      liquidErrors: uniqueLiquidErrors,
    },
    heroSnapshot: {
      headlineDetected: Boolean(heroHeadline),
      headlineText: heroHeadline || null,
      primaryCtaDetected: ctaButtons.length > 0,
      primaryCtaText: ctaButtons[0]?.text || null,
      hasSupportingCopy: Boolean(heroSubhead && heroSubhead.length >= 15),
    },
    navigationSnapshot: {
      topLevelLinksCount: topNavLinks.length,
      links: topNavLinks,
    },
    layoutSnapshot: {
      totalSections: sections.length,
      consecutiveCollectionGrids: maxConsecutiveCollections,
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
