/**
 * The SHARED Tiingo budget guard — MONEY-1309.
 *
 * ## What this is, and what it is NOT
 *
 * `tiingo-pacer.ts` spreads requests EVENLY in time so we never burst. It does
 * not, and cannot, know how much of the account's allowance has already been
 * spent, because its state is a module-scope counter: `dayRequestCount` is
 * per-PROCESS, and the quota is per-ACCOUNT. That is the same shape as the bug
 * MONEY-1263 fixed one layer down — four clients each pacing correctly against
 * a ceiling they were collectively exceeding fourfold — moved up from "four
 * modules in one process" to "N processes on one account".
 *
 * The processes that can spend this account CONCURRENTLY today:
 *
 *   us-eod-sync              worker, 11:00 IST Tue-Sat, PROD_ONLY   EOD + news
 *   us-instrument-master-sync worker, 10:00 IST prod / 14:00 QA     master,
 *                                                                   metadata,
 *                                                                   permaTicker
 *   tiingo-us-backfill       script, founder-run, ~73k requests
 *   tiingo-us-news-seed      script, founder-run
 *   the QA fixture generator  ops script, founder-run
 *
 * (that last one is named by ROLE rather than by filename on purpose. A guard
 * in packages/core greps every production source file for the QA sample
 * manifest's name and fails on any hit, because nothing on a production path
 * may reach for a Wikipedia-derived test fixture. It cannot tell a comment from
 * an import, and it should not have to — so the filename does not appear here,
 * including in this note, which is how it first tripped.)
 *
 * plus however many INSTANCES Cloud Run decides to give each worker. So this
 * module counts in Redis: one hour bucket, one day bucket, one month byte
 * meter, shared by every process, keyed by the window so nothing has to be
 * swept.
 *
 * This is a CEILING, not a rate limiter. It answers "may this leg spend
 * another request", and the pacer answers "not yet, wait 180ms". Both are
 * required: remove the pacer and this module happily authorises 16,000
 * requests in the first ninety seconds of the hour.
 *
 * ## Fixed windows vs Tiingo's ROLLING hour — the caveat, and why it is safe
 *
 * A `YYYYMMDDHH` bucket resets on the clock hour; Tiingo enforces over a
 * rolling hour. On paper that means a run could spend the ceiling at :59 and
 * the ceiling again at :01, putting 1.6x the plan's hourly cap inside one
 * rolling hour. That is a REAL defect in a bucket-only design and it is
 * neutralised here by the layer underneath rather than by arithmetic: the pacer
 * spreads at `3_600_000 / perHour` ms between requests, so a process
 * PHYSICALLY cannot emit two buckets' worth inside sixty minutes. A future
 * change that removes or loosens the pacer has to revisit this file too, which
 * is why it is written down here rather than assumed.
 *
 * ## FAIL-DEGRADED, deliberately diverging from the EDGAR limiter
 *
 * `services/us-fundamentals/app/sec/limiter.py` fails CLOSED: Redis
 * unreachable, no SEC request, run stops. Its header argues the case well and
 * it is right — for SEC. It is wrong here, and the difference is in what the
 * two upstreams DO when you overspend:
 *
 *   SEC     a per-IP fair-access policy. Breaching it gets the EGRESS IP
 *           blocked — Cloud Run shares egress addresses, so one job's
 *           overspend darkens every environment we own, the block lands days
 *           later, and nothing in the response attributes it. The failure is
 *           invisible while it is being caused: each instance still logs a
 *           virtuous 9 req/s. A stopped run is strictly cheaper.
 *
 *   Tiingo  a METERED PAID QUOTA. Breaching it returns 429 on the next
 *           request — immediate, attributable, per-request, and handled:
 *           `decideTiingoFailure` classifies it, the ladder backs off, and
 *           `breakTiingoLeg` parks the leg. There is no silent, delayed,
 *           cross-environment penalty to protect against.
 *
 *           THE SECOND HALF OF THAT SENTENCE WAS FALSE UNTIL MONEY-1309, and
 *           it is worth keeping the correction here because this paragraph is
 *           the argument the whole fail-degraded design rests on. The break
 *           armed on `err instanceof TiingoRateLimitError`, which a real 429
 *           never is — the feed seam throws a plain `Error` and the typed one
 *           is built a frame further out, in the ladder's catch. Measured
 *           through this wrapper with the production error string: `allowed:
 *           true`, no break key written. So the ladder half of the claim ran
 *           and the half this module owns did not, which made every piece of
 *           circuit-break machinery below dead code. See
 *           {@link isTiingoRateLimitFailure}. A justification for degrading
 *           rather than closing is only as good as the mechanism it defers to,
 *           so a claim of this kind needs a test that builds the failure the
 *           way PRODUCTION builds it — every test that covered this one
 *           hand-threw the typed error inside the callback and passed against
 *           a guard that could not fire.
 *
 * And the cost of stopping is not symmetric either. An EDGAR job re-runs
 * minutely. `us-eod-sync` has ONE window per day, gated by the US close and
 * the 12:00 AM ET NAV publication; a night it does not run is a hole in
 * `candles` that only the backfill can fill, at ~73k requests. Killing that job
 * because Redis blinked would spend far more quota than the blip could.
 *
 * So on a Redis failure the ceiling that is still LEFT is divided by
 * `TIINGO_BUDGET_CONSUMERS` and enforced per-process. That is a genuine
 * ceiling — it is what a fleet-unaware design would give us anyway — and it
 * degrades toward LESS spending, never more.
 *
 * "WHAT IS LEFT" IS LOAD-BEARING AND USED TO SAY "the ceiling". Seeding the
 * degraded ledger from ZERO handed a process that had already spent the whole
 * shared allowance a SECOND full one: 100/100 spent, Redis dies, 33 more
 * authorised in the same clock hour, 1.33x the ceiling — so the "never more"
 * above was false across exactly the transition it was written about. Both
 * halves of the fix, and what remains approximate about them, are in the
 * "Process-local state" header below.
 *
 * `TIINGO_BUDGET_CONSUMERS` is bounded at BOTH ends for the same reason. Zero
 * and negatives divide by zero or invert the sign; a large enough value floors
 * every ceiling to zero and turns this whole design into the fail-CLOSED one it
 * argues against (measured: N=200000 refused every request on every leg). See
 * {@link TIINGO_MAX_BUDGET_CONSUMERS}.
 *
 * The degradation is logged ONCE PER WINDOW rather than per call, because a
 * per-call warning in a 73k-request backfill is not an alert, it is a way of
 * hiding one — and once per OUTAGE rather than merely once per window, or a
 * node that flapped twenty times in an hour reported one blip.
 *
 * ## Requests are counted AFTER SUCCESS (MONEY-1255)
 *
 * `withTiingoBudget` records the request only once `fn` has resolved. Counting
 * before the call is the defect class MONEY-1255 found in
 * `stock-document-sync`, where every per-source counter was incremented BEFORE
 * the call it counted — so a source that 403'd on every request still produced
 * a full-looking number, and Tickertape's block hid for five months behind it.
 *
 * The honest consequence, stated rather than glossed: a request that FAILED
 * still cost quota at Tiingo's edge, so this meter UNDERCOUNTS. That is what
 * the 80% ceiling is for. It is headroom against exactly this — the failed
 * attempts we do not count, the retries the pacer charges but this does not,
 * and the rolling-window overlap above. A meter that lies in the SAFE direction
 * and a ceiling sized to absorb the lie beats a meter that reports a comforting
 * number nobody can act on.
 *
 * ## A PARTIALLY wired guard is worse than no guard — the 1-of-5 measurement
 *
 * This module shipped wired at ONE of the FIVE places in `packages/core/src`
 * that issue a Tiingo request. `tiingo-client.ts` (legs "eod" and "master")
 * went through `withTiingoBudget`; `tiingo-news.ts`,
 * `tiingo-corp-actions.ts`, `instruments/tiingo-search.ts` and
 * `instruments/us-instrument-names.ts` did not — four legs spending the same
 * metered account, invisible to the counter. The shared meter therefore reported
 * roughly A FIFTH of real spend until MONEY-1309 wired the other four.
 *
 * That is a worse failure than having no ceiling at all, and the asymmetry is
 * the reason it is written down here. No guard fails LOUDLY and at the right
 * moment: Tiingo answers 429, `decideTiingoFailure` classifies it, the
 * callers circuit-break. An under-reporting guard fails SILENTLY and in the
 * comforting direction: the ops read says 20% spent, `checkTiingoBudget`
 * never refuses, and the first evidence is the 429 the guard existed to
 * prevent — with `breakTiingoLeg`'s log insisting it should be impossible.
 * `TiingoBudgetLeg` declaring every leg name while two were wired is exactly
 * how that survives review: the TYPE looked complete. The wiring scan now
 * checks the LEG each site passes and not merely that some wrapper encloses it
 * — relabelling `withTiingoBudget("news"` to `("eod"` left it 8/8 green, and
 * the circuit break is per leg, so a mislabelled site parks the innocent leg
 * after a 429 and leaves the guilty one running.
 *
 * Wiring is now a checked property rather than a convention.
 * `__tests__/market-data/tiingo-budget-wiring.test.ts` scans the package for
 * every `paceTiingoRequest(` call site and fails the suite unless each one is
 * lexically inside a `withTiingoBudget(` callback. A source-text scan because
 * there is no import, base class or client object every caller shares — they
 * reach the network through `getFeedAsset`, the archive seam, which is shared
 * with NSE, BSE, Kite, RBI and SEC and has no business knowing about a Tiingo
 * quota.
 */

import { getRedisClient } from "../../cache/redis";
import { tiingoLimits } from "./tiingo-logic";
import { TiingoRateLimitError } from "./tiingo-errors";
import { TiingoDailyCapError } from "./tiingo-pacer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Key prefix. Every key below carries its own window, so nothing is swept. */
const KEY_PREFIX = "tiingo:budget";

/**
 * Fraction of the plan's REQUEST ceilings we will actually spend.
 *
 * Not caution for its own sake — it is sized against three known, quantified
 * leaks documented in the module header: failed attempts that cost quota and
 * are not counted, retries the pacer charges per attempt, and the fixed-window
 * vs rolling-hour overlap. 20% covers all three with room left over, and the
 * backfill still fits: 73k requests at COMMERCIAL's 16,000/hr effective
 * ceiling is ~4.6 hours against the 3.7 the raw cap would give.
 */
export const TIINGO_REQUEST_CEILING_FRACTION = 0.8;

/** How long each window's key outlives its window. */
const HOUR_KEY_TTL_SEC = 2 * 3600;
const DAY_KEY_TTL_SEC = 48 * 3600;
const MONTH_KEY_TTL_SEC = 40 * 86_400;

/** A 429 parks the offending leg for this long. */
export const TIINGO_CIRCUIT_BREAK_MS = 5 * 60_000;

/**
 * The legs that spend this account. A closed union rather than `string`
 * because the circuit break is PER LEG: a typo'd leg name would arm a break
 * nobody ever checks, and the whole point of the break is that the next call
 * on the same leg sees it.
 *
 * `realtime` is the STREAMING leg (MONEY-1309) and it is unlike the other six
 * in one way that matters: it spends BYTES continuously and REQUESTS almost
 * never. A websocket is one HTTP upgrade and then an open pipe, so charging it
 * per FRAME through `recordTiingoRequest` would be arithmetic nonsense — a leg
 * that opens four sockets a day would report four requests while moving
 * gigabytes. What it must feed is the MONTHLY BYTE METER, which is
 * account-wide and does not care whether the bytes arrived as a response body
 * or a frame. Use {@link recordStreamBytes} per frame (it buffers; no Redis
 * round trip until the threshold) and {@link flushStreamBytes} on a timer and
 * at shutdown. Never `recordBytes` per frame — see `recordStreamBytes` for why.
 *
 * `withTiingoBudget("realtime", ...)` still belongs around the things that ARE
 * discrete requests on this leg: the websocket upgrade itself, and the metered
 * REST snapshot bought on every reconnect. Wrapping each frame would put a
 * Redis read in the tick path and charge a "request" per quote.
 */
export type TiingoBudgetLeg =
  | "eod"
  | "master"
  | "metadata"
  | "search"
  | "news"
  | "corp-actions"
  | "realtime";

/**
 * The three rungs of the monthly BANDWIDTH ladder.
 *
 * THIS DECLARATION IS THE VOCABULARY, for the producer here AND for the
 * realtime consumer that acts on it. `DegradeStage` in
 * `tiingo-rt-subscription-logic.ts` is DERIVED from this union rather than
 * spelled out again, and that is load-bearing rather than tidy.
 *
 * The two were written independently and disagreed on two of three rungs — this
 * side said `shrink-ephemeral-ttl` / `sp500-only`, the consumer said
 * `shrink-ephemeral` / `baseline-only`. Both are string-literal unions in
 * different modules, so TypeScript saw two unrelated types and never compared
 * them: the mismatch was invisible until runtime, where a non-matching string
 * fell through to "no degradation at all" — silently, at exactly the moment the
 * byte budget was being blown. Only `alarm` matched, and its documented action
 * is "page a human", i.e. the one rung that sheds nothing.
 *
 * Deriving the consumer's type from this one makes a future rename a COMPILE
 * ERROR on both sides instead of a quiet fallthrough. Do not re-spell these
 * strings anywhere; import the type.
 */
export type TiingoBytesStage = "shrink-ephemeral" | "baseline-only" | "alarm";

/**
 * The bandwidth ladder.
 *
 * Bytes are graded SEPARATELY from requests and the ladder NEVER REFUSES, and
 * both of those are deliberate. Monthly bandwidth is the one limit whose
 * exhaustion cannot be undone by waiting an hour: refusing at 70% would dark
 * the platform for the rest of the month over a budget that still has 30% in
 * it. So the ladder hands the caller progressively cheaper ways to keep
 * running, and only the top rung says "a human decides now".
 *
 * Fractions are of the plan's RAW `bandwidthBytesPerMonth`, not of an 80%
 * ceiling — the 80% headroom exists to absorb an UNDERCOUNT, and bytes are
 * measured from response sizes we actually read, so there is nothing to
 * absorb.
 *
 * Measured sizing, from `tiingo-logic.ts`: the whole US backfill is ~10 GB of
 * COMMERCIAL's 100 GB. Reaching 70 GB in a month means something is fetching
 * far more than a backfill, which is precisely when a caller should start
 * shedding rather than a job should start failing.
 */
/**
 * The HTTP status inside a thrown feed-seam failure, or 0.
 *
 * THE ONE COPY OF THIS RULE. `tiingo-client.ts`'s `statusFromFeedFailure`
 * delegates here rather than carrying a second regex, because the two would be
 * one rule stated twice and free to disagree — the defect class MONEY-1255
 * named when a `mimeType` exact-match and its sibling substring test disagreed
 * about the same 1,211 rows.
 *
 * It lives HERE, in the budget module, rather than in the client, because the
 * budget module is the one that must not import the client: `tiingo-client.ts`
 * already imports `withTiingoBudget`, so the arrow only points one way.
 *
 * `fetchExchangeAsset` (exchange-feed.ts:154) throws
 * `Exchange fetch failed: {status} {statusText} ({url})`, so the status is the
 * only classifiable fact that survives the seam. A transport failure (DNS,
 * abort, timeout) carries none, which is what 0 means.
 */
export function tiingoStatusFromError(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  return Number(/failed:\s*(\d{3})/.exec(msg)?.[1] ?? 0);
}

/**
 * Is this failure a Tiingo RATE LIMIT — i.e. must it arm the circuit break?
 *
 * ## The bug this exists to fix (MONEY-1309)
 *
 * `withTiingoBudget` used to arm the break on `err instanceof
 * TiingoRateLimitError` alone. That arm was UNREACHABLE IN PRODUCTION, and the
 * reason is a frame boundary rather than a typo.
 *
 * A real Tiingo 429 does not arrive typed. It arrives as a PLAIN `Error` from
 * `exchange-feed.ts:154` reading `Exchange fetch failed: 429 Too Many Requests
 * (...)` — which is precisely why `statusFromFeedFailure` has to parse a status
 * out of a message string in the first place. `TiingoRateLimitError` is
 * constructed only in the retry ladders' CATCH blocks (tiingo-client.ts,
 * tiingo-news.ts, tiingo-corp-actions.ts), one frame OUTSIDE the
 * `withTiingoBudget` callback. So the typed error was born where the wrapper
 * could no longer see it, and a probe through the real wrapper with the exact
 * production string measured: `allowed: true`, no break key written.
 *
 * That made `breakTiingoLeg` a function with one dead caller, and
 * `TIINGO_CIRCUIT_BREAK_MS`, the `break:` key, `isBroken`'s Redis leg and the
 * `circuit-break` verdict dead with it. It also falsified this module's own
 * central argument: the header justifies fail-DEGRADED over fail-CLOSED partly
 * on the grounds that a 429 "is already handled — the ladder backs off and
 * `TiingoRateLimitError` circuit-breaks the run". The ladder half ran; the half
 * this module owns did not.
 *
 * The tests did not catch it because every one of them hand-threw
 * `new TiingoRateLimitError(...)` INSIDE the callback — a shape production
 * never produces. They guarded the ARM, not the BEHAVIOUR.
 *
 * ## Why it is decided on the STATUS and not on the class
 *
 * Because the class is what production does not supply. Both are accepted: the
 * typed error still arms the break (an inner frame that has already classified
 * a 429 is right, and a future caller may throw it), and so does any failure
 * whose message carries a 429 — which is the shape the feed seam actually
 * produces. The status is read through the SAME function `decideTiingoFailure`
 * uses, so the ladder and the guard cannot disagree about what a 429 is.
 */
export function isTiingoRateLimitFailure(err: unknown): boolean {
  // The pacer's own daily cap and this module's own refusal are SUBCLASSES of
  // `TiingoRateLimitError` (see `TiingoDailyCapError` and
  // `TiingoBudgetExhaustedError`). Neither is a 429 from Tiingo: the first
  // never touched the network and the second is us refusing ourselves, so
  // arming a five-minute break over either would park a leg for an event that
  // is neither a 429 nor impossible — and log that it should be impossible.
  if (err instanceof TiingoDailyCapError) return false;
  if (err instanceof TiingoBudgetExhaustedError) return false;
  if (err instanceof TiingoRateLimitError) return true;
  return tiingoStatusFromError(err) === 429;
}

export const TIINGO_BYTES_LADDER: readonly {
  readonly fraction: number;
  readonly stage: TiingoBytesStage;
  /** What the caller is expected to DO. Prose, because it is for the operator. */
  readonly action: string;
}[] = [
  {
    fraction: 0.7,
    stage: "shrink-ephemeral",
    action:
      "shorten ephemeral cache TTLs and stop re-fetching what the warehouse already holds",
  },
  {
    fraction: 0.8,
    stage: "baseline-only",
    action:
      "drop ephemeral page interest and keep only the baseline subscription set",
  },
  {
    fraction: 0.9,
    stage: "alarm",
    action:
      "page a human — there is nothing further to shed automatically before the cap",
  },
] as const;

// ---------------------------------------------------------------------------
// Test seams
//
// `packages/core` is ESM, where the CJS `require.cache` module-swap the web
// suite uses does not work and `node:test`'s `mock.module` needs an
// experimental flag this repo does not pass. Same reasoning, and the same
// shape, as `brokers/oauth-state.ts`. Production never calls a setter.
// ---------------------------------------------------------------------------

/**
 * The narrow slice of ioredis this module uses.
 *
 * Declared as its own interface, with the real client ADAPTED into it below,
 * rather than typing the seam as `Redis | null`. ioredis's `set` is heavily
 * overloaded and structural assignability across overload sets is exactly the
 * kind of thing that ends in an `any` to make the compiler quiet.
 */
export interface TiingoBudgetRedis {
  incrby(key: string, amount: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  get(key: string): Promise<string | null>;
  setEx(key: string, value: string, seconds: number): Promise<void>;
}

export type TiingoBudgetRedisGetter = () => TiingoBudgetRedis | null;

function defaultRedis(): TiingoBudgetRedis | null {
  const client = getRedisClient();
  if (!client) return null;
  return {
    incrby: (key, amount) => client.incrby(key, amount),
    expire: (key, seconds) => client.expire(key, seconds),
    get: (key) => client.get(key),
    setEx: async (key, value, seconds) => {
      await client.set(key, value, "EX", seconds);
    },
  };
}

let redisGetter: TiingoBudgetRedisGetter = defaultRedis;
let nowFn: () => number = Date.now;
/**
 * The plan's three raw numbers, STRUCTURALLY typed.
 *
 * `TiingoLimits` is a union of two `as const` object literals, so its `perHour`
 * is the literal type `20000 | 80000` — a test override of 125 is not
 * assignable to it, and nothing in this module needs those literals. This is
 * the widened shape; the real table satisfies it.
 */
export interface TiingoRequestLimits {
  readonly perHour: number;
  readonly perDay: number;
  readonly bandwidthBytesPerMonth: number;
}

/** Overrides `tiingoLimits()`. Tests only — see `activeLimits`. */
let limitsOverride: TiingoRequestLimits | null = null;

/** Inject a Redis accessor. Pass null to restore the real client. */
export function __setTiingoBudgetRedisForTests(
  fn: TiingoBudgetRedisGetter | null,
): void {
  redisGetter = fn ?? defaultRedis;
}

/** Inject a clock so window rollover is testable without waiting an hour. */
export function __setTiingoBudgetClockForTests(
  fn: (() => number) | null,
): void {
  nowFn = fn ?? Date.now;
}

/**
 * Inject plan limits so a ceiling of 100 can be exercised without 20,000 calls.
 *
 * This seam deliberately does NOT cover `TIINGO_PLAN` resolution: when it is
 * null, `activeLimits()` calls `tiingoLimits()`, which reads the env PER CALL.
 * A test that flips the plan must leave the override off, so the plan path is
 * the thing under test rather than this bypass.
 */
export function __setTiingoBudgetLimitsForTests(
  limits: TiingoRequestLimits | null,
): void {
  limitsOverride = limits;
}

// ---------------------------------------------------------------------------
// Process-local state — the fallback ledger, and the circuit breaks
//
// ## What the local ledger COUNTS, and why it is not simply "spend" (MONEY-1309)
//
// It counts spend THIS PROCESS charged while the shared counter was
// unavailable and which has NOT yet reached Redis. That is a narrower thing
// than it used to count, and the difference was a real 1.33x overspend.
//
// The old ledger rolled from `localHourWindow = ""`, so a process that had
// already spent the account's FULL shared allowance started the local ledger at
// ZERO the moment Redis died:
//
//     shared spend 100/100 -> refused.
//     Redis dies, SAME clock hour -> 33 MORE requests authorised (100 / 3).
//     Redis returns -> the shared counter still reads 100. Actual spend: 133.
//
// 1.33x the ceiling inside one clock hour, plus a permanent undercount that
// every sibling process then reads as headroom. The module header's claim that
// degradation "degrades toward LESS spending, never more" was false across
// exactly that transition.
//
// Two pieces fix it, and both are approximations that say so:
//
//   1. SEED FROM WHAT WE LAST KNEW. `sharedSeen*` remembers the last shared
//      total observed for a window. While degraded the allowance is
//      `(ceiling - lastKnownSharedSpend) / N` — one process's share of what
//      REMAINS — instead of a fresh full ceiling. If the account was already
//      spent, the honest answer is zero and the guard refuses; that is not
//      fail-closed, it is the last known truth, and the window rolls within the
//      hour.
//   2. BACK-FILL ON RECOVERY. The first successful shared INCR after an outage
//      adds the unflushed local backlog too, so the 33 above are not lost and
//      siblings stop reading phantom headroom.
//
// WHAT IS STILL APPROXIMATE, stated rather than discovered later: between our
// last shared read and the outage, SIBLINGS may have spent more than we saw, so
// the seed can be stale-low; and the back-fill lands late, so for the length of
// the outage every sibling under-reads the account. Neither can be made exact
// without a shared store — which is precisely the thing that is missing — so
// the design is "conservative and self-correcting", never "correct". Claiming
// exactness here would be its own defect.
// ---------------------------------------------------------------------------

/** Spend charged locally in this window and NOT yet flushed to Redis. */
let localHourWindow = "";
let localHourCount = 0;
let localDayWindow = "";
let localDayCount = 0;
let localMonthWindow = "";
let localMonthBytes = 0;

/**
 * The last SHARED totals this process observed, per window.
 *
 * The seed for the degraded ledger. Kept per window label so a rollover
 * discards it rather than carrying an old hour's spend into a new one.
 */
let sharedSeenHourWindow = "";
let sharedSeenHour = 0;
let sharedSeenDayWindow = "";
let sharedSeenDay = 0;
let sharedSeenMonthWindow = "";
let sharedSeenMonthBytes = 0;

/**
 * The highest bandwidth rung this process has seen this month.
 *
 * The bandwidth ladder is the ONE limit that cannot be undone by waiting an
 * hour, and before MONEY-1309 it fail-OPENED the instant Redis blinked: a
 * shared month sitting on `alarm` went to `null` on the next `recordBytes`, so
 * shedding simply stopped at the moment the budget was being blown. The rung is
 * already MONOTONE within a month by design (see `readTiingoBytesStage`), so
 * remembering the high-water mark locally costs nothing and removes the
 * fail-open. Keyed by month so it cannot leak into the next one.
 */
let seenStageMonth = "";
let seenStageIndex = 0;
/** The hour window whose degradation we have already shouted about. */
let degradedLoggedForWindow = "";
/** leg -> epoch ms at which its break expires. */
const localBreaks = new Map<TiingoBudgetLeg, number>();

/** Clear every piece of module state. Tests only — it would leak between them. */
export function __resetTiingoBudget(): void {
  localHourWindow = "";
  localHourCount = 0;
  localDayWindow = "";
  localDayCount = 0;
  localMonthWindow = "";
  localMonthBytes = 0;
  sharedSeenHourWindow = "";
  sharedSeenHour = 0;
  sharedSeenDayWindow = "";
  sharedSeenDay = 0;
  sharedSeenMonthWindow = "";
  sharedSeenMonthBytes = 0;
  seenStageMonth = "";
  seenStageIndex = 0;
  bufferedStreamBytes = 0;
  degradedLoggedForWindow = "";
  localBreaks.clear();
}

/**
 * Remember a shared total we just observed, so the degraded ledger can be
 * seeded from it rather than from zero. Window-keyed: a rollover discards it.
 */
function noteSharedHour(w: TiingoBudgetWindows, total: number): void {
  sharedSeenHourWindow = w.hour;
  sharedSeenHour = Math.max(0, total);
}
function noteSharedDay(w: TiingoBudgetWindows, total: number): void {
  sharedSeenDayWindow = w.day;
  sharedSeenDay = Math.max(0, total);
}
function noteSharedMonthBytes(w: TiingoBudgetWindows, total: number): void {
  sharedSeenMonthWindow = w.month;
  sharedSeenMonthBytes = Math.max(0, total);
}

/** The last shared total for THIS window, or 0 if we never saw one. */
function seenHourFor(w: TiingoBudgetWindows): number {
  return sharedSeenHourWindow === w.hour ? sharedSeenHour : 0;
}
function seenDayFor(w: TiingoBudgetWindows): number {
  return sharedSeenDayWindow === w.day ? sharedSeenDay : 0;
}
function seenMonthBytesFor(w: TiingoBudgetWindows): number {
  return sharedSeenMonthWindow === w.month ? sharedSeenMonthBytes : 0;
}

// ---------------------------------------------------------------------------
// Windows and keys
// ---------------------------------------------------------------------------

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

export interface TiingoBudgetWindows {
  /** `YYYYMMDDHH`, UTC. */
  readonly hour: string;
  /** `YYYYMMDD`, UTC. */
  readonly day: string;
  /** `YYYYMM`, UTC. */
  readonly month: string;
}

/**
 * The three window labels for an instant.
 *
 * UTC, not IST, and not the local zone. The key is SHARED across processes that
 * do not agree on a timezone — a Cloud Run container, a founder's laptop
 * running the backfill, a QA job — and a key whose value depends on `TZ` would
 * silently split the counter in two, which is the exact failure this module
 * exists to prevent, reintroduced through a formatting choice.
 */
export function tiingoBudgetWindows(
  nowMs: number = nowFn(),
): TiingoBudgetWindows {
  const d = new Date(nowMs);
  const ymd = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}`;
  return {
    hour: `${ymd}${pad(d.getUTCHours(), 2)}`,
    day: ymd,
    month: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}`,
  };
}

const hourKey = (w: TiingoBudgetWindows): string =>
  `${KEY_PREFIX}:req:h:${w.hour}`;
const dayKey = (w: TiingoBudgetWindows): string =>
  `${KEY_PREFIX}:req:d:${w.day}`;
const bytesKey = (w: TiingoBudgetWindows): string =>
  `${KEY_PREFIX}:bytes:m:${w.month}`;
const stageKey = (w: TiingoBudgetWindows): string =>
  `${KEY_PREFIX}:stage:m:${w.month}`;
const breakKey = (leg: TiingoBudgetLeg): string => `${KEY_PREFIX}:break:${leg}`;

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

/**
 * The plan's raw limits, resolved PER CALL.
 *
 * `tiingoLimits()` reads `TIINGO_PLAN` on every call and this function must not
 * undo that. A module-scope `const LIMITS = tiingoLimits()` freezes the value
 * at IMPORT, so on a warm Cloud Run container a redeployed `TIINGO_PLAN` is no
 * switch at all — the same trap `XBRL_PROJECTION_APPLY` and `TIINGO_PLAN`'s own
 * doc comment already name, and the one `bse-client.ts`'s retry config was
 * actually caught by.
 */
function activeLimits(): TiingoRequestLimits {
  if (limitsOverride) return limitsOverride;
  return tiingoLimits();
}

export interface TiingoBudgetCeilings {
  readonly perHour: number;
  readonly perDay: number;
  /** The plan's RAW monthly cap. The ladder's fractions are of this. */
  readonly bytesPerMonth: number;
}

/**
 * The SHARED ceilings: 80% of the plan's request caps, resolved per call.
 *
 * `Math.floor`, never `Math.ceil`, and the direction is load-bearing rather
 * than cosmetic: the 80% fraction is HEADROOM against three known undercounts
 * (see `TIINGO_REQUEST_CEILING_FRACTION`), so rounding the ceiling UP spends a
 * sliver of the very margin that exists to absorb them. It is invisible on the
 * real plan table — every product there is an exact integer (20,000 x 0.8 =
 * 16,000) — which is exactly why the direction has to be pinned by a test with
 * a NON-exact product rather than left to the table to enforce.
 */
export function tiingoBudgetCeilings(): TiingoBudgetCeilings {
  const limits = activeLimits();
  return {
    perHour: Math.floor(limits.perHour * TIINGO_REQUEST_CEILING_FRACTION),
    perDay: Math.floor(limits.perDay * TIINGO_REQUEST_CEILING_FRACTION),
    bytesPerMonth: limits.bandwidthBytesPerMonth,
  };
}

/**
 * How many processes we assume are sharing this account when Redis is gone.
 *
 * Read PER CALL, same rule as the plan. Default 3 — the two nightly workers
 * plus one founder-run script, which is what can realistically overlap in the
 * steady state.
 *
 * It does NOT model Cloud Run instance fan-out, and pretending otherwise would
 * be the worse error: a divisor tuned for a worst-case fleet would throttle the
 * common case to uselessness. The shared counter is the real mechanism; this is
 * the floor we drop to while it is unavailable, and it is meant to be
 * conservative-but-usable rather than correct.
 *
 * A non-numeric, zero or negative value resolves to the default rather than
 * dividing by zero or, worse, MULTIPLYING the ceiling. A value ABOVE
 * {@link TIINGO_MAX_BUDGET_CONSUMERS} is clamped for the mirror-image reason —
 * see that constant.
 */
export function tiingoBudgetConsumers(): number {
  const raw = Number(process.env.TIINGO_BUDGET_CONSUMERS);
  if (!Number.isFinite(raw) || raw < 1) return 3;
  return Math.min(Math.floor(raw), TIINGO_MAX_BUDGET_CONSUMERS);
}

/**
 * The largest divisor we will honour — the OTHER end of the guard.
 *
 * The zero/negative rejection above exists because those values divide by zero
 * or invert the sign. This end exists because a large enough divisor turns
 * FAIL-DEGRADED into FAIL-CLOSED, which is the one outcome this module's header
 * argues at length against: `effectiveCeilings` floors, so under COMMERCIAL any
 * `N > 16000` produces `{perHour: 0}` and refuses EVERY request on EVERY leg for
 * as long as Redis is down. Measured with `N=200000`: `{perHour: 0, perDay: 0}`,
 * every call refused. A typo'd or copy-pasted env value would then kill the
 * nightly run outright — and `us-eod-sync` has ONE window a day, so the hole it
 * leaves costs a ~73k-request backfill to fill.
 *
 * 64 is sized off the fleet that can actually hold this key, not off arithmetic:
 *
 *   stockbook-workers          prod maxScale 20  (every Tiingo REST leg —
 *                                                 us-eod-sync, the master sync,
 *                                                 news, corp-actions, search,
 *                                                 metadata — rides this service)
 *   tiingo-realtime-{env}      maxScale 1        (minScale = maxScale = 1, and
 *                                                 a Redis leader lock on top)
 *   founder-run scripts        ~3                (backfill, news seed, the QA
 *                                                 fixture generator)
 *
 * so the realistic worst case in one environment is ~24. 64 is a shade over
 * double that, which absorbs a maxScale bump without a code change while
 * keeping every COMMERCIAL ceiling comfortably positive (16,000 / 64 = 250
 * requests per process per hour). Above that the number has stopped describing
 * a fleet and started describing a mistake.
 */
export const TIINGO_MAX_BUDGET_CONSUMERS = 64;

/**
 * The ceilings actually enforced, given whether the shared counter answered.
 *
 * The `Math.max(1, ...)` is a SECOND, independent guard against the
 * fail-closed collapse, and it is deliberate duplication rather than belt with
 * no braces. `TIINGO_MAX_BUDGET_CONSUMERS` is a JUDGEMENT about how large a
 * fleet can plausibly get; this is a STRUCTURAL invariant that does not depend
 * on that judgement being right — a positive plan ceiling must never divide
 * down to a zero one, whatever N and whatever a future plan table says. A
 * ceiling that is genuinely zero (a test forcing a refusal, a plan with no
 * allowance) still passes through as zero, because `0 / n` has no positive
 * budget to preserve.
 */
function effectiveCeilings(
  shared: boolean,
  /**
   * The window whose already-known SHARED spend should be deducted before the
   * share is taken. Omitted by callers that only want the shape of the degraded
   * ceiling (`readTiingoBytesStage`'s no-client path), which is why it is
   * optional rather than required — with no window the deduction is zero and
   * the answer is the old full-ceiling share.
   */
  w?: TiingoBudgetWindows,
): TiingoBudgetCeilings {
  const c = tiingoBudgetCeilings();
  if (shared) return c;
  const n = tiingoBudgetConsumers();
  // What is LEFT of the account, not what the account started with. This is
  // the F2 fix: a fresh full ceiling here is how a process that had already
  // spent 100/100 authorised 33 more the moment Redis died.
  const remaining = (ceiling: number, spent: number): number =>
    Math.max(0, ceiling - spent);
  const share = (ceiling: number, spent: number): number => {
    if (!(ceiling > 0)) return 0;
    const left = remaining(ceiling, spent);
    // A genuinely exhausted account gets 0 and the guard refuses. That is the
    // last known truth rather than fail-closed: the hour window rolls within
    // sixty minutes and the seed is discarded with it.
    if (left <= 0) return 0;
    return Math.max(1, Math.floor(left / n));
  };
  return {
    perHour: share(c.perHour, w ? seenHourFor(w) : 0),
    perDay: share(c.perDay, w ? seenDayFor(w) : 0),
    // Divided like the others. The degraded BYTES ceiling is what grades the
    // bandwidth ladder while Redis is down, so dropping this division would
    // silently hold every process below rung 1 on a month that was already
    // over it — a shedding ladder nobody stands on.
    bytesPerMonth: share(c.bytesPerMonth, w ? seenMonthBytesFor(w) : 0),
  };
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/**
 * Which rung `bytesUsed` sits on, or null below the first.
 *
 * `>=` on purpose: the ladder fires AT 70%, not past it. A `>` would make the
 * first rung unreachable for any run whose byte total lands exactly on the
 * boundary, which is not a corner case when the ceiling is a round number of
 * gigabytes and the caller is deciding whether to shed.
 */
export function tiingoBytesStage(
  bytesUsed: number,
  bytesCeiling: number,
): TiingoBytesStage | null {
  if (!(bytesCeiling > 0) || !Number.isFinite(bytesUsed)) return null;
  const ratio = bytesUsed / bytesCeiling;
  let stage: TiingoBytesStage | null = null;
  for (const rung of TIINGO_BYTES_LADDER) {
    if (ratio >= rung.fraction) stage = rung.stage;
  }
  return stage;
}

/** 1-based rung index, or 0 for "below the ladder". The Redis wire format. */
function stageIndex(stage: TiingoBytesStage | null): number {
  if (stage === null) return 0;
  return TIINGO_BYTES_LADDER.findIndex((r) => r.stage === stage) + 1;
}

function stageFromIndex(index: number): TiingoBytesStage | null {
  const rung = TIINGO_BYTES_LADDER[index - 1];
  return rung ? rung.stage : null;
}

/**
 * Read the ladder rung another process last published, without recomputing it.
 *
 * The AUTHORITY is always `bytesUsed / bytesCeiling` — this key is a cache so
 * that a process which has not itself recorded any bytes (an ops query, a job
 * on a different leg) can see the rung in one GET. Published MONOTONICALLY
 * within a month: two processes computing from the same shared counter agree on
 * the value, so the only ordering hazard is a stale write landing after a
 * higher one, and refusing to write downward removes it. A ladder that flapped
 * would toggle `baseline-only` on and off between nightly legs, which is worse
 * than being one rung stale.
 */
export async function readTiingoBytesStage(): Promise<TiingoBytesStage | null> {
  const w = tiingoBudgetWindows();
  // The local month must be ROLLED here exactly as `readCounters` and
  // `localAddBytes` roll theirs. Without it an August "alarm" was still being
  // reported in September until some other call path happened to roll the
  // window — a stale rung on a budget that had reset.
  rollLocalMonth(w);

  const redis = safeRedis();
  if (!redis) return noteStage(w, localBytesStage(w));

  let cached: TiingoBytesStage | null = null;
  try {
    const raw = await redis.get(stageKey(w));
    cached = raw === null ? null : stageFromIndex(Number(raw));
  } catch {
    // Fall through to the counter. A stage key we cannot read is not evidence
    // that the month is below the ladder.
    return noteStage(w, localBytesStage(w));
  }
  if (cached !== null) return noteStage(w, cached);

  // THE CACHE MISSED — fall back to the COUNTER, which is the authority.
  //
  // This function used to return `null` here, which failed precisely the reader
  // its own doc comment names ("an ops query, a job on a different leg"): with
  // a shared counter at 950/1000 it answered `null` while `checkTiingoBudget`
  // on the same Redis, in the same millisecond, answered "alarm". The stage key
  // is only ever WRITTEN by `recordBytes`, so any month in which this process
  // has recorded no bytes — or in which the publish lost its race — read as
  // "below the ladder", fail-open, on the one limit that cannot be undone by
  // waiting an hour.
  try {
    const raw = await redis.get(bytesKey(w));
    const total = Number(raw ?? 0) || 0;
    noteSharedMonthBytes(w, total);
    return noteStage(
      w,
      tiingoBytesStage(total, effectiveCeilings(true).bytesPerMonth),
    );
  } catch {
    return noteStage(w, localBytesStage(w));
  }
}

/** The rung the process-local byte ledger is on, graded degraded. */
function localBytesStage(w: TiingoBudgetWindows): TiingoBytesStage | null {
  return tiingoBytesStage(
    localMonthBytes,
    effectiveCeilings(false, w).bytesPerMonth,
  );
}

/**
 * Record a rung we have learned, and never report a LOWER one this month.
 *
 * The ladder is already monotone within a month by design; this makes it
 * monotone across a REDIS OUTAGE too, which is where it used to fail open —
 * a shared month sitting on `alarm` reported `null` on the very next call once
 * Redis went away, and shedding stopped at the moment it was most needed.
 */
function noteStage(
  w: TiingoBudgetWindows,
  stage: TiingoBytesStage | null,
): TiingoBytesStage | null {
  if (seenStageMonth !== w.month) {
    seenStageMonth = w.month;
    seenStageIndex = 0;
  }
  const idx = stageIndex(stage);
  if (idx > seenStageIndex) seenStageIndex = idx;
  return stageFromIndex(seenStageIndex);
}

function rollLocalMonth(w: TiingoBudgetWindows): void {
  if (localMonthWindow !== w.month) {
    localMonthWindow = w.month;
    localMonthBytes = 0;
  }
}

// ---------------------------------------------------------------------------
// Redis plumbing
// ---------------------------------------------------------------------------

function safeRedis(): TiingoBudgetRedis | null {
  try {
    return redisGetter();
  } catch {
    // `getRedisClient()` is not supposed to throw, but a getter that does must
    // degrade like an absent one rather than take the caller's run with it.
    return null;
  }
}

/**
 * INCRBY, with EXPIRE set on CREATE.
 *
 * The expire is conditional on the counter having just been created — the
 * returned total equalling the amount added — which costs one extra round trip
 * per window instead of one per request. If the process dies between the two
 * commands the key is immortal, and that is survivable rather than merely
 * unlikely: every key here carries its own window in its NAME, so a leaked key
 * is never read again by anything. It costs a few bytes of Redis and cannot
 * corrupt a later window's count, which is the whole reason the windows are in
 * the keys.
 */
async function incrWindow(
  redis: TiingoBudgetRedis,
  key: string,
  amount: number,
  ttlSec: number,
): Promise<number> {
  const total = await redis.incrby(key, amount);
  if (total === amount) await redis.expire(key, ttlSec);
  return total;
}

function noteDegraded(window: string, err: unknown): void {
  if (degradedLoggedForWindow === window) return;
  degradedLoggedForWindow = window;
  const n = tiingoBudgetConsumers();
  console.warn(
    `[tiingo-budget] SHARED counter unavailable for window ${window} — ` +
      `falling back to a per-process share of 1/${n} of what is LEFT of every ` +
      `ceiling. Spending is now bounded per PROCESS, not per ACCOUNT, so N ` +
      `concurrent processes can spend N/${n} of the remaining plan. This is ` +
      `deliberate (fail-degraded, not fail-closed: see tiingo-budget.ts) but ` +
      `it is not the intended state — check REDIS_URL and the Redis node. ` +
      `Logged once per hour window, or once per OUTAGE if the node flaps.`,
    err instanceof Error ? err.message : err,
  );
}

/**
 * The shared counter answered — clear the once-per-window latch.
 *
 * Without this a FLAPPING node produced exactly one warning per hour no matter
 * how many times it came and went, so the log said "one blip" about twenty. The
 * latch exists to stop a per-CALL warning inside a 73k-request backfill from
 * drowning the alert it is supposed to be; it was never meant to suppress
 * distinct OUTAGES. Cleared on recovery, the count of warnings becomes the
 * count of outages, which is the number an operator actually wants.
 *
 * A node flapping mid-request cannot spam it either: the latch is only cleared
 * by a SUCCESS, so the worst case is one warning per successful/failed pair.
 */
function noteRecovered(): void {
  degradedLoggedForWindow = "";
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

interface TiingoBudgetCommon {
  /** true when the SHARED counter answered; false on the degraded local share. */
  readonly shared: boolean;
  /** The bandwidth rung, or null. Present on refusals too — still actionable. */
  readonly stage: TiingoBytesStage | null;
  readonly hourUsed: number;
  readonly dayUsed: number;
  readonly bytesUsed: number;
  readonly ceilings: TiingoBudgetCeilings;
}

export type TiingoBudgetVerdict =
  | (TiingoBudgetCommon & { readonly allowed: true })
  | (TiingoBudgetCommon & {
      readonly allowed: false;
      readonly reason: "hour-ceiling" | "day-ceiling" | "circuit-break";
      readonly detail: string;
    });

/**
 * Raised when the guard refuses a request.
 *
 * EXTENDS `TiingoRateLimitError` for the reason `TiingoDailyCapError`'s own
 * doc comment gives, and it is worth restating because getting it wrong cost a
 * release: every circuit-breaker in this repo — seven of them, across
 * `us-eod-sync` and three backfill scripts — is written against
 * `TiingoRateLimitError`. A refusal that arrived as a plain `Error` would land
 * in their generic `else`, which does the OPPOSITE of what a ceiling is for:
 * the throw happens before any sleep, so the run tears through every remaining
 * symbol in seconds recording each as a failure, and with `rateLimited` unset
 * it keeps SELF-CHAINING — a job that hit its ceiling and responded by asking
 * for more work.
 *
 * Subclassing means no breaker has to be found and edited, and a future one
 * written against the parent inherits the behaviour rather than the bug.
 */
export class TiingoBudgetExhaustedError extends TiingoRateLimitError {
  constructor(
    message: string,
    readonly verdict: Extract<TiingoBudgetVerdict, { allowed: false }>,
  ) {
    super(message);
    this.name = "TiingoBudgetExhaustedError";
    // `TiingoRateLimitError`'s constructor builds its own message from a
    // context string, so it has to be overwritten rather than passed through.
    this.message = message;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function readCounters(): Promise<{
  shared: boolean;
  hour: number;
  day: number;
  bytes: number;
}> {
  const w = tiingoBudgetWindows();
  const redis = safeRedis();
  if (redis) {
    try {
      const [h, d, b] = await Promise.all([
        redis.get(hourKey(w)),
        redis.get(dayKey(w)),
        redis.get(bytesKey(w)),
      ]);
      const hour = Number(h ?? 0) || 0;
      const day = Number(d ?? 0) || 0;
      const bytes = Number(b ?? 0) || 0;
      // Remember what the account looked like, so that if Redis goes away
      // before the next call the degraded ledger is seeded from THIS rather
      // than from zero. See the "Process-local state" header for the 1.33x
      // overspend that seeding from zero caused.
      noteSharedHour(w, hour);
      noteSharedDay(w, day);
      noteSharedMonthBytes(w, bytes);
      noteRecovered();
      return { shared: true, hour, day, bytes };
    } catch (err) {
      noteDegraded(w.hour, err);
    }
  } else {
    noteDegraded(w.hour, new Error("no Redis client"));
  }

  // Degraded: the process-local ledger, rolled on window change. It counts
  // only spend charged SINCE the outage began; the spend that happened before
  // it is carried by `sharedSeen*` into the CEILING instead (see
  // `effectiveCeilings`), which is what keeps the two from being added twice.
  if (localHourWindow !== w.hour) {
    localHourWindow = w.hour;
    localHourCount = 0;
  }
  if (localDayWindow !== w.day) {
    localDayWindow = w.day;
    localDayCount = 0;
  }
  rollLocalMonth(w);
  return {
    shared: false,
    hour: localHourCount,
    day: localDayCount,
    bytes: localMonthBytes,
  };
}

async function isBroken(leg: TiingoBudgetLeg): Promise<boolean> {
  const now = nowFn();
  const localUntil = localBreaks.get(leg);
  if (localUntil !== undefined) {
    if (localUntil > now) return true;
    localBreaks.delete(leg);
  }
  const redis = safeRedis();
  if (!redis) return false;
  try {
    const raw = await redis.get(breakKey(leg));
    if (raw === null) return false;
    const until = Number(raw);
    return Number.isFinite(until) && until > now;
  } catch {
    // A break we cannot read is not a break we invent. The LOCAL copy above is
    // what makes this safe: the process that saw the 429 keeps enforcing it
    // even with Redis gone, and a sibling process that never saw one simply
    // has nothing to enforce.
    return false;
  }
}

/**
 * May this leg spend another request?
 *
 * Pure read — it charges NOTHING. `recordTiingoRequest` is the charge, and it
 * runs after the call succeeds.
 */
export async function checkTiingoBudget(
  leg: TiingoBudgetLeg,
): Promise<TiingoBudgetVerdict> {
  const counters = await readCounters();
  // The WINDOW is passed so a degraded ceiling is a share of what REMAINS
  // rather than a fresh full allowance (MONEY-1309, F2).
  const ceilings = effectiveCeilings(
    counters.shared,
    tiingoBudgetWindows(nowFn()),
  );
  // Graded through `noteStage` so this verdict can never report a LOWER rung
  // than something else already learned this month — the bandwidth ladder is
  // monotone within a month, including across a Redis outage.
  const stage = noteStage(
    tiingoBudgetWindows(nowFn()),
    tiingoBytesStage(counters.bytes, ceilings.bytesPerMonth),
  );
  const common: TiingoBudgetCommon = {
    shared: counters.shared,
    stage,
    hourUsed: counters.hour,
    dayUsed: counters.day,
    bytesUsed: counters.bytes,
    ceilings,
  };

  if (await isBroken(leg)) {
    return {
      ...common,
      allowed: false,
      reason: "circuit-break",
      detail:
        `Tiingo leg "${leg}" is circuit-broken after a 429 ` +
        `(${Math.round(TIINGO_CIRCUIT_BREAK_MS / 60_000)} min)`,
    };
  }
  if (counters.day >= ceilings.perDay) {
    return {
      ...common,
      allowed: false,
      reason: "day-ceiling",
      detail:
        `Tiingo DAILY budget spent: ${counters.day}/${ceilings.perDay} ` +
        `(${counters.shared ? "shared" : "per-process share"})`,
    };
  }
  if (counters.hour >= ceilings.perHour) {
    return {
      ...common,
      allowed: false,
      reason: "hour-ceiling",
      detail:
        `Tiingo HOURLY budget spent: ${counters.hour}/${ceilings.perHour} ` +
        `(${counters.shared ? "shared" : "per-process share"})`,
    };
  }
  return { ...common, allowed: true };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Charge ONE request against the hour and day counters.
 *
 * Called only after a request has SUCCEEDED — see the module header for why,
 * and for what that costs.
 *
 * ## The two counters degrade INDEPENDENTLY (MONEY-1309, F6)
 *
 * This used to be one try block around both INCRs with a single `return` after
 * them, so a hour-succeeds/day-throws split fell through to the degraded block
 * and charged BOTH local counters. The request was then charged to the hour
 * TWICE (once shared, once local) and to the day ZERO times — and it is the DAY
 * counter, the one gating 24 hours, that systematically under-counted under a
 * flaky node. Exactly backwards: the counter with the longest window and the
 * least chance to self-correct was the one being quietly forgiven.
 *
 * There is no transaction available here — the seam is INCRBY/EXPIRE/GET/SETEX,
 * deliberately narrow — so the fix is not atomicity but INDEPENDENCE: each
 * counter records where it can, and falls back to the local ledger only for
 * itself. A partial failure now costs exactly one counter's accuracy instead of
 * corrupting both.
 *
 * ## The local backlog is FLUSHED on recovery
 *
 * The first successful shared INCR after an outage adds this process's
 * unflushed local spend as well, so the requests authorised while degraded stop
 * being invisible to every sibling. The local counter is then cleared: the
 * shared counter is authoritative again, and the next degrade re-seeds from it.
 */
export async function recordTiingoRequest(): Promise<void> {
  const w = tiingoBudgetWindows();
  const redis = safeRedis();

  // Roll first, so a backlog from a previous window is never flushed into this
  // one. A window boundary DISCARDS the backlog by design — the old window's
  // key has its own name and its own TTL, and back-filling it would charge
  // spend to an hour that is already over.
  if (localHourWindow !== w.hour) {
    localHourWindow = w.hour;
    localHourCount = 0;
  }
  if (localDayWindow !== w.day) {
    localDayWindow = w.day;
    localDayCount = 0;
  }

  let hourShared = false;
  let dayShared = false;
  if (redis) {
    try {
      const total = await incrWindow(
        redis,
        hourKey(w),
        1 + localHourCount,
        HOUR_KEY_TTL_SEC,
      );
      localHourCount = 0;
      noteSharedHour(w, total);
      hourShared = true;
    } catch (err) {
      noteDegraded(w.hour, err);
    }
    try {
      const total = await incrWindow(
        redis,
        dayKey(w),
        1 + localDayCount,
        DAY_KEY_TTL_SEC,
      );
      localDayCount = 0;
      noteSharedDay(w, total);
      dayShared = true;
    } catch (err) {
      noteDegraded(w.hour, err);
    }
  }

  if (hourShared && dayShared) {
    noteRecovered();
    return;
  }
  if (!hourShared) localHourCount++;
  if (!dayShared) localDayCount++;
}

/**
 * Feed the bandwidth meter from a response size.
 *
 * Callers pass the bytes they actually read — `fetchTiingoEod` already computes
 * `Buffer.byteLength(text)` for its own return value, so the number exists and
 * is honest. Returns the rung the month is now on, so a caller can act on the
 * escalation it just caused without a second round trip.
 *
 * Non-positive and non-finite inputs are dropped rather than added. A `NaN`
 * here would poison the counter permanently: `NaN >= 0.7 * cap` is false, so
 * the ladder would read "below the first rung" forever, and the meter would
 * report a number no operator could act on. Same non-finite-poison class the
 * `fixing-bugs` skill names.
 *
 * The returned rung is passed through `noteStage`, so it can never be LOWER
 * than one this process already knows about this month. Before MONEY-1309 it
 * could: a shared month sitting on `alarm` answered `null` on the very next
 * call once Redis went away, because the degraded path grades a local ledger
 * that starts at zero. That fail-OPENED the one limit that cannot be undone by
 * waiting an hour — shedding stopped at exactly the moment the byte budget was
 * being blown, and nothing in the return value revealed it.
 */
export async function recordBytes(n: number): Promise<TiingoBytesStage | null> {
  const w = tiingoBudgetWindows();
  if (!Number.isFinite(n) || n <= 0) {
    return readTiingoBytesStage();
  }
  const bytes = Math.floor(n);
  const redis = safeRedis();

  let total: number;
  let shared: boolean;
  if (redis) {
    try {
      total = await incrWindow(redis, bytesKey(w), bytes, MONTH_KEY_TTL_SEC);
      noteSharedMonthBytes(w, total);
      noteRecovered();
      shared = true;
    } catch (err) {
      noteDegraded(w.hour, err);
      total = localAddBytes(w, bytes);
      shared = false;
    }
  } else {
    noteDegraded(w.hour, new Error("no Redis client"));
    total = localAddBytes(w, bytes);
    shared = false;
  }

  const ceilings = effectiveCeilings(shared, w);
  const stage = noteStage(w, tiingoBytesStage(total, ceilings.bytesPerMonth));

  // Publish the rung so OTHER processes can read it without recomputing.
  // Monotone within the month — see `readTiingoBytesStage`.
  if (redis && shared && stage !== null) {
    try {
      const key = stageKey(w);
      const prev = Number((await redis.get(key)) ?? 0) || 0;
      const next = stageIndex(stage);
      if (next > prev) await redis.setEx(key, String(next), MONTH_KEY_TTL_SEC);
    } catch {
      // The stage key is a convenience cache; the counter is the authority, so
      // failing to publish costs a reader one recomputation and nothing else.
    }
  }
  return stage;
}

// ---------------------------------------------------------------------------
// The STREAMING byte meter (MONEY-1309, leg "realtime")
// ---------------------------------------------------------------------------

/**
 * Bytes accumulated since the last flush. Not window-keyed — `flushStreamBytes`
 * resolves the window at flush time, which is correct to within one flush.
 */
let bufferedStreamBytes = 0;

/**
 * Flush when the buffer reaches this. 1 MiB against COMMERCIAL's 100 GB/month
 * means at most ~102,400 INCRBYs a month from the socket even if it moved the
 * entire monthly allowance by itself — about one every 26 seconds at that
 * (impossible) rate, and far fewer in practice.
 */
export const TIINGO_STREAM_FLUSH_BYTES = 1024 * 1024;

/**
 * Charge STREAMED bytes to the monthly meter. Safe to call PER FRAME.
 *
 * ## Why `recordBytes` is the wrong entry point for a socket
 *
 * `recordBytes` does a Redis INCRBY on every call. That is right for a REST
 * response — one round trip per HTTP request is noise — and wrong for a
 * websocket by three or four orders of magnitude: the equity-intraday feed
 * delivers top-of-book quotes for up to `TIINGO_RT_MAX_SYMBOLS` (default 3000)
 * symbols, so a per-frame INCRBY would put Redis in the hot path of every tick
 * and turn the meter into the bottleneck it exists to measure.
 *
 * So this ACCUMULATES in memory and touches Redis only when the buffer crosses
 * {@link TIINGO_STREAM_FLUSH_BYTES}. Awaiting it per frame is fine — the
 * non-flush path performs no I/O at all and returns the last known rung.
 *
 * ## The tail still has to be flushed
 *
 * Whatever sits below the threshold when the socket closes is lost unless
 * {@link flushStreamBytes} is called. Call it on an interval (30-60s is ample)
 * AND on shutdown; a partial month of unmetered bytes is exactly the
 * under-reporting the wiring guard's header calls worse than no guard at all.
 */
export async function recordStreamBytes(
  n: number,
): Promise<TiingoBytesStage | null> {
  // Same non-finite drop as `recordBytes`, and for the same reason: one NaN
  // added to the buffer poisons every subsequent flush, not just this frame.
  if (Number.isFinite(n) && n > 0) bufferedStreamBytes += Math.floor(n);
  if (bufferedStreamBytes < TIINGO_STREAM_FLUSH_BYTES) {
    // NO I/O on this path. The rung is whatever we last learned, which is what
    // a shedding decision should be made on between flushes anyway.
    return stageFromIndex(
      seenStageMonth === tiingoBudgetWindows().month ? seenStageIndex : 0,
    );
  }
  return flushStreamBytes();
}

/**
 * Push whatever is buffered to the shared meter now. Call on a timer and on
 * shutdown. A no-op (one cheap stage read) when there is nothing buffered.
 */
export async function flushStreamBytes(): Promise<TiingoBytesStage | null> {
  const pending = bufferedStreamBytes;
  // Cleared BEFORE the await, so a concurrent frame arriving mid-flush
  // accumulates into a fresh buffer instead of being double-charged by the
  // next flush. If the INCRBY then fails, `recordBytes` has already put the
  // bytes on the process-local ledger, so they are not silently dropped.
  bufferedStreamBytes = 0;
  if (pending <= 0) return readTiingoBytesStage();
  return recordBytes(pending);
}

function localAddBytes(w: TiingoBudgetWindows, bytes: number): number {
  rollLocalMonth(w);
  localMonthBytes += bytes;
  return localMonthBytes;
}

/**
 * Park a leg after a 429.
 *
 * A 429 SHOULD BE IMPOSSIBLE if this module and the pacer are both working —
 * the pacer spreads below the rate and this guard stops at 80% of the volume —
 * so one is a BUG SIGNAL, not a routine backpressure event, and the log says
 * so in those words. The likeliest causes, in the order worth checking: the
 * shared counter is degraded and N processes are each spending a full share;
 * `TIINGO_PLAN` claims REDISTRIBUTION on an account that is still COMMERCIAL;
 * or a call site was added that bypasses `withTiingoBudget`.
 *
 * Written to Redis AND kept locally. Locally because it must survive a Redis
 * outage in the one process that has evidence of a problem; in Redis because
 * a 429 is an ACCOUNT-wide fact and the sibling processes have no other way to
 * learn it.
 */
export async function breakTiingoLeg(leg: TiingoBudgetLeg): Promise<void> {
  const until = nowFn() + TIINGO_CIRCUIT_BREAK_MS;
  localBreaks.set(leg, until);
  console.error(
    `[tiingo-budget] 429 from Tiingo on leg "${leg}" — THIS SHOULD BE ` +
      `IMPOSSIBLE while the pacer and the shared budget are both working, so ` +
      `treat it as a BUG SIGNAL rather than routine backpressure. The leg is ` +
      `parked for ${Math.round(TIINGO_CIRCUIT_BREAK_MS / 60_000)} minutes. ` +
      `Check, in order: (1) is the shared counter degraded (grep this log for ` +
      `"SHARED counter unavailable") — N processes each spending a full ` +
      `share is the only way to pass the ceiling without passing it; ` +
      `(2) does TIINGO_PLAN claim REDISTRIBUTION on an account that is still ` +
      `COMMERCIAL, which quadruples every ceiling on paper and none in fact; ` +
      `(3) has a new call site been added that does not go through ` +
      `withTiingoBudget.`,
  );
  const redis = safeRedis();
  if (!redis) return;
  try {
    await redis.setEx(
      breakKey(leg),
      String(until),
      Math.ceil(TIINGO_CIRCUIT_BREAK_MS / 1000),
    );
  } catch {
    // The local copy above is the one that matters for THIS process; failing
    // to tell the siblings is a degradation, not a reason to fail the call.
  }
}

// ---------------------------------------------------------------------------
// The wrapper
// ---------------------------------------------------------------------------

/**
 * Check the budget, run the request, charge it if it worked.
 *
 * Three orderings in here are load-bearing and each guards a named defect:
 *
 *  1. The CHECK is before `fn`, outside the try. A refusal is not a transport
 *     failure and must not be swallowed by the catch that arms circuit breaks.
 *  2. The CHARGE is after `fn` RESOLVES. Charging first is MONEY-1255's
 *     counted-before-the-call defect: a leg that fails every request still
 *     reports a full-looking spend, and the failure hides behind its own meter.
 *  3. The 429 arm is decided by {@link isTiingoRateLimitFailure}, NOT by a bare
 *     `instanceof TiingoRateLimitError`. Two independent reasons, and the
 *     module got each of them wrong in a different direction:
 *
 *     TOO NARROW — a bare `instanceof` never fires in production. The feed seam
 *     throws a plain `Error` carrying `429` in its message, and the typed error
 *     is built one frame further out, in the ladder's own catch. Measured: the
 *     break was never armed by a real 429.
 *
 *     TOO WIDE — `TiingoDailyCapError` (tiingo-pacer.ts) and
 *     `TiingoBudgetExhaustedError` (below) are both SUBCLASSES of
 *     `TiingoRateLimitError`, so a bare `instanceof` also catches the pacer's
 *     daily cap and this guard's own refusal, parking the leg for five minutes
 *     and logging "429, this should be impossible" about an event that is
 *     neither. Exactly the rename-defeats-the-fix shape `tiingo-news.ts`
 *     documents from the other direction.
 *
 *     One predicate answers both, so the two cannot drift apart.
 */
export async function withTiingoBudget<T>(
  leg: TiingoBudgetLeg,
  fn: () => Promise<T>,
): Promise<T> {
  const verdict = await checkTiingoBudget(leg);
  if (!verdict.allowed) {
    throw new TiingoBudgetExhaustedError(
      `[tiingo-budget] refusing leg "${leg}": ${verdict.detail}`,
      verdict,
    );
  }

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    // `isTiingoRateLimitFailure` decides this, and it is decided on the STATUS
    // IN THE MESSAGE as well as on the class — because a real Tiingo 429
    // reaches this catch as a PLAIN Error from the feed seam, never as
    // `TiingoRateLimitError`. See that function for the measurement; before
    // MONEY-1309 this arm read `err instanceof TiingoRateLimitError` and was
    // unreachable in production, which made every piece of circuit-break
    // machinery below it dead code.
    //
    // The daily cap and our own refusal are excluded INSIDE that predicate
    // rather than by a guard here, so the same three-way answer is available to
    // the two ladder-less call sites (`tiingo-search.ts`,
    // `us-instrument-names.ts`) that must make the identical distinction.
    if (isTiingoRateLimitFailure(err)) await breakTiingoLeg(leg);
    throw err;
  }

  await recordTiingoRequest();
  return result;
}
