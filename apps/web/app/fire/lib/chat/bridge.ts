import type { Dispatch, SetStateAction } from "react";
import type { AssetClass, MonthlyExpense, OneTimeExpense } from "../types";
import type { FireChatActions } from "./actions";
import type { FireSnapshot } from "./systemPrompt";

/* =====================================================================
   FIRE chat — state bridge  (MONEY-1049)
   ---------------------------------------------------------------------
   Adapts the FIRE page's local `useState` (values + setters) into the
   `FireChatActions` contract the tool executor calls, plus a snapshot
   builder for the system prompt.

   `buildFireActions` is handed a `getLive()` accessor (not a static
   value) so the returned object can be memoised ONCE and still always
   read/write the latest committed state — no stale closures, no
   re-render churn on the chat panel.
   ===================================================================== */

/** Everything the chat needs to read and mutate the FIRE plan. */
export interface FireLive {
  // Parameter values
  currentAge: number;
  retirementAge: number;
  lifeExpectancy: number;
  currentCorpus: number;
  monthlySavings: number;
  withdrawalRate: number;
  taxRate: number;
  salaryIncrement: number;
  savingsIncrement: number;
  // Collections
  assetClasses: AssetClass[];
  monthlyExpenses: MonthlyExpense[];
  oneTimeExpenses: OneTimeExpense[];
  savedScenarios: { name: string }[];
  // Derived outcomes (already computed by the page each render) — exposed so
  // the chat model can SEE the effect of its changes and goal-seek.
  fireNumber: number;
  yearsToFire: number; // >= 999 is the page's "never" sentinel
  corpusAtRetire: number;
  fireAchieved: boolean;
  surplus: number;
  corpusLastsTill: number;
  sustainableMonthly: number;
  // MONEY-876 outcomes: perpetual 4%-rule comparison number + first
  // retirement year where spending exceeds the withdrawal-rate cap.
  swrFireNumber: number;
  firstShortfallAge: number | null;
  // Parameter setters
  setCurrentAge: (n: number) => void;
  setRetirementAge: (n: number) => void;
  setLifeExpectancy: (n: number) => void;
  setCurrentCorpus: (n: number) => void;
  setMonthlySavings: (n: number) => void;
  setWithdrawalRate: (n: number) => void;
  setTaxRate: (n: number) => void;
  setSalaryIncrement: (n: number) => void;
  setSavingsIncrement: (n: number) => void;
  // Collection setters
  setAssetClasses: Dispatch<SetStateAction<AssetClass[]>>;
  setMonthlyExpenses: Dispatch<SetStateAction<MonthlyExpense[]>>;
  setOneTimeExpenses: Dispatch<SetStateAction<OneTimeExpense[]>>;
  // Scenario ops + reset (server-backed / page-level)
  saveScenario: (name: string) => Promise<boolean>;
  loadScenarioByName: (name: string) => Promise<boolean>;
  resetAll: () => void;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function eq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** New asset classes get a neutral swatch + icon (the UI palette cycles). */
const NEW_ASSET_COLOR = "#64748b";

export function buildFireActions(getLive: () => FireLive): FireChatActions {
  return {
    /* ── Current values (read-only) ────────────────────────────────── */
    // MONEY-1079 — before/after reporting; reads the LATEST committed state
    // via getLive() (never a stale closure).
    readValues: () => {
      const l = getLive();
      return {
        currentAge: l.currentAge,
        retirementAge: l.retirementAge,
        lifeExpectancy: l.lifeExpectancy,
        currentCorpus: l.currentCorpus,
        monthlySavings: l.monthlySavings,
        withdrawalRate: l.withdrawalRate,
        taxRate: l.taxRate,
        salaryIncrement: l.salaryIncrement,
        savingsIncrement: l.savingsIncrement,
      };
    },

    /* ── Parameters ────────────────────────────────────────────────── */
    setCurrentAge: (age) => getLive().setCurrentAge(age),
    setRetirementAge: (age) => getLive().setRetirementAge(age),
    setLifeExpectancy: (age) => getLive().setLifeExpectancy(age),
    setCurrentCorpus: (amount) => getLive().setCurrentCorpus(amount),
    setMonthlySavings: (amount) => getLive().setMonthlySavings(amount),
    setSafeWithdrawalRate: (percent) => getLive().setWithdrawalRate(percent),
    setTaxRate: (percent) => getLive().setTaxRate(percent),
    setSalaryIncrement: (percent) => getLive().setSalaryIncrement(percent),
    setSavingsIncrement: (percent) => getLive().setSavingsIncrement(percent),

    /* ── Asset allocation ──────────────────────────────────────────── */
    addAssetClass: ({ name, allocation, expectedReturn, icon }) => {
      getLive().setAssetClasses((prev) => [
        ...prev,
        {
          id: id("asset"),
          name,
          icon: icon ?? "💼",
          allocation,
          expectedReturn,
          color: NEW_ASSET_COLOR,
        },
      ]);
    },
    updateAssetAllocationByName: (name, allocation) => {
      const live = getLive();
      if (!live.assetClasses.some((a) => eq(a.name, name))) return false;
      live.setAssetClasses((prev) =>
        prev.map((a) => (eq(a.name, name) ? { ...a, allocation } : a))
      );
      return true;
    },
    updateAssetReturnByName: (name, expectedReturn) => {
      const live = getLive();
      if (!live.assetClasses.some((a) => eq(a.name, name))) return false;
      live.setAssetClasses((prev) =>
        prev.map((a) => (eq(a.name, name) ? { ...a, expectedReturn } : a))
      );
      return true;
    },
    removeAssetClassByName: (name) => {
      const live = getLive();
      if (!live.assetClasses.some((a) => eq(a.name, name))) return false;
      live.setAssetClasses((prev) => prev.filter((a) => !eq(a.name, name)));
      return true;
    },

    /* ── Monthly expenses ──────────────────────────────────────────── */
    addExpense: ({ category, amount, inflation }) => {
      getLive().setMonthlyExpenses((prev) => [
        ...prev,
        { id: id("exp"), category, amount, inflation },
      ]);
    },
    updateExpenseByCategory: (category, updates) => {
      const live = getLive();
      if (!live.monthlyExpenses.some((e) => eq(e.category, category)))
        return false;
      live.setMonthlyExpenses((prev) =>
        prev.map((e) => (eq(e.category, category) ? { ...e, ...updates } : e))
      );
      return true;
    },
    removeExpenseByCategory: (category) => {
      const live = getLive();
      if (!live.monthlyExpenses.some((e) => eq(e.category, category)))
        return false;
      live.setMonthlyExpenses((prev) =>
        prev.filter((e) => !eq(e.category, category))
      );
      return true;
    },

    /* ── One-time goals ────────────────────────────────────────────── */
    addOneTimeGoal: ({ name, currentCost, yearsAway, inflation }) => {
      getLive().setOneTimeExpenses((prev) => [
        ...prev,
        { id: id("ot"), name, currentCost, yearsAway, inflation },
      ]);
    },
    updateOneTimeGoalByName: (name, updates) => {
      const live = getLive();
      if (!live.oneTimeExpenses.some((o) => eq(o.name, name))) return false;
      live.setOneTimeExpenses((prev) =>
        prev.map((o) => (eq(o.name, name) ? { ...o, ...updates } : o))
      );
      return true;
    },
    removeOneTimeGoalByName: (name) => {
      const live = getLive();
      if (!live.oneTimeExpenses.some((o) => eq(o.name, name))) return false;
      live.setOneTimeExpenses((prev) => prev.filter((o) => !eq(o.name, name)));
      return true;
    },

    /* ── Scenarios + reset ─────────────────────────────────────────── */
    saveScenario: (name) => getLive().saveScenario(name),
    loadScenarioByName: (name) => getLive().loadScenarioByName(name),
    resetAll: () => getLive().resetAll(),
  };
}

/**
 * MONEY-1079: `rebalanceAssetAllocations` moved to the framework-free
 * `@usemoney/fire` package (the server turn engine needs it too). Re-exported
 * here so this module's existing consumers keep importing it unchanged.
 */
export { rebalanceAssetAllocations } from "@usemoney/fire";

/** Serialisable plan snapshot for the system prompt. */
export function buildFireSnapshot(live: FireLive): FireSnapshot {
  return {
    parameters: {
      currentAge: live.currentAge,
      retirementAge: live.retirementAge,
      lifeExpectancy: live.lifeExpectancy,
      currentCorpus: live.currentCorpus,
      monthlySavings: live.monthlySavings,
      safeWithdrawalRate: live.withdrawalRate,
      taxRate: live.taxRate,
      salaryIncrement: live.salaryIncrement,
      savingsIncrement: live.savingsIncrement,
    },
    assetClasses: live.assetClasses.map((a) => ({
      name: a.name,
      allocation: a.allocation,
      expectedReturn: a.expectedReturn,
    })),
    expenses: live.monthlyExpenses.map((e) => ({
      category: e.category,
      amount: e.amount,
      inflation: e.inflation,
    })),
    oneTimeGoals: live.oneTimeExpenses.map((o) => ({
      name: o.name,
      currentCost: o.currentCost,
      yearsAway: o.yearsAway,
      inflation: o.inflation,
    })),
    savedScenarios: live.savedScenarios.map((s) => ({ name: s.name })),
    computed: {
      fireNumber: Math.round(live.fireNumber),
      yearsToFire: live.yearsToFire >= 999 ? null : live.yearsToFire,
      corpusAtRetirement: Math.round(live.corpusAtRetire),
      fireAchievedAtRetirement: live.fireAchieved,
      surplusAtRetirement: Math.round(live.surplus),
      sustainableMonthlySpend: Math.round(live.sustainableMonthly),
      swrComparisonFireNumber: Math.round(live.swrFireNumber),
      firstShortfallAge: live.firstShortfallAge,
    },
  };
}
