/**
 * Sector writers must normalise (MONEY-1093).
 *
 * FOUR runtime paths write `InstrumentMapping.sector`: sector-enrichment,
 * screener/engine, enrich-sectors-gemini and stock-sector.
 *
 * MONEY-1302 closed the gap this header used to describe. It said the file
 * covered "the two it can read as source text" and that removing normalisation
 * from sector-enrichment or stock-sector "would NOT turn it red" — and that
 * hole is exactly where the passthrough survived. Now THREE writers are scanned
 * here (engine, gemini, stock-sector) and the fourth, sector-enrichment, is
 * covered BEHAVIOURALLY in
 * `packages/core/__tests__/market-data/sector-taxonomy-write-guard.test.ts`,
 * which drives `decideFetchOutcome` — the one function both of its entry points
 * share. All four are covered; none is covered by assumption.
 *
 * The other axis — whether a writer is restricted to instrument types that may
 * carry a sector at all — is covered separately and by DISCOVERY rather than by
 * enumeration, in `packages/core/__tests__/market-data/sector-write-guard.test.ts`.
 * That split matters: an earlier pass on this ticket fixed normalisation in
 * `screener/engine.ts` and left the type filter off the same query, so the
 * writer stopped corrupting the taxonomy and carried on writing sectors onto
 * bonds. Two axes, two failures, one call site.
 *
 * Between them these writers are why prod carries 228 rows on "Other", 40 on
 * "Construction", 19 on "Real Estate", 9 on "Media & Entertainment" and 5 on
 * "Agriculture" — none of which is an NSE_SECTORS name, so none is reachable
 * from the screener's sector filter or countable in the sector chips.
 *
 *   - `screener/engine.ts#backfillMissingSectors` wrote Yahoo's raw GICS
 *     string ("Technology", "Consumer Cyclical", "Basic Materials", …) on
 *     EVERY fundamental screener request.
 *   - `scripts/data/enrich-sectors-gemini.ts` declared its OWN 18-value
 *     vocabulary — seven names not in the taxonomy — plus an "Other" escape
 *     hatch, and wrote Gemini's answer verbatim.
 *
 * That is why repairing the DATA alone would not have held: the next screener
 * run re-introduces the problem. These are static scans because both writers
 * are I/O-bound (a live Yahoo call, a live Gemini call) and the failure mode
 * is "someone removes the normalisation", which a scan catches and a mocked
 * unit test does not — the same reasoning as
 * `apps/web/__tests__/navigation/no-unguarded-url-writes.test.ts`.
 *
 * Sources: packages/core/src/screener/engine.ts,
 *          scripts/data/enrich-sectors-gemini.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAllSectorNames, normalizeToNseSector } from "../../src/market-data";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");

/** Read a repo-relative file, returning "" instead of throwing — a throw inside
 *  a describe body is reported by node as a dropped suite with `fail 0`. */
function readRepoFile(...parts: string[]): string {
  try {
    return stripComments(readFileSync(join(REPO, ...parts), "utf8"));
  } catch {
    return "";
  }
}

/**
 * Remove comments before ANY source scan.
 *
 * Every guard in this file was defeatable by quoting the required token in an
 * adjacent comment, and three of them were defeated exactly that way: removing
 * `instrumentType: "EQUITY"` from the gemini script's destructive `updateMany`
 * and naming the field in the comment above it kept the suite green, as did
 * deleting the resector's chunk loop while leaving `const CHUNK = 500` behind,
 * and removing its type re-check while quoting the clause in prose. A scan that
 * reads comments is not checking the code.
 */
function stripComments(src: string): string {
  return (
    src
      // MONEY-1143 — LINE before BLOCK; a `//` containing `/*` otherwise opens
      // a phantom block and eats the code this suite asserts is absent.
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/\/\*[\s\S]*?\*\//g, "")
  );
}
const engineSrc = readRepoFile(
  "packages",
  "core",
  "src",
  "screener",
  "engine.ts",
);
const geminiSrc = readRepoFile("scripts", "data", "enrich-sectors-gemini.ts");
const stockSectorSrc = readRepoFile(
  "apps",
  "web",
  "lib",
  "actions",
  "stock-sector.ts",
);

/** The `backfillMissingSectors` body. */
function backfillBlock(): string {
  const start = engineSrc.indexOf("async function backfillMissingSectors");
  assert.notEqual(start, -1, "backfillMissingSectors not found — did it move?");
  const end = engineSrc.indexOf("\n}", start);
  assert.notEqual(end, -1);
  return engineSrc.slice(start, end);
}

describe("sector-writer scan — liveness", () => {
  it("both sources are readable and non-trivial", () => {
    // Without this the scans below could pass vacuously on a bad path.
    assert.ok(engineSrc.length > 2000, "engine.ts unexpectedly small");
    assert.ok(geminiSrc.length > 2000, "gemini script unexpectedly small");
    assert.match(engineSrc, /backfillMissingSectors/);
    assert.match(geminiSrc, /instrumentMapping\.updateMany/);
    assert.ok(
      stockSectorSrc.length > 1000,
      "stock-sector.ts unexpectedly small",
    );
    assert.match(stockSectorSrc, /getOrEnrichSectorAction/);
  });
});

describe("writer B — screener/engine.ts#backfillMissingSectors", () => {
  // MONEY-1302 STRENGTHENED THIS, deliberately. The assertion used to require
  // `sector: normalizeToNseSector(...)`, which is NOT enough for a writer:
  // that function ends in `return rawSector`, so it maps the six known GICS
  // strings and passes every OTHER label through verbatim. This call site runs
  // on every fundamental screener request, so an unmapped label — a GICS
  // rename, a new Yahoo sector — was written raw, continuously, and the row
  // could never heal (the facet cannot reach an off-taxonomy value, and
  // enrichment only re-selects null/empty sectors). Repairing the 101 prod rows
  // without this would have let the next screener run start refilling them.
  it("routes the sector through the VALIDATING guard, not the passthrough", () => {
    assert.match(
      backfillBlock(),
      /toWritableNseSector\(/,
      "must use toWritableNseSector — normalizeToNseSector passes unmapped " +
        "labels through and this runs on every fundamental screener request",
    );
    assert.doesNotMatch(
      backfillBlock(),
      /sector:\s*normalizeToNseSector\(/,
      "the read-side passthrough must never be the value written",
    );
  });

  it("cannot write when the guard rejects — the null is checked, not coerced", () => {
    // A guard whose null is `?? rawSector`-ed, or written straight into `data`,
    // is not a guard. Pin that the rejection is BRANCHED on before the write.
    const block = backfillBlock();
    assert.match(
      block,
      /const\s+writableSector\s*=\s*toWritableNseSector\(/,
      "the guard's verdict must be bound before the write",
    );
    assert.match(
      block,
      /if\s*\(\s*writableSector\s*!==\s*null\s*\)/,
      "a null verdict must SKIP the write, not fall through to it",
    );
    assert.doesNotMatch(
      block,
      /writableSector\s*\?\?/,
      "coalescing the rejection back to a raw value defeats the guard entirely",
    );
  });

  it("does not write a bare sector variable", () => {
    assert.doesNotMatch(
      backfillBlock(),
      /data:\s*\{\s*sector\s*\}/,
      "shorthand `{ sector }` would bypass the guard",
    );
  });
});

describe("writer C — enrich-sectors-gemini.ts", () => {
  it("derives its vocabulary from the taxonomy, not a local list", () => {
    assert.match(
      geminiSrc,
      /const CANONICAL_SECTORS = getAllSectorNames\(\)/,
      "a locally-declared list is what drifted to 18 values including seven " +
        "the rest of the app cannot filter on",
    );
  });

  it("no longer accepts 'Other' as a classification", () => {
    // "Other" was the single largest passthrough bucket in prod (228 rows).
    assert.doesNotMatch(
      geminiSrc,
      /new Set\(\[\.\.\.CANONICAL_SECTORS,\s*"Other"\]\)/,
      '"Other" must not be an accepted sector',
    );
    assert.match(geminiSrc, /new Set\(CANONICAL_SECTORS\)/);
  });

  it("normalises on write", () => {
    assert.match(geminiSrc, /sector:\s*normalizeToNseSector\(c\.sector\)/);
  });

  it("instructs the model to abstain rather than guess", () => {
    // The old prompt said "make your best guess from the name", which is how
    // a bond with a company-ish name acquires a confident sector.
    assert.match(geminiSrc, /UNKNOWN/);
    assert.doesNotMatch(geminiSrc, /make your best guess/i);
  });
});

describe("writer D — apps/web stock-sector.ts#getOrEnrichSectorAction", () => {
  // MONEY-1302 ADDED THIS BLOCK. The file header used to say removing
  // normalisation from `stock-sector` "would NOT turn it red" — and that was
  // true, which is why this writer kept the passthrough long after the screener
  // one was fixed. It is the MORE exposed of the two: it fires on stock-page
  // visits rather than on fundamental screens.
  it("routes the persisted sector through the VALIDATING guard", () => {
    assert.match(
      stockSectorSrc,
      /const\s+writableSector\s*=\s*toWritableNseSector\(/,
      "must bind toWritableNseSector — normalizeToNseSector passes unmapped " +
        "labels through, and this action writes on every stock-page visit",
    );
  });

  it("skips the write on a rejection instead of falling through to it", () => {
    assert.match(
      stockSectorSrc,
      /if\s*\(\s*instrument\s*&&\s*writableSector\s*!==\s*null\s*\)/,
      "a null verdict must SKIP the updateMany",
    );
    assert.doesNotMatch(
      stockSectorSrc,
      /sector:\s*normalizedSector\s*,[\s\S]{0,80}industry,\s*\}\s*,\s*\}\s*\)/,
      "the passthrough value must not be what gets persisted",
    );
    assert.doesNotMatch(
      stockSectorSrc,
      /writableSector\s*\?\?/,
      "coalescing the rejection back to a raw value defeats the guard",
    );
  });
});

describe("the taxonomy the writers are pinned to", () => {
  it("exposes exactly the canonical NSE sectors", () => {
    const names = getAllSectorNames();
    assert.ok(names.length >= 10, "taxonomy unexpectedly small");
    // Positively pinned: Real Estate is canonical, and its NSE/screener alias
    // must NOT be (the alias belongs in YAHOO_TO_NSE_MAP, not in the sector
    // list, or the screener gets two buckets for one asset class).
    assert.ok(names.includes("Real Estate"), "Real Estate must be canonical");
    assert.ok(!names.includes("Realty"), '"Realty" is an alias, not a sector');
    // The names the Gemini script used to emit are NOT canonical — that is
    // the whole point of pinning it to this list.
    //
    // "Real Estate" was on this list and has been removed DELIBERATELY: as of
    // 2026-07-30 it is a canonical sector in its own right (founder decision,
    // MONEY-1093), split out of Financial Services. This test fired exactly as
    // designed when that happened, which is why it is worded as an instruction
    // rather than an assertion about the world. The remaining seven are still
    // free-text inventions with no home in the taxonomy.
    for (const bogus of [
      "Media & Entertainment",
      "Automobile",
      "Chemicals",
      "Textiles",
      "Construction",
      "Agriculture",
      "Other",
    ]) {
      assert.ok(
        !names.includes(bogus),
        `"${bogus}" must not be canonical — if it becomes so, update this test deliberately`,
      );
    }
  });

  it("normalizeToNseSector maps every canonical name to itself", () => {
    for (const name of getAllSectorNames()) {
      assert.equal(normalizeToNseSector(name), name);
    }
  });

  it("maps every alias to a CANONICAL name, never to a new bucket", () => {
    // MONEY-1093 — the passthrough in `normalizeToNseSector` returns an
    // unrecognised input unchanged, so any alias that is not in the mapping
    // table silently becomes its own non-canonical bucket, unreachable from
    // the screener's sector filter. "Realty" did exactly that: it is the same
    // asset class as "Real Estate" under the name NSE and Screener use, and it
    // was mapped nowhere.
    const canonical = new Set(getAllSectorNames());
    const aliases = [
      "Real Estate",
      "Realty",
      "Technology",
      "Consumer Cyclical",
      "Basic Materials",
      "Consumer Defensive",
      "Communication Services",
      "Insurance",
      "Chemicals",
      "Cement",
      "Textiles",
      "Metals",
      "Oil & Gas",
      "Power",
      "Conglomerate",
      "Media",
    ];
    for (const alias of aliases) {
      const mapped = normalizeToNseSector(alias);
      assert.ok(
        canonical.has(mapped),
        `"${alias}" normalises to "${mapped}", which is NOT canonical — it will ` +
          "become an unfilterable bucket",
      );
    }
  });

  it("maps Realty and Real Estate to the SAME bucket", () => {
    // Whichever bucket the product decision lands on, the two names for one
    // asset class must not diverge.
    assert.equal(
      normalizeToNseSector("Realty"),
      normalizeToNseSector("Real Estate"),
    );
  });
});

describe("every sector WRITER is scoped to equities", () => {
  // The nightly bhavcopy backfill clears sector/industry when it types a row
  // DEBT, so `sector: null` stopped meaning "an equity we have not enriched yet"
  // and started also meaning "a bond the worker just cleaned". Any writer that
  // selects on a null sector without an instrumentType filter therefore feeds
  // values back onto bonds — re-creating the exact corruption the retype removed,
  // and falsifying the "a retyped row is excluded from re-enrichment" claim that
  // several other files rely on.
  const GEMINI = readRepoFile("scripts", "data", "enrich-sectors-gemini.ts");
  const RESECTOR = readRepoFile("scripts", "data", "resector-real-estate.ts");

  it("found both scripts", () => {
    assert.ok(GEMINI.length > 0 && RESECTOR.length > 0);
  });

  it("the gemini script filters on instrumentType in BOTH the read and write", () => {
    const hits = [...GEMINI.matchAll(/instrumentType:\s*"EQUITY"/g)].length;
    assert.ok(
      hits >= 2,
      `expected the type filter on both the SELECT and the updateMany, found ${hits}`,
    );
  });

  it("the resector re-checks instrumentType at write time", () => {
    // The confirmation prompt can block on a human for minutes while the 21:00
    // writer runs, so the planned-from type must be re-asserted in the WHERE.
    assert.match(
      RESECTOR,
      /where:\s*\{[\s\S]{0,400}?instrumentType:\s*\{\s*in:\s*\[\s*"EQUITY",\s*"REIT"\s*\]/,
      "the updateMany must re-check the type it planned from",
    );
  });

  it("the resector chunks its write like its sibling", () => {
    // The constant alone is not the invariant — the LOOP is. Deleting the loop
    // and leaving `const CHUNK = 500;` as dead code passed the previous form,
    // restoring a single unbounded `$in` over every planned id.
    assert.match(RESECTOR, /CHUNK\s*=\s*\d+/, "chunk size constant missing");
    assert.match(
      RESECTOR,
      /for\s*\([\s\S]{0,120}?\+=\s*CHUNK\s*\)/,
      "the write must iterate in CHUNK-sized slices, not just declare a size",
    );
    assert.match(
      RESECTOR,
      /slice\s*\([\s\S]{0,40}?CHUNK/,
      "each iteration must slice the id list",
    );
  });
});
