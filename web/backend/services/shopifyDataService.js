import shopifyApi from '../config/shopify.js';
import { decrypt } from '../utils/encryption.js';
import { handleShopifyRateLimit, getRateLimitInfo } from '../utils/shopifyApiHelper.js';
import prisma from '../config/database.js';

export async function fetchShopifyData(shop) {
  console.log(`🛍️ [Shopify] Starting Admin API fetch for ${shop.shopDomain}`);
  const accessToken = decrypt(shop.accessToken);
  const session = {
    shop: shop.shopDomain,
    accessToken: accessToken,
  };

  const client = new shopifyApi.clients.Rest({ session });

  try {
    // Fetch products (Core for Audit Engine)
    const products = await fetchProducts(client);
    
    // Fetch collections for Ghost Listing detection (Phase 2.5)
    let collectionMap = new Map();
    try {
      collectionMap = await fetchCollections(client);
      console.log(`🧾 [Shopify] Built collection map with ${collectionMap.size} products for ${shop.shopDomain}`);
    } catch (collError) {
      console.error(`⚠️ [Shopify] Could not fetch collections for ${shop.shopDomain}:`, collError);
    }
    
    // Fetch orders (Optional Layer for Performance Insights)
    let orders = [];
    try {
      orders = await fetchOrders(client);
      console.log(`🧾 [Shopify] Fetched ${orders.length} orders for ${shop.shopDomain}`);
    } catch (orderError) {
      console.warn(`⚠️ [Shopify] Could not fetch orders for ${shop.shopDomain}. Check read_orders scope.`);
    }
    
    console.log(
      `🧾 [Shopify] Completed Admin API fetch for ${shop.shopDomain}: ` +
        `${products?.length || 0} products, ${orders.length} orders`
    );
    return {
      products,
      orders,
      collectionMap,
      fetchedAt: new Date(),
    };
  } catch (error) {
    if (error.response?.code === 401 || error.status === 401 || error.statusCode === 401) {
      console.error(`❌ [Shopify] Unauthorized (401) for ${shop.shopDomain}. This usually means the access token is expired or invalid.`);
      console.error(`💡 ACTION REQUIRED: Please re-install the app on your store to refresh the authorization.`);
      
      // Mark shop as needing re-auth (optional, but good for UI)
      await prisma.shop.update({
        where: { id: shop.id },
        data: { isActive: false }
      });
    }
    
    console.error(`Error fetching Shopify data for ${shop.shopDomain}:`, error);
    throw error;
  }
}

/**
 * Fetch products with pagination
 */
async function fetchProducts(client) {
  const products = [];
  let pageInfo = null;

  do {
    const params = {
      limit: 250,
    };

    if (pageInfo) {
      params.page_info = pageInfo;
    }

    // Use rate limit handling wrapper
    const response = await handleShopifyRateLimit(async () => {
      return await client.get({
        path: 'products',
        query: params,
      });
    });
    
    // Log rate limit info for monitoring
    if (response.headers) {
      const rateLimitInfo = getRateLimitInfo(response.headers);
      if (rateLimitInfo.remaining !== null && rateLimitInfo.remaining < 10) {
        console.warn(`⚠️ Low Shopify API rate limit remaining: ${rateLimitInfo.remaining}/${rateLimitInfo.limit}`);
      }
    }

    if (response.body?.products) {
      products.push(...response.body.products);
    }

    const linkHeader = response.headers?.link;
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>; rel="next"/);
      if (match) {
        const url = new URL(match[1]);
        pageInfo = url.searchParams.get('page_info');
      } else {
        pageInfo = null;
      }
    } else {
      pageInfo = null;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  } while (pageInfo);

  return products;
}

/**
 * Fetch orders (Last 60 days)
 */
async function fetchOrders(client) {
  const orders = [];
  let pageInfo = null;

  // We only care about orders from the last 60 days for current trends
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

  do {
    const params = {
      limit: 250,
      status: 'any',
      created_at_min: sixtyDaysAgo.toISOString(),
    };

    if (pageInfo) {
      params.page_info = pageInfo;
    }

    const response = await handleShopifyRateLimit(async () => {
      return await client.get({
        path: 'orders',
        query: params,
      });
    });

    if (response.body?.orders) {
      orders.push(...response.body.orders);
    }

    const linkHeader = response.headers?.link;
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>; rel="next"/);
      pageInfo = match ? new URL(match[1]).searchParams.get('page_info') : null;
    } else {
      pageInfo = null;
    }
  } while (pageInfo);

  return orders;
}

/**
 * Fetch all custom and smart collections, then fetch their products to build product->collection mapping
 */
async function fetchCollections(client) {
  const collections = [];
  
  // 1. Fetch Custom Collections
  let pageInfo = null;
  do {
    const params = { limit: 250, fields: 'id,title' };
    if (pageInfo) params.page_info = pageInfo;

    try {
      const response = await handleShopifyRateLimit(async () => {
        return await client.get({
          path: 'custom_collections',
          query: params,
        });
      });

      if (response.body?.custom_collections) {
        collections.push(...response.body.custom_collections);
      }

      const linkHeader = response.headers?.link;
      pageInfo = linkHeader && linkHeader.includes('rel="next"')
        ? new URL(linkHeader.match(/<([^>]+)>; rel="next"/)[1]).searchParams.get('page_info')
        : null;
    } catch (e) {
      console.error(`⚠️ Error fetching custom collections:`, e);
      pageInfo = null;
    }
  } while (pageInfo);

  // 2. Fetch Smart Collections
  pageInfo = null;
  do {
    const params = { limit: 250, fields: 'id,title' };
    if (pageInfo) params.page_info = pageInfo;

    try {
      const response = await handleShopifyRateLimit(async () => {
        return await client.get({
          path: 'smart_collections',
          query: params,
        });
      });

      if (response.body?.smart_collections) {
        collections.push(...response.body.smart_collections);
      }

      const linkHeader = response.headers?.link;
      pageInfo = linkHeader && linkHeader.includes('rel="next"')
        ? new URL(linkHeader.match(/<([^>]+)>; rel="next"/)[1]).searchParams.get('page_info')
        : null;
    } catch (e) {
      console.error(`⚠️ Error fetching smart collections:`, e);
      pageInfo = null;
    }
  } while (pageInfo);

  console.log(`🛍️ [Shopify] Found ${collections.length} total collections (custom + smart)`);

  // Cap collection fetching to avoid excessive API requests (max 50 collections)
  const cappedCollections = collections.slice(0, 50);
  if (collections.length > 50) {
    console.warn(`⚠️ Store has ${collections.length} collections. Capping fetch at 50 to avoid rate limit issues.`);
  }

  const collectionMap = new Map(); // Map<string, string[]> (productId -> collectionIds)

  // 3. For each collection, fetch its product IDs
  for (const collection of cappedCollections) {
    let collPageInfo = null;
    do {
      const params = { limit: 250, fields: 'id' };
      if (collPageInfo) params.page_info = collPageInfo;

      try {
        const response = await handleShopifyRateLimit(async () => {
          return await client.get({
            path: `collections/${collection.id}/products`,
            query: params,
          });
        });

        if (response.body?.products) {
          for (const p of response.body.products) {
            const pId = String(p.id);
            if (!collectionMap.has(pId)) {
              collectionMap.set(pId, []);
            }
            collectionMap.get(pId).push(String(collection.id));
          }
        }

        const linkHeader = response.headers?.link;
        collPageInfo = linkHeader && linkHeader.includes('rel="next"')
          ? new URL(linkHeader.match(/<([^>]+)>; rel="next"/)[1]).searchParams.get('page_info')
          : null;
      } catch (e) {
        console.error(`⚠️ Error fetching products for collection ${collection.id}:`, e);
        collPageInfo = null;
      }
      
      // Delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (collPageInfo);
  }

  return collectionMap;
}
