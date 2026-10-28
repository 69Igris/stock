/**
 * Auth middleware pure logic
 *
 * Bearer-token extraction, the 401 response body, and the
 * verify→check-sub→set-context decision flow extracted as pure, testable
 * functions so the auth contract (which inputs are rejected, that internal
 * verifier errors never leak to the client) is tested against the REAL source
 * instead of an inline copy.
 *
 * `auth.ts` imports and calls these — there are NO dead exports.
 *
 * @see apps/api/__tests__/middleware/auth.test.ts
 */

/** Minimal shape of a verified Clerk JWT payload we depend on. */
export interface TokenPayload {
  sub?: string;
  [key: string]: unknown;
}

/** Standard 401 body shape. */
export interface UnauthorizedBody {
  success: false;
  error: { code: "UNAUTHORIZED"; message: string };
}

/** Outcome of running the required-auth decision flow. */
export interface AuthDecision {
  /** `true` → call `next()`; `false` → respond with `status`/`body`. */
  authorized: boolean;
  status?: 401;
  body?: UnauthorizedBody;
  /**
   * The Clerk subject (raw JWT `sub`) from the verified token — NOT an internal
   * user id. The middleware (`auth.ts`) resolves THIS to the internal Mongo user
   * `_id` itself (via `resolveUserId`) and stores that resolved id as
   * `c.get("userId")`; this field only ever carries the Clerk sub it starts
   * from. (MONEY-1062: renamed from the misleading `userId`, which held the
   * Clerk sub and was never consumed as a Mongo id.)
   */
  clerkUserId?: string;
}

/**
 * Extract the bearer token from an `Authorization` header.
 *
 * Returns `null` for a missing header or any scheme other than `"Bearer "`
 * (case-sensitive). For `"Bearer "` with no token this returns `""` — the same
 * substring the production middleware passes to `verifyToken`, which then fails
 * verification. (The extraction never trims; trailing/embedded spaces are kept
 * verbatim, matching `substring(7)`.)
 */
export function extractBearerToken(
  authHeader: string | undefined | null,
): string | null {
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.substring(7);
}

/** Build the standard 401 response body (never includes verifier internals). */
export function buildUnauthorizedBody(message: string): UnauthorizedBody {
  return {
    success: false,
    error: { code: "UNAUTHORIZED", message },
  };
}

/**
 * Run the required-auth decision flow.
 *
 * On success returns `{ authorized: true, clerkUserId }`, where `clerkUserId`
 * is the verified token's Clerk subject (`sub`) — the Clerk sub, NOT an internal
 * user id. The caller (`auth.ts`) resolves it to the Mongo `_id` itself.
 *
 * @param authHeader  raw `Authorization` header value.
 * @param verifyToken async verifier (Clerk's `verifyToken` in production); it
 *   MAY throw — its error is swallowed and mapped to a generic
 *   "Invalid or expired token" so sensitive details never reach the client.
 */
export async function decideAuth(
  authHeader: string | undefined | null,
  verifyToken: (token: string) => Promise<TokenPayload>,
): Promise<AuthDecision> {
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      authorized: false,
      status: 401,
      body: buildUnauthorizedBody("Missing or invalid Authorization header"),
    };
  }

  const token = authHeader.substring(7);

  try {
    const payload = await verifyToken(token);

    if (!payload.sub) {
      return {
        authorized: false,
        status: 401,
        body: buildUnauthorizedBody("Invalid token payload"),
      };
    }

    return {
      authorized: true,
      clerkUserId: payload.sub,
    };
  } catch {
    return {
      authorized: false,
      status: 401,
      body: buildUnauthorizedBody("Invalid or expired token"),
    };
  }
}

/**
 * Run the optional-auth decision flow.
 *
 * Never produces an error response: if a valid token with a `sub` is present
 * `{ clerkUserId }` is returned — the Clerk subject (`sub`), NOT an internal
 * user id — otherwise the request proceeds anonymously (`{}`). The caller
 * (`auth.ts`) resolves the Clerk sub to the internal Mongo `_id` itself.
 */
export async function decideOptionalAuth(
  authHeader: string | undefined | null,
  verifyToken: (token: string) => Promise<TokenPayload>,
): Promise<{ clerkUserId?: string }> {
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    try {
      const payload = await verifyToken(token);
      if (payload.sub) {
        return { clerkUserId: payload.sub };
      }
    } catch {
      // Ignore auth errors for optional auth.
    }
  }
  return {};
}
