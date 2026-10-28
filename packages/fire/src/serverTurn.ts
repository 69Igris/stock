import type { Content } from "@google/genai";
import { parseFireCommand } from "./parser";
import { executeFireTool } from "./toolExecutor";
import { rebalanceAssetAllocations } from "./rebalance";
import { buildFireSnapshotFromPlan } from "./serverSnapshot";
import type { ServerFireActions } from "./serverActions";
import type { FireSnapshot } from "./systemPrompt";

/* =====================================================================
   FIRE chat — SERVER-side turn engine  (StockSage integration)
   ---------------------------------------------------------------------
   The off-page twin of AskFirePanel.handleSend's multi-hop loop, run
   entirely server-side. It drives the SAME two tiers as the web Ask FIRE
   server action:

     Tier 1 — parseFireCommand resolves an unambiguous single-intent
       command to tool calls with NO model call (free), executes them
       against ServerFireActions, and stops (no confirmation hop — the
       tool summaries ARE the reply), exactly like the client's
       `source: "deterministic"` short-circuit.
     Tier 2 — everything else runs a bounded goal-seeking loop: ask the
       model (injected `generate`) for tool calls given the FRESH snapshot,
       execute them against ServerFireActions, feed the functionResponses
       back, and repeat until the model answers in plain text (or MAX_HOPS).

   `generate` is INJECTED (not a hardcoded Gemini call) so the loop is
   unit-testable with a scripted model — the same technique
   chat-e2e-protocol.test.ts uses for the client loop. The real adapter
   (Gemini function-calling) is wired by the chat tool.

   The engine mutates `actions.plan` in place and enforces the 100%
   allocation invariant post-turn (identical rebalance to bridge.ts), but
   does NOT persist — targeting + save is the caller's responsibility.
   ===================================================================== */

/** One model round-trip: given the running contents + fresh snapshot, the
    model's text and any tool calls it wants executed. */
export type FireTurnGenerate = (
  contents: Content[],
  snapshot: FireSnapshot,
) => Promise<{
  text: string | null;
  functionCalls: { id?: string; name: string; args: Record<string, unknown> }[];
}>;

export interface FireTurnResult {
  /** The model's final plain-text answer, if the turn ended in one. */
  finalText: string | null;
  /** Human-readable summary of each executed tool call (in order). */
  summaries: string[];
  /** Total tool calls executed this turn. 0 ⇒ pure-answer turn ⇒ charge. */
  toolCallCount: number;
  /** Whether the model (Tier 2) was called at all (Tier 1 is free). */
  usedLlm: boolean;
  /** Note describing a post-turn rebalance, if allocations were auto-fixed. */
  rebalanceNote: string | null;
}

const MAX_HOPS = 8;

/** Names of tool calls that change asset allocations (→ post-turn rebalance). */
const ALLOCATION_TOOLS = new Set([
  "updateAssetAllocation",
  "addAssetClass",
  "removeAssetClass",
]);

export async function runFireChatTurn(
  actions: ServerFireActions,
  savedScenarioNames: string[],
  request: string,
  generate: FireTurnGenerate,
  opts: { maxHops?: number } = {},
): Promise<FireTurnResult> {
  const maxHops = opts.maxHops ?? MAX_HOPS;
  const summaries: string[] = [];
  const touchedAssets: string[] = [];
  let allocationChanged = false;
  let toolCallCount = 0;
  let usedLlm = false;
  let finalText: string | null = null;

  // Execute one model-or-parser tool call against the plan, recording the
  // summary + tracking allocation changes for the post-turn rebalance.
  const runCall = async (call: {
    name: string;
    args: Record<string, unknown>;
  }): Promise<string> => {
    if (ALLOCATION_TOOLS.has(call.name)) {
      allocationChanged = true;
      if (typeof call.args.name === "string")
        touchedAssets.push(call.args.name);
    }
    const result = await executeFireTool(call.name, call.args, actions);
    toolCallCount++;
    const summary = result.ok ? result.message : `⚠️ ${result.error}`;
    summaries.push(summary);
    return summary;
  };

  // ── Tier 1: deterministic parser (free, no model) ───────────────────
  const snapshot0 = buildFireSnapshotFromPlan(actions.plan, savedScenarioNames);
  const parsed = parseFireCommand(request, snapshot0);
  if (parsed) {
    for (const call of parsed.functionCalls) await runCall(call);
    return {
      finalText: null,
      summaries,
      toolCallCount,
      usedLlm: false,
      rebalanceNote: applyRebalance(actions, allocationChanged, touchedAssets),
    };
  }

  // ── Tier 2: bounded goal-seeking loop (model-driven) ────────────────
  usedLlm = true;
  let contents: Content[] = [{ role: "user", parts: [{ text: request }] }];

  for (let hop = 0; hop < maxHops; hop++) {
    const snapshot = buildFireSnapshotFromPlan(
      actions.plan,
      savedScenarioNames,
    );
    const reply = await generate(contents, snapshot);

    if (reply.functionCalls.length === 0) {
      finalText = reply.text ?? null;
      break;
    }

    // Execute each call, echoing Gemini's call id so parallel calls match.
    const modelParts: Content["parts"] = [];
    const responseParts: Content["parts"] = [];
    if (reply.text) modelParts!.push({ text: reply.text });

    for (const call of reply.functionCalls) {
      const idPart = call.id ? { id: call.id } : {};
      modelParts!.push({
        functionCall: { ...idPart, name: call.name, args: call.args },
      });
      const summary = await runCall(call);
      responseParts!.push({
        functionResponse: {
          ...idPart,
          name: call.name,
          response: { result: summary },
        },
      });
    }

    contents = [
      ...contents,
      { role: "model", parts: modelParts },
      { role: "user", parts: responseParts },
    ];
  }

  return {
    finalText,
    summaries,
    toolCallCount,
    usedLlm,
    rebalanceNote: applyRebalance(actions, allocationChanged, touchedAssets),
  };
}

/**
 * Enforce the 100%-allocation invariant after a turn that changed the mix,
 * preserving the assets the model set explicitly (identical to the client's
 * post-turn rebalance). Returns a human note when rounding shifted anything.
 */
function applyRebalance(
  actions: ServerFireActions,
  allocationChanged: boolean,
  touchedAssets: string[],
): string | null {
  if (!allocationChanged) return null;
  const before = JSON.stringify(actions.plan.assetClasses);
  actions.plan.assetClasses = rebalanceAssetAllocations(
    actions.plan.assetClasses,
    touchedAssets,
  );
  if (JSON.stringify(actions.plan.assetClasses) === before) return null;
  return `Final mix (rebalanced to 100%): ${actions.plan.assetClasses
    .map((a) => `${a.name} ${a.allocation}%`)
    .join(" · ")}`;
}
