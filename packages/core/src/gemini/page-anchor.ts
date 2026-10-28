/**
 * What is the user LOOKING AT when they ask? — MONEY-1274 (Bug 3).
 *
 * Two pure functions, both about the one string the client already sends
 * (`ChatDashboardRequest.pagePath`) and neither of which the prompt layer knew
 * how to read.
 *
 * ## The defect, measured 2026-08-28
 *
 * `getSystemPrompt` resolved its page prompt with an EXACT key lookup —
 * `PAGE_PROMPTS[context.pagePath] || BASE_SYSTEM_PROMPT`. `PAGE_PROMPTS` has
 * six keys (`/fire`, `/holdings`, `/analysis`, `/tutor`, `/tradebook`,
 * `/discover`), and every path the app actually sends is a DYNAMIC route:
 *
 *     /analysis/abc123      -> BASE_SYSTEM_PROMPT   (research details)
 *     /roast/xyz789         -> BASE_SYSTEM_PROMPT   (roast page)
 *     /stocksage            -> BASE_SYSTEM_PROMPT   (the main chat)
 *     /stock/RELIANCE       -> BASE_SYSTEM_PROMPT   (stock detail)
 *     /discover/screener    -> BASE_SYSTEM_PROMPT   (screener)
 *     /paper-trading/chat   -> BASE_SYSTEM_PROMPT
 *
 * `/analysis` HAS a tailored prompt. The app has never once received it,
 * because it sends `/analysis/${sessionId}`. Nothing errored — a generic
 * assistant is a plausible assistant — which is why this survived as four
 * separate bug reports (MONEY-1155 #33, #34, #43, #44) about the chat "not
 * being context-aware" rather than one report about a string comparison.
 *
 * The second half is the ANCHOR: even when the prompt matched, the dynamic
 * segment was discarded, so nothing ever told the model WHICH stock or report
 * the user had on screen. That is #33 ("suggestions are not related to the
 * current stock in discussion") exactly.
 */

/** What the user has on screen, parsed from the path. */
export type PageAnchor =
  | { kind: "stock"; symbol: string }
  | { kind: "fund"; schemeId: string }
  | { kind: "research"; sessionId: string }
  | { kind: "roast"; roastId: string }
  | { kind: "screener"; mode: string | null }
  | null;

/** Path with any query string and trailing slash removed. */
function normalisePath(pagePath: string): string {
  const noQuery = pagePath.split("?")[0]?.split("#")[0] ?? "";
  if (noQuery.length > 1 && noQuery.endsWith("/")) return noQuery.slice(0, -1);
  return noQuery;
}

/**
 * The best `PAGE_PROMPTS` key for a path, or `null` when none applies.
 *
 * Matching is by PATH SEGMENT, not by string prefix: `/analysis` matches
 * `/analysis/abc123` but must NOT match `/analysis-archive`, which is a
 * different page and would otherwise inherit a prompt written for this one.
 *
 * The LONGEST match wins, so adding a more specific key later (say
 * `/discover/screener` alongside `/discover`) takes effect without having to
 * reorder anything — the alternative, first-match-wins, makes correctness
 * depend on the declaration order of an object literal.
 */
export function resolvePromptKey(
  pagePath: string,
  keys: readonly string[],
): string | null {
  const path = normalisePath(pagePath);
  let best: string | null = null;
  for (const key of keys) {
    if (path !== key && !path.startsWith(`${key}/`)) continue;
    if (best === null || key.length > best.length) best = key;
  }
  return best;
}

/**
 * What the user is looking at, or `null` when the path names no single subject.
 *
 * Only paths whose subject is unambiguous are parsed. A page that is a LIST
 * (`/holdings`, `/tradebook`) has no anchor, and inventing one would be worse
 * than none: the model would tell the user about a stock they did not ask
 * about, with the confidence of something it had been handed as fact.
 */
export function parsePageAnchor(pagePath: string): PageAnchor {
  const path = normalisePath(pagePath);
  const seg = path.split("/").filter(Boolean);
  const [head, id] = seg;
  if (!head) return null;

  // A dynamic segment is required for these — bare `/stock` is the index.
  if (id) {
    if (head === "stock") return { kind: "stock", symbol: id };
    if (head === "fund" || head === "mf") return { kind: "fund", schemeId: id };
    if (head === "analysis") return { kind: "research", sessionId: id };
    if (head === "roast") return { kind: "roast", roastId: id };
  }

  if (head === "discover" && id === "screener") {
    const q = pagePath.split("?")[1] ?? "";
    const mode = new URLSearchParams(q).get("mode");
    return { kind: "screener", mode };
  }

  return null;
}

/**
 * The anchor as a prompt block, or `""` when there is nothing to say.
 *
 * `sanitize` is REQUIRED, not optional, and is passed in rather than imported
 * to keep this module free of the prompt bundle. `pagePath` arrives in the
 * request body: it is user-controlled input being interpolated into a SYSTEM
 * prompt, which is the textbook injection vector. A symbol is echoed back to
 * the model as an instruction about what "this stock" means, so a crafted path
 * would otherwise be a crafted instruction.
 */
export function formatPageAnchor(
  anchor: PageAnchor,
  sanitize: (text: string) => string,
): string {
  if (!anchor) return "";

  switch (anchor.kind) {
    case "stock":
      return (
        `CURRENT PAGE: the user is viewing the stock ${sanitize(anchor.symbol)}. ` +
        `Resolve bare references ("this stock", "it", "the company") to ` +
        `${sanitize(anchor.symbol)} unless they name a different one, and keep ` +
        `follow-up suggestions about this company.`
      );
    case "fund":
      return (
        `CURRENT PAGE: the user is viewing the fund ${sanitize(anchor.schemeId)}. ` +
        `Resolve bare references ("this fund", "it") to that fund unless they ` +
        `name a different one.`
      );
    case "research":
      return (
        `CURRENT PAGE: the user is reading research report ` +
        `${sanitize(anchor.sessionId)}. Answer about THIS report's findings — ` +
        `tie each answer to what the report actually said rather than ` +
        `re-analysing from scratch, and say so when the report does not cover it.`
      );
    case "roast":
      return (
        `CURRENT PAGE: the user is reading portfolio roast ` +
        `${sanitize(anchor.roastId)}. Ground answers and follow-up suggestions ` +
        `in THIS roast's specific findings and holdings, not generic portfolio ` +
        `advice.`
      );
    case "screener":
      return anchor.mode
        ? `CURRENT PAGE: the user is on the ${sanitize(anchor.mode)} screener. ` +
            `Keep suggestions to filters and results for that asset type.`
        : `CURRENT PAGE: the user is on the screener.`;
  }
}
