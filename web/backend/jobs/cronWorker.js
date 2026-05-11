import cron from 'node-cron';
import prisma from '../config/database.js';
import { processDataSync } from './processors/dataSync.js';
import { processAuditRun } from './processors/auditEngine.js';
import { processWeeklyAnalysis } from './processors/weeklyAnalysis.js';
import { processCleanup } from './processors/cleanup.js';

const JOB_TYPES = {
  DATA_SYNC: 'DATA_SYNC',
  WEEKLY_ANALYSIS: 'WEEKLY_ANALYSIS',
  CLEANUP: 'CLEANUP',
};

let isProcessing = false;

export function startCronWorker() {
  console.log('🕒 Starting database-backed cron worker...');

  // Poll every minute
  cron.schedule('* * * * *', async () => {
    if (isProcessing) {
      console.log('⏳ Worker is already processing a job. Skipping this tick.');
      return;
    }

    try {
      isProcessing = true;

      // Find the oldest pending job
      // We use findFirst to get just one job to process at a time
      const pendingJob = await prisma.job.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
      });

      if (!pendingJob) {
        return; // No pending jobs
      }

      console.log(`🔄 Processing job ${pendingJob.id} of type ${pendingJob.jobType}`);

      // Mark job as PROCESSING
      await prisma.job.update({
        where: { id: pendingJob.id },
        data: {
          status: 'PROCESSING',
          startedAt: new Date(),
        },
      });

      let result;

      try {
        // Process the job based on type
        switch (pendingJob.jobType) {
          case JOB_TYPES.DATA_SYNC:
            result = await processDataSync({ shopId: pendingJob.shopId, jobId: pendingJob.id });

            // Auto-queue an AUDIT_RUN job after successful data sync
            console.log(`✅ Data sync successful. Queueing AUDIT_RUN job for shop ${pendingJob.shopId}`);
            await prisma.job.create({
              data: {
                shopId: pendingJob.shopId,
                jobType: 'AUDIT_RUN',
                status: 'PENDING',
                metadata: { triggeredBy: pendingJob.id }
              }
            });
            break;

          case 'AUDIT_RUN':
            result = await processAuditRun({ shopId: pendingJob.shopId, jobId: pendingJob.id });
            break;

          case JOB_TYPES.WEEKLY_ANALYSIS:
            result = await processWeeklyAnalysis({ shopId: pendingJob.shopId, jobId: pendingJob.id });
            break;

          case JOB_TYPES.CLEANUP:
            result = await processCleanup({ jobId: pendingJob.id });
            break;

          default:
            throw new Error(`Unknown job type: ${pendingJob.jobType}`);
        }

        // Mark as COMPLETED
        await prisma.job.update({
          where: { id: pendingJob.id },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            metadata: {
              ...(pendingJob.metadata ? (typeof pendingJob.metadata === 'string' ? JSON.parse(pendingJob.metadata) : pendingJob.metadata) : {}),
              result,
            },
          },
        });

        console.log(`✅ Job ${pendingJob.id} completed successfully.`);
      } catch (jobError) {
        console.error(`❌ Job ${pendingJob.id} failed:`, jobError);
        await prisma.job.update({
          where: { id: pendingJob.id },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            error: jobError.message || String(jobError)
          },
        });
      }

    } catch (error) {
      console.error(`❌ Worker outer error:`, error);
    } finally {
      isProcessing = false;
    }
  });

  console.log('✅ Database-backed cron worker initialized.');
}
