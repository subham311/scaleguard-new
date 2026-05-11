import prisma from '../../config/database.js';

export async function processCleanup(jobData) {
  console.log('🧹 Starting cleanup job');
  
  try {
    // Archive old analyses (older than 90 days)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    
    // For now, we'll just log. In production, you might want to archive to a separate table
    const oldAnalyses = await prisma.analysis.findMany({
      where: {
        createdAt: {
          lt: cutoffDate,
        },
      },
      select: {
        id: true,
      },
    });

    console.log(`📦 Found ${oldAnalyses.length} old analyses to archive`);

    // Archive dismissed nudges older than 30 days
    const dismissedCutoff = new Date();
    dismissedCutoff.setDate(dismissedCutoff.getDate() - 30);
    
    const oldDismissedNudges = await prisma.nudge.findMany({
      where: {
        status: 'DISMISSED',
        updatedAt: {
          lt: dismissedCutoff,
        },
      },
      select: {
        id: true,
      },
    });

    console.log(`📦 Found ${oldDismissedNudges.length} old dismissed nudges`);

    // Update status to ARCHIVED
    if (oldDismissedNudges.length > 0) {
      await prisma.nudge.updateMany({
        where: {
          id: {
            in: oldDismissedNudges.map(n => n.id),
          },
        },
        data: {
          status: 'ARCHIVED',
        },
      });
    }

    console.log('✅ Cleanup job completed');
    return {
      success: true,
      analysesFound: oldAnalyses.length,
      nudgesArchived: oldDismissedNudges.length,
    };
  } catch (error) {
    console.error('❌ Cleanup job failed:', error);
    throw error;
  }
}
