/**
 * TaskStep default-expand semantics - B4 (MONEY-218-followup).
 *
 * Pre-fix: showData defaulted to `false` in TaskStep, so even when
 * task.resultSummary was populated (Earnings, Cash Flow, etc.) the
 * card looked empty until the user clicked the chevron.
 *
 * Fix:
 *   1. showData initial = `hasData` (true when status=completed and
 *      resultSummary != null)
 *   2. useEffect flips showData → true the first time hasData
 *      transitions to true (covers the running → completed mid-render
 *      case)
 *   3. Manual collapse still wins - userTouched ref prevents the
 *      effect from re-opening after a user clicks closed
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface FakeTask {
  status: "pending" | "running" | "completed" | "failed";
  resultSummary?: unknown;
}

/**
 * Mirrors the post-fix TaskStep state machine:
 *   - hasData = (status === completed && resultSummary != null)
 *   - showData initial = hasData
 *   - effect: when hasData flips true, set showData=true (unless user
 *     has manually toggled)
 *   - handleToggle: marks userTouched + flips showData
 */
class TaskStepStateMachine {
  showData: boolean;
  userTouched = false;

  constructor(initialTask: FakeTask) {
    this.showData =
      initialTask.status === "completed" && initialTask.resultSummary != null;
  }

  // Mirrors the useEffect on [hasData]
  onTaskUpdate(task: FakeTask): void {
    const hasData = task.status === "completed" && task.resultSummary != null;
    if (hasData && !this.userTouched) {
      this.showData = true;
    }
  }

  handleToggle(task: FakeTask): void {
    const hasData = task.status === "completed" && task.resultSummary != null;
    if (!hasData) return;
    this.userTouched = true;
    this.showData = !this.showData;
  }
}

describe("TaskStep default-expand - B4", () => {
  it("completed task with data: showData starts TRUE", () => {
    const sm = new TaskStepStateMachine({
      status: "completed",
      resultSummary: { revenue: 100 },
    });
    assert.equal(sm.showData, true);
  });

  it("pending task: showData starts FALSE (no data yet)", () => {
    const sm = new TaskStepStateMachine({ status: "pending" });
    assert.equal(sm.showData, false);
  });

  it("running task: showData starts FALSE", () => {
    const sm = new TaskStepStateMachine({ status: "running" });
    assert.equal(sm.showData, false);
  });

  it("completed task with NULL resultSummary: showData starts FALSE", () => {
    const sm = new TaskStepStateMachine({
      status: "completed",
      resultSummary: null,
    });
    assert.equal(sm.showData, false);
  });

  it("running → completed transition: effect flips showData true", () => {
    const sm = new TaskStepStateMachine({ status: "running" });
    assert.equal(sm.showData, false);
    sm.onTaskUpdate({ status: "completed", resultSummary: { eps: 5 } });
    assert.equal(sm.showData, true);
  });

  it("user collapses → state stays collapsed even after re-render", () => {
    const task: FakeTask = {
      status: "completed",
      resultSummary: { revenue: 100 },
    };
    const sm = new TaskStepStateMachine(task);
    assert.equal(sm.showData, true);
    sm.handleToggle(task); // user clicks → collapses
    assert.equal(sm.showData, false);
    sm.onTaskUpdate(task); // re-render
    assert.equal(sm.showData, false, "manual collapse should stick");
  });

  it("user re-expands after collapse → effect doesn't fight the user", () => {
    const task: FakeTask = {
      status: "completed",
      resultSummary: { revenue: 100 },
    };
    const sm = new TaskStepStateMachine(task);
    sm.handleToggle(task); // collapse
    sm.handleToggle(task); // re-expand
    assert.equal(sm.showData, true);
    sm.onTaskUpdate(task);
    assert.equal(sm.showData, true);
  });

  it("failed task: showData stays FALSE (no data to show)", () => {
    const sm = new TaskStepStateMachine({ status: "failed" });
    assert.equal(sm.showData, false);
  });

  it("toggle on a no-data task is a no-op (handleToggle early returns)", () => {
    const task: FakeTask = { status: "pending" };
    const sm = new TaskStepStateMachine(task);
    sm.handleToggle(task);
    assert.equal(sm.showData, false);
    assert.equal(
      sm.userTouched,
      false,
      "userTouched not set when toggle is no-op"
    );
  });
});
