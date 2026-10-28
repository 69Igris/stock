/**
 * Ask FIRE chat — multi-hop protocol END-TO-END tests (MONEY-1049).
 *
 * Exercises the full tool-calling conversation protocol the panel speaks —
 * scripted Gemini replies driving the REAL executor + REAL bridge over a
 * live state harness — asserting the invariants the feature depends on:
 *
 *   - parallel function calls in one hop all execute, and every
 *     functionCall is answered by a functionResponse with the same
 *     name/id (Gemini rejects orphaned calls);
 *   - the snapshot sent on hop N+1 reflects hop N's mutations (the
 *     goal-seeking feedback loop — without this the model iterates
 *     against stale numbers);
 *   - a model that never stops calling tools is bounded by MAX_HOPS;
 *   - a mid-loop transport error still persists the partial conversation
 *     and still enforces the 100% allocation invariant (the error-path
 *     behaviour the pre-PR review confirmed and we fixed).
 *
 * The hop loop here mirrors AskFirePanel.handleSend's protocol contract
 * (the component itself is UI and deliberately not imported — no UI tests).
 * Sources: apps/web/app/fire/lib/chat/{toolExecutor,bridge}.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Dispatch, SetStateAction } from "react";

import { executeFireTool } from "@/app/fire/lib/chat/toolExecutor";
import {
  buildFireActions,
  buildFireSnapshot,
  rebalanceAssetAllocations,
  type FireLive,
} from "@/app/fire/lib/chat/bridge";
import type { FireSnapshot } from "@/app/fire/lib/chat/systemPrompt";
import type {
  AssetClass,
  MonthlyExpense,
  OneTimeExpense,
} from "@/app/fire/lib/types";

// ── live-state harness ──────────────────────────────────────────────

function makePage() {
  const state = {
    currentAge: 30,
    retirementAge: 50,
    lifeExpectancy: 85,
    currentCorpus: 1_800_000,
    monthlySavings: 60_000,
    withdrawalRate: 4,
    taxRate: 30,
    salaryIncrement: 10,
    savingsIncrement: 8,
    assetClasses: [
      {
        id: "1",
        name: "Equity",
        icon: "📈",
        allocation: 60,
        expectedReturn: 12,
        color: "#3b82f6",
      },
      {
        id: "2",
        name: "Cash",
        icon: "💵",
        allocation: 25,
        expectedReturn: 4,
        color: "#22c55e",
      },
      {
        id: "3",
        name: "Gold",
        icon: "🪙",
        allocation: 15,
        expectedReturn: 8,
        color: "#f59e0b",
      },
    ] as AssetClass[],
    monthlyExpenses: [
      { id: "e1", category: "Housing", amount: 25000, inflation: 5 },
    ] as MonthlyExpense[],
    oneTimeExpenses: [] as OneTimeExpense[],
  };
  const coll =
    <T>(key: "assetClasses" | "monthlyExpenses" | "oneTimeExpenses") =>
    (update: SetStateAction<T[]>) => {
      const prev = state[key] as unknown as T[];
      (state as Record<string, unknown>)[key] =
        typeof update === "function"
          ? (update as (p: T[]) => T[])(prev)
          : update;
    };
  const num =
    (key: keyof typeof state) =>
    (n: number): void => {
      (state as Record<string, unknown>)[key] = n;
    };

  const live = {
    get currentAge() {
      return state.currentAge;
    },
    get retirementAge() {
      return state.retirementAge;
    },
    get lifeExpectancy() {
      return state.lifeExpectancy;
    },
    get currentCorpus() {
      return state.currentCorpus;
    },
    get monthlySavings() {
      return state.monthlySavings;
    },
    get withdrawalRate() {
      return state.withdrawalRate;
    },
    get taxRate() {
      return state.taxRate;
    },
    get salaryIncrement() {
      return state.salaryIncrement;
    },
    get savingsIncrement() {
      return state.savingsIncrement;
    },
    get assetClasses() {
      return state.assetClasses;
    },
    get monthlyExpenses() {
      return state.monthlyExpenses;
    },
    get oneTimeExpenses() {
      return state.oneTimeExpenses;
    },
    savedScenarios: [] as { name: string }[],
    fireNumber: 0,
    yearsToFire: 12,
    corpusAtRetire: 0,
    fireAchieved: false,
    surplus: 0,
    corpusLastsTill: 85,
    sustainableMonthly: 0,
    swrFireNumber: 0,
    firstShortfallAge: null,
    setCurrentAge: num("currentAge"),
    setRetirementAge: num("retirementAge"),
    setLifeExpectancy: num("lifeExpectancy"),
    setCurrentCorpus: num("currentCorpus"),
    setMonthlySavings: num("monthlySavings"),
    setWithdrawalRate: num("withdrawalRate"),
    setTaxRate: num("taxRate"),
    setSalaryIncrement: num("salaryIncrement"),
    setSavingsIncrement: num("savingsIncrement"),
    setAssetClasses: coll<AssetClass>("assetClasses") as Dispatch<
      SetStateAction<AssetClass[]>
    >,
    setMonthlyExpenses: coll<MonthlyExpense>("monthlyExpenses") as Dispatch<
      SetStateAction<MonthlyExpense[]>
    >,
    setOneTimeExpenses: coll<OneTimeExpense>("oneTimeExpenses") as Dispatch<
      SetStateAction<OneTimeExpense[]>
    >,
    saveScenario: async () => true,
    loadScenarioByName: async () => false,
    resetAll: () => undefined,
  } as FireLive;

  return { state, live, actions: buildFireActions(() => live) };
}

// ── the protocol loop (mirrors AskFirePanel.handleSend's contract) ──

interface ScriptedCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}
interface ScriptedReply {
  text: string | null;
  functionCalls: ScriptedCall[];
}
type Part = Record<string, unknown>;
type Content = { role: "user" | "model"; parts: Part[] };

interface RunResult {
  convo: Content[];
  snapshotsSent: FireSnapshot[];
  finalText: string | null;
  caught: unknown;
  hops: number;
}

async function runProtocol(
  page: ReturnType<typeof makePage>,
  userText: string,
  model: (hop: number, snapshot: FireSnapshot) => ScriptedReply | Error
): Promise<RunResult> {
  let convo: Content[] = [{ role: "user", parts: [{ text: userText }] }];
  const snapshotsSent: FireSnapshot[] = [];
  const touchedAssets: string[] = [];
  let allocationChanged = false;
  let finalText: string | null = null;
  let caught: unknown = null;
  let hops = 0;

  try {
    const MAX_HOPS = 8;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const snapshot = buildFireSnapshot(page.live);
      snapshotsSent.push(snapshot);
      const reply = model(hop, snapshot);
      if (reply instanceof Error) throw reply;
      hops++;

      if (reply.functionCalls.length === 0) {
        convo = [
          ...convo,
          { role: "model", parts: [{ text: reply.text ?? "" }] },
        ];
        finalText = reply.text ?? null;
        break;
      }

      const modelParts: Part[] = [];
      const responseParts: Part[] = [];
      if (reply.text) modelParts.push({ text: reply.text });
      for (const call of reply.functionCalls) {
        const idPart = call.id ? { id: call.id } : {};
        modelParts.push({
          functionCall: { ...idPart, name: call.name, args: call.args },
        });
        if (
          call.name === "updateAssetAllocation" ||
          call.name === "addAssetClass"
        ) {
          allocationChanged = true;
          if (typeof call.args.name === "string")
            touchedAssets.push(call.args.name);
        } else if (call.name === "removeAssetClass") {
          allocationChanged = true;
        }
        const result = await executeFireTool(
          call.name,
          call.args,
          page.actions
        );
        responseParts.push({
          functionResponse: {
            ...idPart,
            name: call.name,
            response: result.ok
              ? { result: result.message }
              : { error: result.error },
          },
        });
      }
      convo = [
        ...convo,
        { role: "model", parts: modelParts },
        { role: "user", parts: responseParts },
      ];
    }
  } catch (err) {
    caught = err;
  }

  // Post-processing (always runs — mirrors the fixed panel behaviour).
  if (allocationChanged) {
    page.state.assetClasses = rebalanceAssetAllocations(
      page.state.assetClasses,
      touchedAssets
    );
  }
  return { convo, snapshotsSent, finalText, caught, hops };
}

/** Every model functionCall must be answered by a functionResponse with the
 *  same name (and id when present) in the immediately following user turn. */
function assertNoOrphanedCalls(convo: Content[]): void {
  for (let i = 0; i < convo.length; i++) {
    const turn = convo[i]!;
    if (turn.role !== "model") continue;
    const calls = turn.parts.filter((p) => p.functionCall);
    if (calls.length === 0) continue;
    const next = convo[i + 1];
    assert.ok(
      next && next.role === "user",
      "model tool turn must be followed by a user turn"
    );
    const responses = next.parts.filter((p) => p.functionResponse);
    assert.equal(responses.length, calls.length, "one response per call");
    for (let k = 0; k < calls.length; k++) {
      const fc = calls[k]!.functionCall as { id?: string; name: string };
      const fr = responses[k]!.functionResponse as {
        id?: string;
        name: string;
      };
      assert.equal(fr.name, fc.name);
      assert.equal(fr.id, fc.id, "functionResponse must echo the call id");
    }
  }
}

// ── tests ───────────────────────────────────────────────────────────

describe("e2e protocol — parallel batch then confirmation", () => {
  it("executes all parallel calls, pairs every response, converges state", async () => {
    const page = makePage();
    const result = await runProtocol(page, "life event", (hop) => {
      if (hop === 0) {
        return {
          text: null,
          functionCalls: [
            { id: "a", name: "setRetirementAge", args: { age: 46 } },
            { id: "b", name: "setMonthlySavings", args: { amount: 95000 } },
            {
              id: "c",
              name: "addExpense",
              args: { category: "Childcare", amount: 18000, inflation: 8 },
            },
          ],
        };
      }
      return { text: "All three changes applied.", functionCalls: [] };
    });

    assert.equal(result.caught, null);
    assert.equal(result.hops, 2);
    assert.equal(result.finalText, "All three changes applied.");
    assert.equal(page.state.retirementAge, 46);
    assert.equal(page.state.monthlySavings, 95000);
    assert.ok(
      page.state.monthlyExpenses.some((e) => e.category === "Childcare")
    );
    assertNoOrphanedCalls(result.convo);
  });
});

describe("e2e protocol — goal-seeking feedback loop", () => {
  it("hop N+1's snapshot reflects hop N's mutations", async () => {
    const page = makePage();
    const result = await runProtocol(page, "save more", (hop, snapshot) => {
      if (hop === 0) {
        assert.equal(snapshot.parameters.monthlySavings, 60000);
        return {
          text: null,
          functionCalls: [
            { name: "setMonthlySavings", args: { amount: 80000 } },
          ],
        };
      }
      if (hop === 1) {
        // THE goal-seek invariant: the model sees the fresh value.
        assert.equal(snapshot.parameters.monthlySavings, 80000);
        return {
          text: null,
          functionCalls: [
            { name: "setMonthlySavings", args: { amount: 100000 } },
          ],
        };
      }
      assert.equal(snapshot.parameters.monthlySavings, 100000);
      return { text: "Converged.", functionCalls: [] };
    });
    assert.equal(result.caught, null);
    assert.equal(page.state.monthlySavings, 100000);
    assert.equal(result.snapshotsSent.length, 3);
  });
});

describe("e2e protocol — bounds and error paths", () => {
  it("a model that never stops is cut off at MAX_HOPS (8)", async () => {
    const page = makePage();
    const result = await runProtocol(page, "loop forever", () => ({
      text: null,
      functionCalls: [{ name: "setCurrentAge", args: { age: 44 } }],
    }));
    assert.equal(result.hops, 8);
    assert.equal(result.finalText, null);
    assert.equal(result.caught, null);
    assertNoOrphanedCalls(result.convo);
  });

  it("mid-loop transport error: applied changes survive, conversation stays coherent, 100% invariant enforced", async () => {
    const page = makePage();
    const result = await runProtocol(page, "make it conservative", (hop) => {
      if (hop === 0) {
        return {
          text: null,
          functionCalls: [
            {
              id: "x",
              name: "updateAssetAllocation",
              args: { name: "Equity", allocation: 40 },
            },
          ],
        };
      }
      return new Error("network blip");
    });

    // hop 0's change is applied…
    assert.equal(
      page.state.assetClasses.find((a) => a.name === "Equity")!.allocation,
      40
    );
    // …the error is surfaced…
    assert.ok(result.caught instanceof Error);
    // …the partial conversation still pairs call ↔ response (no orphans)…
    assertNoOrphanedCalls(result.convo);
    assert.equal(result.convo.length, 3); // user + model(call) + user(response)
    // …and the allocation invariant is restored even on the error path.
    const total = page.state.assetClasses.reduce((s, a) => s + a.allocation, 0);
    assert.equal(total, 100);
  });
});
