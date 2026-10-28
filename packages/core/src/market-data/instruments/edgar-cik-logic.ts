/* =====================================================================
   EDGAR CIK join — pure parsing + enrichment planning  (MONEY-980)
   ---------------------------------------------------------------------
   The SEC's Central Index Key is the durable identity of a US filer, the
   way ISIN is for an Indian one. It is what any future US filings,
   XBRL-financials or ownership ingest joins on, and there is no way to
   derive it from anything Tiingo publishes.

   Source: https://www.sec.gov/files/company_tickers.json — one public
   static object, measured 2026-08-28 at 795,179 bytes / 10,391 entries:

       {"0":{"cik_str":1045810,"ticker":"NVDA","title":"NVIDIA CORP"},
        "1":{"cik_str":320193, "ticker":"AAPL","title":"Apple Inc."}, …}

   ## Why this is an ENRICHER, not an InstrumentProvider

   The same reason the BSE scrip master is one (bse-master-logic.ts): a
   provider whose symbols are not OUR symbols CREATES rows instead of
   updating them. EDGAR's ticker spelling is SEC's, and it carries no
   exchange and no listing window at all — so a provider would have to
   invent two of the three components of `UsInstrument.listingId`, which
   is a fabricated unique key. An update-only enricher has no such
   failure mode: an unmatched EDGAR row is counted and reported, never
   written.

   ## What makes the join safe WITHOUT a name corroboration

   The BSE enricher requires `namesCorroborate` before it writes, because
   its identity claim (`scrip_id === tradingsymbol`) was a guess. That
   check was IMPOSSIBLE when this was written and copying it would have
   made the whole enricher inert: Tiingo's master has no name column, so
   every US row's `name` was the ticker string. Comparing "AAPL" against
   "Apple Inc." rejects every row, and the enricher would have written
   nothing while looking healthy — the exact shape of the BSE bug that
   shipped and had to be repaired.

   MONEY-980 TASK B3 CHANGES THE FACT BUT NOT THE DECISION.
   `UsInstrument.name` is now null until the paced `/tiingo/daily/`
   name leg reaches the row, and then holds a real company name. So a
   corroboration is finally POSSIBLE — and is deliberately still not
   used, because it would make this enricher's coverage a function of
   another leg's rotation: a row EDGAR could match today would be
   rejected purely for being early in the name backfill, and the
   resulting number would look like an EDGAR coverage gap. If it is ever
   added it must be `name === null ? skip-the-check : compare`, never
   `name === null ? reject`.

   What carries the safety instead, in order:

     1. The map is a strict ticker -> CIK FUNCTION. A ticker appearing
        twice with DIFFERENT CIKs is removed from the map entirely and
        counted `ambiguous`, never resolved arbitrarily. (Measured
        2026-08-28: zero such tickers in 10,391 entries.)
     2. One CIK under SEVERAL tickers is NORMAL and is not ambiguity —
        BRK-A and BRK-B are both CIK 1067983, BRKH/BRKHU/BRKHW are all
        2098707. Share classes and units. The join runs ticker -> CIK, so
        this direction never has to be resolved.
     3. Scope is `listingStatus: "ACTIVE"` within `us_instruments` (the
        table is now US-only, so the old `market: "US"` clause is gone).
        The status half is the real guard, not tidiness:
        `company_tickers.json` lists who is registered TODAY, while our
        table deliberately keeps 31,314 delisted listings — 1,440 of
        which share a ticker with another listing. A dead ticker later
        reassigned to a new registrant would otherwise get the NEW
        company's CIK stamped onto the OLD company's row. That risk went
        UP, not down, when the US rows moved to a model whose
        `(symbol, exchange)` index is deliberately not unique.
     4. `cik` is written only where ABSENT, never overwritten.

   A wrong CIK is not cosmetic — it attaches another company's SEC
   filings to this security, silently and indistinguishably from correct
   data — so every uncertainty above resolves to "skip and count".
   ===================================================================== */

/** One normalised entry of `company_tickers.json`. */
export interface EdgarTickerRow {
  /** Uppercased ticker as SEC spells it (`BRK-B`, `BF-B`). */
  ticker: string;
  /** Zero-padded to 10 digits — the form every EDGAR URL and API wants. */
  cik: string;
  /** Registrant name. Not written by this enricher; kept for diagnostics. */
  title: string;
}

/**
 * Zero-pad a CIK to the canonical 10 digits.
 *
 * The JSON carries `cik_str` as a NUMBER despite the name (320193, not
 * "0000320193"), and every EDGAR endpoint — submissions, companyfacts, the
 * filing index — wants the padded string. Storing the unpadded form would push
 * that conversion onto every future reader, and one of them would forget.
 */
export function padCik(value: number | string): string | null {
  const digits = String(value).trim().replace(/^0+/, "");
  if (digits === "" || !/^\d+$/.test(digits)) return null;
  // A CIK is at most 10 digits. Anything longer is not a CIK.
  if (digits.length > 10) return null;
  return digits.padStart(10, "0");
}

/**
 * Ticker reduced to its identifying characters, for the SECONDARY join pass.
 *
 * Feeds spell share classes differently — `BRK.B` (Nasdaq), `BRK-B` (Yahoo and
 * SEC), `BRK/B` (some vendors) — and which spelling Tiingo uses for a given
 * class could not be verified here (no token in this environment). So the
 * variant join exists, but as a SEPARATE, separately-counted pass: the exact
 * match runs first and its result is reported on its own, so the variant pass's
 * real contribution is a number in the sync log rather than an assumption baked
 * into the primary path.
 *
 * It strips only punctuation. It does NOT strip a class letter, because `FOOA`
 * and `FOO` are different securities and collapsing them is the mis-attribution
 * this whole module refuses to make.
 *
 * ## Even punctuation-only normalisation collides, and it is NOT hypothetical
 *
 * Measured over the real 10,391-entry file, 2026-08-28: four normalised keys
 * are claimed by two DIFFERENT registrants each, because SEC spells a preferred
 * or warrant class with a hyphen that this function removes —
 *
 *     TPC    T-PC   = AT&T preferred      vs  TPC   = Tutor Perini
 *     BCPC   BC-PC  = Brunswick preferred vs  BCPC  = Balchem
 *     NEWT   NE-WT  = Noble warrants      vs  NEWT  = NewtekOne
 *     INNPF  INN-PF = Summit Hotel pref.  vs  INNPF = Innocan Pharma
 *
 * Without the ambiguity rule in `buildEdgarCikIndex`, Tutor Perini would be
 * stamped with AT&T's CIK — silently, and indistinguishably from a correct
 * join. All eight of those tickers are dropped from the variant index, which is
 * why it holds 10,383 keys against 10,391 exact ones. The guard is measured, not
 * defensive.
 */
export function normaliseUsTicker(ticker: string): string {
  return ticker.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Rewrite a preferred-class ticker from OUR spelling into SEC's — MONEY-1353.
 *
 * `UsInstrument.symbol` is Tiingo's spelling, which separates every component
 * with a dash: `SPG-P-J`, `T-P-C`. SEC collapses the class marker onto the
 * series letter: `SPG-PJ`, `T-PC`. Measured against the archived
 * `company_tickers.json` (10,412 entries) and prod's 41,261 ACTIVE US rows on
 * 2026-09-05: 382 rows carry the `-P-<letter>` shape and this rewrite is the
 * only transformation any of them needs.
 *
 * ## Why this exists when {@link normaliseUsTicker} already "handles" it
 *
 * It does not handle it — it SURVIVES it, and only where nothing collides.
 * Stripping punctuation maps `T-P-C` onto `TPC`, which is Tutor Perini's EXACT
 * ticker, so `buildEdgarCikIndex` correctly refuses the whole normalised key
 * and AT&T's preferred C is reported unmatched. Three of prod's 1,170 CIK-less
 * active stocks are exactly that case, and they are the three the guard is
 * SUPPOSED to protect:
 *
 *     T-P-C    -> T-PC    AT&T (0000732717)          not TPC   Tutor Perini
 *     INN-P-F  -> INN-PF  Summit Hotel (0001497645)  not INNPF Innocan Pharma
 *     BC-P-C   -> BC-PC   Brunswick (0000014930)     not BCPC  Balchem
 *
 * The rewrite KEEPS the dash, so `T-PC` and `TPC` stay two different keys and
 * the lookup runs against `byTicker` — the ambiguity-DISAMBIGUATED index —
 * rather than the lossy normalised one. That is why it is tried BEFORE the
 * punctuation pass rather than folded into it: a preferred resolved this way is
 * resolved by SEC's own spelling, not by a key that threw away the character
 * that distinguishes the two companies.
 *
 * MEASURED SAFETY, not asserted: over all 41,261 ACTIVE rows, 374 resolve under
 * BOTH this rule and the existing punctuation pass and they agree on the CIK in
 * every single case — ZERO disagreements. Three resolve only here. None resolve
 * only under the old path. So this can add a match and can never change one.
 *
 * Dash-only on purpose. `.`/`/` share-class spellings are real at other vendors
 * and are exactly why {@link normaliseUsTicker} strips them, but prod holds
 * ZERO US symbols containing either character — inventing a second spelling
 * here would be a rule with no population.
 */
export function toSecPreferredForm(ticker: string): string {
  return ticker
    .trim()
    .toUpperCase()
    .replace(/-P-([A-Z0-9]+)$/, "-P$1");
}

/**
 * What SHAPE of security a US ticker spells — MONEY-1353.
 *
 * Pure, and reporting-only. It exists because `unmatched` was a single integer
 * and could not answer the question anyone actually has about it: are these
 * fixable spellings, or securities SEC's file was never going to carry? It is
 * NEVER consulted by the enricher — a shape is not evidence of a CIK, and
 * turning "this looks like a warrant of FOO" into "stamp FOO's CIK on it" is
 * the mis-attribution this whole module refuses to make.
 */
export type UsTickerShape =
  | "preferred"
  | "warrant"
  | "unit"
  | "right"
  | "shareClass"
  | "plain";

export const US_TICKER_SHAPES: readonly UsTickerShape[] = [
  "preferred",
  "warrant",
  "unit",
  "right",
  "shareClass",
  "plain",
] as const;

/**
 * Classify a ticker's shape. Two notations, because the market has two.
 *
 * ## 1. The punctuated form — the exchange's own notation, and authoritative
 *
 * NYSE/AMEX spell a non-common security as `<BASE>-<MODIFIER>[-<QUALIFIER>]`:
 * `AAC-U` (unit), `ACHR-WS` (warrant), `AIIA-R` (right), `T-P-C` (preferred
 * series C), `BRK-A` (class A). `.` and `/` are accepted as separators because
 * other vendors use them, though prod holds zero of either (measured
 * 2026-09-05).
 *
 * The FIRST segment after the base decides, not the last. `HYT-R-W` is a RIGHT
 * that is also when-issued and `NE-WS-A` is a WARRANT of the A class — reading
 * the final segment would call the first a warrant and the second a share
 * class, both wrong. What the security IS comes first; everything after
 * qualifies it.
 *
 * ## 2. The bare five-character form — NASDAQ's fifth-letter convention
 *
 * A five-character NASDAQ ticker carries the modifier as its fifth letter:
 * `ASTSW` warrant, `AIMAU` unit, `AITRR` right, `FITBP` preferred, `LSXMA`
 * class A. Applied ONLY at exactly five characters, which is the convention's
 * own scope: `BREW`, `ASTR` and `AVGR` are four-character tickers that end in
 * those letters and are ordinary common stock (47 such rows in the CIK-less
 * population alone). Reading a fifth letter off a four-character ticker would
 * relabel every one of them.
 *
 * The remaining fifth letters (V, T, L, Z, O…) have no single meaning across
 * NASDAQ and the CTA tape and are left `plain` rather than guessed.
 *
 * A misread here costs a row in the wrong bucket of a report, which is why a
 * convention is good enough for this and would not be good enough for a write.
 */
export function classifyUsTickerShape(symbol: string): UsTickerShape {
  const s = symbol.trim().toUpperCase();
  if (s === "") return "plain";

  const parts = s.split(/[-./]/).filter((p) => p !== "");
  if (parts.length > 1) {
    // The first MODIFIER segment, i.e. the one after the base.
    const m = parts[1] ?? "";
    // `P`, `PA`, `P` + series — SEC's collapsed form and ours both land here.
    if (/^P[A-Z0-9]*$/.test(m)) return "preferred";
    if (m === "WS" || m === "W") return "warrant";
    if (m === "U") return "unit";
    if (m === "R") return "right";
    if (/^[A-Z]$/.test(m)) return "shareClass";
    return "plain";
  }

  // `AACTWS` — the two-letter warrant suffix on a bare symbol. Six characters
  // is already outside the US ticker length range, so the suffix is the only
  // thing it can be; measured 2026-09-05, prod holds exactly one such row and
  // it read `plain` in the first version of this table, which is the kind of
  // visibly-wrong cell that costs a report its credibility.
  if (/^[A-Z]{4,}WS$/.test(s) && s.length >= 6) return "warrant";

  if (/^[A-Z]{5}$/.test(s)) {
    switch (s[4]) {
      case "W":
        return "warrant";
      case "U":
        return "unit";
      case "R":
        return "right";
      case "P":
        return "preferred";
      case "A":
      case "B":
        return "shareClass";
      default:
        return "plain";
    }
  }

  return "plain";
}

/**
 * An EXCHANGE TEST SYMBOL — `NTEST-P`, `ATEST-A`, `ZXYZ-A`, `CTEST`.
 *
 * A cross-cutting FLAG rather than a seventh shape, because a test symbol also
 * has a shape: `NTEST-P` is preferred-spelled and `ATEST-A` is class-spelled.
 * Measured on prod 2026-09-05: 33 of the 1,170 CIK-less active stocks are these,
 * and ZERO test symbols anywhere in the table carry a CIK. They never will —
 * the exchanges publish them so members can test order entry, and no registrant
 * stands behind one. Surfaced so nobody spends a cycle chasing 33 rows that are
 * correct as they are.
 */
export function isExchangeTestSymbol(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  return /(^|[-./])[A-Z]?TEST([-./]|$)/.test(s) || /^ZXYZ([-./]|$)/.test(s);
}

/** A ticker -> CIK lookup, with the unresolvable tickers removed. */
export interface EdgarCikIndex {
  /** Exact uppercased ticker -> CIK. */
  byTicker: Map<string, string>;
  /** `normaliseUsTicker` form -> CIK, for the second pass. */
  byNormalised: Map<string, string>;
  /** Tickers dropped because two entries claimed different CIKs. */
  ambiguousTickers: string[];
}

/**
 * Parse `company_tickers.json`.
 *
 * The payload is an OBJECT keyed by a stringified index, not an array, and the
 * indices carry no meaning — they are the row numbers of SEC's own export.
 * Tolerant per entry: a malformed one is dropped, never thrown, because a shape
 * wobble in a single row must not cost the other 10,390.
 *
 * Also accepts a bare array. SEC has published this file as an object for years
 * and there is no evidence it will change, but the cost of accepting both is
 * three lines, and the failure mode of accepting one is the BSE lesson: the
 * enricher would report "0 usable rows" behind a `console.warn`, for ever.
 */
export function parseEdgarCompanyTickers(text: string): EdgarTickerRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];

  const entries: unknown[] = Array.isArray(parsed)
    ? parsed
    : Object.values(parsed as Record<string, unknown>);

  const out: EdgarTickerRow[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { cik_str?: unknown; ticker?: unknown; title?: unknown };

    const ticker =
      typeof e.ticker === "string" ? e.ticker.trim().toUpperCase() : "";
    if (ticker === "") continue;

    if (typeof e.cik_str !== "number" && typeof e.cik_str !== "string")
      continue;
    const cik = padCik(e.cik_str);
    if (cik === null) continue;

    out.push({
      ticker,
      cik,
      title: typeof e.title === "string" ? e.title.trim() : "",
    });
  }
  return out;
}

/**
 * Build the lookup, dropping any ticker two entries disagree about.
 *
 * "Disagree" means DIFFERENT CIKs for the same ticker. A repeated ticker with
 * the SAME CIK is a duplicate row, not a conflict, and is folded silently.
 *
 * A conflicting ticker is REMOVED rather than last-wins. That distinction cost
 * the BSE enricher a defect: its first version recorded the collision and then
 * called `.set` anyway, so it reported the ambiguity and resolved it
 * arbitrarily in the same breath. An ambiguous ticker here simply does not
 * match, and is counted.
 */
export function buildEdgarCikIndex(
  rows: readonly EdgarTickerRow[],
): EdgarCikIndex {
  const byTicker = new Map<string, string>();
  const ambiguous = new Set<string>();

  for (const row of rows) {
    const held = byTicker.get(row.ticker);
    if (held === undefined) {
      byTicker.set(row.ticker, row.cik);
      continue;
    }
    if (held === row.cik) continue;
    ambiguous.add(row.ticker);
    byTicker.delete(row.ticker);
  }
  for (const t of ambiguous) byTicker.delete(t);

  // The normalised index is built FROM the disambiguated exact index, so an
  // ambiguous ticker cannot re-enter through the second pass. Its own
  // collisions (`BRK.B` and `BRK-B` both normalising to `BRKB` under different
  // CIKs) are dropped by the same rule.
  const byNormalised = new Map<string, string>();
  const normAmbiguous = new Set<string>();
  for (const [ticker, cik] of byTicker) {
    const key = normaliseUsTicker(ticker);
    if (key === "") continue;
    const held = byNormalised.get(key);
    if (held === undefined) {
      byNormalised.set(key, cik);
      continue;
    }
    if (held === cik) continue;
    normAmbiguous.add(key);
  }
  for (const k of normAmbiguous) byNormalised.delete(k);

  return {
    byTicker,
    byNormalised,
    ambiguousTickers: [...ambiguous].sort(),
  };
}

/** The subset of a stored row this planner needs. */
export interface StoredUsInstrument {
  id: string;
  symbol: string;
  /**
   * Required, not optional — MONEY-1353. `unmatched` used to be one integer,
   * and the only way to break it down was for a caller to re-derive the match
   * itself, which is one rule stated twice and eventually disagreeing. So the
   * planner that DECIDES unmatched is also the thing that buckets it, and that
   * needs the venue on the row it is deciding about.
   */
  exchange: string;
  /**
   * Reads `null` for an ABSENT attribute when it comes back through a Prisma
   * `select` — which is every row that has never been stamped, since a Mongo
   * `db push` creates indexes and not fields. The PROJECTION is safe; it is the
   * FILTER that is not, which is why the caller leaves `cik` out of its `where`
   * entirely and decides emptiness here, from the value in hand.
   */
  cik: string | null;
}

export interface EdgarCikPlan {
  /** `{id, cik}` writes. Every id came from `stored`, so this cannot create. */
  updates: Array<{ id: string; cik: string }>;
  /** Stored rows whose ticker resolved to a CIK (whether or not it was new). */
  matched: number;
  /** Matched on the exact ticker. */
  matchedExact: number;
  /**
   * Matched only after rewriting our `-P-<series>` preferred spelling into
   * SEC's `-P<series>` — an EXACT hit on the disambiguated index, not a lossy
   * one. See {@link toSecPreferredForm}.
   */
  matchedSecForm: number;
  /** Matched only after punctuation normalisation. */
  matchedNormalised: number;
  /** Stored rows EDGAR has no entry for. Expected and large — see below. */
  unmatched: number;
  /**
   * `unmatched` split by venue — MONEY-1353.
   *
   * The single integer could not distinguish "NASDAQ's SPAC warrants are not in
   * SEC's file", which is the steady state, from "one venue's rows stopped
   * joining", which is a defect. Measured on prod 2026-09-05 the shape is
   * NASDAQ 531 / NYSE 377 / BATS 212 / AMEX 24 / NYSE MKT 14 / NYSE ARCA 12
   * across 1,170 CIK-less active stocks; a venue moving on its own is now
   * visible in the outcome line rather than needing a database query.
   */
  unmatchedByExchange: Record<string, number>;
  /**
   * The first {@link UNMATCHED_SAMPLE_LIMIT} unmatched tickers, in the order
   * the rows arrived.
   *
   * BOUNDED on purpose. The whole list runs to 1,170 entries on prod today and
   * a log line that long is a log line nobody reads — it would be truncated by
   * whatever renders it, at an offset nobody chose. Twenty is enough to see
   * WHAT KIND of ticker is missing (`AAC-U`, `ACHR-WS`, `AITRR`) which is the
   * question the integer could not answer; the full population belongs to
   * `scripts/data/us-cik-unmatched-report.ts`.
   */
  unmatchedSample: string[];
  /** Matched rows that already carried a CIK, so nothing was planned. */
  alreadySet: number;
}

/** How many unmatched tickers ride in {@link EdgarCikPlan.unmatchedSample}. */
export const UNMATCHED_SAMPLE_LIMIT = 20;

/**
 * Decide what to write. Pure, so the properties that matter are unit-testable
 * and the caller is only I/O.
 *
 * UPDATE-ONLY by construction: every planned write names an id that came out of
 * `stored`, so an EDGAR row matching nothing cannot become a row.
 *
 * `unmatched` being LARGE is the expected steady state, not a fault. EDGAR
 * lists ~10,391 registrants against ~14,041 active US securities, and the
 * difference is mostly ETFs and trusts, which register under a fund complex
 * rather than per-share-class. It is reported so a COLLAPSE — the number
 * jumping toward the row count, which is what a renamed `ticker` key would look
 * like — is visible, not so anyone chases it to zero.
 */
export function planEdgarCikEnrichment(
  index: EdgarCikIndex,
  stored: readonly StoredUsInstrument[],
): EdgarCikPlan {
  const plan: EdgarCikPlan = {
    updates: [],
    matched: 0,
    matchedExact: 0,
    matchedSecForm: 0,
    matchedNormalised: 0,
    unmatched: 0,
    unmatchedByExchange: {},
    unmatchedSample: [],
    alreadySet: 0,
  };

  const seen = new Set<string>();

  /**
   * One place that records a refusal, so the count, the venue breakdown and the
   * sample can never disagree about which rows they describe. The empty-symbol
   * branch below used to increment the bare counter on its own; with three
   * things to keep in step that is how one of them drifts.
   */
  const refuse = (row: StoredUsInstrument, symbol: string): void => {
    plan.unmatched++;
    const venue = row.exchange.trim() === "" ? "UNKNOWN" : row.exchange.trim();
    plan.unmatchedByExchange[venue] =
      (plan.unmatchedByExchange[venue] ?? 0) + 1;
    if (plan.unmatchedSample.length < UNMATCHED_SAMPLE_LIMIT) {
      plan.unmatchedSample.push(symbol === "" ? "(blank)" : symbol);
    }
  };

  for (const row of stored) {
    const symbol = row.symbol.trim().toUpperCase();
    if (symbol === "") {
      refuse(row, symbol);
      continue;
    }

    const exact = index.byTicker.get(symbol);
    /**
     * The SEC-form pass. It resolves the preferreds whose punctuation-stripped
     * form collides with another registrant's exact ticker — the rows the
     * ambiguity guard correctly refuses today. Measured on prod 2026-09-05:
     * adds 3, changes 0 of the 374 that already resolve.
     *
     * ITS POSITION IN THE `??` CHAIN IS IMMATERIAL TO THE VALUE, and saying
     * otherwise would be a claim no test can fail. `byNormalised` is built FROM
     * `byTicker`, so if `toSecPreferredForm(symbol)` is a key in `byTicker`
     * then that SEC ticker normalises to `normaliseUsTicker(symbol)` — which
     * makes `byNormalised.get(...)` either the SAME CIK or absent (dropped as
     * ambiguous). The two passes cannot disagree. Swapping them changes
     * nothing, and a mutation test proves exactly that.
     *
     * What DOES distinguish them is the counter below, and that is the point:
     * a preferred resolved by SEC's own spelling was resolved against the
     * disambiguated index, while one resolved by punctuation-stripping was
     * resolved by a key that threw away the character separating two
     * companies. Both are right today. Reporting them as one number is how
     * nobody would notice if that stopped being true.
     */
    const secForm =
      exact === undefined
        ? index.byTicker.get(toSecPreferredForm(symbol))
        : undefined;
    const cik =
      exact ??
      secForm ??
      index.byNormalised.get(normaliseUsTicker(symbol)) ??
      undefined;

    if (cik === undefined) {
      refuse(row, symbol);
      continue;
    }

    plan.matched++;
    if (exact !== undefined) plan.matchedExact++;
    else if (secForm !== undefined) plan.matchedSecForm++;
    else plan.matchedNormalised++;

    // ABSENT-ONLY. Never an overwrite: a CIK already on the row was put there
    // by a run that saw the same file or by a human, and this join has no
    // evidence that beats either.
    if ((row.cik ?? "").trim() !== "") {
      plan.alreadySet++;
      continue;
    }
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    plan.updates.push({ id: row.id, cik });
  }

  return plan;
}

/**
 * Is the EDGAR feed healthy, or did the payload change shape under us?
 *
 * Pure and exported for the reason `diagnoseBseFeed` is: the wrong version of
 * this kind of check has shipped twice as an inline condition nobody could
 * test — once requiring a signal that cannot occur for the case it guards, once
 * flagging the CONVERGED steady state as a failure.
 *
 * The discriminator here is whether the file still resolves tickers AT ALL. A
 * healthy converged run matches most of what it looks at and writes NOTHING,
 * because every CIK is already stored — so "planned no writes" must never be
 * the signal. "Matched almost nothing" is, because that is what a renamed
 * `ticker`/`cik_str` key produces: rows fetched, entries parsed, nothing joins.
 *
 * Returns null when the feed looks healthy.
 */
export function diagnoseEdgarFeed(input: {
  fetched: number;
  indexedTickers: number;
  candidates: number;
  matched: number;
}): string | null {
  const { fetched, indexedTickers, candidates, matched } = input;
  if (fetched === 0) return null; // the caller's 0-row branch owns this

  if (indexedTickers === 0) {
    return (
      `${fetched} EDGAR entries parsed but NONE produced a usable ` +
      `ticker -> CIK pair — the "ticker" or "cik_str" key has probably been ` +
      `renamed. Nothing can be joined this run.`
    );
  }

  // Denominator is the rows we actually looked at, not the file.
  //
  // Dividing by `fetched` would measure a numerator and a denominator drawn
  // from different populations — the BSE `rejectedShare` bug, exactly. With few
  // candidates the share would be diluted to nothing and a totally broken join
  // would score as healthy.
  if (candidates === 0) return null;
  const matchShare = matched / candidates;

  // 5% is a TOTAL-FAILURE floor, not a quality target, and the gap is
  // deliberate. The true steady-state match rate is unmeasured — it depends on
  // the stock/ETF split of the ~14,041 active US rows, and ETFs mostly register
  // under a fund complex rather than per share class, so a large unmatched
  // remainder is normal. Setting a threshold near an unverified expectation is
  // how a check pages somebody every night until it is muted, at which point it
  // protects nothing. Once a few runs have logged a real rate, this can be
  // tightened to a band around it.
  if (matchShare < 0.05) {
    return (
      `${matched}/${candidates} active US rows matched an EDGAR ticker ` +
      `(${Math.round(matchShare * 100)}%) against ${indexedTickers} indexed ` +
      `tickers. Below 5% the join has effectively stopped working — a renamed ` +
      `key or a scope change, not a converged universe.`
    );
  }

  return null;
}
