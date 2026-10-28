/**
 * `fire_plan` chat tool  (StockSage ↔ FIRE integration)
 *
 * The "supreme god" case: lets the main StockSage chat EDIT a saved FIRE plan
 * or ANSWER a FIRE question from ANY page (e.g. the dashboard), where there is
 * no live /fire React state. It runs the SAME two-tier FIRE turn the /fire page
 * runs — deterministic parser first (free), else Gemini function-calling — but
 * server-side against a working copy of a saved scenario (ServerFireActions),
 * persisting once per turn.
 *
 * Targeting (which plan) and the no-plan case follow the agreed product rules
 * (scenarioTarget.ts): a named plan wins; else the single/default plan; else a
 * mutation with several plans DISAMBIGUATES rather than guess; with no plans a
 * mutation AUTO-CREATES "My FIRE Plan" and a question answers against defaults.
 *
 * Credits mirror the Ask FIRE server action exactly: tool-producing turns are
 * FREE; only a
 * pure-answer LLM turn charges `fire_chat`. The main chat does not charge for a
 * tool turn, so this is the single charge — no double-count.
 */

import type { ToolResult } from "@usemoney/types";
import { consumeCredits } from "@usemoney/services";
import {
  getFireScenariosAction,
  saveFireScenarioAction,
} from "@/lib/actions/fire";
import { isDemoSession } from "@/lib/demo/session";
import {
  ServerFireActions,
  defaultServerFirePlan,
} from "@/app/fire/lib/chat/serverActions";
import {
  runFireChatTurn,
  type FireTurnGenerate,
} from "@/app/fire/lib/chat/serverTurn";
import { buildFireSnapshotFromPlan } from "@/app/fire/lib/chat/serverSnapshot";
import { makeGeminiFireGenerate } from "@/app/fire/lib/chat/fireGenerate";
import {
  resolveTargetScenario,
  scenarioToServerPlan,
  serverPlanToScenarioInput,
  stripTargetingPrefix,
} from "@/app/fire/lib/chat/scenarioTarget";

const FIRE_CHAT_ACTION = "fire_chat";
const AUTO_PLAN_NAME = "My FIRE Plan";

export interface FirePlanParams {
  /** The user's raw FIRE request — the FIRE turn does the NL understanding. */
  request: string;
  /** "edit" (default) mutates; "ask" answers read-only. From the classifier. */
  intent?: "edit" | "ask";
  /** Optional explicit target plan name ("update my Aggressive plan"). */
  scenarioName?: string;
}

const ok = (data: Record<string, unknown>): ToolResult => ({
  tool: "fire_plan",
  success: true,
  data,
  renderType: "text",
});

const fail = (error: string): ToolResult => ({
  tool: "fire_plan",
  success: false,
  error,
});

export async function runFirePlan(
  params: FirePlanParams,
  userId: string,
  generate: FireTurnGenerate = makeGeminiFireGenerate()
): Promise<ToolResult> {
  const request = (params.request ?? "").trim();
  if (!request) return fail("I didn't catch a FIRE request — try rephrasing.");

  const isMutation = params.intent !== "ask";
  const demo = await isDemoSession();

  // Load the user's plans (demo-aware: returns demo scenarios in demo mode).
  const listRes = await getFireScenariosAction();
  const scenarios = (listRes.success ? listRes.data : []) ?? [];
  const savedNames = scenarios.map((s) => s.name);

  // Lightweight name resolution: an explicit hint, else any saved plan named
  // in the request ("update my Aggressive plan" → "Aggressive").
  const nameHint =
    params.scenarioName ??
    scenarios.find((s) => request.toLowerCase().includes(s.name.toLowerCase()))
      ?.name ??
    null;

  const target = resolveTargetScenario(scenarios, { nameHint, isMutation });

  // Several plans, a mutation, no name → ask rather than edit the wrong one.
  if (target.kind === "disambiguate") {
    const names = target.candidates.map((s) => `"${s.name}"`).join(", ");
    return ok({
      message: `You have a few FIRE plans: ${names}. Which one should I update? (Say, e.g., "update my ${target.candidates[0]!.name}".)`,
    });
  }

  // Assemble the working plan + remember where to persist it.
  let scenarioId: string | undefined;
  let planName = AUTO_PLAN_NAME;
  const plan =
    target.kind === "found"
      ? scenarioToServerPlan(target.scenario)
      : defaultServerFirePlan();
  if (target.kind === "found") {
    scenarioId = target.scenario.id;
    planName = target.scenario.name;
  }

  // Strip a leading targeting clause ("on Master22,", "update my Master22 to")
  // so a clean single-intent command reaches the FREE deterministic parser
  // instead of falling to the LLM — a comma alone trips the parser's compound
  // guard, and the plan is already resolved, so the name is just noise now.
  const command = nameHint ? stripTargetingPrefix(request, nameHint) : request;

  // Run the two-tier FIRE turn against the working plan.
  const actions = new ServerFireActions(plan);
  let result;
  try {
    result = await runFireChatTurn(actions, savedNames, command, generate);
  } catch {
    return fail("The FIRE assistant hit an error. Please try again.");
  }

  // A no-op turn (the LLM came back with nothing — no tool call, no text) must
  // NOT masquerade as "Done." with an unchanged plan, nor charge. Ask to
  // rephrase; the deterministic parser handles the concrete forms below.
  if (result.usedLlm && result.toolCallCount === 0 && !result.finalText) {
    return ok({
      message:
        'I couldn\'t apply that one — try rephrasing it as a concrete change, e.g. "set SIP to 80000", "retire at 45", or "set equity to 60%".',
      scenarioName: planName,
    });
  }

  const mutated = result.toolCallCount > 0;

  // Persist mutations (authed only). Auto-create on the first mutation for a
  // user with no plan; otherwise update the targeted scenario in place.
  let persistNote = "";
  if (mutated) {
    if (demo) {
      persistNote =
        " (Demo mode — changes aren't saved. Sign up to keep them.)";
    } else if (target.kind === "found") {
      await saveFireScenarioAction(
        serverPlanToScenarioInput(actions.plan, planName),
        scenarioId
      );
    } else {
      // "create" or a "defaults" read that turned into a mutation.
      const save = await saveFireScenarioAction(
        serverPlanToScenarioInput(actions.plan, AUTO_PLAN_NAME)
      );
      if (save.success) {
        planName = AUTO_PLAN_NAME;
        persistNote = ` I created a FIRE plan ("${AUTO_PLAN_NAME}") for you and applied that.`;
      } else {
        persistNote = ` (I couldn't save the new plan: ${save.error ?? "unknown error"}.)`;
      }
    }
  }

  // Charge ONLY a pure-answer LLM turn (no tools executed), matching
  // the Ask FIRE server action. Tool turns (edits + the parser) are free.
  if (result.usedLlm && result.toolCallCount === 0 && !demo) {
    const credit = await consumeCredits(userId, FIRE_CHAT_ACTION, {
      query: request.slice(0, 200),
    });
    if (!credit.success) {
      return fail(
        credit.error ||
          "You're out of credits for the FIRE assistant. Upgrade to keep chatting."
      );
    }
  }

  const reply =
    result.finalText ??
    (result.summaries.length ? result.summaries.join(" ") : "Done.");
  const rebalance = result.rebalanceNote ? `\n\n${result.rebalanceNote}` : "";

  // Attach a FIRE corpus-gauge card (rendered via buildTypedBlockFromTool's
  // fire_plan → fireBlock path) whenever we acted on a real or just-created
  // plan — scenario-shaped so it reuses the same fireBlock builder as
  // get_fire_scenarios. Omitted for a read against factory defaults (no plan
  // exists yet), so we don't imply the user has a saved plan.
  const showCard = target.kind === "found" || mutated;
  const finalComputed = showCard
    ? buildFireSnapshotFromPlan(actions.plan, savedNames).computed
    : null;
  const planCard = finalComputed
    ? {
        currentCorpus: actions.plan.currentCorpus,
        fireNumber: finalComputed.fireNumber,
        yearsToFire: finalComputed.yearsToFire,
        currentAge: actions.plan.currentAge,
        retirementAge: actions.plan.retirementAge,
        monthlySavings: actions.plan.monthlySavings,
        withdrawalRate: actions.plan.withdrawalRate,
      }
    : undefined;

  return ok({
    message: `${reply}${rebalance}${persistNote}`,
    scenarioName: planName,
    mutated,
    ...(planCard ? { plan: planCard } : {}),
  });
}
