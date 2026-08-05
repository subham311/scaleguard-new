import cron from 'node-cron';
import prisma from '../config/database.js';

const JOB_TYPES = {
  DATA_SYNC: 'DATA_SYNC',
  WEEKLY_ANALYSIS: 'WEEKLY_ANALYSIS',
  CLEANUP: 'CLEANUP',
};

/**
 * Schedule background jobs based on subscription plan frequency
 */
export function startScheduler() {
  console.log('📅 Starting tier-based job scheduler...');

  // 1. Every 3 Hours: 'FASTER' (PRO Plan) - "3-hourly sync"
  // Runs every 3 hours
  cron.schedule('0 */3 * * *', async () => {
    console.log('⏰ 3-Hourly scheduler triggered (FASTER scan frequency)');
    await scheduleDataSyncs('FASTER');
  });

  // 2. Daily: 'CONTINUOUS' (GROWTH Plan) - "Daily sync"
  // Runs every day at 1 AM UTC
  cron.schedule('0 1 * * *', async () => {
    console.log('⏰ Daily scheduler triggered (CONTINUOUS scan frequency)');
    await scheduleDataSyncs('CONTINUOUS');
  });

  // 3. Weekly: 'WEEKLY' (LIGHT Plan or Fallback) - "Weekly sync"
  // Runs every Monday at 2 AM UTC
  cron.schedule('0 2 * * 1', async () => {
    console.log('⏰ Weekly scheduler triggered (WEEKLY scan frequency)');
    await scheduleDataSyncs('WEEKLY');
    
    // Also run the legacy weekly analysis for all active shops
    await scheduleWeeklyAnalysis();
  });

  // Cleanup job - Every Sunday at 3 AM UTC
  cron.schedule('0 3 * * 0', async () => {
    console.log('⏰ Cleanup job triggered');
    await scheduleCleanup();
  });

  console.log('✅ Tier-based job scheduler started');
}

/**
 * Schedule DATA_SYNC for shops matching the target frequency.
 * Note: cronWorker automatically chains AUDIT_RUN after successful DATA_SYNC.
 */
async function scheduleDataSyncs(targetFrequency) {
  try {
    const activeShops = await prisma.shop.findMany({
      where: { isActive: true },
      include: {
        subscription: {
          include: { pricingPlan: true }
        },
      },
    });

    let scheduledCount = 0;

    for (const shop of activeShops) {
      if (shop.subscription && shop.subscription.status === 'ACTIVE') {
        const plan = shop.subscription.pricingPlan;
        
        // Default to WEEKLY if no plan is specified
        const frequency = plan?.scanFrequency || 'WEEKLY';

        // ── Trial-Safe Limit: trial shops always use WEEKLY (daily/manual scanning) ──
        // During a free trial, skip heavy recurring scans (FASTER = every 3h, CONTINUOUS = daily).
        // Trial shops can still run manual syncs from the dashboard at any time.
        const trialEndsAt = shop.subscription?.trialEndsAt;
        const isTrial = trialEndsAt ? new Date(trialEndsAt) > new Date() : false;
        if (isTrial && frequency !== 'WEEKLY') {
          // Silently skip this shop — trial users are restricted to WEEKLY/manual scans
          continue;
        }

        if (frequency === targetFrequency) {
          // Check if there is already a pending sync job to prevent duplicates
          const existingJob = await prisma.job.findFirst({
            where: {
              shopId: shop.id,
              jobType: JOB_TYPES.DATA_SYNC,
              status: 'PENDING'
            }
          });

          if (!existingJob) {
            await prisma.job.create({
              data: {
                shopId: shop.id,
                jobType: JOB_TYPES.DATA_SYNC,
                status: 'PENDING',
                metadata: {
                  scheduledAt: new Date().toISOString(),
                  trigger: `SCHEDULER_${targetFrequency}`
                },
              },
            });
            scheduledCount++;
          }
        }
      }
    }

    console.log(`✅ Scheduled DATA_SYNC for ${scheduledCount} shop(s) on ${targetFrequency} frequency.`);
  } catch (error) {
    console.error(`❌ Error scheduling ${targetFrequency} syncs:`, error);
  }
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
