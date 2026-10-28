/**
 * Query-to-Filters - Natural Language → Screener Filters Parser
 *
 * Regex-based parser that extracts screener filters and strategy matches
 * from natural language queries. Covers fundamental, technical, and
 * ownership filter fields.
 *
 * Examples:
 * - "stocks with RSI < 30" → [{field: "rsi_14", operator: "lt", value: 30}]
 * - "golden cross stocks" → strategy: "golden_cross"
 * - "PE below 15 and ROE above 20" → [{field: "pe", op: "lt", val: 15}, {field: "roe", op: "gt", val: 20}]
 */

import type { ScreenerFilter } from "@usemoney/core/screener/engine";

// ── Filter extraction patterns ──────────────────────────────────────────

interface FilterPattern {
  pattern: RegExp;
  field: string;
  operator: "gt" | "lt" | "eq";
  /**
   * Non-numeric operand carried onto the emitted filter — currently only
   * `indexMember`'s index slug (MONEY-1204 / 14e.1).
   */
  operand?: string;
  /**
   * Skip this pattern when `field` is already among the extracted filters.
   *
   * The market-structure vocabulary has genuinely nested phrasings: "average
   * delivery above 50" contains "delivery above 50", and "exclude ASM stocks"
   * contains "ASM stocks". Both halves match, and emitting both ANDs a filter
   * the user never asked for (or, for the negations, its exact opposite). The
   * specific pattern is listed FIRST and the general one defers to it — an
   * explicit precedence rather than a lookbehind nobody can read.
   */
  skipIfFieldPresent?: string;
  /**
   * Value to use when the pattern captured no number.
   *
   * Takes precedence over the field/operator table in `getDefaultValue`, which
   * cannot express the market-structure booleans: "under ASM" and "exclude ASM
   * stocks" are the SAME field with the SAME `eq` operator and OPPOSITE values,
   * so the default has to belong to the phrase, not to the field.
   */
  defaultValue?: number;
}

// Field names MUST match the screener engine's TECHNICAL_FIELDS and FUNDAMENTAL_FIELDS
// Technical: rsi_14, macd, sma_20, sma_50, sma_200, ema_12, ema_26, bollinger_bandwidth,
//            atr_14, stoch_k, stoch_d, williams_r, volume_ratio, distance_52w_high,
//            distance_52w_low, golden_cross, death_cross
// Fundamental: pe, pb, evToEbitda, pegRatio, roe, roa, roce, grossMargin, operatingMargin,
//              netMargin, revenueGrowth, earningsGrowth, debtToEquity, currentRatio,
//              interestCoverage, beta, dividendYield, marketCap

const FILTER_PATTERNS: FilterPattern[] = [
  // Technical indicators - field names match engine's TECHNICAL_FIELDS (snake_case)
  {
    pattern: /rsi\s*(?:<|below|under|less\s*than)\s*([\d.]+)/i,
    field: "rsi_14",
    operator: "lt",
  },
  {
    pattern: /rsi\s*(?:>|above|over|greater\s*than|more\s*than)\s*([\d.]+)/i,
    field: "rsi_14",
    operator: "gt",
  },
  {
    pattern: /macd\s*(?:>|above|positive)\s*([\d.]*)/i,
    field: "macd",
    operator: "gt",
  },
  {
    pattern: /macd\s*(?:<|below|negative)\s*([\d.]*)/i,
    field: "macd",
    operator: "lt",
  },
  {
    pattern: /sma\s*(?:20|50|200)?\s*(?:>|above)\s*([\d.]+)/i,
    field: "sma_50",
    operator: "gt",
  },
  {
    pattern: /ema\s*(?:12|26)?\s*(?:>|above)\s*([\d.]+)/i,
    field: "ema_12",
    operator: "gt",
  },
  { pattern: /atr\s*(?:>|above)\s*([\d.]+)/i, field: "atr_14", operator: "gt" },
  { pattern: /atr\s*(?:<|below)\s*([\d.]+)/i, field: "atr_14", operator: "lt" },
  {
    pattern: /stochastic\s*(?:k|%k)?\s*(?:<|below)\s*([\d.]+)/i,
    field: "stoch_k",
    operator: "lt",
  },
  {
    pattern: /stochastic\s*(?:k|%k)?\s*(?:>|above)\s*([\d.]+)/i,
    field: "stoch_k",
    operator: "gt",
  },
  {
    pattern: /williams\s*(?:%r|r)?\s*(?:<|below)\s*-?([\d.]+)/i,
    field: "williams_r",
    operator: "lt",
  },
  {
    pattern: /volume\s*(?:ratio)?\s*(?:>|above)\s*([\d.]+)/i,
    field: "volume_ratio",
    operator: "gt",
  },
  {
    pattern:
      /52\s*(?:week|w)?\s*high\s*(?:distance|diff)?\s*(?:<|below|within)\s*([\d.]+)/i,
    field: "distance_52w_high",
    operator: "lt",
  },
  {
    pattern: /bollinger\s*(?:band)?.*(?:squeeze|narrow|tight)/i,
    field: "bollinger_bandwidth",
    operator: "lt",
  },

  // Descriptive technical patterns (no explicit number - use sensible defaults)
  {
    pattern:
      /(?:near|close\s*to|at|around|touching)\s*(?:their\s*)?52\s*(?:weeks?|w|wk)?\s*low/i,
    field: "distance_52w_low",
    operator: "lt",
  },
  {
    pattern:
      /(?:near|close\s*to|at|around|touching)\s*(?:their\s*)?52\s*(?:weeks?|w|wk)?\s*high/i,
    field: "distance_52w_high",
    operator: "lt",
  },
  { pattern: /\b(?:oversold)\b/i, field: "rsi_14", operator: "lt" },
  { pattern: /\b(?:overbought)\b/i, field: "rsi_14", operator: "gt" },

  // Fundamental - Valuation
  {
    pattern: /pe\s*(?:ratio)?\s*(?:<|below|under|less\s*than)\s*([\d.]+)/i,
    field: "pe",
    operator: "lt",
  },
  {
    pattern: /pe\s*(?:ratio)?\s*(?:>|above|over|greater\s*than)\s*([\d.]+)/i,
    field: "pe",
    operator: "gt",
  },
  {
    pattern: /pb\s*(?:ratio)?\s*(?:<|below|under)\s*([\d.]+)/i,
    field: "pb",
    operator: "lt",
  },
  {
    pattern: /pb\s*(?:ratio)?\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "pb",
    operator: "gt",
  },
  {
    pattern: /ev\s*(?:\/|to)\s*ebitda\s*(?:<|below|under)\s*([\d.]+)/i,
    field: "evToEbitda",
    operator: "lt",
  },
  {
    pattern: /peg\s*(?:ratio)?\s*(?:<|below|under)\s*([\d.]+)/i,
    field: "peg",
    operator: "lt",
  },

  // Fundamental - Profitability
  {
    pattern: /roe\s*(?:>|above|over|greater\s*than|more\s*than)\s*([\d.]+)/i,
    field: "roe",
    operator: "gt",
  },
  {
    pattern: /roe\s*(?:<|below|under)\s*([\d.]+)/i,
    field: "roe",
    operator: "lt",
  },
  {
    pattern: /roa\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "roa",
    operator: "gt",
  },
  {
    pattern: /roce\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "roce",
    operator: "gt",
  },
  {
    pattern: /(?:gross|operating|net)\s*margin\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "netMargin",
    operator: "gt",
  },
  {
    pattern: /(?:gross|operating|net)\s*margin\s*(?:<|below|under)\s*([\d.]+)/i,
    field: "netMargin",
    operator: "lt",
  },

  // Fundamental - Growth
  {
    pattern: /revenue\s*growth\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "revenueGrowth1Y",
    operator: "gt",
  },
  {
    pattern: /earnings?\s*growth\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "earningsGrowth1Y",
    operator: "gt",
  },

  // Fundamental - Health
  {
    pattern:
      /debt\s*(?:to|\/)\s*equity\s*(?:<|below|under|less\s*than)\s*([\d.]+)/i,
    field: "debtToEquity",
    operator: "lt",
  },
  {
    pattern: /debt\s*(?:to|\/)\s*equity\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "debtToEquity",
    operator: "gt",
  },
  {
    pattern: /current\s*ratio\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "currentRatio",
    operator: "gt",
  },
  {
    pattern: /interest\s*coverage\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "interestCoverage",
    operator: "gt",
  },
  {
    pattern: /beta\s*(?:<|below|under)\s*([\d.]+)/i,
    field: "beta",
    operator: "lt",
  },
  {
    pattern: /beta\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "beta",
    operator: "gt",
  },

  // Dividend & Market Cap
  {
    pattern: /dividend\s*(?:yield)?\s*(?:>|above|over|more\s*than)\s*([\d.]+)/i,
    field: "dividendYield",
    operator: "gt",
  },
  {
    pattern: /market\s*cap\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "marketCap",
    operator: "gt",
  },
  {
    pattern: /market\s*cap\s*(?:<|below|under)\s*([\d.]+)/i,
    field: "marketCap",
    operator: "lt",
  },

  // Ownership (Screener.in)
  {
    pattern: /promoter\s*(?:holding|stake)\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "promoterHolding",
    operator: "gt",
  },
  {
    pattern: /promoter\s*(?:holding|stake)\s*(?:<|below|under)\s*([\d.]+)/i,
    field: "promoterHolding",
    operator: "lt",
  },
  // MONEY-1204 (14e.1) — RETARGETED from `fiiHolding` / `diiHolding`.
  //
  // Those two ids exist in no field registry: `isFundamental` rejects them, so
  // `runFundamentalScreen` logged "dropping unsupported fundamental filter
  // field" and screened on nothing. Every "FII holding above 20" query has been
  // silently returning an unfiltered set. `fiiPct` / `diiPct` are the real
  // `ShareholdingPattern` columns and they run.
  {
    pattern: /fii\s*(?:holding|stake)\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "fiiPct",
    operator: "gt",
  },
  {
    pattern: /fii\s*(?:holding|stake)\s*(?:<|below|under)\s*([\d.]+)/i,
    field: "fiiPct",
    operator: "lt",
  },
  {
    pattern: /dii\s*(?:holding|stake)\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "diiPct",
    operator: "gt",
  },
  {
    pattern: /public\s*(?:holding|stake)\s*(?:<|below|under)\s*([\d.]+)/i,
    field: "publicHolding",
    operator: "lt",
  },

  // ── SMA/DMA patterns ────────────────────────────────────────────────
  {
    pattern: /(?:above|over)\s+200\s*(?:dma|day\s*(?:moving\s*)?average|sma)/i,
    field: "sma_200",
    operator: "gt",
  },
  {
    pattern: /(?:below|under)\s+200\s*(?:dma|day\s*(?:moving\s*)?average|sma)/i,
    field: "sma_200",
    operator: "lt",
  },
  {
    pattern: /(?:above|over)\s+50\s*(?:dma|day\s*(?:moving\s*)?average|sma)/i,
    field: "sma_50",
    operator: "gt",
  },
  {
    pattern: /(?:below|under)\s+50\s*(?:dma|day\s*(?:moving\s*)?average|sma)/i,
    field: "sma_50",
    operator: "lt",
  },
  {
    pattern: /(?:above|over)\s+20\s*(?:dma|day\s*(?:moving\s*)?average|sma)/i,
    field: "sma_20",
    operator: "gt",
  },
  {
    pattern: /(?:below|under)\s+20\s*(?:dma|day\s*(?:moving\s*)?average|sma)/i,
    field: "sma_20",
    operator: "lt",
  },

  // ── MF-related patterns (mapped to screener fields) ─────────────────
  {
    pattern:
      /(?:expense\s*ratio|ter)\s*(?:<|below|under|less\s*than)\s*([\d.]+)/i,
    field: "expenseRatio",
    operator: "lt",
  },
  {
    pattern:
      /(?:expense\s*ratio|ter)\s*(?:>|above|over|more\s*than)\s*([\d.]+)/i,
    field: "expenseRatio",
    operator: "gt",
  },
  {
    pattern:
      /(?:1\s*(?:yr?|year)\s*return|return\s*1\s*(?:yr?|year))\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "return1Y",
    operator: "gt",
  },
  {
    pattern:
      /(?:3\s*(?:yr?|year)\s*return|return\s*3\s*(?:yr?|year))\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "return3Y",
    operator: "gt",
  },
  {
    pattern:
      /(?:5\s*(?:yr?|year)\s*return|return\s*5\s*(?:yr?|year))\s*(?:>|above|over)\s*([\d.]+)/i,
    field: "return5Y",
    operator: "gt",
  },
  {
    pattern: /\baum\s*(?:>|above|over|more\s*than)\s*([\d.]+)/i,
    field: "aum",
    operator: "gt",
  },

  // ── Market-structure fields (MONEY-1204 / 14e.1) ────────────────────
  //
  // Ids here MUST exist in `MARKET_FIELDS` (packages/core/src/screener/
  // market-fields-logic.ts). A phrase that maps to an id the registry does not
  // know is dropped by the engine with a warning and screens on nothing — the
  // exact failure the retargeted FII/DII patterns above were living in.
  //
  // ORDER IS LOAD-BEARING within each group: the SPECIFIC phrasing (the 20-day
  // average; the negations) is listed before the general one, and the general
  // one carries `skipIfFieldPresent`.

  // Delivery — DailyPrice.deliveryPct
  {
    pattern:
      /(?:20\s*-?\s*day|20d|avg\.?|average|mean)\s*delivery[^\d]{0,24}(?:>|above|over|greater\s*than|more\s*than)\s*([\d.]+)/i,
    field: "deliveryPct20dAvg",
    operator: "gt",
  },
  {
    pattern:
      /(?:20\s*-?\s*day|20d|avg\.?|average|mean)\s*delivery[^\d]{0,24}(?:<|below|under|less\s*than)\s*([\d.]+)/i,
    field: "deliveryPct20dAvg",
    operator: "lt",
  },
  {
    pattern:
      /deliver(?:y|able)\s*(?:%|percent(?:age)?|volume|qty|quantity)?\s*(?:>|above|over|greater\s*than|more\s*than)\s*([\d.]+)/i,
    field: "deliveryPct",
    operator: "gt",
    skipIfFieldPresent: "deliveryPct20dAvg",
  },
  {
    pattern:
      /deliver(?:y|able)\s*(?:%|percent(?:age)?|volume|qty|quantity)?\s*(?:<|below|under|less\s*than)\s*([\d.]+)/i,
    field: "deliveryPct",
    operator: "lt",
    skipIfFieldPresent: "deliveryPct20dAvg",
  },
  {
    pattern: /\bhigh\s*deliver(?:y|able)\b/i,
    field: "deliveryPct",
    operator: "gt",
    skipIfFieldPresent: "deliveryPct",
    defaultValue: 60,
  },

  // Surveillance flags — StockFlag, current state per kind
  {
    pattern:
      /\b(?:not|non|no|exclud(?:e|ing)|without|avoid)\s*(?:stocks?\s*)?(?:under\s*)?(?:asm|additional\s*surveillance)\b/i,
    field: "asmFlag",
    operator: "eq",
    defaultValue: 0,
  },
  {
    pattern: /\b(?:asm|additional\s*surveillance)\b/i,
    field: "asmFlag",
    operator: "eq",
    skipIfFieldPresent: "asmFlag",
    defaultValue: 1,
  },
  {
    pattern:
      /\b(?:not|non|no|exclud(?:e|ing)|without|avoid)\s*(?:stocks?\s*)?(?:under\s*)?(?:gsm|graded\s*surveillance)\b/i,
    field: "gsmFlag",
    operator: "eq",
    defaultValue: 0,
  },
  {
    pattern: /\b(?:gsm|graded\s*surveillance)\b/i,
    field: "gsmFlag",
    operator: "eq",
    skipIfFieldPresent: "gsmFlag",
    defaultValue: 1,
  },
  {
    pattern: /\b(?:price\s*band|circuit\s*(?:limit|band|filter))\b/i,
    field: "priceBandFlag",
    operator: "eq",
    defaultValue: 1,
  },
  {
    pattern:
      /\b(?:not|non|no|exclud(?:e|ing)|without|outside|avoid)\s*(?:the\s*)?(?:f\s*&?\s*o|f\s*and\s*o|fno)?\s*ban\b/i,
    field: "foBanFlag",
    operator: "eq",
    defaultValue: 0,
  },
  {
    pattern:
      /\b(?:(?:f\s*&?\s*o|f\s*and\s*o|fno|futures?\s*(?:and|&)\s*options?)\s*ban|ban\s*(?:list|period)|securities?\s*in\s*ban)\b/i,
    field: "foBanFlag",
    operator: "eq",
    skipIfFieldPresent: "foBanFlag",
    defaultValue: 1,
  },

  // Ownership — ShareholdingPattern levels + QoQ deltas
  {
    pattern: /\b(?:rising|increas\w*|growing)\s*(?:promoter\s*)?pledg\w*/i,
    field: "pledgedPctQoqDelta",
    operator: "gt",
    defaultValue: 0,
  },
  {
    pattern:
      /\b(?:falling|fell|declin\w*|reduc\w*|decreas\w*)\s*(?:promoter\s*)?pledg\w*/i,
    field: "pledgedPctQoqDelta",
    operator: "lt",
    defaultValue: 0,
  },
  {
    pattern:
      /pledg\w*\s*(?:%|percent(?:age)?|shares?|holding)?\s*(?:>|above|over|more\s*than)\s*([\d.]+)/i,
    field: "pledgedPct",
    operator: "gt",
  },
  {
    pattern:
      /pledg\w*\s*(?:%|percent(?:age)?|shares?|holding)?\s*(?:<|below|under|less\s*than)\s*([\d.]+)/i,
    field: "pledgedPct",
    operator: "lt",
    skipIfFieldPresent: "pledgedPct",
  },
  {
    pattern: /\b(?:zero|no|nil)\s*(?:promoter\s*)?pledg\w*/i,
    field: "pledgedPct",
    operator: "eq",
    skipIfFieldPresent: "pledgedPct",
    defaultValue: 0,
  },
  {
    pattern:
      /\bfii\w*\s*(?:stake|holding)?\s*(?:increas\w*|rising|rose|added|buying|accumulat\w*)/i,
    field: "fiiPctQoqDelta",
    operator: "gt",
    defaultValue: 0,
  },
  {
    pattern:
      /\bfii\w*\s*(?:stake|holding)?\s*(?:decreas\w*|falling|fell|reduc\w*|selling|trimm\w*)/i,
    field: "fiiPctQoqDelta",
    operator: "lt",
    defaultValue: 0,
  },
  {
    pattern:
      /\bdii\w*\s*(?:stake|holding)?\s*(?:increas\w*|rising|rose|added|buying|accumulat\w*)/i,
    field: "diiPctQoqDelta",
    operator: "gt",
    defaultValue: 0,
  },
  {
    pattern:
      /\bdii\w*\s*(?:stake|holding)?\s*(?:decreas\w*|falling|fell|reduc\w*|selling|trimm\w*)/i,
    field: "diiPctQoqDelta",
    operator: "lt",
    defaultValue: 0,
  },
  {
    pattern: /dii\s*(?:holding|stake)\s*(?:<|below|under)\s*([\d.]+)/i,
    field: "diiPct",
    operator: "lt",
  },

  // Index membership — IndexMembership, open stints only
  {
    pattern:
      /\b(?:in|part\s*of|member\s*of|constituents?\s*of|belongs?\s*to)\s*(?:the\s*)?nifty\s*50\b/i,
    field: "indexMember",
    operator: "eq",
    operand: "nifty50",
    defaultValue: 1,
  },
  {
    pattern: /\bindex\s*(?:constituents?|members?|stocks?)\b/i,
    field: "indexMember",
    operator: "eq",
    skipIfFieldPresent: "indexMember",
    defaultValue: 1,
  },

  // F&O positioning — DerivativeSummary
  {
    pattern:
      /\b(?:pcr|put\s*[\/-]?\s*call\s*ratio)\b[^\d]{0,20}(?:>|above|over|greater\s*than)\s*([\d.]+)/i,
    field: "pcrOi",
    operator: "gt",
  },
  {
    pattern:
      /\b(?:pcr|put\s*[\/-]?\s*call\s*ratio)\b[^\d]{0,20}(?:<|below|under|less\s*than)\s*([\d.]+)/i,
    field: "pcrOi",
    operator: "lt",
  },
  {
    pattern:
      /\b(?:futures?\s*)?(?:open\s*interest|oi)\s*(?:change|build\s*-?\s*up)?\s*(?:>|above|rising|increas\w*|buildup|build\s*-?\s*up)/i,
    field: "futOiChange",
    operator: "gt",
    defaultValue: 0,
  },
  {
    pattern:
      /\b(?:futures?\s*)?(?:open\s*interest|oi)\s*(?:change)?\s*(?:<|below|falling|declin\w*|unwind\w*|decreas\w*)/i,
    field: "futOiChange",
    operator: "lt",
    defaultValue: 0,
  },
  {
    pattern:
      /\b(?:mwpl|market\s*[-\s]*wide\s*position\s*limit)\b(?:[^\d]{0,20}(?:>|above|over)\s*([\d.]+))?/i,
    field: "mwplUtilisation",
    operator: "gt",
    defaultValue: 90,
  },

  // Debt — BondEOD / BondMaster, joined by ISIN
  {
    pattern:
      /\b(?:bond\s*(?:yield|ytm)|ytm|yield\s*to\s*maturity)\b[^\d]{0,20}(?:>|above|over|greater\s*than|more\s*than)\s*([\d.]+)/i,
    field: "bondYield",
    operator: "gt",
  },
  {
    pattern:
      /\b(?:bond\s*(?:yield|ytm)|ytm|yield\s*to\s*maturity)\b[^\d]{0,20}(?:<|below|under|less\s*than)\s*([\d.]+)/i,
    field: "bondYield",
    operator: "lt",
  },
  {
    pattern:
      /\bbond\s*price\b[^\d]{0,20}(?:<|below|under|less\s*than)\s*([\d.]+)/i,
    field: "bondPrice",
    operator: "lt",
  },
  {
    pattern:
      /\bbond\s*price\b[^\d]{0,20}(?:>|above|over|more\s*than)\s*([\d.]+)/i,
    field: "bondPrice",
    operator: "gt",
    skipIfFieldPresent: "bondPrice",
  },
  {
    pattern:
      /\bcoupon\s*(?:rate|%)?\s*(?:>|above|over|more\s*than)\s*([\d.]+)/i,
    field: "bondCoupon",
    operator: "gt",
  },
  {
    pattern:
      /\bcoupon\s*(?:rate|%)?\s*(?:<|below|under|less\s*than)\s*([\d.]+)/i,
    field: "bondCoupon",
    operator: "lt",
    skipIfFieldPresent: "bondCoupon",
  },

  // ── Descriptive MF / technical patterns (no number) ─────────────────
  {
    pattern: /\b(?:low\s*expense\s*ratio)\b/i,
    field: "expenseRatio",
    operator: "lt",
  },
  { pattern: /\b(?:high\s*return)\b/i, field: "return1Y", operator: "gt" },
];

// ── Strategy keyword mapping ────────────────────────────────────────────

const STRATEGY_KEYWORDS: Record<string, string> = {
  // Fundamental strategies
  undervalued: "value_investing",
  "value pick": "value_investing",
  "value stock": "value_investing",
  "value investing": "value_investing",
  "dividend aristocrat": "dividend_aristocrats",
  "high dividend": "dividend_aristocrats",
  "dividend stock": "dividend_aristocrats",
  "growth stock": "growth_stocks",
  "high growth": "growth_stocks",
  garp: "garp",
  "growth at reasonable": "garp",
  "low debt blue": "low_debt_bluechips",
  "blue chip low debt": "low_debt_bluechips",
  "high roce": "high_roce",
  turnaround: "turnaround",
  "turnaround stock": "turnaround",
  "small cap gem": "small_cap_gems",
  "hidden gem": "small_cap_gems",
  "high margin": "high_margin",
  "cash rich": "cash_rich",

  // Technical strategies
  "bullish trend": "bullish_trend",
  "bullish stock": "bullish_trend",
  "bearish trend": "bearish_trend",
  "bearish stock": "bearish_trend",
  momentum: "momentum",
  "momentum stock": "momentum",
  "volume breakout": "volume_breakout",
  breakout: "volume_breakout",
  "golden cross": "golden_cross",
  "death cross": "death_cross",
  "bollinger squeeze": "bollinger_squeeze",
  "52 week high": "52w_high_breakout",
  "52w high": "52w_high_breakout",
  "new high": "52w_high_breakout",
  oversold: "oversold_bounce",
  "oversold bounce": "oversold_bounce",
  overbought: "overbought",
  "near support": "near_support",
  "macd crossover": "macd_bullish_crossover",
  "macd bullish": "macd_bullish_crossover",

  // Chartink scan patterns (map to CHARTINK_PREBUILT_SCANS keys)
  "rsi oversold": "rsi_oversold",
  "rsi overbought": "rsi_overbought",
  "bullish macd": "bullish_macd",
  "macd crossover bullish": "bullish_macd",
  "above 200 dma": "above_200dma",
  "above 200dma": "above_200dma",
  "near 52 week high": "near_52w_high",
  "near 52 week low": "near_52w_low",

  // MF strategies
  "large cap fund": "large_cap_fund",
  "mid cap fund": "mid_cap_fund",
  "small cap fund": "small_cap_fund",
  "index fund": "index_fund",
  "debt fund": "debt_fund",
  "elss fund": "elss_fund",
  "tax saver fund": "elss_fund",
  "low expense ratio fund": "low_expense_fund",

  // Combined strategies
  buffett: "buffett_style",
  "warren buffett": "buffett_style",
  "buffett style": "buffett_style",
  "peter lynch": "peter_lynch_peg",
  "lynch peg": "peter_lynch_peg",
  "value with momentum": "value_with_momentum",
  "quality breakout": "quality_breakout",
  "dividend tech": "dividend_tech_buy",
  "growth momentum": "growth_momentum",
};

// ── Index keyword extraction ────────────────────────────────────────────

const INDEX_PATTERNS: { pattern: RegExp; index: string }[] = [
  { pattern: /\bnifty\s*50\b/i, index: "NIFTY 50" },
  { pattern: /\bnifty\s*100\b/i, index: "NIFTY 100" },
  { pattern: /\bnifty\s*200\b/i, index: "NIFTY 200" },
  { pattern: /\bnifty\s*500\b/i, index: "NIFTY 500" },
  { pattern: /\bsensex\b/i, index: "SENSEX" },
  { pattern: /\blarge\s*cap/i, index: "NIFTY 100" },
  { pattern: /\bmid\s*cap/i, index: "NIFTY MIDCAP 100" },
  { pattern: /\bsmall\s*cap/i, index: "NIFTY SMALLCAP 100" },
];

// ── Main parser ─────────────────────────────────────────────────────────

export interface ParsedScreenerQuery {
  strategy?: string;
  filters: ScreenerFilter[];
  index?: string;
}

/**
 * Parse a natural language query into screener strategy + filters.
 *
 * @param query - User's natural language screening query
 * @returns Parsed strategy, filters, and index (any/all may be empty)
 */
export function parseQueryToFilters(query: string): ParsedScreenerQuery {
  const result: ParsedScreenerQuery = { filters: [] };

  // 1. Try strategy keyword match (longest match first)
  const lowerQuery = query.toLowerCase();
  let bestMatch = "";
  let bestStrategy = "";

  for (const [keyword, strategyId] of Object.entries(STRATEGY_KEYWORDS)) {
    if (lowerQuery.includes(keyword) && keyword.length > bestMatch.length) {
      bestMatch = keyword;
      bestStrategy = strategyId;
    }
  }

  if (bestStrategy) {
    result.strategy = bestStrategy;
  }

  // 2. Extract filters from numeric comparisons
  for (const {
    pattern,
    field,
    operator,
    operand,
    skipIfFieldPresent,
    defaultValue,
  } of FILTER_PATTERNS) {
    // A more specific phrasing already claimed this field — see
    // `skipIfFieldPresent`. Checked BEFORE the match so the general pattern
    // never even runs, which is also what keeps the precedence readable in the
    // pattern list's ORDER rather than hidden in a regex lookbehind.
    if (
      skipIfFieldPresent &&
      result.filters.some((f) => f.field === skipIfFieldPresent)
    ) {
      continue;
    }

    const match = query.match(pattern);
    if (match) {
      const rawValue = match[1];
      // Some patterns (e.g., "near 52w low", "under ASM") may not capture a
      // number - use the pattern's own default first, then the field/operator
      // table.
      const parsed = rawValue ? parseFloat(rawValue) : NaN;
      const value = isNaN(parsed)
        ? (defaultValue ?? getDefaultValue(field, operator))
        : parsed;
      if (value !== null) {
        // Avoid duplicate field entries. `operand` is part of the identity:
        // two `indexMember eq 1` filters naming DIFFERENT indexes are two
        // different constraints, and collapsing them would silently drop one.
        if (
          !result.filters.some(
            (f) =>
              f.field === field &&
              f.operator === operator &&
              f.operand === operand,
          )
        ) {
          result.filters.push({
            field,
            operator,
            value,
            ...(operand ? { operand } : {}),
          });
        }
      }
    }
  }

  // 3. Extract index filter
  for (const { pattern, index } of INDEX_PATTERNS) {
    if (pattern.test(query)) {
      result.index = index;
      break;
    }
  }

  return result;
}

/**
 * Default values for descriptive patterns that don't include explicit numbers.
 * Returns null if no sensible default exists.
 */
function getDefaultValue(
  field: string,
  operator: "gt" | "lt" | "eq",
): number | null {
  const defaults: Record<string, Record<string, number>> = {
    // "near 52 week low" → within 5% of low
    distance_52w_low: { lt: 5 },
    // "near 52 week high" → within 5% of high
    distance_52w_high: { lt: 5 },
    // "oversold" → RSI < 30, "overbought" → RSI > 70
    rsi_14: { lt: 30, gt: 70 },
    // "bollinger squeeze" → bandwidth < 0.1
    bollinger_bandwidth: { lt: 0.1 },
    // "macd positive/negative" → above/below 0
    macd: { gt: 0, lt: 0 },
    // SMA/DMA defaults - use 0 as threshold (price vs SMA comparison)
    sma_200: { gt: 0, lt: 0 },
    sma_50: { gt: 0, lt: 0 },
    sma_20: { gt: 0, lt: 0 },
    // MF defaults - "low expense ratio" → < 0.5%, "high return" → > 15%
    expenseRatio: { lt: 0.5 },
    return1Y: { gt: 15 },
  };

  return defaults[field]?.[operator] ?? null;
}
