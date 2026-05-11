/**
 * Input Validation Middleware
 */

import { ValidationError } from './errorHandler.js';

/**
 * Validate shop domain format
 */
export function validateShopDomain(shop) {
  if (!shop) {
    throw new ValidationError('Shop parameter is required');
  }

  const shopDomain = shop.includes('.myshopify.com') 
    ? shop 
    : `${shop}.myshopify.com`;

  // Basic validation
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
    throw new ValidationError('Invalid shop domain format');
  }

  return shopDomain;
}

/**
 * Validate plan name
 */
export function validatePlan(plan) {
  const validPlans = ['LIGHT', 'GROWTH', 'PRO'];
  
  if (!plan) {
    throw new ValidationError('Plan is required');
  }

  if (!validPlans.includes(plan.toUpperCase())) {
    throw new ValidationError(`Invalid plan. Must be one of: ${validPlans.join(', ')}`);
  }

  return plan.toUpperCase();
}

/**
 * Validate nudge ID format (UUID)
 */
export function validateNudgeId(id) {
  if (!id) {
    throw new ValidationError('Nudge ID is required');
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    throw new ValidationError('Invalid nudge ID format');
  }

  return id;
}

/**
 * Sanitize string input
 */
export function sanitizeString(input, maxLength = 1000) {
  if (typeof input !== 'string') {
    return '';
  }

  // Remove null bytes and trim
  let sanitized = input.replace(/\0/g, '').trim();

  // Limit length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }

  return sanitized;
}

/**
 * Validate pagination parameters
 */
export function validatePagination(query) {
  const limit = Math.min(parseInt(query.limit) || 10, 100); // Max 100
  const offset = Math.max(parseInt(query.offset) || 0, 0);

  return { limit, offset };
}

/**
 * Validate date range
 */
export function validateDateRange(startDate, endDate) {
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;

  if (start && isNaN(start.getTime())) {
    throw new ValidationError('Invalid start date');
  }

  if (end && isNaN(end.getTime())) {
    throw new ValidationError('Invalid end date');
  }

  if (start && end && start > end) {
    throw new ValidationError('Start date must be before end date');
  }

  return { start, end };
}

/**
 * Request body size limit middleware
 */
export function bodySizeLimit(maxSize = '1mb') {
  return (req, res, next) => {
    const contentLength = parseInt(req.get('content-length') || '0');
    const maxBytes = parseSize(maxSize);

    if (contentLength > maxBytes) {
      return res.status(413).json({
        error: 'Payload too large',
        message: `Request body exceeds maximum size of ${maxSize}`,
      });
    }

    next();
  };
}

function parseSize(size) {
  const units = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };

  const match = size.toLowerCase().match(/^(\d+)([a-z]+)$/);
  if (!match) return 1024 * 1024; // Default 1MB

  const value = parseInt(match[1]);
  const unit = match[2];

  return value * (units[unit] || 1);
}
