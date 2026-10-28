/**
 * Output Validation — pure logic (no server-action / auth imports)
 *
 * These are the side-effect-free checks used by `validateOutput` /
 * `factCheckNumbers` in `output-validator.ts`. They live in this sibling so
 * they can be imported under `node:test` without dragging in the chat-tool
 * registry → `@/lib/actions` → `lib/auth.ts` (`react.cache`) chain, which
 * throws at module load outside a React server request.
 *
 * `output-validator.ts` imports and CALLS these — the production code path and
 * the tests execute the exact same functions (no shadows, no dead exports).
 */

/**
 * Basic content filtering for LLM output.
 * Strips prompt-leak markers (SYSTEM PROMPT:, INSTRUCTION:, [INTERNAL]).
 */
export function filterUnsafeContent(response: string): string {
  // Remove potential prompt leaks
  return response
    .replace(/SYSTEM\s*PROMPT:/gi, "")
    .replace(/INSTRUCTION:/gi, "")
    .replace(/\[INTERNAL\]/gi, "");
}

/**
 * Detect if response contains financial recommendations
 * and return appropriate disclaimers.
 */
export function detectDisclaimers(response: string): string[] {
  const disclaimers: string[] = [];
  const lower = response.toLowerCase();

  // BUY/SELL recommendations
  if (
    /\b(buy|sell|short|long)\b.*\b(recommendation|suggest|advice|target\s*price)\b/i.test(
      lower
    ) ||
    /\b(recommend|suggest)\b.*\b(buy|sell|invest)\b/i.test(lower)
  ) {
    disclaimers.push(
      "This is not financial advice. Please consult a SEBI-registered advisor before making investment decisions."
    );
  }

  // Target price mentions
  if (/target\s*price|stop\s*loss|entry\s*price/i.test(lower)) {
    disclaimers.push(
      "Past performance is not indicative of future results. All investments carry risk."
    );
  }

  // Allocation/rebalancing recommendations.
  // NOTE: the percentage clause is `(\d+\s*%|\bpercent\b)`, NOT `\b(\d+%|percent)\b`.
  // A trailing `\b` after `%` only matches when a word char follows (e.g. "30%into"),
  // so a bare "30%" before a space/period/EOL silently failed — meaning advice like
  // "rebalance 30% into bonds" got NO financial-advice disclaimer. `\d+\s*%` uses the
  // `%` itself as the terminator; `\bpercent\b` keeps the spelled word bounded.
  if (
    /\b(allocate|rebalance|shift|move)\b.*(\d+\s*%|\bpercent\b)/i.test(lower) ||
    /\b(overweight|underweight)\b/i.test(lower)
  ) {
    if (disclaimers.length === 0) {
      disclaimers.push(
        "This is not financial advice. Please consult a SEBI-registered advisor before making investment decisions."
      );
    }
  }

  return disclaimers;
}

/**
 * Cross-reference LLM-stated numbers against actual tool result data.
 * Returns corrected response with warnings if discrepancies found.
 */
export function factCheckNumbers(
  response: string,
  toolData: Record<string, unknown> | undefined
): { response: string; corrections: string[] } {
  if (!toolData) return { response, corrections: [] };

  const corrections: string[] = [];

  // Build a map of known numerical values from tool data (flat extraction)
  const knownValues = extractNumericValues(toolData);
  if (knownValues.size === 0) return { response, corrections: [] };

  // Find all numbers mentioned in the LLM response (₹ amounts, percentages, counts)
  const numberPattern = /₹?\s?([\d,]+(?:\.\d+)?)\s*(?:Cr|L|crore|lakh|%)?/g;
  let match: RegExpExecArray | null;

  while ((match = numberPattern.exec(response)) !== null) {
    const matchedText = match[0]!;
    const rawNumber = match[1]!.replace(/,/g, "");
    const parsedNumber = parseFloat(rawNumber);
    if (isNaN(parsedNumber) || parsedNumber === 0) continue;

    const normalized = normalizeIndianCurrency(matchedText);
    if (normalized === null) continue;

    // Check if this number is close to any known value
    knownValues.forEach((knownValue, key) => {
      if (typeof knownValue !== "number" || knownValue === 0) return;

      const deviation =
        Math.abs(normalized - knownValue) / Math.abs(knownValue);

      // Flag if LLM number deviates >20% from actual data
      if (deviation > 0.2 && deviation < 10) {
        corrections.push(
          `Note: "${key}" is actually ${formatForCorrection(knownValue)}, not ${matchedText.trim()}`
        );
      }
    });
  }

  // Append corrections as footnote if any found
  let correctedResponse = response;
  if (corrections.length > 0) {
    correctedResponse +=
      "\n\n> **Data verification:** " + corrections.join(". ") + ".";
  }

  return { response: correctedResponse, corrections };
}

/** Extract all numeric values from a nested object (up to 2 levels) */
export function extractNumericValues(
  data: Record<string, unknown>,
  prefix = ""
): Map<string, number> {
  const values = new Map<string, number>();

  for (const [key, value] of Object.entries(data)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "number") {
      values.set(label, value);
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !prefix // Only go 1 level deep
    ) {
      const nested = extractNumericValues(
        value as Record<string, unknown>,
        label
      );
      nested.forEach((v, k) => values.set(k, v));
    }
  }

  return values;
}

/** Normalize "25L" to 2500000, "1.5Cr" to 15000000, "500" to 500 */
export function normalizeIndianCurrency(text: string): number | null {
  const cleaned = text.replace(/[₹,\s]/g, "");
  const crMatch = cleaned.match(/([\d.]+)\s*(?:Cr|crore)/i);
  if (crMatch) return parseFloat(crMatch[1]!) * 10000000;
  const lMatch = cleaned.match(/([\d.]+)\s*(?:L|lakh)/i);
  if (lMatch) return parseFloat(lMatch[1]!) * 100000;
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/** Format a number for correction display */
export function formatForCorrection(value: number): string {
  if (Math.abs(value) >= 10000000) return `₹${(value / 10000000).toFixed(2)}Cr`;
  if (Math.abs(value) >= 100000) return `₹${(value / 100000).toFixed(2)}L`;
  if (Math.abs(value) >= 1000) return `₹${value.toLocaleString("en-IN")}`;
  return String(value);
}

/**
 * Strip leaked JSON fragments from LLM response.
 *
 * Gemini sometimes outputs raw JSON objects/arrays inline when it's trying
 * to "construct" a tool call or show filter parameters. These look like:
 *   - , {"metric": "ROE", "operator": "gt", "value": 20}]}
 *   - {"filters": [...], "indices": ["NIFTY 50"]}
 *   - ]}}
 *
 * This strips them so the user sees clean narrative text.
 */
export function stripLeakedJson(response: string): string {
  // Remove standalone JSON objects/arrays (entire line is JSON-like)
  let cleaned = response.replace(
    /^[\s,]*(\{(?:[^{}]|\{[^{}]*\})*\}|\[(?:[^\[\]]|\[[^\[\]]*\])*\])[\s,]*$/gm,
    ""
  );

  // Remove trailing JSON fragments at end of sentences
  // e.g., "I'll tighten the screen for you.\n, {"metric": "DebtToEquity", ...}]}"
  cleaned = cleaned.replace(/[,\s]*\{["\w:,\s.\-\[\]{}]+\}[}\]\s]*$/gm, "");

  // Remove orphaned closing braces/brackets that remain
  cleaned = cleaned.replace(/^\s*[}\]]{2,}\s*$/gm, "");

  // Clean up extra blank lines left behind
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
}
