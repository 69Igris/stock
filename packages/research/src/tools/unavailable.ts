/**
 * Saying WHY a tool came back empty — MONEY-1274 (Bug 2).
 *
 * ## The defect
 *
 * A tool that found nothing returned, verbatim:
 *
 *     { success: false, error: `No income statement data found for ${symbol}` }
 *
 * The synthesizer puts that string in front of the model unchanged (see
 * `buildUnavailableSourceLines`), so the model reports it as a finding: "TCS
 * has no income statement data". That is a claim about the COMPANY — and it is
 * produced identically when every upstream source threw, when our egress is
 * blocked, and when the symbol is a genuinely uncovered SME.
 *
 * Only the last of those is a fact. The other two are outages being reported
 * as facts about a business, which is the worst version of this failure: the
 * user cannot tell, the model cannot tell, and nothing logs an error.
 *
 * `tryChainDetailed` (MONEY-1146) already computes the distinction —
 * `errors[]` for sources that THREW, `emptyCount` for sources that answered
 * cleanly with nothing. It had no caller outside its own module, so the
 * diagnosis was calculated and discarded on every request. This module is what
 * consumes it.
 *
 * ## The two endings, and why they need opposite words
 *
 * - NO COVERAGE — every source answered, none had this symbol. Legitimate for
 *   BSE-only listings, SME/Emerge, and recent IPOs. The honest sentence names
 *   the SOURCES as not covering it, never the company as not having it.
 * - LOOKUP FAILED — at least one source threw. Nothing was learned about the
 *   company at all, so the tool must not imply anything was.
 */

/** The subset of `ChainOutcome` this needs. Structural, so any chain fits. */
export interface ChainEnding {
  /** Sources that THREW, in attempt order. */
  errors: ReadonlyArray<{ source: string; message: string }>;
  /** Sources that answered cleanly with no data. */
  emptyCount: number;
}

/** A `ToolOutput`-shaped failure that says which ending it was. */
export interface UnavailableResult {
  success: false;
  error: string;
  metadata: Record<string, unknown>;
}

/**
 * Describe an exhausted chain honestly.
 *
 * `subject` is what was being looked for, as a noun phrase the model can read
 * back ("an income statement", "a cash flow statement").
 *
 * `metadata.sourceError` is set ONLY on the failed ending. That key is what
 * `buildUnavailableSourceLines` and the RC4 synthesizer path key off to say
 * "source temporarily unavailable" instead of "the company lacks data", so
 * setting it on a no-coverage ending would produce the opposite lie to the one
 * being fixed — an outage reported where there is none.
 */
export function describeUnavailable(
  subject: string,
  symbol: string,
  ending: ChainEnding,
): UnavailableResult {
  if (ending.errors.length > 0) {
    const detail = ending.errors
      .map((e) => `${e.source}: ${e.message}`)
      .join("; ");
    return {
      success: false,
      // Deliberately about the LOOKUP, not the company. Nothing was learned
      // about the business, so nothing may be implied about it.
      error:
        `Could not retrieve ${subject} for ${symbol} — every data source ` +
        `failed. This is a source problem, not a statement about the company; ` +
        `do not report the figures as missing or unavailable for ${symbol}.`,
      metadata: {
        unavailableReason: "lookup_failed",
        sourceError: detail,
        sourcesTried: ending.errors.length + ending.emptyCount,
      },
    };
  }

  return {
    success: false,
    // Absence we DID establish — but attributed to our sources' coverage
    // rather than asserted about the company's filings.
    error:
      `No ${subject} is available for ${symbol} from our data sources. ` +
      `They answered without error and none covers this symbol — common for ` +
      `BSE-only, SME/Emerge and recently listed companies.`,
    metadata: {
      unavailableReason: "no_coverage",
      sourcesTried: ending.emptyCount,
    },
  };
}
