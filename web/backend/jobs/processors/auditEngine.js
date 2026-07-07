import prisma from '../../config/database.js';
import {
  detectProductLanguage,
  isGenericDescriptionForLang,
  getStopWords
} from '../../utils/languageDetector.js';

const LAZY_INVENTORY_VALUES = new Set([999, 9999, 10000]);
const DESCRIPTION_MIN_CHARS = 350; // ~70 words
const EXCESSIVE_IMAGE_THRESHOLD = 20;
const UNREALISTIC_INVENTORY_THRESHOLD = 5000;

// Severity sort order
const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function getFileName(url) {
  try {
    const u = new URL(url);
    const pathname = u.pathname;
    return pathname.substring(pathname.lastIndexOf('/') + 1);
  } catch (e) {
    return url;
  }
}

function getFileNamePrefix(filename) {
  const cleanName = filename.split('?')[0].replace(/\.[^/.]+$/, "");
  return cleanName.replace(/[\-_]\d+$|\d+$/, "").toLowerCase().trim();
}

export function calculateDominantVisualStandard(products) {
  let squareCount = 0;
  let portraitCount = 0;
  let landscapeCount = 0;
  let totalWithImages = 0;

  for (const product of products) {
    const images = Array.isArray(product.images) ? product.images : [];
    const primaryImg = images.find(img => img.position === 1) || images[0];
    if (primaryImg && primaryImg.width > 0 && primaryImg.height > 0) {
      const ratio = primaryImg.width / primaryImg.height;
      totalWithImages++;
      if (ratio >= 0.95 && ratio <= 1.05) {
        squareCount++;
      } else if (ratio < 0.95) {
        portraitCount++;
      } else {
        landscapeCount++;
      }
    }
  }

  if (totalWithImages === 0) return null;

  const squareRatio = squareCount / totalWithImages;
  const portraitRatio = portraitCount / totalWithImages;
  const landscapeRatio = landscapeCount / totalWithImages;

  if (squareRatio >= 0.7) return 'SQUARE';
  if (portraitRatio >= 0.7) return 'PORTRAIT';
  if (landscapeRatio >= 0.7) return 'LANDSCAPE';

  return null;
}

export function auditProductImages(product, auditRunId, isVisualOverride, dominantVisualStandard) {
  const issues = [];
  const images = Array.isArray(product.images) ? product.images : [];
  if (images.length === 0) return issues;

  const shopifyId = product.shopifyId;
  const title = product.title;

  // 1. DUPLICATE_IMAGES
  const exactDuplicates = [];
  const nearDuplicates = [];
  
  for (let i = 0; i < images.length; i++) {
    const imgA = images[i];
    const urlA = imgA.src.split('?')[0];
    const fileA = getFileName(imgA.src);
    
    for (let j = i + 1; j < images.length; j++) {
      const imgB = images[j];
      const urlB = imgB.src.split('?')[0];
      const fileB = getFileName(imgB.src);
      
      if (urlA === urlB) {
        exactDuplicates.push({ imgA: imgA.id, imgB: imgB.id, src: imgA.src });
      } else if (
        imgA.width > 0 && imgA.height > 0 &&
        imgA.width === imgB.width &&
        imgA.height === imgB.height &&
        ((imgA.alt !== '' && imgA.alt === imgB.alt) || (fileA === fileB))
      ) {
        nearDuplicates.push({ imgA: imgA.id, imgB: imgB.id, file: fileA });
      }
    }
  }

  if (exactDuplicates.length > 0 || nearDuplicates.length > 0) {
    issues.push({
      auditRunId,
      type: 'DUPLICATE_IMAGES',
      severity: 'MEDIUM',
      category: 'CONTENT',
      affectedEntities: [shopifyId],
      evidence: {
        title,
        exactCount: exactDuplicates.length,
        nearCount: nearDuplicates.length,
        reason: 'Duplicate or near-identical images detected in product gallery.',
        businessImpact: 'Duplicate imagery looks unprofessional and cluttering.',
        confidence: 'HIGH',
      }
    });
  }

  // 2. LIMITED_IMAGE_DIVERSITY
  if (images.length >= 3) {
    const firstImg = images[0];
    const allSameSize = images.every(img => img.width > 0 && img.height > 0 && img.width === firstImg.width && img.height === firstImg.height);
    const allSameAlt = images.every(img => img.alt === firstImg.alt);
    
    const firstPrefix = getFileNamePrefix(getFileName(firstImg.src));
    const allSimilarNames = firstPrefix.length >= 5 && images.every(img => {
      const prefix = getFileNamePrefix(getFileName(img.src));
      return prefix.startsWith(firstPrefix) || firstPrefix.startsWith(prefix);
    });

    if (allSameSize && allSameAlt && allSimilarNames) {
      issues.push({
        auditRunId,
        type: 'LIMITED_IMAGE_DIVERSITY',
        severity: 'MEDIUM',
        category: 'CONTENT',
        affectedEntities: [shopifyId],
        evidence: {
          title,
          imageCount: images.length,
          reason: 'Product images provide limited additional information due to high visual similarity.',
          businessImpact: 'Buyers do not get alternative views or detail shots, creating purchase hesitation.',
          confidence: 'MEDIUM',
        }
      });
    }
  }

  // 3. LOW_QUALITY_IMAGE
  const lowQualityImages = [];
  const placeholderTerms = ['placeholder', 'thumbnail', 'temp', 'default', 'preview', 'icon', '_thumb', '_small'];
  
  for (const img of images) {
    const filename = getFileName(img.src).toLowerCase();
    const alt = img.alt.toLowerCase();
    
    const isLowRes = img.width > 0 && img.height > 0 && (img.width < 400 || img.height < 400);
    const ratio = img.width > 0 && img.height > 0 ? img.width / img.height : 1;
    const isDistorted = img.width > 0 && img.height > 0 && (ratio > 3.5 || ratio < 0.28);
    const isPlaceholder = placeholderTerms.some(term => filename.includes(term) || alt.includes(term));
    
    if (isLowRes || isDistorted || isPlaceholder) {
      lowQualityImages.push({
        id: img.id,
        src: img.src,
        width: img.width,
        height: img.height,
        reasons: [
          isLowRes ? 'low-resolution' : null,
          isDistorted ? 'distorted aspect-ratio' : null,
          isPlaceholder ? 'placeholder/thumbnail indicator' : null
        ].filter(Boolean)
      });
    }
  }

  if (lowQualityImages.length > 0) {
    issues.push({
      auditRunId,
      type: 'LOW_QUALITY_IMAGE',
      severity: 'HIGH',
      category: 'CONTENT',
      affectedEntities: [shopifyId],
      evidence: {
        title,
        lowQualityCount: lowQualityImages.length,
        lowQualityDetails: lowQualityImages,
        reason: 'Pixelated, blurry, or extremely low-resolution images detected.',
        businessImpact: 'Blurry images decrease perceived brand quality and conversions.',
        confidence: 'HIGH',
      }
    });
  }

  // 4. INCONSISTENT_PRIMARY_IMAGE
  const primaryImg = images.find(img => img.position === 1) || images[0];
  if (primaryImg && images.length > 1) {
    const filename = getFileName(primaryImg.src).toLowerCase();
    const alt = primaryImg.alt.toLowerCase();
    
    const isSizeGuide = ['size chart', 'size-chart', 'size guide', 'size-guide', 'tabla de tallas', 'tabla-de-tallas', 'guia de tamanhos', 'tableau des tailles'].some(term => filename.includes(term) || alt.includes(term));
    const isPackaging = ['packaging', 'package', 'box', 'caja', 'embalaje'].some(term => filename.includes(term) || alt.includes(term));
    const isPlaceholder = ['logo', 'banner'].some(term => filename.includes(term) || alt.includes(term));
    
    if (isSizeGuide || isPackaging || isPlaceholder) {
      issues.push({
        auditRunId,
        type: 'INCONSISTENT_PRIMARY_IMAGE',
        severity: 'HIGH',
        category: 'CONTENT',
        affectedEntities: [shopifyId],
        evidence: {
          title,
          primarySrc: primaryImg.src,
          detectedType: isSizeGuide ? 'SIZE_GUIDE' : (isPackaging ? 'PACKAGING' : 'PLACEHOLDER'),
          reason: 'Primary image represents size guide, packaging, or placeholder rather than the actual product.',
          businessImpact: 'First impressions matter; showing a size chart first drives immediate user bounces.',
          confidence: 'HIGH',
        }
      });
    }
  }

  // 5. INCONSISTENT_STORE_VISUALS
  if (!isVisualOverride && dominantVisualStandard && primaryImg && primaryImg.width > 0 && primaryImg.height > 0) {
    const ratio = primaryImg.width / primaryImg.height;
    let category = 'SQUARE';
    if (ratio < 0.95) category = 'PORTRAIT';
    else if (ratio > 1.05) category = 'LANDSCAPE';
    
    if (category !== dominantVisualStandard) {
      issues.push({
        auditRunId,
        type: 'INCONSISTENT_STORE_VISUALS',
        severity: 'MEDIUM',
        category: 'CONTENT',
        affectedEntities: [shopifyId],
        evidence: {
          title,
          productAspect: category,
          dominantStoreAspect: dominantVisualStandard,
          reason: 'Product primary image aspect ratio is visually inconsistent with store catalog standards.',
          businessImpact: 'Inconsistent catalog visuals make lists look cluttered and uncurated.',
          confidence: 'MEDIUM',
        }
      });
    }
  }

  return issues;
}

export function isApparelOrFootwear(product) {
  const type = (product.productType || '').toLowerCase();
  const tags = (product.tags || '').toLowerCase();
  const title = (product.title || '').toLowerCase();

  const apparelFootwearTerms = [
    'apparel', 'clothing', 'shirt', 't-shirt', 'tshirt', 'pant', 'jeans', 'trousers',
    'dress', 'skirt', 'jacket', 'coat', 'hoodie', 'sweater', 'cardigan',
    'socks', 'footwear', 'shoe', 'sneaker', 'boot', 'sandal', 'slipper', 'heel',
    'vest', 'suit', 'blazer', 'underwear', 'pajama', 'swimwear', 'bikini',
    'activewear', 'joggers', 'leggings', 'tights', 'wear', 'ropa', 'camisa',
    'camiseta', 'vestido', 'pantalón', 'pantalon', 'chaqueta', 'abrigo', 'sudadera',
    'calcetines', 'calzado', 'zapato', 'zapatilla', 'bota', 'sandalia', 'traje',
    'interior', 'pijama', 'tallas'
  ];

  if (type && apparelFootwearTerms.some(term => type.includes(term))) {
    return true;
  }

  if (tags) {
    const tagList = tags.split(/[\s,]+/).filter(Boolean);
    if (tagList.some(tag => apparelFootwearTerms.some(term => tag.includes(term)))) {
      return true;
    }
  }

  const words = title.split(/\s+/).filter(Boolean);
  if (words.some(word => apparelFootwearTerms.some(term => word === term || (word.length > 3 && word.includes(term))))) {
    return true;
  }

  return false;
}

export function hasSizeGuide(product) {
  const desc = (product.description || '').toLowerCase();
  const images = Array.isArray(product.images) ? product.images : [];

  const sizeGuideTerms = [
    'size chart', 'size-chart', 'size guide', 'size-guide', 'sizing chart',
    'sizing guide', 'measurements', 'measurement chart', 'sizing info',
    'sizing guidance', 'fits true to size', 'fit guide',
    'tabla de tallas', 'tabla-de-tallas', 'guía de tallas', 'guia de tallas',
    'medidas', 'guia de tamanhos', 'tabela de tamanhos',
    'tableau des tailles', 'grössentabelle', 'groessentabelle',
    'guida alle taglie', 'tabella taglie'
  ];

  if (sizeGuideTerms.some(term => desc.includes(term))) {
    return true;
  }

  for (const img of images) {
    const filename = getFileName(img.src).toLowerCase();
    const alt = (img.alt || '').toLowerCase();

    if (sizeGuideTerms.some(term => filename.includes(term) || alt.includes(term))) {
      return true;
    }
  }

  return false;
}

export function hasProductSpecifications(product) {
  const desc = (product.description || '').toLowerCase();

  const specTerms = [
    'material', 'cotton', 'polyester', 'nylon', 'leather', 'denim', 'wool', 'silk',
    'linen', 'acrylic', 'spandex', 'canvas', 'wood', 'metal', 'steel', 'iron', 'gold',
    'silver', 'bronze', 'copper', 'aluminum', 'plastic', 'glass', 'ceramic', 'silicone',
    'algodón', 'poliéster', 'cuero', 'lana', 'seda', 'lino', 'acrílico', 'madera',
    'metal', 'acero', 'hierro', 'oro', 'plata', 'plástico', 'silicona',
    'dimensions', 'dimension', 'size', 'width', 'height', 'depth', 'length', 'thickness',
    'weight', 'diameter', 'volume', 'capacity', 'size:', 'talla', 'tallas', 'medidas',
    'ancho', 'alto', 'largo', 'peso', 'grosor', 'diámetro', 'capacidad',
    'specification', 'specifications', 'technical spec', 'package list', 'packing list',
    'package includes', 'box contents', 'includes:', 'especificación', 'especificaciones',
    'contenido del paquete', 'incluye:', 'especificaciones técnicas'
  ];

  let matches = 0;
  for (const term of specTerms) {
    if (desc.includes(term)) {
      matches++;
    }
  }

  const lines = desc.split(/<br\s*\/?>|\n/i);
  const colonSpecCount = lines.filter(line => {
    const cleanLine = line.replace(/<[^>]*>?/gm, '').trim();
    return cleanLine.includes(':') && specTerms.some(term => cleanLine.toLowerCase().includes(term));
  }).length;

  if (matches >= 2 || colonSpecCount >= 1) {
    return true;
  }

  return false;
}

export function auditProductOrganization(product, auditRunId) {
  const issues = [];
  const missing = [];

  const type = (product.productType || '').trim();
  const tags = (product.tags || '').trim();
  const vendor = (product.vendor || '').trim();

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

  if (!type || type.toLowerCase() === 'null') missing.push('product type');
  if (!tags || tags.toLowerCase() === 'null') missing.push('tags');
  if (!vendor || vendor.toLowerCase() === 'null') missing.push('vendor');
  if (collections.length === 0) missing.push('collection assignment');

  if (missing.length > 0) {
    issues.push({
      auditRunId,
      type: 'INCOMPLETE_ORGANIZATION',
      severity: 'LOW',
      category: 'CONSISTENCY',
      affectedEntities: [product.shopifyId],
      evidence: {
        title: product.title,
        missingFields: missing,
        reason: `Product is missing standard organizational metadata: ${missing.join(', ')}.`,
        businessImpact: 'Missing tags, types, vendors, or collections limits product filtering and smart storefront navigation.',
        confidence: 'HIGH',
      }
    });
  }

  return issues;
}

export function auditProductMetafields(product, auditRunId) {
  const issues = [];
  const missing = [];

  const desc = (product.description || '').toLowerCase();
  const tags = (product.tags || '').toLowerCase();
  const title = (product.title || '').toLowerCase();

  // 1. Material/Fabric
  const materialTerms = [
    'cotton', 'polyester', 'nylon', 'leather', 'denim', 'wool', 'silk', 'linen',
    'acrylic', 'spandex', 'canvas', 'wood', 'metal', 'steel', 'iron', 'gold',
    'silver', 'bronze', 'copper', 'aluminum', 'plastic', 'glass', 'ceramic', 'silicone',
    'material', 'composition', 'fabric', 'composición', 'algodón', 'poliéster',
    'cuero', 'lana', 'seda', 'lino', 'acrílico', 'madera', 'metal', 'acero',
    'hierro', 'oro', 'plata', 'plástico', 'silicona'
  ];
  const hasMaterial = materialTerms.some(term => desc.includes(term) || tags.includes(term));
  if (!hasMaterial) missing.push('material/fabric');

  // 2. Colour
  const colorTerms = [
    'color', 'colour', 'red', 'blue', 'green', 'black', 'white', 'yellow', 'pink',
    'orange', 'purple', 'gold', 'silver', 'brown', 'grey', 'gray', 'multicolor',
    'color:', 'plata', 'oro', 'rojo', 'azul', 'verde', 'negro', 'blanco',
    'amarillo', 'rosa', 'naranja', 'morado', 'gris'
  ];
  const hasColor = colorTerms.some(term => desc.includes(term) || tags.includes(term) || title.includes(term));
  if (!hasColor) missing.push('colour');

  // 3. Age Group / Gender
  const ageTerms = [
    'age', 'group', 'men', 'women', 'kid', 'child', 'adult', 'baby', 'toddler',
    'unisex', 'gender', 'hombre', 'mujer', 'niño', 'niña', 'adulto', 'bebé'
  ];
  const hasAgeGroup = ageTerms.some(term => desc.includes(term) || tags.includes(term) || title.includes(term));
  if (!hasAgeGroup) missing.push('age group');

  // 4. Product Features
  const featureTerms = [
    'feature', 'features', 'benefits', 'details', 'key features', 'características',
    'beneficios', 'detalles'
  ];
  const hasBulletPoints = desc.includes('<li') || desc.includes('<li>');
  const hasFeatures = hasBulletPoints || featureTerms.some(term => desc.includes(term));
  if (!hasFeatures) missing.push('product features');

  if (missing.length >= 2) {
    issues.push({
      auditRunId,
      type: 'MISSING_RECOMMENDED_METAFIELDS',
      severity: 'LOW',
      category: 'CONSISTENCY',
      affectedEntities: [product.shopifyId],
      evidence: {
        title: product.title,
        missingMetafields: missing,
        reason: `Product description or options are missing recommended metafields: ${missing.join(', ')}.`,
        businessImpact: 'Missing structured metafield attributes (fabric, color, age group, features) weakens SEO schema and faceted catalog searches.',
        confidence: 'MEDIUM',
      }
    });
  }

  return issues;
}

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

function isWeakTitle(title, lang = 'en') {
  if (!title) return false;
  const t = title.trim();
  if (t.length < 5) return true;
  const minWordLen = lang === 'en' ? 2 : 1; // allow single-char words in non-English
  const words = t.split(/\s+/).filter(w => w.length >= minWordLen);
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

function isKeywordStuffedTitle(title, lang = 'en') {
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
  const stopWords = getStopWords(lang);
  const words = tLower.split(/[\s,\|/\-_]+/).filter(w => w.length >= 3);
  const wordCounts = {};
  for (const w of words) {
    if (stopWords.includes(w)) continue; // ignore common language-specific function words
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

function isSpecDumpDescription(html, lang = 'en') {
  if (!html) return false;
  const text = html.replace(/<[^>]*>?/gm, '').trim();
  if (text.length === 0) return false;
  
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  
  const SPEC_KEYWORDS_BY_LANG = {
    en: ['material', 'dimension', 'size', 'package', 'includes', 'specification', 'cotton', 'polyester', 'weight', 'height', 'width', 'depth', 'contents', 'fabric', 'color', 'colour', 'measurement', 'length', 'composition', 'package list', 'packing list', 'package includes', 'technical data'],
    es: ['material', 'dimensión', 'tamaño', 'paquete', 'incluye', 'especificación', 'algodón', 'poliéster', 'peso', 'altura', 'ancho', 'profundidad', 'contenido', 'tela', 'color', 'medida', 'longitud', 'composición', 'lista de empaque', 'especificaciones técnicas'],
    pt: ['material', 'dimensão', 'tamanho', 'pacote', 'inclui', 'especificação', 'algodão', 'poliéster', 'peso', 'altura', 'largura', 'profundidade', 'conteúdo', 'tecido', 'cor', 'medida', 'comprimento', 'composição', 'lista de embalagem', 'dados técnicos'],
    fr: ['matériau', 'dimension', 'taille', 'emballage', 'comprend', 'spécification', 'coton', 'polyester', 'poids', 'hauteur', 'largeur', 'profondeur', 'contenu', 'tissu', 'couleur', 'mesure', 'longueur', 'composition', 'liste de colisage', 'données techniques'],
    de: ['material', 'abmessung', 'größe', 'paket', 'beinhaltet', 'spezifikation', 'baumwolle', 'polyester', 'gewicht', 'höhe', 'breite', 'tiefe', 'inhalt', 'stoff', 'farbe', 'messung', 'länge', 'zusammensetzung', 'packliste', 'technische daten'],
    it: ['materiale', 'dimensione', 'misura', 'pacchetto', 'include', 'specifica', 'cotone', 'poliestere', 'peso', 'altezza', 'larghezza', 'profondità', 'contenuto', 'tessuto', 'colore', 'misurazione', 'lunghezza', 'composizione', 'lista di imballaggio', 'dati tecnici']
  };

  const COPY_KEYWORDS_BY_LANG = {
    en: ['perfect', 'designed', 'feature', 'great', 'love', 'comfortable', 'style', 'unique', 'beautiful', 'feel', 'enjoy', 'special', 'gift', 'premium', 'high quality', 'wear', 'look', 'choose', 'experience', 'versatile', 'modern', 'durable'],
    es: ['perfecto', 'diseñado', 'característica', 'excelente', 'amor', 'cómodo', 'estilo', 'único', 'hermoso', 'sentir', 'disfrutar', 'especial', 'regalo', 'premium', 'alta calidad', 'llevar', 'aspecto', 'elegir', 'experiencia', 'versátil', 'moderno', 'duradero'],
    pt: ['perfeito', 'projetado', 'característica', 'excelente', 'amor', 'confortável', 'estilo', 'único', 'lindo', 'sentir', 'aproveitar', 'especial', 'presente', 'premium', 'alta qualidade', 'usar', 'aparência', 'escolher', 'experiência', 'versátil', 'moderno', 'durável'],
    fr: ['parfait', 'conçu', 'caractéristique', 'excellent', 'amour', 'confortable', 'style', 'unique', 'beau', 'ressentir', 'profiter', 'spécial', 'cadeau', 'premium', 'haute qualité', 'porter', 'apparence', 'choisir', 'expérience', 'polyvalent', 'moderne', 'durable'],
    de: ['perfekt', 'entwickelt', 'merkmal', 'großartig', 'liebe', 'bequem', 'stil', 'einzigartig', 'schön', 'fühlen', 'genießen', 'speziell', 'geschenk', 'premium', 'hohe qualität', 'tragen', 'aussehen', 'wählen', 'erfahrung', 'vielseitig', 'modern', 'langlebig'],
    it: ['perfetto', 'progettato', 'caratteristica', 'eccellente', 'amore', 'comodo', 'stile', 'unico', 'bello', 'sentire', 'godere', 'speciale', 'regalo', 'premium', 'alta qualità', 'indossare', 'aspetto', 'scegliere', 'esperienza', 'versatile', 'moderno', 'durevole']
  };

  const specKeywords = SPEC_KEYWORDS_BY_LANG[lang] || SPEC_KEYWORDS_BY_LANG.en;
  const copyKeywords = COPY_KEYWORDS_BY_LANG[lang] || COPY_KEYWORDS_BY_LANG.en;
  
  let specLineCount = 0;
  let totalWords = 0;
  let specWordCount = 0;
  
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  totalWords = words.length;
  
  for (const word of words) {
    if (specKeywords.some(kw => word.includes(kw))) {
      specWordCount++;
    }
  }
  
  let copyWordCount = 0;
  for (const word of words) {
    if (copyKeywords.some(kw => word.includes(kw))) {
      copyWordCount++;
    }
  }
  
  let linesWithColon = 0;
  for (const line of lines) {
    const lLower = line.toLowerCase();
    if (lLower.includes(':')) {
      linesWithColon++;
    }
    if (specKeywords.some(kw => lLower.includes(kw))) {
      specLineCount++;
    }
  }
  
  const colonRatio = lines.length > 0 ? linesWithColon / lines.length : 0;
  const specLineRatio = lines.length > 0 ? specLineCount / lines.length : 0;
  const specWordRatio = totalWords > 0 ? specWordCount / totalWords : 0;
  const copyRatio = totalWords > 0 ? copyWordCount / totalWords : 0;
  
  if (totalWords > 120 && copyWordCount >= 2) {
    return false;
  }
  
  if ((colonRatio > 0.4 || specLineRatio > 0.4 || specWordRatio > 0.3) && copyRatio < 0.05) {
    return true;
  }
  
  return false;
}

function isSupplierDescription(html) {
  if (!html) return false;
  const text = html.replace(/<[^>]*>?/gm, '').toLowerCase();
  
  const supplierPhrases = [
    'due to manual measurement',
    'allow slight difference',
    'color deviation',
    'actual color may be slightly',
    'brand new and high quality',
    '100% brand new',
    'please allow',
    'item color displayed in photos',
    'due to the light and screen difference',
    'wholesale and drop shipping',
    'drop shipping',
    'dropshipping',
    'aliexpress',
    'temu',
    'china post',
    'estimated delivery time',
    'import duties',
    'tax not included',
    'factory direct',
    'no package box',
    'opp bag package',
    'satisfaction guarantee contact us'
  ];
  
  let phraseMatches = 0;
  for (const phrase of supplierPhrases) {
    if (text.includes(phrase)) {
      phraseMatches++;
    }
  }
  
  return phraseMatches >= 1;
}

function calculateDescriptionQualityScore(html, title, lang = 'en') {
  if (!html) return 0;
  const text = html.replace(/<[^>]*>?/gm, '').trim();
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) return 0;
  
  let score = 100;
  
  // 1. Readability & Formatting (max 20%)
  const hasFormatting = /<p[ >]/i.test(html) || /<br[ >\/]/i.test(html) || /<li[ >]/i.test(html) || /<div[ >]/i.test(html) || /<span[ >]/i.test(html) || /<ul[ >]/i.test(html) || /<ol[ >]/i.test(html);
  if (!hasFormatting) {
    score -= 15;
  }
  if (wordCount < 30) {
    score -= 20;
  } else if (wordCount < 75) {
    score -= 10;
  }
  
  // 2. Customer Benefits (max 30%)
  const BENEFIT_KEYWORDS_BY_LANG = {
    en: ['perfect for', 'ideal for', 'enjoy', 'comfortable', 'easy to', 'designed to', 'protect', 'saves', 'improve', 'best', 'benefit', 'helps', 'reduces', 'enhances', 'essential', 'must-have', 'love', 'amazing', 'beautiful'],
    es: ['perfecto para', 'ideal para', 'disfruta', 'cómodo', 'fácil de', 'diseñado para', 'protege', 'ahorra', 'mejora', 'mejor', 'beneficio', 'ayuda', 'reduce', 'esencial', 'imprescindible', 'encanta', 'increíble', 'hermoso', 'diseño', 'estilo', 'clásico', 'combinar', 'combina', 'ideal'],
    pt: ['perfeito para', 'ideal para', 'aproveite', 'confortável', 'fácil de', 'projetado para', 'protege', 'economiza', 'melhora', 'melhor', 'benefício', 'ajuda', 'reduz', 'essencial', 'indispensável', 'adora', 'incrível', 'lindo'],
    fr: ['parfait pour', 'idéal pour', 'profitez', 'confortable', 'facile à', 'conçu pour', 'protège', 'économise', 'améliore', 'meilleur', 'bénéfice', 'aide', 'réduit', 'essentiel', 'indispensable', 'adore', 'incroyable', 'magnifique'],
    de: ['perfekt für', 'ideal für', 'genießen', 'bequem', 'einfach zu', 'entwickelt für', 'schützt', 'spart', 'verbessert', 'beste', 'vorteil', 'hilft', 'reduziert', 'essenziell', 'unverzichtbar', 'lieben', 'toll', 'wunderschön'],
    it: ['perfetto per', 'ideale per', 'goditi', 'comodo', 'facile da', 'progettato per', 'protegge', 'risparmia', 'migliora', 'migliore', 'beneficio', 'aiuta', 'riduce', 'essenziale', 'indispensabile', 'adora', 'incredibile', 'bellissimo']
  };

  const benefitKeywords = BENEFIT_KEYWORDS_BY_LANG[lang] || BENEFIT_KEYWORDS_BY_LANG.en;
  const textLower = text.toLowerCase();
  let benefitMatches = 0;
  for (const kw of benefitKeywords) {
    if (textLower.includes(kw)) {
      benefitMatches++;
    }
  }
  if (benefitMatches === 0) {
    score -= 25;
  } else if (benefitMatches === 1) {
    score -= 15;
  } else if (benefitMatches === 2) {
    score -= 5;
  }
  
  // 3. Trust Signals (max 25%)
  const TRUST_KEYWORDS_BY_LANG = {
    en: ['guarantee', 'warranty', 'refund', 'return', 'support', 'contact us', 'satisfaction', 'safe', 'secure', 'durable', 'premium quality', 'tested'],
    es: ['garantía', 'garantiza', 'reembolso', 'devolución', 'soporte', 'contáctanos', 'satisfacción', 'seguro', 'duradero', 'calidad premium', 'probado', 'plata', 'calidad', 'oro', 'artesanal'],
    pt: ['garantia', 'garante', 'reembolso', 'devolução', 'suporte', 'contate-nos', 'satisfação', 'seguro', 'durável', 'qualidade premium', 'testado'],
    fr: ['garantie', 'remboursement', 'retour', 'support', 'contactez-nous', 'satisfaction', 'sûr', 'durable', 'qualité premium', 'testé'],
    de: ['garantie', 'rückerstattung', 'rückgabe', 'support', 'kontakt', 'zufriedenheit', 'sicher', 'langlebig', 'premium-qualität', 'getestet'],
    it: ['garanzia', 'rimborso', 'reso', 'supporto', 'contattaci', 'soddisfazione', 'sicuro', 'durevole', 'qualità premium', 'testato']
  };

  const trustKeywords = TRUST_KEYWORDS_BY_LANG[lang] || TRUST_KEYWORDS_BY_LANG.en;
  let trustMatches = 0;
  for (const kw of trustKeywords) {
    if (textLower.includes(kw)) {
      trustMatches++;
    }
  }
  if (trustMatches === 0) {
    score -= 20;
  } else if (trustMatches === 1) {
    score -= 10;
  }
  
  // 4. Commercial Strength / Differentiation (max 25%)
  const isSpec = isSpecDumpDescription(html, lang);
  const isSupp = isSupplierDescription(html);
  
  if (isSpec) {
    score -= 30;
  }
  if (isSupp) {
    score -= 20;
  }
  
  return Math.max(0, Math.min(100, score));
}

function buildScoreExplanations(issues, scores) {
  const pricingIssues = issues.filter(i => ['PRICING_ERROR', 'ABSOLUTE_PRICING_ANOMALY'].includes(i.type));
  const titleIssues = issues.filter(i => ['INVALID_PRODUCT_TITLE', 'WEAK_PRODUCT_TITLE', 'SERIAL_PRODUCT_TITLE', 'KEYWORD_STUFFED_TITLE'].includes(i.type));
  const descIssues = issues.filter(i => ['MISSING_DESCRIPTION', 'WEAK_DESCRIPTION', 'GENERIC_DESCRIPTION', 'SPEC_DUMP_DESCRIPTION', 'SUPPLIER_DESCRIPTION', 'MISSING_SIZE_GUIDE', 'MISSING_PRODUCT_SPECIFICATION'].includes(i.type));
  const imageIssues = issues.filter(i => ['NO_PRODUCT_IMAGES', 'LOW_IMAGE_COUNT', 'EXCESSIVE_IMAGE_COUNT', 'DUPLICATE_IMAGES', 'LIMITED_IMAGE_DIVERSITY', 'LOW_QUALITY_IMAGE', 'INCONSISTENT_PRIMARY_IMAGE', 'INCONSISTENT_STORE_VISUALS'].includes(i.type));
  const consistencyIssues = issues.filter(i =>
    ['CATALOG_INCONSISTENCY', 'HIGH_FRAGMENTATION', 'INCONSISTENT_PRICE_POSITIONING', 'VARIANT_PRICE_GAP', 'COLLECTION_PRICE_OUTLIER', 'INCOMPLETE_ORGANIZATION', 'MISSING_RECOMMENDED_METAFIELDS'].includes(i.type)
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
    if (descIssues.length > 0) {
      const specDumps = descIssues.filter(i => i.type === 'SPEC_DUMP_DESCRIPTION').length;
      const suppliers = descIssues.filter(i => i.type === 'SUPPLIER_DESCRIPTION').length;
      const genericOrWeak = descIssues.filter(i => ['MISSING_DESCRIPTION', 'WEAK_DESCRIPTION', 'GENERIC_DESCRIPTION'].includes(i.type)).length;
      
      const descParts = [];
      if (genericOrWeak > 0) descParts.push(`${genericOrWeak} product(s) have missing or insufficient descriptions`);
      if (specDumps > 0) descParts.push(`${specDumps} product(s) have spec-dump descriptions`);
      if (suppliers > 0) descParts.push(`${suppliers} product(s) have supplier-style descriptions`);
      
      if (descParts.length > 0) {
        parts.push(descParts.join(', and '));
      }
    }
    dataQualityExplanation += `Score reduced because ${parts.join(', and ')}.`;
  }

  // Visual Trust
  let visualTrustExplanation = 'Visual Trust covers image count, missing images, and excessive imagery. ';
  const noImg = issues.filter(i => i.type === 'NO_PRODUCT_IMAGES').length;
  const lowImg = issues.filter(i => i.type === 'LOW_IMAGE_COUNT').length;
  const exImg = issues.filter(i => i.type === 'EXCESSIVE_IMAGE_COUNT').length;
  const duplicates = issues.filter(i => i.type === 'DUPLICATE_IMAGES').length;
  const lowDiversity = issues.filter(i => i.type === 'LIMITED_IMAGE_DIVERSITY').length;
  const lowQuality = issues.filter(i => i.type === 'LOW_QUALITY_IMAGE').length;
  const inconsistentPrimary = issues.filter(i => i.type === 'INCONSISTENT_PRIMARY_IMAGE').length;
  const inconsistentVisuals = issues.filter(i => i.type === 'INCONSISTENT_STORE_VISUALS').length;

  const visualParts = [];
  if (noImg > 0) visualParts.push(`${noImg} product(s) have no images at all`);
  if (lowImg > 0) visualParts.push(`${lowImg} product(s) have insufficient images`);
  if (exImg > 0) visualParts.push(`${exImg} product(s) have excessive image counts`);
  if (duplicates > 0) visualParts.push(`${duplicates} product(s) contain duplicate images`);
  if (lowDiversity > 0) visualParts.push(`${lowDiversity} product(s) show limited image diversity`);
  if (lowQuality > 0) visualParts.push(`${lowQuality} product(s) contain pixelated or low-quality images`);
  if (inconsistentPrimary > 0) visualParts.push(`${inconsistentPrimary} product(s) have non-product primary images (e.g. size charts)`);
  if (inconsistentVisuals > 0) visualParts.push(`${inconsistentVisuals} product(s) are visually inconsistent with catalog aspect standards`);

  if (visualParts.length === 0) {
    visualTrustExplanation += 'All products meet the required image standards for your plan.';
  } else {
    visualTrustExplanation += `Score reduced because ${visualParts.join(', and ')}.`;
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
  
  const incompleteOrgCount = consistencyIssues.filter(i => i.type === 'INCOMPLETE_ORGANIZATION').length;
  if (incompleteOrgCount > 0)
    consistencyParts.push(`${incompleteOrgCount} product(s) have incomplete vendor, tag, or type organization`);

  const missingMetafieldCount = consistencyIssues.filter(i => i.type === 'MISSING_RECOMMENDED_METAFIELDS').length;
  if (missingMetafieldCount > 0)
    consistencyParts.push(`${missingMetafieldCount} product(s) are missing recommended merchandising metafields`);

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
        fallbackPlan.maxProducts = 75; fallbackPlan.imagesPerProduct = 3;
      } else if (planName === 'PRO') {
        fallbackPlan.maxProducts = 200; fallbackPlan.imagesPerProduct = 4;
      }
    }
    const plan = shop.subscription?.pricingPlan || fallbackPlan;

    const products = await prisma.product.findMany({
      where: { shopId },
      include: { variants: true, performance: true },
      take: plan.maxProducts,
    });

    const dbOverrides = await prisma.merchantOverride.findMany({
      where: { shopId }
    });
    const isVisualOverride = dbOverrides.some(o => o.ruleType === 'INCONSISTENT_STORE_VISUALS');
    const dominantVisualStandard = calculateDominantVisualStandard(products);

    const allPrices = [];

    for (const product of products) {
      const variantCount = product.variants.length;

      let productHasTitleIssue = false;
      let productHasDescIssue = false;
      let productHasImageIssue = false;
      let productHasSpecIssue = false;
      let productHasSizeGuideIssue = false;
      let productIsGhostListing = false;

      // Determine product language (prefer cached detectedLanguage, fallback to detection or shop locale)
      const productLang = product.detectedLanguage 
        || shop.primaryLocale 
        || detectProductLanguage(product.title, product.description).lang;

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
      } else if (isWeakTitle(product.title, productLang)) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'WEAK_PRODUCT_TITLE',
          severity: 'HIGH',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            wordCount: product.title.trim().split(/\s+/).filter(Boolean).length,
            detectedLanguage: productLang,
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

      if (isKeywordStuffedTitle(product.title, productLang)) {
        issues.push({
          auditRunId: auditRun.id,
          type: 'KEYWORD_STUFFED_TITLE',
          severity: 'MEDIUM',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            detectedLanguage: productLang,
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
      } else {
        if (isGenericDescriptionForLang(product.description, productLang)) {
          issues.push({
            auditRunId: auditRun.id,
            type: 'GENERIC_DESCRIPTION',
            severity: 'MEDIUM',
            category: 'CONTENT',
            affectedEntities: [product.shopifyId],
            evidence: {
              title: product.title,
              descriptionLength: textLen,
              detectedLanguage: productLang,
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
              detectedLanguage: productLang,
              businessImpact: 'Thin descriptions cannot convert paid or organic traffic.',
              confidence: 'HIGH',
            },
          });
        }

        // Section 1.1 Enhanced Description Detection
        if (isSpecDumpDescription(product.description)) {
          issues.push({
            auditRunId: auditRun.id,
            type: 'SPEC_DUMP_DESCRIPTION',
            severity: 'HIGH',
            category: 'CONTENT',
            affectedEntities: [product.shopifyId],
            evidence: {
              title: product.title,
              descriptionLength: textLen,
              businessImpact: 'Descriptions containing only specifications and no selling copy reduce buyer trust and conversion rates.',
              confidence: 'HIGH',
            },
          });
        }

        if (isSupplierDescription(product.description)) {
          issues.push({
            auditRunId: auditRun.id,
            type: 'SUPPLIER_DESCRIPTION',
            severity: 'MEDIUM',
            category: 'CONTENT',
            affectedEntities: [product.shopifyId],
            evidence: {
              title: product.title,
              descriptionLength: textLen,
              businessImpact: 'AliExpress/Temu-style phrases make the store look like a low-trust drop-shipping hub.',
              confidence: 'HIGH',
            },
          });
        }
      }

      // ── Section 3: Completeness Checks (3.1 & 3.2) ──────────────────────
      if (isApparelOrFootwear(product)) {
        if (!hasSizeGuide(product)) {
          productHasSizeGuideIssue = true;
          issues.push({
            auditRunId: auditRun.id,
            type: 'MISSING_SIZE_GUIDE',
            severity: 'MEDIUM',
            category: 'CONTENT',
            affectedEntities: [product.shopifyId],
            evidence: {
              title: product.title,
              productType: product.productType || '',
              tags: product.tags || '',
              reason: 'Apparel, footwear, or fashion product is missing sizing charts or guides.',
              businessImpact: 'Missing size guides increase return rates and shopping cart abandonment.',
              confidence: 'HIGH',
            }
          });
        }
      }

      if (!hasProductSpecifications(product)) {
        productHasSpecIssue = true;
        issues.push({
          auditRunId: auditRun.id,
          type: 'MISSING_PRODUCT_SPECIFICATION',
          severity: 'LOW',
          category: 'CONTENT',
          affectedEntities: [product.shopifyId],
          evidence: {
            title: product.title,
            reason: 'Product is missing materials, dimensions, or technical specifications.',
            businessImpact: 'Lack of specifications reduces customer confidence and purchase clarity.',
            confidence: 'HIGH',
          }
        });
      }

      // ── Section 4: Product Organization Intelligence ─────────────────────
      const orgIssues = auditProductOrganization(product, auditRun.id);
      issues.push(...orgIssues);

      const metafieldIssues = auditProductMetafields(product, auditRun.id);
      issues.push(...metafieldIssues);

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

      // ── Section 2: Product Image Intelligence ───────────────────────────
      const imageIntelIssues = auditProductImages(product, auditRun.id, isVisualOverride, dominantVisualStandard);
      issues.push(...imageIntelIssues);

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

      // ── Calculate and Update Product Scores (Section 1 & 3) ───────────────
      const descQualityScore = calculateDescriptionQualityScore(product.description, product.title, productLang);
      
      // 1. Title Quality (max 20 points)
      const isWeakTitleFlag = isWeakTitle(product.title, productLang);
      const isInvalidTitleFlag = isInvalidTitle(product.title);
      const isSerialTitleFlag = isSerialTitle(product.title);
      const isKeywordStuffedTitleFlag = isKeywordStuffedTitle(product.title, productLang);
      
      let titlePoints = 20;
      if (isInvalidTitleFlag) titlePoints = 0;
      else if (isWeakTitleFlag) titlePoints = 10;
      else if (isSerialTitleFlag || isKeywordStuffedTitleFlag) titlePoints = 15;

      // 2. Description Quality (max 20 points)
      const descPoints = Math.round((descQualityScore / 100) * 20);

      // 3. Images (max 20 points)
      let imagePoints = 20;
      if (product.imageCount === 0) {
        imagePoints = 0;
      } else {
        if (product.imageCount < plan.imagesPerProduct) imagePoints -= 10;
        if (imageIntelIssues.some(i => i.type === 'LOW_QUALITY_IMAGE')) imagePoints -= 5;
      }
      imagePoints = Math.max(0, imagePoints);

      // 4. Specifications (max 15 points)
      const specPoints = productHasSpecIssue ? 0 : 15;

      // 5. Size Guide (max 15 points)
      const sizeGuidePoints = (isApparelOrFootwear(product) && productHasSizeGuideIssue) ? 0 : 15;

      // 6. Product Organization & Metafields (max 10 points)
      let orgPoints = 10;
      if (product.published && collections.length === 0) {
        orgPoints -= 5;
      }
      if (!product.productType || !product.tags) {
        orgPoints -= 5;
      }
      orgPoints = Math.max(0, orgPoints);

      const compScore = Math.max(0, Math.min(100, Math.round(titlePoints + descPoints + imagePoints + specPoints + sizeGuidePoints + orgPoints)));

      await prisma.product.update({
        where: { id: product.id },
        data: {
          descriptionQualityScore: descQualityScore,
          completenessScore: compScore,
        },
      });
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
    const descIssues          = filteredIssues.filter(i => ['MISSING_DESCRIPTION', 'WEAK_DESCRIPTION', 'GENERIC_DESCRIPTION', 'SPEC_DUMP_DESCRIPTION', 'SUPPLIER_DESCRIPTION', 'MISSING_SIZE_GUIDE', 'MISSING_PRODUCT_SPECIFICATION'].includes(i.type));
    const allImageIssues      = filteredIssues.filter(i => ['NO_PRODUCT_IMAGES', 'LOW_IMAGE_COUNT', 'EXCESSIVE_IMAGE_COUNT'].includes(i.type));
    const noImageIssues       = filteredIssues.filter(i => i.type === 'NO_PRODUCT_IMAGES');
    const allConsistencyIssues = filteredIssues.filter(i =>
      ['VARIANT_PRICE_GAP', 'CATALOG_INCONSISTENCY', 'HIGH_FRAGMENTATION', 'INCONSISTENT_PRICE_POSITIONING', 'COLLECTION_PRICE_OUTLIER', 'INCOMPLETE_ORGANIZATION', 'MISSING_RECOMMENDED_METAFIELDS'].includes(i.type)
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
        - (descIssues.filter(i => i.type === 'SPEC_DUMP_DESCRIPTION').length * 15)
        - (descIssues.filter(i => i.type === 'SUPPLIER_DESCRIPTION').length * 10)
        - (descIssues.filter(i => i.type === 'MISSING_SIZE_GUIDE').length * 10)
        - (descIssues.filter(i => i.type === 'MISSING_PRODUCT_SPECIFICATION').length * 5)
      ),
      visualTrust: Math.max(0,
        100
        - (noImageIssues.length * 30)
        - (allImageIssues.filter(i => i.type === 'LOW_IMAGE_COUNT').length * 15)
        - (allImageIssues.filter(i => i.type === 'EXCESSIVE_IMAGE_COUNT').length * 5)
        - (filteredIssues.filter(i => i.type === 'DUPLICATE_IMAGES').length * 10)
        - (filteredIssues.filter(i => i.type === 'LIMITED_IMAGE_DIVERSITY').length * 5)
        - (filteredIssues.filter(i => i.type === 'LOW_QUALITY_IMAGE').length * 15)
        - (filteredIssues.filter(i => i.type === 'INCONSISTENT_PRIMARY_IMAGE').length * 20)
        - (filteredIssues.filter(i => i.type === 'INCONSISTENT_STORE_VISUALS').length * 5)
      ),
      catalogConsistency: Math.max(0, 100 
        - (allConsistencyIssues.filter(i => !['INCOMPLETE_ORGANIZATION', 'MISSING_RECOMMENDED_METAFIELDS'].includes(i.type)).length * 20)
        - (inventoryIssues.length * 15)
        - (allConsistencyIssues.filter(i => i.type === 'INCOMPLETE_ORGANIZATION').length * 2)
        - (allConsistencyIssues.filter(i => i.type === 'MISSING_RECOMMENDED_METAFIELDS').length * 2)
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
