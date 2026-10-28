/**
 * Pure helpers for the Tiingo `utilities/search` permaTicker enrichment —
 * MONEY-1263.
 *
 * Zero I/O, so its unit test cannot open a socket or orphan a handle. The I/O
 * shell in `tiingo-search.ts` imports and calls these; there are no parallel
 * copies.
 */

/** One row of `/tiingo/utilities/search`. Seven fields, all measured present. */
export interface TiingoSearchRow {
  ticker: string;
  name: string;
  permaTicker: string;
  openFIGIComposite: string | null;
  assetType: string;
  isActive: boolean;
  countryCode: string;
}

export type SearchResolution =
  | { kind: "resolved"; permaTicker: string; openFIGIComposite: string | null }
  /** The query matched nothing we can safely attribute. */
  | { kind: "unmatched" }
  /** Several US securities answer to this exact ticker. */
  | { kind: "ambiguous"; candidates: string[] };

/**
 * Pick the one US security a ticker names, or refuse.
 *
 * ## Three measured hazards, all of which produce a WRONG id rather than none
 *
 * 1. **The endpoint is FUZZY.** `?query=APP` returns `APP, APP, APPB, APPC,
 *    APPC, APPCF` — prefix matches, not an exact lookup. Taking `results[0]`
 *    would attribute APPB's identity to APP roughly whenever ordering shifted.
 *    So the exact ticker is matched first, case-insensitively.
 * 2. **One ticker spans countries.** `AAPL` returns BOTH `US000000000038` and
 *    `CA000000137372`, each an exact ticker match and each genuinely Apple's
 *    listing in its own market. Only the US row is ours.
 * 3. **A ticker can still be ambiguous inside the US.** `APP` returns two rows
 *    with that exact ticker. When more than one US row survives, this returns
 *    `ambiguous` and stores NOTHING.
 *
 * Refusing is the whole point. A permaTicker is a claim that a corporate-action
 * row belongs to this instrument; a near-match would attach another company's
 * dividends and splits to it, silently and indistinguishably from correct data.
 * This mirrors the EDGAR CIK enricher, which drops `T-PC`/`TPC` for the same
 * reason.
 */
export function resolveSearchMatch(
  ticker: string,
  rows: readonly TiingoSearchRow[],
): SearchResolution {
  const want = ticker.trim().toUpperCase();
  if (want === "") return { kind: "unmatched" };

  const exact = rows.filter((r) => r.ticker?.trim().toUpperCase() === want);
  const us = exact.filter((r) => r.countryCode === "US");

  if (us.length === 0) return { kind: "unmatched" };
  if (us.length > 1) {
    return {
      kind: "ambiguous",
      candidates: us.map((r) => r.permaTicker).sort(),
    };
  }

  const hit = us[0]!;
  // A row without a permaTicker is not a resolution. Measured 100% populated,
  // but "measured always present" is not "guaranteed present", and an empty
  // string written into a join key is worse than a null.
  if (!hit.permaTicker || hit.permaTicker.trim() === "") {
    return { kind: "unmatched" };
  }
  return {
    kind: "resolved",
    permaTicker: hit.permaTicker.trim(),
    openFIGIComposite: hit.openFIGIComposite?.trim() || null,
  };
}

/** Tolerant parse: a malformed row is dropped, never thrown. */
export function parseSearchResponse(text: string): TiingoSearchRow[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const out: TiingoSearchRow[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.ticker !== "string" || typeof r.permaTicker !== "string") {
      continue;
    }
    out.push({
      ticker: r.ticker,
      name: typeof r.name === "string" ? r.name : "",
      permaTicker: r.permaTicker,
      openFIGIComposite:
        typeof r.openFIGIComposite === "string" ? r.openFIGIComposite : null,
      assetType: typeof r.assetType === "string" ? r.assetType : "",
      isActive: r.isActive === true,
      countryCode: typeof r.countryCode === "string" ? r.countryCode : "",
    });
  }
  return out;
}
