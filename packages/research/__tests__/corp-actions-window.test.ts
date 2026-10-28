/**
 * UNIT TEST — corporate-action request chunking (MONEY-1098 / P5.2).
 *
 * Exercises the REAL exports from `src/data-sources/corp-actions-window.ts`
 * (no shadow copies):
 *   - `splitDateWindows`  — the chunk-boundary arithmetic
 *   - `inclusiveDaySpan` / `toUtcDay` / `parseNSEDate`
 *   - `fetchInWindows`    — sequential runner, pacing, the split log line
 *
 * The whole point of chunking is that a 20-year request stops being ONE
 * silently-truncated call. The failure it replaces is invisible (no error, just
 * missing years), so the boundary properties are asserted structurally rather
 * than spot-checked: the windows must RE-UNION exactly to the requested range —
 * no gap, no overlap, each endpoint present exactly once.
 *
 * No network, no timers (`paceMs: 0` skips the sleep entirely), so nothing here
 * can orphan the runner.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  splitDateWindows,
  inclusiveDaySpan,
  toUtcDay,
  parseNSEDate,
  fetchInWindows,
  windowPaceMs,
  MAX_CORP_ACTION_WINDOW_DAYS,
  type DateWindow,
  describeWindows,
} from "../src/data-sources/corp-actions-window";

const MS_PER_DAY = 86_400_000;
const utc = (y: number, m: number, d: number): Date =>
  new Date(Date.UTC(y, m - 1, d));
const iso = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The re-union invariant, asserted as one reusable property so every range in
 * this file is held to the same standard.
 */
function assertExactCover(
  windows: DateWindow[],
  from: Date,
  to: Date,
  maxDays: number,
): void {
  assert.ok(windows.length > 0, "expected at least one window");

  // Endpoints present, exactly once, at the edges.
  assert.strictEqual(iso(windows[0]!.from), iso(from), "first window.from");
  assert.strictEqual(iso(windows.at(-1)!.to), iso(to), "last window.to");

  let days = 0;
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;
    const span = inclusiveDaySpan(w.from, w.to);
    assert.ok(span >= 1, `window ${i} must span >= 1 day, got ${span}`);
    assert.ok(
      span <= maxDays,
      `window ${i} spans ${span}d, exceeding the ${maxDays}d cap`,
    );
    days += span;

    if (i > 0) {
      const prev = windows[i - 1]!;
      // Adjacent, NOT overlapping: inclusive windows must start the day AFTER
      // the previous one ends. Equality here would double-count the boundary.
      assert.strictEqual(
        w.from.getTime(),
        prev.to.getTime() + MS_PER_DAY,
        `gap/overlap between window ${i - 1} and ${i}`,
      );
    }
  }

  // The day counts summing to the total is the "no gap AND no overlap" proof
  // once adjacency is established.
  assert.strictEqual(
    days,
    inclusiveDaySpan(from, to),
    "windows must re-union to exactly the requested day count",
  );
}

// ── splitDateWindows ─────────────────────────────────────────────────────────

describe("splitDateWindows", () => {
  it("returns ONE window when the range already fits the cap", () => {
    const from = utc(2026, 8, 1);
    const to = utc(2026, 8, 7);
    const windows = splitDateWindows(from, to, 180);
    assert.strictEqual(windows.length, 1);
    assertExactCover(windows, from, to, 180);
  });

  it("treats from === to as a single one-day window", () => {
    const day = utc(2026, 8, 8);
    const windows = splitDateWindows(day, day, 180);
    assert.strictEqual(windows.length, 1);
    assert.strictEqual(inclusiveDaySpan(windows[0]!.from, windows[0]!.to), 1);
    assertExactCover(windows, day, day, 180);
  });

  it("splits exactly at the cap without overlapping the boundary", () => {
    // 360 days inclusive = exactly two 180-day windows.
    const from = utc(2026, 1, 1);
    const to = new Date(from.getTime() + 359 * MS_PER_DAY);
    const windows = splitDateWindows(from, to, 180);

    assert.strictEqual(windows.length, 2);
    assert.strictEqual(
      iso(windows[0]!.to),
      iso(new Date(from.getTime() + 179 * MS_PER_DAY)),
    );
    assert.strictEqual(
      iso(windows[1]!.from),
      iso(new Date(from.getTime() + 180 * MS_PER_DAY)),
    );
    assertExactCover(windows, from, to, 180);
  });

  it("emits a short FINAL window rather than overshooting `to`", () => {
    const from = utc(2026, 1, 1);
    const to = new Date(from.getTime() + 200 * MS_PER_DAY); // 201 days
    const windows = splitDateWindows(from, to, 180);

    assert.strictEqual(windows.length, 2);
    assert.strictEqual(inclusiveDaySpan(windows[0]!.from, windows[0]!.to), 180);
    assert.strictEqual(inclusiveDaySpan(windows[1]!.from, windows[1]!.to), 21);
    assertExactCover(windows, from, to, 180);
  });

  it("chunks a ~7,300-day (20-year) span into windows that re-union EXACTLY", () => {
    // The backfill this ticket exists for: 2005-01-01 .. 2024-12-31.
    const from = utc(2005, 1, 1);
    const to = utc(2024, 12, 31);
    const totalDays = inclusiveDaySpan(from, to);
    assert.strictEqual(totalDays, 7305); // 20 years incl. 5 leap days

    const windows = splitDateWindows(from, to, MAX_CORP_ACTION_WINDOW_DAYS);
    assert.strictEqual(
      windows.length,
      Math.ceil(totalDays / MAX_CORP_ACTION_WINDOW_DAYS),
    );
    assert.strictEqual(windows.length, 41);
    assertExactCover(windows, from, to, MAX_CORP_ACTION_WINDOW_DAYS);
  });

  it("covers every calendar day exactly once (enumerated, not just counted)", () => {
    const from = utc(2023, 11, 20);
    const to = utc(2024, 3, 10); // spans a leap day AND a year boundary
    const windows = splitDateWindows(from, to, 17);

    const seen = new Map<string, number>();
    for (const w of windows) {
      for (let t = w.from.getTime(); t <= w.to.getTime(); t += MS_PER_DAY) {
        const key = iso(new Date(t));
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    assert.strictEqual(seen.size, inclusiveDaySpan(from, to));
    for (const [day, count] of seen) {
      assert.strictEqual(count, 1, `${day} covered ${count}x`);
    }
    assert.ok(seen.has("2024-02-29"), "leap day must be covered");
    assertExactCover(windows, from, to, 17);
  });

  it("is DST-proof: whole-UTC-day steps regardless of the host zone", () => {
    // 30 Mar 2025 is the European DST switch; a local-midnight step would emit a
    // 23-hour "day" here and drift every subsequent boundary.
    const from = utc(2025, 3, 25);
    const to = utc(2025, 4, 5);
    const windows = splitDateWindows(from, to, 4);
    for (const w of windows) {
      assert.strictEqual(w.from.getUTCHours(), 0);
      assert.strictEqual(w.to.getUTCHours(), 0);
    }
    assertExactCover(windows, from, to, 4);
  });

  it("floors sub-day precision to UTC midnight on both ends", () => {
    const from = new Date("2026-08-01T18:45:12.345Z");
    const to = new Date("2026-08-03T02:00:00.000Z");
    const windows = splitDateWindows(from, to, 180);
    assert.strictEqual(
      windows[0]!.from.toISOString(),
      "2026-08-01T00:00:00.000Z",
    );
    assert.strictEqual(
      windows[0]!.to.toISOString(),
      "2026-08-03T00:00:00.000Z",
    );
  });

  it("returns [] for an inverted range instead of a whole-market pull", () => {
    assert.deepStrictEqual(
      splitDateWindows(utc(2026, 8, 10), utc(2026, 8, 1), 180),
      [],
    );
  });

  it("returns [] for Invalid Dates (never emits an Invalid window)", () => {
    assert.deepStrictEqual(
      splitDateWindows(new Date("nope"), utc(2026, 8, 1), 180),
      [],
    );
    assert.deepStrictEqual(
      splitDateWindows(utc(2026, 8, 1), new Date("nope"), 180),
      [],
    );
  });

  it("falls back to the 180-day cap for a nonsense maxDays (never loops)", () => {
    const from = utc(2020, 1, 1);
    const to = utc(2021, 1, 1);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const windows = splitDateWindows(from, to, bad);
      assertExactCover(windows, from, to, MAX_CORP_ACTION_WINDOW_DAYS);
    }
  });

  it("defaults to MAX_CORP_ACTION_WINDOW_DAYS when no cap is given", () => {
    const from = utc(2020, 1, 1);
    const to = utc(2022, 1, 1);
    const explicit = splitDateWindows(from, to, MAX_CORP_ACTION_WINDOW_DAYS);
    assert.deepStrictEqual(splitDateWindows(from, to), explicit);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

describe("inclusiveDaySpan / toUtcDay", () => {
  it("counts a single day as 1, not 0", () => {
    const d = utc(2026, 8, 8);
    assert.strictEqual(inclusiveDaySpan(d, d), 1);
  });

  it("returns 0 for inverted or invalid ranges", () => {
    assert.strictEqual(inclusiveDaySpan(utc(2026, 8, 8), utc(2026, 8, 1)), 0);
    assert.strictEqual(inclusiveDaySpan(new Date("x"), utc(2026, 8, 1)), 0);
  });

  it("toUtcDay nulls out missing / Invalid Dates", () => {
    assert.strictEqual(toUtcDay(null), null);
    assert.strictEqual(toUtcDay(undefined), null);
    assert.strictEqual(toUtcDay(new Date("nope")), null);
  });
});

describe("parseNSEDate", () => {
  it("round-trips NSE's DD-MM-YYYY query format as a UTC date", () => {
    assert.strictEqual(
      parseNSEDate("15-03-2024")!.toISOString(),
      "2024-03-15T00:00:00.000Z",
    );
  });

  it("rejects impossible dates instead of rolling them over", () => {
    // `new Date(Date.UTC(2024, 1, 31))` would silently become 2 Mar.
    assert.strictEqual(parseNSEDate("31-02-2024"), null);
    assert.strictEqual(parseNSEDate("00-01-2024"), null);
    assert.strictEqual(parseNSEDate("15-13-2024"), null);
  });

  it("rejects other formats rather than guessing American", () => {
    assert.strictEqual(parseNSEDate("2024-03-15"), null);
    assert.strictEqual(parseNSEDate("15/03/2024"), null);
    assert.strictEqual(parseNSEDate(""), null);
  });
});

describe("windowPaceMs", () => {
  it("honours an explicit 0 rather than falling through to the default", () => {
    const prev = process.env.CORP_ACTIONS_WINDOW_PACE_MS;
    try {
      process.env.CORP_ACTIONS_WINDOW_PACE_MS = "0";
      assert.strictEqual(windowPaceMs(), 0);
      process.env.CORP_ACTIONS_WINDOW_PACE_MS = "250";
      assert.strictEqual(windowPaceMs(), 250);
      delete process.env.CORP_ACTIONS_WINDOW_PACE_MS;
      assert.ok(windowPaceMs() > 0);
    } finally {
      if (prev === undefined) delete process.env.CORP_ACTIONS_WINDOW_PACE_MS;
      else process.env.CORP_ACTIONS_WINDOW_PACE_MS = prev;
    }
  });
});

// ── fetchInWindows ───────────────────────────────────────────────────────────

describe("fetchInWindows", () => {
  it("issues ONE call per window, sequentially, and concatenates in order", async () => {
    const seen: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const out = await fetchInWindows(
      utc(2024, 1, 1),
      utc(2024, 12, 31),
      async (w) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await Promise.resolve();
        concurrent--;
        seen.push(`${iso(w.from)}..${iso(w.to)}`);
        return [iso(w.from)];
      },
      { maxDays: 180, paceMs: 0, log: () => {} },
    );

    assert.strictEqual(seen.length, 3); // 366 days / 180
    assert.strictEqual(maxConcurrent, 1, "windows must not run in parallel");
    assert.deepStrictEqual(
      out.rows,
      seen.map((s) => s.split("..")[0]),
    );
    assert.deepStrictEqual(out.failedWindows, []);
    assert.strictEqual(seen[0], "2024-01-01..2024-06-28");
    assert.strictEqual(seen[1], "2024-06-29..2024-12-25");
    assert.strictEqual(seen[2], "2024-12-26..2024-12-31");
  });

  it("logs the window count when — and only when — it actually splits", async () => {
    const logs: string[] = [];
    await fetchInWindows(utc(2005, 1, 1), utc(2024, 12, 31), async () => [], {
      maxDays: 180,
      paceMs: 0,
      label: "NSE corp-actions",
      log: (m) => logs.push(m),
    });
    assert.strictEqual(logs.length, 1);
    assert.match(logs[0]!, /NSE corp-actions/);
    assert.match(logs[0]!, /7305d span -> 41 windows \(<=180d each\)/);

    logs.length = 0;
    await fetchInWindows(utc(2026, 8, 1), utc(2026, 8, 5), async () => [], {
      maxDays: 180,
      paceMs: 0,
      log: (m) => logs.push(m),
    });
    assert.deepStrictEqual(logs, [], "a single-window range must not log");
  });

  it("returns [] without calling the fetcher for an inverted range", async () => {
    let calls = 0;
    const out = await fetchInWindows(
      utc(2026, 8, 10),
      utc(2026, 8, 1),
      async () => {
        calls++;
        return [1];
      },
      { paceMs: 0, log: () => {} },
    );
    assert.deepStrictEqual(out, { rows: [], failedWindows: [] });
    assert.strictEqual(calls, 0);
  });

  // MONEY-1189 — `null` from a fetcher means "asked, never answered"; `[]`
  // means "answered, nothing there". Collapsing them let a 20-year backfill
  // lose 37 NSE windows and one BSE window while printing a success summary.
  it("records a null window as FAILED and keeps walking the rest", async () => {
    const out = await fetchInWindows(
      utc(2024, 1, 1),
      utc(2024, 12, 31),
      async (w) => (iso(w.from) === "2024-06-29" ? null : [iso(w.from)]),
      { maxDays: 180, paceMs: 0, log: () => {} },
    );
    assert.deepStrictEqual(out.rows, ["2024-01-01", "2024-12-26"]);
    assert.strictEqual(out.failedWindows.length, 1);
    assert.strictEqual(iso(out.failedWindows[0]!.from), "2024-06-29");
    assert.strictEqual(iso(out.failedWindows[0]!.to), "2024-12-25");
  });

  it("does NOT record an empty window as failed", async () => {
    const out = await fetchInWindows(
      utc(2024, 1, 1),
      utc(2024, 12, 31),
      async () => [],
      { maxDays: 180, paceMs: 0, log: () => {} },
    );
    assert.deepStrictEqual(out.rows, []);
    assert.deepStrictEqual(
      out.failedWindows,
      [],
      "an empty answer is an answer",
    );
  });

  it("reports EVERY failed window when the feed is down throughout", async () => {
    const out = await fetchInWindows(
      utc(2024, 1, 1),
      utc(2024, 12, 31),
      async () => null,
      { maxDays: 180, paceMs: 0, log: () => {} },
    );
    assert.deepStrictEqual(out.rows, []);
    assert.strictEqual(out.failedWindows.length, 3);
  });

  it("propagates a fetcher error (the BSE 429 circuit-break contract)", async () => {
    class Boom extends Error {}
    await assert.rejects(
      fetchInWindows(
        utc(2024, 1, 1),
        utc(2024, 12, 31),
        async () => {
          throw new Boom("rate limited");
        },
        { maxDays: 180, paceMs: 0, log: () => {} },
      ),
      Boom,
    );
  });
});

// ── describeWindows ─────────────────────────────────────────────────────────

describe("describeWindows", () => {
  const w = (a: string, b: string) => ({ from: new Date(a), to: new Date(b) });

  it("renders in the SAME DD-MM-YYYY grammar the NSE query takes", () => {
    // So a logged failure pastes straight into a heal run. The previous
    // incident was recovered by grepping run logs and hand-reconstructing 37
    // ranges (MONEY-1189).
    assert.strictEqual(
      describeWindows([w("2007-08-18", "2007-09-16")]),
      "18-08-2007..16-09-2007",
    );
  });

  it("zero-pads single-digit days and months", () => {
    assert.strictEqual(
      describeWindows([w("2004-04-15", "2004-05-14")]),
      "15-04-2004..14-05-2004",
    );
  });

  it("joins several windows", () => {
    assert.strictEqual(
      describeWindows([
        w("2024-01-01", "2024-06-28"),
        w("2024-06-29", "2024-12-25"),
      ]),
      "01-01-2024..28-06-2024, 29-06-2024..25-12-2024",
    );
  });

  it("caps the list but SAYS how many it dropped", () => {
    // Truncating silently would reproduce the bug this whole line exists to
    // report on.
    const many = Array.from({ length: 12 }, () =>
      w("2024-01-01", "2024-06-28"),
    );
    const out = describeWindows(many, 3);
    // 3 windows joined by ", ", then " (+9 more)" appended with a space.
    assert.strictEqual(out.split(", ").length, 3);
    assert.match(out, /\(\+9 more\)$/);
  });

  it("renders an unparseable window rather than 'NaN-NaN-NaN'", () => {
    assert.strictEqual(
      describeWindows([{ from: new Date(NaN), to: new Date(NaN) }]),
      "unparseable..unparseable",
    );
  });

  it("is empty for no failures", () => {
    assert.strictEqual(describeWindows([]), "");
  });
});
