import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const pricingPlans = [
  {
    name: 'Light',
    price: 19,
    description: 'Essential commercial risk checks for new stores getting started.',
    maxProducts: 20,
    imagesPerProduct: 2,
    auditType: 'BASIC',
    scanFrequency: 'WEEKLY',
    features: [
      'Up to 20 products analyzed per audit',
      '2 images analyzed per product',
      'Basic catalog audit (pricing, descriptions, images)',
      'Weekly sync & risk scan',
      'Top 5 risk issues flagged',
      'Standard support'
    ],
    isPopular: false,
    isActive: true
  },
  {
    name: 'Growth',
    price: 49,
    description: 'Advanced commercial risk detection and priority fixes to scale fast.',
    maxProducts: 75,
    imagesPerProduct: 3,
    auditType: 'FULL',
    scanFrequency: 'CONTINUOUS',
    features: [
      'Up to 75 products analyzed per audit',
      '3 images analyzed per product',
      'Continuous delta-monitoring',
      'Inventory anomaly detection (lazy imports, ghost listings)',
      'Niche consistency & fragmentation checks',
      'Priority fix recommendations',
      'Priority support'
    ],
    isPopular: true,
    isActive: true
  },
  {
    name: 'Pro',
    price: 99,
    description: 'Full-suite commercial intelligence engine for high-volume merchants.',
    maxProducts: 200,
    imagesPerProduct: 4,
    auditType: 'DEEPER',
    scanFrequency: 'FASTER',
    features: [
      'Up to 200 products analyzed per audit',
      '4 images analyzed per product',
      'Deeper commercial risk audit',
      'Price positioning & variance intelligence',
      'Performance-layer risk detection',
      'Product-level drilldown',
      'Dedicated support'
    ],
    isPopular: false,
    isActive: true
  }
];

export async function seedPricingPlans() {
  try {
    console.log('🌱 Seeding pricing plans...');
    for (const plan of pricingPlans) {
      await prisma.pricingPlan.upsert({
        where: { name: plan.name },
        update: plan,
        create: plan,
      });
    }
    console.log('✅ Pricing plans seeded successfully');
  } catch (error) {
    console.error('❌ Error seeding pricing plans:', error);
  }
}