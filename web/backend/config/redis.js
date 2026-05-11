import Redis from 'ioredis';

// Check if Redis is explicitly configured (not using defaults)
const hasRedisEnv = !!(process.env.REDIS_HOST || process.env.REDIS_PORT);

// Create Redis client with lazy connection (only connects when actually used)
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: true, // Don't connect immediately - only when needed
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  // BullMQ requires maxRetriesPerRequest to be null for blocking operations
  maxRetriesPerRequest: null,
  // Enable offline queue so commands don't fail immediately if Redis is down
  enableOfflineQueue: true,
});

redis.on('connect', () => {
  console.log('✅ Redis connected');
});

redis.on('error', (err) => {
  // Only log errors if Redis is explicitly configured (to avoid spam when Redis isn't needed)
  // Suppress ECONNREFUSED errors if Redis env vars aren't set (means Redis is optional)
  if (!hasRedisEnv && err.code === 'ECONNREFUSED') {
    // Silently ignore - Redis is optional
    return;
  }
  if (err.code !== 'ECONNREFUSED') {
    console.error('❌ Redis connection error:', err);
  }
  // Don't throw - allow app to continue without Redis (graceful degradation)
});

// Graceful shutdown
process.on('SIGTERM', () => {
  if (redis && redis.status !== 'end') {
    redis.disconnect();
  }
});

process.on('SIGINT', () => {
  if (redis && redis.status !== 'end') {
    redis.disconnect();
  }
});

export default redis;
