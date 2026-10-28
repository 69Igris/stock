/**
 * Hono app pure logic
 *
 * CORS-origin resolution and the 404 / error / root response bodies extracted
 * as pure, testable functions so the app contract (env-specific CORS allow-list,
 * and crucially that the global error handler NEVER leaks internal error
 * details) is tested against the REAL source instead of an inline copy.
 *
 * `app.ts` imports and calls these — there are NO dead exports.
 *
 * @see apps/api/__tests__/app.test.ts
 */

/** CORS allow-list inputs (defaults read from `process.env` by the caller). */
export interface CorsOriginOptions {
  nodeEnv?: string;
  webUrl?: string;
  adminUrl?: string;
}

/** 404 response body. */
export interface NotFoundBody {
  success: false;
  error: { code: "NOT_FOUND"; message: string };
}

/** Generic 500 response body (no internal details). */
export interface InternalErrorBody {
  success: false;
  error: { code: "INTERNAL_ERROR"; message: string };
}

/** Root (`GET /`) response body. */
export interface RootInfoBody {
  name: string;
  version: string;
  status: string;
  documentation: string;
}

/** CORS request methods allowed by the API. */
export const CORS_ALLOW_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

/** CORS request headers allowed by the API. */
export const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Requested-With",
] as const;

/** CORS response headers exposed to the browser. */
export const CORS_EXPOSE_HEADERS = ["X-Request-Id"] as const;

/** CORS preflight cache lifetime, in seconds. */
export const CORS_MAX_AGE = 600;

/**
 * Resolve the allowed CORS origins for the current environment.
 *
 * Always includes `webUrl`/`adminUrl` when set, plus environment-specific
 * defaults. localhost is allowed in development and QA but NEVER in
 * production/prod. The result is de-duplicated.
 */
export function getCorsOrigins(options: CorsOriginOptions = {}): string[] {
  const env = options.nodeEnv || "development";
  const origins: string[] = [];

  if (options.webUrl) origins.push(options.webUrl);
  if (options.adminUrl) origins.push(options.adminUrl);

  switch (env) {
    case "production":
    case "prod":
      origins.push(
        "https://usemoney.ai",
        "https://www.usemoney.ai",
        "https://admin.usemoney.ai",
      );
      break;
    case "qa":
      origins.push("https://qa.usemoney.ai", "https://admin.qa.usemoney.ai");
      // Allow localhost in QA for testing
      origins.push("http://localhost:3000", "http://localhost:3001");
      break;
    default:
      // Local development
      origins.push(
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:8080",
      );
  }

  return [...new Set(origins)]; // Remove duplicates
}

/** Build the 404 body for an unmatched route. */
export function buildNotFoundBody(method: string, path: string): NotFoundBody {
  return {
    success: false,
    error: {
      code: "NOT_FOUND",
      message: `Route ${method} ${path} not found`,
    },
  };
}

/**
 * Build the generic 500 body.
 *
 * SECURITY: this intentionally ignores the thrown error and always returns a
 * fixed message so DB/stack/secret details in `err.message` never reach the
 * client. The `_err` param exists only to mirror the call site.
 */
export function buildInternalErrorBody(_err?: unknown): InternalErrorBody {
  return {
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    },
  };
}

/** Build the root (`GET /`) info body. */
export function buildRootInfoBody(): RootInfoBody {
  return {
    name: "UseMoney API",
    version: "1.0.0",
    status: "operational",
    documentation: "/docs",
  };
}
