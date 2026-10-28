---
name: usemoney-research-dev
description:
  "Developer toolkit for extending UseMoney's StockSage research agent. Use this
  skill whenever you need to add new research tools, create research skills,
  debug the agent pipeline, or extend the financial analysis capabilities.
  Trigger on: 'add research tool', 'new analysis skill', 'extend agent', 'add
  tool to research', 'debug research pipeline', 'new computation tool', 'new
  data source', or any request to modify packages/research/."
---

# UseMoney Research Agent Developer Toolkit

Build, extend, and debug UseMoney's autonomous StockSage research agent. This
skill knows the exact interfaces, patterns, and conventions so you can ship new
capabilities without breaking the pipeline.

## Architecture Overview

The research agent lives in `packages/research/src/` and follows a **5-stage
pipeline**:

```
Planning → Execution → Validation → Refinement → Synthesis
```

Three building blocks make up all capabilities:

| Layer      | Interface         | Location                         |
| ---------- | ----------------- | -------------------------------- |
| **Tools**  | `ResearchToolDef` | `packages/research/src/tools/`   |
| **Skills** | `ResearchSkill`   | `packages/research/src/skills/`  |
| **Agent**  | Orchestrator      | `packages/research/src/agent.ts` |

Tools are atomic operations (fetch data, compute metrics). Skills compose tools
into execution plans. The agent orchestrates plan execution with dependency
resolution and parallel processing.

---

## Adding a New Research Tool

Every tool implements `ResearchToolDef` from
`packages/research/src/tools/types.ts`:

```typescript
interface ResearchToolDef {
  name: string; // snake_case, e.g. "compute_sharpe_ratio"
  description: string; // What the tool does
  category: "data" | "computation" | "synthesis";
  parameters: Record<
    string,
    {
      type: string;
      description: string;
      required?: boolean;
      default?: unknown;
    }
  >;
  execute: (params: Record<string, unknown>) => Promise<ToolOutput>;
  cacheTTL?: number; // Optional cache in seconds
}
```

### Step-by-step: Create a tool

1. **Create the file** at `packages/research/src/tools/<tool-name>.ts`
2. **Implement the interface** - follow existing patterns (see `compute-dcf.ts`
   for computation, `fetch-key-ratios.ts` for data)
3. **Register it** in `packages/research/src/tools/registry.ts`:
   - Import at top
   - Add `this.register(yourNewTool)` in the appropriate section
4. **Export** from `packages/research/src/tools/index.ts`

### Naming conventions

- **Data tools**: `fetch_<thing>` - e.g., `fetch_dividend_history`
- **Computation tools**: `compute_<metric>` - e.g., `compute_sharpe_ratio`
- **Synthesis tools**: `synthesize_<output>` or `generate_<output>`

### Tool categories explained

- `"data"` - External API calls. These run first, in parallel. Set `cacheTTL`
  for API responses (300s typical).
- `"computation"` - Pure calculations from data tool outputs. These depend on
  data tasks completing first.
- `"synthesis"` - LLM-powered generation (reports, summaries). These run last,
  after all dependencies resolve.

### Error handling pattern

Always return `ToolOutput`:

```typescript
// Success
return { success: true, data: result };

// Failure (the pipeline handles this gracefully)
return { success: false, error: "Clear error message" };

// With metadata
return {
  success: true,
  data: result,
  metadata: { source: "nse", cached: false },
};
```

### Data source integration

For tools that fetch external data, use existing data source clients:

- **NSE data**: `packages/research/src/data-sources/nse-client.ts`
- **News**: `packages/research/src/data-sources/news-client.ts`
- **Symbol resolution**: `packages/research/src/data-sources/symbol-resolver.ts`

The symbol resolver normalizes tickers: `RELIANCE` → `RELIANCE.NS`. Always use
it for user-provided symbols.

---

## Adding a New Research Skill

Skills implement `ResearchSkill` from `packages/research/src/skills/types.ts`:

```typescript
interface ResearchSkill {
  name: string;
  description: string;
  triggers: RegExp[]; // Regex patterns to match user queries
  requiredParams: string[]; // e.g., ["symbol"] or ["holdings"]
  optionalParams?: string[];
  buildPlan: (params: Record<string, unknown>) => ResearchPlan;
}
```

### Step-by-step: Create a skill

1. **Create the file** at `packages/research/src/skills/<skill-name>.ts`
2. **Define trigger patterns** - multiple regexes that match user intent. Be
   generous with triggers to avoid under-matching.
3. **Build the execution plan** - compose `fetchTask()`, `computeTask()`, and
   `synthesisTask()` with dependency chains
4. **Register** in `packages/research/src/skills/index.ts`

### Task helpers

Use the helpers from `packages/research/src/skills/types.ts`:

```typescript
fetchTask(id, toolName, params, dependsOn?)     // Data fetching
computeTask(id, toolName, params, dependsOn)    // Computation (requires deps)
synthesisTask(id, toolName, params, dependsOn)  // Synthesis (requires deps)
```

### Dependency graph rules

- Data tasks can run independently (no deps) - they execute in parallel
- Computation tasks depend on data tasks
- Synthesis tasks depend on everything they need to generate from
- The executor resolves the DAG and runs up to 3 tasks concurrently

### Example: Adding a "Dividend Analysis" skill

```typescript
export const dividendAnalysisSkill: ResearchSkill = {
  name: "dividend-analysis",
  description: "Analyze dividend history, yield, and sustainability",
  triggers: [
    /\b(dividend|yield|payout)\s*(analysis|history|track)\b/i,
    /\b(dividend|income)\s*(stock|invest)\b/i,
  ],
  requiredParams: ["symbol"],
  buildPlan: (params): ResearchPlan => {
    const symbol = resolveSymbol(params.symbol as string, "NSE");
    const tasks = [
      fetchTask("profile", "fetch_company_profile", { symbol }),
      fetchTask("financials", "fetch_income_statement", { symbol }),
      fetchTask("dividends", "fetch_corporate_actions", { symbol }),
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),
      computeTask("health", "compute_health_score", {}, ["financials"]),
      synthesisTask(
        "report",
        "synthesize_report",
        { query: `Dividend analysis of ${params.symbol}` },
        ["profile", "financials", "dividends", "price", "health"],
      ),
    ];
    return {
      query: `Dividend analysis of ${params.symbol}`,
      skill: "dividend-analysis",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "moderate",
    };
  },
};
```

---

## Debugging the Pipeline

### Common issues

1. **Tool not found** - Check registry registration and exact tool name
   (snake_case)
2. **Dependency deadlock** - Circular deps cause timeout. The executor detects
   this and logs it.
3. **Synthesis timeout** - Synthesis tasks get 4x timeout (min 120s). If still
   failing, reduce context passed.
4. **Symbol resolution** - Use `resolveSymbol()`. Raw symbols without
   `.NS`/`.BO` suffix cause API failures.

### Testing a tool in isolation

```typescript
import { computeDcfTool } from "../tools/compute-dcf";

const result = await computeDcfTool.execute({
  currentPrice: 2500,
  freeCashFlow: 50000000000,
  sharesOutstanding: 6700000000,
  growthRate: 0.12,
});
```

### Testing a skill plan

```typescript
import { stockAnalysisSkill } from "../skills/stock-analysis";

const plan = stockAnalysisSkill.buildPlan({ symbol: "RELIANCE" });
console.log(
  plan.tasks.map((t) => `${t.id} → ${t.tool} [deps: ${t.dependsOn}]`),
);
```

### Agent configs

Defined in `packages/research/src/types.ts`:

- `FAST_AGENT_CONFIG`: 2 min timeout, skip validation, 1 iteration
- `DEFAULT_AGENT_CONFIG`: 3 min, 2 iterations, quality threshold 0.7
- `ADVANCED_AGENT_CONFIG`: 5 min, 2 iterations, quality threshold 0.75

---

## Key Files Reference

| File                                      | Purpose                                    |
| ----------------------------------------- | ------------------------------------------ |
| `packages/research/src/agent.ts`          | Main orchestrator                          |
| `packages/research/src/executor.ts`       | Task execution engine                      |
| `packages/research/src/planner.ts`        | Skill matching + plan building             |
| `packages/research/src/tools/registry.ts` | Tool registry (add new tools here)         |
| `packages/research/src/tools/types.ts`    | `ResearchToolDef`, `ToolOutput` interfaces |
| `packages/research/src/skills/types.ts`   | `ResearchSkill` interface + task helpers   |
| `packages/research/src/skills/index.ts`   | Skill registration                         |
| `packages/research/src/types.ts`          | Core types, agent configs, `ResearchPlan`  |
| `packages/research/src/data-sources/`     | External data clients                      |
| `apps/web/lib/actions/research.ts`        | Server actions (start, status, results)    |

---

## Checklist for New Capabilities

- [ ] Tool or skill file created with proper interface
- [ ] Registered in registry/index
- [ ] Exported from package index
- [ ] Tests added following `node:test` + `node:assert/strict` pattern
- [ ] TEST-COVERAGE.md updated
- [ ] No `any` types (use `unknown`)
- [ ] Error handling returns `ToolOutput` with clear messages
- [ ] Symbol resolution for user-facing tools
- [ ] Cache TTL set for external API calls
