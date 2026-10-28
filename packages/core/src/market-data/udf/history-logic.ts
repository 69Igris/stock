/**
 * `/udf/history` response shaping — the pure half. MONEY-1467 (A2).
 *
 * The rules below are lifted from the header of
 * `apps/web/app/api/market/udf/history/route.ts`, which calls them "easy to get
 * wrong" and is right. Every one of them fails SILENTLY: TradingView renders an
 * empty chart, or an infinite spinner, and never an error.
 *
 *   1. `t[]` is unix SECONDS. Milliseconds put the chart ~55,000 years ahead.
 *   2. `s:"no_data"` MUST carry `nextTime` pointing at an OLDER bar that does
 *      have data, or the widget loops forever asking for older bars and the
 *      user watches a spinner. `no_data` WITHOUT `nextTime` is the bug.
 *   3. `countback`, when present, WINS over `from`: slice the tail N bars.
 *      TradingView sends it on the initial load and expects exactly N bars
 *      ending at `to`, regardless of what `from` says.
 *   4. Unrecoverable errors are `{s:"error", errmsg}` — never a throw, and
 *      never `no_data`. `no_data` means "this symbol has no bars in this
 *      range", which the widget draws as a blank chart with no message,
 *      indistinguishable from a delisted instrument.
 *
 * This module imports nothing, so the reader's decisions are testable without
 * a tile store, a database or a clock.
 */
import type { TileBar } from "../tiles/tile-logic";

export interface UdfHistoryOk {
  s: "ok";
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  /** Per-bar provenance. NOT part of the UDF spec; our chart reads it. */
  sources?: string[];
}

export interface UdfHistoryNoData {
  s: "no_data";
  /** Unix seconds of an older bar that DOES have data. See rule 2. */
  nextTime?: number;
}

export interface UdfHistoryError {
  s: "error";
  errmsg: string;
}

export type UdfHistoryResponse =
  | UdfHistoryOk
  | UdfHistoryNoData
  | UdfHistoryError;

export interface HistoryRequest {
  /** Unix seconds, inclusive. */
  from: number;
  /** Unix seconds, inclusive. */
  to: number;
  /** When present and positive, overrides `from` — see rule 3. */
  countback?: number;
}

/**
 * The calendar years a request can possibly touch.
 *
 * Used to decide which YEAR tiles to `get`. It returns a computed list rather
 * than reading a listing, because `listFiles` fails open to `[]` and a reader
 * that decided "which years exist" from a listing would serve a silently
 * truncated price series on every credentials blip.
 *
 * `countback` widens the window BACKWARDS without bound in principle, so the
 * caller passes an explicit `maxYears` floor rather than letting one request
 * fan out across three decades of objects.
 */
export function yearsForRequest(
  fromYear: number,
  toYear: number,
  maxYears = 30,
): number[] {
  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear)) return [];
  const lo = Math.min(fromYear, toYear);
  const hi = Math.max(fromYear, toYear);
  const years: number[] = [];
  for (let y = hi; y >= lo && years.length < maxYears; y--) years.push(y);
  return years.sort((a, b) => a - b);
}

/**
 * Select the bars a request asks for, from an ascending, de-duplicated series.
 *
 * `countback` wins over `from` when present — rule 3. When it is absent the
 * window is the inclusive `[from, to]` range.
 */
export function sliceBarsForRequest(
  bars: readonly TileBar[],
  req: HistoryRequest,
): TileBar[] {
  // `to` always bounds the RIGHT edge, countback or not: the widget is asking
  // for history as of a point in time, and returning bars after `to` draws
  // candles into the future.
  const upTo = bars.filter((b) => b[0] <= req.to);

  if (typeof req.countback === "number" && req.countback > 0) {
    // The TAIL N, regardless of `from`. Returning fewer than N when the data
    // exists makes the chart load short and then immediately re-request.
    return upTo.slice(Math.max(0, upTo.length - req.countback));
  }
  return upTo.filter((b) => b[0] >= req.from);
}

/** Transpose the tuple bars into UDF's column arrays. */
export function barsToUdfOk(
  bars: readonly TileBar[],
  sources?: readonly string[],
): UdfHistoryOk {
  const out: UdfHistoryOk = {
    s: "ok",
    t: new Array(bars.length),
    o: new Array(bars.length),
    h: new Array(bars.length),
    l: new Array(bars.length),
    c: new Array(bars.length),
    v: new Array(bars.length),
  };
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    out.t[i] = b[0];
    out.o[i] = b[1];
    out.h[i] = b[2];
    out.l[i] = b[3];
    out.c[i] = b[4];
    out.v[i] = b[5];
  }
  if (sources && sources.length === bars.length) out.sources = [...sources];
  return out;
}

/**
 * Build the `no_data` answer, with `nextTime` whenever one can be justified.
 *
 * `earliestAvailable` is the timestamp of the OLDEST bar we hold for this
 * listing. Three cases, and they are three because collapsing them is the bug:
 *
 *   - the request is entirely BEFORE our history  -> no `nextTime`. There is no
 *     older bar to point at; sending one sends the widget further back, which
 *     is the infinite loop by another route.
 *   - the request is AFTER our history (a weekend, a holiday, a gap) ->
 *     `nextTime` = the newest bar we DO have, so the widget jumps to it
 *     instead of stepping back one window at a time.
 *   - we hold nothing at all -> no `nextTime`.
 */
export function noDataResponse(opts: {
  requestedFrom: number;
  earliestAvailable: number | null;
  latestAvailable: number | null;
}): UdfHistoryNoData {
  const { requestedFrom, earliestAvailable, latestAvailable } = opts;
  if (earliestAvailable === null || latestAvailable === null)
    return { s: "no_data" };
  // Asking for a window older than anything we hold: there is genuinely no
  // older bar, so DO NOT invent a nextTime.
  if (requestedFrom < earliestAvailable) return { s: "no_data" };
  return { s: "no_data", nextTime: latestAvailable };
}

/** Never throw at the route. Rule 4. */
export function errorResponse(message: string): UdfHistoryError {
  return { s: "error", errmsg: message };
}

/**
 * Parse and validate the query parameters.
 *
 * Returns an ERROR response rather than throwing, and refuses a nonsense range
 * instead of clamping it: a silently clamped range answers a question nobody
 * asked and the chart looks fine.
 */
export function parseHistoryRequest(params: {
  symbol?: string | null;
  resolution?: string | null;
  from?: string | null;
  to?: string | null;
  countback?: string | null;
}):
  | { ok: true; symbol: string; resolution: string; req: HistoryRequest }
  | { ok: false; error: UdfHistoryError } {
  const symbol = (params.symbol ?? "").trim();
  if (!symbol) return { ok: false, error: errorResponse("symbol is required") };

  const resolution = (params.resolution ?? "1D").trim();

  // ABSENT is not ZERO. `Number(null)` and `Number("")` are both 0, which is
  // finite, passes every check below, and silently widens the window to the
  // epoch — "answering a question nobody asked", which this function's own doc
  // says it refuses to do. Hono's `c.req.query()` returns undefined so today's
  // caller is safe; the `| null` in the signature is there for
  // `URLSearchParams.get()`, which returns null, and that caller would get
  // `from = 0`.
  if (params.from === undefined || params.from === null || params.from === "") {
    return { ok: false, error: errorResponse("from is required") };
  }
  if (params.to === undefined || params.to === null || params.to === "") {
    return { ok: false, error: errorResponse("to is required") };
  }
  const from = Number(params.from);
  const to = Number(params.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return {
      ok: false,
      error: errorResponse("from and to must be unix seconds"),
    };
  }
  // A MILLISECOND timestamp is the failure this guard exists for: it is a
  // finite number, it passes every other check, and it asks for a window
  // ~55,000 years wide that quietly returns nothing.
  if (from > 1e11 || to > 1e11) {
    return {
      ok: false,
      error: errorResponse("from/to look like milliseconds; UDF uses seconds"),
    };
  }
  if (to < from) {
    return { ok: false, error: errorResponse("to must not precede from") };
  }

  const countbackRaw = params.countback;
  let countback: number | undefined;
  if (
    countbackRaw !== undefined &&
    countbackRaw !== null &&
    countbackRaw !== ""
  ) {
    const n = Number(countbackRaw);
    if (!Number.isFinite(n) || n <= 0) {
      return {
        ok: false,
        error: errorResponse("countback must be a positive integer"),
      };
    }
    countback = Math.floor(n);
  }

  return {
    ok: true,
    symbol,
    resolution,
    req: {
      from: Math.floor(from),
      to: Math.floor(to),
      ...(countback ? { countback } : {}),
    },
  };
}
