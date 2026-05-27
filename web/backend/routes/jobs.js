import express from 'express';
import prisma from '../config/database.js';
import { authenticateShop } from '../middleware/auth.js';
import { triggerWeeklyAnalysis } from '../jobs/scheduler.js';

const router = express.Router();

// Get job status for a shop
router.get('/status', authenticateShop, async (req, res) => {
  try {
    const jobs = await prisma.job.findMany({
      where: {
        shopId: req.shop.id,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 10,
    });

    res.json({ jobs });
  } catch (error) {
    console.error('Get job status error:', error);
    res.status(500).json({ error: 'Failed to get job status' });
  }
});

// Manually trigger weekly analysis (for testing)
router.post('/trigger-analysis', authenticateShop, async (req, res) => {
  try {
    const jobRecord = await triggerWeeklyAnalysis(req.shop.id);
    res.json({
      success: true,
      job: jobRecord,
      message: 'Weekly analysis job triggered',
    });
  } catch (error) {
    console.error('Trigger analysis error:', error);
    res.status(500).json({ error: 'Failed to trigger analysis' });
  }
});

// Manually trigger data sync with tier-based cooldown enforcement
router.post('/trigger-sync', authenticateShop, async (req, res) => {
  try {
    const shop = await prisma.shop.findUnique({
      where: { id: req.shop.id },
      include: {
        subscription: { include: { pricingPlan: true } },
      },
    });

    if (!shop) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const planName = shop.subscription?.pricingPlan?.name?.toUpperCase() 
      || shop.subscription?.plan?.toUpperCase() 
      || 'LIGHT';

    let cooldownMs = 24 * 60 * 60 * 1000; // 24h default
    if (planName === 'PRO') {
      cooldownMs = 3 * 60 * 60 * 1000; // 3 hours
    } else if (planName === 'GROWTH') {
      cooldownMs = 8 * 60 * 60 * 1000; // 8 hours
    }

    // 1. Check for active PENDING or PROCESSING jobs
    const activeJob = await prisma.job.findFirst({
      where: {
        shopId: shop.id,
        jobType: { in: ['DATA_SYNC', 'AUDIT_RUN'] },
        status: { in: ['PENDING', 'PROCESSING'] },
      },
    });

    if (activeJob) {
      return res.status(429).json({
        success: false,
        error: 'ACTIVE_JOB',
        message: 'A catalog re-analysis is already in progress. Please wait for it to complete.',
      });
    }

    // 2. Enforce tier cooldowns based on the last completed manual sync
    const lastSync = await prisma.job.findFirst({
      where: {
        shopId: shop.id,
        jobType: 'DATA_SYNC',
        status: 'COMPLETED',
      },
      orderBy: {
        completedAt: 'desc',
      },
    });

    if (lastSync && lastSync.completedAt) {
      const elapsed = Date.now() - new Date(lastSync.completedAt).getTime();
      if (elapsed < cooldownMs) {
        const remainingMs = cooldownMs - elapsed;
        return res.status(429).json({
          success: false,
          error: 'COOLDOWN',
          remainingMs,
          message: `Re-analysis cooldown active. Next sync available in ${Math.ceil(remainingMs / (60 * 1000))} minutes.`,
        });
      }
    }

    // 3. Trigger new re-analysis job
    const jobRecord = await prisma.job.create({
      data: {
        shopId: shop.id,
        jobType: 'DATA_SYNC',
        status: 'PENDING',
        metadata: {
          manuallyTriggered: true,
          triggeredAt: new Date().toISOString(),
        },
      },
    });

    res.json({
      success: true,
      job: jobRecord,
      message: 'Data sync job triggered successfully.',
    });
  } catch (error) {
    console.error('Trigger sync error:', error);
    res.status(500).json({ error: 'Failed to trigger sync' });
  }
});

export default router;
