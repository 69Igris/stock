/**
 * Tiingo equity-realtime (24x5 consolidated) websocket — the PURE half.
 *
 * ## Which feed, and why not IEX
 *
 * Tiingo's own documentation page for this endpoint says "for production use
 * cases, we recommend the IEX websocket endpoints". For OUR account that line
 * is superseded. Rishi Singh (Tiingo CEO), by email 2026-08-31:
 *
 *   "Use the 24x5 plan - it will be the successor to IEX. It is 24x5 derived -
 *    whereas IEX derived is 1 venue, this new 24x5 venue is 4 venues - and we
 *    may add more. It's a better product - and we're including it no additional
 *    cost. [...] No exchange fees, more venues, better prices, and expanded
 *    hours. We anticipate most customers will move off IEX Derived onto this."
 *
 * That is written down HERE, next to the endpoint constant, because the public
 * doc page still says the opposite: without this note the next reader "fixes"
 * us back onto a single-venue feed on the strength of a stale sentence. There
 * is deliberately NO `TIINGO_RT_FEED` switch and no IEX code path — a config
 * value nobody should choose is an invitation to choose it.
 *
 * ## The frame contract is PINNED FROM CAPTURED BYTES, not from the docs
 *
 * The docs describe these payloads as arrays but do not give a field-by-field
 * layout for this endpoint. This project has already paid once for trusting a
 * documented layout: Tiingo's EOD CSV is documented `date,open,...` and is
 * actually `date,close,high,low,open` — a positional parser written from the
 * docs silently swaps open and close on every US security (see
 * `tiingo-logic.ts`). So the layout below was derived from 236 live frames
 * captured 2026-08-31 (`__tests__/fixtures/tiingo-realtime/`) and CHECKED
 * ARITHMETICALLY rather than assumed:
 *
 *     ['2026-08-31T13:58:11.030145337-04:00','aapl',3.2e-05,60,314.975,314.98,314.985,140]
 *       [0] ts   [1] ticker  [2] spread  [3] bidSize  [4] bid  [5] mid  [6] ask  [7] askSize
 *
 *     (314.985 - 314.975) / 314.98 = 3.175e-05  ==  the reported [2]. Bid < mid
 *     < ask holds on all 118 level-4 frames; zero null elements in either corpus.
 *
 * `sanityCheckLevel4Layout` re-runs that arithmetic in the test suite, so a
 * silent upstream re-ordering fails a build instead of quietly inverting every
 * bid and ask we store.
 *
 * ## Threshold levels
 *
 *   level 4  8 elements, quote-shaped: spread, sizes, bid/mid/ask.  <- WE USE THIS
 *   level 6  3 elements, a single reference price.
 *
 * Level 6 cannot populate a bid/ask quote, so the tick path requires level 4.
 * Both are entitled on our key (probed) and both are fixtured, because a future
 * reader comparing them needs the evidence and because level 6 is the natural
 * fallback if level 4 is ever withdrawn.
 *
 * ## `thresholdLevel` is a LOADED FOOT-GUN
 *
 * Values 0 and 5 are refused with a 400 whose text reads exactly like an
 * entitlement rejection:
 *
 *   {"response":{"code":400,"message":"thresholdLevel not valid for your
 *     subscription tier. Please read the new IEX Market data rules on: ..."}}
 *
 * It is NOT an entitlement problem — 4 and 6 work on the same key in the same
 * second. That message cost a probe during planning; `classifyRefusal` names
 * the two apart so it cannot cost an outage later.
 */

/** The one endpoint. See the header for why there is no IEX alternative. */
export const TIINGO_RT_WS_URL = "wss://api.tiingo.com/equity/intraday";

/**
 * Snapshot + gap-fill REST bases.
 *
 * The batch form REQUIRES the trailing slash: `/equity/intraday?tickers=...`
 * answers 301 and `fetch` will not carry an Authorization header across the
 * redirect, so it presents as an auth failure rather than a routing one.
 * Measured 2026-08-31.
 */
export const TIINGO_RT_SNAPSHOT_URL =
  "https://api.tiingo.com/tiingo/equity/intraday/";
export const TIINGO_RT_PRICES_URL =
  "https://api.tiingo.com/tiingo/equity/intraday";

/** Quote-shaped frames. Level 6 carries no bid/ask and cannot feed a quote. */
export const TIINGO_RT_THRESHOLD_LEVEL = 4;

/** Element counts, per level. A frame of any other width is refused. */
const LEVEL_WIDTH: Readonly<Record<number, number>> = { 4: 8, 6: 3 };

export type TiingoRtMessageType = "I" | "H" | "A" | "E";

export interface TiingoRtQuote {
  /** Lower-case in the feed; callers upper-case when joining to our master. */
  ticker: string;
  /** Feed timestamp, offset-aware ISO with nanoseconds. */
  ts: Date;
  bid: number | null;
  ask: number | null;
  /** The mid. This is the closest thing the feed gives to a "last". */
  mid: number | null;
  bidSize: number | null;
  askSize: number | null;
  /** RELATIVE spread, i.e. 0.000032 is 0.0032%, not 3.2 basis points of price. */
  spread: number | null;
  service: string;
}

export type TiingoRtRefusal =
  | { kind: "threshold-level"; message: string }
  | { kind: "not-entitled"; service: string | null; message: string }
  | { kind: "auth"; message: string }
  | { kind: "unknown"; message: string };

export type TiingoRtFrame =
  | { kind: "ack"; subscriptionId: number | null }
  | { kind: "heartbeat" }
  | { kind: "quote"; quote: TiingoRtQuote }
  | {
      kind: "reference";
      ticker: string;
      ts: Date;
      price: number | null;
      service: string;
    }
  | { kind: "refusal"; refusal: TiingoRtRefusal }
  | { kind: "ignored"; reason: string };

/** Finite-number coercion. `null` for anything that is not a usable number. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The mid, or `null` — and a mid of ZERO OR LESS is `null`.
 *
 * This is an EQUITY feed, and no equity has a price of 0.00. The mid is the
 * feed's own midpoint of the top of book, so it can only reach zero when there
 * is no book to take a midpoint of — a halted or unquoted symbol. It is an
 * ABSENCE, and the arithmetic says so from both directions: a zero mid beside a
 * NON-zero bid is impossible (`bid <= mid` fails), and a zero mid beside a zero
 * bid and ask is a book with nothing in it.
 *
 * Left as `0` it becomes `last: 0` in the quote hash and an `open/high/low/
 * close` of 0 in a written M1 candle — a tradeable-looking price for a security
 * nobody quoted. Neither guard downstream can see it: `Number.isFinite(0)` is
 * true, and `sanityCheckLevel4Layout` cannot evaluate `(ask - bid) / 0`. It is
 * the one input on this path where a fabricated zero reaches storage.
 *
 * SCOPED TO THE MID, deliberately, and NOT folded into `num()`:
 *
 *   - `bid` / `ask`: a zero bid is a PRICE — the feed reporting no buyer at any
 *     price — and `toQuotePayload` already pins that a null and a zero must not
 *     be collapsed into each other.
 *   - `bidSize` / `askSize`: zero size at the top of book is ordinary.
 *   - `spread`: zero is a locked market, bid === ask.
 *
 * A zero in those four columns is the feed telling us something. A zero mid is
 * the feed having nothing to tell us.
 */
function midOrNull(v: unknown): number | null {
  const n = num(v);
  return n === null || n <= 0 ? null : n;
}

/**
 * Parse a timestamp, or `null`.
 *
 * The feed sends offset-aware ISO with NANOSECOND precision
 * (`...T13:58:11.030145337-04:00`). `Date.parse` handles it by truncating to
 * milliseconds, which is what we want and is worth stating: the extra digits
 * are dropped deliberately, not lost accidentally.
 */
function parseTs(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * Classify an error frame BY BODY, never by the presence of an error alone.
 *
 * Two refusals look identical to a status-only reader and mean opposite things:
 * a `thresholdLevel` 400 is a bad PARAMETER on a perfectly entitled key, while
 * the BOATS 403 is a real entitlement gap that no retry or reconnect will fix.
 * Treating the first as "not entitled" would disable a working feed; treating
 * the second as "retry" would reconnect forever.
 */
export function classifyRefusal(
  message: string,
  code: number | null,
): TiingoRtRefusal {
  const lower = message.toLowerCase();
  if (lower.includes("thresholdlevel")) {
    return { kind: "threshold-level", message };
  }
  if (lower.includes("not authorized for service")) {
    const m = /not authorized for service:\s*(\S+)/i.exec(message);
    return { kind: "not-entitled", service: m ? m[1]! : null, message };
  }
  if (
    code === 401 ||
    lower.includes("invalid token") ||
    lower.includes("not authorized")
  ) {
    return { kind: "auth", message };
  }
  return { kind: "unknown", message };
}

/**
 * Decode ONE websocket frame.
 *
 * Never throws. A frame this build cannot read is DATA, and a socket holder
 * that dies on an unexpected shape takes the whole feed down for every
 * subscriber — the same reasoning as `parse_and_store`'s broad parse catch on
 * the EDGAR side.
 */
export function decodeRtFrame(
  raw: string,
  level: number = TIINGO_RT_THRESHOLD_LEVEL,
): TiingoRtFrame {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { kind: "ignored", reason: "unparseable JSON" };
  }
  if (typeof msg !== "object" || msg === null) {
    return { kind: "ignored", reason: "not an object" };
  }
  const m = msg as Record<string, unknown>;
  const type = m["messageType"];
  const response = (m["response"] ?? null) as Record<string, unknown> | null;
  const code = num(response?.["code"]);
  const text =
    typeof response?.["message"] === "string"
      ? (response["message"] as string)
      : "";

  if (type === "E" || (code !== null && code >= 400)) {
    return { kind: "refusal", refusal: classifyRefusal(text, code) };
  }
  if (type === "H") return { kind: "heartbeat" };
  if (type === "I") {
    const data = (m["data"] ?? null) as Record<string, unknown> | null;
    return { kind: "ack", subscriptionId: num(data?.["subscriptionId"]) };
  }
  if (type !== "A")
    return { kind: "ignored", reason: `messageType ${String(type)}` };

  const data = m["data"];
  if (!Array.isArray(data))
    return { kind: "ignored", reason: "A frame with no data array" };
  const service =
    typeof m["service"] === "string" ? (m["service"] as string) : "";
  const ts = parseTs(data[0]);
  const ticker = typeof data[1] === "string" ? (data[1] as string) : "";
  // A frame with no usable identity cannot be routed to a symbol, so it is
  // dropped rather than stored against an empty key.
  if (ts === null || ticker === "") {
    return { kind: "ignored", reason: "A frame missing ts or ticker" };
  }

  const expected = LEVEL_WIDTH[level];
  if (expected !== undefined && data.length !== expected) {
    // WIDTH IS THE TRIPWIRE. If Tiingo adds or reorders an element, positional
    // reads silently start meaning something else — bid becomes size, ask
    // becomes spread. Refusing the frame turns that into a visible counter
    // instead of a corrupted quote hash.
    return {
      kind: "ignored",
      reason: `level ${level} expects ${expected} elements, got ${data.length}`,
    };
  }

  if (level === 6) {
    return { kind: "reference", ticker, ts, price: num(data[2]), service };
  }
  return {
    kind: "quote",
    quote: {
      ticker,
      ts,
      spread: num(data[2]),
      bidSize: num(data[3]),
      bid: num(data[4]),
      mid: midOrNull(data[5]),
      ask: num(data[6]),
      askSize: num(data[7]),
      service,
    },
  };
}

/**
 * Re-derive the level-4 layout from the numbers themselves.
 *
 * `(ask - bid) / mid` must reproduce the reported relative spread. This is what
 * makes the positional layout a MEASURED claim rather than a guess, and it is
 * exercised over the whole captured corpus so an upstream re-ordering fails the
 * suite instead of inverting every stored bid and ask.
 *
 * The tolerance is generous (1e-6 absolute on a quantity around 3e-5) because
 * the feed rounds the spread it publishes; the check is for a TRANSPOSITION,
 * which would be wrong by orders of magnitude, not for rounding.
 */
export function sanityCheckLevel4Layout(q: TiingoRtQuote): {
  ok: boolean;
  detail: string;
} {
  const { bid, ask, mid, spread } = q;

  // BID <= ASK IS CHECKED FIRST, because it is the half of the claim that needs
  // no mid and no spread. An inverted book is the TRANSPOSITION SIGNATURE, and
  // it is exactly the input the previous ordering of this function skipped:
  // with the mid unusable, every remaining check was short-circuited to
  // `ok: true` and the inversion sailed through the one guard built to see it.
  // A check that abstains on the input it exists for is not a check.
  if (bid !== null && ask !== null && !(bid <= ask)) {
    return { ok: false, detail: `inverted book: bid=${bid} ask=${ask}` };
  }

  if (bid === null || ask === null || mid === null || spread === null) {
    return { ok: true, detail: "incomplete frame — not a layout claim" };
  }

  // A non-positive mid is REFUSED, never abstained on. `decodeRtFrame` already
  // nulls it (see `midOrNull`), so this is reachable only from a hand-built
  // quote — but this function is exported, and answering "ok" to a division it
  // cannot perform would report a layout VERIFIED having verified nothing. That
  // fail-open is the shape this tripwire exists to prevent.
  if (mid <= 0) {
    return { ok: false, detail: `mid is not a price: ${mid}` };
  }

  if (!(bid <= mid && mid <= ask)) {
    return {
      ok: false,
      detail: `not ordered: bid=${bid} mid=${mid} ask=${ask}`,
    };
  }
  const derived = (ask - bid) / mid;
  const delta = Math.abs(derived - spread);
  return delta <= 1e-6
    ? { ok: true, detail: `derived ${derived} vs reported ${spread}` }
    : {
        ok: false,
        detail: `spread mismatch: derived ${derived}, reported ${spread}`,
      };
}

export interface SubscribePayload {
  eventName: "subscribe" | "unsubscribe";
  authorization: string;
  eventData: { tickers: string[]; thresholdLevel?: number };
}

/**
 * Build a subscribe/unsubscribe payload.
 *
 * `thresholdLevel` is included ONLY when explicitly asked for, and the contract
 * test refuses a payload carrying an unsupported value. See the header: 0 and 5
 * are rejected with a message that reads like an entitlement failure, so a
 * careless default here would look like a licence problem and send someone to
 * the wrong place entirely.
 */
export function buildSubscribePayload(args: {
  token: string;
  tickers: readonly string[];
  event?: "subscribe" | "unsubscribe";
  thresholdLevel?: number;
}): SubscribePayload {
  const level = args.thresholdLevel;
  if (level !== undefined && LEVEL_WIDTH[level] === undefined) {
    throw new Error(
      `thresholdLevel ${level} is not supported by this account. Measured ` +
        "2026-08-31: 0 and 5 are refused with a 400 that reads as an " +
        "entitlement rejection and is not one. Supported: " +
        `${Object.keys(LEVEL_WIDTH).join(", ")}.`,
    );
  }
  return {
    eventName: args.event ?? "subscribe",
    authorization: args.token,
    eventData: {
      tickers: args.tickers.map((t) => t.toLowerCase()),
      ...(level === undefined ? {} : { thresholdLevel: level }),
    },
  };
}
