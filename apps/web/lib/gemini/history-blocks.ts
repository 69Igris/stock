/**
 * Replaying a message's BLOCKS into the text a model actually reads —
 * MONEY-1274 (MONEY-1155 #44, "chat is not context-aware").
 *
 * ## The defect
 *
 * A chat message carries two parallel channels: `content` (a string) and
 * `blocks` (the rich payload the UI renders). History replay sends only the
 * first:
 *
 *     parts: [{ text: msg.content }]        // conversation.ts
 *
 * and every rich turn writes a STUB into `content`:
 *
 *     content: "Here are the research results:"   ChatContext.tsx:983
 *     content: "Full research report loaded:"     ChatContext.tsx:1150
 *     content: ""                                 ChatContext.tsx:2240 (streaming)
 *
 * So on the next turn the model is handed `assistant: "Here are the research
 * results:"` and nothing else. A deep research report, a screener result, a
 * roast — all visible to the user, none visible to the model. It then answers
 * the follow-up from the question alone and sounds like it has forgotten the
 * conversation, which is exactly the report.
 *
 * This is NOT a model-switch bug. History is keyed by chatId and userId, never
 * by model, so a Gemini -> Claude switch loses nothing that was there. The
 * report was never there for EITHER model. Switching just makes it noticeable.
 *
 * ## Why flatten rather than special-case research
 *
 * The narrow fix — load the research report from the DB when the page anchor
 * says `research` — helps one block type on one page. There are 26 block types
 * and the same hole swallows all of them. Flattening at the replay boundary
 * fixes the class, and it is provider-agnostic by construction: it produces
 * TEXT, which is what both the Gemini and Anthropic clients receive.
 *
 * ## Shape
 *
 * A handful of targeted renderers for the types that carry real substance, and
 * a generic scalar walk for everything else, so a block type added later
 * degrades to "some readable keys" rather than to silence. Primitives are
 * imported from `anchor-report` rather than re-declared — this is the third
 * renderer in this directory and the review already flagged duplication.
 *
 * Budgets are per message and overall, because history is replayed for EVERY
 * turn: an unbounded flatten would grow the prompt without limit as a chat gets
 * longer, and `trimHistoryToTokenBudget` would then silently drop the OLDEST
 * turns to pay for it.
 */

import { asRecord, str, MAX_ITEM_CHARS } from "./anchor-report";

/** Per-message ceiling. Roughly 250 tokens — one turn must not eat the budget. */
export const MAX_BLOCK_SUMMARY_CHARS = 1000;

/** Rows/items rendered from any one block before it is cut. */
const MAX_ROWS = 5;

/** Blocks rendered from any one message. */
const MAX_BLOCKS = 4;

/** Columns rendered from any one row. */
const MAX_COLS = 6;

/**
 * Join the renderable items, capped.
 *
 * MONEY-1274 — takes `items` UNSLICED and does the cap itself, after dropping
 * the empties. Callers used to slice to MAX_ROWS first, so unrenderable
 * entries spent the budget: a table whose first five rows were not objects
 * returned "" even with a usable row behind them.
 */
function joinItems(items: string[]): string | null {
  const kept = items.filter(Boolean);
  const shown = kept.slice(0, MAX_ROWS);
  return shown.length ? shown.join(" | ") : null;
}

/** How many of `total` were withheld, for the "+N more" suffix. */
function withheld(total: number, shown: number): string {
  return total > shown ? ` (+${total - shown} more)` : "";
}

/** `{columns, rows}` — the declared columns for a few rows. */
function renderTable(b: Record<string, unknown>): string | null {
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (rows.length === 0) return null;

  // MONEY-1274 — `cols` is USED now. It was computed and then discarded by
  // `cols.length ? Object.keys(o) : Object.keys(o)`, whose two branches are
  // identical, so the block's declared columns never reached the output and the
  // `.slice(0, 6)` below picked the first six RAW keys in object order instead.
  const cols = (Array.isArray(b.columns) ? b.columns : [])
    .map((c) => {
      const o = asRecord(c);
      return o ? { key: str(o.key), label: str(o.label) ?? str(o.key) } : null;
    })
    .filter((c): c is { key: string | null; label: string } => c?.key != null);

  // Rows are NOT pre-sliced: `joinItems` caps after dropping the unrenderable
  // ones, so a leading run of bad rows no longer costs the whole budget.
  const lines = rows.map((r) => {
    const o = asRecord(r);
    if (!o) return "";
    const pairs = cols.length
      ? cols.map((c) => ({ label: c.label, value: str(o[c.key!]) }))
      : Object.keys(o).map((k) => ({ label: k, value: str(o[k]) }));
    return pairs
      .filter((p) => p.value)
      .slice(0, MAX_COLS)
      .map((p) => `${p.label} ${p.value}`.slice(0, MAX_ITEM_CHARS))
      .join(", ");
  });

  const body = joinItems(lines);
  if (!body) return null;
  const usable = lines.filter(Boolean).length;
  const title = str(b.title);
  return `${title ? `${title}: ` : ""}${body}${withheld(usable, Math.min(usable, MAX_ROWS))}`;
}

/** `{stocks: [{symbol, metrics}], total}` — screener and list results. */
function renderStockList(b: Record<string, unknown>): string | null {
  const stocks = Array.isArray(b.stocks) ? b.stocks : [];
  if (stocks.length === 0) return null;

  // Not pre-sliced, for the same reason as renderTable: entries that render to
  // nothing must not spend the row budget.
  const lines = stocks.map((entry) => {
    const o = asRecord(entry);
    if (!o) return "";
    const sym = str(o.symbol);
    if (!sym) return "";
    const metrics = asRecord(o.metrics);
    const m = metrics
      ? Object.entries(metrics)
          .map(([k, v]) => (str(v) ? `${k} ${str(v)}` : null))
          .filter((x): x is string => x !== null)
          .slice(0, 3)
          .join(", ")
      : "";
    return (m ? `${sym} (${m})` : sym).slice(0, MAX_ITEM_CHARS);
  });

  const body = joinItems(lines);
  if (!body) return null;

  // MONEY-1274 — truncation is announced whenever rows were withheld, not only
  // when a `total` field happens to exceed the array. This compared `total`
  // against `stocks.length` (the FULL array) rather than against how many were
  // RENDERED, so the common case — a screener page whose `total` equals its own
  // length — showed 5 of 10 and said nothing, and the model read a truncated
  // list as the complete answer. renderTable already announced this.
  const usable = lines.filter(Boolean).length;
  const shown = Math.min(usable, MAX_ROWS);
  const declared = Number(str(b.total));
  const population =
    Number.isFinite(declared) && declared > usable ? declared : usable;
  const title = str(b.title);
  return `${title ?? "Results"}: ${body}${withheld(population, shown)}`;
}

/**
 * `{report, symbol}` — a completed research report.
 *
 * Deliberately shallow: the report is a large nested object and this is a
 * REMINDER of what was produced, not a re-delivery of it. The full text is
 * loaded by the anchor when the user is on `/analysis/<id>`; here the job is to
 * stop the follow-up believing nothing happened.
 */
function renderStructuredReport(b: Record<string, unknown>): string | null {
  const symbol = str(b.symbol);
  const report = asRecord(b.report);
  const bits: string[] = [];
  if (symbol) bits.push(`on ${symbol}`);
  if (report) {
    for (const key of ["verdict", "recommendation", "summary", "thesis"]) {
      const v = str(report[key]);
      if (v) {
        bits.push(`${key}: ${v.slice(0, MAX_ITEM_CHARS)}`);
        break;
      }
    }
    const sections = Object.keys(report).slice(0, 8);
    if (sections.length) bits.push(`sections: ${sections.join(", ")}`);
  }
  return bits.length ? `Research report ${bits.join(" — ")}` : null;
}

/** `{status, progress, symbols}` — a run in flight or just finished. */
function renderResearchStream(b: Record<string, unknown>): string | null {
  const status = str(b.status);
  if (!status) return null;
  const syms = Array.isArray(b.symbols)
    ? b.symbols.map(str).filter(Boolean).join(", ")
    : null;
  return `Research run ${status}${syms ? ` on ${syms}` : ""}`;
}

/**
 * Anything else: the readable scalars, shallowest-first.
 *
 * A block type added after this file is written still contributes something
 * rather than vanishing — the failure mode this whole module exists to remove.
 */
function renderGeneric(b: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (k === "type") continue;
    const s = str(v);
    if (s) parts.push(`${k} ${s.slice(0, MAX_ITEM_CHARS)}`);
    if (parts.length >= 6) break;
  }
  return parts.length ? parts.join(", ") : null;
}

const RENDERERS: Record<string, (b: Record<string, unknown>) => string | null> =
  {
    table: renderTable,
    "stock-list": renderStockList,
    comparison: renderTable,
    "structured-report": renderStructuredReport,
    "research-stream": renderResearchStream,
  };

/**
 * One block as a line of text, or null when it carries nothing readable.
 *
 * `text` blocks are skipped: their content is already the message text, so
 * rendering them would duplicate it into the prompt.
 */
export function summariseBlock(block: unknown): string | null {
  const b = asRecord(block);
  if (!b) return null;
  const type = str(b.type);
  if (!type || type === "text") return null;
  const body = (RENDERERS[type] ?? renderGeneric)(b);
  if (!body) return null;
  return `[${type}] ${body}`;
}

/**
 * A message's blocks as replayable text, capped, or "" when there is nothing.
 *
 * `sanitize` is REQUIRED, not optional. Blocks hold model-generated text, tool
 * output and fetched documents — untrusted content going into a prompt — and an
 * optional sanitizer is one a caller forgets.
 */
export function summariseBlocks(
  blocks: unknown,
  sanitize: (text: string) => string
): string {
  if (!Array.isArray(blocks) || blocks.length === 0) return "";
  // Render EVERY block, then keep the newest few. Slicing first spent the
  // budget on blocks that render to nothing — `text` blocks are skipped by
  // design — so a message whose first four blocks were text produced "" even
  // with a report behind them. And blocks accumulate NEWEST-LAST
  // (`blocks: [...(msg.blocks ?? []), streamBlock]`, ChatContext.tsx:2225), so
  // the one most worth carrying was the first to be cut. Take from the END.
  const rendered: string[] = [];
  for (const block of blocks) {
    const line = summariseBlock(block);
    if (line) rendered.push(line);
  }
  const lines = rendered.slice(-MAX_BLOCKS);
  if (lines.length === 0) return "";
  const joined = sanitize(lines.join("\n"));
  return joined.length > MAX_BLOCK_SUMMARY_CHARS
    ? `${joined.slice(0, MAX_BLOCK_SUMMARY_CHARS - 1)}…`
    : joined;
}

/**
 * The text a history turn should replay: the message plus what it produced.
 *
 * Returns the content unchanged when there are no blocks, so an ordinary turn
 * is byte-identical to before this change.
 */
export function replayText(
  content: string,
  blocks: unknown,
  sanitize: (text: string) => string
): string {
  const summary = summariseBlocks(blocks, sanitize);
  if (!summary) return content;
  const head = content.trim();
  return head ? `${head}\n${summary}` : summary;
}
