import express from 'express';
import prisma from '../config/database.js';
import shopify from '../config/shopify.js';
import { decrypt } from '../utils/encryption.js';
import { authenticateShop, requirePlan } from '../middleware/auth.js';

const router = express.Router();

const PLAN_PRICES = {
  LIGHT: { amount: 9.99, name: 'Light Plan' },
  GROWTH: { amount: 29.99, name: 'Growth Plan' },
  PRO: { amount: 99.99, name: 'Pro Plan' },
};

/**
 * Verify charge status from Shopify API
 * This ensures we return the actual charge status, not just database state
 */
async function verifyChargeStatus(shopDomain, accessToken, chargeId) {
  if (!chargeId) return null;
  
  try {
    const apiVersion = '2025-04';
    const chargeUrl = `https://${shopDomain}/admin/api/${apiVersion}/recurring_application_charges/${chargeId}.json`;
    
    const response = await fetch(chargeUrl, {
      headers: {
        'X-Shopify-Access-Token': accessToken,
      },
    });
    
    if (!response.ok) {
      console.warn(`Failed to verify charge ${chargeId}: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    return data.recurring_application_charge;
  } catch (error) {
    console.error('Error verifying charge status:', error);
    return null;
  }
}

/**
 * List all charges from Shopify API
 */
async function listAllCharges(shopDomain, accessToken) {
  try {
    const apiVersion = '2025-04';
    const chargesUrl = `https://${shopDomain}/admin/api/${apiVersion}/recurring_application_charges.json`;
    
    const trimmedToken = accessToken.trim();
    const response = await fetch(chargesUrl, {
      headers: {
        'X-Shopify-Access-Token': trimmedToken,
      },
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`Failed to list charges: ${response.status}`);
      console.warn('List charges error response:', errorText.substring(0, 500));
      
      // If we get 403 on listing, that's a critical issue
      if (response.status === 403) {
        console.error('❌ CRITICAL: Cannot list charges - 403 Forbidden');
        console.error('This means the app does not have billing API access');
        console.error('Possible causes:');
        console.error('  1. Billing capability not enabled in Partner Dashboard');
        console.error('  2. App needs to be reinstalled to refresh permissions');
        console.error('  3. Access token missing required scopes');
      }
      
      return [];
    }
    
    const data = await response.json();
    return data.recurring_application_charges || [];
  } catch (error) {
    console.error('Error listing charges:', error);
    return [];
  }
}

/**
 * Cancel a pending charge in Shopify
 */
async function cancelCharge(shopDomain, accessToken, chargeId) {
  try {
    const apiVersion = '2025-04';
    const cancelUrl = `https://${shopDomain}/admin/api/${apiVersion}/recurring_application_charges/${chargeId}.json`;
    
    const trimmedToken = accessToken.trim();
    const response = await fetch(cancelUrl, {
      method: 'DELETE',
      headers: {
        'X-Shopify-Access-Token': trimmedToken,
      },
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`Failed to cancel charge ${chargeId}: ${response.status} - ${errorText}`);
      return false;
    }
    
    console.log(`✅ Successfully cancelled charge ${chargeId}`);
    return true;
  } catch (error) {
    console.error(`Error cancelling charge ${chargeId}:`, error);
    return false;
  }
}

/**
 * Validate access token by making a simple API call to Shopify
 * Returns true if token is valid, false otherwise
 */
async function validateAccessToken(shopDomain, accessToken) {
  try {
    // Use a lightweight endpoint to validate the token
    const apiVersion = '2025-04';
    const shopUrl = `https://${shopDomain}/admin/api/${apiVersion}/shop.json`;
    
    console.log('Validating token with URL:', shopUrl);
    console.log('Token preview:', accessToken.substring(0, 20) + '...' + accessToken.substring(accessToken.length - 10));
    console.log('Token length:', accessToken.length);
    console.log('Token starts with shpat_:', accessToken.startsWith('shpat_'));
    console.log('Token starts with shpua_:', accessToken.startsWith('shpua_'));
    
    const trimmedToken = accessToken.trim();
    if (trimmedToken !== accessToken) {
      console.warn('⚠️ Token had whitespace - trimmed before validation');
    }
    
    const response = await fetch(shopUrl, {
      headers: {
        'X-Shopify-Access-Token': trimmedToken,
      },
    });
    
    const responseText = await response.text();
    console.log('Validation response status:', response.status);
    console.log('Validation response (first 500 chars):', responseText.substring(0, 500));
    
    if (response.status === 401) {
      let errorDetails;
      try {
        errorDetails = JSON.parse(responseText);
      } catch {
        errorDetails = responseText;
      }
      console.error('❌ Access token validation failed: 401 Unauthorized');
      console.error('Error details:', errorDetails);
      return false;
    }
    
    if (!response.ok) {
      console.warn(`⚠️ Access token validation returned status ${response.status}`);
      console.warn('Response:', responseText.substring(0, 500));
      return false;
    }
    
    console.log('✅ Access token is valid');
    return true;
  } catch (error) {
    console.error('Error validating access token:', error);
    console.error('Error stack:', error.stack);
    return false;
  }
}

// Get all available pricing plans
router.get('/pricing-plans', authenticateShop, async (req, res) => {
  try {
    const plans = await prisma.pricingPlan.findMany({
      where: { isActive: true },
      orderBy: { price: 'asc' },
    });
    res.json(plans);
  } catch (error) {
    console.error('Error fetching pricing plans:', error);
    res.status(500).json({ error: 'Failed to fetch pricing plans' });
  }
});

// Get current subscription
router.get('/subscription', authenticateShop, async (req, res) => {
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { shopId: req.shop.id },
    });

    if (!subscription) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    // Verify actual charge status from Shopify API
    // CRITICAL: Check ALL charges, not just the stored chargeId
    // This prevents showing PENDING when there's an active charge from a previous plan
    const shopRecord = await prisma.shop.findUnique({
      where: { id: req.shop.id },
    });
    
    let verifiedStatus = subscription.status;
    let verifiedChargeId = subscription.chargeId;
    
    if (shopRecord) {
      try {
        // Use access token from middleware (already decrypted)
        const accessToken = req.accessToken || decrypt(shopRecord.accessToken);
        const apiVersion = '2025-04';
        const chargesUrl = `https://${req.shop.shopDomain}/admin/api/${apiVersion}/recurring_application_charges.json`;
        
        const chargesResponse = await fetch(chargesUrl, {
          headers: {
            'X-Shopify-Access-Token': accessToken,
          },
        });
        
        if (chargesResponse.ok) {
          const chargesData = await chargesResponse.json();
          const charges = chargesData.recurring_application_charges || [];
          
          // Find the ACTIVE charge first (this is the source of truth)
          const activeCharge = charges.find(c => c.status === 'active');
          
          if (activeCharge) {
            // There's an active charge - this is the real subscription
            verifiedStatus = 'ACTIVE';
            verifiedChargeId = activeCharge.id.toString();
            
            // Extract plan from charge name
            let plan = subscription.plan;
            if (activeCharge.name) {
              if (activeCharge.name.toLowerCase().includes('light')) {
                plan = 'LIGHT';
              } else if (activeCharge.name.toLowerCase().includes('growth')) {
                plan = 'GROWTH';
              } else if (activeCharge.name.toLowerCase().includes('pro')) {
                plan = 'PRO';
              }
            }
            
            // Update database if chargeId or plan changed
            if (verifiedChargeId !== subscription.chargeId || plan !== subscription.plan) {
              await prisma.subscription.update({
                where: { shopId: req.shop.id },
                data: {
                  status: 'ACTIVE',
                  chargeId: verifiedChargeId,
                  plan: plan,
                },
              });
              subscription.plan = plan;
              subscription.chargeId = verifiedChargeId;
            } else if (verifiedStatus !== subscription.status) {
              // Only update status if chargeId hasn't changed
              await prisma.subscription.update({
                where: { shopId: req.shop.id },
                data: { status: verifiedStatus },
              });
            }
          } else {
            // No active charge - check if there's a pending charge
            // CRITICAL: Always use Shopify's actual charge status as source of truth
            const pendingCharge = charges.find(c => c.status === 'pending');
            
            if (pendingCharge) {
              // There's a pending charge but no active one
              // ALWAYS show PENDING if Shopify only has a pending charge
              // This ensures UI reflects actual Shopify Billing API state
              verifiedStatus = 'PENDING';
              verifiedChargeId = pendingCharge.id.toString();
              
              // Extract plan from pending charge name
              let plan = subscription.plan;
              if (pendingCharge.name) {
                if (pendingCharge.name.toLowerCase().includes('light')) {
                  plan = 'LIGHT';
                } else if (pendingCharge.name.toLowerCase().includes('growth')) {
                  plan = 'GROWTH';
                } else if (pendingCharge.name.toLowerCase().includes('pro')) {
                  plan = 'PRO';
                }
              }
              
              // Update database to match Shopify's actual state
              if (verifiedChargeId !== subscription.chargeId || plan !== subscription.plan || subscription.status !== 'PENDING') {
                await prisma.subscription.update({
                  where: { shopId: req.shop.id },
                  data: {
                    status: 'PENDING',
                    chargeId: verifiedChargeId,
                    plan: plan,
                  },
                });
                subscription.plan = plan;
                subscription.chargeId = verifiedChargeId;
              }
            } else {
              // No active or pending charges - check stored chargeId status
              if (subscription.chargeId) {
                const storedCharge = charges.find(c => c.id.toString() === subscription.chargeId);
                if (storedCharge) {
                  if (storedCharge.status === 'cancelled' || storedCharge.status === 'expired') {
                    verifiedStatus = 'CANCELLED';
                    await prisma.subscription.update({
                      where: { shopId: req.shop.id },
                      data: { status: 'CANCELLED' },
                    });
                  } else if (storedCharge.status === 'declined') {
                    verifiedStatus = 'DECLINED';
                    await prisma.subscription.update({
                      where: { shopId: req.shop.id },
                      data: { status: 'DECLINED' },
                    });
                  }
                } else {
                  // Stored chargeId not found in Shopify - might have been deleted
                  // Keep current status but log warning
                  console.warn(`⚠️ Stored chargeId ${subscription.chargeId} not found in Shopify charges list`);
                }
              } else {
                // No chargeId stored and no charges in Shopify - subscription should be PENDING or CANCELLED
                if (subscription.status === 'ACTIVE') {
                  // This shouldn't happen - if we had ACTIVE but no charges, something is wrong
                  console.warn('⚠️ Subscription marked ACTIVE but no charges found in Shopify - setting to PENDING');
                  verifiedStatus = 'PENDING';
                  await prisma.subscription.update({
                    where: { shopId: req.shop.id },
                    data: { status: 'PENDING' },
                  });
                }
              }
            }
          }
        }
      } catch (error) {
        // If verification fails, use database status
        console.warn('Failed to verify charge status:', error.message);
      }
    }

    // Return subscription with verified status
    // The UI should only show the plan when status is ACTIVE
    res.json({
      ...subscription,
      status: verifiedStatus,
      chargeId: verifiedChargeId || subscription.chargeId,
    });
  } catch (error) {
    console.error('Get subscription error:', error);
    res.status(500).json({ error: 'Failed to get subscription' });
  }
});

// Create or update subscription charge (legacy RAC endpoint - kept for backwards compatibility)
router.post('/create-charge', authenticateShop, async (req, res) => {
  try {
    const { plan } = req.body;
    
    // Fetch plan from database - normalize name to capitalize first letter (e.g., light -> Light)
    const normalizedPlanName = plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase();
    const dbPlan = await prisma.pricingPlan.findUnique({
      where: { name: normalizedPlanName }
    });

    if (!dbPlan) {
      return res.status(400).json({ 
        error: 'Invalid plan',
        message: 'Please select a valid subscription plan from the available options.',
      });
    }
    
    // The database lookup above already validates if the plan is valid.
    // We normalize the plan name to uppercase for legacy internal status tracking
    const internalPlanName = plan.toUpperCase();

    const subscription = await prisma.subscription.findUnique({
      where: { shopId: req.shop.id },
    });

    // Check if there's already a pending charge for the same plan
    // This prevents duplicate charge creation
    if (subscription && subscription.status === 'PENDING' && subscription.plan === plan) {
      // Verify if the pending charge still exists in Shopify
      try {
        const shopRecord = await prisma.shop.findUnique({
          where: { id: req.shop.id },
        });
        
        if (shopRecord && subscription.chargeId) {
          // Use access token from middleware (already decrypted)
          const accessToken = req.accessToken || decrypt(shopRecord.accessToken);
          const existingCharge = await verifyChargeStatus(
            req.shop.shopDomain,
            accessToken,
            subscription.chargeId
          );
          
          if (existingCharge && (existingCharge.status === 'pending' || existingCharge.status === 'active')) {
            // Pending or active charge exists - return the confirmation URL
            const baseUrl = process.env.FRONTEND_URL || process.env.SHOPIFY_APP_URL || 'http://localhost:3000';
            const confirmationUrl = existingCharge.status === 'pending' 
              ? `https://${req.shop.shopDomain}/admin/charges/${existingCharge.api_client_id}/${existingCharge.id}/RecurringApplicationCharge/confirm_recurring_application_charge?signature=${existingCharge.decorated_return_url?.split('signature=')[1] || ''}`
              : null;
            
            return res.json({
              confirmationUrl: confirmationUrl || existingCharge.confirmation_url,
              chargeId: subscription.chargeId,
              message: 'A charge for this plan already exists',
            });
          }
        }
      } catch (error) {
        // If verification fails, proceed with creating a new charge
        console.warn('Failed to verify existing charge, proceeding with new charge creation:', error.message);
      }
    }

    const price = dbPlan.price;
    const planName = dbPlan.name;
    
    // Use access token from middleware (already decrypted)
    // The authenticateShop middleware decrypts and stores it in req.accessToken
    const accessToken = req.accessToken;
    
    if (!accessToken) {
      console.error('❌ Access token not found in request - middleware should have set req.accessToken');
      return res.status(500).json({ error: 'Access token not available' });
    }
    
    // Validate token format (Shopify access tokens start with 'shpat_', 'shpua_', or 'shpca_')
    // shpat_ = Admin API access token (most common)
    // shpua_ = User access token (OAuth flow)
    // shpca_ = Custom app access token (Created in Shop Admin)
    if (!accessToken.startsWith('shpat_') && !accessToken.startsWith('shpua_') && !accessToken.startsWith('shpca_')) {
      console.error('❌ Invalid access token format - should start with "shpat_", "shpua_", or "shpca_"');
      console.error('Token preview:', accessToken.substring(0, 20) + '...');
      return res.status(500).json({ 
        error: 'Invalid access token format',
        message: 'Access token appears to be invalid. Please reinstall the app to get a new token.',
      });
    }
    
    const tokenType = accessToken.startsWith('shpat_') ? 'Admin API token' : 
                      accessToken.startsWith('shpua_') ? 'User access token' : 'Custom app token';
    console.log(`Token type: ${tokenType}`);

    const shopDomain = req.shop.shopDomain;
    
    // Validate access token before proceeding
    console.log('\n=== Validating Access Token ===');
    const isValidToken = await validateAccessToken(shopDomain, accessToken);
    if (!isValidToken) {
      console.error('❌ Access token validation failed');
      console.error('⚠️ This usually means:');
      console.error('   1. The access token is from an old app (you created a new app)');
      console.error('   2. The app was uninstalled and the token is invalid');
      console.error('   3. The token was revoked or expired');
      console.error('   SOLUTION: Delete the shop record and reinstall the app');
      console.error('   - Use: DELETE /diagnostics/shop?shop=' + shopDomain);
      console.error('   - Then reinstall the app to get a fresh token');
      
      return res.status(401).json({ 
        error: 'Access token is invalid or expired',
        message: 'The app\'s access token is no longer valid. This can happen if you created a new app, uninstalled/reinstalled, or the token was revoked.',
        solution: 'Delete the shop record and reinstall the app to get a fresh token.',
        steps: [
          '1. Delete the shop record: DELETE /diagnostics/shop?shop=' + shopDomain,
          '2. Go to Shopify Admin → Apps → ScaleGuard → Uninstall (if installed)',
          '3. Reinstall the app from Partner Dashboard',
          '4. This will create a new shop record with a valid access token',
        ],
        shopDomain: shopDomain,
      });
    }
    
    // CRITICAL: Check for and cancel any pending charges before creating a new one
    // Pending charges block new charge creation in Shopify
    console.log('\n=== Checking for Pending Charges ===');
    console.log('Using access token:', accessToken.substring(0, 20) + '...' + accessToken.substring(accessToken.length - 10));
    const allCharges = await listAllCharges(shopDomain, accessToken);
    const pendingCharges = allCharges.filter(c => c.status === 'pending');
    
    const activeCharges = allCharges?.filter(c => c.status === 'active').length || 0;
    const cancelledCharges = allCharges?.filter(c => c.status === 'cancelled').length || 0;
    const declinedCharges = allCharges?.filter(c => c.status === 'declined').length || 0;
    const expiredCharges = allCharges?.filter(c => c.status === 'expired').length || 0;
    
    console.log('Charges API test results:', {
      canListCharges: allCharges !== null && Array.isArray(allCharges),
      totalCharges: allCharges?.length || 0,
      pendingCharges: pendingCharges.length,
      activeCharges: activeCharges,
      cancelledCharges: cancelledCharges,
      declinedCharges: declinedCharges,
      expiredCharges: expiredCharges,
    });
    
    // Check if there are too many charges (Shopify may limit charge creation)
    if (allCharges && allCharges.length > 50) {
      console.warn(`⚠️ WARNING: Found ${allCharges.length} total charges - this is unusually high`);
      console.warn(`⚠️ Breakdown: ${activeCharges} active, ${cancelledCharges} cancelled, ${declinedCharges} declined, ${expiredCharges} expired`);
      console.warn('⚠️ Shopify may limit charge creation when there are too many existing charges');
      console.warn('⚠️ Consider cleaning up old cancelled/declined/expired charges');
    }
    
    if (pendingCharges.length > 0) {
      console.log(`⚠️ Found ${pendingCharges.length} pending charge(s) - cancelling before creating new charge`);
      for (const pendingCharge of pendingCharges) {
        const cancelled = await cancelCharge(shopDomain, accessToken, pendingCharge.id.toString());
        if (cancelled) {
          console.log(`✅ Cancelled pending charge ${pendingCharge.id} (${pendingCharge.name})`);
        } else {
          console.warn(`⚠️ Failed to cancel pending charge ${pendingCharge.id} - may block new charge creation`);
        }
      }
    } else {
      console.log('✅ No pending charges found - proceeding with new charge creation');
    }
    
    // Additional diagnostic: Check if we can access the charges endpoint at all
    if (allCharges === null || !Array.isArray(allCharges)) {
      console.warn('⚠️ WARNING: Could not list charges - this might indicate API access issues');
      console.warn('⚠️ This could mean:');
      console.warn('   1. The app does not have billing permissions');
      console.warn('   2. The access token is missing required scopes');
      console.warn('   3. The API endpoint is not accessible');
    }
    
    // Use FRONTEND_URL if available (for ngrok), otherwise SHOPIFY_APP_URL
    const baseUrl = process.env.FRONTEND_URL || process.env.SHOPIFY_APP_URL || 'http://localhost:3000';
    // Ensure return URL includes shop and host parameters for proper embedded app redirect handling
    // The host parameter is critical for maintaining embedded context after billing confirmation
    const host = req.query.host; // Get host parameter from request (passed from frontend)
    const returnUrlParams = new URLSearchParams();
    returnUrlParams.set('shop', shopDomain);
    if (host) {
      returnUrlParams.set('host', host);
    }
    const returnUrl = `${baseUrl}/billing/confirm?${returnUrlParams.toString()}`;
    
    // Determine if this is a test/development store
    // CRITICAL: We must check the actual shop type, not just the domain name
    // Setting test=true on a production store causes 403 Forbidden errors
    let isTestStore = false;
    try {
      // Check shop type via API to determine if it's a development store
      const apiVersion = '2025-04';
      const shopUrl = `https://${shopDomain}/admin/api/${apiVersion}/shop.json`;
      const shopResponse = await fetch(shopUrl, {
        headers: {
          'X-Shopify-Access-Token': accessToken.trim(),
        },
      });
      
      if (shopResponse.ok) {
        const shopData = await shopResponse.json();
        const planName = shopData.shop?.plan_name?.toLowerCase() || '';
        // Development stores have plan names like "partner_test", "development", etc.
        isTestStore = planName.includes('test') || 
                     planName.includes('development') || 
                     planName.includes('partner');
        
        console.log('Shop type check:', {
          planName: shopData.shop?.plan_name,
          isTestStore,
        });
      } else {
        // If we can't check shop type, fall back to domain name check
        // But be conservative - only set test=true if domain clearly indicates test store
        isTestStore = shopDomain.toLowerCase().includes('.myshopify.com') && 
                     (shopDomain.toLowerCase().includes('-test-') || 
                      shopDomain.toLowerCase().includes('.dev.') ||
                      shopDomain.toLowerCase().startsWith('dev-'));
        console.warn('⚠️ Could not check shop type, using domain-based detection:', isTestStore);
      }
    } catch (error) {
      // If shop type check fails, don't set test=true (safer to omit it)
      console.warn('⚠️ Failed to check shop type, omitting test parameter:', error.message);
      isTestStore = false;
    }
    
    const chargeData = {
      recurring_application_charge: {
        name: `${planName} Plan`,
        price: price,
        return_url: returnUrl,
        trial_days: planName === 'Light' ? 7 : undefined,
        // Only set test parameter for actual development/test stores
        // CRITICAL: Omitting test parameter for production stores (defaults to false)
        // Setting test=true on production stores causes 403 Forbidden
        ...(isTestStore && { test: true }),
      },
    };
    
    console.log('Charge creation details:', {
      shopDomain,
      isTestStore,
      testParameter: isTestStore ? true : 'omitted (production)',
      returnUrl,
      note: isTestStore 
        ? 'Using test=true for development store' 
        : 'Omitting test parameter for production store',
    });
    
    // Log the exact charge data being sent
    console.log('\n=== Charge Data Being Sent to Shopify ===');
    console.log('Charge Data (JSON):', JSON.stringify(chargeData, null, 2));
    console.log('Will include test parameter:', isTestStore);
    console.log('Charge Data Summary:', {
      name: chargeData.recurring_application_charge.name,
      price: chargeData.recurring_application_charge.price,
      trial_days: chargeData.recurring_application_charge.trial_days,
      test: chargeData.recurring_application_charge.test,
      return_url: chargeData.recurring_application_charge.return_url,
    });

    // Use latest API version - Shopify is using 2025-04, so we'll match that
    const apiVersion = '2025-04';
    const chargeUrl = `https://${shopDomain}/admin/api/${apiVersion}/recurring_application_charges.json`;
    
    console.log('\n=== Creating Recurring Charge ===');
    console.log('Shop Domain:', shopDomain);
    console.log('Plan:', plan);
    console.log('Price:', price);
    console.log('Return URL:', returnUrl);
    console.log('Charge URL:', chargeUrl);
    console.log('Charge Data:', JSON.stringify(chargeData, null, 2));
    console.log('Request Headers:', {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken.substring(0, 20) + '...',
    });
    
    const trimmedToken = accessToken.trim();
    const chargeResponse = await fetch(chargeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': trimmedToken,
      },
      body: JSON.stringify(chargeData),
    });

    const responseText = await chargeResponse.text();
    console.log('Charge response status:', chargeResponse.status);
    console.log('Charge response headers:', Object.fromEntries(chargeResponse.headers.entries()));
    console.log('Charge response body (full):', responseText);
    console.log('Charge response body length:', responseText.length);
    console.log('Content-Type:', chargeResponse.headers.get('content-type'));
    
    // Handle 403 Forbidden errors (most common: billing capability not enabled)
    if (chargeResponse.status === 403) {
      const contentType = chargeResponse.headers.get('content-type') || '';
      const isHtml = contentType.includes('text/html');
      const isEmpty = !responseText || responseText.length === 0;
      
      console.error('❌ Received 403 Forbidden response');
      console.error('Content-Type:', contentType);
      console.error('Response body empty:', isEmpty);
      
      if (isHtml && !isEmpty) {
        console.error('HTML response (first 1000 chars):', responseText.substring(0, 1000));
      } else if (isEmpty) {
        console.error('⚠️ Response body is empty - this is unusual for a 403 error');
        console.error('This typically means the endpoint is completely blocked, not just unauthorized');
      }
      
      // Try to extract error message from HTML if available
      let htmlErrorDetails = '';
      if (responseText && responseText.length > 0) {
        const titleMatch = responseText.match(/<title[^>]*>([^<]+)<\/title>/i);
        const h1Match = responseText.match(/<h1[^>]*>([^<]+)<\/h1>/i);
        const errorMatch = responseText.match(/error[^>]*>([^<]+)/i);
        
        if (titleMatch) htmlErrorDetails += `Title: ${titleMatch[1]}\n`;
        if (h1Match) htmlErrorDetails += `Heading: ${h1Match[1]}\n`;
        if (errorMatch) htmlErrorDetails += `Error: ${errorMatch[1]}\n`;
      }
      
      // Extract useful headers for diagnostics
      const diagnosticHeaders = {
        'x-shopify-shop-api-call-limit': chargeResponse.headers.get('x-shopify-shop-api-call-limit'),
        'x-shopify-api-version': chargeResponse.headers.get('x-shopify-api-version'),
        'x-request-id': chargeResponse.headers.get('x-request-id'),
        'x-shopid': chargeResponse.headers.get('x-shopid'),
      };
      
      // Check if we can list charges (this helps diagnose the issue)
      const canListCharges = allCharges !== null && Array.isArray(allCharges);
      const totalCharges = allCharges?.length || 0;
      const hasManyCharges = totalCharges > 50;
      
      return res.status(403).json({ 
        error: 'Failed to create charge - 403 Forbidden',
        message: 'Shopify returned a 403 Forbidden error when trying to create a charge.',
        critical: canListCharges 
          ? hasManyCharges
            ? `App can LIST charges (${totalCharges} found) but cannot CREATE - too many existing charges may be blocking creation`
            : 'App can LIST charges but cannot CREATE them - this suggests a permissions refresh is needed'
          : 'App cannot access billing API - check billing capability in Partner Dashboard',
        details: {
          status: chargeResponse.status,
          shopDomain,
          isTestStore,
          testParameterUsed: isTestStore,
          canListCharges: canListCharges,
          totalCharges: totalCharges,
          hasManyCharges: hasManyCharges,
          responseInfo: {
            contentType,
            bodyEmpty: isEmpty,
            bodyLength: responseText?.length || 0,
            diagnosticHeaders,
          },
          possibleCauses: canListCharges ? (hasManyCharges ? [
            `⚠️ CRITICAL: Found ${totalCharges} existing charges - Shopify may block new charge creation`,
            '⚠️ Too many charges (especially cancelled/declined) can prevent new charge creation',
            '⚠️ Solution: Clean up old cancelled/declined/expired charges via Partner Dashboard',
            '⚠️ Or: Contact Shopify Support to clean up charges for this store',
            '⚠️ App may need to be reinstalled to refresh create permissions',
            'Development store restrictions (some dev stores cannot create charges)',
          ] : [
            '⚠️ App can list charges but cannot create - permissions may need refresh',
            '⚠️ App may need to be reinstalled to refresh create permissions',
            '⚠️ Access token may have read-only billing permissions',
            'Development store restrictions (some dev stores cannot create charges)',
            'API version mismatch or deprecated endpoint',
          ]) : [
            '❌ CRITICAL: App does not have billing capability enabled in Partner Dashboard',
            '❌ CRITICAL: App needs to be reinstalled after enabling billing capability',
            'Development store restrictions (some dev stores cannot create charges)',
            'API version mismatch or deprecated endpoint',
            'Access token does not have billing scopes',
            'App is not approved for billing in Partner Dashboard'
          ],
          solutions: canListCharges ? (hasManyCharges ? [
            `1. CRITICAL: Too many existing charges (${totalCharges} total) are blocking new charge creation`,
            `   Breakdown: ${cancelledCharges} cancelled, ${declinedCharges} declined, ${expiredCharges} expired`,
            '',
            '2. SOLUTION OPTIONS:',
            '   Option A - Contact Shopify Support (RECOMMENDED):',
            '   - Email support@shopify.com or use Partner Dashboard support',
            '   - Request bulk cleanup of old charges for store: ' + shopDomain,
            '   - Mention: "67 charges blocking new charge creation, need cleanup"',
            '',
            '   Option B - Use a different test store:',
            '   - Create a fresh development store in Partner Dashboard',
            '   - Install the app on the new store',
            '   - Test charge creation on the clean store',
            '',
            '   Option C - Wait for auto-cleanup (if Shopify does this):',
            '   - Shopify may auto-clean old charges periodically',
            '   - Check back in a few days/weeks',
            '',
            '3. NOTE: Charges cannot be deleted via API - they are permanent records',
            '4. After cleanup, try creating a charge again',
            '5. If still failing after cleanup, try reinstalling the app',
          ] : [
            '1. Try reinstalling the app to refresh permissions:',
            '   - Go to Shopify Admin → Apps → ScaleGuard → Uninstall',
            '   - Reinstall the app from Partner Dashboard',
            '2. Check if the access token has write permissions for billing',
            '3. Verify the app has "write_billing" scope (if required)',
            '4. If still failing, check Partner Dashboard → App Setup → App capabilities',
            '5. Ensure billing capability is enabled',
          ]) : [
            '1. Go to https://partners.shopify.com → Your App → Distribution → App Setup',
            '2. Scroll to "App capabilities" section',
            '3. Enable "Billing" or "Recurring Application Charges" capability',
            '4. Save changes in Partner Dashboard',
            '5. IMPORTANT: Uninstall the app from the test store',
            '6. Reinstall the app to refresh permissions',
            '7. Try creating a charge again',
            '',
            'If still failing:',
            '- Check that the app is not in "Development" mode (should be "Public" or "Unlisted")',
            '- Verify the app has been approved for billing (if required)',
            '- Check Shopify API documentation for any recent changes'
          ],
          diagnostic: 'Run: GET /diagnostics/billing?shop=' + shopDomain + ' to check billing status',
          htmlPreview: responseText && responseText.length > 0 ? responseText.substring(0, 500) : '(empty response)',
          htmlErrorDetails: htmlErrorDetails || (isEmpty ? 'Response body is empty' : 'No error details found in HTML'),
        }
      });
    }
    
    // If response is HTML but not 403, handle it
    if (chargeResponse.headers.get('content-type')?.includes('text/html')) {
      console.error('❌ Received HTML response instead of JSON');
      console.error('HTML response (first 1000 chars):', responseText.substring(0, 1000));
      
      return res.status(chargeResponse.status || 500).json({ 
        error: 'Failed to create charge - received HTML error page',
        message: 'Shopify returned an HTML error page instead of JSON.',
        details: {
          status: chargeResponse.status,
          shopDomain,
          htmlPreview: responseText.substring(0, 500),
        }
      });
    }
    
    let chargeResult;
    try {
      chargeResult = responseText ? JSON.parse(responseText) : {};
    } catch (error) {
      console.error('Failed to parse charge response as JSON:', error.message);
      console.error('Raw response:', responseText);
      return res.status(chargeResponse.status).json({ 
        error: 'Failed to create charge - invalid response from Shopify',
        details: {
          status: chargeResponse.status,
          response: responseText || '(empty response)',
          headers: Object.fromEntries(chargeResponse.headers.entries()),
        }
      });
    }

    if (!chargeResponse.ok || chargeResult.errors) {
      console.error('❌ Charge creation failed');
      console.error('Response Status:', chargeResponse.status);
      console.error('Response Status Text:', chargeResponse.statusText);
      console.error('Full Response:', JSON.stringify(chargeResult, null, 2));
      console.error('Errors:', chargeResult.errors || chargeResult);
      
      // Special handling for 401 Unauthorized
      if (chargeResponse.status === 401) {
        const errorMessage = chargeResult.errors || chargeResult.error || 'Unauthorized';
        const isInvalidToken = typeof errorMessage === 'string' && 
          (errorMessage.includes('Invalid API key') || 
           errorMessage.includes('access token') || 
           errorMessage.includes('unrecognized login'));
        
        // If token is invalid, we can't check for pending charges (would also fail)
        if (isInvalidToken) {
          return res.status(401).json({ 
            error: 'Access token is invalid or expired',
            message: 'The app\'s access token is no longer valid. This can happen if the app was uninstalled and reinstalled, or if the token was revoked.',
            solution: 'Please reinstall the app to obtain a new access token. Go to Shopify Admin → Apps → ScaleGuard → Uninstall, then reinstall.',
            errors: chargeResult.errors || chargeResult,
            details: {
              status: chargeResponse.status,
              statusText: chargeResponse.statusText,
              shopDomain: shopDomain,
            }
          });
        }
        
        // If it's not a token issue, check for pending charges
        try {
          const remainingCharges = await listAllCharges(shopDomain, accessToken);
          const remainingPending = remainingCharges.filter(c => c.status === 'pending');
          
          return res.status(401).json({ 
            error: 'Failed to create charge - Unauthorized (401)',
            message: 'This usually means: 1) Pending charge blocking creation, or 2) App lacks billing permissions',
            errors: chargeResult.errors || chargeResult,
            diagnostics: {
              pendingChargesCount: remainingPending.length,
              pendingCharges: remainingPending.map(c => ({
                id: c.id,
                name: c.name,
                status: c.status,
              })),
              suggestion: remainingPending.length > 0 
                ? 'Try cancelling pending charges first using POST /billing/cancel-pending'
                : 'Check if app has billing permissions enabled in Partner Dashboard',
            },
            details: {
              status: chargeResponse.status,
              statusText: chargeResponse.statusText,
              response: chargeResult,
            }
          });
        } catch (listError) {
          // If listing charges also fails, it's likely a token issue
          return res.status(401).json({ 
            error: 'Access token is invalid or expired',
            message: 'The app\'s access token is no longer valid. Please reinstall the app.',
            errors: chargeResult.errors || chargeResult,
            details: {
              status: chargeResponse.status,
              statusText: chargeResponse.statusText,
            }
          });
        }
      }
      
      // Special handling for 422 Unprocessable Entity - App Migration Required
      if (chargeResponse.status === 422) {
        const errorMessage = chargeResult.errors?.base?.[0] || chargeResult.errors || chargeResult.error || 'Unknown error';
        const isAppMigrationError = typeof errorMessage === 'string' && 
          (errorMessage.includes('currently owned by a Shop') || 
           errorMessage.includes('must be migrated to the Shopify partners area') ||
           errorMessage.includes('migrated to the Shopify partners'));
        
        if (isAppMigrationError) {
          return res.status(422).json({ 
            error: 'App Migration Required',
            message: 'This app is currently owned by a Shop and must be migrated to the Shopify Partners area before it can create charges.',
            critical: true,
            errors: chargeResult.errors || chargeResult,
            solution: 'The app needs to be migrated from Shop ownership to Partner ownership in Shopify.',
            steps: [
              '1. Go to https://partners.shopify.com',
              '2. Navigate to: Apps → Your App → Distribution → App Setup',
              '3. Look for "App ownership" or "Migration" section',
              '4. If the app shows as "Owned by Shop", you need to migrate it to Partner ownership',
              '5. Contact Shopify Support if migration option is not available:',
              '   - Email: partners@shopify.com',
              '   - Or use Partner Dashboard → Help → Contact Support',
              '   - Mention: "App needs to be migrated from Shop ownership to Partner ownership"',
              '6. After migration is complete, try creating a charge again',
              '',
              'ALTERNATIVE: If migration is not possible, create a new app in Partner Dashboard:',
              '1. Go to https://partners.shopify.com → Apps → Create app',
              '2. Create a new app (this will be Partner-owned by default)',
              '3. Update your environment variables with the new app credentials',
              '4. Delete the old shop record: DELETE /diagnostics/shop?shop=' + shopDomain,
              '5. Reinstall the app with the new Partner-owned app',
            ],
            details: {
              status: chargeResponse.status,
              statusText: chargeResponse.statusText,
              shopDomain: shopDomain,
              errorMessage: errorMessage,
              response: chargeResult,
            }
          });
        }
      }
      
      return res.status(chargeResponse.status || 400).json({ 
        error: 'Failed to create charge',
        errors: chargeResult.errors || chargeResult,
        details: {
          status: chargeResponse.status,
          statusText: chargeResponse.statusText,
          response: chargeResult,
          request: {
            url: chargeUrl,
            method: 'POST',
            body: chargeData,
          },
        }
      });
    }

    const charge = chargeResult.recurring_application_charge;
    const chargeId = charge.id.toString();
    
    // CRITICAL: Do NOT update subscription plan or status when creating a charge.
    // The subscription should only change when Shopify confirms the charge is ACTIVE (via webhook).
    // This ensures the UI shows the correct plan until the new charge is approved.
    
    // Handle subscription update with error handling for database connection issues
    try {
      if (subscription && subscription.status === 'ACTIVE') {
        // If subscription is ACTIVE, we're creating a new charge to replace it.
        // Store the new chargeId for tracking, but keep status as ACTIVE and don't change plan.
        // The old charge will be cancelled by Shopify, and the new charge will activate via webhook.
        try {
          await prisma.subscription.update({
            where: { shopId: req.shop.id },
            data: {
              chargeId, // Store new pending charge ID for tracking
              // Keep status as ACTIVE and plan unchanged until new charge is confirmed
            },
          });
          console.log('⚠️ Subscription is ACTIVE - stored new chargeId for tracking. Old charge will be cancelled, new charge pending approval.');
        } catch (dbError) {
          // Log database error but don't fail the charge creation
          console.warn('⚠️ Failed to update subscription chargeId (non-critical):', dbError.message);
        }
      } else if (subscription) {
        // Subscription exists but is not ACTIVE - update chargeId for tracking only
        try {
          await prisma.subscription.update({
            where: { shopId: req.shop.id },
            data: {
              chargeId, // Store pending charge ID for tracking
              // Do NOT update plan or status - keep existing values
            },
          });
        } catch (dbError) {
          // Log database error but don't fail the charge creation
          console.warn('⚠️ Failed to update subscription (non-critical):', dbError.message);
          // Charge was created successfully, so we can continue
        }
      } else {
        // No subscription exists - create one with PENDING status
        // Plan is stored but status is PENDING, so it won't show as active until confirmed
        const trialDays = plan === 'LIGHT' ? 7 : null;
        try {
          await prisma.subscription.create({
            data: {
              shopId: req.shop.id,
              plan, // Store intended plan
              chargeId,
              status: 'PENDING', // Status is PENDING, so plan won't be shown as active
              trialEndsAt: trialDays 
                ? new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000)
                : null,
            },
          });
        } catch (dbError) {
          // Log database error but don't fail the charge creation
          console.warn('⚠️ Failed to create subscription (non-critical):', dbError.message);
          // Charge was created successfully, so we can continue
        }
      }
    } catch (error) {
      // Log error but don't fail the request - charge was already created successfully
      console.warn('⚠️ Database operation failed (non-critical):', error.message);
    }

    res.json({ 
      confirmationUrl: charge.confirmation_url,
      chargeId 
    });
  } catch (error) {
    console.error('Create charge error:', error);
    res.status(500).json({ error: 'Failed to create charge' });
  }
});

// NEW: Create or update subscription using the App Subscriptions GraphQL API
// This avoids the legacy Recurring Application Charges endpoint that returns 403 for new apps
router.post('/create-subscription', authenticateShop, async (req, res) => {
  try {
    const { plan } = req.body;

    if (!plan || !PLAN_PRICES[plan]) {
      return res.status(400).json({
        error: 'Invalid plan',
        message: 'Please select a valid subscription plan (LIGHT, GROWTH, or PRO)',
        validPlans: Object.keys(PLAN_PRICES),
      });
    }

    const price = PLAN_PRICES[plan];

    // Access token is decrypted and attached by authenticateShop middleware
    const accessToken = req.accessToken;
    const shopDomain = req.shop.shopDomain;

    if (!accessToken) {
      console.error('❌ Access token not found in request - middleware should have set req.accessToken');
      return res.status(500).json({ error: 'Access token not available' });
    }

    console.log('\n=== Creating App Subscription (GraphQL) ===');
    console.log('Shop Domain:', shopDomain);
    console.log('Plan:', plan);
    console.log('Price:', price);

    // Validate access token before proceeding
    console.log('\n=== Validating Access Token (before subscription create) ===');
    const isValidToken = await validateAccessToken(shopDomain, accessToken);
    if (!isValidToken) {
      return res.status(401).json({
        error: 'Access token is invalid or expired',
        message: 'The app\'s access token is no longer valid. Please reinstall the app to get a new token.',
        shopDomain,
      });
    }

    // Build return URL (same as legacy route) so frontend flow stays identical
    const baseUrl = process.env.FRONTEND_URL || process.env.SHOPIFY_APP_URL || 'http://localhost:3000';
    const host = req.query.host;
    const returnUrlParams = new URLSearchParams();
    returnUrlParams.set('shop', shopDomain);
    if (host) {
      returnUrlParams.set('host', host);
    }
    const returnUrl = `${baseUrl}/billing/confirm?${returnUrlParams.toString()}`;

    // Determine if this is a test/development store for the "test" flag
    // CRITICAL: Development stores MUST have test=true, otherwise approval will fail
    let isTestStore = false;
    try {
      // First check domain name - development stores often have "-test" or ".dev" in domain
      const domainLower = shopDomain.toLowerCase();
      if (domainLower.includes('-test') || domainLower.includes('.dev.') || domainLower.includes('devstore')) {
        isTestStore = true;
        console.log('Shop type check (domain-based): Development store detected from domain name');
      }
      
      // Also check via API for plan name
      const apiVersion = '2025-04';
      const shopUrl = `https://${shopDomain}/admin/api/${apiVersion}/shop.json`;
      const shopResponse = await fetch(shopUrl, {
        headers: {
          'X-Shopify-Access-Token': accessToken.trim(),
        },
      });

      if (shopResponse.ok) {
        const shopData = await shopResponse.json();
        const planName = shopData.shop?.plan_name?.toLowerCase() || '';
        // If domain check didn't catch it, check plan name
        if (!isTestStore) {
          isTestStore =
            planName.includes('test') ||
            planName.includes('development') ||
            planName.includes('partner');
        }

        console.log('Shop type check (for App Subscriptions):', {
          planName: shopData.shop?.plan_name,
          domain: shopDomain,
          isTestStore,
        });
      } else {
        console.warn('⚠️ Could not check shop type via API, using domain-based detection');
      }
    } catch (error) {
      console.warn('⚠️ Failed to check shop type for App Subscriptions, using domain-based detection:', error.message);
    }
    
    // CRITICAL: If we still can't determine, and domain suggests test store, default to test=true
    // Better to use test=true on a production store than test=false on a dev store (which causes approval failure)
    if (!isTestStore && shopDomain.toLowerCase().includes('-test')) {
      isTestStore = true;
      console.warn('⚠️ Forcing test=true based on domain name containing "-test"');
    }

    const apiVersion = '2025-04';
    const graphqlUrl = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

    // App Subscriptions GraphQL mutation
    const mutation = `
      mutation AppSubscriptionCreate(
        $name: String!,
        $returnUrl: URL!,
        $trialDays: Int,
        $test: Boolean,
        $price: Decimal!,
        $currencyCode: CurrencyCode!
      ) {
        appSubscriptionCreate(
          name: $name,
          returnUrl: $returnUrl,
          trialDays: $trialDays,
          test: $test,
          lineItems: [{
            plan: {
              appRecurringPricingDetails: {
                price: { amount: $price, currencyCode: $currencyCode },
                interval: EVERY_30_DAYS
              }
            }
          }]
        ) {
          userErrors {
            field
            message
          }
          confirmationUrl
          appSubscription {
            id
            name
            status
          }
        }
      }
    `;

    const trialDays = plan === 'LIGHT' ? 7 : null;

    const variables = {
      name: price.name,
      returnUrl,
      trialDays,
      test: isTestStore || undefined,
      price: price.amount,
      currencyCode: 'USD',
    };

    console.log('AppSubscriptionCreate variables:', variables);

    const gqlResponse = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken.trim(),
      },
      body: JSON.stringify({ query: mutation, variables }),
    });

    const gqlText = await gqlResponse.text();
    console.log('AppSubscriptionCreate status:', gqlResponse.status);
    console.log('AppSubscriptionCreate raw response:', gqlText);

    if (!gqlResponse.ok) {
      return res.status(gqlResponse.status).json({
        error: 'Failed to create subscription',
        message: 'Shopify returned a non-200 response when creating the subscription.',
        status: gqlResponse.status,
        body: gqlText,
      });
    }

    let gqlJson;
    try {
      gqlJson = JSON.parse(gqlText);
    } catch (parseError) {
      console.error('Failed to parse GraphQL response as JSON:', parseError);
      return res.status(500).json({
        error: 'Failed to parse Shopify response',
        rawBody: gqlText,
      });
    }

    if (gqlJson.errors && gqlJson.errors.length > 0) {
      console.error('GraphQL top-level errors:', gqlJson.errors);
      return res.status(400).json({
        error: 'Failed to create subscription',
        graphqlErrors: gqlJson.errors,
      });
    }

    const result = gqlJson.data?.appSubscriptionCreate;
    if (!result) {
      return res.status(500).json({
        error: 'Invalid Shopify response',
        message: 'appSubscriptionCreate payload is missing.',
        raw: gqlJson,
      });
    }

    if (result.userErrors && result.userErrors.length > 0) {
      console.error('AppSubscriptionCreate user errors:', result.userErrors);
      
      // Check for specific "Managed Pricing" error
      const managedPricingError = result.userErrors.find(
        err => err.message && err.message.includes('Managed Pricing Apps cannot use the Billing API')
      );
      
      if (managedPricingError) {
        return res.status(400).json({
          error: 'Managed Pricing App - Cannot Create Charges',
          message: 'This app is configured as a "Managed Pricing" app in the Partner Dashboard. Managed Pricing apps cannot create their own charges via the Billing API.',
          solution: 'Change the app to "Unmanaged Pricing" in Partner Dashboard',
          steps: [
            '1. Go to Shopify Partner Dashboard → Apps → ScaleGuard (your app)',
            '2. Click "App setup" or "Configuration"',
            '3. Find "Pricing" or "Billing" section',
            '4. Change from "Managed Pricing" to "Unmanaged Pricing" (or "App sets pricing")',
            '5. Save changes',
            '6. Reinstall the app on your store to apply the change',
            '',
            'NOTE: Managed Pricing means Shopify handles pricing/billing directly.',
            'Unmanaged Pricing means your app controls pricing via the Billing API.',
          ],
          userErrors: result.userErrors,
        });
      }
      
      return res.status(400).json({
        error: 'Failed to create subscription',
        userErrors: result.userErrors,
      });
    }

    const appSubscription = result.appSubscription;
    if (!appSubscription) {
      return res.status(500).json({
        error: 'Subscription not returned',
        message: 'Shopify did not return an appSubscription object.',
        raw: result,
      });
    }

    const subscriptionId = appSubscription.id;
    const subscriptionStatus = appSubscription.status || 'PENDING';
    const confirmationUrl = result.confirmationUrl;

    console.log('Created App Subscription:', {
      id: subscriptionId,
      status: subscriptionStatus,
      confirmationUrl,
    });

    // Persist subscription in our database (similar to legacy flow)
    const trialEndsAt =
      trialDays && trialDays > 0
        ? new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000)
        : null;

    try {
      const existing = await prisma.subscription.findUnique({
        where: { shopId: req.shop.id },
      });

      const data = {
        plan,
        chargeId: subscriptionId,
        status: subscriptionStatus === 'ACTIVE' ? 'ACTIVE' : 'PENDING',
        trialEndsAt,
      };

      if (existing) {
        await prisma.subscription.update({
          where: { shopId: req.shop.id },
          data,
        });
      } else {
        await prisma.subscription.create({
          data: {
            shopId: req.shop.id,
            ...data,
          },
        });
      }
    } catch (dbError) {
      console.warn('⚠️ Failed to persist subscription in database (non-critical):', dbError.message);
    }

    // Frontend needs confirmationUrl to redirect merchant to approve subscription
    return res.json({
      confirmationUrl,
      subscriptionId,
      status: subscriptionStatus,
    });
  } catch (error) {
    console.error('Create subscription error (App Subscriptions):', error);
    return res.status(500).json({ error: 'Failed to create subscription' });
  }
});

// Confirm charge (webhook handler will update status)
router.get('/confirm', authenticateShop, async (req, res) => {
  res.json({ message: 'Charge confirmation pending. Webhook will update status.' });
});

// List all charges (for debugging)
router.get('/charges', authenticateShop, async (req, res) => {
  try {
    // Use access token from middleware (already decrypted)
    const accessToken = req.accessToken;
    
    if (!accessToken) {
      return res.status(500).json({ error: 'Access token not available' });
    }
    
    const allCharges = await listAllCharges(req.shop.shopDomain, accessToken);
    
    // For pending charges, include confirmation URL
    const chargesWithUrls = allCharges.map(charge => {
      const chargeData = { ...charge };
      if (charge.status === 'pending' && charge.confirmation_url) {
        chargeData.confirmationUrl = charge.confirmation_url;
        // Also construct the direct admin URL
        chargeData.adminConfirmationUrl = `https://${req.shop.shopDomain}/admin/charges/${charge.api_client_id}/${charge.id}/RecurringApplicationCharge/confirm_recurring_application_charge?signature=${charge.decorated_return_url?.split('signature=')[1] || ''}`;
      }
      return chargeData;
    });
    
    res.json({
      charges: chargesWithUrls,
      summary: {
        total: allCharges.length,
        active: allCharges.filter(c => c.status === 'active').length,
        pending: allCharges.filter(c => c.status === 'pending').length,
        cancelled: allCharges.filter(c => c.status === 'cancelled').length,
        declined: allCharges.filter(c => c.status === 'declined').length,
        expired: allCharges.filter(c => c.status === 'expired').length,
      },
    });
  } catch (error) {
    console.error('List charges error:', error);
    res.status(500).json({ error: 'Failed to list charges' });
  }
});

// Cancel pending charges (for debugging/cleanup)
router.post('/cancel-pending', authenticateShop, async (req, res) => {
  try {
    // Use access token from middleware (already decrypted)
    const accessToken = req.accessToken;
    
    if (!accessToken) {
      return res.status(500).json({ error: 'Access token not available' });
    }
    
    const allCharges = await listAllCharges(req.shop.shopDomain, accessToken);
    const pendingCharges = allCharges.filter(c => c.status === 'pending');
    
    const results = [];
    for (const pendingCharge of pendingCharges) {
      const cancelled = await cancelCharge(req.shop.shopDomain, accessToken, pendingCharge.id.toString());
      results.push({
        chargeId: pendingCharge.id.toString(),
        name: pendingCharge.name,
        cancelled,
      });
    }
    
    res.json({
      message: `Cancelled ${results.filter(r => r.cancelled).length} of ${results.length} pending charge(s)`,
      results,
    });
  } catch (error) {
    console.error('Cancel pending charges error:', error);
    res.status(500).json({ error: 'Failed to cancel pending charges' });
  }
});

// Manually activate a pending charge (fallback if approval button fails)
router.post('/activate-charge', authenticateShop, async (req, res) => {
  try {
    const { chargeId } = req.body;
    const accessToken = req.accessToken;
    const shopDomain = req.shop.shopDomain;
    
    if (!chargeId) {
      return res.status(400).json({ error: 'chargeId is required' });
    }
    
    if (!accessToken) {
      return res.status(500).json({ error: 'Access token not available' });
    }
    
    console.log(`\n=== Manually Activating Charge ===`);
    console.log('Charge ID:', chargeId);
    console.log('Shop Domain:', shopDomain);
    
    // Activate the charge via Shopify API
    const apiVersion = '2025-04';
    const activateUrl = `https://${shopDomain}/admin/api/${apiVersion}/recurring_application_charges/${chargeId}/activate.json`;
    
    const activateResponse = await fetch(activateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken.trim(),
      },
    });
    
    const responseText = await activateResponse.text();
    console.log('Activate response status:', activateResponse.status);
    console.log('Activate response:', responseText);
    
    if (!activateResponse.ok) {
      const errorData = responseText ? JSON.parse(responseText) : {};
      return res.status(activateResponse.status).json({
        error: 'Failed to activate charge',
        details: errorData,
      });
    }
    
    const result = JSON.parse(responseText);
    const activatedCharge = result.recurring_application_charge;
    
    // Update subscription status to ACTIVE
    if (req.shop.subscription) {
      await prisma.subscription.update({
        where: { shopId: req.shop.id },
        data: {
          status: 'ACTIVE',
          chargeId: chargeId.toString(),
        },
      });
      console.log('✅ Subscription updated to ACTIVE');
    }
    
    res.json({
      success: true,
      message: 'Charge activated successfully',
      charge: activatedCharge,
    });
  } catch (error) {
    console.error('Activate charge error:', error);
    res.status(500).json({ error: 'Failed to activate charge', details: error.message });
  }
});

// Cancel App Subscription (GraphQL) - for pending subscriptions that can't be cancelled in UI
router.post('/cancel-subscription', authenticateShop, async (req, res) => {
  try {
    const accessToken = req.accessToken;
    const shopDomain = req.shop.shopDomain;
    
    if (!accessToken) {
      return res.status(500).json({ error: 'Access token not available' });
    }
    
    // Get current subscription to find the subscription ID
    const subscription = await prisma.subscription.findUnique({
      where: { shopId: req.shop.id },
    });
    
    if (!subscription || !subscription.chargeId) {
      return res.status(404).json({ 
        error: 'No subscription found',
        message: 'No active or pending subscription to cancel',
      });
    }
    
    let subscriptionId = subscription.chargeId; // This might be numeric or Global ID format
    
    // Convert numeric ID to Global ID format if needed
    // Shopify GraphQL requires Global IDs in format: gid://shopify/AppSubscription/{numericId}
    if (subscriptionId && !subscriptionId.startsWith('gid://')) {
      // If it's just a number, convert to Global ID
      subscriptionId = `gid://shopify/AppSubscription/${subscriptionId}`;
      console.log('Converted numeric ID to Global ID format:', subscriptionId);
    }
    
    console.log(`\n=== Cancelling App Subscription ===`);
    console.log('Subscription ID:', subscriptionId);
    console.log('Shop Domain:', shopDomain);
    
    // Cancel via GraphQL App Subscriptions API
    const apiVersion = '2025-04';
    const graphqlUrl = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;
    
    const mutation = `
      mutation AppSubscriptionCancel($id: ID!) {
        appSubscriptionCancel(id: $id) {
          appSubscription {
            id
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    
    const variables = {
      id: subscriptionId,
    };
    
    const gqlResponse = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken.trim(),
      },
      body: JSON.stringify({ query: mutation, variables }),
    });
    
    const gqlText = await gqlResponse.text();
    console.log('Cancel subscription status:', gqlResponse.status);
    console.log('Cancel subscription response:', gqlText);
    
    if (!gqlResponse.ok) {
      return res.status(gqlResponse.status).json({
        error: 'Failed to cancel subscription',
        message: 'Shopify returned a non-200 response when cancelling the subscription.',
        status: gqlResponse.status,
        body: gqlText,
      });
    }
    
    let gqlJson;
    try {
      gqlJson = JSON.parse(gqlText);
    } catch (parseError) {
      console.error('Failed to parse GraphQL response as JSON:', parseError);
      return res.status(500).json({
        error: 'Failed to parse Shopify response',
        rawBody: gqlText,
      });
    }
    
    if (gqlJson.errors && gqlJson.errors.length > 0) {
      console.error('GraphQL top-level errors:', gqlJson.errors);
      return res.status(400).json({
        error: 'Failed to cancel subscription',
        graphqlErrors: gqlJson.errors,
      });
    }
    
    const result = gqlJson.data?.appSubscriptionCancel;
    if (!result) {
      return res.status(500).json({
        error: 'Invalid Shopify response',
        message: 'appSubscriptionCancel payload is missing.',
        raw: gqlJson,
      });
    }
    
    if (result.userErrors && result.userErrors.length > 0) {
      // Check if this is actually a RecurringApplicationCharge (old API)
      const isRecurringChargeError = result.userErrors.some(
        err => err.message && err.message.includes('RecurringApplicationCharge')
      );
      
      if (isRecurringChargeError) {
        console.log('⚠️ This appears to be a RecurringApplicationCharge (old API), trying RAC cancel method...');
        
        // Extract numeric ID from Global ID or use as-is
        const numericId = subscription.chargeId.replace(/^gid:\/\/shopify\/AppSubscription\//, '') || subscription.chargeId;
        
        // Try cancelling via old RAC API
        const apiVersion = '2025-04';
        const cancelUrl = `https://${shopDomain}/admin/api/${apiVersion}/recurring_application_charges/${numericId}.json`;
        
        const cancelResponse = await fetch(cancelUrl, {
          method: 'DELETE',
          headers: {
            'X-Shopify-Access-Token': accessToken.trim(),
          },
        });
        
        const cancelText = await cancelResponse.text();
        console.log('RAC cancel response status:', cancelResponse.status);
        console.log('RAC cancel response:', cancelText);
        
        if (cancelResponse.ok) {
          // Update subscription status in database
          await prisma.subscription.update({
            where: { shopId: req.shop.id },
            data: {
              status: 'CANCELLED',
            },
          });
          
          console.log('✅ RecurringApplicationCharge cancelled successfully');
          
          return res.json({
            success: true,
            message: 'RecurringApplicationCharge cancelled successfully (via old API)',
            method: 'recurring_application_charge',
          });
        } else {
          // If RAC cancel also fails, return the original error
          return res.status(400).json({
            error: 'Failed to cancel subscription',
            message: 'Tried both AppSubscription and RecurringApplicationCharge cancel methods, both failed.',
            appSubscriptionErrors: result.userErrors,
            racCancelStatus: cancelResponse.status,
            racCancelResponse: cancelText,
          });
        }
      }
      
      // If it's not a RAC error, return the AppSubscription error
      return res.status(400).json({
        error: 'Failed to cancel subscription',
        userErrors: result.userErrors,
      });
    }
    
    // Update subscription status in database
    await prisma.subscription.update({
      where: { shopId: req.shop.id },
      data: {
        status: 'CANCELLED',
      },
    });
    
    console.log('✅ Subscription cancelled successfully');
    
    res.json({
      success: true,
      message: 'Subscription cancelled successfully',
      subscription: result.appSubscription,
    });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: 'Failed to cancel subscription', details: error.message });
  }
});

// Delete subscription record from database (for pending charges that can't be cancelled via API)
router.delete('/subscription', authenticateShop, async (req, res) => {
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { shopId: req.shop.id },
    });
    
    if (!subscription) {
      return res.status(404).json({ 
        error: 'No subscription found',
        message: 'No subscription record to delete',
      });
    }
    
    console.log(`\n=== Deleting Subscription Record ===`);
    console.log('Shop ID:', req.shop.id);
    console.log('Subscription ID:', subscription.id);
    console.log('Charge ID:', subscription.chargeId);
    console.log('Status:', subscription.status);
    
    // Delete the subscription record
    await prisma.subscription.delete({
      where: { shopId: req.shop.id },
    });
    
    console.log('✅ Subscription record deleted from database');
    
    res.json({
      success: true,
      message: 'Subscription record deleted successfully. You can now create a new subscription.',
      note: 'The pending charge in Shopify will expire automatically. This only removed the record from our database.',
    });
  } catch (error) {
    console.error('Delete subscription error:', error);
    res.status(500).json({ error: 'Failed to delete subscription', details: error.message });
  }
});

export default router;

