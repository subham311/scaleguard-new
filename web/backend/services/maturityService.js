import prisma from '../config/database.js';

/**
 * Update shop maturity level based on data accumulation
 */
export async function updateMaturityLevel(shopId, shopifyData) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
  });

  if (!shop) {
    throw new Error(`Shop ${shopId} not found`);
  }

  const orders = shopifyData.orders || [];
  const daysSinceInstall = Math.floor(
    (new Date() - new Date(shop.installedAt)) / (1000 * 60 * 60 * 24)
  );

  let newMaturityLevel = shop.maturityLevel;

  // Maturity progression logic
  if (shop.maturityLevel === 'NEW') {
    // Move to LEARNING after 7 days and 10+ orders
    if (daysSinceInstall >= 7 && orders.length >= 10) {
      newMaturityLevel = 'LEARNING';
    }
  } else if (shop.maturityLevel === 'LEARNING') {
    // Move to STABLE after 30 days and 50+ orders
    if (daysSinceInstall >= 30 && orders.length >= 50) {
      newMaturityLevel = 'STABLE';
    }
  } else if (shop.maturityLevel === 'STABLE') {
    // Move to MATURE after 90 days and 200+ orders
    if (daysSinceInstall >= 90 && orders.length >= 200) {
      newMaturityLevel = 'MATURE';
    }
  }

  // Update if changed
  if (newMaturityLevel !== shop.maturityLevel) {
    await prisma.shop.update({
      where: { id: shopId },
      data: { maturityLevel: newMaturityLevel },
    });
    console.log(`📊 Shop ${shop.shopDomain} maturity updated: ${shop.maturityLevel} → ${newMaturityLevel}`);
  }

  return newMaturityLevel;
}
