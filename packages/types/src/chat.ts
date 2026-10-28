/**
 * Chat Dashboard - TypeScript Type Definitions
 *
 * ContentBlock discriminated union for rich message rendering,
 * ChatContextMode for context switching, and extended chat types.
 */

// ============== Content Block Types ==============

/**
 * Markdown text content
 */
export interface TextBlock {
  type: "text";
  content: string;
}

/**
 * Data table with columns and rows
 */
export interface TableBlock {
  type: "table";
  title?: string;
  columns: TableColumn[];
  rows: Record<string, unknown>[];
  maxRows?: number;
}

export interface TableColumn {
  key: string;
  label: string;
  align?: "left" | "center" | "right";
  format?: "currency" | "pnl" | "percentage" | "number" | "date" | "text";
}

/**
 * Metric/info card (portfolio stats, stock info, MF info)
 */
export interface CardBlock {
  type: "card";
  variant: "metric" | "stock" | "mf" | "info";
  title: string;
  value?: string;
  subtitle?: string;
  change?: number;
  changeLabel?: string;
  icon?: string;
  items?: CardItem[];
}

export interface CardItem {
  label: string;
  value: string;
  format?: "currency" | "pnl" | "percentage" | "text";
}

/**
 * Recharts data for inline charts
 */
export interface ChartBlock {
  type: "chart";
  chartType: "area" | "line" | "bar" | "pie" | "tradingview";
  title?: string;
  subtitle?: string;
  /** Recharts data - required for area/line/bar/pie */
  data?: Record<string, unknown>[];
  xKey?: string;
  yKeys?: ChartYKey[];
  /** TradingView symbol - required for tradingview chartType (e.g. "NSE:TCS") */
  symbol?: string;
  height?: number;
}

export interface ChartYKey {
  key: string;
  label: string;
  color?: string;
  format?: "currency" | "pnl" | "percentage" | "number";
}

/**
 * Confirmable write operation
 */
export interface TaskProgressItem {
  id: string;
  tool: string;
  type: string;
  status: string;
  durationMs?: number;
  /** Summarized tool output for completed tasks (streamed during polling) */
  resultSummary?: unknown;
}

export interface ActionBlock {
  type: "action";
  actionId: string;
  tool: string;
  description: string;
  params: Record<string, unknown>;
  status:
    | "pending"
    | "confirmed"
    | "cancelled"
    | "executed"
    | "failed"
    | "polling";
  result?: string;
  sessionId?: string;
  progress?: number;
  currentStep?: string;
  skill?: string;
  totalSteps?: number;
  taskProgress?: TaskProgressItem[];

  // ── ConfirmModal variant fields (MONEY-587, StockSage design) ──
  // All optional: the renderer infers sensible defaults from `tool` when a
  // producer hasn't populated them. See lib/chat/confirm-config.ts.
  /** Which confirmation card to render. Inferred from `tool` if absent. */
  variant?:
    | "generic"
    | "research"
    | "disambiguation"
    | "paid"
    | "roast"
    | "trade"
    | "connect"
    | "danger";
  /** Accent color family (border + icon). */
  accent?: "warning" | "danger" | "emerald" | "info" | "violet" | "neutral";
  /** "highlight" draws a colored border + glow ring (gold/red emphasis). */
  frame?: "default" | "highlight";
  /** Lucide icon name for the card header badge. */
  icon?: string;
  /** Credit cost shown as a chip (paid / roast variants). */
  credits?: number;
  /** Estimated run time, e.g. "~40s". */
  eta?: string;
  /** Model label, e.g. "Pro + grounding". */
  model?: string;
  /** Serif-italic disclaimer footer text. */
  disclaimer?: string;
  /** Paper-trade order summary (trade variant). */
  order?: {
    side: "BUY" | "SELL";
    symbol: string;
    qty: string;
    type: string;
    value: string;
  };
  /** Broker chips (connect variant). */
  brokers?: string[];
  /** Disambiguation candidates (research/disambiguation variants). */
  candidates?: Array<{ ticker: string; name: string; exchange: string }>;
  /** Post-confirm CTA link (e.g. "Open run"). */
  confirmedCta?: { label: string; href?: string };
}

/**
 * Navigation link/button to another page
 */
export interface NavigationBlock {
  type: "navigation";
  links: NavigationLink[];
}

export interface NavigationLink {
  label: string;
  href: string;
  icon?: string;
  description?: string;
}

/**
 * Side-by-side comparison (MF/stock)
 */
export interface ComparisonBlock {
  type: "comparison";
  title?: string;
  items: ComparisonItem[];
  metrics: ComparisonMetric[];
}

export interface ComparisonItem {
  name: string;
  subtitle?: string;
  icon?: string;
}

export interface ComparisonMetric {
  label: string;
  values: string[];
  format?: "currency" | "pnl" | "percentage" | "text";
  highlight?: "higher" | "lower";
}

/**
 * Paginated stock list from screener results
 */
export interface StockListBlock {
  type: "stock-list";
  title: string;
  /** Short plain-language explanation of what the metrics mean */
  description?: string;
  stocks: Array<{
    symbol: string;
    name?: string;
    sector?: string;
    exchange?: string;
    metrics: Record<string, string | number>;
  }>;
  total: number;
  screenQuery?: string;
  pageSize?: number;
}

/**
 * Styled error/warning alert
 */
export interface ErrorBlock {
  type: "error";
  severity: "error" | "warning" | "info";
  title: string;
  message?: string;
}

/**
 * Inline research option selector (Claude-style tool approval)
 */
export interface ResearchPromptBlock {
  type: "research-prompt";
  title: string;
  symbol: string;
  options: Array<{
    id: string;
    label: string;
    description?: string;
    icon?: string;
    tool: string;
    params: Record<string, unknown>;
  }>;
  status: "pending" | "selected" | "cancelled";
  selectedOptionId?: string;
  actionId?: string;
}

/**
 * Off-topic refusal (MONEY-295) - user query failed the topic
 * classifier. Renders branded copy + clickable suggestion chips that
 * fire on-topic queries when tapped.
 */
export interface RefusalBlock {
  type: "refusal";
  /** Polite refusal text shown to the user. */
  message: string;
  /** Clickable on-topic prompts. Click sends as a new chat message. */
  suggestions: string[];
  /** Classifier debug field (kept off the visible UI; useful for analytics). */
  category?: string;
}

/**
 * Streaming research progress (task-by-task updates)
 */
export interface ResearchStreamBlock {
  type: "research-stream";
  sessionId: string;
  actionId: string;
  status: "running" | "completed" | "failed";
  progress: number;
  currentStep?: string;
  /**
   * Selected research depth/mode (e.g. "fast" | "advanced") — drives the card's
   * depth label so it reflects what the user actually chose (MONEY-669). The
   * ResearchSession DB row doesn't store mode, so it's threaded onto the block
   * at creation from the confirm action's params.mode.
   */
  mode?: string;
  skill?: string;
  totalSteps?: number;
  taskProgress?: TaskProgressItem[];
}

/**
 * The full structured research report rendered IN CHAT through the same
 * <ResearchReport> renderer the /analysis page uses (MONEY-676, P6) — so the
 * chat-inline report and the analysis report no longer diverge. `report` is the
 * StructuredReport (typed in apps/web/components/analysis/types); kept as
 * `unknown` here to avoid a cross-package dependency — the renderer casts it.
 */
export interface StructuredReportBlock {
  type: "structured-report";
  report: unknown;
  symbol: string;
  sessionId?: string;
  /**
   * Sources carried for the chat Sources rail (MONEY-670). Completion emits only
   * this block, so deriveCitations reads its sources from here (the rail's other
   * source blocks are gone). `news` mirrors NewsBlock.articles so the rail's
   * WEB-group mapping works unchanged.
   */
  news?: Array<{
    headline: string;
    source?: string;
    domain?: string;
    url?: string;
    at?: string;
    sentiment?: "positive" | "neutral" | "negative";
  }>;
  /** Tools the run executed, for the rail's DATA TOOLS RUN group. */
  dataSources?: Array<{ tool: string; label: string; status: string }>;
  /** Analysed instruments, for the rail's INSTRUMENTS group. */
  symbols?: string[];
}

/**
 * A single highlight on the compact roast card (MONEY-581).
 * `praise` = something the portfolio is doing right; `burn` = a flagged issue.
 */
export interface RoastSummaryHighlight {
  type: "burn" | "praise";
  emoji: string;
  title: string;
}

/**
 * Compact in-chat Portfolio Roast result (MONEY-581). The full rich report
 * lives on the `/roast/[sessionId]` page; the chat shows only a small card —
 * score gauge + verdict headline + a couple of highlights + a "View full roast"
 * link — instead of dumping the entire narrative as a wall of text.
 */
export interface RoastSummaryBlock {
  type: "roast-summary";
  /** Roast sessionId — links to `/roast/[sessionId]` for the full report. */
  sessionId: string;
  /** Overall score 0–100 (drives the gauge colour + label). */
  score: number;
  /** One-line verdict headline derived from the roast. */
  headline: string;
  /** A few highlights (mix of praise/burn) shown as compact rows. */
  highlights: RoastSummaryHighlight[];
  /** Best holding by P&L %, if available. */
  topPerformer?: { symbol: string; pnlPercent: number };
  /** Worst holding by P&L %, if available. */
  worstPerformer?: { symbol: string; pnlPercent: number };
}

// ============== Typed financial blocks (MONEY-587) ==============
// Rich, domain-specific blocks so analysis/research/roast data renders richly
// in chat instead of collapsing into a generic card/table. Each maps 1:1 to a
// renderer + a `registry.renderType`. `partial` flags a still-resolving turn.

/** Portfolio summary — total value, day change, P&L, segment mix, brokers. */
export interface PortfolioBlock {
  type: "portfolio";
  title?: string;
  subtitle?: string;
  totalValue: number;
  dayChange?: { amount: number; pct: number };
  totalPnL?: { amount?: number; pct: number };
  holdingsValue?: number;
  mfValue?: number;
  openPositions?: number;
  segments?: Array<{ label: string; pct: number; color?: string }>;
  brokers?: string[];
  partial?: boolean;
}

/** Holdings — rich, sortable table with sector + P&L + day move. */
export interface HoldingsBlock {
  type: "holdings";
  title?: string;
  rows: Array<{
    symbol: string;
    sector?: string;
    qty: number;
    avg: number;
    ltp: number;
    pnl: number;
    pnlPct: number;
    day?: number;
  }>;
  partial?: boolean;
}

/** Tax report — STCG/LTCG, harvesting opportunities, advance-tax schedule. */
export interface TaxReportBlock {
  type: "tax";
  title?: string;
  fy?: string;
  stcg?: { gains: number; tax: number };
  ltcg?: { gains: number; tax: number; exemptUsed?: number };
  harvest?: Array<{ symbol: string; loss: number; action: string }>;
  advance?: Array<{ due: string; amount: number; paid: boolean }>;
  itr?: string;
  partial?: boolean;
  /**
   * MONEY-1121 - the user booked NO realised trades in this financial year, so
   * every gains figure is legitimately zero. Set so the card can say that in
   * words instead of rendering a full statement of ₹0s (which reads as broken
   * software). Distinct from `partial`, which means the data is incomplete —
   * here it is complete and the answer is genuinely nothing.
   */
  noRealisedTrades?: boolean;
}

/** Risk analysis — VaR, drawdown, concentration, correlation, rebalance. */
export interface RiskBlock {
  type: "risk";
  title?: string;
  var1d?: number;
  var1w?: number;
  maxDD?: number;
  sharpe?: number;
  concentration?: { top?: number; top5?: number; hhi?: number };
  drawdownSeries?: number[];
  heatmap?: { labels: string[]; data: number[][] };
  rebalance?: Array<{ text: string; tone?: "amber" | "blue" | "red" }>;
  partial?: boolean;
}

/** Mutual-fund overview — NAV, returns, AUM, expense, percentile, top holds. */
export interface MutualFundBlock {
  type: "mf";
  scheme: string;
  category?: string;
  nav: number;
  returns?: { y1?: number; y3?: number; y5?: number };
  aum?: number; // ₹ Cr
  expense?: number;
  percentile?: number;
  top?: Array<{ name: string; weight: number }>;
  partial?: boolean;
}

/** FIRE projection — corpus gauge + projection curve. */
export interface FireBlock {
  type: "fire";
  currentCorpus: number;
  targetCorpus: number;
  yearsToFI?: number;
  monthlySIP?: number;
  withdrawalRate?: number;
  projection?: number[]; // ₹ Cr series
  /**
   * Monte-Carlo / scenario fan bands (₹ Cr percentile series). When present the
   * renderer draws a FanChart cone instead of a flat projection line.
   */
  fan?: {
    p10: number[];
    p25: number[];
    p50: number[];
    p75: number[];
    p90: number[];
    target?: number | null;
  };
  /**
   * Bear / base / bull terminal-corpus RANGE (₹ Cr) — a scenario range, not a
   * target. Rendered as a RangeBar when `fan` is absent.
   */
  scenario?: { low: number; mid: number; high: number; current?: number };
  partial?: boolean;
}

/** Sector allocation — donut + over/under-weight verdicts. */
export interface SectorBlock {
  type: "sector";
  title?: string;
  sectors: Array<{
    sector: string;
    pct: number;
    verdict?: "overweight" | "underweight" | "fair";
    color?: string;
  }>;
  partial?: boolean;
}

/** Technical readout — RSI/MACD gauges, S/R, detected patterns. */
export interface TechnicalBlock {
  type: "technical";
  symbol: string;
  trend?: string;
  rsi?: number;
  macd?: number;
  sma?: Partial<Record<"20" | "50" | "200", number>>;
  support?: number[];
  resistance?: number[];
  patterns?: Array<{
    name: string;
    kind?: "chart" | "candlestick";
    direction: "bullish" | "bearish";
  }>;
  /**
   * OHLC candle series for the inline candlestick chart. `patternMarkers`
   * pin detected patterns onto specific candles (index + price + label).
   */
  candles?: Array<{ o: number; h: number; l: number; c: number }>;
  patternMarkers?: Array<{ i: number; y: number; label: string }>;
  /**
   * Pre-grouped indicator-dashboard rows (Trend / Momentum / Volatility / …).
   * When absent the renderer derives rows from rsi / macd / sma / trend.
   */
  indicatorGroups?: Array<{
    group: string;
    rows: Array<{
      name: string;
      value: string;
      signal: "bullish" | "bearish" | "neutral";
    }>;
  }>;
  partial?: boolean;
}

/** News — favicon list with source/date/sentiment. */
export interface NewsBlock {
  type: "news";
  title?: string;
  articles: Array<{
    headline: string;
    source?: string;
    domain?: string;
    url?: string;
    at?: string;
    sentiment?: "positive" | "neutral" | "negative";
  }>;
  partial?: boolean;
}

/** Scorecard — L3/L4 comprehensive analysis: overall score + scored sections. */
export interface ScorecardBlock {
  type: "scorecard";
  symbol?: string;
  title?: string;
  overall: number; // 0–100
  confidence?: "High" | "Medium" | "Low" | string;
  verdict?: string;
  /** Current market price (₹) of the stock, when known — surfaced in the report
   *  header (MONEY-1060). Optional + additive so existing scorecards/data that
   *  omit it render unchanged. */
  currentPrice?: number;
  sessionId?: string; // links to /analysis/[sessionId]
  sections: Array<{
    title: string;
    score: number;
    summary?: string;
    metrics?: Array<[string, string]>;
    cites?: number[];
  }>;
  partial?: boolean;
}

/** P&L summary — realised/unrealised, win-rate, equity curve, best/worst. */
export interface PnlBlock {
  type: "pnl";
  realized?: number;
  unrealized?: number;
  winRate?: number;
  trades?: number;
  best?: { symbol: string; amount: number };
  worst?: { symbol: string; amount: number };
  equity?: number[];
  partial?: boolean;
}

/** Dividends — portfolio yield + upcoming ex-dates. */
export interface DividendBlock {
  type: "dividend";
  yield?: number;
  annualIncome?: number;
  upcoming: Array<{ symbol: string; exDate: string; amount: number }>;
  partial?: boolean;
}

/**
 * Discriminated union of all content block types
 */
export type ContentBlock =
  | TextBlock
  | TableBlock
  | CardBlock
  | ChartBlock
  | ActionBlock
  | NavigationBlock
  | ComparisonBlock
  | StockListBlock
  | ErrorBlock
  | ResearchPromptBlock
  | ResearchStreamBlock
  | StructuredReportBlock
  | RoastSummaryBlock
  | RefusalBlock
  | PortfolioBlock
  | HoldingsBlock
  | TaxReportBlock
  | RiskBlock
  | MutualFundBlock
  | FireBlock
  | SectorBlock
  | TechnicalBlock
  | NewsBlock
  | ScorecardBlock
  | PnlBlock
  | DividendBlock;

export type ContentBlockType = ContentBlock["type"];

// ============== Chat Context ==============

/**
 * Context mode for the chat dashboard
 */
export type ChatContextMode =
  | "all"
  | { type: "broker"; brokerId: string; brokerName: string }
  | "stock_analysis"
  | "mf_analysis"
  | "retirement"
  | "paper_trading"
  | "research";

/**
 * Serializable context mode for API requests
 */
export type ChatContextModeSerializable =
  | "all"
  | `broker:${string}:${string}`
  | "stock_analysis"
  | "mf_analysis"
  | "retirement"
  | "paper_trading"
  | "research";

// ============== Turn Metadata ==============

/**
 * Per-turn structured metadata for conversation memory.
 *
 * Attached to each message so follow-up turns can resolve
 * "yes", "tighten the filter", "tell me more about the top stock"
 * without re-classifying from scratch.
 */
export interface TurnMeta {
  intent?: string;
  tier?: "L1" | "L2" | "L3";
  /**
   * MONEY-501: the model that produced this advisory turn (e.g. "gemini-2.5-pro"
   * / "gemini-2.5-flash"), for per-message AI-source attribution. The chat
   * footer currently attributes statically ("StockSage (Google Gemini)"); the
   * playful chat redesign can surface this per message.
   */
  model?: string;
  tool?: string;
  persona?: string;
  confidence?: number;
  toolParams?: Record<string, unknown>;
  toolSuccess?: boolean;
  symbols?: string[];
  /**
   * MONEY-800 (B6): the explanation-style bandit arm that framed this answer.
   * Echoed so the feedback component can attribute the user's 👍/👎 back to the
   * chosen variant, closing the outcome-learning loop.
   */
  variantId?: string;
  screenerState?: {
    query: string;
    strategy?: string;
    filters?: Array<{ field: string; operator: string; value: unknown }>;
    indexFilter?: string;
    resultCount?: number;
    resultSummary?: string;
  };
}

// ============== Extended Chat Types ==============

/**
 * Tool execution request (for confirmed write actions)
 */
export interface ToolExecutionRequest {
  tool: string;
  params: Record<string, unknown>;
  actionId: string;
}

/**
 * Extended chat request with context and tool execution
 */
export interface ChatDashboardRequest {
  message: string;
  queryType: "fast" | "advanced";
  pagePath: string;
  context?: ChatContextModeSerializable;
  toolExecution?: ToolExecutionRequest;
  userContext?: string;
  chatId?: string;
  conversationHistory?: {
    role: "user" | "assistant";
    content: string;
    turnMeta?: TurnMeta;
  }[];
}

/**
 * Extended chat response with content blocks and turn metadata
 */
export interface ChatDashboardResponse {
  response: string;
  blocks?: ContentBlock[];
  action?: {
    type: string;
    parameters: Record<string, unknown>;
    confirmationMessage: string;
  };
  remaining?: number;
  queryType: "fast" | "advanced";
  blocked?: boolean;
  toolResults?: ToolResult[];
  turnMeta?: TurnMeta;
}

/**
 * Result from a tool execution
 */
export interface ToolResult {
  tool: string;
  success: boolean;
  data?: unknown;
  error?: string;
  renderType?: ContentBlockType;
}

/**
 * Chat message with optional content blocks (for UI state)
 */
export interface ChatMessageWithBlocks {
  id: string;
  role: "user" | "assistant";
  content: string;
  blocks?: ContentBlock[];
  timestamp: Date;
  /** Links this message to a specific research session (for dedup on reload) */
  researchSessionId?: string;
  /** Structured metadata from this turn (intent, tool, persona, screener state) */
  turnMeta?: TurnMeta;
}
