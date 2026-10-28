/**
 * Rendering a stored portfolio roast into prompt context — MONEY-1274 / -1155 #43.
 *
 * ## Why this exists separately from anchor-report.ts
 *
 * The previous commit gave `/roast/<id>` an ANCHOR: the prompt told the model
 * "ground answers and follow-up suggestions in THIS roast's specific findings".
 * Nothing loaded the findings. So the model was INSTRUCTED to be specific about
 * something it could not see, which is worse than saying nothing — an
 * instruction to cite findings you do not have is an invitation to invent them.
 * This module supplies them.
 *
 * It is not routed through `formatAnchoredReport` because the item shapes are
 * genuinely different, and that renderer would silently DROP most of a roast.
 * Measured against production: its `renderItem` looks for
 * `label|event|title|name` then `value|impact|text|summary`, while a roast
 * carries `{symbol, pnlPercent, roast}` and `{sector, percentage, verdict,
 * comment}` — neither `symbol` nor `sector` is in that list, so both would
 * render as nothing. Forcing one renderer over two vocabularies is how the
 * generic path ends up quietly producing empty blocks.
 *
 * ## The shape IS stable here — measured, not assumed
 *
 * Unlike the research report (SEVEN distinct key-sets across 35 rows), all 14
 * recent roasts carry exactly ONE key-set: `overallScore`, `scoreBreakdown`,
 * `roastHighlights`, `topPerformers`, `worstPerformers`, `sectorAnalysis`,
 * `constructiveAdvice`, `roastNarrative`, `disclaimer`. Reads are still guarded
 * — a stable sample is not a guarantee, and this block is best-effort context
 * where a throw would cost the whole feature — but the renderer can rely on the
 * vocabulary rather than probing for it.
 *
 * `roastNarrative` is deliberately NOT rendered. It is several hundred words of
 * comedy prose; it would consume most of the budget while adding nothing the
 * model needs to answer a follow-up. The STRUCTURED findings are what make a
 * suggestion specific, which is what #43 asked for.
 */

import {
  asRecord,
  str,
  MAX_BLOCK_CHARS,
  MAX_ITEM_CHARS,
} from "./anchor-report";

const MAX_LIST_ITEMS = 3;

/** The stored roast fields this needs. Structural, so the caller picks them. */
export interface AnchoredRoast {
  mode: string | null;
  assetType: string | null;
  status: string | null;
  score: number | null;
  result: unknown;
}

/** `{symbol, pnlPercent, roast}` — a named holding with its return. */
function renderPerformers(
  raw: unknown,
  sanitize: (s: string) => string
): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: string[] = [];
  for (const item of raw.slice(0, MAX_LIST_ITEMS)) {
    const o = asRecord(item);
    if (!o) continue;
    const symbol = str(o.symbol);
    if (!symbol) continue;
    const pct =
      typeof o.pnlPercent === "number" && Number.isFinite(o.pnlPercent)
        ? `${o.pnlPercent > 0 ? "+" : ""}${o.pnlPercent}%`
        : null;
    out.push(
      sanitize(pct ? `${symbol} (${pct})` : symbol).slice(0, MAX_ITEM_CHARS)
    );
  }
  return out.length ? out.join(" | ") : null;
}

/** `{sector, percentage, verdict, comment}` — an allocation call. */
function renderSectors(
  raw: unknown,
  sanitize: (s: string) => string
): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: string[] = [];
  for (const item of raw.slice(0, MAX_LIST_ITEMS)) {
    const o = asRecord(item);
    if (!o) continue;
    const sector = str(o.sector);
    if (!sector) continue;
    const pct =
      typeof o.percentage === "number" && Number.isFinite(o.percentage)
        ? `${o.percentage}%`
        : null;
    const verdict = str(o.verdict);
    const bits = [sector, pct, verdict].filter(Boolean).join(" ");
    out.push(sanitize(bits).slice(0, MAX_ITEM_CHARS));
  }
  return out.length ? out.join(" | ") : null;
}

/** `{title, description}` / `{type, emoji, title, description}` — titles only. */
function renderTitles(
  raw: unknown,
  sanitize: (s: string) => string
): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: string[] = [];
  for (const item of raw.slice(0, MAX_LIST_ITEMS)) {
    const o = asRecord(item);
    const title = o ? str(o.title) : str(item);
    if (!title) continue;
    out.push(sanitize(title).slice(0, MAX_ITEM_CHARS));
  }
  return out.length ? out.join(" | ") : null;
}

/** `{diversification, riskManagement, stockPicking, timing}` — the sub-scores. */
function renderBreakdown(
  raw: unknown,
  sanitize: (s: string) => string
): string | null {
  const o = asRecord(raw);
  if (!o) return null;
  const parts = Object.entries(o)
    .map(([k, v]) => {
      const n = str(v);
      // The VALUE is sanitized and capped too, not just the key. `str` accepts
      // any non-empty string, and `scoreBreakdown` is model-GENERATED then
      // stored — so an unsanitized value here was untrusted text landing in a
      // trusted prompt section, which is exactly what this module's header
      // forbids. Every sibling renderer already does both.
      return n ? sanitize(`${k} ${n}`).slice(0, MAX_ITEM_CHARS) : null;
    })
    .filter((x): x is string => x !== null);
  return parts.length ? parts.join(", ") : null;
}

/**
 * The roast as a prompt block, or `""` when there is nothing usable.
 *
 * `sanitize` is required for the same reason as elsewhere: this text is
 * model-GENERATED and then stored, so it is untrusted input being written into
 * a trusted prompt section.
 */
export function formatAnchoredRoast(
  roast: AnchoredRoast,
  sanitize: (text: string) => string
): string {
  const result = asRecord(roast.result);

  // An unfinished roast has no findings. Say the state rather than letting the
  // anchor's "ground your answer in this roast" instruction stand with nothing
  // behind it — which is precisely the defect this module closes.
  if (!result) {
    const status = str(roast.status);
    if (!status || status === "COMPLETED") return "";
    return (
      `THE ROAST ON SCREEN IS STILL ${sanitize(status)} — it has no findings ` +
      `yet. Say so rather than answering as though it does.`
    );
  }

  const lines: string[] = [];

  const scope = [str(roast.assetType), str(roast.mode)]
    .filter((x): x is string => x !== null)
    .map(sanitize);
  if (scope.length) lines.push(`Scope: ${scope.join(", ")}`);

  const score = str(roast.score) ?? str(result.overallScore);
  const breakdown = renderBreakdown(result.scoreBreakdown, sanitize);
  if (score) {
    lines.push(
      breakdown ? `Score: ${score} (${breakdown})` : `Score: ${score}`
    );
  }

  for (const [label, render, key] of [
    ["Best holdings", renderPerformers, "topPerformers"],
    ["Worst holdings", renderPerformers, "worstPerformers"],
    ["Allocation", renderSectors, "sectorAnalysis"],
    ["Advice given", renderTitles, "constructiveAdvice"],
    ["Criticisms raised", renderTitles, "roastHighlights"],
  ] as const) {
    const line = render(result[key], sanitize);
    if (line) lines.push(`${label}: ${line}`);
  }

  if (lines.length === 0) return "";

  const block =
    `THE ROAST ON SCREEN — ground answers and follow-up suggestions in THESE ` +
    `findings, and say so when the roast does not cover something rather ` +
    `than offering generic portfolio advice:\n` +
    lines.join("\n");

  return block.length > MAX_BLOCK_CHARS
    ? `${block.slice(0, MAX_BLOCK_CHARS - 1)}…`
    : block;
}
