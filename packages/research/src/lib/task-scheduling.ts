/**
 * StockSage Research — Task Scheduling (pure)
 *
 * Side-effect-free dependency-resolution / topological-scheduling helpers
 * extracted out of `executor.ts` so the ordering logic can be unit-tested by
 * importing the REAL symbol (no shadow copies, no booting the tool registry /
 * Gemini / network). `ResearchExecutor.execute()` imports and calls these.
 *
 * The scheduler is intentionally a *partial* topological walk driven by
 * runtime completion: on each pass it picks every task whose dependencies are
 * already satisfied. A cycle (or a dependency on a task that can never
 * complete) simply yields no ready tasks while pending tasks remain — which
 * the executor treats as a deadlock and fails those tasks, rather than looping
 * forever.
 */

import type { ResearchTask } from "../types";

/**
 * Strip `dependsOn` references to task IDs that don't exist in `tasks`.
 * Mutates each task's `dependsOn` in place (matching the executor's behaviour)
 * and returns the same array for chaining.
 *
 * Dangling deps happen when the planner hallucinates an ID or fast-mode
 * filtering drops a task that others referenced. Left unsanitized, the
 * referencing task could never become ready (false deadlock).
 */
export function sanitizeDependencies(tasks: ResearchTask[]): ResearchTask[] {
  const ids = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    task.dependsOn = task.dependsOn.filter((dep) => ids.has(dep));
  }
  return tasks;
}

/**
 * Tasks that are ready to run right now: still `pending` and with every
 * dependency present in `completed`. Pure — reads, never mutates.
 */
export function findReadyTasks(
  tasks: ResearchTask[],
  completed: ReadonlySet<string>,
): ResearchTask[] {
  return tasks.filter(
    (t) =>
      t.status === "pending" && t.dependsOn.every((dep) => completed.has(dep)),
  );
}

/** All tasks still in `pending` status. */
export function findPendingTasks(tasks: ResearchTask[]): ResearchTask[] {
  return tasks.filter((t) => t.status === "pending");
}

/**
 * Deadlock = there is at least one pending task but none of them are ready
 * (their dependencies can never all complete — a cycle, a dep on a
 * failed/never-scheduled task, or a self-reference). When this is true the
 * executor stops and fails the remaining pending tasks.
 */
export function isDeadlocked(
  tasks: ResearchTask[],
  completed: ReadonlySet<string>,
): boolean {
  return (
    findReadyTasks(tasks, completed).length === 0 &&
    findPendingTasks(tasks).length > 0
  );
}

/**
 * Mark every still-pending task as failed with an "Unresolvable dependency"
 * error. Mutates in place (matching the executor) and returns the tasks it
 * changed, so the caller can log which IDs were dropped.
 */
export function markPendingDeadlocked(tasks: ResearchTask[]): ResearchTask[] {
  const pending = findPendingTasks(tasks);
  for (const t of pending) {
    t.status = "failed";
    t.error = "Unresolvable dependency";
  }
  return pending;
}

/**
 * MONEY-1120 - release `releasedIds` from every still-pending task's
 * `dependsOn`, returning the tasks whose dependency list actually shrank.
 *
 * Needed because `findReadyTasks` only counts a dependency as satisfied when it
 * is in `completed` — a task that was skipped or failed never is. Since the
 * planner is instructed to end with `synthesize_report` depending on ALL other
 * tasks, dropping even ONE task for time made synthesis permanently unready:
 * `isDeadlocked` fired, `markPendingDeadlocked` failed it with "Unresolvable
 * dependency", and the run fell through to the bare "partially completed"
 * fallback report. The time-saver caused the very outcome it was added to
 * avoid (MONEY-1095 items 3, 5, 11).
 *
 * Releasing the skipped ids lets synthesis run on whatever data DID arrive —
 * a shorter real report instead of no report. Mutates in place, matching the
 * other helpers here.
 */
export function releaseDependencies(
  tasks: ResearchTask[],
  releasedIds: ReadonlySet<string>,
): ResearchTask[] {
  if (releasedIds.size === 0) return [];
  const changed: ResearchTask[] = [];
  for (const task of tasks) {
    if (task.status !== "pending") continue;
    const next = task.dependsOn.filter((dep) => !releasedIds.has(dep));
    if (next.length !== task.dependsOn.length) {
      task.dependsOn = next;
      changed.push(task);
    }
  }
  return changed;
}

/** Minimum wall-clock a synthesis task is given (2 minutes). */
export const SYNTHESIS_MIN_TIMEOUT_MS = 120_000;
/** Synthesis gets this many × the base step timeout (then floored at the min). */
export const SYNTHESIS_TIMEOUT_MULTIPLIER = 4;

/**
 * Per-task execution timeout. Synthesis tasks (a Gemini call that generates a
 * whole report) get `base × 4`, floored at 2 minutes; every other task gets
 * the base step timeout unchanged.
 *
 * NOTE: the gate is the task *type* (`"synthesis"`), NOT the tool name — both
 * `synthesize_report` and `compare_stocks` are emitted as synthesis-type tasks,
 * so keying off the type covers them (and any future synthesis tool) without
 * an allowlist.
 */
export function taskTimeoutMs(
  taskType: ResearchTask["type"],
  baseTimeoutMs: number,
): number {
  return taskType === "synthesis"
    ? Math.max(
        baseTimeoutMs * SYNTHESIS_TIMEOUT_MULTIPLIER,
        SYNTHESIS_MIN_TIMEOUT_MS,
      )
    : baseTimeoutMs;
}
