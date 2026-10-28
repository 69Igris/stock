# @usemoney/roast

> Portfolio roast analysis engine for UseMoney

AI-powered portfolio analysis that scores, critiques, and provides actionable
advice. Uses a 6-step pipeline with Google Gemini.

## Pipeline

```
1. Fetch Portfolio → 2. Analyze Stocks → 3. Analyze MF
       → 4. Generate Scores → 5. Generate Roast → 6. Assemble Result
```

| Step              | Description                                       | LLM |
| ----------------- | ------------------------------------------------- | --- |
| `fetch-portfolio` | Fetch holdings + mutual funds from Prisma         | No  |
| `analyze-stocks`  | Diversification, sector concentration, risk flags | Yes |
| `analyze-mf`      | Category overlap, performance, expense analysis   | Yes |
| `generate-scores` | Overall score + 4 dimensions (JSON mode)          | Yes |
| `generate-roast`  | Humorous/constructive narrative with highlights   | Yes |
| `assemble-result` | Combine all results, format for storage           | No  |

## Scoring Dimensions

- **Diversification** - Sector spread, stock count, concentration
- **Risk Management** - Position sizing, drawdown exposure
- **Stock Picking** - Quality of individual picks
- **Timing** - Entry/exit decisions

## Usage

```typescript
import { RoastAgent } from "@usemoney/roast";

const agent = new RoastAgent();
const result = await agent.execute({
  userId: "...",
  mode: "overall",
  assetType: "all",
});
```

## Exports

- `RoastAgent`
- Types: `PortfolioData`, `StockAnalysisResult`, `MfAnalysisResult`,
  `ScoresResult`, `RoastContentResult`, `RoastAgentConfig`

## Documentation

See **CLAUDE.md** for technical details.
