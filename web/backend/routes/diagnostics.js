import express from 'express';
import prisma from '../config/database.js';
import { decrypt } from '../utils/encryption.js';

const router = express.Router();

// Manual shop deletion endpoint (for debugging - allows fresh reinstall)
router.delete('/shop', async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) {
      return res.status(400).json({ error: 'Shop parameter required (?shop=scaleguard-test.myshopify.com)' });
    }
    
    const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
    
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain },
    });
    
    if (!shopRecord) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    
    // Delete shop (cascade will delete subscription)
    await prisma.shop.delete({
      where: { shopDomain },
    });
    
    res.json({
      success: true,
      message: `Shop ${shopDomain} deleted. You can now reinstall the app fresh.`,
      deletedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// Manual shop activation endpoint (for fixing inactive shops)
router.post('/shop/activate', async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) {
      return res.status(400).json({ error: 'Shop parameter required (?shop=scaleguard-test.myshopify.com)' });
    }
    
    const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
    
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain },
    });
    
    if (!shopRecord) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    
    // Activate the shop
    await prisma.shop.update({
      where: { shopDomain },
      data: {
        isActive: true,
      },
    });
    
    res.json({
      success: true,
      message: `Shop ${shopDomain} activated successfully.`,
      activatedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// Comprehensive OAuth diagnostic endpoint
router.get('/oauth', async (req, res) => {
  try {
    const shop = req.query.shop || 'scaleguard-test.myshopify.com';
    const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
    
    // Get environment variables
    const frontendUrl = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.replace(/\/$/, '') : null;
    const backendUrl = process.env.SHOPIFY_APP_URL ? process.env.SHOPIFY_APP_URL.replace(/\/$/, '') : 'http://localhost:3001';
    
    // Calculate redirect URI the same way as install route
    let appUrl = frontendUrl;
    if (!appUrl) {
      if (backendUrl.includes('api.scaleguard-app.com')) {
        appUrl = backendUrl.replace('api.scaleguard-app.com', 'app.scaleguard-app.com');
      } else {
        appUrl = backendUrl;
      }
    }
    const redirectUri = `${appUrl}/auth/callback`;
    
    // Get shop record
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain },
    });
    
    let tokenInfo = null;
    if (shopRecord) {
      try {
        const decryptedToken = decrypt(shopRecord.accessToken);
        tokenInfo = {
          length: decryptedToken.length,
          preview: decryptedToken.substring(0, 30) + '...',
          full: decryptedToken,
          startsWithShpat: decryptedToken.startsWith('shpat_'),
          startsWithShpua: decryptedToken.startsWith('shpua_'),
          tokenType: decryptedToken.startsWith('shpat_') ? 'Admin API token' : (decryptedToken.startsWith('shpua_') ? 'User access token' : 'Unknown format'),
          isTooShort: decryptedToken.length < 45,
          installedAt: shopRecord.installedAt,
        };
      } catch (error) {
        tokenInfo = { error: error.message };
      }
    }
    
    res.json({
      environment: {
        FRONTEND_URL: process.env.FRONTEND_URL || '(not set)',
        SHOPIFY_APP_URL: process.env.SHOPIFY_APP_URL || '(not set)',
        calculatedAppUrl: appUrl,
        redirectUri: redirectUri,
        redirectUriEncoded: encodeURIComponent(redirectUri),
        expectedRedirectUri: 'https://app.scaleguard-app.com/auth/callback',
        redirectUriMatches: redirectUri === 'https://app.scaleguard-app.com/auth/callback',
        callbackRouteAccessible: 'https://app.scaleguard-app.com/auth/callback (frontend proxy) → https://api.scaleguard-app.com/auth/callback (backend)',
      },
      shop: {
        exists: !!shopRecord,
        shopDomain: shopDomain,
        isActive: shopRecord ? shopRecord.isActive : false,
        installedAt: shopRecord ? shopRecord.installedAt : null,
        daysSinceInstall: shopRecord && shopRecord.installedAt
          ? Math.floor((Date.now() - new Date(shopRecord.installedAt).getTime()) / (1000 * 60 * 60 * 24))
          : null,
      },
      token: tokenInfo,
      diagnosis: {
        problem: tokenInfo && tokenInfo.isTooShort 
          ? `Token is too short (${tokenInfo.length} chars, expected 50-70). OAuth callback is NOT completing - token never gets updated. This means Shopify is NOT calling the callback route.`
          : tokenInfo 
            ? 'Token exists but may be invalid'
            : 'No shop record found',
        rootCause: tokenInfo && tokenInfo.isTooShort
          ? 'The redirect URI in your code does NOT match what is registered in Shopify Partner Dashboard. Shopify rejects the OAuth request silently, so the callback is never called.'
          : 'Unknown',
        solution: tokenInfo && tokenInfo.isTooShort
          ? `1. Visit https://api.scaleguard-app.com/auth/debug to see the EXACT redirect URI your code generates\n2. Go to Shopify Partner Dashboard → Apps → ScaleGuard → App Setup\n3. Check "Allowed redirection URL(s)" - it MUST be EXACTLY: ${redirectUri}\n4. If it doesn't match, update it in Shopify Partner Dashboard\n5. DELETE the shop record: DELETE https://api.scaleguard-app.com/diagnostics/shop?shop=${shopDomain}\n6. Reinstall the app and watch Railway logs for "=== OAuth Callback ==="`
          : 'Reinstall the app to get a new token',
      },
      actionRequired: {
        step1: `Check redirect URI: https://api.scaleguard-app.com/auth/debug`,
        step2: `Verify in Shopify Partner Dashboard → App Setup → Allowed redirection URL(s) matches EXACTLY`,
        step3: tokenInfo && tokenInfo.isTooShort 
          ? `Delete shop record: DELETE https://api.scaleguard-app.com/diagnostics/shop?shop=${shopDomain}`
          : 'N/A',
        step4: 'Reinstall app and watch Railway logs for OAuth callback logs',
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// IP diagnostic endpoint - helps troubleshoot IP blocking issues
router.get('/ip', async (req, res) => {
  try {
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    const forwardedFor = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];
    
    res.json({
      ip: {
        detected: clientIp,
        forwardedFor: forwardedFor || 'not set',
        realIp: realIp || 'not set',
        connectionRemoteAddress: req.connection.remoteAddress || 'not set',
        socketRemoteAddress: (req.socket && req.socket.remoteAddress) || 'not set',
      },
      headers: {
        'x-forwarded-for': req.headers['x-forwarded-for'] || 'not set',
        'x-real-ip': req.headers['x-real-ip'] || 'not set',
        'cf-connecting-ip': req.headers['cf-connecting-ip'] || 'not set', // Cloudflare
        'x-vercel-forwarded-for': req.headers['x-vercel-forwarded-for'] || 'not set', // Vercel
      },
      rateLimit: {
        windowMs: process.env.NODE_ENV === 'production' ? 15 * 60 * 1000 : 60 * 1000,
        maxRequests: process.env.NODE_ENV === 'production' ? 500 : 1000,
        note: 'If you see rate limit errors, wait 15 minutes or change your IP address',
      },
      troubleshooting: {
        ifBlocked: [
          '1. Wait 15 minutes for rate limit to reset',
          '2. Change your IP address (restart router, use mobile hotspot, or use VPN)',
          '3. Check if Vercel is blocking your IP (frontend) - contact Vercel support',
          '4. Check Railway logs for rate limit errors (backend)',
        ],
        note: 'Rate limiting only affects backend API calls, not frontend page loading. If frontend page fails to load, it\'s likely Vercel DDoS protection or ISP routing issues.',
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// Webhook diagnostic endpoint - checks if GDPR webhooks are registered
router.get('/webhooks', async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) {
      return res.status(400).json({ error: 'Shop parameter required (?shop=scaleguard-test.myshopify.com)' });
    }
    
    const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
    
    // Get shop record
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain },
    });
    
    if (!shopRecord) {
      return res.status(404).json({ error: 'Shop not found. Please install the app first.' });
    }
    
    // Decrypt access token
    const accessToken = decrypt(shopRecord.accessToken);
    
    // Get webhook configuration
    const frontendUrl = process.env.FRONTEND_URL;
    let backendUrl = process.env.SHOPIFY_APP_URL?.replace(/\/$/, '') || 'http://localhost:3001';
    
    if (backendUrl.includes('app.scaleguard-app.com')) {
      backendUrl = backendUrl.replace('app.scaleguard-app.com', 'api.scaleguard-app.com');
    }
    
    const isProduction = backendUrl.includes('api.scaleguard-app.com');
    const isLocalhost = backendUrl.includes('localhost') || backendUrl.includes('127.0.0.1');
    
    const getWebhookEndpoint = (path) => {
      if (isProduction) {
        return `${backendUrl}/webhooks/${path}`;
      } else if (!isLocalhost && frontendUrl) {
        return `${frontendUrl}/api/webhooks/${path}`;
      } else {
        return `${backendUrl}/webhooks/${path}`;
      }
    };
    
    // Required GDPR webhooks
    const requiredWebhooks = [
      { topic: 'customers/data_request', endpoint: getWebhookEndpoint('customers/data_request') },
      { topic: 'customers/redact', endpoint: getWebhookEndpoint('customers/redact') },
      { topic: 'shop/redact', endpoint: getWebhookEndpoint('shop/redact') },
      { topic: 'app/uninstalled', endpoint: getWebhookEndpoint('app/uninstalled') },
    ];
    
    // Check webhooks via Shopify API
    const apiVersion = '2025-04';
    const baseApiUrl = `https://${shopDomain}/admin/api/${apiVersion}`;
    const listUrl = `${baseApiUrl}/webhooks.json`;
    
    const response = await fetch(listUrl, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
      },
    });
    
    let allWebhooks = [];
    if (response.ok) {
      const data = await response.json();
      allWebhooks = data.webhooks || [];
    }
    
    // Check each required webhook
    const webhookStatus = requiredWebhooks.map(required => {
      const registered = allWebhooks.find(wh => wh.topic === required.topic);
      return {
        topic: required.topic,
        required: true,
        registered: !!registered,
        webhookId: registered?.id || null,
        currentAddress: registered?.address || null,
        expectedAddress: required.endpoint,
        addressMatches: registered?.address === required.endpoint,
        format: registered?.format || null,
        status: registered ? (registered.address === required.endpoint ? '✅ Correct' : '⚠️ Wrong URL') : '❌ Missing',
      };
    });
    
    const allRegistered = webhookStatus.every(wh => wh.registered && wh.addressMatches);
    
    res.json({
      shop: {
        domain: shopDomain,
        isActive: shopRecord.isActive,
      },
      webhookConfiguration: {
        backendUrl,
        isProduction,
        isLocalhost,
        frontendUrl: frontendUrl || '(not set)',
      },
      webhooks: webhookStatus,
      summary: {
        allRegistered,
        registeredCount: webhookStatus.filter(wh => wh.registered).length,
        totalRequired: requiredWebhooks.length,
        correctAddressCount: webhookStatus.filter(wh => wh.addressMatches).length,
      },
      actionRequired: allRegistered
        ? '✅ All webhooks are registered correctly!'
        : [
            '1. Reinstall the app to register missing webhooks',
            '2. Check backend logs during installation for webhook registration errors',
            '3. Verify webhook endpoints are publicly accessible (no authentication required)',
            '4. Ensure HMAC verification is working (check webhook logs)',
          ],
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// App installation state diagnostic endpoint
// Checks if app is properly installed and configured
router.get('/installation', async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) {
      return res.status(400).json({ error: 'Shop parameter required (?shop=scaleguard-test.myshopify.com)' });
    }
    
    const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
    
    // Get shop record
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { subscription: true },
    });
    
    if (!shopRecord) {
      return res.json({
        installed: false,
        message: 'App is not installed. Please install the app from Shopify Admin.',
        action: 'Go to Shopify Admin → Apps → Find ScaleGuard → Install',
      });
    }
    
    // Check access token
    let tokenValid = false;
    let tokenError = null;
    try {
      const accessToken = decrypt(shopRecord.accessToken);
      if (accessToken && (accessToken.startsWith('shpat_') || accessToken.startsWith('shpua_')) && accessToken.length >= 38) {
        // Try to validate token
        const apiVersion = '2025-04';
        const shopUrl = `https://${shopDomain}/admin/api/${apiVersion}/shop.json`;
        const response = await fetch(shopUrl, {
          headers: {
            'X-Shopify-Access-Token': accessToken.trim(),
          },
        });
        tokenValid = response.ok;
        if (!response.ok) {
          tokenError = `Token validation failed: ${response.status} ${response.statusText}`;
        }
      } else {
        tokenError = 'Token format is invalid';
      }
    } catch (error) {
      tokenError = error.message;
    }
    
    // Check webhooks
    let webhooksRegistered = false;
    let webhookDetails = null;
    try {
      const accessToken = decrypt(shopRecord.accessToken);
      const apiVersion = '2025-04';
      const webhooksUrl = `https://${shopDomain}/admin/api/${apiVersion}/webhooks.json`;
      const response = await fetch(webhooksUrl, {
        headers: {
          'X-Shopify-Access-Token': accessToken.trim(),
        },
      });
      
      if (response.ok) {
        const data = await response.json();
        const webhooks = data.webhooks || [];
        const requiredTopics = ['customers/data_request', 'customers/redact', 'shop/redact', 'app/uninstalled'];
        const registeredTopics = webhooks.map(wh => wh.topic);
        const missingTopics = requiredTopics.filter(topic => !registeredTopics.includes(topic));
        
        webhooksRegistered = missingTopics.length === 0;
        webhookDetails = {
          total: webhooks.length,
          registered: registeredTopics,
          missing: missingTopics,
          allRequired: webhooksRegistered,
        };
      }
    } catch (error) {
      webhookDetails = { error: error.message };
    }
    
    // Determine installation state
    const isFullyInstalled = shopRecord.isActive && tokenValid && webhooksRegistered;
    const isPartiallyInstalled = shopRecord.isActive && (!tokenValid || !webhooksRegistered);
    
    res.json({
      installed: shopRecord.isActive,
      fullyInstalled: isFullyInstalled,
      partiallyInstalled: isPartiallyInstalled,
      shop: {
        domain: shopDomain,
        isActive: shopRecord.isActive,
        installedAt: shopRecord.installedAt,
        uninstalledAt: shopRecord.uninstalledAt,
      },
      accessToken: {
        exists: !!shopRecord.accessToken,
        valid: tokenValid,
        error: tokenError,
      },
      webhooks: webhookDetails,
      subscription: shopRecord.subscription ? {
        status: shopRecord.subscription.status,
        plan: shopRecord.subscription.plan,
        chargeId: shopRecord.subscription.chargeId,
      } : null,
      diagnosis: {
        state: isFullyInstalled 
          ? '✅ Fully installed and configured'
          : isPartiallyInstalled
            ? '⚠️ Partially installed - some components missing'
            : '❌ Not installed or inactive',
        issues: [
          !shopRecord.isActive && 'Shop is marked as inactive',
          !tokenValid && `Access token is invalid: ${tokenError}`,
          !webhooksRegistered && 'Required GDPR webhooks are not registered',
        ].filter(Boolean),
      },
      actionRequired: isFullyInstalled
        ? '✅ No action needed - app is fully installed'
        : [
            !shopRecord.isActive && '1. Reinstall the app from Shopify Admin',
            !tokenValid && '2. Reinstall the app to get a new access token',
            !webhooksRegistered && '3. Reinstall the app to register webhooks (webhooks are registered during OAuth)',
            '4. After reinstalling, check this endpoint again to verify everything is working',
          ].filter(Boolean),
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// Billing diagnostic endpoint - checks billing permissions and store type
router.get('/billing', async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) {
      return res.status(400).json({ error: 'Shop parameter required (?shop=scaleguard-test.myshopify.com)' });
    }
    
    const shopDomain = shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
    
    // Get shop record
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { subscription: true },
    });
    
    if (!shopRecord) {
      return res.status(404).json({ error: 'Shop not found. Please install the app first.' });
    }
    
    // Decrypt access token
    const accessToken = decrypt(shopRecord.accessToken);
    
    // Check shop type and billing capabilities
    let shopInfo = null;
    let shopType = 'unknown';
    let canCreateCharges = false;
    let billingError = null;
    
    try {
      const apiVersion = '2025-04';
      const shopUrl = `https://${shopDomain}/admin/api/${apiVersion}/shop.json`;
      const response = await fetch(shopUrl, {
        headers: {
          'X-Shopify-Access-Token': accessToken.trim(),
        },
      });
      
      if (response.ok) {
        const data = await response.json();
        shopInfo = data.shop;
        shopType = shopInfo?.plan_name || 'unknown';
        
        // Development stores typically have plan_name like "partner_test" or "development"
        // Production stores have plan_name like "plus", "basic", etc.
        const isDevStore = shopType?.toLowerCase().includes('test') || 
                          shopType?.toLowerCase().includes('development') ||
                          shopType?.toLowerCase().includes('partner');
        
        // Some development stores can't create charges
        canCreateCharges = !isDevStore || shopDomain.toLowerCase().includes('test');
      } else {
        billingError = `Failed to get shop info: ${response.status}`;
      }
    } catch (error) {
      billingError = error.message;
    }
    
    // Try to list existing charges (this tests billing API access)
    let chargesAccessible = false;
    let chargesError = null;
    let existingCharges = [];
    
    try {
      const apiVersion = '2025-04';
      const chargesUrl = `https://${shopDomain}/admin/api/${apiVersion}/recurring_application_charges.json`;
      const response = await fetch(chargesUrl, {
        headers: {
          'X-Shopify-Access-Token': accessToken.trim(),
        },
      });
      
      if (response.ok) {
        const data = await response.json();
        existingCharges = data.recurring_application_charges || [];
        chargesAccessible = true;
      } else {
        chargesError = `Failed to list charges: ${response.status} ${response.statusText}`;
        if (response.status === 403) {
          chargesError += ' - This indicates billing permissions are not enabled or store cannot create charges';
        }
      }
    } catch (error) {
      chargesError = error.message;
    }
    
    // Check scopes from stored shop record
    const scopes = shopRecord.scope?.split(',') || [];
    const hasBillingScopes = scopes.some(scope => 
      scope.includes('write_') || scope.includes('read_')
    );
    
    // Determine if billing should work
    const billingShouldWork = chargesAccessible && canCreateCharges && hasBillingScopes;
    
    res.json({
      shop: {
        domain: shopDomain,
        isActive: shopRecord.isActive,
        shopType: shopType,
        planName: shopInfo?.plan_name || 'unknown',
        isDevelopmentStore: shopType?.toLowerCase().includes('test') || 
                            shopType?.toLowerCase().includes('development') ||
                            shopType?.toLowerCase().includes('partner'),
      },
      accessToken: {
        exists: !!shopRecord.accessToken,
        scopes: scopes,
        hasBillingScopes: hasBillingScopes,
      },
      billing: {
        canCreateCharges: canCreateCharges,
        chargesAccessible: chargesAccessible,
        billingShouldWork: billingShouldWork,
        existingChargesCount: existingCharges.length,
        existingCharges: existingCharges.map(c => ({
          id: c.id,
          name: c.name,
          status: c.status,
          price: c.price,
        })),
        errors: {
          shopInfo: billingError,
          charges: chargesError,
        },
      },
      diagnosis: {
        issue: !billingShouldWork 
          ? 'Billing API is not accessible. This is why you get 403 errors.'
          : 'Billing API is accessible. 403 errors may be due to other issues.',
        possibleCauses: [
          !chargesAccessible && 'Billing permissions not enabled in Partner Dashboard',
          !canCreateCharges && 'Store type does not allow billing (development store restrictions)',
          !hasBillingScopes && 'Access token does not have required scopes',
          chargesError && `API returned error: ${chargesError}`,
        ].filter(Boolean),
      },
      actionRequired: !billingShouldWork ? [
        '1. Go to Shopify Partners → Your App → Distribution → App Setup',
        '2. Ensure "Billing" capability is enabled',
        '3. If using a development store, check if it allows billing',
        '4. Reinstall the app to refresh permissions and scopes',
        '5. Check SHOPIFY_SCOPES environment variable includes necessary scopes',
      ] : [
        'Billing should work. If you still get 403 errors, check:',
        '1. Partner Dashboard billing permissions',
        '2. Store type restrictions',
        '3. Try creating a charge again',
      ],
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

export default router;
