/**
 * META TEST — a credits fraction must compare like with like (MONEY-1199).
 *
 * ## The bug
 *
 * The StockSage chat popover rendered:
 *
 *   {totalCreditsRemaining} / {creditsLimit} credits     ->  "2750 / 200"
 *
 * A remaining count larger than the limit, which is not a number that can
 * exist. The two fields answer different questions and both are correct:
 *
 *   totalCreditsRemaining   plan remaining + PACK remaining
 *   creditsLimit            the plan's allowance ALONE
 *   packCreditsLimit        the purchased pack allowance, separately
 *
 * So the numerator spanned both allowances and the denominator only one. Fixed
 * by summing `creditsLimit + packCreditsLimit`.
 *
 * ## Why a guard
 *
 * The field names do not warn you. `creditsLimit` reads like the limit for
 * `totalCreditsRemaining`, and for every user WITHOUT a query pack the two
 * agree exactly — so the display is correct until the moment someone buys a
 * pack, and no test that uses a pack-free fixture will ever see it.
 *
 * The rule: any file that renders `totalCreditsRemaining` against a limit must
 * also read `packCreditsLimit`. Files that show the remaining count alone
 * (ChatMessage's badge, ChatPromptArea's counter) are unaffected — there is no
 * denominator to mismatch.
 *
 * Source: apps/web/components/chat/options/PromptOptionsPopover.tsx
 *         apps/web/lib/chat/ChatContext.tsx
 *         packages/services/src/subscription-logic.ts (buildSubscriptionAccess)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..");

/** Every .tsx/.ts under app/, components/ and lib/. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  for (const d of ["app", "components", "lib"]) walk(join(WEB, d));
  return out;
}

describe("MONEY-1199 — credits fractions compare like with like", () => {
  it("[meta] the scanner sees the file the bug was in", () => {
    // A walker that found nothing would report a clean codebase and be
    // indistinguishable from a fixed one.
    const files = sourceFiles();
    assert.ok(files.length > 200, `only ${files.length} files — walker broken`);
    assert.ok(
      files.some((f) => f.endsWith("PromptOptionsPopover.tsx")),
      "PromptOptionsPopover.tsx not found — the walker misses the chat options"
    );
  });

  it("any file pairing remaining WITH a limit also reads packCreditsLimit", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("totalCreditsRemaining")) continue;
      // Only files that actually form a fraction can mismatch; a bare
      // remaining-count badge has no denominator.
      if (!src.includes("creditsLimit")) continue;
      if (!src.includes("packCreditsLimit")) {
        offenders.push(file.slice(WEB.length + 1));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "these read totalCreditsRemaining (plan + PACK remaining) alongside " +
        "creditsLimit (plan allowance ONLY) without packCreditsLimit. That " +
        'renders an impossible fraction like "2750 / 200" for any user who ' +
        "bought a query pack. The denominator must be " +
        "creditsLimit + packCreditsLimit"
    );
  });

  it("[regression] the popover's denominator sums both allowances", () => {
    // Named explicitly rather than left to the scan: this is the exact site
    // that shipped wrong, and the tempting "fix" for a future reader who sees
    // remaining > limit is to clamp the numerator instead of widening the
    // denominator — which would hide the pack credits the user paid for.
    const src = readFileSync(
      join(WEB, "components/chat/options/PromptOptionsPopover.tsx"),
      "utf8"
    );
    assert.match(
      src,
      /creditsLimit \?\? 0\) \+\s*\(subscriptionAccess\?\.packCreditsLimit/,
      "the popover must add packCreditsLimit to creditsLimit for its denominator"
    );
  });
});
