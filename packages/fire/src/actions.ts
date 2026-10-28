/* =====================================================================
   FIRE chat — actions contract  (MONEY-1049)
   ---------------------------------------------------------------------
   The set of mutations the Ask FIRE chat can perform on the FIRE plan.

   The FIRE page (`client.tsx`) implements this interface from its own
   `useState` setters and provides it through `FireActionsContext`. The
   tool executor (`toolExecutor.ts`) is handed an implementation and never
   touches React state directly — so the same executor is unit-testable
   against a plain mock object.

   By-name / by-category mutators return `boolean` (was a matching row
   found?) so the executor can report "not found" back to the model
   instead of silently succeeding.
   ===================================================================== */

export interface AddAssetInput {
  name: string;
  allocation: number;
  expectedReturn: number;
  icon?: string;
}

export interface AddExpenseInput {
  category: string;
  amount: number;
  inflation: number;
}

export interface AddOneTimeGoalInput {
  name: string;
  currentCost: number;
  yearsAway: number;
  inflation: number;
}

/**
 * The plan's current numeric parameters, read BEFORE a mutation so the tool
 * executor can report a change as "from <old> to <new>" (MONEY-1079).
 *
 * Without this, the executor could only say "set monthly savings to ₹80,000".
 * The turn loop then hands the model a FRESH (already-mutated) snapshot, so on
 * the next hop it read ₹80,000 as "current" and re-applied the user's "+₹20k"
 * — answering "₹1,00,000" for a plan that is actually ₹80,000. Giving the model
 * the before/after as a FACT removes the double-count at the source.
 */
export interface FireCurrentValues {
  currentAge: number;
  retirementAge: number;
  lifeExpectancy: number;
  currentCorpus: number;
  monthlySavings: number;
  withdrawalRate: number;
  taxRate: number;
  salaryIncrement: number;
  savingsIncrement: number;
}

export interface FireChatActions {
  /* ── Current values (read-only) ──────────────────────────────────── */
  /** Snapshot of the plan's numeric params, for before/after reporting. */
  readValues(): FireCurrentValues;

  /* ── Plan parameters ─────────────────────────────────────────────── */
  setCurrentAge(age: number): void;
  setRetirementAge(age: number): void;
  setLifeExpectancy(age: number): void;
  setCurrentCorpus(amount: number): void;
  setMonthlySavings(amount: number): void;
  setSafeWithdrawalRate(percent: number): void;
  setTaxRate(percent: number): void;
  setSalaryIncrement(percent: number): void;
  setSavingsIncrement(percent: number): void;

  /* ── Asset allocation ────────────────────────────────────────────── */
  addAssetClass(asset: AddAssetInput): void;
  updateAssetAllocationByName(name: string, allocation: number): boolean;
  updateAssetReturnByName(name: string, expectedReturn: number): boolean;
  removeAssetClassByName(name: string): boolean;

  /* ── Monthly expenses ────────────────────────────────────────────── */
  addExpense(expense: AddExpenseInput): void;
  updateExpenseByCategory(
    category: string,
    updates: { amount?: number; inflation?: number },
  ): boolean;
  removeExpenseByCategory(category: string): boolean;

  /* ── One-time goals ──────────────────────────────────────────────── */
  addOneTimeGoal(goal: AddOneTimeGoalInput): void;
  updateOneTimeGoalByName(
    name: string,
    updates: { currentCost?: number; yearsAway?: number; inflation?: number },
  ): boolean;
  removeOneTimeGoalByName(name: string): boolean;

  /* ── Scenarios + reset ───────────────────────────────────────────── */
  // Scenario ops are server-backed (Prisma) hence async.
  saveScenario(name: string): Promise<boolean>;
  loadScenarioByName(name: string): Promise<boolean>;
  resetAll(): void;
}

/** Result of executing a single tool call. */
export type ToolResult =
  | { ok: true; message: string }
  | { ok: false; error: string };
