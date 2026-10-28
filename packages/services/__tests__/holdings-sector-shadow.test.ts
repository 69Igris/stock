/**
 * MONEY-1152 — the three copies of "is this a real sector?" must agree.
 *
 * ## Why there are three, and why that is allowed
 *
 * The `"N/A"` tombstone (`SECTOR_SKIPPED`) has to be recognised in modules that
 * deliberately cannot import each other:
 *
 * - `@usemoney/core/market-data` — `hasRealSector` / `SECTOR_SKIPPED`, the
 *   canonical definition.
 * - `packages/services/src/holdings-logic.ts` — has ZERO imports on purpose, so
 *   the holdings money path's math can be unit-tested without pulling the Prisma
 *   client in at import time.
 * - `apps/web/lib/actions/sector-performance-logic.ts` — exists specifically to
 *   stay free of `@usemoney/core`, which pulls `fs`/`child_process`.
 *
 * Both constraints are real, so the duplication is real. What is not acceptable
 * is duplication that can DRIFT.
 *
 * ## What drift costs
 *
 * `holdings-logic.ts` has carried a comment warning that `sector != null` treats
 * `"N/A"` as valid since MONEY-846. Six live queries did it anyway, and the
 * measured result on QA was:
 *
 * - the `/discover` sector-performance list rendering `"N/A"` as its 3rd-largest
 *   sector — 1,296 instruments, 15.8% of the aggregate;
 * - the NSE heatmap running on 7,822 unclassified against 2,289 real.
 *
 * A warning in prose next to the code it describes did not prevent any of that.
 * These assertions are the version that fails.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SECTOR_SKIPPED as CORE_SENTINEL,
  hasRealSector,
} from "@usemoney/core/market-data";
import {
  SECTOR_SKIPPED as HOLDINGS_SENTINEL,
  isUsableSector,
} from "../src/holdings-logic";

/** Every input where the copies could plausibly disagree. */
const CASES: Array<string | null | undefined> = [
  "N/A",
  "",
  "Healthcare",
  "Financial Services",
  "Not Categorised",
  "n/a",
  " N/A ",
  null,
  undefined,
];

describe("MONEY-1152 — sector-sentinel copies agree", () => {
  it("the sentinel constants are identical", () => {
    assert.equal(
      HOLDINGS_SENTINEL,
      CORE_SENTINEL,
      "holdings-logic's SECTOR_SKIPPED drifted from core's — every consumer of " +
        "the stale one silently stops filtering the tombstone",
    );
  });

  it("holdings-logic's isUsableSector matches core's hasRealSector", () => {
    for (const input of CASES) {
      assert.equal(
        isUsableSector(input),
        hasRealSector(input),
        `disagreement on ${JSON.stringify(input)}`,
      );
    }
  });

  it("the web aggregator's private copy matches too", () => {
    // That module cannot be imported here (it is "use server"-adjacent and
    // deliberately core-free), so assert on its source: the sentinel it hard
    // -codes must be the real one.
    const src = readFileSync(
      fileURLToPath(
        new URL(
          "../../../apps/web/lib/actions/sector-performance-logic.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const m = src.match(/const SECTOR_SKIPPED_SENTINEL = "([^"]*)"/);
    assert.ok(m, "sector-performance-logic must declare its sentinel copy");
    assert.equal(
      m[1],
      CORE_SENTINEL,
      "the web aggregator's hard-coded sentinel drifted from core's",
    );
  });

  it("[regression] the tombstone is rejected by all of them", () => {
    // The single case the whole ticket is about.
    assert.equal(hasRealSector("N/A"), false);
    assert.equal(isUsableSector("N/A"), false);
  });

  it("[regression] a real sector is accepted by all of them", () => {
    // Guards the opposite failure: a predicate that rejects everything would
    // pass every "must be false" assertion above and empty the heatmap.
    assert.equal(hasRealSector("Healthcare"), true);
    assert.equal(isUsableSector("Healthcare"), true);
  });
});

describe("MONEY-1152 — no query filters sector on null alone", () => {
  /**
   * The durable half. `sector: { not: null }` reads as obviously correct, which
   * is why it recurred six times across two apps. This fails the build rather
   * than relying on the next reader noticing the comment.
   */
  const REPO = fileURLToPath(new URL("../../..", import.meta.url));

  const SCANNED = [
    "packages/services/src/discover-market.service.ts",
    "packages/services/src/discover.service.ts",
    "packages/services/src/holdings.service.ts",
    "apps/web/lib/actions/discover-heatmap.ts",
    "apps/web/lib/actions/discover-sectors.ts",
  ];

  /** LINE before BLOCK — MONEY-1143. */
  function stripComments(s: string): string {
    return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }

  for (const rel of SCANNED) {
    it(`${rel} uses REAL_SECTOR_WHERE`, () => {
      const src = stripComments(readFileSync(REPO + rel, "utf8"));
      assert.ok(
        !/sector:\s*\{\s*not:\s*null\s*\}/.test(src),
        `${rel} filters sector on null alone, which keeps the "N/A" tombstone. ` +
          `Use REAL_SECTOR_WHERE from @usemoney/core/market-data — it pairs ` +
          `not:null with notIn:[SECTOR_SKIPPED], because notIn ALONE would ` +
          `newly match documents where the field is absent`,
      );
      assert.match(
        src,
        /REAL_SECTOR_WHERE/,
        `${rel} should reference the shared filter`,
      );
    });
  }

  /**
   * The list above pins the six sites this ticket FOUND. It cannot catch the
   * seventh.
   *
   * That matters because six is how many there already were: the naive form
   * reads as obviously correct, so it kept being written independently, in two
   * apps, by people who had no reason to check a list in a test file. An
   * allow-list guard only ever protects the files someone already thought to
   * add to it.
   *
   * So this walks the source tree instead. Modelled on the MONEY-1143 meta
   * guard, which had the same shape of problem and solved it the same way.
   */
  const SOURCE_ROOTS = ["apps", "packages", "workers"];

  /** This file — it contains the pattern as a regex and in fixtures below. */
  const SELF = "packages/services/__tests__/holdings-sector-shadow.test.ts";

  function walkSource(dir: string, acc: string[] = []): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return acc;
    }
    for (const entry of entries) {
      // `dist` matters specifically: compiled output carries the old text and
      // would report violations nobody can fix in source.
      if (
        entry === "node_modules" ||
        entry === ".next" ||
        entry === "dist" ||
        entry === "build"
      ) {
        continue;
      }
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) walkSource(full, acc);
      else if (/\.tsx?$/.test(entry)) acc.push(full);
    }
    return acc;
  }

  /** The naive filter, as it appears in a Prisma `where`. */
  const NAIVE = /sector:\s*\{\s*not:\s*null\s*\}/;

  it("[meta] the walker actually reaches the source tree", () => {
    // Without this a moved directory makes the scan below vacuously pass —
    // the same "green because it looked at nothing" failure this repo keeps
    // finding.
    const files = SOURCE_ROOTS.flatMap((r) => walkSource(REPO + r));
    assert.ok(
      files.length > 500,
      `expected 500+ source files, found ${files.length} — the walker is ` +
        `broken and this guard is blind`,
    );
  });

  it("[meta] the pattern matches the naive form and not the fixed one", () => {
    // Guards the guard: a regex that matched nothing would report zero
    // violations and be indistinguishable from a clean tree.
    assert.ok(
      NAIVE.test("where: { sector: { not: null } }"),
      "must flag the naive form",
    );
    assert.ok(
      !NAIVE.test("where: { ...REAL_SECTOR_WHERE }"),
      "must not flag the shared filter",
    );
    assert.ok(
      !NAIVE.test("where: { name: { not: null } }"),
      "must not flag a not-null filter on a DIFFERENT field",
    );
  });

  it("[regression] NO source file filters sector on null alone", () => {
    const offenders: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of walkSource(REPO + root)) {
        const rel = file.slice(REPO.length);
        if (rel === SELF) continue;
        // Comments stripped so the several files that DOCUMENT this hazard
        // are not mistaken for committing it. LINE before BLOCK (MONEY-1143).
        if (NAIVE.test(stripComments(readFileSync(file, "utf8")))) {
          offenders.push(rel);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these files filter sector on null alone, which counts the "N/A" ` +
        `tombstone as a real sector — 14,893 of 22,153 instruments carry it, ` +
        `so the bucket can dominate a sector aggregate rather than merely add ` +
        `noise. Use REAL_SECTOR_WHERE from @usemoney/core/market-data, which ` +
        `pairs not:null with notIn:[SECTOR_SKIPPED]. If including unclassified ` +
        `rows is correct for your query, label them instead (see ` +
        `discover-market.service.ts mapping "N/A" -> "Not Categorised")`,
    );
  });
});
