/**
 * DCF display guards (MONEY-295 Bug 8) — pure, extracted from the analysis UI.
 *
 * The synthesizer's `dcf` scalars are typed `number` but can arrive `null` when
 * the DCF tool couldn't produce a figure (no FCF data). The original crash was
 * `null.toLocaleString()` on /analysis/[sessionId]. These guards are the single
 * source of truth for "is a DCF field renderable" — the chat-context builder
 * (app/analysis/[sessionId]/client.tsx) and the report tiles (ResearchReport.tsx)
 * both call them, so the tests exercise the real production guards.
 */

/** A DCF block as the synthesizer emits it (scalars may be null). */
export interface DcfFigures {
  intrinsicValue: number | null;
  currentPrice: number | null;
  upside: number | null;
}

/**
 * Build the one-line "- DCF …" chat-context string for a DCF block, guarding
 * each scalar (0 and negatives are valid; only null/non-number is skipped).
 * Returns null when no field is renderable so the caller skips the line.
 */
export function buildDcfContextLine(dcf: DcfFigures): string | null {
  const parts: string[] = [];
  if (typeof dcf.intrinsicValue === "number") {
    parts.push(
      `Intrinsic Value: ₹${dcf.intrinsicValue.toLocaleString("en-IN")}`
    );
  }
  if (typeof dcf.currentPrice === "number") {
    parts.push(`Current: ₹${dcf.currentPrice.toLocaleString("en-IN")}`);
  }
  if (typeof dcf.upside === "number") {
    parts.push(`Upside: ${dcf.upside.toFixed(1)}%`);
  }
  return parts.length > 0 ? `- DCF ${parts.join(", ")}` : null;
}

/** Whether to render the DCF tiles box: only if at least one scalar is a number. */
export function shouldRenderDcfBox(
  dcf: DcfFigures | undefined | null
): boolean {
  if (!dcf) return false;
  return (
    typeof dcf.intrinsicValue === "number" ||
    typeof dcf.currentPrice === "number" ||
    typeof dcf.upside === "number"
  );
}
