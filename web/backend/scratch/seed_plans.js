import dotenv from 'dotenv';
dotenv.config();
import { seedPricingPlans } from '../jobs/seedPricingPlans.js';

console.log('Starting seed run...');
seedPricingPlans()
  .then(() => {
    console.log('Seed test completed.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Seed test failed:', err);
    process.exit(1);
  });
