import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

// Prisma handles connections automatically via connection pooling
// Connection errors are transient and will be retried on the next query
// No need to manually connect - Prisma connects lazily when needed

// Add connection retry helper function
export async function testDatabaseConnection() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.error('❌ Database connection test failed:', error.message);
    return false;
  }
}

// Test connection on startup (non-blocking)
if (process.env.NODE_ENV === 'production') {
  testDatabaseConnection().then(connected => {
    if (connected) {
      console.log('✅ Database connection verified');
    } else {
      console.error('❌ Database connection failed - check DATABASE_URL');
    }
  }).catch(err => {
    console.error('❌ Database connection test error:', err);
  });
}

export default prisma;

