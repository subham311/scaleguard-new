import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.js';
import billingRoutes from './routes/billing.js';
import webhookRoutes from './routes/webhooks.js';
import apiRoutes from './routes/api.js';
import jobRoutes from './routes/jobs.js';
import healthRoutes from './routes/health.js';
import diagnosticsRoutes from './routes/diagnostics.js';
import { startCronWorker } from './jobs/cronWorker.js';
import { startScheduler } from './jobs/scheduler.js';
import { seedPricingPlans } from './jobs/seedPricingPlans.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { setupGracefulShutdown } from './utils/gracefulShutdown.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy - CRITICAL for Railway/Railway deployments behind reverse proxy
// This fixes rate limiting X-Forwarded-For header warnings
app.set('trust proxy', true);

// Security middleware - configure to allow redirects
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false, // Disable CSP for API (frontend handles it)
}));

// CORS configuration - allow both localhost and ngrok URLs
const allowedOrigins = [
  'http://localhost:3000',
  process.env.FRONTEND_URL,
].filter(Boolean);

const isProduction = process.env.NODE_ENV === 'production';

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Check if origin is in allowed list
    if (allowedOrigins.some(allowed => origin.startsWith(allowed))) {
      callback(null, true);
    } else if (!isProduction) {
      // For development, log but allow
      console.warn(`⚠️  CORS: Origin not in allowed list: ${origin}`);
      callback(null, true);
    } else {
      // In production, reject unauthorized origins
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Shopify-*', 'Cookie'],
  exposedHeaders: ['Location', 'Set-Cookie'], // CRITICAL: Expose Location header for redirects
}));

// Capture RAW query string BEFORE Express processes it
// This is critical for OAuth HMAC verification
app.use((req, res, next) => {
  // Store raw query string before Express parses it
  if (req.url.includes('?')) {
    req.rawQueryString = req.url.split('?')[1];
  }
  if (req.originalUrl && req.originalUrl.includes('?')) {
    req.rawQueryString = req.originalUrl.split('?')[1];
  }
  next();
});

// Body parsing with size limits
app.use('/webhooks', express.raw({ type: 'application/json', limit: '1mb' })); // Raw for webhook HMAC verification
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// Rate limiting - more lenient and sophisticated to avoid blocking legitimate users
// Increased limits to prevent IP blocking issues (some ISPs share IPs, causing false positives)
const rateLimitWindow = isProduction ? 15 * 60 * 1000 : 60 * 1000; // 15 min prod, 1 min dev
const rateLimitMax = isProduction ? 1000 : 2000; // Very lenient to avoid false positives

// Standard rate limiter for most routes
const limiter = rateLimit({
  windowMs: rateLimitWindow,
  max: rateLimitMax,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  // Use req.ip which respects Express trust proxy setting
  // This prevents the X-Forwarded-For warning
  keyGenerator: (req) => {
    return req.ip || req.connection.remoteAddress || 'unknown';
  },
  // Skip rate limiting for health checks and diagnostics
  skip: (req) => {
    return req.path === '/health' || req.path.startsWith('/diagnostics');
  },
  // Custom handler to provide more helpful error messages
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      message: 'Rate limit exceeded. Please wait a few minutes and try again.',
      retryAfter: Math.ceil(rateLimitWindow / 1000), // seconds
      tip: 'If this persists, try changing your network connection or contact support.',
    });
  },
});

// More lenient rate limiter for auth routes (OAuth can be chatty)
const authLimiter = rateLimit({
  windowMs: rateLimitWindow,
  max: rateLimitMax * 2, // Double for auth routes
  keyGenerator: (req) => {
    return req.ip || req.connection.remoteAddress || 'unknown';
  },
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      message: 'Rate limit exceeded. Please wait a few minutes and try again.',
      retryAfter: Math.ceil(rateLimitWindow / 1000),
    });
  },
});

// Apply rate limiting - more lenient for auth, standard for others
app.use('/auth', authLimiter);
app.use('/api', limiter);
app.use('/billing', limiter);
app.use('/jobs', limiter);
// Health and diagnostics routes are excluded from rate limiting

// Routes
app.use('/health', healthRoutes);
app.use('/auth', authRoutes);
app.use('/billing', billingRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/api', apiRoutes);
app.use('/jobs', jobRoutes);
app.use('/diagnostics', diagnosticsRoutes);

// Error handling (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

// Listen on 0.0.0.0 to accept connections from any interface (required for Railway/containers)
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);
  
  // Start database-backed cron worker
  try {
    startCronWorker();
    console.log('✅ Database-backed cron worker enabled');
  } catch (error) {
    console.warn('⚠️  Failed to start cron worker:', error.message);
  }

  // Start tier-based job scheduler
  try {
    startScheduler();
    console.log('✅ Tier-based job scheduler enabled');
  } catch (error) {
    console.warn('⚠️  Failed to start job scheduler:', error.message);
  }

  // Seed pricing plans
  try {
    seedPricingPlans();
  } catch (error) {
    console.warn('⚠️  Failed to seed pricing plans:', error.message);
  }
});

// Setup graceful shutdown
setupGracefulShutdown(server);
