/**
 * `tiingo-realtime` — the always-on socket holder. Its own Cloud Run SERVICE.
 *
 * ## Why a separate service and not a second entry inside `stockbook-workers`
 *
 * Cloud Run throttles a container's CPU to near-zero BETWEEN REQUESTS unless
 * `run.googleapis.com/cpu-throttling: "false"` is set. `stockbook-workers` is
 * request-driven and does not set it, so a websocket living inside that service
 * would be starved between Pub/Sub pushes: heartbeats missed, the watchdog
 * firing, the reconnect loop thrashing — and every reconnect buys a full REST
 * snapshot against a metered API. The workers service is also `maxScale: 20`,
 * so nineteen instances would run a leader-candidate loop to lose it.
 *
 * So: `minScale = maxScale = 1`, CPU always allocated, on the SAME image (a
 * `command` override, not a second Dockerfile — a second image is a second
 * thing to keep in step, and this shares every dependency).
 *
 * THE LEADER LOCK IS STILL REQUIRED even at maxScale 1. Cloud Run overlaps
 * revisions during a deploy: the new instance starts before the old one drains,
 * so there is a window with two processes and one socket budget. Without the
 * lock that window double-writes bars.
 *
 * ## Shape
 *
 * A tiny HTTP server for `/health` (Cloud Run needs a listening port, and the
 * probe is how a stalled socket becomes visible), plus THREE timers:
 *
 *   leader     every LEADER_RENEW_MS — acquire or renew, act on the verdict
 *   subscribe  every SUBSCRIPTION_REFRESH_MS — re-plan and apply deltas
 *   flush      every FLUSH_MS — close due minute bars and write them
 *
 * That list used to be aspirational: `start()` registered the first and third,
 * `SUBSCRIPTION_REFRESH_MS` was exported and never passed to a `setInterval`,
 * and because the Tiingo auth token rides inside the SUBSCRIBE frame rather
 * than the handshake, a holder that never subscribes never even authenticates.
 * The service connected, received nothing, and reported itself healthy. Both
 * halves — the timer and the write below it — are real now.
 *
 * Everything each timer decides is PURE and lives elsewhere. This file is wiring
 * and I/O only, which is why it composes so many small tested units.
 */

// ── BOOT INSTALLS — the same three `workers/src/index.ts` performs, and for the
// same reasons. This is a SECOND entrypoint (`dist/tiingo-realtime.js`), so it
// inherits none of them; the log-boundary test pinned `index.ts` BY NAME, so
// adding an entrypoint bypassed that guard without failing it.
//
// Redaction FIRST, before anything can log: this file makes ~20 console calls,
// several of which stringify an error — a `ws` failure and a GCS upload
// rejection both carry request context.
import { installLogRedaction } from "../log-boundary";
installLogRedaction();

// Tracer before application code, so dd-trace patches HTTP/Redis/Prisma at load.
import {
  RT_GAUGE_METRICS,
  computeRtMetricDeltas,
  emptyRtSnapshot,
  healthReasonTag,
  type RtCounterSnapshot,
} from "./rt-metrics-logic";
import { initTracer } from "@usemoney/datadog";
import { initLogger, flushLogs } from "@usemoney/logger";
import { DD_SERVICES } from "@usemoney/datadog/constants";
import {
  flushMetrics,
  gauge,
  incrementCounter,
} from "@usemoney/datadog/metrics";
// MONEY-1357 — its OWN name. The image bakes DD_SERVICE=stockbook-workers and
// DD_TRACE_ENABLED=true, and this process filed under that name: a 24x5 socket
// holder and a request-driven worker pool blended into one service map entry,
// one error rate, one latency curve.
//
// `profiling` and `runtimeMetrics` OFF, and ONLY here — every other service
// keeps them, so both default to true in `TracerOptions`. Tracing was already
// enabled by the baked env, so before the sidecar the profiler collected and
// then failed fast against a refused port; the sidecar is what makes the
// uploads SUCCEED — ~1,440 pprof serialise-and-upload cycles a day, plus a GC
// PerformanceObserver in a process that allocates per frame, on the one event
// loop `cpu-throttling: "false"` exists to keep free.
//
// The `/health` spans STAY. They are this service's only inbound route, so
// blocklisting the path would take its APM hit count to zero — and
// `monitor-apm-error-rate.json` (applied for tiingo-realtime) and the us-market
// dashboard's "hits vs errors" widget are built on exactly that series. Two
// dead instruments to save ~2,880 spans a day is moving the defect, not fixing
// it. The profiler is the cost worth removing; these are signal.
initTracer({
  service: DD_SERVICES.REALTIME,
  profiling: false,
  runtimeMetrics: false,
});

// MONEY-1375 — attach the Datadog log stream. `initLogger()` had exactly ONE
// caller in the repo (`workers/src/index.ts`), so this always-on service logged
// to stdout and nowhere else: Cloud Logging looked perfect while Datadog had
// never received a line from it. Top-level, before anything logs, matching the
// workers service.
await initLogger();

// Same reason as the workers service: the stream has to be FED. This process
// makes 9 `console.*` calls and zero `getLogger()` calls, so attaching alone
// shipped nothing from it.
import { forwardConsoleToDatadog } from "../lib/job-telemetry";
forwardConsoleToDatadog();

// IPv4 first. Cloud Run's resolver tries IPv6 and times out against APIs that
// do not route it — and this process is one long-lived TLS connection to
// api.tiingo.com, so a resolver stall is the whole service, not one request.
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { createServer } from "node:http";
import {
  decideLeadership,
  mayWrite,
  LEADER_RENEW_MS,
  type LeaderView,
} from "@usemoney/core/market-data/tiingo/tiingo-rt-leader-logic";
import { MinuteBarAggregator } from "@usemoney/core/market-data/tiingo/tiingo-minute-bars";
import {
  toQuotePayload,
  toAggregatorTick,
} from "@usemoney/core/market-data/tiingo/tiingo-rt-sink-logic";
import { usMarketSession } from "@usemoney/core/market-data/us-market-hours";
import {
  rtQuoteKey,
  RT_QUOTE_CHANNEL,
} from "@usemoney/core/market-data/tiingo/tiingo-rt-keys";
import { RT_QUOTE_TTL_SECONDS } from "@usemoney/core/market-data/tiingo/tiingo-rt-read-logic";
import { DEFAULT_MAX_SYMBOLS } from "@usemoney/core/market-data/tiingo/tiingo-rt-subscription-logic";
import {
  recordStreamBytes,
  flushStreamBytes,
} from "@usemoney/core/market-data/tiingo/tiingo-budget";
import { getRedisClient } from "@usemoney/core/cache";
import { TiingoSocket, HEARTBEAT_TIMEOUT_MS } from "./tiingo-socket";
import { acquireOrRenew, releaseLeadership, newToken } from "./leader-lock";
import {
  refreshSubscriptions,
  emptySubscriptionCounters,
  BASE_REFRESH_MS,
} from "./subscription";
import { RtCandleSink } from "./candle-sink";
import { decideHealth, type HealthVerdict } from "./health-logic";
import { TickArchive, archiveEnabled } from "./tick-archive";

const PORT = Number(process.env.PORT ?? 8082);
const SUBSCRIPTION_REFRESH_MS = 30_000;
/**
 * Bars are closed on this cadence, NOT on the minute boundary.
 *
 * A timer aimed at :00 drifts and can miss a minute entirely; a short poll that
 * asks "what is due?" cannot. `closeDue` is idempotent and cheap, so polling
 * costs nothing and removes a whole class of scheduling bug.
 */
const FLUSH_MS = 5_000;

/**
 * The quote key's TTL, IMPORTED rather than derived here.
 *
 * These were two independent numbers: the reader treated a quote as fresh for
 * 15 minutes while this writer set `EX 90`. The tighter one always wins, so the
 * binding threshold was 90 seconds and the 15-minute window — chosen with an
 * explicit argument about not flapping on thin names — could effectively never
 * be the decider. A name last quoted 91 seconds ago had no key at all.
 *
 * I first fixed this by deriving the seconds from `RT_QUOTE_MAX_AGE_MS` HERE,
 * which is a third place the relationship would have to stay true. The reader
 * now exports both spellings of the one decision, so this file imports the
 * answer instead of recomputing it, and a test over there pins
 * `TTL * 1000 > MAX_AGE` — the reader's explicit freshness check stays the
 * arbiter rather than whichever of the two clocks runs ahead.
 */
const QUOTE_TTL_SECONDS = RT_QUOTE_TTL_SECONDS;

/**
 * The overnight ("boats") feed, which we are NOT entitled to.
 *
 * `wss://api.tiingo.com/boats` answers 403 "Not authorized for service: boats"
 * — a real entitlement gap needing a Tiingo add-on, not a configuration
 * mistake. Overnight is 20:00-04:00 ET only; pre- and post-market both ride the
 * main feed, so nothing user-visible depends on it today.
 *
 * The flag shipped in both Cloud Build specs and was read by NOTHING, which
 * makes it decorative: flipping it would have changed exactly zero behaviour
 * and looked like it worked. Reading it here converts that into an immediate,
 * named failure at boot. That is the whole value — a 403 reconnect loop against
 * a metered vendor is indistinguishable from a quiet market in the logs, and
 * this service's entire failure history is things that looked quiet.
 */
function assertBoatsNotRequested(): void {
  if (process.env.TIINGO_RT_BOATS === "on") {
    throw new Error(
      "TIINGO_RT_BOATS=on, but wss://api.tiingo.com/boats returns 403 " +
        '"Not authorized for service: boats" on this account. The overnight ' +
        "feed needs a Tiingo add-on; there is no code path that can work around " +
        'it. Set it back to "off" and buy the entitlement first.',
    );
  }
}

/** Cap on simultaneously subscribed symbols. Env-overridable, and READ. */
function maxSymbols(): number {
  const raw = Number(process.env.TIINGO_RT_MAX_SYMBOLS);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_MAX_SYMBOLS;
}

const token = newToken();
let view: LeaderView = { state: "follower", lastConfirmedMs: null, token };
const aggregator = new MinuteBarAggregator();
const candleSink = new RtCandleSink();
const tickArchive = new TickArchive();
const subCounters = emptySubscriptionCounters();
let socket: TiingoSocket | null = null;
let lastBaseRebuildMs = 0;

/**
 * In-flight guards. Every timer body is async and all three can outlast their
 * interval — a slow Redis makes `leaderTick` take longer than LEADER_RENEW_MS,
 * and overlapping runs then interleave reads and writes of `view`, which is how
 * a process convinces itself it is both leader and follower.
 */
let leaderBusy = false;
let subscribeBusy = false;
let flushBusy = false;

const counters = {
  quotesWritten: 0,
  quoteWriteFailures: 0,
  framesDropped: 0,
  barsClosed: 0,
  leaderTransitions: 0,
  bytesRecorded: 0,
};

function apiKey(): string {
  const k = process.env.TIINGO_API_KEY;
  if (!k) {
    // THROW rather than connect unauthenticated: the client does the same, and
    // a missing secret must be a loud failure rather than a service that holds
    // a socket which silently receives nothing.
    throw new Error("TIINGO_API_KEY is required for the realtime holder");
  }
  return k;
}

/** Write one quote. Never throws — a Redis blip must not kill the socket. */
async function writeQuote(symbol: string, payload: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.set(rtQuoteKey(symbol), payload, "EX", QUOTE_TTL_SECONDS);
    await redis.publish(RT_QUOTE_CHANNEL, payload);
    counters.quotesWritten++;
  } catch {
    counters.quoteWriteFailures++;
  }
}

function openSocket(): void {
  if (socket !== null) return;
  socket = new TiingoSocket(apiKey(), {
    onFrame: (frame) => {
      if (frame.kind !== "quote") return;
      // THE WHOLE HANDLER IS GUARDED, and this is not defensive noise.
      // `usMarketSession` throws by design on an Invalid Date, and this runs
      // inside the `ws.on("message")` handler, where an escaping throw is an
      // unhandled exception that takes the PROCESS down — one malformed
      // timestamp ending the feed for every subscriber. The decoder promises
      // never to emit one, and that promise rests on a single `Number.isFinite`
      // check; this is the second layer, so the promise being broken costs one
      // frame instead of the service.
      try {
        const session = usMarketSession(frame.quote.ts);
        const payload = toQuotePayload(frame.quote, session);
        void writeQuote(payload.symbol, JSON.stringify(payload));
        aggregator.ingest(toAggregatorTick(frame.quote));
      } catch (err) {
        counters.framesDropped++;
        console.error(`[tiingo-rt] dropped a frame: ${String(err)}`);
      }
    },
    // The raw bytes, buffered for the 30-day re-derivation window. Kept
    // OUTSIDE the decode path deliberately — see `SocketCallbacks.onRaw`.
    onRaw: (raw, receivedAtMs) => tickArchive.add(raw, receivedAtMs),
    onConnected: (n) => console.log(`[tiingo-rt] connected (${n})`),
    onDisconnected: (why) => console.warn(`[tiingo-rt] disconnected: ${why}`),
  });
  socket.connect();
}

function closeSocket(why: string): void {
  if (socket === null) return;
  console.warn(`[tiingo-rt] closing socket: ${why}`);
  // Drain FIRST. A stepping-down leader must not take its open minute with it —
  // the bars are already paid for and the successor cannot reconstruct them.
  const remaining = aggregator.drain();
  counters.barsClosed += remaining.length;
  if (remaining.length > 0 && mayWrite(view, Date.now())) {
    void candleSink.write(remaining);
  }
  socket.close();
  socket = null;
}

async function leaderTick(): Promise<void> {
  if (leaderBusy) return;
  leaderBusy = true;
  try {
    const outcome = await acquireOrRenew(token);
    const action = decideLeadership({ view, outcome, nowMs: Date.now() });
    switch (action.do) {
      case "become-leader":
        counters.leaderTransitions++;
        view = { ...view, state: "leader", lastConfirmedMs: Date.now() };
        // Start the health clock HERE. Left at 0 a brand-new leader is
        // instantly "unhealthy for 56 years" and gets restarted before its
        // socket has finished its first handshake.
        lastSocketHealthyMs = Date.now();
        console.log("[tiingo-rt] became leader");
        openSocket();
        // Subscribe IMMEDIATELY rather than waiting up to SUBSCRIPTION_REFRESH_MS
        // — and rebuild the base set, because a new leader has no cache.
        lastBaseRebuildMs = 0;
        void subscribeTick();
        break;
      case "hold":
        if (outcome === "acquired")
          view = { ...view, lastConfirmedMs: Date.now() };
        break;
      case "step-down":
        counters.leaderTransitions++;
        console.error(`[tiingo-rt] stepping down: ${action.reason}`);
        view = { ...view, state: "follower", lastConfirmedMs: null };
        closeSocket(action.reason);
        await releaseLeadership(token);
        break;
      case "stay-follower":
        break;
    }
  } finally {
    leaderBusy = false;
  }
}

/**
 * Re-plan the subscription set and apply the deltas.
 *
 * Only the leader holds a socket, so only the leader subscribes. The base set
 * is rebuilt from the database on a much slower cadence than the plan is
 * applied: page interest changes by the second, holdings do not.
 */
async function subscribeTick(): Promise<void> {
  if (subscribeBusy || socket === null) return;
  subscribeBusy = true;
  try {
    const now = Date.now();
    const rebuildBase = now - lastBaseRebuildMs >= BASE_REFRESH_MS;
    if (rebuildBase) {
      lastBaseRebuildMs = now;
      // A newly-listed symbol is unresolvable until the cache is dropped, and
      // this is the natural cadence for it — same reason, same period.
      candleSink.forgetListings();
    }
    await refreshSubscriptions({
      socket,
      counters: subCounters,
      nowMs: now,
      rebuildBase,
      maxSymbols: maxSymbols(),
    });
  } finally {
    subscribeBusy = false;
  }
}

/**
 * Close due bars and write them.
 *
 * `mayWrite` is consulted HERE and not only on the leader timer: a stalled
 * event loop can leave a process believing it leads long after its lock lapsed,
 * and the renewal loop cannot report that because the renewal loop is the thing
 * that stalled. A duplicated bar is permanent; a skipped flush costs one cycle.
 */
/**
 * Emit the counters as Datadog series — MONEY-1357.
 *
 * Called from `flushTick`'s `finally` AND from its `flushBusy` early return, so
 * it runs on EVERY tick. That placement is the point: `rt.health_ok` has to be
 * emitted when the service is UNHEALTHY too, and every early return in that
 * function is a state an operator would want to see.
 *
 * THE BUSY PATH IS NOT AN AFTERTHOUGHT, it is the one that matters, and this
 * docblock claimed to cover it while the call sat below the guard. `flushBusy`
 * is cleared only in that `finally`, and neither `candleSink.write` nor
 * `tickArchive.flush` carries a timeout — so a Mongo primary election latches it
 * for minutes and every 5s tick returns BEFORE the `try`. Emitting only from the
 * `finally` therefore silenced every realtime series, `rt.health_ok` included,
 * and 20 minutes later `monitor-rt-health.json` (`notify_no_data: true`) paged
 * saying "a living process cannot stop emitting it. No data means the process is
 * gone" — while the process was alive and `/health` returned 200, because
 * `decideHealth` watches the socket, not the flush loop. That monitor's text is
 * the claim this second call site keeps true.
 *
 * A stuck flush stays VISIBLE on the gauge that should show it: `closeDue` is
 * not being called, so `rt.open_bars` climbs without bound.
 *
 * Never throws. Metrics must not be able to take down the socket they describe.
 */
let lastEmittedCounters: RtCounterSnapshot = emptyRtSnapshot();

function rtSnapshot(): RtCounterSnapshot {
  return {
    barsClosed: counters.barsClosed,
    candlesWritten: candleSink.counters.written,
    candlesBuffered: candleSink.counters.buffered,
    refusedMixedSource: candleSink.counters.refusedMixedSource,
    refusedNoListing: candleSink.counters.refusedNoListing,
    candleWriteFailures: candleSink.counters.writeFailures,
    quotesWritten: counters.quotesWritten,
    quoteWriteFailures: counters.quoteWriteFailures,
    framesDropped: counters.framesDropped,
    framesReceived: socket?.counters.framesReceived ?? 0,
    reconnects: socket?.counters.reconnects ?? 0,
    leaderTransitions: counters.leaderTransitions,
    bytesRecorded: counters.bytesRecorded,
  };
}

function emitRtMetrics(): void {
  try {
    const current = rtSnapshot();
    for (const { metric, value } of computeRtMetricDeltas(
      lastEmittedCounters,
      current,
    )) {
      // Zero deltas are skipped: a zero-valued increment is a wire round trip
      // that says nothing, and the monitors use default_zero() for the gap.
      if (value > 0) incrementCounter(metric, value);
    }
    lastEmittedCounters = current;

    const health = healthView();
    gauge(RT_GAUGE_METRICS.healthOk, health.ok ? 1 : 0, {
      reason: healthReasonTag(health.reason),
    });
    gauge(RT_GAUGE_METRICS.leader, view.state === "leader" ? 1 : 0);
    // `subscribedCount`, not `subscribedSymbols().length`: the latter spreads
    // and SORTS up to TIINGO_RT_MAX_SYMBOLS (3,000) entries to produce a number
    // the Set already holds, 17,280 times a day, on the socket's own loop.
    gauge(RT_GAUGE_METRICS.subscribed, socket?.subscribedCount() ?? 0);
    gauge(RT_GAUGE_METRICS.openBars, aggregator.openCount());
  } catch {
    // Reporting is never worth failing the run it reports on.
  }
}

async function flushTick(): Promise<void> {
  if (flushBusy) {
    // BEFORE the return: the `finally` below is unreachable while the previous
    // tick still holds the flag, and a flush that hangs is exactly when an
    // operator needs these series. See `emitRtMetrics`.
    emitRtMetrics();
    return;
  }
  flushBusy = true;
  try {
    const now = Date.now();
    // Bytes first, and unconditionally: the streamed volume counts against the
    // MONTHLY byte budget whether or not this process is entitled to write
    // bars, and a meter that only runs on the happy path under-reports exactly
    // when it matters.
    //
    // `recordStreamBytes`, not `recordBytes`. The latter does a Redis INCRBY
    // per call, which is right for one HTTP response and wrong for a feed
    // delivering top-of-book quotes for up to TIINGO_RT_MAX_SYMBOLS symbols —
    // it would put Redis in the hot path of every tick and make the meter the
    // bottleneck it exists to measure. This one accumulates in memory and only
    // touches Redis past TIINGO_STREAM_FLUSH_BYTES.
    if (socket !== null && socket.counters.bytesReceived > 0) {
      const n = socket.counters.bytesReceived;
      socket.counters.bytesReceived = 0;
      counters.bytesRecorded += n;
      await recordStreamBytes(n).catch(() => {});
    }
    // And the TAIL, on the archive's cadence. Whatever sits under the flush
    // threshold is unmetered until something forces it out — a partial month of
    // unmetered bytes is precisely the under-reporting this meter exists to
    // prevent.
    if (tickArchive.dueForFlush(now))
      await flushStreamBytes().catch(() => null);

    // The archive is flushed on its OWN cadence and independently of
    // entitlement: these are bytes the feed sent us, not a derived write, so
    // the `mayWrite` gate below does not apply to them.
    if (tickArchive.dueForFlush(now)) await tickArchive.flush(now);

    const due = aggregator.closeDue(now);
    if (due.length === 0) return;

    // The gate comes BEFORE the counter. `closeDue` has already retired these
    // minutes inside the aggregator, so counting them as closed here and then
    // refusing to write would report work that produced nothing — and there is
    // no second pass that could pick them up.
    if (!mayWrite(view, now)) {
      console.warn(
        `[tiingo-rt] dropping ${due.length} bar(s): not entitled to write`,
      );
      return;
    }
    counters.barsClosed += due.length;
    await candleSink.write(due);
  } finally {
    // In the FINALLY, so an unhealthy tick and an early return still report.
    // Silence from this service means the process is gone, and that is the one
    // monitor in the set whose notify_no_data is deliberately true.
    emitRtMetrics();
    flushBusy = false;
  }
}

/**
 * How long a leader may be without a working socket before it is UNHEALTHY.
 *
 * Must exceed a whole reconnect cycle, and that is not a comfort margin — it is
 * what stops this check from cancelling the backoff ladder.
 *
 * A disconnect is normal and self-healing: the ladder waits up to
 * BACKOFF_MAX_MS (60s) between attempts, and the watchdog needs
 * HEARTBEAT_TIMEOUT_MS (45s) to notice a socket that went quiet without
 * erroring. A probe that failed the instant the socket dropped would have Cloud
 * Run restart the container during EVERY ordinary reconnect — and a restart
 * builds a fresh `TiingoSocket` with `attempt` back at 0, so the ladder could
 * never climb past its first rung. The liveness check would silently undo the
 * backoff fix while both looked correct in isolation.
 *
 * 180s is comfortably past 60 + 45 and still restarts a genuinely wedged holder
 * within three minutes.
 */
const UNHEALTHY_AFTER_MS = 180_000;

/** Last moment the leader's socket was demonstrably working. */
let lastSocketHealthyMs = 0;

/**
 * READ-ONLY. `/health` must be able to say NO — see `health-logic.ts` for why it
 * must not say no too eagerly. The DECISION is pure and lives there so it can be
 * tested; this is the I/O that feeds it.
 *
 * IT DOES NOT WRITE `lastSocketHealthyMs`, and that is the entire reason it is
 * separate from the probe below. `decideHealth` advances the clock to `nowMs` on
 * ANY sample where the socket is momentarily live, so whoever calls it decides
 * how often the grace window may be reset. That was safe while the only caller
 * was the 30s probe; `emitRtMetrics` samples every 5s, and a socket that comes
 * up for one 5s window inside each 180s grace period would hold `downFor` under
 * `UNHEALTHY_AFTER_MS` forever — on samples the probe never sees. `/health`
 * would never 503 and Cloud Run would never restart a container dropping most of
 * the feed. Six times the sampling rate is six times the chance of catching a
 * flap, and every catch cancels the restart.
 */
function healthView(nowMs = Date.now()): HealthVerdict {
  return decideHealth({
    leader: view.state === "leader",
    socketConnected: socket?.isConnected() ?? false,
    msSinceLastFrame: socket?.msSinceLastMessage(nowMs) ?? Infinity,
    lastHealthyAtMs: lastSocketHealthyMs,
    nowMs,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    unhealthyAfterMs: UNHEALTHY_AFTER_MS,
  });
}

const server = createServer((req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404).end();
    return;
  }
  // THE PROBE IS THE ONLY CALLER THAT ADVANCES THE CLOCK — see `healthView`.
  // (`leaderTick` sets it once, on becoming leader, so a fresh leader is not
  // instantly "unhealthy for 56 years".) A future reader takes `healthView`.
  const health = healthView();
  lastSocketHealthyMs = health.lastHealthyAtMs;
  const body = {
    ok: health.ok,
    health: health.reason,
    leader: view.state,
    socket: socket?.isConnected() ?? false,
    msSinceLastFrame: socket?.msSinceLastMessage() ?? null,
    subscribed: socket?.subscribedCount() ?? 0,
    openBars: aggregator.openCount(),
    counters: {
      ...counters,
      socket: socket?.counters,
      aggregator: aggregator.counters,
      subscription: subCounters,
      candles: candleSink.counters,
      tickArchive: archiveEnabled() ? tickArchive.counters : "disabled",
    },
  };
  res
    .writeHead(health.ok ? 200 : 503, { "content-type": "application/json" })
    .end(JSON.stringify(body));
});

const timers: NodeJS.Timeout[] = [];

function start(): void {
  assertBoatsNotRequested();
  server.listen(PORT, () => console.log(`[tiingo-rt] health on :${PORT}`));
  timers.push(setInterval(() => void leaderTick(), LEADER_RENEW_MS));
  timers.push(setInterval(() => void subscribeTick(), SUBSCRIPTION_REFRESH_MS));
  timers.push(setInterval(() => void flushTick(), FLUSH_MS));
  void leaderTick();
}

/**
 * SIGTERM is Cloud Run telling us a new revision is taking over.
 *
 * Releasing the lock explicitly hands leadership over in milliseconds instead of
 * leaving the successor to wait out a 30s TTL — 30 seconds of no socket on every
 * deploy, which is a gap in the bar series that nothing later can fill.
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`[tiingo-rt] ${signal} — shutting down`);
  // ARM THE ESCAPE FIRST. It used to be the last statement, after two awaits —
  // so the deadline it exists to enforce could be consumed by the very work it
  // was meant to bound, and a hung `releaseLeadership` would hang the shutdown
  // with no timer yet running to end it. Cloud Run's grace period is finite and
  // then it SIGKILLs, so an escape armed after the fact is no escape.
  setTimeout(() => process.exit(0), 5_000).unref();
  for (const t of timers) clearInterval(t);
  closeSocket(signal);
  // Last chance for the buffered ticks. A deploy happens mid-minute far more
  // often than not, so skipping this would lose a partial minute on every
  // revision — and the escape timer above bounds how long it may take.
  await tickArchive.flush(Date.now());
  // The last partial buffer of streamed bytes, or it is never charged.
  await flushStreamBytes().catch(() => null);
  await releaseLeadership(token);
  // One last emit + flush: datadog-metrics batches on a 15s timer, so a deploy
  // would otherwise drop the final window — including the leader transition
  // this shutdown is about to cause.
  emitRtMetrics();
  await flushMetrics().catch(() => undefined);
  // Same reasoning as the metrics flush above, for the log transport: it batches
  // on a 5s timer, so a deploy would otherwise drop the final window — which is
  // exactly where the shutdown's own lines are.
  await flushLogs().catch(() => undefined);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

start();

export {
  SUBSCRIPTION_REFRESH_MS,
  FLUSH_MS,
  QUOTE_TTL_SECONDS,
  UNHEALTHY_AFTER_MS,
};
