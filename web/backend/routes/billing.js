import express from 'express';
import prisma from '../config/database.js';
import shopify from '../config/shopify.js';
import { decrypt } from '../utils/encryption.js';
import { authenticateShop, requirePlan } from '../middleware/auth.js';

const router = express.Router();

const PLAN_PRICES = {
  LIGHT: { amount: 19.99, name: 'Light Plan' },
  GROWTH: { amount: 49.99, name: 'Growth Plan' },
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
  // --- TEMPORARY PROMOTION (Delegated to handleCreateSubscription) ---
  return handleCreateSubscription(req, res);
});

// NEW: Create or update subscription using the App Subscriptions GraphQL API
// This avoids the legacy Recurring Application Charges endpoint that returns 403 for new apps
router.post('/create-subscription', authenticateShop, async (req, res) => {
  // --- TEMPORARY PROMOTION (Delegated to handleCreateSubscription) ---
  return handleCreateSubscription(req, res);
});

/**
 * Shared GraphQL-based subscription creation to apply promotional pricing:
 * - Light: 30-day trial (free first month)
 * - Growth: $48.99 discount for 1 month ($1 for the first month)
 * - Pro: $98.99 discount for 1 month ($1 for the first month)
 */
async function handleCreateSubscription(req, res) {
  try {
    const { plan } = req.body;

    if (!plan) {
      return res.status(400).json({ error: 'Plan is required' });
    }

    const planUpper = plan.toUpperCase();
    if (!PLAN_PRICES[planUpper]) {
      return res.status(400).json({
        error: 'Invalid plan',
        message: 'Please select a valid subscription plan (LIGHT, GROWTH, or PRO)',
        validPlans: Object.keys(PLAN_PRICES),
      });
    }

    const price = PLAN_PRICES[planUpper];
    const accessToken = req.accessToken;
    const shopDomain = req.shop.shopDomain;

    if (!accessToken) {
      console.error('❌ Access token not found in request');
      return res.status(500).json({ error: 'Access token not available' });
    }

    console.log('\n=== Creating App Subscription (GraphQL Promotion Bypass) ===');
    console.log('Shop Domain:', shopDomain);
    console.log('Plan:', planUpper);
    console.log('Price:', price);

    // Build return URL
    const baseUrl = process.env.FRONTEND_URL || process.env.SHOPIFY_APP_URL || 'http://localhost:3000';
    const host = req.query.host;
    const returnUrlParams = new URLSearchParams();
    returnUrlParams.set('shop', shopDomain);
    if (host) {
      returnUrlParams.set('host', host);
    }
    const returnUrl = `${baseUrl}/billing/confirm?${returnUrlParams.toString()}`;

    // Determine test store status
    let isTestStore = false;
    try {
      const domainLower = shopDomain.toLowerCase();
      if (domainLower.includes('-test') || domainLower.includes('.dev.') || domainLower.includes('devstore')) {
        isTestStore = true;
      }
      
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
        if (!isTestStore) {
          isTestStore =
            planName.includes('test') ||
            planName.includes('development') ||
            planName.includes('partner');
        }
      }
    } catch (error) {
      console.warn('⚠️ Failed to check shop type:', error.message);
    }
    
    if (!isTestStore && shopDomain.toLowerCase().includes('-test')) {
      isTestStore = true;
    }

    const apiVersion = '2025-04';
    const graphqlUrl = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

    // App Subscriptions GraphQL mutation supporting promotional discount
    const mutation = `
      mutation AppSubscriptionCreate(
        $name: String!,
        $returnUrl: URL!,
        $trialDays: Int,
        $test: Boolean,
        $price: Decimal!,
        $currencyCode: CurrencyCode!,
        $discount: AppSubscriptionDiscountInput
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
                interval: EVERY_30_DAYS,
                discount: $discount
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

    // Determine promotion setup
    let trialDays = null;
    let discount = null;

    if (planUpper === 'LIGHT') {
      trialDays = 30; // 30 days free trial
    } else if (planUpper === 'GROWTH') {
      discount = {
        durationMonths: 1,
        value: { amount: 48.99 } // $49.99 - $48.99 = $1.00 for the first month
      };
    } else if (planUpper === 'PRO') {
      discount = {
        durationMonths: 1,
        value: { amount: 98.99 } // $99.99 - $98.99 = $1.00 for the first month
      };
    }

    const variables = {
      name: price.name,
      returnUrl,
      trialDays,
      test: isTestStore || undefined,
      price: price.amount,
      currencyCode: 'USD',
      discount
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
    if (!gqlResponse.ok) {
      return res.status(gqlResponse.status).json({
        error: 'Failed to create subscription',
        message: 'Shopify returned a non-200 response when creating the subscription.',
        status: gqlResponse.status,
        body: gqlText,
      });
    }

    const gqlJson = JSON.parse(gqlText);
    if (gqlJson.errors && gqlJson.errors.length > 0) {
      console.error('GraphQL errors:', gqlJson.errors);
      return res.status(400).json({
        error: 'Failed to create subscription',
        graphqlErrors: gqlJson.errors,
      });
    }

    const result = gqlJson.data?.appSubscriptionCreate;
    if (result.userErrors && result.userErrors.length > 0) {
      console.error('User errors:', result.userErrors);
      return res.status(400).json({
        error: 'Failed to create subscription',
        userErrors: result.userErrors,
      });
    }

    const appSubscription = result.appSubscription;
    const subscriptionId = appSubscription.id;
    const subscriptionStatus = appSubscription.status || 'PENDING';
    const confirmationUrl = result.confirmationUrl;

    // Normalize plan name for database lookups
    const normalizedPlanName = plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase();
    const dbPlan = await prisma.pricingPlan.findUnique({
      where: { name: normalizedPlanName }
    });

    // Persist subscription in database
    const trialEndsAt =
      trialDays && trialDays > 0
        ? new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000)
        : null;

    try {
      const existing = await prisma.subscription.findUnique({
        where: { shopId: req.shop.id },
      });

      const data = {
        plan: planUpper,
        chargeId: subscriptionId,
        status: subscriptionStatus === 'ACTIVE' ? 'ACTIVE' : 'PENDING',
        trialEndsAt,
        pricingPlanId: dbPlan ? dbPlan.id : null,
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

    return res.json({
      confirmationUrl,
      subscriptionId,
      status: subscriptionStatus,
    });
  } catch (error) {
    console.error('Create subscription error:', error);
    return res.status(500).json({ error: 'Failed to create subscription' });
  }
}

/* --- ORIGINAL FLOWS STORED FOR BACKWARDS COMPATIBILITY / SIMPLE ROLLBACK ---
// Create or update subscription charge (legacy RAC endpoint)
function legacyCreateCharge(req, res) {
  // original REST endpoint logic was here...
}
// ---------------------------------------------------------------------------- */

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

