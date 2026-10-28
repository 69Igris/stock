/**
 * StockSage Research Agent
 *
 * Orchestrates the full research pipeline:
 * 1. Plan - decompose query into tasks
 * 2. Execute - run tasks with data fetching and computation
 * 3. Synthesize - generate structured report
 * 4. Validate - quality check (advanced mode only)
 * 5. Refine - iterate if needed (advanced mode only)
 */

import prisma from "@usemoney/database";
import { getGeminiModel, generateWithTimeout } from "@usemoney/core/gemini";
import { getModelDefinition } from "@usemoney/core/gemini/model-registry";
import { logAiDecision } from "@usemoney/core/analytics";
import { captureResearchSignal } from "@usemoney/core/investor/capture";
import { assembleUserContext } from "@usemoney/core/investor/context";
import {
  resolveInstrument,
  INDIA_VENUE_ORDER,
  INDIA_CASH_VENUES,
} from "@usemoney/core/market-data/instruments/resolve-instrument";
import { ResearchPlanner } from "./planner";
import { ResearchExecutor } from "./executor";
import { Scratchpad } from "./scratchpad";
import { resolveSymbol } from "./data-sources/symbol-resolver";
import {
  retrieveUserDocumentContext,
  formatPinnedEvidence,
} from "./data-sources/user-document-retriever";
import { applyResearchPreferences } from "./apply-preferences";
import { expandSkillAliases } from "./skills/skill-tool-map";
import { releaseDependencies } from "./lib/task-scheduling";
import { ResearchValidator } from "./validator";
import { LoopController } from "./loop-controller";
import { ResearchToolRegistry } from "./tools/registry";
import {
  getEmergencySynthesizerPrompt,
  buildSynthesizerUserPrompt,
} from "./prompts";
import {
  cleanQueryForPlanner,
  sanitizeResearchError,
  detectQueryType,
  hasValidReport,
  computeQualityScore,
  buildContentBlocks,
  applyRunParameters,
} from "./agent-logic";
import type {
  ResearchAgentConfig,
  ResearchJobMessage,
  ResearchMode,
  ResearchPlan,
} from "./types";
import { getConfigForMode, DEFAULT_AGENT_CONFIG } from "./types";

export class ResearchAgent {
  private config: ResearchAgentConfig;
  private registry: ResearchToolRegistry;
  private planner: ResearchPlanner;
  private executor: ResearchExecutor;
  private validator: ResearchValidator;
  private mode: ResearchMode;

  constructor(config?: Partial<ResearchAgentConfig>, mode?: ResearchMode) {
    this.mode = mode || "advanced";
    const baseConfig = config
      ? { ...DEFAULT_AGENT_CONFIG, ...config }
      : getConfigForMode(this.mode);
    this.config = baseConfig;
    this.registry = new ResearchToolRegistry();
    this.planner = new ResearchPlanner(this.registry.getToolNames());
    this.executor = new ResearchExecutor(this.registry, this.config);
    this.validator = new ResearchValidator();
  }

  /**
   * Run a complete research session.
   */
  async run(job: ResearchJobMessage): Promise<void> {
    const {
      sessionId,
      userId,
      skill,
      symbols,
      customSkills,
      researchFocus,
      preset,
      model,
      // MONEY-396 (Document Vault) - user-uploaded doc ids pinned to this run.
      pinnedUserDocumentIds,
      // MONEY-794 (C1c) - institutional run-parameters. All optional; unset →
      // identical plan + report. Stamped onto task params below (mirrors the
      // researchFocus → synthesis-param stamping in applyResearchPreferences).
      horizon,
      benchmark,
      assumptions,
      reportLength,
      varConfig,
    } = job;
    const mode = job.mode || this.mode;

    // Clean query: strip [Mentioned: ...] prefix which confuses the planner
    // into treating description words (INDUSTRIES, INDIAN, CORP) as symbols
    const query = cleanQueryForPlanner(job.query);

    // Re-configure if mode differs from constructor
    if (mode !== this.mode) {
      this.mode = mode;
      this.config = getConfigForMode(mode);
      this.executor = new ResearchExecutor(this.registry, this.config);
    }

    const scratchpad = new Scratchpad();
    const loopController = new LoopController(this.config);

    const startTime = Date.now();
    const totalTimeout = this.config.totalTimeoutMs;

    try {
      // Verify session exists and hasn't already completed - avoids re-processing
      // stale Pub/Sub re-deliveries that would overwrite a finished session
      const existingSession = await prisma.researchSession.findUnique({
        where: { sessionId },
        select: { id: true, status: true },
      });
      if (!existingSession) {
        console.warn(
          `[agent] Session ${sessionId} not found in DB - skipping (stale message?)`,
        );
        return;
      }
      if (
        existingSession.status === "COMPLETED" ||
        existingSession.status === "FAILED"
      ) {
        console.warn(
          `[agent] Session ${sessionId} already ${existingSession.status} - skipping re-delivery`,
        );
        return;
      }

      // Update status: PLANNING
      await this.updateSession(sessionId, {
        status: "PLANNING",
        progress: 5,
        currentStep: "Creating research plan...",
      });

      // MONEY-1120 - expand v1 skill aliases BEFORE planning.
      //
      // `buildAllowedToolSet` (the trim, below) has always expanded aliases
      // internally, but the planner prompt received the RAW ids. The prompt's
      // "skill → tool" mapping table lists v2 ids only, so a v1 alias arrived
      // as a skill the planner had no row for — it was told "emit the matching
      // compute task(s) for EACH skill, use ONLY tools from the list" and
      // could match nothing. It fell back to a generic plan, which the trim
      // then cut down to the alias's real tools: the two halves disagreed
      // about what the run was for.
      //
      // 4 of the 5 skill shortcuts sent an alias — /peer (peer-comparison),
      // /thesis (investment-thesis), /earnings (earnings-analysis) and
      // /technical (stock-analysis). /dcf sent the one real v2 id
      // (dcf-valuation), which is exactly why /dcf was the one that produced a
      // report at all while /earnings failed outright (MONEY-1095 items 5, 7,
      // 11). Expansion is idempotent, so a v2 id passes through untouched.
      const plannerSkills = customSkills?.length
        ? expandSkillAliases(customSkills)
        : customSkills;

      // Step 1: Plan (mode-aware) - pass job symbols so skill can use
      // them directly. MONEY-240 follow-up (B5): also pass customSkills
      // so the LLM emits one task per selected skill instead of
      // defaulting to ~17 generic tasks.
      const rawPlan = await this.planner.plan(
        query,
        scratchpad,
        skill,
        mode,
        symbols,
        plannerSkills,
      );

      // MONEY-222 - apply the user's saved research preferences:
      //   - customSkills trim compute/analysis tasks (data fetches + synth
      //     are always kept) so a user who only wants DCF doesn't pay for
      //     a full earnings-quality + accounting-quality + technicals run.
      //   - researchFocus stamps a directive onto synthesis tasks so the
      //     report leans toward the user's recurring lens (e.g. "always
      //     emphasise margin expansion").
      const prefsPlan = applyResearchPreferences(rawPlan, {
        customSkills,
        researchFocus,
        // MONEY-219/MONEY-779 - stamp the preset onto the plan so the
        // worker's billing reconciliation can read `planObj.preset` off
        // the persisted plan (it was always undefined before this).
        preset,
      });

      // MONEY-794 (C1c) - stamp the institutional run-parameters onto the task
      // params (mirrors the researchFocus → synthesis-param stamping above).
      // Runs AFTER applyResearchPreferences so any AUGMENTED tasks (e.g. an
      // appended fetch_price_history / compute_var from a preset's extra
      // skills) also inherit the horizon / benchmark / VaR overrides. An empty
      // run-param set returns a structurally-identical plan → no behaviour
      // change for callers that don't set them.
      const plan = applyRunParameters(prefsPlan, {
        horizon,
        benchmark,
        assumptions,
        reportLength,
        varConfig,
      });

      // MONEY-790 (B5) - the user's durable InvestorProfile memory. Stamp it
      // onto every synthesis task's params (same threading as researchFocus)
      // so the synthesizer prompt builder personalizes the report's FRAMING.
      // Best-effort + never-throws ("" on miss/error) so research keeps working
      // when memory is unavailable; DESCRIBES the user, never advises (SEBI).
      const memoryContext = await assembleUserContext(userId).catch(() => "");
      if (memoryContext) {
        plan.tasks = plan.tasks.map((t) =>
          t.type === "synthesis"
            ? { ...t, params: { ...t.params, memoryContext } }
            : t,
        );
      }

      // MONEY-396 (Document Vault) - if the user pinned uploaded documents to
      // this run, retrieve their embedded chunks (STRICTLY scoped to this
      // userId) and stamp the FENCED evidence onto every synthesis task's
      // params as `pinnedEvidence` (same threading as memoryContext above).
      // Unlike the TRUSTED InvestorProfile memory, this is UNTRUSTED user
      // content: `formatPinnedEvidence` fences it and the synthesizer prompt
      // re-fences it as EXTERNAL DATA so a planted document can't inject
      // instructions. Best-effort + never-throws ("" on miss/error) so a RAG
      // miss never blocks the run. DESCRIBES the user's documents; never
      // advises a buy/sell (SEBI).
      if (pinnedUserDocumentIds?.length) {
        const pinned = await retrieveUserDocumentContext(
          userId,
          pinnedUserDocumentIds,
          query,
        ).catch(() => null);
        const pinnedEvidence = pinned ? formatPinnedEvidence(pinned) : "";
        if (pinnedEvidence) {
          plan.tasks = plan.tasks.map((t) =>
            t.type === "synthesis"
              ? { ...t, params: { ...t.params, pinnedEvidence } }
              : t,
          );
        }
      }

      // Override symbols if provided
      if (symbols?.length) {
        plan.symbols = symbols;
      }

      // Validate resolved symbols against InstrumentMapping (Indian stocks only)
      const isMfQuery =
        query.startsWith("[MUTUAL_FUND]") || query.startsWith("[ETF]");
      if (plan.symbols?.length > 0 && !isMfQuery) {
        const invalidSymbols: string[] = [];
        const validSymbols: string[] = [];
        for (const sym of plan.symbols) {
          const baseSym = sym.replace(/\.(NS|BO)$/i, "").toUpperCase();
          // Skip index symbols (^NSEI, ^BSESN, etc.)
          if (baseSym.startsWith("^")) {
            validSymbols.push(sym);
            continue;
          }
          // Skip common noise words that LLM planner may extract as symbols
          if (
            ["VS", "VERSUS", "AND", "OR", "THE", "OF", "IN", "FOR"].includes(
              baseSym,
            )
          ) {
            console.warn(
              `[agent] Filtering noise word "${baseSym}" from symbols`,
            );
            invalidSymbols.push(baseSym);
            continue;
          }
          // MONEY-980 — exact symbol match through the one resolver that owns
          // the venue rank, the liveness rule and the tiebreak.
          //
          // This was three hand-written queries: a `findMany` scoped
          // `exchange: { in: ["NSE","BSE","NASDAQ","NYSE","AMEX"] }`, a rank in
          // that same order, and a `findFirst` with no venue clause at all as an
          // "any exchange (ETFs, indices)" fallback. Once US securities moved to
          // `us_instruments` the three US terms matched ZERO ROWS BY
          // CONSTRUCTION, so a US ticker fell through to the `findFirst` — which,
          // having no venue clause and no ordering, picked by Mongo's natural
          // order. The India read now covers every venue `instrument_mappings`
          // holds, which is what the "any exchange" fallback was reaching for,
          // and it is RANKED rather than arbitrary.
          //
          // `market: "IN"` is load-bearing and its absence was a REGRESSION, not
          // a widening. `resolveInstrument`'s default also reads `us_instruments`
          // (~72,685 listings) and this rung RETURNS EARLY, so an unscoped call
          // answers any bare token that is an active US ticker before the
          // company-NAME branch below ever runs. The planner's only guard
          // against junk is an eight-word literal list, so "how is IT doing"
          // reaches here as `IT` — which is a live NYSE ticker (Gartner). The
          // run would then have executed in full against NSE/screener/XBRL
          // tools that hold not one row for it: a spent credit, a plausible
          // report, and nothing behind it.
          //
          // Research is India-only by CAPABILITY, not by preference. There is
          // no flag to gate a US arm on here — this package runs in the Cloud
          // Run worker and cannot reach `getUsFeatureFlags` — and there would be
          // nothing for the arm to feed: every tool in the registry that takes a
          // symbol reads NSE, BSE, screener.in or our own XBRL archive. The arm
          // arrives with the US data sources, not before them.
          const resolvedInstrument = await resolveInstrument({
            symbol: baseSym,
            market: "IN",
          });
          // AMBIGUOUS falls through to the name-matching branch and, failing
          // that, to `invalidSymbols`. That is the correct outcome for a planner
          // symbol we cannot pin to one security: the run tells the user the
          // symbol was not usable rather than researching the wrong company.
          // (Unreachable from the India side today — `@@unique([symbol,
          // exchange])` makes multiplicity a dual listing, which the venue rank
          // settles — and handled anyway so it cannot become a silent guess.)
          const foundAny =
            resolvedInstrument.status === "RESOLVED"
              ? resolvedInstrument.instrument
              : null;
          if (foundAny) {
            // Use the resolved Yahoo symbol for the correct exchange suffix
            const resolvedSym =
              foundAny.yahooSymbol || resolveSymbol(foundAny.symbol);
            validSymbols.push(resolvedSym);
            // Update tasks if the resolved symbol differs from what the planner produced
            if (resolvedSym !== sym) {
              for (const t of plan.tasks) {
                if (
                  (t.params.symbol as string)
                    ?.replace(/\.(NS|BO)$/i, "")
                    .toUpperCase() === baseSym
                ) {
                  t.params.symbol = resolvedSym;
                }
                const syms = t.params.symbols as string[] | undefined;
                if (syms) {
                  t.params.symbols = syms.map((s) =>
                    s.replace(/\.(NS|BO)$/i, "").toUpperCase() === baseSym
                      ? resolvedSym
                      : s,
                  );
                }
              }
            }
            continue;
          }

          // Fallback: try matching by company name (handles "INFOSYS" → "INFY", "TATA CONSULTANCY" → "TCS")
          // First try startsWith for precise matches, then contains as fallback.
          // Prefer shortest name match (more specific) to avoid "HCL Infosystems" beating "Infosys Limited".
          //
          // MONEY-980 — INDIA CASH VENUES ONLY.
          //
          // These two queries carried the "NSE, BSE, NASDAQ, NYSE, AMEX" list,
          // three terms of which have matched ZERO ROWS BY CONSTRUCTION since
          // the split: they read as US coverage while providing none. An
          // earlier pass swapped them to `INDIA_VENUE_ORDER` and called it a
          // rename that "changes no result" — IT IS NOT. That constant is
          // `["NSE","BSE","NFO","BFO","MCX"]`, so the swap dropped three dead
          // terms and ADDED THREE LIVE ONES, against venues whose `name` column
          // holds contract identifiers (`NIFTY25SEP25000CE`) rather than
          // issuers. A `contains` match there resolves a company query to a
          // derivative contract that every downstream tool then fails on.
          //
          // `INDIA_CASH_VENUES` is the honest scope, and it IS the no-op the
          // earlier note claimed: `["NSE","BSE"]` is what the old list matched.
          //
          // A US name search is deliberately NOT added here. `UsInstrument.name`
          // is nullable and filled by a separate PACED leg, so a name query
          // against it returns a different answer depending on how far that leg
          // has walked — non-determinism dressed as coverage.
          //
          // `orderBy` is not decoration on a `take`. Without one, Mongo returns
          // an arbitrary 20 of however many rows match, so `pickBestMatch` picks
          // the best of a page nobody chose — a query that matches 400 names can
          // return a different winner on two identical runs. `name: "asc"`
          // matches the chat route's name branches, so the two paths page the
          // same rows. (It orders LEXICALLY while the ranking below prefers the
          // SHORTEST name, so a 400-match `contains` can still page past the
          // shortest one; deterministic-and-explicable beats arbitrary, and a
          // query that broad is already answering the wrong question.)
          const nameSelect = {
            id: true,
            symbol: true,
            yahooSymbol: true,
            exchange: true,
            name: true,
          } as const;
          const nameOrder = { name: "asc" } as const;

          const byNameStartsWith = await prisma.instrumentMapping.findMany({
            where: {
              name: { startsWith: baseSym, mode: "insensitive" },
              isActive: true,
              exchange: { in: [...INDIA_CASH_VENUES] },
            },
            select: nameSelect,
            orderBy: nameOrder,
            take: 20,
          });

          // If startsWith didn't find anything, try contains
          const byNameMatches =
            byNameStartsWith.length > 0
              ? byNameStartsWith
              : await prisma.instrumentMapping.findMany({
                  where: {
                    name: { contains: baseSym, mode: "insensitive" },
                    isActive: true,
                    exchange: { in: [...INDIA_CASH_VENUES] },
                  },
                  select: nameSelect,
                  orderBy: nameOrder,
                  take: 20,
                });

          // Rank: NSE > BSE > … (the shared India venue order), then shortest
          // name (most specific match).
          //
          // MONEY-980 — `indexOf` returns -1 for a venue not in the list, which
          // sorted UNKNOWN venues AHEAD of NSE. That was unreachable while the
          // list covered every venue the query could return; it stopped being
          // unreachable the moment `instrument_mappings` started holding
          // NFO/BFO/MCX rows. Missing now ranks LAST, explicitly.
          const venueRank = (exchange: string): number => {
            const at = (INDIA_VENUE_ORDER as readonly string[]).indexOf(
              exchange,
            );
            return at === -1 ? Number.MAX_SAFE_INTEGER : at;
          };
          const pickBestMatch = (matches: typeof byNameMatches) => {
            const sorted = [...matches].sort((a, b) => {
              const exchDiff = venueRank(a.exchange) - venueRank(b.exchange);
              if (exchDiff !== 0) return exchDiff;
              // Shorter name = more specific match (e.g., "Infosys Limited" beats "HCL Infosystems Limited")
              return (a.name?.length ?? 999) - (b.name?.length ?? 999);
            });
            return sorted[0] ?? null;
          };

          const byName = pickBestMatch(byNameMatches);
          if (byName) {
            const resolvedYahoo =
              byName.yahooSymbol || resolveSymbol(byName.symbol);
            console.log(
              `[agent] Resolved company name "${baseSym}" → symbol "${byName.symbol}" (${resolvedYahoo}, ${byName.exchange})`,
            );
            // Replace the old symbol in plan.symbols and task params
            validSymbols.push(resolvedYahoo);
            // Update tasks that reference the old symbol
            for (const t of plan.tasks) {
              if (
                (t.params.symbol as string)
                  ?.replace(/\.(NS|BO)$/i, "")
                  .toUpperCase() === baseSym
              ) {
                t.params.symbol = resolvedYahoo;
              }
              const syms = t.params.symbols as string[] | undefined;
              if (syms) {
                t.params.symbols = syms.map((s) =>
                  s.replace(/\.(NS|BO)$/i, "").toUpperCase() === baseSym
                    ? resolvedYahoo
                    : s,
                );
              }
            }
            continue;
          }

          invalidSymbols.push(baseSym);
        }

        if (invalidSymbols.length > 0) {
          if (validSymbols.length === 0) {
            // ALL symbols unrecognised - reject.
            //
            // MONEY-980 — this named NASDAQ/NYSE and suggested "AAPL, MSFT".
            // It has never been true: the exact-symbol read above is India-only
            // and every symbol tool in the registry reads NSE, BSE, screener.in
            // or our own XBRL archive. A user who takes the suggestion gets the
            // same rejection back, having been told by the product that it was
            // the right thing to type.
            const errMsg = `${invalidSymbols.join(", ")} ${invalidSymbols.length > 1 ? "are" : "is"} not listed on NSE or BSE. Please use a valid Indian stock symbol (e.g., RELIANCE, TCS, INFY).`;
            await this.updateSession(sessionId, {
              status: "FAILED",
              errorMessage: errMsg,
              completedAt: new Date(),
            });
            return;
          }

          // Some symbols invalid - filter them out and continue with valid ones
          console.warn(
            `[agent] Filtered out invalid symbols: ${invalidSymbols.join(", ")}. Continuing with: ${validSymbols.join(", ")}`,
          );
          plan.symbols = validSymbols;

          // Also remove tasks that reference invalid symbols
          for (const inv of invalidSymbols) {
            plan.tasks = plan.tasks.filter((t) => {
              const taskSym = ((t.params.symbol as string) || "")
                .replace(/\.(NS|BO)$/i, "")
                .toUpperCase();
              const taskSyms = ((t.params.symbols as string[]) || []).map((s) =>
                s.replace(/\.(NS|BO)$/i, "").toUpperCase(),
              );
              return taskSym !== inv && !taskSyms.includes(inv);
            });
          }
        }
      }

      // Detect query type for routing to the right synthesizer prompt
      const queryType = detectQueryType(query);

      // Ensure synthesis tasks always have the query param
      // (LLM-generated plans may omit it)
      for (const task of plan.tasks) {
        if (
          task.tool === "synthesize_report" ||
          task.tool === "compare_stocks"
        ) {
          if (!task.params.query) {
            task.params.query = query;
          }
          if (!task.params.mode) {
            task.params.mode = mode;
          }
          // MONEY-1073 — PRESERVE a queryType the skill already set (the
          // mf-analysis / mf-comparison skills inject "mf"/"etf" because THEY
          // know the run is fund-shaped). Only fall back to detectQueryType when
          // unset — consistent with `query`/`mode` above. The prior unconditional
          // assignment clobbered the skill's "mf" with detectQueryType's
          // `undefined`, so funds were synthesized with the stock prompt and the
          // synthesis step failed.
          if (!task.params.queryType) {
            task.params.queryType = queryType;
          }
          // MONEY-587 (task #36) - forward the user-chosen model to the
          // synthesizer so a premium-billed Pro model is actually used.
          // synthesize_report falls back to the advanced default when
          // omitted/unknown/gated; compare_stocks ignores it harmlessly.
          if (model && task.params.model === undefined) {
            task.params.model = model;
          }
        }
      }

      await this.updateSession(sessionId, {
        plan: plan as unknown as Record<string, unknown>,
        symbols: plan.symbols,
        progress: 10,
        currentStep: `Plan created: ${plan.tasks.length} tasks (${mode} mode)`,
      });

      let report: Record<string, unknown> | string = "";
      let lastValidation = {
        score: 0,
        passed: false,
        gaps: [] as string[],
        suggestions: [] as string[],
      };

      // Iterative loop
      while (!loopController.isAtLimit()) {
        loopController.startIteration();

        // Check total timeout
        if (Date.now() - startTime > totalTimeout) {
          console.warn("[agent] Total timeout reached");
          break;
        }

        // Check if user cancelled
        if (await this.isCancelled(sessionId)) {
          console.log(
            `[agent] Session ${sessionId} cancelled by user - stopping`,
          );
          return;
        }

        // Time-aware: if running low on time, skip non-essential pending tasks
        const elapsed = Date.now() - startTime;
        const remaining = totalTimeout - elapsed;

        if (remaining < 180_000) {
          const pendingNonSynthesis = plan.tasks.filter(
            (t) => t.status === "pending" && t.type !== "synthesis",
          );
          if (pendingNonSynthesis.length > 3) {
            const skipped = pendingNonSynthesis.slice(3);
            for (const t of skipped) {
              t.status = "failed";
              t.error = "Skipped - insufficient time remaining";
            }
            // MONEY-1120 - release the skipped ids from whatever still depends
            // on them. synthesize_report depends on ALL other tasks, so without
            // this the skip above left it permanently unready: the executor saw
            // a deadlock, failed synthesis with "Unresolvable dependency", and
            // the run ended on the bare "partially completed" fallback with no
            // report body. Releasing lets synthesis run on the data that did
            // arrive — a shorter real report instead of none.
            const released = releaseDependencies(
              plan.tasks,
              new Set(skipped.map((t) => t.id)),
            );
            console.warn(
              `[agent] Low time (${Math.round(remaining / 1000)}s left) - skipped ${skipped.length} tasks, released them from ${released.length} dependent task(s)`,
            );
          }
        }

        // Step 2: Execute
        await this.updateSession(sessionId, {
          status: "RESEARCHING",
          progress: 15 + (loopController.getIteration() - 1) * 30,
          currentStep: "Fetching data and running analysis...",
          iteration: loopController.getIteration(),
        });

        const executedTasks = await this.executor.execute(
          plan.tasks.filter((t) => t.status === "pending"),
          scratchpad,
          async (completed, total, step) => {
            const baseProgress = 15 + (loopController.getIteration() - 1) * 30;
            const execProgress = Math.round((completed / total) * 40);
            await this.updateSession(sessionId, {
              progress: Math.min(baseProgress + execProgress, 85),
              currentStep: step,
              plan: plan as unknown as Record<string, unknown>,
            }).catch(() => {}); // Non-critical update
          },
        );

        loopController.addSteps(executedTasks.length);

        // Step 3: Check if synthesis task produced a report
        const synthesisTask = executedTasks.find(
          (t) => t.tool === "synthesize_report" || t.tool === "compare_stocks",
        );

        if (synthesisTask?.status === "completed" && synthesisTask.result) {
          const result = synthesisTask.result as Record<string, unknown>;
          const reportData = result.report;

          console.log(
            "[agent] Synthesis completed. Report type:",
            typeof reportData,
            reportData && typeof reportData === "object"
              ? `keys: ${Object.keys(reportData as Record<string, unknown>).join(",")}`
              : "",
          );

          if (typeof reportData === "object" && reportData !== null) {
            // Structured JSON report
            report = reportData as Record<string, unknown>;
          } else if (typeof reportData === "string" && reportData.trim()) {
            report = reportData;
          } else {
            // Synthesis returned but report is empty/null
            console.warn("[agent] Synthesis returned empty report");
            report = {
              score: 0,
              recommendation: "N/A",
              confidence: 0,
              summary:
                "Research data was collected but analysis could not be completed. Please try again.",
              keyMetrics: [],
              strengths: [],
              risks: [],
              disclaimer: "Analysis incomplete.",
            };
          }
        } else if (synthesisTask?.status === "failed") {
          console.error("[agent] Synthesis task failed:", synthesisTask.error);
          report = {
            score: 0,
            recommendation: "N/A",
            confidence: 0,
            summary:
              "Research data was collected but analysis could not be completed. Please try again.",
            keyMetrics: [],
            strengths: [],
            risks: [],
            disclaimer: "Analysis incomplete.",
          };
        }

        if (!report || (typeof report === "string" && !report.trim())) {
          // Synthesis hasn't run yet - check if it's still pending
          const synthesisTasks = plan.tasks.filter(
            (t) =>
              t.tool === "synthesize_report" || t.tool === "compare_stocks",
          );
          const anySynthesisRan = synthesisTasks.some(
            (t) => t.status === "completed" || t.status === "failed",
          );

          if (anySynthesisRan) {
            // Synthesis ran but didn't produce extractable report
            report = {
              score: 0,
              recommendation: "N/A",
              confidence: 0,
              summary:
                "Research data was collected but synthesis could not produce a structured report. Please try again.",
              keyMetrics: [],
              strengths: [],
              risks: [],
              disclaimer: "Synthesis incomplete - this is a fallback result.",
            };
          } else {
            // Synthesis hasn't run yet - continue loop
            report = "";
          }
        }

        // In fast mode, skip validation entirely
        if (this.config.skipValidation) {
          break;
        }

        // Step 4: Validate (advanced mode)
        if (report) {
          await this.updateSession(sessionId, {
            status: "VALIDATING",
            progress: 80,
            currentStep: "Validating report quality...",
          });

          const reportForValidation =
            typeof report === "string" ? report : JSON.stringify(report);

          lastValidation = await this.validator.validate(
            query,
            plan,
            reportForValidation,
            scratchpad,
            model,
          );

          scratchpad.log("validation", {
            score: lastValidation.score,
            passed: lastValidation.passed,
            gaps: lastValidation.gaps,
          });

          // Step 5: Check if refinement needed
          if (!loopController.shouldRefine(lastValidation)) {
            break;
          }

          // Step 6: Refine
          await this.updateSession(sessionId, {
            status: "REFINING",
            progress: 70,
            currentStep: `Refining: filling ${lastValidation.gaps.length} gaps...`,
          });

          scratchpad.log("refinement", {
            iteration: loopController.getIteration(),
            gaps: lastValidation.gaps,
          });

          const refinementTasks = this.planner.createRefinementTasks(
            lastValidation.gaps,
            plan,
          );

          if (refinementTasks.length === 0) break;

          // Add refinement tasks to plan
          plan.tasks.push(...refinementTasks);

          // Re-add synthesis task as pending
          const existingSynthesis = plan.tasks.find(
            (t) => t.tool === "synthesize_report",
          );
          if (existingSynthesis) {
            existingSynthesis.status = "pending";
            existingSynthesis.result = undefined;
            existingSynthesis.dependsOn = [
              ...existingSynthesis.dependsOn,
              ...refinementTasks.map((t) => t.id),
            ];
          }
        }
      }

      // Emergency synthesis when loop exits without a valid report
      if (!hasValidReport(report)) {
        console.warn(
          "[agent] No valid report after loop - attempting emergency synthesis",
        );
        try {
          report = await this.emergencySynthesize(plan, query);
        } catch (e) {
          console.error("[agent] Emergency synthesis also failed:", e);
        }
      }

      // Build contentBlocks from structured report
      const contentBlocks = buildContentBlocks(report, plan.symbols);

      // Done - save final results
      const tokenUsage = scratchpad.getTokenUsage();

      // Extract + normalize the persisted quality score (see agent-logic).
      const finalScore = computeQualityScore(
        report,
        lastValidation.score,
        !!this.config.skipValidation,
      );

      await this.updateSession(sessionId, {
        status: "COMPLETED",
        progress: 100,
        currentStep: "Research complete",
        report: typeof report === "object" ? report : { content: report },
        contentBlocks,
        scratchpad: scratchpad.toJSON(),
        qualityScore: finalScore,
        totalSteps: loopController.getTotalSteps(),
        tokensUsed: tokenUsage.input + tokenUsage.output,
        iteration: loopController.getIteration(),
        completedAt: new Date(),
      });

      // MONEY-786: durable AI decision audit log (best-effort, never throws).
      void logAiDecision({
        decisionType: "RESEARCH_RUN",
        userId,
        model: model ?? "unknown",
        provider:
          getModelDefinition(model ?? "")?.provider === "anthropic"
            ? "ANTHROPIC"
            : "GOOGLE",
        input: { query, symbols, customSkills, researchFocus, preset, mode },
        output: {
          qualityScore: finalScore,
          totalSteps: loopController.getTotalSteps(),
          iteration: loopController.getIteration(),
          contentBlockCount: contentBlocks.length,
        },
        rationale: `Research run completed in ${this.mode} mode (quality ${finalScore})`,
        qualityScore: finalScore,
        outcome: "COMPLETED",
        sessionId,
        usage: {
          inputTokens: tokenUsage.input,
          outputTokens: tokenUsage.output,
          latencyMs: Date.now() - startTime,
        },
        metadata: {
          symbols: plan.symbols,
          skills: customSkills,
          taskCount: plan.tasks.length,
          mode,
        },
      }).catch(() => {});

      // MONEY-788 (B3): behaviour-signal capture — nudge the exercised concepts
      // + append a `research_completed` UserEvent. Best-effort, never throws.
      // Only on the COMPLETED path (not the FAILED branch below). `plan.skill`
      // is the planner's resolved skill; fall back to the job-level hint.
      void captureResearchSignal({
        userId,
        sessionId,
        skill: plan.skill ?? skill,
        symbols: plan.symbols,
        mode,
        qualityScore: finalScore,
      }).catch(() => {});
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : String(error);
      console.error("[agent] Research failed:", rawMsg);

      scratchpad.log("error", { phase: "agent", error: rawMsg });

      // Sanitize error for user display - hide internal/technical details
      const userMsg = sanitizeResearchError(rawMsg);

      await this.updateSession(sessionId, {
        status: "FAILED",
        errorMessage: userMsg,
        scratchpad: scratchpad.toJSON(),
        progress: 0,
        currentStep: "Research failed",
        completedAt: new Date(),
      });

      // MONEY-786: durable AI decision audit log for the failed run.
      const failTokens = scratchpad.getTokenUsage();
      void logAiDecision({
        decisionType: "RESEARCH_RUN",
        userId,
        model: model ?? "unknown",
        provider:
          getModelDefinition(model ?? "")?.provider === "anthropic"
            ? "ANTHROPIC"
            : "GOOGLE",
        input: { query, symbols, customSkills, researchFocus, preset, mode },
        output: { error: rawMsg },
        rationale: `Research run failed: ${userMsg}`,
        outcome: "FAILED",
        sessionId,
        usage: {
          inputTokens: failTokens.input,
          outputTokens: failTokens.output,
          latencyMs: Date.now() - startTime,
        },
        metadata: { symbols, skills: customSkills, mode },
      }).catch(() => {});
    }
  }

  /**
   * Emergency synthesis using the fast model (flash) when primary synthesis fails.
   * Collects whatever completed task data exists and produces a minimal report.
   * Always returns a valid report object - never throws.
   */
  private async emergencySynthesize(
    plan: ResearchPlan,
    query: string,
  ): Promise<Record<string, unknown>> {
    try {
      const model = getGeminiModel("fast");
      const systemPrompt = getEmergencySynthesizerPrompt();
      const userPrompt = buildSynthesizerUserPrompt(query, plan.tasks);
      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

      const response = await generateWithTimeout(model, fullPrompt, 45_000, 1);

      // Try to parse JSON
      let jsonStr = response.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1]!.trim();
      }

      try {
        const parsed = JSON.parse(jsonStr);
        if (typeof parsed === "object" && parsed !== null) {
          return {
            ...parsed,
            disclaimer:
              "This report was generated with limited data due to timeout. Results should be verified with additional research.",
          } as Record<string, unknown>;
        }
      } catch {
        // JSON parse failed - try extracting object
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (typeof parsed === "object" && parsed !== null) {
              return {
                ...parsed,
                disclaimer:
                  "This report was generated with limited data due to timeout.",
              } as Record<string, unknown>;
            }
          } catch {
            // Give up on JSON
          }
        }
      }
    } catch (err) {
      console.error(
        "[agent] Emergency synthesis LLM call failed:",
        err instanceof Error ? err.message : err,
      );
    }

    // Absolute fallback - hand-crafted minimal report.
    const completedTasks = plan.tasks.filter((t) => t.status === "completed");
    // MONEY-650 (B11): a timed-out Advanced run used to render a BARE
    // "partially completed" message with no report body. Emit a "Completed
    // coverage" section listing the analysis dimensions that DID finish, so the
    // user gets something useful from the partial run (same defensive intent as
    // the synthesizer salvage in synthesize-report.ts). The real timeout tuning
    // — why N tasks miss the 480s budget (upstream latency vs API rate limits)
    // — is a worker-telemetry problem, not a blind config bump.
    const coverage = Array.from(
      new Set(
        completedTasks
          .map((t) => (t as { tool?: string }).tool)
          .filter((v): v is string => typeof v === "string" && v.length > 0)
          .map((tool) =>
            tool
              .replace(/^(fetch|compute|get|analyze)_/, "")
              .replace(/_/g, " "),
          ),
      ),
    );
    const coverageSections =
      coverage.length > 0
        ? [
            {
              title: "Completed coverage",
              content: `These analysis dimensions completed before the run reached its time budget:\n\n${coverage
                .map((c) => `- ${c}`)
                .join("\n")}\n\nRe-run the research for the full report.`,
            },
          ]
        : [];
    return {
      score: 40,
      recommendation: "N/A",
      confidence: 30,
      summary: `Research for "${query}" was partially completed (${completedTasks.length}/${plan.tasks.length} tasks). Some analysis dimensions could not be processed due to time constraints. Please try again for a full report.`,
      keyMetrics: [],
      strengths: [],
      risks: ["Incomplete analysis - not all data sources were available"],
      sections: coverageSections,
      disclaimer:
        "This report was generated with limited data due to timeout. Results should be verified.",
      dataCompleteness: Math.round(
        (completedTasks.length / Math.max(plan.tasks.length, 1)) * 100,
      ),
    };
  }

  /**
   * Update research session in the database.
   */
  /**
   * Check if the session has been cancelled by the user.
   * Returns true if the session status is FAILED with "Cancelled by user".
   */
  private async isCancelled(sessionId: string): Promise<boolean> {
    try {
      const session = await prisma.researchSession.findUnique({
        where: { sessionId },
        select: { status: true, errorMessage: true },
      });
      return (
        session?.status === "FAILED" &&
        session.errorMessage === "Cancelled by user"
      );
    } catch (e) {
      console.warn("[agent] isCancelled check failed", e);
      return false;
    }
  }

  private async updateSession(
    sessionId: string,
    data: Record<string, unknown>,
    retries = 5,
  ): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // If we're about to mark COMPLETED, check for user cancellation first
        if (data.status === "COMPLETED") {
          const cancelled = await this.isCancelled(sessionId);
          if (cancelled) {
            console.log(
              `[agent] Session ${sessionId} was cancelled - skipping COMPLETED update`,
            );
            return;
          }
        }

        await prisma.researchSession.update({
          where: { sessionId },
          data: data as Parameters<
            typeof prisma.researchSession.update
          >[0]["data"],
        });
        return; // Success
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isWriteConflict =
          msg.includes("write conflict") || msg.includes("deadlock");
        if (isWriteConflict && attempt < retries) {
          // Exponential backoff with jitter: 200-400ms, 400-800ms, 800-1600ms, 1600-3200ms
          const baseDelay = 200 * Math.pow(2, attempt - 1);
          const jitter = Math.random() * baseDelay;
          await new Promise((r) => setTimeout(r, baseDelay + jitter));
          continue;
        }
        // Only warn on final failure; progress-only updates are non-critical
        const isProgressOnly =
          !data.status && !data.report && !data.errorMessage;
        if (isProgressOnly) {
          // Silently drop non-critical progress updates on final failure
          return;
        }
        // A terminal-status write (COMPLETED/FAILED) that exhausts all
        // retries leaves the session stuck forever — escalate to error so
        // it surfaces in alerting rather than getting lost as a warn.
        const isTerminal =
          data.status === "COMPLETED" || data.status === "FAILED";
        if (isTerminal) {
          console.error(
            "[agent] FAILED to persist terminal status after retries — session stuck",
            { sessionId, intendedStatus: data.status },
          );
        } else {
          console.warn(
            `[agent] Failed to update session (attempt ${attempt}/${retries}):`,
            msg,
          );
        }
      }
    }
  }
}
