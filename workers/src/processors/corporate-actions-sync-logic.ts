/**
 * Corporate-actions ISIN attachment — MONEY-1301.
 *
 * ## The gap, measured on prod 2026-08-30
 *
 * `corporate_actions` is one of the healthiest tables in this repo: 56,446 rows
 * over 8,577 symbols, growing 17-119/day, and `corporate-actions-sync` ran 7/7
 * days with 8,832 selected = 8,832 written. What it does NOT carry is identity.
 * `isin` is populated on **2,507 of 56,446 rows (4.4%)** despite an
 * `@@index([isin])` at `schema.prisma:3444`, so every ISIN-keyed join off this
 * table — dual-listing dedupe, the XBRL `dividendPerShare` feed for
 * `dividendYield`, MF-holding cross-references — reads an index over an empty
 * column and returns nothing. It fails as "no corporate actions", not as an
 * error.
 *
 * ## Why a pure module rather than three lines inline
 *
 * Two writers fill this column — the nightly `corporate-actions-sync` and the
 * `backfill-corp-action-isins.ts` repair — and they must not be able to
 * disagree about what "the same instrument" means. That is the same reason
 * `reresolve-xbrl-instruments.ts` imports `rankIsinCandidates` from
 * `xbrl-sync-logic.ts` instead of re-deriving the ladder (MONEY-1299): a second,
 * subtly different join is a silent divergence between the repair and the
 * nightly writing one column of one table.
 *
 * ## The rule: the key is (symbol, exchange), never symbol alone
 *
 * A symbol is NOT unique across exchanges. Ten active-equity symbols are two
 * DIFFERENT companies with distinct ISINs — KIRLPNU, SEL, CORDELIA, RAJPUTANA,
 * TDPOWERSYS, FOCUS, KALYANI, GSTL, MAL, ZEAL — and `instrument_mappings`
 * models that correctly with `@@unique([symbol, exchange])`. A symbol-keyed
 * lookup collapses those two rows into one and hands whichever the driver
 * returned last to both companies' actions.
 *
 * A wrong ISIN on a dividend row is strictly worse than a missing one: the
 * missing one reads as "not ingested yet" and the wrong one silently attributes
 * a payout to another company, through an index that makes the join look
 * healthy. So {@link corpActionIsinKey} returns `null` — never a guess, never a
 * symbol-only fallback — whenever the action's own exchange is absent or is not
 * one this join can place, and the row keeps its null.
 *
 * That is also why the reverse fallback is deliberately absent. "The symbol has
 * exactly one mapping row, so use it" is tempting and wrong for exactly the ten
 * symbols above; and "the symbol exists on the other exchange" is the shape that
 * MONEY-1299 measured attaching 163 XBRL filings to a different company's row.
 */

/** The mapping columns the join needs. Matches `instrument_mappings`. */
export interface InstrumentIsinRow {
  symbol: string;
  exchange: string;
  isin: string | null;
}

/** The corporate-action fields the join reads, and the one it writes. */
export interface IsinAttachable {
  symbol: string;
  exchange: string;
  isin?: string | null;
}

/**
 * Exchanges a corporate action can be placed on.
 *
 * Both live feeds tag their rows here — `nseActionToInput` writes "NSE",
 * `bseActionToInput` writes "BSE", `screenerActionToInput` writes "NSE" — so
 * this is not speculative narrowing, it is the observed domain. An action
 * arriving on any other venue (a derivatives segment, a future feed) has no
 * cash-equity mapping to join to and must stay null rather than borrow one.
 */
const JOINABLE_EXCHANGES = new Set(["NSE", "BSE"]);

/**
 * Values that LOOK like an exchange and carry no information. A blank string
 * would otherwise build the key `"RELIANCE|"`, which matches nothing today but
 * would match the moment a single mapping row was written with a blank
 * exchange — a silent, whole-column mis-join out of one bad upstream row.
 */
const PLACEHOLDER_EXCHANGES = new Set([
  "",
  "-",
  "NA",
  "N/A",
  "NULL",
  "UNKNOWN",
]);

/**
 * The join key, or `null` when this row cannot be joined.
 *
 * BOTH sides of the join must be built with this function. Deriving one side by
 * hand is how the XBRL bulk writer classed every mixed-case legacy row as new
 * and dropped whole chunks to its slow path — the same failure shape, one table
 * over.
 */
export function corpActionIsinKey(
  symbol: string | null | undefined,
  exchange: string | null | undefined,
): string | null {
  const sym = (symbol ?? "").trim().toUpperCase();
  if (!sym) return null;
  const ex = (exchange ?? "").trim().toUpperCase();
  if (PLACEHOLDER_EXCHANGES.has(ex)) return null;
  if (!JOINABLE_EXCHANGES.has(ex)) return null;
  return `${sym}|${ex}`;
}

/**
 * Index a batch of mapping rows by {@link corpActionIsinKey}.
 *
 * Rows with no ISIN are DROPPED rather than indexed as null, so a hit in this
 * map always means "there is an ISIN to attach". A caller that needs to tell
 * "no mapping row" apart from "mapping row with no ISIN" — the backfill's
 * residual bucketing does — keeps its own second index; conflating the two here
 * would make the nightly's `isinUnresolved` count unreadable.
 *
 * `instrument_mappings` is `@@unique([symbol, exchange])`, so a key collision
 * inside one batch cannot happen against a live database. It CAN happen against
 * a fixture, and last-wins there would quietly bless whichever order the test
 * happened to build. First-wins is not better; both are guesses. So a collision
 * with a DIFFERENT ISIN removes the key entirely and the rows behind it stay
 * null, which is the same refusal {@link corpActionIsinKey} makes for a missing
 * exchange.
 */
export function buildIsinIndex(
  rows: ReadonlyArray<InstrumentIsinRow>,
): Map<string, string> {
  const index = new Map<string, string>();
  const poisoned = new Set<string>();
  for (const row of rows) {
    const isin = (row.isin ?? "").trim();
    if (!isin) continue;
    const key = corpActionIsinKey(row.symbol, row.exchange);
    if (!key) continue;
    if (poisoned.has(key)) continue;
    const seen = index.get(key);
    if (seen === undefined) {
      index.set(key, isin);
    } else if (seen !== isin) {
      index.delete(key);
      poisoned.add(key);
    }
  }
  return index;
}

/** What one attachment pass did, for the job's outcome line. */
export interface IsinAttachTally {
  /** Rows that ended the pass carrying an ISIN (attached here or preset). */
  resolved: number;
  /** Rows that ended the pass with no ISIN. */
  unresolved: number;
  /**
   * Subset of `unresolved` whose exchange could not be placed at all, so no
   * lookup was even attempted. Reported separately because it is a DIFFERENT
   * defect from "we looked and the mapping is missing": a non-zero value here
   * means a feed started tagging rows with a venue this join does not know,
   * which no amount of instrument-master coverage will fix.
   */
  unkeyable: number;
}

/**
 * Attach ISINs to a batch, in memory, from a pre-built index.
 *
 * Takes the index rather than a database handle ON PURPOSE: the caller is
 * responsible for having issued exactly ONE query for the whole batch. A
 * function that could look a row up would eventually be called inside the write
 * loop, which is the per-row-query shape this codebase has paid for repeatedly.
 *
 * Never overwrites a value the row already carries — a source that supplied its
 * own ISIN knows more about that row than a (symbol, exchange) join does.
 */
export function attachIsins<T extends IsinAttachable>(
  rows: readonly T[],
  index: ReadonlyMap<string, string>,
): IsinAttachTally {
  let resolved = 0;
  let unresolved = 0;
  let unkeyable = 0;
  for (const row of rows) {
    if (row.isin) {
      resolved++;
      continue;
    }
    const key = corpActionIsinKey(row.symbol, row.exchange);
    if (!key) {
      unkeyable++;
      unresolved++;
      continue;
    }
    const isin = index.get(key);
    if (isin) {
      row.isin = isin;
      resolved++;
    } else {
      unresolved++;
    }
  }
  return { resolved, unresolved, unkeyable };
}

/**
 * The distinct (symbol, exchange) pairs a batch needs looked up, plus the two
 * `in` lists that fetch them in ONE query.
 *
 * Mongo has no composite `$in`, so the query is the CROSS PRODUCT of the two
 * lists and returns rows the batch did not ask for. That is fine and it is
 * cheap — `instrument_mappings` holds ~26,669 rows in total, both exchanges,
 * and the pairs are re-narrowed exactly by {@link attachIsins} keying on both
 * halves. What matters is that it is ONE round trip whatever the batch size.
 */
export function isinLookupArgs(rows: readonly IsinAttachable[]): {
  symbols: string[];
  exchanges: string[];
  pairs: number;
} {
  const symbols = new Set<string>();
  const exchanges = new Set<string>();
  const pairs = new Set<string>();
  for (const row of rows) {
    const key = corpActionIsinKey(row.symbol, row.exchange);
    if (!key) continue;
    const [sym, ex] = key.split("|") as [string, string];
    symbols.add(sym);
    exchanges.add(ex);
    pairs.add(key);
  }
  return {
    symbols: [...symbols],
    exchanges: [...exchanges],
    pairs: pairs.size,
  };
}
