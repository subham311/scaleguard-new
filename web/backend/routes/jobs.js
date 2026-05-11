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

// Manually trigger data sync (for testing)
router.post('/trigger-sync', authenticateShop, async (req, res) => {
  try {
    const jobRecord = await prisma.job.create({
      data: {
        shopId: req.shop.id,
        jobType: 'DATA_SYNC', // Or JOB_TYPES.DATA_SYNC if we import it
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
      message: 'Data sync job triggered',
    });
  } catch (error) {
    console.error('Trigger sync error:', error);
    res.status(500).json({ error: 'Failed to trigger sync' });
  }
});

export default router;
