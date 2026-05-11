import { Worker } from 'bullmq';
import redis from '../config/redis.js';
import prisma from '../config/database.js';
import { JOB_TYPES } from './queue.js';
import { processWeeklyAnalysis } from './processors/weeklyAnalysis.js';
import { processDataSync } from './processors/dataSync.js';
import { processCleanup } from './processors/cleanup.js';

let jobWorker = null;

/**
 * Initialize the job worker (lazy initialization)
 * Only creates worker if Redis is configured
 */
export function initializeWorker() {
  // Check if Redis is configured
  if (!process.env.REDIS_HOST && !process.env.REDIS_PORT) {
    console.warn('⚠️  Redis not configured - worker not initialized');
    return null;
  }

  // If worker already exists, return it
  if (jobWorker) {
    return jobWorker;
  }

  try {
    // Create worker to process jobs
    jobWorker = new Worker(
      'scaleguard-jobs',
      async (job) => {
        const jobId = job.id || job.data?.jobId;
        console.log(`🔄 Processing job ${jobId} of type ${job.name}`);
        
        // Update job status to PROCESSING (if jobId exists in DB)
        if (jobId) {
          try {
            await prisma.job.update({
              where: { id: jobId },
              data: {
                status: 'PROCESSING',
                startedAt: new Date(),
              },
            });
          } catch (err) {
            // Job might not exist in DB yet, that's okay
            console.warn(`⚠️ Could not update job ${jobId} status:`, err.message);
          }
        }
        
        try {
          let result;
          switch (job.name) {
            case JOB_TYPES.WEEKLY_ANALYSIS:
              result = await processWeeklyAnalysis(job.data);
              break;
            case JOB_TYPES.DATA_SYNC:
              result = await processDataSync(job.data);
              break;
            case JOB_TYPES.CLEANUP:
              result = await processCleanup(job.data);
              break;
            default:
              throw new Error(`Unknown job type: ${job.name}`);
          }

          // Update job status to COMPLETED (if jobId exists in DB)
          if (jobId) {
            try {
              await prisma.job.update({
                where: { id: jobId },
                data: {
                  status: 'COMPLETED',
                  completedAt: new Date(),
                  metadata: {
                    ...(job.data?.metadata || {}),
                    result,
                  },
                },
              });
            } catch (err) {
              console.warn(`⚠️ Could not update job ${jobId} completion:`, err.message);
            }
          }

          return result;
        } catch (error) {
          console.error(`❌ Job ${jobId} failed:`, error);
          
          // Update job status to FAILED (if jobId exists in DB)
          if (jobId) {
            try {
              await prisma.job.update({
                where: { id: jobId },
                data: {
                  status: 'FAILED',
                  completedAt: new Date(),
                  error: error.message,
                  metadata: {
                    ...(job.data?.metadata || {}),
                    errorDetails: error.stack,
                  },
                },
              });
            } catch (err) {
              console.warn(`⚠️ Could not update job ${jobId} failure:`, err.message);
            }
          }

          throw error; // Re-throw to trigger retry logic
        }
      },
      {
        connection: redis,
        concurrency: 5, // Process up to 5 jobs concurrently
        limiter: {
          max: 10,
          duration: 1000, // Max 10 jobs per second
        },
      }
    );

    jobWorker.on('completed', (job) => {
      console.log(`✅ Job ${job.id} completed`);
    });

    jobWorker.on('failed', (job, err) => {
      console.error(`❌ Job ${job.id} failed:`, err.message);
    });

    jobWorker.on('error', (err) => {
      // Only log if it's not a connection error (those are expected if Redis isn't running)
      if (err.code !== 'ECONNREFUSED') {
        console.error('❌ Worker error:', err);
      }
    });

    console.log('✅ Job worker initialized');
    return jobWorker;
  } catch (error) {
    console.error('❌ Failed to initialize worker:', error.message);
    return null;
  }
}

// Export getter for backward compatibility
export const getJobWorker = () => jobWorker;

export default jobWorker;
