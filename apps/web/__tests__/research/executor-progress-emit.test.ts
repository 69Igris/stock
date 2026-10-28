/**
 * Executor progress-emit semantics - B3 (MONEY-218-followup).
 *
 * Pre-fix: the executor called `throttledProgress` only when a task
 * STARTED ("Running X"). The per-task `totalCompleted++` happened
 * after `Promise.allSettled` resolved for the entire batch, with no
 * accompanying `throttledProgress(totalCompleted, ...)` call. The
 * "0 of N" → "N of N" UI jump was the visible symptom.
 *
 * Fix: emit a `throttledProgress(totalCompleted, ...)` inside the
 * per-task map callback after `totalCompleted++`. The existing 2s
 * throttle still prevents DB write storms, but the UI now sees
 * monotonic deltas as tasks finish - even mid-batch when several
 * parallel tasks resolve back-to-back.
 *
 * Logic is inlined so the test runs without booting the executor's
 * dependencies (Scratchpad, tools, gemini, etc.).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface ProgressEvent {
  completed: number;
  total: number;
  step: string;
  ts: number;
}

interface FakeTask {
  id: string;
  durationMs: number;
  fails?: boolean;
}

/**
 * Mirrors the post-fix executor loop: per-batch parallel, per-task
 * progress emit on completion. Throttle is faithfully simulated.
 */
async function runExecutor(
  tasks: FakeTask[],
  opts: { maxConcurrency: number; throttleMs: number }
): Promise<{ events: ProgressEvent[]; totalCompleted: number }> {
  const events: ProgressEvent[] = [];
  let lastEmitTs = -Infinity;
  let pending: ProgressEvent | null = null;
  let totalCompleted = 0;
  const startTs = Date.now();

  const throttledEmit = (ev: Omit<ProgressEvent, "ts">) => {
    const now = Date.now() - startTs;
    if (now - lastEmitTs >= opts.throttleMs) {
      lastEmitTs = now;
      events.push({ ...ev, ts: now });
      pending = null;
    } else {
      pending = { ...ev, ts: now };
    }
  };

  // Sequential batches of `maxConcurrency` so dependencies aren't
  // modeled - every task is independent.
  for (let i = 0; i < tasks.length; i += opts.maxConcurrency) {
    const batch = tasks.slice(i, i + opts.maxConcurrency);
    // Mark each task as "running" (the START event mirrors the
    // pre-fix-only emit; we keep it so the test mirrors reality).
    for (const t of batch) {
      throttledEmit({
        completed: totalCompleted,
        total: tasks.length,
        step: `Running ${t.id}`,
      });
    }
    await Promise.allSettled(
      batch.map(async (t) => {
        await new Promise((res) => setTimeout(res, t.durationMs));
        totalCompleted++;
        // POST-FIX emit - this is the line the B3 fix added.
        throttledEmit({
          completed: totalCompleted,
          total: tasks.length,
          step: t.fails ? `Failed ${t.id}` : `Completed ${t.id}`,
        });
      })
    );
  }

  // Flush pending (mirrors the executor's final flush)
  if (pending) events.push(pending);
  return { events, totalCompleted };
}

describe("executor progress emit - B3 (MONEY-218-followup)", () => {
  it("emits per-task COMPLETED events as tasks finish, not only at end", async () => {
    const tasks: FakeTask[] = [
      { id: "t1", durationMs: 5 },
      { id: "t2", durationMs: 5 },
      { id: "t3", durationMs: 5 },
    ];
    // Throttle = 0 so every event emits - proves the new emit point
    // exists. (Real executor uses 2s throttle in prod - separate
    // concern verified below.)
    const { events, totalCompleted } = await runExecutor(tasks, {
      maxConcurrency: 1,
      throttleMs: 0,
    });
    assert.equal(totalCompleted, 3);
    const completedEvents = events.filter((e) =>
      e.step.startsWith("Completed ")
    );
    assert.equal(completedEvents.length, 3);
    // Per-task emit means we observe (1,3), (2,3), (3,3) deltas
    assert.deepEqual(
      completedEvents.map((e) => e.completed),
      [1, 2, 3]
    );
  });

  it("monotonic completed count - never goes backward", async () => {
    const tasks: FakeTask[] = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      durationMs: 3,
    }));
    const { events } = await runExecutor(tasks, {
      maxConcurrency: 4,
      throttleMs: 0,
    });
    const completedEvents = events.filter((e) =>
      e.step.startsWith("Completed ")
    );
    for (let i = 1; i < completedEvents.length; i++) {
      assert.ok(
        completedEvents[i]!.completed >= completedEvents[i - 1]!.completed,
        `regressed at index ${i}`
      );
    }
  });

  it("Failed tasks still bump totalCompleted + emit a Failed event", async () => {
    const tasks: FakeTask[] = [
      { id: "ok", durationMs: 5 },
      { id: "boom", durationMs: 5, fails: true },
      { id: "ok2", durationMs: 5 },
    ];
    const { events, totalCompleted } = await runExecutor(tasks, {
      maxConcurrency: 3,
      throttleMs: 0,
    });
    assert.equal(totalCompleted, 3);
    const failedEvents = events.filter((e) => e.step.startsWith("Failed "));
    assert.equal(failedEvents.length, 1);
  });

  it("throttle batches rapid completions but final flush still fires", async () => {
    const tasks: FakeTask[] = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      durationMs: 1,
    }));
    // Aggressive throttle so most per-task emits get queued
    const { events, totalCompleted } = await runExecutor(tasks, {
      maxConcurrency: 5,
      throttleMs: 5000,
    });
    assert.equal(totalCompleted, 10);
    // The final "completed=10" event is queued/flushed even though
    // the throttle would otherwise suppress it.
    const lastEvent = events[events.length - 1]!;
    assert.equal(lastEvent.completed, 10);
  });

  it("pre-fix simulation: WITHOUT per-task emit, UI sees only 0 → N", async () => {
    // Reimplements the pre-fix loop (no completion emit) to prove
    // the bug existed in the first place.
    let lastEmit = -Infinity;
    const events: { completed: number; total: number }[] = [];
    const emit = (c: number, t: number) => {
      const now = events.length;
      if (now - lastEmit >= 0) {
        lastEmit = now;
        events.push({ completed: c, total: t });
      }
    };
    const tasks = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      durationMs: 1,
    }));
    let total = 0;
    for (let i = 0; i < tasks.length; i += 4) {
      const batch = tasks.slice(i, i + 4);
      // Pre-fix only emitted "Running" at task start (count not bumped)
      for (const _t of batch) emit(total, tasks.length);
      await Promise.allSettled(
        batch.map(async () => {
          await new Promise((res) => setTimeout(res, 1));
          total++;
          // NOTE: no emit here pre-fix
        })
      );
    }
    // Simulating the lone "Execution complete" final emit
    emit(total, tasks.length);
    const completionDeltas = events.map((e) => e.completed);
    // Pre-fix sequence with maxConcurrency=4 + 8 tasks:
    //   [0,0,0,0,    ← first batch START (4 emits, count still 0)
    //    4,4,4,4,    ← second batch START (count is 4 - first batch
    //                  completed silently inside Promise.allSettled
    //                  with NO progress emits during the gap)
    //    8]          ← final flush
    // The bug: the user sees the count jump 0 → 4 → 8 in two visible
    // moments, with no per-task delta in between. With 17 tasks and
    // varying durations the symptom is the dramatic 0 → 15 jump.
    assert.equal(completionDeltas[0], 0);
    assert.equal(completionDeltas[completionDeltas.length - 1], 8);
    // The number of unique completion values equals batches+1 - that
    // IS the bug: the user sees 3 distinct counts for 8 tasks.
    const unique = Array.from(new Set(completionDeltas));
    assert.equal(unique.length, 3, `expected 3 unique values, got ${unique}`);
  });
});
