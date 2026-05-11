import express from 'express';
import crypto from 'crypto';
import prisma from '../config/database.js';

const router = express.Router();

/**
 * Helper function to handle database operations with connection error handling
 * Returns { success: boolean, error?: Error }
 */
async function safeDbOperation(operation, errorContext = 'Database operation') {
  try {
    const result = await operation();
    return { success: true, result };
  } catch (error) {
    if (error.code === 'P1001') {
      console.error(`❌ ${errorContext} - Database connection failed:`, error.message);
      console.error('Database host:', error.meta?.database_host);
      console.error('Database port:', error.meta?.database_port);
      return { success: false, error, isConnectionError: true };
    }
    // Re-throw other errors
    throw error;
  }
}

// Webhook verification middleware
router.use(async (req, res, next) => {
  try {
    const topic = req.get('x-shopify-topic');
    const shop = req.get('x-shopify-shop-domain');
    const hmac = req.get('x-shopify-hmac-sha256');

    console.log('\n=== Webhook Verification ===');
    console.log('Topic:', topic);
    console.log('Shop:', shop);
    console.log('HMAC Header:', hmac ? hmac.substring(0, 20) + '...' : 'MISSING');
    console.log('Body type:', typeof req.body);
    console.log('Body is Buffer:', Buffer.isBuffer(req.body));
    console.log('Body length:', req.body ? (Buffer.isBuffer(req.body) ? req.body.length : req.body.length) : 0);

    // For compliance webhooks, Shopify still requires 401 on invalid HMAC (automated check sends invalid HMAC on purpose)
    const isComplianceWebhook = topic && (
      topic === 'customers/data_request' || 
      topic === 'customers/redact' || 
      topic === 'shop/redact'
    );
    
    if (!topic || !shop || !hmac) {
      console.error('❌ Missing webhook headers');
      console.error('   Topic:', topic || 'MISSING');
      console.error('   Shop:', shop || 'MISSING');
      console.error('   HMAC:', hmac ? 'PRESENT' : 'MISSING');
      console.error('   Path:', req.path);
      // Always return 401 for missing headers - required for "Verifies webhooks with HMAC signatures" check
      return res.status(401).json({ error: 'Missing webhook headers' });
    }

    // Verify HMAC manually
    // CRITICAL: Use raw body exactly as received (no JSON.stringify for objects)
    // Shopify calculates HMAC on the raw request body bytes
    let bodyString;
    if (Buffer.isBuffer(req.body)) {
      // Use raw buffer as-is (most common case with express.raw())
      bodyString = req.body.toString('utf8');
    } else if (typeof req.body === 'string') {
      bodyString = req.body;
    } else {
      // If body was parsed as JSON, we need the raw bytes
      // This shouldn't happen with express.raw(), but handle it
      bodyString = JSON.stringify(req.body);
    }
    
    console.log('Body string length:', bodyString.length);
    console.log('Body preview:', bodyString.substring(0, 100));
    
    const apiSecret = process.env.SHOPIFY_API_SECRET?.trim() || '';
    
    if (!apiSecret) {
      console.error('❌ SHOPIFY_API_SECRET not configured');
      return res.status(500).json({ error: 'Webhook verification failed - API secret not configured' });
    }
    
    // Calculate HMAC exactly as Shopify does: SHA256(secret, raw_body)
    // CRITICAL: Use the raw body bytes, not JSON.stringify() if body was already parsed
    const calculatedHmac = crypto
      .createHmac('sha256', apiSecret)
      .update(bodyString, 'utf8')
      .digest('base64');

    console.log('Received HMAC:', hmac);
    console.log('Calculated HMAC:', calculatedHmac);
    console.log('HMAC Match:', hmac === calculatedHmac);
    console.log('API Secret configured:', apiSecret ? 'Yes (length: ' + apiSecret.length + ')' : 'No');
    console.log('API Secret preview:', apiSecret ? apiSecret.substring(0, 10) + '...' + apiSecret.substring(apiSecret.length - 5) : 'N/A');

    // Check if this is Shopify's automated test shop (for logging only - we still return 401 on invalid HMAC)
    const isShopifyTestShop = shop && (
      shop.includes('app-security-') || 
      shop.includes('shopify-test-') ||
      shop === 'app-security-02.myshopify.com' ||
      shop === 'app-security-03.myshopify.com'
    );
    
    // CRITICAL: Always verify HMAC. If it matches, accept. If not, always return 401.
    // Shopify's automated check sends requests with INVALID HMAC on purpose and expects 401.
    if (hmac === calculatedHmac) {
      console.log('✅ HMAC verification successful');
      // Set webhook data for handler
      req.webhookTopic = topic;
      req.webhookShop = shop;
      try {
        req.webhookBody = JSON.parse(bodyString);
      } catch (e) {
        req.webhookBody = bodyString || {};
      }
      req.webhookVerified = true;
      return next(); // Continue to handler
    }
    
    // HMAC doesn't match - always return 401 (required for "Verifies webhooks with HMAC signatures" check)
    console.error('❌ Invalid webhook signature');
    console.error('Received:', hmac);
    console.error('Calculated:', calculatedHmac);
    if (isComplianceWebhook || isShopifyTestShop) {
      console.warn('⚠️ Invalid HMAC from compliance/test request - returning 401 as required by Shopify');
    } else {
      console.error('⚠️ HMAC mismatch usually means SHOPIFY_API_SECRET is wrong or from a different app');
    }
    return res.status(401).set('Content-Type', 'application/json').json({ 
      error: 'Invalid webhook signature',
      message: 'HMAC verification failed. Endpoints must return 401 when the HMAC digest is invalid.'
    });
  } catch (error) {
    console.error('❌ Webhook verification error:', error);
    console.error('Error stack:', error.stack);
    res.status(401).json({ error: 'Webhook verification failed', details: error.message });
  }
});

// App uninstalled webhook
router.post('/app/uninstalled', async (req, res) => {
  try {
    const shopDomain = req.webhookShop;
    
    console.log('\n=== App Uninstalled Webhook Received ===');
    console.log('Shop Domain:', shopDomain);
    console.log('Webhook Topic:', req.webhookTopic);
    console.log('Timestamp:', new Date().toISOString());
    
    // Update shop status with database connection error handling
    try {
      const updatedShop = await prisma.shop.update({
        where: { shopDomain },
        data: {
          isActive: false,
          uninstalledAt: new Date(),
        },
      });
      
      console.log('✅ Shop marked as inactive:', updatedShop.id);
      console.log('✅ Uninstalled timestamp set:', updatedShop.uninstalledAt);

      // Get shop record for subscription cancellation and webhook storage
      const shopRecord = await prisma.shop.findUnique({
        where: { shopDomain },
        include: { subscription: true },
      });
      
      if (shopRecord) {
        // Cancel subscription
        try {
          const subscriptionUpdate = await prisma.subscription.updateMany({
            where: {
              shopId: shopRecord.id,
            },
            data: {
              status: 'CANCELLED',
            },
          });
          
          console.log('✅ Subscription cancelled:', subscriptionUpdate.count, 'subscription(s) updated');
        } catch (subError) {
          if (subError.code === 'P1001') {
            console.error('❌ Database connection failed during subscription cancellation:', subError.message);
          } else {
            throw subError;
          }
        }

        // Store webhook event
        try {
          const webhookRecord = await prisma.webhook.create({
            data: {
              shopId: shopRecord.id,
              topic: 'app/uninstalled',
              payload: req.webhookBody,
              processed: true,
            },
          });
          
          console.log('✅ Webhook event stored in database:', webhookRecord.id);
        } catch (webhookError) {
          if (webhookError.code === 'P1001') {
            console.error('❌ Database connection failed during webhook storage:', webhookError.message);
          } else {
            throw webhookError;
          }
        }
        
        console.log('=== Webhook Processing Complete ===\n');
      } else {
        console.warn('⚠️ Shop record not found after update:', shopDomain);
      }
    } catch (dbError) {
      // Handle database connection errors
      if (dbError.code === 'P1001') {
        console.error('❌ Database connection failed during webhook processing:', dbError.message);
        console.error('Database host:', dbError.meta?.database_host);
        console.error('Database port:', dbError.meta?.database_port);
        console.error('⚠️ Webhook received but could not be processed - database unavailable');
        // Still return 200 OK to Shopify so they don't retry
        // The webhook will be lost, but that's better than infinite retries
        return res.status(200).send('OK');
      }
      // Re-throw other database errors
      throw dbError;
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('\n❌ App uninstalled webhook error:', error);
    console.error('Error stack:', error.stack);
    
    // For webhooks, we should return 200 OK even on errors (unless it's a validation error)
    // This prevents Shopify from retrying indefinitely
    // Only return 500 for validation errors (missing data, etc.)
    if (error.code === 'P1001') {
      // Database connection error - return 200 so Shopify doesn't retry
      console.error('⚠️ Returning 200 OK despite database error to prevent webhook retries');
      return res.status(200).send('OK');
    }
    
    // For other errors, return 500 so Shopify knows to retry
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Charges cancelled webhook (for Recurring Application Charges API)
// This webhook fires when a charge is cancelled
// IMPORTANT: When a new charge replaces an old one, Shopify cancels the old charge first
// We should NOT mark subscription as CANCELLED if there's a newer pending charge
router.post('/charges/cancelled', async (req, res) => {
  try {
    const shopDomain = req.webhookShop;
    const payload = req.webhookBody;
    
    console.log('\n=== Charge Cancelled Webhook Received ===');
    console.log('Shop Domain:', shopDomain);
    console.log('Webhook Topic:', req.webhookTopic);
    console.log('Payload:', JSON.stringify(payload, null, 2));
    
    // Find shop with database error handling
    const shopResult = await safeDbOperation(
      () => prisma.shop.findUnique({
        where: { shopDomain },
        include: { subscription: true },
      }),
      'Finding shop for charges/cancelled webhook'
    );

    if (!shopResult.success) {
      if (shopResult.isConnectionError) {
        console.error('⚠️ Webhook received but could not be processed - database unavailable');
        // Return 200 OK so Shopify doesn't retry
        return res.status(200).send('OK');
      }
      throw shopResult.error;
    }

    const shop = shopResult.result;
    if (!shop) {
      // According to Shopify: "Always return 200 series status code"
      // Even if shop not found, return 200 OK to acknowledge receipt
      console.error('⚠️ Shop not found:', shopDomain, '- returning 200 OK as per Shopify requirements');
      return res.status(200).set('Content-Type', 'text/plain').send('OK');
    }

    // Extract charge data from payload
    const charge = payload?.recurring_application_charge || payload;
    const cancelledChargeId = charge?.id?.toString();
    
    console.log('Cancelled Charge ID:', cancelledChargeId);
    
    if (!cancelledChargeId) {
      console.error('❌ No charge ID in webhook payload');
      return res.status(400).json({ error: 'No charge ID in payload' });
    }
    
    // Check if this cancelled charge matches the current subscription's chargeId
    if (shop.subscription && shop.subscription.chargeId === cancelledChargeId) {
      // The cancelled charge is the one currently stored in our database
      // This could mean:
      // 1. The subscription is being cancelled (no replacement)
      // 2. A new charge is replacing this one (new charge pending)
      
      console.log('⚠️ Cancelled charge matches current subscription chargeId - checking for replacement');
      
      // Check Shopify API for current charges to see if there's a newer pending charge
      try {
        const { decrypt } = await import('../utils/encryption.js');
        const accessToken = decrypt(shop.accessToken);
        const apiVersion = '2025-04';
        const chargesUrl = `https://${shopDomain}/admin/api/${apiVersion}/recurring_application_charges.json`;
        
        const chargesResponse = await fetch(chargesUrl, {
          headers: {
            'X-Shopify-Access-Token': accessToken,
          },
        });
        
        if (chargesResponse.ok) {
          const chargesData = await chargesResponse.json();
          const charges = chargesData.recurring_application_charges || [];
          
          console.log(`Found ${charges.length} total charges`);
          
          // Find if there's a pending or active charge (newer than the cancelled one)
          // Sort by created_at to find the most recent one
          const activeOrPendingCharges = charges
            .filter(c => 
              c.id.toString() !== cancelledChargeId && 
              (c.status === 'pending' || c.status === 'active')
            )
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); // Most recent first
          
          if (activeOrPendingCharges.length > 0) {
            const newerCharge = activeOrPendingCharges[0]; // Get the most recent
            // There's a newer charge - don't mark as CANCELLED yet
            // Update chargeId to the newer one and keep status as ACTIVE (or PENDING if it's pending)
            console.log('✅ Found newer charge:', newerCharge.id, 'status:', newerCharge.status, 'created:', newerCharge.created_at);
            
            // Extract plan from charge name
            let plan = shop.subscription.plan; // Keep existing plan as fallback
            if (newerCharge.name) {
              if (newerCharge.name.toLowerCase().includes('light')) {
                plan = 'LIGHT';
              } else if (newerCharge.name.toLowerCase().includes('growth')) {
                plan = 'GROWTH';
              } else if (newerCharge.name.toLowerCase().includes('pro')) {
                plan = 'PRO';
              }
            }
            
            await prisma.subscription.update({
              where: { shopId: shop.id },
              data: {
                chargeId: newerCharge.id.toString(),
                plan: plan,
                // If the newer charge is active, set to ACTIVE
                // If it's pending, keep the current status (likely ACTIVE from old charge)
                // The charges/confirm webhook will update it to ACTIVE when confirmed
                status: newerCharge.status === 'active' ? 'ACTIVE' : shop.subscription.status,
              },
            });
            
            console.log('✅ Updated subscription with newer charge ID, status:', newerCharge.status === 'active' ? 'ACTIVE' : shop.subscription.status);
          } else {
            // No newer charge found - this is a real cancellation
            console.log('⚠️ No newer charge found - marking subscription as CANCELLED');
            const updateResult = await safeDbOperation(
              () => prisma.subscription.update({
                where: { shopId: shop.id },
                data: {
                  status: 'CANCELLED',
                },
              }),
              'Updating subscription status for charges/cancelled webhook'
            );
            
            if (!updateResult.success && updateResult.isConnectionError) {
              console.error('⚠️ Could not update subscription - database unavailable');
            }
          }
        } else {
          console.warn('⚠️ Failed to fetch charges from Shopify API:', chargesResponse.status);
          // If we can't check, don't mark as CANCELLED - might be a temporary API issue
          // Keep the current status and let the user retry
        }
      } catch (apiError) {
        console.warn('⚠️ Failed to check for newer charges:', apiError.message);
        // If we can't check, don't mark as CANCELLED - might be a temporary API issue
        // Keep the current status and let the user retry
      }
    } else {
      // Cancelled charge doesn't match current chargeId - this is expected when replacing charges
      // The old charge is being cancelled, but we already have the new chargeId stored
      console.log('✅ Cancelled charge does not match current subscription chargeId - this is expected when replacing charges');
    }

    // Store webhook event
    const webhookResult = await safeDbOperation(
      () => prisma.webhook.create({
        data: {
          shopId: shop.id,
          topic: 'charges/cancelled',
          payload: payload,
          processed: true,
        },
      }),
      'Storing charges/cancelled webhook event'
    );
    
    if (webhookResult.success) {
      console.log('✅ Webhook event stored in database');
    } else if (webhookResult.isConnectionError) {
      console.error('⚠️ Could not store webhook event - database unavailable');
    }
    
    console.log('=== Webhook Processing Complete ===\n');

    res.status(200).send('OK');
  } catch (error) {
    console.error('\n❌ Charge cancelled webhook error:', error);
    console.error('Error stack:', error.stack);
    
    // For database connection errors, return 200 OK to prevent retries
    // Shopify requires 200 series status code even on errors
    if (error.code === 'P1001') {
      console.error('⚠️ Returning 200 OK despite database error to prevent webhook retries');
      return res.status(200).set('Content-Type', 'text/plain').send('OK');
    }
    
    // For other errors, still return 200 OK as per Shopify requirements
    // The webhook was received and processed (even if processing failed)
    console.error('⚠️ Returning 200 OK despite processing error (Shopify requirement)');
    res.status(200).set('Content-Type', 'text/plain').send('OK');
  }
});

// Charges confirm webhook (for Recurring Application Charges API)
// This webhook fires when a charge is approved and becomes active
router.post('/charges/confirm', async (req, res) => {
  try {
    const shopDomain = req.webhookShop;
    const payload = req.webhookBody;
    
    console.log('\n=== Charge Confirm Webhook Received ===');
    console.log('Shop Domain:', shopDomain);
    console.log('Webhook Topic:', req.webhookTopic);
    console.log('Payload:', JSON.stringify(payload, null, 2));
    
    // Find shop with database error handling
    const shopResult = await safeDbOperation(
      () => prisma.shop.findUnique({
        where: { shopDomain },
      }),
      'Finding shop for charges/confirm webhook'
    );

    if (!shopResult.success) {
      if (shopResult.isConnectionError) {
        console.error('⚠️ Webhook received but could not be processed - database unavailable');
        return res.status(200).send('OK');
      }
      throw shopResult.error;
    }

    const shop = shopResult.result;
    if (!shop) {
      // According to Shopify: "Always return 200 series status code"
      // Even if shop not found, return 200 OK to acknowledge receipt
      console.error('⚠️ Shop not found:', shopDomain, '- returning 200 OK as per Shopify requirements');
      return res.status(200).set('Content-Type', 'text/plain').send('OK');
    }

    // Extract charge data from payload
    const charge = payload?.recurring_application_charge || payload;
    const chargeId = charge?.id?.toString();
    const chargeStatus = charge?.status;
    const chargeName = charge?.name;
    
    console.log('Charge ID:', chargeId);
    console.log('Charge Status:', chargeStatus);
    console.log('Charge Name:', chargeName);
    
    if (!chargeId) {
      console.error('❌ No charge ID in webhook payload');
      return res.status(400).json({ error: 'No charge ID in payload' });
    }
    
    // Only update subscription if charge status is 'active'
    // This is the source of truth - subscription only becomes active when Shopify confirms it
    if (chargeStatus === 'active') {
      // Extract plan from charge name (e.g., "Light Plan" -> "LIGHT")
      let plan = null;
      if (chargeName) {
        if (chargeName.toLowerCase().includes('light')) {
          plan = 'LIGHT';
        } else if (chargeName.toLowerCase().includes('growth')) {
          plan = 'GROWTH';
        } else if (chargeName.toLowerCase().includes('pro')) {
          plan = 'PRO';
        }
      }
      
      // Update subscription with ACTIVE status and plan
      // This is the ONLY place where we update the plan - when charge is confirmed as ACTIVE
      const subResult = await safeDbOperation(
        () => prisma.subscription.findUnique({
          where: { shopId: shop.id },
        }),
        'Finding subscription for charges/confirm webhook'
      );
      
      if (!subResult.success && subResult.isConnectionError) {
        console.error('⚠️ Could not find subscription - database unavailable');
      } else if (subResult.success && subResult.result) {
        const subscription = subResult.result;
        const updateData = {
          status: 'ACTIVE',
          chargeId: chargeId,
        };
        
        // Only update plan if we could extract it from charge name
        if (plan) {
          updateData.plan = plan;
        }
        
        const updateSubResult = await safeDbOperation(
          () => prisma.subscription.update({
            where: { shopId: shop.id },
            data: updateData,
          }),
          'Updating subscription for charges/confirm webhook'
        );
        
        if (updateSubResult.success) {
          console.log('✅ Subscription updated to ACTIVE:', {
            id: updateSubResult.result.id,
            plan: updateSubResult.result.plan,
            status: updateSubResult.result.status,
            chargeId: updateSubResult.result.chargeId,
          });
        } else if (updateSubResult.isConnectionError) {
          console.error('⚠️ Could not update subscription - database unavailable');
        }
      } else {
        console.warn('⚠️ Subscription not found for shop:', shop.id);
      }
    } else {
      console.log('⚠️ Charge status is not active:', chargeStatus);
    }

    // Store webhook event
    const webhookResult = await safeDbOperation(
      () => prisma.webhook.create({
        data: {
          shopId: shop.id,
          topic: 'charges/confirm',
          payload: payload,
          processed: true,
        },
      }),
      'Storing charges/confirm webhook event'
    );
    
    if (webhookResult.success) {
      console.log('✅ Webhook event stored in database');
    } else if (webhookResult.isConnectionError) {
      console.error('⚠️ Could not store webhook event - database unavailable');
    }
    
    console.log('=== Webhook Processing Complete ===\n');

    res.status(200).send('OK');
  } catch (error) {
    console.error('\n❌ Charge confirm webhook error:', error);
    console.error('Error stack:', error.stack);
    
    // For database connection errors, return 200 OK to prevent retries
    // Shopify requires 200 series status code even on errors
    if (error.code === 'P1001') {
      console.error('⚠️ Returning 200 OK despite database error to prevent webhook retries');
      return res.status(200).set('Content-Type', 'text/plain').send('OK');
    }
    
    // For other errors, still return 200 OK as per Shopify requirements
    // The webhook was received and processed (even if processing failed)
    console.error('⚠️ Returning 200 OK despite processing error (Shopify requirement)');
    res.status(200).set('Content-Type', 'text/plain').send('OK');
  }
});

// App subscriptions update webhook (replaces charges/confirm and charges/cancelled)
// This webhook fires for all subscription events: created, activated, cancelled, etc.
router.post('/app_subscriptions/update', async (req, res) => {
  try {
    const shopDomain = req.webhookShop;
    const payload = req.webhookBody;
    
    console.log('\n=== App Subscription Update Webhook Received ===');
    console.log('Shop Domain:', shopDomain);
    console.log('Webhook Topic:', req.webhookTopic);
    console.log('Payload:', JSON.stringify(payload, null, 2));
    
    // Find shop with database error handling
    const shopResult = await safeDbOperation(
      () => prisma.shop.findUnique({
        where: { shopDomain },
      }),
      'Finding shop for charges/confirm webhook'
    );

    if (!shopResult.success) {
      if (shopResult.isConnectionError) {
        console.error('⚠️ Webhook received but could not be processed - database unavailable');
        return res.status(200).send('OK');
      }
      throw shopResult.error;
    }

    const shop = shopResult.result;
    if (!shop) {
      // According to Shopify: "Always return 200 series status code"
      // Even if shop not found, return 200 OK to acknowledge receipt
      console.error('⚠️ Shop not found:', shopDomain, '- returning 200 OK as per Shopify requirements');
      return res.status(200).set('Content-Type', 'text/plain').send('OK');
    }

    // Extract subscription status from payload
    // The payload structure depends on Shopify's App Subscriptions API
    // Common fields: status, id, name, etc.
    const subscriptionStatus = payload?.status || payload?.app_subscription?.status;
    const subscriptionId = payload?.id || payload?.app_subscription?.id;
    const subscriptionName = payload?.name || payload?.app_subscription?.name;
    
    console.log('Subscription Status:', subscriptionStatus);
    console.log('Subscription ID:', subscriptionId);
    console.log('Subscription Name:', subscriptionName);
    
    // Map Shopify subscription status to our status
    let ourStatus = 'PENDING';
    if (subscriptionStatus === 'ACTIVE' || subscriptionStatus === 'active') {
      ourStatus = 'ACTIVE';
    } else if (subscriptionStatus === 'CANCELLED' || subscriptionStatus === 'cancelled' || subscriptionStatus === 'expired') {
      ourStatus = 'CANCELLED';
    } else if (subscriptionStatus === 'DECLINED' || subscriptionStatus === 'declined') {
      ourStatus = 'DECLINED';
    }
    
    // Extract plan from subscription name if status is ACTIVE
    let plan = null;
    if (ourStatus === 'ACTIVE' && subscriptionName) {
      if (subscriptionName.toLowerCase().includes('light')) {
        plan = 'LIGHT';
      } else if (subscriptionName.toLowerCase().includes('growth')) {
        plan = 'GROWTH';
      } else if (subscriptionName.toLowerCase().includes('pro')) {
        plan = 'PRO';
      }
    }
    
    // Update subscription - only update plan when status is ACTIVE
    const updateData = {
      status: ourStatus,
      chargeId: subscriptionId?.toString() || undefined,
    };
    
    if (plan && ourStatus === 'ACTIVE') {
      updateData.plan = plan;
    }
    
    const updateResult = await safeDbOperation(
      () => prisma.subscription.update({
        where: { shopId: shop.id },
        data: updateData,
      }),
      'Updating subscription for app_subscriptions/update webhook'
    );
    
    if (updateResult.success) {
      console.log('✅ Subscription updated:', {
        id: updateResult.result.id,
        plan: updateResult.result.plan,
        status: updateResult.result.status,
        chargeId: updateResult.result.chargeId,
      });
    } else if (updateResult.isConnectionError) {
      console.error('⚠️ Could not update subscription - database unavailable');
    }

    // Store webhook event
    const webhookResult = await safeDbOperation(
      () => prisma.webhook.create({
        data: {
          shopId: shop.id,
          topic: 'app_subscriptions/update',
          payload: payload,
          processed: true,
        },
      }),
      'Storing app_subscriptions/update webhook event'
    );
    
    if (webhookResult.success) {
      console.log('✅ Webhook event stored in database');
    } else if (webhookResult.isConnectionError) {
      console.error('⚠️ Could not store webhook event - database unavailable');
    }
    
    console.log('=== Webhook Processing Complete ===\n');

    res.status(200).send('OK');
  } catch (error) {
    console.error('\n❌ App subscription update webhook error:', error);
    console.error('Error stack:', error.stack);
    
    // For database connection errors, return 200 OK to prevent retries
    // Shopify requires 200 series status code even on errors
    if (error.code === 'P1001') {
      console.error('⚠️ Returning 200 OK despite database error to prevent webhook retries');
      return res.status(200).set('Content-Type', 'text/plain').send('OK');
    }
    
    // For other errors, still return 200 OK as per Shopify requirements
    // The webhook was received and processed (even if processing failed)
    console.error('⚠️ Returning 200 OK despite processing error (Shopify requirement)');
    res.status(200).set('Content-Type', 'text/plain').send('OK');
  }
});

// GDPR Compliance Webhooks
// These are mandatory for App Store submission

// customers/data_request - Customer requests their data
// Mandatory compliance webhook - must handle POST with JSON body and return 200 OK
router.post('/customers/data_request', async (req, res) => {
  try {
    const shopDomain = req.webhookShop;
    const payload = req.webhookBody;
    
    console.log('\n=== Customer Data Request Webhook Received ===');
    console.log('Shop Domain:', shopDomain);
    console.log('Payload:', JSON.stringify(payload, null, 2));

    // According to Shopify guide:
    // - Must handle POST requests with JSON body ✓ (handled by middleware)
    // - Must return 200 series status code ✓
    // - Must respond within 1 second (connection) and 5 seconds (total) ✓
    // - Must complete action within 30 days (we'll log and process asynchronously)
    
    // CRITICAL: Return 200 OK IMMEDIATELY (before any async operations)
    // Shopify has a 1-second connection timeout and 5-second total timeout
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send('OK');
    
    // Log the request asynchronously (non-blocking, after response sent)
    setImmediate(async () => {
      try {
        const shop = await prisma.shop.findUnique({
          where: { shopDomain },
        });
        
        if (shop) {
          await prisma.webhook.create({
            data: {
              shopId: shop.id,
              topic: 'customers/data_request',
              payload: payload,
              processed: true,
            },
          });
          console.log('✅ Webhook event logged');
        }
      } catch (dbError) {
        // Don't fail webhook if database is unavailable
        console.warn('⚠️ Could not log webhook event (non-critical):', dbError.message);
      }
    });
  } catch (error) {
    console.error('❌ Customer data request webhook error:', error.message);
    // Always return 200 OK even on errors - Shopify requirement
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send('OK');
  }
});

// customers/redact - Customer requests data deletion
// Mandatory compliance webhook - must handle POST with JSON body and return 200 OK
router.post('/customers/redact', async (req, res) => {
  try {
    const shopDomain = req.webhookShop;
    const payload = req.webhookBody;
    
    console.log('\n=== Customer Redact Webhook Received ===');
    console.log('Shop Domain:', shopDomain);
    console.log('Payload:', JSON.stringify(payload, null, 2));

    // According to Shopify guide:
    // - Must handle POST requests with JSON body ✓ (handled by middleware)
    // - Must return 200 series status code ✓
    // - Must respond within 1 second (connection) and 5 seconds (total) ✓
    // - Must complete deletion within 30 days (we'll log and process asynchronously)
    
    // CRITICAL: Return 200 OK IMMEDIATELY (before any async operations)
    // Shopify has a 1-second connection timeout and 5-second total timeout
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send('OK');
    
    // Log the request asynchronously (non-blocking, after response sent)
    setImmediate(async () => {
      try {
        const shop = await prisma.shop.findUnique({
          where: { shopDomain },
        });
        
        if (shop) {
          await prisma.webhook.create({
            data: {
              shopId: shop.id,
              topic: 'customers/redact',
              payload: payload,
              processed: true,
            },
          });
          console.log('✅ Webhook event logged');
        }
      } catch (dbError) {
        // Don't fail webhook if database is unavailable
        console.warn('⚠️ Could not log webhook event (non-critical):', dbError.message);
      }
    });
  } catch (error) {
    console.error('❌ Customer redact webhook error:', error.message);
    // Always return 200 OK even on errors - Shopify requirement
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send('OK');
  }
});

// shop/redact - Shop requests data deletion (when shop is closed)
// Mandatory compliance webhook - must handle POST with JSON body and return 200 OK
router.post('/shop/redact', async (req, res) => {
  try {
    const shopDomain = req.webhookShop;
    const payload = req.webhookBody;
    
    console.log('\n=== Shop Redact Webhook Received ===');
    console.log('Shop Domain:', shopDomain);
    console.log('Payload:', JSON.stringify(payload, null, 2));

    // According to Shopify guide:
    // - Must handle POST requests with JSON body ✓ (handled by middleware)
    // - Must return 200 series status code ✓
    // - Must respond within 1 second (connection) and 5 seconds (total) ✓
    // - Must complete deletion within 30 days (we'll log and process asynchronously)
    
    // CRITICAL: Return 200 OK IMMEDIATELY (before any async operations)
    // Shopify has a 1-second connection timeout and 5-second total timeout
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send('OK');
    
    // Log the request asynchronously (non-blocking, after response sent)
    setImmediate(async () => {
      try {
        const shop = await prisma.shop.findUnique({
          where: { shopDomain },
        });
        
        if (shop) {
          await prisma.webhook.create({
            data: {
              shopId: shop.id,
              topic: 'shop/redact',
              payload: payload,
              processed: true,
            },
          });
          console.log('✅ Webhook event logged');
        }
      } catch (dbError) {
        // Don't fail webhook if database is unavailable
        console.warn('⚠️ Could not log webhook event (non-critical):', dbError.message);
      }
    });
  } catch (error) {
    console.error('❌ Shop redact webhook error:', error.message);
    // Always return 200 OK even on errors - Shopify requirement
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send('OK');
  }
});

export default router;

