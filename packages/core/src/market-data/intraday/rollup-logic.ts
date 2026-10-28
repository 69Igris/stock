/**
 * Intraday bars — the ring buffer's rules. MONEY-1470 (data-platform A5).
 *
 * 1-minute bars live in a Redis list per (listing, interval); 5m/15m/60m are
 * DERIVED ON READ by the roll-up below rather than stored. One stored series
 * cannot disagree with itself, which is the whole reason not to store four.
 *
 * ## THE BASIS IS PART OF THE BAR, NOT A FOOTNOTE
 *
 * Two feeds produce 1-minute bars and they are not the same measurement:
 *
 *   quote_mid   Tiingo RT. Built from the MID of top-of-book, because that feed
 *               carries no trades at all (MONEY-1309, measured across 236
 *               captured frames). `volume` is 0 MEANING "this feed does not
 *               report volume", never "nothing traded".
 *   trade       Databento EQUS.MINI. Trade-derived, with REAL volume.
 *
 * A chart that silently mixes them puts a structural zero beside a real volume
 * and changes what OHLC means partway through a series, with nothing on the
 * rows to reveal it. So every bar carries its basis, a roll-up REFUSES to
 * combine two bases, and the reader states the basis in a response header.
 */

export type BarBasis = "quote_mid" | "trade";

/** The intervals the reader serves. 1m is stored; the rest are derived. */
export const SUPPORTED_INTERVALS = ["1m", "5m", "15m", "60m"] as const;
export type IntradayInterval = (typeof SUPPORTED_INTERVALS)[number];

export const INTERVAL_MINUTES: Readonly<Record<IntradayInterval, number>> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "60m": 60,
};

/**
 * Sessions of 1-minute bars kept per listing.
 *
 * 45 per the brief. Trimmed BY COUNT rather than by age: a count is what Redis
 * can enforce atomically on write (`LTRIM`), while an age trim needs a reader
 * to decide what "45 sessions ago" means on a calendar with holidays — and a
 * reader that gets that wrong silently shortens every chart.
 */
export const BUFFER_SESSIONS = 45;

/** US 04:00–20:00 ET is 960 minutes; India 09:15–15:30 IST is 375. */
export const MINUTES_PER_SESSION: Readonly<Record<string, number>> = {
  US: 960,
  IN: 375,
};

/**
 * How many BARS 45 sessions is — which is not how many MINUTES it is.
 *
 * This returned minutes, and was correct only for a 1-minute base. India's base
 * is 5m, so `375 * 45` was 16,875 FIVE-minute bars = **225 sessions**, five
 * times the documented window: five times the Redis per listing, an
 * `X-Buffer-Oldest` floor wrong by 5x, and a single request allowed to read
 * 16,875 entries.
 */
export function bufferCapacity(market: "IN" | "US"): number {
  const minutes = MINUTES_PER_SESSION[market] ?? 960;
  return Math.ceil(
    (minutes / INTERVAL_MINUTES[BASE_INTERVAL[market]]) * BUFFER_SESSIONS,
  );
}

/**
 * How long a listing's buffer may sit unwritten before Redis reclaims it.
 *
 * A rank trim bounds a key's LENGTH; nothing bounds the KEYSPACE. The realtime
 * subscription set churns by design — ephemerals are evicted soonest-first — so
 * without this, every symbol that ever entered it leaves a full-size immortal
 * key and the footprint is bounded by every symbol EVER subscribed rather than
 * by the 3,000-symbol cap.
 *
 * This is the SHARED Redis that also holds the L2 cache, `rt:us:quote:*`, the
 * Pub/Sub dedupe leases and the realtime socket's FAIL-CLOSED leader lock.
 * Under `noeviction` the first OOM stops every writer; under an LRU policy the
 * eviction may take the leader lock, and the socket with it.
 *
 * 50 sessions of calendar time — past the 45-session window, so a long holiday
 * cannot expire a live listing. Refreshed on every write.
 */
export const BUFFER_TTL_SECONDS = 50 * 24 * 3600;

/**
 * The NARROWEST interval each market actually has a source for.
 *
 * US is 1m: the Tiingo socket closes minute bars and Databento sells
 * `ohlcv-1m`. India is 5m, and that is a SOURCE fact, not a preference —
 * `intraday-sync` fetches Yahoo, whose 1m retention is SEVEN DAYS against 60
 * for 5m/15m, so a 45-session 1m buffer for India cannot be filled. Kite
 * Connect would supply real 1m and is deliberately NOT activated
 * (docs/reference/india-intraday-activation.md).
 *
 * Everything wider is DERIVED from the base. Nothing narrower can be.
 */
export const BASE_INTERVAL: Readonly<Record<"IN" | "US", IntradayInterval>> = {
  US: "1m",
  IN: "5m",
};

/** `ib:{market}:{listing_id}:{interval}` — the market's BASE interval. */
export function intradayKey(
  market: "IN" | "US",
  listingId: string,
  interval: IntradayInterval = BASE_INTERVAL[market],
): string {
  return `ib:${market}:${listingId.toUpperCase()}:${interval}`;
}

/**
 * Refused when a caller asks for bars NARROWER than what is stored.
 *
 * This is not pedantry. `rollUp` used to return its input unchanged whenever
 * the target was 1m — so asking a 5m India buffer for 1m returned FIVE-MINUTE
 * BARS LABELLED AS ONE-MINUTE. Every one of them plots, at a timestamp that is
 * a real minute, with an OHLC that describes four minutes it does not claim.
 * There is no downstream check that could catch it.
 */
export class IntervalNotDerivableError extends Error {
  constructor(target: IntradayInterval, base: IntradayInterval) {
    super(
      `cannot serve ${target} from ${base} bars: ${INTERVAL_MINUTES[target]} is not a ` +
        `whole multiple of ${INTERVAL_MINUTES[base]}. Rolling UP aggregates real bars; ` +
        "rolling DOWN would invent prices that never traded.",
    );
    this.name = "IntervalNotDerivableError";
  }
}

/** Which intervals a given base can honestly serve. */
export function derivableIntervals(base: IntradayInterval): IntradayInterval[] {
  return SUPPORTED_INTERVALS.filter(
    (i) => INTERVAL_MINUTES[i] % INTERVAL_MINUTES[base] === 0,
  );
}

/** `[t, o, h, l, c, v]`, `t` in unix SECONDS — the same tuple the tiles use. */
export type IntradayBar = readonly [
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
];

export interface BasisBar {
  bar: IntradayBar;
  basis: BarBasis;
}

export class MixedBasisError extends Error {
  constructor(found: readonly BarBasis[]) {
    super(
      `refusing to roll up bars of mixed basis (${[...new Set(found)].join(", ")}): ` +
        "quote_mid carries a structural volume of 0 while trade carries real volume, " +
        "so a combined bar's OHLC and volume would mean two different things at once",
    );
    this.name = "MixedBasisError";
  }
}

/**
 * Roll 1-minute bars up to a larger interval.
 *
 * Buckets are aligned to the epoch on the interval's own width, so a 5m bucket
 * always starts at a multiple of 300 s. Aligning to the FIRST BAR instead would
 * make two readers of the same series disagree whenever one of them starts a
 * minute earlier — the classic source of a chart whose candles shift when you
 * pan.
 *
 * GAPS PRODUCE NO BAR. A minute with no trade simply has no input, and an
 * invented flat bar would show a real price that never happened. A bucket with
 * one input bar is legitimate and is emitted.
 */
/**
 * Seconds to subtract before bucketing, so buckets align to the VENUE's session
 * rather than to the UTC epoch.
 *
 * `Math.floor(t / width) * width` aligns to the epoch, which is UTC. India's
 * session opens 09:15 IST = 03:45 UTC, so a 60-minute epoch bucket starts at
 * 03:00 UTC = **08:30 IST** — every hourly candle stamped 08:30, 09:30, 10:30
 * instead of the Indian convention 09:15, 10:15, 11:15, with the session's
 * first "hour" holding only three 5-minute bars while presenting as a full one.
 *
 * 15m survives by coincidence (09:15 IST is a whole number of 15-minute periods
 * from the epoch), which is exactly why this does not show up on the resolution
 * most people test.
 *
 * US needs none: 04:00 and 09:30 ET are both whole hours from the epoch under
 * either offset, and the half-hour only matters below 60m, where 30 is itself a
 * multiple of every interval we serve.
 */
export const BUCKET_PHASE_SECONDS: Readonly<Record<"IN" | "US", number>> = {
  IN: 45 * 60,
  US: 0,
};

export function rollUp(
  bars: readonly IntradayBar[],
  interval: IntradayInterval,
  base: IntradayInterval = "1m",
  phaseSeconds = 0,
): IntradayBar[] {
  const minutes = INTERVAL_MINUTES[interval];
  const baseMinutes = INTERVAL_MINUTES[base];
  // REFUSED, not silently passed through. See IntervalNotDerivableError.
  if (minutes % baseMinutes !== 0)
    throw new IntervalNotDerivableError(interval, base);
  if (minutes === baseMinutes) return [...bars];
  const width = minutes * 60;

  const out: IntradayBar[] = [];
  let bucketStart = -1;
  let o = 0;
  let h = -Infinity;
  let l = Infinity;
  let c = 0;
  let v = 0;

  const flush = (): void => {
    if (bucketStart < 0) return;
    out.push([bucketStart, o, h, l, c, v]);
  };

  // Ascending is assumed by every caller and cheap to guarantee here — an
  // unsorted input would otherwise produce buckets in arbitrary order and a
  // chart that draws backwards.
  const sorted = [...bars].sort((a, b) => a[0] - b[0]);

  for (const bar of sorted) {
    // Phase-shifted so buckets align to the VENUE's open, not the UTC epoch.
    const start =
      Math.floor((bar[0] - phaseSeconds) / width) * width + phaseSeconds;
    if (start !== bucketStart) {
      flush();
      bucketStart = start;
      o = bar[1];
      h = bar[2];
      l = bar[3];
      c = bar[4];
      v = bar[5];
      continue;
    }
    // OPEN stays the first bar's open and CLOSE follows the last — that is what
    // makes 5 x 1m identical to 1 x 5m.
    h = Math.max(h, bar[2]);
    l = Math.min(l, bar[3]);
    c = bar[4];
    v += bar[5];
  }
  flush();
  return out;
}

/**
 * Roll up a basis-tagged series, refusing a mixed one.
 *
 * The refusal is the point. A buffer can legitimately hold both bases over
 * time — Databento backfills `trade` for a baseline symbol that Tiingo also
 * streams as `quote_mid` — and combining them produces a bar whose volume is
 * partly structural zero and partly real, which no downstream can detect.
 */
export function rollUpWithBasis(
  bars: readonly BasisBar[],
  interval: IntradayInterval,
  base: IntradayInterval = "1m",
  phaseSeconds = 0,
): { bars: IntradayBar[]; basis: BarBasis } {
  // The interval check runs BEFORE the empty guard: asking a 5m buffer for 1m
  // is a programming error whether or not the buffer happens to be empty today,
  // and an empty answer would let it ship and fail on the first populated
  // symbol instead.
  if (INTERVAL_MINUTES[interval] % INTERVAL_MINUTES[base] !== 0) {
    throw new IntervalNotDerivableError(interval, base);
  }
  if (bars.length === 0) return { bars: [], basis: "trade" };
  const bases = bars.map((b) => b.basis);
  const first = bases[0]!;
  if (bases.some((b) => b !== first)) throw new MixedBasisError(bases);
  return {
    bars: rollUp(
      bars.map((b) => b.bar),
      interval,
      base,
      phaseSeconds,
    ),
    basis: first,
  };
}

/**
 * Pick ONE basis for a series that holds both, preferring the better
 * measurement.
 *
 * `trade` wins: it is trade-derived with real volume, against a mid-price whose
 * volume is a structural zero. Same direction as the price-source authority
 * table, for the same reason — DATABENTO 55 outranks TIINGO_RT 20.
 */
export function preferredBasis(bars: readonly BasisBar[]): BarBasis | null {
  if (bars.length === 0) return null;
  return bars.some((b) => b.basis === "trade") ? "trade" : "quote_mid";
}

/**
 * Choose ONE basis PER SESSION, and keep every session.
 *
 * ## WHY PER SESSION AND NOT PER RESPONSE
 *
 * `selectBasis(bars, preferredBasis(bars))` picked one basis for the whole read
 * window, and that is wrong in a way that empties a live chart. Two writers
 * share `ib:US:{listing}:1m`:
 *
 *   candle-sink        appends session D live, `quote_mid`, minute by minute
 *   databento-append   runs 15:00 and 18:00 IST and writes session **D-1** as
 *                      `trade` — its vendor embargo is T+1, so it can NEVER
 *                      have today
 *
 * `trade` outranks `quote_mid`, so the first night the append lands, a
 * whole-window choice returns "trade" for ever: 100% of TODAY's bars are dropped,
 * `sliceBarsForRequest` returns [] for a today window, and the route answers
 * `no_data`. The live US intraday chart flat-lines for the entire current
 * session, every day, with `dropped` at 0 so nothing logs — it looks exactly
 * like the socket died.
 *
 * Per session, the trade bars win where they exist and today keeps its live
 * quote_mid ones. No roll-up bucket can mix, because a bucket never spans two
 * sessions.
 *
 * `sessionOf` is SUPPLIED rather than computed here: the US session key is an
 * ET calendar date whose boundaries this module has no business knowing, and
 * India's is an IST one.
 */
export function selectBasisPerSession(
  bars: readonly BasisBar[],
  sessionOf: (tsSeconds: number) => string,
): { bars: BasisBar[]; bases: BarBasis[] } {
  const bySession = new Map<string, BasisBar[]>();
  for (const b of bars) {
    const key = sessionOf(b.bar[0]);
    const list = bySession.get(key) ?? [];
    list.push(b);
    bySession.set(key, list);
  }

  const kept: BasisBar[] = [];
  const bases = new Set<BarBasis>();
  for (const list of bySession.values()) {
    const basis = preferredBasis(list);
    if (basis === null) continue;
    bases.add(basis);
    // Deduplicate on TIMESTAMP within the session. A sorted set dedupes
    // identical members, but a re-fetch whose OHLCV differs by a rounding is a
    // DIFFERENT member at the same score — two bars for one minute, which
    // `rollUp` would sum into a doubled volume.
    const byTs = new Map<number, BasisBar>();
    for (const b of list) {
      if (b.basis !== basis) continue;
      byTs.set(b.bar[0], b);
    }
    kept.push(...byTs.values());
  }
  kept.sort((a, b) => a.bar[0] - b.bar[0]);
  return { bars: kept, bases: [...bases] };
}

/**
 * The basis to REPORT for a window that may hold more than one.
 *
 * The NEWEST session's, because that is what the viewer is looking at, and
 * because the badge exists to warn about a structural zero volume on the bars
 * in front of them rather than about history.
 */
export function reportedBasis(bars: readonly BasisBar[]): BarBasis | null {
  if (bars.length === 0) return null;
  let newest = bars[0]!;
  for (const b of bars) if (b.bar[0] > newest.bar[0]) newest = b;
  return newest.basis;
}

/** Keep only the bars of one basis, so a mixed buffer can still be served. */
export function selectBasis(
  bars: readonly BasisBar[],
  basis: BarBasis,
): BasisBar[] {
  return bars.filter((b) => b.basis === basis);
}

/* ─────────────────────────────────────────────────────────────────────────
   Encoding — one line per bar, because the buffer is a Redis LIST
   ──────────────────────────────────────────────────────────────────────── */

/** `t,o,h,l,c,v,basis` — compact, and the basis rides WITH the bar. */
export function encodeBar(entry: BasisBar): string {
  const [t, o, h, l, c, v] = entry.bar;
  return `${t},${o},${h},${l},${c},${v},${entry.basis}`;
}

/**
 * Parse one buffer entry, returning null for anything unusable.
 *
 * Null rather than a throw: one corrupt entry must not lose a whole session.
 * Every field is `Number.isFinite`-checked because `Number("")` is 0, and a
 * silent zero in an OHLC field is a candle that renders and is wrong.
 */
export function decodeBar(line: string): BasisBar | null {
  const parts = line.split(",");
  if (parts.length < 7) return null;
  const raw = parts.slice(0, 6);
  // EMPTY IS NOT ZERO, and `Number.isFinite` cannot tell them apart:
  // `Number("")` is 0, so `,,,,,,trade` decoded as a perfectly valid bar at
  // t=0 with a price of 0 — and `dropped` stayed 0, so nothing reported it.
  // The comment below named this trap and the code walked into it anyway.
  if (raw.some((v) => v.trim() === "")) return null;
  const nums = raw.map(Number);
  if (!nums.every((n) => Number.isFinite(n))) return null;
  const basis = parts[6];
  if (basis !== "quote_mid" && basis !== "trade") return null;
  const [t, o, h, l, c, v] = nums as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return { bar: [t, o, h, l, c, v], basis };
}

/** Parse a buffer page, dropping unusable lines and reporting how many. */
export function decodeBuffer(lines: readonly string[]): {
  bars: BasisBar[];
  dropped: number;
} {
  const bars: BasisBar[] = [];
  let dropped = 0;
  for (const line of lines) {
    const parsed = decodeBar(line);
    if (parsed) bars.push(parsed);
    else dropped++;
  }
  bars.sort((a, b) => a.bar[0] - b.bar[0]);
  return { bars, dropped };
}

/**
 * One buffer entry as a SORTED-SET member: score = timestamp, value = the line.
 *
 * ## WHY A SORTED SET, AFTER A LIST GOT IT WRONG THREE WAYS
 *
 * This was a Redis LIST, on the reasoning that the buffer is append-mostly and
 * read as a contiguous tail. That is true of ONE writer. It is false here, and
 * every consequence was silent:
 *
 *   1. `LPUSH key v1 v2 v3` inserts each at the HEAD in turn, so the arguments
 *      land REVERSED. Reversing before pushing — which reads as "newest first"
 *      and is backwards — put the OLDEST at the head, so `LTRIM 0 cap-1` kept
 *      the oldest entries and DROPPED every new bar once full. The buffer
 *      freezes at its first 45 sessions, for ever.
 *   2. The US buffer has TWO writers with opposite recency. `candle-sink`
 *      appends session D live; `databento-append` runs 15:00 and 18:00 IST and
 *      writes session **D-1** (its vendor embargo is T+1, so it can never have
 *      today). 960 older bars land at the head, ABOVE session D — and a
 *      `LRANGE 0 n` window is then entirely D-1 while today's bars sit
 *      positionally below, invisible.
 *   3. `intraday-sync` re-fetches a 5-day overlap nightly. Mongo absorbs it
 *      through an upsert; an unconditional LPUSH does not, so every India
 *      timestamp accumulates ~5 copies — `rollUp` sums `v` across them, so
 *      every derived volume inflates ~5x with a plausible OHLC, and a
 *      count-based cap holds ~9 distinct sessions instead of 45.
 *
 * All three are the same root cause: in a list, position only APPROXIMATES
 * time. In a sorted set scored by the bar's own timestamp, position IS time.
 * `ZREVRANGE 0 n-1` is the newest n whoever wrote them and in whatever order;
 * `ZREMRANGEBYRANK key 0 -(cap+1)` evicts the OLDEST, atomically, on write.
 *
 * And it DEDUPES: a member is unique, so re-fetching an identical bar is a
 * score update rather than a second copy. Two bars at one timestamp survive
 * only when their CONTENT differs — which is the real case worth keeping,
 * because that is a `trade` bar and a `quote_mid` bar for the same minute, and
 * `selectBasis` is what decides between them.
 */
export interface BufferMember {
  score: number;
  value: string;
}

export function toBufferMembers(bars: readonly BasisBar[]): BufferMember[] {
  return bars.map((b) => ({ score: b.bar[0], value: encodeBar(b) }));
}

/**
 * What the sorted set would hold after adding `members`, NEWEST FIRST.
 *
 * Exists so the ordering and de-duplication contracts can be asserted against
 * the command's real semantics rather than against a comment describing them —
 * the list version's bugs were all invisible on read, because `decodeBuffer`
 * sorts ascending and the OUTPUT looked perfect while the store kept the wrong
 * end.
 */
export function simulateZAdd(
  existing: readonly BufferMember[],
  members: readonly BufferMember[],
): BufferMember[] {
  const byValue = new Map(existing.map((m) => [m.value, m]));
  for (const m of members) byValue.set(m.value, m);
  return [...byValue.values()].sort((a, b) => b.score - a.score);
}

/** What `ZREMRANGEBYRANK key 0 -(cap+1)` leaves, given a newest-first view. */
export function simulateRankTrim(
  members: readonly BufferMember[],
  capacity: number,
): BufferMember[] {
  return members.slice(0, capacity);
}
