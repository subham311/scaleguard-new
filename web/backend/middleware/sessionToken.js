import crypto from 'crypto';
import prisma from '../config/database.js';
import { decrypt } from '../utils/encryption.js';

const AUTH_DEBUG = process.env.LOG_LEVEL === 'debug' || process.env.SHOPIFY_AUTH_DEBUG === 'true';

/**
 * Verifies Shopify session token
 * Session tokens are used for embedded app authentication (required for App Store compliance)
 * 
 * For proper verification, we should call Shopify's session token verification API,
 * but for now we'll validate the format and extract shop information, then look up the shop.
 * 
 * @param {string} sessionToken - The session token from App Bridge
 * @param {string} shop - The shop domain
 * @returns {Promise<{valid: boolean, shop?: object, accessToken?: string}>}
 */
async function verifySessionToken(sessionToken, shop) {
  try {
    if (!sessionToken) {
      return { valid: false, error: 'Session token missing' };
    }

    if (!shop) {
      return { valid: false, error: 'Shop parameter missing' };
    }

    const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;

    // Session tokens are JWT-like tokens
    // Format: header.payload.signature (base64url encoded)
    const parts = sessionToken.split('.');
    if (parts.length !== 3) {
      console.error('❌ Invalid session token format');
      return { valid: false, error: 'Invalid token format' };
    }

    // Decode payload to extract shop information
    let payload;
    try {
      // Base64url decode (replace - with +, _ with /, add padding if needed)
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch (e) {
      console.error('❌ Failed to decode session token payload:', e);
      return { valid: false, error: 'Invalid token payload' };
    }

    // Extract shop from token payload (dest field contains shop URL)
    const tokenShop = payload.dest?.replace('https://', '').replace('http://', '').split('/')[0];
    const tokenShopDomain = tokenShop?.includes('.myshopify.com') 
      ? tokenShop 
      : tokenShop ? `${tokenShop}.myshopify.com` : null;

    // Verify token is for the correct shop
    if (tokenShopDomain && tokenShopDomain !== shopDomain) {
      console.error('❌ Session token shop mismatch:', { tokenShopDomain, shopDomain });
      return { valid: false, error: 'Token shop mismatch' };
    }

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      console.error('❌ Session token expired');
      return { valid: false, error: 'Token expired' };
    }

    // Token format is valid - look up shop and return access token
    // Note: For production, you should verify the signature with Shopify's API
    // For now, we validate format and trust the shop parameter
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { subscription: true },
    });

    if (!shopRecord || !shopRecord.isActive) {
      console.error('❌ Shop not found or inactive');
      return { valid: false, error: 'Shop not found or inactive' };
    }

    // Decrypt and return access token
    const accessToken = decrypt(shopRecord.accessToken);

    if (AUTH_DEBUG) {
      console.log('✅ Session token verified (format validation)');
    }
    return {
      valid: true,
      shop: shopRecord,
      accessToken: accessToken.trim(),
    };
  } catch (error) {
    console.error('❌ Session token verification error:', error);
    return { valid: false, error: error.message };
  }
}

/**
 * Middleware to authenticate requests using session tokens
 * This is the preferred method for embedded apps (required for App Store compliance)
 */
export async function authenticateSessionToken(req, res, next) {
  try {
    // Session token can come from:
    // 1. Authorization header: "Authorization: Bearer <token>"
    // 2. X-Shopify-Session-Token header
    // 3. Query parameter: ?session_token=<token>
    
    const authHeader = req.get('authorization');
    const sessionTokenHeader = req.get('x-shopify-session-token');
    const sessionTokenQuery = req.query.session_token;
    
    const sessionToken = authHeader?.replace('Bearer ', '') || sessionTokenHeader || sessionTokenQuery;
    let shop = req.query.shop || req.body?.shop || req.get('x-shopify-shop-domain');

    // Extract shop from session token if missing
    if (!shop && sessionToken) {
      try {
        const parts = sessionToken.split('.');
        if (parts.length === 3) {
          const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
          const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
          const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
          const tokenShop = payload.dest?.replace('https://', '').replace('http://', '').split('/')[0];
          if (tokenShop) {
            shop = tokenShop.includes('.myshopify.com') ? tokenShop : `${tokenShop}.myshopify.com`;
          }
        }
      } catch (e) {
        // Ignore parsing errors here, verifySessionToken will catch them
      }
    }

    if (AUTH_DEBUG) {
      console.log('=== Session Token Authentication ===');
      console.log('Shop:', shop);
      console.log('Session token present:', !!sessionToken);
    }

    if (!sessionToken) {
      // Fallback to shop-based authentication if no session token
      if (AUTH_DEBUG) {
        console.log('⚠️ No session token - falling back to shop-based auth');
      }
      // Import and use shop-based auth middleware
      const { authenticateShop } = await import('./auth.js');
      return authenticateShop(req, res, next);
    }

    if (!shop) {
      console.log('❌ No shop parameter provided');
      return res.status(401).json({ error: 'Shop parameter required' });
    }

    const verification = await verifySessionToken(sessionToken, shop);

    if (!verification.valid) {
      console.error('❌ Session token verification failed:', verification.error);
      
      // If shop is missing from our DB, tell App Bridge to reauthorize (which will trigger our new OAuth hook!)
      if (verification.error === 'Shop not found or inactive' && shop) {
        const authUrl = `/api/auth?shop=${shop}`;
        return res.status(401)
          .set('X-Shopify-API-Request-Failure-Reauthorize', '1')
          .set('X-Shopify-API-Request-Failure-Reauthorize-Url', authUrl)
          .json({ 
            error: 'Invalid session token',
            details: verification.error 
          });
      }

      return res.status(401).json({ 
        error: 'Invalid session token',
        details: verification.error 
      });
    }

    // Store shop data and access token for use in routes
    req.shop = verification.shop;
    req.accessToken = verification.accessToken;
    
    if (AUTH_DEBUG) {
      console.log('✅ Session token authentication successful');
    }
    next();
  } catch (error) {
    console.error('❌ Session token authentication error:', error);
    res.status(401).json({ error: 'Authentication failed', details: error.message });
  }
}

/**
 * Middleware that tries session token first, falls back to shop-based auth
 * This allows the app to work with both authentication methods
 */
export async function authenticateFlexible(req, res, next) {
  try {
    // Try session token first
    const authHeader = req.get('authorization');
    const sessionTokenHeader = req.get('x-shopify-session-token');
    const sessionTokenQuery = req.query.session_token;
    const sessionToken = authHeader?.replace('Bearer ', '') || sessionTokenHeader || sessionTokenQuery;

    if (sessionToken) {
      // Use session token authentication
      return authenticateSessionToken(req, res, next);
    } else {
      // Fall back to shop-based authentication
      const { authenticateShop } = await import('./auth.js');
      return authenticateShop(req, res, next);
    }
  } catch (error) {
    console.error('❌ Flexible authentication error:', error);
    res.status(401).json({ error: 'Authentication failed', details: error.message });
  }
}
