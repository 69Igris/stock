/**
 * Worker entrypoint — PURE startup-decision helpers (no Hono server / no Pub/Sub).
 *
 * `index.ts` boots a real HTTP server and (conditionally) starts the local pull
 * subscriber at module load, so it can never be imported in a unit test without
 * leaking handles. The startup DECISIONS that are regression-prone live here as
 * side-effect-free functions; `index.ts` imports and CALLS them, so the
 * production code path and the tests execute the SAME code (no shadow).
 *
 * @see workers/src/index.ts (caller)
 * @see apps/web/__tests__/workers/index-logic.test.ts (tests the real exports)
 */

/**
 * The env vars `shouldEnablePullSubscriber` reads (a narrow, testable slice).
 *
 * The index signature keeps the type assignable from `NodeJS.ProcessEnv` (which
 * has one) so `index.ts` can pass `process.env` straight in; the named keys
 * document exactly which vars the decision actually consults.
 */
export interface PullSubscriberEnv {
  /** Explicit override flag — "true" force-enables in any environment. */
  ENABLE_PULL_SUBSCRIBER?: string;
  /** Node environment ("development" is the only auto-enable trigger here). */
  NODE_ENV?: string;
  /** Pub/Sub environment ("local" auto-enables; "qa"/"prod" never do). */
  PUBSUB_ENV?: string;
  /** GCP project — required for the auto-enable path (can't subscribe without it). */
  GCP_PROJECT_ID?: string;
  /** Any other env var (keeps this assignable from `process.env`). */
  [key: string]: string | undefined;
}

/**
 * Decide whether the LOCAL pull subscriber should start (MONEY-807).
 *
 * The pull subscriber is a competing consumer: if a DEPLOYED worker (Cloud Run,
 * which receives Pub/Sub PUSH) also auto-creates pull subscriptions, it STEALS
 * push messages from itself. The old logic auto-enabled whenever `NODE_ENV` was
 * NOT in {production, qa} — so a worker booting with an unset/odd `NODE_ENV`
 * (e.g. "" or "staging") silently auto-subscribed in a real environment.
 *
 * This keys off a POSITIVE local signal instead:
 *   - `ENABLE_PULL_SUBSCRIBER === "true"` → always on (explicit operator opt-in);
 *   - OTHERWISE on ONLY when it's a genuinely-local boot
 *     (`NODE_ENV === "development"` OR `PUBSUB_ENV === "local"`) AND a
 *     `GCP_PROJECT_ID` is present (you can't subscribe without it).
 *
 * Fail-CLOSED: any unrecognised env ("", "staging", "qa", "production", "prod")
 * does NOT auto-enable, so a deployed worker never steals its own push traffic.
 */
export function shouldEnablePullSubscriber(env: PullSubscriberEnv): boolean {
  if (env.ENABLE_PULL_SUBSCRIBER === "true") return true;
  const isLocalEnv =
    env.NODE_ENV === "development" || env.PUBSUB_ENV === "local";
  return isLocalEnv && !!env.GCP_PROJECT_ID;
}
