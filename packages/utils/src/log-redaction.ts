/**
 * Log-payload redaction — MONEY-1209.
 *
 * ## Why this is a sibling of `error-sanitization.ts` and not part of it
 *
 * `error-sanitization.ts` rewrites an error into something a USER should read:
 * it maps "MongoServerSelectionError" to "Service temporarily unavailable". Its
 * failure mode is a confusing toast. This module rewrites what a LOG SINK
 * should read: it keeps every technical detail an engineer needs and removes
 * only the credentials. Its failure mode is publishing a live session cookie to
 * Cloud Logging, where it is retained, indexed, and readable by anyone with
 * project log access. Two different audiences, two different blast radii —
 * overloading one function with both jobs guarantees that a future edit tuned
 * for one of them silently regresses the other.
 *
 * ## The bug this exists for
 *
 * `workers/src` has ~156 `console.error` call sites and most of them end in
 * `console.error("[job] failed:", err)`. When `err` is a ky/got/axios HTTP
 * error, Node's `util.inspect` walks the error's own enumerable properties and
 * prints them. For a ky `HTTPError` those properties are `request` (a real
 * `Request`) and `options` (the normalized request options) — i.e. the exact
 * objects that carry the credentialed headers we just sent. Verified output
 * from an unredacted `console.error(err)`:
 *
 *     Error [HTTPError]: Request failed with status code 403 Forbidden
 *         at ...
 *       request: Request {
 *         method: 'GET',
 *         url: 'https://www.nseindia.com/api/x',
 *         headers: Headers { cookie: 'ak_bmsc=<live session>; bm_sz=<live session>' },
 *         ...
 *       },
 *       options: { headers: { authorization: 'Bearer <token>' }, ... }
 *
 * ## `util.inspect`'s depth limit does NOT contain this
 *
 * The obvious mitigation — "inspect only goes 2 levels deep, so a header value
 * at level 3 is already elided as [Object]" — is false here, and measurably so.
 * `Request` and `Headers` (undici) both define `[util.inspect.custom]`, so they
 * render as ONE inspected leaf that inlines their entire contents regardless of
 * the surrounding depth budget. The line above was produced at inspect's
 * DEFAULT depth of 2. Anything that reasons about nesting level as a safety
 * property is reasoning about the wrong thing.
 *
 * That is also why the walker below never returns a live object it did not
 * construct: the guarantee is not "we nulled some fields", it is **the return
 * value is inert plain data** (primitives, plain objects, arrays, and a freshly
 * built `Error`), so no custom inspector — known or future — can re-expand
 * something we thought we had removed.
 *
 * ## Both rules are required
 *
 * Redacting by KEY alone misses a whole cookie jar joined into one string and
 * parked under a non-sensitive key (`{ sessionHeader: "ak_bmsc=...; bm_sz=..." }`,
 * or any `JSON.stringify(err)` that a call site did before logging). Scanning
 * VALUES alone misses an opaque credential with no recognisable shape, which is
 * every API key we hold. Neither rule subsumes the other; both run on every
 * node.
 */

/** Marker written in place of a redacted value. */
export const REDACTED = "[REDACTED]";
/** Marker written when a value could not be read or walked at all. */
export const UNSERIALIZABLE = "[unserializable]";
/** Marker written when the depth or node budget ran out. */
export const TRUNCATED = "[truncated]";
/** Marker written when a node is its own ancestor. */
export const CIRCULAR = "[Circular]";

/**
 * Keys whose VALUE is a credential, matched against the whole key.
 *
 * Anchored rather than a substring test on purpose: a substring rule would eat
 * `tokenCount`, `apiKeyId`, `secretsManagerRegion` and `passwordPolicy`, which
 * are diagnostics, not credentials — and a log that hides the diagnostics is a
 * log people stop reading, which is how the next leak goes unnoticed.
 *
 * MONEY-1229 — THE COMPOUND NAMES ARE SPELLED OUT, NOT REACHED WITH A SUFFIX
 * RULE, and that is measured rather than taste. A `\w+[-_]?token$` rule would
 * be shorter and would also blank this repo's `instrument_token` (92 uses),
 * `instrumentToken` (45), `symboltoken` (48) and `exchangeToken` (41) — every
 * one of them a Kite/SmartAPI INSTRUMENT IDENTIFIER, not a credential. That
 * turns every market-data log line into `[REDACTED]`, which is exactly the
 * "log people stop reading" failure the anchoring exists to avoid. So the list
 * grows by NAME, and the stated ceiling is that a credential spelled some
 * other way is not covered here.
 *
 * The six names after `password` are the ones pino's `redact` wildcards used to
 * cover — at exactly ONE level of nesting — until `a92bcc32` dropped them for
 * costing 6-11x a log line. `formatters.log` in `packages/logger/src/config.ts`
 * now reaches them at EVERY depth, but only for the names this pattern knows:
 * widening it is the other half of that fix, not a separate cleanup.
 */
export const SENSITIVE_KEY_PATTERN =
  /^(cookie|set-cookie|authorization|x-api-key|api[-_]?key|api[-_]?secret|token|secret|password|(access|refresh|session|id)[-_]?token|client[-_]?secret|(database|redis)[-_]?url)$/i;

/**
 * Session cookie names masked wherever they appear inside a STRING.
 *
 * MONEY-1209 names three (`ak_bmsc`, `bm_mi`, `bm_sz`); the rest of the list is
 * the remainder of the same jar. NSE's gate is Akamai Bot Manager
 * (`ak_bmsc`, `bm_*`, `_abck`) plus NSE's own `nsit` / `nseappid`, and they all
 * travel in ONE `Cookie:` header. Masking three of seven out of a joined cookie
 * string leaves a session that is still replayable, so the useful unit here is
 * the jar, not the three names the ticket happened to observe.
 */
export const SESSION_COOKIE_NAMES = [
  "ak_bmsc",
  "bm_mi",
  "bm_sz",
  "bm_sv",
  "_abck",
  "nsit",
  "nseappid",
] as const;

/**
 * The value half of `name=value`, stopping at the separators that end a cookie
 * value in the wild: `;` and `,` in a real header, and `"` / `'` / `\` because
 * a very common call site is `console.error(msg, JSON.stringify(err))` — there
 * the value is followed by the closing quote of a JSON string, and swallowing
 * that quote would leave a mangled, unparseable log line behind.
 */
const COOKIE_VALUE_CHARS = `[^;,\\s"'\\\\]*`;

const SESSION_COOKIE_RE = new RegExp(
  `\\b(${SESSION_COOKIE_NAMES.join("|")})=${COOKIE_VALUE_CHARS}`,
  "gi",
);

/**
 * `Basic` rides along with `Bearer`: it is base64, not encryption, and every
 * broker adapter that sends one is one `console.error(err)` away from printing
 * a decodable username:password pair.
 */
const AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+[^\s"'\\,;]+/gi;

/**
 * Mask credential-shaped substrings inside a single string.
 *
 * Exported because the string rule has to be reachable on its own: a call site
 * that has already collapsed an error into a message (`String(err)`,
 * `err.message`, a `JSON.stringify`) has no object left for the walker to
 * traverse, and that string is still the leak.
 */
export function maskSensitiveText(text: string): string {
  return text
    .replace(
      SESSION_COOKIE_RE,
      (_match: string, name: string) => `${name}=${REDACTED}`,
    )
    .replace(
      AUTH_SCHEME_RE,
      (_match: string, scheme: string) => `${scheme} ${REDACTED}`,
    );
}

/**
 * Total nodes one `redactSensitive` call may visit.
 *
 * The cycle guard drops a node from the ancestor set on the way OUT, which is
 * what makes `[Circular]` mean "is its own ancestor" rather than "was seen
 * somewhere else already" — a shared-but-acyclic subtree stays readable. The
 * cost of that accuracy is that a diamond-shaped graph is walked once per PATH,
 * so a wide shared payload could cost fan-out^depth. This budget makes the
 * worst case flat instead of exponential. It runs on the logging path of a
 * worker that must not be taken down by the shape of an error object.
 */
const NODE_BUDGET = 5_000;

interface WalkContext {
  /** Ancestors of the node currently being walked (cycle detection). */
  readonly seen: WeakSet<object>;
  /** Mutable remaining node budget, shared across the whole walk. */
  remaining: number;
}

/**
 * Deep-copy `value` with every credential removed, for logging.
 *
 * Never throws. Any value that cannot be read or walked — a Proxy that traps
 * `ownKeys`, a getter that throws, a revoked Proxy, a cross-realm exotic —
 * degrades to {@link UNSERIALIZABLE} for that node only; the rest of the
 * payload still gets logged. A redactor that can throw is worse than no
 * redactor, because it converts "a log line with a secret in it" into "no log
 * line and a crashed handler".
 *
 * @param value Anything: an Error, a response body, a string, a Buffer.
 * @param depth How many levels below the root to walk. Deeper nodes collapse to
 *   {@link TRUNCATED} — which is safe by construction, since a truncated node is
 *   not printed at all.
 */
export function redactSensitive(value: unknown, depth = 6): unknown {
  return walk(value, depth, {
    seen: new WeakSet<object>(),
    remaining: NODE_BUDGET,
  });
}

/** The never-throws boundary. Every recursive edge goes through here. */
function walk(value: unknown, depth: number, ctx: WalkContext): unknown {
  try {
    return walkValue(value, depth, ctx);
  } catch {
    return UNSERIALIZABLE;
  }
}

function walkValue(value: unknown, depth: number, ctx: WalkContext): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case "string":
      return maskSensitiveText(value);
    case "number":
    case "boolean":
    case "bigint":
      return value;
    case "symbol":
      return String(value);
    case "function":
      // Printing a function body in a log is noise at best; at worst it is a
      // closure whose source contains a hard-coded key.
      return `[Function: ${readName(value) || "anonymous"}]`;
    default:
      break;
  }

  const obj = value as object;

  // Ancestor check BEFORE the budget check, so a self-referential node reports
  // the reason it stopped rather than looking like it ran out of room.
  if (ctx.seen.has(obj)) return CIRCULAR;
  if (depth <= 0) return TRUNCATED;
  if (ctx.remaining <= 0) return TRUNCATED;
  ctx.remaining -= 1;

  ctx.seen.add(obj);
  try {
    return walkObject(obj, depth, ctx);
  } finally {
    ctx.seen.delete(obj);
  }
}

function walkObject(obj: object, depth: number, ctx: WalkContext): unknown {
  // Leaves that must not be walked as bags of properties.
  if (obj instanceof Date) return obj;
  if (obj instanceof RegExp) return obj;
  // A URL can carry a credential in its query string, so it is masked as text
  // rather than passed through.
  if (obj instanceof URL) return maskSensitiveText(obj.toString());
  if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) {
    return describeBinary(obj);
  }

  if (obj instanceof Error) return redactError(obj, depth, ctx);
  if (Array.isArray(obj)) {
    return obj.map((item) => walk(item, depth - 1, ctx));
  }
  if (obj instanceof Map) return mapToRecord(obj, depth, ctx);
  if (obj instanceof Set) {
    return [...obj].map((item) => walk(item, depth - 1, ctx));
  }

  // Fetch/undici shapes. These are handled explicitly, not because the generic
  // walk would leak them — `Object.keys(new Request(...))` is `[]`, so the
  // generic path would emit a useless `{}` — but because the method, URL and
  // status are the three facts an engineer actually needs off a failed HTTP
  // call, and dropping them is how a redactor gets ripped back out.
  if (isHeaders(obj)) return headersToRecord(obj);
  if (isRequest(obj)) {
    return {
      __type: "Request",
      method: obj.method,
      url: maskSensitiveText(obj.url),
      headers: headersToRecord(obj.headers),
    };
  }
  if (isResponse(obj)) {
    return {
      __type: "Response",
      status: obj.status,
      statusText: obj.statusText,
      url: maskSensitiveText(obj.url),
      // `set-cookie` is how NSE HANDS us the session in the first place, so a
      // response's headers are as sensitive as a request's.
      headers: headersToRecord(obj.headers),
    };
  }

  return walkPlain(obj, depth, ctx);
}

/**
 * Walk own enumerable string keys.
 *
 * Both the key enumeration and each property READ are individually guarded:
 * `Object.keys` can throw on a Proxy with an `ownKeys` trap, and a plain
 * accessor property can throw on get. Failing the whole payload because one
 * getter is unhappy would lose the other twenty fields that explain the bug.
 */
function walkPlain(
  obj: object,
  depth: number,
  ctx: WalkContext,
): Record<string, unknown> | string {
  let keys: string[];
  try {
    keys = Object.keys(obj);
  } catch {
    return UNSERIALIZABLE;
  }

  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = redactEntry(obj, key, depth, ctx);
  }
  return out;
}

/** Read one property and redact it, by key rule first then by value walk. */
function redactEntry(
  source: object,
  key: string,
  depth: number,
  ctx: WalkContext,
): unknown {
  // The key rule fires BEFORE the read. A property named `cookie` is never
  // worth reading, and not reading it also sidesteps any side effect or throw
  // hiding behind that particular getter.
  if (SENSITIVE_KEY_PATTERN.test(key)) return REDACTED;

  let raw: unknown;
  try {
    raw = (source as Record<string, unknown>)[key];
  } catch {
    return UNSERIALIZABLE;
  }
  return walk(raw, depth - 1, ctx);
}

/**
 * Rebuild an Error as a fresh Error.
 *
 * A plain object would be safe too, but `console.error` and every log ingester
 * key their stack-trace handling off a real Error, and the stack is the whole
 * point of logging the thing. The reconstruction is what strips any inherited
 * custom inspector along with the raw `request` / `options` / `config` /
 * `response` subtrees — those come back only through {@link redactEntry}, so a
 * ky `options.headers.cookie`, a got `options.headers.authorization` and an
 * axios `config.headers` are all redacted by the same key rule, and
 * `response.headers` by the `Headers` handler above.
 *
 * `message` and `stack` are preserved, but still run through the string mask:
 * a 403 handler that interpolates the request into its message is exactly how
 * a cookie ends up inside `err.message` with no object left to walk.
 */
function redactError(err: Error, depth: number, ctx: WalkContext): Error {
  const out = new Error(maskSensitiveText(readMessage(err)));
  out.name = readName(err) || "Error";

  const stack = readStack(err);
  // Assigning `undefined` would print `undefined` where a stack belongs;
  // deleting leaves Node's own "no stack" rendering intact.
  if (stack === undefined) delete (out as { stack?: string }).stack;
  else out.stack = maskSensitiveText(stack);

  // `cause` is non-enumerable when set via `new Error(msg, { cause })`, so
  // `Object.keys` below never sees it — and an HTTP error's cause is routinely
  // the transport error that still holds the request.
  const cause = readCause(err);
  if (cause !== undefined) {
    Object.defineProperty(out, "cause", {
      value: walk(cause, depth - 1, ctx),
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }

  let keys: string[];
  try {
    keys = Object.keys(err);
  } catch {
    return out;
  }
  for (const key of keys) {
    // Already handled above; re-copying `name` would also make it show up
    // twice in `util.inspect` output.
    if (key === "name" || key === "message" || key === "stack") continue;
    Object.defineProperty(out, key, {
      value: redactEntry(err, key, depth, ctx),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function mapToRecord(
  map: Map<unknown, unknown>,
  depth: number,
  ctx: WalkContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of map) {
    const name = typeof key === "string" ? key : safeString(key);
    out[name] = SENSITIVE_KEY_PATTERN.test(name)
      ? REDACTED
      : walk(value, depth - 1, ctx);
  }
  return out;
}

/**
 * Flatten a `Headers` bag to a plain record with the key rule applied.
 *
 * `Headers` lowercases every name it stores, which is why the anchored,
 * case-insensitive key pattern is enough here and no normalisation is needed.
 */
function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    headers.forEach((value, name) => {
      out[name] = SENSITIVE_KEY_PATTERN.test(name)
        ? REDACTED
        : maskSensitiveText(value);
    });
  } catch {
    return { __headers: UNSERIALIZABLE };
  }
  return out;
}

function describeBinary(value: object): string {
  const name = readName((value as { constructor?: unknown }).constructor);
  let bytes = -1;
  try {
    bytes = ArrayBuffer.isView(value)
      ? value.byteLength
      : (value as ArrayBuffer).byteLength;
  } catch {
    /* exotic view — fall through to the unknown-length form */
  }
  const label = name || "Binary";
  return bytes >= 0 ? `[${label} ${bytes} bytes]` : `[${label}]`;
}

// ─── Guarded readers ────────────────────────────────────────────────
// Everything below reads a property off a value we do not control. Each read
// is wrapped because the value may be a Proxy, may be cross-realm, or may have
// a throwing accessor — and the whole contract of this module is that it does
// not throw.

function readName(value: unknown): string {
  try {
    const name = (value as { name?: unknown } | null | undefined)?.name;
    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}

function readMessage(err: Error): string {
  try {
    return typeof err.message === "string" ? err.message : safeString(err);
  } catch {
    return UNSERIALIZABLE;
  }
}

function readStack(err: Error): string | undefined {
  try {
    return typeof err.stack === "string" ? err.stack : undefined;
  } catch {
    return undefined;
  }
}

function readCause(err: Error): unknown {
  try {
    return (err as { cause?: unknown }).cause;
  } catch {
    return undefined;
  }
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return UNSERIALIZABLE;
  }
}

// ─── Structural type guards ─────────────────────────────────────────
// `typeof X === "function"` first: these globals exist in Node 18+ and in the
// browser, but this package is imported from client bundles too and a bare
// `instanceof` against a missing global is a ReferenceError, not a `false`.

function isHeaders(value: object): value is Headers {
  return typeof Headers === "function" && value instanceof Headers;
}

function isRequest(value: object): value is Request {
  return typeof Request === "function" && value instanceof Request;
}

function isResponse(value: object): value is Response {
  return typeof Response === "function" && value instanceof Response;
}
