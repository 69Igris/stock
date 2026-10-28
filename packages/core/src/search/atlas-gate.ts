/**
 * Atlas Search gate — the ONE place that decides "Atlas `$search` vs the
 * Prisma/regex fallback", the ONE place that latches Atlas off, and the ONE
 * place that reports either transition. (MONEY-1128)
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ───────────────────────────────────────────────────────────────────────────
 * Four subsystems each carried a private copy of the same three things:
 *
 *   apps/web/lib/market/atlas-search.ts
 *   apps/web/lib/market/content-search.ts
 *   apps/content/lib/atlas-user-search.ts
 *   packages/services/src/discover.service.ts
 *
 *   1. `(process.env.DATABASE_URL ?? "").includes("mongodb.net")` — a substring
 *      sniff on the connection string with NO override, so QA/local (raw-IP
 *      Mongo URL) could never exercise the Atlas path at all, and prod could
 *      never be moved off it without a deploy.
 *   2. A private 5-minute `atlasUnavailableUntil` latch. Four independent
 *      latches meant one subsystem falling back left the others believing
 *      Atlas was healthy.
 *   3. A classifier that treated ANY message containing `$search` or
 *      `PlanExecutor` as "Atlas Search is unavailable".
 *
 * (3) was the production bug. A loaded Atlas cluster answers with
 * `PlanExecutor error during aggregation :: caused by :: operation exceeded
 * time limit` (or a `QueryPlanKilled` / `PlanExecutorKilled`) — a LOAD signal.
 * The old predicate promoted that into five process-wide minutes of the regex
 * fallback, which at production data volume is a double collection scan
 * (`InstrumentMapping` has no index on `name`, the `OR` prevents an index
 * union, and the second pass is an unanchored case-insensitive `contains`) —
 * i.e. strictly MORE expensive than the query that "failed". A positive
 * feedback loop, and completely silent: no log, no metric, no alert, with the
 * response's `source` field as the only tell.
 *
 * So this module draws the line at DETERMINISM, not at severity:
 *
 *   • Will the NEXT request fail for the same reason no matter how healthy the
 *     cluster is? (missing stage, search not enabled, index absent/building)
 *     → deterministic → LATCH, because retrying is pure waste.
 *   • Did this request lose a race with load, time, or the network?
 *     (timeout, executor kill, interrupt, pool/socket churn) → transient →
 *     serve THIS request from the fallback and leave the gate OPEN, because
 *     the next request very likely succeeds and latching would amplify the
 *     very load that caused it.
 *
 * Anything we cannot positively identify is rethrown, exactly as before — a
 * silent fallback on an unknown error is how the original defect hid.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SCOPE OF A LATCH
 * ───────────────────────────────────────────────────────────────────────────
 * Deployment-level failures ("`$search` is not a thing here") latch EVERY
 * index — that is the shared-state fix, and the case QA actually hits.
 * Index-level failures ("`content_search` not found") latch only that index,
 * so a missing content index can never take instrument search down with it.
 */

import { getLogger } from "@usemoney/logger";
import { metrics } from "@usemoney/datadog/metrics";

// ─────────────────────────────────────────────────────────────────────────────
// Public constants
// ─────────────────────────────────────────────────────────────────────────────

/** How long a latched index/deployment stays on the regex fallback. */
export const ATLAS_RETRY_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Atlas Search index names. Shared so `apps/web` and `packages/services` latch
 * the SAME key — both query `instrument_search` / `mf_search`, and before this
 * they kept separate flags for them.
 */
export const SEARCH_INDEX = {
  INSTRUMENTS: "instrument_search",
  MUTUAL_FUNDS: "mf_search",
  CONTENT: "content_search",
  USERS: "user_search",
} as const;

export type SearchIndexName = (typeof SEARCH_INDEX)[keyof typeof SEARCH_INDEX];

/** Which search implementation a request should use. */
export type SearchBackend = "atlas" | "regex";

/**
 * What a failed `$search` actually means.
 *
 * - `deployment-unavailable` — `$search` does not exist on this deployment
 *   (non-Atlas Mongo, Atlas Search not enabled). Deterministic, cluster-wide.
 * - `index-unavailable` — the named index is missing or not yet queryable.
 *   Deterministic, but scoped to that index.
 * - `transient` — timeout / executor kill / interrupt / connectivity. NOT a
 *   capability statement; the next request may well succeed.
 * - `unrelated` — not recognisable as any of the above; rethrown.
 */
export type SearchErrorKind =
  | "deployment-unavailable"
  | "index-unavailable"
  | "transient"
  | "unrelated";

export interface SearchErrorClassification {
  kind: SearchErrorKind;
  /** Id of the predicate that matched — the alert/dashboard dimension. */
  matcher: string;
  /** MongoDB server error code when one could be recovered from the error. */
  code: number | null;
}

/** What the caller should do after `reportSearchFailure`. */
export type SearchFailureAction = "fallback" | "rethrow";

export interface SearchFailureInput {
  /** Atlas Search index the failing query targeted. */
  index: string;
  /** Caller identity for logs/metrics, e.g. `"market.instruments"`. */
  subsystem: string;
  /** The thrown value, unmodified. */
  error: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

interface Matcher {
  id: string;
  pattern: RegExp;
}

/**
 * Load / time / network signals. Checked FIRST and allowed to win, because a
 * genuinely-unavailable deployment never mentions a timeout, whereas an
 * overloaded one very often names the `$search` stage or `PlanExecutor` that
 * happened to be running when the deadline hit. That asymmetry is the whole
 * bug: `PlanExecutor` is a *location*, not a diagnosis.
 */
const TRANSIENT_MATCHERS: readonly Matcher[] = [
  {
    id: "plan-executor-killed",
    pattern: /plan[\s_]?executor[\s_]?killed|queryplankilled/,
  },
  {
    id: "interrupted",
    pattern:
      /\binterrupted\b|interruptedatshutdown|interrupteddueto|operation was interrupted/,
  },
  {
    id: "time-limit-exceeded",
    pattern:
      /exceeded time limit|maxtimemsexpired|max time ms expired|operation exceeded/,
  },
  { id: "timeout", pattern: /timed out|timeout/ },
  {
    id: "connectivity",
    pattern:
      /socketexception|socket exception|connection (?:was )?(?:closed|reset|refused)|network error|networkerror|no connection available|pool (?:was )?cleared|server selection|topology (?:was |is )?(?:closed|destroyed)|not (?:writable )?primary|primary stepped down|shutdown in progress|host ?unreachable|host ?not ?found/,
  },
  {
    // mongot (the Atlas Search process) being down is an infra blip, not a
    // capability statement: it fails FAST, so paying one refused connection per
    // request costs far less than latching 5 minutes of collection scan on a
    // blip that may last seconds. Deliberately worded so it cannot swallow
    // "Atlas Search is not available", which IS a capability statement.
    id: "search-node-down",
    pattern:
      /no healthy upstream|service unavailable|mongot[\s\S]{0,120}unavailable/,
  },
  {
    id: "overloaded",
    pattern:
      /too many requests|rate limit|resource exhausted|resourceexhausted|temporarily unavailable|try again later/,
  },
];

/** "`$search` does not exist on this deployment." Cluster-wide + permanent. */
const DEPLOYMENT_MATCHERS: readonly Matcher[] = [
  { id: "stage-unrecognized", pattern: /unrecognized pipeline stage/ },
  {
    id: "search-not-enabled",
    pattern:
      /searchnotenabled|search is not enabled|atlas search is not (?:enabled|available|supported)/,
  },
  {
    // Covers the shared/free-tier wording too ("$search is not supported on
    // this cluster tier"), which is just as permanent as an absent stage.
    id: "search-not-allowed",
    pattern:
      /\$search(?:meta)? (?:stage )?(?:is )?not (?:allowed|supported|available|enabled)|only (?:allowed|supported) on (?:mongodb )?atlas/,
  },
];

/**
 * LAST RESORT. Matched only after every specific matcher above has declined.
 *
 * Every mongot-side failure reaches the driver wrapped in an aggregation
 * envelope — `PlanExecutor error during aggregation :: caused by :: Remote
 * error from mongot :: caused by :: <reason>` — and `<reason>` is an open set
 * (bad operator, unindexed path, malformed query, wordings not yet invented).
 * The pre-MONEY-1128 gate caught the whole family with a bare
 * `msg.includes("PlanExecutor")`, so any such failure degraded to the regex
 * path. Classifying only the *named* reasons regressed that: an unrecognised
 * reason fell through to `unrelated` and was rethrown, which the search routes
 * turn into an HTTP 500 where they previously returned degraded-but-real
 * results. Measured: 3 of 6 realistic mongot messages flipped fallback →
 * rethrow.
 *
 * So the envelope itself is the signal of last resort: "the request reached
 * $search and $search is what failed" ⇒ serve the fallback.
 *
 * `transient` (fall back, do NOT latch) rather than a latching kind, because
 * the envelope says nothing about duration. Some reasons here are permanent
 * config bugs where latching would actually be cheaper — but latching on a
 * misread costs five minutes of collection scan, and this bucket exists
 * precisely for reasons we could not identify. The `matcher` id lands in the
 * warn log, so an envelope that shows up repeatedly is visible and can be
 * promoted to a specific matcher above.
 *
 * ORDER IS LOAD-BEARING: this is checked after DEPLOYMENT and INDEX matchers,
 * so a real "index not found" that happens to arrive inside a PlanExecutor
 * envelope still latches as `index-unavailable` instead of being flattened to
 * a generic transient.
 */
const SEARCH_STAGE_MATCHERS: readonly Matcher[] = [
  {
    id: "search-stage-generic",
    pattern:
      /remote error from mongot|plan[\s_]?executor error|\$search(?:meta)?\b/,
  },
];

/** "That index is missing / still building." Permanent, but index-scoped. */
const INDEX_MATCHERS: readonly Matcher[] = [
  {
    id: "index-not-found",
    // Covers both `index not found` and Atlas's
    // `Search index with name "instrument_search" not found`.
    pattern:
      /index not found|indexnotfound|no such index|index[\s\S]{0,120}?not found/,
  },
  {
    id: "index-not-queryable",
    pattern: /not queryable|index is building|still building/,
  },
];

/**
 * Server error codes that mean "this request lost a race", never "this feature
 * is missing": HostUnreachable(6), HostNotFound(7), MaxTimeMSExpired(50),
 * NetworkTimeout(89), ShutdownInProgress(91), QueryPlanKilled(175),
 * PrimarySteppedDown(189), NetworkInterfaceExceededTimeLimit(202),
 * ExceededTimeLimit(262), SocketException(9001), NotWritablePrimary(10107),
 * Interrupted*(11600-11602), NotPrimaryNoSecondaryOk(13435/13436).
 */
const TRANSIENT_CODES: ReadonlySet<number> = new Set([
  6, 7, 50, 89, 91, 175, 189, 202, 262, 9001, 10107, 11600, 11601, 11602, 13435,
  13436,
]);

/** Location40324 = "Unrecognized pipeline stage name". */
const DEPLOYMENT_CODES: ReadonlySet<number> = new Set([40324]);

/** IndexNotFound. */
const INDEX_CODES: ReadonlySet<number> = new Set([27]);

const MAX_CAUSE_DEPTH = 5;

/**
 * Flatten an error (plus its `cause` chain, Prisma's `meta`, and Mongo's
 * `errmsg`/`codeName`) into one lowercase haystack. Prisma wraps the server
 * message inside `Raw query failed. Code: \`40324\`. Message: \`…\``, and
 * drivers nest the real reason under `cause`, so matching only `error.message`
 * misses the diagnosis in both directions.
 */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  for (let depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") {
      parts.push(String(current));
      break;
    }
    const record = current as Record<string, unknown>;
    for (const key of ["message", "errmsg", "codeName"]) {
      const value = record[key];
      if (typeof value === "string") parts.push(value);
    }
    const meta = record.meta;
    if (meta !== null && typeof meta === "object") {
      const metaMessage = (meta as Record<string, unknown>).message;
      if (typeof metaMessage === "string") parts.push(metaMessage);
    }
    current = record.cause;
  }

  return parts.join(" | ").toLowerCase();
}

function numericCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

/**
 * Recover the MongoDB server error code. Prisma surfaces it three different
 * ways depending on how the raw command failed — `meta.code` (P2010),
 * `Error code 175 (QueryPlanKilled)` inside the message, or a plain numeric
 * `code` from the driver — and `error.code` itself is often the Prisma code
 * (`"P2010"`), which is deliberately NOT numeric and therefore skipped.
 */
export function extractMongoErrorCode(error: unknown): number | null {
  let current: unknown = error;

  for (let depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object") break;
    const record = current as Record<string, unknown>;

    const direct = numericCode(record.code);
    if (direct !== null) return direct;

    const meta = record.meta;
    if (meta !== null && typeof meta === "object") {
      const fromMeta = numericCode((meta as Record<string, unknown>).code);
      if (fromMeta !== null) return fromMeta;
    }

    current = record.cause;
  }

  const text = errorText(error);
  const match =
    /error code (\d{1,5})/.exec(text) ?? /code:?\s*`?(\d{1,5})`?/.exec(text);
  return match ? Number(match[1]) : null;
}

function firstMatch(text: string, matchers: readonly Matcher[]): string | null {
  for (const matcher of matchers) {
    if (matcher.pattern.test(text)) return matcher.id;
  }
  return null;
}

/**
 * Classify a `$search` failure. Pure — no state, no I/O.
 *
 * Precedence is deliberate: transient CODE, transient MESSAGE, deployment,
 * index, unrelated. Codes outrank text because they are unambiguous; transient
 * outranks unavailable because a timeout message routinely also names
 * `$search`/`PlanExecutor` while an unavailable deployment never names a
 * timeout.
 */
export function classifySearchError(error: unknown): SearchErrorClassification {
  const code = extractMongoErrorCode(error);
  const text = errorText(error);

  if (code !== null && TRANSIENT_CODES.has(code)) {
    return { kind: "transient", matcher: `code:${code}`, code };
  }

  const transient = firstMatch(text, TRANSIENT_MATCHERS);
  if (transient) return { kind: "transient", matcher: transient, code };

  if (code !== null && DEPLOYMENT_CODES.has(code)) {
    return { kind: "deployment-unavailable", matcher: `code:${code}`, code };
  }

  const deployment = firstMatch(text, DEPLOYMENT_MATCHERS);
  if (deployment) {
    return { kind: "deployment-unavailable", matcher: deployment, code };
  }

  if (code !== null && INDEX_CODES.has(code)) {
    return { kind: "index-unavailable", matcher: `code:${code}`, code };
  }

  const index = firstMatch(text, INDEX_MATCHERS);
  if (index) return { kind: "index-unavailable", matcher: index, code };

  // Last resort — see the note on SEARCH_STAGE_MATCHERS. Restores the
  // pre-MONEY-1128 behaviour of degrading (rather than 500-ing) on any
  // failure that came out of the $search stage itself.
  const stage = firstMatch(text, SEARCH_STAGE_MATCHERS);
  if (stage) return { kind: "transient", matcher: stage, code };

  return { kind: "unrelated", matcher: "unclassified", code };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate
// ─────────────────────────────────────────────────────────────────────────────

/** Structural subset of a pino logger — lets tests record emissions. */
export interface SearchGateLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

/** Structural subset of `@usemoney/datadog`'s metrics client. */
export interface SearchGateMetrics {
  increment(name: string, value?: number, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
}

export interface SearchGateDeps {
  now: () => number;
  env: () => Record<string, string | undefined>;
  logger: SearchGateLogger;
  metrics: SearchGateMetrics;
  retryIntervalMs: number;
}

export interface SearchGate {
  /** Configured backend (env only — ignores latches). */
  resolveBackend(): SearchBackend;
  /** True when this request may issue `$search` against `index`. */
  isAtlasEnabled(index: string, subsystem: string): boolean;
  /** Classify + record a `$search` failure; tells the caller what to do. */
  reportFailure(input: SearchFailureInput): SearchFailureAction;
  /** Clear all latches WITHOUT emitting transitions. Tests/ops only. */
  reset(): void;
}

/** Metric names, prefixed with `stockbook.` by the Datadog reporter. */
const METRIC = {
  /** Per request served by the regex fallback because Atlas could not be used. */
  FALLBACK: "search.backend.fallback",
  /** Latch flips only — the alertable "we just degraded / recovered" event. */
  TRANSITION: "search.backend.transition",
  /** 1 = Atlas serving, 0 = latched onto the fallback. */
  AVAILABLE: "search.backend.available",
  /** Unclassified `$search` failure that was rethrown to the caller. */
  ERROR: "search.backend.error",
} as const;

export function createSearchGate(
  overrides: Partial<SearchGateDeps> = {},
): SearchGate {
  const deps: SearchGateDeps = {
    now: () => Date.now(),
    env: () => process.env,
    logger: getLogger("search"),
    metrics,
    retryIntervalMs: ATLAS_RETRY_INTERVAL_MS,
    ...overrides,
  };

  /** > 0 while `$search` is latched off for EVERY index. */
  let deploymentLatchUntil = 0;
  /** index name → latch expiry. */
  const indexLatchUntil = new Map<string, number>();
  /** One "which backend am I on" line per process, not per request. */
  let backendAnnounced: SearchBackend | null = null;
  let warnedInvalidOverride = false;

  function resolveBackend(): SearchBackend {
    const env = deps.env();
    const override = (env.SEARCH_BACKEND ?? "").trim().toLowerCase();

    let backend: SearchBackend;
    let source: string;

    if (override === "atlas" || override === "regex") {
      backend = override;
      source = "SEARCH_BACKEND";
    } else {
      if (override && !warnedInvalidOverride) {
        warnedInvalidOverride = true;
        deps.logger.warn(
          { searchBackend: override },
          "Ignoring invalid SEARCH_BACKEND (expected 'atlas' or 'regex')",
        );
      }
      // Legacy behaviour: Atlas Search only exists on Atlas-hosted clusters.
      backend = (env.DATABASE_URL ?? "").includes("mongodb.net")
        ? "atlas"
        : "regex";
      source = "DATABASE_URL";
    }

    if (backendAnnounced !== backend) {
      backendAnnounced = backend;
      deps.logger.info({ backend, source }, "Search backend resolved");
    }
    return backend;
  }

  function emitRecovery(scope: "deployment" | "index", index: string): void {
    deps.logger.warn(
      { scope, index, event: "atlas_search_retry" },
      "Atlas Search fallback window expired - retrying Atlas Search",
    );
    deps.metrics.increment(METRIC.TRANSITION, 1, {
      direction: "out_of_fallback",
      scope,
      index,
    });
    deps.metrics.gauge(METRIC.AVAILABLE, 1, { scope, index });
  }

  function isAtlasEnabled(index: string, subsystem: string): boolean {
    if (resolveBackend() !== "atlas") return false;

    const now = deps.now();

    if (deploymentLatchUntil > 0) {
      if (now < deploymentLatchUntil) {
        // Count every request the latch costs us. Without this the fallback
        // counter goes SILENT for the whole degradation (no request reaches
        // `reportFailure` while the gate is shut) - which is exactly the
        // blind spot this ticket exists to close.
        deps.metrics.increment(METRIC.FALLBACK, 1, {
          index,
          subsystem,
          scope: "deployment",
          reason: "latched",
        });
        return false;
      }
      deploymentLatchUntil = 0;
      emitRecovery("deployment", "*");
    }

    const until = indexLatchUntil.get(index);
    if (until !== undefined) {
      if (now < until) {
        deps.metrics.increment(METRIC.FALLBACK, 1, {
          index,
          subsystem,
          scope: "index",
          reason: "latched",
        });
        return false;
      }
      indexLatchUntil.delete(index);
      emitRecovery("index", index);
    }

    return true;
  }

  function latch(
    scope: "deployment" | "index",
    index: string,
    subsystem: string,
    classification: SearchErrorClassification,
    error: unknown,
  ): void {
    const now = deps.now();
    const expiresAt = now + deps.retryIntervalMs;
    const wasLatched =
      scope === "deployment"
        ? deploymentLatchUntil > now
        : (indexLatchUntil.get(index) ?? 0) > now;

    if (scope === "deployment") deploymentLatchUntil = expiresAt;
    else indexLatchUntil.set(index, expiresAt);

    // Only the FLIP is a transition. Concurrent in-flight requests that fail
    // into an already-shut gate must not re-page or spam the log.
    if (wasLatched) return;

    deps.logger.error(
      {
        scope,
        index,
        subsystem,
        matcher: classification.matcher,
        code: classification.code,
        retryInMs: deps.retryIntervalMs,
        event: "atlas_search_fallback",
        error: errorMessage(error),
      },
      "Atlas Search unavailable - falling back to regex search",
    );
    deps.metrics.increment(METRIC.TRANSITION, 1, {
      direction: "into_fallback",
      scope,
      index,
      reason: classification.matcher,
    });
    deps.metrics.gauge(METRIC.AVAILABLE, 0, { scope, index });
  }

  function reportFailure(input: SearchFailureInput): SearchFailureAction {
    const { index, subsystem, error } = input;
    const classification = classifySearchError(error);
    const tags = {
      index,
      subsystem,
      reason: classification.matcher,
      code: classification.code === null ? "none" : String(classification.code),
    };

    switch (classification.kind) {
      case "deployment-unavailable":
        deps.metrics.increment(METRIC.FALLBACK, 1, {
          ...tags,
          scope: "deployment",
        });
        latch("deployment", index, subsystem, classification, error);
        return "fallback";

      case "index-unavailable":
        deps.metrics.increment(METRIC.FALLBACK, 1, { ...tags, scope: "index" });
        latch("index", index, subsystem, classification, error);
        return "fallback";

      case "transient":
        // THE regression guard: serve this one request from the fallback and
        // leave the gate OPEN. Latching here is what turned a single slow
        // query into five minutes of the (slower) collection scan.
        deps.metrics.increment(METRIC.FALLBACK, 1, {
          ...tags,
          scope: "request",
        });
        deps.logger.warn(
          {
            index,
            subsystem,
            matcher: classification.matcher,
            code: classification.code,
            event: "atlas_search_transient",
            error: errorMessage(error),
          },
          "Atlas Search query failed transiently - falling back for this request only",
        );
        return "fallback";

      case "unrelated":
      default:
        deps.metrics.increment(METRIC.ERROR, 1, tags);
        deps.logger.warn(
          {
            index,
            subsystem,
            code: classification.code,
            event: "atlas_search_error",
            error: errorMessage(error),
          },
          "Unclassified Atlas Search failure - rethrowing",
        );
        return "rethrow";
    }
  }

  function reset(): void {
    deploymentLatchUntil = 0;
    indexLatchUntil.clear();
    backendAnnounced = null;
    warnedInvalidOverride = false;
  }

  return { resolveBackend, isAtlasEnabled, reportFailure, reset };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─────────────────────────────────────────────────────────────────────────────
// Process-wide default gate — what the four subsystems share
// ─────────────────────────────────────────────────────────────────────────────

const defaultGate = createSearchGate();

/** Configured search backend (`SEARCH_BACKEND`, else the `DATABASE_URL` sniff). */
export function getSearchBackend(): SearchBackend {
  return defaultGate.resolveBackend();
}

/**
 * True when this request may issue `$search` against `index`. Returns false on
 * a regex-configured environment and while `index` (or the whole deployment)
 * is latched onto the fallback.
 */
export function isAtlasSearchEnabled(
  index: string,
  subsystem: string,
): boolean {
  return defaultGate.isAtlasEnabled(index, subsystem);
}

/**
 * Record a `$search` failure and decide what the caller does next.
 *
 * ```ts
 * } catch (error) {
 *   if (reportSearchFailure({ index, subsystem, error }) === "fallback") return null;
 *   throw error;
 * }
 * ```
 */
export function reportSearchFailure(
  input: SearchFailureInput,
): SearchFailureAction {
  return defaultGate.reportFailure(input);
}

/** Clear every latch on the shared gate. Tests / ops escape hatch only. */
export function resetSearchGate(): void {
  defaultGate.reset();
}
