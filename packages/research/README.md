# @usemoney/research

> StockSage - Autonomous AI research agent for Indian stock market analysis

## Overview

Multi-skill research agent that plans, executes, validates, and refines stock
research using 45+ computation tools, 9 specialized skills, and NSE data
sources. Powered by Google Gemini.

## Architecture

```
Query → Planner → Executor → Validator → Refiner (loop)
                     ↓
              Tool Registry (45+ tools)
                     ↓
              NSE Client / News / Symbol Resolver
```

## Skills (9)

| Skill                     | Description                        |
| ------------------------- | ---------------------------------- |
| `stock-analysis`          | Single stock deep-dive             |
| `peer-comparison`         | Peer company benchmarking          |
| `dcf-valuation`           | Discounted cash flow valuations    |
| `sector-analysis`         | Sector-wide trends & metrics       |
| `stock-screener`          | Multi-symbol screening             |
| `portfolio-analysis`      | Portfolio composition & allocation |
| `portfolio-risk-analysis` | Risk metrics & concentration       |
| `tax-analysis`            | Capital gains & tax planning       |
| `strategy-analysis`       | Trading strategy evaluation        |

## Tools (45+)

- **Data Fetch** (13): Stock prices, company profiles, financials, earnings,
  analyst recommendations, news, shareholding
- **Computation** (24): DCF, VaR, drawdown, correlation, WACC, technical
  analysis, tax calculations, health scores, growth metrics
- **Synthesis** (8): Stock screening, report generation, ITR schedules

## Modes

| Mode       | Iterations | Quality Threshold | Timeout |
| ---------- | ---------- | ----------------- | ------- |
| `DEFAULT`  | 2          | 0.70              | 180s    |
| `FAST`     | 1          | 0.60              | 120s    |
| `ADVANCED` | 2          | 0.75              | 480s    |

## Usage

```typescript
import { ResearchAgent, getConfigForMode } from "@usemoney/research";

const agent = new ResearchAgent(getConfigForMode("DEFAULT"));
const result = await agent.execute({
  query: "Analyze TCS stock",
  skill: "stock-analysis",
  symbols: ["TCS"],
});
```

## Exports

- `ResearchAgent`, `ResearchPlanner`, `ResearchExecutor`, `ResearchValidator`,
  `LoopController`, `Scratchpad`
- `ResearchToolRegistry`
- `getSkill()`, `getAllSkills()`, `matchSkill()`
- `NseClient`, `fetchNews`, `resolveSymbol`
- `DEFAULT_AGENT_CONFIG`, `FAST_AGENT_CONFIG`, `ADVANCED_AGENT_CONFIG`,
  `getConfigForMode()`
- 70+ type exports

## Documentation

See **CLAUDE.md** for technical details.
