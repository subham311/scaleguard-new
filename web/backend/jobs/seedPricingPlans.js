import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const pricingPlans = [
  {
    name: 'Light',
    price: 19.99,
    description: 'Essential commercial risk checks for new stores getting started.',
    maxProducts: 20,
    imagesPerProduct: 2,
    auditType: 'BASIC',
    scanFrequency: 'WEEKLY',
    features: [
      'Store Readiness Audit',
      'Data Quality Analysis',
      'Visual Trust Detection',
      'Catalog Consistency Checks',
      'Up to 20 Products Monitored',
      '2 Images Analyzed Per Product',
      'Weekly Audits',
      'Readiness Score'
    ],
    isPopular: false,
    isActive: true
  },
  {
    name: 'Growth',
    price: 49.99,
    description: 'Advanced commercial risk detection and priority fixes to scale fast.',
    maxProducts: 75,
    imagesPerProduct: 3,
    auditType: 'FULL',
    scanFrequency: 'CONTINUOUS',
    features: [
      'Commercial Risk Intelligence',
      'Product-Level Recommendations',
      'Conversion Risk Detection',
      'Inventory Anomaly Detection',
      'Up to 75 Products Monitored',
      '3 Images Analyzed Per Product',
      'Daily Audits',
      'Priority Fix Queue'
    ],
    isPopular: true,
    isActive: true
  },
  {
    name: 'Pro',
    price: 99.0,
    description: 'Full-suite commercial intelligence engine for high-volume merchants.',
    maxProducts: 200,
    imagesPerProduct: 5,
    auditType: 'DEEPER',
    scanFrequency: 'FASTER',
    features: [
      'Full Catalog Intelligence',
      'Advanced Risk Detection',
      'Product-Level Drilldown',
      'Commercial Scaling Verdict',
      'Up to 200 Products Monitored',
      '4 Images Analyzed Per Product',
      'Audits Every 3 Hours',
      'Safe-To-Scale Assessment'
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