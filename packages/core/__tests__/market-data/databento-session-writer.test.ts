/**
 * The session writer — MONEY-1373.
 *
 * Fake deps throughout, so this suite exercises the ORCHESTRATION: the order of
 * the two displacement steps, what the cold union keeps and drops, and whether
 * the counters report what the store did rather than what it was handed.
 *
 * The single most important case is `deleteSessionRows` BEFORE `putCandles`.
 * There is no transaction available — `putCandles` is chunked diff-then-create
 * — so the ORDER is the entire guarantee: after the delete the session is
 * empty, so a crash leaves a gap that the next idempotent run fills. The
 * inverse order leaves a session holding two sources, which is the exact state
 * the whole rule exists to prevent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  emptySessionWriteCounters,
  groupRowsBySession,
  writeSymbolBatch,
  type SessionWriterDeps,
} from "../../src/market-data/databento/databento-session-writer";
import { DATABENTO_SOURCE } from "../../src/market-data/databento/databento-logic";
import { RT_CANDLE_SOURCE } from "../../src/market-data/tiingo/tiingo-rt-sink-logic";
import type {
  CandleBar,
  CandleWriteRow,
} from "../../src/market-data/candles/candle-logic";

/* ── fixtures ──────────────────────────────────────────────────────────── */

/** A recent session, so the router sends it HOT (inside the 45-day window). */
const recent = (daysAgo: number, hour = 14, minute = 30): Date => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute),
  );
};

const row = (ts: Date, o: Partial<CandleWriteRow> = {}): CandleWriteRow => ({
  symbol: "AAPL",
  exchange: "NASDAQ",
  timeframe: "M1",
  ts,
  listingId: "AAPL:NASDAQ:1980-12-12",
  open: 1,
  high: 2,
  low: 0.5,
  close: 1.5,
  volume: 100,
  source: DATABENTO_SOURCE,
  ...o,
});

const bar = (
  ts: Date,
  source: string,
  o: Partial<CandleBar> = {},
): CandleBar => ({
  symbol: "AAPL",
  exchange: "NASDAQ",
  timeframe: "M1",
  ts,
  listingId: "AAPL:NASDAQ:1980-12-12",
  open: 9,
  high: 9,
  low: 9,
  close: 9,
  volume: 0,
  divCash: 0,
  splitFactor: 1,
  source,
  ...o,
});

function fakeDeps(
  o: {
    existing?: string[];
    shard?: CandleBar[];
    shardFails?: boolean;
    putResult?: { created: number; upgraded: number; failed: number };
  } = {},
) {
  const calls: string[] = [];
  const put: CandleWriteRow[][] = [];
  const deletes: Array<{
    sources: readonly string[];
    startMs: number;
    endMs: number;
  }> = [];
  const shardWrites: Array<{
    year: number;
    bars: readonly CandleBar[];
    merge: false;
  }> = [];
  const deps: SessionWriterDeps = {
    async findExistingSources() {
      calls.push("findExistingSources");
      return o.existing ?? [];
    },
    async deleteSessionRows(args) {
      calls.push("deleteSessionRows");
      deletes.push({
        sources: args.sources,
        startMs: args.startMs,
        endMs: args.endMs,
      });
      return 42;
    },
    async putCandles(rows) {
      calls.push("putCandles");
      put.push([...rows]);
      return o.putResult ?? { created: rows.length, upgraded: 0, failed: 0 };
    },
    async readColdShard() {
      calls.push("readColdShard");
      if (o.shardFails)
        return { status: "failed", error: new Error("gcs down") };
      return o.shard
        ? { status: "present", bars: o.shard }
        : { status: "absent" };
    },
    async writeColdShard(args) {
      calls.push("writeColdShard");
      shardWrites.push({ year: args.year, bars: args.bars, merge: args.merge });
      return undefined;
    },
    now: () => new Date(),
  };
  return { deps, calls, put, deletes, shardWrites };
}

/* ── grouping ──────────────────────────────────────────────────────────── */

describe("grouping is by ET SESSION, not by UTC day", () => {
  it("a post-market bar and a morning bar of the SAME EST session are one group", () => {
    // 2026-01-15 19:30 ET is 2026-01-16 00:30 UTC. Under a UTC key these were
    // two groups, and whichever writer reached the second one first locked the
    // other out of the next session too.
    const rows = [
      row(new Date("2026-01-15T14:35:00Z")), // 09:35 ET
      row(new Date("2026-01-16T00:30:00Z")), // 19:30 ET, same session
    ];
    const groups = groupRowsBySession(rows);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.dateKey, "2026-01-15");
    assert.equal(groups[0]!.rows.length, 2);
  });

  it("the NEXT session's pre-market is a different group", () => {
    const rows = [
      row(new Date("2026-01-16T00:30:00Z")), // 2026-01-15 19:30 ET
      row(new Date("2026-01-16T09:05:00Z")), // 2026-01-16 04:05 ET
    ];
    const groups = groupRowsBySession(rows);
    assert.deepEqual(groups.map((g) => g.dateKey).sort(), [
      "2026-01-15",
      "2026-01-16",
    ]);
  });

  it("the bounds are the ET day, not start plus 86,400,000", () => {
    const groups = groupRowsBySession([row(new Date("2026-03-08T15:00:00Z"))]);
    const g = groups[0]!;
    // 2026-03-08 is the US spring-forward day: 23 hours.
    assert.equal(g.endMs - g.startMs, 23 * 3_600_000);
  });

  it("separates timeframes", () => {
    const ts = new Date("2026-01-15T14:35:00Z");
    const groups = groupRowsBySession([row(ts), row(ts, { timeframe: "H1" })]);
    assert.equal(groups.length, 2);
  });
});

/* ── hot path ──────────────────────────────────────────────────────────── */

describe("hot path — an empty session is a plain write", () => {
  it("writes and counts what the REPOSITORY did", () => {
    return (async () => {
      const f = fakeDeps({ putResult: { created: 3, upgraded: 1, failed: 2 } });
      const c = emptySessionWriteCounters();
      await writeSymbolBatch([row(recent(1)), row(recent(1, 15))], f.deps, c);
      // Six rows were handed in across the two calls' fixtures; what is counted
      // is created+upgraded from the RESULT, never the input length.
      assert.equal(c.rowsWritten, 4);
      assert.equal(c.failed, 2);
      assert.equal(c.sessionsWritten, 1);
      assert.equal(c.sessionsDisplaced, 0);
      assert.ok(!f.calls.includes("deleteSessionRows"));
    })();
  });
});

describe("hot path — DISPLACEMENT, and the ORDER that makes it safe", () => {
  it("deletes BEFORE it writes", () => {
    return (async () => {
      const f = fakeDeps({ existing: [RT_CANDLE_SOURCE] });
      const c = emptySessionWriteCounters();
      await writeSymbolBatch([row(recent(1))], f.deps, c);
      const del = f.calls.indexOf("deleteSessionRows");
      const put = f.calls.indexOf("putCandles");
      assert.ok(del !== -1 && put !== -1, `calls were ${f.calls.join(",")}`);
      assert.ok(
        del < put,
        "putCandles ran before deleteSessionRows — a crash between them would " +
          "leave the session holding TWO sources, which is the exact state the " +
          "rule exists to prevent",
      );
    })();
  });

  it("deletes only the sources the verdict named", () => {
    return (async () => {
      const f = fakeDeps({ existing: [RT_CANDLE_SOURCE] });
      const c = emptySessionWriteCounters();
      await writeSymbolBatch([row(recent(1))], f.deps, c);
      assert.deepEqual(f.deletes[0]!.sources, [RT_CANDLE_SOURCE]);
      assert.equal(c.sessionsDisplaced, 1);
      assert.equal(c.rowsDeleted, 42);
    })();
  });

  it("scopes the delete to the ET session window", () => {
    return (async () => {
      const f = fakeDeps({ existing: [RT_CANDLE_SOURCE] });
      const c = emptySessionWriteCounters();
      const ts = new Date("2026-01-15T14:35:00Z");
      // Force the hot path by using a `now` close to the bar.
      f.deps.now = () => new Date("2026-01-20T00:00:00Z");
      await writeSymbolBatch([row(ts)], f.deps, c);
      const d = f.deletes[0]!;
      assert.equal(
        new Date(d.startMs).toISOString(),
        "2026-01-15T05:00:00.000Z",
      );
      assert.equal(new Date(d.endMs).toISOString(), "2026-01-16T05:00:00.000Z");
    })();
  });
});

describe("hot path — refusals write nothing", () => {
  it("REFUSES a session held by a stronger source and does not delete", () => {
    return (async () => {
      const f = fakeDeps({ existing: ["TIINGO"] });
      const c = emptySessionWriteCounters();
      await writeSymbolBatch([row(recent(1))], f.deps, c);
      assert.equal(c.sessionsRefused, 1);
      assert.equal(c.rowsWritten, 0);
      assert.ok(!f.calls.includes("deleteSessionRows"));
      assert.ok(!f.calls.includes("putCandles"));
    })();
  });

  it("counts a D1 refusal SEPARATELY — that counter must read zero forever", () => {
    return (async () => {
      const f = fakeDeps({ existing: ["TIINGO"] });
      const c = emptySessionWriteCounters();
      await writeSymbolBatch([row(recent(1), { timeframe: "D1" })], f.deps, c);
      assert.equal(c.refusedD1, 1);
    })();
  });

  it("a same-source session is written without a delete, so a re-run is a no-op", () => {
    return (async () => {
      const f = fakeDeps({ existing: [DATABENTO_SOURCE] });
      const c = emptySessionWriteCounters();
      await writeSymbolBatch([row(recent(1))], f.deps, c);
      assert.equal(c.sessionsSameSource, 1);
      assert.equal(c.sessionsDisplaced, 0);
      assert.ok(!f.calls.includes("deleteSessionRows"));
    })();
  });

  it("one failing session does not abandon the others", () => {
    return (async () => {
      const f = fakeDeps();
      let n = 0;
      f.deps.putCandles = async (rows) => {
        n++;
        if (n === 1) throw new Error("mongo blip");
        return { created: rows.length, upgraded: 0, failed: 0 };
      };
      const c = emptySessionWriteCounters();
      await writeSymbolBatch([row(recent(1)), row(recent(2))], f.deps, c);
      assert.equal(c.sessionsWritten, 1);
      assert.ok(c.failed > 0);
    })();
  });
});

/* ── cold path ─────────────────────────────────────────────────────────── */

describe("cold path — the shard is rewritten WHOLE, never merged", () => {
  const old = new Date("2024-06-03T14:30:00Z");

  it("writes with merge:false — a merge would resurrect displaced bars", () => {
    return (async () => {
      const f = fakeDeps();
      const c = emptySessionWriteCounters();
      await writeSymbolBatch([row(old)], f.deps, c);
      assert.equal(f.shardWrites.length, 1);
      assert.equal(f.shardWrites[0]!.merge, false);
      assert.equal(f.shardWrites[0]!.year, 2024);
      assert.equal(c.coldShardsWritten, 1);
    })();
  });

  it("DROPS the displaced source's bars and KEEPS a neighbouring session", () => {
    return (async () => {
      const neighbour = new Date("2024-06-04T14:30:00Z");
      const f = fakeDeps({
        shard: [bar(old, RT_CANDLE_SOURCE), bar(neighbour, RT_CANDLE_SOURCE)],
      });
      const c = emptySessionWriteCounters();
      await writeSymbolBatch([row(old)], f.deps, c);
      const written = f.shardWrites[0]!.bars;
      // The 06-03 realtime bar is gone; the 06-04 one is untouched, because
      // displacement is decided per SESSION and not per shard.
      assert.equal(
        written.filter(
          (b) =>
            b.ts.getTime() === old.getTime() && b.source === RT_CANDLE_SOURCE,
        ).length,
        0,
      );
      assert.equal(
        written.filter((b) => b.ts.getTime() === neighbour.getTime()).length,
        1,
      );
      assert.equal(c.coldRowsDisplaced, 1);
    })();
  });

  it("an incoming bar WINS over an existing one at the same natural key", () => {
    return (async () => {
      const f = fakeDeps({
        shard: [bar(old, DATABENTO_SOURCE, { close: 999 })],
      });
      const c = emptySessionWriteCounters();
      await writeSymbolBatch([row(old, { close: 1.5 })], f.deps, c);
      const written = f.shardWrites[0]!.bars.filter(
        (b) => b.ts.getTime() === old.getTime(),
      );
      assert.equal(written.length, 1);
      assert.equal(written[0]!.close, 1.5);
    })();
  });

  it("a REFUSED cold session keeps the existing bars and writes no incoming", () => {
    return (async () => {
      const f = fakeDeps({ shard: [bar(old, "TIINGO", { close: 777 })] });
      const c = emptySessionWriteCounters();
      await writeSymbolBatch([row(old)], f.deps, c);
      assert.equal(c.sessionsRefused, 1);
      // Nothing changed, so nothing is rewritten — a PUT would restart the
      // object's lifecycle age for no reason.
      assert.equal(f.shardWrites.length, 0);
    })();
  });

  it("a FAILED shard read NEVER becomes an empty shard", () => {
    return (async () => {
      // `absent` and `failed` are different answers. Treating a GCS outage as
      // "no history" would rewrite a symbol-year from whatever this batch holds.
      const f = fakeDeps({ shardFails: true });
      const c = emptySessionWriteCounters();
      await writeSymbolBatch([row(old)], f.deps, c);
      assert.equal(f.shardWrites.length, 0);
      assert.ok(c.failed > 0);
    })();
  });

  it("a session that straddles the YEAR boundary writes BOTH shards", () => {
    return (async () => {
      // 2024-12-31 19:30 ET is 2025-01-01 00:30 UTC — one ET session, two
      // shard years, because shards are keyed by the bar's own UTC year.
      const f = fakeDeps();
      const c = emptySessionWriteCounters();
      await writeSymbolBatch(
        [
          row(new Date("2024-12-31T14:35:00Z")),
          row(new Date("2025-01-01T00:30:00Z")),
        ],
        f.deps,
        c,
      );
      assert.deepEqual(f.shardWrites.map((w) => w.year).sort(), [2024, 2025]);
    })();
  });

  it("is IDEMPOTENT — a second pass over its own output changes nothing", () => {
    return (async () => {
      const first = fakeDeps();
      const c1 = emptySessionWriteCounters();
      await writeSymbolBatch([row(old)], first.deps, c1);
      const produced = first.shardWrites[0]!.bars;

      const second = fakeDeps({ shard: [...produced] });
      const c2 = emptySessionWriteCounters();
      await writeSymbolBatch([row(old)], second.deps, c2);
      assert.equal(c2.sessionsSameSource, 1);
      assert.equal(c2.coldRowsDisplaced, 0);
      assert.equal(
        second.shardWrites.length,
        0,
        "a no-op must not rewrite the object",
      );
    })();
  });
});
