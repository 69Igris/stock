/**
 * Verify/repair scripts must COMPUTE the verdict they print — MONEY-1238.
 *
 * Five scripts printed a conclusion that nothing calculated and no caller could
 * observe. Each is a different flavour of the same defect:
 *
 *   - `verify-chart-series`   branched only on `unexplainedBoundary.length`, so
 *                             analysing NOTHING printed "the re-parse is a safe
 *                             swap"; `invalid candles` and `duplicate dates`
 *                             were summed and dropped.
 *   - `verify-instrument-classification`  computed a `pass` flag per assertion
 *                             and a `sumsMatch`, serialised them to JSON, and
 *                             set no exit code — in its DEFAULT mode, while its
 *                             sibling `compare` mode does set one.
 *   - `fix-missing-sectors`   printed `Sum: X (should be Y)` and never compared.
 *   - `repair-instrument-names`  printed `N remaining (expected M)` under a
 *                             comment saying "Verify against the database
 *                             rather than trusting the counter".
 *   - `repair-stock-ratios-links`  "verified" with `take: 5`, so orphans past
 *                             row five printed "OK — query succeeded"; and its
 *                             STILL-FAILING branch exited 0 like the OK one.
 *
 * ## A note on how these assertions are written
 *
 * An earlier draft of the sibling backfill guard used an unbounded lazy span
 * (`/if \(\s*failedWindows[\s\S]*?process\.exitCode = 1;/`) and was VACUOUS: it
 * began inside one block and ran through several others, so the captured text
 * still contained the token a mutation had just deleted. It passed against
 * mutated source and only the mutation run exposed it. Every match below is
 * therefore bounded — a fixed-size window, or a class that cannot cross the
 * delimiter it is scanning for.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");

/** LINE comments first, then BLOCK — MONEY-1143. */
const strip = (rel: string): string =>
  readFileSync(join(REPO, rel), "utf8")
    .replace(/^[^\S\r\n]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

/** Text from `needle` for `span` chars — the bounded-window idiom. */
function windowAt(src: string, needle: string, span = 400): string {
  const i = src.indexOf(needle);
  assert.notEqual(i, -1, `could not find ${JSON.stringify(needle)}`);
  return src.slice(i, i + span);
}

describe("MONEY-1238 — verify-chart-series computes its verdict", () => {
  const CODE = strip("scripts/data/verify-chart-series.ts");

  it("verdict RETURNS a result instead of void", () => {
    assert.match(
      CODE,
      /function verdict\(reports: SymbolReport\[\]\): boolean \{/,
      "a verdict nothing can observe is not a verdict",
    );
  });

  it("analysing nothing is not a clean bill of health", () => {
    // A typo'd --symbols, an empty master, or a filter matching no rows all
    // produce `found = []`, hence zero jumps, hence the green message.
    assert.match(
      windowAt(CODE, "if (found.length === 0)", 500),
      /return false;/,
      "zero analysed symbols must not report success",
    );
  });

  it("invalid candles and duplicate dates decide, not just print", () => {
    assert.match(
      windowAt(CODE, "return unexplainedBoundary.length === 0", 200),
      /badCandles === 0 && dupDates === 0/,
      "counted-but-ignored integrity failures must fail the verdict",
    );
  });

  it("the caller wires the verdict to the exit code", () => {
    assert.match(CODE, /if \(!verdict\(reports\)\) process\.exitCode = 1;/);
  });
});

describe("MONEY-1238 — verify-instrument-classification's assert mode decides", () => {
  const CODE = strip("scripts/data/verify-instrument-classification.ts");

  it("every pass/sumsMatch flag is collected and gates the exit", () => {
    // These flags existed and were serialised into the JSON output; nothing
    // read them. scripts/README.md claims this script "asserts" its result.
    const w = windowAt(CODE, "const failures: string[] = []", 600);
    assert.match(
      w,
      /o\.pass === false/,
      "a failed assertion must be collected",
    );
    assert.match(
      w,
      /o\.sumsMatch === false/,
      "a sum mismatch must be collected",
    );
    assert.match(
      w,
      /process\.exitCode = 1;/,
      "failures must set the exit code",
    );
  });
});

describe("MONEY-1238 — the three repair scripts verify what they claim", () => {
  it("fix-missing-sectors compares the sum it prints", () => {
    const CODE = strip("scripts/data/fix-missing-sectors.ts");
    assert.match(
      windowAt(CODE, "if (sum !== instruments.length)", 400),
      /process\.exitCode = 1;/,
      "`(should be N)` must be asserted, not narrated",
    );
  });

  it("repair-instrument-names compares remaining against expected", () => {
    const CODE = strip("scripts/data/repair-instrument-names.ts");
    assert.match(
      windowAt(CODE, "if (remaining !== expected)", 500),
      /process\.exitCode = 1;/,
      "the database count and the run's own accounting must be compared",
    );
  });

  it("repair-stock-ratios-links resolves EVERY row, not the first five", () => {
    const CODE = strip("scripts/ops/repair-stock-ratios-links.ts");
    // A dangling required relation throws when its row is RESOLVED, so a
    // limited query only proves the rows it happened to fetch are healthy.
    const q = windowAt(CODE, "await prisma.stockRatios.findMany", 400);
    assert.doesNotMatch(
      q,
      /take: \d+/,
      "the verification query must not be limited — orphans hide past the limit",
    );
    assert.match(
      CODE,
      /const check = all\.slice\(0, 5\)/,
      "sample after, not before",
    );
  });

  it("repair-stock-ratios-links fails the run when the query still throws", () => {
    const CODE = strip("scripts/ops/repair-stock-ratios-links.ts");
    assert.match(
      windowAt(CODE, "STILL FAILING", 600),
      /process\.exitCode = 1;/,
      "`OK` and `STILL FAILING` must not be the same outcome to a caller",
    );
  });
});
