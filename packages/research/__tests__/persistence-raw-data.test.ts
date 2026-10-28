/**
 * `rawData` on a fallback-persisted `StockFinancials` row — MONEY-1205.
 *
 * ## Why this exists
 *
 * `rawData` is not decoration. It is the raw material every later repair reads:
 * `scripts/data/backfill-financials-from-rawdata.ts` re-projects the columns
 * prod is missing (netIncome, totalAssets, totalEquity and operatingIncome are
 * null on 100% of 32,359 rows) straight out of it. Two bugs in
 * `persistFinancialFallback` destroyed it, and neither could ever surface as a
 * failure — the whole path is fire-and-forget
 * (`persistFinancialFallbackInBackground`) and swallows its errors.
 *
 * 1. The three fetch tools passed the WHOLE statement array as the call-level
 *    `rawData` (`rawData: ttIncome`), and the upsert wrote it onto EVERY period
 *    row. Five annual rows each ended up holding the same five-element array
 *    instead of their own payload. The backfill reads a non-object and buckets
 *    the row `unmappable`; it cannot fail loudly, because an array is a legal
 *    `Json?`.
 * 2. The upsert wrote `rawData: opts.rawData ?? null` on UPDATE, so a persist
 *    carrying no payload NULLED a good per-row payload written earlier.
 *
 * ## Why it is tested HERE and not in `persistence-fallback.test.ts`
 *
 * That file states in its own header that it "inlines a fake Prisma client +
 * the helper logic ... without importing the real persistence module". It
 * therefore asserts a re-implementation and would stay green with the real
 * module deleted. `resolveRowRawData` lives in `persistence-logic.ts`
 * specifically so the thing that runs in production is the thing under test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveRowRawData } from "../src/data-sources/persistence-logic";

const FIXTURES = join(import.meta.dirname, "fixtures");

/** The real annual income payload, exactly as the fetch tools receive it. */
const INCOME_ROWS = (
  JSON.parse(
    readFileSync(join(FIXTURES, "tickertape-annual-income-HDBK.json"), "utf8"),
  ) as { data: Array<Record<string, unknown>> }
).data;

describe("resolveRowRawData", () => {
  it("prefers THIS row's payload", () => {
    const row = INCOME_ROWS[0]!;
    assert.deepEqual(resolveRowRawData({ raw: row }, undefined), row);
  });

  it("REJECTS an array — that is the history, not this row", () => {
    // The exact value the fetch tools used to pass. Six income rows, written
    // identically onto all six period rows.
    assert.equal(INCOME_ROWS.length > 1, true);
    assert.equal(
      resolveRowRawData({}, INCOME_ROWS),
      undefined,
      "the whole statement array was accepted as one row's rawData",
    );
  });

  it("prefers the row payload even when an array is also supplied", () => {
    const row = INCOME_ROWS[2]!;
    assert.deepEqual(resolveRowRawData({ raw: row }, INCOME_ROWS), row);
  });

  it("accepts a call-level payload when it IS a single row", () => {
    // Callers that persist one row may still pass it at call level.
    const row = INCOME_ROWS[1]!;
    assert.deepEqual(resolveRowRawData({}, row), row);
  });

  it("returns undefined — never null — when nothing is known", () => {
    // undefined is what lets the caller OMIT the key. `null` would be written,
    // and on an UPDATE that erases the payload a previous writer stored.
    for (const nothing of [undefined, null, "", 0, false, "{}"]) {
      assert.equal(
        resolveRowRawData({}, nothing),
        undefined,
        `${JSON.stringify(nothing)} resolved to something writable`,
      );
    }
    assert.equal(resolveRowRawData({ raw: null }, undefined), undefined);
    assert.equal(resolveRowRawData({ raw: [] }, undefined), undefined);
  });

  it("keeps a row payload distinguishable per period", () => {
    // The property the array broke: two different periods must not resolve to
    // the same object.
    const a = resolveRowRawData({ raw: INCOME_ROWS[0]! }, INCOME_ROWS);
    const b = resolveRowRawData({ raw: INCOME_ROWS[1]! }, INCOME_ROWS);
    assert.notEqual(a!.displayPeriod, b!.displayPeriod);
  });

  it("resolves a payload the shared statement mapper can actually read", () => {
    // The point of storing it at all: the backfill must be able to re-project
    // columns from what lands here.
    const resolved = resolveRowRawData({ raw: INCOME_ROWS[0]! }, INCOME_ROWS)!;
    assert.equal(typeof resolved.displayPeriod, "string");
    assert.equal(Array.isArray(resolved), false);
  });
});

describe("the fetch tools thread the per-row payload", () => {
  // The call sites are inside I/O-bound tool bodies; the BEHAVIOUR they feed is
  // covered above. This guards the wiring that carries it there.
  const TOOLS = [
    "fetch-income-statement.ts",
    "fetch-balance-sheet.ts",
    "fetch-cash-flow.ts",
  ];

  for (const tool of TOOLS) {
    it(`${tool} passes raw per row, not the whole array`, () => {
      const src = readFileSync(
        new URL(`../src/tools/${tool}`, import.meta.url),
        "utf8",
      );
      assert.match(
        src,
        /statements: chainRows\.map\(\(\{ mapped, raw \}\) => \(\{/,
        "the per-row payload is no longer threaded",
      );
      assert.doesNotMatch(
        src,
        /^\s*rawData: tt\w+,\s*$/m,
        "the whole statement array is being passed as rawData again",
      );
    });
  }

  it("the upsert OMITS rawData rather than nulling it", () => {
    // `persistence.ts` imports Prisma at module load, so the upsert clause is
    // asserted structurally. `?? null` on an UPDATE is the erase: it writes a
    // null over a per-row payload an earlier writer stored, which is the same
    // absent-is-not-null rule the numeric columns already follow.
    const src = readFileSync(
      new URL("../src/data-sources/persistence.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      src,
      /rawData:\s*\(opts\.rawData \?\? null\)/,
      "rawData is being nulled on update again",
    );
    assert.match(
      src,
      /\.\.\.\(rowRaw \? \{ rawData: rowRaw as never \} : \{\}\)/,
    );
    assert.match(src, /const rowRaw = resolveRowRawData\(row, opts\.rawData\)/);
  });
});
