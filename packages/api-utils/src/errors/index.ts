/**
 * API Error Classes
 *
 * Custom error classes for consistent error handling across the API.
 */

import { ErrorCode, ErrorCodes } from "../response";

/**
 * Base API Error
 */
export class ApiError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number = 500,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toJSON() {
    const result: { code: ErrorCode; message: string; details?: unknown } = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) {
      result.details = this.details;
    }
    return result;
  }
}

/**
 * 400 Bad Request - Validation errors
 */
export class ValidationError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(ErrorCodes.VALIDATION_ERROR, message, 400, details);
    this.name = "ValidationError";
  }
}

/**
 * 401 Unauthorized - Authentication required
 */
export class UnauthorizedError extends ApiError {
  constructor(message: string = "Authentication required") {
    super(ErrorCodes.UNAUTHORIZED, message, 401);
    this.name = "UnauthorizedError";
  }
}

/**
 * 403 Forbidden - Access denied
 */
export class ForbiddenError extends ApiError {
  constructor(message: string = "Access denied") {
    super(ErrorCodes.FORBIDDEN, message, 403);
    this.name = "ForbiddenError";
  }
}

/**
 * 404 Not Found - Resource not found
 */
export class NotFoundError extends ApiError {
  constructor(resource: string = "Resource") {
    super(ErrorCodes.NOT_FOUND, `${resource} not found`, 404);
    this.name = "NotFoundError";
  }
}

/**
 * 409 Conflict - Resource already exists
 */
export class ConflictError extends ApiError {
  constructor(message: string = "Resource already exists") {
    super(ErrorCodes.CONFLICT, message, 409);
    this.name = "ConflictError";
  }
}

/**
 * 429 Too Many Requests - Rate limit exceeded
 */
export class RateLimitError extends ApiError {
  public readonly retryAfter?: number;

  constructor(retryAfter?: number) {
    super(
      ErrorCodes.RATE_LIMIT_EXCEEDED,
      "Too many requests. Please try again later.",
      429,
    );
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

/**
 * 500 Internal Server Error
 */
export class InternalError extends ApiError {
  constructor(message: string = "An unexpected error occurred") {
    super(ErrorCodes.INTERNAL_ERROR, message, 500);
    this.name = "InternalError";
  }
}

/**
 * 503 Service Unavailable
 */
export class ServiceUnavailableError extends ApiError {
  constructor(service: string = "Service") {
    super(
      ErrorCodes.SERVICE_UNAVAILABLE,
      `${service} is currently unavailable`,
      503,
    );
    this.name = "ServiceUnavailableError";
  }
}

/**
 * Broker-specific errors
 */
export class BrokerNotConnectedError extends ApiError {
  constructor(broker?: string) {
    const message = broker
      ? `${broker} broker is not connected`
      : "No broker connected";
    super(ErrorCodes.BROKER_NOT_CONNECTED, message, 400);
    this.name = "BrokerNotConnectedError";
  }
}

export class BrokerAuthExpiredError extends ApiError {
  constructor(broker: string) {
    super(
      ErrorCodes.BROKER_AUTH_EXPIRED,
      `${broker} authentication has expired. Please reconnect.`,
      401,
    );
    this.name = "BrokerAuthExpiredError";
  }
}

export class BrokerSyncFailedError extends ApiError {
  constructor(broker: string, reason?: string) {
    const message = reason
      ? `Failed to sync ${broker}: ${reason}`
      : `Failed to sync ${broker} data`;
    super(ErrorCodes.BROKER_SYNC_FAILED, message, 500);
    this.name = "BrokerSyncFailedError";
  }
}

/**
 * Subscription-specific errors
 */
export class SubscriptionRequiredError extends ApiError {
  constructor(feature: string = "This feature") {
    super(
      ErrorCodes.SUBSCRIPTION_REQUIRED,
      `${feature} requires an active subscription`,
      403,
    );
    this.name = "SubscriptionRequiredError";
  }
}

export class FeatureNotAvailableError extends ApiError {
  constructor(feature: string, requiredPlan: string) {
    super(
      ErrorCodes.FEATURE_NOT_AVAILABLE,
      `${feature} is available on the ${requiredPlan} plan and above`,
      403,
    );
    this.name = "FeatureNotAvailableError";
  }
}

/**
 * Check if an error is an ApiError
 */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * Convert any error to an ApiError
 */
export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new InternalError(error.message);
  }

  return new InternalError("An unknown error occurred");
}
