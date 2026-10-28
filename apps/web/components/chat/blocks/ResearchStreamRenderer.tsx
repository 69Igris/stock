"use client";

import type { ResearchStreamBlock } from "@usemoney/types";
import {
  ResearchRunBlock,
  type ResearchRunData,
} from "@/components/stocksage/ResearchRunBlock";
import { modeBadge } from "@/components/stocksage/research-run";

interface ResearchStreamRendererProps {
  block: ResearchStreamBlock;
}

/**
 * Research-stream renderer (MONEY-490 / MONEY-672, P2b).
 *
 * Maps the live `ResearchStreamBlock` into the StockSage v2 `JobProgress` design
 * (apps/web/components/stocksage). This is the SINGLE seam: both the in-bubble
 * path (MessageRenderer) and the standalone "research-stream-only" pill path
 * (ChatMessage) route through here, so running / completed / failed all get the
 * new design — including the empty-but-green, peer-fetch and accordion fixes
 * that live in the design components.
 */
export default function ResearchStreamRenderer({
  block,
}: ResearchStreamRendererProps) {
  const data: ResearchRunData = {
    status: block.status,
    progress: block.status === "completed" ? 100 : block.progress,
    currentStep:
      block.status === "completed"
        ? "Completed"
        : block.status === "failed"
          ? "A step didn't complete"
          : block.currentStep,
    tasks: (block.taskProgress ?? []).map((t) => ({
      id: t.id,
      tool: t.tool,
      type: t.type,
      status: t.status,
      durationMs: t.durationMs,
      resultSummary: t.resultSummary,
    })),
    // Show the REAL selected research mode/depth (MONEY-669): threaded onto the
    // block at creation from the confirm action's params.mode.
    //
    // MONEY-1274 (MONEY-1155 #28) — when `mode` is ABSENT this used to fall
    // back to `deep: true` + "Comprehensive", inventing BOTH halves. `mode`
    // lives only in client state: `ResearchSession` persists `skill` and no
    // mode/depth column, so every block rebuilt from the DB — i.e. after any
    // reload or back-navigation — lost it. An Advanced run then read
    // "DEEP · Comprehensive", which is the reported bug, and a FAST run read
    // "DEEP", which is worse: the fabricated default contradicts the run.
    //
    // Undefined now means undefined. The pill renders only what is known.
    ...modeBadge(block.mode),
  };

  return (
    <div style={{ padding: "4px 0", width: "100%" }}>
      <ResearchRunBlock data={data} />
    </div>
  );
}
