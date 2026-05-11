/**
 * Shopify API Helper Utilities
 * Handles rate limiting, retries, and error handling for Shopify API calls
 */

/**
 * Handle Shopify API rate limits with exponential backoff
 * Works with Shopify API client responses and fetch responses
 */
export async function handleShopifyRateLimit(fetchFn, maxRetries = 3) {
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      const response = await fetchFn();
      
      // Shopify API client returns response object with headers property
      // Check for rate limit errors in response or error thrown
      const status = response.status || response.statusCode;
      const headers = response.headers || {};
      
      // Check for rate limit (429 status)
      if (status === 429) {
        const retryAfter = headers.get ? headers.get('Retry-After') : headers['retry-after'];
        const waitTime = retryAfter 
          ? parseInt(retryAfter) * 1000 
          : Math.pow(2, retries) * 1000; // Exponential backoff
        
        console.warn(`⚠️ Shopify API rate limit hit. Waiting ${waitTime}ms before retry ${retries + 1}/${maxRetries}`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        retries++;
        continue;
      }
      
      // Check for other server errors (5xx)
      if (status && status >= 500) {
        const waitTime = Math.pow(2, retries) * 1000;
        console.warn(`⚠️ Shopify API server error (${status}). Retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        retries++;
        continue;
      }
      
      // Success
      return response;
    } catch (error) {
      // Check if error is rate limit related
      const errorMessage = error.message?.toLowerCase() || '';
      const isRateLimit = errorMessage.includes('rate limit') || 
                         errorMessage.includes('429') ||
                         error.status === 429 ||
                         error.statusCode === 429;
      
      if (isRateLimit && retries < maxRetries - 1) {
        const waitTime = Math.pow(2, retries) * 1000;
        console.warn(`⚠️ Shopify API rate limit error. Retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        retries++;
        continue;
      }
      
      // For other errors, retry once if it's a network/server error
      if (retries < maxRetries - 1 && (
        errorMessage.includes('network') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('econnrefused') ||
        (error.status && error.status >= 500)
      )) {
        const waitTime = Math.pow(2, retries) * 1000;
        console.warn(`⚠️ Shopify API request failed. Retrying in ${waitTime}ms...`, error.message);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        retries++;
        continue;
      }
      
      // Non-retryable error or max retries reached
      throw error;
    }
  }
  
  throw new Error('Max retries exceeded for Shopify API request');
}

/**
 * Extract rate limit info from Shopify API response headers
 * Works with both Headers object (from fetch) and plain object (from Shopify client)
 */
export function getRateLimitInfo(headers) {
  if (!headers) return { used: null, limit: null, remaining: null };
  
  // Handle both Headers object (has .get method) and plain object
  const getHeader = (name) => {
    if (headers.get) {
      return headers.get(name) || headers.get(name.toLowerCase());
    }
    return headers[name] || headers[name.toLowerCase()];
  };
  
  const rawCallsMade = getHeader('X-Shopify-Shop-Api-Call-Limit');
  // Some runtimes/libraries may expose header values as arrays or numbers.
  const callsMade =
    Array.isArray(rawCallsMade) ? rawCallsMade[0] : rawCallsMade;
  const callsMadeStr = typeof callsMade === 'string' ? callsMade : (callsMade != null ? String(callsMade) : null);

  const limit = callsMadeStr ? callsMadeStr.split('/')[1] : null;
  const used = callsMadeStr ? callsMadeStr.split('/')[0] : null;
  
  return {
    used: used ? parseInt(used) : null,
    limit: limit ? parseInt(limit) : null,
    remaining: limit && used ? parseInt(limit) - parseInt(used) : null,
  };
}
