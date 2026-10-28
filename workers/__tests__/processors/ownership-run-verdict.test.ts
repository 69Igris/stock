/**
 * MONEY-1238 (#8) — a FAILED ownership verdict must be able to produce a 500.
 *
 * `decideRunStatus` returns FAILED for an empty symbol queue, missing Prisma
 * models, or "0 rows written across N non-empty payloads". None of those could
 * reach Pub/Sub: the processor was `Promise<void>` and only LOGGED the verdict,
 * and the route answered a flat `{success:true}, 200`. Its own catch-block
 * comment insisted "500 so Pub/Sub retries — a failed ownership shard is worth
 * retrying" while describing a path the verdict could never trigger.
 *
 * The fix is NOT a blanket 500. Pub/Sub redelivers on any non-2xx, so a
 * DETERMINISTIC failure would become five identical full per-symbol fan-outs
 * against NSE — the retry storm `xbrl-sync`'s `isRetriableFailure` idiom exists
 * to prevent (MONEY-1200). This pins the matrix and the route's mapping.
 *
 * Sources: workers/src/processors/ownership-sync.ts
 *          workers/src/routes/ownership-sync.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isRetriableOwnershipFailure } from "../../src/processors/ownership-sync";

type Input = Parameters<typeof isRetriableOwnershipFailure>[0];

const BASE: Input = {
  status: "FAILED",
  missingModels: [],
  queueFailures: [],
  emptyUniverseQueue: false,
  symbolsAttempted: 0,
};

// ═══════════════════════════════════════════════════════════════════════════
// The transient / deterministic matrix
// ═══════════════════════════════════════════════════════════════════════════

describe("isRetriableOwnershipFailure — only FAILED is even a candidate", () => {
  it("COMPLETED is never retried", () => {
    assert.equal(
      isRetriableOwnershipFailure({
        ...BASE,
        status: "COMPLETED",
        emptyUniverseQueue: true,
      }),
      false,
    );
  });

  it("PARTIAL is never retried — some of the run landed", () => {
    // A redelivery would repeat the whole fan-out to re-attempt the part that
    // did not, and the barren legs are already named in the sync log.
    assert.equal(
      isRetriableOwnershipFailure({
        ...BASE,
        status: "PARTIAL",
        queueFailures: ["bse"],
      }),
      false,
    );
  });
});

describe("DETERMINISTIC failures ack (200) — retrying cannot fix them", () => {
  it("missing Prisma models: absent until a schema push AND a redeploy", () => {
    // The processor deliberately keeps fetching and parsing when models are
    // missing ("so the shape counters are recorded"), so every retry pays the
    // full per-symbol NSE fan-out and still writes nothing.
    //
    // Paired with an otherwise-RETRIABLE condition on purpose. `missingModels`
    // ALONE leaves every other clause false, so the expectation held whether
    // or not the guard existed — deleting the guard did not turn this red
    // (mutation-verified, MONEY-1238). A dominance rule is only observable
    // when it has something to dominate.
    assert.equal(
      isRetriableOwnershipFailure({
        ...BASE,
        missingModels: ["ShareholdingPattern"],
        emptyUniverseQueue: true,
      }),
      false,
    );
    assert.equal(
      isRetriableOwnershipFailure({
        ...BASE,
        missingModels: ["ShareholdingPattern"],
      }),
      false,
    );
  });

  it("missing models WIN over a transient queue failure in the same run", () => {
    // Both can be true at once. The schema problem is the one that makes a
    // retry pointless, so it must dominate.
    assert.equal(
      isRetriableOwnershipFailure({
        ...BASE,
        missingModels: ["InsiderEvent"],
        queueFailures: ["bse"],
      }),
      false,
    );
  });

  it("a barren / zero-write run: same bytes, same parse, every time", () => {
    // FAILED with no queue failure and no missing model is the
    // "0 rows written across N non-empty payloads" rule. It is healed by
    // teaching the parser, not by asking NSE again.
    assert.equal(
      isRetriableOwnershipFailure({ ...BASE, symbolsAttempted: 420 }),
      false,
    );
    assert.equal(isRetriableOwnershipFailure(BASE), false);
  });
});

describe("TRANSIENT failures 500 — but only while the retry is still CHEAP", () => {
  it("a queue that could not be BUILT, before any walk, is retried", () => {
    // The BSE scrip master 403'd, or the pending-filing index threw. Both heal
    // by themselves, and the run failed before doing anything expensive.
    assert.equal(
      isRetriableOwnershipFailure({ ...BASE, queueFailures: ["bse"] }),
      true,
    );
  });

  it("a UNIVERSE query returning zero active equities is retried", () => {
    // Never a real market state — an infrastructure fault wearing the shape of
    // a serene COMPLETED with every counter at 0.
    assert.equal(
      isRetriableOwnershipFailure({ ...BASE, emptyUniverseQueue: true }),
      true,
    );
  });

  it("but NOT once the fan-out has already been spent", () => {
    // This is the whole reason the classifier is not just "was it infra?".
    // 400 symbols walked means a redelivery re-walks all 400 to re-attempt one
    // broken leg — the retry storm, at transient cause or not.
    assert.equal(
      isRetriableOwnershipFailure({
        ...BASE,
        queueFailures: ["bse"],
        symbolsAttempted: 400,
      }),
      false,
    );
    assert.equal(
      isRetriableOwnershipFailure({
        ...BASE,
        emptyUniverseQueue: true,
        symbolsAttempted: 1,
      }),
      false,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The verdict actually REACHES the wire (structural)
// ═══════════════════════════════════════════════════════════════════════════

/** LINE comments first, then BLOCK comments (repo guard, MONEY-1143). */
function stripComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const read = (...p: string[]) =>
  readFileSync(join(import.meta.dirname, "..", "..", "src", ...p), "utf8");

describe("the processor RETURNS the verdict instead of only logging it", () => {
  const SRC = stripComments(read("processors", "ownership-sync.ts"));

  it("processOwnershipSync is no longer Promise<void>", () => {
    assert.match(
      SRC,
      /export async function processOwnershipSync\(\s*data: OwnershipSyncMessage,\s*\): Promise<OwnershipRunOutcome> \{/,
    );
    assert.doesNotMatch(
      SRC,
      /export async function processOwnershipSync\([\s\S]{0,80}?\): Promise<void>/,
    );
  });

  it("the returned status is the verdict's, and retriable is classified", () => {
    assert.match(SRC, /return \{\s*status: verdict\.status,/);
    assert.match(SRC, /retriable: isRetriableOwnershipFailure\(\{/);
  });

  it("emptyUniverseQueue is the UNIVERSE rule, not the whole emptyQueue OR", () => {
    // `decideRunStatus`'s `emptyQueue` also folds in `queueFailures` and the
    // BSE-specific case. Passing that composite here would classify a
    // post-fan-out BSE failure as a cheap universe failure.
    assert.match(
      SRC,
      /emptyUniverseQueue:\s*perSymbolLegs\.length > 0 && queue\.symbols\.length === 0/,
    );
  });
});

describe("the route maps the verdict to a status code by FAILURE CLASS", () => {
  const SRC = stripComments(read("routes", "ownership-sync.ts"));

  it("it awaits an outcome rather than discarding the call's result", () => {
    assert.match(SRC, /const outcome = await processOwnershipSync\(data\);/);
  });

  it("FAILED + retriable is a 500; FAILED + deterministic is a 200", () => {
    assert.match(SRC, /if \(outcome\.status === "FAILED"\)/);
    assert.match(
      SRC,
      /if \(outcome\.retriable\)[\s\S]{0,400}?return c\.json\(\{ success: false, \.\.\.outcome \}, 500\)/,
    );
    assert.match(
      SRC,
      /return c\.json\(\{ success: false, retried: false, \.\.\.outcome \}, 200\)/,
    );
  });

  it("the FAILED branch is reached BEFORE the success 200", () => {
    const failed = SRC.indexOf('outcome.status === "FAILED"');
    const success = SRC.indexOf("{ success: true, ...outcome }");
    assert.ok(failed > 0 && success > failed, "the success 200 shadows FAILED");
  });

  it("the catch still 500s — an unhandled throw IS worth retrying", () => {
    assert.match(
      SRC,
      /catch \(error\)[\s\S]*?return c\.json\(\{ error: "Processing failed" \}, 500\)/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// passDaysAlert — wired, computed once, and READ
// ═══════════════════════════════════════════════════════════════════════════

describe("passDaysAlert is read by something, and is a single predicate", () => {
  const PROC = stripComments(read("processors", "ownership-sync.ts"));
  const ROUTE = stripComments(read("routes", "ownership-sync.ts"));

  it("the alert predicate is computed ONCE, not restated at the write site", () => {
    // It used to be evaluated for the log and AGAIN inline for the metadata
    // field 136 lines below — two copies of one rule, free to drift.
    assert.equal(
      (
        PROC.match(/passDays !== null && passDays > FULL_PASS_ALERT_DAYS/g) ??
        []
      ).length,
      1,
    );
    assert.match(
      PROC,
      /const passDaysAlert = passDays !== null && passDays > FULL_PASS_ALERT_DAYS;/,
    );
    assert.match(PROC, /if \(passDaysAlert\) \{/);
  });

  it("it is on the returned outcome, not only in the metadata blob", () => {
    // Reading `/^\s+passDaysAlert,$/m` over the WHOLE file was vacuous with
    // respect to this test's own claim (mutation-verified, MONEY-1238): the
    // metadata blob ~70 lines earlier carries an identically-shaped
    // `passDaysAlert,` line, so deleting the field from the RETURN left the
    // regex green. Slice the return object out first, bounded, and read that.
    const ret =
      /\n  return \{\n    status: verdict\.status,[\s\S]{0,900}?\n  \};/.exec(
        PROC,
      );
    assert.ok(ret, "the processor's outcome return object was not found");
    assert.match(ret[0], /^\s+passDaysAlert,$/m);
    assert.match(PROC, /passDaysAlert: boolean;/);
  });

  it("the route READS it — the flag is no longer a write with no reader", () => {
    assert.match(ROUTE, /if \(outcome\.passDaysAlert\)/);
  });
});
