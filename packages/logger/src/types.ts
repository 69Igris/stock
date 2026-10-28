import type pino from "pino";

/**
 * Logger module names for categorization
 */
export type LoggerModule =
  | "cache"
  | "database"
  | "api"
  | "auth"
  | "broker-sync"
  | "redis"
  | "payments"
  | "subscription"
  | "feature-flags"
  | "gemini"
  | "admin"
  | "content"
  | string; // Allow custom module names

/**
 * Log levels supported by Pino
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Logger instance type (Pino logger)
 */
export type Logger = pino.Logger;

/**
 * Base log context with common fields
 */
export interface LogContext {
  userId?: string;
  module?: LoggerModule;
  [key: string]: unknown;
}

/**
 * Error log context
 */
export interface ErrorLogContext extends LogContext {
  error: Error | unknown;
  errorMessage?: string;
  errorStack?: string;
}

/**
 * Performance log context
 */
export interface PerformanceLogContext extends LogContext {
  duration: number;
  operation: string;
}

/**
 * Cache log context
 */
export interface CacheLogContext extends LogContext {
  cacheKey?: string;
  cacheHit?: boolean;
  cacheTTL?: number;
  cacheAge?: number;
}

/**
 * Database log context
 */
export interface DatabaseLogContext extends LogContext {
  collection?: string;
  operation?: string;
  documentId?: string;
  count?: number;
}

/**
 * API log context
 */
export interface ApiLogContext extends LogContext {
  method?: string;
  path?: string;
  statusCode?: number;
  duration?: number;
}
