/**
 * Research task-scheduling (pure) — REAL imports.
 *
 * De-shadow (MONEY-620): the dependency-resolution / topological-ordering
 * logic used to live inline inside `ResearchExecutor.execute()` (an async
 * method that also fires real tools + Gemini), so it could only be tested by
 * reimplementing it. It now lives in `packages/research/src/lib/task-scheduling.ts`;
 * the executor imports + calls these, and the tests below assert the REAL
 * exports.
 *
 * Focus: negative / edge — circular deps, self-deps, missing-task deps,
 * dangling refs — and the invariant that a cycle yields a DEADLOCK (failed
 * tasks) rather than an infinite loop.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeDependencies,
  findReadyTasks,
  findPendingTasks,
  isDeadlocked,
  markPendingDeadlocked,
  releaseDependencies,
} from "../src/lib/task-scheduling";
import type { ResearchTask } from "../src/types";

// ── builder ──
function task(
  id: string,
  dependsOn: string[] = [],
  status: ResearchTask["status"] = "pending",
): ResearchTask {
  return {
    id,
    type: "data_fetch",
    tool: `tool_${id}`,
    params: {},
    dependsOn,
    status,
  };
}

/**
 * Drive the SAME control flow the executor uses, but synchronously: pick ready
 * tasks, mark them completed, repeat; bail on deadlock. Returns the order
 * completed + whether a deadlock was hit. A hard iteration cap turns any
 * accidental non-termination into a test failure instead of an orphaned hang.
 */
function drain(tasks: ResearchTask[]): {
  order: string[];
  deadlocked: boolean;
  failed: string[];
} {
  sanitizeDependencies(tasks);
  const completed = new Set<string>();
  const order: string[] = [];
  let deadlocked = false;
  const failed: string[] = [];
  const CAP = tasks.length * tasks.length + 10; // generous, but finite
  let iters = 0;

  while (completed.size < tasks.length) {
    if (++iters > CAP) throw new Error("scheduler did not terminate (cycle?)");
    const ready = findReadyTasks(tasks, completed);
    if (ready.length === 0) {
      if (isDeadlocked(tasks, completed)) {
        deadlocked = true;
        for (const t of markPendingDeadlocked(tasks)) failed.push(t.id);
      }
      break;
    }
    for (const t of ready) {
      t.status = "completed";
      completed.add(t.id);
      order.push(t.id);
    }
  }
  return { order, deadlocked, failed };
}

// ===========================================================================
// sanitizeDependencies
// ===========================================================================

describe("task-scheduling - sanitizeDependencies", () => {
  it("strips refs to task IDs that don't exist (dangling/hallucinated)", () => {
    const tasks = [task("a"), task("b", ["a", "ghost", "also_missing"])];
    sanitizeDependencies(tasks);
    assert.deepEqual(tasks[1]!.dependsOn, ["a"]);
  });

  it("keeps valid deps, mutates in place, returns same array", () => {
    const tasks = [task("a"), task("b", ["a"])];
    const out = sanitizeDependencies(tasks);
    assert.equal(out, tasks);
    assert.deepEqual(tasks[1]!.dependsOn, ["a"]);
  });

  it("empty task list → no throw", () => {
    assert.doesNotThrow(() => sanitizeDependencies([]));
  });

  it("does NOT remove a self-dependency (real ID) — left for deadlock to catch", () => {
    // 'a' depends on itself: the ID exists, so sanitize keeps it. It can never
    // become ready (needs itself completed first) → deadlock, not a silent drop.
    const tasks = [task("a", ["a"])];
    sanitizeDependencies(tasks);
    assert.deepEqual(tasks[0]!.dependsOn, ["a"]);
  });
});

// ===========================================================================
// findReadyTasks
// ===========================================================================

describe("task-scheduling - findReadyTasks", () => {
  it("a task with no deps is ready", () => {
    const tasks = [task("a")];
    assert.deepEqual(
      findReadyTasks(tasks, new Set()).map((t) => t.id),
      ["a"],
    );
  });

  it("a task is ready only once ALL deps are completed", () => {
    const tasks = [task("c", ["a", "b"])];
    assert.equal(findReadyTasks(tasks, new Set(["a"])).length, 0);
    assert.equal(findReadyTasks(tasks, new Set(["a", "b"])).length, 1);
  });

  it("non-pending tasks are never returned (no re-run)", () => {
    const done = task("a");
    done.status = "completed";
    const running = task("b");
    running.status = "running";
    assert.equal(findReadyTasks([done, running], new Set()).length, 0);
  });

  it("empty task list → empty (no throw)", () => {
    assert.deepEqual(findReadyTasks([], new Set()), []);
  });
});

// ===========================================================================
// deadlock detection
// ===========================================================================

describe("task-scheduling - isDeadlocked / markPendingDeadlocked", () => {
  it("no pending tasks → not deadlocked", () => {
    const done = task("a");
    done.status = "completed";
    assert.equal(isDeadlocked([done], new Set(["a"])), false);
  });

  it("pending task whose dep is missing-from-set → deadlocked", () => {
    // 'b' depends on 'a' but 'a' is not completed and not otherwise runnable.
    const a = task("a");
    a.status = "failed"; // a will never complete
    const b = task("b", ["a"]);
    assert.equal(isDeadlocked([a, b], new Set()), true);
  });

  it("markPendingDeadlocked fails every pending task with a clear error", () => {
    const a = task("a", ["a"]); // self-cycle
    const b = task("b", ["c"]); // dep on non-existent (post-sanitize would clear,
    // but here we exercise the raw marker)
    const failed = markPendingDeadlocked([a, b]);
    assert.deepEqual(
      failed.map((t) => t.id),
      ["a", "b"],
    );
    for (const t of [a, b]) {
      assert.equal(t.status, "failed");
      assert.equal(t.error, "Unresolvable dependency");
    }
  });

  it("does not touch already-completed tasks", () => {
    const done = task("a");
    done.status = "completed";
    const pending = task("b");
    markPendingDeadlocked([done, pending]);
    assert.equal(done.status, "completed");
    assert.equal(pending.status, "failed");
  });
});

// ===========================================================================
// full drain (topological walk) — termination is the headline invariant
// ===========================================================================

describe("task-scheduling - drain (executor control flow)", () => {
  it("linear chain a→b→c completes in dependency order", () => {
    const r = drain([task("c", ["b"]), task("b", ["a"]), task("a")]);
    assert.deepEqual(r.order, ["a", "b", "c"]);
    assert.equal(r.deadlocked, false);
  });

  it("diamond a→{b,c}→d completes all four, d last", () => {
    const r = drain([
      task("a"),
      task("b", ["a"]),
      task("c", ["a"]),
      task("d", ["b", "c"]),
    ]);
    assert.equal(r.order.length, 4);
    assert.equal(r.order[0], "a");
    assert.equal(r.order[3], "d");
    assert.equal(r.deadlocked, false);
  });

  it("CIRCULAR dep a↔b TERMINATES as deadlock (no infinite loop)", () => {
    // The whole point: a cycle must not spin forever. drain()'s CAP would throw
    // if it did; instead both tasks should end up failed via deadlock.
    const r = drain([task("a", ["b"]), task("b", ["a"])]);
    assert.equal(r.deadlocked, true);
    assert.deepEqual(r.order, []);
    assert.deepEqual(r.failed.sort(), ["a", "b"]);
  });

  it("3-node cycle a→b→c→a terminates as deadlock", () => {
    const r = drain([task("a", ["c"]), task("b", ["a"]), task("c", ["b"])]);
    assert.equal(r.deadlocked, true);
    assert.equal(r.failed.length, 3);
  });

  it("self-dependency a→a terminates as deadlock", () => {
    const r = drain([task("a", ["a"])]);
    assert.equal(r.deadlocked, true);
    assert.deepEqual(r.failed, ["a"]);
  });

  it("partial cycle: independent tasks finish, only the cycle fails", () => {
    // 'x' is independent and should complete; the b↔c cycle deadlocks the rest.
    const r = drain([task("x"), task("b", ["c"]), task("c", ["b"])]);
    assert.deepEqual(r.order, ["x"]); // x ran
    assert.equal(r.deadlocked, true);
    assert.deepEqual(r.failed.sort(), ["b", "c"]); // cycle failed
  });

  it("dangling dep is sanitized away, task then runs (not a false deadlock)", () => {
    // 'b' depends on a ghost ID; sanitize drops it so 'b' becomes a root.
    const r = drain([task("b", ["ghost"]), task("a")]);
    assert.equal(r.deadlocked, false);
    assert.equal(r.order.length, 2);
    assert.ok(r.order.includes("b"));
  });

  it("empty plan → nothing to do, not deadlocked", () => {
    const r = drain([]);
    assert.deepEqual(r.order, []);
    assert.equal(r.deadlocked, false);
  });
});

// ── MONEY-1120: releaseDependencies — synthesis must survive a time-skip ──
//
// The agent skips low-priority tasks when the run is short on time. Because
// `findReadyTasks` only counts a dependency satisfied when it is in
// `completed`, and the planner ends every plan with synthesize_report
// depending on ALL other tasks, skipping even one task left synthesis
// permanently unready — a deadlock that failed it with "Unresolvable
// dependency" and produced the bare "partially completed" fallback with no
// report body (MONEY-1095 items 3, 5, 11).

describe("releaseDependencies (MONEY-1120)", () => {
  it("drops released ids from a pending task's dependsOn", () => {
    const tasks = [task("a", [], "completed"), task("synth", ["a", "b"])];
    const changed = releaseDependencies(tasks, new Set(["b"]));
    assert.deepEqual(tasks[1].dependsOn, ["a"]);
    assert.deepEqual(
      changed.map((t) => t.id),
      ["synth"],
    );
  });

  it("returns an empty array and mutates nothing when the set is empty", () => {
    const tasks = [task("synth", ["a"])];
    assert.deepEqual(releaseDependencies(tasks, new Set()), []);
    assert.deepEqual(tasks[0].dependsOn, ["a"]);
  });

  it("leaves non-pending tasks untouched", () => {
    // A completed task's dependsOn is history — rewriting it would corrupt the
    // record of what the run actually did.
    const done = task("done", ["x"], "completed");
    const failed = task("failed", ["x"], "failed");
    releaseDependencies([done, failed], new Set(["x"]));
    assert.deepEqual(done.dependsOn, ["x"]);
    assert.deepEqual(failed.dependsOn, ["x"]);
  });

  it("reports only the tasks whose dependency list actually shrank", () => {
    const tasks = [task("p", ["gone"]), task("q", ["kept"])];
    const changed = releaseDependencies(tasks, new Set(["gone"]));
    assert.deepEqual(
      changed.map((t) => t.id),
      ["p"],
    );
  });

  it("REGRESSION: a skipped dep deadlocks synthesis until released", () => {
    // Exactly the agent's low-time path: one data task is skipped (failed),
    // synthesis depends on it.
    const fetched = task("fetched", [], "completed");
    const skipped = task("skipped", [], "failed");
    const synth = task("synth", ["fetched", "skipped"]);
    synth.type = "synthesis";
    const tasks = [fetched, skipped, synth];
    const completed = new Set(["fetched"]);

    // Before: synthesis can never become ready → deadlock → no report.
    assert.deepEqual(findReadyTasks(tasks, completed), []);
    assert.equal(isDeadlocked(tasks, completed), true);

    // After releasing the skipped id, synthesis runs on what did arrive.
    releaseDependencies(tasks, new Set(["skipped"]));
    assert.deepEqual(
      findReadyTasks(tasks, completed).map((t) => t.id),
      ["synth"],
    );
    assert.equal(isDeadlocked(tasks, completed), false);
  });
});
