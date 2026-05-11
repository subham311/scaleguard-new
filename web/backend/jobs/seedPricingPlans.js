import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const pricingPlans = [
  {
    name: 'Light',
    price: 19,
    description: 'Essential audit checks for new stores getting started.',
    maxProducts: 20,
    imagesPerProduct: 2,
    auditType: 'BASIC',
    scanFrequency: 'WEEKLY',
    features: [
      'Basic catalog audit',
      'Weekly sync',
      'Top 5 issues flagged',
      'Standard support'
    ],
    isPopular: false,
    isActive: true
  },
  {
    name: 'Growth',
    price: 49,
    description: 'Advanced checks and priority fixes to scale fast.',
    maxProducts: 75,
    imagesPerProduct: 3,
    auditType: 'FULL',
    scanFrequency: 'CONTINUOUS',
    features: [
      'Advanced catalog & visual audit',
      'Daily sync',
      'Priority fix recommendations',
      'Smart insights',
      'Priority support'
    ],
    isPopular: true,
    isActive: true
  },
  {
    name: 'Pro',
    price: 99,
    description: 'Full-suite readiness engine for high-volume merchants.',
    maxProducts: 200,
    imagesPerProduct: 4,
    auditType: 'DEEPER',
    scanFrequency: 'FASTER',
    features: [
      'Real-time audit engine',
      'Custom rule configurations',
      'Product-level drilldown'
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