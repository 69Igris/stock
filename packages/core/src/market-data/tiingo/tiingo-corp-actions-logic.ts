/**
 * Pure, side-effect-free helpers for US corporate actions from Tiingo —
 * MONEY-1263.
 *
 * Extracted from `tiingo-corp-actions.ts` for the reason every `-logic.ts` in
 * this package exists: the code production runs must be reachable by a unit
 * test with no network, no Prisma and no GCS. There are no parallel copies —
 * the client imports these and calls them.
 *
 * Everything here was written against RESPONSES MEASURED FROM THE LIVE API on
 * 2026-08-28. Four of the rules below contradict the documentation or the
 * obvious reading, and each contradiction is called out where it applies.
 *
 * ## The four measured facts that shape this file
 *
 *   1. A day with NO corporate actions answers 200 with the literal four-byte
 *      body `None` — not an empty CSV, not `[]`. See {@link isEmptyCorpActionsBody}.
 *   2. The API's `ticker` is LOWERCASE (`aapl`); every other US table in this
 *      repo stores UPPERCASE. See {@link toUsCorporateActionRows}.
 *   3. The market-wide batch legitimately returns TWO rows for one ticker on
 *      one day — different companies, different `permaTicker`. See
 *      {@link dedupeCorpActions}.
 *   4. Dates arrive in TWO formats depending on `format=`. See
 *      {@link parseTiingoDate}.
 */

import { splitCsvLine } from "../csv-line";

/**
 * One row of `/tiingo/corporate-actions/distributions`, as Tiingo prints it.
 *
 * Dates are normalised to ISO `YYYY-MM-DD` (or null); numbers are parsed. The
 * shape is otherwise the wire shape, so a reader can diff it against a captured
 * response without a mental translation step.
 */
export interface TiingoDistributionRow {
  /** Tiingo's durable security id, e.g. `US000000000038`. Opaque — never cased. */
  permaTicker: string;
  /** As filed, LOWERCASE. Not an identity — see {@link toUsCorporateActionRows}. */
  ticker: string;
  exDate: string;
  paymentDate: string | null;
  recordDate: string | null;
  declarationDate: string | null;
  /**
   * Per-share cash, gross. NULLABLE and separately ZEROABLE, and the two are
   * different things — see {@link toUsCorporateActionRows}.
   */
  distribution: number | null;
  /** `w|bm|m|tm|q|sa|a|ir|f|u|c`. Blank on most rows, including all of AAPL's. */
  distributionFrequency: string | null;
}

/** One row of `/tiingo/corporate-actions/splits`. */
export interface TiingoSplitRow {
  permaTicker: string;
  ticker: string;
  exDate: string;
  /** The human ratio's denominator. Null on 65 of 67 live rows. */
  splitFrom: number | null;
  splitTo: number | null;
  /** `splitTo / splitFrom`. A REVERSE split is `< 1`. NEVER equality-test it. */
  splitFactor: number | null;
}

/** The two kinds `UsCorporateAction.type` carries. */
export type UsCorporateActionType = "DIVIDEND" | "SPLIT";

/**
 * A `UsCorporateAction` ready for Prisma — every column the model declares
 * except the generated ones (`id`, `createdAt`, `updatedAt`).
 *
 * Typed structurally rather than imported from `@usemoney/database`: this
 * package must stay Prisma-free (see the package restrictions), and a
 * hand-written shape that drifts from the schema is caught by the writer's own
 * compile, not hidden by a loose `any`.
 */
export interface UsCorporateActionRow {
  permaTicker: string;
  /** UPPERCASE. See {@link toUsCorporateActionRows} for why that is load-bearing. */
  symbol: string;
  listingId: string | null;
  type: UsCorporateActionType;
  exDate: Date;
  distribution: number | null;
  distributionFrequency: string | null;
  splitFactor: number | null;
  splitFrom: number | null;
  splitTo: number | null;
  paymentDate: Date | null;
  recordDate: Date | null;
  declarationDate: Date | null;
  currency: string;
  source: string;
}

/**
 * The occupancy window of one listing, as much of it as
 * {@link resolveListingId} needs.
 *
 * Declared structurally instead of importing `TiingoListing` from
 * `instruments/tiingo-instruments-logic.ts`. `TiingoListing` is assignable to
 * it, so the caller passes its rows unchanged, and this file gains no
 * dependency on the instrument master's own evolution — the two modules answer
 * different questions and should not be able to break each other.
 */
export interface CorpActionListingWindow {
  /** `{symbol}:{exchange}:{startDate}` — see `buildListingId`. */
  listingId: string;
  /** ISO `YYYY-MM-DD`, or null when the master leaves it blank. */
  listingStartDate: string | null;
  listingEndDate: string | null;
}

/**
 * Currency and source, spelled once.
 *
 * `UsCorporateAction` defaults both in the schema, but a `create` that omits a
 * defaulted column and one that sets it are different writes the day someone
 * adds a second source, and this table WILL get one — every price feed in this
 * repo eventually does. Writing them explicitly makes the provenance a property
 * of the writer rather than of the schema's current defaults.
 */
export const TIINGO_CORP_ACTION_CURRENCY = "USD";
export const TIINGO_CORP_ACTION_SOURCE = "TIINGO";

/**
 * The columns each CSV must carry for its parse to be meaningful.
 *
 * Calibrated to what the parser HARD-REQUIRES and no more — the same rule
 * `feed-payload.ts` states for its `requiredTokens`, and for the same reason: a
 * check stricter than the parser rejects valid files, which is strictly worse
 * than the gap it was meant to close.
 *
 * `splitFrom`/`splitTo` are deliberately NOT required for splits: they are
 * legitimately blank on real rows (65 of 67 split rows carry no ratio), so
 * requiring them would reject the historical majority of the data. A required
 * COLUMN and a populated CELL are different things — `distribution` is required
 * below and is still allowed to be blank.
 *
 * ## `distribution` and `splitFactor` are what make these lists DISCRIMINATING
 *
 * Found by mutation testing, MONEY-1263. The first version of
 * `DISTRIBUTION_REQUIRED` was `[permaTicker, ticker, exDate]` — and the SPLITS
 * response carries all three. So `parseDistributionsCsv` handed a splits CSV
 * returned FIVE rows: real permaTickers, real ex-dates, `type: "DIVIDEND"`, and
 * `distribution: null` because there was no such column. Rows that would be
 * written, indexed, and read by a dividends tab as five dividends that never
 * happened.
 *
 * The two lists must therefore each name a column the OTHER feed does not have,
 * and they now do: `distribution` appears only on the distributions header,
 * `splitFactor` only on the splits header. That is what turns "the required
 * columns are present" into "this is the feed I asked for". The check is still
 * no stricter than the parser — a distribution parse genuinely cannot produce a
 * distribution without a `distribution` column.
 *
 * ## The two sides were NOT symmetric, and the asymmetry is the whole story
 *
 * `parseSplitsCsv` was already safe against a distributions CSV before that
 * change, because its ROW guard drops any row whose `splitFactor` is null and a
 * distributions response has no such column — so every row fell out one at a
 * time and the result was `[]` either way. Removing `splitFactor` from the list
 * below was an EQUIVALENT mutation: measured, it changed no observable
 * behaviour, only how early the parser gave up.
 *
 * `parseDistributionsCsv` had no such second line of defence. Its row guard
 * checks `permaTicker`/`ticker`/`exDate`, all three of which a splits row
 * happily supplies, and `distribution` was allowed to be absent because a blank
 * CELL is legitimate. One rule stated once, in the one place it could not
 * fire — which is why the file-level check is kept on BOTH sides even though
 * only one side needed it. A guard that exists on one branch of a symmetric
 * pair is a guard the next reader deletes.
 *
 * That equivalence is now GONE, and deliberately so (MONEY-1263 review, F5): a
 * missing required column THROWS {@link TiingoCorpActionsShapeError} instead of
 * returning `[]`, so dropping `splitFactor` from the list below turns a loud
 * refusal into a silent empty day and a test fails. Both lists are now
 * mutation-sensitive on both sides.
 */
const DISTRIBUTION_REQUIRED = [
  "permaTicker",
  "ticker",
  "exDate",
  "distribution",
] as const;
const SPLIT_REQUIRED = [
  "permaTicker",
  "ticker",
  "exDate",
  "splitFactor",
] as const;

/**
 * Does this body mean "no corporate actions on this day"?
 *
 * ## Measured 2026-08-28, and it is NOT what any reasonable person would guess
 *
 * With `format=csv`, a day with zero actions answers **HTTP 200 with the
 * four-byte body `None`** — on BOTH routes, verified on Sunday 2026-08-23:
 *
 *     splits?exDate=2026-08-23&format=csv        -> 200, 4 bytes, `None`
 *     distributions?exDate=2026-08-23&format=csv -> 200, 4 bytes, `None`
 *
 * That is Python's `None` reaching the wire through their CSV serializer. The
 * JSON form of the same request is correct (`[]`, 2 bytes), so this is a defect
 * in one serializer rather than a documented sentinel — which means it could be
 * fixed upstream without warning, and this function must therefore accept the
 * corrected shapes too.
 *
 * ## Why this is an EXPLICIT check and not left to the parsers
 *
 * `None` has no comma, so the header-name lookup below cannot find
 * `permaTicker`. That used to make the parser return `[]` by accident; since
 * MONEY-1263's F5 fix it makes the parser THROW — so without this guard the
 * commonest response in the whole walk (a market holiday, a quiet weekday)
 * would be reported as a broken feed and circuit-break the run. The guard was
 * always necessary; it is now necessary in the opposite direction too, which is
 * the strongest possible argument for stating emptiness as a rule rather than
 * letting it fall out of a parser's internals.
 *
 * Relax the required-column check instead and `None` becomes one junk row with
 * `permaTicker: "None"` — a row that would be written, deduped, indexed and
 * never questioned, because it looks exactly like data. Both failure directions
 * are pinned by tests.
 *
 * The empty string and a whitespace-only body are folded in for the same
 * reason, and `[]`/`{}` because the JSON form is one `format=` away.
 */
export function isEmptyCorpActionsBody(text: string): boolean {
  const t = text.trim();
  return t === "" || t === "None" || t === "[]" || t === "{}";
}

/**
 * Normalise a Tiingo date to ISO `YYYY-MM-DD`, or null.
 *
 * ## Both forms are real, and which one you get depends on `format=`
 *
 * Measured 2026-08-28:
 *
 *     format=csv   ->  `1987-11-17`                (bare)
 *     JSON default ->  `1987-11-17T05:00:00.000Z`  (instant)
 *
 * We fetch CSV (~26% of the JSON bytes for the same rows), so the bare form is
 * what production sees. The ISO branch exists anyway because the JSON form is
 * one query parameter away, an archived object may predate a format change, and
 * a function that silently returned null for the shape it was not expecting
 * would empty a column rather than fail.
 *
 * ## Why the instant is TRUNCATED and not converted
 *
 * `05:00:00.000Z` is midnight US/Eastern in winter and `04:00:00.000Z` is
 * midnight in summer, so Tiingo is encoding a CALENDAR DAY in Eastern time, not
 * a moment. Truncating to the first ten characters recovers exactly that day
 * for both offsets. Running it through `new Date(...)` and reading UTC parts
 * would also work today — but only because the encoded hour happens to stay on
 * the same UTC date, and an ex-date is a market-calendar fact that must not
 * depend on that coincidence. `parseTiingoEodCsv` truncates for the same reason.
 *
 * The shape is then VALIDATED rather than assumed: anything that is not ten
 * characters of `YYYY-MM-DD` returns null, so a reformat upstream shows up as a
 * null column instead of a `Invalid Date` reaching Prisma.
 */
export function parseTiingoDate(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const day = raw.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * An ISO day as a `Date` anchored at UTC midnight.
 *
 * UTC, never local: the writer runs on Cloud Run (UTC) and on a founder laptop
 * (IST, +5:30). `new Date("2026-08-25")` is already UTC-anchored, but
 * `new Date(2026, 7, 25)` is not, and the two spellings sit one careless edit
 * apart. Spelling the `T00:00:00Z` out loud removes the choice.
 *
 * An ex-date is a calendar day, so any anchor works as long as it is the SAME
 * anchor everywhere — this is that anchor, and `@@unique([permaTicker, type,
 * exDate])` is why it has to be: two runs disagreeing by an hour would write
 * two rows for one event.
 */
export function isoDayToUtcDate(day: string | null): Date | null {
  if (day === null) return null;
  const d = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Read a numeric cell, returning null for blank / non-finite rather than NaN. */
function numOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * A corporate-actions CSV whose HEADER is not the header this parser was
 * written against — MONEY-1263 review, F5.
 *
 * ## Why this is a THROW and not a `return []`
 *
 * Both parsers used to answer a missing required column with `[]`, which is
 * BYTE-IDENTICAL downstream to the far more common and entirely benign "this
 * day had no corporate actions". The backfill maps `rows.length === 0` to the
 * TERMINAL status `EMPTY`, so a single renamed column would have walked the
 * whole requested range — up to ~18,000 (day, route) pairs for a
 * `--from=1990-01-01` run — writing "nothing happened" for every one of them,
 * exiting 0, and skipping the entire window on every later run. Recoverable
 * only with `--retry-terminal` by an operator who first has to suspect it.
 *
 * ## The archive's shape check does NOT cover this
 *
 * `FEED_SHAPES["TIINGO/distributions"].requiredTokens` is
 * `["permaTicker", "exDate"]` — it does NOT include `distribution`, the one
 * column {@link DISTRIBUTION_REQUIRED} adds precisely because the splits feed
 * lacks it. So a rename of `distribution` PASSES archive validation, gets
 * archived as a healthy object, and then parses to zero rows. `ticker` is in
 * neither list and is required by both parsers. Two independent rules, one of
 * them unable to see the other's requirement — which is why the parser has to
 * be the one that refuses.
 *
 * Throwing rather than returning a discriminated union is deliberate: this is
 * not a value a caller might reasonably ignore, and every call site in the repo
 * (the backfill script, the worker's CA calendar leg) already sits inside a
 * `try` that treats an unrecognised error as a counted transport failure rather
 * than as data. A union would have needed each of them to add a branch, and a
 * branch nobody adds is the `return []` we are replacing.
 */
export class TiingoCorpActionsShapeError extends Error {
  constructor(
    /** Which route's parser refused. */
    readonly feed: "distributions" | "splits",
    /** The required columns that were absent. Never empty. */
    readonly missing: readonly string[],
    /** The header we actually got, for triage. */
    readonly header: readonly string[],
  ) {
    super(
      `Tiingo ${feed} CSV is missing required column(s): ${missing.join(", ")}. ` +
        `Header was: [${header.join(", ")}]. This is a SHAPE failure, not an ` +
        `empty day — refusing to return zero rows, because a caller cannot ` +
        `tell the two apart and would checkpoint the whole walk as ` +
        `"nothing happened".`,
    );
    this.name = "TiingoCorpActionsShapeError";
  }
}

/**
 * Index a CSV's header row BY NAME, reporting any required column that is
 * absent.
 *
 * By name, never by position — the same rule `parseTiingoEodCsv` states, and it
 * was earned there: Tiingo's EOD endpoint emits `close` SECOND and `open` FIFTH
 * while the docs say open/high/low/close, so a positional parser written from
 * the documentation swaps every open and close, throws nothing, and produces
 * plausible wrong data forever. The corporate-actions headers happen to match
 * their documentation today. "Happens to match today" is not a reason to index
 * positionally; it is the state every silently-broken parser starts in.
 *
 * Returns the missing names rather than a bare null so the caller's error can
 * NAME the column that moved. "A required column is missing" sends an operator
 * to diff two CSVs by hand; "`distribution` is missing, header was
 * [permaTicker, ticker, exDate, …]" is the whole diagnosis.
 */
function headerIndex(
  headerLine: string,
  required: readonly string[],
): { idx: Map<string, number>; header: string[]; missing: string[] } {
  const header = splitCsvLine(headerLine).map((h) => h.trim());
  const idx = new Map(header.map((h, i) => [h, i]));
  const missing = required.filter((col) => !idx.has(col));
  return { idx, header, missing };
}

/** Split a CSV body into non-blank lines. */
function contentLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "");
}

/**
 * Parse a `distributions` CSV response.
 *
 * Live header, measured 2026-08-28:
 *
 *     permaTicker,ticker,exDate,paymentDate,recordDate,declarationDate,distribution,distributionFrequency
 *
 * Tolerant per ROW and strict per FILE: a malformed row is dropped, but a
 * missing required COLUMN THROWS {@link TiingoCorpActionsShapeError} for the
 * whole response. One bad row in a 6,482-row day must not cost the day; a
 * missing `permaTicker` column means we are not looking at this feed at all,
 * and guessing past that is how a parser writes 6,482 rows of nonsense.
 *
 * The header is checked BEFORE the "are there any data rows" test, and the
 * order is load-bearing: a one-line body carrying the WRONG header (an error
 * page that answered 200, a route that started serving a different feed) would
 * otherwise fall out of the row test as a benign zero-row day. `None` and the
 * JSON empties are still recognised first, because those really are empty days.
 */
export function parseDistributionsCsv(text: string): TiingoDistributionRow[] {
  if (isEmptyCorpActionsBody(text)) return [];

  const lines = contentLines(text);
  if (lines.length === 0) return [];

  const { idx, header, missing } = headerIndex(
    lines[0]!,
    DISTRIBUTION_REQUIRED,
  );
  if (missing.length > 0) {
    throw new TiingoCorpActionsShapeError("distributions", missing, header);
  }
  if (lines.length < 2) return [];

  const out: TiingoDistributionRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const at = (col: string): string | undefined => cells[idx.get(col) ?? -1];
    const str = (col: string): string => (at(col) ?? "").trim();

    const permaTicker = str("permaTicker");
    const ticker = str("ticker");
    const exDate = parseTiingoDate(str("exDate"));
    // The unique key is (permaTicker, type, exDate). A row missing either half
    // of it cannot be written or deduped, so it is not a row — dropping it here
    // is the only place that decision costs nothing.
    if (permaTicker === "" || ticker === "" || exDate === null) continue;

    out.push({
      permaTicker,
      ticker,
      exDate,
      paymentDate: parseTiingoDate(str("paymentDate")),
      recordDate: parseTiingoDate(str("recordDate")),
      declarationDate: parseTiingoDate(str("declarationDate")),
      distribution: numOrNull(at("distribution")),
      distributionFrequency: str("distributionFrequency") || null,
    });
  }
  return out;
}

/**
 * Parse a `splits` CSV response.
 *
 * Live header, measured 2026-08-28:
 *
 *     permaTicker,ticker,exDate,splitFrom,splitTo,splitFactor
 *
 * `splitStatus` DOES NOT EXIST on this route — checked across all 67 split rows
 * in JSON and CSV alike. Written down because it appears in third-party
 * descriptions of Tiingo's schema, and a parser that reserves a column for it
 * would report `null` forever and read as a coverage gap rather than as a field
 * that was never there.
 *
 * Throws {@link TiingoCorpActionsShapeError} on a missing required column, for
 * the reason spelled out on that class and on {@link parseDistributionsCsv}.
 * Kept symmetric with the distributions side even though this route's ROW guard
 * would already drop every row of a foreign feed: a guard that exists on one
 * branch of a symmetric pair is a guard the next reader deletes.
 */
export function parseSplitsCsv(text: string): TiingoSplitRow[] {
  if (isEmptyCorpActionsBody(text)) return [];

  const lines = contentLines(text);
  if (lines.length === 0) return [];

  const { idx, header, missing } = headerIndex(lines[0]!, SPLIT_REQUIRED);
  if (missing.length > 0) {
    throw new TiingoCorpActionsShapeError("splits", missing, header);
  }
  if (lines.length < 2) return [];

  const out: TiingoSplitRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const at = (col: string): string | undefined => cells[idx.get(col) ?? -1];
    const str = (col: string): string => (at(col) ?? "").trim();

    const permaTicker = str("permaTicker");
    const ticker = str("ticker");
    const exDate = parseTiingoDate(str("exDate"));
    if (permaTicker === "" || ticker === "" || exDate === null) continue;

    const splitFactor = numOrNull(at("splitFactor"));
    // A split with no factor cannot adjust anything, and a NON-POSITIVE one
    // would divide by zero or flip the sign of every historical price. Dropped
    // rather than stored: `computeAdjustedSeries` already guards `<= 0` on the
    // price path, and a row that only exists to be skipped downstream is a row
    // that eventually gets read by something that forgot to skip it.
    if (splitFactor === null || splitFactor <= 0) continue;

    out.push({
      permaTicker,
      ticker,
      exDate,
      splitFrom: numOrNull(at("splitFrom")),
      splitTo: numOrNull(at("splitTo")),
      splitFactor,
    });
  }
  return out;
}

/**
 * The `listingId` this action belongs to, or null when we cannot PROVE one.
 *
 * ## Why this refuses instead of guessing
 *
 * `UsCorporateAction`'s key is `permaTicker`; the security master
 * (`supported_tickers.csv`) has NO permaTicker column — its columns are
 * ticker/exchange/assetType/priceCurrency/startDate/endDate. So the only join
 * available is on the TICKER, and the ticker is exactly the field this table's
 * schema header spends twenty lines explaining is not an identity: `DOW` names
 * Dow Chemical (1972-2017) and Dow Inc. (2019-), and 834 delisted US rows share
 * a ticker with a live one.
 *
 * `selectPrimaryListings` collapses each recycled ticker to ONE surviving
 * window, so a naive `Map<ticker, listingId>` lookup would file Dow Chemical's
 * 1990s dividends under Dow Inc.'s listing — silently, and indistinguishably
 * from correct data. That is the same failure `isRecycledResponse` exists to
 * prevent on the price path.
 *
 * The window is the discriminator that makes the join sound: an action whose
 * ex-date falls inside `[listingStartDate, listingEndDate]` provably belongs to
 * that occupant, and one that falls outside provably does not. Outside, this
 * returns null and the column stays empty — which is precisely why the schema
 * made it nullable ("a corporate action can arrive for a security we do not
 * carry").
 *
 * A null `listingStartDate` or `listingEndDate` is treated as an OPEN bound
 * rather than a failure: the master leaves them blank on a small number of
 * rows, and an open bound narrows nothing while still rejecting a date on the
 * wrong side of the bound that IS present.
 */
export function resolveListingId(
  exDate: string,
  listing: CorpActionListingWindow | undefined,
): string | null {
  if (!listing) return null;
  if (listing.listingStartDate !== null && exDate < listing.listingStartDate) {
    return null;
  }
  if (listing.listingEndDate !== null && exDate > listing.listingEndDate) {
    return null;
  }
  return listing.listingId;
}

/**
 * Map parsed distributions and splits onto Prisma-ready `UsCorporateAction`
 * rows.
 *
 * ## The ticker is UPPERCASED, and that is the most important line in this file
 *
 * Measured 2026-08-28: the corporate-actions API returns `aapl`, `reax`, `ge` —
 * LOWERCASE. `supported_tickers.csv` returns `AAPL` — UPPERCASE. Both are
 * Tiingo. Every US row this repo already writes takes its symbol from the
 * MASTER, so `UsInstrument`, `Candle` and `BackfillCheckpoint` all hold
 * uppercase.
 *
 * Storing the wire casing would leave `UsCorporateAction` the only US table in
 * lowercase, and `@@index([symbol, exDate])` — the index every consumer will
 * reach this table through — would return ZERO rows for every caller holding a
 * symbol from anywhere else. No error, no empty-table alert, just a dividends
 * tab that is blank for a security whose dividends are sitting in the
 * collection. That is the exact shape of MONEY-1211 and MONEY-1255: a query
 * whose filter cannot match the rows the same system wrote.
 *
 * `permaTicker` is deliberately NOT cased. It is an opaque durable id and it is
 * the unique key; normalising a key is how you fail to match the row you
 * already stored.
 *
 * ## `distribution` is preserved as ZERO, never coerced to null
 *
 * Three genuine `0.0` rows exist in the live data, AAPL 2022-12-23 among them —
 * fully populated with payment, record and declaration dates, i.e. a real
 * announced event that happens to carry no cash. `numOrNull` returns `0` for
 * `"0.0"` and null only for a BLANK cell, and the two stay different all the
 * way to the column. Readers filter `> 0`, never `!= null`.
 */
export function toUsCorporateActionRows(args: {
  distributions?: readonly TiingoDistributionRow[];
  splits?: readonly TiingoSplitRow[];
  /**
   * Occupancy windows keyed by UPPERCASE ticker. Omit to leave every
   * `listingId` null — see {@link resolveListingId} for why a wrong one is much
   * worse than none.
   */
  listings?: ReadonlyMap<string, CorpActionListingWindow>;
}): UsCorporateActionRow[] {
  const { distributions = [], splits = [], listings } = args;
  const out: UsCorporateActionRow[] = [];

  for (const d of distributions) {
    const symbol = d.ticker.toUpperCase();
    const exDate = isoDayToUtcDate(d.exDate);
    // Unreachable for a parser-produced row (the parse validated the shape),
    // but this function is exported and callable with hand-built input, and a
    // null exDate reaching Prisma is an `Invalid Date` write rather than a
    // rejection.
    if (exDate === null) continue;

    out.push({
      permaTicker: d.permaTicker,
      symbol,
      listingId: resolveListingId(d.exDate, listings?.get(symbol)),
      type: "DIVIDEND",
      exDate,
      distribution: d.distribution,
      distributionFrequency: d.distributionFrequency,
      splitFactor: null,
      splitFrom: null,
      splitTo: null,
      paymentDate: isoDayToUtcDate(d.paymentDate),
      recordDate: isoDayToUtcDate(d.recordDate),
      declarationDate: isoDayToUtcDate(d.declarationDate),
      currency: TIINGO_CORP_ACTION_CURRENCY,
      source: TIINGO_CORP_ACTION_SOURCE,
    });
  }

  for (const s of splits) {
    const symbol = s.ticker.toUpperCase();
    const exDate = isoDayToUtcDate(s.exDate);
    if (exDate === null) continue;

    out.push({
      permaTicker: s.permaTicker,
      symbol,
      listingId: resolveListingId(s.exDate, listings?.get(symbol)),
      type: "SPLIT",
      exDate,
      distribution: null,
      distributionFrequency: null,
      splitFactor: s.splitFactor,
      splitFrom: s.splitFrom,
      splitTo: s.splitTo,
      // The splits route carries no announcement dates at all — it has six
      // columns and none of them is a payment, record or declaration date.
      // Explicit nulls rather than omitted fields so the row shape is identical
      // for both types and a writer cannot accidentally partial-update.
      paymentDate: null,
      recordDate: null,
      declarationDate: null,
      currency: TIINGO_CORP_ACTION_CURRENCY,
      source: TIINGO_CORP_ACTION_SOURCE,
    });
  }

  return out;
}

/** The key `@@unique([permaTicker, type, exDate])` enforces, as a string. */
export function corpActionKey(row: UsCorporateActionRow): string {
  return `${row.permaTicker}::${row.type}::${row.exDate.toISOString()}`;
}

export interface CorpActionDedupeResult {
  rows: UsCorporateActionRow[];
  /**
   * Rows discarded as duplicates of an earlier row on the FULL key.
   *
   * Expected to be 0. It is returned rather than swallowed because a non-zero
   * value is a signal worth investigating — either the caller merged two
   * overlapping fetches, or Tiingo started emitting a genuine repeat — and a
   * dedupe that quietly collapses rows is indistinguishable from a feed that
   * stopped sending them.
   */
  dropped: number;
}

/**
 * Collapse rows that would collide on `@@unique([permaTicker, type, exDate])`.
 *
 * ## Dedupe on the FULL key. Never on the ticker.
 *
 * Measured 2026-08-28: `splits?exDate=2026-08-25` returned TWO rows, both
 * `ticker: "reax"`, both a 10-to-1 reverse split, with DIFFERENT permaTickers —
 * `US000000086004` and `US000000143755`. Two real companies that happen to
 * share a ticker string on one day. A dedupe keyed on ticker (or on
 * `ticker+exDate`) drops one of them, and the one it drops is a real corporate
 * action for a real security, gone with no error and no counter.
 *
 * `type` is in the key for the mirror-image reason: a security can pay a
 * dividend and split on the SAME ex-date, and a key of `(permaTicker, exDate)`
 * would destroy one of the two.
 *
 * FIRST occurrence wins. Within one response the colliding rows are identical
 * by construction, so the choice cannot matter today; it is stated rather than
 * left to `Map.set` ordering so that a future caller merging two fetches knows
 * which side it is trusting, and `dropped` tells it the merge happened at all.
 */
export function dedupeCorpActions(
  rows: readonly UsCorporateActionRow[],
): CorpActionDedupeResult {
  const seen = new Map<string, UsCorporateActionRow>();
  let dropped = 0;
  for (const row of rows) {
    const key = corpActionKey(row);
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.set(key, row);
  }
  return { rows: [...seen.values()], dropped };
}

/**
 * The ex-dates a day-walk should request, ascending.
 *
 * ## Why a DAY walk and not a symbol walk
 *
 * The market-wide form takes exactly one `exDate` and REJECTS `startExDate` /
 * `endExDate` (measured: those parameters are accepted only on the per-ticker
 * form, and omitting `exDate` altogether is a 400 `{"detail":"Error: Must
 * provide an exDate."}`). So the population is DAYS, and that is the better
 * axis anyway: ~504 requests per year of history regardless of how many
 * securities exist, and it reaches DELISTED names that no master still lists —
 * a symbol walk can only ask about tickers it already knows.
 *
 * ## Weekends are skipped; US market holidays are NOT
 *
 * A weekend is free to exclude and there are 104 of them a year — a third of
 * every request the walk would otherwise spend. Verified: Sunday 2026-08-23
 * answers `None` on both routes.
 *
 * US exchange holidays are deliberately left in. This repo carries an INDIAN
 * holiday calendar (`nse-holidays.ts`) and no US one, and inventing a second
 * calendar to save ~9 days a year — 18 of ~504 requests, 3.6% — would be a new
 * source of truth that must be maintained forever to avoid skipping a day the
 * market actually traded. A holiday costs one paced request per route, comes
 * back `None`, and is checkpointed EMPTY so it is never asked again.
 *
 * ## Ordering is ASCENDING, and that is not cosmetic
 *
 * A batch walked in `desc` order over a population that GROWS at the recent end
 * pushes the oldest rows further down every cycle and never reaches them
 * (MONEY-1255). Ascending over a FIXED historical range terminates by
 * construction, and the checkpoint is then the only thing deciding what remains.
 */
export function enumerateExDates(from: string, to: string): string[] {
  const start = isoDayToUtcDate(parseTiingoDate(from));
  const end = isoDayToUtcDate(parseTiingoDate(to));
  if (start === null || end === null || start > end) return [];

  const out: string[] = [];
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // Sunday / Saturday
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
