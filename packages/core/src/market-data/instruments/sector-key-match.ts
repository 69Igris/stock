/**
 * Matching a sector NAME against a short keyword (MONEY-1093).
 *
 * A leaf module with zero imports, so anything can use it.
 *
 * ## Why this is shared rather than four regexes
 *
 * Four places in this repo classify a sector by testing keywords against its
 * name, and all four were written as `haystack.includes(key)`. With a
 * two-character key that is wrong in a way nobody notices, because it produces a
 * confident answer rather than an error:
 *
 *     "utilities".includes("it")    === true
 *     "commodities".includes("it")  === true
 *
 * So Utilities and Commodities were classified as INFORMATION TECHNOLOGY. A Tata
 * Power or Tata Steel holding was scored against IT benchmarks (ROE 25%,
 * D/E 0.2), told a pure IT shock cost it 20%, told an RBI rate hike and a 5%
 * rupee fall were both good for it, and counted as a mid-cycle sector when
 * computing the business-cycle phase — where `MID_CYCLE` is tested BEFORE
 * `LATE_CYCLE` and `DEFENSIVE`, so the branches that correctly list
 * "commodities" and "utilities" were unreachable.
 *
 * It was fixed twice, in `planner.ts` and `risk-stress-test.ts`, and the second
 * fix's comment claimed the sweep was complete — "the same infix-`it` defect
 * that was just fixed in the research planner". Three copies survived it. Fixing
 * a fifth copy in place would have been the same mistake a fourth time, so the
 * rule lives here once and the call sites import it.
 *
 * ## The rule, and why it is not simply `\b…\b`
 *
 * Two-character keys are anchored at BOTH ends; longer keys only at the START.
 *
 * Both halves are load-bearing, and each was learned from a regression:
 *
 *   - A start anchor ALONE is not enough for "it": `\bit` matches the beginning
 *     of "ITC", a top-10 NSE name sitting in this repo's own FMCG basket, so
 *     "ITC sector analysis" returned a confident report built from TCS, Infosys
 *     and Wipro.
 *   - Anchoring BOTH ends on longer keys breaks real matches: "financial" must
 *     match "Financials" and "Banking & Financials"; "pharma" must match
 *     "pharmaceuticals"; "auto" must match "automobile". A trailing-plural or
 *     -suffix match is wanted, so the tail stays loose.
 *   - `\bit\b` alone loses "Information Technology", which is the canonical NSE
 *     spelling and the single most important thing the "it" key has to match.
 *     That regression shipped in the first version of this fix, which is why
 *     `IT_CANONICAL` exists.
 */

/**
 * Alternate spellings for the "it" key that a word-boundary test cannot reach.
 *
 * "Information Technology" is the canonical NSE sector name. It contains no
 * standalone "it" token, so `\bit\b` misses it entirely.
 */
const IT_CANONICAL = /\binformation\s*tech/i;

/**
 * Whether `key` matches `sector`.
 *
 * Both arguments are treated case-insensitively. `sector` is the RAW name —
 * callers must NOT strip punctuation or spaces first. One call site did
 * (`sector.toLowerCase().replace(/[^a-z]/g, "")`), which turns "Information
 * Technology" into "informationtechnology", where neither `\bit\b` nor
 * `\binformation\s+tech` can match. Stripping destroys the very boundaries this
 * function depends on.
 */
export function sectorKeyMatches(sector: string, key: string): boolean {
  const haystack = (sector ?? "").trim();
  if (haystack === "" || key === "") return false;

  if (key.toLowerCase() === "it") {
    return /\bit\b/i.test(haystack) || IT_CANONICAL.test(haystack);
  }

  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Interior whitespace in a key tolerates any run of whitespace in the name, so
  // a key like "oil & gas" or "capital goods" survives double spaces.
  const body = escaped.replace(/\s+/g, "\\s+");
  const pattern = key.length <= 2 ? `\\b${body}\\b` : `\\b${body}`;
  return new RegExp(pattern, "i").test(haystack);
}

/**
 * The first key in `keys` that matches `sector`, or null.
 *
 * Order matters and is the CALLER's responsibility: these lists are
 * first-match-wins, so a general key placed before a specific one shadows it
 * ("finance" before "financial services", or "services" before "financial
 * services"). Callers that want specificity should sort longest-first — see
 * `impactForSector` in risk-stress-test.ts, which does exactly that.
 */
export function firstMatchingSectorKey(
  sector: string,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    if (sectorKeyMatches(sector, key)) return key;
  }
  return null;
}

/**
 * True when ANY key matches — the `list.some(k => s.includes(k))` replacement.
 */
export function anySectorKeyMatches(
  sector: string,
  keys: readonly string[],
): boolean {
  return firstMatchingSectorKey(sector, keys) !== null;
}
