import express from 'express';
import prisma from '../config/database.js';

import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

/**
 * Basic health check
 */
router.get('/', asyncHandler(async (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'scaleguard-backend',
  });
}));

/**
 * Detailed health check with dependencies
 */
router.get('/detailed', asyncHandler(async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'scaleguard-backend',
    version: process.env.npm_package_version || '1.0.0',
    dependencies: {},
  };

  // Check database
  try {
    await prisma.$queryRaw`SELECT 1`;
    health.dependencies.database = {
      status: 'ok',
      type: 'postgresql',
    };
  } catch (error) {
    health.dependencies.database = {
      status: 'error',
      error: error.message,
    };
    health.status = 'degraded';
  }



  // Check environment variables
  const requiredEnvVars = [
    'DATABASE_URL',
    'SHOPIFY_API_KEY',
    'SHOPIFY_API_SECRET',
    'ENCRYPTION_KEY',
  ];

  const missingEnvVars = requiredEnvVars.filter(
    varName => !process.env[varName]
  );

  if (missingEnvVars.length > 0) {
    health.dependencies.environment = {
      status: 'error',
      missing: missingEnvVars,
    };
    health.status = 'error';
  } else {
    health.dependencies.environment = {
      status: 'ok',
    };
  }

  const statusCode = health.status === 'ok' ? 200 : 
                     health.status === 'degraded' ? 200 : 503;

  res.status(statusCode).json(health);
}));

/**
 * System status endpoint
 */
router.get('/status', asyncHandler(async (req, res) => {
  // Get system statistics
  const [shopCount, activeShopCount, subscriptionCount, activeSubscriptionCount, 
         nudgeCount, analysisCount, jobCount, recentJobs] = await Promise.all([
    prisma.shop.count(),
    prisma.shop.count({ where: { isActive: true } }),
    prisma.subscription.count(),
    prisma.subscription.count({ where: { status: 'ACTIVE' } }),
    prisma.nudge.count(),
    prisma.analysis.count(),
    prisma.job.count(),
    prisma.job.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        jobType: true,
        status: true,
        createdAt: true,
        completedAt: true,
      },
    }),
  ]);

  res.json({
    system: {
      shops: {
        total: shopCount,
        active: activeShopCount,
      },
      subscriptions: {
        total: subscriptionCount,
        active: activeSubscriptionCount,
      },
      data: {
        nudges: nudgeCount,
        analyses: analysisCount,
      },
      jobs: {
        total: jobCount,
        recent: recentJobs,
      },
    },
    timestamp: new Date().toISOString(),
  });
}));

export default router;
