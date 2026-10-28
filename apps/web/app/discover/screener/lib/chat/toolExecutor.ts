import type { ScreenerMode } from "@/components/screener/ModeTabs";
import type { ScreenerChatActions, ToolResult } from "./actions";
import {
  sanitizeFilters,
  sanitizeSort,
  SORTS_BY_MODE,
  FIELDS_BY_MODE,
} from "./filters";

/* =====================================================================
   Screener chat — tool executor  (MONEY-1078)
   ---------------------------------------------------------------------
   Maps a Gemini function call (name + args) onto a `ScreenerChatActions`
   method. Pure and side-effect-free except through `actions`, so it is
   unit-testable against a mock (same seam as the FIRE tool executor).

   Everything model-supplied is validated through the filter vocab in
   ./filters.ts: unknown keys are dropped (and reported back to the model
   so it can self-correct), numbers are clamped, enums canonicalised. A
   bad call yields an error ToolResult (fed back to the model) rather
   than throwing.
   ===================================================================== */

export type ToolArgs = Record<string, unknown>;

const MODES: readonly ScreenerMode[] = ["stocks", "mf", "etf"];

const MODE_LABEL: Record<ScreenerMode, string> = {
  stocks: "Stocks",
  mf: "Mutual Funds",
  etf: "ETFs",
};

function isMode(v: unknown): v is ScreenerMode {
  return typeof v === "string" && (MODES as readonly string[]).includes(v);
}

/** Compose the executor's summary of a sanitised filter merge. */
function describeMerge(
  mode: ScreenerMode,
  activeMode: ScreenerMode,
  s: ReturnType<typeof sanitizeFilters>
): ToolResult {
  const parts: string[] = [];
  if (mode !== activeMode) parts.push(`Switched to ${MODE_LABEL[mode]}.`);
  const appliedKeys = Object.keys(s.applied);
  if (appliedKeys.length > 0) {
    parts.push(
      `Applied ${appliedKeys.map((k) => `${k}=${String(s.applied[k])}`).join(", ")}.`
    );
  }
  if (s.cleared.length > 0) parts.push(`Unset ${s.cleared.join(", ")}.`);
  if (s.notes.length > 0) parts.push(`Note: ${s.notes.join("; ")}.`);
  if (s.dropped.length > 0) {
    parts.push(`Ignored unsupported/invalid keys: ${s.dropped.join(", ")}.`);
  }
  if (appliedKeys.length === 0 && s.cleared.length === 0) {
    return {
      ok: false,
      error:
        s.dropped.length > 0
          ? `No valid filter keys — unsupported/invalid: ${s.dropped.join(", ")}.`
          : "No filter keys provided.",
    };
  }
  return { ok: true, message: parts.join(" ") };
}

/** Execute one filter-merge tool for its implied mode. */
function runFilterMerge(
  mode: ScreenerMode,
  args: ToolArgs,
  activeMode: ScreenerMode,
  actions: ScreenerChatActions
): ToolResult {
  const s = sanitizeFilters(mode, args);
  const result = describeMerge(mode, activeMode, s);
  if (!result.ok) return result;
  if (mode !== activeMode) actions.switchMode(mode);
  if (Object.keys(s.applied).length > 0) actions.mergeFilters(mode, s.applied);
  if (s.cleared.length > 0) actions.unsetFilters(mode, s.cleared);
  return result;
}

/**
 * `getActiveMode` is a GETTER (not a captured value) because a single
 * batched hop can switch mode and then act on it (setEtfFilters +
 * setSort in one response) before React flushes state. The bridge backs
 * it with a ref that `switchMode` updates synchronously.
 */
export function executeScreenerTool(
  name: string,
  args: ToolArgs,
  getActiveMode: () => ScreenerMode,
  actions: ScreenerChatActions
): ToolResult {
  const activeMode = getActiveMode();
  try {
    switch (name) {
      case "setStockFilters":
        return runFilterMerge("stocks", args, activeMode, actions);
      case "setMfFilters":
        return runFilterMerge("mf", args, activeMode, actions);
      case "setEtfFilters":
        return runFilterMerge("etf", args, activeMode, actions);

      case "removeFilters": {
        const raw = args.keys;
        const requested = (Array.isArray(raw) ? raw : [raw])
          .map((k) => String(k ?? "").trim())
          .filter(Boolean);
        // Only unset keys in THIS mode's vocabulary: the chat must not be
        // able to drop filters it has no tool to restore (e.g. `amcAny`,
        // the multi-AMC chip selection deliberately outside the vocab).
        const vocab = FIELDS_BY_MODE[activeMode];
        const keys = requested.filter((k) => Object.hasOwn(vocab, k));
        const unknown = requested.filter((k) => !Object.hasOwn(vocab, k));
        if (keys.length === 0) {
          return {
            ok: false,
            error:
              unknown.length > 0
                ? `No removable filter keys — unsupported for ${MODE_LABEL[activeMode]}: ${unknown.join(", ")}.`
                : 'Invalid or missing "keys".',
          };
        }
        actions.unsetFilters(activeMode, keys);
        const note =
          unknown.length > 0
            ? ` Ignored unsupported: ${unknown.join(", ")}.`
            : "";
        return { ok: true, message: `Removed ${keys.join(", ")}.${note}` };
      }

      case "clearFilters": {
        actions.clearFilters(activeMode);
        return {
          ok: true,
          message: `Cleared all ${MODE_LABEL[activeMode]} filters.`,
        };
      }

      case "setSearchQuery": {
        if (typeof args.query !== "string") {
          return { ok: false, error: 'Invalid or missing "query".' };
        }
        const query = args.query.trim().slice(0, 120);
        actions.setQuery(query);
        return {
          ok: true,
          message: query
            ? `Set search to "${query}".`
            : "Cleared the search query.",
        };
      }

      case "setSort": {
        const sort = sanitizeSort(activeMode, args.sort);
        if (!sort) {
          return {
            ok: false,
            error: `Invalid sort "${String(args.sort)}" for ${MODE_LABEL[activeMode]}. Valid: ${SORTS_BY_MODE[activeMode].join(", ")}.`,
          };
        }
        actions.setSort(activeMode, sort);
        return { ok: true, message: `Sorted by ${sort}.` };
      }

      case "switchMode": {
        if (!isMode(args.mode)) {
          return {
            ok: false,
            error: 'Invalid "mode" — use "stocks", "mf", or "etf".',
          };
        }
        if (args.mode === activeMode) {
          return { ok: true, message: `Already on ${MODE_LABEL[args.mode]}.` };
        }
        actions.switchMode(args.mode);
        return { ok: true, message: `Switched to ${MODE_LABEL[args.mode]}.` };
      }

      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
