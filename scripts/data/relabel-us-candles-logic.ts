/**
 * The PURE half of `relabel-us-candles.ts` — MONEY-1617.
 *
 * Every stored US D1 bar is re-resolved against the master exactly the way the
 * lake gate does it (`resolveListingForDate` over every Stock/ETF window of the
 * symbol, at the session's 04:00 ET open). A bar whose stored `listingId` is not
 * the ONE window the master resolves is moved to that window — `listingId` AND
 * `exchange`, so the row's key and its id never disagree about the venue.
 *
 * What it will NOT do, each counted by name:
 *   - touch a session zero windows cover, or several do (UNRESOLVED/AMBIGUOUS);
 *   - move a bar onto a key already holding a DIFFERENT bar (CONFLICT) — that
 *     would merge two companies' prices;
 * and a moving copy whose target key already holds an IDENTICAL bar is removed
 * (DUP_REMOVED), because keeping it would be one session twice.
 *
 * Hot (Mongo) and cold (a GCS shard) are independent stores and are planned
 * independently; the same session may legitimately sit in both.
 */
import {
  candleKey,
  type CandleBar,
} from "@usemoney/core/market-data/candles/candle-logic";
import {
  isPhantomWindow,
  resolveListingForDate,
  windowCoversDate,
  type ListingRow,
} from "@usemoney/core/market-data/databento/databento-symbology";
import { usMarketDayBoundsUtc } from "@usemoney/core/market-data/us-market-hours";

/** The arm flag. Compared to the LITERAL string, read per call. */
export const ARM_ENV = "RELABEL_US_CANDLES_APPLY";
export function isArmed(
  raw: string | undefined = process.env[ARM_ENV],
): boolean {
  return raw === "true";
}

/** Mongo collection the hot rows are copied to before any write. */
export const BACKUP_COLLECTION = "candles_money1617_backup";
/** GCS prefix the original shard bytes are copied to before any rewrite. */
export const SHARD_BACKUP_PREFIX = "backups/money-1617";

/** Why a bar was moved. Reporting only — every class is moved the same way. */
export type RelabelClass =
  | "PHANTOM" //   stored under a phantom window a longer one also covers (GAB)
  | "SPLIT" //     stored window now ENDS before the session; the target starts after it (RAM)
  | "NON_COVERING"; // stored window never covered the session (CADE, WNS)

export type LeftReason = "UNRESOLVED" | "AMBIGUOUS" | "CONFLICT";

/** A bar as either store holds it, plus the hot row's id when it has one. */
export interface StoredBar extends CandleBar {
  id?: string;
}

export interface Move {
  from: StoredBar;
  listingId: string;
  exchange: string;
  cls: RelabelClass;
  venueChange: boolean;
}

export interface StorePlan {
  moves: Move[];
  /** Moving copies whose target key already holds an identical bar. */
  removes: Move[];
  left: Record<LeftReason, number>;
  /** Bars that already carry the id the master resolves. */
  ok: number;
}

const SESSION_OPEN = (ts: Date): Date =>
  new Date(usMarketDayBoundsUtc(ts.toISOString().slice(0, 10)).startMs);

/** Same prices, same volume, same adjustment inputs. Source may differ. */
export function sameBar(a: CandleBar, b: CandleBar): boolean {
  return (
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    Number(a.volume) === Number(b.volume) &&
    a.divCash === b.divCash &&
    a.splitFactor === b.splitFactor
  );
}

function classify(
  windows: readonly ListingRow[],
  storedId: string,
  target: ListingRow,
  at: Date,
): RelabelClass {
  const stored = windows.find((w) => w.listingId === storedId);
  if (stored === undefined) return "NON_COVERING";
  if (windowCoversDate(stored, at) && isPhantomWindow(stored, windows)) {
    return "PHANTOM";
  }
  if (
    stored.exchange === target.exchange &&
    stored.listingEndDate !== null &&
    stored.listingEndDate.getTime() < at.getTime() &&
    target.listingStartDate !== null &&
    stored.listingEndDate.getTime() < target.listingStartDate.getTime()
  ) {
    return "SPLIT";
  }
  return "NON_COVERING";
}

/**
 * Plan ONE store's bars for ONE symbol (all of Mongo's, or one shard's).
 *
 * `windows` is every Stock/ETF master row of the symbol, on every venue — the
 * population the lake resolves against, so a moved bar is one the lake accepts.
 */
export function planStore(
  bars: readonly StoredBar[],
  windows: readonly ListingRow[],
): StorePlan {
  const plan: StorePlan = {
    moves: [],
    removes: [],
    left: { UNRESOLVED: 0, AMBIGUOUS: 0, CONFLICT: 0 },
    ok: 0,
  };
  const byId = new Map(windows.map((w) => [w.listingId, w]));
  const wanted: Array<{ bar: StoredBar; target: ListingRow; at: Date }> = [];
  /** key -> the bar that will occupy it once the plan lands. */
  const occupied = new Map<string, StoredBar>();

  for (const bar of bars) {
    const at = SESSION_OPEN(bar.ts);
    const r = resolveListingForDate(windows, at);
    if (!r.ok) {
      plan.left[r.reason === "ambiguous" ? "AMBIGUOUS" : "UNRESOLVED"]++;
      occupied.set(candleKey(bar), bar);
      continue;
    }
    if (r.multiVenue || r.listing.listingId === bar.listingId) {
      plan.ok++;
      occupied.set(candleKey(bar), bar);
      continue;
    }
    wanted.push({ bar, target: byId.get(r.listing.listingId)!, at });
  }

  // Moves whose key does not change first: they never collide.
  wanted.sort(
    (a, b) =>
      Number(a.bar.exchange !== a.target.exchange) -
      Number(b.bar.exchange !== b.target.exchange),
  );
  for (const { bar, target, at } of wanted) {
    const move: Move = {
      from: bar,
      listingId: target.listingId,
      exchange: target.exchange,
      cls: classify(windows, bar.listingId, target, at),
      venueChange: bar.exchange !== target.exchange,
    };
    const key = candleKey({ ...bar, exchange: target.exchange });
    const there = occupied.get(key);
    if (there === undefined) {
      occupied.set(key, bar);
      plan.moves.push(move);
    } else if (sameBar(there, bar)) {
      plan.removes.push(move);
    } else {
      plan.left.CONFLICT++;
      occupied.set(candleKey(bar), bar);
    }
  }
  return plan;
}

/** The store after the plan: what a second run would read. */
export function applyStorePlan(
  bars: readonly StoredBar[],
  plan: StorePlan,
): StoredBar[] {
  const moved = new Map(plan.moves.map((m) => [m.from, m]));
  const removed = new Set(plan.removes.map((m) => m.from));
  const out: StoredBar[] = [];
  for (const b of bars) {
    if (removed.has(b)) continue;
    const m = moved.get(b);
    out.push(m ? { ...b, listingId: m.listingId, exchange: m.exchange } : b);
  }
  return out;
}

/** Changes a plan makes. Zero means a second run plans nothing. */
export const planSize = (p: StorePlan): number =>
  p.moves.length + p.removes.length;
