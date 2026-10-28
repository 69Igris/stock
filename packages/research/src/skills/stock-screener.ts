/**
 * Stock Screener Skill - Filter stocks by criteria
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { computeTask, synthesisTask } from "./types";

// Default NIFTY 50 components for screening
const NIFTY50 = [
  "RELIANCE.NS",
  "TCS.NS",
  "HDFCBANK.NS",
  "ICICIBANK.NS",
  "INFY.NS",
  "HINDUNILVR.NS",
  "ITC.NS",
  "SBIN.NS",
  "BHARTIARTL.NS",
  "KOTAKBANK.NS",
  "LT.NS",
  "HCLTECH.NS",
  "AXISBANK.NS",
  "ASIANPAINT.NS",
  "MARUTI.NS",
  "SUNPHARMA.NS",
  "TATAMOTORS.NS",
  "BAJFINANCE.NS",
  "WIPRO.NS",
  "TITAN.NS",
  "ULTRACEMCO.NS",
  "NESTLEIND.NS",
  "TECHM.NS",
  "POWERGRID.NS",
  "NTPC.NS",
  "M%26M.NS",
  "TATASTEEL.NS",
  "ADANIENT.NS",
  "BAJAJFINSV.NS",
  "ONGC.NS",
  "JSWSTEEL.NS",
  "COALINDIA.NS",
  "DRREDDY.NS",
  "CIPLA.NS",
  "DIVISLAB.NS",
  "BRITANNIA.NS",
  "EICHERMOT.NS",
  "APOLLOHOSP.NS",
  "HEROMOTOCO.NS",
  "BAJAJ-AUTO.NS",
  "GRASIM.NS",
  "INDUSINDBK.NS",
  "HINDALCO.NS",
  "TATACONSUM.NS",
  "SBILIFE.NS",
  "HDFCLIFE.NS",
  "BPCL.NS",
  "DABUR.NS",
  "GODREJCP.NS",
  "DLF.NS",
];

export const stockScreenerSkill: ResearchSkill = {
  name: "stock-screener",
  description: "Screen/filter stocks by fundamental criteria",
  triggers: [
    /\b(screen|filter|find|search)\s*(stocks?|companies|shares)\b/i,
    /\bstocks?\s*(with|where|having)\s*(pe|pb|roe|roce|market\s*cap|dividend)\b/i,
  ],
  requiredParams: [],
  optionalParams: ["maxPE", "minPE", "maxMarketCap", "minMarketCap", "symbols"],
  buildPlan: (params): ResearchPlan => {
    const symbols = (params.symbols as string[]) || NIFTY50;

    const tasks = [
      computeTask(
        "screen",
        "screen_stocks",
        {
          symbols,
          maxPE: params.maxPE,
          minPE: params.minPE,
          maxMarketCap: params.maxMarketCap,
          minMarketCap: params.minMarketCap,
          sortBy: params.sortBy || "marketCap",
          sortOrder: params.sortOrder || "desc",
          limit: params.limit || 20,
        },
        [],
      ),
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query: (params.query as string) || "Stock screening results",
        },
        ["screen"],
      ),
    ];

    return {
      query: (params.query as string) || "Stock screening",
      skill: "stock-screener",
      symbols,
      tasks,
      estimatedSteps: tasks.length,
      complexity: "simple",
    };
  },
};
