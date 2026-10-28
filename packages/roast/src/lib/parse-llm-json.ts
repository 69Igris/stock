/**
 * Resilient JSON parsing for LLM responses (MONEY-488).
 *
 * Gemini occasionally returns JSON that's:
 *   - wrapped in ```json ... ``` markdown fences
 *   - prefixed with prose ("Sure, here's the JSON: { ... }")
 *   - truncated mid-string when maxOutputTokens is hit (yields the
 *     "Unterminated string in JSON at position N" exception that surfaced
 *     to users on the Past Roasts card)
 *
 * The previous behaviour was a bare `JSON.parse(text)` per step — a single
 * malformed character anywhere in the response failed the entire roast.
 * That's both bad UX (we never want to expose JSON.parse errors to a user)
 * AND incorrect failure semantics — most steps just need a best-effort
 * structured object and can carry on with defaults if recovery is partial.
 *
 * `parseLLMJson` returns the supplied fallback rather than throwing, so
 * callers can write straight-line code:
 *
 *     const parsed = parseLLMJson<Result>(text, EMPTY_RESULT, "analyze-mf");
 *     return { foo: parsed.foo || [] };
 *
 * The actual technical error is logged with the step name; what reaches
 * the DB / user is only the fallback shape.
 */

import { geminiLogger as logger } from "@usemoney/logger";

/**
 * Canonical sentinel string used to mark a roast session that was cancelled
 * by the user. The UI (apps/web/app/roast/client.tsx,
 * apps/web/app/analysis/client.tsx) and agent (packages/roast/src/agent.ts)
 * key off this EXACT string via strict equality, so any sanitization /
 * normalization path that returns the cancel signal MUST return this
 * canonical form (not the user's case-variant input).
 *
 * MONEY-543: extracted into a named constant so the cancel-sentinel
 * vocabulary has a single source of truth and future drift is harder.
 */
export const ROAST_CANCELLED_SENTINEL = "Cancelled by user";

/**
 * Try to recover a structured object from an LLM response.
 *
 * Recovery sequence:
 *   1. Strip leading/trailing whitespace.
 *   2. Strip markdown code fences (closed AND unclosed — Gemini's
 *      `responseMimeType: "application/json"` should suppress fences but
 *      doesn't always when the model adds explanatory prose).
 *   3. Strict `JSON.parse`.
 *   4. Greedy `{...}` substring match + parse (handles prose prefix/suffix).
 *   5. Bracket-balance recovery for truncated output — walks the string,
 *      tracks open `{` `[` and string state, closes anything still open at
 *      end-of-string, and parses the patched payload. This handles the
 *      canonical "Unterminated string in JSON at position N" failure mode
 *      from token-budget cutoffs.
 *
 * If none recover, returns the fallback and logs the original payload
 * snippet for debugging. NEVER throws.
 */
export function parseLLMJson<T>(
  text: string | null | undefined,
  fallback: T,
  stepName: string,
): T {
  if (!text || typeof text !== "string") {
    logger.warn({ stepName }, "parseLLMJson: empty or non-string input");
    return fallback;
  }

  let jsonStr = text.trim();

  // Step 2: strip markdown code fences.
  const closedFence = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (closedFence) {
    jsonStr = closedFence[1]!.trim();
  } else {
    const openFence = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*)/);
    if (openFence) jsonStr = openFence[1]!.trim();
  }

  // Step 3: strict parse.
  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as T;
    }
  } catch {
    /* fall through */
  }

  // Step 4: greedy {...} match.
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as T;
      }
    } catch {
      /* fall through */
    }
  }

  // Step 5: bracket-balance recovery for truncated output.
  const repaired = balanceTruncatedJson(jsonStr);
  if (repaired) {
    try {
      const parsed = JSON.parse(repaired);
      if (typeof parsed === "object" && parsed !== null) {
        logger.info(
          { stepName, originalLen: jsonStr.length },
          "parseLLMJson: recovered from truncated JSON via bracket-balance",
        );
        return parsed as T;
      }
    } catch {
      /* fall through */
    }
  }

  // Total failure — log and return fallback. The caller continues with
  // empty/default data; the agent does NOT mark the session as FAILED.
  logger.warn(
    {
      stepName,
      preview: jsonStr.slice(0, 200),
      length: jsonStr.length,
    },
    "parseLLMJson: all recovery paths failed, using fallback",
  );
  return fallback;
}

/**
 * Walk the string, track `{` `[` nesting and string-literal state, then
 * close anything still open at end-of-input. Best-effort — for genuinely
 * malformed JSON this still won't parse, but for the common truncation
 * case (model ran out of tokens mid-array) it usually recovers most of
 * the structured content.
 */
function balanceTruncatedJson(s: string): string | null {
  if (!s.startsWith("{") && !s.startsWith("[")) return null;

  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escape = false;
  let lastSafe = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      const expected = ch === "}" ? "{" : "[";
      if (stack[stack.length - 1] === expected) {
        stack.pop();
        if (stack.length === 0) lastSafe = i; // top-level close
      }
    } else if (ch === "," && stack.length === 1) {
      // Remember the last safe top-level position to truncate to.
      lastSafe = i - 1;
    }
  }

  // If we ended inside a string, close it; then close all open brackets.
  let out = s;
  if (inString) out += '"';
  // Drop trailing partial fragment after the last safe top-level comma —
  // the partial element/property would fail to parse otherwise.
  if (lastSafe >= 0 && lastSafe < out.length - 1 && stack.length > 0) {
    out = out.slice(0, lastSafe + 1);
  }
  while (stack.length > 0) {
    const open = stack.pop();
    out += open === "{" ? "}" : "]";
  }
  return out;
}

/**
 * Map a thrown error to a user-friendly message. Used by the roast agent
 * at the catch boundary so the DB never stores low-level technical strings
 * like "Unterminated string in JSON at position 245" — those go to logs
 * only, and what the user sees is a generic "please try again" message.
 *
 * Categories:
 *   - "Cancelled by user" passes through (special case the UI keys off).
 *     MONEY-543: case-insensitive + whitespace-tolerant compare; we always
 *     return the canonical sentinel (NOT the user's input case) because the
 *     UI uses strict `=== "Cancelled by user"` equality on DB-stored values.
 *   - JSON / parser errors → "we had trouble reading the AI response".
 *   - Timeouts → "took longer than expected".
 *   - Anything else → generic.
 */
export function sanitizeRoastErrorMessage(raw: string): string {
  if (!raw) return "Something went wrong. Please try again.";
  if (raw.trim().toLowerCase() === ROAST_CANCELLED_SENTINEL.toLowerCase()) {
    return ROAST_CANCELLED_SENTINEL;
  }

  const lc = raw.toLowerCase();
  if (
    lc.includes("json") ||
    lc.includes("unexpected token") ||
    lc.includes("unterminated") ||
    lc.includes("parse")
  ) {
    return "We had trouble reading the AI response. Please try again.";
  }
  if (lc.includes("timed out") || lc.includes("timeout")) {
    return "Roast generation took longer than expected. Please try again.";
  }
  if (lc.includes("network") || lc.includes("fetch")) {
    return "Network issue while generating roast. Please try again.";
  }
  return "Something went wrong while generating your roast. Please try again.";
}
