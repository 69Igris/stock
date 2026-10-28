/**
 * "Not enough data to compute this" is not "this computation failed".
 * MONEY-1274 / MONEY-1155 #30 ("all computations are failing").
 *
 * ## The cascade
 *
 * `compute_growth_metrics` began:
 *
 *     if (!statements?.length || statements.length < 2) {
 *       return { success: false, error: "At least 2 annual statements required" };
 *     }
 *
 * `success: false` makes the executor mark the task FAILED, and
 * `buildUnavailableSourceLines` then puts the line in front of the model under
 * "FAILED / UNAVAILABLE SOURCES". So when `fetch_income_statement` returns
 * nothing — which it does for ~90% of symbols, and did for EVERY quarterly
 * request before this ticket — the report says the COMPUTATION failed.
 *
 * Nothing computed wrongly. The arithmetic was never reached. But a research
 * run that fetched thin data now reads as a run where the analysis engine
 * broke, which is #30's screenshot: a wall of failed computations whose real
 * cause is one empty upstream table.
 *
 * ## The distinction this encodes
 *
 * Two different situations were sharing one return shape:
 *
 *   - CALLER ERROR — a required parameter was never supplied at all
 *     ("sector is required", "growth_rate is required"). The planner called the
 *     tool wrong; the run has a real defect. `success: false` is correct and
 *     these are deliberately left alone.
 *
 *   - INSUFFICIENT DATA — the parameter arrived and is simply too thin
 *     ("At least 2 annual statements required"). Nothing is broken; there is
 *     just not enough to work with. That is what this module reports.
 *
 * The shape mirrors what 27 of the 63 compute tools already do
 * (`{ available: false, reason }`) rather than inventing a third convention —
 * the point is to stop the two halves diverging, not to add to them.
 */

import type { ToolOutput } from "./types";

/**
 * A COMPLETED tool result that says the inputs were too thin to compute from.
 *
 * `success: true` is deliberate and is the whole fix: the tool did its job —
 * it looked at what it was given and correctly declined to invent a number.
 * Reporting that as a failure tells the model the engine is broken.
 *
 * `available: false` is what the model and the synthesiser read. `needed` and
 * `got` are included because "not enough data" without the shortfall is not
 * actionable: a run that fetched 1 of 2 required statements and one that
 * fetched none look identical otherwise, and they have different causes.
 */
export function insufficientInput(
  reason: string,
  detail?: { needed?: string; got?: number | string },
): ToolOutput {
  return {
    success: true,
    data: {
      available: false,
      reason,
      ...(detail?.needed !== undefined ? { needed: detail.needed } : {}),
      ...(detail?.got !== undefined ? { got: detail.got } : {}),
    },
    metadata: {
      // Distinct from `sourceError` (a source THREW) and from an ordinary
      // failure: this run is healthy and simply under-supplied. Named so a
      // reader of the metadata cannot mistake it for either.
      unavailableReason: "insufficient_input",
    },
  };
}
