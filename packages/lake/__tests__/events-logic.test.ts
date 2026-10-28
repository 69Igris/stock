/**
 * Mongo -> silver row shapes, and the DDL they are written against.
 * MONEY-1507 (data-platform C1).
 *
 * The mappers' keys ARE column names — both jobs write with
 * `INSERT/MERGE ... FROM UNNEST(@rows)`, which reads each struct field BY NAME.
 * A camelCase key does not fail; it supplies NULL for its column and the
 * statement reports success. So the row shape is pinned against the DDL text
 * rather than against itself.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { splitStatements } from "../src/ddl";
import {
  CLOCK_REPAIR_BACKUP_COLLECTION,
  CLOCK_SKEW_TOLERANCE_MS,
  EVENT_RETENTION_DAYS,
  EVENT_SINK_PARSER_VERSION,
  FILING_REGISTRY_PARSER_VERSION,
  INSTRUMENT_EVENTS_COLLECTION,
  SINK_OVERLAP_MS,
  appendThenStamp,
  chunkRows,
  clockRepairBackup,
  clockRepairCommand,
  clockRepairVerdict,
  eventExpiresAt,
  eventSilverKey,
  eventSourceObjectUri,
  observedAfterIngest,
  parseClockRepairArgs,
  planClockRepair,
  planClockRestore,
  planEventSink,
  sinkSelection,
  sinkWindowStart,
  stampExpiryCommand,
  toEventSilverRow,
  toFilingRegistryRow,
  type ClockBackupDoc,
  type EventClockRepair,
  type EventClockRow,
  type EventSilverRow,
  type MongoEventRow,
  type MongoFilingRow,
} from "../src/events-logic";

const DDL = readFileSync(
  join(import.meta.dirname, "..", "ddl", "008_silver_instrument_event.sql"),
  "utf8",
);

const OBSERVED = new Date("2026-08-29T02:00:00.000Z");

function mongoEvent(overrides: Partial<MongoEventRow> = {}): MongoEventRow {
  return {
    eventId: "a".repeat(40),
    market: "US",
    listingId: "AAPL:NASDAQ:1980-12-12",
    entityId: "0000320193",
    eventType: "FILING_8K",
    severity: 2,
    title: "Apple Inc. — 8-K",
    summary: null,
    evidenceUri: "https://www.sec.gov/x",
    source: "SEC_EDGAR",
    sourceRecordKey: "0000320193-26-000106",
    publishedAt: new Date("2026-08-29T01:53:58.000Z"),
    observedAt: OBSERVED,
    linkerVersion: "sec-exact-v1",
    confidence: 1,
    tags: ["form:8-K"],
    supersedesEventId: null,
    enrichedAt: null,
    ...overrides,
  };
}

function mongoFiling(overrides: Partial<MongoFilingRow> = {}): MongoFilingRow {
  return {
    accession: "0000320193-26-000106",
    cik10: "0000320193",
    form: "8-K",
    filedAt: new Date("2026-08-30T00:00:00.000Z"),
    acceptedAt: new Date("2026-08-29T21:53:58.000Z"),
    periodOfReport: new Date("2026-06-30T00:00:00.000Z"),
    items: ["2.02"],
    primaryDocument: "aapl-8k.htm",
    isXbrl: true,
    isInlineXbrl: false,
    sizeBytes: 1234,
    parseClass: "EIGHTK",
    status: "DETECTED",
    rawPath: "stockbook-content-prod/edgar/filings/x.zip",
    ...overrides,
  };
}

/* ── sinkWindowStart ──────────────────────────────────────────────────── */

describe("sinkWindowStart (MONEY-1507)", () => {
  it("returns NULL on an empty table so a first run is distinguishable", () => {
    // Returned as null rather than epoch-zero: the caller says "FIRST RUN" out
    // loud instead of silently reading everything and looking like a normal
    // night.
    assert.equal(sinkWindowStart(null), null);
  });

  it("subtracts the overlap, because producer clocks are not monotonic", () => {
    // A row can reach Mongo AFTER a run has passed its observed_at. A strict
    // `>` would drop it permanently and leave a gap no count can see — the
    // reasoning behind tiingo-news-poll's 30-minute crawlDate overlap.
    const start = sinkWindowStart(OBSERVED)!;
    assert.equal(OBSERVED.getTime() - start.getTime(), SINK_OVERLAP_MS);
  });

  it("REFUSES an Invalid Date rather than reading everything for ever", () => {
    // Every comparison against an Invalid Date is false, so the window would
    // silently become "no rows", on every run, reported as a clean night.
    assert.throws(() => sinkWindowStart(new Date("nope")), /Invalid Date/);
  });
});

describe("chunkRows", () => {
  it("splits on the boundary", () => {
    assert.deepEqual(chunkRows([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });

  it("REFUSES a non-positive size — it would write nothing and report success", () => {
    assert.throws(() => chunkRows([1], 0), /positive integer/);
    assert.throws(() => chunkRows([1], 1.5), /positive integer/);
  });
});

/* ── toEventSilverRow ─────────────────────────────────────────────────── */

describe("toEventSilverRow", () => {
  it("emits snake_case keys — they ARE the column names", () => {
    const row = toEventSilverRow(mongoEvent());
    for (const key of Object.keys(row)) {
      assert.ok(
        !/[A-Z]/.test(key),
        `camelCase key ${key} would supply NULL silently`,
      );
    }
  });

  it("every emitted key is a column the DDL declares", () => {
    // The join. A mapper that is internally consistent and disagrees with the
    // table is the failure this pins: `INSERT ... FROM UNNEST` reads by NAME.
    const create = splitStatements(DDL).find((s) =>
      s.includes("{{DATASET}}.instrument_event"),
    )!;
    for (const key of Object.keys(toEventSilverRow(mongoEvent()))) {
      assert.match(
        create,
        new RegExp(`\\b${key}\\b`),
        `${key} is produced by the mapper and absent from the DDL`,
      );
    }
  });

  it("carries observed_at as the SOURCE's clock, in RFC-3339", () => {
    assert.equal(
      toEventSilverRow(mongoEvent()).observed_at,
      OBSERVED.toISOString(),
    );
  });

  it("names the ASSERTION in source_object_uri — there is no archived object", () => {
    assert.equal(
      toEventSilverRow(mongoEvent()).source_object_uri,
      eventSourceObjectUri("SEC_EDGAR", "0000320193-26-000106"),
    );
  });

  it("REFUSES an Invalid Date rather than writing it as NULL", () => {
    // A null timestamp means "the source never stated one", which is a
    // different and perfectly ordinary fact.
    assert.throws(
      () => toEventSilverRow(mongoEvent({ publishedAt: new Date("nope") })),
      /Invalid Date/,
    );
  });

  it("keeps a genuinely absent clock as null", () => {
    assert.equal(
      toEventSilverRow(mongoEvent({ publishedAt: null })).published_at,
      null,
    );
  });

  it("copies tags rather than aliasing the Mongo array", () => {
    const source = mongoEvent();
    const row = toEventSilverRow(source);
    row.tags.push("mutated");
    assert.deepEqual(source.tags, ["form:8-K"]);
  });
});

/* ── toFilingRegistryRow ──────────────────────────────────────────────── */

describe("toFilingRegistryRow", () => {
  it("every emitted key is a column the DDL declares", () => {
    const create = splitStatements(DDL).find((s) =>
      s.includes("{{DATASET}}.filing_registry"),
    )!;
    for (const key of Object.keys(toFilingRegistryRow(mongoFiling(), null))) {
      assert.match(
        create,
        new RegExp(`\\b${key}\\b`),
        `${key} absent from the DDL`,
      );
    }
  });

  it("observes on ACCEPTANCE, not on the filing date", () => {
    // `filedAt` is the NEXT business day for anything accepted after the
    // 17:30/22:00 ET cut-offs, so using it as the observation clock claims we
    // knew about a filing before it was accepted.
    const row = toFilingRegistryRow(mongoFiling(), null);
    assert.equal(row.observed_at, "2026-08-29T21:53:58.000Z");
    assert.equal(row.filed_at, "2026-08-30");
  });

  it("falls back to the filing date at UTC midnight when SEC gave no instant", () => {
    const row = toFilingRegistryRow(mongoFiling({ acceptedAt: null }), null);
    assert.equal(row.observed_at, "2026-08-30T00:00:00.000Z");
  });

  it("coerces the two XBRL booleans, because Mongo OMITS a false default", () => {
    // `UsFilingRow.to_doc()` drops null/false fields, so the attribute is
    // ABSENT on a freshly detected row — and `undefined` in an UNNEST struct
    // lands as NULL in a `BOOL NOT NULL` column, which fails the whole batch.
    const bare = { ...mongoFiling() } as Record<string, unknown>;
    delete bare.isXbrl;
    delete bare.isInlineXbrl;
    const row = toFilingRegistryRow(bare as unknown as MongoFilingRow, null);
    assert.equal(row.is_xbrl, false);
    assert.equal(row.is_inline_xbrl, false);
  });

  it("REFUSES a filing with no filedAt rather than defaulting to today", () => {
    // Defaulting would file a decade-old filing in this month's data.
    const bad = {
      ...mongoFiling(),
      filedAt: null,
    } as unknown as MongoFilingRow;
    assert.throws(() => toFilingRegistryRow(bad, null), /no filedAt/);
  });

  it("carries the listing when one was resolved, and null when not", () => {
    assert.equal(
      toFilingRegistryRow(mongoFiling(), "AAPL:NASDAQ:1980-12-12").listing_id,
      "AAPL:NASDAQ:1980-12-12",
    );
    assert.equal(toFilingRegistryRow(mongoFiling(), null).listing_id, null);
  });

  it("points source_object_uri at the archived bundle when there is one", () => {
    assert.equal(
      toFilingRegistryRow(mongoFiling(), null).source_object_uri,
      "gs://stockbook-content-prod/edgar/filings/x.zip",
    );
    assert.equal(
      toFilingRegistryRow(mongoFiling({ rawPath: null }), null)
        .source_object_uri,
      "sec://edgar/0000320193/0000320193-26-000106",
    );
  });
});

/* ── The DDL itself ───────────────────────────────────────────────────── */

describe("008_silver_instrument_event.sql", () => {
  const statements = splitStatements(DDL);

  it("declares exactly the two tables C1 names", () => {
    assert.equal(statements.length, 2);
    assert.ok(
      statements.every((s) => s.includes("CREATE TABLE IF NOT EXISTS")),
    );
  });

  it("targets {{DATASET}}, which the applier resolves from the 008_silver_ prefix", () => {
    // `lake-apply-ddl.ts` reads the LAYER from the filename and REFUSES an
    // unrecognised one, because a silver table created in the bronze dataset is
    // then hidden for ever by `IF NOT EXISTS` (MONEY-1496).
    for (const s of statements) assert.match(s, /\{\{DATASET\}\}/);
  });

  it("partitions instrument_event on observed_at — OUR clock, not the source's", () => {
    // lake-layout.md §6: point-in-time correctness is observed_at. EDGAR's
    // filing date is the NEXT business day for anything accepted after the ET
    // cut-offs, so partitioning on the source clock files a whole evening peak
    // a day forward.
    const create = statements.find((s) => s.includes("instrument_event"))!;
    assert.match(create, /PARTITION BY DATE\(observed_at\)/);
    assert.match(create, /CLUSTER BY market, listing_id, event_type/);
  });

  it("does NOT partition filing_registry, and clusters it market-first", () => {
    // `listing`'s precedent in 003: every query is a key lookup, and BigQuery
    // serves an unfiltered COUNT(*) — which is B6 lever 3's whole use — from
    // metadata at zero bytes.
    const create = statements.find((s) => s.includes("filing_registry"))!;
    assert.ok(!/PARTITION BY/.test(create));
    assert.match(create, /CLUSTER BY market, cik10, form/);
  });

  it("carries all six mandatory silver columns on BOTH tables", () => {
    // lake-layout.md §5. Without source_object_uri and parser_version a wrong
    // number cannot be traced to the bytes and the code that produced it, and
    // the only available repair is to rebuild everything.
    const mandatory = [
      "source_object_uri",
      "source_record_key",
      "parser_version",
      "pipeline_run_id",
      "observed_at",
      "ingested_at",
    ];
    for (const s of statements) {
      for (const column of mandatory) {
        assert.match(s, new RegExp(`\\b${column}\\b`), `${column} missing`);
      }
    }
  });

  it("types confidence FLOAT64 — it is a score, not money", () => {
    // 001's cost_usd is NUMERIC for the opposite reason. A money column typed
    // FLOAT64 is the defect; a score typed NUMERIC is only noise.
    const create = statements.find((s) => s.includes("instrument_event"))!;
    assert.match(create, /confidence\s+FLOAT64\s+NOT NULL/);
  });

  it("keeps listing_id NULLABLE on both tables", () => {
    // An event about a filer we cannot yet map is still a real event. A NOT
    // NULL here would make the producer DROP it, shrinking the corpus with
    // nothing to measure the loss against.
    for (const s of statements) {
      assert.ok(!/listing_id\s+STRING\s+NOT NULL/.test(s));
    }
  });
});

describe("[control] the parser versions are distinct", () => {
  it("one per table, so a reparse of one is identifiable", () => {
    assert.notEqual(EVENT_SINK_PARSER_VERSION, FILING_REGISTRY_PARSER_VERSION);
  });
});

describe("eventSilverKey — the sink's skip set (MONEY-1507)", () => {
  it("separates an ENRICHMENT from the row it enriches", () => {
    // The enrichment appends a second row with the SAME event_id AND the same
    // observed_at: the producer's clock does not move, because we saw the
    // filing when we saw it. A two-part key would skip it and the summary would
    // never reach the lake, with both tables looking entirely healthy.
    const base = {
      event_id: "a".repeat(40),
      observed_at: "2026-08-29T02:00:00.000Z",
    };
    assert.notEqual(
      eventSilverKey({ ...base, enriched_at: null }),
      eventSilverKey({ ...base, enriched_at: "2026-08-29T04:00:00.000Z" }),
    );
  });

  it("is stable — the same row twice is the same key", () => {
    const row = {
      event_id: "a".repeat(40),
      observed_at: "2026-08-29T02:00:00.000Z",
      enriched_at: null,
    };
    assert.equal(eventSilverKey(row), eventSilverKey({ ...row }));
  });

  it("separates on a NUL, so a printable separator cannot be forged", () => {
    // An ISO timestamp carries `:` and `.`, so either would be a separator a
    // part can itself produce — and a collision here is a row silently skipped,
    // not an error.
    assert.notEqual(
      eventSilverKey({
        event_id: "a",
        observed_at: "b:c",
        enriched_at: null,
      }),
      eventSilverKey({ event_id: "a:b", observed_at: "c", enriched_at: null }),
    );
  });

  it("accepts the mapper's own output unchanged", () => {
    // The JOIN. The sink compares a key built from a Mongo row against one
    // built from a BigQuery row, and the two only ever agree if this function
    // reads the mapper's shape.
    const row = toEventSilverRow(mongoEvent());
    assert.equal(
      eventSilverKey(row),
      eventSilverKey({
        event_id: row.event_id,
        observed_at: row.observed_at,
        enriched_at: row.enriched_at,
      }),
    );
  });
});

/* ── The serving copy's lifecycle — MONEY-1521 / MONEY-1531 ─────────────── */

const REPO = join(import.meta.dirname, "..", "..", "..");

/** A silver row whose key is `(id, OBSERVED, null)`. */
function silverRow(id: string): EventSilverRow {
  return toEventSilverRow(mongoEvent({ eventId: id.padEnd(40, "0") }));
}

describe("eventExpiresAt — the date the TTL may delete a row the lake holds", () => {
  it("is observed_at + the declared retention", () => {
    assert.equal(
      eventExpiresAt(OBSERVED.toISOString()).getTime() - OBSERVED.getTime(),
      EVENT_RETENTION_DAYS * 86_400_000,
    );
  });

  it("anchors on the EVENT's clock, never on the stamp time", () => {
    // The sink re-confirms rows it re-reads. Anchored on `now`, every re-read
    // would push the expiry forward and a row would never expire at all.
    const old = "2020-01-01T00:00:00.000Z";
    assert.equal(
      eventExpiresAt(old).toISOString(),
      new Date(
        Date.parse(old) + EVENT_RETENTION_DAYS * 86_400_000,
      ).toISOString(),
    );
  });

  it("REFUSES a value that is not a timestamp — it is a deletion date", () => {
    assert.throws(() => eventExpiresAt("nope"), /not a timestamp/);
  });
});

describe("sinkSelection — what a sink run reads", () => {
  it("reads EVERYTHING on a first run or a reload", () => {
    assert.deepEqual(sinkSelection(null), {});
  });

  it("reads the window PLUS every row the lake has not confirmed", () => {
    // An absent `expiresAt` is "not yet in the lake". Without that arm a run
    // killed between two INSERT chunks, a failed stamp, and every row sunk
    // before MONEY-1521 would sit outside every later window for good.
    // `isSet: false`, never `null` — a Prisma `null` matches only an explicit
    // null, and the field is ABSENT until stamped.
    const since = new Date("2026-09-23T00:00:00.000Z");
    assert.deepEqual(sinkSelection(since), {
      OR: [{ updatedAt: { gte: since } }, { expiresAt: { isSet: false } }],
    });
  });
});

describe("observedAfterIngest — the MONEY-1531 signature the sink refuses", () => {
  const ingestedAt = new Date("2026-09-22T13:03:36.269Z");
  const at = (ms: number) => new Date(ingestedAt.getTime() + ms);

  it("refuses a first-sighting clock moved past its own creation", () => {
    // The smallest move measured on prod 2026-09-23 was 174 s.
    assert.equal(
      observedAfterIngest({ observedAt: at(174_000), ingestedAt }),
      true,
    );
  });

  it("passes a clock that LEADS its creation, as every first emission does", () => {
    // The news poll stamps `observedAt` before its write loop: the 105 unmoved
    // prod rows lead their `ingestedAt` by up to 72 s.
    assert.equal(
      observedAfterIngest({ observedAt: at(-72_086), ingestedAt }),
      false,
    );
  });

  it("tolerates producer/writer clock skew up to the stated bound", () => {
    assert.equal(
      observedAfterIngest({
        observedAt: at(CLOCK_SKEW_TOLERANCE_MS),
        ingestedAt,
      }),
      false,
    );
    assert.equal(
      observedAfterIngest({
        observedAt: at(CLOCK_SKEW_TOLERANCE_MS + 1),
        ingestedAt,
      }),
      true,
    );
  });
});

describe("planEventSink — confirmed means IN SILVER, never 'seen in this batch'", () => {
  it("stamps what silver holds and appends what it does not", () => {
    const held = silverRow("a");
    const fresh = silverRow("b");
    const plan = planEventSink([held, fresh], new Set([eventSilverKey(held)]));
    assert.deepEqual(plan.confirmed, [held]);
    assert.deepEqual(plan.pending, [fresh]);
  });

  it("a duplicate of a PENDING row is dropped — never confirmed", () => {
    // Confirming it would stamp it before its twin's INSERT lands, which is a
    // licence to delete a row the lake never took.
    const fresh = silverRow("b");
    const plan = planEventSink([fresh, { ...fresh }], new Set());
    assert.equal(plan.pending.length, 1);
    assert.equal(plan.confirmed.length, 0);
  });

  it("a changed key is PENDING even when an older key of the event is in silver", () => {
    // An enrichment, or a repaired clock: the lake holds the event, but not at
    // its CURRENT key — and the current state is what a stamp vouches for.
    const old = silverRow("a");
    const enriched = { ...old, enriched_at: "2026-08-29T04:00:00.000Z" };
    const plan = planEventSink([enriched], new Set([eventSilverKey(old)]));
    assert.deepEqual(plan.pending, [enriched]);
    assert.equal(plan.confirmed.length, 0);
  });
});

describe("appendThenStamp — a stamp only ever follows its own INSERT", () => {
  /** Logs every effect call as `append:<ids>` / `stamp:<ids>`. */
  function effects(failAppendOn?: string) {
    const log: string[] = [];
    const ids = (rows: readonly EventSilverRow[]) =>
      rows.map((r) => r.event_id[0]).join("");
    return {
      log,
      fx: {
        append: async (rows: readonly EventSilverRow[]) => {
          log.push(`append:${ids(rows)}`);
          if (failAppendOn && ids(rows).includes(failAppendOn)) {
            throw new Error("bigquery said no");
          }
        },
        stamp: async (rows: readonly EventSilverRow[]) => {
          log.push(`stamp:${ids(rows)}`);
          return rows.length;
        },
      },
    };
  }

  it("orders every chunk INSERT -> stamp, and stamps confirmed rows last", async () => {
    // The ORDER is the assertion, not the totals: a stamp is what lets the TTL
    // monitor delete, so it may only follow the INSERT that carried the row.
    const { log, fx } = effects();
    const out = await appendThenStamp(
      {
        pending: [silverRow("b"), silverRow("c"), silverRow("d")],
        confirmed: [silverRow("a")],
      },
      2,
      fx,
    );
    assert.deepEqual(log, [
      "append:bc",
      "stamp:bc",
      "append:d",
      "stamp:d",
      "stamp:a",
    ]);
    assert.deepEqual(out, { appended: 3, stamped: 4 });
  });

  it("a failed INSERT stamps NOTHING it carried, and nothing after it", async () => {
    // The chunk that landed stays stamped; the one that did not stays
    // unstamped — un-expirable, and back in the next run's selection.
    const { log, fx } = effects("d");
    await assert.rejects(
      appendThenStamp(
        {
          pending: [silverRow("b"), silverRow("c"), silverRow("d")],
          confirmed: [silverRow("a")],
        },
        2,
        fx,
      ),
      /bigquery said no/,
    );
    assert.deepEqual(log, ["append:bc", "stamp:bc", "append:d"]);
  });
});

describe("stampExpiryCommand — raw, compare-and-set, never moves updatedAt", () => {
  it("stamps observed_at + retention on the row matching the silver key", () => {
    const row = silverRow("a");
    const cmd = stampExpiryCommand([row]);
    assert.equal(cmd.update, INSTRUMENT_EVENTS_COLLECTION);
    assert.deepEqual(cmd.updates, [
      {
        // The whole key, so a row enriched after this run read it is NOT
        // stamped: its summary is not in the lake yet.
        q: {
          eventId: row.event_id,
          observedAt: { $date: row.observed_at },
          enrichedAt: null,
        },
        u: {
          $set: {
            expiresAt: { $date: eventExpiresAt(row.observed_at).toISOString() },
          },
        },
      },
    ]);
  });

  it("matches an enriched row on its enrichment clock", () => {
    const row = { ...silverRow("a"), enriched_at: "2026-08-29T04:00:00.000Z" };
    assert.deepEqual(stampExpiryCommand([row]).updates[0]!.q.enrichedAt, {
      $date: "2026-08-29T04:00:00.000Z",
    });
  });

  it("the collection is the InstrumentEvent model's @@map", () => {
    // A raw command names a COLLECTION; a wrong one matches nothing and
    // reports `n: 0` — a stamp that silently never happens.
    const schema = readFileSync(
      join(REPO, "packages/database/prisma/schema.prisma"),
      "utf8",
    );
    const model = /^model InstrumentEvent \{([\s\S]*?)^\}/m.exec(schema)?.[1];
    assert.ok(model, "model InstrumentEvent not found");
    assert.match(
      model,
      new RegExp(`@@map\\("${INSTRUMENT_EVENTS_COLLECTION}"\\)`),
    );
  });
});

describe("[MONEY-1531] the reload keys on a version the moved rows do not carry", () => {
  it("is not v1", () => {
    // Every v1 row on prod carries a re-emission's clock. `--reload` skips only
    // CURRENT-version keys and deletes the rest once replaced, so a current
    // version equal to v1 would treat the wrong rows as already rebuilt.
    assert.notEqual(EVENT_SINK_PARSER_VERSION, "event-lake-sink-v1");
  });
});

describe("planClockRepair — observedAt := min(observedAt, ingestedAt), $unset expiresAt", () => {
  const ingestedAt = new Date("2026-09-22T13:03:36.269Z");
  const stamped = new Date("2026-10-22T21:59:34.502Z");
  const row = (over: Partial<EventClockRow>): EventClockRow => ({
    id: "6a0000000000000000000001",
    eventId: "e".repeat(40),
    observedAt: ingestedAt,
    ingestedAt,
    expiresAt: null,
    ...over,
  });

  it("restores a moved clock to the create instant and clears the timer", () => {
    const moved = new Date("2026-09-22T21:59:34.502Z");
    assert.deepEqual(
      planClockRepair(row({ observedAt: moved, expiresAt: stamped })),
      {
        id: "6a0000000000000000000001",
        eventId: "e".repeat(40),
        observedAtWas: moved,
        expiresAtWas: stamped,
        observedAt: ingestedAt,
        unsetExpiresAt: true,
      },
    );
  });

  it("never moves a clock that leads its creation — only clears the timer", () => {
    // min(), not "set to ingestedAt": an unmoved first sighting is up to 72 s
    // BETTER than the create instant, and overwriting it would make it worse.
    const early = new Date(ingestedAt.getTime() - 72_086);
    const plan = planClockRepair(
      row({ observedAt: early, expiresAt: stamped }),
    );
    assert.equal(plan?.observedAt, null);
    assert.equal(plan?.unsetExpiresAt, true);
  });

  it("is IDEMPOTENT — the repaired row plans nothing", () => {
    const moved = row({
      observedAt: new Date("2026-09-23T04:00:00.000Z"),
      expiresAt: stamped,
    });
    const plan = planClockRepair(moved)!;
    const repaired = row({
      observedAt: plan.observedAt ?? moved.observedAt,
      expiresAt: plan.unsetExpiresAt ? null : moved.expiresAt,
    });
    assert.equal(planClockRepair(repaired), null);
  });
});

describe("clockRepairCommand", () => {
  const was = new Date("2026-09-22T21:59:34.502Z");
  const ingestedAt = new Date("2026-09-22T13:03:36.269Z");

  it("compare-and-sets on the clock it READ", () => {
    // A row the pre-fix writer re-stamps between the read and the write is
    // left alone and counted as unmatched, never overwritten blind.
    const cmd = clockRepairCommand([
      {
        id: "6a0000000000000000000001",
        eventId: "e".repeat(40),
        observedAtWas: was,
        expiresAtWas: null,
        observedAt: ingestedAt,
        unsetExpiresAt: true,
      },
    ]);
    assert.equal(cmd.update, INSTRUMENT_EVENTS_COLLECTION);
    assert.deepEqual(cmd.updates[0], {
      q: { eventId: "e".repeat(40), observedAt: { $date: was.toISOString() } },
      u: {
        $set: { observedAt: { $date: ingestedAt.toISOString() } },
        $unset: { expiresAt: "" },
      },
    });
  });

  it("writes only what the plan changes", () => {
    const cmd = clockRepairCommand([
      {
        id: "6a0000000000000000000001",
        eventId: "e".repeat(40),
        observedAtWas: was,
        expiresAtWas: null,
        observedAt: null,
        unsetExpiresAt: true,
      },
    ]);
    assert.deepEqual(cmd.updates[0]!.u, { $unset: { expiresAt: "" } });
  });

  it("REFUSES a repair that changes nothing — `u: {}` REPLACES the document", () => {
    assert.throws(
      () =>
        clockRepairCommand([
          {
            id: "6a0000000000000000000001",
            eventId: "e".repeat(40),
            observedAtWas: was,
            expiresAtWas: null,
            observedAt: null,
            unsetExpiresAt: false,
          },
        ]),
      /changes nothing/,
    );
  });
});

describe("clockRepairBackup — the fields it changes, AS READ, keyed on _id", () => {
  const id = "6a0000000000000000000001";
  const was = new Date("2026-09-22T21:59:34.502Z");
  const ingestedAt = new Date("2026-09-22T13:03:36.269Z");
  const stamped = new Date("2026-10-22T21:59:34.502Z");
  const repair = (over: Partial<EventClockRepair>): EventClockRepair => ({
    id,
    eventId: "e".repeat(40),
    observedAtWas: was,
    expiresAtWas: stamped,
    observedAt: ingestedAt,
    unsetExpiresAt: true,
    ...over,
  });

  it("stores the original observedAt and expiresAt, and what overwrote them", () => {
    assert.equal(
      CLOCK_REPAIR_BACKUP_COLLECTION,
      "instrument_events_money1531_backup",
    );
    assert.deepEqual(clockRepairBackup(repair({})), {
      id,
      role: "MOVED",
      doc: {
        _id: { $oid: id },
        eventId: "e".repeat(40),
        observedAt: { $date: was.toISOString() },
        expiresAt: { $date: stamped.toISOString() },
      },
      wrote: {
        observedAt: { $date: ingestedAt.toISOString() },
        expiresAt: null,
      },
    });
  });

  it("records only the fields the repair writes", () => {
    // `wrote` is what the restore trusts: a field listed here that the repair
    // never touched would be "restored" over a value it never replaced.
    const b = clockRepairBackup(repair({ observedAt: null }));
    assert.equal(b.role, "EXPIRY_ONLY");
    assert.deepEqual(b.wrote, { expiresAt: null });
    assert.deepEqual(
      clockRepairBackup(repair({ unsetExpiresAt: false, expiresAtWas: null }))
        .wrote,
      { observedAt: { $date: ingestedAt.toISOString() } },
    );
  });
});

describe("planClockRestore — field-level, only where the row still holds what was written", () => {
  const id = "6a0000000000000000000001";
  const was = new Date("2026-09-22T21:59:34.502Z");
  const ingestedAt = new Date("2026-09-22T13:03:36.269Z");
  const stamped = new Date("2026-10-22T21:59:34.502Z");
  const reStamped = new Date("2026-12-21T13:03:36.269Z");
  const full = clockRepairBackup({
    id,
    eventId: "e".repeat(40),
    observedAtWas: was,
    expiresAtWas: stamped,
    observedAt: ingestedAt,
    unsetExpiresAt: true,
  });
  /** The backup as `readAll` hands it back: the row's `_id` at the top. */
  const read = (b: ReturnType<typeof clockRepairBackup>): ClockBackupDoc =>
    ({ _id: { $oid: b.id }, doc: b.doc, wrote: b.wrote }) as ClockBackupDoc;
  const at = (observedAt: Date, expiresAt: Date | null) =>
    new Map([[id, { observedAt, expiresAt }]]);

  it("puts BOTH fields back on a row the repair left untouched since", () => {
    const plan = planClockRestore([read(full)], at(ingestedAt, null));
    assert.deepEqual(plan.ops, [
      {
        id,
        // Compare-and-set on what the repair wrote — a clock re-dated between
        // this plan and its write fails the write rather than being clobbered.
        expect: {
          observedAt: { $date: ingestedAt.toISOString() },
          expiresAt: null,
        },
        set: {
          observedAt: { $date: was.toISOString() },
          expiresAt: { $date: stamped.toISOString() },
        },
      },
    ]);
    assert.deepEqual(
      [plan.partial, plan.changedSince, plan.gone],
      [[], [], []],
    );
  });

  it("keeps a stamp event-lake-sink wrote since, and restores only the clock", () => {
    // MONEY-1521: after the repair the sink stamps every row silver holds.
    // Putting the OLD blind stamp back over it would undo the design.
    const plan = planClockRestore([read(full)], at(ingestedAt, reStamped));
    assert.deepEqual(plan.ops, [
      {
        id,
        expect: { observedAt: { $date: ingestedAt.toISOString() } },
        set: { observedAt: { $date: was.toISOString() } },
      },
    ]);
    assert.deepEqual(plan.partial, [id]);
  });

  it("leaves a clock re-dated since, and restores only the expiry", () => {
    const later = new Date(ingestedAt.getTime() + 1);
    const plan = planClockRestore([read(full)], at(later, null));
    assert.deepEqual(plan.ops, [
      {
        id,
        expect: { expiresAt: null },
        set: { expiresAt: { $date: stamped.toISOString() } },
      },
    ]);
    assert.deepEqual(plan.partial, [id]);
  });

  it("lists a row holding NEITHER written value and writes nothing to it", () => {
    const plan = planClockRestore(
      [read(full)],
      at(new Date(ingestedAt.getTime() + 1), reStamped),
    );
    assert.deepEqual(plan.ops, []);
    assert.deepEqual(plan.changedSince, [id]);
  });

  it("never touches a field the repair did not write", () => {
    // An expiry-only repair: the clock led its creation and was left alone,
    // so it is not the restore's to set — whatever it holds now.
    const expiryOnly = clockRepairBackup({
      id,
      eventId: "e".repeat(40),
      observedAtWas: ingestedAt,
      expiresAtWas: stamped,
      observedAt: null,
      unsetExpiresAt: true,
    });
    const plan = planClockRestore([read(expiryOnly)], at(ingestedAt, null));
    assert.deepEqual(plan.ops, [
      {
        id,
        expect: { expiresAt: null },
        set: { expiresAt: { $date: stamped.toISOString() } },
      },
    ]);
    assert.deepEqual(plan.partial, [], "one field written, one restored");

    // And the mirror: a clock-only repair (no expiry was set, so none was
    // unset) must not write `expiresAt` at all — not even the null it read.
    const clockOnly = clockRepairBackup({
      id,
      eventId: "e".repeat(40),
      observedAtWas: was,
      expiresAtWas: null,
      observedAt: ingestedAt,
      unsetExpiresAt: false,
    });
    assert.deepEqual(
      planClockRestore([read(clockOnly)], at(ingestedAt, null)).ops,
      [
        {
          id,
          expect: { observedAt: { $date: ingestedAt.toISOString() } },
          set: { observedAt: { $date: was.toISOString() } },
        },
      ],
    );
  });

  it("names a backed-up row that no longer exists, rather than re-creating it", () => {
    const plan = planClockRestore([read(full)], new Map());
    assert.deepEqual(plan.ops, []);
    assert.deepEqual(plan.gone, [id]);
  });

  it("round-trips: the repair, then the restore, gives back the row as read", () => {
    const row: EventClockRow = {
      id,
      eventId: "e".repeat(40),
      observedAt: was,
      ingestedAt,
      expiresAt: stamped,
    };
    const r = planClockRepair(row)!;
    const [op] = planClockRestore(
      [read(clockRepairBackup(r))],
      at(r.observedAt ?? row.observedAt, r.unsetExpiresAt ? null : stamped),
    ).ops;
    assert.deepEqual(op!.set, {
      observedAt: { $date: row.observedAt.toISOString() },
      expiresAt: { $date: row.expiresAt!.toISOString() },
    });
  });
});

describe("clockRepairVerdict — a repair that was undone under it exits NON-ZERO", () => {
  it("passes only a write that matched every plan and left nothing to repair", () => {
    assert.equal(
      clockRepairVerdict({ planned: 11_976, matched: 11_976, remaining: 0 }),
      null,
    );
  });

  it("fails when a compare-and-set missed, naming the pre-MONEY-1531 workers", () => {
    const v = clockRepairVerdict({
      planned: 11_976,
      matched: 11_975,
      remaining: 0,
    });
    assert.match(v ?? "", /1 of 11976 planned write\(s\) matched nothing/);
    assert.match(v ?? "", /pre-MONEY-1531 workers are still deployed/);
  });

  it("fails when the re-census still finds rows, even after a clean write", () => {
    const v = clockRepairVerdict({ planned: 5, matched: 5, remaining: 1 });
    assert.match(v ?? "", /1 row\(s\) still need repair/);
    assert.match(v ?? "", /pre-MONEY-1531 workers are still deployed/);
  });
});

describe("parseClockRepairArgs — --apply asks, --apply --yes consents", () => {
  const TTY = true;
  const PIPE = false;
  const parse = (argv: string[], tty: boolean) =>
    parseClockRepairArgs(argv, tty);

  it("a dry run needs only --env, and no terminal", () => {
    assert.deepEqual(parse(["--env", "prod"], PIPE), {
      env: "prod",
      apply: false,
      yes: false,
      restore: false,
    });
  });

  it("--env is REQUIRED — there is no ambient-DATABASE_URL form", () => {
    // The repo's `.env` is QA: an unnamed target is a QA write that says prod.
    assert.throws(() => parse([], TTY), /REQUIRED/);
    assert.throws(() => parse(["--env", "staging"], TTY), /REQUIRED/);
    assert.throws(() => parse(["--env=prod"], TTY), /equals form/);
  });

  it("refuses an unknown flag rather than ignoring it", () => {
    // `argv.includes(...)` drops what it does not know — how `--apply
    // --dry-run` once WROTE.
    assert.throws(
      () => parse(["--env", "prod", "--apply", "--dry-run"], TTY),
      /Unknown flag/,
    );
  });

  it("a bare --apply ASKS: accepted on a terminal, refused where nobody can answer", () => {
    // A prompt on a closed stdin never resolves and the process exits 0,
    // which a wrapper's `&&` reads as success.
    assert.deepEqual(parse(["--env", "prod", "--apply"], TTY), {
      env: "prod",
      apply: true,
      yes: false,
      restore: false,
    });
    assert.throws(
      () => parse(["--env", "prod", "--apply"], PIPE),
      /--apply --yes/,
    );
  });

  it("--apply --yes is the non-interactive consent", () => {
    assert.deepEqual(parse(["--env", "prod", "--apply", "--yes"], PIPE), {
      env: "prod",
      apply: true,
      yes: true,
      restore: false,
    });
  });

  it("--restore is a DRY RUN on its own, and arms exactly like the repair", () => {
    assert.deepEqual(parse(["--env", "prod", "--restore"], PIPE), {
      env: "prod",
      apply: false,
      yes: false,
      restore: true,
    });
    assert.deepEqual(
      parse(["--env", "prod", "--restore", "--apply", "--yes"], PIPE),
      { env: "prod", apply: true, yes: true, restore: true },
    );
    assert.throws(
      () => parse(["--env", "prod", "--restore", "--apply"], PIPE),
      /--apply --yes/,
    );
    assert.throws(
      () => parse(["--env", "prod", "--restore", "--yes"], TTY),
      /--yes is consent to WRITE/,
    );
    assert.throws(() => parse(["--restore"], TTY), /REQUIRED/);
  });

  it("--yes without --apply is REFUSED, not ignored", () => {
    // Consent to a write nobody asked for. Swallowed, it would teach the
    // caller that the pair is optional.
    for (const tty of [TTY, PIPE]) {
      assert.throws(
        () => parse(["--env", "prod", "--yes"], tty),
        /--yes is consent to WRITE/,
      );
    }
  });
});

describe("[wiring] the repair script pins its Mongo target from --env", () => {
  // MONEY-1514: `@usemoney/database`'s singleton captures DATABASE_URL at
  // import, and the repo's `.env` is QA — so a `--env prod` run built on it
  // would repair QA while saying prod. Comment lines are dropped first: the
  // header DESCRIBES the trap in the words this scan looks for.
  const src = readFileSync(
    join(REPO, "scripts/data/repair-instrument-event-clocks.ts"),
    "utf8",
  )
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
    .join("\n");

  it("never imports the import-time singleton", () => {
    assert.doesNotMatch(src, /from\s+"@usemoney\/database"/);
  });

  it("builds its client from the URI pinJobEnv resolved", () => {
    assert.match(src, /const \{ databaseUrl \} = pinJobEnv\(env\)/);
    // `,?` because Prettier wraps this call and adds a trailing comma — a scan
    // that fails on formatting gets "fixed" by loosening it until it guards
    // nothing.
    assert.match(
      src,
      /new PrismaClient\(\{\s*datasources:\s*\{\s*db:\s*\{\s*url:\s*databaseUrl\s*\}\s*\},?\s*\}\)/,
    );
  });

  it("hands the grammar the REAL terminal state, and prompts unless --yes", () => {
    // The grammar above is only as good as its inputs: a hard-coded `true`
    // would accept a bare `--apply` from a pipe and hang on the prompt.
    assert.match(
      src,
      /parseClockRepairArgs\(\s*process\.argv\.slice\(2\),\s*Boolean\(process\.stdin\.isTTY\),?\s*\)/,
    );
    assert.match(src, /if \(!yes\) await confirmWrite\(/);
  });

  it("backs up, and counts the backup back, BEFORE its first write", () => {
    // `backupVerified` upserts every entry and throws on a short count, so a
    // repair write that ran first would modify rows no backup holds.
    const backup = src.indexOf("await backupVerified(");
    const firstWrite = src.indexOf("clockRepairCommand(");
    assert.ok(backup > 0, "the repair no longer backs up");
    assert.ok(firstWrite > 0, "the repair no longer writes");
    assert.ok(backup < firstWrite, "the backup must precede the first write");
    assert.match(
      src,
      /backupVerified\(\s*run,\s*CLOCK_REPAIR_BACKUP_COLLECTION,\s*before\.repairs\.map\(clockRepairBackup\),?\s*\)/,
    );
  });

  it("turns the verdict into a non-zero exit", () => {
    assert.match(src, /if \(failure\) throw new Error\(failure\)/);
    assert.match(src, /process\.exitCode = 1/);
  });

  it("restores through the compare-and-set writer, never a blind update", () => {
    // `updateOps` puts each op's `expect` in the filter and throws unless every
    // statement matched exactly one row.
    assert.match(
      src,
      /await updateOps\(\s*run,\s*INSTRUMENT_EVENTS_COLLECTION,\s*plan\.ops,/,
    );
  });
});
