/**
 * THE ADAPTER — MONEY-1324 (P17).
 *
 * Binds `analyzeFilingText` (the Gemini call, in `lib/gemini-filing-insight`)
 * to the `FilingTextAnalyser` seam the sweep processor consumes. It is the ONE
 * place the two halves meet, and it exists because they answer to two
 * deliberately opposite contracts:
 *
 *   the ANALYSER never throws.  Every path returns a result, and `failure`
 *                               says whether a retry could help. Degrading to
 *                               `OTHER` with three empty lists is a legal
 *                               answer, because a nightly job must not die on
 *                               one odd response.
 *   the SEAM throws.            `FilingTextAnalyser` returns a reading or it
 *                               raises. Returning "no reading" would make the
 *                               sweep stamp READY, drain the one-shot queue
 *                               and fill the table with rows nothing ever
 *                               read — which is exactly why the default seam
 *                               is a stub that throws rather than an empty
 *                               object.
 *
 * Neither contract is wrong; they are answers to different questions ("can
 * this job continue?" vs "is there something to store?"). Translating between
 * them is this file's whole job, and it is why the translation lives in ONE
 * function instead of being spelled out at a call site.
 *
 * ## The split this file keeps
 *
 * I/O-ADJACENT, and it holds no decision of its own. What to analyse, whether
 * a re-run may write, and what a row contains are all decided by the pure
 * `us-filing-insight-logic.ts`; selection, prompt and validation are all
 * decided by the pure modules behind `analyzeFilingText`. This module maps
 * fields and classifies one boolean.
 *
 * ## It is INJECTED, never the default
 *
 * `processUsFilingInsight` still defaults to `notImplementedFilingAnalyser`.
 * A wiring step that can be forgotten is a wiring step that fails LOUDLY at
 * the first document rather than silently across the cohort, and the sweep
 * stays testable with a two-line fake.
 */

import {
  FILING_INSIGHT_PROMPT_VERSION,
  type FilingIssue,
} from "@usemoney/core/market-data/filing-insight-logic";

import {
  analyzeFilingText,
  type FilingAnalysisDeps,
  type FilingAnalysisFailure,
  type FilingAnalysisResult,
} from "../lib/gemini-filing-insight";
import type {
  FilingTextAnalyser,
  FilingTextAnalysis,
  FilingTextAnalysisRequest,
  TokenUsage,
  UpstreamSeamFailure,
} from "./us-filing-insight-logic";

/** How many issues are named in the thrown message before it is elided. */
export const MAX_REPORTED_ISSUES = 3;

/**
 * Raised when the analyser answered but the answer is not storable.
 *
 * TWO causes, kept distinguishable on the error because they need different
 * responses from a human even though the sweep records both as FAILED:
 *
 *   a FAILURE     the call did not produce an insight at all (empty input,
 *                 unparseable response, transport, unconfigured backend).
 *   a REJECTION   the call produced an insight and the CHECKS refused it —
 *                 a figure that is not in the text the model was shown, or a
 *                 printed total that does not equal its printed components.
 *
 * The second is the interesting one. It is a reading we could have stored,
 * and storing it would have been the easy thing to do: the row would look
 * completely normal, and the only trace that a figure was invented would be a
 * `validation` object nobody kept. `ok` is the analyser's own verdict on both
 * the call AND the checks, so it is the one boolean that separates "a reading"
 * from "a plausible-looking answer".
 */
export class FilingAnalysisRejectedError
  extends Error
  implements UpstreamSeamFailure
{
  readonly failure: FilingAnalysisFailure | null;
  /** True when a retry could plausibly do better. Recorded, not acted on. */
  readonly retryable: boolean;
  /**
   * THE UPSTREAM, not the document. Read by the processor through
   * `isUpstreamSeamFailure` so a Gemini outage is counted as
   * `transportFailures` rather than as a night of unreadable filings — those
   * two look identical in `failed` and only one of them is our data's fault.
   */
  readonly upstreamFailure: boolean;
  /**
   * What the refused call ALREADY COST.
   *
   * A REJECTION is a model call that completed — it produced an insight the
   * checks then refused — so it bills exactly like a stored reading. Dropping
   * the usage on the throw made the FAILED row and its metric report zero
   * tokens, so a prompt regression that refused every reading read as FREE on
   * the only surface that would have shown it. A FAILURE (`CALL_FAILED`,
   * `UNCONFIGURED`) genuinely got no answer and carries `undefined`.
   */
  readonly usage?: TokenUsage;

  constructor(
    message: string,
    opts: {
      failure: FilingAnalysisFailure | null;
      retryable: boolean;
      usage?: TokenUsage;
    },
  ) {
    super(message);
    this.name = "FilingAnalysisRejectedError";
    this.failure = opts.failure;
    this.retryable = opts.retryable;
    this.usage = opts.usage;
    this.upstreamFailure =
      opts.failure === "FILING_ANALYSIS_CALL_FAILED" ||
      opts.failure === "FILING_ANALYSIS_UNCONFIGURED";
  }
}

/**
 * Would another attempt plausibly do better?
 *
 * The analyser's own classification, restated here so the row's
 * `failureReason` says which kind of failure it was. `CALL_FAILED` and
 * `UNCONFIGURED` are transport and environment; `EMPTY_INPUT` and
 * `UNPARSEABLE` fail identically on every attempt.
 *
 * A VALIDATION rejection (`failure === null`) is treated as retryable,
 * narrowly: temperature is 0, so the same bytes give the same answer and a
 * blind re-run buys nothing — but a PROMPT change is the fix for an
 * ungrounded reading, and this is the only channel that brings the document
 * back afterwards.
 *
 * NOTE what this does NOT do: the sweep records every throw as FAILED, which
 * is re-selectable, so a deterministic failure IS re-attempted on the next
 * sweep. That costs a GCS read and a selection (both cheap) and, for
 * `UNPARSEABLE` only, one model call. Making `SKIPPED` reachable from here
 * would need the processor to read this flag — deliberately not done in this
 * change; see the report.
 */
export function isRetryableFilingFailure(
  failure: FilingAnalysisFailure | null,
): boolean {
  return (
    failure === null ||
    failure === "FILING_ANALYSIS_CALL_FAILED" ||
    failure === "FILING_ANALYSIS_UNCONFIGURED"
  );
}

/** A compact, operator-facing summary of why a reading was refused. */
export function describeFilingIssues(issues: readonly FilingIssue[]): string {
  if (issues.length === 0) return "no issues reported";
  const named = issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${issue.kind}: ${issue.message}`)
    .join("; ");
  const rest = issues.length - MAX_REPORTED_ISSUES;
  return rest > 0 ? `${named}; +${rest} more` : named;
}

/**
 * Turn one analyser result into what the seam owes the sweep, or throw.
 *
 * PURE, and separated from the call for exactly that reason: the mapping is
 * where a field can be silently dropped or crossed, and it is checkable
 * without a model.
 *
 * The three mappings that are NOT one-to-one, each of which reads as a rename
 * and is not:
 *
 *   `usage.candidatesTokens` -> `outputTokens`   Gemini's spelling for output
 *                                                tokens is `candidates`.
 *   `selection.sentChars`    -> `analysedBytes`  what was SENT, never
 *                                                `textBytes`. The document is
 *                                                up to 300 KB and the budget
 *                                                is 60,000 chars, so storing
 *                                                the document size would
 *                                                attribute a cost we did not
 *                                                pay and hide a thin
 *                                                selection.
 *   `ok: false`              -> THROW            see the class comment above.
 */
export function toFilingTextAnalysis(
  result: FilingAnalysisResult,
): FilingTextAnalysis {
  if (!result.ok || result.insight === null) {
    const retryable = isRetryableFilingFailure(result.failure);
    const detail =
      result.failure !== null
        ? `${result.failure}: ${result.error ?? "no detail"}`
        : `validation-refused (${result.validation?.issues.length ?? 0} issue(s), ` +
          `checkedValues=${result.validation?.checkedValues ?? 0}, ` +
          `checkedTotals=${result.validation?.checkedTotals ?? 0}) ` +
          describeFilingIssues(result.validation?.issues ?? []);

    throw new FilingAnalysisRejectedError(
      `${detail} [retryable=${retryable} model=${result.model} ` +
        `sentChars=${result.selection.sentChars}/${result.selection.documentChars}]`,
      {
        failure: result.failure,
        retryable,
        // A REJECTION spent these; a transport FAILURE did not. `result.usage`
        // is zero-filled either way, so the flag decides whether reporting it
        // is a measurement or a fabrication.
        usage:
          result.failure === null
            ? {
                promptTokens: result.usage.promptTokens,
                cachedTokens: result.usage.cachedTokens,
                outputTokens: result.usage.candidatesTokens,
              }
            : undefined,
      },
    );
  }

  return {
    // THE VALIDATED OBJECT, forwarded whole. Not re-shaped, not repaired, not
    // filtered — the row must be the thing the checks passed.
    insight: result.insight,
    modelId: result.model,
    // The version of the prompt that produced this reading, taken from the
    // module that BUILDS that prompt. Restating the string here would be one
    // fact in two places, and the copy that drifts is always the one stamped
    // onto the rows.
    promptVersion: FILING_INSIGHT_PROMPT_VERSION,
    analysedBytes: result.selection.sentChars,
    usage: {
      promptTokens: result.usage.promptTokens,
      cachedTokens: result.usage.cachedTokens,
      outputTokens: result.usage.candidatesTokens,
    },
  };
}

/**
 * The filing date as the prompt wants it: `YYYY-MM-DD`, or nothing.
 *
 * An Invalid Date stringifies to "Invalid Date" and would be sent to the model
 * as though it were a filing date. The repo's standing rule about non-finite
 * values applies to clocks too: absent is a state the prompt already handles
 * (`buildFilingContext` omits the line), and a wrong date is one it cannot.
 */
export function isoFilingDate(filedAt: Date | null | undefined): string | null {
  if (!(filedAt instanceof Date)) return null;
  const ms = filedAt.getTime();
  if (!Number.isFinite(ms)) return null;
  return filedAt.toISOString().slice(0, 10);
}

export interface FilingAnalyserOptions {
  /** Selection budget. Defaults to the selector's own 60,000 chars. */
  maxChars?: number;
  /** Per-document model budget in ms. Defaults to `DOC_PARSE_BUDGET_MS`. */
  budgetMs?: number;
  /** Registry-checked model id. Ignored unless registered AND available. */
  modelOverride?: string | null;
  /** Passed through to the analyser. TESTS ONLY — see `FilingAnalysisDeps`. */
  deps?: FilingAnalysisDeps;
}

/**
 * Build the analyser the sweep injects.
 *
 * NOTE what is NOT forwarded: `items`. A 6-K carries `items: []` because a
 * foreign private issuer files no item numbers, and 1,256 of the cohort's
 * documents are 6-Ks. Nothing on this path reads the list, so there is no
 * gate an empty one can silently fail — which is the point rather than an
 * omission.
 */
export function createFilingInsightAnalyser(
  opts: FilingAnalyserOptions = {},
): FilingTextAnalyser {
  return async (
    request: FilingTextAnalysisRequest,
  ): Promise<FilingTextAnalysis> => {
    const result = await analyzeFilingText(
      {
        text: request.text,
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
        ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
        ...(opts.modelOverride !== undefined
          ? { modelOverride: opts.modelOverride }
          : {}),
        cik: request.cik10,
        accession: request.accession,
        formType: request.form,
        // The exhibit's own type — "EX-99.1", "EX-99.2". It is what tells the
        // model which attachment of the filing it is holding.
        exhibitLabel: request.documentType,
        filedAt: isoFilingDate(request.filedAt),
        // A HINT, and named one in the prompt. The registrant is read out of
        // the document; the symbol only nudges a tie.
        registrantHint: request.symbol,
        label: `${request.accession}#${request.sequence}`,
      },
      opts.deps ?? {},
    );

    return toFilingTextAnalysis(result);
  };
}
