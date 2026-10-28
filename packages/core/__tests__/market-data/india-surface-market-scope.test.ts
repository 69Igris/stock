/**
 * MONEY-1263 — India-facing universe queries must carry a venue scope.
 *
 * `instrument_mappings` became a SHARED table when the US master started
 * writing to it, and the measured consequence was that the Indian ETF page
 * would fill with US names at roughly 14:1 (~7,600 active US ETFs against
 * India's ~541) — no error, no exception, just a page about a different
 * country.
 *
 * THAT PREMISE IS NOW DEAD: MONEY-980 moved US listings into their own
 * `us_instruments` collection, so this table is India-only again and the
 * 14:1 number describes a state that no longer exists.
 *
 * The test STAYS, and not out of sentiment. The venue clause it enforces does
 * two things the split does not: it excludes the NFO / BFO / MCX rows Kite's
 * dump writes into this same table, so an unscoped equity or ETF query still
 * returns F&O and commodity contracts; and it is what makes a future
 * re-sharing a non-event rather than a repeat. A guard whose original hazard
 * was removed is worth keeping only when it still catches something — this one
 * does, and the sentence above now says which.
 *
 * A STRUCTURAL test rather than a behavioural one, because the failure needs no
 * bug to appear: it arrives the first night the master job runs, in code nobody
 * touched. The scan therefore reads the source of the real query sites.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { INDIA_DISCOVER_EXCHANGES } from "../../src/market-data/instruments/types";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/** Every file that selects the instrument universe for an India surface. */
const SURFACES = [
  "packages/services/src/discover-market.service.ts",
  "packages/services/src/discover.service.ts",
  "packages/services/src/screener.service.ts",
  "apps/web/lib/screener/match-score.ts",
  "apps/web/lib/actions/discover-indices.ts",
];

/** A `where: { ... }` object literal, roughly — brace-matched from `where:`. */
function whereBlocks(src: string): string[] {
  const out: string[] = [];
  const re = /where:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

describe("India surfaces scope the shared instrument table", () => {
  test("the files this scans actually exist (a blind scan proves nothing)", () => {
    for (const rel of SURFACES) {
      assert.ok(existsSync(join(ROOT, rel)), `missing surface file: ${rel}`);
    }
  });

  test("finds the universe selects it is supposed to police", () => {
    // Without this, deleting or renaming every query would leave the suite
    // green while the surfaces went unprotected.
    let found = 0;
    for (const rel of SURFACES) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      for (const block of whereBlocks(src)) {
        if (
          block.includes("FUND_INSTRUMENT_TYPES") ||
          block.includes("wantedTypes")
        ) {
          found++;
        }
      }
    }
    assert.ok(found >= 5, `scan matched only ${found} universe selects`);
  });

  test("EVERY universe select carries an exchange scope", () => {
    const offenders: string[] = [];
    for (const rel of SURFACES) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      for (const block of whereBlocks(src)) {
        const selectsUniverse =
          block.includes("FUND_INSTRUMENT_TYPES") ||
          block.includes("wantedTypes");
        if (!selectsUniverse) continue;
        // Either the shared constant or an explicit Indian venue list. Both are
        // correct; the constant is preferred because it states the rule once.
        const scoped =
          block.includes("INDIA_DISCOVER_EXCHANGES") ||
          /exchange:\s*\{\s*in:\s*\[\s*"NSE"\s*,\s*"BSE"\s*\]/.test(block);
        if (!scoped) {
          offenders.push(`${rel}: ${block.slice(0, 140).replace(/\s+/g, " ")}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "an India surface selects the instrument universe with no venue clause. " +
        "Since the US master shares this table, that query returns US rows — " +
        "silently, and in the majority. Add " +
        "`exchange: { in: [...INDIA_DISCOVER_EXCHANGES] }`.\n  " +
        offenders.join("\n  "),
    );
  });

  test("the scope names Indian venues only", () => {
    assert.deepEqual([...INDIA_DISCOVER_EXCHANGES], ["NSE", "BSE"]);
    for (const ex of INDIA_DISCOVER_EXCHANGES) {
      assert.ok(
        !["NASDAQ", "NYSE", "AMEX", "BATS", "NMFQS"].includes(ex),
        `${ex} is a US venue and must never be in the India scope`,
      );
    }
  });
});
