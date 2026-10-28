/**
 * Tool result → typed ContentBlock adapter (MONEY-587).
 *
 * The chat route auto-formats any tool result into a generic table/card. This
 * maps the high-frequency read tools to their RICH typed block instead, so
 * "show my holdings / portfolio / risk / news on X" render as the designed
 * blocks rather than a wall of cells. Returns null for unmapped tools (the
 * route keeps its generic table/card fallback) and for empty/odd-shaped data,
 * so a slightly-off shape degrades gracefully rather than rendering broken.
 *
 * Data shapes are the server-action return values:
 *   get_holdings           → Holding[]            (lib/actions/holdings)
 *   get_portfolio_summary  → DashboardStats       (lib/actions/dashboard)
 *   get_stock_news         → NewsArticle[]        (lib/actions/news)
 *   portfolio_risk_analysis→ PortfolioRiskResult  (services/risk.service)
 *   tax_report             → TaxReportResult      (services/tax.service)
 *   get_fire_scenarios     → FireScenario[]       (services/fire.service)
 *
 * A few tools also expose SECONDARY blocks via buildSecondaryBlocksFromTool
 * (e.g. risk → sector donut from concentration.sectorWeights), so the same
 * tool result can render more than one rich block when its data fits.
 */

import type {
  ContentBlock,
  HoldingsBlock,
  PortfolioBlock,
  NewsBlock,
  RiskBlock,
  TaxReportBlock,
  FireBlock,
  SectorBlock,
} from "@usemoney/types";

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec =>
  v && typeof v === "object" ? (v as Rec) : {};
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const r2 = (v: number): number => Math.round(v * 100) / 100;

function domainOf(url?: string): string | undefined {
  if (!url || url === "#") return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function relTime(d: unknown): string | undefined {
  if (!d) return undefined;
  const t =
    d instanceof Date
      ? d.getTime()
      : typeof d === "string"
        ? Date.parse(d)
        : NaN;
  if (!Number.isFinite(t)) return undefined;
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Dispatch a tool's result to its rich typed block, or null to fall back. */
export function buildTypedBlockFromTool(
  toolName: string,
  data: unknown
): ContentBlock | null {
  switch (toolName) {
    case "get_holdings":
      return holdingsBlock(data);
    case "get_portfolio_summary":
      return portfolioBlock(data);
    case "get_stock_news":
      return newsBlock(data);
    case "web_search":
      // Grounded web-search payload is { answer, articles: [...] }; the cited
      // web sources live in `.articles` (NewsBlock-shaped). The answer prose is
      // surfaced separately as the message narrative (deterministicToolSummary).
      return newsBlock(asRec(data).articles);
    case "portfolio_risk_analysis":
      return riskBlock(data);
    case "tax_report":
      return taxBlock(data);
    case "get_fire_scenarios":
      return fireBlock(data);
    case "fire_plan":
      // The turn attaches a scenario-shaped `plan` (currentCorpus, fireNumber,
      // ages, monthlySavings) when it acted on a real/created plan; reuse the
      // same builder. Absent (read vs defaults) → null → text-only reply.
      return fireBlock([asRec(data).plan]);
    // NOTE: technical / pnl / dividend have NO matching registered chat tool
    // (registry.ts has 33 tools, none of them produce these shapes), so there
    // is no producer to dispatch on here. Those blocks stay reachable via the
    // LLM `:::block:technical|pnl|dividend` marker whitelist (message-parser.ts).
    default:
      return null;
  }
}

/**
 * Secondary typed blocks a tool can render IN ADDITION to its primary block.
 * Keeps the primary 1:1 dispatch above simple while letting a rich result
 * (e.g. portfolio_risk_analysis) surface a second purpose-built block — its
 * sector donut — without flattening into a generic table. Returns [] when the
 * shape doesn't fit so the result degrades to its primary block alone.
 */
export function buildSecondaryBlocksFromTool(
  toolName: string,
  data: unknown
): ContentBlock[] {
  const out: ContentBlock[] = [];
  if (toolName === "portfolio_risk_analysis") {
    const sector = sectorBlockFromRisk(data);
    if (sector) out.push(sector);
  }
  return out;
}

function holdingsBlock(data: unknown): HoldingsBlock | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const rows = data
    .map((h) => {
      const o = asRec(h);
      return {
        symbol: String(o.symbol ?? ""),
        sector: o.sector ? String(o.sector) : undefined,
        qty: num(o.quantity) ?? 0,
        avg: r2(num(o.averagePrice) ?? 0),
        ltp: r2(num(o.currentPrice) ?? 0),
        pnl: Math.round(num(o.unrealizedPnL) ?? num(o.pnl) ?? 0),
        pnlPct: r2(num(o.pnlPercentage) ?? 0),
      };
    })
    .filter((row) => row.symbol);
  if (rows.length === 0) return null;
  return { type: "holdings", rows };
}

function portfolioBlock(data: unknown): PortfolioBlock | null {
  const d = asRec(data);
  const p = asRec(d.portfolio);
  const totalValue = num(p.totalValue);
  if (totalValue == null) return null;
  const trading = asRec(d.trading);
  const today = num(trading.todaysPnL);

  const hv = num(p.holdingsValue);
  const mv = num(p.mfValue);
  const ov = num(p.openPositionsValue);
  const segments: NonNullable<PortfolioBlock["segments"]> = [];
  const pushSeg = (label: string, val?: number) => {
    if (val && totalValue)
      segments.push({ label, pct: r2((val / totalValue) * 100) });
  };
  pushSeg("Equity", hv);
  pushSeg("Mutual funds", mv);
  pushSeg("F&O", ov);

  const pnlPct =
    typeof p.pnlPercentage === "string"
      ? parseFloat(p.pnlPercentage)
      : num(p.pnlPercentage);

  return {
    type: "portfolio",
    totalValue,
    dayChange:
      today != null
        ? {
            amount: Math.round(today),
            pct: totalValue ? r2((today / totalValue) * 100) : 0,
          }
        : undefined,
    totalPnL:
      pnlPct != null && Number.isFinite(pnlPct)
        ? { amount: num(p.totalPnL), pct: r2(pnlPct) }
        : undefined,
    holdingsValue: hv,
    mfValue: mv,
    openPositions: num(trading.openTrades),
    segments: segments.length ? segments : undefined,
  };
}

function newsBlock(data: unknown): NewsBlock | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const articles = data
    .map((a) => {
      const o = asRec(a);
      const link = o.link ? String(o.link) : o.url ? String(o.url) : undefined;
      const s = o.sentiment ? String(o.sentiment).toLowerCase() : undefined;
      const sentiment =
        s === "positive" || s === "negative" || s === "neutral"
          ? (s as "positive" | "negative" | "neutral")
          : undefined;
      return {
        headline: String(o.title ?? o.headline ?? ""),
        source: o.source ? String(o.source) : undefined,
        domain: domainOf(link),
        url: link && link !== "#" ? link : undefined,
        at: relTime(o.pubDate ?? o.publishedAt ?? o.at),
        sentiment,
      };
    })
    .filter((x) => x.headline);
  if (articles.length === 0) return null;
  return { type: "news", articles };
}

function riskBlock(data: unknown): RiskBlock | null {
  const d = asRec(data);
  const conc = asRec(d.concentration);
  const topHoldings = Array.isArray(conc.topHoldings)
    ? conc.topHoldings.map(asRec)
    : [];
  if (topHoldings.length === 0 && conc.hhi == null) return null;

  const top = num(topHoldings[0]?.weight);
  const top5 = topHoldings
    .slice(0, 5)
    .reduce((sum, h) => sum + (num(h.weight) ?? 0), 0);
  const vrh = asRec(asRec(d.var).historical);
  const dd = asRec(d.drawdown);

  // MONEY-1121 - VaR and drawdown are FRACTIONS, and the card stamps a "%"
  // onto whatever it is given. They were passed through unscaled while the
  // concentration weights below were multiplied by 100 in the same object, so
  // a -3% VaR rendered as "-0.03%" — a 100x understatement that made every
  // portfolio look risk-free (MONEY-1095 item 10).
  //
  // That these are fractions is not a guess: `compute-var` derives them from
  // `(curr - prev) / prev` and computes the rupee figure as
  // `|var95| * portfolioValue`, which is only correct for a fraction; and
  // `compute-drawdown` documents "a fraction of the prior peak". The `//
  // negative %` comment on VaRResult.var95 is what misled the original wiring.
  return {
    type: "risk",
    var1d: num(vrh.var95) != null ? r2(num(vrh.var95)! * 100) : undefined,
    maxDD:
      num(dd.maxDrawdown) != null ? r2(num(dd.maxDrawdown)! * 100) : undefined,
    concentration: {
      top: top != null ? r2(top * 100) : undefined,
      top5: topHoldings.length ? r2(top5 * 100) : undefined,
      hhi: num(conc.hhi) != null ? Math.round(num(conc.hhi)!) : undefined,
    },
  };
}

/**
 * tax_report → TaxReportResult (services/tax.service). Maps the capital-gains
 * STCG/LTCG buckets, harvesting opportunities, and the advance-tax schedule
 * onto the rich tax block. Returns null when there's no gains data at all.
 */
function taxBlock(data: unknown): TaxReportBlock | null {
  const d = asRec(data);
  const cg = asRec(d.capitalGains);
  const equity = asRec(cg.equity);
  const stcgR = asRec(equity.stcg);
  const ltcgR = asRec(equity.ltcg);
  const harvesting = asRec(d.harvesting);
  const advanceTax = asRec(d.advanceTax);

  const stcgGains = num(stcgR.net) ?? num(stcgR.gains);
  const ltcgGains = num(ltcgR.net) ?? num(ltcgR.gains);
  const hasGains =
    stcgGains != null || ltcgGains != null || num(cg.totalTax) != null;
  if (!hasGains) return null;

  const stcg =
    stcgGains != null
      ? { gains: Math.round(stcgGains), tax: Math.round(num(stcgR.tax) ?? 0) }
      : undefined;
  const ltcg =
    ltcgGains != null
      ? {
          gains: Math.round(ltcgGains),
          tax: Math.round(num(ltcgR.tax) ?? 0),
          exemptUsed:
            num(ltcgR.exemption) != null
              ? Math.round(num(ltcgR.exemption)!)
              : undefined,
        }
      : undefined;

  const opportunities = Array.isArray(harvesting.opportunities)
    ? harvesting.opportunities.map(asRec)
    : [];
  const harvest: NonNullable<TaxReportBlock["harvest"]> = opportunities
    .map((o) => ({
      symbol: String(o.symbol ?? ""),
      loss: Math.round(Math.abs(num(o.unrealizedLoss) ?? 0)),
      action: `Book ${o.type ? String(o.type) : "loss"} to save ${
        num(o.potentialTaxSaving) != null
          ? "₹" + Math.round(num(o.potentialTaxSaving)!).toLocaleString("en-IN")
          : "tax"
      }`,
    }))
    .filter((h) => h.symbol);

  const installments = Array.isArray(advanceTax.installments)
    ? advanceTax.installments.map(asRec)
    : [];
  const advance: NonNullable<TaxReportBlock["advance"]> = installments
    .map((i) => ({
      due: String(i.quarter ?? i.dueDate ?? ""),
      amount: Math.round(num(i.amount) ?? 0),
      paid: num(i.paid) != null && num(i.paid)! >= (num(i.amount) ?? 0),
    }))
    .filter((a) => a.due);

  // MONEY-1121 - distinguish "nothing to report" from "the report is broken".
  //
  // MONEY-1095 item 9 read as a calculation failure: a full statement with
  // STCG ₹0, LTCG ₹0 and four ₹0 advance-tax quarters, yet a live harvesting
  // suggestion beside it. The engine was right both times — harvesting reads
  // HOLDINGS while gains read PAIRED TRADES, and the account genuinely had no
  // realised trades in that FY (verified: the same query returns ₹16,111 STCG
  // / ₹3,222 tax for an account that does). Suppress the zero-filled sections
  // so the card can say so in words; harvesting still stands, because it is
  // real and actionable.
  const tradeCount = Array.isArray(cg.trades) ? cg.trades.length : undefined;
  const allZero =
    (stcg?.gains ?? 0) === 0 &&
    (stcg?.tax ?? 0) === 0 &&
    (ltcg?.gains ?? 0) === 0 &&
    (ltcg?.tax ?? 0) === 0;
  const noRealisedTrades = tradeCount === 0 && allZero;

  return {
    type: "tax",
    fy: cg.fy ? String(cg.fy) : undefined,
    stcg: noRealisedTrades ? undefined : stcg,
    ltcg: noRealisedTrades ? undefined : ltcg,
    harvest: harvest.length ? harvest : undefined,
    advance: noRealisedTrades || !advance.length ? undefined : advance,
    ...(noRealisedTrades ? { noRealisedTrades: true } : {}),
  };
}

/**
 * get_fire_scenarios → FireScenario[] (the FireScenario shape in
 * packages/types/src/fire). The service returns scenarios ordered most-recent
 * first (updatedAt desc), so the first entry is the one to project. Maps only
 * REAL FireScenario fields onto the single-scenario FIRE block:
 *   currentCorpus / fireNumber / monthlySavings / yearsToFire and, when
 * yearsToFire is absent, a (retirementAge − currentAge) fallback. Returns null
 * when the scenario has no corpus target. (`isDefault` / `withdrawalRate` are
 * not on the canonical FireScenario type, so we don't read them.)
 */
function fireBlock(data: unknown): FireBlock | null {
  const list = Array.isArray(data) ? data.map(asRec) : [];
  if (list.length === 0) return null;
  // Most-recent scenario (service orders by updatedAt desc).
  const scenario = list[0] ?? ({} as Rec);

  const currentCorpus = num(scenario.currentCorpus);
  const targetCorpus = num(scenario.fireNumber);
  if (currentCorpus == null || targetCorpus == null) return null;

  // Prefer the stored projection horizon; otherwise derive it from the ages.
  const currentAge = num(scenario.currentAge);
  const retirementAge = num(scenario.retirementAge);
  const derivedYears =
    currentAge != null && retirementAge != null && retirementAge > currentAge
      ? retirementAge - currentAge
      : undefined;
  const yearsToFire = num(scenario.yearsToFire) ?? derivedYears;

  return {
    type: "fire",
    currentCorpus: Math.round(currentCorpus),
    targetCorpus: Math.round(targetCorpus),
    yearsToFI: yearsToFire != null ? Math.round(yearsToFire) : undefined,
    monthlySIP:
      num(scenario.monthlySavings) != null
        ? Math.round(num(scenario.monthlySavings)!)
        : undefined,
  };
}

/**
 * sector block from a PortfolioRiskResult's concentration.sectorWeights.
 * SEBI-safe: a neutral allocation donut, no over/under-weight verdict unless
 * the source explicitly provides one. Returns null when no sector weights.
 */
function sectorBlockFromRisk(data: unknown): SectorBlock | null {
  const d = asRec(data);
  const conc = asRec(d.concentration);
  const weights = Array.isArray(conc.sectorWeights)
    ? conc.sectorWeights.map(asRec)
    : [];
  const sectors: SectorBlock["sectors"] = weights
    .map((w) => {
      const weight = num(w.weight) ?? 0;
      // weight may be a fraction (0–1) or already a percentage — normalize.
      const pct = weight <= 1 ? r2(weight * 100) : r2(weight);
      return { sector: String(w.sector ?? "Unknown"), pct };
    })
    .filter((s) => s.sector && s.pct > 0)
    .sort((a, b) => b.pct - a.pct);
  if (sectors.length === 0) return null;
  return { type: "sector", title: "Sector allocation", sectors };
}
