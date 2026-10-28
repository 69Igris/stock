/**
 * Chat roast/scan/report resume reconcile - pure logic (React-free)
 *
 * Extracted from the `"use client"` `ChatContext.tsx` resume effect so the
 * block-partitioning that decides which background jobs to re-attach on chat
 * reload is unit-testable without React/Clerk/server actions. `ChatContext.tsx`
 * imports and calls `partitionResumableJobBlocks`, so production and the tests
 * run the SAME logic (no shadow).
 *
 * NOTE: the previous `chat-context-roast-reconcile.test.ts` asserted a 3-tier
 * "match roast block to a recent roast session by sessionId / mode+broker+
 * assetType / degenerate-single" design with a COMPLETED→Score transition. That
 * design is NOT in the source: the real roast reconcile simply re-attaches
 * `startRoastPoll` for `polling`/`confirmed` blocks that still carry a
 * `sessionId` (the COMPLETED→score handling lives inside the poll, not here).
 * These types/helper pin the behavior that actually ships.
 */

/** The action-block fields the reconcile reads (a minimal structural subset). */
export interface ResumableActionBlock {
  type: string;
  tool?: string;
  status?: string;
  actionId: string;
  sessionId?: string;
}

export interface ResumableMessage {
  blocks?: Array<{ type: string; [key: string]: unknown }>;
}

export interface ResumableJobs {
  /** start_roast blocks → poll on `sessionId`. */
  roastBlocks: Array<{ actionId: string; sessionId: string }>;
  /** run_strategy_scan blocks → poll on `scanId` (== sessionId). */
  scanBlocks: Array<{ actionId: string; scanId: string }>;
  /** generate_report blocks → poll on `documentId` (== sessionId). */
  reportBlocks: Array<{ actionId: string; documentId: string }>;
}

/**
 * Partition a chat's messages into the background jobs whose polling must be
 * re-attached after a reload. A block qualifies only when it is an `action`
 * block in `polling` | `confirmed` state, carries a `sessionId`, and is NOT
 * already being polled (`isPolling(actionId)` false). The block's `tool`
 * routes it to roast / scan / report.
 */
export function partitionResumableJobBlocks(
  messages: ResumableMessage[],
  isPolling: (actionId: string) => boolean
): ResumableJobs {
  const roastBlocks: ResumableJobs["roastBlocks"] = [];
  const scanBlocks: ResumableJobs["scanBlocks"] = [];
  const reportBlocks: ResumableJobs["reportBlocks"] = [];

  for (const msg of messages) {
    if (!msg.blocks) continue;
    for (const raw of msg.blocks) {
      const block = raw as unknown as ResumableActionBlock;
      if (
        block.type !== "action" ||
        !(block.status === "polling" || block.status === "confirmed") ||
        !("sessionId" in raw) ||
        !block.sessionId ||
        isPolling(block.actionId)
      ) {
        continue;
      }
      if (block.tool === "start_roast") {
        roastBlocks.push({
          actionId: block.actionId,
          sessionId: block.sessionId,
        });
      } else if (block.tool === "run_strategy_scan") {
        scanBlocks.push({
          actionId: block.actionId,
          scanId: block.sessionId,
        });
      } else if (block.tool === "generate_report") {
        reportBlocks.push({
          actionId: block.actionId,
          documentId: block.sessionId,
        });
      }
    }
  }

  return { roastBlocks, scanBlocks, reportBlocks };
}

/** True when there is at least one resumable job across roast/scan/report. */
export function hasResumableJobs(jobs: ResumableJobs): boolean {
  return (
    jobs.roastBlocks.length > 0 ||
    jobs.scanBlocks.length > 0 ||
    jobs.reportBlocks.length > 0
  );
}
