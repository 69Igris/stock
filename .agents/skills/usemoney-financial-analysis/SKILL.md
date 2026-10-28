---
name: usemoney-financial-analysis
description:
  "End-user financial analysis commands for UseMoney, inspired by Anthropic's
  Cowork Finance plugin. Use this skill when adding user-facing analysis slash
  commands, building the financial analysis UI, creating interactive analysis
  workflows, or extending the StockSage AI chat. Trigger on: 'add analysis
  command', 'financial analysis UI', 'analysis workflow', 'stock comparison
  page', 'screening interface', 'watchlist analysis', or any work on the
  /analysis routes."
---

# UseMoney Financial Analysis - User-Facing Commands & Workflows

Build end-user financial analysis features for UseMoney, following patterns from
Anthropic's Cowork Finance plugin. This skill covers slash commands, interactive
analysis workflows, and the frontend experience that ties into UseMoney's
existing StockSage research agent.

## Design Philosophy

Anthropic's Finance plugin succeeds because each command maps to a specific
workflow with clear inputs and outputs. UseMoney's analysis commands follow the
same principle:

- **One command = one workflow** - `/analyze TCS` does a complete stock analysis
- **Smart defaults** - Indian market defaults (NSE exchange, INR currency, Nifty
  50 benchmark)
- **Progressive disclosure** - Show summary first, let users drill into details
- **Always actionable** - Every analysis ends with a clear recommendation or
  next step

---

## Slash Commands

These are the user-facing entry points that trigger research sessions through
the StockSage agent.

### `/analyze <SYMBOL>`

**Triggers**: "Analyze RELIANCE", "Research TCS", "Should I buy HDFC Bank?"

**Flow**:

1. Resolve symbol via `symbol-resolver`
2. Start `stock-analysis` skill via `startResearchAction()`
3. Show real-time progress (planning, researching, validating, completed)
4. Render `ResearchReport` with score, recommendation, key metrics

**Already implemented** at `apps/web/app/analysis/`. Enhancements to build:

- Auto-suggest symbols as user types (debounced NSE symbol search)
- Quick-action buttons: "Compare with peers", "DCF deep dive", "Add to
  watchlist"
- Share analysis as public link

### `/compare <SYMBOL1> vs <SYMBOL2> [vs SYMBOL3]`

**Triggers**: "Compare TCS vs INFY", "TCS or WIPRO which is better?"

**Flow**:

1. Parse multiple symbols (support "vs", "or", comma-separated)
2. Start `peer-comparison` skill
3. Render side-by-side comparison table

**Frontend component**: Build a `ComparisonTable` showing key metrics per stock,
color-coded (green = best in row, red = worst).

### `/screen [criteria]`

**Triggers**: "Find undervalued IT stocks", "Screen for high dividend yield"

**Screening criteria to support**:

- P/E ratio, Market cap, Sector filter, ROE minimum
- Dividend yield minimum, Revenue growth, Debt-to-equity maximum

**UX pattern**: Filter panel with sliders/dropdowns alongside results table.
Each row links to `/analyze <symbol>`.

### `/dcf <SYMBOL>`

**Triggers**: "DCF valuation for RELIANCE", "Intrinsic value of TCS"

**Key UX**: Let users tweak growth rate, discount rate, and projection years
with sliders, and see the intrinsic value update in real-time. Educational and
empowering.

### `/portfolio-risk`

**Triggers**: "How risky is my portfolio?", "Portfolio risk analysis"

**Flow**: Fetch holdings from broker connections, start
`portfolio-risk-analysis` skill, render risk dashboard. See
`usemoney-portfolio-risk` skill for the tools.

### `/tax-report [FY]`

**Triggers**: "Capital gains for FY 2025-26", "My tax report"

**Flow**: Fetch paired trades for the financial year, start `tax-analysis`
skill, render tax summary with ITR export. See `usemoney-tax-india` skill for
the tools.

### `/sector <SECTOR>`

**Triggers**: "Analyze IT sector", "Banking sector overview"

**Flow**: Start `sector-analysis` skill, render sector heatmap with top
performers.

---

## AI Chat Integration (StockSage)

The analysis page already has an AI chat sidebar. Extensions to build:

### Context-Aware Follow-ups

After analysis completes, the chat should understand full context:

- User asks "Why not a BUY?" - chat references specific metrics
- User asks "What if growth improves to 15%?" - chat recalculates DCF
- User asks "Compare it with ONGC" - chat triggers peer-comparison skill

### Proactive Insights

After analysis, surface relevant observations:

- Upcoming earnings dates
- Correlation with existing holdings
- Margin of safety warnings

### Inline Chat Commands

Within the chat, support quick lookups:

- `@price SYMBOL` - Quick price lookup
- `@ratio SYMBOL PE` - Fetch a specific ratio
- `@compare SYMBOL1 SYMBOL2` - Quick comparison

---

## Frontend Architecture

### Route Structure

```
apps/web/app/
├── analysis/
│   ├── page.tsx              # Search + history (existing)
│   ├── [sessionId]/page.tsx  # Analysis result (existing)
│   ├── compare/page.tsx      # Side-by-side comparison (new)
│   ├── screen/page.tsx       # Stock screener (new)
│   └── sector/[sector]/page.tsx  # Sector analysis (new)
├── tax/page.tsx              # Tax report (new)
└── risk/page.tsx             # Portfolio risk dashboard (new)
```

### Shared Components to Build

1. **`StockCard`** - Compact stock info card (name, price, change, score badge)
2. **`MetricsGrid`** - Flexible grid of key-value metrics with verdict colors
3. **`ComparisonTable`** - Multi-stock side-by-side with best/worst highlighting
4. **`ScreenerFilters`** - Filter panel with range sliders and select dropdowns
5. **`RiskGauge`** - Circular gauge for risk scores (0-100)
6. **`TaxSummaryCard`** - STCG/LTCG/Total with color coding

### Design System

Follow existing UseMoney patterns:

- **Colors**: Green for positive, Red for negative, Amber for neutral
- **Number format**: Indian notation via `Intl.NumberFormat('en-IN')`
- **Charts**: Use existing charting library
- **Mobile**: All new pages must be responsive

---

## Server Actions Pattern

All analysis triggers go through server actions in
`apps/web/lib/actions/research.ts`:

```typescript
export async function startResearchAction(
  query: string,
  skill?: string,
  symbols?: string[],
  mode?: "fast" | "advanced",
) {
  // 1. Auth check (Clerk)
  // 2. Create ResearchSession in DB
  // 3. Publish to Cloud Pub/Sub for async processing
  // 4. Return sessionId for polling
}
```

New commands should use `startResearchAction()` to trigger,
`getResearchStatusAction()` to poll, and `getResearchResultAction()` to fetch
results.

---

## Subscription Gating

| Command           | FREE          | PREMIUM     | PRO                 |
| ----------------- | ------------- | ----------- | ------------------- |
| `/analyze`        | 3/month       | Unlimited   | Unlimited           |
| `/compare`        | 1/month       | Unlimited   | Unlimited           |
| `/screen`         | Basic filters | All filters | All + custom        |
| `/dcf`            | View only     | Interactive | Interactive + save  |
| `/portfolio-risk` | N/A           | Basic       | Full suite          |
| `/tax-report`     | N/A           | Current FY  | Multi-year + export |

Check subscription in server actions before starting research sessions using the
existing subscription check pattern from `packages/core/`.

---

## Performance Considerations

- **Prefetch**: When user visits `/analysis`, prefetch recent sessions from
  cache
- **Streaming**: Use SSE for real-time progress (already implemented)
- **Caching**: Research results cache in Redis (5min TTL)
- **Parallel fetching**: Agent handles this - up to 3 concurrent API calls
- **Bundle size**: Lazy-load chart libraries and heavy components
