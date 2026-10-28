/**
 * MONEY-1220 / 1217 — the columns this branch adds, and the indexes without
 * which two nightly jobs are collection scans.
 *
 * ## Why a test for a schema
 *
 * `prisma db push` is a FOUNDER-GATED step that happens after the merge. Until
 * it runs, the code on `release` references fields that do not exist on either
 * database. This file is the checklist that step is checked against — it names
 * every field and index the branch expects, so "did the push cover everything"
 * is answerable without reading four commits.
 *
 * ## The indexes are not decoration
 *
 * Both new jobs select stale-first — `ORDER BY <marker> ASC` over the whole
 * table, nightly. Without the index that is a collection scan across every
 * ratio row and every filing, every night. With no MARKER at all it is worse
 * than slow: the sort is constant, so each run receives the same first N rows
 * forever, writes them once and skips them thereafter while the rest of the
 * population is never selected. That is MONEY-1211, which cost 681 of 781
 * symbols their sync and reported success throughout.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = readFileSync(
  join(import.meta.dirname, "..", "prisma", "schema.prisma"),
  "utf8",
);

/** The body of one `model X { … }` block. */
function model(name: string): string {
  const at = SCHEMA.indexOf(`model ${name} {`);
  assert.ok(at > 0, `model ${name} not found`);
  return SCHEMA.slice(at, SCHEMA.indexOf("\n}", at));
}

describe("StockRatios — the 23 columns need somewhere to land", () => {
  const m = model("StockRatios");

  it("has the two columns the engine could already compute", () => {
    // `deriveRatios` produced both since MONEY-1115 and the producer reported
    // them under `computedButUnstorable` because there was no column. A ratio
    // computed and then dropped on the floor is the quietest kind of waste.
    for (const f of ["ebitdaMargin", "assetTurnover"]) {
      assert.match(m, new RegExp(`\\b${f}\\s+Float\\?`), `missing ${f}`);
    }
  });

  it("keeps targetPrice and recommendation — we do not write them, but we do not drop them", () => {
    // Analyst opinion, from a source we can no longer re-fetch. Removing the
    // columns would delete the last copy; the ratios job simply never writes
    // them (asserted in xbrl-ratios-wired.test.ts).
    assert.match(m, /targetPrice\s+Float\?/);
    assert.match(m, /recommendation\s+String\?/);
  });

  it("carries BOTH clocks, so a change is attributable", () => {
    // Half the row moves on a new filing, half on a new close. One `updatedAt`
    // cannot say which, and that is the first question anyone asks of a P/E.
    assert.match(m, /ratiosFilingId\s+String\?/);
    assert.match(m, /ratiosPriceDate\s+DateTime\?/);
  });

  it("has the stale-first cursor AND its index", () => {
    assert.match(m, /ratiosDerivedAt\s+DateTime\?/, "no rotation marker");
    assert.match(
      m,
      /@@index\(\[ratiosDerivedAt\]\)/,
      "the nightly ORDER BY is a collection scan without this",
    );
  });
});

describe("XbrlFiling — the projection cursor", () => {
  const m = model("XbrlFiling");

  it("has projectedAt and its index", () => {
    // Selection is `orderBy [symbol asc, periodEnd desc] take limit` — constant
    // over an append-only table. Without this marker every run gets the same
    // first `limit` filings forever.
    assert.match(m, /projectedAt\s+DateTime\?/);
    assert.match(m, /@@index\(\[projectedAt\]\)/);
  });
});

describe("every rotation marker is its own field", () => {
  it("news, filings and events each have one", () => {
    // Deliberately NOT a shared `lastTouched`: one job's run must not reset
    // another job's rotation. Three jobs sharing one marker means the fastest
    // one starves the other two, silently.
    const m = model("InstrumentMapping");
    for (const f of ["newsSyncedAt", "filingsSyncedAt", "eventsSyncedAt"]) {
      assert.match(m, new RegExp(`\\b${f}\\s+DateTime\\?`), `missing ${f}`);
    }
  });
});

describe("the founder-gated push checklist", () => {
  it("names every field this branch expects to exist after `db push`", () => {
    // One place to check the push against. If this list and the schema ever
    // disagree, the push was incomplete — which on Mongo means the write
    // silently drops the field rather than erroring.
    const expected: Array<[string, string]> = [
      ["StockRatios", "ebitdaMargin"],
      ["StockRatios", "assetTurnover"],
      ["StockRatios", "ratiosFilingId"],
      ["StockRatios", "ratiosPriceDate"],
      ["StockRatios", "ratiosDerivedAt"],
      ["XbrlFiling", "projectedAt"],
      ["InstrumentMapping", "eventsSyncedAt"],
    ];
    const missing = expected.filter(
      ([mdl, field]) => !model(mdl).includes(field),
    );
    assert.deepEqual(
      missing,
      [],
      `schema is missing fields the code already references`,
    );
  });
});
