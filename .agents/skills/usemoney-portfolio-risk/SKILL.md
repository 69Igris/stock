---
name: usemoney-portfolio-risk
description:
  "Build portfolio risk analysis and advanced analytics features for UseMoney.
  Use this skill whenever the user asks about portfolio risk metrics, sector
  allocation, correlation analysis, VaR, drawdown, Sharpe ratio, rebalancing, or
  any portfolio-level quantitative analysis. Also trigger when adding risk
  computation tools, building portfolio analytics dashboards, or working on the
  advanced analytics roadmap item."
---

# UseMoney Portfolio Risk & Analytics Agent

Add quantitative portfolio risk analysis capabilities to UseMoney. This skill
guides you through building new computation tools, risk metrics, and
portfolio-level analytics that plug into the existing StockSage research agent.

## What This Agent Does

The portfolio risk agent extends UseMoney's existing `portfolio-analysis` skill
(which currently does basic sector allocation and health scoring) with
institutional-grade risk analytics:

- **Concentration risk** - Herfindahl index, top-N holding exposure
- **Correlation analysis** - Cross-holding correlation matrix, diversification
  score
- **Value at Risk (VaR)** - Historical and parametric VaR at 95%/99% confidence
- **Drawdown analysis** - Maximum drawdown, recovery time, underwater periods
- **Risk-adjusted returns** - Sharpe ratio, Sortino ratio, information ratio
- **Rebalancing** - Target allocation vs actual, recommended trades

---

## New Tools to Build

Each tool follows `ResearchToolDef` interface. See `usemoney-research-dev` skill
for the complete pattern.

### 1. `compute_portfolio_concentration`

**Category**: `computation`

**Purpose**: Measure how concentrated vs diversified a portfolio is.

**Inputs**:

```
holdings: Array<{ symbol, quantity, currentPrice, sector }>
```

**Outputs**:

```typescript
{
  herfindahlIndex: number; // 0-10000, lower = more diversified
  top3Exposure: number; // % of portfolio in top 3 holdings
  top10Exposure: number; // % in top 10
  sectorBreakdown: Array<{
    sector: string;
    weight: number; // percentage
    holdings: number; // count
  }>;
  concentrationVerdict: "high" | "moderate" | "low";
}
```

**Implementation notes**: The Herfindahl-Hirschman Index (HHI) is the sum of
squared portfolio weights. Below 1500 is diversified, 1500-2500 moderate, above
2500 concentrated. For Indian retail investors, also flag single-stock exposure
above 20%.

### 2. `compute_correlation_matrix`

**Category**: `computation`

**Purpose**: Calculate return correlations between holdings to measure true
diversification.

**Inputs**:

```
symbols: string[]
priceHistories: Record<string, Array<{ date, close }>>
period: "1m" | "3m" | "6m" | "1y"    // default "6m"
```

**Outputs**:

```typescript
{
  matrix: number[][];               // NxN correlation matrix
  symbols: string[];                // Column/row labels
  diversificationScore: number;     // 0-100 (higher = more diversified)
  highCorrelationPairs: Array<{
    stock1: string;
    stock2: string;
    correlation: number;
  }>;                               // Pairs with correlation > 0.7
}
```

**Implementation notes**: Use Pearson correlation on daily log returns. The
diversification score is derived from the average off-diagonal correlation -
lower average correlation means better diversification. Flag pairs above 0.7 as
potentially redundant holdings.

### 3. `compute_var`

**Category**: `computation`

**Purpose**: Estimate potential portfolio loss at given confidence levels.

**Inputs**:

```
holdings: Array<{ symbol, currentValue }>
priceHistories: Record<string, Array<{ date, close }>>
confidence: 0.95 | 0.99
method: "historical" | "parametric"
timeHorizon: number                  // days, default 1
```

**Outputs**:

```typescript
{
  var95: number; // Loss at 95% confidence (INR)
  var99: number; // Loss at 99% confidence (INR)
  var95Percent: number; // As % of portfolio
  var99Percent: number;
  expectedShortfall: number; // Average loss beyond VaR (CVaR)
  method: string;
  interpretation: string; // Human-readable explanation
}
```

**Implementation notes**: Historical VaR sorts portfolio returns and picks the
percentile. Parametric VaR assumes normal distribution - multiply portfolio std
dev by z-score (1.645 for 95%, 2.326 for 99%). For Indian markets, use INR
values. The interpretation field should say something like "There is a 5% chance
of losing more than INR X in a single day."

### 4. `compute_drawdown`

**Category**: `computation`

**Purpose**: Analyze worst-case declines from peak portfolio values.

**Inputs**:

```
portfolioHistory: Array<{ date, totalValue }>
```

**Outputs**:

```typescript
{
  maxDrawdown: number; // Percentage (negative)
  maxDrawdownPeriod: {
    peakDate: string;
    troughDate: string;
    recoveryDate: string | null; // null if not recovered
    daysToTrough: number;
    daysToRecovery: number | null;
  }
  currentDrawdown: number; // Current distance from peak
  underwaterPeriods: Array<{
    start: string;
    end: string;
    depth: number;
  }>;
}
```

### 5. `compute_risk_adjusted_returns`

**Category**: `computation`

**Purpose**: Compare returns relative to risk taken.

**Inputs**:

```
portfolioReturns: number[]          // Daily returns
riskFreeRate: number                // Annual, default 0.065 (6.5% for India, RBI repo rate)
benchmarkReturns?: number[]         // Nifty 50 daily returns for comparison
```

**Outputs**:

```typescript
{
  sharpeRatio: number;              // (Rp - Rf) / StdDev
  sortinoRatio: number;             // (Rp - Rf) / DownsideStdDev
  informationRatio?: number;        // (Rp - Rb) / TrackingError (if benchmark provided)
  maxDrawdown: number;
  calmarRatio: number;              // AnnualReturn / MaxDrawdown
  volatility: number;               // Annualized std dev
  verdict: string;                  // "Excellent risk-adjusted returns" etc.
}
```

**Implementation notes**: India's risk-free rate is the RBI repo rate (~6.5%).
For Sharpe, annualize daily returns by multiplying by sqrt(252) trading days.
Sortino only penalizes downside volatility, which is more relevant for retail
investors who feel losses more than gains.

### 6. `compute_rebalancing`

**Category**: `computation`

**Purpose**: Compare current portfolio allocation to target and suggest trades.

**Inputs**:

```
holdings: Array<{ symbol, currentValue, sector }>
targetAllocation: Record<string, number>  // sector -> target percentage
totalPortfolioValue: number
```

**Outputs**:

```typescript
{
  currentAllocation: Record<string, number>;
  targetAllocation: Record<string, number>;
  drift: Record<string, number>; // Difference per sector
  suggestedTrades: Array<{
    action: "BUY" | "SELL";
    sector: string;
    amount: number; // INR
    reason: string;
  }>;
  rebalanceUrgency: "low" | "moderate" | "high";
}
```

---

## New Research Skill: `portfolio-risk-analysis`

This skill composes the new tools into a complete risk assessment:

```typescript
export const portfolioRiskSkill: ResearchSkill = {
  name: "portfolio-risk-analysis",
  description:
    "Deep portfolio risk analysis with VaR, correlation, and drawdown metrics",
  triggers: [
    /\bportfolio\s*(risk|var|drawdown|sharpe|volatility)\b/i,
    /\b(risk\s*analysis|risk\s*metrics|risk\s*assessment)\b/i,
    /\bhow\s*(risky|diversified|concentrated)\s*(is\s*)?(my\s*)?portfolio\b/i,
  ],
  requiredParams: ["holdings"],
  optionalParams: ["riskFreeRate", "targetAllocation"],
};
```

**Execution plan structure**:

```
1. fetch_stock_price (all holdings)          - no deps
2. fetch_price_history (each holding, 1Y)    - no deps
3. compute_portfolio_concentration           - depends on [1]
4. compute_correlation_matrix                - depends on [2]
5. compute_var                               - depends on [1, 2]
6. compute_drawdown                          - depends on [2]
7. compute_risk_adjusted_returns             - depends on [2]
8. synthesize_report (risk-focused)          - depends on [3-7]
```

---

## Frontend Integration

### Risk Dashboard Component

Add to `apps/web/app/analysis/` or `apps/web/app/dashboard/`:

**Key visualizations**:

- Pie chart: Sector allocation with concentration warning badges
- Heatmap: Correlation matrix (red = high correlation, green = low)
- Gauge: VaR as percentage of portfolio (green/yellow/red zones)
- Line chart: Drawdown periods overlaid on portfolio value
- Bar chart: Risk-adjusted metrics vs benchmark (Nifty 50)

### Report Extension

Extend the `StructuredReport` type to include a `riskMetrics` section:

```typescript
interface RiskMetrics {
  concentrationScore: number;
  diversificationScore: number;
  var95: number;
  sharpeRatio: number;
  maxDrawdown: number;
  overallRiskRating: "conservative" | "moderate" | "aggressive";
}
```

---

## Indian Market Specifics

- **Risk-free rate**: Use RBI repo rate (currently ~6.5%), not US Treasury
- **Trading days**: 252 per year (NSE calendar)
- **Currency**: All values in INR, display with Indian number formatting
  (1,00,000 = 1 lakh)
- **Benchmark**: Nifty 50 (^NSEI) for large-cap, Nifty Midcap 150 for mid-cap
  portfolios
- **Sector classification**: Follow NSE sector taxonomy (IT, Banking, Pharma,
  FMCG, Auto, etc.)
- **FII/DII flows**: Consider adding institutional flow data as a risk signal

---

## Testing Strategy

Each computation tool should have tests covering:

1. **Normal case** - Typical portfolio with 10-15 stocks
2. **Edge cases** - Single stock portfolio, empty portfolio, extreme values
3. **Indian market data** - Use real NSE data snapshots for realistic testing
4. **Numerical precision** - Financial calculations must be deterministic

Test files go in `packages/research/__tests__/tools/`. Follow `node:test` +
`node:assert/strict` pattern. Update `TEST-COVERAGE.md` after adding tests.
