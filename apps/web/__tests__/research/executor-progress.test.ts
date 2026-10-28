/**
 * Research Executor — dependency resolution, deadlock detection, ready-task
 * selection and synthesis timeout.
 *
 * De-shadowed (MONEY-620): this file used to re-implement `sanitizeDependencies`,
 * `getReadyTasks`, `detectDeadlock` and a tool-name-keyed `getTaskTimeout`
 * inline. It now imports the REAL exports from
 * `packages/research/src/lib/task-scheduling.ts` — the same module
 * `ResearchExecutor.execute()` imports.
 *
 * Two real-vs-shadow corrections fell out of the swap:
 *   1. The real `findReadyTasks` returns EVERY ready task; it does NOT slice to
 *      `maxConcurrency` (the executor applies the concurrency cap separately,
 *      and on the running-count, not on the ready list). The old shadow folded
 *      a `.slice(0, available)` in — encoding behaviour the real function never
 *      had. The concurrency-slice assertions were dropped.
 *   2. The real synthesis-timeout gate keys off the task TYPE (`"synthesis"`),
 *      not the tool name. The old shadow keyed off `tool === "synthesize_report"
 *      || "compare_stocks"`. `taskTimeoutMs(type, base)` is asserted instead.
 *
 * The 2s progress throttle and the per-task status-transition timestamps live
 * inside the async `execute()` loop (no pure exported counterpart); those
 * reimplementation-only suites were dropped rather than kept as shadows.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeDependencies,
  findReadyTasks,
  findPendingTasks,
  isDeadlocked,
  markPendingDeadlocked,
  taskTimeoutMs,
  SYNTHESIS_MIN_TIMEOUT_MS,
  SYNTHESIS_TIMEOUT_MULTIPLIER,
} from "@usemoney/research/lib/task-scheduling";
import type { ResearchTask } from "@usemoney/research/types";

function makeTask(overrides: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    type: "data_fetch",
    tool: "fetch_stock_price",
    params: {},
    dependsOn: [],
    status: "pending",
    ...overrides,
  };
}

describe("Research Executor — task scheduling (real source)", () => {
  // ── Dependency sanitization ───────────────────────────────────────────

  describe("sanitizeDependencies", () => {
    it("removes a reference to a non-existent task ID", () => {
      const tasks = [makeTask({ id: "t1", dependsOn: ["ghost-task"] })];
      sanitizeDependencies(tasks);
      assert.deepStrictEqual(tasks[0]!.dependsOn, []);
    });

    it("keeps valid references intact", () => {
      const tasks = [
        makeTask({ id: "t1", dependsOn: [] }),
        makeTask({ id: "t2", dependsOn: ["t1"] }),
      ];
      sanitizeDependencies(tasks);
      assert.deepStrictEqual(tasks[1]!.dependsOn, ["t1"]);
    });

    it("mixed valid and invalid deps: keeps only valid ones (preserving dupes)", () => {
      const tasks = [
        makeTask({ id: "t1", dependsOn: [] }),
        makeTask({ id: "t2", dependsOn: ["t1", "phantom", "t1"] }),
      ];
      sanitizeDependencies(tasks);
      assert.deepStrictEqual(tasks[1]!.dependsOn, ["t1", "t1"]);
    });

    it("all deps invalid → empty dependsOn", () => {
      const tasks = [makeTask({ id: "t1", dependsOn: ["x", "y", "z"] })];
      sanitizeDependencies(tasks);
      assert.deepStrictEqual(tasks[0]!.dependsOn, []);
    });

    it("a self-reference is a valid ID and is NOT removed", () => {
      const tasks = [makeTask({ id: "t1", dependsOn: ["t1"] })];
      sanitizeDependencies(tasks);
      assert.deepStrictEqual(tasks[0]!.dependsOn, ["t1"]);
    });

    it("mutates in place and returns the same array", () => {
      const tasks = [makeTask({ id: "t1", dependsOn: ["ghost"] })];
      const ref = tasks[0];
      const returned = sanitizeDependencies(tasks);
      assert.strictEqual(returned, tasks);
      assert.strictEqual(tasks[0], ref);
      assert.deepStrictEqual(tasks[0]!.dependsOn, []);
    });

    it("planner-generated numeric-string IDs are stripped", () => {
      const tasks = [
        makeTask({ id: "task-abc", dependsOn: [] }),
        makeTask({ id: "task-def", dependsOn: ["task-abc", "123", "999"] }),
      ];
      sanitizeDependencies(tasks);
      assert.deepStrictEqual(tasks[1]!.dependsOn, ["task-abc"]);
    });

    it("empty task list: no-op", () => {
      const tasks: ResearchTask[] = [];
      sanitizeDependencies(tasks);
      assert.strictEqual(tasks.length, 0);
    });
  });

  // ── Ready task selection (findReadyTasks — NO concurrency slice) ───────

  describe("findReadyTasks", () => {
    const completedOf = (tasks: ResearchTask[]) =>
      new Set(
        tasks
          .filter((t) => t.status === "completed" || t.status === "failed")
          .map((t) => t.id)
      );

    it("returns EVERY pending task whose deps are all satisfied (no concurrency cap)", () => {
      const tasks = [
        makeTask({ id: "t1", status: "pending", dependsOn: [] }),
        makeTask({ id: "t2", status: "pending", dependsOn: [] }),
        makeTask({ id: "t3", status: "pending", dependsOn: [] }),
        makeTask({ id: "t4", status: "pending", dependsOn: [] }),
      ];
      const ready = findReadyTasks(tasks, completedOf(tasks));
      // Real function does NOT slice to a maxConcurrency — all 4 are ready.
      assert.strictEqual(ready.length, 4);
    });

    it("tasks with unmet deps are not selected", () => {
      const tasks = [
        makeTask({ id: "t1", status: "pending", dependsOn: [] }),
        makeTask({ id: "t2", status: "pending", dependsOn: ["t1"] }),
      ];
      const ready = findReadyTasks(tasks, completedOf(tasks));
      assert.strictEqual(ready.length, 1);
      assert.strictEqual(ready[0]!.id, "t1");
    });

    it("all deps completed → task becomes ready", () => {
      const tasks = [
        makeTask({ id: "t1", status: "completed", dependsOn: [] }),
        makeTask({ id: "t2", status: "completed", dependsOn: [] }),
        makeTask({ id: "t3", status: "pending", dependsOn: ["t1", "t2"] }),
      ];
      const ready = findReadyTasks(tasks, completedOf(tasks));
      assert.strictEqual(ready.length, 1);
      assert.strictEqual(ready[0]!.id, "t3");
    });

    it("failed tasks count as 'done' for dependency resolution", () => {
      const tasks = [
        makeTask({ id: "t1", status: "failed", dependsOn: [] }),
        makeTask({ id: "t2", status: "pending", dependsOn: ["t1"] }),
      ];
      const ready = findReadyTasks(tasks, completedOf(tasks));
      assert.strictEqual(ready.length, 1);
      assert.strictEqual(ready[0]!.id, "t2");
    });

    it("no pending tasks → empty array", () => {
      const tasks = [
        makeTask({ id: "t1", status: "completed", dependsOn: [] }),
        makeTask({ id: "t2", status: "running", dependsOn: [] }),
      ];
      assert.strictEqual(findReadyTasks(tasks, completedOf(tasks)).length, 0);
    });

    it("preserves array order", () => {
      const tasks = [
        makeTask({ id: "first", status: "pending", dependsOn: [] }),
        makeTask({ id: "second", status: "pending", dependsOn: [] }),
        makeTask({ id: "third", status: "pending", dependsOn: [] }),
      ];
      const ready = findReadyTasks(tasks, completedOf(tasks));
      assert.deepStrictEqual(
        ready.map((t) => t.id),
        ["first", "second", "third"]
      );
    });

    it("multi-level chain: only the head task is ready initially", () => {
      const tasks = [
        makeTask({ id: "t1", status: "pending", dependsOn: [] }),
        makeTask({ id: "t2", status: "pending", dependsOn: ["t1"] }),
        makeTask({ id: "t3", status: "pending", dependsOn: ["t2"] }),
      ];
      const ready = findReadyTasks(tasks, completedOf(tasks));
      assert.strictEqual(ready.length, 1);
      assert.strictEqual(ready[0]!.id, "t1");
    });
  });

  // ── findPendingTasks ──────────────────────────────────────────────────

  describe("findPendingTasks", () => {
    it("returns only pending-status tasks", () => {
      const tasks = [
        makeTask({ id: "t1", status: "pending" }),
        makeTask({ id: "t2", status: "running" }),
        makeTask({ id: "t3", status: "completed" }),
        makeTask({ id: "t4", status: "pending" }),
      ];
      const pending = findPendingTasks(tasks);
      assert.deepStrictEqual(
        pending.map((t) => t.id),
        ["t1", "t4"]
      );
    });
  });

  // ── Deadlock detection (isDeadlocked) ─────────────────────────────────

  describe("isDeadlocked", () => {
    const completedOf = (tasks: ResearchTask[]) =>
      new Set(
        tasks
          .filter((t) => t.status === "completed" || t.status === "failed")
          .map((t) => t.id)
      );

    it("two pending tasks depending on each other → deadlock", () => {
      const tasks = [
        makeTask({ id: "t1", status: "pending", dependsOn: ["t2"] }),
        makeTask({ id: "t2", status: "pending", dependsOn: ["t1"] }),
      ];
      assert.strictEqual(isDeadlocked(tasks, completedOf(tasks)), true);
    });

    it("one pending task with all deps completed → no deadlock", () => {
      const tasks = [
        makeTask({ id: "t1", status: "completed", dependsOn: [] }),
        makeTask({ id: "t2", status: "pending", dependsOn: ["t1"] }),
      ];
      assert.strictEqual(isDeadlocked(tasks, completedOf(tasks)), false);
    });

    it("all tasks completed → no deadlock", () => {
      const tasks = [
        makeTask({ id: "t1", status: "completed", dependsOn: [] }),
        makeTask({ id: "t2", status: "completed", dependsOn: ["t1"] }),
      ];
      assert.strictEqual(isDeadlocked(tasks, completedOf(tasks)), false);
    });

    it("no tasks at all → no deadlock", () => {
      assert.strictEqual(isDeadlocked([], new Set<string>()), false);
    });

    it("all tasks running → no deadlock (no pending tasks)", () => {
      const tasks = [
        makeTask({ id: "t1", status: "running", dependsOn: [] }),
        makeTask({ id: "t2", status: "running", dependsOn: ["t1"] }),
      ];
      assert.strictEqual(isDeadlocked(tasks, completedOf(tasks)), false);
    });

    it("a pending dep on a still-running task → deadlock (running ∉ completed)", () => {
      const tasks = [
        makeTask({ id: "t1", status: "running", dependsOn: [] }),
        makeTask({ id: "t2", status: "pending", dependsOn: ["t1"] }),
      ];
      // t1 running (not completed/failed) → t2 not ready while pending → deadlock.
      assert.strictEqual(isDeadlocked(tasks, completedOf(tasks)), true);
    });

    it("3-way dependency cycle → deadlock", () => {
      const tasks = [
        makeTask({ id: "t1", status: "pending", dependsOn: ["t3"] }),
        makeTask({ id: "t2", status: "pending", dependsOn: ["t1"] }),
        makeTask({ id: "t3", status: "pending", dependsOn: ["t2"] }),
      ];
      assert.strictEqual(isDeadlocked(tasks, completedOf(tasks)), true);
    });

    it("failed deps unblock a pending task → no deadlock", () => {
      const tasks = [
        makeTask({ id: "t1", status: "failed", dependsOn: [] }),
        makeTask({ id: "t2", status: "pending", dependsOn: ["t1"] }),
      ];
      assert.strictEqual(isDeadlocked(tasks, completedOf(tasks)), false);
    });

    it("sanitize → deadlock pipeline: a stripped ghost dep makes the task ready", () => {
      const tasks = [
        makeTask({ id: "t1", status: "pending", dependsOn: ["nonexistent"] }),
      ];
      sanitizeDependencies(tasks);
      assert.strictEqual(isDeadlocked(tasks, new Set<string>()), false);
      assert.strictEqual(findReadyTasks(tasks, new Set<string>()).length, 1);
    });
  });

  // ── markPendingDeadlocked ─────────────────────────────────────────────

  describe("markPendingDeadlocked", () => {
    it("fails every pending task with the unresolvable-dependency error", () => {
      const tasks = [
        makeTask({ id: "t1", status: "completed" }),
        makeTask({ id: "t2", status: "pending", dependsOn: ["ghost"] }),
        makeTask({ id: "t3", status: "pending", dependsOn: ["ghost"] }),
      ];
      const changed = markPendingDeadlocked(tasks);
      assert.strictEqual(changed.length, 2);
      assert.strictEqual(tasks[1]!.status, "failed");
      assert.strictEqual(tasks[1]!.error, "Unresolvable dependency");
      assert.strictEqual(tasks[2]!.status, "failed");
      // Already-completed task is untouched.
      assert.strictEqual(tasks[0]!.status, "completed");
    });
  });

  // ── Synthesis timeout (taskTimeoutMs — gated on TYPE, not tool name) ───

  describe("taskTimeoutMs", () => {
    it("synthesis task: base=30s → 4× = 120s (meets the 2-min minimum)", () => {
      assert.strictEqual(taskTimeoutMs("synthesis", 30_000), 120_000);
    });

    it("synthesis task: base=60s → 4× = 240s (exceeds the minimum)", () => {
      assert.strictEqual(taskTimeoutMs("synthesis", 60_000), 240_000);
    });

    it("synthesis task: base=10s → 4× = 40s, floored at 120s", () => {
      assert.strictEqual(taskTimeoutMs("synthesis", 10_000), 120_000);
    });

    it("synthesis task: base=0 → floored at 120s", () => {
      assert.strictEqual(taskTimeoutMs("synthesis", 0), 120_000);
    });

    it("data_fetch task: base passes through unchanged", () => {
      assert.strictEqual(taskTimeoutMs("data_fetch", 30_000), 30_000);
    });

    it("computation task: base passes through unchanged (no multiplier)", () => {
      assert.strictEqual(taskTimeoutMs("computation", 120_000), 120_000);
    });

    it("analysis task: base passes through unchanged", () => {
      assert.strictEqual(taskTimeoutMs("analysis", 45_000), 45_000);
    });

    it("non-synthesis base=0 → 0 (no minimum applied)", () => {
      assert.strictEqual(taskTimeoutMs("data_fetch", 0), 0);
    });

    it("constants: multiplier=4, min=120_000ms", () => {
      assert.strictEqual(SYNTHESIS_TIMEOUT_MULTIPLIER, 4);
      assert.strictEqual(SYNTHESIS_MIN_TIMEOUT_MS, 120_000);
    });
  });

  // ── Integration: sanitize → deadlock-check → ready-tasks ──────────────

  describe("scheduling pipeline", () => {
    it("3-task sequential chain advances head → middle → tail as each completes", () => {
      const tasks: ResearchTask[] = [
        makeTask({ id: "fetch", status: "pending", dependsOn: [] }),
        makeTask({ id: "compute", status: "pending", dependsOn: ["fetch"] }),
        makeTask({
          id: "synthesize",
          status: "pending",
          dependsOn: ["compute"],
        }),
      ];
      const completed = new Set<string>();

      let ready = findReadyTasks(tasks, completed);
      assert.deepStrictEqual(
        ready.map((t) => t.id),
        ["fetch"]
      );

      tasks[0]!.status = "completed";
      completed.add("fetch");
      ready = findReadyTasks(tasks, completed);
      assert.deepStrictEqual(
        ready.map((t) => t.id),
        ["compute"]
      );

      tasks[1]!.status = "completed";
      completed.add("compute");
      ready = findReadyTasks(tasks, completed);
      assert.deepStrictEqual(
        ready.map((t) => t.id),
        ["synthesize"]
      );
    });

    it("parallel fetch tasks all become ready at once", () => {
      const tasks: ResearchTask[] = [
        makeTask({ id: "fetch1", status: "pending", dependsOn: [] }),
        makeTask({ id: "fetch2", status: "pending", dependsOn: [] }),
        makeTask({ id: "fetch3", status: "pending", dependsOn: [] }),
        makeTask({
          id: "synthesize",
          status: "pending",
          dependsOn: ["fetch1", "fetch2", "fetch3"],
        }),
      ];
      const ready = findReadyTasks(tasks, new Set<string>());
      assert.strictEqual(ready.length, 3);
      assert.deepStrictEqual(ready.map((t) => t.id).sort(), [
        "fetch1",
        "fetch2",
        "fetch3",
      ]);
    });
  });
});
