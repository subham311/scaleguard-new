/**
 * Enhanced Error Handling Middleware
 */

export class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message, fields = {}) {
    super(message, 400);
    this.fields = fields;
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403);
  }
}

/**
 * Standardized error response handler
 */
export function errorHandler(err, req, res, next) {
  // Log error
  const errorDetails = {
    message: err.message,
    statusCode: err.statusCode || 500,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
  };

  // Log operational errors at info level, programming errors at error level
  if (err.isOperational !== false) {
    console.error('⚠️ Operational Error:', errorDetails);
  } else {
    console.error('❌ Programming Error:', errorDetails);
  }

  // Don't leak error details in production
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  // Handle Prisma errors
  if (err.code === 'P1001') {
    // Database connection error
    return res.status(503).json({
      error: 'Database connection failed',
      message: 'Unable to connect to the database. Please try again in a few moments.',
      ...(isDevelopment && { 
        details: {
          code: err.code,
          host: err.meta?.database_host,
          port: err.meta?.database_port,
          hint: 'Check if DATABASE_URL is correct and database server is running'
        }
      }),
    });
  }

  if (err.code === 'P2002') {
    return res.status(409).json({
      error: 'Duplicate entry',
      message: 'A record with this value already exists',
      ...(isDevelopment && { details: err.meta }),
    });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({
      error: 'Not found',
      message: 'The requested record was not found',
    });
  }

  // Handle validation errors
  if (err instanceof ValidationError) {
    return res.status(400).json({
      error: 'Validation error',
      message: err.message,
      fields: err.fields,
    });
  }

  // Handle custom AppErrors
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(isDevelopment && { stack: err.stack }),
    });
  }

  // Handle unknown errors
  const statusCode = err.statusCode || 500;
  const message = statusCode === 500 && !isDevelopment
    ? 'Internal server error'
    : err.message || 'Internal server error';

  res.status(statusCode).json({
    error: message,
    ...(isDevelopment && { 
      stack: err.stack,
      details: errorDetails,
    }),
  });
}

/**
 * Async handler wrapper to catch errors in async routes
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 404 Not Found handler
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`,
  });
}
