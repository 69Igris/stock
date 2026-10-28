/**
 * MONEY-1300 — the three statement tools SAY whose accounts the figures are.
 *
 * An Indian company files the same period twice under SEBI/Ind AS: CONSOLIDATED
 * (parent + subsidiaries) and STANDALONE (parent alone). For a holding company
 * they differ by a MULTIPLE — 360ONE FY2025 `totalAssets` is 19,768 Cr against
 * 7,332 Cr — and `StockFinancials` keeps ONE row per period (`basis` is
 * deliberately not in its `@@unique`, because two rows per period is how every
 * reader starts double-counting). So the number these tools return is correct
 * and, until this ticket, unattributable.
 *
 * Three surfaces, one per path a tool can answer from:
 *
 *  1. THE DB PATH. `rowToStatement` carries the stored `basis` onto every row.
 *     Asserted against the REAL mapper in
 *     apps/web/__tests__/research/db-first-statements.test.ts, where that
 *     reader's tests already live.
 *  2. THE LIVE PATHS. Yahoo's `quoteSummary` and the Screener chain report no
 *     basis at all. They stamp "UNKNOWN" rather than omitting the key, because
 *     an absent key is one `?? "Consolidated"` away from a confident wrong
 *     label — and for a holding company that label sits on a number off by a
 *     multiple. Executed here against the REAL exported mappers.
 *  3. THE METADATA. Each tool's DB-first branch reports the basis across the
 *     rows it actually returned, beside `source`. `source` says who produced
 *     the figure; `basis` says whose accounts it describes.
 *
 * Sources: packages/research/src/tools/fetch-income-statement.ts
 *          packages/research/src/tools/fetch-balance-sheet.ts
 *          packages/research/src/tools/fetch-cash-flow.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  mapStatements,
  fetchIncomeStatementTool,
} from "../src/tools/fetch-income-statement";
import {
  mapBalanceSheet,
  fetchBalanceSheetTool,
} from "../src/tools/fetch-balance-sheet";
import { mapCashFlow, fetchCashFlowTool } from "../src/tools/fetch-cash-flow";

/** One Yahoo `quoteSummary` statement row, in the `{raw, fmt}` shape. */
const YAHOO_ROW = {
  endDate: { raw: "1743379200", fmt: "2025-03-31" },
  totalRevenue: { raw: 1000 },
  totalAssets: { raw: 19768 },
  totalCashFromOperatingActivities: { raw: 250 },
  capitalExpenditures: { raw: -50 },
};

describe("MONEY-1300 — the live paths state an UNKNOWN basis rather than none", () => {
  const cases: Array<
    [string, (items: unknown[]) => Array<{ basis?: string }>]
  > = [
    ["fetch_income_statement", mapStatements],
    ["fetch_balance_sheet", mapBalanceSheet],
    ["fetch_cash_flow", mapCashFlow],
  ];

  for (const [tool, map] of cases) {
    it(`${tool}: Yahoo rows carry basis "UNKNOWN"`, () => {
      const [row] = map([YAHOO_ROW]);
      assert.ok(row, "mapper returned no row");
      // The key must EXIST — this is the assertion that an absent field cannot
      // satisfy, and absence is what a downstream default would silently fill.
      assert.ok(
        Object.prototype.hasOwnProperty.call(row, "basis"),
        "statement has no `basis` key at all",
      );
      assert.equal(row.basis, "UNKNOWN");
      // Yahoo says nothing about basis, so claiming the group's accounts here
      // would be a fabrication, not a default.
      assert.notEqual(row.basis, "CONSOLIDATED");
    });
  }
});

describe("MONEY-1300 — the tools tell the model the field exists", () => {
  // The research agent's user-facing "render" is the model's answer, and the
  // model only surfaces a field it has been told about. A row carrying `basis`
  // that no prompt mentions is a field nobody reads.
  const tools = [
    fetchIncomeStatementTool,
    fetchBalanceSheetTool,
    fetchCashFlowTool,
  ];

  for (const tool of tools) {
    it(`${tool.name}: description names basis and both stated values`, () => {
      assert.match(tool.description, /\bbasis\b/i);
      assert.match(tool.description, /CONSOLIDATED/);
      assert.match(tool.description, /STANDALONE/);
    });
  }
});

describe("MONEY-1300 — the DB-first branch reports basis beside source", () => {
  // A source scan, with comments stripped so a note ABOUT basis cannot pass for
  // a line that emits it. The DB-first branch returns `getDbFirstStatements`
  // rows verbatim (their per-row basis is covered by the mapper's own test);
  // what is pinned here is the tool-level summary, which is the field a caller
  // reading only `metadata` — the executor, the synthesizer's source labelling
  // — can act on.
  // `import.meta.dirname` — packages/research tests load as ESM, where
  // `__dirname` is not defined (and a suite that throws while COLLECTING still
  // prints `# fail 0`, so this failed silently once already).
  const TOOLS = join(import.meta.dirname, "..", "src", "tools");
  const stripComments = (src: string) =>
    src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  for (const file of [
    "fetch-income-statement.ts",
    "fetch-balance-sheet.ts",
    "fetch-cash-flow.ts",
  ]) {
    it(`${file}: metadata carries a summarised basis`, () => {
      const src = stripComments(readFileSync(join(TOOLS, file), "utf8"));
      assert.match(
        src,
        /metadata:\s*\{[\s\S]*?basis:\s*summariseStockFinancialsBasis\(/,
        "DB-first metadata does not report a basis",
      );
      // And it must never become a FILTER. `basis` in a Prisma `where` is the
      // MONEY-1050/1234/1235 class: on Mongo `basis: null` matches no absent
      // field and returns ZERO rows, and this column is absent on ~32,359 of
      // them.
      assert.doesNotMatch(src, /where:\s*\{[^}]*\bbasis\b/);
    });
  }
});
