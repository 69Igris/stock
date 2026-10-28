/**
 * `POST /jobs/us-filing-events` — the request contract and the processor.
 * MONEY-1507 (data-platform C1); remounted from `/internal/events` by
 * MONEY-1520, when that path turned out to be unreachable from its only caller.
 *
 * Drives the REAL `internalEventsRequestSchema` and the REAL
 * `processInternalEvents`, with its Mongo and publish seams injected — so no
 * Prisma is loaded and the resolution rules are exercised rather than described.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../_support/repo-root";
import {
  MAX_FILINGS_PER_REQUEST,
  OBSERVED_AT_FLOOR,
  OBSERVED_AT_MAX_LEAD_MS,
  ackStatusFor,
  distinctCiks,
  internalEventsRequestSchema,
  payloadObservedAt,
  secFilingRequestSchema,
} from "../../src/processors/internal-events-logic";
import { processInternalEvents } from "../../src/processors/internal-events";
import { publishTimeOf } from "../../src/lib/message";
import type { InstrumentEvent } from "@usemoney/core/events/event-types";

const OBSERVED = new Date("2026-08-29T02:00:00.000Z");

function filing(overrides: Record<string, unknown> = {}) {
  return {
    accession: "0000320193-26-000106",
    cik10: "0000320193",
    form: "8-K",
    items: ["2.02"],
    acceptedAt: "2026-08-29T01:53:58.000Z",
    filedAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

/** Captures what the processor would publish. */
function capture() {
  const published: InstrumentEvent[][] = [];
  return {
    published,
    publish: async (events: readonly unknown[]) => {
      published.push(events as InstrumentEvent[]);
      return { upserted: events.length, failed: 0 };
    },
  };
}

/* ── The request contract ─────────────────────────────────────────────── */

describe("secFilingRequestSchema (MONEY-1507)", () => {
  it("accepts a well-formed filing", () => {
    assert.doesNotThrow(() => secFilingRequestSchema.parse(filing()));
  });

  it("REFUSES an unpadded cik — it would join to nothing", () => {
    // `us_filings`, `us_filers` and `us_instruments` all store the 10-digit
    // form, which is what every EDGAR URL and bulk filename uses.
    assert.throws(
      () => secFilingRequestSchema.parse(filing({ cik10: "320193" })),
      /10 digits/,
    );
  });

  it("REFUSES an accession that is not SEC's dashed form", () => {
    // The accession IS the event's source_record_key and therefore half its id.
    // A malformed one produces an event that looks fine and matches nothing.
    assert.throws(() =>
      secFilingRequestSchema.parse(filing({ accession: "000032019326000106" })),
    );
    assert.throws(() =>
      secFilingRequestSchema.parse(filing({ accession: "nope" })),
    );
  });

  it("coerces ISO strings to Dates", () => {
    const parsed = secFilingRequestSchema.parse(filing());
    assert.ok(parsed.acceptedAt instanceof Date);
    assert.equal(parsed.acceptedAt!.toISOString(), "2026-08-29T01:53:58.000Z");
  });

  it("REFUSES an unparseable timestamp rather than storing an Invalid Date", () => {
    // An Invalid Date compares false everywhere and lands in Mongo as a null,
    // so the row would look merely incomplete.
    assert.throws(
      () => secFilingRequestSchema.parse(filing({ acceptedAt: "yesterday" })),
      /ISO-8601/,
    );
  });

  it("allows a genuinely absent clock", () => {
    assert.doesNotThrow(() =>
      secFilingRequestSchema.parse(
        filing({ acceptedAt: null, filedAt: undefined }),
      ),
    );
  });
});

describe("internalEventsRequestSchema", () => {
  it("REFUSES an empty batch", () => {
    // A producer that sends nothing has a bug, and `{written: 0}` is
    // indistinguishable from a quiet minute — the same rule `encodeNdjson`
    // applies to a zero-row stage object.
    assert.throws(
      () => internalEventsRequestSchema.parse({ filings: [] }),
      /empty batch/,
    );
  });

  it("REFUSES a batch past the ceiling, so a bulk caller is told to page", () => {
    const many = Array.from({ length: MAX_FILINGS_PER_REQUEST + 1 }, (_v, i) =>
      filing({
        accession: `000032019${i % 10}-26-${String(i).padStart(6, "0")}`,
      }),
    );
    assert.throws(
      () => internalEventsRequestSchema.parse({ filings: many }),
      /page instead/,
    );
  });
});

describe("distinctCiks", () => {
  it("collapses repeats — EDGAR files several forms for one company a minute", () => {
    const ciks = distinctCiks([
      { cik10: "0000320193" },
      { cik10: "0000320193" },
      { cik10: "0000789019" },
    ] as never);
    assert.deepEqual(ciks, ["0000320193", "0000789019"]);
  });
});

/* ── The processor ────────────────────────────────────────────────────── */

describe("processInternalEvents", () => {
  const deps = (overrides = {}) => ({
    resolveListings: async () =>
      new Map([["0000320193", "AAPL:NASDAQ:1980-12-12"]]),
    resolveNames: async () => new Map([["0000320193", "Apple Inc."]]),
    now: () => OBSERVED,
    ...overrides,
  });

  it("builds one event per filing, resolved and titled", async () => {
    const sink = capture();
    const result = await processInternalEvents(
      { filings: [filing()] },
      { ...deps(), publish: sink.publish },
    );
    assert.equal(result.received, 1);
    assert.equal(result.listingResolved, 1);
    const event = sink.published[0]![0]!;
    assert.equal(event.listingId, "AAPL:NASDAQ:1980-12-12");
    assert.equal(event.title, "Apple Inc. — 8-K");
    assert.equal(event.severity, 2);
  });

  it("keeps an UNRESOLVED filer rather than dropping the event", async () => {
    // A fund manager filing 13F, a private filer, an issuer listed this
    // morning. `listingResolved` is the linkage coverage, not a filter.
    const sink = capture();
    const result = await processInternalEvents(
      { filings: [filing()] },
      {
        ...deps({ resolveListings: async () => new Map() }),
        publish: sink.publish,
      },
    );
    assert.equal(result.received, 1);
    assert.equal(result.listingResolved, 0);
    assert.equal(sink.published[0]![0]!.listingId, null);
    assert.equal(sink.published[0]![0]!.confidence, 0.5);
  });

  it("with no payload observedAt, stamps ONE fallback instant across the batch", async () => {
    // The detector saw these filings in one pass. A per-event `new Date()`
    // would make the ordering inside a batch depend on how long the Mongo
    // lookups took. (A filing that CARRIES its claim instant keeps its own —
    // MONEY-1532, below.)
    const sink = capture();
    await processInternalEvents(
      {
        filings: [
          filing(),
          filing({ accession: "0000320193-26-000107", form: "10-Q" }),
        ],
      },
      { ...deps(), publish: sink.publish },
    );
    const [a, b] = sink.published[0]!;
    assert.equal(a!.observedAt.getTime(), b!.observedAt.getTime());
  });

  it("DECODES a Pub/Sub push envelope, not just a bare body", async () => {
    // A push subscription delivers `{message:{data:"<base64>"}}` because the
    // subscriptions are created without --push-no-wrapper. Reading fields
    // straight off `body` yields undefined for every one of them, silently —
    // MONEY-1490 ran a self-chaining job in a loop for a week on that.
    const { parsePubSubMessage } = await import("../../src/lib/message");
    const payload = { filings: [filing()] };
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
        messageId: "1",
      },
    };
    const sink = capture();
    const result = await processInternalEvents(parsePubSubMessage(envelope), {
      ...deps(),
      publish: sink.publish,
    });
    assert.equal(result.received, 1);
  });

  it("THROWS on an invalid request — that is a 400, not a transient", async () => {
    await assert.rejects(processInternalEvents({ filings: [] }, deps()));
    await assert.rejects(processInternalEvents({}, deps()));
  });

  it("issues ONE lookup for a batch with repeated CIKs", async () => {
    let calls = 0;
    const sink = capture();
    await processInternalEvents(
      {
        filings: [
          filing(),
          filing({ accession: "0000320193-26-000107" }),
          filing({ accession: "0000320193-26-000108" }),
        ],
      },
      {
        ...deps({
          resolveListings: async (ciks: readonly string[]) => {
            calls += 1;
            assert.deepEqual([...ciks], ["0000320193"]);
            return new Map([["0000320193", "AAPL:NASDAQ:1980-12-12"]]);
          },
        }),
        publish: sink.publish,
      },
    );
    assert.equal(calls, 1);
  });
});

/* ── ACK vs NACK (MONEY-1520) ─────────────────────────────────────────── */

describe("a batch is ACKed only when every event landed", () => {
  const route = readFileSync(
    join(repoRoot(), "workers", "src", "routes", "internal-events.ts"),
    "utf8",
  );

  it("a clean batch is 200", () => {
    assert.equal(ackStatusFor({ failed: 0 }), 200);
  });

  it("ONE failed upsert nacks the whole batch", () => {
    // Pub/Sub ACKs only on 2xx. Answering 200 with `success: false` — which is
    // what this route did until MONEY-1520 — discards the message and with it
    // every event whose upsert threw. Redelivery is free: `publishEvents`
    // upserts on a deterministic eventId, so the rows that already landed are
    // rewritten with the same values.
    assert.equal(ackStatusFor({ failed: 1 }), 500);
  });

  it("a wholly-failed batch nacks too", () => {
    assert.equal(ackStatusFor({ failed: 500 }), 500);
  });

  it("the ROUTE decides through this function, not through its own expression", () => {
    // A pure function nothing calls is a decision that still lives inline. The
    // assertions above would pass against a route that kept `200` hardcoded.
    assert.match(route, /ackStatusFor\(result\)/);
    assert.ok(
      !/c\.json\(\s*\{\s*success:[^}]*\}\s*,\s*200\s*\)/.test(route),
      "the route still answers a literal 200 for a processed batch; that path " +
        "acks a partial failure",
    );
  });
});

/* ── The wiring ───────────────────────────────────────────────────────── */

describe("the route is mounted and OIDC-gated (MONEY-288)", () => {
  const index = readFileSync(
    join(repoRoot(), "workers", "src", "index.ts"),
    "utf8",
  );

  it("mounts /jobs/us-filing-events", () => {
    // MONEY-1520 — it WAS `/internal/events`. The producer POSTed there
    // directly and got 404 on every call: this service is `ingress: internal`
    // and `us-fundamentals` has no VPC egress, so Cloud Run refused the request
    // at the edge. The path segment must now equal the Pub/Sub topic base name,
    // because `setup-pubsub.sh` builds the push endpoint as
    // `${SERVICE_URL}/jobs/${BASE_TOPIC}`.
    assert.match(
      index,
      /app\.route\("\/jobs\/us-filing-events", internalEventsRoute\)/,
    );
  });

  it("the old unreachable /internal/events mount is GONE", () => {
    // Not merely "the new one exists". Two mounts would leave an
    // unauthenticated-writer surface standing that nothing calls and nothing
    // can reach, which is worse than either state alone.
    assert.ok(!index.includes('app.route("/internal/events"'));
  });

  it("registers the SAME auth factory on /internal/*", () => {
    // Hono's `app.use` matches by PREFIX, so the `/jobs/*` registration does
    // not cover it. KEPT after MONEY-1520 moved the route out of `/internal/*`:
    // the registration now guards nothing, and that is the point — the next
    // `/internal/…` route is gated from its first commit rather than from the
    // review that notices. What the moved route relies on today is the
    // `/jobs/*` registration below, by the same factory.
    assert.match(
      index,
      /app\.use\("\/internal\/\*", \(c, next\) =>\s*jobsAuth\(c as unknown as JobsAuthContext, next\),?\s*\)/s,
    );
  });

  it("the /jobs/* gate — the one this route now sits behind — is registered", () => {
    // The assertion that MOVED with the route. Without this, the case above
    // would keep passing against a prefix the route no longer uses, which is a
    // guard that reads as coverage and is not.
    assert.match(
      index,
      /app\.use\("\/jobs\/\*", \(c, next\) =>\s*jobsAuth\(c as unknown as JobsAuthContext, next\),?\s*\)/s,
    );
  });

  it("[control] the gate the route relies on is the deny-by-default factory", () => {
    // If `createJobsAuthMiddleware` stopped being what `jobsAuth` is built
    // from, the assertion above would still pass against a different gate.
    assert.match(index, /const jobsAuth = createJobsAuthMiddleware\(/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   observedAt comes from the ENVELOPE, not the wall clock — MONEY-1514 review
   ──────────────────────────────────────────────────────────────────────── */

describe("observedAt is stable across a redelivery", () => {
  // `ackStatusFor` nacks a partially-written batch so Pub/Sub redelivers it.
  // Every field in this route is idempotent EXCEPT `observedAt`:
  // `defaultUpsert`'s `update:` block `$set`s it unconditionally, and
  // `eventSilverKey` includes `observed_at` — so a re-stamp makes the lake
  // sink append a SECOND `instrument_event` row, indistinguishable from a
  // real enrichment.
  //
  // The dedupe middleware does NOT cover this: it skips a duplicate of an
  // ACKED message, while a 500-NACK retry is granted RUN by
  // `reclaim_after_failure`.

  const envelope = (publishTime: string) => ({
    message: {
      data: Buffer.from(JSON.stringify({ filings: [] })).toString("base64"),
      messageId: "m-1",
      publishTime,
    },
    subscription: "projects/p/subscriptions/us-filing-events-prod-push",
  });

  it("reads publishTime off the envelope", () => {
    const got = publishTimeOf(envelope("2026-09-22T16:45:07.123Z"));
    assert.ok(got instanceof Date);
    assert.equal(got?.toISOString(), "2026-09-22T16:45:07.123Z");
  });

  it("returns the SAME instant for a redelivery of the same message", () => {
    // This is the whole property. Pub/Sub keeps publishTime across every
    // delivery attempt; `new Date()` would move on each one.
    const stamp = "2026-09-22T16:45:07.123Z";
    const first = publishTimeOf(envelope(stamp));
    const retry = publishTimeOf(envelope(stamp));
    assert.equal(first?.getTime(), retry?.getTime());
  });

  it("falls back to null for a DIRECT body, so local dev keeps the wall clock", () => {
    assert.equal(publishTimeOf({ filings: [] }), null);
  });

  it("refuses an unparseable stamp rather than silently becoming 1970", () => {
    assert.equal(publishTimeOf(envelope("not-a-date")), null);
    assert.equal(publishTimeOf(envelope("")), null);
  });

  it("the ROUTE actually wires it — the call site, not just the helper", () => {
    // Same reasoning as the tile read-back scan: a pure helper that nothing
    // calls is a guard that does nothing. Deleting the wiring must fail here.
    const src = readFileSync(
      join(repoRoot(), "workers/src/routes/internal-events.ts"),
      "utf8",
    );
    assert.match(
      src,
      /publishTimeOf\(body\)/,
      "the route never reads publishTime",
    );
    assert.match(
      src,
      /now:\s*\(\)\s*=>\s*publishedAt/,
      "publishTime is read and then not passed as the processor's clock",
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   observedAt comes from the PAYLOAD when it is usable — MONEY-1532
   ──────────────────────────────────────────────────────────────────────── */

describe("payloadObservedAt — is the producer's claim instant usable?", () => {
  // The envelope's publishTime: the fallback AND the upper bound.
  const PUBLISHED = new Date("2026-09-23T06:00:00.000Z");

  it("uses a zoned ISO stamp days older than the publish, unchanged", () => {
    // `{"mode":"event-backfill"}` re-emits claims days old ON PURPOSE. A
    // recency rule would push exactly those onto publishTime — today.
    const got = payloadObservedAt("2026-09-01T14:03:07.219Z", PUBLISHED);
    assert.equal(got?.toISOString(), "2026-09-01T14:03:07.219Z");
  });

  it("accepts a numeric offset and normalises the instant", () => {
    const got = payloadObservedAt("2026-09-22T19:33:07.219+05:30", PUBLISHED);
    assert.equal(got?.toISOString(), "2026-09-22T14:03:07.219Z");
  });

  it("absent, null and empty mean 'use the fallback'", () => {
    assert.equal(payloadObservedAt(undefined, PUBLISHED), null);
    assert.equal(payloadObservedAt(null, PUBLISHED), null);
    assert.equal(payloadObservedAt("", PUBLISHED), null);
  });

  it("REFUSES a zone-less stamp — Node reads it as LOCAL time", () => {
    // Measured: `new Date("2026-09-22T10:00:00")` is 04:30Z on an IST host.
    assert.equal(payloadObservedAt("2026-09-22T14:03:07.219", PUBLISHED), null);
    assert.equal(payloadObservedAt("2026-09-22", PUBLISHED), null);
  });

  it("REFUSES what does not parse", () => {
    assert.equal(payloadObservedAt("yesterday", PUBLISHED), null);
    assert.equal(payloadObservedAt("2026-13-45T99:99:99Z", PUBLISHED), null);
  });

  it("REFUSES a stamp before EDGAR existed — a zeroed or defaulted clock", () => {
    assert.equal(
      payloadObservedAt("1970-01-01T00:00:00.000Z", PUBLISHED),
      null,
    );
    assert.equal(payloadObservedAt("0001-01-01T00:00:00Z", PUBLISHED), null);
    assert.equal(
      payloadObservedAt(OBSERVED_AT_FLOOR.toISOString(), PUBLISHED)?.getTime(),
      OBSERVED_AT_FLOOR.getTime(),
      "the floor itself is usable",
    );
  });

  it("REFUSES an observation later than the publish, beyond clock skew", () => {
    // The producer stamps BEFORE it publishes, so 'seen after it was
    // published' is impossible — a local-time-as-UTC bug is hours, not ms.
    const at = (ms: number) => new Date(PUBLISHED.getTime() + ms).toISOString();
    assert.equal(
      payloadObservedAt(at(OBSERVED_AT_MAX_LEAD_MS + 1), PUBLISHED),
      null,
    );
    assert.equal(
      payloadObservedAt(at(5.5 * 3600 * 1000), PUBLISHED),
      null,
      "IST sent as UTC",
    );
    assert.ok(payloadObservedAt(at(OBSERVED_AT_MAX_LEAD_MS), PUBLISHED));
    assert.ok(payloadObservedAt(at(1_000), PUBLISHED), "a second of skew");
  });
});

describe("processInternalEvents — observedAt (MONEY-1532)", () => {
  const PUBLISHED = new Date("2026-09-23T06:00:00.000Z");
  const deps = () => ({
    resolveListings: async () => new Map<string, string>(),
    resolveNames: async () => new Map<string, string>(),
    now: () => PUBLISHED,
  });

  it("stamps each event with ITS OWN claim instant, not the batch's publishTime", async () => {
    const sink = capture();
    const result = await processInternalEvents(
      {
        filings: [
          filing({ observedAt: "2026-09-22T14:03:07.219Z" }),
          filing({
            accession: "0000320193-26-000107",
            observedAt: "2026-09-22T14:03:07.411Z",
          }),
        ],
      },
      { ...deps(), publish: sink.publish },
    );
    const [a, b] = sink.published[0]!;
    assert.equal(a!.observedAt.toISOString(), "2026-09-22T14:03:07.219Z");
    assert.equal(b!.observedAt.toISOString(), "2026-09-22T14:03:07.411Z");
    assert.equal(result.observedAtFromPayload, 2);
  });

  it("a BACKFILLED filing keeps its week-old claim instant — it must not arrive as new", async () => {
    // The whole point: re-emitted today, observed a week ago. publishTime would
    // restate history and fire every alert on the filing at once.
    const sink = capture();
    await processInternalEvents(
      { filings: [filing({ observedAt: "2026-09-16T13:00:00.000Z" })] },
      { ...deps(), publish: sink.publish },
    );
    const event = sink.published[0]![0]!;
    assert.equal(event.observedAt.toISOString(), "2026-09-16T13:00:00.000Z");
    assert.notEqual(event.observedAt.getTime(), PUBLISHED.getTime());
  });

  it("falls back to the ONE batch instant for a filing with none, or an unusable one — and counts only the usable", async () => {
    const sink = capture();
    const result = await processInternalEvents(
      {
        filings: [
          filing({ observedAt: "2026-09-22T14:03:07.219Z" }),
          filing({ accession: "0000320193-26-000107" }),
          filing({
            accession: "0000320193-26-000108",
            observedAt: "2026-09-22T14:03:07",
          }),
        ],
      },
      { ...deps(), publish: sink.publish },
    );
    const [used, absent, zoneless] = sink.published[0]!;
    assert.equal(used!.observedAt.toISOString(), "2026-09-22T14:03:07.219Z");
    assert.equal(absent!.observedAt.getTime(), PUBLISHED.getTime());
    assert.equal(zoneless!.observedAt.getTime(), PUBLISHED.getTime());
    assert.equal(result.observedAtFromPayload, 1);
  });

  it("an unusable observedAt does NOT 400 the batch — the other filings still land", async () => {
    // The schema takes a bare string on purpose. Refusing there would park up
    // to 500 good filings on the dead-letter topic over one clock.
    const sink = capture();
    const result = await processInternalEvents(
      {
        filings: [
          filing({ observedAt: "not-a-time" }),
          filing({ accession: "0000320193-26-000107" }),
        ],
      },
      { ...deps(), publish: sink.publish },
    );
    assert.equal(result.received, 2);
    assert.equal(sink.published[0]!.length, 2);
  });

  it("the route LOGS the count, so a deploy can be verified from one line", () => {
    const src = readFileSync(
      join(repoRoot(), "workers/src/routes/internal-events.ts"),
      "utf8",
    );
    assert.match(
      src,
      /observedAtFromPayload=\$\{result\.observedAtFromPayload\}/,
    );
  });
});
