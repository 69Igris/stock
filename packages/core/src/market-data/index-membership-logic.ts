/**
 * Point-in-time index membership from dated constituent snapshots — MONEY-1189.
 *
 * ## Why the current table cannot answer the question
 *
 * `IndexConstituent` is `@@unique([indexId, symbol])` and the sync does
 * `deleteMany` + rewrite, so it holds TODAY's membership and nothing else.
 * P4.3's headline benefit — survivorship-bias-free backtests — needs "who was
 * in NIFTY 50 on 2019-03-14", which that shape can never answer. The dated
 * snapshots have been accruing in `feeds/NSE/index-constituents/` all along;
 * only the latest is ever read.
 *
 * ## The distinction this model exists to preserve
 *
 * The obvious design — `{addedOn, removedOn}` derived from the first snapshot a
 * symbol appears in — is WRONG in a way that quietly corrupts every backtest
 * that starts before our observation window.
 *
 * RELIANCE has been in NIFTY 50 since the index existed. Our earliest snapshot
 * is 2026-08-07. Writing `addedOn: 2026-08-07` asserts it JOINED that day, and
 * a backtest reading that would rebalance the entire index on our first
 * observation date — a fabricated event affecting every constituent at once,
 * which is exactly the kind of artefact that looks like a real regime change.
 *
 * So membership carries FOUR dates with different epistemic status:
 *
 *   firstSeen  first snapshot containing it        — always known
 *   lastSeen   most recent snapshot containing it  — always known
 *   addedOn    set ONLY when the symbol was ABSENT in a prior snapshot and
 *              then appeared. A real, observed join.
 *   removedOn  set ONLY when it was PRESENT and then absent. A real, observed
 *              exit.
 *
 * `addedOn == null` therefore means "already a member when we started looking",
 * which is honest, and is a different claim from "joined on firstSeen".
 * Consumers that need a hard interval can fall back to firstSeen knowingly;
 * they cannot un-fabricate a date the model invented for them.
 */

/** One dated snapshot of an index's membership. */
export interface MembershipSnapshot {
  /** UTC ms of the snapshot's trading day. */
  dateMs: number;
  symbols: ReadonlySet<string>;
}

export interface MembershipInterval {
  indexId: string;
  symbol: string;
  firstSeen: number;
  lastSeen: number;
  /** Observed join. Null = already present in the earliest snapshot we hold. */
  addedOn: number | null;
  /** Observed exit. Null = still a member as of `lastSeen`. */
  removedOn: number | null;
}

/**
 * Fold dated snapshots into membership intervals.
 *
 * Snapshots may arrive unsorted; they are ordered here because the whole
 * inference is "what changed between consecutive observations".
 *
 * A symbol that leaves and later returns produces TWO intervals — the second
 * carries a real `addedOn`, and collapsing them would erase a genuine index
 * change. That is why the accumulator tracks an open interval per symbol
 * rather than a single first/last pair.
 */
export function buildMembershipIntervals(
  indexId: string,
  snapshots: readonly MembershipSnapshot[],
): MembershipInterval[] {
  const ordered = [...snapshots].sort((a, b) => a.dateMs - b.dateMs);
  if (ordered.length === 0) return [];

  const closed: MembershipInterval[] = [];
  const open = new Map<string, MembershipInterval>();
  const everSeen = new Set<string>();

  for (const [i, snap] of ordered.entries()) {
    // Appearances.
    for (const symbol of snap.symbols) {
      const current = open.get(symbol);
      if (current) {
        current.lastSeen = snap.dateMs;
        continue;
      }
      open.set(symbol, {
        indexId,
        symbol,
        firstSeen: snap.dateMs,
        lastSeen: snap.dateMs,
        // Only the FIRST snapshot leaves addedOn null — a symbol appearing in
        // any later snapshot was genuinely observed to join, whether it is new
        // or returning.
        addedOn: i === 0 ? null : snap.dateMs,
        removedOn: null,
      });
      everSeen.add(symbol);
    }

    // Disappearances — a symbol open before this snapshot but absent from it.
    for (const [symbol, interval] of [...open]) {
      if (snap.symbols.has(symbol)) continue;
      interval.removedOn = snap.dateMs;
      closed.push(interval);
      open.delete(symbol);
    }
  }

  return [...closed, ...open.values()].sort(
    (a, b) => a.symbol.localeCompare(b.symbol) || a.firstSeen - b.firstSeen,
  );
}

/**
 * Membership as of a date.
 *
 * `removedOn` is EXCLUSIVE — a symbol removed on day D was not a member on D,
 * mirroring how the snapshot for D is what revealed the removal.
 *
 * Dates before `firstSeen` return nothing rather than guessing: we genuinely do
 * not know who was in the index before our earliest snapshot, and answering
 * anyway is how survivorship bias gets reintroduced by the very table meant to
 * remove it.
 */
export function membershipAsOf(
  intervals: readonly MembershipInterval[],
  dateMs: number,
): string[] {
  const out = new Set<string>();
  for (const iv of intervals) {
    if (dateMs < iv.firstSeen) continue;
    if (iv.removedOn !== null && dateMs >= iv.removedOn) continue;
    out.add(iv.symbol);
  }
  return [...out].sort();
}

/**
 * The membership changes between two consecutive snapshots.
 *
 * Used by the forward hook so the weekly sync appends events instead of only
 * overwriting the current view.
 */
export function diffSnapshots(
  previous: ReadonlySet<string> | null,
  current: ReadonlySet<string>,
): { added: string[]; removed: string[] } {
  if (!previous) return { added: [], removed: [] };
  const added: string[] = [];
  const removed: string[] = [];
  for (const s of current) if (!previous.has(s)) added.push(s);
  for (const s of previous) if (!current.has(s)) removed.push(s);
  return { added: added.sort(), removed: removed.sort() };
}

/** An interval already recorded as open (`removedOn == null`). */
export interface OpenInterval {
  symbol: string;
  lastSeen: number;
}

export interface MembershipUpdate {
  /** Symbols whose open interval should have `lastSeen` moved to `observedAt`. */
  touch: string[];
  /** Symbols whose open interval should be closed with `removedOn = observedAt`. */
  close: string[];
  /** New intervals to create. `addedOn` is null only on the first-ever observation. */
  open: Array<{ symbol: string; addedOn: number | null }>;
  /** Set when the observation must be ignored entirely. */
  skip?: "stale" | "duplicate";
}

/**
 * What the weekly sync should write after resolving an index's members.
 *
 * Three things this refuses to do, each of which corrupts the table silently:
 *
 * 1. **Stamp `addedOn` on the first observation.** With no open intervals the
 *    index is being recorded for the first time, so every member is an
 *    incumbent of unknown standing — the same rule as the backfill.
 *
 * 2. **Replay an older or equal observation.** The sync runs weekly but the
 *    archive only gains a file when NSE publishes one, so the SAME file is
 *    re-resolved on most runs. Re-processing it is harmless, but processing a
 *    date at or behind `lastSeen` as if it were new would let a stale file
 *    close intervals that are actually current. `duplicate` is the common,
 *    boring case; `stale` means the archive went backwards and is worth a log.
 *
 * 3. **Infer anything from a strategy other than the archive.** That guard
 *    lives at the call site because it is about provenance, not dates — an
 *    `mcap-rank` index reshuffles on market moves, and writing those diffs
 *    would fabricate a rebalance every week.
 */
export function planMembershipUpdate(
  openIntervals: readonly OpenInterval[],
  currentSymbols: ReadonlySet<string>,
  observedAtMs: number,
): MembershipUpdate {
  const empty: MembershipUpdate = { touch: [], close: [], open: [] };

  if (openIntervals.length === 0) {
    // First observation for this index — everyone is an incumbent.
    return {
      touch: [],
      close: [],
      open: [...currentSymbols]
        .sort()
        .map((symbol) => ({ symbol, addedOn: null })),
    };
  }

  const newest = Math.max(...openIntervals.map((i) => i.lastSeen));
  if (observedAtMs < newest) return { ...empty, skip: "stale" };
  if (observedAtMs === newest) return { ...empty, skip: "duplicate" };

  const previous = new Set(openIntervals.map((i) => i.symbol));
  const { added, removed } = diffSnapshots(previous, currentSymbols);
  const touch = [...currentSymbols].filter((s) => previous.has(s)).sort();

  return {
    touch,
    close: removed,
    open: added.map((symbol) => ({ symbol, addedOn: observedAtMs })),
  };
}
