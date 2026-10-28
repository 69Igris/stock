/**
 * Detect a rename at the moment `instrument-sync` would deactivate the old row
 * — MONEY-1177.
 *
 * ## Why this has to happen HERE
 *
 * `syncInstruments` upserts on `(symbol, exchange)`, so when NSE renames a
 * ticker the dump produces a NEW row and the old one simply stops appearing.
 * `deactivateStaleInstruments` then flips it inactive and the connection is
 * gone forever — nothing records that ETERNAL used to be ZOMATO.
 *
 * That single moment, where a stale row and its successor are both in hand, is
 * the only place a rename is knowable without re-reading the archive. The
 * backfill script (`scripts/data/backfill-symbol-aliases.ts`) recovered the
 * history that was already lost; this keeps the next one from being lost.
 *
 * ## Why the price history must move with the name
 *
 * `DailyPrice` rows point at an `instrumentId`. A renamed instrument's new row
 * is a DIFFERENT id, so its chart starts from zero on rename day while decades
 * of history sit on a deactivated row nothing queries.
 *
 * That is not hypothetical — it is what should have happened to ETERNAL and
 * TMPV. They only have their full series because the MONEY-1175 re-parse
 * re-read every archived bhavcopy and `resolveInstrumentId` reattached the rows
 * by ISIN. Absent that accident, both charts would have been stubs. A re-parse
 * is not a rename-recovery mechanism and must not be relied on as one.
 *
 * ## The rule
 *
 * A stale row is a RENAME when an ACTIVE row on the same exchange carries the
 * same ISIN under a different symbol. Everything else is an ordinary delisting.
 *
 * ISIN is required, never guessed: a stale row with no ISIN could be matched
 * only by name similarity, and a wrong match would silently graft one company's
 * price history onto another. A missed rename costs a chart; a wrong one
 * corrupts data.
 */

/** Minimal shape of a row that fell out of every provider's dump. */
export interface StaleInstrument {
  id: string;
  symbol: string;
  exchange: string;
  isin: string | null;
}

/** Minimal shape of a row still present in the dump. */
export interface ActiveInstrument {
  id: string;
  symbol: string;
  exchange: string;
  isin: string | null;
  previousSymbols?: string[];
}

export interface RenameDetection {
  /** The row about to be deactivated. */
  from: StaleInstrument;
  /** The row that now carries this ISIN. */
  to: ActiveInstrument;
}

export interface RenameSplit {
  renames: RenameDetection[];
  /** Stale rows that are genuinely gone, not renamed. */
  plainStale: StaleInstrument[];
}

const key = (isin: string, exchange: string): string =>
  `${isin.trim().toUpperCase()}@${exchange.trim().toUpperCase()}`;

/**
 * Split stale rows into renames and ordinary delistings.
 *
 * A demerger legitimately produces SEVERAL active rows, but only one of them
 * inherits the ISIN — the others are new securities with new ISINs and cannot
 * be detected here (they need the seed list in the backfill script). When more
 * than one active row somehow shares the ISIN, NOTHING is claimed: an ambiguous
 * match is the case where guessing wrong grafts history onto the wrong company.
 */
export function detectRenames(
  stale: readonly StaleInstrument[],
  active: readonly ActiveInstrument[],
): RenameSplit {
  const byIsin = new Map<string, ActiveInstrument[]>();
  for (const a of active) {
    if (!a.isin) continue;
    const k = key(a.isin, a.exchange);
    const list = byIsin.get(k);
    if (list) list.push(a);
    else byIsin.set(k, [a]);
  }

  const renames: RenameDetection[] = [];
  const plainStale: StaleInstrument[] = [];

  for (const s of stale) {
    if (!s.isin) {
      plainStale.push(s);
      continue;
    }
    const candidates = (byIsin.get(key(s.isin, s.exchange)) ?? []).filter(
      (a) => a.symbol.trim().toUpperCase() !== s.symbol.trim().toUpperCase(),
    );
    // Exactly one successor, or nothing. Ambiguity is treated as "not a rename".
    if (candidates.length === 1) {
      renames.push({ from: s, to: candidates[0]! });
    } else {
      plainStale.push(s);
    }
  }

  return { renames, plainStale };
}

/**
 * The alias list a successor should end up with, or null when nothing changes.
 *
 * Carries the predecessor's own aliases forward too, so a chain A -> B -> C
 * leaves C searchable by both A and B rather than only B.
 */
export function nextPreviousSymbols(
  successor: ActiveInstrument,
  predecessorSymbol: string,
  predecessorAliases: readonly string[] = [],
): string[] | null {
  const current = successor.symbol.trim().toUpperCase();
  const merged = new Set(successor.previousSymbols ?? []);
  for (const s of [predecessorSymbol, ...predecessorAliases]) {
    const v = s.trim().toUpperCase();
    if (v && v !== current) merged.add(v);
  }
  const next = [...merged].sort();
  const before = [...(successor.previousSymbols ?? [])].sort();
  const unchanged =
    next.length === before.length && next.every((v, i) => v === before[i]);
  return unchanged ? null : next;
}
