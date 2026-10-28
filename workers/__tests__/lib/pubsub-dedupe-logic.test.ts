/**
 * UNIT TEST — Pub/Sub messageId idempotency (MONEY-1204, 14a.5b).
 *
 * Exercises the REAL exports from `workers/src/lib/pubsub-dedupe-logic.ts`:
 * the claim decision table, the Extended-JSON readers, the claim PROTOCOL
 * (driven against a fake Mongo that implements a genuine unique index), and the
 * `/jobs/*` middleware itself.
 *
 * ## Why the fake Mongo is not a shadow
 *
 * `createDedupeStore` takes an injected `RawCommandRunner`, so these tests run
 * the SAME function `index.ts` runs — only the transport is faked. The fake
 * implements `insert` / `aggregate` / `findAndModify` / `update` with a real
 * unique-index constraint on `messageId`, so a protocol that raced (read, then
 * insert) would produce two claims here exactly as it would in production.
 *
 * The fake yields a microtask BEFORE its check-and-set, which is what makes the
 * concurrency assertions discriminating: two `claim()` calls started without an
 * intervening await genuinely interleave at that point.
 *
 * Pure functions and in-memory fakes only: no Prisma, no Hono, no fetch, no
 * timers — nothing here can orphan the runner.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEDUPE_COLLECTION,
  DEDUPE_RETENTION_MS,
  DEDUPE_TTL_INDEX,
  DEDUPE_UNIQUE_INDEX,
  DEFAULT_LEASE_MS,
  SELF_DEDUPING_ROUTES,
  createDedupeMiddleware,
  createDedupeStore,
  decideOnExistingMarker,
  decideOnStoreError,
  dedupeIndexCommand,
  extractDeliveryId,
  insertSucceeded,
  isDuplicateKeyError,
  parseMarkerDate,
  parseMarkerStatus,
  routeKey,
  toMarker,
  type ClaimDecision,
  type DedupeContext,
  type DedupeMarker,
  type DedupeStore,
  type RawCommandRunner,
} from "../../src/lib/pubsub-dedupe-logic";

// ── A fake Mongo with a real unique index ────────────────────────────────

interface FakeDoc extends Record<string, unknown> {
  messageId: string;
}

class FakeMongo {
  readonly docs = new Map<string, FakeDoc>();
  readonly commands: string[] = [];
  /** Set to force every command to reject (store-outage simulation). */
  failWith: Error | null = null;
  /** When true, a duplicate insert THROWS instead of returning writeErrors —
   *  the other way MongoDB/Prisma can surface E11000. */
  throwOnDuplicate = false;

  readonly run: RawCommandRunner = async (command) => {
    // Yield BEFORE inspecting state, so two concurrent claims interleave here.
    await Promise.resolve();

    if (this.failWith) throw this.failWith;

    if (typeof command.insert === "string") {
      this.commands.push("insert");
      const docs = command.documents as FakeDoc[];
      const doc = docs[0];
      // The unique index. Check + set is synchronous == atomic, exactly as the
      // storage engine serialises it.
      if (this.docs.has(doc.messageId)) {
        if (this.throwOnDuplicate) {
          throw Object.assign(
            new Error("E11000 duplicate key error collection"),
            { code: 11000 },
          );
        }
        return {
          n: 0,
          ok: 1,
          writeErrors: [
            { index: 0, code: 11000, errmsg: "E11000 duplicate key error" },
          ],
        };
      }
      this.docs.set(doc.messageId, { ...doc });
      return { n: 1, ok: 1 };
    }

    if (typeof command.aggregate === "string") {
      this.commands.push("aggregate");
      const pipeline = command.pipeline as Array<Record<string, unknown>>;
      const match = pipeline.find((s) => "$match" in s)?.$match as
        | { messageId?: string }
        | undefined;
      const found = match?.messageId
        ? this.docs.get(match.messageId)
        : undefined;
      return { cursor: { firstBatch: found ? [{ ...found }] : [] }, ok: 1 };
    }

    if (typeof command.findAndModify === "string") {
      this.commands.push("findAndModify");
      const query = command.query as Record<string, unknown>;
      const id = query.messageId as string;
      const doc = this.docs.get(id);
      if (!doc) return { value: null, ok: 1 };
      // Every non-messageId key in the query must match (the CAS filter).
      for (const [k, v] of Object.entries(query)) {
        if (k === "messageId") continue;
        const actual = doc[k] ?? null;
        if (actual !== v) return { value: null, ok: 1 };
      }
      const set = (command.update as { $set: Record<string, unknown> }).$set;
      const next = { ...doc, ...set };
      this.docs.set(id, next as FakeDoc);
      return { value: { ...next }, ok: 1 };
    }

    if (typeof command.update === "string") {
      this.commands.push("update");
      const updates = command.updates as Array<{
        q: { messageId: string };
        u: { $set: Record<string, unknown> };
      }>;
      const { q, u } = updates[0];
      const doc = this.docs.get(q.messageId);
      if (doc) this.docs.set(q.messageId, { ...doc, ...u.$set } as FakeDoc);
      return { n: doc ? 1 : 0, ok: 1 };
    }

    if (typeof command.createIndexes === "string") {
      this.commands.push("createIndexes");
      return { ok: 1 };
    }

    throw new Error(`FakeMongo: unhandled command ${Object.keys(command)[0]}`);
  };
}

const FIXED_NOW = Date.parse("2026-08-16T10:00:00.000Z");

function storeAt(mongo: FakeMongo, now = () => FIXED_NOW): DedupeStore {
  return createDedupeStore({ runCommand: mongo.run, now, logError: () => {} });
}

// ── decideOnExistingMarker ───────────────────────────────────────────────

function marker(over: Partial<DedupeMarker> = {}): DedupeMarker {
  return {
    messageId: "m1",
    route: "/jobs/price-sync",
    status: "IN_FLIGHT",
    attempts: 1,
    leaseExpiresAt: FIXED_NOW + 1000,
    ...over,
  };
}

describe("decideOnExistingMarker", () => {
  it("COMPLETED -> skip, so a redelivery does not re-run the job", () => {
    const d = decideOnExistingMarker(
      marker({ status: "COMPLETED", leaseExpiresAt: null, attempts: 2 }),
      FIXED_NOW,
    );
    assert.equal(d.action, "SKIP_COMPLETED");
    assert.equal(d.reason, "already_completed");
    assert.equal(d.attempts, 2);
  });

  it("IN_FLIGHT with a LIVE lease -> retry later, NEVER skip", () => {
    // The requirement that motivates this branch: an in-flight (not completed)
    // messageId must not be treated as duplicate-and-skip, or a job that
    // crashes after claiming can never be retried.
    const d = decideOnExistingMarker(
      marker({ leaseExpiresAt: FIXED_NOW + 60_000 }),
      FIXED_NOW,
    );
    assert.equal(d.action, "RETRY_LATER");
    assert.notEqual(d.action, "SKIP_COMPLETED");
  });

  it("IN_FLIGHT with an EXPIRED lease -> run (a crashed job stays retryable)", () => {
    const d = decideOnExistingMarker(
      marker({ leaseExpiresAt: FIXED_NOW - 1 }),
      FIXED_NOW,
    );
    assert.equal(d.action, "RUN");
    assert.equal(d.reason, "lease_expired");
  });

  it("a lease expiring exactly NOW is expired, not live", () => {
    const d = decideOnExistingMarker(
      marker({ leaseExpiresAt: FIXED_NOW }),
      FIXED_NOW,
    );
    assert.equal(d.action, "RUN");
  });

  it("IN_FLIGHT with a MISSING lease -> run, never an eternal lock", () => {
    const d = decideOnExistingMarker(
      marker({ leaseExpiresAt: null }),
      FIXED_NOW,
    );
    assert.equal(d.action, "RUN");
    assert.equal(d.reason, "lease_missing");
  });

  it("FAILED -> run; Pub/Sub is entitled to its remaining attempts", () => {
    const d = decideOnExistingMarker(
      marker({ status: "FAILED", leaseExpiresAt: null, attempts: 3 }),
      FIXED_NOW,
    );
    assert.equal(d.action, "RUN");
    assert.equal(d.reason, "reclaim_after_failure");
  });

  it("a vanished marker runs untracked rather than being assumed done", () => {
    const d = decideOnExistingMarker(null, FIXED_NOW);
    assert.equal(d.action, "RUN_UNTRACKED");
  });

  it("a store error fails OPEN — an outage must not stop every job", () => {
    assert.equal(decideOnStoreError().action, "RUN_UNTRACKED");
  });
});

// ── Raw-response readers ─────────────────────────────────────────────────

describe("isDuplicateKeyError / insertSucceeded", () => {
  it("recognises E11000 as a thrown error, a writeErrors entry and a string", () => {
    assert.equal(isDuplicateKeyError({ code: 11000 }), true);
    assert.equal(isDuplicateKeyError({ code: "11000" }), true);
    assert.equal(
      isDuplicateKeyError(new Error("E11000 duplicate key error")),
      true,
    );
    assert.equal(isDuplicateKeyError("E11000 dup"), true);
    assert.equal(
      isDuplicateKeyError({ meta: { cause: { code: 11000 } } }),
      true,
    );
    assert.equal(
      isDuplicateKeyError({ n: 0, ok: 1, writeErrors: [{ code: 11000 }] }),
      true,
      "the ok:1 + writeErrors response is the shape the store passes on the " +
        "COMMON path; missing it fails open and the dedupe never dedupes",
    );
    assert.equal(isDuplicateKeyError(null), false);
    assert.equal(isDuplicateKeyError({ code: 121 }), false);
    assert.equal(
      isDuplicateKeyError({ n: 0, ok: 1, writeErrors: [{ code: 121 }] }),
      false,
      "a non-duplicate write error must NOT be mistaken for a conflict",
    );
  });

  it("treats an ok:1 response carrying writeErrors as NOT written", () => {
    // This is the trap: Mongo's `insert` does not fail the command on a
    // duplicate key, it reports it per-document. Reading only `ok` would
    // classify every duplicate as a successful claim — dedupe that never
    // dedupes.
    assert.equal(
      insertSucceeded({ n: 0, ok: 1, writeErrors: [{ code: 11000 }] }),
      false,
    );
    assert.equal(insertSucceeded({ n: 1, ok: 1 }), true);
    assert.equal(insertSucceeded({ ok: 1 }), false);
    assert.equal(insertSucceeded(null), false);
  });
});

describe("parseMarkerDate", () => {
  it("reads epoch ms, ISO strings, Date and both Extended-JSON shapes", () => {
    assert.equal(parseMarkerDate(FIXED_NOW), FIXED_NOW);
    assert.equal(parseMarkerDate("2026-08-16T10:00:00.000Z"), FIXED_NOW);
    assert.equal(parseMarkerDate(new Date(FIXED_NOW)), FIXED_NOW);
    assert.equal(
      parseMarkerDate({ $date: "2026-08-16T10:00:00.000Z" }),
      FIXED_NOW,
    );
    assert.equal(
      parseMarkerDate({ $date: { $numberLong: String(FIXED_NOW) } }),
      FIXED_NOW,
    );
  });

  it("returns null (never NaN) for unparseable input", () => {
    // NaN is the dangerous answer: `NaN <= now` is FALSE, so a NaN lease reads
    // as permanently LIVE and every redelivery would nack forever.
    for (const bad of [
      null,
      undefined,
      "not-a-date",
      {},
      [],
      NaN,
      {
        $date: {},
      },
    ]) {
      assert.equal(
        parseMarkerDate(bad),
        null,
        `expected null for ${String(bad)}`,
      );
    }
  });
});

describe("parseMarkerStatus / toMarker", () => {
  it("defaults an unknown status to IN_FLIGHT, never COMPLETED", () => {
    assert.equal(parseMarkerStatus("WAT"), "IN_FLIGHT");
    assert.equal(parseMarkerStatus(undefined), "IN_FLIGHT");
    assert.equal(parseMarkerStatus("COMPLETED"), "COMPLETED");
  });

  it("builds a marker from an Extended-JSON document", () => {
    const m = toMarker({
      messageId: "m1",
      route: "/jobs/price-sync",
      status: "IN_FLIGHT",
      attempts: 2,
      leaseExpiresAt: FIXED_NOW + 5,
    });
    assert.deepEqual(m, {
      messageId: "m1",
      route: "/jobs/price-sync",
      status: "IN_FLIGHT",
      attempts: 2,
      leaseExpiresAt: FIXED_NOW + 5,
    });
  });

  it("rejects documents with no messageId", () => {
    assert.equal(toMarker({}), null);
    assert.equal(toMarker(null), null);
    assert.equal(toMarker("nope"), null);
  });
});

describe("extractDeliveryId", () => {
  it("returns the messageId only for a real push envelope", () => {
    assert.equal(
      extractDeliveryId({ message: { messageId: "123", data: "e30=" } }),
      "123",
    );
    assert.equal(extractDeliveryId({ message: { messageId: " 123 " } }), "123");
  });

  it("returns null for direct JSON bodies so they are never deduped", () => {
    // `lib/message.ts::getMessageId` synthesises `local-${Date.now()}` for
    // these. Deduping on a clock-derived id would make two manual triggers in
    // the same millisecond collide and silently skip the second.
    assert.equal(extractDeliveryId({ exchanges: ["NSE"] }), null);
    assert.equal(extractDeliveryId({ message: {} }), null);
    assert.equal(extractDeliveryId({ message: { messageId: "" } }), null);
    assert.equal(extractDeliveryId({ message: { messageId: 42 } }), null);
    assert.equal(extractDeliveryId(null), null);
    assert.equal(extractDeliveryId("string"), null);
  });
});

describe("routeKey", () => {
  it("strips a query string and bounds the length", () => {
    assert.equal(routeKey("/jobs/price-sync?x=1"), "/jobs/price-sync");
    assert.equal(routeKey("/a".repeat(200)).length, 120);
  });
});

describe("dedupeIndexCommand", () => {
  it("declares the unique index the whole protocol depends on", () => {
    const cmd = dedupeIndexCommand();
    assert.equal(cmd.createIndexes, DEDUPE_COLLECTION);
    const indexes = cmd.indexes as Array<Record<string, unknown>>;
    const unique = indexes.find((i) => i.name === DEDUPE_UNIQUE_INDEX);
    assert.ok(unique, "the unique index must be declared");
    assert.equal(unique.unique, true);
    assert.deepEqual(unique.key, { messageId: 1 });
    const ttl = indexes.find((i) => i.name === DEDUPE_TTL_INDEX);
    assert.ok(ttl);
    assert.equal(ttl.expireAfterSeconds, 0);
  });

  it("keeps marker retention above Pub/Sub's 7d message retention", () => {
    // A marker reaped while the message can still be redelivered would let
    // that redelivery re-run the job.
    assert.ok(DEDUPE_RETENTION_MS > 7 * 24 * 60 * 60 * 1000);
  });

  it("keeps the default lease above the 600s ack deadline", () => {
    // Below it, a legitimate redelivery of a still-running job would find an
    // expired lease and steal it — double-running the exact case this exists
    // to prevent.
    assert.ok(DEFAULT_LEASE_MS > 600 * 1000);
  });
});

// ── The claim protocol against a real unique index ───────────────────────

describe("createDedupeStore — claim protocol", () => {
  it("first delivery claims; a SECOND delivery of the same messageId is a no-op", async () => {
    const mongo = new FakeMongo();
    const store = storeAt(mongo);

    const first = await store.claim("m-1", "/jobs/price-sync");
    assert.equal(first.action, "RUN");

    await store.release("m-1", "COMPLETED");

    const second = await store.claim("m-1", "/jobs/price-sync");
    assert.equal(second.action, "SKIP_COMPLETED");
    assert.equal(mongo.docs.size, 1, "no second marker row was created");
  });

  it("SIMULTANEOUS redelivery: exactly one RUN, the loser is told to retry", async () => {
    const mongo = new FakeMongo();
    const store = storeAt(mongo);

    // Started without an intervening await, so both are in flight across the
    // fake's microtask yield — a genuine interleave.
    const [a, b] = await Promise.all([
      store.claim("m-race", "/jobs/price-sync"),
      store.claim("m-race", "/jobs/price-sync"),
    ]);

    const actions = [a.action, b.action].sort();
    assert.deepEqual(
      actions,
      ["RETRY_LATER", "RUN"],
      "the unique index must elect exactly one winner",
    );
    assert.equal(mongo.docs.size, 1);
  });

  it("five simultaneous deliveries still elect exactly one winner", async () => {
    const mongo = new FakeMongo();
    const store = storeAt(mongo);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.claim("m-5", "/jobs/mf-sync")),
    );
    assert.equal(results.filter((r) => r.action === "RUN").length, 1);
    assert.equal(results.filter((r) => r.action === "RETRY_LATER").length, 4);
  });

  it("handles E11000 arriving as a THROW, not just as writeErrors", async () => {
    const mongo = new FakeMongo();
    mongo.throwOnDuplicate = true;
    const store = storeAt(mongo);

    assert.equal((await store.claim("m-t", "/jobs/mf-sync")).action, "RUN");
    const second = await store.claim("m-t", "/jobs/mf-sync");
    assert.equal(second.action, "RETRY_LATER");
  });

  it("an EXPIRED lease is stolen once, and only once, across concurrent retries", async () => {
    const mongo = new FakeMongo();
    // Claim at T, then read the clock an hour and a second later so the
    // default lease has lapsed.
    const claimStore = storeAt(mongo, () => FIXED_NOW);
    assert.equal(
      (await claimStore.claim("m-crash", "/jobs/roast")).action,
      "RUN",
    );

    const later = FIXED_NOW + DEFAULT_LEASE_MS + 1000;
    const retryStore = storeAt(mongo, () => later);
    const results = await Promise.all([
      retryStore.claim("m-crash", "/jobs/roast"),
      retryStore.claim("m-crash", "/jobs/roast"),
      retryStore.claim("m-crash", "/jobs/roast"),
    ]);

    assert.equal(
      results.filter((r) => r.action === "RUN").length,
      1,
      "a crashed job must be retryable exactly once per lease",
    );
    assert.equal(results.filter((r) => r.action === "RETRY_LATER").length, 2);
    assert.equal(mongo.docs.get("m-crash")?.attempts, 2);
  });

  it("a FAILED marker is re-claimable so the job keeps its remaining attempts", async () => {
    const mongo = new FakeMongo();
    const store = storeAt(mongo);
    await store.claim("m-f", "/jobs/import");
    await store.release("m-f", "FAILED");

    const retry = await store.claim("m-f", "/jobs/import");
    assert.equal(retry.action, "RUN");
    assert.equal(retry.reason, "reclaim_after_failure");
    assert.equal(mongo.docs.get("m-f")?.status, "IN_FLIGHT");
  });

  it("a store outage fails OPEN rather than blocking the job", async () => {
    const mongo = new FakeMongo();
    mongo.failWith = new Error("connection refused");
    const store = storeAt(mongo);
    const d = await store.claim("m-down", "/jobs/price-sync");
    assert.equal(d.action, "RUN_UNTRACKED");
  });

  it("release never throws, even when the store is down", async () => {
    const mongo = new FakeMongo();
    mongo.failWith = new Error("connection refused");
    const store = storeAt(mongo);
    await store.release("m-down", "COMPLETED"); // must simply resolve
  });

  it("claims into the documented collection with a numeric lease", async () => {
    const mongo = new FakeMongo();
    await storeAt(mongo).claim("m-doc", "/jobs/price-sync");
    const doc = mongo.docs.get("m-doc");
    assert.ok(doc);
    assert.equal(doc.status, "IN_FLIGHT");
    assert.equal(doc.route, "/jobs/price-sync");
    assert.equal(
      typeof doc.leaseExpiresAt,
      "number",
      "the lease must be epoch ms, not an Extended-JSON date",
    );
    assert.equal(doc.leaseExpiresAt, FIXED_NOW + DEFAULT_LEASE_MS);
    // The TTL field DOES have to be a real date for Mongo's TTL monitor.
    assert.deepEqual(doc.expiresAt, {
      $date: new Date(FIXED_NOW + DEDUPE_RETENTION_MS).toISOString(),
    });
  });
});

// ── The middleware ───────────────────────────────────────────────────────

interface FakeCtx extends DedupeContext {
  body: unknown;
  jsonCalls: Array<{ body: unknown; status: number }>;
}

function ctx(path: string, body: unknown, resStatus = 200): FakeCtx {
  const jsonCalls: Array<{ body: unknown; status: number }> = [];
  return {
    body,
    jsonCalls,
    req: {
      path,
      json: async () => {
        if (body === Symbol.for("unparseable")) throw new SyntaxError("bad");
        return body;
      },
    },
    res: { status: resStatus },
    json: (b: unknown, status: number) => {
      jsonCalls.push({ body: b, status });
      return { b, status };
    },
  };
}

function recordingStore(
  claims: ClaimDecision[],
): DedupeStore & { released: Array<[string, string]> } {
  const released: Array<[string, string]> = [];
  let i = 0;
  return {
    released,
    claim: async () => claims[Math.min(i++, claims.length - 1)],
    release: async (id, outcome) => {
      released.push([id, outcome]);
    },
  };
}

const ENVELOPE = { message: { messageId: "abc", data: "e30=" } };

describe("createDedupeMiddleware", () => {
  it("runs the handler and marks COMPLETED on a 2xx", async () => {
    const store = recordingStore([{ action: "RUN", reason: "claimed" }]);
    const mw = createDedupeMiddleware({ store });
    let ran = 0;
    const c = ctx("/jobs/price-sync", ENVELOPE, 200);

    await mw(c, async () => {
      ran += 1;
    });

    assert.equal(ran, 1);
    assert.deepEqual(store.released, [["abc", "COMPLETED"]]);
    assert.equal(c.jsonCalls.length, 0, "the handler's own response is used");
  });

  it("second delivery of a COMPLETED messageId is a no-op: 200 + duplicate:true", async () => {
    const store = recordingStore([
      { action: "SKIP_COMPLETED", reason: "already_completed", attempts: 1 },
    ]);
    const logs: string[] = [];
    const mw = createDedupeMiddleware({ store, log: (m) => logs.push(m) });
    let ran = 0;
    const c = ctx("/jobs/price-sync", ENVELOPE);

    await mw(c, async () => {
      ran += 1;
    });

    assert.equal(ran, 0, "the job must NOT re-run");
    assert.deepEqual(c.jsonCalls, [
      { body: { success: true, duplicate: true }, status: 200 },
    ]);
    assert.ok(
      logs.some((l) => l.includes("duplicate:true")),
      "a duplicate:true log line is required",
    );
    assert.deepEqual(
      store.released,
      [],
      "nothing to release; we never claimed",
    );
  });

  it("an IN-FLIGHT duplicate NACKS (409) instead of acking", async () => {
    // Acking here would be the dangerous shortcut: the first delivery may yet
    // crash, and Pub/Sub would already believe the message was handled.
    const store = recordingStore([
      { action: "RETRY_LATER", reason: "in_flight_elsewhere" },
    ]);
    const mw = createDedupeMiddleware({ store });
    let ran = 0;
    const c = ctx("/jobs/price-sync", ENVELOPE);

    await mw(c, async () => {
      ran += 1;
    });

    assert.equal(ran, 0);
    assert.equal(c.jsonCalls[0]?.status, 409);
  });

  it("marks FAILED when the handler returns a non-2xx, keeping it retryable", async () => {
    const store = recordingStore([{ action: "RUN", reason: "claimed" }]);
    const mw = createDedupeMiddleware({ store });
    const c = ctx("/jobs/price-sync", ENVELOPE, 500);

    await mw(c, async () => {
      c.res.status = 500;
    });

    assert.deepEqual(store.released, [["abc", "FAILED"]]);
  });

  it("releases FAILED and rethrows when the handler throws", async () => {
    const store = recordingStore([{ action: "RUN", reason: "claimed" }]);
    const mw = createDedupeMiddleware({ store });
    const c = ctx("/jobs/price-sync", ENVELOPE);

    await assert.rejects(
      () => mw(c, async () => Promise.reject(new Error("boom"))),
      /boom/,
    );
    assert.deepEqual(
      store.released,
      [["abc", "FAILED"]],
      "a throwing handler must not leave an IN_FLIGHT marker blocking retries",
    );
  });

  it("does not claim a body without a real Pub/Sub messageId", async () => {
    let claimed = 0;
    const store: DedupeStore = {
      claim: async () => {
        claimed += 1;
        return { action: "RUN", reason: "claimed" };
      },
      release: async () => {},
    };
    const mw = createDedupeMiddleware({ store });
    let ran = 0;
    await mw(ctx("/jobs/price-sync", { exchanges: ["NSE"] }), async () => {
      ran += 1;
    });
    assert.equal(ran, 1);
    assert.equal(claimed, 0);
  });

  it("passes an unparseable body straight through", async () => {
    let claimed = 0;
    const store: DedupeStore = {
      claim: async () => {
        claimed += 1;
        return { action: "RUN", reason: "claimed" };
      },
      release: async () => {},
    };
    const mw = createDedupeMiddleware({ store });
    let ran = 0;
    await mw(ctx("/jobs/price-sync", Symbol.for("unparseable")), async () => {
      ran += 1;
    });
    assert.equal(ran, 1);
    assert.equal(claimed, 0);
  });

  it("skips the dead-letter route entirely", async () => {
    // The generic path answers a competing claim with 409 = nack, and nacking
    // a dead letter grows the one queue with no backstop.
    assert.ok(SELF_DEDUPING_ROUTES.includes("/jobs/dead-letter"));
    let claimed = 0;
    const store: DedupeStore = {
      claim: async () => {
        claimed += 1;
        return { action: "SKIP_COMPLETED", reason: "already_completed" };
      },
      release: async () => {},
    };
    const mw = createDedupeMiddleware({ store });
    let ran = 0;
    await mw(ctx("/jobs/dead-letter", ENVELOPE), async () => {
      ran += 1;
    });
    assert.equal(ran, 1, "the DLQ consumer must always be reached");
    assert.equal(claimed, 0);
  });

  it("runs the job when the dedupe store is unavailable (fail-open)", async () => {
    const store = recordingStore([
      { action: "RUN_UNTRACKED", reason: "dedupe_store_unavailable" },
    ]);
    const mw = createDedupeMiddleware({ store });
    let ran = 0;
    await mw(ctx("/jobs/price-sync", ENVELOPE), async () => {
      ran += 1;
    });
    assert.equal(ran, 1);
    assert.deepEqual(
      store.released,
      [],
      "an untracked run has no claim to release",
    );
  });

  it("end-to-end against the fake Mongo: the SAME message twice runs once", async () => {
    const mongo = new FakeMongo();
    const mw = createDedupeMiddleware({ store: storeAt(mongo) });
    let ran = 0;
    const handler = async (): Promise<void> => {
      ran += 1;
    };

    const c1 = ctx("/jobs/price-sync", ENVELOPE, 200);
    await mw(c1, handler);
    const c2 = ctx("/jobs/price-sync", ENVELOPE, 200);
    await mw(c2, handler);

    assert.equal(ran, 1, "the second delivery must not re-run the job");
    assert.deepEqual(c2.jsonCalls, [
      { body: { success: true, duplicate: true }, status: 200 },
    ]);
  });
});
