import { Queue } from 'bullmq';
import redis from '../config/redis.js';

// Job types
export const JOB_TYPES = {
  WEEKLY_ANALYSIS: 'WEEKLY_ANALYSIS',
  DATA_SYNC: 'DATA_SYNC',
  CLEANUP: 'CLEANUP',
};

let jobQueue = null;

/**
 * Get or create the job queue (lazy initialization)
 * Only creates queue if Redis is configured
 */
export function getJobQueue() {
  // Check if Redis is configured
  if (!process.env.REDIS_HOST && !process.env.REDIS_PORT) {
    return null;
  }

  // If queue already exists, return it
  if (jobQueue) {
    return jobQueue;
  }

  try {
    // Create job queue (lazy connection - only connects when used)
    jobQueue = new Queue('scaleguard-jobs', {
      connection: redis,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 24 * 3600, // Keep completed jobs for 24 hours
          count: 1000,
        },
        removeOnFail: {
          age: 7 * 24 * 3600, // Keep failed jobs for 7 days
        },
      },
    });

    // Handle queue errors gracefully
    jobQueue.on('error', (error) => {
      // Suppress connection errors when Redis isn't configured
      if (error.message === 'Connection is closed' || error.code === 'ECONNREFUSED') {
        return; // Silently ignore
      }
      console.error('❌ Queue error:', error);
    });

    return jobQueue;
  } catch (error) {
    console.error('❌ Failed to create job queue:', error.message);
    return null;
  }
}

// Note: Don't call getJobQueue() at module load time
// Always use getJobQueue() function to get the queue when needed

export default getJobQueue;
