/**
 * Standard API Response Format
 *
 * Provides consistent response structure across all API endpoints.
 */

/**
 * Standard API response structure
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta?: {
    total?: number;
    page?: number;
    limit?: number;
    hasMore?: boolean;
  };
}

/**
 * Pagination parameters
 */
export interface PaginationParams {
  page?: number;
  limit?: number;
  offset?: number;
}

/**
 * Create a success response
 */
export function success<T>(
  data: T,
  meta?: ApiResponse<T>["meta"],
): ApiResponse<T> {
  const response: ApiResponse<T> = { success: true, data };
  if (meta) {
    response.meta = meta;
  }
  return response;
}

/**
 * Create a paginated success response
 */
export function paginated<T>(
  data: T[],
  options: {
    total: number;
    page: number;
    limit: number;
  },
): ApiResponse<T[]> {
  return {
    success: true,
    data,
    meta: {
      total: options.total,
      page: options.page,
      limit: options.limit,
      hasMore: options.page * options.limit < options.total,
    },
  };
}

/**
 * Create an error response
 */
export function error(
  code: string,
  message: string,
  details?: unknown,
): ApiResponse<never> {
  const errorObj: ApiResponse<never>["error"] = { code, message };
  if (details !== undefined) {
    errorObj!.details = details;
  }
  return { success: false, error: errorObj };
}

/**
 * Common error codes
 */
export const ErrorCodes = {
  // Authentication & Authorization
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  INVALID_TOKEN: "INVALID_TOKEN",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",

  // Validation
  BAD_REQUEST: "BAD_REQUEST",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_INPUT: "INVALID_INPUT",
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",

  // Resources
  NOT_FOUND: "NOT_FOUND",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  CONFLICT: "CONFLICT",

  // Rate Limiting
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",

  // Server Errors
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  DATABASE_ERROR: "DATABASE_ERROR",
  EXTERNAL_SERVICE_ERROR: "EXTERNAL_SERVICE_ERROR",

  // Broker Specific
  BROKER_NOT_CONNECTED: "BROKER_NOT_CONNECTED",
  BROKER_AUTH_EXPIRED: "BROKER_AUTH_EXPIRED",
  BROKER_SYNC_FAILED: "BROKER_SYNC_FAILED",

  // Subscription
  SUBSCRIPTION_REQUIRED: "SUBSCRIPTION_REQUIRED",
  SUBSCRIPTION_EXPIRED: "SUBSCRIPTION_EXPIRED",
  FEATURE_NOT_AVAILABLE: "FEATURE_NOT_AVAILABLE",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
