/**
 * One instrument, one route — MONEY-1205.
 *
 * ## The defect
 *
 * `SBIETFQLTY` (ISIN INF200KA1WX6, AMFI scheme 145648) rendered at THREE live
 * routes with no canonical and no redirect: `/etf/SBIETFQLTY`, `/mf/145648` and
 * `/stock/SBIETFQLTY`. Not a flag and not an environment difference — eight
 * link sites each built the href themselves. Two emitted `/etf/`; the other six
 * sent funds to `/stock/`, the OHLC/PE page.
 *
 * ## What this file pins
 *
 *   1. the routing RULE, as a pure function (`instrumentDetailHref`);
 *   2. that the converted call sites contain no hand-rolled detail href at all,
 *      which is the only way "they agree today" survives the next edit.
 *
 * Source: apps/web/lib/fund/instrument-href.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  instrumentDetailHref,
  instrumentRouteFamily,
} from "@/lib/fund/instrument-href";

const ROOT = join(__dirname, "..", "..");

describe("MONEY-1205 — instrumentDetailHref routes by instrument type", () => {
  it("an ETF goes to /etf/, never /stock/", () => {
    assert.equal(
      instrumentDetailHref({
        symbol: "SBIETFQLTY",
        exchange: "NSE",
        instrumentType: "ETF",
      }),
      "/etf/SBIETFQLTY?exchange=NSE"
    );
  });

  it("an MF goes to /mf/, preferring an explicit scheme code", () => {
    assert.equal(
      instrumentDetailHref({
        symbol: "SBIETFQLTY",
        schemeCode: "145648",
        instrumentType: "MF",
      }),
      "/mf/145648"
    );
    // The MF surfaces that pass the scheme code AS the symbol still work.
    assert.equal(
      instrumentDetailHref({ symbol: "119551", instrumentType: "MF" }),
      "/mf/119551"
    );
  });

  it("an index keeps its type=index marker", () => {
    // Dropping it degrades an index that is not in `instrument_mappings` to an
    // equity lookup, because `type` is what lets the stock page synthesise the
    // Yahoo symbol.
    assert.equal(
      instrumentDetailHref({
        symbol: "NIFTY 50",
        exchange: "NSE",
        type: "INDEX",
      }),
      "/stock/NIFTY%2050?exchange=NSE&type=index"
    );
  });

  it("an equity, and anything unknown, goes to /stock/", () => {
    assert.equal(
      instrumentDetailHref({
        symbol: "RELIANCE",
        exchange: "NSE",
        instrumentType: "EQUITY",
      }),
      "/stock/RELIANCE?exchange=NSE"
    );
    // Watchlist items and holdings rows carry NO type — they must still resolve,
    // and the canonical redirect on /stock/ is what fixes an ETF that lands here.
    assert.equal(
      instrumentDetailHref({ symbol: "RELIANCE", exchange: "NSE" }),
      "/stock/RELIANCE?exchange=NSE"
    );
  });

  it("REIT/INVIT stay on /stock/ — they have no NAV, AMC or scheme code", () => {
    // `FUND_INSTRUMENT_TYPES` groups them with ETFs on the DISCOVER surfaces,
    // which is why they used to be linked to `/etf/` and 404 there.
    assert.equal(
      instrumentRouteFamily({ symbol: "MINDSPACE", instrumentType: "REIT" }),
      "stock"
    );
    assert.equal(
      instrumentRouteFamily({ symbol: "IRBINVIT", instrumentType: "INVIT" }),
      "stock"
    );
  });

  it("`instrumentType` wins over `type`, but an EMPTY one falls through", () => {
    // The search route emits both fields; synthetic index rows set only `type`.
    assert.equal(
      instrumentRouteFamily({ symbol: "X", instrumentType: "", type: "ETF" }),
      "etf"
    );
    assert.equal(
      instrumentRouteFamily({
        symbol: "X",
        instrumentType: "EQUITY",
        type: "ETF",
      }),
      "stock"
    );
  });

  it("[regression] the symbol is percent-encoded — `M&M` is a real ticker", () => {
    // The raw-interpolated `/stock/${symbol}?exchange=${exchange}` this replaces
    // produced `/stock/M&M?exchange=NSE`, which a URL parser reads as the path
    // `M` plus a stray `M` parameter.
    assert.equal(
      instrumentDetailHref({ symbol: "M&M", exchange: "NSE" }),
      "/stock/M%26M?exchange=NSE"
    );
  });

  it("omits `exchange` when the caller does not know it", () => {
    assert.equal(
      instrumentDetailHref({ symbol: "GOLDBEES", instrumentType: "ETF" }),
      "/etf/GOLDBEES"
    );
    assert.equal(
      instrumentDetailHref({
        symbol: "GOLDBEES",
        exchange: "   ",
        instrumentType: "ETF",
      }),
      "/etf/GOLDBEES"
    );
  });

  it("appends a fragment AFTER the query string", () => {
    assert.equal(
      instrumentDetailHref({
        symbol: "RELIANCE",
        exchange: "NSE",
        hash: "chart",
      }),
      "/stock/RELIANCE?exchange=NSE#chart"
    );
    assert.equal(
      instrumentDetailHref({
        symbol: "119551",
        instrumentType: "MF",
        hash: "chart",
      }),
      "/mf/119551#chart"
    );
  });
});

// ── The lint ───────────────────────────────────────────────────────────────

/** LINE comments before BLOCK comments — MONEY-1143. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** A hand-rolled detail href: a template literal opening `/stock/`, `/etf/` or `/mf/`. */
const LITERAL_HREF = /`\/(stock|etf|mf)\/\$\{/;

/**
 * Every site MONEY-1205 converted. If one of these grows a literal href again,
 * the eight surfaces are free to disagree again — which is the entire defect.
 */
const CONVERTED = [
  "app/discover/client.tsx",
  "app/discover/screener/etf-mode.tsx",
  "app/holdings/client.tsx",
  "app/watchlist/client.tsx",
  "components/CommandPalette.tsx",
  "components/InstrumentSearch.tsx",
  "components/screener/FundCardCompact.tsx",
  // The redirects are route DECISIONS, not link sites, and they go through the
  // same helper so the destination cannot drift from what the links emit.
  "app/stock/[symbol]/page.tsx",
  "app/mf/[schemeCode]/page.tsx",
];

/**
 * Files that still build their own href. NOT a permission — an inventory, so a
 * NEW literal href anywhere in `apps/web` fails this test instead of quietly
 * joining the list. All of them are stock/MF-only surfaces where the ETF
 * ambiguity does not arise; converting them is follow-up work, and the right
 * fix for a failure here is the helper, not a longer list.
 */
const KNOWN_REMAINING = [
  "app/discover/markets/components/MoversColumn.tsx",
  "app/discover/screener/mf-mode.tsx",
  "app/discover/screener/stocks-mode.tsx",
  "app/discover/sectors/SectorDeepDive.tsx",
  "app/notifications/client.tsx",
  "components/analysis/ResearchReport.tsx",
  "components/chat/blocks/StockListBlockRenderer.tsx",
  "components/chat/sidebar/NotifsTabBody.tsx",
  "components/discover/IndexDetailView.tsx",
  "components/markets/Treemap.tsx",
  "components/screener/StockCardCompact.tsx",
  "components/stock/StockPeersTab.tsx",
];

/**
 * Every `.ts`/`.tsx` under app/, components/ and lib/.
 *
 * A filesystem walk rather than `git ls-files`: an UNTRACKED new file is
 * exactly the case this guard exists for, and it must fail before the file is
 * committed, not after.
 */
function listSourceFiles(dir = "", out: string[] = []): string[] {
  const abs = join(ROOT, dir);
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "__tests__" ||
        entry.name.startsWith(".")
      ) {
        continue;
      }
      listSourceFiles(rel, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

const SOURCE_ROOTS = ["app", "components", "lib"];

describe("MONEY-1205 — no link site rolls its own detail href", () => {
  it("[regression] every converted site is free of literal detail hrefs", () => {
    const offenders = CONVERTED.filter((rel) =>
      LITERAL_HREF.test(stripComments(readFileSync(join(ROOT, rel), "utf8")))
    );
    assert.deepEqual(
      offenders,
      [],
      `these were converted to instrumentDetailHref and must stay converted: ${offenders.join(", ")}`
    );
  });

  it("[regression] every converted site actually imports the helper", () => {
    const missing = CONVERTED.filter(
      (rel) =>
        !readFileSync(join(ROOT, rel), "utf8").includes(
          "@/lib/fund/instrument-href"
        )
    );
    assert.deepEqual(
      missing,
      [],
      `a site that does not import the helper is not using it: ${missing.join(", ")}`
    );
  });

  it("[regression] and no NEW file joins the un-converted set", () => {
    const found = SOURCE_ROOTS.flatMap((root) => listSourceFiles(root))
      .filter((rel) => !rel.startsWith("lib/fund/"))
      .filter((rel) => {
        try {
          return LITERAL_HREF.test(
            stripComments(readFileSync(join(ROOT, rel), "utf8"))
          );
        } catch {
          return false;
        }
      })
      .sort();

    const unexpected = found.filter((f) => !KNOWN_REMAINING.includes(f));
    assert.deepEqual(
      unexpected,
      [],
      `build the href with instrumentDetailHref() from @/lib/fund/instrument-href — ` +
        `these files hand-roll one: ${unexpected.join(", ")}`
    );
  });

  it("the helper itself is allowed to emit them — it is the only place", () => {
    // Guards the guard: if the exclusion above ever stopped matching, the
    // inventory test would pass for the wrong reason.
    const src = readFileSync(join(ROOT, "lib/fund/instrument-href.ts"), "utf8");
    assert.match(
      src,
      LITERAL_HREF,
      "the helper must be the one file that builds these"
    );
  });
});
