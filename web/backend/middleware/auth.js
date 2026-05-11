import prisma from '../config/database.js';
import { decrypt } from '../utils/encryption.js';

/**
 * Authenticates requests using either session tokens (preferred) or shop-based auth (fallback)
 * Session tokens are required for App Store compliance in embedded apps
 */
export async function authenticateShop(req, res, next) {
  try {
    // Check for session token first (preferred method for embedded apps)
    const authHeader = req.get('authorization');
    const sessionTokenHeader = req.get('x-shopify-session-token');
    const sessionTokenQuery = req.query.session_token;
    const sessionToken = authHeader?.replace('Bearer ', '') || sessionTokenHeader || sessionTokenQuery;
    
    const shop = req.query.shop || req.body?.shop || req.get('x-shopify-shop-domain');
    
    console.log('=== Authentication Request ===');
    console.log('Shop parameter:', shop);
    console.log('Session token present:', !!sessionToken);
    
    // If session token is present, try to verify it
    if (sessionToken) {
      try {
        const { authenticateSessionToken } = await import('./sessionToken.js');
        return authenticateSessionToken(req, res, next);
      } catch (sessionTokenError) {
        console.warn('⚠️ Session token authentication failed, falling back to shop-based auth:', sessionTokenError.message);
        // Fall through to shop-based authentication
      }
    }
    
    // Fallback to shop-based authentication (original method)
    if (!shop) {
      console.log('❌ No shop parameter provided');
      return res.status(401).json({ error: 'Shop parameter required' });
    }

    const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
    console.log('Looking up shop domain:', shopDomain);
    
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { subscription: true },
    });

    if (!shopRecord) {
      console.log('❌ Shop not found in database');
      if (shop) {
        const authUrl = `/api/auth?shop=${shop}`;
        return res.status(401)
          .set('X-Shopify-API-Request-Failure-Reauthorize', '1')
          .set('X-Shopify-API-Request-Failure-Reauthorize-Url', authUrl)
          .json({ error: 'Shop not found or inactive' });
      }
      return res.status(401).json({ error: 'Shop not found or inactive' });
    }

    if (!shopRecord.isActive) {
      console.log('❌ Shop is inactive');
      if (shop) {
        const authUrl = `/api/auth?shop=${shop}`;
        return res.status(401)
          .set('X-Shopify-API-Request-Failure-Reauthorize', '1')
          .set('X-Shopify-API-Request-Failure-Reauthorize-Url', authUrl)
          .json({ error: 'Shop not found or inactive' });
      }
      return res.status(401).json({ error: 'Shop not found or inactive' });
    }

    console.log('✅ Shop found:', shopRecord.id);
    
    // Decrypt access token
    try {
      const accessToken = decrypt(shopRecord.accessToken);
      console.log('✅ Access token decrypted successfully');
      console.log('Decrypted token preview (first 30 chars):', accessToken.substring(0, 30));
      console.log('Decrypted token length:', accessToken.length);
      console.log('Decrypted token starts with shpat_:', accessToken.startsWith('shpat_'));
      console.log('Decrypted token starts with shpua_:', accessToken.startsWith('shpua_'));
      const tokenType = accessToken.startsWith('shpat_') ? 'Admin API token' : (accessToken.startsWith('shpua_') ? 'User access token' : 'Unknown format');
      console.log('Token type:', tokenType);
      
      // Trim any whitespace that might have been introduced
      const trimmedToken = accessToken.trim();
      if (trimmedToken !== accessToken) {
        console.warn('⚠️ Token had whitespace - trimmed');
      }
      
      // Store shop data and access token for use in routes
      // We'll create Shopify sessions on-demand when making API calls
      req.shop = shopRecord;
      req.accessToken = trimmedToken; // Store decrypted and trimmed token for API calls
      
      console.log('✅ Authentication successful');
      next();
    } catch (decryptError) {
      console.error('❌ Decryption error:', decryptError);
      console.error('Decryption error stack:', decryptError.stack);
      throw decryptError;
    }
  } catch (error) {
    console.error('❌ Authentication error:', error);
    console.error('Error stack:', error.stack);
    res.status(401).json({ error: 'Authentication failed', details: error.message });
  }
}

export function requirePlan(minPlan) {
  const planLevels = { LIGHT: 1, GROWTH: 2, PRO: 3 };
  
  return async (req, res, next) => {
    const subscription = req.shop?.subscription;
    
    if (!subscription || subscription.status !== 'ACTIVE') {
      return res.status(403).json({ 
        error: 'Active subscription required',
        upgradeRequired: true 
      });
    }

    const currentLevel = planLevels[subscription.plan] || 0;
    const requiredLevel = planLevels[minPlan] || 0;

    if (currentLevel < requiredLevel) {
      return res.status(403).json({ 
        error: `Plan upgrade required. Minimum plan: ${minPlan}`,
        upgradeRequired: true,
        currentPlan: subscription.plan,
        requiredPlan: minPlan
      });
    }

    next();
  };
}

