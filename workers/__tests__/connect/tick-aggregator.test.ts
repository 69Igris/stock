/**
 * Tick Aggregator Tests
 *
 * Tests for apps/web/lib/market/tick-aggregator.ts - the server-side
 * tick → bar state machine that powers MONEY-123 Part B's live chart
 * stream.
 *
 * The aggregator has no external dependencies (no Prisma, no Next,
 * no broker WebSocket), so we import it directly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TickAggregator,
  snapToBarStart,
  getIntervalSeconds,
  type Bar,
} from "../../src/connect/tick-aggregator";

// ============== PURE HELPERS ==============

describe("getIntervalSeconds", () => {
  it("returns expected widths for canonical intervals", () => {
    assert.equal(getIntervalSeconds("1m"), 60);
    assert.equal(getIntervalSeconds("3m"), 180);
    assert.equal(getIntervalSeconds("5m"), 300);
    assert.equal(getIntervalSeconds("10m"), 600);
    assert.equal(getIntervalSeconds("15m"), 900);
    assert.equal(getIntervalSeconds("30m"), 1800);
    assert.equal(getIntervalSeconds("60m"), 3600);
    assert.equal(getIntervalSeconds("1h"), 3600);
  });

  it("returns null for unsupported intervals", () => {
    assert.equal(getIntervalSeconds("1d"), null);
    assert.equal(getIntervalSeconds("1w"), null);
    assert.equal(getIntervalSeconds(""), null);
    assert.equal(getIntervalSeconds("foo"), null);
  });
});

describe("snapToBarStart", () => {
  it("snaps a timestamp down to the bar boundary for 5m", () => {
    // 5m bars at :00, :05, :10, :15...
    // 09:17:23 → 09:15:00
    const t = Date.UTC(2026, 3, 8, 9, 17, 23) / 1000;
    const expected = Date.UTC(2026, 3, 8, 9, 15, 0) / 1000;
    assert.equal(snapToBarStart(t, 300), expected);
  });

  it("returns the same timestamp when it's already on a boundary", () => {
    const t = Date.UTC(2026, 3, 8, 9, 15, 0) / 1000;
    assert.equal(snapToBarStart(t, 300), t);
  });

  it("snaps to the lower boundary for 1m intervals", () => {
    const t = Date.UTC(2026, 3, 8, 9, 17, 59) / 1000;
    const expected = Date.UTC(2026, 3, 8, 9, 17, 0) / 1000;
    assert.equal(snapToBarStart(t, 60), expected);
  });

  it("snaps to the lower boundary for 60m intervals", () => {
    // 09:45 → 09:00 for hourly bars
    const t = Date.UTC(2026, 3, 8, 9, 45, 0) / 1000;
    const expected = Date.UTC(2026, 3, 8, 9, 0, 0) / 1000;
    assert.equal(snapToBarStart(t, 3600), expected);
  });
});

// ============== TICK AGGREGATOR ==============

describe("TickAggregator constructor", () => {
  it("throws on unsupported interval", () => {
    assert.throws(() => new TickAggregator("1d"), /Unsupported interval/);
    assert.throws(() => new TickAggregator(""), /Unsupported interval/);
  });

  it("accepts canonical intraday intervals", () => {
    for (const iv of ["1m", "3m", "5m", "10m", "15m", "30m", "60m", "1h"]) {
      assert.doesNotThrow(() => new TickAggregator(iv));
    }
  });

  it("starts with no current bar", () => {
    const agg = new TickAggregator("5m");
    assert.equal(agg.getCurrentBar(), null);
  });
});

describe("TickAggregator.ingest - first tick", () => {
  it("opens a new bar at the snapped timestamp", () => {
    const agg = new TickAggregator("5m");
    const updates: Array<{ bar: Bar; isNew: boolean }> = [];
    agg.onBarUpdate((bar, isNew) => updates.push({ bar: { ...bar }, isNew }));

    // Tick at 09:17:23 → bar at 09:15:00
    const t = Date.UTC(2026, 3, 8, 9, 17, 23) / 1000;
    agg.ingest(1000, 50, t);

    assert.equal(updates.length, 1);
    assert.equal(updates[0]!.isNew, true);
    assert.equal(updates[0]!.bar.time, Date.UTC(2026, 3, 8, 9, 15, 0) / 1000);
    assert.equal(updates[0]!.bar.open, 1000);
    assert.equal(updates[0]!.bar.high, 1000);
    assert.equal(updates[0]!.bar.low, 1000);
    assert.equal(updates[0]!.bar.close, 1000);
    assert.equal(updates[0]!.bar.volume, 50);
  });

  it("treats negative volumeDelta as 0", () => {
    const agg = new TickAggregator("5m");
    const t = Date.UTC(2026, 3, 8, 9, 17, 23) / 1000;
    agg.ingest(1000, -100, t);
    assert.equal(agg.getCurrentBar()!.volume, 0);
  });
});

describe("TickAggregator.ingest - within current bar", () => {
  it("updates high, low, close on subsequent ticks in the same bar", () => {
    const agg = new TickAggregator("5m");
    const t0 = Date.UTC(2026, 3, 8, 9, 15, 5) / 1000;
    agg.ingest(1000, 10, t0);
    agg.ingest(1005, 5, t0 + 30); // higher
    agg.ingest(998, 5, t0 + 60); // lower
    agg.ingest(1003, 5, t0 + 90); // back up

    const bar = agg.getCurrentBar()!;
    assert.equal(bar.open, 1000);
    assert.equal(bar.high, 1005);
    assert.equal(bar.low, 998);
    assert.equal(bar.close, 1003);
    assert.equal(bar.volume, 25);
  });

  it("emits an update event for every tick", () => {
    const agg = new TickAggregator("5m");
    const updates: Array<{ isNew: boolean }> = [];
    agg.onBarUpdate((_, isNew) => updates.push({ isNew }));

    const t0 = Date.UTC(2026, 3, 8, 9, 15, 5) / 1000;
    agg.ingest(1000, 10, t0);
    agg.ingest(1005, 5, t0 + 30);
    agg.ingest(998, 5, t0 + 60);

    assert.equal(updates.length, 3);
    assert.equal(updates[0]!.isNew, true);
    assert.equal(updates[1]!.isNew, false);
    assert.equal(updates[2]!.isNew, false);
  });
});

describe("TickAggregator.ingest - bar boundary crossing", () => {
  it("rotates to a new bar and emits new=true", () => {
    const agg = new TickAggregator("5m");
    const updates: Array<{ bar: Bar; isNew: boolean }> = [];
    agg.onBarUpdate((bar, isNew) => updates.push({ bar: { ...bar }, isNew }));

    // First bar: 09:15-09:20
    const t1 = Date.UTC(2026, 3, 8, 9, 17, 0) / 1000;
    agg.ingest(1000, 10, t1);
    agg.ingest(1005, 5, t1 + 30);

    // Cross into 09:20-09:25
    const t2 = Date.UTC(2026, 3, 8, 9, 20, 5) / 1000;
    agg.ingest(1010, 20, t2);

    assert.equal(updates.length, 4);
    // Last update of old bar (close-out emit)
    assert.equal(updates[2]!.isNew, false);
    assert.equal(updates[2]!.bar.time, Date.UTC(2026, 3, 8, 9, 15, 0) / 1000);
    // First emit of new bar
    assert.equal(updates[3]!.isNew, true);
    assert.equal(updates[3]!.bar.time, Date.UTC(2026, 3, 8, 9, 20, 0) / 1000);
    assert.equal(updates[3]!.bar.open, 1010);
    assert.equal(updates[3]!.bar.volume, 20);
  });

  it("handles a multi-bar gap without inventing empty bars", () => {
    // Common scenario: trading pause then resume - the next tick is
    // many bars later. Aggregator should NOT invent intermediate bars,
    // just rotate forward.
    const agg = new TickAggregator("5m");
    const t1 = Date.UTC(2026, 3, 8, 9, 15, 0) / 1000;
    agg.ingest(1000, 0, t1);

    // Skip to 09:35 - 4 bars later
    const t2 = Date.UTC(2026, 3, 8, 9, 35, 12) / 1000;
    agg.ingest(1020, 100, t2);

    const bar = agg.getCurrentBar()!;
    assert.equal(bar.time, Date.UTC(2026, 3, 8, 9, 35, 0) / 1000);
    assert.equal(bar.open, 1020);
    assert.equal(bar.volume, 100);
  });
});

describe("TickAggregator.ingest - out of order ticks", () => {
  it("ignores ticks older than the current bar", () => {
    const agg = new TickAggregator("5m");
    const updates: Array<{ bar: Bar }> = [];
    agg.onBarUpdate((bar) => updates.push({ bar: { ...bar } }));

    // Open bar at 09:20
    const t1 = Date.UTC(2026, 3, 8, 9, 20, 0) / 1000;
    agg.ingest(1000, 10, t1);

    // Stale tick from 09:15 (before current bar)
    const tStale = Date.UTC(2026, 3, 8, 9, 15, 0) / 1000;
    agg.ingest(999, 5, tStale);

    // Should still be the 09:20 bar with original open price.
    const current = agg.getCurrentBar()!;
    assert.equal(current.time, Date.UTC(2026, 3, 8, 9, 20, 0) / 1000);
    assert.equal(current.open, 1000);
    // Only the 09:20 tick should have produced an emit.
    assert.equal(updates.length, 1);
  });
});

describe("TickAggregator.onBarUpdate", () => {
  it("returns an unsubscribe function that detaches the listener", () => {
    const agg = new TickAggregator("5m");
    let calls = 0;
    const off = agg.onBarUpdate(() => calls++);

    const t = Date.UTC(2026, 3, 8, 9, 17, 0) / 1000;
    agg.ingest(1000, 10, t);
    assert.equal(calls, 1);

    off();
    agg.ingest(1005, 5, t + 60);
    // No additional calls after detach.
    assert.equal(calls, 1);
  });

  it("isolates listener errors so other listeners still receive updates", () => {
    const agg = new TickAggregator("5m");
    let okCalls = 0;
    agg.onBarUpdate(() => {
      throw new Error("boom");
    });
    agg.onBarUpdate(() => {
      okCalls++;
    });

    const t = Date.UTC(2026, 3, 8, 9, 17, 0) / 1000;
    // Aggregator must not propagate the listener error
    assert.doesNotThrow(() => agg.ingest(1000, 10, t));
    assert.equal(okCalls, 1);
  });

  it("does NOT replay current bar to late subscribers", () => {
    const agg = new TickAggregator("5m");
    const t = Date.UTC(2026, 3, 8, 9, 17, 0) / 1000;
    agg.ingest(1000, 10, t);

    let calls = 0;
    agg.onBarUpdate(() => calls++);
    // Late subscriber should not have received the past tick.
    assert.equal(calls, 0);

    // But the current bar IS available via getCurrentBar()
    assert.notEqual(agg.getCurrentBar(), null);
  });
});

describe("TickAggregator.destroy", () => {
  it("clears listeners and current bar", () => {
    const agg = new TickAggregator("5m");
    let calls = 0;
    agg.onBarUpdate(() => calls++);

    const t = Date.UTC(2026, 3, 8, 9, 17, 0) / 1000;
    agg.ingest(1000, 10, t);
    assert.equal(calls, 1);
    assert.notEqual(agg.getCurrentBar(), null);

    agg.destroy();
    assert.equal(agg.getCurrentBar(), null);

    // Listener was detached - further ticks don't fire it.
    // (Note: ingesting after destroy would re-create a bar; we test
    // only that the listener is gone.)
    agg.ingest(1005, 5, t + 60);
    assert.equal(calls, 1);
  });
});
