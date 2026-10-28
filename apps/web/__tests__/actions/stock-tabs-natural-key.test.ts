/**
 * MONEY-1145 — stock-tab reads key on (symbol, exchange), not `instrumentId`.
 *
 * `instrumentId` is a MUTABLE denormalised FK. Re-seeding `instrument_mappings`
 * mints fresh ObjectIds, and every row in a dependent collection that stored
 * the old id becomes unreachable — silently. There is no error and no way for
 * the UI to tell "no data" from "data I cannot address", so the feature simply
 * goes quiet.
 *
 * Measured on the dev database before the fix:
 *
 *   StockFinancials rows total            32,359
 *   reachable by instrumentId                  0   ← 100% orphaned
 *   reachable by (symbol, exchange)       32,359   (2,123 symbols)
 *
 * i.e. the Financials tab was empty for EVERY stock on the platform while the
 * data sat in the collection the whole time. `dailyPrice` escaped only because
 * the price sync re-resolves ids daily; financials are written once, so they
 * rot from the first re-seed onward — which is why a "repair the ids" migration
 * would fix it until the next re-seed and no longer.
 *
 * The durable fix is to read the key the WRITER writes. Both models declare it:
 *   StockFinancials  @@unique([symbol, exchange, statementType, periodType, period])
 *   StockPeers       @@unique([symbol, exchange])
 * and both are indexed, so this is not a performance trade either.
 *
 * Source-level, per this suite's convention for `"use server"` files: these
 * actions reach Prisma + Clerk and cannot be imported into node:test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const REPO = join(ROOT, "..", "..");

const webSrc = readFileSync(join(ROOT, "lib/actions/stock-tabs.ts"), "utf8");
const apiSrc = readFileSync(
  join(REPO, "packages/services/src/stock-tabs.service.ts"),
  "utf8"
);

/**
 * LINE comments first, then BLOCK comments (MONEY-1143 — the order is
 * load-bearing; reversed, a `//` containing `/*` opens a phantom block).
 *
 * Stripping at all is REQUIRED here, and this file proved why on its first
 * run: the fix's own comment explains the bug by quoting the old
 * `where: { instrumentId }` clause, so the "must not filter by instrumentId"
 * assertion matched the explanation and failed against correct code. An
 * assertion that reads prose is not reading the wire.
 */
function stripComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The body of a named exported function, up to the next top-level export. */
function bodyOf(src: string, fnName: string): string {
  const code = stripComments(src);
  const start = code.indexOf(`export async function ${fnName}`);
  assert.ok(start > -1, `could not locate ${fnName}`);
  const rest = code.slice(start + 1);
  const end = rest.indexOf("\nexport ");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("MONEY-1145 — stock tabs read the natural key", () => {
  it("[meta] stripComments cannot swallow the code under assertion", () => {
    const fixture = [
      "// mentions tours/* which opens nothing",
      'const KEEP = "where: { symbol, exchange }";',
      "/* a real block */",
    ].join("\n");
    const stripped = stripComments(fixture);
    assert.match(stripped, /KEEP/);
    assert.doesNotMatch(stripped, /a real block/);
    assert.doesNotMatch(stripped, /mentions tours/);
  });

  describe("apps/web server actions", () => {
    it("[regression] financials query is keyed on symbol + exchange", () => {
      const body = bodyOf(webSrc, "getStockFinancialsAction");
      assert.match(
        body,
        /where:\s*\{\s*symbol:\s*args\.symbol,\s*exchange:\s*args\.exchange,\s*periodType\s*\}/,
        "financials must be read by its declared @@unique key"
      );
    });

    it("[regression] financials does NOT filter by instrumentId", () => {
      const body = bodyOf(webSrc, "getStockFinancialsAction");
      assert.doesNotMatch(
        body,
        /where:\s*\{\s*instrumentId/,
        "instrumentId is mutable — this matched 0 of 32,359 rows in dev"
      );
      assert.doesNotMatch(
        body,
        /instrumentIdFor\(/,
        "resolving the mapping here also re-adds a failure mode: no active " +
          "mapping returned an empty result that looked identical to no data"
      );
    });

    it("[regression] peers query is keyed on symbol + exchange", () => {
      const body = bodyOf(webSrc, "getStockPeersAction");
      assert.match(
        body,
        /where:\s*\{\s*symbol:\s*args\.symbol,\s*exchange:\s*args\.exchange\s*\}/
      );
      assert.doesNotMatch(body, /where:\s*\{\s*instrumentId/);
    });
  });

  describe("packages/services (apps/api port)", () => {
    // Standing rule: apps/api must not drift from the server actions. This one
    // matters more than usual — mobile would otherwise keep serving the empty
    // tab after web was fixed, and nobody would connect the two.
    it("[regression] financials mirrors the web fix", () => {
      const body = bodyOf(apiSrc, "getStockFinancials");
      assert.match(
        body,
        /where:\s*\{\s*symbol:\s*args\.symbol,\s*exchange:\s*args\.exchange,\s*periodType\s*\}/
      );
      assert.doesNotMatch(body, /where:\s*\{\s*instrumentId/);
    });

    it("[regression] peers mirrors the web fix", () => {
      const body = bodyOf(apiSrc, "getStockPeers");
      assert.match(
        body,
        /where:\s*\{\s*symbol:\s*args\.symbol,\s*exchange:\s*args\.exchange\s*\}/
      );
      assert.doesNotMatch(body, /where:\s*\{\s*instrumentId/);
    });
  });

  describe("the rule is NOT over-applied", () => {
    // Guards the opposite mistake. `DailyPrice` is genuinely instrument-keyed
    // (`@@unique([instrumentId, date])`, no symbol column), and its rows are
    // NOT orphaned — measured 5,989 correctly-keyed rows for STAR — because
    // the price sync re-resolves ids on every run. Rewriting these reads to
    // "symbol" would break them and cannot even be expressed on that model.
    it("dailyPrice reads still use instrumentId", () => {
      const returns = bodyOf(webSrc, "getStockReturnsAction");
      assert.match(
        returns,
        /dailyPrice\.findMany\(\{[\s\S]{0,120}?where:\s*\{\s*instrumentId/,
        "price history is legitimately keyed on instrumentId — do not 'fix' it"
      );
    });

    it("instrumentIdFor is still exported/used for the price paths", () => {
      assert.match(
        webSrc,
        /async function instrumentIdFor\(/,
        "the helper is still needed by the instrument-keyed reads"
      );
    });
  });

  describe("corporate actions were already correct", () => {
    it("reads by symbol + exchange", () => {
      // Pinned so a future refactor doesn't 'consistently' convert this one
      // onto instrumentId and reintroduce the bug on a working tab.
      assert.match(
        webSrc,
        /corporateAction\.findMany\(\{[\s\S]{0,160}?where:\s*\{\s*symbol,\s*exchange\s*\}/
      );
    });
  });
});
