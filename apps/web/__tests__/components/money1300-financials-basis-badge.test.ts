/**
 * MONEY-1300 — the Financials tab says WHOSE accounts the numbers are.
 *
 * An Indian company files the SAME period twice under SEBI/Ind AS: CONSOLIDATED
 * (parent + subsidiaries) and STANDALONE (parent alone). For a holding company
 * they differ by a MULTIPLE — 360ONE FY2025 `totalAssets` is 19,768 Cr against
 * 7,332 Cr — and measured on prod 2026-08-31, 1,786 of 2,467 symbols with an
 * annual period (72%) file BOTH, 664 standalone only, 17 consolidated only.
 *
 * `StockFinancials` deliberately keeps ONE row per period (`basis` is not in its
 * `@@unique`, because two rows per period is how a reader starts double-
 * counting), and the selection rule is consolidated-preferred with standalone
 * fallback. So the figure the tab renders is CORRECT and, until this ticket,
 * unattributable — a user could not tell a group total from the parent's alone.
 *
 * Two directions are pinned, because the label can fail in both:
 *
 *  1. UNDER-stating — the badge or the per-column note not rendering at all,
 *     which returns the tab to the ambiguous state.
 *  2. OVER-stating — an ABSENT or "UNKNOWN" basis rendering as "Consolidated".
 *     This is the worse failure and the reason the ticket exists: it puts a
 *     confident claim on a number that may be the parent alone. On MongoDB a
 *     `db push` creates indexes and never fields, so the attribute is MISSING
 *     — not null — on the ~32,359 rows the XBRL projection has not rewritten,
 *     and a vendor row says the literal "UNKNOWN". Both are the same answer.
 *
 * Source: apps/web/components/stock/StockFinancialsTab.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The tab is a client component importing a CSS module and the "use server"
// actions; stub both so the real helpers can be EXECUTED rather than described.
interface ModuleLoader {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}
const loader = Module as unknown as ModuleLoader;
const originalLoad = loader._load;
loader._load = function patchedLoad(
  request: string,
  parent: unknown,
  isMain: boolean
): unknown {
  if (request.endsWith(".css")) return {};
  if (request === "@/lib/actions/stock-tabs") {
    return { getStockFinancialsAction: async () => ({ success: true }) };
  }
  return originalLoad.call(loader, request, parent, isMain);
};

interface Row {
  period: string;
  basis?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tab = require("../../components/stock/StockFinancialsTab") as {
  columnBasisNote: (row: Row) => string;
};
const { columnBasisNote } = tab;

/**
 * THE SECTION BADGE IS GONE — founder decision, and its unit tests with it.
 *
 * `sectionBasisLabel` had exactly one caller, that badge. Every row in
 * `stock_financials` is still a vendor row stamped UNKNOWN or a pre-existing
 * row with the column ABSENT, because `XBRL_PROJECTION_APPLY` is false in both
 * specs — so the badge read "Basis not stated" on 100% of cards, 100% of the
 * time. A label that never varies carries no information.
 *
 * The FACT was not deleted: `columnBasisNote` still puts each column's own
 * basis in its header tooltip, and the cases below still cover it — including
 * the absent-is-never-Consolidated rule, which is the one that actually
 * protects a reader from being told the group's numbers are the parent's.
 */

describe("MONEY-1300 — the per-column note", () => {
  it("carries that column's own basis, which is what MIXED needs", () => {
    // When the badge collapses to "Mixed basis" this tooltip is the only place
    // a reader learns which column is which.
    assert.match(
      columnBasisNote({ period: "FY 2025", basis: "CONSOLIDATED" }),
      /Consolidated/
    );
    assert.match(
      columnBasisNote({ period: "FY 2024", basis: "STANDALONE" }),
      /Standalone/
    );
  });

  it("never claims consolidated for a column that did not say so", () => {
    for (const row of [
      { period: "FY 2019" },
      { period: "FY 2019", basis: null },
      { period: "FY 2019", basis: "UNKNOWN" },
    ] as Row[]) {
      const note = columnBasisNote(row);
      assert.match(note, /Basis not stated/);
      assert.doesNotMatch(
        note,
        /^Consolidated/,
        "an unstated basis must not be announced as consolidated"
      );
    }
  });
});

describe("MONEY-1300 — the helpers are actually RENDERED", () => {
  // The helpers above are pure and would keep passing if the JSX stopped
  // calling them, which is the failure mode a helper-only test cannot see.
  // Comments are stripped so a note ABOUT the badge cannot pass for a badge.
  const SRC = readFileSync(
    join(
      __dirname,
      "..",
      "..",
      "components",
      "stock",
      "StockFinancialsTab.tsx"
    ),
    "utf8"
  )
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("the section head renders NO basis badge — removed by decision", () => {
    // MONEY-1300 shipped a section badge that was "always rendered", on the
    // argument that a missing badge would read as "consolidated, obviously".
    // That argument needs someone to have seen a REAL value, and nobody has:
    // `XBRL_PROJECTION_APPLY` is false in both specs (its reconcile gate reads
    // NOT READY), so every row in `stock_financials` is a vendor row stamped
    // UNKNOWN or a pre-existing row with the column ABSENT — and the badge read
    // "Basis not stated" on 100% of cards, 100% of the time. Founder decision:
    // remove it rather than show a label that never varies.
    //
    // Asserted NEGATIVELY so it cannot drift back in unnoticed. Restoring it is
    // a deliberate edit here, in the same change that arms the projection.
    assert.doesNotMatch(SRC, /className="fin-section-basis"/);
    assert.doesNotMatch(SRC, /sectionBasisLabel/);
  });

  it("the per-COLUMN basis is still available — the fact was not deleted", () => {
    // Anti-vacuity for the case above. The badge is gone; the information is
    // not. Each column header still carries its own basis in its tooltip, so a
    // reader who needs to know whose accounts a figure is can still find out —
    // which is what makes removing the section badge a presentation change
    // rather than a data one.
    assert.match(SRC, /columnBasisNote\(r\)/);
  });

  it("every column header carries its own basis note", () => {
    assert.match(SRC, /title=\{columnBasisNote\(r\)\}/);
    // The TTM column's inner <span title> SHADOWS the <th>'s, so the note has
    // to be folded into it too or TTM becomes the one column a reader cannot
    // hover — and it is the column most likely to disagree, since the
    // projection can never rewrite a "TTM" label.
    assert.match(
      SRC,
      /Trailing twelve months[\s\S]{0,240}columnBasisNote\(r\)/
    );
  });
});
