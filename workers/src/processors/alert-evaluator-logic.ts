/**
 * Alert evaluator — PURE decision logic for the MONEY-1204 data-engine alert
 * kinds (14e.3). No Prisma, no fetch, no timers, no clock reads.
 *
 * `alert-evaluator.ts` is the thin I/O shell: it reads the PRECOMPUTED tables
 * (`StockFlag`, `DailyPrice`, `ShareholdingPattern`, `InsiderEvent`,
 * `MwplDaily`, `InstitutionalFlow`), hands the rows to the functions here, and
 * turns a returned {@link AlertEvent} into a notification. NOTHING in this
 * module or its shell scrapes or fetches — every kind below is answered from
 * rows the data engine already wrote.
 *
 * ## The idempotency contract (read this before changing any evaluator)
 *
 * Every evaluator returns the EVENT'S OWN DATE alongside the verdict, and the
 * shell suppresses the fire when `lastFiredAt >= eventDate` — see
 * {@link shouldSuppressRepeat}. The whole design rests on one rule:
 *
 *   **`eventDate` is the CROSSING DATE — the day the condition became true —
 *   derived from the DATA ALONE, never from the clock and never from "the
 *   latest row we happen to have".**
 *
 * That is what makes a PERSISTING condition silent. A stock that entered ASM on
 * 4-Aug and is still in ASM on 5-Aug produces the same `eventDate` (4-Aug) on
 * both days, so the 5-Aug evaluation is suppressed and the user gets exactly
 * ONE notification. A genuine EXIT on 21-Aug is a new crossing date and fires.
 * Anchoring on "today's row date" instead would re-fire every single day for 17
 * days — the failure mode that trains users to ignore alerts.
 *
 * Per kind the crossing date is:
 *   FLAG_TRANSITION   the date the flag STATE changed (not the date of the
 *                     latest row carrying the flag).
 *   DELIVERY_SPIKE    the spike day itself — a one-day event, so consecutive
 *                     spike days are genuinely distinct events.
 *   PLEDGE_INCREASE   the quarter-END date of the quarter that reported the
 *                     jump — stable for as long as that is the latest filing.
 *   INSIDER_CLUSTER   the date the Nth buy inside the rolling window landed,
 *                     i.e. the day the count first reached the threshold. This
 *                     is monotonically NON-DECREASING as the window slides:
 *                     appending a 4th buy does not move it (silent), but a
 *                     fresh cluster after the old buys age out does (fires).
 *   MWPL_HIGH         the first day of the current contiguous >= threshold run.
 *   FII_FLOW_STREAK   the date the streak REACHED `minDays` (day 5 of a 5-day
 *                     streak). Day 6 does not move it, so a running streak is
 *                     silent; a broken-then-new streak crosses again.
 *
 * ## A cooldown is NOT idempotency — do not delete one thinking the other covers it
 *
 * `Alert.cooldownMinutes` limits the RATE at which an alert may speak (at most
 * once an hour). {@link shouldSuppressRepeat} limits REPETITION OF THE SAME
 * FACT (never twice for one transition, however long it persists). They are
 * orthogonal: a 60-minute cooldown does nothing at all against a daily cron
 * re-announcing a 40-day F&O ban, and event-idempotency does nothing against
 * two different price crossings a minute apart. Both gates exist on purpose.
 *
 * No schema change was made or is needed: `lastFiredAt` and `cooldownMinutes`
 * already exist on `Alert`, and the crossing date is DERIVED, not stored.
 *
 * ## Absence is not zero
 *
 * `DailyPrice.deliveryPct` is NULL on trade-for-trade series (NSE prints `-`;
 * delivery is 100% by construction there) and every `ShareholdingPattern`
 * percentage is nullable. Treating a null as 0 would understate the delivery
 * baseline on exactly the illiquid names where a spike matters — firing on
 * noise — and would turn an undisclosed promoter pledge into a fabricated
 * all-clear. So nulls are SKIPPED, never coalesced, and the delivery mean
 * carries its contributing-day COUNT so a baseline built from two days can be
 * rejected rather than trusted.
 *
 * @see workers/src/processors/alert-evaluator.ts (the I/O shell that calls this)
 * @see workers/__tests__/processors/alert-evaluator-logic.test.ts
 */

// PURE — no Prisma, no fetch, no clock. Two things come from the writer's own
// module, and both are there so this file cannot drift from it:
//   `FLAG_KIND_POLICY`  the STATE/POINT + watched-by-default table, an
//     exhaustive `Record<StockFlagKind, …>` the compiler checks against the
//     writer's union. It USED TO LIVE HERE; MONEY-1205 moved it beside the
//     union because the stock-page badge builder was deciding shape on its own
//     and getting it wrong (it rendered a 2024 BAND_CHANGE as a standing state
//     that had since "ended"). One table, three readers.
//   `formatStockFlagValue`  the shared value decoder, so a notification says
//     "5% band → 10% band" instead of shipping `{"band":"5"} → {"band":"10"}`.
import {
  FLAG_KIND_POLICY,
  formatStockFlagValue,
} from "@usemoney/core/market-data";
import type { StockFlagKind } from "@usemoney/core/market-data";

// ─── Shared vocabulary ───────────────────────────────────────────────────────

/**
 * A fireable event. `eventDate` is the CROSSING DATE (module doc) and is the
 * ONLY thing the idempotency gate looks at — `title` / `message` / `metadata`
 * are presentation.
 */
export interface AlertEvent {
  /** UTC-midnight day on which the condition became true. */
  eventDate: Date;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
}

/**
 * The event-idempotency gate: TRUE when we have already fired at or after the
 * event's own date, i.e. this is the SAME FACT restated.
 *
 * Deliberately `>=`, not `>`: the shell writes `lastFiredAt = new Date()` (a
 * wall-clock instant) while `eventDate` is UTC midnight of the event's day, so
 * a fire on the event day always lands strictly after it. `>` would let the
 * same event re-fire on the next cron tick of the same day.
 *
 * NOT a cooldown. See the module doc.
 */
export function shouldSuppressRepeat(
  lastFiredAt: Date | null | undefined,
  eventDate: Date,
): boolean {
  if (!lastFiredAt) return false;
  return lastFiredAt.getTime() >= eventDate.getTime();
}

/** UTC-midnight epoch ms for a Date — the canonical day identity. */
export function utcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Distinct UTC-day epoch ms, ascending. */
function distinctDaysAsc(dates: readonly Date[]): number[] {
  return Array.from(new Set(dates.map(utcDay))).sort((a, b) => a - b);
}

const MS_PER_DAY = 86_400_000;

/** Read a finite positive number out of an untyped `conditions` blob. */
function numberOption(conditions: unknown, key: string): number | undefined {
  if (!conditions || typeof conditions !== "object") return undefined;
  const v = (conditions as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Read a non-empty string[] out of an untyped `conditions` blob. */
function stringArrayOption(
  conditions: unknown,
  key: string,
): string[] | undefined {
  if (!conditions || typeof conditions !== "object") return undefined;
  const v = (conditions as Record<string, unknown>)[key];
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

// ─── FLAG_TRANSITION ─────────────────────────────────────────────────────────

/**
 * How each `StockFlag.kind` is diffed, and whether it is watched by default.
 *
 * THE TABLE ITSELF NOW LIVES IN `@usemoney/core/market-data/stock-flags`,
 * beside the `StockFlagKind` union it is compiler-checked against
 * (`Record<StockFlagKind, …>`). It started here, and that was the problem:
 * three layers were each deciding a kind's shape independently — this
 * evaluator (correctly), the stock-page badge builder (not at all — it stamped
 * every kind as a standing state, so a 21-May-2024 BAND_CHANGE rendered in a
 * 2026 header and then said "(ended)") and the login briefing. MONEY-1205
 * moved the one table to the one place all three can import.
 *
 * What has NOT changed is the mechanism that makes it worth having: the
 * exhaustive Record is checked by the compiler, so a kind added upstream breaks
 * this build until somebody decides its disposition. That is what caught
 * `SERIES_CHANGE` being absent from the default set — an EQ->BE move never
 * fired an alert and nothing anywhere said so.
 *
 * `shape`:
 *   STATE — `StockFlag` carries one row per day for as long as the flag holds
 *     (a 40-day F&O ban is 40 rows; that run length IS the datum, which is why
 *     the model has no unique). The event is a CHANGE between two observed
 *     days: absent -> present is an ENTRY, present -> absent an EXIT,
 *     present -> different value a CHANGE.
 *   POINT — row PRESENCE is itself the event; NSE publishes these only on the
 *     day the thing happened. Diffing them as states would invent a bogus
 *     "EXIT" the day after every real change.
 *
 * `watchedByDefault: false` means opt-in via `conditions.kinds`, never
 * unavailable.
 */
const ALL_FLAG_KINDS = Object.keys(FLAG_KIND_POLICY) as StockFlagKind[];

/** State kinds — diffed between adjacent observed days. See FLAG_KIND_POLICY. */
export const STATE_FLAG_KINDS: readonly string[] = ALL_FLAG_KINDS.filter(
  (k) => FLAG_KIND_POLICY[k].shape === "STATE",
);

/** Point-event kinds — presence IS the event. See FLAG_KIND_POLICY. */
export const POINT_EVENT_FLAG_KINDS: readonly string[] = ALL_FLAG_KINDS.filter(
  (k) => FLAG_KIND_POLICY[k].shape === "POINT",
);

/** What a FLAG_TRANSITION alert watches unless the alert names its own kinds. */
export const DEFAULT_FLAG_KINDS: readonly string[] = ALL_FLAG_KINDS.filter(
  (k) => FLAG_KIND_POLICY[k].watchedByDefault,
);

/**
 * Kinds a FLAG_TRANSITION alert must ASK for by name.
 *
 * Exported so the exclusion is assertable rather than implied by absence — the
 * failure mode this whole record exists to prevent.
 */
export const OPT_IN_FLAG_KINDS: readonly string[] = ALL_FLAG_KINDS.filter(
  (k) => !FLAG_KIND_POLICY[k].watchedByDefault,
);

export type FlagTransitionDirection = "ENTRY" | "EXIT" | "CHANGE";

/** The `StockFlag` columns this evaluator reads. */
export interface StockFlagRowLite {
  date: Date;
  kind: string;
  /** Compact JSON or a bare code; encoding fixed per kind (see stock-flags.ts). */
  value: string;
}

/** A detected state change, before it is dressed up as a notification. */
export interface FlagTransition {
  kind: string;
  direction: FlagTransitionDirection;
  /** The crossing date — the observed day on which the state differed. */
  date: Date;
  /** Previous value; null when the flag was absent. */
  from: string | null;
  /** New value; null when the flag cleared. */
  to: string | null;
}

/** One market-wide publication: a KIND, and a day it published something. */
export interface FlagObservationLite {
  /** `StockFlag.kind` — the family that published. */
  kind: string;
  /** A day that family published, market-wide. */
  date: Date;
}

export interface FlagTransitionInput {
  symbol: string;
  /** This symbol's flag rows over the lookback window (any order). */
  rows: readonly StockFlagRowLite[];
  /**
   * The `(kind, day)` pairs on which the feed PUBLISHED, market-wide, over the
   * same window — i.e. `StockFlag.groupBy({ by: ["kind", "date"] })`.
   *
   * REQUIRED, and it cannot be derived from `rows`: an EXIT is the absence of a
   * row on a day that KIND *did* publish. With only this symbol's rows, "the
   * flag cleared" and "the file did not arrive" are the same empty set, and the
   * evaluator would announce an exit every time NSE skipped a publication.
   *
   * PER KIND, and that is the whole point of the shape. A single market-wide
   * day list is a FAIL-OPEN: `WK52_HIGH_LOW` and `SHORT_SELLING` publish the
   * entire universe every session, so every trading day counts as "observed"
   * even when the surveillance or F&O-ban file did not land. A stock under
   * continuous ASM whose surveillance file skipped one day then reads as
   * EXIT@day-N, ENTRY@day-N+1 and the user is told it "entered surveillance"
   * having never left; a weekly-cadence family manufactures that pair EVERY
   * WEEK. The sibling screener reader learned this first — see
   * `flagsReferenceDayByKind` in `packages/core/src/screener/market-fields-logic.ts`.
   */
  observations: readonly FlagObservationLite[];
  conditions: unknown;
}

/**
 * Find the most recent flag-state transition for one symbol.
 *
 * Walks EACH KIND's OWN publication days in order and compares this symbol's
 * value for that kind between adjacent days. The FIRST observed day of a kind
 * is never a transition: there is no "before" state for it, and treating it as
 * one would make every alert fire on its first evaluation for a flag that has
 * been set for a year.
 *
 * A kind with NO observations at all yields nothing — the honest answer when a
 * family has not landed for this environment (surveillance-sync is prod-only),
 * and the same "unknown is not clear" rule the screener applies.
 *
 * Exported for testing and for the login-briefing surface.
 */
export function detectFlagTransitions(
  rows: readonly StockFlagRowLite[],
  observations: readonly FlagObservationLite[],
  kinds: readonly string[],
): FlagTransition[] {
  const daysByKind = new Map<string, Date[]>();
  for (const o of observations) {
    const key = o.kind.toUpperCase();
    const list = daysByKind.get(key);
    if (list) list.push(o.date);
    else daysByKind.set(key, [o.date]);
  }

  const wanted = new Set(kinds.map((k) => k.toUpperCase()));
  const out: FlagTransition[] = [];

  for (const kind of wanted) {
    // THIS kind's publication days, never the market-wide union.
    const days = distinctDaysAsc(daysByKind.get(kind) ?? []);
    // Point events need one observed day to bound the window; state diffs need
    // two (the `i - 1` walk below supplies that guard on its own).
    if (days.length === 0) continue;
    const windowStart = days[0] as number;
    const windowEnd = days[days.length - 1] as number;

    const kindRows = rows.filter((r) => r.kind.toUpperCase() === kind);

    if (POINT_EVENT_FLAG_KINDS.includes(kind)) {
      // Presence IS the event. Every row inside the observed window counts.
      for (const r of kindRows) {
        const day = utcDay(r.date);
        if (day < windowStart || day > windowEnd) continue;
        out.push({
          kind,
          direction: "CHANGE",
          date: new Date(day),
          from: null,
          to: r.value,
        });
      }
      continue;
    }

    // State kind: last-write-wins per day (the feed publishes one row per day
    // per kind; a duplicate is a re-parse, not a second state).
    const byDay = new Map<number, string>();
    for (const r of kindRows) byDay.set(utcDay(r.date), r.value);

    for (let i = 1; i < days.length; i++) {
      const prevDay = days[i - 1] as number;
      const curDay = days[i] as number;
      const prev = byDay.get(prevDay) ?? null;
      const cur = byDay.get(curDay) ?? null;
      if (prev === cur) continue;
      out.push({
        kind,
        direction: prev === null ? "ENTRY" : cur === null ? "EXIT" : "CHANGE",
        date: new Date(curDay),
        from: prev,
        to: cur,
      });
    }
  }

  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

const FLAG_KIND_LABEL: Record<string, string> = {
  SURVEILLANCE: "surveillance",
  FO_BAN: "F&O ban",
  PRICE_BAND: "price band",
  BAND_CHANGE: "price band change",
  SERIES_CHANGE: "series change",
  WK52_HIGH_LOW: "52-week extreme",
  SHORT_SELLING: "short selling",
};

/**
 * ASM/GSM entry or exit, F&O ban entry/exit, price-band change.
 *
 * `conditions.kinds?: string[]` narrows the watched flag kinds; the default is
 * {@link DEFAULT_FLAG_KINDS}. Values are reported VERBATIM (`GSM STAGE - I`) —
 * the schema stores surveillance codes raw and decodes at read time, so a
 * better decode table improves old alerts without a re-parse.
 */
export function evaluateFlagTransition(
  input: FlagTransitionInput,
): AlertEvent | null {
  const kinds = stringArrayOption(input.conditions, "kinds") ?? [
    ...DEFAULT_FLAG_KINDS,
  ];
  const transitions = detectFlagTransitions(
    input.rows,
    input.observations,
    kinds,
  );
  if (transitions.length === 0) return null;

  const t = transitions[transitions.length - 1];
  if (!t) return null;
  const label = FLAG_KIND_LABEL[t.kind] ?? t.kind.toLowerCase();
  const verb =
    t.direction === "ENTRY"
      ? "entered"
      : t.direction === "EXIT"
        ? "exited"
        : "changed";
  // DECODED, not raw. `StockFlag.value` is compact JSON for five of the seven
  // kinds, so building the sentence out of `t.from` / `t.to` shipped
  // `{"band":"5"} → {"band":"10"}` into a user's notification (MONEY-1205).
  // `formatStockFlagValue` is the one decoder the web popover, `/v1`, research
  // and this writer share — and it returns SURVEILLANCE byte-identical, so the
  // verbatim-code rule survives the change.
  const say = (v: string | null): string | null =>
    v === null ? null : formatStockFlagValue(t.kind, v);
  const from = say(t.from);
  const to = say(t.to);
  const detail =
    t.direction === "EXIT"
      ? `was ${from ?? "set"}`
      : t.direction === "ENTRY"
        ? (to ?? "")
        : `${from ?? "—"} → ${to ?? "—"}`;

  return {
    eventDate: t.date,
    title: `${input.symbol} ${verb} ${label}`,
    message: detail
      ? `${detail} (${t.date.toISOString().slice(0, 10)})`
      : t.date.toISOString().slice(0, 10),
    metadata: {
      flagKind: t.kind,
      direction: t.direction,
      from: t.from,
      to: t.to,
      date: t.date.toISOString(),
    },
  };
}

// ─── DELIVERY_SPIKE ──────────────────────────────────────────────────────────

/** The `DailyPrice` columns this evaluator reads. */
export interface DeliveryBarLite {
  date: Date;
  /** NULL = NOT REPORTED (trade-for-trade series). Never coalesce to 0. */
  deliveryPct: number | null;
}

/** A delivery baseline plus the evidence for how much of it is real. */
export interface DeliveryBaseline {
  /** Mean over the NON-NULL bars, or null when none contributed. */
  mean: number | null;
  /** How many bars actually contributed — the honesty column. */
  contributingDays: number;
}

/** Default lookback for the delivery baseline (trading days). */
export const DELIVERY_BASELINE_DAYS = 20;

/**
 * Minimum contributing days before a delivery baseline is trusted.
 *
 * A "20-day mean" computed from two reported days is not a baseline, and on a
 * thin counter that is exactly when a single 100%-delivery print would look
 * like a 5x spike.
 */
export const DELIVERY_MIN_CONTRIBUTING_DAYS = 5;

/**
 * Mean delivery percentage over the window, SKIPPING nulls and reporting how
 * many bars contributed.
 *
 * Nulls are skipped, not zeroed: NSE prints `-` on trade-for-trade series where
 * delivery is 100% by construction, so `null -> 0` would drag the baseline
 * down on precisely the illiquid names where a spike is meaningful and would
 * manufacture a spike out of an ordinary day.
 */
export function meanDeliveryPct(
  bars: readonly DeliveryBarLite[],
): DeliveryBaseline {
  const vals = bars
    .map((b) => b.deliveryPct)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (vals.length === 0) return { mean: null, contributingDays: 0 };
  return {
    mean: vals.reduce((a, b) => a + b, 0) / vals.length,
    contributingDays: vals.length,
  };
}

export interface DeliverySpikeInput {
  symbol: string;
  /** The day being judged. A null `deliveryPct` here is "not reported" -> skip. */
  latest: DeliveryBarLite;
  /** The preceding bars (typically 20), EXCLUDING `latest`. */
  baseline: readonly DeliveryBarLite[];
  conditions: unknown;
}

/**
 * Delivery percentage more than `multiplier`x (default 2) the trailing 20-day
 * mean.
 *
 * STRICTLY greater: exactly 2.0x does not fire. The baseline must have at least
 * `minContributingDays` non-null bars and be positive — a zero mean makes the
 * ratio infinite, and Infinity is not a signal.
 *
 * `eventDate` is the spike day: a spike is a single-day event, so two spikes on
 * consecutive days are two events and both are worth saying.
 */
export function evaluateDeliverySpike(
  input: DeliverySpikeInput,
): AlertEvent | null {
  const multiplier = numberOption(input.conditions, "multiplier") ?? 2;
  const minDays =
    numberOption(input.conditions, "minContributingDays") ??
    DELIVERY_MIN_CONTRIBUTING_DAYS;

  const today = input.latest?.deliveryPct;
  if (typeof today !== "number" || !Number.isFinite(today)) return null;

  const { mean, contributingDays } = meanDeliveryPct(input.baseline);
  if (mean === null || mean <= 0) return null;
  if (contributingDays < minDays) return null;

  const ratio = today / mean;
  if (!(ratio > multiplier)) return null;

  const eventDate = new Date(utcDay(input.latest.date));
  return {
    eventDate,
    title: `${input.symbol} delivery spike`,
    message: `Delivery ${today.toFixed(1)}% is ${ratio.toFixed(2)}× the ${contributingDays}-day mean of ${mean.toFixed(1)}%`,
    metadata: {
      deliveryPct: today,
      baselineMean: mean,
      ratio,
      contributingDays,
      windowDays: input.baseline.length,
      multiplier,
      date: eventDate.toISOString(),
    },
  };
}

// ─── PLEDGE_INCREASE ─────────────────────────────────────────────────────────

/** The `ShareholdingPattern` columns this evaluator reads. */
export interface ShareholdingRowLite {
  /** Canonical `YYYY-MM` of the quarter END, or a verbatim label. */
  quarter: string;
  /** NULL = NOT REPORTED. A null is NOT zero. */
  pledgedPct: number | null;
}

/**
 * Last calendar day of a canonical `YYYY-MM` quarter label, as UTC midnight.
 *
 * Returns null for the verbatim-label fallback the parser writes when the
 * source value did not parse as a date. Without a comparable date there is no
 * event identity, and an alert with no identity is the daily-repeat failure
 * this module exists to prevent — so the evaluator SKIPS rather than guesses.
 */
export function quarterEndDate(quarter: string): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(quarter ?? "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  // Day 0 of the NEXT month = last day of this one.
  return new Date(Date.UTC(year, month, 0));
}

export interface PledgeIncreaseInput {
  symbol: string;
  /**
   * The recent quarters, ANY ORDER. Sorted internally by quarter-end date, and
   * rows whose `quarter` is the verbatim-label fallback are dropped: a label
   * that does not parse has no position in the sequence, so "the previous
   * quarter" would be whatever the string sort happened to put there.
   */
  rows: readonly ShareholdingRowLite[];
  conditions: unknown;
}

/**
 * Promoter pledge up more than `minDeltaPp` percentage POINTS (default 2)
 * quarter-on-quarter.
 *
 * STRICTLY greater: exactly +2.00pp does not fire. Percentage POINTS, not
 * percent — 10% -> 12% is +2pp, not +20%.
 *
 * Either side null -> skip. `-` in an NSE table means NOT REPORTED, and
 * `Number("")` is 0; treating the null as 0 would read an undisclosed pledge as
 * a clean book and could invent a +12pp jump out of a disclosure gap.
 */
export function evaluatePledgeIncrease(
  input: PledgeIncreaseInput,
): AlertEvent | null {
  const minDeltaPp = numberOption(input.conditions, "minDeltaPp") ?? 2;

  const dated = input.rows
    .map((r) => ({ row: r, end: quarterEndDate(r.quarter) }))
    .filter((x): x is { row: ShareholdingRowLite; end: Date } => x.end !== null)
    .sort((a, b) => b.end.getTime() - a.end.getTime());
  if (dated.length < 2) return null;

  const head = dated[0];
  const prior = dated[1];
  if (!head || !prior) return null;
  const latest = head.row;
  const previous = prior.row;
  const now = latest.pledgedPct;
  const before = previous.pledgedPct;
  if (typeof now !== "number" || !Number.isFinite(now)) return null;
  if (typeof before !== "number" || !Number.isFinite(before)) return null;

  const deltaPp = now - before;
  if (!(deltaPp > minDeltaPp)) return null;

  const eventDate = head.end;

  return {
    eventDate,
    title: `${input.symbol} promoter pledge up ${deltaPp.toFixed(2)}pp`,
    message: `${before.toFixed(2)}% → ${now.toFixed(2)}% of promoter holding pledged (${latest.quarter})`,
    metadata: {
      quarter: latest.quarter,
      previousQuarter: previous.quarter,
      pledgedPct: now,
      previousPledgedPct: before,
      deltaPp,
      minDeltaPp,
    },
  };
}

// ─── INSIDER_CLUSTER ─────────────────────────────────────────────────────────

/** The `InsiderEvent` columns this evaluator reads. */
export interface InsiderEventLite {
  date: Date;
  /** BUY | SELL | PLEDGE_* — or verbatim source text when unrecognised. */
  action: string;
  /** PIT | SAST | PLEDGE. */
  category: string;
  person?: string;
}

/** Default rolling window for a cluster (calendar days). */
export const INSIDER_CLUSTER_WINDOW_DAYS = 30;
/** Default number of BUY disclosures that constitutes a cluster. */
export const INSIDER_CLUSTER_MIN_EVENTS = 3;

export interface InsiderClusterInput {
  symbol: string;
  /** This symbol's insider events over at least the window (any order). */
  events: readonly InsiderEventLite[];
  conditions: unknown;
}

/**
 * `minEvents` (default 3) or more BUY disclosures inside a rolling
 * `windowDays` (default 30) window. INCLUSIVE at 3 — exactly three buys is a
 * cluster; two is not.
 *
 * The window is anchored on the most recent BUY and is inclusive at both ends:
 * an event exactly `windowDays` old counts, one day older does not.
 *
 * `eventDate` is the date of the Nth buy COUNTING FROM THE START of the window
 * — i.e. the day the count first reached the threshold. That value is
 * monotonically non-decreasing as the window slides, which gives both halves of
 * the behaviour we want: appending a 4th buy leaves it unchanged (silent), but
 * once the early buys age out and three fresh ones land, it moves forward and
 * the alert speaks again. Anchoring on the LATEST buy instead would re-fire on
 * every subsequent disclosure; anchoring on the window's first buy would go
 * permanently silent for a name with rolling insider activity.
 */
export function evaluateInsiderCluster(
  input: InsiderClusterInput,
): AlertEvent | null {
  const windowDays =
    numberOption(input.conditions, "windowDays") ?? INSIDER_CLUSTER_WINDOW_DAYS;
  const minEvents =
    numberOption(input.conditions, "minEvents") ?? INSIDER_CLUSTER_MIN_EVENTS;
  const categories = stringArrayOption(input.conditions, "categories");

  const buys = input.events
    .filter((e) => String(e.action ?? "").toUpperCase() === "BUY")
    .filter(
      (e) =>
        !categories ||
        categories.includes(String(e.category ?? "").toUpperCase()),
    )
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (buys.length === 0) return null;

  const newest = buys[buys.length - 1];
  if (!newest) return null;
  const anchor = utcDay(newest.date);
  const floor = anchor - windowDays * MS_PER_DAY;
  const inWindow = buys.filter((e) => {
    const d = utcDay(e.date);
    return d >= floor && d <= anchor;
  });
  if (inWindow.length < minEvents) return null;

  const crossing = inWindow[minEvents - 1];
  if (!crossing) return null;
  const eventDate = new Date(utcDay(crossing.date));
  const people = Array.from(
    new Set(inWindow.map((e) => (e.person ?? "").trim()).filter(Boolean)),
  );

  return {
    eventDate,
    title: `${input.symbol}: ${inWindow.length} insider buys in ${windowDays} days`,
    message: people.length
      ? `Buyers: ${people.slice(0, 3).join(", ")}${people.length > 3 ? ` +${people.length - 3} more` : ""}`
      : `${inWindow.length} BUY disclosures since ${new Date(floor).toISOString().slice(0, 10)}`,
    metadata: {
      buyCount: inWindow.length,
      windowDays,
      minEvents,
      windowStart: new Date(floor).toISOString(),
      windowEnd: new Date(anchor).toISOString(),
      crossingDate: eventDate.toISOString(),
      people: people.slice(0, 10),
    },
  };
}

// ─── MWPL_HIGH ───────────────────────────────────────────────────────────────

/**
 * The `MwplDaily` columns this evaluator reads.
 *
 * ## THIS EVALUATOR IS DORMANT AND THAT IS CORRECT, NOT A BUG
 *
 * `MwplDaily.utilisationPct` is NULL on EVERY row and will stay null until a
 * source for the DENOMINATOR exists. Per the model's own doc: only the
 * numerator is obtainable (`nse-combine-oi-deleq` publishes notional and
 * futures-equivalent OI and nothing else); the market-wide position limit lives
 * in `mwpl_cli`, whose registry path 404s and which has ZERO archived objects.
 * The neighbouring `oi_cli_limit` carries a PER-CLIENT limit — a different
 * quantity that would yield a plausible, WRONG utilisation, and this alert
 * would then fire on it.
 *
 * So the evaluator is gated on `utilisationPct != null` and simply returns null
 * today. DO NOT substitute another denominator to make it fire. When a real
 * MWPL feed lands, this starts working with no code change.
 */
export interface MwplRowLite {
  date: Date;
  /** NULL until an MWPL denominator source exists — see the doc above. */
  utilisationPct: number | null;
}

/** Default utilisation level that counts as "high" (percent). */
export const MWPL_HIGH_THRESHOLD_PCT = 80;

export interface MwplHighInput {
  symbol: string;
  /** Recent rows, NEWEST FIRST. */
  rows: readonly MwplRowLite[];
  conditions: unknown;
}

/**
 * Market-wide position limit utilisation at or above `threshold` (default 80%).
 *
 * INCLUSIVE at 80 — exactly 80.0% fires, 79.99% does not.
 *
 * `eventDate` is the FIRST day of the current contiguous >= threshold run, so a
 * name that sits at 85% for a week says so once rather than seven times. A
 * lone latest row (no history) is its own run start.
 */
export function evaluateMwplHigh(input: MwplHighInput): AlertEvent | null {
  const threshold =
    numberOption(input.conditions, "threshold") ?? MWPL_HIGH_THRESHOLD_PCT;

  const rows = [...input.rows].sort(
    (a, b) => b.date.getTime() - a.date.getTime(),
  );
  const latest = rows[0];
  if (!latest) return null;
  const util = latest.utilisationPct;
  // DORMANT GATE: null utilisation is "not known", never "not high".
  if (typeof util !== "number" || !Number.isFinite(util)) return null;
  if (!(util >= threshold)) return null;

  // Walk back while the run holds. A null breaks it: "not known" cannot extend
  // a run of "known high".
  let runStart = latest;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) break;
    const v = row.utilisationPct;
    if (typeof v !== "number" || !Number.isFinite(v) || v < threshold) break;
    runStart = row;
  }

  const eventDate = new Date(utcDay(runStart.date));
  return {
    eventDate,
    title: `${input.symbol} MWPL utilisation ${util.toFixed(1)}%`,
    message: `Open interest is at ${util.toFixed(1)}% of the market-wide position limit (>= ${threshold}% since ${eventDate.toISOString().slice(0, 10)})`,
    metadata: {
      utilisationPct: util,
      threshold,
      runStart: eventDate.toISOString(),
      date: new Date(utcDay(latest.date)).toISOString(),
    },
  };
}

// ─── FII_FLOW_STREAK ─────────────────────────────────────────────────────────

/** The `InstitutionalFlow` columns this evaluator reads. */
export interface FlowRowLite {
  date: Date;
  /** Net (buy − sell) in ₹ CRORE — NSE's own unit, stored unconverted. */
  netValue: number;
}

/** Default streak length that counts as a signal (trading days). */
export const FLOW_STREAK_MIN_DAYS = 5;

/**
 * Largest calendar gap (days) two adjacent readings may span and still count as
 * consecutive.
 *
 * A BACKSTOP, not the primary mechanism — `tradingDates` is. Fri -> Mon is 3
 * days and Thu -> Tue across a Friday holiday is 5, both legitimate; a missing
 * week is 7 and is a capture gap, and `InstitutionalFlow` is UNBACKFILLABLE
 * (the endpoint serves only the current reading), so a day we did not capture
 * is a day nobody can ever fill in.
 */
export const FLOW_STREAK_MAX_GAP_DAYS = 5;

export interface FiiFlowStreakInput {
  /** "FII" or "DII" — whose flow this alert watches. */
  category: string;
  /** That category's rows over the window (any order). */
  rows: readonly FlowRowLite[];
  /**
   * The days on which the flow table holds ANY row over the same window
   * (distinct `InstitutionalFlow.date` across categories/segments).
   *
   * REQUIRED. Consecutiveness is adjacency in THIS sequence, not in the
   * category's own rows: if the table has a row for 12-Aug (DII was written)
   * but no FII row, a "5-day FII buying streak" spanning 11 -> 13 Aug is NOT a
   * streak — a gap is not continuity. Sorting the category's own rows and
   * calling neighbours consecutive is the mistake this parameter exists to
   * prevent.
   */
  tradingDates: readonly Date[];
  conditions: unknown;
}

export type FlowDirection = "BUY" | "SELL";

/** A maximal run of same-signed net flow over consecutive observed days. */
export interface FlowStreak {
  direction: FlowDirection;
  days: Date[];
}

/**
 * Split a category's flow rows into maximal same-sign streaks over the observed
 * trading-day sequence.
 *
 * A day with `netValue === 0` is neither buying nor selling: it ENDS the current
 * streak and starts nothing. A day missing from the category's rows (but present
 * in `tradingDates`) ends the streak. A calendar jump greater than
 * `maxGapDays` ends the streak even when the two days are adjacent in
 * `tradingDates`.
 *
 * Exported for testing.
 */
export function detectFlowStreaks(
  rows: readonly FlowRowLite[],
  tradingDates: readonly Date[],
  maxGapDays: number = FLOW_STREAK_MAX_GAP_DAYS,
): FlowStreak[] {
  const days = distinctDaysAsc(tradingDates);
  const byDay = new Map<number, number>();
  for (const r of rows) {
    if (typeof r.netValue !== "number" || !Number.isFinite(r.netValue))
      continue;
    byDay.set(utcDay(r.date), r.netValue);
  }

  const streaks: FlowStreak[] = [];
  let current: FlowStreak | null = null;
  let previousDay: number | null = null;

  for (const day of days) {
    const net = byDay.get(day);
    const direction: FlowDirection | null =
      net === undefined || net === 0 ? null : net > 0 ? "BUY" : "SELL";

    const contiguous =
      previousDay !== null && day - previousDay <= maxGapDays * MS_PER_DAY;

    if (
      direction === null ||
      current === null ||
      current.direction !== direction ||
      !contiguous
    ) {
      if (direction === null) {
        current = null;
        previousDay = null;
        continue;
      }
      current = { direction, days: [new Date(day)] };
      streaks.push(current);
    } else {
      current.days.push(new Date(day));
    }
    previousDay = day;
  }

  return streaks;
}

/**
 * `minDays` (default 5) or more CONSECUTIVE net-buy or net-sell days for one
 * institutional category. INCLUSIVE at 5 — exactly five days fires, four does
 * not.
 *
 * `eventDate` is the day the streak REACHED `minDays` (day 5 of a 5-day
 * streak), not the latest day: day 6 of the same streak does not move it, so a
 * running streak stays silent, while a broken-then-restarted streak crosses
 * again and speaks.
 *
 * Values are ₹ CRORE and are NOT rescaled — that is NSE's own unit and the unit
 * the column is stored in.
 */
export function evaluateFiiFlowStreak(
  input: FiiFlowStreakInput,
): AlertEvent | null {
  const minDays =
    numberOption(input.conditions, "minDays") ?? FLOW_STREAK_MIN_DAYS;
  const maxGapDays =
    numberOption(input.conditions, "maxGapDays") ?? FLOW_STREAK_MAX_GAP_DAYS;
  const wanted = stringArrayOption(input.conditions, "directions");

  const streaks = detectFlowStreaks(input.rows, input.tradingDates, maxGapDays);
  if (streaks.length === 0) return null;

  const last = streaks[streaks.length - 1];
  if (!last) return null;
  if (last.days.length < minDays) return null;
  if (wanted && !wanted.includes(last.direction)) return null;

  // The streak must be CURRENT — its last day is the latest day the table holds
  // anything. A streak that ended a month ago is history, not a signal, and
  // announcing it on an alert's first evaluation would be stale news. (A zero
  // or missing day already ends a streak in detectFlowStreaks, so "ends before
  // the latest observed day" is exactly "broken".)
  const observed = distinctDaysAsc(input.tradingDates);
  const latestObserved = observed[observed.length - 1];
  const streakStart = last.days[0];
  const streakEnd = last.days[last.days.length - 1];
  const eventDate = last.days[minDays - 1];
  if (!streakStart || !streakEnd || !eventDate) return null;
  if (utcDay(streakEnd) !== latestObserved) return null;

  const byDay = new Map<number, number>();
  for (const r of input.rows) byDay.set(utcDay(r.date), r.netValue);
  const total = last.days.reduce(
    (sum, d) => sum + (byDay.get(utcDay(d)) ?? 0),
    0,
  );

  const verb = last.direction === "BUY" ? "buying" : "selling";
  const crore = Math.abs(total).toLocaleString("en-IN", {
    maximumFractionDigits: 0,
  });

  return {
    eventDate,
    title: `${input.category} net ${verb} ${last.days.length} days running`,
    message: `₹${crore} Cr net ${last.direction === "BUY" ? "bought" : "sold"} between ${streakStart.toISOString().slice(0, 10)} and ${streakEnd.toISOString().slice(0, 10)}`,
    metadata: {
      category: input.category,
      direction: last.direction,
      streakDays: last.days.length,
      minDays,
      netValueCr: total,
      streakStart: streakStart.toISOString(),
      streakEnd: streakEnd.toISOString(),
      crossingDate: eventDate.toISOString(),
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* MONEY-1238 — the RUN VERDICT, and the delivery-channel gap                 */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * ## The defect this closes
 *
 * `processAlertEvaluator` returned `void`, had NO failure counter anywhere, and
 * reached the database through EIGHT `.catch(() => null)` / `.catch(() => [])`
 * swallows. Every one of them makes a DB error identical to an empty table:
 *
 *     resolveInstrumentId       .catch(() => null)
 *     latestQuote.findUnique    .catch(() => null)
 *     dailyPrice.findMany       .catch(() => [])
 *     upcomingEvent (earnings)  .catch(() => null)
 *     newsArticle.findMany      .catch(() => [])
 *     upcomingEvent (corp act)  .catch(() => null)
 *     stockFlag.groupBy         .catch(() => [])
 *     institutionalFlow.groupBy .catch(() => [])
 *
 * The last two are market-WIDE and cached per run, so `stockFlag.groupBy`
 * breaking silently disables every FLAG_TRANSITION alert for every user at
 * once. This job runs 1,440 times a day (every minute in market hours, every
 * five outside), and each of those 1,440 runs logs `fired 0` and returns 200.
 * There is no number anywhere that would move.
 *
 * The counters now exist and reach this verdict, which reaches the route's HTTP
 * status. The rule the repo already has for caches applies to reads too: make
 * "couldn't determine" a distinct value, and key on determinacy rather than on
 * the value.
 *
 * ## Retriable vs deterministic — following routes/xbrl-sync.ts
 *
 * A rejected Prisma read is TRANSPORT: 500, so Pub/Sub redelivers. Safe,
 * because a redelivery re-reads `lastFiredAt` and the cooldown suppresses
 * everything that already fired, and cheap, because the alerts table is small
 * and nothing here leaves the process except Prisma.
 *
 * An alert whose own evaluation THREW is DETERMINISTIC — a malformed
 * `conditions` JSON throws identically on every attempt, and the loop already
 * steps over it. That gets a 200 and a loud line, not five redeliveries of a
 * cron that fires again in sixty seconds anyway.
 */
export interface AlertRunTotals {
  /** Alert rows read from the table. */
  evaluated: number;
  /** Alerts that fired AND whose notification row was created. */
  fired: number;
  /** Alerts suppressed by the event-date gate. */
  suppressedAsRepeat: number;
  /** Prisma reads that REJECTED and were swallowed to a fallback. */
  dataErrors: number;
  /**
   * Of those, the ones that disable an alert kind PLATFORM-WIDE — MONEY-1236.
   *
   * The two `groupBy` reads (`stockFlag`, `institutionalFlow`) serve EVERY
   * alert of their kind for EVERY user. The other six `readOr` sites are
   * per-symbol and are isolated by design.
   */
  marketWideDataErrors: number;
  /** Notification writes that failed. The user was never told. */
  notifyFailures: number;
  /** Alerts whose own evaluation threw. */
  alertErrors: number;
}

export interface AlertRunVerdict {
  ok: boolean;
  /** True when a redelivery could plausibly succeed. */
  retriable: boolean;
  /** Null only for a clean run. */
  reason: string | null;
}

/** Judge one alert-evaluator run. Transport first — it is the recoverable one. */
export function judgeAlertRun(t: AlertRunTotals): AlertRunVerdict {
  // ONLY A MARKET-WIDE READ IS WORTH A REDELIVERY — MONEY-1236.
  //
  // `retriable: true` on ANY `dataErrors` meant one transient per-symbol read —
  // a single `instrumentMapping` or `latestQuote` lookup for one user's alert —
  // NACKed the whole run. This cron fires EVERY 60 SECONDS, so the redelivery
  // lands concurrently with the next scheduled tick, and the 60-minute default
  // `cooldownMinutes` is the only thing masking duplicate notifications;
  // `isWithinCooldown` returns false for `cooldownMinutes: 0`, so a user who
  // configured no cooldown is re-notified on every redelivery.
  //
  // The two scopes need opposite answers. A per-symbol read failure affects the
  // alerts on ONE symbol and is isolated by design — reported, never retried. A
  // market-wide `groupBy` failure disables an entire alert kind for every user,
  // and that is worth asking for the run again.
  if (t.marketWideDataErrors > 0) {
    return {
      ok: false,
      retriable: true,
      reason:
        `${t.marketWideDataErrors} MARKET-WIDE database read(s) failed and were ` +
        `swallowed to an empty result — an entire alert kind evaluated against ` +
        `data that was not absent, only unreadable, for every user`,
    };
  }
  if (t.dataErrors > 0) {
    return {
      ok: false,
      retriable: false,
      reason:
        `${t.dataErrors} per-symbol database read(s) failed and were swallowed ` +
        `to an empty result — those alerts evaluated against data that was not ` +
        `absent, only unreadable. Not retried: a 60-second cron must not ` +
        `redeliver a whole run for one symbol's read`,
    };
  }
  if (t.notifyFailures > 0) {
    return {
      ok: false,
      retriable: true,
      reason:
        `${t.notifyFailures} notification(s) could not be written — the ` +
        `condition fired and the user was not told`,
    };
  }
  if (t.alertErrors > 0) {
    return {
      ok: false,
      retriable: false,
      reason:
        `${t.alertErrors} alert(s) threw during evaluation — a malformed ` +
        `conditions payload throws the same way on every attempt, so this is ` +
        `acked rather than redelivered`,
    };
  }
  return { ok: true, retriable: false, reason: null };
}

/**
 * The channels this worker can actually deliver on.
 *
 * ONE, and naming it is the point. `Alert.notifyChannels` is
 * `"IN_APP" | "EMAIL" | "PUSH"`, both creation surfaces tick IN_APP **and**
 * EMAIL by default (`NewAlertDrawer.tsx:772` seeds `["app","email"]`;
 * `AlertConfigModal.tsx:103` seeds `new Set(["IN_APP","EMAIL"])`), and the
 * evaluator writes a `Notification` row and nothing else. So EMAIL and PUSH are
 * stored, shown in the UI as selected, and delivered by nobody.
 *
 * The worker declared `notifyChannels: string[]` on two of its alert types and
 * never read it — a dead field named for a delivery channel, which reads as
 * coverage. MONEY-1238's instruction was to wire it or delete it. Deleting it
 * would hide a real product gap; wiring EMAIL needs `@usemoney/email`, a
 * template and a sender identity, which is a feature and not a bug fix. So it
 * is wired to the one decider reachable from here: the run's reported outcome.
 * The gap becomes a NUMBER instead of an assumption.
 */
export const DELIVERABLE_CHANNELS: readonly string[] = ["IN_APP"];

/**
 * Normalise the stored list.
 *
 * `sanitizeChannels` (packages/services/src/alerts-logic.ts) already defaults an
 * empty or all-invalid list to `["IN_APP"]`, but rows predating that guard — or
 * written straight to Mongo — can still be empty. Defaulting the same way here
 * keeps the two from disagreeing about what an empty array means.
 */
function wantedChannels(notifyChannels: readonly string[]): readonly string[] {
  return notifyChannels.length > 0 ? notifyChannels : ["IN_APP"];
}

/** Channels the alert asked for that nothing in this worker delivers. */
export function undeliverableChannels(
  notifyChannels: readonly string[],
): string[] {
  return wantedChannels(notifyChannels).filter(
    (c) => !DELIVERABLE_CHANNELS.includes(c),
  );
}

/**
 * True when firing this alert notifies the user through NO channel they chose.
 *
 * The expensive case: a user who unticks In-app and keeps only Email gets an
 * in-app row they never asked for, no email, and an alert whose `lastFiredAt`
 * says it was delivered.
 */
export function isSilentDelivery(notifyChannels: readonly string[]): boolean {
  return !wantedChannels(notifyChannels).some((c) =>
    DELIVERABLE_CHANNELS.includes(c),
  );
}
