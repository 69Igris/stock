/**
 * Two worker call sites that were wrong in ways no unit test could see —
 * MONEY-1198.
 *
 * Both defects live in HOW a correct, well-tested pure function is CALLED, so
 * every existing test of those functions stayed green while the production
 * behaviour was wrong. That is the shape this file exists to catch, and it is
 * why the assertions are structural: they read the processor source and check
 * the call, because there is nothing else to check.
 *
 * The same class as MONEY-1092's inert fix — a guard that is unit-correct and
 * never reached is indistinguishable from no guard at all.
 *
 * Source: workers/src/processors/financial-data-sync.ts
 *         workers/src/processors/mf-portfolio-sync.ts
 *
 * ## What moved out of this file, and why (MONEY-1204)
 *
 * The authority half used to own EXHAUSTIVENESS: it counted
 * `stockFinancials.upsert` calls in ONE file and demanded a matching guard
 * count. That is precisely the shape it was written to warn about. Reading two
 * files by name, it stayed green for the whole time FOUR other writers of the
 * same two models were unguarded — including this very file's
 * `stockRatios.upsert`, the highest-frequency one of the set
 * (`ratios-sync-daily`, 23:30 IST Mon-Fri).
 *
 * Exhaustiveness therefore now lives in ONE place, as a DISCOVERY scan over
 * `apps/ packages/ workers/ scripts/`:
 * `packages/core/__tests__/market-data/financials-write-authority.test.ts`.
 * It finds writers by pattern rather than by name, so a new unguarded one turns
 * it red without anyone updating a list.
 *
 * What stays here is what is genuinely LOCAL to this processor and would be
 * lost as a bare count elsewhere: the MONEY-1198 narrative, and the fact that
 * this file needs TWO guards rather than one because its two models are keyed
 * differently. Duplicating the counting rule in both places would just create
 * two things to drift.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../_support/repo-root";

import {
  mayOverwriteFinancials,
  FINANCIALS_AUTHORITY,
} from "../../../packages/core/src/market-data/xbrl-projection";

const ROOT = repoRoot();
const FIN_SYNC_PATH = join(
  ROOT,
  "workers",
  "src",
  "processors",
  "financial-data-sync.ts",
);
const FIN_SYNC_LOGIC_PATH = join(
  ROOT,
  "workers",
  "src",
  "processors",
  "financial-data-sync-logic.ts",
);
const XBRL_RATIOS = readFileSync(
  join(ROOT, "workers", "src", "processors", "xbrl-ratios.ts"),
  "utf8",
);
const MF_SYNC = readFileSync(
  join(ROOT, "workers", "src", "processors", "mf-portfolio-sync.ts"),
  "utf8",
);

describe("the Tickertape writer is gone, and the guard moved with the job", () => {
  // INVERTED, not deleted (MONEY-1220). This block used to assert that
  // `financial-data-sync.ts` held TWO authority guards — one for
  // `StockFinancials` on its five-part key, one for `StockRatios` on
  // `symbol_exchange` — because that processor wrote both models from
  // Tickertape and would otherwise revert an XBRL-projected row within a week.
  //
  // The processor is deleted. `api.tickertape.in` returns 403 to our Cloud Run
  // egress, so every weekly run was writing the financials leg 0 rows in
  // silence, and the columns it fed are now derived from our own NSE XBRL
  // archive. A guard on a writer that no longer exists asserts nothing.
  //
  // What is kept is the part that OUTLIVED the processor: the authority ORDER
  // (rows Tickertape wrote before the switchover are still incumbents the
  // projection has to be allowed to displace), and the two-guards-because-two-
  // keys reasoning, re-pointed at the writer that now runs nightly.
  it("the processor is deleted, not merely unrouted", () => {
    // Unrouting alone would leave a file that still compiles, still writes, and
    // is one `route()` away from running again — with credentials for a host
    // that 403s us.
    assert.equal(
      existsSync(FIN_SYNC_PATH),
      false,
      "financial-data-sync.ts is back; the Tickertape write path was retired",
    );
  });

  it("its config module went with it — a stranded second tier implementation is how MONEY-1211 happened", () => {
    // `financial-data-sync-logic.ts` was a private copy of the hot/warm tier
    // selector. The shared one is `packages/core/src/market-data/sync-tiers.ts`,
    // and the whole reason it is shared is that the private copy drifted: its
    // selector matched 0 of 10,444 instruments while the job reported success.
    // Leaving the orphan in the tree invites a third copy — this is the same
    // duplicate-module trap that produced (and deleted) `instrument-tier.ts`
    // earlier in this branch.
    assert.equal(
      existsSync(FIN_SYNC_LOGIC_PATH),
      false,
      "the orphaned tier duplicate is back — use @usemoney/core/market-data sync-tiers",
    );
  });

  it("the authority order still ranks XBRL above Tickertape", () => {
    // Still load-bearing AFTER the removal: `stock_financials` and
    // `stock_ratios` are full of TICKERTAPE-sourced rows written before the
    // switchover, and the projection may only overwrite them because it
    // outranks them. Reshuffle this and the nightly job goes quiet — writing
    // nothing, reporting success, which is the exact failure mode this branch
    // exists to end.
    assert.ok(
      FINANCIALS_AUTHORITY.indexOf("NSE_XBRL") <
        FINANCIALS_AUTHORITY.indexOf("TICKERTAPE"),
      "NSE_XBRL must outrank TICKERTAPE in FINANCIALS_AUTHORITY",
    );
    assert.equal(mayOverwriteFinancials("NSE_XBRL", "TICKERTAPE"), true);
    assert.equal(mayOverwriteFinancials("TICKERTAPE", "NSE_XBRL"), false);
  });

  it("a gap is still fillable — the guard must not be so broad it blocks a first write", () => {
    assert.equal(mayOverwriteFinancials("NSE_XBRL", null), true);
    assert.equal(mayOverwriteFinancials("NSE_XBRL", "NSE_XBRL"), true);
    assert.equal(mayOverwriteFinancials("NSE_XBRL", "YAHOO"), true);
  });

  it("REGRESSION (MONEY-1204, re-homed): the ratios guard reads the incumbent on symbol_exchange", () => {
    // `StockRatios` is @@unique([symbol, exchange]) — ONE row per symbol, no
    // period dimension — so it cannot share a lookup with the five-part
    // financials key. That is why it needed its own guard under Tickertape and
    // why it still needs its own guard now that `xbrl-ratios` is the writer.
    // A guard that looked up the wrong key would answer about a different row
    // and be worse than none.
    assert.match(
      XBRL_RATIOS,
      /where:\s*\{\s*symbol_exchange:/,
      "the ratios guard must read the incumbent on the symbol_exchange key",
    );
    assert.match(
      XBRL_RATIOS,
      /mayOverwriteFinancials\("NSE_XBRL", incumbent\?\.source\)/,
      "the ratios writer must delegate to the shared helper, not re-derive the order",
    );
    assert.match(
      XBRL_RATIOS,
      /import \{[\s\S]*?mayOverwriteFinancials[\s\S]*?\} from "@usemoney\/core\/market-data"/,
    );
  });

  it("EXHAUSTIVENESS still lives in the core scan, not here", () => {
    // Named so the next person does not re-add a count of upserts to this file.
    // Counting writers BY NAME is what let four unguarded ones sit green for
    // months; the core test finds them by PATTERN across the whole repo.
    assert.equal(
      existsSync(
        join(
          ROOT,
          "packages",
          "core",
          "__tests__",
          "market-data",
          "financials-write-authority.test.ts",
        ),
      ),
      true,
      "the repo-wide write-authority scan is missing — nothing enforces exhaustiveness",
    );
  });
});

describe("mf-portfolio-sync must drive per-scheme houses per scheme", () => {
  it("resolves the source it reasons over", () => {
    assert.ok(MF_SYNC.length > 2000, "processor source did not load");
  });

  it("REGRESSION: a perScheme house is iterated, not picked once", () => {
    // THE DEFECT: `pickLinkForMonth(links, month)` with no `scheme` argument is
    // no filter at all. On a house publishing one workbook per scheme EVERY
    // file matches the month, so the count is never 1 and the result is null BY
    // CONSTRUCTION — every month, forever. Six of twelve houses were in that
    // state, and the 2026-08-14 production log reported it as
    // "no single link for this month { amc: 'ZERODHA', linksOnPage: 338 }",
    // which reads as a fact about NSE rather than about this call.
    assert.match(
      MF_SYNC,
      /schemesForMonth\(/,
      "the processor must ask which schemes were published this month",
    );
    assert.match(
      MF_SYNC,
      /cfg\.perScheme/,
      "the processor must branch on the perScheme flag",
    );
    assert.match(
      MF_SYNC,
      /pickLinkForMonth\(links, month, s\)/,
      "pickLinkForMonth must be called WITH a scheme — without one it is unfiltered",
    );
  });

  it("REGRESSION: the landing page is fetched with the configured method", () => {
    // Mirae's listing endpoint is POST-only and answers a GET with HTTP 200 +
    // {"ReturnCode":"9999"}. A hard-coded GET makes the house look reachable
    // and simply empty.
    assert.match(
      MF_SYNC,
      /fetchText\(cfg\.pageUrl, cfg\.pageRequest\)/,
      "the landing page must be fetched with cfg.pageRequest, not an assumed GET",
    );
  });

  it("a partial month is reported, not silently rounded to success", () => {
    // One AMC now spans many workbooks. `ok` must mean "we got something", and
    // a house where every file failed must not read as a success with zero
    // holdings — that is the shape that let an empty table look healthy.
    assert.match(MF_SYNC, /gotSomething/);
    assert.match(MF_SYNC, /partial month/);
  });
});
