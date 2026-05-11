import '@shopify/shopify-api/adapters/node';
import { shopifyApi, LogSeverity } from '@shopify/shopify-api';
import dotenv from 'dotenv';

dotenv.config();

// Pin to a stable Admin API version to avoid "latest" deprecation noise in logs.
// Can be overridden per-environment.
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-04';

// Keep logs clean in production/review. Deprecation notices are logged at Warning level.
// You can override with SHOPIFY_LOG_LEVEL=debug|info|warning|error if needed.
const SHOPIFY_LOG_LEVEL = (process.env.SHOPIFY_LOG_LEVEL || '').toLowerCase();
const loggerLevel =
  SHOPIFY_LOG_LEVEL === 'debug'
    ? LogSeverity.Debug
    : SHOPIFY_LOG_LEVEL === 'info'
      ? LogSeverity.Info
      : SHOPIFY_LOG_LEVEL === 'warning'
        ? LogSeverity.Warning
        : LogSeverity.Error;

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: process.env.SHOPIFY_SCOPES?.split(',') || [],
  hostName: process.env.SHOPIFY_APP_URL?.replace(/https?:\/\//, '') || 'localhost:3000',
  apiVersion: SHOPIFY_API_VERSION,
  isEmbeddedApp: true,
  logger: {
    level: loggerLevel,
  },
});

export default shopify;

