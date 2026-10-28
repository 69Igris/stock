/**
 * The OIDC skip decision for `/jobs/*`, extracted so it can be tested for real.
 *
 * This is the single most security-sensitive branch in the worker: it decides
 * whether an unauthenticated POST can trigger any of the ~35 job processors with
 * an arbitrary payload.
 *
 * MONEY-288 (security audit) found verification gated behind
 * `NODE_ENV === "production"`, so QA Cloud Run accepted unauthenticated POSTs to
 * every `/jobs/*` route. The fix made it always-on for any deployed environment,
 * with one explicit opt-out for genuine local development — where Pub/Sub cannot
 * reach localhost and jobs arrive via the pull subscriber instead, so there is no
 * HTTP auth context to check.
 *
 * It lives in its own module because the test that covered it was a SHADOW: it
 * imported nothing and re-declared the middleware inline, so deleting the real
 * gate in `index.ts` left the suite green. A fail-open regression here is
 * exactly the class of bug a shadow cannot see.
 */

/**
 * Environments that are deployed and therefore ALWAYS require a token.
 *
 * Kept for documentation and for the test that pins QA's membership; the
 * DECISION is now driven by `LOCAL_ENVS` below, because an allow-list of
 * deployed envs fails OPEN on anything it does not recognise.
 */
export const DEPLOYED_ENVS = ["production", "qa"] as const;

/**
 * The ONLY environments in which HTTP OIDC may be skipped, and only then with
 * the pull subscriber explicitly enabled.
 *
 * An empty/unset NODE_ENV is deliberately NOT here: "I do not know what this is"
 * must never authorise skipping auth on a route family that can trigger ~35 job
 * processors with an arbitrary payload.
 */
export const LOCAL_ENVS = ["development", "test", "local"] as const;

export interface OidcSkipInput {
  /** `process.env.NODE_ENV` */
  nodeEnv: string | undefined;
  /** `process.env.ENABLE_PULL_SUBSCRIBER` */
  enablePullSubscriber: string | undefined;
}

/**
 * True only in genuine local development with the pull subscriber active.
 *
 * Both conditions are required, and the deployed check comes first: an operator
 * setting `ENABLE_PULL_SUBSCRIBER=true` on a QA or prod service must NOT be able
 * to turn HTTP auth off.
 */
export function shouldSkipHttpOidc(input: OidcSkipInput): boolean {
  // INVERTED: skip only when the env is EXPLICITLY local, never merely because
  // we failed to recognise it.
  //
  // The previous form asked "is this one of production|qa?" and, if not, allowed
  // the pull-subscriber opt-out. That is an allow-list, so any deployed service
  // whose NODE_ENV is neither — unset, "staging", a typo, or a Cloud Build
  // substitution that did not expand — plus ENABLE_PULL_SUBSCRIBER=true would
  // skip OIDC on every /jobs/* route. `cloudbuild.yaml` sets NODE_ENV from a
  // build substitution matched against a hard-coded list, so "unrecognised" is a
  // realistic state rather than a hypothetical one. MONEY-288 was this exact
  // class: verification gated on `NODE_ENV === "production"` left QA open.
  //
  // Both conditions are now positive requirements: the env must be a KNOWN local
  // one AND the pull subscriber must be active. Anything else requires a token.
  const isKnownLocal = (LOCAL_ENVS as readonly string[]).includes(
    (input.nodeEnv ?? "").toLowerCase(),
  );
  if (!isKnownLocal) return false;
  return input.enablePullSubscriber === "true";
}

// ── The middleware itself ────────────────────────────────────────────────

/**
 * Minimal shape of the pieces of a Hono context this gate touches.
 *
 * Declared structurally rather than importing Hono's types so the gate can be
 * driven directly by a test with a plain object — no server, no sockets, no
 * route table.
 */
export interface JobsAuthContext {
  req: { header(name: string): string | undefined };
  json(body: unknown, status: number): unknown;
}

export interface JobsAuthDeps {
  /** `process.env.NODE_ENV` at construction time. */
  nodeEnv: string | undefined;
  /** `process.env.ENABLE_PULL_SUBSCRIBER` at construction time. */
  enablePullSubscriber: string | undefined;
  /** `process.env.CLOUD_RUN_URL` — the expected OIDC audience. */
  audience: string | undefined;
  /** Verifies the token; rejects on anything invalid. */
  verifyIdToken(args: { idToken: string; audience: string }): Promise<unknown>;
  /** Injected so tests do not print, and so prod keeps its console.error. */
  logError?: (message: string, err?: unknown) => void;
}

/**
 * Build the `/jobs/*` auth middleware.
 *
 * This is a FACTORY, and that is the entire point.
 *
 * The decision function `shouldSkipHttpOidc` was already extracted and unit
 * tested — and the gate was still trivially defeatable, because nothing tested
 * the CALL SITE. Two mutations left the whole workers suite green at exit 0:
 *
 *   1. appending `|| process.env.ENABLE_PULL_SUBSCRIBER === "true"` to the
 *      `skipHttpOidc` expression in `index.ts`. `shouldSkipHttpOidc` itself is
 *      untouched, so its unit tests still pass — including the one named
 *      "cannot be disabled on a deployed env by an env var";
 *   2. changing `if (!skipHttpOidc)` to `if (false)`, which disables OIDC on all
 *      ~43 `/jobs/*` routes while every string the wiring test greps for
 *      (`shouldSkipHttpOidc(`, `Unauthorized: missing token`, `verifyIdToken`,
 *      `CLOUD_RUN_URL`) is still present.
 *
 * A source scan cannot close that; only executing the real middleware can. With
 * the composition inside this function, both mutations now have to be made HERE,
 * where the behavioural tests run them.
 *
 * MONEY-288 was this class: verification gated on `NODE_ENV === "production"`
 * left QA accepting unauthenticated POSTs to every job processor.
 */
export function createJobsAuthMiddleware(deps: JobsAuthDeps) {
  const skip = shouldSkipHttpOidc({
    nodeEnv: deps.nodeEnv,
    enablePullSubscriber: deps.enablePullSubscriber,
  });
  const logError = deps.logError ?? (() => {});

  return async function jobsAuth(
    c: JobsAuthContext,
    next: () => Promise<void>,
  ): Promise<unknown> {
    if (!skip) {
      const token = c.req.header("Authorization")?.replace("Bearer ", "");
      if (!token) {
        return c.json({ error: "Unauthorized: missing token" }, 401);
      }
      // A missing audience must FAIL, not skip verification: verifying against
      // an undefined audience would accept any Google-signed token, including
      // one minted for an unrelated service.
      if (!deps.audience) {
        logError("CLOUD_RUN_URL not set - cannot verify OIDC token");
        return c.json({ error: "Server misconfigured" }, 500);
      }
      try {
        await deps.verifyIdToken({ idToken: token, audience: deps.audience });
      } catch (err) {
        logError("OIDC token verification failed:", err);
        return c.json({ error: "Unauthorized: invalid token" }, 401);
      }
    }
    await next();
    return undefined;
  };
}
