/**
 * Real-estate industry matcher (MONEY-1093) — pure, so it can be tested.
 *
 * Extracted from `resector-real-estate.ts` because that script calls `main()` at
 * module scope, so importing it would RUN it against a database. This matcher is
 * the highest-risk component of the re-sector: it decides, from free text, which
 * companies get moved into a different sector — and the values it reads have
 * three provenances (Yahoo taxonomy, unvalidated Gemini output, on-demand
 * enrichment), so it cannot be reasoned about from Yahoo's vocabulary alone.
 */

/**
 * Industry substrings that identify real estate, lower-cased.
 *
 * Deliberately short and literal rather than a clever pattern. Each entry is
 * reported separately in the dry run so a human can reject one without
 * rejecting all of them.
 *
 * "reit" is included because a REIT's SECTOR is real estate regardless of what
 * its instrumentType says — but it is listed last and counted separately, since
 * it is the one an operator is most likely to want to argue about.
 */
export const INDUSTRY_MATCHES = ["real estate", "realty", "reit"] as const;

/**
 * Industry substrings that look related but are NOT real estate, so the report
 * can show them as deliberate rejections rather than silent omissions.
 */
export const NEAR_MISSES = [
  // Most specific first: `find` returns the first hit, and that term is what
  // gets REPORTED, so "housing finance" is more useful than bare "finance".
  "housing finance",
  "building products",
  "construction",
  "engineering",
  "infrastructure",
  "mortgage",
  "cement",
  // Bare "finance" is deliberately included and deliberately last. A unit test
  // caught that "Real Estate Finance" — a real Gemini output shape — classified
  // as a clean match and would have been MOVED, even though such a company
  // lends against property rather than owning it: the same error as housing
  // finance, one word apart.
  //
  // Note what is NOT here: "investment". A REIT is a "Real Estate Investment
  // Trust", so treating that word as a conflict would make every genuine REIT
  // ambiguous and move nothing.
  "finance",
] as const;

/**
 * Classify one industry string against BOTH lists at once.
 *
 * The first version checked the match list, returned on the first hit, and only
 * consulted the near-miss list when nothing matched. That made the overlap
 * structurally invisible: `"Housing Finance / Real Estate"` matched on
 * "real estate", returned immediately, and never appeared in the near-miss
 * report — which is the one report whose entire purpose was to surface exactly
 * that case. A report that cannot see its own blind spot is worse than no
 * report, because it reads as due diligence.
 *
 * So both lists are always evaluated, and a string hitting both is AMBIGUOUS:
 * reported loudly and NOT moved. A housing-finance company silently relabelled
 * Real Estate is a worse outcome than one left alone for a human to look at.
 */
export function classifyIndustry(industry: string | null): {
  verdict: "match" | "ambiguous" | "near-miss" | "none";
  match: string | null;
  nearMiss: string | null;
} {
  const i = (industry ?? "").toLowerCase();
  if (!i) return { verdict: "none", match: null, nearMiss: null };

  // Word-boundary for "reit": a bare `includes("reit")` also fires on any
  // future value containing the letters, and this list is applied to free text.
  const match =
    INDUSTRY_MATCHES.find((m) =>
      m === "reit"
        ? // Allows an optional plural: /\breit\b/ alone missed "REITs", because
          // the trailing "s" is a word character so there is no boundary — a
          // real Gemini output shape, and a SILENT miss with no report line.
          /\breits?\b/.test(i)
        : i.includes(m),
    ) ?? null;
  const nearMiss = NEAR_MISSES.find((m) => i.includes(m)) ?? null;

  if (match && nearMiss) return { verdict: "ambiguous", match, nearMiss };
  if (match) return { verdict: "match", match, nearMiss: null };
  if (nearMiss) return { verdict: "near-miss", match: null, nearMiss };
  return { verdict: "none", match: null, nearMiss: null };
}

/**
 * Infrastructure trusts — toll roads, transmission lines, gas pipelines.
 *
 * NOT real estate, and NOT reliably typed INVIT: Yahoo has no InvIT class, so it
 * files them under "REIT - Specialty"/"Diversified", and `classifyTrustInstrument`
 * only catches the ones whose registered name contains an INVIT token. INDIGRID
 * ("INDIA GRID TRUST"), NHIT, Cube Highways and Anzen contain none and are typed
 * EQUITY.
 *
 * Lives here, next to `classifyIndustry`, for exactly the reason in this file's
 * header: it was a bare regex inside `resector-real-estate.ts`, which calls
 * `main()` at module scope, so nothing could unit-test it — and it was wrong
 * twice while being described as correct. First it enumerated only the four
 * instances a review happened to surface; then the widened "shape-based" version
 * still could not match "INDINFRAVIT" because `\bINFRA` requires a word boundary
 * that "IND|INFRA" does not provide, so INDINFRAVIT TRUST was swept into Real
 * Estate. The leading `\b` is gone and `INFRA\w*` now absorbs the "VIT".
 */
const INFRA_TRUST_NAME =
  /(INVIT|INV\s*IT|INFRA\w*\s*(?:INVESTMENT\s+)?TRUST|GRID\s+TRUST|HIGHWAYS?\s+(?:INFRA\w*\s+)?TRUST|ENERGY\s+YIELD|YIELD\s+PLUS)/i;

/**
 * Infra trusts whose registered name carries NO infra signal in any form.
 *
 * An ENUMERATION, and named as one. INTERISE TRUST (formerly Shrem InvIT) has no
 * infra, grid, highway, invit or yield token anywhere in its name, so no shape
 * can catch it and a list is the only honest option. Claiming shape-coverage
 * where there is none is what produced the last two misses.
 *
 * The real fix is upstream: once trusts are reliably typed INVIT this whole name
 * heuristic collapses to an instrumentType check. MONEY-1093 removed the only
 * writer that retyped an existing row to INVIT, so that is not possible today.
 */
export const INFRA_TRUST_SYMBOLS = new Set(["INTERISE"]);

/**
 * True for an infrastructure trust, by name shape or by the explicit list.
 *
 * Callers must run this BEFORE any "already in the target sector" short-circuit.
 * Yahoo files InvITs under "Real Estate", so the common case is a row already
 * stored there — and an already-correct check placed first swallows exactly the
 * rows this predicate exists to catch, silently and without a report line.
 */
export function isInfraTrust(
  symbol: string,
  name: string | null | undefined,
): boolean {
  return (
    INFRA_TRUST_SYMBOLS.has(symbol.trim().toUpperCase()) ||
    INFRA_TRUST_NAME.test(`${symbol} ${name ?? ""}`)
  );
}
