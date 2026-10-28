/**
 * MONEY-1142 — `/v1` premium endpoints enforce the tier, not just auth.
 *
 * MONEY-1142 closed a client-only paywall on `apps/web`. It did NOT cover
 * `apps/api`, and a review caught it: `v1/risk.ts`, `v1/tax.ts` and
 * `v1/documents.ts` did `const userId = c.get("userId")` and went straight to
 * the service. A FREE user holding a valid Clerk JWT could curl `/v1/risk` and
 * get the full premium analysis — the same hole one surface over, and worse,
 * because there is no PageGuard even nominally in the way.
 *
 * `v1/learning.ts` already returned 403 for an unentitled plan, so the pattern
 * existed; this was omission. It also violated the standing rule that apps/api
 * stays in sync with the server actions — which is exactly the rule that exists
 * to stop a fix landing on one surface only.
 *
 * The completeness case at the bottom is the durable half: it derives the
 * premium route list from the WEB `PAGE_TO_FEATURE_MAP` rather than a hand
 * -maintained copy, so a new premium feature cannot be gated on web and
 * forgotten here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
);
const REPO = join(API_SRC, "..", "..", "..");

/** LINE before BLOCK — MONEY-1143. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function routeSrc(file: string): string {
  return stripComments(readFileSync(join(API_SRC, "routes/v1", file), "utf8"));
}

/** `/v1` route file → the Feature it must assert. */
const GATED: Array<{ file: string; feature: string }> = [
  { file: "risk.ts", feature: "riskAnalysis" },
  { file: "tax.ts", feature: "taxAnalysis" },
  { file: "documents.ts", feature: "documentVault" },
];

describe("MONEY-1142 — /v1 premium endpoints are tier-gated", () => {
  for (const { file, feature } of GATED) {
    it(`${file} asserts ${feature}`, () => {
      const code = routeSrc(file);
      assert.match(
        code,
        new RegExp(`isEntitled\\([\\s\\S]{0,40}?"${feature}"\\)`),
        `v1/${file} must check ${feature} — a valid JWT is not an entitlement`,
      );
    });

    it(`${file} gates EVERY authenticated handler`, () => {
      // Gating one handler and not its siblings is the shape of the original
      // bug: the write is locked, the read that returns the same data is not.
      const code = routeSrc(file);
      const auths = (code.match(/c\.get\("userId"\)/g) ?? []).length;
      const gates = (code.match(/isEntitled\(/g) ?? []).length;
      assert.ok(auths > 0, "sanity: the scan found the handlers");
      assert.equal(
        gates,
        auths,
        `${auths} authenticated handler(s) but ${gates} gate(s) in v1/${file}`,
      );
    });
  }

  it("the gate fails CLOSED", () => {
    const code = stripComments(
      readFileSync(join(API_SRC, "lib/premium-gate.ts"), "utf8"),
    );
    assert.match(
      code,
      /catch[\s\S]{0,80}?return false/,
      "a failed subscription lookup must deny — failing open during a Mongo " +
        "blip hands premium data to whoever asks",
    );
    // Raw planId, not the access view that collapses unknown legacy ids to FREE.
    assert.match(code, /getSubscription/);
    assert.doesNotMatch(code, /getSubscriptionAccess/);
  });

  it("denies with 403 and a subscription-specific code", () => {
    for (const { file } of GATED) {
      const code = routeSrc(file);
      assert.match(
        code,
        /ErrorCodes\.SUBSCRIPTION_REQUIRED[\s\S]{0,80}?403/,
        `v1/${file} should deny with 403 SUBSCRIPTION_REQUIRED so a client can ` +
          `tell "upgrade" apart from "you are logged out"`,
      );
    }
  });

  /**
   * The durable guard: derive the premium set from the WEB map, so a feature
   * gated on web cannot be silently missed here. This is the check that would
   * have caught the original omission.
   */
  it("[completeness] every premium route gated on web is gated here too", () => {
    const mapPath = join(REPO, "apps/web/lib/constants/page-features.ts");
    assert.ok(existsSync(mapPath), "could not find PAGE_TO_FEATURE_MAP");
    const map = readFileSync(mapPath, "utf8");
    const body = map.slice(map.indexOf("PAGE_TO_FEATURE_MAP"));
    const premium = [...body.matchAll(/"(\/[^"]+)":\s*"([a-zA-Z]+)"/g)].map(
      (m) => ({ route: m[1]!, feature: m[2]! }),
    );
    assert.ok(premium.length >= 5, "the map's shape changed");

    // Routes with no `/v1` equivalent, or enforced by another mechanism.
    // Each needs a reason, not just an entry.
    const NO_V1_EQUIVALENT = new Set([
      "/strategies", // no /v1 route exists
      "/quizzes", // no /v1 route exists
      "/sage-tutor", // quota-metered via the chat path, not a binary gate
      "/learning", // v1/learning gates in the SERVICE (getLessonById)
    ]);

    const gatedFiles = new Set(GATED.map((g) => g.file.replace(".ts", "")));
    const missing = premium
      .filter((p) => !NO_V1_EQUIVALENT.has(p.route))
      .filter((p) => !gatedFiles.has(p.route.replace(/^\//, "")))
      .map((p) => `${p.route} (${p.feature})`);

    assert.deepEqual(
      missing,
      [],
      "these routes are premium on web but have no asserted /v1 gate. Add the " +
        "route file to GATED and gate it, or add it to NO_V1_EQUIVALENT with a " +
        "reason — apps/api must not drift from the server actions",
    );
  });
});
