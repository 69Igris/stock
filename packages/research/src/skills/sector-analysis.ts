/**
 * Sector Analysis Skill - Sector overview with top stocks
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, synthesisTask } from "./types";

// Map common sector names to representative stocks
export const SECTOR_STOCKS: Record<string, string[]> = {
  banking: [
    "HDFCBANK.NS",
    "ICICIBANK.NS",
    "SBIN.NS",
    "KOTAKBANK.NS",
    "AXISBANK.NS",
  ],
  it: ["TCS.NS", "INFY.NS", "WIPRO.NS", "HCLTECH.NS", "TECHM.NS"],
  pharma: [
    "SUNPHARMA.NS",
    "DRREDDY.NS",
    "CIPLA.NS",
    "DIVISLAB.NS",
    "APOLLOHOSP.NS",
  ],
  auto: [
    "MARUTI.NS",
    "TATAMOTORS.NS",
    "M%26M.NS",
    "BAJAJ-AUTO.NS",
    "HEROMOTOCO.NS",
  ],
  // NTPC and POWERGRID MOVED to `utilities` (MONEY-1093). They are a power
  // generator and the transmission monopoly, not oil & gas — and leaving them
  // here forced the utilities basket to omit them, since a symbol in two
  // baskets breaks the no-duplicates invariant. Moving rather than duplicating
  // fixes BOTH baskets and keeps the invariant: energy is now genuinely
  // upstream/refining, which is what its own comment claimed it was.
  energy: ["RELIANCE.NS", "ONGC.NS", "ADANIENT.NS", "IOC.NS", "BPCL.NS"],
  fmcg: ["HINDUNILVR.NS", "ITC.NS", "NESTLEIND.NS", "BRITANNIA.NS", "DABUR.NS"],
  metals: [
    "TATASTEEL.NS",
    "HINDALCO.NS",
    "JSWSTEEL.NS",
    "COALINDIA.NS",
    "VEDL.NS",
  ],
  // Curated liquid large/mid caps per sector. These four were absent, so
  // Industrials, Telecommunication, Services and Diversified returned [] and
  // produced a news-only "sector analysis".
  industrials: ["LT.NS", "SIEMENS.NS", "ABB.NS", "CUMMINSIND.NS", "BHEL.NS"],
  telecom: [
    "BHARTIARTL.NS",
    "IDEA.NS",
    "INDUSTOWER.NS",
    "TATACOMM.NS",
    "HFCL.NS",
  ],
  services: [
    "IRCTC.NS",
    "INDIGO.NS",
    "CONCOR.NS",
    "DELHIVERY.NS",
    "TEAMLEASE.NS",
  ],
  diversified: [
    "GRASIM.NS",
    "BAJAJHLDNG.NS",
    "DCMSHRIRAM.NS",
    "KESORAMIND.NS",
    "ZUARIIND.NS",
  ],
  // Utilities used to alias onto `energy`, whose basket was majority oil & gas,
  // so a Utilities question was answered largely with upstream energy names.
  //
  // It then got its own basket that EXCLUDED NTPC and POWERGRID — India's
  // largest generator and its transmission monopoly — purely to satisfy the
  // no-duplicates invariant, because both sat in `energy`. That is a real
  // product cost paid for a bookkeeping rule: a Utilities analysis missing the
  // two most important utilities in the country. They are moved here from
  // `energy` instead, which satisfies the invariant and makes both baskets more
  // accurate.
  utilities: [
    "NTPC.NS",
    "POWERGRID.NS",
    "TATAPOWER.NS",
    "ADANIPOWER.NS",
    "JSWENERGY.NS",
    "TORNTPOWER.NS",
    "CESC.NS",
  ],
  realty: [
    "DLF.NS",
    "GODREJPROP.NS",
    "OBEROIRLTY.NS",
    "PRESTIGE.NS",
    "BRIGADE.NS",
  ],
};

/**
 * Canonical/alias sector name -> SECTOR_STOCKS key.
 *
 * Without this, only "Energy" and "FMCG" of the 13 canonical NSE sector names
 * matched a key at all — every other one fell through to the banking fallback
 * below, so a "Real Estate sector analysis" was answered with five private
 * banks and nothing said so. `skills/sector-deep-dive.ts` already carries an
 * equivalent map; this is the same idea applied to the sibling skill.
 */
const SECTOR_ALIASES: Record<string, string> = {
  // The planner emits "real estate"/"property"/"finance" as literal tokens;
  // omitting "finance" turned a previously-correct answer into no answer.
  "real estate": "realty",
  finance: "banking",
  realestate: "realty",
  property: "realty",
  niftyrealty: "realty",
  informationtechnology: "it",
  technology: "it",
  niftyit: "it",
  financialservices: "banking",
  financials: "banking",
  // Bare "financial" — the planner now emits it, because "how is the financial
  // sector" (the most natural phrasing of the largest sector on the exchange)
  // previously resolved to nothing at all. Without this alias the token reaches
  // the skill and produces an EMPTY basket, which is the same "fixed one layer
  // below the bug" shape this file's own comments warn about.
  financial: "banking",
  banks: "banking",
  bank: "banking",
  healthcare: "pharma",
  pharmaceuticals: "pharma",
  automobile: "auto",
  automobiles: "auto",
  consumerdiscretionary: "auto",
  commodities: "metals",
  telecommunication: "telecom",
  media: "telecom",
  metal: "metals",
  mining: "metals",
  steel: "metals",
  power: "energy",
  oilgas: "energy",
  // utilities has its own basket now — see the note in SECTOR_STOCKS.
  consumerstaples: "fmcg",
  consumer: "fmcg",
};

/**
 * Symbols for a sector, or [] when we genuinely do not cover it.
 *
 * Returning [] rather than a default basket is deliberate. This used to fall
 * back to `SECTOR_STOCKS["banking"]`, so an unmatched sector produced a
 * confident, fully-rendered analysis of five private banks under someone else's
 * heading — wrong data presented as an answer, which is worse than no data.
 * An empty list degrades to "no coverage", which is true.
 */
export function resolveSectorStocks(sector: string): string[] {
  const raw = sector.toLowerCase().replace(/[^a-z]/g, "");
  const key = SECTOR_ALIASES[raw] ?? raw;
  const hit = SECTOR_STOCKS[key];
  if (!hit) {
    console.warn(
      `[sector-analysis] no stock basket for sector "${sector}" ` +
        `(normalised "${raw}") — returning no coverage rather than substituting`,
    );
    return [];
  }
  return hit;
}

export const sectorAnalysisSkill: ResearchSkill = {
  name: "sector-analysis",
  description: "Sector overview with top stocks, performance, and outlook",
  triggers: [
    /\b(sector|industry)\s*(analysis|overview|performance|outlook)\b/i,
    /\bhow\s*(is|are)\s*the\s*(banking|it|pharma|auto|energy|fmcg|metal|real\s*estate)\s*(sector)?\b/i,
  ],
  requiredParams: ["sector"],
  buildPlan: (params): ResearchPlan => {
    const sector = String(params.sector ?? "");
    const stocks = resolveSectorStocks(sector);

    const tasks = [
      fetchTask("prices", "fetch_stock_price", { symbols: stocks }),
    ];

    const profileIds: string[] = ["prices"];
    for (let i = 0; i < Math.min(stocks.length, 5); i++) {
      const id = `profile_${i}`;
      tasks.push(fetchTask(id, "fetch_key_ratios", { symbol: stocks[i] }));
      profileIds.push(id);
    }

    // Peer data for sector PE/PB averages, using the first stock as the sector
    // representative — ONLY when there is one.
    //
    // `stocks[0]` on an empty basket is `undefined`, and `fetch_peer_companies`
    // calls `toNseSymbol(symbol)` -> `symbol.replace(...)` BEFORE its own
    // falsy-guard, so it threw a raw `TypeError: Cannot read properties of
    // undefined` into `task.error` — an unsanitized internal error on a user
    // path. The abstention was right; this plan just had not been taught about
    // it.
    if (stocks.length > 0) {
      tasks.push(
        fetchTask("sector_peers", "fetch_peer_companies", {
          symbol: stocks[0],
        }),
      );
    }

    tasks.push(
      fetchTask("news", "fetch_news", { symbol: sector }),
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query: (params.query as string) || `${sector} sector analysis`,
        },
        [...profileIds, "sector_peers", "news"],
      ),
    );

    return {
      query: (params.query as string) || `${sector} sector analysis`,
      skill: "sector-analysis",
      symbols: stocks,
      tasks,
      estimatedSteps: tasks.length,
      complexity: "moderate",
    };
  },
};
