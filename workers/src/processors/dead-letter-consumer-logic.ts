/**
 * Dead-letter consumer — PURE payload shaping (MONEY-1204, 14a.5a).
 *
 * `workers/scripts/setup-pubsub.sh` has attached a dead-letter policy to every
 * worker push subscription since MONEY-841: after 5 failed deliveries a message
 * is parked on `dead-letter-${ENV}`. Until now NOTHING subscribed to that topic,
 * so a poison payload disappeared into a queue nobody read — the job stopped
 * retrying (good) and nobody found out (bad). This module turns a parked
 * message into something a human can act on.
 *
 * Everything here is a pure function over the push body: no Prisma, no Pub/Sub,
 * no clock beyond what the caller passes in.
 *
 * ## Three rules encoded here, each from a specific failure mode
 *
 * 1. **TRUNCATE.** A Pub/Sub message is up to 10 MB. A Cloud Logging entry is
 *    capped at 256 KB and is BILLED by volume. Logging a dead letter verbatim
 *    turns one poison message into a logging incident.
 * 2. **REDACT.** Job payloads carry broker material — a `csv-import` message
 *    references user uploads, a broker-sync message can carry an access token.
 *    A DLQ log line is the least-guarded place in the system; it must not be
 *    where a token finally leaks.
 * 3. **NEVER THROW.** The caller acks on the strength of this returning. Every
 *    function below is total: malformed, empty, huge, non-JSON, deeply-nested
 *    and cyclic inputs all produce a record instead of an exception.
 *
 * @see workers/src/processors/dead-letter-consumer.ts (I/O shell)
 * @see workers/__tests__/processors/dead-letter-consumer-logic.test.ts
 */

/**
 * Attributes Pub/Sub stamps onto a message when it forwards it to a dead-letter
 * topic. Exported so the test pins the exact spellings — these are Google's,
 * not ours, and a typo would silently produce "unknown" for every field.
 */
export const DLQ_ATTR_SOURCE_SUBSCRIPTION =
  "CloudPubSubDeadLetterSourceSubscription";
export const DLQ_ATTR_SOURCE_PROJECT =
  "CloudPubSubDeadLetterSourceSubscriptionProject";
export const DLQ_ATTR_SOURCE_PUBLISH_TIME =
  "CloudPubSubDeadLetterSourceTopicPublishTime";
export const DLQ_ATTR_DELIVERY_COUNT =
  "CloudPubSubDeadLetterSourceDeliveryCount";

/** Hard cap on the payload excerpt that reaches Cloud Logging. */
export const MAX_PAYLOAD_CHARS = 2_000;

/** Hard cap on the payload excerpt stored on the Notification row. */
export const MAX_NOTIFICATION_PAYLOAD_CHARS = 500;

/** Recursion / breadth caps for redaction — a hostile payload must not be able
 *  to make this walk forever or allocate unboundedly. */
export const MAX_REDACT_DEPTH = 6;
export const MAX_REDACT_ARRAY_ITEMS = 20;
export const MAX_REDACT_OBJECT_KEYS = 50;

/** Placeholder written in place of anything sensitive. */
export const REDACTED = "[REDACTED]";

/**
 * Key names whose VALUE is never safe to log.
 *
 * The repo has no structural (key-based) redactor to reuse —
 * `@usemoney/utils/error-sanitization` maps a whole error STRING to a canned
 * user-facing message, which would replace an entire payload with
 * "Something went wrong" and destroy the diagnostic value of the DLQ record.
 * So this list is local and deliberately GENEROUS: over-redacting a DLQ log
 * line costs a debugging round-trip, under-redacting it leaks a broker token.
 */
const SENSITIVE_KEY_PATTERN =
  /(?:token|secret|passwo?rd|passwd|credential|api[-_]?key|apikey|authoriz|auth[-_]?header|bearer|session|cookie|private[-_]?key|signature|encrypt|access[-_]?code|request[-_]?token|refresh|client[-_]?secret|\botp\b|\bpin\b|checksum)/i;

/**
 * Value shapes that are secrets regardless of the key they hang off.
 *
 * Mirrors the classes `@usemoney/utils/error-sanitization` treats as leaks
 * (connection strings, JWTs, Bearer headers, provider key prefixes) — a job
 * payload that embeds a DATABASE_URL in a free-text `note` field would sail
 * past a key-name check.
 */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\b(?:mongodb(?:\+srv)?|rediss?|postgres(?:ql)?|mysql|amqps?):\/\/\S+/i,
  /\beyJ[A-Za-z0-9._-]{8,}\.[A-Za-z0-9._-]{8,}\.[A-Za-z0-9._-]+/,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/i,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\bAIza[0-9A-Za-z_-]{10,}/,
];

/** True when a key name means "the value is a secret". */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** True when a string LOOKS like a secret regardless of where it came from. */
export function looksSensitive(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((re) => re.test(value));
}

/** Replace secret-shaped substrings inside an otherwise loggable string. */
export function redactString(value: string): string {
  let out = value;
  for (const re of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(
      new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`),
      REDACTED,
    );
  }
  return out;
}

/**
 * Recursively redact a decoded payload.
 *
 * Bounded on every axis (depth, array length, key count) and cycle-safe via a
 * `seen` set, because the input is by definition a message that already broke
 * something. Truncation markers are explicit (`"…+N more"`) so a reader can
 * tell "the field was empty" from "we stopped looking".
 */
export function redactValue(
  value: unknown,
  depth = 0,
  seen: Set<object> = new Set(),
): unknown {
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return `${(value as bigint).toString()}n`;
  if (t === "function" || t === "symbol") return `[${t}]`;

  if (t === "string") {
    const s = value as string;
    return looksSensitive(s) ? redactString(s) : s;
  }

  if (depth >= MAX_REDACT_DEPTH) return "[depth-limit]";

  if (typeof value === "object") {
    if (seen.has(value as object)) return "[circular]";
    seen.add(value as object);

    try {
      if (Array.isArray(value)) {
        const head = value
          .slice(0, MAX_REDACT_ARRAY_ITEMS)
          .map((v) => redactValue(v, depth + 1, seen));
        if (value.length > MAX_REDACT_ARRAY_ITEMS) {
          head.push(`…+${value.length - MAX_REDACT_ARRAY_ITEMS} more`);
        }
        return head;
      }

      const out: Record<string, unknown> = {};
      const keys = Object.keys(value as Record<string, unknown>);
      for (const key of keys.slice(0, MAX_REDACT_OBJECT_KEYS)) {
        const raw = (value as Record<string, unknown>)[key];
        out[key] = isSensitiveKey(key)
          ? REDACTED
          : redactValue(raw, depth + 1, seen);
      }
      if (keys.length > MAX_REDACT_OBJECT_KEYS) {
        out["…truncated"] =
          `+${keys.length - MAX_REDACT_OBJECT_KEYS} more keys`;
      }
      return out;
    } finally {
      // Release the node so a DAG (same object referenced twice on different
      // branches) is not mislabelled "[circular]" — only genuine ancestry is.
      seen.delete(value as object);
    }
  }

  return String(value);
}

/** Truncate with an explicit, countable marker (never a bare ellipsis). */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} of ${value.length} chars]`;
}

/**
 * Serialise anything to a bounded string without ever throwing.
 * `JSON.stringify` can throw on BigInt and on cycles; both are caught.
 */
export function safeStringify(value: unknown, max: number): string {
  try {
    const json = JSON.stringify(value);
    if (typeof json === "string") return truncate(json, max);
    return truncate(String(value), max);
  } catch {
    try {
      return truncate(String(value), max);
    } catch {
      return "[unserializable]";
    }
  }
}

/** Attributes carried on the dead-lettered message. */
export type DlqAttributes = Record<string, string>;

/** The shaped, redacted, truncated record the shell logs and notifies on. */
export interface DeadLetterRecord {
  /** messageId of THIS DLQ delivery — the idempotency key. */
  messageId: string;
  /** Subscription the message died on, e.g. `.../subscriptions/price-sync-qa-push`. */
  sourceSubscription: string;
  /** Job name recovered from the source subscription, e.g. `price-sync`. */
  sourceJob: string;
  /** GCP project of the source subscription, when Pub/Sub reported one. */
  sourceProject: string;
  /** When the message was ORIGINALLY published (not when it was dead-lettered). */
  originalPublishTime: string;
  /** Delivery attempts before Pub/Sub gave up. `null` when not reported. */
  deliveryCount: number | null;
  /** DLQ subscription this arrived on. */
  subscription: string;
  /** Redacted + truncated payload excerpt. */
  payloadExcerpt: string;
  /** True when the payload was not decodable base64 JSON. */
  payloadDecodable: boolean;
  /** Bytes of the ORIGINAL (pre-truncation) decoded payload. */
  payloadBytes: number;
  /** Redacted non-system attributes (system DLQ attrs are hoisted above). */
  attributes: Record<string, string>;
}

/** Attribute names Pub/Sub owns — hoisted into named fields, not re-logged. */
const SYSTEM_ATTRS = new Set<string>([
  DLQ_ATTR_SOURCE_SUBSCRIPTION,
  DLQ_ATTR_SOURCE_PROJECT,
  DLQ_ATTR_SOURCE_PUBLISH_TIME,
  DLQ_ATTR_DELIVERY_COUNT,
]);

/**
 * Recover the job name from a source-subscription resource name.
 *
 * `projects/p/subscriptions/price-sync-qa-push` → `price-sync`. The suffix
 * stripping mirrors the `${BASE_TOPIC}-${ENV}-push` convention in
 * `setup-pubsub.sh`; anything that does not match is returned as-is rather than
 * mangled, because a wrong-but-confident job name sends a responder to the
 * wrong processor.
 */
export function jobNameFromSubscription(subscription: string): string {
  if (!subscription) return "unknown";
  const last = subscription.split("/").pop() ?? subscription;
  const m = /^(.*)-(?:qa|prod|production|local)-push$/.exec(last);
  return m?.[1] ?? last;
}

/** Parse the delivery-count attribute; `null` rather than 0 when unreported. */
export function parseDeliveryCount(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Decode a base64 Pub/Sub payload into a redacted excerpt.
 *
 * Handles: absent data, non-base64, base64 of non-JSON, and base64 of JSON.
 * Non-JSON is NOT discarded — it is redacted as a plain string and kept, since
 * "the payload was not JSON" is frequently the reason the job died.
 */
export function decodePayload(data: unknown): {
  excerpt: string;
  decodable: boolean;
  bytes: number;
} {
  if (typeof data !== "string" || data.length === 0) {
    return { excerpt: "", decodable: false, bytes: 0 };
  }

  let decoded: string;
  try {
    decoded = Buffer.from(data, "base64").toString("utf-8");
  } catch {
    return { excerpt: "[undecodable base64]", decodable: false, bytes: 0 };
  }

  const bytes = Buffer.byteLength(decoded, "utf-8");

  try {
    const parsed: unknown = JSON.parse(decoded);
    return {
      excerpt: safeStringify(redactValue(parsed), MAX_PAYLOAD_CHARS),
      decodable: true,
      bytes,
    };
  } catch {
    // Not JSON. Still useful — redact secret shapes and keep a bounded slice.
    return {
      excerpt: truncate(redactString(decoded), MAX_PAYLOAD_CHARS),
      decodable: false,
      bytes,
    };
  }
}

/** Redact the message's own attribute map (values only; keys are metadata). */
export function redactAttributes(attrs: unknown): Record<string, string> {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return {};
  const out: Record<string, string> = {};
  const entries = Object.entries(attrs as Record<string, unknown>);
  for (const [key, value] of entries.slice(0, MAX_REDACT_OBJECT_KEYS)) {
    if (SYSTEM_ATTRS.has(key)) continue;
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    const str = typeof value === "string" ? value : safeStringify(value, 200);
    out[key] = truncate(looksSensitive(str) ? redactString(str) : str, 200);
  }
  if (entries.length > MAX_REDACT_OBJECT_KEYS) {
    out["…truncated"] =
      `+${entries.length - MAX_REDACT_OBJECT_KEYS} more attributes`;
  }
  return out;
}

/**
 * Shape a raw DLQ push body into a `DeadLetterRecord`.
 *
 * TOTAL by construction — `{}`, `null`, a string, a 10 MB payload and a body
 * whose `message` is an array all return a record. The caller acks on this
 * returning, so a throw here would nack the message straight back onto the one
 * queue that must never grow.
 */
export function buildDeadLetterRecord(body: unknown): DeadLetterRecord {
  const root: Record<string, unknown> =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const rawMessage = root.message;
  const message: Record<string, unknown> =
    rawMessage && typeof rawMessage === "object" && !Array.isArray(rawMessage)
      ? (rawMessage as Record<string, unknown>)
      : {};

  const rawAttrs = message.attributes;
  const attrs: DlqAttributes = {};
  if (rawAttrs && typeof rawAttrs === "object" && !Array.isArray(rawAttrs)) {
    for (const [k, v] of Object.entries(rawAttrs as Record<string, unknown>)) {
      if (typeof v === "string") attrs[k] = v;
    }
  }

  const messageId =
    typeof message.messageId === "string" && message.messageId.trim() !== ""
      ? message.messageId.trim()
      : "";

  const sourceSubscription = attrs[DLQ_ATTR_SOURCE_SUBSCRIPTION] ?? "";
  const payload = decodePayload(message.data);

  return {
    messageId,
    sourceSubscription: sourceSubscription || "unknown",
    sourceJob: jobNameFromSubscription(sourceSubscription),
    sourceProject: attrs[DLQ_ATTR_SOURCE_PROJECT] ?? "unknown",
    originalPublishTime:
      attrs[DLQ_ATTR_SOURCE_PUBLISH_TIME] ??
      (typeof message.publishTime === "string"
        ? message.publishTime
        : "unknown"),
    deliveryCount: parseDeliveryCount(attrs[DLQ_ATTR_DELIVERY_COUNT]),
    subscription:
      typeof root.subscription === "string" ? root.subscription : "unknown",
    payloadExcerpt: payload.excerpt,
    payloadDecodable: payload.decodable,
    payloadBytes: payload.bytes,
    attributes: redactAttributes(attrs),
  };
}

/** The founder-facing notification built from a record. */
export interface DeadLetterNotification {
  title: string;
  message: string;
  metadata: Record<string, unknown>;
}

/**
 * Build the in-app notification.
 *
 * Says what died, how many times it was tried, and — explicitly — that nothing
 * will retry it. The last part matters: a reader who assumes "the queue will
 * get to it" takes no action, and a dead letter's whole point is that no
 * automatic recovery is coming.
 */
export function buildDeadLetterNotification(
  record: DeadLetterRecord,
): DeadLetterNotification {
  const attempts =
    record.deliveryCount === null
      ? "the configured maximum number of"
      : `${record.deliveryCount}`;

  return {
    title: `Job dead-lettered: ${record.sourceJob}`,
    message:
      `A ${record.sourceJob} message failed ${attempts} delivery attempts and was parked ` +
      `on the dead-letter queue. It will NOT be retried automatically — re-publish it ` +
      `manually once the cause is fixed. Original publish time: ${record.originalPublishTime}.`,
    metadata: {
      messageId: record.messageId,
      sourceJob: record.sourceJob,
      sourceSubscription: record.sourceSubscription,
      sourceProject: record.sourceProject,
      originalPublishTime: record.originalPublishTime,
      deliveryCount: record.deliveryCount,
      payloadDecodable: record.payloadDecodable,
      payloadBytes: record.payloadBytes,
      // A second, tighter cap: this one is persisted on a DB row and rendered
      // in the notification UI, not just streamed to Cloud Logging.
      payloadExcerpt: truncate(
        record.payloadExcerpt,
        MAX_NOTIFICATION_PAYLOAD_CHARS,
      ),
    },
  };
}

/**
 * Emails to notify. `DLQ_ALERT_EMAILS` → `ADMIN_EMAILS` → the founder default,
 * matching the precedence in `packages/auth/src/admin.ts` (whose constant is
 * not exported, and which `@usemoney/workers` does not depend on).
 */
export const DEFAULT_DLQ_ALERT_EMAILS = ["deepshaswat@gmail.com"];

export interface DlqAlertEnv {
  /** Explicit DLQ recipient list (CSV). */
  DLQ_ALERT_EMAILS?: string;
  /** Shared admin list, same var `packages/auth/src/admin.ts` reads. */
  ADMIN_EMAILS?: string;
  /** Keeps this assignable from `NodeJS.ProcessEnv`, which has an index
   *  signature — same trick as `PullSubscriberEnv` in `index-logic.ts`. */
  [key: string]: string | undefined;
}

export function resolveDlqAlertEmails(env: DlqAlertEnv): string[] {
  const raw = env.DLQ_ALERT_EMAILS ?? env.ADMIN_EMAILS ?? "";
  const parsed = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  return parsed.length > 0 ? parsed : DEFAULT_DLQ_ALERT_EMAILS;
}
