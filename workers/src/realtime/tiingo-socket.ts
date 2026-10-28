/**
 * The Tiingo equity-realtime socket holder.
 *
 * ALLOW-LISTED in `no-feed-fetch-bypass.test.ts`: this file is the only place
 * in the repo permitted to open a connection to `api.tiingo.com` for realtime
 * data. Everything else reads what this writes.
 *
 * ## What this file is responsible for, and what it is not
 *
 * It owns the CONNECTION: connect, subscribe, decode, reconnect, heartbeat
 * watchdog. It does NOT decide what to subscribe to (the planner does), what a
 * frame means (the decoder does), whether it may write (the leader does), or
 * where ticks go (the sink does). Each of those is pure and tested without a
 * socket; this layer is the only part that needs a network to exercise, so it
 * is kept as thin as the job allows.
 *
 * ## Reconnect
 *
 * Exponential backoff with FULL JITTER. The jitter is not decoration: every
 * instance of this service watches the same upstream, so a fixed ladder makes
 * them all retry in lockstep after a Tiingo blip and turns one outage into a
 * thundering herd against a metered API. Full jitter (random in [0, delay])
 * spreads them without needing to coordinate.
 *
 * ## The heartbeat watchdog exists because a dead socket looks like a quiet one
 *
 * TCP will happily hold a connection that is delivering nothing. The feed sends
 * a heartbeat frame on its own schedule, so silence beyond
 * `HEARTBEAT_TIMEOUT_MS` means the socket is gone even though no error fired
 * and no `close` event arrived. Without this the service reports itself healthy,
 * holds the leader lock, and writes nothing — which is the single failure mode
 * that looks most like "the market is quiet".
 */

import WebSocket from "ws";
import {
  TIINGO_RT_WS_URL,
  TIINGO_RT_THRESHOLD_LEVEL,
  buildSubscribePayload,
  decodeRtFrame,
  type TiingoRtFrame,
} from "@usemoney/core/market-data/tiingo/tiingo-realtime-logic";

/** No heartbeat and no data for this long means the socket is dead. */
export const HEARTBEAT_TIMEOUT_MS = 45_000;

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export interface SocketCallbacks {
  onFrame: (frame: TiingoRtFrame) => void;
  /**
   * Every frame's RAW text, before decoding, for the re-derivation archive.
   *
   * Separate from `onFrame` because the archive's whole purpose is to survive a
   * decoder that turns out to be wrong: handing it the DECODED frame would
   * archive this decoder's interpretation and lose the bytes needed to correct
   * it. Optional — an environment with no bucket configured simply omits it.
   */
  onRaw?: (raw: string, receivedAtMs: number) => void;
  /** Fired after every successful (re)connect, so the caller can snapshot. */
  onConnected: (attempt: number) => void;
  onDisconnected: (reason: string) => void;
}

export interface SocketCounters {
  connects: number;
  reconnects: number;
  framesReceived: number;
  heartbeats: number;
  refusals: number;
  decodeIgnored: number;
  /**
   * Inbound payload bytes, so the streamed volume reaches the monthly BYTE
   * budget. Accumulated here and flushed by the holder on its own cadence — a
   * Redis round trip per frame would cost more than the feed does.
   */
  bytesReceived: number;
  /**
   * The CURRENT rung of the reconnect ladder, exposed rather than private.
   *
   * Two reasons, and the second is why it is here at all. It is the single most
   * useful number on `/health` when a feed is flapping — a climbing attempt
   * count distinguishes "one blip" from "we cannot connect" without reading
   * logs. And it is the only way to OBSERVE that the ladder escalates: the
   * delay itself is full-jittered into a `setTimeout` and never surfaces, which
   * is exactly how a permanently-reset counter went unnoticed.
   */
  reconnectAttempt: number;
}

/**
 * Full-jitter exponential backoff.
 *
 * Exported for its own test: retry timing is the kind of arithmetic that is
 * easy to get subtly wrong and impossible to observe once it is inside a
 * private method.
 */
/**
 * How long a connection must SURVIVE before the backoff ladder is allowed to
 * reset.
 *
 * The ladder used to reset in the `open` handler, which made it inert: the
 * reset ran before any teardown could read the counter, so the delay was
 * `backoffDelayMs(1)` on every single retry and the ceiling never rose above
 * the base. That is only harmless if "opened" implies "working", and it does
 * not — a rejected auth, or a server shedding load, accepts the socket and
 * drops it, firing `open` every time. The measured cost was a hot reconnect
 * loop at base delay, roughly 1,900 handshakes a day, with exponential backoff
 * sitting right there in the source doing nothing.
 *
 * Resetting on proven UPTIME instead means a flapping connection keeps climbing
 * the ladder, and only a connection that actually held gets forgiven.
 */
export const BACKOFF_STABLE_AFTER_MS = 60_000;

export function backoffDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(
    BACKOFF_MAX_MS,
    BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
  return Math.floor(random() * ceiling);
}

/**
 * The slice of `ws.WebSocket` this class actually uses.
 *
 * Declared so the socket can be INJECTED. Without a seam this class had no
 * behavioural test at all — every test was either on the pure `backoffDelayMs`
 * or a scan of the source text — and that is exactly how the reconnect ladder
 * came to be inert: `attempt` was reset in the `open` handler, before any
 * teardown could read it, so the delay was `backoffDelayMs(1)` forever. Nothing
 * could observe the difference because nothing could drive the class.
 */
export interface SocketLike {
  readyState: number;
  on(event: string, listener: (...args: never[]) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

/** How a socket gets made. Overridden only by tests. */
export type SocketFactory = (url: string) => SocketLike;

const defaultSocketFactory: SocketFactory = (url) =>
  new WebSocket(url) as unknown as SocketLike;

export class TiingoSocket {
  private ws: SocketLike | null = null;
  private readonly subscribed = new Set<string>();
  private attempt = 0;
  private lastMessageAtMs = 0;
  private closing = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;

  readonly counters: SocketCounters = {
    connects: 0,
    reconnects: 0,
    framesReceived: 0,
    heartbeats: 0,
    refusals: 0,
    decodeIgnored: 0,
    bytesReceived: 0,
    reconnectAttempt: 0,
  };

  constructor(
    private readonly token: string,
    private readonly cb: SocketCallbacks,
    private readonly createSocket: SocketFactory = defaultSocketFactory,
  ) {}

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * The set, spread and SORTED. Only `refreshSubscriptions` needs this — it
   * diffs the current set against a plan — and the tests that drive it.
   *
   * For a COUNT use `subscribedCount`. Both `/health` and the 5s metrics tick
   * used `subscribedSymbols().length`, which allocates and sorts up to
   * TIINGO_RT_MAX_SYMBOLS (3,000) strings to read a number the Set already
   * holds — 17,280 times a day on the socket's own event loop, the one
   * `cpu-throttling: "false"` is paid for.
   */
  subscribedSymbols(): string[] {
    return [...this.subscribed].sort();
  }

  /** How many symbols we believe we hold. O(1). */
  subscribedCount(): number {
    return this.subscribed.size;
  }

  msSinceLastMessage(nowMs = Date.now()): number {
    return this.lastMessageAtMs === 0 ? Infinity : nowMs - this.lastMessageAtMs;
  }

  connect(): void {
    if (this.closing || this.ws !== null) return;
    this.attempt++;
    this.counters.reconnectAttempt = this.attempt;
    const ws = this.createSocket(TIINGO_RT_WS_URL);
    this.ws = ws;

    ws.on("open", (() => {
      this.counters.connects++;
      if (this.attempt > 1) this.counters.reconnects++;
      this.lastMessageAtMs = Date.now();
      console.log(
        `[tiingo-rt] socket open (attempt ${this.attempt}, ${this.subscribed.size} symbols to restore)`,
      );
      // Re-subscribe EVERYTHING we believed we held. The server keeps no state
      // for us across a reconnect, so anything not re-sent is silently gone —
      // the shape where a feed comes back "working" and is missing half its
      // symbols.
      if (this.subscribed.size > 0)
        this.send("subscribe", [...this.subscribed]);
      // NOT `this.attempt = 0` here — see BACKOFF_STABLE_AFTER_MS. Forgiveness
      // is earned by surviving, not by connecting.
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        this.attempt = 0;
        this.counters.reconnectAttempt = 0;
      }, BACKOFF_STABLE_AFTER_MS);
      this.stableTimer.unref?.();
      this.armWatchdog();
      this.cb.onConnected(this.counters.connects);
    }) as (...a: never[]) => void);

    ws.on("message", ((raw: Buffer) => {
      // A frame from a socket we have already replaced must not revive the
      // watchdog clock for its successor.
      if (ws !== this.ws) return;
      const receivedAtMs = Date.now();
      this.lastMessageAtMs = receivedAtMs;
      this.counters.framesReceived++;
      this.counters.bytesReceived += raw.length;
      const text = raw.toString();
      // BEFORE the decode, and outside its try: the archive exists so a wrong
      // decoder can be corrected later, so it must not be skipped by the decode
      // path failing. Never allowed to throw into the message handler.
      try {
        this.cb.onRaw?.(text, receivedAtMs);
      } catch {
        // A buffering failure must never cost a frame.
      }
      const frame = decodeRtFrame(text, TIINGO_RT_THRESHOLD_LEVEL);
      if (frame.kind === "heartbeat") this.counters.heartbeats++;
      if (frame.kind === "ignored") this.counters.decodeIgnored++;
      if (frame.kind === "refusal") {
        this.counters.refusals++;
        // Loud, because the two refusal kinds send an operator to completely
        // different places and the message text is the only thing that tells
        // them apart.
        console.error(
          `[tiingo-rt] refusal (${frame.refusal.kind}): ${frame.refusal.message}`,
        );
      }
      this.cb.onFrame(frame);
    }) as (...a: never[]) => void);

    ws.on("close", ((code: number) => this.teardown(`close ${code}`, ws)) as (
      ...a: never[]
    ) => void);
    ws.on("error", ((err: Error) =>
      this.teardown(`error ${err.message}`, ws)) as (...a: never[]) => void);
  }

  /** Apply a subscription delta. Deltas, not a full re-send, on a live socket. */
  applyDelta(
    toSubscribe: readonly string[],
    toUnsubscribe: readonly string[],
  ): void {
    for (const s of toSubscribe) this.subscribed.add(s);
    for (const s of toUnsubscribe) this.subscribed.delete(s);
    if (!this.isConnected()) return; // the open handler will restore the set
    if (toSubscribe.length > 0) this.send("subscribe", toSubscribe);
    if (toUnsubscribe.length > 0) this.send("unsubscribe", toUnsubscribe);
  }

  close(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.reconnectTimer = null;
    this.watchdog = null;
    this.stableTimer = null;
    try {
      this.ws?.close();
    } catch {
      // Already gone; nothing to do.
    }
    this.ws = null;
  }

  private send(
    event: "subscribe" | "unsubscribe",
    tickers: readonly string[],
  ): void {
    if (!this.isConnected()) return;
    try {
      this.ws!.send(
        JSON.stringify(
          buildSubscribePayload({
            token: this.token,
            tickers,
            event,
            thresholdLevel: TIINGO_RT_THRESHOLD_LEVEL,
          }),
        ),
      );
    } catch (err) {
      console.error(`[tiingo-rt] ${event} failed: ${String(err)}`);
    }
  }

  /**
   * A socket delivering nothing is indistinguishable from a quiet market until
   * something checks the clock. This is that check.
   */
  private armWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.msSinceLastMessage() > HEARTBEAT_TIMEOUT_MS) {
        console.warn(
          `[tiingo-rt] no frame for ${HEARTBEAT_TIMEOUT_MS}ms — treating the socket as dead`,
        );
        this.teardown("heartbeat timeout", this.ws);
      }
    }, HEARTBEAT_TIMEOUT_MS / 3);
    // Never hold the process open on this timer alone.
    this.watchdog.unref?.();
  }

  /**
   * `origin` is the socket the event came from. A late `close` from a socket we
   * have already replaced must not tear down its SUCCESSOR — that turns one
   * disconnect into two and, because each teardown schedules a reconnect, into
   * two competing reconnect timers racing to create a third socket.
   */
  private teardown(reason: string, origin: SocketLike | null): void {
    if (origin !== null && origin !== this.ws) return;
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    const had = this.ws !== null;
    try {
      this.ws?.terminate();
    } catch {
      // best effort
    }
    this.ws = null;
    if (!had) return;
    this.cb.onDisconnected(reason);
    if (this.closing) return;
    const delay = backoffDelayMs(this.attempt + 1);
    console.warn(
      `[tiingo-rt] disconnected (${reason}); reconnecting in ${delay}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
