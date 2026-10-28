/**
 * Sector Deep Dive Skill - Enhanced sector analysis
 *
 * An upgraded version of sector-analysis that includes:
 * - Sector aggregate metrics (PE, ROE, D/E averages)
 * - Sector rotation signals (relative performance vs Nifty)
 * - Top/bottom performers within the sector
 * - Macro sensitivity for the sector
 */

import type { ResearchPlan } from "../types";
import { SECTOR_STOCKS as ANALYSIS_SECTOR_STOCKS } from "./sector-analysis";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";

// ─── Sector → Representative stocks (expanded for deeper analysis) ──────

/**
 * Keys this file curates itself. The sibling's versions of these must NOT
 * overwrite them — see the note on the spread below, where a later spread wins.
 *
 * Listed explicitly (rather than read back off the literal) because the literal
 * is what contains the spread, so it cannot reference itself.
 */
const LOCALLY_CURATED = new Set([
  "banking",
  "it",
  "pharma",
  "auto",
  "energy",
  "fmcg",
  "metals",
  "realty",
  "infra",
  "financial",
]);

const SECTOR_STOCKS: Record<string, string[]> = {
  banking: [
    "HDFCBANK.NS",
    "ICICIBANK.NS",
    "SBIN.NS",
    "KOTAKBANK.NS",
    "AXISBANK.NS",
    "INDUSINDBK.NS",
    "BANDHANBNK.NS",
    "FEDERALBNK.NS",
    "IDFCFIRSTB.NS",
    "PNB.NS",
    "BANKBARODA.NS",
    "CANBK.NS",
    "AUBANK.NS",
    "RBLBANK.NS",
    "IDBI.NS",
  ],
  it: [
    "TCS.NS",
    "INFY.NS",
    "WIPRO.NS",
    "HCLTECH.NS",
    "TECHM.NS",
    "LTIM.NS",
    "MPHASIS.NS",
    "COFORGE.NS",
    "PERSISTENT.NS",
    "LTTS.NS",
    "CYIENT.NS",
    "TATAELXSI.NS",
    "MASTEK.NS",
    "SONATSOFTW.NS",
    "HAPPSTMNDS.NS",
  ],
  pharma: [
    "SUNPHARMA.NS",
    "DRREDDY.NS",
    "CIPLA.NS",
    "DIVISLAB.NS",
    "APOLLOHOSP.NS",
    "LUPIN.NS",
    "AUROPHARMA.NS",
    "TORNTPHARM.NS",
    "ALKEM.NS",
    "BIOCON.NS",
    "LALPATHLAB.NS",
    "IPCALAB.NS",
    "GLENMARK.NS",
    "NATCOPHARMA.NS",
    "LAURUSLABS.NS",
  ],
  auto: [
    "MARUTI.NS",
    "TATAMOTORS.NS",
    "M%26M.NS",
    "BAJAJ-AUTO.NS",
    "HEROMOTOCO.NS",
    "EICHERMOT.NS",
    "ASHOKLEY.NS",
    "TVSMOTOR.NS",
    "BALKRISIND.NS",
    "MOTHERSON.NS",
    "BHARATFORG.NS",
    "MRF.NS",
    "APOLLOTYRE.NS",
    "EXIDEIND.NS",
    "BOSCHLTD.NS",
  ],
  energy: [
    "RELIANCE.NS",
    "ONGC.NS",
    "NTPC.NS",
    "POWERGRID.NS",
    "ADANIENT.NS",
    "BPCL.NS",
    "IOC.NS",
    "GAIL.NS",
    "TATAPOWER.NS",
    "ADANIGREEN.NS",
    "ADANIPORTS.NS",
    "PETRONET.NS",
    "HINDPETRO.NS",
    "TORNTPOWER.NS",
    "NHPC.NS",
  ],
  fmcg: [
    "HINDUNILVR.NS",
    "ITC.NS",
    "NESTLEIND.NS",
    "BRITANNIA.NS",
    "DABUR.NS",
    "GODREJCP.NS",
    "MARICO.NS",
    "COLPAL.NS",
    "TATACONSUM.NS",
    "EMAMILTD.NS",
    "VBL.NS",
    "UBL.NS",
    "PGHH.NS",
    "RADICO.NS",
    "JYOTHYLAB.NS",
  ],
  metals: [
    "TATASTEEL.NS",
    "HINDALCO.NS",
    "JSWSTEEL.NS",
    "COALINDIA.NS",
    "VEDL.NS",
    "NMDC.NS",
    "NATIONALUM.NS",
    "SAIL.NS",
    "JINDALSTEL.NS",
    "APLAPOLLO.NS",
    "RATNAMANI.NS",
    "WELCORP.NS",
    "MOIL.NS",
    "HINDCOPPER.NS",
    "MISHRA.NS",
  ],
  realty: [
    "DLF.NS",
    "GODREJPROP.NS",
    "OBEROIRLTY.NS",
    "PRESTIGE.NS",
    "BRIGADE.NS",
    "PHOENIXLTD.NS",
    "SOBHA.NS",
    "SUNTECK.NS",
    "MAHLIFE.NS",
    "LODHA.NS",
  ],
  infra: [
    "LT.NS",
    "ADANIENT.NS",
    "ULTRACEMCO.NS",
    "GRASIM.NS",
    "AMBUJACEM.NS",
    "ACC.NS",
    "SHREECEM.NS",
    "IRCON.NS",
    "NBCC.NS",
    "NCC.NS",
    "KEC.NS",
    "BEL.NS",
    "HAL.NS",
    "RVNL.NS",
    "IRB.NS",
  ],
  financial: [
    "HDFCBANK.NS",
    "ICICIBANK.NS",
    "SBIN.NS",
    "BAJFINANCE.NS",
    "BAJAJFINSV.NS",
    "HDFCLIFE.NS",
    "SBILIFE.NS",
    "ICICIPRULI.NS",
    "MUTHOOTFIN.NS",
    "CHOLAFIN.NS",
    "MANAPPURAM.NS",
    "PEL.NS",
    "ICICIGI.NS",
    "SBICARD.NS",
    "RECLTD.NS",
  ],
  // Baskets this file lacked, taken from the sibling skill rather than copied.
  //
  // 8 of the 13 canonical sectors resolved to an EMPTY basket here while the
  // sibling had a full set — the exact divergence that comes from two files
  // owning the same knowledge. Spreading the sibling's map means the next basket
  // added there reaches this skill too.
  //
  // A LATER SPREAD WINS. The previous comment claimed "the entries above still
  // win, because this skill's own curation (infra, financial) is deliberately
  // different" — that is backwards: `({ a: 1, ...{ a: 2 } }).a === 2`. It is
  // inert today ONLY because the exclusion list below happens to cover every
  // key the two maps share. The moment someone adds an `infra` or `financial`
  // basket to sector-analysis.ts, this file's carefully curated 15-name version
  // would be silently replaced by the sibling's — with the comment still
  // asserting the opposite.
  //
  // So the exclusion list is LOAD-BEARING, not a convenience, and it is derived
  // rather than hand-written: every key defined above is excluded, which is the
  // invariant the comment was trying to describe.
  ...Object.fromEntries(
    Object.entries(ANALYSIS_SECTOR_STOCKS).filter(
      ([k]) => !LOCALLY_CURATED.has(k),
    ),
  ),
};

// ─── Sector → Nifty sectoral index symbol ────────────────────────────

const SECTOR_INDEX: Record<string, string> = {
  banking: "^NSEBANK",
  it: "^CNXIT",
  pharma: "^CNXPHARMA",
  auto: "^CNXAUTO",
  energy: "^CNXENERGY",
  fmcg: "^CNXFMCG",
  metals: "^CNXMETAL",
  realty: "^CNXREALTY",
  infra: "^CNXINFRA",
  financial: "^CNXFIN",
};

// ─── Sector → Macro drivers ─────────────────────────────────────────

const SECTOR_MACRO_DRIVERS: Record<string, string[]> = {
  banking: [
    "interest_rates",
    "credit_growth",
    "npa_trends",
    "gdp_growth",
    "rbi_policy",
  ],
  it: [
    "usd_inr",
    "us_tech_spending",
    "visa_policy",
    "global_recession_risk",
    "ai_disruption",
  ],
  pharma: [
    "usfda_approvals",
    "usd_inr",
    "healthcare_spending",
    "patent_cliffs",
    "raw_material_costs",
  ],
  auto: [
    "interest_rates",
    "commodity_prices",
    "ev_transition",
    "fuel_prices",
    "consumer_sentiment",
  ],
  energy: [
    "crude_oil_prices",
    "government_policy",
    "renewable_push",
    "global_demand",
    "geopolitics",
  ],
  fmcg: [
    "rural_demand",
    "inflation",
    "raw_material_costs",
    "consumer_sentiment",
    "monsoon",
  ],
  metals: [
    "china_demand",
    "global_commodity_cycle",
    "infrastructure_spending",
    "anti_dumping_duties",
    "energy_costs",
  ],
  realty: [
    "interest_rates",
    "affordability_index",
    "urbanization",
    "government_incentives",
    "inventory_levels",
  ],
  infra: [
    "government_capex",
    "interest_rates",
    "order_book_growth",
    "raw_material_costs",
    "election_cycle",
  ],
  financial: [
    "interest_rates",
    "credit_growth",
    "insurance_penetration",
    "capital_markets_activity",
    "regulation",
  ],
};

// ─── Helpers ────────────────────────────────────────────────────────

function normalizeSectorKey(sector: string | undefined | null): string {
  // Tolerates absent input. `params.sector` is `unknown`, and until the planner
  // learned "real estate" it arrived undefined for every natural phrasing of
  // that sector — `undefined.toLowerCase()` then threw a TypeError which the
  // error sanitizer passed through VERBATIM to the user on a FAILED run.
  const key = String(sector ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z]/g, "");

  // Alias mapping
  const aliases: Record<string, string> = {
    // "finance" is a token the planner emits and this map lacked, so a finance
    // query fell through to the banking DEFAULT rather than being aliased —
    // right answer, wrong reason, and it broke when that default was removed.
    // Mapped to "financial" to match this file's own convention (see the
    // financials/financialservices entries below), NOT to "banking".
    finance: "financial",
    // The CANONICAL sector names, which this map did not cover — 8 of the 13
    // resolved to an empty basket here, including Information Technology,
    // because the map had `information` but not `informationtechnology`. The
    // sibling skill received a full alias map and five new baskets in the same
    // commit and this file received one entry.
    informationtechnology: "it",
    consumerdiscretionary: "auto",
    commodities: "metals",
    telecommunication: "telecom",
    media: "telecom",
    utilities: "utilities",
    services: "services",
    diversified: "diversified",
    industrials: "industrials",
    bank: "banking",
    banks: "banking",
    niftybank: "banking",
    privatbank: "banking",
    psubank: "banking",
    information: "it",
    technology: "it",
    tech: "it",
    niftyit: "it",
    software: "it",
    healthcare: "pharma",
    pharmaceutical: "pharma",
    niftypharma: "pharma",
    automobile: "auto",
    automotive: "auto",
    niftyauto: "auto",
    oil: "energy",
    oilandgas: "energy",
    power: "energy",
    niftyenergy: "energy",
    consumer: "fmcg",
    consumerstaples: "fmcg",
    niftyfmcg: "fmcg",
    metal: "metals",
    mining: "metals",
    steel: "metals",
    niftymetal: "metals",
    realestate: "realty",
    property: "realty",
    niftyrealty: "realty",
    infrastructure: "infra",
    cement: "infra",
    construction: "infra",
    niftyinfra: "infra",
    financials: "financial",
    financialservices: "financial",
    nbfc: "financial",
    insurance: "financial",
    niftyfin: "financial",
  };

  return aliases[key] || key;
}

function resolveSectorStocks(
  sector: string,
  extraSymbols?: string[],
): string[] {
  const key = normalizeSectorKey(sector);
  // No banking substitute. This used to be
  // `SECTOR_STOCKS[key] || SECTOR_STOCKS["banking"]`, which answered any
  // unmatched sector with fifteen private banks under someone else's heading —
  // and this skill WINS the trigger race for "<x> sector analysis", so it was
  // the path users actually hit. An empty basket degrades to "no coverage",
  // which is true; a confident wrong answer is not.
  const base = SECTOR_STOCKS[key] ?? [];

  if (extraSymbols && extraSymbols.length > 0) {
    // Merge without duplicates
    const set = new Set(base);
    for (const s of extraSymbols) {
      set.add(s);
    }
    return Array.from(set);
  }

  return base;
}

function resolveSectorIndex(sector: string): string {
  const key = normalizeSectorKey(sector);
  return SECTOR_INDEX[key] || "^NSEI"; // fallback to Nifty 50
}

function resolveMacroDrivers(sector: string): string[] {
  const key = normalizeSectorKey(sector);
  return (
    SECTOR_MACRO_DRIVERS[key] || [
      "gdp_growth",
      "interest_rates",
      "inflation",
      "global_demand",
      "government_policy",
    ]
  );
}

// ─── Skill Definition ───────────────────────────────────────────────

export const sectorDeepDiveSkill: ResearchSkill = {
  name: "sector-deep-dive",
  description:
    "Deep analysis of a sector including aggregates, rotation, and macro impact",
  triggers: [
    /\bsector\s*deep\s*dive\b/i,
    // The bare sector-rotation trigger moved to flows-and-positioning (v2),
    // which registers first — an identical copy here could never match.
    /\bsector\s*analysis\s*detailed\b/i,
    /\bsector\s*outlook\b/i,
    /\bhow\s*is\s*(the\s*)?(banking|it|pharma|auto|fmcg|metal|real\s*estate|energy|infra|financial)\s*sector\b/i,
    /\b(banking|it|pharma|auto|fmcg|metal|metals|real\s*estate|energy|infra|financial)\s*sector\s*(deep\s*dive|analysis|outlook|rotation|performance|overview)\b/i,
    /\b(nifty\s*bank|nifty\s*it|nifty\s*pharma|nifty\s*auto|nifty\s*fmcg|nifty\s*metal|nifty\s*realty|nifty\s*energy|nifty\s*infra|nifty\s*fin)\s*(analysis|outlook|performance|deep\s*dive)\b/i,
  ],
  requiredParams: ["sector"],
  optionalParams: ["symbols"],
  buildPlan: (params): ResearchPlan => {
    // String(... ?? ""), matching the sibling skill. `params.sector` is
    // `unknown` and the planner only sets it when a sector was recognised, so
    // the sector-agnostic triggers on this skill ("sector outlook", "sector deep
    // dive") arrive with it undefined — which then rendered the literal string
    // "undefined" into the synthesis query and threw a TypeError out of
    // fetch_news. The sibling was fixed and this one was not.
    const sector = String(params.sector ?? "");
    const extraSymbols = params.symbols as string[] | undefined;
    const stocks = resolveSectorStocks(sector, extraSymbols);
    const sectorIndex = resolveSectorIndex(sector);
    const macroDrivers = resolveMacroDrivers(sector);

    const tasks = [
      // ── Task 1: Screen sector stocks for aggregate data ──────────
      fetchTask("screen_sector", "screen_stocks_advanced", {
        filters: {
          // Tickertape screener fetches broad sector stocks with key metrics
          // The sector stocks list provides the universe; the screener enriches
        },
        limit: 30,
        // We pass sector stocks so the execution context can cross-reference
        sectorStocks: stocks,
      }),

      // ── Task 2: Fetch key ratios for top sector stocks ───────────
      // Fetch ratios for up to 15 stocks for aggregate metrics
      ...stocks
        .slice(0, 15)
        .map((symbol, i) =>
          fetchTask(`ratios_${i}`, "fetch_key_ratios", { symbol }),
        ),

      // ── Task 3: Sector index price history (for rotation signals) ─
      fetchTask("sector_index_history", "fetch_price_history", {
        symbol: sectorIndex,
        period: "1y",
        interval: "1wk",
      }),

      // ── Task 4: Nifty 50 price history (benchmark for relative perf) ─
      fetchTask("nifty_history", "fetch_price_history", {
        symbol: "^NSEI",
        period: "1y",
        interval: "1wk",
      }),

      // ── Task 5: Current prices for all sector stocks ─────────────
      fetchTask("prices", "fetch_stock_price", { symbols: stocks }),

      // ── Task 6: Sector news ──────────────────────────────────────
      fetchTask("news", "fetch_news", { symbol: sector }),

      // ── Task 7: Compute sector aggregates (PE, ROE, D/E averages) ─
      // Depends on all ratio fetches + prices
      computeTask(
        "sector_aggregates",
        "compute_comparative_valuation",
        {
          symbol: stocks[0],
          aggregateMode: true,
          sectorName: sector,
        },
        [...stocks.slice(0, 15).map((_, i) => `ratios_${i}`), "prices"],
      ),

      // ── Task 8: Compute technical analysis on sector index ───────
      computeTask(
        "sector_technicals",
        "compute_technical_analysis",
        {
          symbol: sectorIndex,
        },
        ["sector_index_history"],
      ),

      // ── Task 9: Compute macro impact / sensitivity ───────────────
      // Uses sector index + Nifty history to derive rotation signals
      // and maps macro drivers to the sector
      computeTask(
        "macro_impact",
        "synthesize_report",
        {
          query: `Analyze macro sensitivity for ${sector} sector. Key drivers: ${macroDrivers.join(", ")}. Determine sector rotation signals by comparing sector index performance vs Nifty 50. Identify whether the sector is in accumulation, markup, distribution, or markdown phase.`,
          reportType: "macro_sensitivity",
          sectorName: sector,
          macroDrivers,
        },
        ["sector_index_history", "nifty_history"],
      ),

      // ── Task 10: Final synthesis ─────────────────────────────────
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `Comprehensive deep dive of ${sector} sector`,
          reportType: "sector_deep_dive",
          sectorName: sector,
          macroDrivers,
          sectorIndex,
          instructions: [
            "Provide sector aggregate metrics: average PE, PB, ROE, D/E, and how they compare to historical averages",
            "Identify top 5 and bottom 5 performers by 1Y returns within the sector",
            "Analyze sector rotation: is money flowing into or out of this sector relative to Nifty?",
            "Discuss macro sensitivity: which economic factors most impact this sector and current outlook",
            "Provide sector technical view: trend, support/resistance on sectoral index",
            "Give an overall sector rating: Overweight, Neutral, or Underweight with reasoning",
          ],
        },
        [
          "screen_sector",
          ...stocks.slice(0, 15).map((_, i) => `ratios_${i}`),
          "sector_index_history",
          "nifty_history",
          "prices",
          "news",
          "sector_aggregates",
          "sector_technicals",
          "macro_impact",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) ||
        `Comprehensive deep dive of ${sector} sector`,
      skill: "sector-deep-dive",
      symbols: stocks,
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
