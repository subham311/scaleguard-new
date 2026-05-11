/**
 * Decision Safety Logic
 * Ensures we only generate recommendations when we have sufficient data and confidence
 */

/**
 * Check if minimum data thresholds are met
 */
export async function checkThresholds(shopifyData, shop) {
  const orders = shopifyData.orders || [];
  const products = shopifyData.products || [];
  
  // Minimum thresholds
  const MIN_ORDERS = 10; // Minimum orders for basic analysis
  const MIN_ORDERS_FOR_CONFIDENCE = 30; // Minimum for high confidence
  const MIN_TIME_WINDOW_DAYS = 7; // Minimum days of data
  const MIN_PRODUCTS = 5; // Minimum products

  // Check order count
  if (orders.length < MIN_ORDERS) {
    return {
      meetsThreshold: false,
      reason: `Insufficient orders (${orders.length} < ${MIN_ORDERS} required)`,
      ordersCount: orders.length,
      minRequired: MIN_ORDERS,
    };
  }

  // Check time window
  if (orders.length > 0) {
    const oldestOrder = new Date(orders[orders.length - 1].created_at);
    const newestOrder = new Date(orders[0].created_at);
    const daysDiff = (newestOrder - oldestOrder) / (1000 * 60 * 60 * 24);
    
    if (daysDiff < MIN_TIME_WINDOW_DAYS) {
      return {
        meetsThreshold: false,
        reason: `Insufficient time window (${Math.round(daysDiff)} days < ${MIN_TIME_WINDOW_DAYS} days required)`,
        daysDiff: Math.round(daysDiff),
        minRequired: MIN_TIME_WINDOW_DAYS,
      };
    }
  }

  // Check product count
  if (products.length < MIN_PRODUCTS) {
    return {
      meetsThreshold: false,
      reason: `Insufficient products (${products.length} < ${MIN_PRODUCTS} required)`,
      productsCount: products.length,
      minRequired: MIN_PRODUCTS,
    };
  }

  // Check variance stability (basic check)
  const orderValues = orders.map(o => parseFloat(o.total_price || 0));
  const mean = orderValues.reduce((a, b) => a + b, 0) / orderValues.length;
  const variance = orderValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / orderValues.length;
  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = mean > 0 ? stdDev / mean : 0;

  // High variance might indicate unstable patterns
  if (coefficientOfVariation > 2.0 && orders.length < MIN_ORDERS_FOR_CONFIDENCE) {
    return {
      meetsThreshold: false,
      reason: `High variance in order values (CV: ${coefficientOfVariation.toFixed(2)}). Need more data for reliable analysis.`,
      coefficientOfVariation: coefficientOfVariation,
    };
  }

  return {
    meetsThreshold: true,
    ordersCount: orders.length,
    productsCount: products.length,
    hasEnoughForHighConfidence: orders.length >= MIN_ORDERS_FOR_CONFIDENCE,
  };
}

/**
 * Calculate confidence scores for analysis results
 */
export async function calculateConfidence(analysisResults, shopifyData) {
  const orders = shopifyData.orders || [];
  const confidenceScores = {};

  // Base confidence factors
  const dataPointsFactor = Math.min(orders.length / 100, 1.0); // Max at 100 orders
  const timeWindowFactor = Math.min(orders.length > 0 ? 
    (new Date(orders[0].created_at) - new Date(orders[orders.length - 1].created_at)) / (1000 * 60 * 60 * 24 * 30) : 0, 
    1.0); // Max at 30 days

  // Calculate confidence for each analysis type
  for (const [analysisType, results] of Object.entries(analysisResults)) {
    let baseConfidence = 50; // Start at 50%

    // Adjust based on data points
    baseConfidence += dataPointsFactor * 30; // Up to +30% for data volume

    // Adjust based on time window
    baseConfidence += timeWindowFactor * 10; // Up to +10% for time coverage

    // Adjust based on analysis-specific factors
    if (results?.trendStrength) {
      baseConfidence += results.trendStrength * 10; // Up to +10% for strong trends
    }

    if (results?.dataQuality) {
      baseConfidence += results.dataQuality * 10; // Up to +10% for data quality
    }

    // Cap at 100%
    confidenceScores[analysisType] = Math.min(Math.round(baseConfidence), 100);
  }

  return confidenceScores;
}
