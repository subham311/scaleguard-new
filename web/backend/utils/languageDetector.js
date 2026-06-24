/**
 * Zero-dependency, offline language detector for Product Audits.
 * Supports: en (English), pt (Portuguese), es (Spanish), fr (French), de (German), it (Italian).
 */

const PROFILES = {
  en: {
    words: ['the', 'and', 'with', 'this', 'that', 'for', 'from', 'have', 'are', 'you', 'your', 'with', 'about', 'will', 'their', 'there'],
    trigrams: ['the', 'and', 'tha', 'ent', 'ing', 'ion', 'tio', 'her', 'ati', 'oth', 'all', 'wit', 'thi', 'ere', 'con', 'ter', 'ted', 'hat', 'for', 'res', 'ver', 'nce']
  },
  pt: {
    words: ['para', 'com', 'uma', 'este', 'esta', 'como', 'mais', 'seus', 'suas', 'pelo', 'pela', 'tudo', 'aqui', 'sobre', 'todos', 'toda'],
    trigrams: ['que', ' de', 'de ', ' do', 'do ', ' da', 'da ', 'os ', 'um ', 'par', 'ara', 'em ', 'com', 'ão ', 'ção', 'ent', 'nte', 'te ', 'uma', 'res', ' pr']
  },
  es: {
    words: ['para', 'con', 'una', 'este', 'esta', 'como', 'más', 'sus', 'todo', 'todos', 'pero', 'del', 'aquí', 'sobre', 'entre', 'también'],
    trigrams: ['que', ' de', 'de ', ' el', 'el ', ' la', 'la ', ' en', 'en ', 'los', 'con', 'del', 'par', 'ara', 'una', ' es', 'es ', 'por', 'tra', 'nte', 'res']
  },
  fr: {
    words: ['avec', 'pour', 'dans', 'plus', 'mais', 'cette', 'tout', 'tous', 'sont', 'vous', 'votre', 'dans', 'nous', 'leur', 'elle', 'cette'],
    trigrams: ['les', ' de', 'de ', 'ent', ' le', 'le ', ' la', 'la ', ' et', 'et ', 'des', 'es ', ' un', 'un ', ' du', 'du ', ' en', 'en ', 'que', 'ue ', 'est']
  },
  de: {
    words: ['und', 'ist', 'mit', 'ein', 'eine', 'für', 'von', 'dem', 'den', 'der', 'die', 'das', 'nicht', 'sind', 'oder', 'aber', 'auch'],
    trigrams: ['der', 'die', 'und', 'den', 'ein', 'ich', 'das', 'ist', 'des', 'mit', 'dem', 'von', 'sie', 'auc', 'uch', 'cht', 'sch', 'ch ', 'en ', 'er ', 'nd ']
  },
  it: {
    words: ['con', 'per', 'una', 'questo', 'questa', 'come', 'più', 'suoi', 'sue', 'tutto', 'tutti', 'sono', 'anche', 'della', 'dello', 'nella'],
    trigrams: [' di', 'di ', 'che', ' il', 'il ', ' la', 'la ', ' in', 'in ', ' un', 'un ', 'del', 'con', 'non', 'per', ' da', 'da ', 'una', 'gli', ' ha']
  }
};

const GENERIC_KEYWORDS_BY_LANG = {
  en: ['lorem ipsum', 'product description', 'coming soon', 'description here', 'add your description', 'no description', 'tbd', 'to be added'],
  pt: ['descrição do produto', 'em breve', 'adicione uma descrição', 'sem descrição', 'a ser definido'],
  es: ['descripción del producto', 'próximamente', 'añade una descripción', 'sin descripción', 'por definir'],
  fr: ['description du produit', 'bientôt disponible', 'ajoutez une description', 'sans description', 'à définir'],
  de: ['produktbeschreibung', 'kommt bald', 'beschreibung hinzufügen', 'keine beschreibung', 'wird noch definiert'],
  it: ['descrizione del prodotto', 'in arrivo', 'aggiungi una descrizione', 'nessuna descrizione', 'da definire'],
};

/**
 * Strip HTML tags from a string.
 */
export function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>?/gm, '').trim();
}

/**
 * Normalize text to lowercase letters and spaces only.
 */
function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, '') // Keep letters (Unicode property L) and whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect language of a plain text string.
 * Returns { lang: string, confidence: number }
 */
export function detectLanguage(text) {
  if (!text || text.length < 20) {
    return { lang: 'en', confidence: 0 };
  }

  const normalized = normalizeText(text);
  const words = normalized.split(' ').filter(w => w.length > 0);
  
  const trigrams = [];
  for (let i = 0; i <= normalized.length - 3; i++) {
    trigrams.push(normalized.substring(i, i + 3));
  }

  const scores = { en: 0, pt: 0, es: 0, fr: 0, de: 0, it: 0 };

  // Calculate scores based on profiles
  for (const lang of Object.keys(PROFILES)) {
    const profile = PROFILES[lang];
    
    // Word matching (weighted 3x)
    for (const word of words) {
      if (profile.words.includes(word)) {
        scores[lang] += 3;
      }
    }

    // Trigram matching (weighted 1x)
    for (const trigram of trigrams) {
      if (profile.trigrams.includes(trigram)) {
        scores[lang] += 1;
      }
    }
  }

  // Find winner and runner up
  let bestLang = 'en';
  let bestScore = 0;
  let runnerUpScore = 0;
  let totalScore = 0;

  for (const lang of Object.keys(scores)) {
    const score = scores[lang];
    totalScore += score;
    if (score > bestScore) {
      runnerUpScore = bestScore;
      bestScore = score;
      bestLang = lang;
    } else if (score > runnerUpScore) {
      runnerUpScore = score;
    }
  }

  // Fallback to English if score is too low or no matches
  if (bestScore < 3) {
    return { lang: 'en', confidence: 0 };
  }

  // If the winner is English, check confidence against runner-up
  if (bestLang === 'en') {
    const confidence = bestScore > 0 ? (bestScore - runnerUpScore) / bestScore : 0;
    if (confidence < 0.15) {
      return { lang: 'en', confidence: 0 };
    }
    return { lang: 'en', confidence };
  }

  // If the winner is NOT English, we compute how confident we are that it is NOT English
  const enScore = scores['en'] || 0;
  const notEnConfidence = bestScore > 0 ? (bestScore - enScore) / bestScore : 0;

  // If we are not confident it is non-English, fall back to English
  if (notEnConfidence < 0.25 || bestScore < 4) {
    return { lang: 'en', confidence: 0 };
  }

  // Return the best non-English language with the confidence that it is not English
  return { lang: bestLang, confidence: notEnConfidence };
}

/**
 * Detect language of a description containing HTML.
 */
export function detectDescriptionLanguage(html) {
  const text = stripHtml(html);
  return detectLanguage(text);
}

/**
 * Detect product language using both title and description for a stronger combined signal.
 */
export function detectProductLanguage(title, descriptionHtml) {
  const cleanTitle = (title || '').trim();
  const cleanDesc = stripHtml(descriptionHtml || '');
  
  // Combine title and description (giving weight to title by duplicating it slightly, or just concatenating)
  const combined = `${cleanTitle}. ${cleanTitle}. ${cleanDesc}`;
  return detectLanguage(combined);
}

/**
 * Check if the description contains language-specific or general boilerplate text.
 */
export function isGenericDescriptionForLang(html, lang = 'en') {
  if (!html) return false;
  const text = stripHtml(html).toLowerCase().trim();
  const keywords = GENERIC_KEYWORDS_BY_LANG[lang] || GENERIC_KEYWORDS_BY_LANG.en;
  const englishKeywords = GENERIC_KEYWORDS_BY_LANG.en;
  
  // Always check English keywords (lorem ipsum is universal in development)
  const allKeywords = new Set([...keywords, ...englishKeywords]);
  return Array.from(allKeywords).some(kw => text.includes(kw));
}

/**
 * Retrieve stop words for a given language to exclude from repetition checks.
 */
export function getStopWords(lang) {
  const profile = PROFILES[lang] || PROFILES.en;
  return profile.words;
}
