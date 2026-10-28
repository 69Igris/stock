/**
 * ChatContext resume reconcile - block partitioning (REAL-CONTRACT tests)
 *
 * De-shadowed (MONEY-620). This file previously inlined ~280 lines mirroring a
 * roast reconcile that matched each roast block to a "recent roast session" via
 * a 3-tier key (sessionId → mode+broker+assetType triple → degenerate single)
 * and applied a COMPLETED→`Score N/100` + follow-up transition. **That design is
 * not in the source.** There is no `getRecentRoastSessions` action, no
 * `RecentRoastSession`, and no params-triple matching anywhere in the codebase —
 * the shadow asserted a reconcile that was never shipped (or was removed), and
 * stayed green doing it.
 *
 * The roast reconcile that ACTUALLY ships (ChatContext.tsx resume effect) simply
 * re-attaches `startRoastPoll` / `startScanPoll` / `startReportPoll` for
 * `polling`/`confirmed` action blocks that still carry a `sessionId` and aren't
 * already being polled (the COMPLETED→score handling lives inside the poll
 * itself). That partitioning is now the exported, wired
 * `partitionResumableJobBlocks` — these tests assert it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  partitionResumableJobBlocks,
  hasResumableJobs,
  type ResumableMessage,
} from "@/lib/chat/roast-reconcile-logic";

const NEVER_POLLING = () => false;

function msg(
  blocks: Array<{ type: string; [k: string]: unknown }>
): ResumableMessage {
  return { blocks };
}

function actionBlock(overrides: Record<string, unknown> = {}): {
  type: string;
  [k: string]: unknown;
} {
  return {
    type: "action",
    tool: "start_roast",
    status: "polling",
    actionId: "act-1",
    sessionId: "sess-1",
    ...overrides,
  };
}

describe("ChatContext resume reconcile - partitionResumableJobBlocks", () => {
  describe("tool routing", () => {
    it("routes start_roast → roastBlocks (actionId + sessionId)", () => {
      const jobs = partitionResumableJobBlocks(
        [msg([actionBlock({ actionId: "r1", sessionId: "s-roast" })])],
        NEVER_POLLING
      );
      assert.deepStrictEqual(jobs.roastBlocks, [
        { actionId: "r1", sessionId: "s-roast" },
      ]);
      assert.strictEqual(jobs.scanBlocks.length, 0);
      assert.strictEqual(jobs.reportBlocks.length, 0);
    });

    it("routes run_strategy_scan → scanBlocks (scanId == sessionId)", () => {
      const jobs = partitionResumableJobBlocks(
        [
          msg([
            actionBlock({
              tool: "run_strategy_scan",
              actionId: "sc1",
              sessionId: "s-scan",
            }),
          ]),
        ],
        NEVER_POLLING
      );
      assert.deepStrictEqual(jobs.scanBlocks, [
        { actionId: "sc1", scanId: "s-scan" },
      ]);
    });

    it("routes generate_report → reportBlocks (documentId == sessionId)", () => {
      const jobs = partitionResumableJobBlocks(
        [
          msg([
            actionBlock({
              tool: "generate_report",
              actionId: "rp1",
              sessionId: "s-doc",
            }),
          ]),
        ],
        NEVER_POLLING
      );
      assert.deepStrictEqual(jobs.reportBlocks, [
        { actionId: "rp1", documentId: "s-doc" },
      ]);
    });

    it("ignores action blocks with an unrecognised tool", () => {
      const jobs = partitionResumableJobBlocks(
        [msg([actionBlock({ tool: "run_research", actionId: "x" })])],
        NEVER_POLLING
      );
      assert.ok(!hasResumableJobs(jobs));
    });
  });

  describe("status / sessionId gates", () => {
    it("collects polling AND confirmed blocks", () => {
      const jobs = partitionResumableJobBlocks(
        [
          msg([
            actionBlock({ actionId: "a", status: "polling" }),
            actionBlock({ actionId: "b", status: "confirmed" }),
          ]),
        ],
        NEVER_POLLING
      );
      assert.strictEqual(jobs.roastBlocks.length, 2);
    });

    it("SKIPS pending / executed / failed / cancelled blocks", () => {
      for (const status of ["pending", "executed", "failed", "cancelled"]) {
        const jobs = partitionResumableJobBlocks(
          [msg([actionBlock({ status })])],
          NEVER_POLLING
        );
        assert.strictEqual(
          jobs.roastBlocks.length,
          0,
          `${status} must not be resumed`
        );
      }
    });

    it("SKIPS blocks with no sessionId (can't resume a poll)", () => {
      const jobs = partitionResumableJobBlocks(
        [
          msg([
            {
              type: "action",
              tool: "start_roast",
              status: "polling",
              actionId: "a",
            },
          ]),
        ],
        NEVER_POLLING
      );
      assert.strictEqual(jobs.roastBlocks.length, 0);
    });

    it("SKIPS blocks already being polled (idempotent re-attach)", () => {
      const jobs = partitionResumableJobBlocks(
        [
          msg([
            actionBlock({ actionId: "live", sessionId: "s1" }),
            actionBlock({ actionId: "gone", sessionId: "s2" }),
          ]),
        ],
        (actionId) => actionId === "live"
      );
      assert.deepStrictEqual(jobs.roastBlocks, [
        { actionId: "gone", sessionId: "s2" },
      ]);
    });

    it("ignores non-action (text/other) blocks", () => {
      const jobs = partitionResumableJobBlocks(
        [
          msg([
            { type: "text", content: "hi" },
            actionBlock({ actionId: "r" }),
          ]),
        ],
        NEVER_POLLING
      );
      assert.strictEqual(jobs.roastBlocks.length, 1);
    });

    it("tolerates messages with no blocks", () => {
      const jobs = partitionResumableJobBlocks(
        [{}, msg([actionBlock()])],
        NEVER_POLLING
      );
      assert.strictEqual(jobs.roastBlocks.length, 1);
    });
  });

  describe("hasResumableJobs", () => {
    it("is false for an empty chat", () => {
      assert.strictEqual(
        hasResumableJobs(partitionResumableJobBlocks([], NEVER_POLLING)),
        false
      );
    });

    it("is true when any job type is present", () => {
      const jobs = partitionResumableJobBlocks(
        [
          msg([
            actionBlock({
              tool: "generate_report",
              actionId: "rp",
              sessionId: "d",
            }),
          ]),
        ],
        NEVER_POLLING
      );
      assert.strictEqual(hasResumableJobs(jobs), true);
    });

    it("aggregates roast + scan + report across messages", () => {
      const jobs = partitionResumableJobBlocks(
        [
          msg([actionBlock({ actionId: "r", sessionId: "s-roast" })]),
          msg([
            actionBlock({
              tool: "run_strategy_scan",
              actionId: "sc",
              sessionId: "s-scan",
            }),
          ]),
          msg([
            actionBlock({
              tool: "generate_report",
              actionId: "rp",
              sessionId: "s-doc",
            }),
          ]),
        ],
        NEVER_POLLING
      );
      assert.strictEqual(jobs.roastBlocks.length, 1);
      assert.strictEqual(jobs.scanBlocks.length, 1);
      assert.strictEqual(jobs.reportBlocks.length, 1);
      assert.ok(hasResumableJobs(jobs));
    });
  });
});
