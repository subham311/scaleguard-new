import cron from 'node-cron';
import prisma from '../config/database.js';

const JOB_TYPES = {
  DATA_SYNC: 'DATA_SYNC',
  WEEKLY_ANALYSIS: 'WEEKLY_ANALYSIS',
  CLEANUP: 'CLEANUP',
};

/**
 * Schedule weekly analysis jobs
 * Runs every Monday at 2 AM UTC
 */
export function startScheduler() {
  console.log('📅 Starting job scheduler...');

  // Weekly analysis job - Every Monday at 2 AM UTC
  cron.schedule('0 2 * * 1', async () => {
    console.log('⏰ Weekly analysis job triggered');
    await scheduleWeeklyAnalysis();
  });

  // Cleanup job - Every Sunday at 3 AM UTC
  cron.schedule('0 3 * * 0', async () => {
    console.log('⏰ Cleanup job triggered');
    await scheduleCleanup();
  });

  console.log('✅ Job scheduler started');
}

/**
 * Schedule weekly analysis for all active shops
 */
async function scheduleWeeklyAnalysis() {
  try {
    const activeShops = await prisma.shop.findMany({
      where: {
        isActive: true,
      },
      include: {
        subscription: true,
      },
    });

    console.log(`📊 Scheduling weekly analysis for ${activeShops.length} shops`);

    for (const shop of activeShops) {
      // Only schedule for shops with active subscriptions
      if (shop.subscription && shop.subscription.status === 'ACTIVE') {
        // Create job record
        await prisma.job.create({
          data: {
            shopId: shop.id,
            jobType: JOB_TYPES.WEEKLY_ANALYSIS,
            status: 'PENDING',
            metadata: {
              scheduledAt: new Date().toISOString(),
            },
          },
        });

        console.log(`✅ Scheduled weekly analysis for shop ${shop.shopDomain}`);
      }
    }
  } catch (error) {
    console.error('❌ Error scheduling weekly analysis:', error);
  }
}

/**
 * Schedule cleanup job
 */
async function scheduleCleanup() {
  try {
    await prisma.job.create({
      data: {
        jobType: JOB_TYPES.CLEANUP,
        status: 'PENDING',
        metadata: {
          scheduledAt: new Date().toISOString(),
        },
      },
    });

    console.log('✅ Scheduled cleanup job');
  } catch (error) {
    console.error('❌ Error scheduling cleanup:', error);
  }
}

/**
 * Manually trigger weekly analysis for a specific shop (for testing)
 */
export async function triggerWeeklyAnalysis(shopId) {
  const jobRecord = await prisma.job.create({
    data: {
      shopId,
      jobType: JOB_TYPES.WEEKLY_ANALYSIS,
      status: 'PENDING',
      metadata: {
        manuallyTriggered: true,
        triggeredAt: new Date().toISOString(),
      },
    },
  });

  return jobRecord;
}

/**
 * Manually trigger data sync for a specific shop (for testing)
 */
export async function triggerDataSync(shopId) {
  const jobRecord = await prisma.job.create({
    data: {
      shopId,
      jobType: JOB_TYPES.DATA_SYNC,
      status: 'PENDING',
      metadata: {
        manuallyTriggered: true,
        triggeredAt: new Date().toISOString(),
      },
    },
  });

  return jobRecord;
}
