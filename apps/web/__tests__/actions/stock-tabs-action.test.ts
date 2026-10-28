/**
 * MONEY-393 §8 / MONEY-779 — `lib/actions/stock-tabs.ts` behavioural contract.
 *
 * De-brittled (MONEY-779): this file USED to `assert.match(SRC, /…/)` against
 * the source FILE STRING — a take:150 regex, the statementType-split branches, a
 * getCached/setCached count — which is green even if the runtime behaviour is
 * wrong (it never executes the code). The hot bits are now extracted into pure,
 * exported helpers in `stock-tabs-logic.ts` that the action CALLS, so this file
 * drives the REAL exports behaviourally:
 *
 *   - splitFinancialsByStatement: fans the flat DB list into income/balance/
 *     cashflow by statementType (the financials list builder the action calls).
 *   - buildCorporateActionCreateManyPayload: the pre-dedup warm-up payload.
 *   - comparePeriodsDesc: the period-aware newest-first order the financials
 *     tab applies on top of the DB tiebreaker.
 *
 * Only a SMALL residue of genuinely-unavoidable DB-query CONFIG LITERALS
 * (orderBy / take on Prisma calls — not reachable from a pure fn without a DB
 * harness) is kept as a source-text guard, clearly labelled.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  splitFinancialsByStatement,
  buildCorporateActionCreateManyPayload,
  type ParsedCorporateAction,
} from "@/lib/actions/stock-tabs-logic";
import { comparePeriodsDesc } from "@/lib/actions/stock-detail-logic";

// ── behavioural: financials statement split (the list builder the action calls) ─

interface Row {
  statementType: string | null | undefined;
  period: string;
}
const row = (
  statementType: string | null | undefined,
  period: string
): Row => ({
  statementType,
  period,
});

describe("splitFinancialsByStatement — financials list builder", () => {
  it("fans a flat list into income / balance / cashflow buckets", () => {
    const out = splitFinancialsByStatement([
      row("INCOME", "Q3-2024"),
      row("BALANCE_SHEET", "Q3-2024"),
      row("CASH_FLOW", "Q3-2024"),
      row("INCOME", "Q2-2024"),
    ]);
    assert.equal(out.income.length, 2);
    assert.equal(out.balance.length, 1);
    assert.equal(out.cashflow.length, 1);
    assert.equal(out.income[0]!.period, "Q3-2024");
    assert.equal(out.balance[0]!.statementType, "BALANCE_SHEET");
  });

  it("preserves input order within each bucket (DB tiebreaker carried through)", () => {
    const out = splitFinancialsByStatement([
      row("INCOME", "Q3-2024"),
      row("INCOME", "Q2-2024"),
      row("INCOME", "Q1-2024"),
    ]);
    assert.deepEqual(
      out.income.map((r) => r.period),
      ["Q3-2024", "Q2-2024", "Q1-2024"]
    );
  });

  it("DROPS an unknown / null / missing statementType (never mis-files)", () => {
    const out = splitFinancialsByStatement([
      row("INCOME", "Q3-2024"),
      row("PROFIT_LOSS", "Q3-2024"), // unknown discriminator
      row(null, "Q3-2024"),
      row(undefined, "Q3-2024"),
    ]);
    assert.equal(out.income.length, 1);
    assert.equal(out.balance.length, 0);
    assert.equal(out.cashflow.length, 0);
  });

  it("returns three empty buckets for an empty input (no throw)", () => {
    const out = splitFinancialsByStatement([]);
    assert.deepEqual(out, { income: [], balance: [], cashflow: [] });
  });
});

// ── behavioural: the financials tab re-sorts each bucket period-aware ─────────

describe("financials ordering — newest-first across year boundaries", () => {
  it("sorts a statement bucket with comparePeriodsDesc (the tab's real sort)", () => {
    // The DB `orderBy:{period:"desc"}` is only a lexical tiebreaker; the tab
    // re-sorts. Pin that a bucket of mixed periods lands newest-first so the
    // QoQ delta reads rows[0] vs rows[1] correctly — 'Q4-2023' must NOT lead.
    const out = splitFinancialsByStatement([
      row("INCOME", "Q4-2023"),
      row("INCOME", "Q3-2024"),
      row("INCOME", "Q1-2024"),
      row("INCOME", "Q2-2024"),
    ]);
    const ordered = out.income.map((r) => r.period).sort(comparePeriodsDesc);
    assert.deepEqual(ordered, ["Q3-2024", "Q2-2024", "Q1-2024", "Q4-2023"]);
  });
});

// ── behavioural: corporate-actions warm-up payload (the action calls this) ────

/** A parsed NSE row, as `fetchNSECorporateActions` returns it (MONEY-1535). */
function corp(
  over: Partial<ParsedCorporateAction> = {}
): ParsedCorporateAction {
  return {
    symbol: "TCS",
    type: "DIVIDEND",
    exDate: new Date("2026-03-10T00:00:00Z"),
    recordDate: null,
    details: "Dividend",
    ratio: null,
    oldFaceValue: null,
    newFaceValue: null,
    dividendPerShare: 24,
    ...over,
  };
}

describe("buildCorporateActionCreateManyPayload — used by warmCorporateActions", () => {
  it("maps a row to main's shape (exchange + type; no instrumentId column)", () => {
    const out = buildCorporateActionCreateManyPayload(
      [corp()],
      "NSE",
      "inst-1"
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.exchange, "NSE");
    assert.equal(out[0]!.type, "DIVIDEND");
    assert.equal("instrumentId" in out[0]!, false);
  });

  it("collapses an in-payload duplicate on the @@unique tuple (first wins)", () => {
    const out = buildCorporateActionCreateManyPayload(
      [corp({ details: "first" }), corp({ details: "second" })],
      "NSE",
      null
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.details, "first");
  });
});

// ── residual config-literal guards (DB-query shape — not pure-fn reachable) ───

const SRC = readFileSync(
  join(__dirname, "..", "..", "lib", "actions", "stock-tabs.ts"),
  "utf8"
);

describe("MONEY-393 §8 — stock-tabs.ts query config (literal guards)", () => {
  it("[exports] the 4 stock-tab actions are declared", () => {
    // Exported-symbol presence — a behavioural import would drag Prisma into
    // node:test, so this stays a presence check on the action declarations.
    assert.match(SRC, /export\s+async\s+function\s+getStockFinancialsAction\b/);
    assert.match(SRC, /export\s+async\s+function\s+getStockPeersAction\b/);
    assert.match(SRC, /export\s+async\s+function\s+getStockNewsAction\b/);
    assert.match(SRC, /export\s+async\s+function\s+getStockReturnsAction\b/);
  });

  it("[financials] the action delegates the split to splitFinancialsByStatement", () => {
    // The branchy inline split was REPLACED by the pure helper (tested above);
    // pin that the action actually calls it so the de-shadow can't silently
    // regress back to an untested inline copy.
    assert.match(SRC, /splitFinancialsByStatement\(/);
  });

  it("[financials] orderBy period desc + a bounded take (no unbounded read)", () => {
    // Genuine DB-query CONFIG: the financials read sorts period desc as a
    // tiebreaker and caps rows so a malformed feed can't pull the universe.
    // The cap (150) is high enough that the client period-aware sort never
    // truncates a recent period — a config literal, kept deliberately.
    assert.match(SRC, /orderBy:\s*\{\s*period:\s*["']desc["']\s*\}/);
    assert.match(SRC, /take:\s*150/);
  });

  // ── MONEY-1235 ────────────────────────────────────────────────────────────

  it("[financials] selects the PER-ROW fetchedAt the TTM badge needs", () => {
    // Rows in one statement no longer share a clock: the nightly XBRL
    // projection refreshes the reporting periods and `periodLabel()`
    // structurally never emits "TTM", so ~2,123 TTM rows are frozen on
    // Tickertape values. Without a per-row stamp the tab cannot tell a current
    // TTM from one that stopped five months ago — they render identically.
    const select = SRC.slice(
      SRC.indexOf("export async function getStockFinancialsAction"),
      SRC.indexOf("// ── Peers")
    );
    assert.match(select, /periodEnd:\s*true/);
    assert.match(select, /fetchedAt:\s*true/);
  });

  // ── MONEY-1300 ────────────────────────────────────────────────────────────

  it("[financials] SELECTS `basis` — and never filters on it", () => {
    // An Indian company files the same period twice under SEBI/Ind AS and for a
    // holding company the two differ by a MULTIPLE: 360ONE FY2025 `totalAssets`
    // is 19,768 Cr consolidated against 7,332 Cr standalone. Measured on prod
    // 2026-08-31, 1,786 of 2,467 symbols with an annual period (72%) file BOTH.
    // `StockFinancials` keeps ONE row per period, so the tab's figure is
    // correct and unattributable without this column.
    //
    // A hardcoded `select` that omits a column makes "we never asked" print as
    // "the row has no value" — invisible from the rendered page, because an
    // absent field and an unpopulated one look identical.
    const select = SRC.slice(
      SRC.indexOf("export async function getStockFinancialsAction"),
      SRC.indexOf("// ── Peers")
    );
    assert.match(select, /basis:\s*true/);
    // Provenance for readers, NEVER a guard. On MongoDB the attribute is ABSENT
    // (not null) on ~32,359 rows, so a `basis: null` filter matches nothing and
    // returns ZERO — the class behind MONEY-1050 / 1234 / 1235.
    assert.doesNotMatch(select, /where:\s*\{[^}]*\bbasis\b/);
  });

  it("[financials] the cache key is bumped to -v5 for those new columns", () => {
    // Same reasoning as the -v2 (`source`) and -v3 (`periodEnd`) bumps before
    // it: a warm entry written before this deploy carries no per-row stamp, so
    // serving one drops the badge on exactly the frozen row it exists to mark,
    // for the 1-6 hours the TTL runs. This assertion is what stops the bump
    // being read as noise and reverted.
    // MONEY-1300: -v5 because `basis` joined the payload. A warm -v4 entry has
    // no basis on any row, so every column would read "Basis not stated" while
    // the database knows the answer.
    assert.match(SRC, /stock-financials-v5:/);
    assert.doesNotMatch(SRC, /stock-financials-v4:/);
    assert.doesNotMatch(SRC, /stock-financials-v3:/);
  });

  it("[ratios] selects ratiosDerivedAt and ships both clocks + their max", () => {
    // `xbrl-ratios-daily` stamps `ratiosDerivedAt` nightly and deliberately
    // never touches `fetchedAt`, because `fetchedAt` is still the honest age of
    // the two columns that job does NOT own (`targetPrice`, `recommendation` —
    // sell-side opinion nothing writes any more). A reader asking "are these
    // ratios current" must therefore read the MAX of the two.
    const ratios = SRC.slice(
      SRC.indexOf("export async function getStockRatiosAction")
    );
    assert.match(ratios, /ratiosDerivedAt:\s*true/);
    assert.match(
      ratios,
      /dataAsOf: latestOfTwo\(row\.fetchedAt, row\.ratiosDerivedAt\)/
    );
    // `fetchedAt` is NOT redefined as the max — the analyst card gates on it.
    assert.match(
      ratios,
      /fetchedAt: row\.fetchedAt \? row\.fetchedAt\.toISOString\(\) : null/
    );
  });

  it("[ratios] the cache key is bumped to -v2 for those new fields", () => {
    assert.match(SRC, /stock-ratios-v2:/);
    assert.doesNotMatch(SRC, /`stock-ratios:/);
  });
});
