import prisma from '../config/database.js';
import { decrypt } from '../utils/encryption.js';

async function checkToken() {
  try {
    const shop = await prisma.shop.findFirst({
      orderBy: { createdAt: 'desc' }
    });

    if (!shop) {
      console.log('No shop found');
      return;
    }

    console.log('Shop:', shop.shopDomain);
    console.log('Encrypted Token Length:', shop.accessToken.length);
    
    try {
      const token = decrypt(shop.accessToken);
      console.log('Decrypted Token Prefix:', token.substring(0, 10));
      console.log('Decrypted Token Length:', token.length);
      console.log('Starts with shpat_:', token.startsWith('shpat_'));
    } catch (e) {
      console.log('Decryption failed:', e.message);
    }
  } catch (err) {
    console.error('Script error:', err);
  }
}

checkToken().then(() => process.exit());
