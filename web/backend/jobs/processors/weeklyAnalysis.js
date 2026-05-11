import prisma from '../../config/database.js';
import { fetchShopifyData } from '../../services/shopifyDataService.js';
import { runAnalysis } from '../../services/analysisService.js';
import { checkThresholds, calculateConfidence } from '../../services/decisionSafety.js';
import { generateNudges } from '../../services/nudgeService.js';
import { updateMaturityLevel } from '../../services/maturityService.js';

export async function processWeeklyAnalysis(jobData) {
  const { shopId } = jobData;
  
  console.log(`📊 Starting weekly analysis for shop ${shopId}`);
  
  // Get shop record
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { subscription: true },
  });

  if (!shop || !shop.isActive) {
    throw new Error(`Shop ${shopId} not found or inactive`);
  }

  // Check if subscription is active
  if (!shop.subscription || shop.subscription.status !== 'ACTIVE') {
    console.log(`⏭️ Skipping analysis - subscription not active for shop ${shopId}`);
    return { skipped: true, reason: 'Subscription not active' };
  }

  try {
    // Step 1: Fetch Shopify data
    console.log(`📥 Fetching Shopify data for shop ${shopId}`);
    const shopifyData = await fetchShopifyData(shop);
    
    if (!shopifyData || shopifyData.orders.length === 0) {
      console.log(`⏭️ No data available for shop ${shopId}`);
      return { skipped: true, reason: 'No data available' };
    }

    // Step 2: Check thresholds
    console.log(`🔍 Checking thresholds for shop ${shopId}`);
    const thresholdCheck = await checkThresholds(shopifyData, shop);
    
    if (!thresholdCheck.meetsThreshold) {
      console.log(`⏭️ Thresholds not met for shop ${shopId}: ${thresholdCheck.reason}`);
      // Update data collected timestamp even if thresholds not met
      await prisma.shop.update({
        where: { id: shopId },
        data: { dataCollectedAt: new Date() },
      });
      return { skipped: true, reason: thresholdCheck.reason };
    }

    // Step 3: Run analysis
    console.log(`🔬 Running analysis for shop ${shopId}`);
    const analysisResults = await runAnalysis(shopifyData, shop);
    
    // Step 4: Calculate confidence scores
    console.log(`📈 Calculating confidence scores for shop ${shopId}`);
    const confidenceScores = await calculateConfidence(analysisResults, shopifyData);
    
    // Step 5: Store analysis results
    console.log(`💾 Storing analysis results for shop ${shopId}`);
    const storedAnalyses = [];
    for (const [analysisType, results] of Object.entries(analysisResults)) {
      const confidence = confidenceScores[analysisType] || 0;
      const analysis = await prisma.analysis.create({
        data: {
          shopId: shop.id,
          analysisType,
          dataPoints: shopifyData.orders.length,
          confidenceScore: confidence,
          meetsThreshold: thresholdCheck.meetsThreshold,
          maturityLevel: shop.maturityLevel,
          results: results,
        },
      });
      storedAnalyses.push(analysis);
    }

    // Step 6: Generate nudges (only if confidence is high enough)
    console.log(`💡 Generating nudges for shop ${shopId}`);
    const nudges = [];
    for (const analysis of storedAnalyses) {
      if (analysis.confidenceScore >= 70) {
        const generatedNudges = await generateNudges(analysis, shopifyData, shop);
        nudges.push(...generatedNudges);
      }
    }

    // Step 7: Update shop maturity level
    console.log(`📊 Updating maturity level for shop ${shopId}`);
    await updateMaturityLevel(shop.id, shopifyData);

    // Step 8: Update shop last analysis timestamp
    await prisma.shop.update({
      where: { id: shopId },
      data: {
        lastAnalysisAt: new Date(),
        dataCollectedAt: new Date(),
      },
    });

    console.log(`✅ Weekly analysis completed for shop ${shopId}`);
    return {
      success: true,
      analysesCreated: storedAnalyses.length,
      nudgesCreated: nudges.length,
      confidenceScores,
    };
  } catch (error) {
    console.error(`❌ Weekly analysis failed for shop ${shopId}:`, error);
    throw error;
  }
}
