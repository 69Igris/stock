/**
 * Ask FIRE — SERVER-side turn engine tests (StockSage integration).
 *
 * runFireChatTurn is the off-page twin of AskFirePanel's multi-hop loop. The
 * model call is INJECTED, so a scripted model drives the loop deterministically
 * (same technique as chat-e2e-protocol.test.ts). Locks the invariants the
 * off-page "supreme god" path depends on:
 *   - Tier 1 (parser) executes free with NO model call;
 *   - Tier 2 goal-seeking reads a FRESH snapshot each hop (hop N+1 sees hop N's
 *     mutation — without this the model iterates against stale numbers);
 *   - a pure-answer turn reports toolCallCount 0 (→ the caller charges);
 *   - the 100% allocation invariant is enforced post-turn;
 *   - a never-stopping model is bounded by maxHops.
 *
 * Source: apps/web/app/fire/lib/chat/serverTurn.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runFireChatTurn,
  type FireTurnGenerate,
} from "@/app/fire/lib/chat/serverTurn";
import {
  ServerFireActions,
  defaultServerFirePlan,
} from "@/app/fire/lib/chat/serverActions";
import type { FireSnapshot } from "@/app/fire/lib/chat/systemPrompt";

/** A scripted model: returns queued replies in order; records the snapshots it saw. */
function scriptedModel(replies: Awaited<ReturnType<FireTurnGenerate>>[]): {
  generate: FireTurnGenerate;
  snapshots: FireSnapshot[];
  calls: () => number;
} {
  const snapshots: FireSnapshot[] = [];
  let i = 0;
  const generate: FireTurnGenerate = async (_contents, snapshot) => {
    snapshots.push(snapshot);
    return replies[Math.min(i++, replies.length - 1)]!;
  };
  return { generate, snapshots, calls: () => i };
}

describe("runFireChatTurn — Tier 1 (deterministic parser)", () => {
  it("handles a single-intent command with NO model call", async () => {
    const a = new ServerFireActions(defaultServerFirePlan());
    const m = scriptedModel([{ text: null, functionCalls: [] }]);
    const r = await runFireChatTurn(
      a,
      [],
      "set retirement age to 45",
      m.generate
    );
    assert.equal(m.calls(), 0, "model must not be called for a parser hit");
    assert.equal(a.plan.retirementAge, 45);
    assert.equal(r.usedLlm, false);
    assert.equal(r.toolCallCount, 1);
    assert.equal(r.finalText, null);
  });
});

describe("runFireChatTurn — Tier 2 (goal-seeking loop)", () => {
  it("executes model tool calls then reads a fresh snapshot on the next hop", async () => {
    const a = new ServerFireActions(defaultServerFirePlan());
    const m = scriptedModel([
      {
        text: "Raising your SIP.",
        functionCalls: [
          { name: "setMonthlySavings", args: { amount: 200_000 } },
        ],
      },
      { text: "Done — you'll reach FIRE sooner.", functionCalls: [] },
    ]);
    const r = await runFireChatTurn(
      a,
      [],
      "how much should I save to retire by 45?", // question → parser bails → Tier 2
      m.generate
    );
    assert.equal(a.plan.monthlySavings, 200_000);
    assert.equal(r.finalText, "Done — you'll reach FIRE sooner.");
    assert.equal(r.usedLlm, true);
    assert.equal(r.toolCallCount, 1);
    // snapshot freshness: the SECOND hop's snapshot reflects the first hop's edit.
    assert.equal(m.snapshots[1]?.parameters.monthlySavings, 200_000);
  });

  it("a pure-answer turn reports toolCallCount 0 (→ caller charges)", async () => {
    const a = new ServerFireActions(defaultServerFirePlan());
    const m = scriptedModel([
      { text: "You're on track to retire at 50.", functionCalls: [] },
    ]);
    const r = await runFireChatTurn(a, [], "am I on track?", m.generate);
    assert.equal(r.toolCallCount, 0);
    assert.equal(r.usedLlm, true);
    assert.equal(r.finalText, "You're on track to retire at 50.");
  });

  it("enforces the 100% allocation invariant after the turn", async () => {
    const a = new ServerFireActions(defaultServerFirePlan());
    const m = scriptedModel([
      {
        text: "",
        functionCalls: [
          {
            name: "updateAssetAllocation",
            args: { name: "Equity", allocation: 80 },
          },
        ],
      },
      { text: "Raised equity to 80%.", functionCalls: [] },
    ]);
    const r = await runFireChatTurn(
      a,
      [],
      "put 80% in equity and explain the risk", // compound → Tier 2
      m.generate
    );
    const total = a.plan.assetClasses.reduce((s, x) => s + x.allocation, 0);
    assert.equal(total, 100, "allocations must be rebalanced to exactly 100%");
    assert.equal(
      a.plan.assetClasses.find((x) => x.name === "Equity")?.allocation,
      80,
      "the explicitly-set asset is preserved"
    );
    assert.ok(r.rebalanceNote, "a rebalance note is surfaced");
  });

  it("bounds a never-stopping model by maxHops", async () => {
    const a = new ServerFireActions(defaultServerFirePlan());
    const m = scriptedModel([
      {
        text: "",
        functionCalls: [
          { name: "setMonthlySavings", args: { amount: 70_000 } },
        ],
      },
    ]);
    const r = await runFireChatTurn(
      a,
      [],
      "keep tweaking my plan forever please", // fuzzy → Tier 2
      m.generate,
      { maxHops: 3 }
    );
    assert.equal(r.toolCallCount, 3, "loop is bounded");
    assert.equal(r.finalText, null, "never reached a plain-text answer");
  });
});
