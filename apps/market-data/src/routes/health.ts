/**
 * Liveness and readiness.
 *
 * ## NOTHING POLLS `/health/ready` TODAY, AND THAT IS NOT AN OVERSIGHT
 *
 * READ THIS BEFORE CITING THIS ENDPOINT AS A SAFETY NET. This header used to
 * say a 503 here takes the instance out of the load balancer's rotation. It
 * cannot, on this platform, in either of the two places that would have to do
 * it:
 *
 *   - **Cloud Run has no readiness probe.** A container may declare a
 *     `startupProbe` and a `livenessProbe` and nothing else. A failing liveness
 *     probe RESTARTS the container; it never parks it.
 *   - **A serverless NEG has no health check.** The backend service forwards to
 *     Cloud Run, which decides what to run. There is no pool to eject from.
 *
 * So this is an OPERATOR endpoint: `curl` it to ask one revision whether it can
 * actually reach Mongo and Redis, during a deploy or an incident, instead of
 * inferring it from error rates. The 503 is still the right answer to give —
 * it makes "cannot reach a dependency" unambiguous rather than something a
 * reader has to spot inside a 200 body — and it is the shape a startup probe
 * needs, which is where this is going.
 *
 * ## WHY THE STARTUP PROBE DOES NOT POINT HERE YET
 *
 * It is the one probe Cloud Run does offer that would give the intended
 * behaviour: a revision that cannot reach its dependencies never goes live, and
 * the previous revision keeps serving. Deliberately NOT wired in A1, because A1
 * answers `/udf/config` and `/udf/time` from CONSTANTS — it needs neither Mongo
 * nor Redis to be correct, so gating the deploy on them would refuse to ship a
 * service that works. A2 gives this service real reads; that is the change that
 * should move the startup probe onto `/health/ready`, together.
 *
 * `apps/api`'s ready route returns **200** with the dependency marked
 * `"unknown"`, and that is still deliberately not copied — not because of
 * rotation, but because a probe whose whole job is to report a dependency
 * failure must not answer with the success code.
 *
 * ## EACH CHECK IS BUDGETED, AND THE BUDGET IS THE POINT
 *
 * 500 ms per dependency, raced against the check itself. An unbudgeted probe
 * against a hung Mongo does not fail — it BLOCKS. Whoever is waiting on it
 * waits too: an operator with no answer, and — once the startup probe does
 * point here — a container killed for not responding rather than reported
 * unready, which is a restart loop rather than a refused revision.
 */
import { Hono } from "hono";
import {
  CACHE_CONTROL,
  READY_BUDGET_MS,
  readyStatus,
  type DependencyResult,
} from "../app-logic";

const health = new Hono();

/**
 * Liveness: is the process up? Nothing else.
 *
 * It must NOT check dependencies. A liveness probe that fails when Mongo is
 * down makes Cloud Run kill and restart every instance during a database
 * incident, turning a degraded service into no service.
 */
health.get("/live", (c) => {
  c.header("Cache-Control", CACHE_CONTROL.health);
  return c.json({ status: "ok", service: "usemoney-market-data" });
});

/** Race a check against the budget. A timeout is a FAILURE, never a pass. */
async function budgeted(
  name: string,
  check: () => Promise<unknown>,
  budgetMs: number,
): Promise<DependencyResult> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout after ${budgetMs}ms`)),
          budgetMs,
        );
      }),
    ]);
    return { name, ok: true, ms: Date.now() - started };
  } catch (err) {
    return {
      name,
      ok: false,
      ms: Date.now() - started,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // ALWAYS cleared. A pending timer keeps the event loop alive, and in a test
    // runner that is an orphaned process rather than a failing assertion.
    if (timer) clearTimeout(timer);
  }
}

export interface ReadyDeps {
  pingMongo: () => Promise<unknown>;
  pingRedis: () => Promise<unknown>;
}

/** Exported for the test: the probe's logic without a live Mongo or Redis. */
export async function runReadyChecks(
  deps: ReadyDeps,
  budgetMs: number = READY_BUDGET_MS,
): Promise<DependencyResult[]> {
  // In PARALLEL: sequential checks make the worst case the SUM of the budgets,
  // so two 500 ms budgets become a 1 s probe.
  return Promise.all([
    budgeted("mongo", deps.pingMongo, budgetMs),
    budgeted("redis", deps.pingRedis, budgetMs),
  ]);
}

health.get("/ready", async (c) => {
  c.header("Cache-Control", CACHE_CONTROL.health);

  // Imported lazily so a readiness probe is the first thing that touches the
  // clients rather than module load — a connection failure at import time
  // would kill the process before it could report itself unready.
  const deps: ReadyDeps = {
    pingMongo: async () => {
      const { prisma } = await import("@usemoney/database");
      return prisma.$runCommandRaw({ ping: 1 });
    },
    pingRedis: async () => {
      // `@usemoney/core/cache`, NOT `@usemoney/cache`. The brief names the
      // latter, but that package is key-generation utilities and types only —
      // it exports no client. The Redis client lives in core.
      //
      // `@usemoney/cache` is therefore deliberately NOT a dependency of this
      // workspace. Leaving it declared made the wrong specifier resolve
      // cleanly, so the mistake this comment warns about would have compiled
      // and then returned `undefined` at runtime. Now it fails to resolve.
      const { getRedisClient } = await import("@usemoney/core/cache");
      const client = getRedisClient();
      // `null` means UNCONFIGURED, which for a readiness probe is a failure:
      // this service caches through Redis, so an instance without one is not
      // ready to take traffic even though nothing threw.
      if (!client) throw new Error("no redis client configured");
      return client.ping();
    },
  };

  const results = await runReadyChecks(deps);
  const status = readyStatus(results);
  return c.json(
    {
      status: status === 200 ? "ready" : "not ready",
      service: "usemoney-market-data",
      checks: results,
    },
    status,
  );
});

export default health;
