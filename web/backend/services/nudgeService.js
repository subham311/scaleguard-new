import prisma from '../config/database.js';

/**
 * Nudge Generation Service
 * Generates intelligent recommendations based on analysis results
 */

const NUDGE_TYPES = {
  SCALING_OPPORTUNITY: 'SCALING_OPPORTUNITY',
  RISK_WARNING: 'RISK_WARNING',
  OPTIMIZATION_TIP: 'OPTIMIZATION_TIP',
};

/**
 * Generate nudges from analysis results
 */
export async function generateNudges(analysis, shopifyData, shop) {
  const nudges = [];

  // Generate nudges based on analysis type
  switch (analysis.analysisType) {
    case 'SALES_TREND':
      nudges.push(...generateSalesTrendNudges(analysis, shopifyData));
      break;
    case 'INVENTORY':
      nudges.push(...generateInventoryNudges(analysis, shopifyData));
      break;
    case 'CUSTOMER_BEHAVIOR':
      nudges.push(...generateCustomerBehaviorNudges(analysis, shopifyData));
      break;
  }

  // Store nudges in database
  const storedNudges = [];
  for (const nudge of nudges) {
    if (nudge.confidenceScore >= 70) {
      const stored = await prisma.nudge.create({
        data: {
          shopId: shop.id,
          nudgeType: nudge.nudgeType,
          confidenceScore: nudge.confidenceScore,
          title: nudge.title,
          message: nudge.message,
          explanation: nudge.explanation,
          supportingData: nudge.supportingData,
          status: 'ACTIVE',
        },
      });
      storedNudges.push(stored);
    }
  }

  return storedNudges;
}

/**
 * Generate sales trend nudges
 */
function generateSalesTrendNudges(analysis, shopifyData) {
  const nudges = [];
  const results = analysis.results;

  // Scaling opportunity: Strong growth trend
  if (results.trendDirection === 'INCREASING' && results.growthRate > 10) {
    nudges.push({
      nudgeType: NUDGE_TYPES.SCALING_OPPORTUNITY,
      confidenceScore: Math.min(analysis.confidenceScore + 10, 100),
      title: 'Strong Growth Detected',
      message: `Your sales are growing at ${results.growthRate.toFixed(1)}% per day. Consider scaling inventory and marketing.`,
      explanation: `Based on ${analysis.dataPoints} orders over the last period, we detected a consistent upward trend in revenue. This suggests strong market demand.`,
      supportingData: {
        growthRate: results.growthRate,
        trendStrength: results.trendStrength,
        averageRevenue: results.averageRevenue,
      },
    });
  }

  // Risk warning: Declining trend
  if (results.trendDirection === 'DECREASING' && Math.abs(results.growthRate) > 5) {
    nudges.push({
      nudgeType: NUDGE_TYPES.RISK_WARNING,
      confidenceScore: analysis.confidenceScore,
      title: 'Sales Decline Detected',
      message: `Sales are declining at ${Math.abs(results.growthRate).toFixed(1)}% per day. Review marketing and product strategy.`,
      explanation: `Analysis of ${analysis.dataPoints} orders shows a downward trend. This may indicate changing market conditions or increased competition.`,
      supportingData: {
        growthRate: results.growthRate,
        trendStrength: results.trendStrength,
      },
    });
  }

  // Optimization tip: Stable but low volume
  if (results.trendDirection === 'STABLE' && results.averageRevenue < 100) {
    nudges.push({
      nudgeType: NUDGE_TYPES.OPTIMIZATION_TIP,
      confidenceScore: analysis.confidenceScore,
      title: 'Optimize Marketing',
      message: 'Sales are stable but volume is low. Consider increasing marketing spend or running promotions.',
      explanation: `Your store shows consistent but low sales volume. Increasing visibility through marketing could help scale.`,
      supportingData: {
        averageRevenue: results.averageRevenue,
        orderCount: analysis.dataPoints,
      },
    });
  }

  return nudges;
}

/**
 * Generate inventory nudges
 */
function generateInventoryNudges(analysis, shopifyData) {
  const nudges = [];
  const results = analysis.results;

  // Risk warning: Low stock
  if (results.lowStockCount > 0) {
    nudges.push({
      nudgeType: NUDGE_TYPES.RISK_WARNING,
      confidenceScore: Math.min(analysis.confidenceScore + 15, 100),
      title: 'Low Stock Alert',
      message: `${results.lowStockCount} product${results.lowStockCount > 1 ? 's' : ''} running low on inventory. Consider restocking soon.`,
      explanation: `Based on current inventory levels, ${results.lowStockCount} product${results.lowStockCount > 1 ? 's' : ''} have less than 10 units remaining.`,
      supportingData: {
        lowStockCount: results.lowStockCount,
        totalProducts: results.totalProducts,
      },
    });
  }

  // Risk warning: Out of stock
  if (results.outOfStockCount > 0) {
    nudges.push({
      nudgeType: NUDGE_TYPES.RISK_WARNING,
      confidenceScore: Math.min(analysis.confidenceScore + 20, 100),
      title: 'Out of Stock Products',
      message: `${results.outOfStockCount} product${results.outOfStockCount > 1 ? 's are' : ' is'} currently out of stock.`,
      explanation: `These products are unavailable for purchase, which may result in lost sales.`,
      supportingData: {
        outOfStockCount: results.outOfStockCount,
        totalProducts: results.totalProducts,
      },
    });
  }

  return nudges;
}

/**
 * Generate customer behavior nudges
 */
function generateCustomerBehaviorNudges(analysis, shopifyData) {
  const nudges = [];
  const results = analysis.results;

  // Scaling opportunity: High repeat rate
  if (results.repeatCustomerRate > 30) {
    nudges.push({
      nudgeType: NUDGE_TYPES.SCALING_OPPORTUNITY,
      confidenceScore: Math.min(analysis.confidenceScore + 10, 100),
      title: 'High Customer Retention',
      message: `${results.repeatCustomerRate.toFixed(1)}% of customers make repeat purchases. Consider a loyalty program.`,
      explanation: `Your store has strong customer retention, indicating high satisfaction. A loyalty program could further increase repeat purchases.`,
      supportingData: {
        repeatCustomerRate: results.repeatCustomerRate,
        averageLTV: results.averageLTV,
      },
    });
  }

  // Optimization tip: Low repeat rate
  if (results.repeatCustomerRate < 10 && results.customersWithOrders > 20) {
    nudges.push({
      nudgeType: NUDGE_TYPES.OPTIMIZATION_TIP,
      confidenceScore: analysis.confidenceScore,
      title: 'Improve Customer Retention',
      message: `Only ${results.repeatCustomerRate.toFixed(1)}% of customers return. Consider email marketing or promotions to encourage repeat purchases.`,
      explanation: `Low repeat purchase rate suggests opportunities to improve customer engagement and retention strategies.`,
      supportingData: {
        repeatCustomerRate: results.repeatCustomerRate,
        customersWithOrders: results.customersWithOrders,
      },
    });
  }

  return nudges;
}
