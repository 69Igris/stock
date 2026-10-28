/**
 * Rendering a stored research report into prompt context — MONEY-1274 / -1155 #32.
 *
 * `page-anchor.ts` tells the model WHICH report the user is reading. That alone
 * does not stop it re-analysing the company from scratch, which is #32: "the
 * output is not tagged to the report it was generated [from] — it should
 * explain and then give details about the earnings of M&M". This module turns
 * the stored report into a compact block so answers come from the report the
 * user is actually looking at.
 *
 * ## The shape is NOT stable — measured, not assumed
 *
 * 35 recent completed reports carry SEVEN distinct key-sets. `catalysts`,
 * `plainSummary`, `scoreBreakdown`, `earningsQuality`, `priceTarget`,
 * `newsHighlights`, `dataCompleteness` and `comparisonMeta` each appear in some
 * and not others. Item types differ too: `strengths` / `risks` hold STRINGS
 * while `catalysts` holds `{event, timeline, impact}` and `keyMetrics` holds
 * `{label, value, verdict}`.
 *
 * So every read here is defensive. A renderer written against one report would
 * produce nothing — or throw — for most of the others, and because this block
 * is best-effort context, a throw would silently cost the user the whole
 * feature rather than one line of it.
 *
 * Only `score`, `recommendation`, `confidence`, `summary`, `keyMetrics`,
 * `strengths` and `risks` appear across all seven, so those carry the block and
 * the rest are additive.
 */

/** Hard ceiling on the rendered block. Reports run to ~13 KB of JSON. */
export const MAX_BLOCK_CHARS = 1800;
const MAX_LIST_ITEMS = 4;
export const MAX_ITEM_CHARS = 160;

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * One list entry as a line, whatever shape it arrived in.
 *
 * Strings pass through. Objects are rendered from whichever of the known
 * descriptive keys they carry — `{event, timeline, impact}` and
 * `{label, value, verdict}` are both real shapes in production — and an
 * unrecognised object is DROPPED rather than JSON-dumped, because raw JSON in
 * a prompt reads as noise the model will try to interpret.
 */
function renderItem(item: unknown): string | null {
  const s = str(item);
  if (s) return s.slice(0, MAX_ITEM_CHARS);

  const o = asRecord(item);
  if (!o) return null;

  const head = str(o.label) ?? str(o.event) ?? str(o.title) ?? str(o.name);
  const body = str(o.value) ?? str(o.impact) ?? str(o.text) ?? str(o.summary);
  const note = str(o.verdict) ?? str(o.timeline);

  if (!head && !body) return null;
  const line = [head, body].filter(Boolean).join(": ");
  return (note ? `${line} (${note})` : line).slice(0, MAX_ITEM_CHARS);
}

function renderList(label: string, raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items = raw
    .slice(0, MAX_LIST_ITEMS)
    .map(renderItem)
    .filter((x): x is string => x !== null);
  if (items.length === 0) return null;
  return `${label}: ${items.join(" | ")}`;
}

/** The stored session fields this needs. Structural — either session model fits. */
export interface AnchoredReport {
  query: string | null;
  symbols: readonly string[];
  status: string | null;
  report: unknown;
}

/**
 * The report as a prompt block, or `""` when there is nothing usable.
 *
 * `sanitize` is required for the same reason as in `page-anchor.ts`: this text
 * is model-GENERATED and then stored, so it is not trusted input being written
 * back into a system prompt.
 */
export function formatAnchoredReport(
  session: AnchoredReport,
  sanitize: (text: string) => string
): string {
  const report = asRecord(session.report);

  // A report that has not finished is not a source to answer from. Say the
  // state plainly instead — otherwise the model treats a half-written report as
  // the finished analysis, which is a worse failure than having no block.
  if (!report) {
    const status = str(session.status);
    if (!status || status === "COMPLETED") return "";
    return `THIS REPORT IS STILL ${sanitize(status)} — it has no findings yet. Say so rather than answering from it.`;
  }

  const lines: string[] = [];
  const q = str(session.query);
  if (q) lines.push(`Question asked: ${sanitize(q)}`);
  if (session.symbols.length > 0) {
    lines.push(`Covers: ${session.symbols.map((s) => sanitize(s)).join(", ")}`);
  }

  const verdict = [
    str(report.recommendation) &&
      `recommendation ${sanitize(str(report.recommendation)!)}`,
    str(report.score) && `score ${str(report.score)}`,
    str(report.confidence) && `confidence ${str(report.confidence)}`,
  ].filter(Boolean);
  if (verdict.length) lines.push(`Report verdict: ${verdict.join(", ")}`);

  const summary = str(report.summary) ?? str(report.plainSummary);
  if (summary) lines.push(`Summary: ${sanitize(summary)}`);

  for (const [label, key] of [
    ["Key metrics", "keyMetrics"],
    ["Strengths", "strengths"],
    ["Risks", "risks"],
    ["Catalysts", "catalysts"],
  ] as const) {
    const line = renderList(label, report[key]);
    if (line) lines.push(sanitize(line));
  }

  if (lines.length === 0) return "";

  const block =
    `THE REPORT ON SCREEN — answer from THIS, and say so when it does not ` +
    `cover something rather than analysing afresh:\n` +
    lines.join("\n");

  return block.length > MAX_BLOCK_CHARS
    ? `${block.slice(0, MAX_BLOCK_CHARS - 1)}…`
    : block;
}
