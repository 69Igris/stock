/**
 * Synthesize Report - Gemini Pro report synthesis → structured JSON
 *
 * Returns parsed JSON with score, recommendation, metrics, etc.
 * Falls back to raw text wrapped in a basic structure if JSON parsing fails.
 */

import { generateWithTimeout } from "@usemoney/core/gemini";
import { getSynthesizerPrompt, buildSynthesizerUserPrompt } from "../prompts";
import { getResearchModel } from "../model-selection";
import type { ResearchToolDef, ToolOutput } from "./types";
import type { ResearchTask, ResearchMode } from "../types";

/**
 * Attempt to parse a JSON response from the LLM.
 * Handles markdown code blocks, leading/trailing whitespace,
 * and truncated JSON output from token-limited responses.
 */
export function parseJsonResponse(
  response: string,
): Record<string, unknown> | null {
  let jsonStr = response.trim();

  // Strip markdown code blocks if present (handles both closed and unclosed fences)
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1]!.trim();
  } else {
    // Unclosed code fence - strip opening fence marker
    const unclosedFence = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*)/);
    if (unclosedFence) {
      jsonStr = unclosedFence[1]!.trim();
    }
  }

  // 1. Try full JSON parse
  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 2. Try to find a complete JSON object
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed === "object" && parsed !== null) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Continue to truncated JSON recovery
      }
    }
  }

  // 3. Truncated JSON recovery - extract known fields via regex
  return extractFieldsFromTruncatedJson(jsonStr);
}

/**
 * Extract known report fields from truncated/incomplete JSON using regex.
 * This handles cases where Gemini's output was cut off mid-response.
 */
export function extractFieldsFromTruncatedJson(
  raw: string,
): Record<string, unknown> | null {
  // Must look like it was trying to be JSON
  if (!raw.includes('"score"') && !raw.includes('"recommendation"')) {
    return null;
  }

  const result: Record<string, unknown> = {};

  // Extract simple numeric fields
  const numFields = ["score", "confidence"];
  for (const field of numFields) {
    const m = raw.match(new RegExp(`"${field}"\\s*:\\s*(\\d+(?:\\.\\d+)?)`));
    if (m) result[field] = Number(m[1]);
  }

  // Extract simple string fields
  const strFields = ["recommendation", "disclaimer"];
  for (const field of strFields) {
    const m = raw.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`));
    if (m) result[field] = m[1];
  }

  // Extract summary (may be long - use greedy match up to next key)
  const summaryMatch = raw.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/);
  if (summaryMatch) {
    result.summary = summaryMatch[1]!
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"');
  }

  // Extract string arrays (strengths, risks)
  for (const field of ["strengths", "risks"]) {
    const arrMatch = raw.match(
      new RegExp(`"${field}"\\s*:\\s*\\[([\\s\\S]*?)\\]`),
    );
    if (arrMatch) {
      const items: string[] = [];
      const strRegex = /"((?:[^"\\]|\\.)*)"/g;
      let m: RegExpExecArray | null;
      while ((m = strRegex.exec(arrMatch[1]!)) !== null) {
        items.push(m[1]!.replace(/\\"/g, '"'));
      }
      if (items.length > 0) result[field] = items;
    }
  }

  // Only return if we extracted at least score or recommendation
  if (result.score !== undefined || result.recommendation !== undefined) {
    console.log(
      "[parseJsonResponse] Recovered fields from truncated JSON:",
      Object.keys(result).join(","),
    );
    return result;
  }

  return null;
}

/**
 * Validate that the parsed JSON has required fields for a research report.
 */
export function validateReportStructure(
  report: Record<string, unknown>,
): boolean {
  return (
    typeof report.score === "number" &&
    typeof report.recommendation === "string" &&
    typeof report.summary === "string"
  );
}

/** Check if a value is a positive number (rejects strings, null, NaN) */
function isPositiveNum(v: unknown): v is number {
  return typeof v === "number" && v > 0 && Number.isFinite(v);
}

/**
 * Extract price data from completed research tasks and enrich priceTarget.
 * When Yahoo fetch or DCF/scenario tools fail, the LLM may omit priceTarget
 * or fill it with "N/A" strings. This ensures we populate from whatever data
 * we have, always preferring real numeric values.
 *
 * MONEY-1060 (RC5a): `fetch_price_history`'s LAST CLOSE is an additional,
 * lowest-priority source for `priceTarget.current`. When the quote / DCF /
 * scenario / ratios sources are all absent it fills `current` so the report
 * still shows a current price — previously priceTarget was DELETED in that case,
 * hiding the price entirely. Exported so the no-shadow unit test drives it.
 *
 * MONEY-1060 (fix 8): benchmark guards on the price-history source. The runtime
 * task objects are full ResearchTasks (id + params — synthesize_report's execute
 * receives them from the executor untouched), so:
 *   - any fetch_price_history task whose `params.symbol` starts with "^" (an
 *     index like ^NSEI planned as a beta benchmark) is SKIPPED — its close is a
 *     benchmark level (e.g. ~24,000), never the subject's price; and
 *   - among the remaining price-history tasks the FIRST valid close wins
 *     (the subject is planned first) instead of the last one overwriting —
 *     benchmark-last plans previously promoted the index close as the price.
 *   A task with NO params stays eligible (defensive: params can be absent on
 *   hand-built task lists), still keep-first.
 *
 * MONEY-1060 (fix 7): when the winning `current` came from a STALE DB-fallback
 * quote row (`stale:true` / `source:"db"`), its `asOf` is threaded onto
 * `priceTarget.currentAsOf` so renderers can say "as of <date>" instead of
 * presenting a week-old close as live.
 */
export function enrichPriceTargetFromTasks(
  report: Record<string, unknown>,
  tasks: Array<{
    id?: string;
    tool: string;
    params?: Record<string, unknown>;
    result?: unknown;
    status?: string;
    metadata?: Record<string, unknown>;
  }>,
): void {
  const completed = tasks.filter((t) => t.status === "completed");
  let current: number | undefined;
  // ISO as-of date of the quote that supplied `current`, set ONLY when that
  // quote is a stale DB-fallback row (fix 7). Cleared when a fresh quote wins.
  let currentAsOf: string | undefined;
  // fetch_price_history last close — the lowest-priority current-price source
  // (RC5a below). Tracked separately and applied AFTER the loop so it can never
  // outrank a real quote / DCF / scenario / ratios value regardless of the
  // order tasks happen to appear in. First eligible (non-benchmark) valid close
  // wins (fix 8) — later tasks never overwrite it.
  let lastClose: number | undefined;
  let low: number | undefined;
  let mid: number | undefined;
  let high: number | undefined;

  for (const task of completed) {
    const r = task.result as Record<string, unknown> | undefined;
    if (!r) continue;

    if (task.tool === "fetch_stock_price") {
      const prices = r as Record<string, Record<string, unknown>>;
      const firstKey = Object.keys(prices)[0];
      if (firstKey) {
        const q = prices[firstKey];
        const p = q?.price ?? q?.regularMarketPrice;
        if (isPositiveNum(p)) {
          current = p;
          // fix 7: label a stale DB-fallback price with its as-of date.
          currentAsOf =
            (q?.stale === true || q?.source === "db") &&
            typeof q?.asOf === "string" &&
            q.asOf.trim()
              ? q.asOf
              : undefined;
        }
      }
    }

    if (task.tool === "compute_dcf") {
      const dcf = r as Record<string, unknown>;
      const iv = dcf.intrinsicValue ?? dcf.intrinsic_value;
      const cp = dcf.currentPrice ?? dcf.current_price;
      if (isPositiveNum(cp) && !current) current = cp;
      if (isPositiveNum(iv)) {
        mid = mid ?? Math.round(iv);
        if (!low) low = Math.round(iv * 0.85);
        if (!high) high = Math.round(iv * 1.15);
      }
    }

    if (task.tool === "compute_scenario_analysis") {
      const scenario = r as Record<string, unknown>;
      const bearObj = scenario.bear as Record<string, unknown> | undefined;
      const baseObj = scenario.base as Record<string, unknown> | undefined;
      const bullObj = scenario.bull as Record<string, unknown> | undefined;
      const bearIV =
        bearObj?.intrinsicValue ?? scenario.bearCase ?? scenario.bear;
      const baseIV =
        baseObj?.intrinsicValue ?? scenario.baseCase ?? scenario.base;
      const bullIV =
        bullObj?.intrinsicValue ?? scenario.bullCase ?? scenario.bull;
      if (isPositiveNum(bearIV)) low = Math.round(bearIV);
      if (isPositiveNum(baseIV)) mid = mid ?? Math.round(baseIV);
      if (isPositiveNum(bullIV)) high = Math.round(bullIV);
      const cp = scenario.currentPrice;
      if (isPositiveNum(cp) && !current) current = cp;
    }

    if (task.tool === "fetch_key_ratios") {
      const ratios = r as Record<string, unknown>;
      const cp = ratios.currentPrice ?? ratios.current_price;
      if (isPositiveNum(cp) && !current) current = cp;
      // Also try targetMeanPrice from Yahoo financial data
      const meta = ratios.metadata as Record<string, unknown> | undefined;
      const tp = meta?.targetMeanPrice ?? ratios.targetMeanPrice;
      if (isPositiveNum(tp) && !mid) mid = Math.round(tp);
    }

    if (task.tool === "fetch_price_history") {
      // RC5a (MONEY-1060): fetch-price-history.ts returns its `data` as an
      // OHLCV bars array ([{ date, open, high, low, close, volume }, …]); some
      // callers wrap it as { prices: [...] }. Normalize both shapes — the LAST
      // bar's close is the most recent traded price. Recorded as the fallback
      // (applied post-loop), never overriding a real quote/DCF/scenario value.
      //
      // fix 8 (MONEY-1060): benchmark tasks (params.symbol "^NSEI" etc.) are
      // skipped — an index close is NOT the subject's price — and the FIRST
      // remaining valid close wins (subject planned first), so a benchmark
      // planned last (stock-risk-analysis) can never overwrite it.
      const sym = task.params?.symbol;
      if (typeof sym === "string" && sym.startsWith("^")) continue;
      if (lastClose !== undefined) continue; // keep-first
      const bars: Array<Record<string, unknown>> = Array.isArray(r)
        ? (r as Array<Record<string, unknown>>)
        : Array.isArray(r.prices)
          ? (r.prices as Array<Record<string, unknown>>)
          : [];
      const close = bars[bars.length - 1]?.close;
      if (isPositiveNum(close)) lastClose = close;
    }
  }

  // RC5a (MONEY-1060): use the price-history last close ONLY when no
  // higher-priority source produced a current price, so the report can still
  // display the stock's current price when quote/DCF/scenario/ratios are all
  // absent — the exact case that previously deleted priceTarget below.
  if (!current && isPositiveNum(lastClose)) current = lastClose;

  const existing = report.priceTarget as Record<string, unknown> | undefined;

  // Check if existing priceTarget has any real numeric values
  const hasValid =
    isPositiveNum(existing?.current) ||
    isPositiveNum(existing?.mid) ||
    isPositiveNum(existing?.low) ||
    isPositiveNum(existing?.high);

  // Always enrich if we have task data and existing values are missing/invalid
  if (current ?? low ?? mid ?? high) {
    const prev =
      existing && typeof existing === "object"
        ? (existing as Record<string, unknown>)
        : {};

    const usedTaskCurrent = !isPositiveNum(prev.current);
    report.priceTarget = {
      ...prev,
      // Use existing value ONLY if it's a real positive number, else use task data
      current: usedTaskCurrent ? current : prev.current,
      low: isPositiveNum(prev.low) ? prev.low : low,
      mid: isPositiveNum(prev.mid) ? prev.mid : mid,
      high: isPositiveNum(prev.high) ? prev.high : high,
    };
    // fix 7 (MONEY-1060): when the current price we filled in came from a
    // stale DB-fallback quote, carry its as-of date so it isn't shown as live.
    if (usedTaskCurrent && current !== undefined && currentAsOf) {
      (report.priceTarget as Record<string, unknown>).currentAsOf = currentAsOf;
    }
  } else if (!hasValid && existing) {
    // priceTarget exists but has no valid values and no task data - remove it
    // so the UI section is hidden rather than showing all N/A
    delete report.priceTarget;
  }
}

/**
 * MONEY-778 (Track B): deterministically surface the fund-overlap chart payloads
 * the LLM can't reliably emit. compute_holdings_overlap produces the exact
 * pairwise matrix + flags; we attach them to the report's overlap section as the
 * design's `heatmap` + `flags` payloads (same convention as 8bf0394e's
 * single-stock chart payloads — exact numbers from the tool, never fabricated).
 * Renderer (FundCompareReport) reads section.heatmap / section.flags. No-op
 * unless a completed compute_holdings_overlap task with real data is present, so
 * non-overlap reports are untouched.
 */
export function enrichOverlapFromTasks(
  report: Record<string, unknown>,
  tasks: Array<{ tool: string; result?: unknown; status?: string }>,
): void {
  const overlapTask = tasks.find(
    (t) => t.tool === "compute_holdings_overlap" && t.status === "completed",
  );
  const r = overlapTask?.result as Record<string, unknown> | undefined;
  if (!r || r.available === false) return;

  const fundIds = Array.isArray(r.fundIds) ? (r.fundIds as string[]) : [];
  const pairwise = Array.isArray(r.pairwise)
    ? (r.pairwise as Array<Record<string, unknown>>)
    : [];
  const flags = Array.isArray(r.flags) ? (r.flags as string[]) : [];

  // Pairwise Jaccard heatmap (diagonal = 100). Exact tool numbers only.
  let heatmap:
    | { rows: string[]; cols: string[]; data: number[][]; colLabel: string }
    | undefined;
  if (fundIds.length >= 2 && pairwise.length) {
    // fundIds are unique (compute_holdings_overlap de-dupes ids); the Map keys
    // assume that — a duplicate would collapse two funds onto one row/col.
    const idx = new Map(fundIds.map((f, i) => [f, i] as const));
    const data: number[][] = fundIds.map((_, i) =>
      fundIds.map((_, j) => (i === j ? 100 : 0)),
    );
    for (const p of pairwise) {
      const a = idx.get(String(p.fundA));
      const b = idx.get(String(p.fundB));
      const v = typeof p.jaccard === "number" ? p.jaccard : null;
      if (a != null && b != null && v != null) {
        data[a]![b] = v;
        data[b]![a] = v;
      }
    }
    heatmap = {
      rows: fundIds,
      cols: fundIds,
      data,
      colLabel: "holdings overlap %",
    };
  }

  // Flags → neutral observation chips (SEBI: data observations, never advice).
  const observations = flags
    .filter((f) => typeof f === "string" && f.trim())
    .map((text) => ({ tone: "blue", text }));

  if (!heatmap && observations.length === 0) return;

  const sections = Array.isArray(report.sections)
    ? (report.sections as Array<Record<string, unknown>>)
    : [];
  // Match the renderer's needles (FundCompareReport.detectFundReport /
  // sectionByTitle): overlap | common holding | holdings overlap.
  let overlapSection = sections.find((s) =>
    /overlap|common holding/i.test(String(s.title ?? "")),
  );
  if (!overlapSection) {
    // The fund-overlap layout (detector + renderer) keys off an overlap-titled
    // section. Create one so the deterministic payloads always land — and the
    // report is detected as a fund-overlap report — even when the LLM omits it.
    overlapSection = { title: "Holdings Overlap", type: "text" };
    if (!Array.isArray(report.sections)) report.sections = [];
    (report.sections as Array<Record<string, unknown>>).push(overlapSection);
  }
  if (heatmap && !overlapSection.heatmap) overlapSection.heatmap = heatmap;
  if (observations.length && !overlapSection.flags)
    overlapSection.flags = observations;
}

export const synthesizeReportTool: ResearchToolDef = {
  name: "synthesize_report",
  description:
    "Synthesize all gathered research data into a structured JSON report with scores, metrics, and analysis",
  category: "synthesis",
  parameters: {
    query: {
      type: "string",
      description: "Original research query",
      required: true,
    },
    tasks: {
      type: "object[]",
      description: "Completed research tasks with results",
      required: true,
    },
    mode: {
      type: "string",
      description: "Research mode: fast or advanced",
      required: false,
      default: "advanced",
    },
    model: {
      type: "string",
      description:
        "Gemini registry model id to synthesize with (e.g. gemini-3.1-pro-preview). Falls back to the advanced config when omitted/unknown/gated.",
      required: false,
    },
    horizon: {
      type: "string",
      description:
        "MONEY-794 (C1c) - analysis horizon (1y/3y/5y) used to frame trends/returns in the user prompt. Omitted = no framing directive.",
      required: false,
    },
    reportLength: {
      type: "string",
      description:
        "MONEY-794 (C1c) - section-depth guidance (brief/standard/full). Omitted/standard = today's prompt depth unchanged.",
      required: false,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const query = params.query as string;
    const tasks = params.tasks as ResearchTask[];
    const mode = (params.mode as ResearchMode) || "advanced";
    const queryType = params.queryType as string | undefined;
    // MONEY-222 - when the user has a recurring "research focus" preference,
    // it gets stamped onto the synthesis task params by
    // applyResearchPreferences so the prompt builder can prepend it as a
    // directive line.
    const researchFocus =
      typeof params.researchFocus === "string" && params.researchFocus.trim()
        ? params.researchFocus.trim()
        : undefined;
    // MONEY-790 (B5) - the user's durable InvestorProfile memory, stamped onto
    // the synthesis task params by the agent. Personalizes the report FRAMING;
    // DESCRIBES the user, never advises a buy/sell (SEBI).
    const memoryContext =
      typeof params.memoryContext === "string" && params.memoryContext.trim()
        ? params.memoryContext.trim()
        : undefined;
    // MONEY-396 (Document Vault) - fenced evidence from the user's pinned
    // documents, stamped onto the synthesis task params by the agent. UNTRUSTED
    // user content (already wrapped in an EXTERNAL DATA boundary by
    // formatPinnedEvidence); forwarded verbatim so the synthesizer prompt keeps
    // it fenced. Personalizes with the user's own sources; never advises (SEBI).
    const pinnedEvidence =
      typeof params.pinnedEvidence === "string" && params.pinnedEvidence.trim()
        ? params.pinnedEvidence
        : undefined;
    // MONEY-587 (task #36) - synthesize with the user-chosen model when the
    // run was billed at a premium for it; otherwise the advanced default.
    const modelId =
      typeof params.model === "string" && params.model.trim()
        ? params.model.trim()
        : undefined;
    // MONEY-794 (C1c) - run-parameters stamped onto the synthesis task params
    // by the agent (applyRunParameters). horizon frames the user prompt;
    // reportLength tunes the system prompt's section-depth guidance. Both
    // optional → today's prompt verbatim when unset.
    const horizon =
      typeof params.horizon === "string" && params.horizon.trim()
        ? params.horizon.trim()
        : undefined;
    const reportLength =
      typeof params.reportLength === "string" && params.reportLength.trim()
        ? params.reportLength.trim()
        : undefined;

    if (!query || !tasks?.length) {
      return { success: false, error: "query and tasks are required" };
    }

    try {
      // MONEY-626: model-driven routing — a Claude id (founder-gated at
      // publish time) resolves to the Claude compat model inside
      // getGeminiModelById; everything else is Gemini.
      const model = getResearchModel(modelId);
      const systemPrompt = getSynthesizerPrompt(mode, queryType, reportLength);
      const userPrompt = buildSynthesizerUserPrompt(
        query,
        tasks,
        researchFocus,
        memoryContext,
        horizon,
        pinnedEvidence,
      );

      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

      // Allow generous timeout for synthesis (120s) - this is the most important step
      // 3 retries with exponential backoff to handle transient 429s
      const response = await generateWithTimeout(model, fullPrompt, 120_000, 3);

      console.log(
        "[synthesize-report] Got response, length:",
        response.length,
        "First 200 chars:",
        response.slice(0, 200),
      );

      // Try to parse as JSON
      const parsed = parseJsonResponse(response);

      if (parsed) {
        // Enrich priceTarget from task data when LLM omits it (e.g. Yahoo fetch failed)
        enrichPriceTargetFromTasks(parsed, tasks);
        // MONEY-778: attach the fund-overlap heatmap + observation flags from
        // the compute_holdings_overlap result (deterministic; no-op otherwise).
        enrichOverlapFromTasks(parsed, tasks);

        // If it has the required fields, great
        if (validateReportStructure(parsed)) {
          console.log(
            "[synthesize-report] Valid structured report. Score:",
            parsed.score,
            "Rec:",
            parsed.recommendation,
          );
          return {
            success: true,
            data: { report: parsed },
          };
        }

        // Partial JSON - still usable, fill in missing fields
        console.warn(
          "[synthesize-report] Partial JSON parsed - filling in defaults. Keys:",
          Object.keys(parsed).join(","),
        );
        return {
          success: true,
          data: {
            report: {
              score: typeof parsed.score === "number" ? parsed.score : 50,
              recommendation:
                typeof parsed.recommendation === "string"
                  ? parsed.recommendation
                  : "N/A",
              confidence:
                typeof parsed.confidence === "number" ? parsed.confidence : 50,
              summary:
                typeof parsed.summary === "string"
                  ? parsed.summary
                  : "Analysis completed but report structure was incomplete.",
              keyMetrics: Array.isArray(parsed.keyMetrics)
                ? parsed.keyMetrics
                : [],
              strengths: Array.isArray(parsed.strengths)
                ? parsed.strengths
                : [],
              risks: Array.isArray(parsed.risks) ? parsed.risks : [],
              ...parsed, // Keep any other fields the LLM returned
              disclaimer:
                typeof parsed.disclaimer === "string"
                  ? parsed.disclaimer
                  : "This is AI-generated analysis for informational purposes only.",
            },
          },
        };
      }

      // JSON parsing completely failed - wrap raw text in a minimal structure
      console.warn(
        "[synthesize-report] JSON parse failed. Raw response (first 500 chars):",
        response.slice(0, 500),
      );

      // Clean the raw text for display - strip code fences and JSON artifacts
      let cleanText = response
        .replace(/```(?:json)?\s*\n?/g, "")
        .replace(/```/g, "")
        .trim();

      // Try to extract a readable summary from the raw text
      // If it looks like JSON, try to pull the "summary" value
      const summaryExtract = cleanText.match(
        /"summary"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/,
      );
      const displaySummary = summaryExtract
        ? summaryExtract[1]!.replace(/\\n/g, "\n").replace(/\\"/g, '"')
        : cleanText.startsWith("{")
          ? "Analysis completed but the report format was unexpected. Please try again."
          : cleanText.slice(0, 500);

      // MONEY-650 (B8): the synthesizer occasionally returns prose / fenced or
      // truncated JSON that fails strict parsing. Previously this path dropped
      // EVERYTHING into `summary` and emitted NO `sections`, so the report BODY
      // rendered blank (only the scorecard + summary showed). Salvage the
      // model's actual written analysis into a single readable section so the
      // user still gets a report body. Skipped when the text is clearly broken
      // JSON (displaySummary already tells the user to retry).
      const looksLikeBrokenJson = cleanText.startsWith("{");
      const salvagedSections =
        !looksLikeBrokenJson && cleanText.length > 0
          ? [{ title: "Analysis", content: cleanText }]
          : [];

      return {
        success: true,
        data: {
          report: {
            score: 50,
            recommendation: "N/A",
            confidence: 50,
            summary: displaySummary,
            keyMetrics: [],
            strengths: [],
            risks: [],
            sections: salvagedSections,
            rawText: response,
            disclaimer:
              "This is AI-generated analysis for informational purposes only.",
          },
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[synthesize-report] Failed:", msg);
      return {
        success: false,
        error: `Report synthesis failed: ${msg}`,
      };
    }
  },
};
