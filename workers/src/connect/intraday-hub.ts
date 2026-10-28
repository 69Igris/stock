/**
 * Intraday Live Data Hub - MONEY-123 Part B
 *
 * Server-side singleton that holds:
 *
 *   1. ONE Zerodha WebSocket connection per Node process
 *   2. A reference-counted registry of subscribed (instrument_token)s
 *   3. A per-(symbol, interval) TickAggregator producing bar updates
 *   4. A fan-out of SSE client listeners per (symbol, interval)
 *
 * Why a single-WS-per-process singleton:
 *   Zerodha allows up to ~3000 tokens per WebSocket connection. Opening
 *   a new WS per chart (per user, per symbol) would hit connection
 *   limits fast and duplicate ticks unnecessarily. One connection,
 *   N token subscriptions, M client listeners per symbol is cheap.
 *
 * Reference counting prevents the "one user's chart close unsubscribes
 * a symbol another user is still watching" bug:
 *
 *   subscribe("NSE:TCS", "5m")  → token 2953217 refcount = 1, WS.subscribeTokens
 *   subscribe("NSE:TCS", "5m")  → refcount = 2 (another client on same sym+iv)
 *   unsubscribe(...)            → refcount = 1 (still active)
 *   unsubscribe(...)            → refcount = 0, WS.unsubscribeTokens
 *
 * The aggregator per (symbol, interval) is similarly shared: two
 * clients watching TCS at 5m share the same aggregator and see the
 * same bar updates at the same times.
 *
 * Lifecycle:
 *   - First subscriber ever → connects Zerodha WS using the user's
 *     broker credentials (credential rotation problem punted to a
 *     follow-up; the credential lookup uses `getBrokerCredentials` on
 *     the subscribing user)
 *   - Last subscriber leaves → disconnect WS (but wait 30 s first to
 *     absorb the "user navigates, reloads, resubscribes" pattern
 *     without thrashing the WS connection)
 *
 * Not in scope for v1:
 *   - Shared WS across multiple Next.js route worker instances. On
 *     Vercel, each function invocation has its own module scope, so
 *     the "singleton" is per-instance. This is fine for the SSE
 *     pattern (one SSE connection per route invocation holds its own
 *     hub), it just means the fan-out benefits are per-instance, not
 *     process-wide across the fleet. For serious scale this would move
 *     to a dedicated WebSocket service behind Redis pub/sub.
 */

import { ZerodhaWebSocket } from "./ws/zerodha-ws";
import type { Tick } from "./ws/base-ws";
import { TickAggregator, type Bar } from "./tick-aggregator";
import { prisma } from "@usemoney/database";

// ============== TYPES ==============

export interface IntradaySubscription {
  /** `EXCHANGE:SYMBOL` form, e.g. "NSE:TCS" */
  symbolKey: string;
  /** Interval label, e.g. "5m" */
  interval: string;
  /** Called on every bar update (new or existing) */
  onBar: (bar: Bar, isNewBar: boolean) => void;
  /** Called when the hub loses the WS connection (informational only) */
  onError?: (error: Error) => void;
}

export interface SubscribeResult {
  /** Call to unsubscribe this listener */
  unsubscribe: () => void;
  /** The current bar at subscribe time, or null if no ticks yet */
  currentBar: Bar | null;
}

// ============== INTERNAL STATE ==============

interface AggregatorEntry {
  aggregator: TickAggregator;
  /** Total number of listeners across all keys that point at this aggregator */
  refCount: number;
}

interface TokenEntry {
  /** Zerodha numeric instrument token */
  token: number;
  /** symbolKey that points at this token, for reverse lookup on tick delivery */
  symbolKey: string;
  /** How many aggregators (across all intervals) are watching this token */
  refCount: number;
  /** Most recent cumulative day volume seen, for delta computation */
  lastVolume: number;
}

interface HubState {
  ws: ZerodhaWebSocket | null;
  wsConnecting: Promise<void> | null;
  /** token → TokenEntry */
  tokens: Map<number, TokenEntry>;
  /** `${symbolKey}::${interval}` → AggregatorEntry */
  aggregators: Map<string, AggregatorEntry>;
  /** symbolKey → token (for tick fan-out) */
  symbolToToken: Map<string, number>;
  /** token → Set of `${symbolKey}::${interval}` keys (for tick fan-out) */
  tokenToAggregatorKeys: Map<number, Set<string>>;
}

const state: HubState = {
  ws: null,
  wsConnecting: null,
  tokens: new Map(),
  aggregators: new Map(),
  symbolToToken: new Map(),
  tokenToAggregatorKeys: new Map(),
};

// ============== KEY HELPERS ==============

function aggregatorKey(symbolKey: string, interval: string): string {
  return `${symbolKey.toUpperCase()}::${interval}`;
}

// ============== INSTRUMENT RESOLUTION ==============

/**
 * Resolve a "NSE:TCS" → Zerodha numeric instrument token via the
 * InstrumentMapping table. The token is required for Zerodha's WS
 * subscribe message.
 */
async function resolveInstrumentToken(
  symbolKey: string,
): Promise<number | null> {
  const [exchange, ...symbolParts] = symbolKey.split(":");
  const symbol = symbolParts.join(":");
  if (!exchange || !symbol) return null;

  const instrument = await prisma.instrumentMapping.findUnique({
    where: {
      symbol_exchange: {
        symbol: symbol.toUpperCase(),
        exchange: exchange.toUpperCase(),
      },
    },
    select: { zerodhaToken: true },
  });

  return instrument?.zerodhaToken ?? null;
}

// ============== WS LIFECYCLE ==============

/**
 * Ensure the Zerodha WS is connected. If a connection is already in
 * progress, wait for it. Resolves to void once connected (or throws
 * if credentials are missing / connection fails).
 *
 * Uses `getBrokerCredentials()` from the web app's action layer,
 * which reads the current Clerk user's stored creds. Since the
 * SSE route is authenticated, this runs in a user-request context.
 */
async function ensureWsConnected(credentials: {
  apiKey: string;
  accessToken: string;
}): Promise<void> {
  if (state.ws?.isConnected()) return;

  if (state.wsConnecting) {
    await state.wsConnecting;
    return;
  }

  const ws = state.ws ?? new ZerodhaWebSocket();
  state.ws = ws;

  // Wire tick fan-out on the shared WS. We register this listener
  // ONCE per WS instance - if the WS reconnects later, the callbacks
  // persist through the existing onTick() subscription.
  ws.onTick((ticks: Tick[]) => {
    for (const tick of ticks) {
      routeTick(tick);
    }
  });

  state.wsConnecting = ws.connect(credentials).finally(() => {
    state.wsConnecting = null;
  });
  await state.wsConnecting;

  // Re-subscribe any tokens that were already registered (covers the
  // reconnect case where a client subscribed before the WS was up).
  const tokens = Array.from(state.tokens.keys());
  if (tokens.length > 0 && state.ws?.isConnected()) {
    state.ws.subscribeTokens(tokens);
  }
}

/**
 * Route an incoming tick to the right aggregators. A single tick
 * fans out to every aggregator keyed on its (symbolKey, *) - so
 * a tick for TCS updates both the 5m and 15m aggregators if both
 * are active.
 */
function routeTick(tick: Tick): void {
  const token = tick.instrumentToken;
  if (typeof token !== "number") return;

  const tokenEntry = state.tokens.get(token);
  if (!tokenEntry) return;

  // Compute volume delta. Zerodha reports cumulative day volume on
  // each tick. We track the previous value to compute the per-tick
  // delta passed into the aggregator.
  const currentVolume = tick.volume ?? 0;
  const volumeDelta = Math.max(0, currentVolume - tokenEntry.lastVolume);
  tokenEntry.lastVolume = currentVolume;

  const tickTimeSec = tick.lastTradeTime
    ? Math.floor(new Date(tick.lastTradeTime).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  const keys = state.tokenToAggregatorKeys.get(token);
  if (!keys) return;

  // Iterate as an array to satisfy the project's TS config (no
  // downlevelIteration, target older than the strict for-of-over-Set
  // contract). Snapshot also protects against mutation during dispatch
  // - an aggregator's listener could in theory call subscribe()/
  // unsubscribe() which would mutate the Set mid-iteration.
  const keysSnapshot = Array.from(keys);
  for (const key of keysSnapshot) {
    const entry = state.aggregators.get(key);
    if (!entry) continue;
    entry.aggregator.ingest(tick.lastPrice, volumeDelta, tickTimeSec);
  }
}

// ============== PUBLIC API ==============

/**
 * Subscribe a listener to live bar updates for a (symbol, interval).
 *
 * Contract:
 *   - First subscriber for a given (symbol, interval) creates the
 *     aggregator; subsequent subscribers share it.
 *   - First subscriber for a given instrument token opens the WS
 *     subscription; subsequent subscribers share the tick stream.
 *   - Unsubscribe is strict: calling it exactly once releases the
 *     listener's refs. Calling it twice is a bug.
 *   - On subscribe, the current open bar (if any) is returned so
 *     callers can immediately render something.
 *
 * Credentials: the SSE route passes the authenticated user's Zerodha
 * creds. The hub doesn't store them - it just uses them to (re)connect
 * the WS. If a second user subscribes later with different creds, the
 * existing WS is reused (the creds are bound to the broker app, not
 * the user - any valid access token for the same Kite Connect app
 * receives the same tick stream).
 */
export async function subscribe(
  sub: IntradaySubscription,
  credentials: { apiKey: string; accessToken: string },
): Promise<SubscribeResult> {
  const { symbolKey, interval, onBar, onError } = sub;

  // 1. Resolve token for this symbol.
  const token = await resolveInstrumentToken(symbolKey);
  if (!token) {
    throw new Error(
      `No Zerodha instrument token mapped for ${symbolKey} - cannot subscribe to live ticks`,
    );
  }

  // 2. Ensure WS is connected (shared across the process).
  try {
    await ensureWsConnected(credentials);
  } catch (err) {
    onError?.(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }

  // 3. Track or create the token registration.
  let tokenEntry = state.tokens.get(token);
  if (!tokenEntry) {
    tokenEntry = {
      token,
      symbolKey,
      refCount: 0,
      lastVolume: 0,
    };
    state.tokens.set(token, tokenEntry);
    state.symbolToToken.set(symbolKey.toUpperCase(), token);
    state.ws?.subscribeTokens([token]);
  }
  tokenEntry.refCount++;

  // 4. Track or create the aggregator.
  const aggKey = aggregatorKey(symbolKey, interval);
  let aggEntry = state.aggregators.get(aggKey);
  if (!aggEntry) {
    aggEntry = {
      aggregator: new TickAggregator(interval),
      refCount: 0,
    };
    state.aggregators.set(aggKey, aggEntry);
    const existingKeys = state.tokenToAggregatorKeys.get(token) ?? new Set();
    existingKeys.add(aggKey);
    state.tokenToAggregatorKeys.set(token, existingKeys);
  }
  aggEntry.refCount++;

  // 5. Wire the listener's onBar to the aggregator.
  const detach = aggEntry.aggregator.onBarUpdate(onBar);

  const currentBar = aggEntry.aggregator.getCurrentBar();

  const unsubscribe = () => {
    detach();

    // Aggregator refcount
    const currentAgg = state.aggregators.get(aggKey);
    if (currentAgg) {
      currentAgg.refCount--;
      if (currentAgg.refCount <= 0) {
        currentAgg.aggregator.destroy();
        state.aggregators.delete(aggKey);
        const aggKeys = state.tokenToAggregatorKeys.get(token);
        aggKeys?.delete(aggKey);
        if (aggKeys && aggKeys.size === 0) {
          state.tokenToAggregatorKeys.delete(token);
        }
      }
    }

    // Token refcount
    const currentToken = state.tokens.get(token);
    if (currentToken) {
      currentToken.refCount--;
      if (currentToken.refCount <= 0) {
        state.tokens.delete(token);
        state.symbolToToken.delete(symbolKey.toUpperCase());
        state.ws?.unsubscribeTokens([token]);
      }
    }

    // If nothing is subscribed anywhere, close the WS entirely - but
    // only after a short grace period, to avoid tearing down on a
    // page navigation that will re-subscribe within ~1s. Closing and
    // reopening Zerodha's WS on every route change is wasteful.
    if (state.tokens.size === 0) {
      scheduleWsShutdown();
    }
  };

  return { unsubscribe, currentBar };
}

// ============== GRACEFUL WS SHUTDOWN ==============

let shutdownTimer: NodeJS.Timeout | null = null;
const WS_SHUTDOWN_GRACE_MS = 30_000;

function scheduleWsShutdown(): void {
  if (shutdownTimer) clearTimeout(shutdownTimer);
  shutdownTimer = setTimeout(() => {
    shutdownTimer = null;
    if (state.tokens.size > 0) return; // someone resubscribed
    if (state.ws) {
      console.log("[intraday-hub] Closing Zerodha WS (no subscribers)");
      state.ws.disconnect();
      state.ws = null;
    }
  }, WS_SHUTDOWN_GRACE_MS);
}

// ============== TEST HELPERS ==============

/**
 * Exported for tests only. Resets ALL hub state including the WS.
 * Never call from production code.
 */
export const __test__ = {
  getState: () => state,
  reset: () => {
    state.ws?.disconnect();
    state.ws = null;
    state.wsConnecting = null;
    state.tokens.clear();
    state.aggregators.clear();
    state.symbolToToken.clear();
    state.tokenToAggregatorKeys.clear();
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
  },
};
