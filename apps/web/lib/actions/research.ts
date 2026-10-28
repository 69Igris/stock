/**
 * Research Server Actions
 *
 * Server actions for starting research and querying status.
 */

"use server";

import { prisma } from "@usemoney/database";
import { mapWithConcurrency } from "@usemoney/services";

/**
 * How many company-NAME lookups run at once during symbol resolution.
 *
 * Small on purpose: each is an unanchored `contains` / `mode:"insensitive"`
 * regex scan, and this runs BEFORE the credit gate, so an unbounded fan-out is
 * unmetered load a caller can trigger for free.
 */
const SYMBOL_RESOLVE_CONCURRENCY = 4;
import { v4 as uuidv4 } from "uuid";
import { getAuthenticatedUser } from "@/lib/auth";
import { publishResearchJob } from "@usemoney/pubsub/publish";
import { isDemoSession } from "@/lib/demo/session";
import {
  demoResearchHistory,
  demoResearchDetail,
  demoResearchDetail2,
} from "@/lib/demo/data";
import {
  getResearchStatus as getResearchStatusService,
  getResearchResult as getResearchResultService,
  getRecentResearchSessions as getRecentResearchSessionsService,
  getRunningResearch as getRunningResearchService,
  getResearchHistory as getResearchHistoryService,
  cancelResearch as cancelResearchService,
  deleteResearch as deleteResearchService,
  consumeCredits,
  refundCredits,
  estimateAnalysisCost,
} from "@usemoney/services";
import { CREDIT_COSTS } from "@usemoney/core";
// MONEY-229 - apply model-premium on top of action base cost. Imported
// from the deeper path to avoid pulling the Vertex AI client into the
// action's bundle (server-only here, but the same trick keeps imports
// uniform across the chat route + composer).
import {
  getEffectiveCreditCost,
  resolveResearchModel,
} from "@usemoney/core/gemini/model-registry";
import { preferences as preferencesService } from "@usemoney/services";
import {
  looksLikeUserId,
  autoDetectComparison,
  isFundShapedQuery,
  cleanSymbol,
  stripMentionPrefix,
  isSchemeCodeRun,
  formatInvalidSymbolError,
} from "@/lib/actions/research-symbol-logic";
// MONEY-779 — field-level run-parameter sanitizer. Pure + exported in its own
// sibling so the validation logic is unit-testable without importing this
// `"use server"` module (which drags in auth + db). De-shadowed: production and
// tests run the SAME `sanitizeAgainstSchema`.
import { sanitizeAgainstSchema } from "@/lib/actions/research-run-params-logic";
// MONEY-798 (P3c) - RAG corpus-coverage visibility for a symbol. Imported from
// the deep subpath so only the prisma-only coverage helper (not the whole
// research package) is pulled into this server action.
import {
  getRagCoverage,
  type RagCoverage,
} from "@usemoney/research/data-sources/rag-enqueue";

// Re-export types for consumers
export type {
  ResearchStatusData,
  ResearchResultData,
  RecentResearchItem,
  RunningResearchItem,
  ResearchHistoryItem,
  ResearchHistoryPage,
} from "@usemoney/services";

/**
 * Create a new research session and publish to Pub/Sub
 */
/**
 * MONEY-222 / MONEY-219 - extras forwarded to the worker. These are a
 * hint, not a contract: the planner ignores them when researchStyle =
 * auto/quick. v2 adds the preset id so the worker can stamp it on
 * the ResearchPlan, surface it in the result UI, and bill via dynamic
 * credits.
 */
export interface ResearchActionExtras {
  customSkills?: string[];
  researchFocus?: string;
  /** v2 preset id (quick-pulse, investment-thesis, etc.) */
  preset?: string;
  /**
   * MONEY-446 — asset class of the research subject. When "mf" the run is
   * a single-fund StockSage deep dive: the `mf-analysis` skill is forced
   * (the `[MUTUAL_FUND] …` query text does NOT match the skill's triggers
   * via matchSkill, so an explicit hint is required for deterministic
   * routing) and credits are billed via the `mf_analysis` estimate
   * (heavier than a single stock, capped at 30, scales with the number of
   * underlying constituents). Omitted / "stock" / "etf" preserve the
   * existing stock + ETF behaviour unchanged.
   */
  assetType?: "stock" | "etf" | "mf";
  /**
   * MONEY-446 — number of underlying portfolio constituents the MF
   * analysis will examine. Scales the `mf_analysis` credit estimate
   * (clamped to the hard cap). Only consulted when assetType === "mf".
   */
  underlyingStocks?: number;
  /**
   * MONEY-587 (task #36) — explicit Gemini registry model id forwarded by
   * the chat route (it resolves `effectiveModelId` from the user's
   * composer prefs and injects it into the run_research params). When
   * supplied it overrides the locally-derived `resolvedModelId` for the
   * published job so the worker synthesizer/validator runs on the model
   * the user was billed a premium for. Omitted → the action computes the
   * model from the user's saved prefs + plan policy below.
   */
  model?: string;
  /**
   * MONEY-794 (C1c) — institutional run-parameters. All optional and
   * forwarded as a hint to the worker; an unset value reproduces today's
   * plan + report exactly. The agent stamps these onto the relevant task
   * params (horizon → fetch_price_history.period, benchmark → benchmark fetch
   * symbol, assumptions → dcf/wacc/scenario params, varConfig → VaR params)
   * and feeds horizon + reportLength into the synthesizer prompt.
   */
  horizon?: "1y" | "3y" | "5y";
  benchmark?: string;
  assumptions?: {
    wacc?: number;
    terminalGrowth?: number;
    growthOverride?: number;
  };
  reportLength?: "brief" | "standard" | "full";
  varConfig?: {
    confidence?: 95 | 99;
    horizonDays?: 1 | 10;
  };
  /**
   * MONEY-396 (Document Vault) — UserDocument ids the user pinned to this run
   * (from the research modal's vault panel). Forwarded to the worker, which
   * retrieves the docs' embedded chunks STRICTLY scoped to this userId and
   * cites them in the report. Sanitized before publish (string ids, deduped,
   * capped); the worker retriever re-scopes on userId so a forged/foreign id
   * matches nothing (no IDOR).
   */
  pinnedUserDocumentIds?: string[];
}

export async function startResearchAction(
  userIdOrQuery: string,
  queryOrSkill?: string,
  skillOrSymbols?: string | string[],
  symbolsOrMode?: string[] | "fast" | "advanced",
  modeParam?: "fast" | "advanced",
  extras?: ResearchActionExtras
): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  try {
    // Support both calling conventions:
    // 1. startResearchAction(userId, query, skill?, symbols?, mode?) -- old callers
    // 2. startResearchAction(query, skill?, symbols?, mode?) -- new callers (userId from auth)
    let userId: string;
    let query: string;
    let skill: string | undefined;
    let symbols: string[] | undefined;
    let mode: "fast" | "advanced" | undefined;

    // Detect if first arg is a query (new convention) or userId (old convention)
    // Old convention: userId is a MongoDB ObjectId (24 hex chars) or Clerk ID (starts with "user_")
    if (looksLikeUserId(userIdOrQuery) && queryOrSkill) {
      // Old convention: startResearchAction(userId, query, skill?, symbols?, mode?)
      userId = userIdOrQuery;
      query = queryOrSkill;
      skill = typeof skillOrSymbols === "string" ? skillOrSymbols : undefined;
      symbols = Array.isArray(symbolsOrMode)
        ? symbolsOrMode
        : Array.isArray(skillOrSymbols)
          ? skillOrSymbols
          : undefined;
      mode =
        modeParam ||
        (typeof symbolsOrMode === "string"
          ? (symbolsOrMode as "fast" | "advanced")
          : undefined);
    } else {
      // New convention: startResearchAction(query, ...) -- get userId from auth()
      const authUser = await getAuthenticatedUser();
      if (!authUser) {
        return { success: false, error: "Unauthorized" };
      }
      userId = authUser.userId;
      query = userIdOrQuery;
      skill = typeof queryOrSkill === "string" ? queryOrSkill : undefined;
      symbols = Array.isArray(skillOrSymbols) ? skillOrSymbols : undefined;
      mode =
        typeof symbolsOrMode === "string"
          ? (symbolsOrMode as "fast" | "advanced")
          : modeParam;
    }

    // MONEY-1073 — normalize + fund-detect at the FUNNEL. Every caller reaches
    // here (chat fast-path, Flash, a follow-up turn resolved from conversation
    // history, the /mf ResearchModal), so fund routing must NOT depend on a
    // classifier hint that only some paths carry: a follow-up ("detailed
    // deep-dive") loses the `[Mentioned:]` context the fast-path keys on and is
    // resolved from history by Flash — verbatim, so it arrives as "@140288".
    // Strip that `@`, then treat a lone all-digit symbol as an AMFI scheme code.
    if (symbols && symbols.length > 0) {
      symbols = symbols.map(stripMentionPrefix).filter((s) => s.length > 0);
    }
    const schemeCodeRun = isSchemeCodeRun(symbols);

    // MONEY-446 — single-fund StockSage. Force the `mf-analysis` skill so
    // an MF run routes deterministically: the `[MUTUAL_FUND] …` query text
    // does NOT match the skill's matchSkill() triggers, so without this hint
    // the planner would fall through to a generic LLM plan. `assetType` is
    // an opt-in extra; stock/etf callers are untouched.
    const isMfAnalysis = extras?.assetType === "mf" || schemeCodeRun;
    if (isMfAnalysis && !skill) {
      skill = "mf-analysis";
    }
    // MONEY-1073 — a fund run that arrived via Flash carries a plain query
    // ("detailed deep-dive"); shape it so BOTH the equity-validation skip below
    // and the worker's fund path recognise it. Already-shaped queries (the
    // fast-path / ResearchModal `[MUTUAL_FUND] <name>`) are left untouched.
    if (isMfAnalysis && !isFundShapedQuery(query)) {
      query = `[MUTUAL_FUND] ${query}`;
    }
    // MONEY-1073 — a fund run must NOT ship the STOCK skill pack. This mirrors
    // MONEY-806 on the ResearchModal path (`isMfRun ? [] : resolveEffective…`),
    // which the chat path never had: the chat route resolves the user's saved
    // preset skills and forwards them for EVERY run, so a fund inherited
    // DCF / quant-factor / VaR / technicals. Those can't produce anything for a
    // fund — they only inflate the plan (an 18-task stock plan that timed out
    // at 8/18 on price-history / factor-scores / volume-profile / position-VaR
    // before a single MF tool ran) while still billing their compute. The
    // forced `mf-analysis` skill stands on its own.
    const effectiveCustomSkills = isMfAnalysis
      ? undefined
      : extras?.customSkills;

    // Auto-detect comparison: multiple symbols without explicit skill → peer-comparison
    ({ skill, mode } = autoDetectComparison(symbols, skill, mode));

    // Validate symbols against InstrumentMapping (Indian stocks only)
    // Skip validation for fund-shaped queries - both mutual funds (prefixed
    // with [MUTUAL_FUND]) and ETFs (prefixed with [ETF]) bypass the
    // equity-only symbol validation. ETF symbols are tradable on exchanges
    // so they'd resolve via InstrumentMapping, but the research engine
    // applies fund-shaped skills downstream regardless.
    const isFundQuery = isFundShapedQuery(query);

    if (symbols && symbols.length > 0 && !isFundQuery) {
      const invalidSymbols: string[] = [];
      const resolvedSymbols: string[] = [];

      // MONEY-709 — O(1) + residual, not O(2N) serial.
      //
      // This was one `findFirst` per symbol, plus a second `contains` /
      // `mode: "insensitive"` lookup per miss — up to 2N SEQUENTIAL round
      // trips before the research run even starts, on a premium path a user is
      // watching. The name fallback is the expensive half: an unanchored
      // case-insensitive `contains` is a regex scan.
      //
      // Now: ONE batched exact-symbol query for every symbol, then the name
      // fallback only for what actually missed, and those in parallel. A
      // typical 3-symbol comparison goes from 3–6 serial queries to 1, or 2
      // rounds when a company name was used instead of a ticker.
      const cleanedSymbols = symbols.map((sym) => cleanSymbol(sym));

      const exactRows = await prisma.instrumentMapping.findMany({
        where: { symbol: { in: cleanedSymbols }, isActive: true },
        select: { id: true, symbol: true },
      });
      const exactBySymbol = new Map(exactRows.map((r) => [r.symbol, r]));

      // Only the misses need the expensive name scan. De-duplicated, because a
      // query naming the same company twice should not pay for it twice.
      const misses = [
        ...new Set(cleanedSymbols.filter((c) => !exactBySymbol.has(c))),
      ];
      const nameHits = new Map<string, { id: string; symbol: string }>();
      if (misses.length > 0) {
        // BOUNDED, not a bare `Promise.all` over every miss. Each of these is
        // an unanchored case-insensitive `contains` — a regex COLLSCAN — and
        // `symbols` is not capped on this path (apps/api caps at 20, but
        // `startResearchAction` has no Zod gate, and the screener's bulk
        // compare lets a user select up to 200). Firing 200 COLLSCANs at once,
        // BEFORE the credit gate, is a free denial-of-service.
        //
        // Caught by review: the same branch that wrote "Bounded, NOT
        // Promise.all" in broker-sync.service.ts left this one unbounded.
        const found = await mapWithConcurrency(
          misses,
          SYMBOL_RESOLVE_CONCURRENCY,
          (cleaned) =>
            prisma.instrumentMapping.findFirst({
              where: {
                name: { contains: cleaned, mode: "insensitive" },
                isActive: true,
                exchange: "NSE",
              },
              select: { id: true, symbol: true },
            })
        );
        misses.forEach((cleaned, i) => {
          const row = found[i];
          if (row) nameHits.set(cleaned, row);
        });
      }

      // Resolution order is preserved deliberately: `resolvedSymbols` feeds the
      // research run and `invalidSymbols` feeds a user-facing error listing the
      // symbols in the order they were given.
      for (const cleaned of cleanedSymbols) {
        const exact = exactBySymbol.get(cleaned);
        if (exact) {
          resolvedSymbols.push(exact.symbol);
          continue;
        }

        // Fallback: matched by company name (handles "HINDUSTAN AERONAUTICS" → "HAL")
        const byName = nameHits.get(cleaned);
        if (byName) {
          resolvedSymbols.push(byName.symbol);
          // Also fix the query if it contains the company name. Still done here
          // rather than in the parallel pass, so rewrites apply in input order
          // and a later symbol cannot overwrite an earlier one's substitution.
          query = query.replace(new RegExp(cleaned, "gi"), byName.symbol);
          continue;
        }

        invalidSymbols.push(cleaned);
      }

      if (invalidSymbols.length > 0) {
        return {
          success: false,
          error: formatInvalidSymbolError(invalidSymbols),
        };
      }

      // Use resolved symbols (may differ from input if name→symbol resolution occurred)
      symbols = resolvedSymbols;
    }

    // ── Credit consumption ──────────────────────────────────────────
    // Determine credit cost based on mode + comparison stock count
    const isComparison =
      skill === "peer-comparison" || (symbols && symbols.length > 1);
    let creditAction: string;
    let totalCreditCost: number;

    if (isMfAnalysis) {
      // MONEY-446 — single-fund StockSage deep dive. Bill via the
      // `mf_analysis` estimate: a heavier-than-single-stock cost that
      // scales with the number of underlying constituents the analysis
      // examines and is clamped to a hard cap of 30. Consume from the
      // unified credit pool (same pool the rest of the research surface
      // uses) so it stays refundable on publish failure below.
      const mfEstimate = estimateAnalysisCost("mf_analysis", symbols, {
        underlyingStocks: extras?.underlyingStocks,
      });
      totalCreditCost = mfEstimate.credits;
      creditAction = "l2_research_advanced";
    } else if (isComparison && symbols && symbols.length > 1) {
      // Comparison: 3 base + 2 per additional entity
      const baseCost = CREDIT_COSTS["l3_multi_comparison_base"] ?? 3;
      const perStockCost = CREDIT_COSTS["l3_multi_comparison_per_stock"] ?? 2;
      totalCreditCost =
        baseCost + perStockCost * Math.max(0, symbols.length - 1);
      creditAction = "l3_multi_comparison_base";
    } else if (mode === "advanced") {
      creditAction = "l2_research_advanced";
      totalCreditCost = CREDIT_COSTS[creditAction] ?? 3;
    } else {
      creditAction = "l2_research_fast";
      totalCreditCost = CREDIT_COSTS[creditAction] ?? 1;
    }

    // MONEY-229 - apply per-model credit premium on top of the base
    // cost. The model preference is set via the popover and validated
    // by Zod against the registered IDs (Phase B). Plan-gating happens
    // at the picker (Phase D) and chat route (Phase E); here we only
    // need the modelId to compute the premium. Unknown / null IDs fall
    // through getModelPremium → 0, so cost stays at baseCost.
    //
    // MONEY-619 (Phase 3) - resolve the research model from the user's REAL
    // plan tier via the single-source-of-truth registry. FREE stays on
    // gemini-2.5-pro (chat is Flash + rate-limited; research uses Pro);
    // PRO/PREMIUM now default to the tier Pro model (gemini-3.1-pro-preview on
    // the Gemini Developer API; an unknown id degrades to gemini-2.5-pro)
    // rather than 2.5-flash. An explicit Pro-tier composer pick the plan allows is
    // honored; the resolved id then drives the per-model credit premium.
    const composerPrefs =
      await preferencesService.getComposerPreferences(userId);
    const subscription = await prisma.subscription.findUnique({
      where: { userId },
      select: { planId: true },
    });
    const resolvedModelId = resolveResearchModel(
      subscription?.planId ?? "FREE",
      composerPrefs.model
    );
    const baseCostForAction = totalCreditCost;
    totalCreditCost = getEffectiveCreditCost(
      creditAction,
      resolvedModelId,
      baseCostForAction
    );

    // MONEY-446 — the `mf_analysis` estimate already carries its own hard
    // cap (30). The per-model premium is still applied above (a Pro model
    // costs more, consistent with the rest of the research surface), but
    // re-clamp so the premium can never push a single-fund deep dive past
    // its ceiling.
    if (isMfAnalysis) {
      totalCreditCost = Math.min(totalCreditCost, 30);
    }

    // Consume credits (for comparisons with per-stock scaling, consume
    // the total amount using the base action key for tracking)
    const creditResult = await consumeCredits(userId, creditAction, {
      symbols,
      query,
      tier: isComparison ? "L3" : mode === "advanced" ? "L2" : "L2",
      geminiModel: resolvedModelId,
      costOverride: totalCreditCost,
    });

    if (!creditResult.success) {
      return {
        success: false,
        error:
          creditResult.error ||
          `Insufficient credits. This action costs ${totalCreditCost} credits.`,
      };
    }

    // If comparison costs more than the base action, consume the extra per-stock credits
    if (
      isComparison &&
      symbols &&
      symbols.length > 1 &&
      totalCreditCost > (CREDIT_COSTS["l3_multi_comparison_base"] ?? 3)
    ) {
      const extraCredits =
        totalCreditCost - (CREDIT_COSTS["l3_multi_comparison_base"] ?? 3);
      if (extraCredits > 0) {
        await consumeCredits(userId, "l3_multi_comparison_per_stock", {
          symbols,
          query,
          tier: "L3",
        });
      }
    }

    const sessionId = uuidv4();
    const jobId = uuidv4();

    // Create research session in DB
    await prisma.researchSession.create({
      data: {
        userId,
        sessionId,
        jobId,
        query,
        skill,
        symbols: symbols || [],
        status: "PLANNING",
        progress: 0,
        scratchpad: [],
        contentBlocks: [],
      },
    });

    // MONEY-779 — sanitize the institutional run-parameters before they reach
    // the worker (and ultimately compute_dcf / compute_wacc / compute_var
    // RAW). `extras` is a hint, not a contract: both the ResearchModal and the
    // chat run-path forward loosely-coerced objects, so an out-of-range value
    // (a fat-fingered WACC=50, a 99.9 confidence) could otherwise flow straight
    // into the valuation math. We validate each field independently against the
    // server schemas (researchAssumptionsSchema / researchVarConfigSchema) and
    // DROP only the offending field — keeping any sibling that is in-bounds —
    // so a single bad input never silently corrupts the whole assumption set.
    const safeAssumptions = sanitizeAgainstSchema(
      preferencesService.researchAssumptionsSchema,
      extras?.assumptions
    );
    const safeVarConfig = sanitizeAgainstSchema(
      preferencesService.researchVarConfigSchema,
      extras?.varConfig
    );

    // MONEY-396 (Document Vault) — sanitize the pinned doc ids: keep non-empty
    // strings, dedupe, cap at 10. Even an unsanitized id is harmless (the
    // worker retriever filters on THIS userId, so a forged id matches nothing),
    // but bound + clean it defensively before it crosses the wire.
    const safePinnedDocIds = Array.isArray(extras?.pinnedUserDocumentIds)
      ? Array.from(
          new Set(
            extras.pinnedUserDocumentIds
              .filter(
                (d): d is string => typeof d === "string" && d.trim().length > 0
              )
              .map((d) => d.trim())
          )
        ).slice(0, 10)
      : [];

    // Publish to Pub/Sub for worker processing
    try {
      await publishResearchJob({
        jobId,
        userId,
        sessionId,
        query,
        skill,
        symbols,
        // Default to "advanced" so the synthesizer emits the full
        // sections array + scoreBreakdown + all 11 standard sections
        // (Business Overview, Financial Performance, Valuation, SWOT,
        // Technicals, etc.). The "fast" prompt only outputs summary +
        // strengths + risks, which is why advanced reports were
        // showing as bare bullet lists despite the "Advanced" badge.
        // Callers that explicitly want fast must pass mode="fast".
        mode: mode || "advanced",
        // MONEY-1073 — `effectiveCustomSkills` is `undefined` for a fund run so
        // the stock skill pack never reaches the worker planner (see above).
        ...(effectiveCustomSkills && effectiveCustomSkills.length > 0
          ? { customSkills: effectiveCustomSkills }
          : {}),
        ...(extras?.researchFocus
          ? { researchFocus: extras.researchFocus }
          : {}),
        ...(extras?.preset ? { preset: extras.preset } : {}),
        // MONEY-794 (C1c) - institutional run-parameters. Each is forwarded
        // only when set so the worker plan/report stays byte-identical to
        // today's for callers that omit them.
        ...(extras?.horizon ? { horizon: extras.horizon } : {}),
        ...(extras?.benchmark ? { benchmark: extras.benchmark } : {}),
        ...(safeAssumptions ? { assumptions: safeAssumptions } : {}),
        ...(extras?.reportLength ? { reportLength: extras.reportLength } : {}),
        ...(safeVarConfig ? { varConfig: safeVarConfig } : {}),
        // MONEY-396 (Document Vault) - pinned user-document ids → worker RAG.
        ...(safePinnedDocIds.length
          ? { pinnedUserDocumentIds: safePinnedDocIds }
          : {}),
        // MONEY-587 (task #36) - thread the user-chosen model to the worker
        // synthesizer + validator. Prefer the chat route's explicit
        // override (extras.model), else the model we already resolved above
        // for the credit-premium calc (FREE → 2.5-pro, paid → saved pref).
        // The worker degrades unknown/env-gated ids to the advanced default.
        model: extras?.model ?? resolvedModelId,
      });
    } catch (pubsubError) {
      console.error("[research] Failed to publish to Pub/Sub:", pubsubError);
      // Refund credits on publish failure
      refundCredits(userId, creditAction).catch((err) =>
        console.error("[research] Failed to refund credits:", err)
      );
      await prisma.researchSession.update({
        where: { sessionId },
        data: {
          status: "FAILED",
          errorMessage: "Failed to queue research job",
        },
      });
      return { success: false, error: "Failed to queue research job" };
    }

    return { success: true, sessionId };
  } catch (error) {
    console.error("[research] Failed to start research:", error);
    return { success: false, error: "Failed to start research" };
  }
}

/**
 * Get research session status
 */
export async function getResearchStatusAction(
  sessionId: string,
  completedTaskIds?: string[]
): Promise<{
  success: boolean;
  data?: {
    status: string;
    progress: number;
    currentStep?: string;
    qualityScore?: number;
    query?: string;
    symbols?: string[];
    errorMessage?: string;
    skill?: string;
    totalSteps?: number;
    taskProgress?: Array<{
      id: string;
      tool: string;
      type: string;
      status: string;
      durationMs?: number;
      resultSummary?: unknown;
    }>;
  };
  error?: string;
}> {
  if (await isDemoSession()) {
    if (sessionId === "demo-research-1" || sessionId === "demo-research-2") {
      return { success: true, data: { status: "COMPLETED", progress: 100 } };
    }
    return { success: false, error: "Research session not found" };
  }

  try {
    // MONEY-286: scope the session lookup to the authenticated user so
    // a guessed sessionId from another account returns "not found"
    // rather than leaking their research progress + symbols.
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }
    const result = await getResearchStatusService(
      sessionId,
      completedTaskIds,
      authUser.userId
    );
    if (!result?.success) {
      return { success: false, error: result?.error };
    }
    return { success: true, data: result?.data };
  } catch (error) {
    console.error("[research] Failed to get status:", error);
    return { success: false, error: "Failed to get research status" };
  }
}

/**
 * Get research session result (report)
 */
export async function getResearchResultAction(sessionId: string): Promise<{
  success: boolean;
  data?: {
    sessionId: string;
    report: unknown;
    contentBlocks: unknown[];
    qualityScore?: number;
    tokensUsed: number;
    symbols: string[];
    totalSteps?: number;
    skill?: string;
    plan?: unknown;
  };
  error?: string;
}> {
  if (await isDemoSession()) {
    const demoMap: Record<string, typeof demoResearchDetail> = {
      "demo-research-1": demoResearchDetail,
      "demo-research-2": demoResearchDetail2,
    };
    const detail = demoMap[sessionId];
    if (detail) {
      return {
        success: true,
        data: detail as unknown as {
          sessionId: string;
          report: unknown;
          contentBlocks: unknown[];
          qualityScore?: number;
          tokensUsed: number;
          symbols: string[];
          totalSteps?: number;
          skill?: string;
          plan?: unknown;
        },
      };
    }
    return { success: false, error: "Research session not found" };
  }

  try {
    // MONEY-286: scope the lookup to the authenticated user. A guessed
    // sessionId from another account must resolve as "not found", not
    // leak the full research report (symbols, plan, content blocks).
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }
    const result = await getResearchResultService(sessionId, authUser.userId);
    if (!result?.success) {
      return { success: false, error: result?.error };
    }
    return { success: true, data: result?.data };
  } catch (error) {
    console.error("[research] Failed to get result:", error);
    return { success: false, error: "Failed to get research result" };
  }
}

/**
 * Get recent research sessions for the current user (last 24h).
 * Used to reconcile ActionBlock state on chat reload.
 */
export async function getRecentResearchSessionsAction(): Promise<{
  success: boolean;
  data?: Array<{
    sessionId: string;
    query: string;
    status: string;
    progress: number;
    currentStep?: string;
  }>;
  error?: string;
}> {
  if (await isDemoSession()) {
    return { success: true, data: [] };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }

    const result = await getRecentResearchSessionsService(authUser.userId);
    if (!result?.success) {
      return { success: false, error: result?.error };
    }
    return { success: true, data: result?.data };
  } catch (error) {
    console.error("[research] Failed to get recent sessions:", error);
    return { success: false, error: "Failed to get recent research sessions" };
  }
}

/**
 * Get running (in-progress) research sessions for the current user.
 * Used by the analysis homepage "Running Research" section.
 */
export async function getRunningResearchAction(): Promise<{
  success: boolean;
  data?: Array<{
    sessionId: string;
    query: string;
    status: string;
    progress: number;
    currentStep?: string;
    symbols: string[];
    createdAt: Date;
  }>;
  error?: string;
}> {
  if (await isDemoSession()) {
    return { success: true, data: [] };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }

    const result = await getRunningResearchService(authUser.userId);
    if (!result?.success) {
      return { success: false, error: result?.error };
    }
    return { success: true, data: result?.data };
  } catch (error) {
    console.error("[research] Failed to get running sessions:", error);
    return { success: false, error: "Failed to get running research sessions" };
  }
}

/**
 * Cancel a running research session.
 * Marks it as FAILED so the worker (if still processing) will see the status
 * change and can stop early. The Pub/Sub message will still be acked normally.
 */
export async function cancelResearchAction(
  sessionId: string
): Promise<{ success: boolean; error?: string }> {
  if (await isDemoSession()) {
    return { success: false, error: "Demo mode" };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }

    const result = await cancelResearchService(authUser.userId, sessionId);
    if (!result?.success) {
      return { success: false, error: result?.error };
    }
    return { success: true };
  } catch (error) {
    console.error("[research] Failed to cancel session:", error);
    return { success: false, error: "Failed to cancel research" };
  }
}

/**
 * Delete a research session and its associated chat history.
 */
export async function deleteResearchAction(
  sessionId: string
): Promise<{ success: boolean; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }

    const result = await deleteResearchService(authUser.userId, sessionId);
    if (!result?.success) {
      return { success: false, error: result?.error };
    }
    return { success: true };
  } catch (error) {
    console.error("[research] Failed to delete session:", error);
    return { success: false, error: "Failed to delete research session" };
  }
}

/**
 * Get research history for the current user (all completed sessions).
 * Used for the analysis page's past research list.
 * Supports pagination: page (1-based) and pageSize.
 */
export async function getResearchHistoryAction(
  page = 1,
  pageSize = 20
): Promise<{
  success: boolean;
  data?: {
    items: Array<{
      sessionId: string;
      query: string;
      status: string;
      symbols: string[];
      skill?: string;
      qualityScore?: number;
      reportScore?: number;
      recommendation?: string;
      createdAt: Date;
      completedAt?: Date;
      errorMessage?: string;
    }>;
    total: number;
  };
  error?: string;
}> {
  if (await isDemoSession()) {
    return {
      success: true,
      data: {
        items: demoResearchHistory as unknown as Array<{
          sessionId: string;
          query: string;
          status: string;
          symbols: string[];
          qualityScore?: number;
          reportScore?: number;
          createdAt: Date;
          completedAt?: Date;
          errorMessage?: string;
          report?: unknown;
        }>,
        total: (demoResearchHistory as unknown[]).length,
      },
    };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }

    const result = await getResearchHistoryService(
      authUser.userId,
      page,
      pageSize
    );
    if (!result?.success) {
      return { success: false, error: result?.error };
    }
    return { success: true, data: result?.data };
  } catch (error) {
    console.error("[research] Failed to get research history:", error);
    return { success: false, error: "Failed to get research history" };
  }
}

/**
 * MONEY-798 (P3c) — RAG corpus-coverage for a symbol.
 *
 * Returns how much of a symbol's `StockDocument` corpus is embedded into the RAG
 * index (`embedded`/`total`, `pct`) vs still awaiting extraction/embedding
 * (`pending`). Used to surface corpus health on the research/stock-detail UI.
 * Best-effort: `getRagCoverage` never throws and zeroes out on any error.
 */
export async function getRagCoverageAction(
  symbol: string,
  exchange?: string
): Promise<{ success: boolean; data?: RagCoverage; error?: string }> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }
    if (!symbol || !symbol.trim()) {
      return { success: false, error: "symbol is required" };
    }
    const coverage = await getRagCoverage(symbol, exchange);
    return { success: true, data: coverage };
  } catch (error) {
    console.error("[research] Failed to get RAG coverage:", error);
    return { success: false, error: "Failed to get RAG coverage" };
  }
}
