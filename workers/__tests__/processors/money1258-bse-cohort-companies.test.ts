/**
 * The BSE backfill cohort must be COMPANIES — MONEY-1258.
 *
 * ## What the probe actually measured
 *
 * `backfill-bse-results.ts --probe` selected its sample from
 * `{ exchange: "BSE", isActive: true, instrumentType: "EQUITY" }` with no
 * further filter, ordered `symbol: asc`, taking the head. Measured on prod
 * 2026-08-27, that cohort is 7,903 rows of which:
 *
 *     5,381 (68.1%)  have `name === symbol` — no company name, just the ticker
 *     3,776 (47.8%)  are digit-led, the debt shape
 *     2,389 (30.2%)  carry an INE company ISIN
 *
 * and — the part that made it invisible — **the first 925 rows in `symbol: asc`
 * order are all non-companies**, because digits sort before letters. So
 * `--sample 5` returned `001HCCL29`, `001HCCL29B`, `0360OAM27`, `0360OPL27`,
 * `0360OPL28`: five HCC and 360 ONE DEBENTURES, every one `instrumentType:
 * EQUITY`, `series: EQ`, no ISIN, `name === symbol`.
 *
 * BSE serves filings for debentures, so the walk SUCCEEDED and reported archive
 * depth — for bonds — as the answer for companies. Any `--limit` below 925
 * would likewise have applied to zero companies.
 *
 * Same mechanism as MONEY-1257 one script over: there, digit-led symbols
 * sorting first would have put 3,766 junk rows at the head of the document
 * queue for weeks.
 *
 * ## Why the discriminator is the ISIN and never the symbol
 *
 * The tempting fix is to exclude digit-led symbols. It is wrong, and the
 * probe's own corrected output proves it: `1STCUS`, `3BFILMS`, `7NR` and
 * `7SEASL` are digit-led REAL companies with INE ISINs and full filing
 * histories. `reclassify-instruments.ts` measured that mistake — pattern
 * matching hit 2,236 wrong rows and recalled only 2,752 of 11,795.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// MONEY-1326 — every path below is anchored to THIS FILE, never to
// `process.cwd()`. The reads used to be bare relative strings, so they resolved
// correctly only when the runner's cwd happened to be `workers/` (which is what
// `yarn test` does, per-workspace) and threw ENOENT from the repo root. Same
// class as the MONEY-1314 coverage test that resolved its roots from the cwd
// and silently scanned ZERO files.
const ROOT = join(import.meta.dirname, "..", "..", "..");

const SRC = readFileSync(
  join(ROOT, "scripts", "data", "backfill-bse-results.ts"),
  "utf8",
);

describe("BSE backfill selects companies, not debt (MONEY-1258)", () => {
  it("[meta] the source is readable and still filters the cohort", () => {
    // Ceiling: the source assertions below are "this string is present/absent",
    // which a failed read satisfies vacuously.
    assert.ok(SRC.length > 5000, `source read as ${SRC.length} chars`);
    assert.match(SRC, /isCompanyInstrument\(r\.isin\)/);
  });

  it("keys on the INE ISIN, not on symbol shape", () => {
    // The predicate must test the ISIN. A symbol-shape test would drop
    // 1STCUS / 3BFILMS / 7NR / 7SEASL — digit-led REAL companies that appear
    // in the probe's own corrected sample.
    assert.match(
      SRC,
      /isCompanyInstrument\(isin: string \| null \| undefined\)/,
      "the company predicate has been renamed or removed",
    );
    assert.match(
      SRC,
      /\/\^INE\/\.test\(isin \?\? ""\)/,
      "the predicate no longer tests for an INE prefix. INE is the exchange's " +
        "own answer to 'is this a company'; INF (fund units) and IN0/IN9 " +
        "(government paper) are not companies, and an ABSENT isin is the " +
        "5,381-row placeholder population.",
    );
    assert.doesNotMatch(
      SRC,
      /companyRows = bseOnlyRows\.filter\(\(r\) => \/\^\[A-Z\]/,
      "the cohort filters on SYMBOL SHAPE. That drops digit-led real " +
        "companies and is the mistake reclassify-instruments.ts measured.",
    );
  });

  it("does not filter `isin` in a Prisma where — absent fields match nothing", () => {
    // `{isin: null}` and `{isin: {not: null}}` BOTH return zero rows on
    // Prisma+Mongo when the field is absent, which it is on every one of these
    // rows. A `where` would look correct and select nothing.
    // MONEY-1050 / 1205 / 1234 / 1236 / 1256.
    const where = SRC.slice(
      SRC.indexOf('exchange: "BSE"'),
      SRC.indexOf('exchange: "BSE"') + 200,
    );
    assert.ok(
      !/isin:\s*(null|\{)/.test(where),
      "the cohort query filters `isin` in Prisma; absent fields match neither " +
        "`null` nor `{not: null}` on Mongo, so this selects zero rows",
    );
  });

  it("treats an EMPTY scrip master as an outage, not a finding", () => {
    // `fetchBseScripMaster` returns [] on a failed fetch AND under
    // BSE_MASTER_ENRICH=off. Falling through prints "N with no scrip code in
    // BSE's master, 0 selected" — a confident claim about our data produced by
    // a network failure. Observed live on 2026-08-27.
    assert.match(
      SRC,
      /master\.length === 0/,
      "no guard on an empty scrip master; an outage would be reported as " +
        "'no scrip code' for every company in the cohort",
    );
    assert.match(SRC, /BSE SCRIP MASTER UNAVAILABLE/);
  });

  it("reports what it DROPPED rather than filtering silently", () => {
    // A silent filter reads as "that is the whole cohort".
    assert.match(
      SRC,
      /nonCompany/,
      "the dropped-row count must reach the operator line",
    );
    assert.match(SRC, /no INE ISIN/);
  });
});
