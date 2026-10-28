/**
 * Deterministic, LLM-free narration for tool results (MONEY-587).
 *
 * The chat pipeline is plan -> run -> answer:
 *   1. plan  - Flash classifies intent + tier + persona (what's needed)
 *   2. run   - executeTool fetches the data
 *   3. answer- a second LLM call narrates the fetched data
 *
 * For list / data tools the fetched rows ARE the answer - there is no extra
 * insight for an LLM to add, so step 3's LLM call is pure waste (a Flash
 * round-trip + tokens + latency). For those tools we skip the LLM and write a
 * deterministic, tool-aware one-liner instead.
 *
 * KEPT on the LLM (NOT in the skip set): get_financial_data, portfolio_risk_
 * analysis, tax_report — they have no self-sufficient block and the model adds
 * genuine synthesis (trend/concentration/harvesting). The async analysis tools
 * (run_research / start_roast / run_comprehensive_analysis) never reach this
 * path (they poll), so they're irrelevant here.
 *
 * Pure module - no imports - so it stays trivially unit-testable.
 */

/**
 * Read tools whose rendered blocks (typed block, stock-list, or generic table
 * via lib/chat/tool-result-blocks.ts) fully answer the query. Narration is
 * skipped for these. Keep deliberately scoped to tools that render completely.
 */
export const DETERMINISTIC_LIST_TOOLS: ReadonlySet<string> = new Set([
  "get_holdings",
  "get_positions",
  "get_trades",
  "get_mutual_funds",
  "get_paper_positions",
  "get_portfolio_summary",
  "get_stock_news",
  // MONEY-610: shareholding + corp-actions render their own card + carry a
  // deterministic summary line, so no second LLM pass is needed.
  "get_shareholding",
  "get_corporate_actions",
  // web_search already produces a grounded ANSWER + cited sources — no second
  // LLM pass adds value, so narrate deterministically with the grounded answer.
  "web_search",
  // summarize_post returns its own finished summary — narrate it verbatim.
  "summarize_post",
  // fire_plan runs its own two-tier FIRE turn and returns a finished reply.
  "fire_plan",
  "get_fire_scenarios",
  "list_strategies",
  "get_user_documents",
  "get_scan_history",
  "get_scan_result",
  "run_screener",
  "run_strategy_scan",
]);

/** Whether the LLM narration step can be skipped for this tool. */
export function shouldSkipNarration(tool: string | undefined | null): boolean {
  return tool != null && DETERMINISTIC_LIST_TOOLS.has(tool);
}

/** Wrapper keys whose value is the primary row array (mirrors tool-result-blocks). */
const WRAPPER_KEYS = [
  "data",
  "results",
  "rows",
  "items",
  "scans",
  "documents",
  "positions",
  "holdings",
  "mutualFunds",
  "funds",
  "trades",
  "articles",
  "scenarios",
  "stocks",
];

/**
 * Count rows across a bare array, a `{ wrapper: [...] }` shape, `{ builtIn,
 * custom }` (list_strategies), or — last resort — the first array property.
 * Returns null when no list shape is recognised (e.g. a single-object payload).
 */
export function countResultRows(data: unknown): number | null {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.builtIn) || Array.isArray(obj.custom)) {
      return (
        ((obj.builtIn as unknown[]) || []).length +
        ((obj.custom as unknown[]) || []).length
      );
    }
    for (const k of WRAPPER_KEYS) {
      if (Array.isArray(obj[k])) return (obj[k] as unknown[]).length;
    }
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) return v.length;
    }
  }
  return null;
}

/** [singular, plural] noun + lead verb per list tool. */
const NOUN: Record<string, [string, string]> = {
  get_holdings: ["holding", "holdings"],
  get_positions: ["position", "positions"],
  get_trades: ["trade", "trades"],
  get_mutual_funds: ["mutual fund", "mutual funds"],
  get_paper_positions: ["paper-trading position", "paper-trading positions"],
  get_fire_scenarios: ["saved FIRE scenario", "saved FIRE scenarios"],
  list_strategies: ["strategy", "strategies"],
  get_user_documents: ["document", "documents"],
  get_scan_history: ["past scan", "past scans"],
  get_scan_result: ["matching stock", "matching stocks"],
  run_screener: ["matching stock", "matching stocks"],
  run_strategy_scan: ["matching stock", "matching stocks"],
};
const VERB: Record<string, string> = {
  get_holdings: "You hold",
  get_positions: "You have",
  get_trades: "Showing your",
  get_mutual_funds: "You hold",
  get_paper_positions: "You have",
  get_fire_scenarios: "You have",
  list_strategies: "Found",
  get_user_documents: "You have",
  get_scan_history: "Found",
  get_scan_result: "Found",
  run_screener: "Found",
  run_strategy_scan: "Found",
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** ₹ formatting (en-IN, no decimals for big numbers). */
function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}
function signedInr(n: number): string {
  return `${n < 0 ? "-" : ""}${inr(Math.abs(n))}`;
}

function get(data: unknown, key: string): unknown {
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

function portfolioLine(data: unknown): string {
  const p = (get(data, "portfolio") ?? data) as Record<string, unknown>;
  const tv = num(p?.totalValue);
  if (tv == null)
    return "Here's your portfolio snapshot — full breakdown below.";
  const pnl = num(p?.totalPnL);
  const pct = num(p?.pnlPercentage);
  let s = `Your portfolio is worth ${inr(tv)}`;
  if (pnl != null) {
    s += ` — overall P&L ${signedInr(pnl)}`;
    if (pct != null) s += ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
  }
  return `${s}. Full breakdown below.`;
}

function newsLine(data: unknown): string {
  const n = countResultRows(data);
  if (n === 0) return "No recent news found for this stock right now.";
  if (n != null)
    return `Here's the latest news — ${n} recent ${n === 1 ? "article" : "articles"} below.`;
  return "Here's the latest news below.";
}

/**
 * web_search: the grounded ANSWER is the narrative. Falls back to a count line
 * when the model returned sources but no prose (or the grounding degraded).
 */
function webSearchLine(data: unknown): string {
  const answer = get(data, "answer");
  if (typeof answer === "string" && answer.trim().length > 0) {
    return answer.trim();
  }
  const sources = get(data, "articles");
  const n = Array.isArray(sources) ? sources.length : 0;
  if (n > 0) {
    return `Here's what I found on the web — ${n} cited ${n === 1 ? "source" : "sources"} below.`;
  }
  return "I couldn't find fresh web results for that right now. Try rephrasing your search.";
}

/** summarize_post: the generated summary IS the narrative (MONEY-887). */
function summarizePostLine(data: unknown): string {
  const answer = get(data, "answer");
  if (typeof answer === "string" && answer.trim().length > 0) {
    return answer.trim();
  }
  return "Here's a summary of the article below.";
}

/** fire_plan: the server-side FIRE turn's own reply IS the narrative. */
function firePlanLine(data: unknown): string {
  const message = get(data, "message");
  if (typeof message === "string" && message.trim().length > 0) {
    return message.trim();
  }
  return "Updated your FIRE plan.";
}

function reportType(data: unknown): string {
  const t = String(get(data, "type") ?? get(data, "reportType") ?? "").trim();
  if (t === "portfolio_statement") return "portfolio statement";
  if (t === "tax" || t === "risk") return t;
  return "";
}

/**
 * A deterministic, LLM-free summary line for a tool result. Tool-aware: list
 * tools get a count, the portfolio summary reads its totals, and write/confirm
 * tools (buy/sell/create/generate) interpolate the persisted record. Caller
 * must only emit this on success.
 */
export function deterministicToolSummary(
  tool: string | undefined,
  data: unknown
): string {
  switch (tool) {
    case "get_portfolio_summary":
      return portfolioLine(data);
    case "get_stock_news":
      return newsLine(data);
    case "web_search":
      return webSearchLine(data);
    case "summarize_post":
      return summarizePostLine(data);
    case "fire_plan":
      return firePlanLine(data);
    case "buy_paper_position": {
      const sym = get(data, "symbol");
      const qty = get(data, "quantity");
      const px = num(get(data, "averagePrice"));
      if (sym && qty != null) {
        return `Done — bought ${qty} ${sym}${px != null ? ` at ${inr(px)}` : ""} in your paper portfolio.`;
      }
      return "Done — your paper position has been added.";
    }
    case "sell_paper_position": {
      const pnl = num(get(data, "pnl"));
      if (pnl != null) {
        return `Position closed — booked a realised ${pnl >= 0 ? "profit" : "loss"} of ${inr(Math.abs(pnl))}.`;
      }
      return "Position closed.";
    }
    case "create_fire_scenario": {
      const name = get(data, "name");
      return `Saved your FIRE scenario${name ? ` "${name}"` : ""} — open the FIRE planner to run the full projection.`;
    }
    case "create_strategy": {
      const name = get(data, "name");
      return `Created your strategy${name ? ` "${name}"` : ""}. Run it any time to scan for matching stocks.`;
    }
    case "generate_report": {
      const t = reportType(data);
      return `Generating your ${t ? `${t} ` : ""}report — a download link will appear here as soon as it's ready.`;
    }
    case "get_shareholding": {
      const rows = Array.isArray(data) ? data : [];
      const latest = rows[0] as
        | {
            quarter?: string;
            promoter?: number;
            fii?: number;
            dii?: number;
            public?: number;
          }
        | undefined;
      if (!latest)
        return "No shareholding data is available for this stock yet.";
      const p = (n: number | undefined) =>
        typeof n === "number" ? `${n.toFixed(1)}%` : "—";
      return `Shareholding${latest.quarter ? ` (${latest.quarter})` : ""}: promoters ${p(latest.promoter)}, FII ${p(latest.fii)}, DII ${p(latest.dii)}, public ${p(latest.public)} — full history below.`;
    }
    case "get_corporate_actions": {
      const rows = Array.isArray(data) ? data : [];
      if (rows.length === 0)
        return "No recent corporate actions found for this stock.";
      const first = rows[0] as
        | { actionType?: string; exDate?: string | null }
        | undefined;
      const lead = first?.actionType
        ? ` (latest: ${first.actionType}${first.exDate ? `, ex-date ${first.exDate}` : ""})`
        : "";
      return `Found ${rows.length} corporate action${rows.length === 1 ? "" : "s"}${lead} — details below.`;
    }
  }

  const noun = tool ? NOUN[tool] : undefined;
  const count = countResultRows(data);
  if (noun) {
    if (count === 0) {
      if (tool === "run_screener" || tool === "run_strategy_scan") {
        return "No stocks matched these criteria. Try a different strategy or open the screener to adjust the filters.";
      }
      return `You don't have any ${noun[1]} yet.`;
    }
    if (count != null) {
      return `${VERB[tool!] || "Found"} ${count} ${count === 1 ? noun[0] : noun[1]} — details are below.`;
    }
  }

  // Generic fallback for any other tool.
  if (count === 0) return "No results found.";
  if (count != null)
    return `Found ${count} ${count === 1 ? "result" : "results"} — details are below.`;
  return "Here's what I found below.";
}
