/**
 * Analysis Service
 * Runs various analysis algorithms on Shopify data
 */

/**
 * Run all analyses on shopify data
 */
export async function runAnalysis(shopifyData, shop) {
  const results = {};

  // Run sales trend analysis
  results.SALES_TREND = analyzeSalesTrend(shopifyData.orders);

  // Run inventory analysis
  results.INVENTORY = analyzeInventory(shopifyData.products, shopifyData.orders);

  // Run customer behavior analysis
  results.CUSTOMER_BEHAVIOR = analyzeCustomerBehavior(shopifyData.customers, shopifyData.orders);

  return results;
}

/**
 * Analyze sales trends
 */
function analyzeSalesTrend(orders) {
  if (!orders || orders.length === 0) {
    return {
      trendStrength: 0,
      dataQuality: 0,
      message: 'Insufficient order data',
    };
  }

  // Calculate daily revenue
  const dailyRevenue = {};
  orders.forEach(order => {
    const date = new Date(order.created_at).toISOString().split('T')[0];
    const revenue = parseFloat(order.total_price || 0);
    dailyRevenue[date] = (dailyRevenue[date] || 0) + revenue;
  });

  const dates = Object.keys(dailyRevenue).sort();
  const revenues = dates.map(date => dailyRevenue[date]);

  // Calculate trend (simple linear regression)
  const n = revenues.length;
  const sumX = dates.reduce((sum, _, i) => sum + i, 0);
  const sumY = revenues.reduce((sum, val) => sum + val, 0);
  const sumXY = revenues.reduce((sum, val, i) => sum + i * val, 0);
  const sumX2 = dates.reduce((sum, _, i) => sum + i * i, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  // Calculate average revenue
  const avgRevenue = sumY / n;

  // Calculate trend strength (0-1)
  const trendStrength = Math.min(Math.abs(slope) / (avgRevenue || 1), 1);

  // Determine trend direction
  const trendDirection = slope > 0 ? 'INCREASING' : slope < 0 ? 'DECREASING' : 'STABLE';

  // Calculate growth rate
  const growthRate = avgRevenue > 0 ? (slope / avgRevenue) * 100 : 0;

  return {
    trendStrength: Math.round(trendStrength * 100) / 100,
    trendDirection,
    growthRate: Math.round(growthRate * 100) / 100,
    averageRevenue: Math.round(avgRevenue * 100) / 100,
    totalRevenue: Math.round(sumY * 100) / 100,
    orderCount: orders.length,
    dataQuality: Math.min(n / 30, 1), // Quality based on days of data
    dailyRevenue,
  };
}

/**
 * Analyze inventory patterns
 */
function analyzeInventory(products, orders) {
  if (!products || products.length === 0) {
    return {
      trendStrength: 0,
      dataQuality: 0,
      message: 'Insufficient product data',
    };
  }

  // Calculate product performance
  const productPerformance = {};
  orders.forEach(order => {
    if (order.line_items) {
      order.line_items.forEach(item => {
        const productId = item.product_id?.toString();
        if (productId) {
          if (!productPerformance[productId]) {
            productPerformance[productId] = {
              quantity: 0,
              revenue: 0,
            };
          }
          productPerformance[productId].quantity += item.quantity || 0;
          productPerformance[productId].revenue += parseFloat(item.price || 0) * (item.quantity || 0);
        }
      });
    }
  });

  // Find low stock products
  const lowStockProducts = products.filter(p => {
    const totalQuantity = p.variants?.reduce((sum, v) => sum + parseInt(v.inventory_quantity || 0), 0) || 0;
    return totalQuantity < 10 && totalQuantity > 0;
  });

  // Find out of stock products
  const outOfStockProducts = products.filter(p => {
    const totalQuantity = p.variants?.reduce((sum, v) => sum + parseInt(v.inventory_quantity || 0), 0) || 0;
    return totalQuantity === 0;
  });

  // Calculate average inventory value
  const totalInventoryValue = products.reduce((sum, p) => {
    const variants = p.variants || [];
    return sum + variants.reduce((vSum, v) => {
      return vSum + (parseFloat(v.price || 0) * parseInt(v.inventory_quantity || 0));
    }, 0);
  }, 0);

  const avgInventoryValue = products.length > 0 ? totalInventoryValue / products.length : 0;

  return {
    totalProducts: products.length,
    lowStockCount: lowStockProducts.length,
    outOfStockCount: outOfStockProducts.length,
    averageInventoryValue: Math.round(avgInventoryValue * 100) / 100,
    productPerformance,
    dataQuality: Math.min(products.length / 50, 1), // Quality based on product count
  };
}

/**
 * Analyze customer behavior
 */
function analyzeCustomerBehavior(customers, orders) {
  if (!customers || customers.length === 0 || !orders || orders.length === 0) {
    return {
      trendStrength: 0,
      dataQuality: 0,
      message: 'Insufficient customer/order data',
    };
  }

  // Calculate customer lifetime value
  const customerOrders = {};
  orders.forEach(order => {
    const customerId = order.customer?.id?.toString();
    if (customerId) {
      if (!customerOrders[customerId]) {
        customerOrders[customerId] = {
          orderCount: 0,
          totalSpent: 0,
        };
      }
      customerOrders[customerId].orderCount += 1;
      customerOrders[customerId].totalSpent += parseFloat(order.total_price || 0);
    }
  });

  // Calculate average order value
  const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
  const avgOrderValue = orders.length > 0 ? totalRevenue / orders.length : 0;

  // Calculate repeat customer rate
  const repeatCustomers = Object.values(customerOrders).filter(co => co.orderCount > 1).length;
  const repeatRate = Object.keys(customerOrders).length > 0 
    ? repeatCustomers / Object.keys(customerOrders).length 
    : 0;

  // Calculate average customer lifetime value
  const customerLTVs = Object.values(customerOrders).map(co => co.totalSpent);
  const avgLTV = customerLTVs.length > 0 
    ? customerLTVs.reduce((sum, ltv) => sum + ltv, 0) / customerLTVs.length 
    : 0;

  return {
    totalCustomers: customers.length,
    customersWithOrders: Object.keys(customerOrders).length,
    repeatCustomerRate: Math.round(repeatRate * 10000) / 100, // Percentage
    averageOrderValue: Math.round(avgOrderValue * 100) / 100,
    averageLTV: Math.round(avgLTV * 100) / 100,
    dataQuality: Math.min(customers.length / 100, 1), // Quality based on customer count
  };
}
