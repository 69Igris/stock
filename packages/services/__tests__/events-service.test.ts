/**
 * `publishEvents` — the one writer for `InstrumentEvent`. MONEY-1507 (C1).
 *
 * Drives the REAL function with its `upsert` / `ensureIndexes` seams injected,
 * so no Prisma is loaded and the failure branches — the ones a live call never
 * takes — are actually exercised.
 *
 * SUBPATH import, never the root barrel: a cold `require("@usemoney/services")`
 * costs 3,817 ms because it re-exports ~40 services and drags in research, roast
 * and the PDF renderer, against a 30,000 ms PER-FILE budget (MONEY-1489).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  EVENT_COLLECTION,
  EVENT_TTL_INDEX,
  enrichEvent,
  instrumentEventIndexCommand,
  instrumentEventUpsertArgs,
  publishEvent,
  publishEvents,
} from "../src/events.service";
import {
  instrumentEventSchema,
  secFilingEvent,
  type InstrumentEvent,
} from "@usemoney/core/events/event-types";

const OBSERVED = new Date("2026-08-29T02:00:00.000Z");

function event(accession = "0000320193-26-000106"): InstrumentEvent {
  return secFilingEvent(
    {
      accession,
      cik10: "0000320193",
      form: "8-K",
      listingId: "AAPL:NASDAQ:1980-12-12",
    },
    OBSERVED,
  );
}

/** Every optional contract field set, so every key is present to classify. */
function fullEvent(): InstrumentEvent {
  return instrumentEventSchema.parse({
    ...event(),
    entityId: "0000320193",
    summary: "Apple reported Q3 revenue.",
    evidenceUri: "https://www.sec.gov/x",
    publishedAt: new Date("2026-08-29T01:53:58.000Z"),
    supersedesEventId: "b".repeat(40),
    enrichedAt: new Date("2026-08-29T04:00:00.000Z"),
  });
}

/** Records every upsert; no Prisma, no Mongo. */
function recorder() {
  const rows: InstrumentEvent[] = [];
  return {
    rows,
    upsert: async (e: InstrumentEvent) => {
      rows.push(e);
    },
    ensureIndexes: async () => {},
    logError: () => {},
  };
}

/**
 * The arguments the REAL `defaultUpsert` hands Prisma, captured through a
 * delegate stub. `ensureIndexes` is stubbed too, so nothing reaches a database.
 */
async function prismaArgsFor(
  events: InstrumentEvent[],
): Promise<
  { create: Record<string, unknown>; update: Record<string, unknown> }[]
> {
  const { prisma } = await import("@usemoney/database");
  const calls: {
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }[] = [];
  const real = prisma.instrumentEvent.upsert;
  prisma.instrumentEvent.upsert = (async (args: {
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }) => {
    calls.push(args);
    return args.create;
  }) as never;
  try {
    await publishEvents(events, { ensureIndexes: async () => {} });
  } finally {
    prisma.instrumentEvent.upsert = real;
  }
  return calls;
}

describe("instrumentEventIndexCommand", () => {
  it("is a TTL index, not a plain one", () => {
    // `db push` creates no TTL index — Prisma has no syntax for one — so an
    // `@@index([expiresAt])` in the schema would create a PLAIN index that
    // deletes nothing while looking exactly like the TTL it is not.
    const cmd = instrumentEventIndexCommand() as {
      createIndexes: string;
      indexes: { name: string; expireAfterSeconds?: number }[];
    };
    assert.equal(cmd.createIndexes, EVENT_COLLECTION);
    const ttl = cmd.indexes.find((i) => i.name === EVENT_TTL_INDEX)!;
    // 0 makes `expiresAt` the DATE, not an offset: a non-zero value ADDS to a
    // date already in the future and silently extends every row's life.
    assert.equal(ttl.expireAfterSeconds, 0);
  });

  it("is keyed on expiresAt — never on observedAt or any ingest clock", () => {
    // MONEY-1521. A TTL on a CLOCK deletes on a timer, with no knowledge of
    // whether the lake took the row. `expiresAt` is written only by the lake
    // sink, after the silver INSERT, so the index can only delete what the lake
    // already holds.
    const cmd = instrumentEventIndexCommand() as {
      indexes: { name: string; key: Record<string, number> }[];
    };
    assert.deepEqual(cmd.indexes.find((i) => i.name === EVENT_TTL_INDEX)!.key, {
      expiresAt: 1,
    });
  });
});

describe("publishEvents", () => {
  it("upserts every event", async () => {
    const deps = recorder();
    const result = await publishEvents([event()], deps);
    assert.deepEqual(result, { upserted: 1, failed: 0 });
    assert.equal(deps.rows[0]!.eventId, event().eventId);
  });

  it("THROWS on an invalid event rather than storing it", async () => {
    // An invalid event is a bug in the producer, not a transient condition, and
    // admitting it would put a row in the serving copy no consumer can use.
    const deps = recorder();
    await assert.rejects(
      publishEvents([{ ...event(), severity: 9 }], deps),
      /severity|Number/i,
    );
    assert.equal(deps.rows.length, 0);
  });

  it("validates the WHOLE batch before writing ANY of it", async () => {
    // A half-written batch whose tail was invalid leaves the producer with no
    // way to tell which rows landed.
    const deps = recorder();
    await assert.rejects(
      publishEvents(
        [event(), { ...event("0000320193-26-000107"), market: "XX" }],
        deps,
      ),
    );
    assert.equal(deps.rows.length, 0);
  });

  it("COUNTS a per-row failure and carries on", async () => {
    // The callers are the EDGAR detect loop and the news poll, and neither may
    // be taken down by an events problem. `failed` is how a caller that needs
    // to fail finds out.
    let seen = 0;
    const result = await publishEvents(
      [event("0000320193-26-000106"), event("0000320193-26-000107")],
      {
        upsert: async () => {
          seen += 1;
          if (seen === 1) throw new Error("mongo blip");
        },
        ensureIndexes: async () => {},
        logError: () => {},
      },
    );
    assert.deepEqual(result, { upserted: 1, failed: 1 });
  });

  it("never reports a silent zero — an empty batch is 0/0, not a throw", async () => {
    assert.deepEqual(await publishEvents([], recorder()), {
      upserted: 0,
      failed: 0,
    });
  });

  it("ensures the TTL index before it writes", async () => {
    // Without it the collection grows for ever while every query still works —
    // invisible until the Atlas tier B6 is downgrading runs out of room.
    const order: string[] = [];
    await publishEvents([event()], {
      ensureIndexes: async () => void order.push("index"),
      upsert: async () => void order.push("upsert"),
      logError: () => {},
    });
    assert.deepEqual(order, ["index", "upsert"]);
  });

  it("publishEvent delegates, so there is ONE code path", async () => {
    const deps = recorder();
    await publishEvent(event(), deps);
    assert.equal(deps.rows.length, 1);
  });
});

describe("[control] the same event twice is the same key", () => {
  it("two emissions of one filing carry one eventId", async () => {
    // The Mongo upsert is keyed on it, so this is what collapses the four
    // EDGAR detectors into one row.
    const deps = recorder();
    await publishEvents([event(), event()], deps);
    assert.equal(deps.rows[0]!.eventId, deps.rows[1]!.eventId);
  });
});

describe("[MONEY-1531] observedAt is the FIRST sighting — create-only", () => {
  it("the CREATE carries it and the UPDATE never does", () => {
    // Every emission carries its own `new Date()`. In the shared write shape,
    // each re-emission overwrote the first sighting: 11,871 of 11,976 prod news
    // events (99.1%) carried a moved clock, median 4.8 h after their own
    // creation, and the lake sink appended every move as a new silver row.
    const args = instrumentEventUpsertArgs(event());
    assert.equal(args.where.eventId, event().eventId);
    assert.equal(args.create.observedAt.getTime(), OBSERVED.getTime());
    assert.ok(
      !("observedAt" in args.update),
      "a re-emission must not move the first-sighting clock",
    );
  });

  it("every contract field is written on CREATE, and every one but the first-sighting clock on UPDATE", () => {
    // The discipline the shared shape exists for, kept honest now that there
    // are two shapes: a new contract field must land on BOTH writes unless it is
    // deliberately declared create-only. Checked against a fully-populated
    // event, so an optional field cannot hide by being absent.
    const full = fullEvent();
    const args = instrumentEventUpsertArgs(full);
    const createKeys = Object.keys(args.create).sort();
    for (const key of Object.keys(full)) {
      assert.ok(createKeys.includes(key), `${key} is never written`);
    }
    assert.deepEqual(
      Object.keys(args.update).sort(),
      createKeys.filter((k) => k !== "eventId" && k !== "observedAt"),
    );
  });
});

describe("[MONEY-1521] publishEvents never writes expiresAt", () => {
  it("neither the CREATE nor the UPDATE names it", () => {
    // Mongo's TTL monitor skips a document whose indexed field is ABSENT, and
    // that skip is the interlock: only the lake sink may stamp the field, after
    // the silver INSERT. A row this writer creates is born un-expirable. Not
    // even `null` — an explicit null is a write, and "absent" is the contract.
    const args = instrumentEventUpsertArgs(fullEvent());
    assert.ok(!("expiresAt" in args.create));
    assert.ok(!("expiresAt" in args.update));
  });

  it("the REAL write path hands Prisma no expiresAt and no update clock", async () => {
    // The layer that runs: `defaultUpsert` through a delegate stub, so a
    // wrapper that re-added the field around the builder would show here.
    const calls = await prismaArgsFor([event()]);
    assert.equal(calls.length, 1);
    assert.ok(!("expiresAt" in calls[0]!.create));
    assert.ok(!("expiresAt" in calls[0]!.update));
    assert.ok("observedAt" in calls[0]!.create);
    assert.ok(!("observedAt" in calls[0]!.update));
  });

  it("the schema keeps expiresAt OPTIONAL and without a @default", () => {
    // A required field, or a default, would stamp every CREATE — and restore
    // the delete-on-a-timer design MONEY-1521 removed, while this file still
    // looked clean. Read from the schema text, because that is where the change
    // would be made.
    const schema = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../database/prisma/schema.prisma",
      ),
      "utf8",
    );
    const model = /^model InstrumentEvent \{([\s\S]*?)^\}/m.exec(schema)?.[1];
    assert.ok(model, "model InstrumentEvent not found");
    const field = /^\s*expiresAt\s+(\S+)(.*)$/m.exec(model);
    assert.ok(field, "InstrumentEvent.expiresAt not found");
    assert.equal(field[1], "DateTime?");
    assert.doesNotMatch(field[2]!, /@default/);
  });
});

describe("enrichEvent (MONEY-1507 C1 item 4)", () => {
  it("writes ONLY the summary and the enrichment clock", async () => {
    // A PARTIAL update, never an upsert. The insight sweep reads
    // `us_filing_documents`, which carries no `acceptedAt`, so rebuilding the
    // whole event would downgrade `publishedAt` from SEC's acceptance INSTANT
    // to the filing DATE — on a row that already held the better value.
    const calls: { id: string; e: { summary: string; enrichedAt: Date } }[] =
      [];
    const at = new Date("2026-09-02T04:00:00.000Z");
    const result = await enrichEvent(
      "a".repeat(40),
      { summary: "Apple reported Q3 revenue.", enrichedAt: at },
      { update: async (id, e) => void calls.push({ id, e }) },
    );
    assert.deepEqual(result, { enriched: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.id, "a".repeat(40));
    assert.deepEqual(Object.keys(calls[0]!.e).sort(), [
      "enrichedAt",
      "summary",
    ]);
  });

  it("a MISSING row is a NAMED no-op, never a create", async () => {
    // The event may legitimately not exist: the filing predates C1, the
    // detector's fail-soft emission dropped it, the TTL reaped it after the
    // lake took it. Creating one here would invent an event with no market, no
    // listing and a `severity` defaulted to something — a number C4's alert
    // floor reads.
    const notFound = Object.assign(new Error("not found"), { code: "P2025" });
    const result = await enrichEvent(
      "b".repeat(40),
      { summary: "s", enrichedAt: new Date() },
      {
        update: async () => {
          throw notFound;
        },
      },
    );
    assert.deepEqual(result, { enriched: false, reason: "not-found" });
  });

  it("RETHROWS a real database failure — it is not an absent row", async () => {
    // Swallowing everything would make an outage read as "no events to
    // enrich", which is the shape a healthy quiet hour also has.
    await assert.rejects(
      enrichEvent(
        "c".repeat(40),
        { summary: "s", enrichedAt: new Date() },
        {
          update: async () => {
            throw Object.assign(new Error("connection reset"), {
              code: "P1001",
            });
          },
        },
      ),
      /connection reset/,
    );
  });
});

describe("[MONEY-1507] a re-emission cannot erase an enrichment", () => {
  it("omits summary / enrichedAt from the UPDATE when the event has none", async () => {
    // `enrichEvent` is their other writer and runs AFTER the detector. A plain
    // `update: row` would set them back to null on any replay — the row still
    // exists, still has its title, and the events tab simply stops showing the
    // sentence. Nothing reports that.
    const calls = await prismaArgsFor([event()]);
    assert.equal(calls.length, 1);
    assert.ok("summary" in calls[0]!.create, "a CREATE still states them");
    assert.ok("enrichedAt" in calls[0]!.create);
    assert.ok(
      !("summary" in calls[0]!.update),
      "an UPDATE with no summary must leave the column alone",
    );
    assert.ok(!("enrichedAt" in calls[0]!.update));
  });
});
