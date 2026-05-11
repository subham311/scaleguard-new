/**
 * Graceful Shutdown Handler
 */

import prisma from '../config/database.js';

let isShuttingDown = false;

export function setupGracefulShutdown(server) {
  const gracefulShutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n${signal} received. Starting graceful shutdown...`);

    // Stop accepting new requests
    server.close(() => {
      console.log('✅ HTTP server closed');
    });

    try {

      // Close database connection
      await prisma.$disconnect();
      console.log('✅ Database connection closed');

      console.log('✅ Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  };

  // Handle shutdown signals
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    gracefulShutdown('uncaughtException');
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('unhandledRejection');
  });
}
