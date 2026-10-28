/**
 * MONEY-1134 — the entitlement cache is dropped on every PLAN/STATUS change.
 *
 * `apps/web/lib/subscription/access-cache.ts` caches the resolved entitlement
 * for 60s and ~30 PageGuard-ed routes read it. `clearSubscriptionCache(userId)`
 * deletes `subscription:{userId}:*`, which includes that entry — but it used to
 * be called from exactly ONE place, the Dodo payment callback. So an upgrade
 * arriving by webhook, a scheduled plan change, a cancellation, or an expiry
 * collapse all mutated the row while the cache kept serving the OLD answer.
 *
 * The asymmetry is what makes it worth a test rather than a shrug: a stale
 * UPGRADE means a paying user waits a minute; a stale DOWNGRADE or cancellation
 * means a revoked user keeps premium access for the window.
 *
 * Source-level, because these mutations reach Prisma + Redis and the suite has
 * no live instance of either.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const SRC = readFileSync(join(SRC_DIR, "subscription.service.ts"), "utf8");
/** The shared helper, extracted out of subscription.service.ts. */
const HELPER = readFileSync(
  join(SRC_DIR, "entitlement-invalidation.ts"),
  "utf8",
);

/**
 * Every service that WRITES a plan or status, and must therefore invalidate.
 *
 * The first pass at MONEY-1134 covered only `subscription.service.ts` and
 * declared the gap closed. A review then found 17 further mutation sites across
 * these other files — the Dodo webhook path and the scheduled-change cron,
 * i.e. three of the four scenarios that commit itself named as fixed.
 * Hard-coding three function names in ONE file is what made that invisible, so
 * this list plus the completeness case at the bottom is the actual guard.
 */
const MUTATING_SERVICES = [
  "subscription.service.ts",
  "subscription-grants.service.ts",
  "scheduled-plan-changes.service.ts",
] as const;

/** LINE before BLOCK — MONEY-1143. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const CODE = stripComments(SRC);

/** Body of an exported function, up to the next top-level export. */
function bodyOf(name: string): string {
  const start = CODE.indexOf(`export async function ${name}`);
  assert.ok(start > -1, `could not locate ${name}`);
  const rest = CODE.slice(start + 1);
  const end = rest.indexOf("\nexport ");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("MONEY-1134 — entitlement cache invalidation", () => {
  it("[meta] stripComments cannot swallow the code under assertion", () => {
    const fixture = [
      "// mentions tours/* which opens nothing",
      'const KEEP = "invalidateEntitlement";',
      "/* a real block */",
    ].join("\n");
    const stripped = stripComments(fixture);
    assert.match(stripped, /KEEP/);
    assert.doesNotMatch(stripped, /a real block/);
  });

  for (const fn of [
    "updateSubscriptionPlan",
    "cancelSubscription",
    "downgradeWithGracePeriod",
  ]) {
    it(`[regression] ${fn} invalidates the cached entitlement`, () => {
      assert.match(
        bodyOf(fn),
        /invalidateEntitlement\(userId\)/,
        `${fn} changes the plan or status, so the cached entitlement it ` +
          `contradicts must be dropped — otherwise ~30 guarded routes serve ` +
          `the old answer for the TTL`,
      );
    });
  }

  it("the invalidation is best-effort and cannot fail the mutation", () => {
    // The row is already written by the time we get here. Throwing would turn
    // a successful plan change into a failed one over a cache blip.
    assert.match(stripComments(HELPER), /try\s*\{[\s\S]{0,200}?catch/);
  });

  it("credit debits deliberately do NOT invalidate", () => {
    // Guards the over-correction. Usage counters are in the cached payload, but
    // nothing GATES on the cached copy — `consumeAIQuery` reads Prisma directly
    // and the debit is a conditional `updateMany` that re-asserts the quota at
    // write time. Invalidating here would negate the cache on its hottest path
    // to freshen a display counter.
    for (const fn of ["consumeAIQuery", "refundAIQuery"]) {
      assert.doesNotMatch(
        bodyOf(fn),
        /invalidateEntitlement\(/,
        `${fn} runs on every AI query — invalidating there defeats the cache ` +
          `entirely, and buys no safety because enforcement is atomic at write`,
      );
    }
  });

  it("there is ONE invalidation helper, not a call scattered per site", () => {
    // The original bug was a single call site that nobody remembered to copy.
    // A helper keeps the policy (and its logging) in one place.
    // ONE definition, in its own module — living inside subscription.service.ts
    // is what stopped the other three services from being able to call it.
    assert.equal(
      (
        stripComments(HELPER).match(
          /export async function invalidateEntitlement/g,
        ) ?? []
      ).length,
      1,
    );
    assert.match(stripComments(HELPER), /clearSubscriptionCache\(userId\)/);
    for (const file of MUTATING_SERVICES) {
      const code = stripComments(readFileSync(join(SRC_DIR, file), "utf8"));
      assert.doesNotMatch(
        code,
        /async function invalidateEntitlement/,
        `${file} must IMPORT the shared helper, not redefine it`,
      );
    }
  });

  /**
   * The durable guard. Any service that writes `subscription.{update,upsert,
   * updateMany,create}` must also invalidate — otherwise the cached entitlement
   * outlives the decision, and the revocation direction lets a cancelled user
   * keep premium for the TTL.
   */
  it("[completeness] every service that mutates a subscription invalidates", () => {
    const offenders: string[] = [];
    for (const file of MUTATING_SERVICES) {
      const code = stripComments(readFileSync(join(SRC_DIR, file), "utf8"));
      const writes = (
        code.match(/subscription\.(update|upsert|updateMany|create)\b/g) ?? []
      ).length;
      const invalidations = (code.match(/invalidateEntitlement\(/g) ?? [])
        .length;
      if (writes > 0 && invalidations === 0) {
        offenders.push(
          `${file}: ${writes} subscription write(s), 0 invalidations`,
        );
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "these services mutate a subscription without dropping the cached " +
        "entitlement — a cancelled or downgraded user keeps access for the TTL",
    );
  });
});
