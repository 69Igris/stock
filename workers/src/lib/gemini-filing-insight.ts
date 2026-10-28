/**
 * THE ANALYSIS CALL for an extracted SEC filing exhibit — MONEY-1324 (P17).
 *
 * One entry point, {@link analyzeFilingText}: extracted filing text in, a
 * validated {@link FilingInsight} out. The sweep processor calls this and
 * nothing else; everything it needs to decide what to store is on the result.
 *
 * ## What is reused, and why reuse rather than rebuild
 *
 * Nothing here is a new Gemini client. The document lane built by MONEY-1314
 * already solved every part of this that is not about filings:
 *
 *   `getVertexAIClient()`      the shared client, from @usemoney/core/gemini
 *   `resolveDocParseModel()`   registry-backed model selection (see below)
 *   `createDeadline`/`withDeadline`  a budget that never orphans a timer
 *   `readUsage` / `extractResponseText`  response shape handling, incl. the
 *                              `cachedContentTokenCount` spelling
 *
 * The only genuinely new things are the prompt, the response schema and the
 * checks, and all three are pure and live in
 * `@usemoney/core/market-data/filing-insight-logic`.
 *
 * ## Model selection — DO NOT ADD AN ENV VAR HERE
 *
 * This lane deliberately shares `DOC_PARSE_MODEL` with the document lane
 * rather than introducing `FILING_INSIGHT_MODEL`.
 *
 * MONEY-1314's scar is the argument: `DOC_PARSE_MODEL` was, for a release, in
 * NEITHER cloudbuild spec, so the lane silently pinned to whatever
 * `resolveChatModel("PREMIUM")` returned — a model at roughly four times the
 * intended rate, with no error and no counter to reveal it. That has since
 * been fixed (the variable is present in `workers/cloudbuild.prod.yaml` and
 * `workers/cloudbuild.qa.yaml` today). A NEW variable would start out in the
 * same hole the old one was dug out of: absent from both specs, defaulting
 * silently, and indistinguishable from working.
 *
 * So the choice is between one variable that is specced and observed, and two
 * of which one is neither. If this lane ever genuinely needs a different model
 * from the document lane, add the variable AND both spec entries in the same
 * change — never the code alone.
 *
 * `resolveDocParseModel` also carries the registry checks that matter:
 * `getModelDefinition` (is this id real?) AND `isModelAvailable` (is it
 * switched off?). The second alone returns true for an id the registry has
 * never heard of, so an unknown override would otherwise be forwarded verbatim
 * and 404 per document across the backlog.
 *
 * ## Never throws
 *
 * Every path returns a {@link FilingAnalysisResult}. `failure` tells the
 * caller whether a retry could help: `CALL_FAILED` and `UNCONFIGURED` are
 * retryable, `EMPTY_INPUT` and `UNPARSEABLE` are deterministic and must never
 * be blind-retried. This mirrors `DocParseResult` on purpose — the sweep
 * processor should not have to learn a second convention.
 */

import { getVertexAIClient } from "@usemoney/core/gemini";
import {
  FILING_INSIGHT_SCHEMA,
  buildFilingInsightPrompt,
  normaliseFilingInsight,
  validateFilingInsight,
  type FilingInsight,
  type FilingValidation,
} from "@usemoney/core/market-data/filing-insight-logic";
import {
  selectSectionsForAnalysis,
  normaliseFilingText,
  DEFAULT_MAX_CHARS,
  type FilingSelectionReason,
} from "@usemoney/core/market-data/filing-section-select-logic";

import {
  createDeadline,
  docParseBudgetMs,
  extractResponseText,
  geminiPdfReady,
  readUsage,
  resolveDocParseModel,
  withDeadline,
  type DocParseUsage,
} from "./gemini-pdf";

/**
 * Local, like `gemini-pdf.ts`'s. There is no `workers/src/lib/logger` module —
 * each of these leaves declares its own tagged console shim so the tag names
 * the lane in a Cloud Run log line.
 */
const logger = {
  info: (...args: unknown[]) => console.log("[filing-insight]", ...args),
  warn: (...args: unknown[]) => console.warn("[filing-insight]", ...args),
};

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

/** Deterministic reads. A figure is not a place for sampling. */
export const FILING_INSIGHT_TEMPERATURE = 0;

/**
 * Output ceiling.
 *
 * Larger than the document lane's 8,192 because this response carries
 * `sourceLine` for every figure — a verbatim copy of a fixed-width line, which
 * is 60-80 characters of pure overhead per fact. That cost is deliberate: the
 * source line is what makes a wrong answer diagnosable rather than merely
 * wrong. Smaller than the vision lane's 32,768 because a single exhibit yields
 * far fewer statements than a whole annual report.
 */
export const FILING_INSIGHT_MAX_OUTPUT_TOKENS = 16_384;

export type FilingAnalysisFailure =
  | "FILING_ANALYSIS_UNCONFIGURED"
  | "FILING_ANALYSIS_EMPTY_INPUT"
  | "FILING_ANALYSIS_CALL_FAILED"
  | "FILING_ANALYSIS_UNPARSEABLE";

/** What the selector did, carried so the caller can see a thin selection. */
export interface FilingSelectionSummary {
  reason: FilingSelectionReason;
  totalSections: number;
  selectedSectionIndexes: number[];
  /** Chars actually sent (the selection), not the document's size. */
  sentChars: number;
  /** Chars of the whole normalised document. */
  documentChars: number;
  /** Sections that scored above zero and still did not fit. */
  droppedForBudget: number;
  /** True when the model saw less than the whole document. */
  truncated: boolean;
}

export interface FilingAnalysisResult {
  ok: boolean;
  insight: FilingInsight | null;
  /**
   * The checks, run against THE TEXT THE MODEL SAW.
   *
   * Null only when there is no insight to check. See
   * {@link analyzeFilingText} for why the selected text is the right thing to
   * validate against rather than the whole document.
   */
  validation: FilingValidation | null;
  selection: FilingSelectionSummary;
  model: string;
  usage: DocParseUsage;
  failure: FilingAnalysisFailure | null;
  error: string | null;
  elapsedMs: number;
}

export interface FilingAnalysisInput {
  /** The extracted filing text, exactly as stored under `edgar/text/...`. */
  text: string;
  /** Character budget for the selection. Defaults to the selector's own. */
  maxChars?: number;
  cik?: string | null;
  accession?: string | null;
  formType?: string | null;
  exhibitLabel?: string | null;
  filedAt?: string | null;
  registrantHint?: string | null;
  /** Registry-checked model id. Ignored unless registered AND available. */
  modelOverride?: string | null;
  budgetMs?: number;
  disableThinking?: boolean;
  /** Log label, e.g. the accession. Never a user-facing string. */
  label?: string;
}

/**
 * THE ONE MODEL CALL, injectable.
 *
 * Not a general-purpose client abstraction — it takes exactly what
 * `generateContent` takes here and returns exactly what it returns, so
 * `readUsage` and `extractResponseText` still run against a real response
 * SHAPE rather than a convenient one. That matters: those two functions carry
 * the `cachedContentTokenCount` spelling and the split-parts handling, and a
 * fake that returned `{text, usage}` would leave both untested.
 *
 * It exists because the alternative is that NOTHING can execute this function
 * without spending a metered Gemini call. In particular the property this lane
 * turns on — that validation runs against the SELECTED text and not the whole
 * document — is a wiring fact between three lines of this file, and a test
 * that cannot run them cannot see it break.
 */
export type FilingModelCall = (request: {
  readonly model: string;
  readonly prompt: string;
  readonly generationConfig: Record<string, unknown>;
}) => Promise<unknown>;

export interface FilingAnalysisDeps {
  /**
   * Replaces the Gemini call. TESTS ONLY — there is no env var and no config
   * that can set it, so an injected call is always a visible argument at a
   * visible call site, never something an environment can switch on.
   */
  readonly generate?: FilingModelCall;
}

const EMPTY_USAGE: DocParseUsage = {
  promptTokens: 0,
  candidatesTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  thinkingTokens: 0,
};

function emptySelection(documentChars: number): FilingSelectionSummary {
  return {
    reason: "empty",
    totalSections: 0,
    selectedSectionIndexes: [],
    sentChars: 0,
    documentChars,
    droppedForBudget: 0,
    truncated: false,
  };
}

/**
 * Pull the JSON object out of a model response.
 *
 * Strips a ```json fence when the model adds one despite
 * `responseMimeType: "application/json"` — it occasionally does, and treating
 * that as unparseable would discard a perfectly good answer. Returns null
 * rather than throwing on anything it cannot read, so the caller's failure
 * classification stays in one place.
 */
export function parseFilingInsightJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The generation config for this lane. */
export function buildFilingGenerationConfig(opts?: {
  disableThinking?: boolean;
  maxOutputTokens?: number;
}): Record<string, unknown> {
  return {
    temperature: FILING_INSIGHT_TEMPERATURE,
    maxOutputTokens: opts?.maxOutputTokens ?? FILING_INSIGHT_MAX_OUTPUT_TOKENS,
    responseMimeType: "application/json",
    responseSchema: FILING_INSIGHT_SCHEMA,
    ...(opts?.disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
  };
}

/**
 * Read one filing exhibit and return what it says.
 *
 * THE PURE INTERFACE THE SWEEP PROCESSOR CALLS. Text in, structured insight
 * out. The processor supplies the bytes it read from GCS and whatever it knows
 * about the filing; it does not need to know about selection, prompts,
 * schemas, models or budgets.
 *
 * Three things happen, in order:
 *
 *   1. SELECT. The text is cut into sections and packed to `maxChars`. A
 *      document under budget is passed whole and `selection.truncated` is
 *      false. The model is TOLD when it received a selection, because a model
 *      that thinks it has the whole document will reason about what is missing
 *      from it.
 *   2. ASK. One call, prompt-first so the ~5.1k-token fixed prefix leads the
 *      request and earns the implicit cache discount.
 *   3. CHECK. Every figure is grounded against the text and every printed
 *      total is cross-footed against its components.
 *
 * VALIDATION RUNS AGAINST THE SELECTED TEXT, NOT THE WHOLE DOCUMENT, and the
 * difference is not cosmetic. Grounding against the full document would accept
 * a figure the model could not have seen — which is precisely the shape of a
 * hallucination that happens to collide with a real number elsewhere in a
 * 1.7 MB filing. The model is accountable for what it was shown.
 *
 * The insight is returned even when validation fails. `ok` reflects BOTH the
 * call and the checks, so a caller that wants only clean readings can gate on
 * it, while a caller triaging a bad batch still has the payload and the
 * specific issues. Nothing is repaired and no value is rewritten.
 */
export async function analyzeFilingText(
  input: FilingAnalysisInput,
  deps: FilingAnalysisDeps = {},
): Promise<FilingAnalysisResult> {
  const startedAt = Date.now();
  const label = input.label ?? input.accession ?? "filing";
  const model = resolveDocParseModel(input.modelOverride);

  const fail = (
    failure: FilingAnalysisFailure,
    error: string,
    selection: FilingSelectionSummary,
  ): FilingAnalysisResult => ({
    ok: false,
    insight: null,
    validation: null,
    selection,
    model,
    usage: EMPTY_USAGE,
    failure,
    error,
    elapsedMs: Date.now() - startedAt,
  });

  if (typeof input.text !== "string" || input.text.trim() === "") {
    return fail(
      "FILING_ANALYSIS_EMPTY_INPUT",
      "filing text is empty",
      emptySelection(0),
    );
  }

  const selected = selectSectionsForAnalysis(input.text, {
    maxChars: input.maxChars ?? DEFAULT_MAX_CHARS,
  });

  // Every section scored at or below zero — a document of pure prose with no
  // heading the selector recognises. Deterministic: retrying spends a request
  // to receive the same empty selection.
  if (selected.text.trim() === "") {
    return fail(
      "FILING_ANALYSIS_EMPTY_INPUT",
      "selection produced no text",
      emptySelection(input.text.length),
    );
  }

  // Measured on the NORMALISED text, so `sentChars / documentChars` is a
  // ratio of like for like. Comparing the selection against the raw bytes
  // would understate it by the 25-35% of trailing padding the normaliser
  // removes, and an operator reading "we sent 40% of the document" when we
  // sent 60% of its content would tune the budget the wrong way.
  const selection: FilingSelectionSummary = {
    reason: selected.reason,
    totalSections: selected.totalSections,
    selectedSectionIndexes: selected.selectedSectionIndexes,
    sentChars: selected.totalChars,
    documentChars: normaliseFilingText(input.text).length,
    droppedForBudget: selected.droppedForBudget,
    truncated: selected.reason === "scored",
  };

  // An INJECTED call has no backend to be ready — checking the environment
  // would refuse every test before it started. The check still guards the real
  // path, which is the only path any deployment can take.
  if (deps.generate === undefined && !geminiPdfReady()) {
    return fail(
      "FILING_ANALYSIS_UNCONFIGURED",
      "no Gemini backend configured (GOOGLE_GENAI_API_KEY / GCP_PROJECT_ID)",
      selection,
    );
  }

  const prompt = buildFilingInsightPrompt({
    text: selected.text,
    cik: input.cik ?? null,
    accession: input.accession ?? null,
    formType: input.formType ?? null,
    exhibitLabel: input.exhibitLabel ?? null,
    filedAt: input.filedAt ?? null,
    registrantHint: input.registrantHint ?? null,
    truncated: selection.truncated,
  });

  const deadline = createDeadline(input.budgetMs ?? docParseBudgetMs());

  const generationConfig = buildFilingGenerationConfig({
    disableThinking: input.disableThinking,
  });

  try {
    const call =
      deps.generate ??
      ((request): Promise<unknown> => {
        const client = getVertexAIClient();
        const handle = client.getGenerativeModel({
          model: request.model,
          generationConfig: request.generationConfig,
        });
        return handle.generateContent({
          contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        });
      });

    const response = await withDeadline(
      call({ model, prompt, generationConfig }),
      deadline,
      `filing-insight(${label})`,
    );

    const usage = readUsage(response);
    const raw = parseFilingInsightJson(extractResponseText(response));
    const insight = normaliseFilingInsight(raw);

    if (insight === null) {
      return {
        ...fail(
          "FILING_ANALYSIS_UNPARSEABLE",
          "response was not a JSON object",
          selection,
        ),
        usage,
      };
    }

    const validation = validateFilingInsight(insight, selected.text);

    logger.info(
      `filing-insight(${label}): class=${insight.documentClass}/${insight.classConfidence} ` +
        `facts=${insight.facts.length} totals=${insight.statementTotals.length} ` +
        `issues=${validation.issues.length} checkedValues=${validation.checkedValues} ` +
        `checkedTotals=${validation.checkedTotals} ` +
        `sections=${selection.selectedSectionIndexes.length}/${selection.totalSections} ` +
        `truncated=${selection.truncated} sentChars=${selection.sentChars} ` +
        `model=${model} promptTokens=${usage.promptTokens} ` +
        `cachedTokens=${usage.cachedTokens} outputTokens=${usage.candidatesTokens} ` +
        `elapsedMs=${Date.now() - startedAt}`,
    );

    return {
      ok: validation.ok,
      insight,
      validation,
      selection,
      model,
      usage,
      failure: null,
      error: null,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`filing-insight(${label}) failed: ${message}`);
    return fail("FILING_ANALYSIS_CALL_FAILED", message, selection);
  }
}
