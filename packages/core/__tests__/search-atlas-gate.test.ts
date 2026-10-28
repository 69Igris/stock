/**
 * MONEY-1128 — Atlas Search gate (`src/search/atlas-gate.ts`).
 *
 * De-shadowed by construction: every assertion drives the REAL exported
 * `classifySearchError` / `createSearchGate`. Nothing is reimplemented here —
 * the gate takes its clock, env, logger and metrics client as injectable deps
 * precisely so the observability contract can be asserted without a Datadog
 * account or a wall-clock wait.
 *
 * The load-bearing case is the FIRST latch suite: a `PlanExecutorKilled` /
 * operation-timeout is what a LOADED Atlas cluster returns, and the previous
 * classifier promoted it into five process-wide minutes of a slower regex
 * collection scan — a positive feedback loop with no log, metric or alert.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  ATLAS_RETRY_INTERVAL_MS,
  SEARCH_INDEX,
  classifySearchError,
  createSearchGate,
  extractMongoErrorCode,
  type SearchGate,
  type SearchGateLogger,
  type SearchGateMetrics,
} from "../src/search/atlas-gate";

// ── recorders ───────────────────────────────────────────────────────────────

interface LogLine {
  level: "info" | "warn" | "error";
  context: Record<string, unknown>;
  message: string;
}
interface MetricLine {
  kind: "increment" | "gauge";
  name: string;
  value: number;
  tags: Record<string, string>;
}

interface Harness {
  gate: SearchGate;
  logs: LogLine[];
  emitted: MetricLine[];
  env: Record<string, string | undefined>;
  advance(ms: number): void;
  logsOf(level: LogLine["level"]): LogLine[];
  metricsOf(name: string): MetricLine[];
}

const ATLAS_URL = "mongodb+srv://user:pw@cluster0.abcde.mongodb.net/app";
const RAW_IP_URL = "mongodb://10.0.0.7:27017/app";

function harness(env: Record<string, string | undefined> = {}): Harness {
  const logs: LogLine[] = [];
  const emitted: MetricLine[] = [];
  let clock = 1_000_000;

  const logger: SearchGateLogger = {
    info: (context, message) => logs.push({ level: "info", context, message }),
    warn: (context, message) => logs.push({ level: "warn", context, message }),
    error: (context, message) =>
      logs.push({ level: "error", context, message }),
  };
  const metrics: SearchGateMetrics = {
    increment: (name, value = 1, tags = {}) =>
      emitted.push({ kind: "increment", name, value, tags }),
    gauge: (name, value, tags = {}) =>
      emitted.push({ kind: "gauge", name, value, tags }),
  };

  const resolved: Record<string, string | undefined> = {
    DATABASE_URL: ATLAS_URL,
    ...env,
  };

  const gate = createSearchGate({
    now: () => clock,
    env: () => resolved,
    logger,
    metrics,
  });

  return {
    gate,
    logs,
    emitted,
    env: resolved,
    advance: (ms) => {
      clock += ms;
    },
    logsOf: (level) => logs.filter((l) => l.level === level),
    metricsOf: (name) => emitted.filter((m) => m.name === name),
  };
}

/** The shape Prisma produces for a failed `$runCommandRaw` (P2010). */
function prismaRawError(code: string, message: string): Error {
  const error = new Error(
    `Raw query failed. Code: \`${code}\`. Message: \`${message}\``,
  ) as Error & { code: string; meta: { code: string; message: string } };
  error.code = "P2010";
  error.meta = { code, message };
  return error;
}

const INSTRUMENTS = SEARCH_INDEX.INSTRUMENTS;
const CONTENT = SEARCH_INDEX.CONTENT;
const SUB = "test.subsystem";

// ── classifier ──────────────────────────────────────────────────────────────

describe("classifySearchError — transient (must NOT latch)", () => {
  const transient: Array<[string, unknown]> = [
    [
      "operation timeout inside the plan executor",
      new Error(
        "PlanExecutor error during aggregation :: caused by :: operation exceeded time limit",
      ),
    ],
    [
      "PlanExecutorKilled",
      new Error(
        "PlanExecutor error during aggregation :: caused by :: PlanExecutorKilled",
      ),
    ],
    [
      "QueryPlanKilled by numeric code (175)",
      prismaRawError(
        "175",
        "Kind: Command failed: Error code 175 (QueryPlanKilled): $search stage failed",
      ),
    ],
    [
      "MaxTimeMSExpired by numeric code (50)",
      prismaRawError("50", "operation exceeded time limit"),
    ],
    [
      "mongot request timed out",
      new Error(
        "PlanExecutor error during aggregation :: caused by :: Remote error from mongot :: caused by :: Request timed out",
      ),
    ],
    [
      "operation was interrupted",
      new Error(
        "PlanExecutor error during aggregation :: caused by :: operation was interrupted",
      ),
    ],
    [
      "socket exception while running $search",
      new Error("MongoNetworkError: connection 3 to cluster0 closed"),
    ],
    [
      "pool cleared",
      new Error("PoolClearedError: Connection pool was cleared"),
    ],
    [
      "server selection timeout",
      new Error("MongoServerSelectionError: Server selection timed out"),
    ],
    [
      "the search node itself being down",
      new Error(
        "Remote error from mongot :: caused by :: UNAVAILABLE: no healthy upstream",
      ),
    ],
  ];

  for (const [label, error] of transient) {
    it(`classifies ${label} as transient`, () => {
      assert.strictEqual(classifySearchError(error).kind, "transient");
    });
  }

  it("keeps the message that mentions BOTH $search and a timeout transient", () => {
    // The exact prod shape the old substring classifier mis-read: `$search`
    // and `PlanExecutor` are the LOCATION, the timeout is the DIAGNOSIS.
    const error = new Error(
      "PlanExecutor error during aggregation :: caused by :: Failed to run $search: operation exceeded time limit",
    );
    assert.strictEqual(classifySearchError(error).kind, "transient");
  });

  it("reports which predicate matched, for alert dimensions", () => {
    const result = classifySearchError(new Error("Request timed out"));
    assert.strictEqual(result.matcher, "timeout");
  });
});

describe("classifySearchError — genuinely unavailable (must latch)", () => {
  it("classifies an unrecognized $search stage as deployment-unavailable", () => {
    const error = prismaRawError(
      "40324",
      "Kind: Command failed: Error code 40324 (Location40324): PlanExecutor error during aggregation :: caused by :: Unrecognized pipeline stage name: '$search'",
    );
    const result = classifySearchError(error);
    assert.strictEqual(result.kind, "deployment-unavailable");
    assert.strictEqual(result.code, 40324);
  });

  it("classifies SearchNotEnabled as deployment-unavailable", () => {
    const result = classifySearchError(
      new Error("SearchNotEnabled: $search is not enabled on this cluster"),
    );
    assert.strictEqual(result.kind, "deployment-unavailable");
  });

  it("classifies '$search is not allowed' as deployment-unavailable", () => {
    const result = classifySearchError(
      new Error("$search is not allowed with the current configuration"),
    );
    assert.strictEqual(result.kind, "deployment-unavailable");
  });

  it("classifies a shared-tier '$search is not supported' as deployment-unavailable", () => {
    const result = classifySearchError(
      new Error("$search is not supported on this cluster tier"),
    );
    assert.strictEqual(result.kind, "deployment-unavailable");
    assert.strictEqual(result.matcher, "search-not-allowed");
  });

  it("does not let the search-node-down predicate swallow 'Atlas Search is not available'", () => {
    assert.strictEqual(
      classifySearchError(new Error("Atlas Search is not available")).kind,
      "deployment-unavailable",
    );
  });

  it("classifies a named missing search index as index-unavailable", () => {
    const result = classifySearchError(
      new Error(
        'PlanExecutor error during aggregation :: caused by :: Search index with name "instrument_search" not found',
      ),
    );
    assert.strictEqual(result.kind, "index-unavailable");
    assert.strictEqual(result.matcher, "index-not-found");
  });

  it("classifies a bare 'index not found' as index-unavailable", () => {
    assert.strictEqual(
      classifySearchError(new Error("index not found")).kind,
      "index-unavailable",
    );
  });

  it("classifies IndexNotFound (code 27) as index-unavailable", () => {
    assert.strictEqual(
      classifySearchError(prismaRawError("27", "no index")).kind,
      "index-unavailable",
    );
  });

  it("classifies a still-building index as index-unavailable", () => {
    assert.strictEqual(
      classifySearchError(
        new Error("Search index is not queryable yet, it is still building"),
      ).kind,
      "index-unavailable",
    );
  });
});

describe("classifySearchError — the $search envelope always degrades", () => {
  /**
   * The pre-MONEY-1128 gate caught this whole family with a bare
   * `msg.includes("PlanExecutor")`. Classifying only the NAMED reasons was a
   * silent availability regression: mongot wraps every server-side failure in
   * `PlanExecutor error during aggregation :: caused by :: Remote error from
   * mongot :: caused by :: <reason>`, and `<reason>` is an open set. An
   * unrecognised reason fell through to `unrelated` and was rethrown — which
   * `/api/market/search` and `/api/market/autocomplete` turn into an HTTP 500,
   * where they had previously served degraded-but-real results, and which the
   * content actions turn into a silent empty list.
   *
   * These messages are deliberately ones NO specific matcher recognises. If a
   * future matcher claims one, that is fine — the assertion is on the OUTCOME
   * (never `unrelated`), not on which matcher fired.
   */
  const UNNAMED_MONGOT_REASONS = [
    'PlanExecutor error during aggregation :: caused by :: Remote error from mongot :: caused by :: bad operator "text" on token field',
    'PlanExecutor error during aggregation :: caused by :: Remote error from mongot :: caused by :: path "status" is not indexed',
    "Raw query failed. Code: `8`. Message: `PlanExecutor error during aggregation :: caused by :: Remote error from mongot`",
    "PlanExecutor error during aggregation :: caused by :: Remote error from mongot :: caused by :: something nobody has written yet",
  ];

  for (const message of UNNAMED_MONGOT_REASONS) {
    it(`degrades rather than rethrows: ${message.slice(0, 54)}…`, () => {
      const result = classifySearchError(new Error(message));
      assert.notStrictEqual(
        result.kind,
        "unrelated",
        "a failure that came OUT of the $search stage must serve the fallback, " +
          "not propagate to the route and 500",
      );
    });
  }

  it("does not latch on an unnamed reason — duration is unknown", () => {
    // Latching costs 5 minutes of collection scan. This bucket exists because
    // we could NOT identify the error, so it must not also assert permanence.
    const result = classifySearchError(
      new Error(
        "PlanExecutor error during aggregation :: caused by :: Remote error from mongot :: caused by :: mystery",
      ),
    );
    assert.strictEqual(result.kind, "transient");
    assert.strictEqual(result.matcher, "search-stage-generic");
  });

  it("[ordering] a NAMED diagnosis inside the envelope still wins", () => {
    // The generic envelope is checked last on purpose. If it ran first it
    // would flatten every specific classification into a non-latching
    // transient, and a genuinely missing index would be re-attempted forever.
    assert.strictEqual(
      classifySearchError(
        new Error(
          'PlanExecutor error during aggregation :: caused by :: Remote error from mongot :: caused by :: Search index with name "instrument_search" not found',
        ),
      ).kind,
      "index-unavailable",
    );
    assert.strictEqual(
      classifySearchError(
        new Error("Unrecognized pipeline stage name: $search"),
      ).kind,
      "deployment-unavailable",
    );
  });

  it("[control] an error that never reached $search is still rethrown", () => {
    // The envelope match must not become a catch-all for unrelated bugs.
    for (const message of [
      "Cannot read properties of undefined (reading 'id')",
      "Invalid `prisma.instrumentMapping.findMany()` invocation: Argument take must not be null",
    ]) {
      assert.strictEqual(
        classifySearchError(new Error(message)).kind,
        "unrelated",
        `"${message}" has nothing to do with Atlas and must propagate`,
      );
    }
  });
});

describe("classifySearchError — plumbing", () => {
  it("rethrows-by-classification anything it cannot identify", () => {
    const result = classifySearchError(new Error("BadValue: bogus operator"));
    assert.strictEqual(result.kind, "unrelated");
    assert.strictEqual(result.matcher, "unclassified");
  });

  it("reads the diagnosis out of a nested cause chain", () => {
    const inner = new Error("Search index with name 'mf_search' not found");
    const outer = new Error("Raw query failed") as Error & { cause: unknown };
    outer.cause = inner;
    assert.strictEqual(classifySearchError(outer).kind, "index-unavailable");
  });

  it("ignores Prisma's non-numeric error code and reads meta.code", () => {
    const error = prismaRawError("40324", "Unrecognized pipeline stage name");
    assert.strictEqual(extractMongoErrorCode(error), 40324);
  });

  it("recovers a code from the message when no structured code exists", () => {
    assert.strictEqual(
      extractMongoErrorCode(
        new Error("Kind: Command failed: Error code 175 (QueryPlanKilled)"),
      ),
      175,
    );
  });

  it("survives a non-Error throw", () => {
    assert.strictEqual(
      classifySearchError("index not found").kind,
      "index-unavailable",
    );
    assert.strictEqual(classifySearchError(null).kind, "unrelated");
  });
});

// ── latch behaviour ─────────────────────────────────────────────────────────

describe("gate latch — a timeout must not shut the gate", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness({ SEARCH_BACKEND: "atlas" });
  });

  it("REGRESSION: a PlanExecutorKilled falls back for that request only", () => {
    assert.strictEqual(h.gate.isAtlasEnabled(INSTRUMENTS, SUB), true);

    const action = h.gate.reportFailure({
      index: INSTRUMENTS,
      subsystem: SUB,
      error: new Error(
        "PlanExecutor error during aggregation :: caused by :: PlanExecutorKilled",
      ),
    });

    assert.strictEqual(action, "fallback");
    // The whole point: the NEXT request still gets Atlas.
    assert.strictEqual(h.gate.isAtlasEnabled(INSTRUMENTS, SUB), true);
  });

  it("REGRESSION: an operation timeout does not latch even when repeated", () => {
    const timeout = new Error(
      "PlanExecutor error during aggregation :: caused by :: operation exceeded time limit",
    );
    for (let i = 0; i < 5; i += 1) {
      h.gate.reportFailure({
        index: INSTRUMENTS,
        subsystem: SUB,
        error: timeout,
      });
    }
    assert.strictEqual(h.gate.isAtlasEnabled(INSTRUMENTS, SUB), true);
    assert.strictEqual(h.metricsOf("search.backend.transition").length, 0);
  });

  it("a transient failure never emits a fallback-transition", () => {
    h.gate.reportFailure({
      index: INSTRUMENTS,
      subsystem: SUB,
      error: new Error("Request timed out"),
    });
    const fallbacks = h.metricsOf("search.backend.fallback");
    assert.strictEqual(fallbacks.length, 1);
    assert.strictEqual(fallbacks[0].tags.scope, "request");
    assert.strictEqual(h.metricsOf("search.backend.transition").length, 0);
  });
});

describe("gate latch — genuine unavailability shuts the gate", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness({ SEARCH_BACKEND: "atlas" });
  });

  it("an index-missing error latches for the retry interval", () => {
    const action = h.gate.reportFailure({
      index: INSTRUMENTS,
      subsystem: SUB,
      error: new Error('Search index with name "instrument_search" not found'),
    });

    assert.strictEqual(action, "fallback");
    assert.strictEqual(h.gate.isAtlasEnabled(INSTRUMENTS, SUB), false);

    h.advance(ATLAS_RETRY_INTERVAL_MS - 1);
    assert.strictEqual(h.gate.isAtlasEnabled(INSTRUMENTS, SUB), false);

    h.advance(1);
    assert.strictEqual(h.gate.isAtlasEnabled(INSTRUMENTS, SUB), true);
  });

  it("an index-scoped latch does not take a healthy sibling index down", () => {
    h.gate.reportFailure({
      index: CONTENT,
      subsystem: "content",
      error: new Error("index not found"),
    });
    assert.strictEqual(h.gate.isAtlasEnabled(CONTENT, "content"), false);
    assert.strictEqual(h.gate.isAtlasEnabled(INSTRUMENTS, SUB), true);
  });

  it("a deployment-level failure latches EVERY index (the shared-flag fix)", () => {
    h.gate.reportFailure({
      index: CONTENT,
      subsystem: "content",
      error: new Error("Unrecognized pipeline stage name: '$search'"),
    });
    assert.strictEqual(h.gate.isAtlasEnabled(CONTENT, "content"), false);
    assert.strictEqual(h.gate.isAtlasEnabled(INSTRUMENTS, SUB), false);
    assert.strictEqual(
      h.gate.isAtlasEnabled(SEARCH_INDEX.USERS, "users"),
      false,
    );
  });

  it("an unclassified failure tells the caller to rethrow and does not latch", () => {
    const action = h.gate.reportFailure({
      index: INSTRUMENTS,
      subsystem: SUB,
      error: new Error("BadValue: unknown operator 'nope'"),
    });
    assert.strictEqual(action, "rethrow");
    assert.strictEqual(h.gate.isAtlasEnabled(INSTRUMENTS, SUB), true);
  });

  it("reset() clears every latch", () => {
    h.gate.reportFailure({
      index: INSTRUMENTS,
      subsystem: SUB,
      error: new Error("SearchNotEnabled"),
    });
    assert.strictEqual(h.gate.isAtlasEnabled(INSTRUMENTS, SUB), false);
    h.gate.reset();
    assert.strictEqual(h.gate.isAtlasEnabled(INSTRUMENTS, SUB), true);
  });
});

// ── observability ───────────────────────────────────────────────────────────

describe("gate observability — every transition is logged and measured", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness({ SEARCH_BACKEND: "atlas" });
  });

  it("logs at ERROR and emits a transition on the way INTO the fallback", () => {
    h.gate.reportFailure({
      index: INSTRUMENTS,
      subsystem: SUB,
      error: new Error("Unrecognized pipeline stage name: '$search'"),
    });

    const errors = h.logsOf("error");
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /falling back to regex/i);
    assert.strictEqual(errors[0].context.index, INSTRUMENTS);
    assert.strictEqual(errors[0].context.subsystem, SUB);
    assert.strictEqual(errors[0].context.matcher, "stage-unrecognized");
    assert.strictEqual(errors[0].context.scope, "deployment");
    assert.match(
      String(errors[0].context.error),
      /Unrecognized pipeline stage/,
    );

    const transitions = h.metricsOf("search.backend.transition");
    assert.strictEqual(transitions.length, 1);
    assert.strictEqual(transitions[0].tags.direction, "into_fallback");
    assert.strictEqual(transitions[0].tags.reason, "stage-unrecognized");

    const gauges = h.metricsOf("search.backend.available");
    assert.strictEqual(gauges.length, 1);
    assert.strictEqual(gauges[0].value, 0);
  });

  it("logs at WARN and emits a transition on the way OUT of the fallback", () => {
    h.gate.reportFailure({
      index: INSTRUMENTS,
      subsystem: SUB,
      error: new Error("index not found"),
    });
    h.advance(ATLAS_RETRY_INTERVAL_MS);

    assert.strictEqual(h.gate.isAtlasEnabled(INSTRUMENTS, SUB), true);

    const recovery = h
      .logsOf("warn")
      .filter((l) => l.context.event === "atlas_search_retry");
    assert.strictEqual(recovery.length, 1);
    assert.match(recovery[0].message, /retrying Atlas Search/i);

    const out = h
      .metricsOf("search.backend.transition")
      .filter((m) => m.tags.direction === "out_of_fallback");
    assert.strictEqual(out.length, 1);

    const gauges = h.metricsOf("search.backend.available");
    assert.strictEqual(gauges[gauges.length - 1].value, 1);
  });

  it("keeps emitting the fallback counter WHILE latched, so the alert never goes silent", () => {
    h.gate.reportFailure({
      index: INSTRUMENTS,
      subsystem: SUB,
      error: new Error("SearchNotEnabled"),
    });

    // Requests during the degradation never reach reportFailure (the gate is
    // shut), so the counter has to come from the gate check itself.
    h.gate.isAtlasEnabled(INSTRUMENTS, SUB);
    h.gate.isAtlasEnabled(INSTRUMENTS, SUB);

    const latched = h
      .metricsOf("search.backend.fallback")
      .filter((m) => m.tags.reason === "latched");
    assert.strictEqual(latched.length, 2);
    assert.strictEqual(latched[0].tags.scope, "deployment");
    assert.strictEqual(latched[0].tags.subsystem, SUB);
  });

  it("does not re-page for concurrent failures into an already-shut gate", () => {
    const error = new Error("SearchNotEnabled");
    h.gate.reportFailure({ index: INSTRUMENTS, subsystem: SUB, error });
    h.gate.reportFailure({ index: INSTRUMENTS, subsystem: SUB, error });
    h.gate.reportFailure({ index: INSTRUMENTS, subsystem: SUB, error });

    assert.strictEqual(
      h.metricsOf("search.backend.transition").length,
      1,
      "only the FLIP is a transition",
    );
    assert.strictEqual(h.logsOf("error").length, 1);
    // …but every affected request is still counted.
    assert.strictEqual(h.metricsOf("search.backend.fallback").length, 3);
  });

  it("logs a transient degradation at WARN with the matched predicate", () => {
    h.gate.reportFailure({
      index: INSTRUMENTS,
      subsystem: SUB,
      error: new Error("Request timed out"),
    });
    const warns = h
      .logsOf("warn")
      .filter((l) => l.context.event === "atlas_search_transient");
    assert.strictEqual(warns.length, 1);
    assert.strictEqual(warns[0].context.matcher, "timeout");
    assert.match(warns[0].message, /this request only/i);
    assert.strictEqual(h.logsOf("error").length, 0);
  });

  it("counts and logs an unclassified failure before rethrowing", () => {
    h.gate.reportFailure({
      index: INSTRUMENTS,
      subsystem: SUB,
      error: new Error("BadValue: nope"),
    });
    assert.strictEqual(h.metricsOf("search.backend.error").length, 1);
    assert.strictEqual(
      h.logsOf("warn").filter((l) => l.context.event === "atlas_search_error")
        .length,
      1,
    );
  });

  it("tags every fallback with index + subsystem + reason + code", () => {
    h.gate.reportFailure({
      index: INSTRUMENTS,
      subsystem: SUB,
      error: prismaRawError("27", "index not found"),
    });
    const [fallback] = h.metricsOf("search.backend.fallback");
    assert.deepStrictEqual(fallback.tags, {
      index: INSTRUMENTS,
      subsystem: SUB,
      reason: "code:27",
      code: "27",
      scope: "index",
    });
  });
});

// ── backend resolution ──────────────────────────────────────────────────────

describe("SEARCH_BACKEND override", () => {
  it("forces Atlas on a non-Atlas connection string", () => {
    const h = harness({ DATABASE_URL: RAW_IP_URL, SEARCH_BACKEND: "atlas" });
    assert.strictEqual(h.gate.resolveBackend(), "atlas");
    assert.strictEqual(h.gate.isAtlasEnabled(INSTRUMENTS, SUB), true);
  });

  it("forces regex on an Atlas connection string (kill switch)", () => {
    const h = harness({ DATABASE_URL: ATLAS_URL, SEARCH_BACKEND: "regex" });
    assert.strictEqual(h.gate.resolveBackend(), "regex");
    assert.strictEqual(h.gate.isAtlasEnabled(INSTRUMENTS, SUB), false);
  });

  it("falls back to the DATABASE_URL sniff when unset", () => {
    assert.strictEqual(
      harness({ DATABASE_URL: ATLAS_URL }).gate.resolveBackend(),
      "atlas",
    );
    assert.strictEqual(
      harness({ DATABASE_URL: RAW_IP_URL }).gate.resolveBackend(),
      "regex",
    );
  });

  it("is case- and whitespace-insensitive", () => {
    const h = harness({ DATABASE_URL: RAW_IP_URL, SEARCH_BACKEND: "  ATLAS " });
    assert.strictEqual(h.gate.resolveBackend(), "atlas");
  });

  it("warns once and falls back to the sniff on an invalid value", () => {
    const h = harness({ DATABASE_URL: ATLAS_URL, SEARCH_BACKEND: "mongo" });
    assert.strictEqual(h.gate.resolveBackend(), "atlas");
    h.gate.resolveBackend();
    h.gate.resolveBackend();
    const warns = h
      .logsOf("warn")
      .filter((l) => /invalid SEARCH_BACKEND/i.test(l.message));
    assert.strictEqual(warns.length, 1);
  });

  it("announces the resolved backend exactly once", () => {
    const h = harness({ DATABASE_URL: ATLAS_URL });
    h.gate.resolveBackend();
    h.gate.resolveBackend();
    h.gate.isAtlasEnabled(INSTRUMENTS, SUB);
    const announcements = h
      .logsOf("info")
      .filter((l) => l.message === "Search backend resolved");
    assert.strictEqual(announcements.length, 1);
    assert.strictEqual(announcements[0].context.backend, "atlas");
    assert.strictEqual(announcements[0].context.source, "DATABASE_URL");
  });

  it("emits no fallback noise when regex is the CONFIGURED backend", () => {
    const h = harness({ DATABASE_URL: RAW_IP_URL });
    h.gate.isAtlasEnabled(INSTRUMENTS, SUB);
    h.gate.isAtlasEnabled(CONTENT, "content");
    assert.strictEqual(h.metricsOf("search.backend.fallback").length, 0);
  });

  it("re-reads the environment per call (no import-time snapshot)", () => {
    const h = harness({ DATABASE_URL: RAW_IP_URL });
    assert.strictEqual(h.gate.resolveBackend(), "regex");
    h.env.SEARCH_BACKEND = "atlas";
    assert.strictEqual(h.gate.resolveBackend(), "atlas");
  });
});
