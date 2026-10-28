/**
 * MF portfolio section — MONEY-1204 (P14 / 14d.1).
 *
 * Two sources describe "what does this fund hold", and they are not equivalent:
 *
 *   - `MfPortfolioHolding` — the AMC's OWN monthly disclosure, published because
 *     SEBI requires it. Keyed `(period, amc, schemeKey, instrumentName)`, with a
 *     real `period` so a time series exists.
 *   - `FundHolding` — the Kuvera/AI-derived table, keyed
 *     `(fundType, fundId, holdingName)`. It has NO period at all: it is a single
 *     current snapshot that is overwritten, so it can answer "what does this
 *     fund hold now" and can never answer "what changed".
 *
 * The official one wins, always, and the fallback is LABELLED. That is not
 * politeness — the two disagree in ways a user cannot see. The AMC file is the
 * filing; the fallback is a third party's reading of one, sometimes an AI's, and
 * a weight from one presented as a weight from the other is a provenance lie of
 * exactly the shape MONEY-1198 was about.
 *
 * ## The join is the hard part, and it is allowed to fail
 *
 * The MF page is addressed by AMFI `schemeCode`. `MfPortfolioHolding` is keyed by
 * `schemeKey`, which is the AMC's own naming of its scheme inside its own
 * workbook — those strings are not AMFI codes and do not follow one convention
 * across AMCs. `amfiSchemeCode` is the bridge and it is NULLABLE.
 *
 * So an unresolved scheme is a NORMAL state, not an error, and it must be
 * COUNTED and shown rather than silently dropped: "this AMC published holdings
 * we could not attach to this scheme" is useful; an empty tab that implies the
 * AMC published nothing is not.
 */

/** Rows as read from `MfPortfolioHolding`. */
export interface MfPortfolioRow {
  /** Month the disclosure describes (month-end, UTC midnight). */
  period: Date;
  amc: string;
  schemeKey: string;
  amfiSchemeCode: string | null;
  instrumentName: string;
  isin: string | null;
  /** EQUITY | DEBT | CASH | DERIVATIVE | REIT_INVIT | GOLD | OTHER */
  holdingType: string;
  quantity: number | null;
  marketValue: number | null;
  /** Share of net assets, in PERCENT. Null = not disclosed; 0 = disclosed zero. */
  percentToNav: number | null;
  source: string;
}

/** Rows as read from `FundHolding` (the fallback). */
export interface FundHoldingRow {
  holdingName: string;
  holdingSymbol: string | null;
  isin: string | null;
  holdingType: string;
  sector: string | null;
  /** Non-nullable in the model, unlike percentToNav above. */
  weightPercent: number;
  source: string;
}

/** One line of the rendered portfolio, source-agnostic. */
export interface MfHoldingLine {
  name: string;
  isin: string | null;
  symbol: string | null;
  holdingType: string;
  weightPct: number | null;
  marketValue: number | null;
  quantity: number | null;
}

export interface MfPortfolioSection {
  lines: MfHoldingLine[];
  /** `"MF_PORTFOLIO"` (official) or `"FUND_HOLDING"` (fallback). */
  source: "MF_PORTFOLIO" | "FUND_HOLDING" | null;
  /** True when serving the non-preferred source. Drives the UI's chip. */
  fallback: boolean;
  /** Month the official data describes; null for the period-less fallback. */
  period: Date | null;
  /** Holdings the AMC published that could not be attached to a scheme. */
  unresolvedSchemes: string[];
}

/**
 * Pick the source and shape the lines.
 *
 * Official wins whenever it has ANY row. "Any row" rather than "enough rows" on
 * purpose: a genuinely small portfolio and a partial parse look identical from
 * here, and silently preferring the fallback because the filing looked thin
 * would hide the parse problem behind plausible data.
 *
 * ## PRECONDITION: `official` holds ONE (amc, schemeKey) — MONEY-1401
 *
 * This function does no grouping. Every row in the newest period becomes a
 * line, so handing it two sheets renders both as one portfolio: four lines
 * summing to ~200%, printed verbatim as "200.0% across 4 of 4 holdings".
 * {@link diffMfPortfolio} is weaker still — its map is keyed on
 * `instrumentName` ALONE, so a name held by both sheets silently takes
 * whichever row arrived last.
 *
 * That is REACHABLE rather than hypothetical: `schemeKeyOf` (the STORAGE key)
 * is separator-SENSITIVE while `schemeFamilyKey` (which resolves the CODES) is
 * separator-FREE, so one family can legitimately produce two storage keys
 * carrying one `amfiSchemeCodes` array — measured, 57 of 4,109 families.
 *
 * The narrowing is deliberately the CALLER's, at the query
 * (`getMfPortfolioSection` scopes every read after the resolve to the newest
 * row's own `(amc, schemeKey)`), and is NOT re-derived here. A grouping rule in
 * this function would have to PICK one of the two sheets with nothing to pick
 * on — a second, arbitrary identity rule disagreeing with the query's, which is
 * the same mistake `resolveSchemeCodes`' `codes[0]` is documented as avoiding.
 * One caller, one place to be right.
 */
export function buildMfPortfolioSection(args: {
  official: readonly MfPortfolioRow[];
  fallback: readonly FundHoldingRow[];
  unresolvedSchemes?: readonly string[];
}): MfPortfolioSection {
  const unresolvedSchemes = [...(args.unresolvedSchemes ?? [])];

  if (args.official.length > 0) {
    const period = latestPeriod(args.official);
    // Only the newest month renders; older ones exist for the MoM diff below.
    const current = args.official.filter(
      (r) => period !== null && r.period.getTime() === period.getTime(),
    );
    return {
      lines: current
        .map((r) => ({
          name: r.instrumentName,
          isin: r.isin,
          symbol: null,
          holdingType: r.holdingType,
          weightPct: r.percentToNav,
          marketValue: r.marketValue,
          quantity: r.quantity,
        }))
        .sort(byWeightDesc),
      source: "MF_PORTFOLIO",
      fallback: false,
      period,
      unresolvedSchemes,
    };
  }

  if (args.fallback.length > 0) {
    return {
      lines: args.fallback
        .map((r) => ({
          name: r.holdingName,
          isin: r.isin,
          symbol: r.holdingSymbol,
          holdingType: r.holdingType,
          weightPct: r.weightPercent,
          marketValue: null,
          quantity: null,
        }))
        .sort(byWeightDesc),
      source: "FUND_HOLDING",
      fallback: true,
      // The fallback table has no period column at all. Null is the honest
      // value; stamping it with "now" would assert a vintage it does not have.
      period: null,
      unresolvedSchemes,
    };
  }

  return {
    lines: [],
    source: null,
    fallback: false,
    period: null,
    unresolvedSchemes,
  };
}

/**
 * Sort heaviest first, with unknown weights LAST rather than treated as 0.
 *
 * A null weight is "not disclosed", and sorting it as zero would bury a
 * potentially large undisclosed position at the bottom next to the genuinely
 * tiny ones.
 */
function byWeightDesc(a: MfHoldingLine, b: MfHoldingLine): number {
  const aw = a.weightPct;
  const bw = b.weightPct;
  if (aw === null && bw === null) return a.name.localeCompare(b.name);
  if (aw === null) return 1;
  if (bw === null) return -1;
  if (aw !== bw) return bw - aw;
  return a.name.localeCompare(b.name);
}

export function latestPeriod(rows: readonly MfPortfolioRow[]): Date | null {
  let best: number | null = null;
  for (const r of rows) {
    const t = r.period instanceof Date ? r.period.getTime() : NaN;
    if (!Number.isFinite(t)) continue;
    if (best === null || t > best) best = t;
  }
  return best === null ? null : new Date(best);
}

export interface MfPortfolioDiff {
  /** Month being compared. */
  period: Date | null;
  /** Month it is compared against; null when there is only one month. */
  previousPeriod: Date | null;
  entered: string[];
  exited: string[];
  /** Positions in both months whose weight moved, newest weight first. */
  changed: Array<{ name: string; from: number | null; to: number | null }>;
}

/**
 * What the fund bought into and out of, month over month.
 *
 * Compares the two most recent DISTINCT periods present, NOT "this month vs last
 * calendar month". AMC disclosures skip months — a scheme can publish in March
 * and then May — and asking for a calendar-previous month that was never
 * published would report every holding as newly entered, which is the most
 * alarming possible rendering of "we have no data".
 *
 * `previousPeriod: null` (only one month present) yields EMPTY entered/exited,
 * not "everything entered". With nothing to compare against, the honest answer
 * is that no change is known.
 */
export function diffMfPortfolio(
  rows: readonly MfPortfolioRow[],
): MfPortfolioDiff {
  const periods = [
    ...new Set(
      rows
        .map((r) => (r.period instanceof Date ? r.period.getTime() : NaN))
        .filter((t) => Number.isFinite(t)),
    ),
  ].sort((a, b) => b - a);

  const period = periods[0] !== undefined ? new Date(periods[0]) : null;
  const previousPeriod = periods[1] !== undefined ? new Date(periods[1]) : null;
  if (period === null || previousPeriod === null) {
    return { period, previousPeriod, entered: [], exited: [], changed: [] };
  }

  const at = (t: number): Map<string, number | null> => {
    const m = new Map<string, number | null>();
    for (const r of rows) {
      if (r.period.getTime() !== t) continue;
      // Identity is the instrument NAME, because that is what the unique key
      // uses and what every AMC prints; ISIN is frequently absent on debt and
      // cash lines in these workbooks.
      m.set(r.instrumentName, r.percentToNav);
    }
    return m;
  };
  const now = at(period.getTime());
  const prev = at(previousPeriod.getTime());

  const entered: string[] = [];
  const exited: string[] = [];
  const changed: Array<{
    name: string;
    from: number | null;
    to: number | null;
  }> = [];

  for (const [name, to] of now) {
    if (!prev.has(name)) {
      entered.push(name);
      continue;
    }
    const from = prev.get(name) ?? null;
    // A null on either side is NOT a change of weight — it is a change in what
    // was disclosed. Reporting it as a move would invent a trade.
    if (from !== null && to !== null && from !== to) {
      changed.push({ name, from, to });
    }
  }
  for (const name of prev.keys()) {
    if (!now.has(name)) exited.push(name);
  }

  entered.sort();
  exited.sort();
  changed.sort((a, b) => (b.to ?? 0) - (a.to ?? 0));
  return { period, previousPeriod, entered, exited, changed };
}

/**
 * Sum of disclosed weights, and how much of the portfolio that accounts for.
 *
 * Returns the count of lines whose weight was NOT disclosed alongside the total,
 * so a UI can say "92.4% across 48 of 51 holdings" rather than presenting 92.4%
 * as if the remaining 7.6% were cash. Those are different statements and only
 * one of them is supported by the data.
 */
export function disclosedWeight(lines: readonly MfHoldingLine[]): {
  totalPct: number;
  disclosed: number;
  undisclosed: number;
} {
  let totalPct = 0;
  let disclosed = 0;
  let undisclosed = 0;
  for (const l of lines) {
    if (l.weightPct === null || !Number.isFinite(l.weightPct)) {
      undisclosed++;
      continue;
    }
    totalPct += l.weightPct;
    disclosed++;
  }
  return { totalPct, disclosed, undisclosed };
}

/* -------------------------------------------------------------------------- */
/* Scheme-code lookup — MONEY-1294                                            */
/* -------------------------------------------------------------------------- */

/**
 * The `where` that finds a scheme's disclosure rows by AMFI scheme code.
 *
 * ## Why there are two arms
 *
 * AMFI splits ONE filed portfolio into up to four scheme codes — Direct and
 * Regular, each Growth and IDCW. `mf_portfolio_holdings` therefore carries both
 * `amfiSchemeCode` (the primary, one value, and the only column that existed
 * before this ticket) and `amfiSchemeCodes` (all of them). A reader that
 * consults only the primary answers "no disclosure" for the other three plans
 * of a fund whose portfolio is sitting in the table.
 *
 * The old rows are the other half. 54,248 rows predate `amfiSchemeCodes`, so
 * the field is ABSENT on them — `db push` creates indexes, not fields — and the
 * monthly sync only rewrites the CURRENT period, so history never backfills
 * itself. Dropping the `amfiSchemeCode` arm would make every prior month
 * unreadable, which is precisely the two months this table's diff needs.
 *
 * ## Both arms are POSITIVE predicates, deliberately
 *
 * Neither mentions `null`. On MongoDB a missing field is not null-valued, so
 * `{f: null}` AND `{f: {not: null}}` both return zero over a field a `db push`
 * never created — the class behind MONEY-1050 / 1205 / 1234 / 1236. `has` asks
 * whether an array contains a value, which an absent field simply does not, and
 * an equality test on an absent scalar likewise just fails to match. So this
 * composes safely regardless of which columns a given row was written with.
 *
 * Both arms are indexed (`@@index([amfiSchemeCode, period Desc])` and
 * `@@index([amfiSchemeCodes, period Desc])`); without the second, the OR
 * degrades to a collection scan on every composition read.
 *
 * IN `schema.prisma`, WHICH IS NOT THE SAME AS IN A DATABASE — MONEY-1401.
 * Both indexes were added by 8a2f8199, and Mongo has no migration step here:
 * they are created by a manual `yarn workspace @usemoney/database prisma db
 * push`, PER ENVIRONMENT, which is a deploy action nobody is reminded to take.
 * Until it has been run against an environment, the reads there really are
 * collection scans. Three sibling comments said the opposite ("`amfiSchemeCode`
 * has none") in that same commit, because they were written before the index
 * and read after it; `db.mf_portfolio_holdings.getIndexes()` is the only
 * statement about a live database.
 */
export function schemeCodeWhere(schemeCode: string): {
  OR: [{ amfiSchemeCode: string }, { amfiSchemeCodes: { has: string } }];
} {
  return {
    OR: [
      { amfiSchemeCode: schemeCode },
      { amfiSchemeCodes: { has: schemeCode } },
    ],
  };
}
