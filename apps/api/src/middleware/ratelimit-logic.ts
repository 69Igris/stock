/**
 * Rate-limit pure logic
 *
 * The client-identification, window/counter, and 429-shaping logic of the
 * rate-limit middleware extracted here as pure, testable functions so the
 * security-relevant behaviour (hash-based client id, NOT a truncation) is
 * tested against the REAL source instead of an inline copy.
 *
 * `ratelimit.ts` imports and calls these — there are NO dead exports.
 *
 * @see apps/api/__tests__/middleware/ratelimit.test.ts
 */

/** A single client's window state. */
export interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/** Headers/body the middleware should emit for a processed request. */
export interface RateLimitResult {
  allowed: boolean;
  status?: 429;
  body?: {
    success: false;
    error: { code: string; message: string };
  };
  headers: Record<string, string>;
}

/** Subset of request headers used to derive a client id. */
export interface RateLimitRequestInfo {
  authorizationHeader?: string;
  xForwardedFor?: string;
  xRealIP?: string;
}

export const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
export const RATE_LIMIT_MAX_REQUESTS = 100; // 100 requests per minute
export const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Derive a stable client identifier from request headers.
 *
 * SECURITY: when an Authorization header longer than `"Bearer "` is present we
 * hash the FULL bearer token (plus its length) rather than truncating it to a
 * fixed prefix. Truncation (e.g. `substring(7, 20)`) collapses every token that
 * shares the same first 13 chars — JWTs share a long constant header — into one
 * bucket, letting many users share (and exhaust) a single rate-limit window.
 *
 * Falls back to the first `X-Forwarded-For` IP, then `X-Real-IP`, then
 * `"anonymous"`.
 */
export function getClientId(req: RateLimitRequestInfo): string {
  const authHeader = req.authorizationHeader;
  if (authHeader && authHeader.length > 7) {
    const token = authHeader.substring(7);
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
    }
    return `auth_${hash.toString(36)}_${token.length}`;
  }
  return req.xForwardedFor?.split(",")[0] || req.xRealIP || "anonymous";
}

/**
 * In-memory fixed-window rate limiter.
 *
 * The real middleware owns a single module-level instance; tests construct
 * their own isolated instances. `now` is injectable so the window/expiry logic
 * is deterministic without faking timers.
 */
export class RateLimiter {
  private readonly requestCounts = new Map<string, RateLimitEntry>();

  /** Record a request for `clientId` and return the rate-limit decision. */
  processRequest(clientId: string, now: number = Date.now()): RateLimitResult {
    const clientData = this.requestCounts.get(clientId);
    const headers: Record<string, string> = {};

    if (!clientData || now > clientData.resetTime) {
      // New window
      this.requestCounts.set(clientId, {
        count: 1,
        resetTime: now + RATE_LIMIT_WINDOW_MS,
      });
    } else if (clientData.count >= RATE_LIMIT_MAX_REQUESTS) {
      // Rate limit exceeded
      const retryAfter = Math.ceil((clientData.resetTime - now) / 1000);
      headers["Retry-After"] = retryAfter.toString();
      headers["X-RateLimit-Limit"] = RATE_LIMIT_MAX_REQUESTS.toString();
      headers["X-RateLimit-Remaining"] = "0";
      headers["X-RateLimit-Reset"] = clientData.resetTime.toString();

      return {
        allowed: false,
        status: 429,
        body: {
          success: false,
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: `Too many requests. Please retry after ${retryAfter} seconds.`,
          },
        },
        headers,
      };
    } else {
      clientData.count++;
    }

    const data = this.requestCounts.get(clientId)!;
    headers["X-RateLimit-Limit"] = RATE_LIMIT_MAX_REQUESTS.toString();
    headers["X-RateLimit-Remaining"] = (
      RATE_LIMIT_MAX_REQUESTS - data.count
    ).toString();
    headers["X-RateLimit-Reset"] = data.resetTime.toString();

    return { allowed: true, headers };
  }

  /** Drop entries whose window has expired; returns the number removed. */
  cleanup(now: number = Date.now()): number {
    let cleaned = 0;
    for (const [key, value] of this.requestCounts.entries()) {
      if (now > value.resetTime) {
        this.requestCounts.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }

  /** Current number of tracked clients (for tests/introspection). */
  getEntryCount(): number {
    return this.requestCounts.size;
  }

  /** Clear all tracked clients. */
  reset(): void {
    this.requestCounts.clear();
  }
}
