/**
 * StockSage Research Executor
 *
 * Runs research tasks in dependency order with parallel execution
 * where possible. Handles timeouts and failures gracefully.
 */

import type { ResearchTask, ResearchAgentConfig } from "./types";
import type { Scratchpad } from "./scratchpad";
import { ResearchToolRegistry } from "./tools/registry";
import { applyDeclarativeBindings } from "./tools/input-bindings";
import {
  sanitizeDependencies,
  findReadyTasks,
  isDeadlocked,
  markPendingDeadlocked,
  taskTimeoutMs,
} from "./lib/task-scheduling";

/**
 * MONEY-802 — pull the first YouTube watch / share URL out of an arbitrary tool
 * result so a discovered link (in news articles, exchange announcements,
 * corporate-action rows, etc.) can flow into `fetch_youtube_transcript`'s `url`
 * param. Pure + never-throw: JSON-stringifies the result and scans for the first
 * `youtube.com/watch?v=…`, `youtu.be/…` or `youtube.com/embed/…` URL.
 *
 * This threads an ALREADY-PRESENT url from upstream data into the transcript
 * fetch. The active-discovery counterpart is `fetch_youtube_candidates` (see
 * `extractCandidateUrl` below + the tool), which actually searches YouTube and
 * emits a candidate list; both feed the same `url` injection.
 */
export function extractYoutubeUrl(result: unknown): string | undefined {
  if (result == null) return undefined;
  let hay: string;
  try {
    hay = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    return undefined;
  }
  if (!hay) return undefined;
  const m = hay.match(
    /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^\s"'<>]*v=|embed\/)|youtu\.be\/)[A-Za-z0-9_-]{11}[^\s"'<>]*/i,
  );
  return m ? m[0] : undefined;
}

/**
 * MONEY-802 (discovery half) — pull the FIRST candidate watch URL out of a
 * completed `fetch_youtube_candidates` result so a discovered video can flow
 * into `fetch_youtube_transcript`'s `url` param (discover → transcribe chain).
 *
 * Reads the structured `{ candidates: [{ url }] }` shape the candidates tool
 * emits, preferring the top-ranked candidate. Pure + never-throw: returns
 * undefined when the result isn't a candidates payload or has no usable url.
 */
export function extractCandidateUrl(result: unknown): string | undefined {
  if (result == null || typeof result !== "object") return undefined;
  const candidates = (result as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return undefined;
  for (const c of candidates) {
    const url = (c as { url?: unknown })?.url;
    if (typeof url === "string" && url.trim()) return url.trim();
  }
  return undefined;
}

export class ResearchExecutor {
  private registry: ResearchToolRegistry;
  private config: ResearchAgentConfig;

  constructor(registry: ResearchToolRegistry, config: ResearchAgentConfig) {
    this.registry = registry;
    this.config = config;
  }

  /**
   * Execute all tasks in dependency order.
   * Returns the updated tasks array with results filled in.
   */
  async execute(
    tasks: ResearchTask[],
    scratchpad: Scratchpad,
    onProgress?: (
      completed: number,
      total: number,
      currentStep: string,
    ) => void,
  ): Promise<ResearchTask[]> {
    const taskMap = new Map<string, ResearchTask>(tasks.map((t) => [t.id, t]));
    const completed = new Set<string>();
    let totalCompleted = 0;

    // Throttle progress updates to avoid DB write conflicts
    // (many tasks complete in rapid succession → concurrent updateSession calls).
    // Coalescing-only: every flush persists the FULL current `plan` (all task
    // results so far), so shortening the window never drops data — it just makes
    // the research-run task cards stream in more smoothly (~per-task / per-layer)
    // instead of appearing in one 2s jump. Kept >0 to avoid write storms when a
    // whole dependency layer of parallel tasks settles together.
    let lastProgressTime = 0;
    const PROGRESS_THROTTLE_MS = 600;
    let pendingProgress: {
      completed: number;
      total: number;
      step: string;
    } | null = null;

    const throttledProgress = (comp: number, total: number, step: string) => {
      if (!onProgress) return;
      const now = Date.now();
      if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
        lastProgressTime = now;
        onProgress(comp, total, step);
        pendingProgress = null;
      } else {
        // Queue the latest progress to flush later
        pendingProgress = { completed: comp, total, step };
      }
    };

    // Sanitize dependsOn: strip references to task IDs that don't exist
    // (can happen when planner generates bad IDs or fast mode filters tasks out)
    sanitizeDependencies(tasks);

    while (completed.size < tasks.length) {
      // Safety: check step limit
      if (scratchpad.getStepCount() >= this.config.maxSteps) {
        console.warn("[executor] Max steps reached, stopping execution");
        break;
      }

      // Find tasks ready to run (all dependencies completed)
      const ready = findReadyTasks(tasks, completed);

      if (ready.length === 0) {
        // No ready tasks: if any remain pending, their deps can never resolve
        // (cycle / dep on a failed task) → deadlock; fail them and stop.
        if (isDeadlocked(tasks, completed)) {
          const pending = markPendingDeadlocked(tasks);
          console.warn(
            "[executor] Deadlock detected - unresolvable dependencies:",
            pending.map((t) => t.id),
          );
        }
        break;
      }

      // Execute ready tasks in parallel (up to max concurrency)
      const batch = ready.slice(0, this.config.maxConcurrency);

      await Promise.allSettled(
        batch.map(async (task) => {
          task.status = "running";
          task.startedAt = new Date().toISOString();

          scratchpad.log(
            "tool_call",
            {
              tool: task.tool,
              params: task.params,
            },
            task.id,
          );

          throttledProgress(
            totalCompleted,
            tasks.length,
            `Running ${task.tool}`,
          );

          try {
            // Resolve dynamic params that reference other task results
            const resolvedParams = this.resolveParams(task, taskMap);

            // Synthesis tasks need much more time (Gemini generates a full report)
            const timeout = taskTimeoutMs(task.type, this.config.stepTimeoutMs);

            const result = await this.executeWithTimeout(
              task.tool,
              resolvedParams,
              timeout,
            );

            task.completedAt = new Date().toISOString();
            task.durationMs =
              new Date(task.completedAt).getTime() -
              new Date(task.startedAt).getTime();

            if (result.success) {
              task.status = "completed";
              task.result = result.data;
              // MONEY-1060 (RC4): carry the tool's metadata (source, stale,
              // sourceError on partial fallbacks) onto the task — previously
              // only result.data survived, so the synthesizer never saw it.
              if (result.metadata !== undefined)
                task.metadata = result.metadata;

              scratchpad.log(
                "tool_result",
                {
                  tool: task.tool,
                  success: true,
                  dataSize: JSON.stringify(result.data).length,
                },
                task.id,
              );
            } else {
              task.status = "failed";
              task.error = result.error;
              // MONEY-1060 (RC4): keep failure metadata (metadata.sourceError
              // = live-source outage) so the synthesizer can report "source
              // temporarily unavailable" instead of "the company lacks data".
              if (result.metadata !== undefined)
                task.metadata = result.metadata;

              scratchpad.log(
                "error",
                {
                  tool: task.tool,
                  error: result.error,
                },
                task.id,
              );
            }
          } catch (error) {
            task.status = "failed";
            task.error = error instanceof Error ? error.message : String(error);
            task.completedAt = new Date().toISOString();

            scratchpad.log(
              "error",
              {
                tool: task.tool,
                error: task.error,
              },
              task.id,
            );
          }

          completed.add(task.id);
          totalCompleted++;

          // B3 fix (MONEY-218-followup): emit a progress delta as
          // each task COMPLETES, not only when a batch starts. The
          // pre-fix code emitted "Running X" at task start but never
          // a "completed/total" delta - so the UI saw 0/17 → 17/17
          // in one jump after the entire batch settled. Per-task
          // emit + the existing throttle (600ms) keeps the UI responsive
          // without DB write storms.
          throttledProgress(
            totalCompleted,
            tasks.length,
            task.status === "completed"
              ? `Completed ${task.tool}`
              : `Failed ${task.tool}`,
          );
        }),
      );
    }

    // Flush any pending throttled progress update
    const pending = pendingProgress as {
      completed: number;
      total: number;
      step: string;
    } | null;
    if (pending && onProgress) {
      onProgress(pending.completed, pending.total, pending.step);
    }
    onProgress?.(totalCompleted, tasks.length, "Execution complete");
    return tasks;
  }

  /**
   * Resolve dynamic parameters that reference results from dependency tasks.
   * For computation/synthesis tasks, inject data from completed dependencies.
   */
  private resolveParams(
    task: ResearchTask,
    taskMap: Map<string, ResearchTask>,
  ): Record<string, unknown> {
    const params = { ...task.params };

    if (task.type === "synthesis" && task.tool === "synthesize_report") {
      // Inject all completed task results
      const tasks = Array.from(taskMap.values());
      params.tasks = tasks;
    }

    if (task.type === "synthesis" && task.tool === "compare_stocks") {
      // Inject all completed task results (same as synthesize_report)
      const allTasks = Array.from(taskMap.values());
      params.tasks = allTasks;

      // Also collect stockData for backward compatibility
      const stockData: Record<string, unknown>[] = [];
      for (const depId of task.dependsOn) {
        const dep = taskMap.get(depId);
        if (dep?.status === "completed" && dep.result) {
          stockData.push({
            taskId: dep.id,
            tool: dep.tool,
            data: dep.result,
          });
        }
      }
      params.stockData = stockData;
    }

    if (task.type === "computation") {
      // Inject dependency results into computation params
      for (const depId of task.dependsOn) {
        const dep = taskMap.get(depId);
        if (dep?.status === "completed" && dep.result) {
          this.injectComputationParams(task, dep, params);
        }
      }
    }

    // ─── MONEY-802: fetch_youtube_transcript — flow a discovered url in ──
    // The transcript fetch needs a `url`. When the planner didn't hard-code one
    // but the task depends on upstream tools, fill an empty `url` from a
    // completed dependency — preferring a `fetch_youtube_candidates` result (the
    // active-discovery chain: its first candidate is the top-ranked hit), then
    // falling back to scanning any other data result (news / announcements /
    // corp actions) for an already-present YouTube link. A planner-supplied url
    // always wins (we only fill an empty `url`).
    if (
      task.tool === "fetch_youtube_transcript" &&
      !(typeof params.url === "string" && params.url.trim())
    ) {
      // Pass 1: prefer the discovery tool's first candidate.
      for (const depId of task.dependsOn) {
        const dep = taskMap.get(depId);
        if (
          dep?.tool === "fetch_youtube_candidates" &&
          dep.status === "completed" &&
          dep.result != null
        ) {
          const url = extractCandidateUrl(dep.result);
          if (url) {
            params.url = url;
            break;
          }
        }
      }
      // Pass 2: fall back to any upstream result that embeds a YouTube link.
      if (!(typeof params.url === "string" && params.url.trim())) {
        for (const depId of task.dependsOn) {
          const dep = taskMap.get(depId);
          if (dep?.status === "completed" && dep.result != null) {
            const url = extractYoutubeUrl(dep.result);
            if (url) {
              params.url = url;
              break;
            }
          }
        }
      }
    }

    return params;
  }

  /**
   * Inject data from completed dependency tasks into computation task params.
   */
  private injectComputationParams(
    task: ResearchTask,
    dep: ResearchTask,
    params: Record<string, unknown>,
  ): void {
    const result = dep.result as Record<string, unknown>;

    if (task.tool === "compute_dcf") {
      if (dep.tool === "fetch_cash_flow") {
        const annual = (result as Record<string, unknown>).annual as
          | Array<Record<string, unknown>>
          | undefined;
        if (annual?.length) {
          const latest = annual[annual.length - 1]!;
          params.freeCashFlow = params.freeCashFlow || latest.freeCashFlow;
          // Also expose OCF + capex so compute_dcf can reconstruct FCF when
          // the canonical `freeCashFlow` field is missing (Tickertape
          // sometimes omits it for shorter histories).
          params.operatingCashFlow =
            params.operatingCashFlow || latest.operatingCashFlow;
          params.capitalExpenditure =
            params.capitalExpenditure || latest.capitalExpenditure;
        }
      }
      if (dep.tool === "fetch_income_statement") {
        const annual = (result as Record<string, unknown>).annual as
          | Array<Record<string, unknown>>
          | undefined;
        if (annual?.length) {
          // netIncome is the third-tier fallback inside compute_dcf when
          // neither FCF nor OCF/capex are available.
          params.netIncome =
            params.netIncome || annual[annual.length - 1]!.netIncome;
        }
      }
      if (dep.tool === "fetch_stock_price") {
        const prices = result as Record<string, Record<string, unknown>>;
        const firstKey = Object.keys(prices)[0];
        if (firstKey) {
          params.currentPrice = params.currentPrice || prices[firstKey]!.price;
          // marketCap lets compute_dcf derive sharesOutstanding =
          // marketCap / currentPrice instead of falling back to a fake
          // 1B-share placeholder that produces a meaningless intrinsic value.
          params.marketCap = params.marketCap || prices[firstKey]!.marketCap;
        }
      }
      if (dep.tool === "fetch_key_ratios") {
        const ratios = result as Record<string, unknown>;
        // Try the explicit shares field if Tickertape / Yahoo provided it.
        params.sharesOutstanding =
          params.sharesOutstanding ||
          ratios.sharesOutstanding ||
          ratios.totalShares;
      }
    }

    if (task.tool === "compute_health_score") {
      if (dep.tool === "fetch_key_ratios") {
        const ratios = result as Record<string, unknown>;
        params.roe = params.roe || ratios.roe;
        params.roa = params.roa || ratios.roa;
        params.operatingMargin =
          params.operatingMargin || ratios.operatingMargin;
        params.netMargin = params.netMargin || ratios.netMargin;
        params.debtToEquity = params.debtToEquity || ratios.debtToEquity;
        params.currentRatio = params.currentRatio || ratios.currentRatio;
        params.revenueGrowth = params.revenueGrowth || ratios.revenueGrowth;
        params.earningsGrowth = params.earningsGrowth || ratios.earningsGrowth;
      }
    }

    if (task.tool === "compute_growth_metrics") {
      if (dep.tool === "fetch_income_statement") {
        const data = result as Record<string, unknown>;
        params.statements = params.statements || data.annual;
      }
    }

    if (task.tool === "compute_comparative_valuation") {
      if (dep.tool === "fetch_key_ratios") {
        const ratios = result as Record<string, unknown>;
        params.pe = params.pe || ratios.pe;
        params.pb = params.pb || ratios.pb;
        params.evToEbitda = params.evToEbitda || ratios.evToEbitda;
      }
      if (dep.tool === "fetch_peer_companies") {
        params.peers = params.peers || result;
      }
      if (dep.tool === "fetch_stock_price") {
        const prices = result as Record<string, Record<string, unknown>>;
        const firstKey = Object.keys(prices)[0];
        if (firstKey) {
          params.currentPrice = params.currentPrice || prices[firstKey]!.price;
          params.symbol = params.symbol || firstKey;
        }
      }
    }

    // ─── WACC ──────────────────────────────────────────────────
    if (task.tool === "compute_wacc") {
      if (dep.tool === "fetch_key_ratios") {
        const ratios = result as Record<string, unknown>;
        params.beta = params.beta || ratios.beta || 1.0;
      }
      if (dep.tool === "fetch_stock_price") {
        const prices = result as Record<string, Record<string, unknown>>;
        const firstKey = Object.keys(prices)[0];
        if (firstKey) {
          params.marketCap = params.marketCap || prices[firstKey]!.marketCap;
        }
      }
    }

    // ─── DCF - wire WACC ──────────────────────────────────────
    if (task.tool === "compute_dcf" && dep.tool === "compute_wacc") {
      const wacc = result as Record<string, unknown>;
      params.wacc = params.wacc || wacc.wacc;
    }

    // ─── Cash Flow Quality ────────────────────────────────────
    if (task.tool === "compute_cash_flow_quality") {
      if (dep.tool === "fetch_cash_flow") {
        const cfData = result as Record<string, unknown>;
        const annual = cfData.annual as
          | Array<Record<string, unknown>>
          | undefined;
        if (annual?.length) {
          const latest = annual[annual.length - 1]!;
          params.operatingCashFlow =
            params.operatingCashFlow || latest.operatingCashFlow;
          params.capitalExpenditure =
            params.capitalExpenditure || latest.capitalExpenditure;
          params.freeCashFlow = params.freeCashFlow || latest.freeCashFlow;
          params.historicalOCF =
            params.historicalOCF ||
            annual.map((a) => a.operatingCashFlow).filter(Boolean);
        }
      }
      if (dep.tool === "fetch_income_statement") {
        const isData = result as Record<string, unknown>;
        const annual = isData.annual as
          | Array<Record<string, unknown>>
          | undefined;
        if (annual?.length) {
          const latest = annual[annual.length - 1]!;
          params.netIncome = params.netIncome || latest.netIncome;
          params.revenue = params.revenue || latest.revenue;
        }
      }
      if (dep.tool === "fetch_stock_price") {
        const prices = result as Record<string, Record<string, unknown>>;
        const firstKey = Object.keys(prices)[0];
        if (firstKey) {
          params.marketCap = params.marketCap || prices[firstKey]!.marketCap;
        }
      }
    }

    // ─── Earnings Quality ─────────────────────────────────────
    if (task.tool === "compute_earnings_quality") {
      if (dep.tool === "fetch_income_statement") {
        const isData = result as Record<string, unknown>;
        const annual = isData.annual as
          | Array<Record<string, unknown>>
          | undefined;
        if (annual?.length) {
          const latest = annual[annual.length - 1]!;
          params.netIncome = params.netIncome || latest.netIncome;
          params.operatingIncome =
            params.operatingIncome || latest.operatingIncome;
          params.revenue = params.revenue || latest.revenue;
        }
      }
      if (dep.tool === "fetch_cash_flow") {
        const cfData = result as Record<string, unknown>;
        const annual = cfData.annual as
          | Array<Record<string, unknown>>
          | undefined;
        if (annual?.length) {
          params.operatingCashFlow =
            params.operatingCashFlow ||
            annual[annual.length - 1]!.operatingCashFlow;
        }
      }
      if (dep.tool === "fetch_balance_sheet") {
        const bsData = result as Record<string, unknown>;
        const annual = bsData.annual as
          | Array<Record<string, unknown>>
          | undefined;
        if (annual?.length) {
          params.totalAssets =
            params.totalAssets || annual[annual.length - 1]!.totalAssets;
        }
      }
    }

    // ─── Technical Analysis ───────────────────────────────────
    if (task.tool === "compute_technical_analysis") {
      if (dep.tool === "fetch_price_history") {
        const history = result as
          | Array<Record<string, unknown>>
          | Record<string, unknown>;
        const dataArray = Array.isArray(history)
          ? history
          : (history as Record<string, unknown>).prices
            ? ((history as Record<string, unknown>).prices as Array<
                Record<string, unknown>
              >)
            : [];
        if (dataArray.length) {
          // Map the full OHLCV payload so the tool's "advanced" branch can
          // run - without highs/lows we lose ADX, ATR, Stochastic, CCI,
          // Williams %R, PSAR, Ichimoku, Pivots, Supertrend, NR; without
          // volumes we lose OBV, VWAP, MFI. Each indicator silently
          // no-ops when its required series is missing, so the previous
          // close-only injection meant the tool only ever returned RSI +
          // MACD + SMAs even though the price-history payload had the
          // bars all along.
          const closes = dataArray
            .map((p) => p.close as number)
            .filter((v) => typeof v === "number" && Number.isFinite(v));
          params.prices = params.prices || closes;

          if (!params.highs) {
            const highs = dataArray
              .map((p) => p.high as number)
              .filter((v) => typeof v === "number" && Number.isFinite(v));
            if (highs.length === closes.length) params.highs = highs;
          }
          if (!params.lows) {
            const lows = dataArray
              .map((p) => p.low as number)
              .filter((v) => typeof v === "number" && Number.isFinite(v));
            if (lows.length === closes.length) params.lows = lows;
          }
          if (!params.volumes) {
            const volumes = dataArray
              .map((p) => p.volume as number)
              .filter((v) => typeof v === "number" && Number.isFinite(v));
            if (volumes.length === closes.length) params.volumes = volumes;
          }
        }
      }
    }

    // ─── Dividend Analysis ────────────────────────────────────
    if (task.tool === "compute_dividend_analysis") {
      if (dep.tool === "fetch_key_ratios") {
        const ratios = result as Record<string, unknown>;
        params.dividendYield = params.dividendYield || ratios.dividendYield;
      }
      if (dep.tool === "fetch_stock_price") {
        const prices = result as Record<string, Record<string, unknown>>;
        const firstKey = Object.keys(prices)[0];
        if (firstKey) {
          params.currentPrice = params.currentPrice || prices[firstKey]!.price;
        }
      }
    }

    // ─── Scenario Analysis ────────────────────────────────────
    if (task.tool === "compute_scenario_analysis") {
      if (dep.tool === "compute_dcf") {
        params.dcfResult = params.dcfResult || result;
      }
      if (dep.tool === "compute_wacc") {
        params.waccResult = params.waccResult || result;
      }
      if (dep.tool === "fetch_stock_price") {
        const prices = result as Record<string, Record<string, unknown>>;
        const firstKey = Object.keys(prices)[0];
        if (firstKey) {
          params.currentPrice = params.currentPrice || prices[firstKey]!.price;
        }
      }
    }

    // ─── Health Score - inject sector from profile ─────────────
    if (task.tool === "compute_health_score") {
      if (dep.tool === "fetch_company_profile") {
        const profile = result as Record<string, unknown>;
        params.sector = params.sector || profile.sector || profile.industry;
      }
    }

    // ─── Correlation Matrix ───────────────────────────────────
    if (task.tool === "compute_correlation_matrix") {
      if (dep.tool === "fetch_price_history") {
        // Accumulate price histories from multiple fetch_price_history tasks
        const existing =
          (params.priceHistories as Record<string, unknown>) || {};
        const symbol = dep.params?.symbol as string;
        if (symbol) {
          existing[symbol] = result;
          params.priceHistories = existing;
        }
      }
    }

    // ─── VaR - needs portfolio returns ────────────────────────
    if (task.tool === "compute_var") {
      // Portfolio returns and value injected by server action
    }

    // ─── Drawdown - needs value series ────────────────────────
    if (task.tool === "compute_drawdown") {
      // Value series injected by server action
    }

    // ─── Risk-Adjusted Returns - needs drawdown ───────────────
    if (task.tool === "compute_risk_adjusted_returns") {
      if (dep.tool === "compute_drawdown") {
        const dd = result as Record<string, unknown>;
        params.maxDrawdown = params.maxDrawdown || dd.maxDrawdown;
      }
    }

    // ─── Tax tools - data injected by server actions ──────────
    if (task.tool === "compute_tax_harvesting") {
      if (dep.tool === "compute_capital_gains_tax") {
        const cg = result as Record<string, unknown>;
        params.realizedGains = params.realizedGains || cg.totalTax;
      }
    }
    if (task.tool === "compute_advance_tax") {
      if (dep.tool === "compute_capital_gains_tax") {
        const cg = result as Record<string, unknown>;
        params.totalEstimatedTax = params.totalEstimatedTax || cg.totalTax;
      }
    }
    if (task.tool === "generate_itr_schedule") {
      if (dep.tool === "compute_capital_gains_tax") {
        params.capitalGains = params.capitalGains || result;
      }
    }

    // ─── MONEY-550: holdings overlap — accumulate each fund's holdings ──
    // compute_holdings_overlap depends on N fetch_mf_holdings tasks; build the
    // `funds` array (one entry per fund) the tool decomposes into common/
    // distinct. Accumulation can't be expressed declaratively (one entry per
    // dep), so it lives here like compute_correlation_matrix's priceHistories.
    if (task.tool === "compute_holdings_overlap") {
      if (dep.tool === "fetch_mf_holdings") {
        const funds = (params.funds as Array<Record<string, unknown>>) || [];
        const fundId = (dep.params?.symbol as string) || `fund_${funds.length}`;
        const raw = dep.result;
        const r = raw as Record<string, unknown>;
        const holdings = Array.isArray(raw)
          ? raw
          : (r?.holdings ?? r?.topHoldings ?? raw);
        funds.push({
          id: fundId,
          name: (r?.name as string) || (r?.schemeName as string) || fundId,
          holdings,
        });
        params.funds = funds;
      }
    }

    // ─── MONEY-498: institutional expansion tools ─────────────
    // The 26 new tools (capex intensity, factor scores, volatility regime,
    // governance flags, …) are wired data-driven via input-bindings.ts
    // instead of bespoke branches above. No-op for the legacy ~17 tools.
    applyDeclarativeBindings(task, dep, params);
  }

  private async executeWithTimeout(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
    metadata?: Record<string, unknown>;
  }> {
    // The timeout timer MUST be cleared once the race settles. If the tool
    // resolves first (the normal path) a bare setTimeout stays pending for the
    // full timeoutMs, keeping the event loop alive — every tool call leaked a
    // timer (delays worker shutdown in prod; orphans/30s-times-out the test
    // suite, which `--test-force-exit` was masking). clearTimeout in finally
    // cancels the obsolete timer the instant the tool wins.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ success: false; error: string }>(
      (resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              success: false,
              error: `Tool ${toolName} timed out after ${timeoutMs}ms`,
            }),
          timeoutMs,
        );
      },
    );
    try {
      return await Promise.race([
        this.registry.execute(toolName, params),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
