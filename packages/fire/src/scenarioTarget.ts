// Imported from the ./fire SUBPATH, not the services barrel: the barrel
// re-exports ./gst, whose React PDF templates are .tsx, which would force this
// deliberately framework-free package to compile with `jsx` set.
import type { FireScenario, FireScenarioInput } from "@usemoney/services/fire";
import type { AssetClass, MonthlyExpense, OneTimeExpense } from "./types";
import type { ServerFirePlan, ServerScenarioOps } from "./serverActions";
import { computeFirePlanOutcomes } from "./serverSnapshot";

/* =====================================================================
   FIRE chat — scenario mapping + targeting  (StockSage integration)
   ---------------------------------------------------------------------
   Two concerns the off-page path needs that the /fire page gets for free:

   MAPPING — a stored FireScenario ⇄ the in-memory ServerFirePlan. The
   /fire page persists its React state arrays VERBATIM as JSON
   (client.tsx handleSave / switchToScenario), so assetClasses / expenses
   / oneTimeExpenses round-trip as the typed shapes; only taxRate (stored
   nullable) needs a default.

   TARGETING — when the main chat edits a plan off /fire it must pick WHICH
   saved scenario, per the product decisions:
     1. an explicit name the user gave ("update my Aggressive plan") wins;
     2. else the single scenario, or the isDefault one;
     3. else, for a MUTATION with several non-default plans, DISAMBIGUATE
        (ask — silently editing the wrong plan is the worst outcome);
        for a READ/answer, fall back to the most-recently-updated;
     4. with NO scenarios: a mutation AUTO-CREATES a default plan, a read
        answers against factory defaults.
   ===================================================================== */

/** taxRate is stored nullable (legacy rows); the page defaults it to 30. */
const DEFAULT_TAX_RATE = 30;

/** Map a stored scenario into a mutable working plan (mirrors switchToScenario). */
export function scenarioToServerPlan(s: FireScenario): ServerFirePlan {
  return {
    currentAge: s.currentAge,
    retirementAge: s.retirementAge,
    lifeExpectancy: s.lifeExpectancy,
    currentCorpus: s.currentCorpus,
    monthlySavings: s.monthlySavings,
    withdrawalRate: s.withdrawalRate,
    taxRate: s.taxRate ?? DEFAULT_TAX_RATE,
    salaryIncrement: s.salaryIncrement,
    savingsIncrement: s.savingsIncrement,
    assetClasses: (s.assetClasses as unknown as AssetClass[]) ?? [],
    monthlyExpenses: (s.expenses as unknown as MonthlyExpense[]) ?? [],
    oneTimeExpenses: (s.oneTimeExpenses as unknown as OneTimeExpense[]) ?? [],
  };
}

/**
 * Serialize a working plan into the persistence input (mirrors handleSave).
 *
 * MONEY-1079 — the four DENORMALIZED headline fields (fireNumber, yearsToFire,
 * avgInflation, weightedReturn) are recomputed here rather than left to the
 * caller. `saveFireScenario` uses Prisma `updateMany`, which SKIPS undefined,
 * so omitting them left the stored row's headline numbers at their
 * pre-mutation values: a chat turn that raised monthly savings persisted the
 * new input beside a yearsToFire computed from the OLD one, and GET /v1/fire
 * served that contradiction. The /fire page never had the bug because
 * client.tsx writes all four on every save; computing them at this single
 * serialization point makes every caller correct by construction.
 */
export function serverPlanToScenarioInput(
  plan: ServerFirePlan,
  name: string,
  description?: string,
): FireScenarioInput {
  const { fireNumber, yearsToFire, avgInflation, weightedReturn } =
    computeFirePlanOutcomes(plan);

  return {
    name,
    description,
    fireNumber,
    // 999 is the "never reaches FIRE" sentinel, not a real horizon — clear the
    // column rather than claiming 999 years. Must be `null`, NOT `undefined`:
    // saveFireScenario persists with Prisma `updateMany`, which SKIPS
    // undefined fields, so undefined would leave the PREVIOUS horizon in place
    // beside the new inputs — a plan that just became unreachable would still
    // advertise its old "reaches FIRE in N years".
    yearsToFire: yearsToFire >= 999 ? null : yearsToFire,
    avgInflation,
    weightedReturn,
    currentAge: plan.currentAge,
    retirementAge: plan.retirementAge,
    lifeExpectancy: plan.lifeExpectancy,
    currentCorpus: plan.currentCorpus,
    monthlySavings: plan.monthlySavings,
    withdrawalRate: plan.withdrawalRate,
    taxRate: plan.taxRate,
    salaryIncrement: plan.salaryIncrement,
    savingsIncrement: plan.savingsIncrement,
    assetClasses:
      plan.assetClasses as unknown as FireScenarioInput["assetClasses"],
    expenses: plan.monthlyExpenses as unknown as FireScenarioInput["expenses"],
    oneTimeExpenses:
      plan.oneTimeExpenses as unknown as FireScenarioInput["oneTimeExpenses"],
  };
}

/* ── Scenario ops + save targeting for a single server turn ───────────── */

/** The scenario a turn's mutated plan must be written back to. */
export interface FireSaveTarget {
  id: string;
  name: string;
}

/**
 * Build the `ServerScenarioOps` for ONE server-side turn, together with the
 * save target that turn must persist to.
 *
 * MONEY-1079 — this pairing is the whole point, and it exists because getting
 * it wrong destroys data. `loadScenarioByName` `Object.assign`s the loaded
 * plan OVER the working copy, so the instant a turn loads a different
 * scenario, `actions.plan` holds THAT scenario's numbers. Persisting the
 * result back to the scenario named in the request path would overwrite it
 * with a different plan's data — "load my Conservative plan" against
 * `/v1/fire/A/turn` would permanently clobber A with B.
 *
 * So the loader records what it loaded and `getSaveTarget()` re-points the
 * save at it. The invariant callers depend on: **the plan and the target
 * always describe the same scenario.** Keeping the mutable bookkeeping in
 * here (rather than a `let` in a route handler) is what makes that invariant
 * testable without a HTTP/Prisma/Gemini harness — see
 * `__tests__/scenario-save-target.test.ts`.
 *
 * `resetAll` is deliberately NOT re-targeted: "reset my plan" aimed at the
 * path scenario is the correct reading of the request, not data loss.
 *
 * @param saved      the user's scenarios, already fetched (no extra query)
 * @param pathScenario the scenario addressed by the request
 * @param persistNew  create a brand-new scenario (chat "save as <name>")
 */
export function createScenarioOps({
  saved,
  pathScenario,
  persistNew,
}: {
  saved: FireScenario[];
  pathScenario: FireSaveTarget;
  persistNew: (input: FireScenarioInput) => Promise<boolean>;
}): {
  ops: ServerScenarioOps;
  getSaveTarget: () => FireSaveTarget;
} {
  // Set only when the turn loaded a DIFFERENT saved scenario; null means the
  // turn stayed on the path scenario.
  let loaded: FireSaveTarget | null = null;

  return {
    ops: {
      saveScenario: async (plan, name) =>
        persistNew(serverPlanToScenarioInput(plan, name)),

      loadScenarioByName: async (name) => {
        // Case-insensitive exact match, mirroring bridge.ts's by-name lookup.
        const hit = saved.find(
          (s) => s.name.toLowerCase() === name.trim().toLowerCase(),
        );
        if (!hit) return null;
        loaded = { id: hit.id, name: hit.name };
        return scenarioToServerPlan(hit);
      },
    },
    getSaveTarget: () => loaded ?? pathScenario,
  };
}

/** How a FIRE edit/answer from the main chat resolves to a target plan. */
export type TargetResolution =
  /** Edit/answer this existing saved scenario. */
  | { kind: "found"; scenario: FireScenario }
  /** Several non-default plans + a mutation with no name → ask the user. */
  | { kind: "disambiguate"; candidates: FireScenario[] }
  /** No saved scenarios + a mutation → auto-create a default plan. */
  | { kind: "create" }
  /** No saved scenarios + a read → answer against factory defaults. */
  | { kind: "defaults" };

function byName(
  scenarios: FireScenario[],
  hint: string,
): FireScenario | undefined {
  const h = hint.trim().toLowerCase();
  return (
    scenarios.find((s) => s.name.toLowerCase() === h) ??
    scenarios.find((s) => s.name.toLowerCase().includes(h))
  );
}

/**
 * Resolve which saved scenario a main-chat FIRE turn targets.
 * `scenarios` is expected in getFireScenarios' order (updatedAt desc), so
 * `scenarios[0]` is the most recently updated.
 */
export function resolveTargetScenario(
  scenarios: FireScenario[],
  opts: { nameHint?: string | null; isMutation: boolean },
): TargetResolution {
  // 1. An explicit named plan always wins.
  if (opts.nameHint) {
    const named = byName(scenarios, opts.nameHint);
    if (named) return { kind: "found", scenario: named };
  }

  // 2. No saved plans: create on a mutation, else answer against defaults.
  if (scenarios.length === 0) {
    return { kind: opts.isMutation ? "create" : "defaults" };
  }

  // 3. A single plan, or an explicit default, is unambiguous.
  if (scenarios.length === 1) return { kind: "found", scenario: scenarios[0]! };
  const dflt = scenarios.find((s) => s.isDefault);
  if (dflt) return { kind: "found", scenario: dflt };

  // 4. Several non-default plans, no name given:
  //    - a MUTATION must not guess → disambiguate;
  //    - a READ/answer is harmless → use the most-recently-updated.
  if (opts.isMutation) return { kind: "disambiguate", candidates: scenarios };
  return { kind: "found", scenario: scenarios[0]! };
}

/**
 * Rewrite a request so the FIRE turn treats the ALREADY-resolved plan as the
 * subject, dropping the targeting noise:
 *   1. strip a LEADING targeting clause ("on Master22,", "update my Master22
 *      to", "for Master22:") — so a clean single-intent command reaches the
 *      deterministic parser instead of the LLM (a comma alone trips the parser's
 *      compound guard);
 *   2. neutralize any REMAINING inline mention of the plan name to "my plan" —
 *      so the model answers about the loaded snapshot ("is my plan on track?")
 *      instead of thinking it must go load a separate scenario ("is Master22 on
 *      track?" → the model would otherwise reply "load it first").
 * Conservative: never strips down to fewer than 3 chars.
 */
export function stripTargetingPrefix(
  request: string,
  nameHint: string,
): string {
  const esc = nameHint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = request
    .replace(
      new RegExp(
        `^\\s*(on|for|in|to|update|edit|change)\\s+(my\\s+)?${esc}(\\s+(plan|scenario))?\\s*[,:]?\\s*(to\\s+)?`,
        "i",
      ),
      "",
    )
    .replace(new RegExp(`\\b${esc}\\b`, "gi"), "my plan")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out.length >= 3 ? out : request;
}
