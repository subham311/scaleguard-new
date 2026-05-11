import shopifyApi from '../config/shopify.js';
import { decrypt } from '../utils/encryption.js';
import { handleShopifyRateLimit, getRateLimitInfo } from '../utils/shopifyApiHelper.js';

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
