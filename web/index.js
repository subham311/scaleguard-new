// @ts-check
import { join } from "path";
import { readFileSync } from "fs";
import express from "express";
import serveStatic from "serve-static";

import shopify from "./shopify.js";
import productCreator from "./product-creator.js";
import PrivacyWebhookHandlers from "./privacy.js";

import prisma from './backend/config/database.js';
import { encrypt } from './backend/utils/encryption.js';

// --- Old Backend Imports ---
import authRoutes from './backend/routes/auth.js';
import billingRoutes from './backend/routes/billing.js';
import customWebhookRoutes from './backend/routes/webhooks.js';
import apiRoutes from './backend/routes/api.js';
import jobRoutes from './backend/routes/jobs.js';
import healthRoutes from './backend/routes/health.js';
import diagnosticsRoutes from './backend/routes/diagnostics.js';
import { startCronWorker } from './backend/jobs/cronWorker.js';
import { seedPricingPlans } from './backend/jobs/seedPricingPlans.js';
import { errorHandler, notFoundHandler } from './backend/middleware/errorHandler.js';
import { processDataSync } from './backend/jobs/processors/dataSync.js';
import { processAuditRun } from './backend/jobs/processors/auditEngine.js';
// ----------------------------

const PORT = parseInt(
  process.env.BACKEND_PORT || process.env.PORT || "3000",
  10
);

const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

const app = express();

// Set up Shopify authentication and webhook handling
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  async (req, res, next) => {
    // Sync session to Prisma for custom backend routes
    try {
      const session = res.locals.shopify.session;
      console.log(`[OAuth Sync] Callback hit for shop: ${session?.shop}`);
      if (session) {
        console.log(`[OAuth Sync] Session keys: ${Object.keys(session).join(', ')}`);
        if (session.accessToken) {
          console.log(`[OAuth Sync] Access token exists. Syncing shop ${session.shop} to Prisma...`);
          await prisma.shop.upsert({
            where: { shopDomain: session.shop },
            create: {
              shopDomain: session.shop,
              accessToken: encrypt(session.accessToken),
              scope: session.scope || '',
              isActive: true,
            },
            update: {
              accessToken: encrypt(session.accessToken),
              scope: session.scope || '',
              isActive: true,
              uninstalledAt: null,
            }
          });
          console.log(`✅ [OAuth Sync] Shop ${session.shop} synced to Prisma successfully.`);
          
          // Trigger immediate data sync and audit for new installation
          try {
            const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
            if (shopRecord) {
              console.log(`🚀 Triggering immediate initial sync for ${session.shop}`);
              // Run asynchronously without blocking the OAuth response
              processDataSync({ shopId: shopRecord.id })
                .then(() => processAuditRun({ shopId: shopRecord.id }))
                .catch(err => console.error(`❌ Immediate sync failed for ${session.shop}:`, err));
            }
          } catch (syncErr) {
            console.error(`❌ Error starting immediate sync:`, syncErr);
          }
        } else {
          console.warn(`⚠️ [OAuth Sync] Session missing accessToken! Cannot sync to Prisma.`);
        }
      } else {
        console.warn(`⚠️ [OAuth Sync] Session object is missing entirely!`);
      }
    } catch (error) {
      console.error('❌ Failed to sync session to Prisma:', error);
    }
    next();
  },
  shopify.redirectToShopifyOrAppRoot()
);
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers: PrivacyWebhookHandlers })
);

// If you are adding routes outside of the /api path, remember to
// also add a proxy rule for them in web/frontend/vite.config.js

app.use("/api", shopify.validateAuthenticatedSession());

app.use(express.json());

app.get("/api/products/count", async (_req, res) => {
  const client = new shopify.api.clients.Graphql({
    session: res.locals.shopify.session,
  });

  const countData = await client.request(`
    query shopifyProductCount {
      productsCount {
        count
      }
    }
  `);

  res.status(200).send({ count: countData.data.productsCount.count });
});

app.post("/api/products", async (_req, res) => {
  let status = 200;
  let error = null;

  try {
    await productCreator(res.locals.shopify.session);
  } catch (e) {
    console.log(`Failed to process products/create: ${e.message}`);
    status = 500;
    error = e.message;
  }
  res.status(status).send({ success: status === 200, error });
});

// --- Old Backend Routes Mount ---
app.use('/v1/health', healthRoutes);
app.use('/v1/auth', authRoutes);
app.use('/v1/billing', billingRoutes);
app.use('/v1/webhooks', customWebhookRoutes);
app.use('/v1/api', apiRoutes);
app.use('/v1/jobs', jobRoutes);
app.use('/v1/diagnostics', diagnosticsRoutes);
// Error handlers for custom endpoints
// Error handlers for custom endpoints
app.use('/v1', notFoundHandler);
app.use('/v1', errorHandler);
// --------------------------------

app.use(shopify.cspHeaders());
app.use(serveStatic(STATIC_PATH, { index: false }));

app.use(shopify.ensureInstalledOnShop(), async (_req, res, _next) => {
  return res
    .status(200)
    .set("Content-Type", "text/html")
    .send(
      readFileSync(join(STATIC_PATH, "index.html"))
        .toString()
        .replace("%VITE_SHOPIFY_API_KEY%", process.env.SHOPIFY_API_KEY || "")
    );
});

app.listen(PORT, () => {
  console.log(`> Ready on http://localhost:${PORT}`);
  // Start database-backed cron worker
  try {
    startCronWorker();
    seedPricingPlans();
  } catch (error) {
    console.warn('⚠️  Failed to start background jobs:', error.message);
  }
});
