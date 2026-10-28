/**
 * MF NAV cold read: return the DB, ENQUEUE, never fetch — REAL exports
 * (MONEY-1205).
 *
 * Source: packages/core/src/market-data/prices/mf-nav-service.ts
 *
 * The defect this pins: `getMfNavHistory` used to run
 * `count === 0 -> await backfillMfNav()` INSIDE the caller's request, and
 * `backfillMfNav` issued one Prisma upsert per NAV point (609 sequential round
 * trips, 55-83s measured on prod during a real page view — the request was cut
 * off and the page rendered "-" for 52W high/low and every CAGR).
 *
 * The load-bearing assertion is the NEGATIVE one: **`globalThis.fetch` is never
 * called**. Everything else could pass while the read still blocked on MFAPI.in.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  getMfNavHistory,
  getMfNavHistoryWithCoverage,
  requestMfNavBackfill,
  setMfNavBackfillPublisher,
  resetMfNavBackfillRequests,
  selectMissingNavPoints,
  navDateKeys,
  MF_NAV_COLD_THRESHOLD,
  type MfNavReader,
} from "../../src/market-data/prices/mf-nav-service";
import type { MfNavBackfillMessage } from "@usemoney/types";

/** An in-memory stand-in for `prisma.mfNavHistory` (the injectable read seam). */
function reader(rows: Array<{ date: Date; nav: number }>): MfNavReader {
  return {
    count: async () => rows.length,
    findMany: async (args) =>
      rows
        .filter(
          (r) => r.date >= args.where.date.gte && r.date <= args.where.date.lte,
        )
        .sort((a, b) => a.date.getTime() - b.date.getTime()),
  };
}

/** Records every publish; returns a fake message id. */
function recordingPublisher() {
  const published: MfNavBackfillMessage[] = [];
  return {
    published,
    publish: async (m: MfNavBackfillMessage) => {
      published.push(m);
      return `msg-${published.length}`;
    },
  };
}

// A fetch spy installed for the whole file: ANY network call from a read path
// is a regression, so it fails loudly rather than silently succeeding.
const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error(
      "a NAV read must never fetch — the backfill belongs to the worker",
    );
  }) as typeof globalThis.fetch;
  resetMfNavBackfillRequests();
  setMfNavBackfillPublisher(null);
  delete process.env.MF_NAV_BACKFILL_ON_READ;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setMfNavBackfillPublisher(null);
  resetMfNavBackfillRequests();
});

// ══════════════════════════════════════════════════════════════════════
// The cold read
// ══════════════════════════════════════════════════════════════════════

describe("getMfNavHistory — cold scheme (real export)", () => {
  it("returns [] AND publishes a backfill job, WITHOUT fetching", async () => {
    const pub = recordingPublisher();
    setMfNavBackfillPublisher(pub.publish);

    const points = await getMfNavHistory(
      "152387",
      undefined,
      undefined,
      reader([]),
    );

    assert.deepEqual(
      points,
      [],
      "an empty DB yields an empty series, immediately",
    );
    assert.deepEqual(
      fetchCalls,
      [],
      "THE regression guard: the read path must issue no HTTP call at all",
    );
    assert.equal(
      pub.published.length,
      1,
      "exactly one backfill job was published",
    );
    assert.deepEqual(pub.published[0]?.schemeCodes, ["152387"]);
    assert.equal(pub.published[0]?.reason, "cold-read");
  });

  it("reports coverage so the caller can say 'no history yet', not 'failed'", async () => {
    setMfNavBackfillPublisher(recordingPublisher().publish);
    const { points, coverage } = await getMfNavHistoryWithCoverage(
      "152387",
      undefined,
      undefined,
      reader([]),
    );
    assert.deepEqual(points, []);
    assert.deepEqual(coverage, {
      schemeCode: "152387",
      storedRows: 0,
      cold: true,
    });
  });

  it("a single stored row is still COLD (one point derives nothing)", async () => {
    const pub = recordingPublisher();
    setMfNavBackfillPublisher(pub.publish);
    assert.equal(MF_NAV_COLD_THRESHOLD, 2);

    const { points, coverage } = await getMfNavHistoryWithCoverage(
      "152387",
      undefined,
      undefined,
      reader([{ date: new Date("2026-08-01T00:00:00Z"), nav: 10 }]),
    );
    assert.equal(points.length, 1);
    assert.equal(coverage.cold, true);
    assert.equal(pub.published.length, 1);
    assert.deepEqual(fetchCalls, []);
  });
});

describe("getMfNavHistory — warm scheme (real export)", () => {
  it("returns the stored window and publishes NOTHING", async () => {
    const pub = recordingPublisher();
    setMfNavBackfillPublisher(pub.publish);

    const rows = [
      { date: new Date("2026-08-01T00:00:00Z"), nav: 10 },
      { date: new Date("2026-08-02T00:00:00Z"), nav: 11 },
      { date: new Date("2026-08-03T00:00:00Z"), nav: 12 },
    ];
    const points = await getMfNavHistory(
      "120503",
      undefined,
      undefined,
      reader(rows),
    );

    assert.deepEqual(points, [
      { date: "2026-08-01", nav: 10 },
      { date: "2026-08-02", nav: 11 },
      { date: "2026-08-03", nav: 12 },
    ]);
    assert.equal(
      pub.published.length,
      0,
      "a covered scheme must not queue work",
    );
    assert.deepEqual(fetchCalls, []);
  });

  it("honours the requested date window", async () => {
    setMfNavBackfillPublisher(recordingPublisher().publish);
    const rows = [
      { date: new Date("2026-01-01T00:00:00Z"), nav: 9 },
      { date: new Date("2026-08-01T00:00:00Z"), nav: 10 },
      { date: new Date("2026-08-02T00:00:00Z"), nav: 11 },
    ];
    const points = await getMfNavHistory(
      "120503",
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-08-01T23:59:59Z"),
      reader(rows),
    );
    assert.deepEqual(points, [{ date: "2026-08-01", nav: 10 }]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// requestMfNavBackfill
// ══════════════════════════════════════════════════════════════════════

describe("requestMfNavBackfill (real export)", () => {
  it("de-duplicates repeat requests for the same scheme", async () => {
    const pub = recordingPublisher();
    setMfNavBackfillPublisher(pub.publish);

    const a = await requestMfNavBackfill("152387");
    const b = await requestMfNavBackfill("152387");
    const c = await requestMfNavBackfill("152387");

    assert.equal(a.status, "published");
    assert.equal(b.status, "deduped");
    assert.equal(c.status, "deduped");
    assert.equal(
      pub.published.length,
      1,
      "one publish, not three page-views' worth",
    );
  });

  it("`force` bypasses the de-dup window", async () => {
    const pub = recordingPublisher();
    setMfNavBackfillPublisher(pub.publish);
    await requestMfNavBackfill("152387");
    const forced = await requestMfNavBackfill("152387", { force: true });
    assert.equal(forced.status, "published");
    assert.equal(pub.published.length, 2);
  });

  it("a publish failure is a REPORTED status and is re-tryable, not a silent no-op", async () => {
    setMfNavBackfillPublisher(async () => {
      throw new Error("pubsub down");
    });
    const first = await requestMfNavBackfill("152387");
    assert.equal(first.status, "failed");
    assert.match(first.error ?? "", /pubsub down/);

    // The failed attempt must NOT occupy the de-dup slot — otherwise a single
    // transient outage would suppress the next 30 minutes of real requests.
    const pub = recordingPublisher();
    setMfNavBackfillPublisher(pub.publish);
    const second = await requestMfNavBackfill("152387");
    assert.equal(second.status, "published");
  });

  it("MF_NAV_BACKFILL_ON_READ=off disables the on-read enqueue", async () => {
    const pub = recordingPublisher();
    setMfNavBackfillPublisher(pub.publish);
    process.env.MF_NAV_BACKFILL_ON_READ = "off";
    try {
      const res = await requestMfNavBackfill("152387");
      assert.equal(res.status, "disabled");
      assert.equal(pub.published.length, 0);
    } finally {
      delete process.env.MF_NAV_BACKFILL_ON_READ;
    }
  });

  it("rejects an empty scheme code", async () => {
    const res = await requestMfNavBackfill("");
    assert.equal(res.status, "failed");
  });
});

// ══════════════════════════════════════════════════════════════════════
// The backfill diff (pure). The WRITE itself is a plain
// `prisma.mfNavHistory.createMany` in workers/src/processors/mf-nav-backfill.ts
// so `prod-only-sync-coverage.test.ts` can see what advances the table.
// ══════════════════════════════════════════════════════════════════════

describe("selectMissingNavPoints (real export)", () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  it("returns only the dates not already stored", () => {
    const points = [
      { date: d("2026-08-01"), nav: 10 },
      { date: d("2026-08-02"), nav: 11 },
      { date: d("2026-08-03"), nav: 12 },
    ];
    const missing = selectMissingNavPoints(points, [d("2026-08-02")]);
    assert.deepEqual(
      missing.map((p) => p.date.toISOString().slice(0, 10)),
      ["2026-08-01", "2026-08-03"],
    );
  });

  it("is EMPTY when everything is stored — the idempotent redelivery case", () => {
    const points = [
      { date: d("2026-08-01"), nav: 10 },
      { date: d("2026-08-02"), nav: 11 },
    ];
    assert.deepEqual(
      selectMissingNavPoints(points, [d("2026-08-01"), d("2026-08-02")]),
      [],
      "a re-run must insert nothing, not re-write history",
    );
  });

  it("returns everything when nothing is stored (a cold scheme)", () => {
    const points = [{ date: d("2026-08-01"), nav: 10 }];
    assert.equal(selectMissingNavPoints(points, []).length, 1);
  });

  it("matches on the exact UTC instant, so a same-day Date object still dedupes", () => {
    const points = [{ date: d("2026-08-01"), nav: 10 }];
    assert.equal(
      selectMissingNavPoints(points, [new Date(d("2026-08-01"))]).length,
      0,
    );
  });

  it("navDateKeys yields epoch-ms keys", () => {
    const keys = navDateKeys([d("2026-08-01")]);
    assert.equal(keys.size, 1);
    assert.ok(keys.has(d("2026-08-01").getTime()));
  });
});
