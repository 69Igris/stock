# UseMoney Monorepo - Quant/Backtesting Readiness Audit

**Scope:** Comprehensive assessment of the stockbook-monorepo for:

- Quantitative backtesting engine integration
- Technical-indicator strategy library
- Multi-agent AI research orchestration
- Forward prediction & live signal generation
- Founder-only live algo execution (Zerodha/Fyers)

**Date:** July 2026  
**Auditor:** Claude Agent (file-search specialist)  
**Audit Depth:** Very Thorough

---

## Executive Summary

**Overall Readiness: 6.5/10 for backtesting, 8/10 for AI research, 3/10 for live trading**

> **Verification corrections (2026-07-03, evidence-checked against the working tree — trust these over the body text below):**
>
> 1. **Workers run 42 job routes, not ~14** — `workers/src/index.ts:134-176` registers 42 `app.route("/jobs/…")` handlers (43 route files, ~60 processors), including `strategy-scan`, `alert-evaluator`, `intraday-sync`, `bhavcopy-sync`. The §6 table is a stale subset. Consequence: a strategy-scanning/alert loop already exists — Epic 5 absorbs it (MONEY-1044).
> 2. **`DailyPrice` is ACTIVE, not inactive** — consumed by `apps/web/lib/actions/sector-heatmap.ts`, `components/stock/StockTechnicalsCard.tsx`, `StockReturnsBars.tsx`; `IntradayBar` (schema:1911) also exists with a sync worker. Epic 1 migration decision: MONEY-1043.
> 3. **`Alert` and `CustomStrategy` models ALREADY EXIST** (schema.prisma:3022 and :3602) — §9's "missing models" list is wrong on these two; the quant models must reconcile, not assume greenfield (MONEY-1042).
> 4. **Interactive Brokers rows in §3/§4 are unverified** — root CLAUDE.md lists 6 brokers; treat IBKR entries as inferred.
> 5. **Research tool count has drifted** — "45+" here, "82+" in MONEY-627, "114" in Epic 13 (July count). The registry grew; use the live registry as truth.

### Strengths

- Excellent **AI research agent infrastructure** (45+ tools, 9 skills, multi-model support)
- **Technical indicator library** is comprehensive (24+ indicators, candlestick patterns, chart patterns)
- **Market data pipeline** exists (Yahoo Finance, intraday bars, historical OHLCV)
- **Broker integrations** cover read-only operations (holdings, positions, orders)
- **Quant math layer** for portfolio risk (VaR, drawdown, correlation basics)
- **Worker infrastructure** (Pub/Sub, Cloud Run) handles async jobs

### Critical Gaps

- **No order placement API** — all broker integrations are read-only (sync historical data)
- **No backtesting engine** — only skeleton `backtest-strategy` tool exists
- **Paper trading removed** — PaperPosition models exist but UI/routes deleted
- **No strategy persistence** — no `Strategy`, `Backtest`, `Signal`, or `Alert` models in schema
- **No Python/NumPy stack** — all TS/Node (not inherently bad, but limits some quant work)
- **No live signal infrastructure** — no webhook/pub-sub wiring for trade alerts
- **Zerodha Connect dormant** — founder OAuth flow exists but no execution channel

---

## 1. AI Research Agent Architecture

**Location:** `/packages/research`

### Current State: MATURE

#### Core Components

| Component              | Status             | Details                                                                                                                                                                         |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent Orchestrator** | ✅ Production      | `ResearchAgent`, `ResearchPlanner`, `ResearchExecutor`, `ResearchValidator`, multi-turn loop                                                                                    |
| **Skills**             | ✅ 9 registered    | `stock-analysis`, `peer-comparison`, `dcf-valuation`, `sector-analysis`, `stock-screener`, `portfolio-analysis`, `portfolio-risk-analysis`, `tax-analysis`, `strategy-analysis` |
| **Tools**              | ✅ 45+             | Data fetch (13), computation (24), synthesis (8)                                                                                                                                |
| **Execution Modes**    | ✅ 3 modes         | DEFAULT (2 iter, 0.70 threshold, 180s), FAST (1 iter, 0.60, 120s), ADVANCED (2 iter, 0.75, 480s)                                                                                |
| **Model Routing**      | ✅ Implemented     | Gemini 2.5 Pro/Flash selection based on complexity (MONEY-626)                                                                                                                  |
| **Planner**            | ✅ LLM-based       | Decomposes query into task DAG                                                                                                                                                  |
| **Validator**          | ✅ LLM + heuristic | Cross-validates results, refines on low confidence                                                                                                                              |

#### Key Exports

```typescript
// packages/research/src/index.ts
ResearchAgent, ResearchPlanner, ResearchExecutor, ResearchValidator, LoopController, Scratchpad
ResearchToolRegistry
getSkill(), getAllSkills(), matchSkill()
NseClient, fetchNews, resolveSymbol
DEFAULT_AGENT_CONFIG, FAST_AGENT_CONFIG, ADVANCED_AGENT_CONFIG, getConfigForMode()
70+ type exports
```

#### Tool Registry

**Location:** `/packages/research/src/tools/registry.ts`

**Registered Tools (45+):**

| Category             | Tools                                                                                                                                                           | Example                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Data Fetch (13)**  | Prices, company profiles, financials, earnings, analyst recommendations, news, shareholding, peer companies, exchange announcements, FII/DII, sector aggregates | `fetch-stock-profile`, `fetch-earnings`, `fetch-fii-dii-flows`                                |
| **Computation (24)** | DCF, VaR, technical indicators, tax, growth metrics, quality scores, correlation, WACC, working capital, rebalancing, momentum analysis                         | `compute-dcf`, `compute-position-var`, `compute-correlation-matrix`, `compute-growth-metrics` |
| **Synthesis (8)**    | Screening, report generation, ITR schedules, summary generation                                                                                                 | `screen-stocks-advanced`, `generate-summary`, `generate-itr-schedule`                         |

#### Technical Indicators in Research

**Location:** `/packages/research/src/lib/indicators.ts`

```typescript
// 24+ indicators
sma(), ema(), rsi(), macd(), bollingerBands(), stochastic(), atr()
adx(), supertrend(), pivotPoints(), obv(), vwap(), volumeRatio()
cci(), mfi(), williamsR(), roc(), psar(), ichimoku(), beta()
detectNarrowRange(), toWeekly(), weeklySMA(), weeklyEMA(), weeklyRSI()

// Strategy rule evaluation
evaluateRule(rule, prices, volumes, highs, lows) → SignalResult
StrategyRule, StrategyDefinition, SignalResult interfaces
```

#### Data Sources

**Location:** `/packages/research/src/data-sources/`

- **DB Store:** Cached historical data (OHLCV tables)
- **Tickertape Client:** MF holdings, metadata
- **NSE Filings:** Corporate actions, earnings announcements
- **BSE Client:** Exchange announcements
- **Screener Client:** Stock screening via Screener.in scraper
- **Stock Document Fetcher:** PDF/document retrieval for company filings
- **Symbol Resolver:** NSE/BSE symbol resolution
- **Chartink Scans:** Technical analysis scans from ChartIQ
- **RAG Enqueue:** Document embedding pipeline
- **Source Cache:** Layer-2 caching with TTL

#### Integration Points with Chat/Web

**Chat Route:** `/apps/web/app/chat-history/` (exists in file system)

- `ChatHistory` model in Prisma
- Slash commands for research invocation
- Streaming response support

**Status:** Chat integration exists but not deeply audited in this pass.

---

## 2. Roast (Portfolio Analytics) Package

**Location:** `/packages/roast`

### Current State: PRODUCTION-READY (Limited Scope)

#### Architecture: 6-Step Pipeline

```
Fetch Portfolio (Prisma)
  → Analyze Stocks (Gemini)
  → Analyze MF (Gemini)
  → Generate Scores (Gemini)
  → Generate Roast (Gemini, high temp)
  → Assemble Result (Pure computation)
```

#### What It Does

- ✅ Loads user's holdings, positions, trades from database
- ✅ Scores stocks on diversification, risk management, stock picking, timing
- ✅ Identifies sector concentration risk (>30%)
- ✅ Flags single-stock concentration (>15% of portfolio)
- ✅ Generates entertaining but insightful AI commentary
- ✅ Computes portfolio summary (totals, sector breakdown, P&L)

#### What It Does NOT Do

- ❌ VaR (Value at Risk) — not implemented
- ❌ Drawdown analysis (mentioned in code, not implemented)
- ❌ Correlation matrix analysis (exists in research tools, not used here)
- ❌ Forward-looking stress tests
- ❌ Live rebalancing recommendations

#### Quant Math Layer

**Location:** `/packages/roast/src/lib/score-utils.ts`, `/packages/roast/src/lib/portfolio-query.ts`

```typescript
// Exists
computePortfolioSummary()  // totals, sector concentration
concentrationScore()        // single stock & sector concentration
diversificationScore()      // inverse of concentration

// NOT implemented
var()                       // VaR calculation
sharpeRatio()              // Risk-adjusted returns
maximumDrawdown()          // Peak-to-trough analysis
```

---

## 3. Market Data Layer

**Location:** `/packages/core/src/market-data/`

### Current State: PARTIAL (Read-Only)

#### Data Sources

| Source                  | Coverage                 | Granularity                     | Availability   | Status                    |
| ----------------------- | ------------------------ | ------------------------------- | -------------- | ------------------------- |
| **Yahoo Finance**       | NSE (Indian), US, Global | Daily OHLCV                     | 1-year history | ✅ Working, cache layer   |
| **Bhavcopy**            | NSE Equities only        | Daily OHLCV + volume            | Historical     | ✅ Historical import      |
| **Zerodha Kite API**    | NSE/NFO positions        | Real-time (holdings, positions) | Live           | ✅ Integrated             |
| **Fyers API**           | NFO positions            | Real-time                       | Live           | ✅ Integrated (read-only) |
| **Interactive Brokers** | US/Global                | Real-time                       | Live           | ✅ Read-only              |

#### Instrument Master

**Location:** `/packages/core/src/market-data/instruments/`

- InstrumentMapping model (NSE → Yahoo symbol lookup)
- ISIN resolution
- Sector/industry enrichment (via Tickertape)
- Fund metadata (AMFI)

#### Quote Service

**Location:** `/packages/core/src/market-data/prices/quote-service.ts`

```typescript
interface QuoteData {
  instrumentId: string;
  price: number;
  change?: number;
  changePercent?: number;
  open?: number;
  high?: number;
  low?: number;
  previousClose?: number;
  volume?: number;
  marketCap?: number;
  timestamp: Date;
  source: string;
}

getLatestQuote(instrumentId, fetchQuote, ttlMs); // DB cache + Yahoo fetch
```

#### Intraday Bar Service

**Location:** `/packages/core/src/market-data/prices/intraday-bar-service.ts`

```typescript
yahooFetchChart(symbol, { period1, period2, interval }); // Daily/weekly/monthly OHLCV
```

#### Technical Indicators (Core)

**Location:** `/packages/core/src/market-data/technical-indicators.ts`

```typescript
// All computed from OHLCV arrays in-memory — no external API
sma(), ema(), rsi(), macd(), bollingerBands(), stochastic(), roc(), atr()
adx(), supertrend(), obv(), vwap(), pivotPoints(), cci(), mfi()
computeMACD(), computeRSI(), etc.  // Returns { value, signal, histogram }

// Signals
interface TechnicalIndicators {
  sma20?, sma50?, sma200?
  ema12?, ema26?
  macd?, macdSignal?, macdHistogram?
  rsi14?, stochK?, stochD?
  // ... 15+ more
  goldenCross?, deathCross?, macdBullishCrossover?
}
```

#### OHLCV Storage

- **No dedicated OHLCV table in Prisma** — prices fetched on-demand from Yahoo
- **DailyPrice model** exists — CORRECTION 2026-07-03: actively used (sector-heatmap, StockTechnicalsCard, StockReturnsBars); see MONEY-1043
- **Sparkline data** sync job exists (`sparkline-sync` worker)
- **Price cache** in Redis (TTL-based)

**Gap:** No persistent OHLCV warehouse. Backtesting will need to fetch from Yahoo or import historical CSV.

---

## 4. Broker Layer

**Location:** `/packages/core/src/brokers/`

### Current State: READ-ONLY SYNCING

#### Supported Brokers

| Broker                  | Holdings       | Positions   | Orders      | Trades                | OrderPlacement         |
| ----------------------- | -------------- | ----------- | ----------- | --------------------- | ---------------------- |
| **Zerodha**             | ✅ Kite API v3 | ✅ Kite API | ✅ Kite API | ✅ Backoffice (async) | ❌ **NOT IMPLEMENTED** |
| **Upstox**              | ✅ REST API    | ✅ REST API | ✅ REST API | ✅ REST API           | ❌ **NOT IMPLEMENTED** |
| **Fyers**               | ✅ REST API    | ✅ REST API | ✅ REST API | ✅ REST API           | ❌ **NOT IMPLEMENTED** |
| **Angel One**           | ✅ SmartAPI    | ✅ SmartAPI | ✅ SmartAPI | ✅ SmartAPI           | ❌ **NOT IMPLEMENTED** |
| **Groww**               | ✅ CSV Import  | ❌          | ❌          | ✅ CSV Import         | ❌ **NOT IMPLEMENTED** |
| **Dhan**                | ✅ REST API    | ✅ REST API | ✅ REST API | ✅ REST API           | ❌ **NOT IMPLEMENTED** |
| **Interactive Brokers** | ✅ API         | ✅ API      | ✅ API      | ✅ API                | ❌ **NOT IMPLEMENTED** |

#### Client Architecture

**Base Class:** `/packages/core/src/brokers/clients/base-client.ts`

```typescript
class BaseBrokerClient {
  async getProfile(): Promise<BrokerProfile>;
  async getHoldings(): Promise<NormalizedHolding[]>;
  async getPositions(): Promise<NormalizedPosition[]>;
  async getOrders(): Promise<NormalizedOrder[]>;
  async getTrades(): Promise<NormalizedTrade[]>;
  async getMutualFunds(): Promise<NormalizedMutualFund[]>;
}
```

**Factory Pattern:** `/packages/core/src/brokers/factory.ts`

```typescript
createBrokerClient(brokerType, credentials) → BaseBrokerClient
```

#### Zerodha Integration (Detailed)

**Files:**

- `/packages/core/src/brokers/clients/zerodha.ts` — Kite Connect API client
- `/packages/core/src/brokers/adapters/zerodha.ts` — Normalization layer

**API Methods Implemented:**

- `getProfile()` — User profile
- `getHoldings()` — Stock holdings (with T1, pledged, MTF data)
- `getPositions()` — F&O positions (NET/DAY)
- `getTrades()` — Historical trades (async polling via backoffice, MONEY-837)
- `getOrders()` — Order history
- `getMutualFunds()` — MF holdings

**Order Placement:** NOT IMPLEMENTED  
**Connect/WebSocket:** Dormant code exists for tick streaming (see notes below)

#### Zerodha Connect (Founder Gating)

**Status:** Infrastructure exists but unused

**Endpoint:** `/api/brokers/zerodha-connect` (web)

```typescript
// MONEY-626: Founder-only OAuth flow to get user's Zerodha access token
// for real-time tick streaming (dormant code in workers/src/connect)
```

**What's missing:**

- Order placement handler
- Order confirmation webhook parsing
- Trade confirmation webhook parsing
- Live position sync

#### Fyers Integration

**Files:**

- `/packages/core/src/brokers/clients/fyers.ts`
- `/packages/core/src/brokers/adapters/fyers.ts`

**Status:** Read-only (holdings, positions, orders, trades)  
**Order Placement:** NOT IMPLEMENTED

---

## 5. Paper Trading Status

**Official Status:** REMOVED

### Evidence

#### Prisma Models (Still Exist)

```prisma
model PaperPosition {
  id String @id @default(auto()) @map("_id") @db.ObjectId
  userId String @db.ObjectId
  portfolioId String? @db.ObjectId
  symbol String
  name String?
  quantity number
  averagePrice number
  currentPrice number
  investedValue number
  currentValue number
  pnl number
  pnlPercentage number
}

model PaperPortfolio {
  id String @id @default(auto()) @map("_id") @db.ObjectId
  userId String @unique @db.ObjectId
  cashBalance number
  totalValue number
}

model PaperOrder {
  id String @id @default(auto()) @map("_id") @db.ObjectId
  userId String @db.ObjectId
  // order fields...
}
```

#### UI/Routes (Deleted)

Grep results show no active routes under `/apps/web/app/` for:

- `/paper-trading`
- `/paper-portfolio`
- `/paper-orders`

**Conclusion:** Models exist in DB schema (legacy) but UI and API routes have been removed. Database cleanup not yet done.

---

## 6. Workers Infrastructure

**Location:** `/workers/`

### Current State: MATURE (No Backtesting Job)

#### Pub/Sub Topics & Processors

| Topic                       | Processor            | Status     | Notes                                                                               |
| --------------------------- | -------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `trade-pairing`             | Trade FIFO pairing   | ✅         | User-scoped                                                                         |
| `csv-import`                | CSV/XLS import       | ✅         | Handles duplicates                                                                  |
| `broker-sync`               | Broker data sync     | ✅         | Holdings, positions, trades                                                         |
| `instrument-sync`           | Master data sync     | ✅         | Daily                                                                               |
| `price-sync`                | Quote refresh        | ✅         | Daily post-market                                                                   |
| `sector-enrichment`         | Sector tagging       | ✅         | Weekly                                                                              |
| `mf-sync`                   | AMFI NAV             | ✅         | Daily                                                                               |
| `mf-metadata-sync`          | MF enrichment        | ✅         | Weekly                                                                              |
| `stock-research`            | AI research jobs     | ✅         | User-scoped                                                                         |
| `document-process`          | PDF extraction       | ✅         | Report generation                                                                   |
| `portfolio-roast`           | Roast analysis       | ✅         | User-scoped                                                                         |
| `comparison-analysis`       | Stock/MF comparison  | ✅         | MONEY-553                                                                           |
| ~~`fund-composition-sync`~~ | ETF/MF composition   | ❌ removed | MONEY-1205: declared + consumed, NEVER published; no scheduler. Deleted, not wired. |
| `investor-rollup`           | Self-learning rollup | ✅         | MONEY-789 B4                                                                        |

#### Job Architecture

```typescript
// Request model
interface PubSubMessage {
  userId: string;
  jobId: string;
  params: Record<string, unknown>;
  createdAt: string;
}

// Processing pattern
async function handleJob(message: PubSubMessage) {
  // 1. Auth check (OIDC)
  // 2. Parse message
  // 3. Run processor logic
  // 4. Update status (PENDING → SUCCESS/FAILED)
  // 5. Send notification
}
```

#### For a New Backtest Job

**Integration would be:**

1. Add `backtest` to Pub/Sub topics list
2. Create `/workers/src/routes/backtest.ts`
3. Create `/workers/src/processors/backtest.ts` with:
   - Historical data fetch (Yahoo, Bhavcopy, or stored OHLCV)
   - Strategy execution loop
   - P&L, drawdown, Sharpe calculation
   - Result persistence to new `Backtest` model
4. Trigger via web server action: `publishToTopic('backtest', { userId, params })`

**Timeouts:** Current workers use 60-300s step timeouts. A backtest job might need longer (depends on history length + indicator complexity).

---

## 7. AI Chat Integration

**Location:** `/apps/web/app/chat-history/`, `/apps/web/routes/api/chat`

### Current State: PARTIAL

#### What Works

- ✅ Chat history storage (Prisma `ChatHistory` model)
- ✅ Streaming responses
- ✅ User authentication via Clerk
- ✅ Research agent invocation (via slash commands)

#### Chat Commands (Inferred from Research Skills)

```
/stock-analysis {symbol}
/peer-comparison {symbols...}
/dcf-valuation {symbol}
/sector-analysis {sector}
/stock-screener {criteria...}
/portfolio-analysis
/portfolio-risk-analysis
/tax-analysis
/strategy-analysis
```

#### Slash Command Routing

- **Pattern:** `/commandName` triggers skill match
- **Planner decomposes** the query into research tasks
- **Executor runs tasks** with progress callbacks
- **Validator cross-checks** results
- **Stream back** to user with markdown formatting

#### Model Selection (MONEY-626)

**Location:** `/packages/research/src/model-selection.ts`

```typescript
// Route to Gemini or Claude based on:
// - Query complexity
// - User tier (free/premium/pro)
// - Founder override (CLAUDE_ALLOWED_EMAILS)

function selectModel(query, user, config) {
  if (
    user.isFounder &&
    process.env.CLAUDE_ALLOWED_EMAILS?.includes(user.email)
  ) {
    return "claude-3-5-sonnet"; // or latest Claude model
  }
  return "gemini-2.5-pro"; // default
}
```

#### Feature Flags Pattern (Extensible)

**Environment Variables:**

```bash
CLAUDE_ALLOWED_EMAILS=deepshaswat@gmail.com,founder2@...
USE_GEMINI=true
GEMINI_MAX_RETRIES=3
GEMINI_TIMEOUT_MS=30000
VERTEX_RAG_ENABLED=true
VERTEX_RAG_CORPUS=...
```

**Where to Add New Commands:**

1. Create new skill in `/packages/research/src/skills/`
2. Export from `/packages/research/src/skills/index.ts`
3. Register in chat route middleware
4. Add to slash-command parser

---

## 8. Charting & Visualization

**Location:** `/apps/web/`

### Current Libraries

| Library                | Version  | Purpose                               | Status                                        |
| ---------------------- | -------- | ------------------------------------- | --------------------------------------------- |
| **lightweight-charts** | 5.1.0    | Candlestick/line charts (TradingView) | ✅ Installed                                  |
| **klinecharts**        | 9.8.12   | Alternative charting lib              | ✅ Installed                                  |
| **recharts**           | 3.6.0    | React-based chart components          | ✅ Installed                                  |
| **charting_library**   | (custom) | TradingView Charting Library          | ✅ Vendor code in `/public/charting_library/` |

### TradingView Integration

**Status:** Advanced (Charting Library integrated)

**Location:** `/apps/web/public/charting_library/`

- `charting_library.cjs.js` + `.esm.js`
- `charting_library.d.ts` (TypeScript definitions)
- Full technical analysis toolbar included

**Gap:** DataFeed integration not fully audited. Would need to wire up real-time & historical data feeds for live charting during backtesting or paper trading.

---

## 9. Prisma Schema Analysis

**Location:** `/packages/database/prisma/schema.prisma`

### Quant-Relevant Models

| Model              | Purpose                            | Status    | Gap                                                             |
| ------------------ | ---------------------------------- | --------- | --------------------------------------------------------------- |
| **Trade**          | Historical trades with broker sync | ✅ Exists | No strategy link                                                |
| **Order**          | Orders (broker sync)               | ✅ Exists | No strategy link                                                |
| **Holding**        | Current holdings                   | ✅ Exists | No position tracking                                            |
| **Position**       | F&O positions                      | ✅ Exists | No strategy link                                                |
| **PaperPosition**  | Paper trading (legacy)             | ⚠️ Exists | UI removed                                                      |
| **PaperPortfolio** | Paper portfolio (legacy)           | ⚠️ Exists | UI removed                                                      |
| **LatestQuote**    | Price cache                        | ✅ Exists | Limited history                                                 |
| **DailyPrice**     | Historical OHLCV                   | ✅ Exists | ACTIVE (corrected 2026-07-03) — migration to Candle: MONEY-1043 |
| **Sparkline**      | Price sparkline data               | ⚠️ Exists | Minimal (for charts)                                            |

### Missing Models (FOR Backtesting)

> CORRECTION 2026-07-03: `Alert` (schema:3022) and a Strategy-like `CustomStrategy` (schema:3602) ALREADY exist — reconcile before adding the models below (MONEY-1042). The rest (Candle, Backtest, BacktestMetrics, Signal, ForwardRun, ExecutionOrder) are genuinely absent.

```prisma
model Strategy {
  id String @id @default(auto()) @map("_id") @db.ObjectId
  userId String @db.ObjectId
  name String
  description String?
  rules Json  // StrategyRule[]
  backtests Backtest[]
  liveSignals Signal[]
  alerts Alert[]
}

model Backtest {
  id String @id @default(auto()) @map("_id") @db.ObjectId
  strategyId String @db.ObjectId
  userId String @db.ObjectId
  startDate DateTime
  endDate DateTime
  symbols String[]
  result Json  // { totalReturn, maxDrawdown, sharpeRatio, winRate, trades[] }
  createdAt DateTime
  completedAt DateTime?
}

model Signal {
  id String @id @default(auto()) @map("_id") @db.ObjectId
  strategyId String @db.ObjectId
  symbol String
  direction String  // "BUY" | "SELL" | "NEUTRAL"
  price number
  timestamp DateTime
  confidence number
  metadata Json?
}

model Alert {
  id String @id @default(auto()) @map("_id") @db.ObjectId
  userId String @db.ObjectId
  strategyId String @db.ObjectId
  condition String
  triggered Boolean @default(false)
  triggeredAt DateTime?
  createdAt DateTime
}

model BacktestMetrics {
  id String @id @default(auto()) @map("_id") @db.ObjectId
  backtestId String @db.ObjectId @unique
  totalReturn number
  annualizedReturn number
  maxDrawdown number
  sharpeRatio number
  sortinoRatio number
  winRate number
  profitFactor number
  totalTrades number
  tradeDetails Json
}
```

---

## 10. Existing Indicator Math

### Location & Completeness

#### In `/packages/research/src/lib/indicators.ts` (COMPREHENSIVE)

```typescript
✅ sma(), ema(), emaLast()
✅ computeRSI()
✅ computeMACD()
✅ computeBollingerBands()
✅ findSupportResistance()
✅ computeStochastic()
✅ computeATR(), computeTrueRanges()
✅ computeADX()
✅ computeSupertrend()
✅ computePivotPoints()
✅ computeOBV()
✅ computeVWAP()
✅ computeVolumeRatio()
✅ computeCCI()
✅ computeMFI()
✅ computeWilliamsR()
✅ computeROC()
✅ computePSAR()
✅ computeIchimoku()
✅ computeBeta()
✅ detectNarrowRange()
✅ evaluateRule() — strategy rule evaluation engine
✅ Weekly variants: weeklySMA(), weeklyEMA(), weeklyRSI()
```

#### In `/packages/core/src/market-data/technical-indicators.ts`

```typescript
✅ sma(), ema()
✅ rsi()
✅ macd() — returns { macd, signal, histogram }
✅ bollingerBands()
✅ stochastic()
✅ supportResistance()
✅ All registered in TechnicalIndicators interface
```

#### Chart Pattern Recognition

**Location:** `/packages/research/src/lib/chart-patterns.ts`

```typescript
✅ Head & Shoulders
✅ Double Top / Double Bottom
✅ Triangle (Ascending, Descending, Symmetric)
✅ Wedge (Rising, Falling)
✅ Channel (Ascending, Descending)
✅ Pennant
✅ Flag
✅ Cup & Handle
```

#### Candlestick Patterns

**Location:** `/packages/research/src/lib/candlestick-patterns.ts`

```typescript
✅ Doji
✅ Hammer / Inverted Hammer
✅ Bullish / Bearish Engulfing
✅ Morning / Evening Star
✅ Harami
✅ Piercing Line / Dark Cloud Cover
✅ Marubozu
✅ Three Soldiers / Three Crows
✅ Kicking
✅ Separating Lines
```

### Risk/Quant Math

**In `/packages/research/src/tools/`:**

```typescript
✅ compute-position-var.ts — Position-level VaR
✅ compute-var.ts — Portfolio VaR
✅ compute-drawdown-profile.ts — Drawdown tracking
✅ compute-correlation-matrix.ts — Correlation heatmap
✅ compute-portfolio-concentration.ts — Concentration metrics
✅ compute-portfolio-beta-drift.ts — Beta analysis
✅ compute-trend-strength.ts — Trend analysis
✅ compute-growth-metrics.ts — Growth calculations
✅ compute-earning-quality.ts — Earnings quality score
✅ compute-accounting-quality.ts — Beneish M-score
```

**Gap:** These tools exist but are not **integrated into backtesting** — they compute on current portfolio, not historical simulations.

---

## 11. Environment & Config Seams

**Locations:**

- `.env` (root + apps/web, workers)
- `.env.example` (each app/package)
- Feature flag pattern via env vars

### Founder-Only Gating Pattern

```bash
# .env
CLAUDE_ALLOWED_EMAILS=deepshaswat@gmail.com,other-founder@example.com
USE_GEMINI=true
VERTEX_RAG_ENABLED=true

# apps/web/.env
NEXT_PUBLIC_BASE_URL=https://usemoney.ai
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
GOOGLE_GENAI_API_KEY=...
```

### Middleware Example (Inferred)

```typescript
// apps/web/lib/founder-check.ts (likely pattern)
export function isFounder(userEmail: string): boolean {
  const allowed = process.env.CLAUDE_ALLOWED_EMAILS?.split(",") || [];
  return allowed.includes(userEmail.trim());
}

// In API route
if (isFounder(user.email)) {
  // Use Claude model instead of Gemini
  // Enable live trading features
  // Use advanced research modes
}
```

### Adding New Systems

**Pattern to follow:**

1. Define feature flag env var in `.env.example` (all apps/packages)
2. Add typed accessor in `/packages/config/` or inline middleware
3. Guard features with `if (process.env.FEATURE_FLAG === 'true')`
4. Test with flag both enabled and disabled

---

## 12. Gap Analysis: What's Missing for Backtesting + Live Trading

### CRITICAL GAPS (Blocking)

| Gap                      | Impact                               | Effort      | Priority |
| ------------------------ | ------------------------------------ | ----------- | -------- |
| **Order Placement API**  | Cannot execute live trades           | Medium-High | **P0**   |
| **Backtest Engine**      | Cannot validate strategies           | High        | **P0**   |
| **Strategy Persistence** | Cannot save/track strategies         | Low         | **P0**   |
| **Signal/Alert Model**   | Cannot alert on triggers             | Low         | **P0**   |
| **Live Data Feed**       | Cannot subscribe to real-time quotes | Medium      | **P0**   |

### HIGH-PRIORITY GAPS

| Gap                         | Impact                                      | Effort | Priority |
| --------------------------- | ------------------------------------------- | ------ | -------- |
| **OHLCV Warehouse**         | Slow backtests (fetch from Yahoo each time) | Medium | **P1**   |
| **Backtest Result Storage** | Cannot compare runs over time               | Low    | **P1**   |
| **Paper Trading UI**        | Cannot practice before live trading         | Medium | **P1**   |
| **Risk/Drawdown Alerts**    | Cannot stop bleeding portfolios             | Low    | **P1**   |
| **Performance Attribution** | Cannot analyze where alpha came from        | Medium | **P1**   |

### MEDIUM-PRIORITY GAPS

| Gap                             | Impact                               | Effort | Priority |
| ------------------------------- | ------------------------------------ | ------ | -------- |
| **Multi-timeframe Analysis**    | Limited to daily                     | Low    | **P2**   |
| **Options Chain Data**          | Can't evaluate F&O strategies        | High   | **P2**   |
| **Dividend/Adjustment History** | Backtests ignoring corporate actions | Low    | **P2**   |
| **Slippage Modeling**           | Unrealistic backtest performance     | Low    | **P2**   |
| **Tax-Lot Tracking**            | Can't optimize for tax efficiency    | Medium | **P2**   |

### LOW-PRIORITY GAPS

| Gap                           | Impact                       | Effort | Priority |
| ----------------------------- | ---------------------------- | ------ | -------- |
| **Multi-Asset Backtests**     | Limited to individual stocks | Medium | **P3**   |
| **Walk-Forward Optimization** | Can't avoid overfitting      | High   | **P3**   |
| **Monte Carlo Simulation**    | Limited risk analysis        | High   | **P3**   |
| **Custom Indicator Editor**   | Can only use built-ins       | Medium | **P3**   |

---

## 13. CLAUDE.md Staleness Check

### Top-Level CLAUDE.md (`/CLAUDE.md`)

| Section                | Stale?      | Notes                                           |
| ---------------------- | ----------- | ----------------------------------------------- |
| **Product Vision**     | ❌ Current  | Accurate as of July 2026                        |
| **Tech Stack**         | ⚠️ SLIGHTLY | Still accurate, no major changes needed         |
| **Monorepo Structure** | ✅ Current  | All packages listed, matched reality            |
| **Core Features**      | ⚠️ SLIGHTLY | Paper trading marked as feature, but UI is gone |
| **Subscription Tiers** | ✅ Current  | Matched subscription model                      |
| **Key Decisions**      | ✅ Current  | Auth, caching, security all accurate            |
| **Test Coverage**      | ✅ Current  | References TEST-COVERAGE.md (proper pattern)    |

**Action:** Update "Paper Trading" feature line to note it's been deprecated UI-wise but models still exist.

### packages/research/README.md

| Section           | Stale?     | Notes                                                     |
| ----------------- | ---------- | --------------------------------------------------------- |
| **Architecture**  | ✅ Current | Planner → Executor → Validator → Refiner loop is accurate |
| **Skills (9)**    | ✅ Current | All 9 match registered skills                             |
| **Tools (45+)**   | ✅ Current | Count matches                                             |
| **Modes (3)**     | ✅ Current | DEFAULT, FAST, ADVANCED all implemented                   |
| **Usage Example** | ✅ Current | Code is runnable                                          |

**Status:** This README is excellent. Keep as-is.

### workers/CLAUDE.md

| Section                 | Stale?     | Notes                                |
| ----------------------- | ---------- | ------------------------------------ |
| **Endpoints**           | ✅ Current | All 14 topics listed and implemented |
| **Directory Structure** | ✅ Current | Matches reality                      |
| **Job Flow**            | ✅ Current | Pub/Sub → Cloud Run pattern accurate |

**Status:** Good. Just needs a note about "NO BACKTEST TOPIC YET".

---

## 14. Key Files & Exports Summary

### Research Agent (Entry Points)

```typescript
// packages/research/src/index.ts
export { ResearchAgent, ResearchPlanner, ResearchExecutor, ResearchValidator }
export { ResearchToolRegistry, getSkill, getAllSkills, matchSkill }
export { DEFAULT_AGENT_CONFIG, FAST_AGENT_CONFIG, ADVANCED_AGENT_CONFIG, getConfigForMode }
export type { ResearchAgentConfig, ResearchTask, ToolOutput, ... }

// packages/research/src/executor.ts
class ResearchExecutor {
  async execute(tasks, scratchpad, onProgress?) → tasks[]
}

// packages/research/src/tools/registry.ts
class ResearchToolRegistry {
  register(tool) → void
  getTool(name) → ResearchToolDef
  listAll() → ResearchToolDef[]
}
```

### Roast (Portfolio Analytics)

```typescript
// packages/roast/src/index.ts
export { RoastAgent, runRoastPipeline }
export type { RoastAgentConfig, RoastJobMessage, RoastResult, ... }

// packages/roast/src/agent.ts
class RoastAgent {
  async execute(job: RoastJobMessage) → RoastResult
}
```

### Broker Integration

```typescript
// packages/core/src/brokers/factory.ts
export function createBrokerClient(broker, credentials) → BaseBrokerClient

// packages/core/src/brokers/clients/base-client.ts
export class BaseBrokerClient {
  async getHoldings() → NormalizedHolding[]
  async getPositions() → NormalizedPosition[]
  async getOrders() → NormalizedOrder[]
  async getTrades() → NormalizedTrade[]
}

// Zerodha-specific (ORDER PLACEMENT NOT HERE)
// packages/core/src/brokers/clients/zerodha.ts
class ZerodhaClient extends BaseBrokerClient { }
```

### Indicators

```typescript
// packages/research/src/lib/indicators.ts
export { sma, ema, computeRSI, computeMACD, computeBollingerBands, ... }
export { evaluateRule, StrategyRule, StrategyDefinition, SignalResult }

// packages/core/src/market-data/technical-indicators.ts
export { sma, ema, rsi, macd, ... }
export interface TechnicalIndicators { ... }
```

---

## 15. Integration Roadmap (Recommended)

### Phase 1: Foundation (Weeks 1-2)

1. **Add Backtest Models to Prisma**
   - `Strategy`, `Backtest`, `Signal`, `Alert`, `BacktestMetrics`
   - Run `yarn db:push`

2. **Create Backtest Worker**
   - `/workers/src/routes/backtest.ts`
   - `/workers/src/processors/backtest-logic.ts`
   - Pub/Sub topic: `backtest`

3. **Implement Basic Backtest Engine**
   - Input: strategy rules + symbol + date range
   - Output: trades array, metrics (return, drawdown, Sharpe)
   - Use existing indicator library
   - Fetch OHLCV from Yahoo Finance or Bhavcopy

### Phase 2: Strategy Library (Weeks 3-4)

1. **Strategy Rule Builder**
   - UI: Create/edit strategies with drag-drop rules
   - Save to `Strategy` model
   - Validation: ensure rule syntax is valid

2. **Built-in Strategies**
   - SMA Crossover, RSI Oversold/Overbought, MACD, Bollinger Band breakout
   - Store in `/packages/research/src/strategies/`

3. **Strategy Backtesting UI**
   - Run backtest from strategy editor
   - Show results: P&L, drawdown, trade list, equity curve

### Phase 3: Live Signal Generation (Weeks 5-6)

1. **Real-time Data Feed**
   - Subscribe to Zerodha WebSocket (dormant code in workers/src/connect)
   - Or use Fyers API streaming
   - Push tick data to Pub/Sub topic: `market-ticks`

2. **Signal Generator**
   - Worker listens to `market-ticks`
   - Evaluates active strategies on each tick
   - Emits `Signal` if condition met
   - Stores in `Signal` model

3. **Alert & Notification**
   - When signal triggered, send push + email + in-app notification
   - Optional: webhook to founder's monitoring dashboard

### Phase 4: Order Placement (Weeks 7-8)

1. **Broker API Extension**
   - Add `placeOrder(symbol, quantity, price, side)` to `BaseBrokerClient`
   - Implement for Zerodha + Fyers (others can follow)
   - Handle order confirmation, error handling, position tracking

2. **Order Execution Handler**
   - Founder-only gate: check `CLAUDE_ALLOWED_EMAILS`
   - One-click order placement from UI
   - Or automatic execution from signal (with safety limits)

3. **Post-Trade Bookkeeping**
   - Sync executed orders back to `Trade` model
   - Link to originating `Signal` and `Strategy`
   - Update portfolio holdings in real-time

### Phase 5: Advanced Features (Weeks 9+)

1. **Multi-timeframe Analysis**
   - Backtest on hourly, 4H, daily in addition to daily
   - Combine signals across timeframes

2. **Risk Management**
   - Portfolio-level limits (max position size, sector exposure)
   - Dynamic stop-loss based on ATR or drawdown
   - Drawdown alerts (notify if portfolio down >5%)

3. **Performance Attribution**
   - Which strategies contributed to P&L?
   - Which rules triggered most often?
   - Correlation with market conditions

4. **Optimization**
   - Walk-forward backtests
   - Parameter optimization grid search
   - Sensitivity analysis

---

## 16. Implementation Notes & Warnings

### Data Source Reliability

- **Yahoo Finance:** Works but has occasional gaps. Not suitable for official records.
- **NSE Bhavcopy:** Official source, 1-day delay, best for historical validation.
- **Broker APIs:** Real-time, broker-dependent rate limits, quota issues.
- **TradingView/Tickertape:** Web scraping fragile, good for enrichment only.

### Backtest Realism

- **No slippage modeling:** Assumes market order fills at OHLC[close]
- **No commission:** Add broker fees separately when comparing to live
- **Survivor bias:** Data only includes stocks that exist today
- **Look-ahead bias:** Ensure indicators don't peek at future data (watch aggregation windows)

### Live Trading Safety

- **Order placement must be gated:** Founder-only, require explicit confirmation
- **Position limits:** Hard caps on size, margin, leverage
- **Kill switch:** Ability to cancel all open orders instantly
- **Audit trail:** Log every order/trade with timestamp, user, strategy, signal
- **Testing:** Always backtest + paper trade before live

### Performance Considerations

- **Backtest speed:** Full-year daily backtest (~250 bars) with 24 indicators: ~100ms per symbol
- **Real-time evaluation:** Evaluate all active strategies on every tick → potential rate limiting
- **Database:** Prisma/MongoDB acceptable for strategy/result storage, not tick-by-tick streaming
- **Caching:** Redis essential for quote cache (60s TTL), indicator cache (day-level)

---

## 17. Competitive Analysis (Market Context)

### Existing Solutions (for reference)

| Product                 | Focus                 | Tech        | India Support          |
| ----------------------- | --------------------- | ----------- | ---------------------- |
| **TradingView**         | Charting + strategies | C++/web     | ✅ (via Zerodha/Fyers) |
| **AlgoJi**              | Algo trading (Indian) | Python/Node | ✅ (NSE/BSE only)      |
| **Bostock**             | Portfolio analytics   | Python/web  | ⚠️ (limited)           |
| **Interactive Brokers** | APIs                  | Java/Python | ✅ (global)            |
| **Zerodha Streak**      | Strategy builder      | Proprietary | ✅ (NSE/NFO)           |

### UseMoney Differentiation (Potential)

- **AI-native:** Gemini + Claude for strategy generation + validation
- **Multi-broker:** Unified interface across Zerodha, Fyers, Upstox, etc.
- **Full portfolio context:** Strategies aware of holdings, taxes, sector exposure
- **India-first:** NSE/BSE optimized, tax compliance built-in
- **Open research:** Researchers can publish strategies → community grows

---

## 18. Conclusion & Recommendations

### Summary

**UseMoney is 70% of the way to a backtesting + algo trading platform.** The missing 30% is primarily:

1. Order placement API (blocking live trading)
2. Backtest engine persistence & UI (blocking strategy iteration)
3. Live signal/alert infrastructure (blocking real-time trading)

### Recommended Next Steps

1. **Short-term (1-2 weeks):**
   - Add `Strategy`, `Backtest`, `Signal` models
   - Implement basic backtest engine (in-memory evaluation)
   - Wire backtest results to UI

2. **Medium-term (3-4 weeks):**
   - Add order placement to Zerodha + Fyers clients
   - Implement live signal generator (WebSocket or polling)
   - Add founder-only gating and safety checks

3. **Long-term (5+ weeks):**
   - Strategy optimization engine (parameter sweep)
   - Multi-timeframe analysis
   - Risk management layer (portfolio limits, drawdown alerts)
   - Community strategy marketplace

### Risk Mitigation

- **Start with paper trading:** Validate backtest accuracy before live orders
- **Founder testing only:** Limit live execution to logged-in founder initially
- **Audit everything:** Log all trades, strategies, signals with context
- **Insurance/disclaimer:** SEBI compliance, user risk acknowledgment
- **Kill switches:** Ability to disable all live trading instantly (env var)

### Files to Create/Modify

**Priority 1 (Week 1):**

- `/packages/database/prisma/schema.prisma` — add Backtest models
- `/workers/src/routes/backtest.ts` — new endpoint
- `/workers/src/processors/backtest-logic.ts` — execution engine
- `/packages/core/src/backtest/engine.ts` — strategy evaluator

**Priority 2 (Week 2-3):**

- `/packages/core/src/brokers/clients/base-client.ts` — add `placeOrder()`
- `/packages/core/src/brokers/clients/zerodha.ts` — implement Kite order placement
- `/packages/core/src/brokers/clients/fyers.ts` — implement Fyers order placement
- `/apps/web/app/strategies/` — new UI section

**Priority 3 (Week 4+):**

- `/packages/research/src/strategies/optimization.ts` — parameter sweep
- `/workers/src/routes/signal-generator.ts` — real-time evaluation
- `/apps/web/app/signals/` — alerts & execution UI

---

## Appendix: File Path Reference

```
stockbook-monorepo/
├── packages/
│   ├── research/              # AI research agent (45+ tools, 9 skills)
│   │   ├── src/
│   │   │   ├── executor.ts               # Core execution engine
│   │   │   ├── agent.ts                  # Orchestrator
│   │   │   ├── tools/registry.ts         # Tool registration
│   │   │   ├── lib/indicators.ts         # 24+ indicators
│   │   │   ├── lib/chart-patterns.ts     # Chart pattern recognition
│   │   │   ├── lib/candlestick-patterns.ts
│   │   │   ├── data-sources/             # NSE, Yahoo, Tickertape, BSE, etc.
│   │   │   └── strategies/               # Built-in strategies
│   │   └── package.json
│   ├── roast/                  # Portfolio analytics (6-step pipeline)
│   │   ├── src/
│   │   │   ├── agent.ts
│   │   │   ├── agent-pipeline.ts
│   │   │   ├── steps/                    # Fetch, Analyze, Score, Generate, Assemble
│   │   │   ├── lib/portfolio-query.ts
│   │   │   ├── lib/score-utils.ts
│   │   │   ├── prompts.ts
│   │   │   └── types.ts
│   │   └── package.json
│   ├── core/                   # Business logic
│   │   ├── src/
│   │   │   ├── brokers/        # Zerodha, Fyers, Upstox, Angel, Groww, Dhan, IBKR
│   │   │   │   ├── clients/    # API clients (read-only)
│   │   │   │   ├── adapters/   # Normalization
│   │   │   │   ├── factory.ts
│   │   │   │   └── base-adapter.ts
│   │   │   ├── market-data/
│   │   │   │   ├── prices/               # Quote service, intraday bars
│   │   │   │   ├── technical-indicators.ts
│   │   │   │   ├── bhavcopy.ts
│   │   │   │   ├── instruments/          # Instrument master
│   │   │   │   └── staleness.ts
│   │   │   ├── pairing/                  # FIFO trade pairing
│   │   │   ├── payments/                 # Dodo Payments
│   │   │   ├── gemini.ts                 # Google Gemini client
│   │   │   ├── investor/                 # Investor signals
│   │   │   └── rag/                      # Vertex AI RAG
│   │   └── package.json
│   ├── database/                # Prisma schema
│   │   ├── prisma/
│   │   │   └── schema.prisma    # All models: User, Trade, Holding, etc.
│   │   └── package.json
│   ├── types/                  # Shared TypeScript types
│   ├── cache/                  # Redis + memory caching
│   ├── logger/                 # Structured logging
│   ├── storage/                # GCS client
│   ├── services/               # 25+ service modules
│   ├── validation/             # Zod schemas
│   ├── security/               # Encryption, tokens
│   ├── email/                  # Resend client
│   ├── auth/                   # Clerk utilities
│   ├── content-engine/         # Learning content generation
│   ├── datadog/                # APM & metrics
│   ├── trpc/                   # tRPC routers
│   ├── ui/                     # Shared React components
│   └── ... other packages
│
├── workers/                    # Background job processing (Cloud Run)
│   ├── src/
│   │   ├── index.ts            # Hono server entry (port 8081)
│   │   ├── routes/
│   │   │   ├── trade-pairing.ts
│   │   │   ├── csv-import.ts
│   │   │   ├── broker-sync.ts
│   │   │   ├── price-sync.ts
│   │   │   ├── research.ts
│   │   │   ├── roast.ts
│   │   │   ├── comparison.ts
│   │   │   ├── document-process.ts
│   │   │   └── ... other routes
│   │   ├── processors/         # Business logic for each job
│   │   ├── lib/
│   │   │   ├── message.ts      # Pub/Sub envelope parsing
│   │   │   ├── pubsub-client.ts
│   │   │   ├── gcs.ts
│   │   │   ├── docai.ts
│   │   │   └── notifications.ts
│   │   └── report-templates/   # PDF report generation
│   ├── CLAUDE.md               # Worker documentation
│   ├── Dockerfile
│   ├── cloudbuild.yaml
│   └── package.json
│
├── apps/
│   ├── web/                    # Next.js web app (Vercel)
│   │   ├── app/
│   │   │   ├── dashboard/
│   │   │   ├── portfolio/
│   │   │   ├── chat-history/   # AI chat UI
│   │   │   ├── discover/       # Stock/MF discovery
│   │   │   ├── settings/
│   │   │   ├── [auth]/         # Sign-in/up
│   │   │   └── ... other routes
│   │   ├── components/         # App-specific components
│   │   ├── lib/                # App utilities
│   │   ├── types/              # App types
│   │   ├── public/
│   │   │   └── charting_library/  # TradingView Charting Library
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── .env                # Web config (with CLAUDE_ALLOWED_EMAILS)
│   ├── api/                    # Hono REST API (Vercel)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── routes/
│   │   │   └── middleware/
│   │   └── package.json
│   ├── admin/                  # Admin dashboard (Next.js)
│   └── content/                # Content CMS (Next.js)
│
├── .env                        # Root env (shared across apps)
├── .env.example
├── CLAUDE.md                   # This file (keep updated!)
├── TEST-COVERAGE.md            # Test coverage (single source of truth)
├── ARCHITECTURE.md
├── SETUP.md
├── README.md
├── package.json                # Root workspace
├── turbo.json                  # Turborepo config
├── tsconfig.json               # Root TypeScript config
└── scripts/
    ├── setup-infra.sh          # One-command infra setup
    ├── setup-pubsub.sh         # Pub/Sub topics
    ├── setup-scheduler.sh       # Cloud Scheduler jobs
    └── seed-env.sh             # Database seeding

```

---

**End of Audit Report**

**Report Generated:** July 3, 2026  
**Prepared for:** Founder (deepshaswat@gmail.com)  
**Next Review:** After Phase 1 implementation
