import type { FireChatActions, FireCurrentValues } from "./actions";
import type { AssetClass, MonthlyExpense, OneTimeExpense } from "./types";
import {
  defaultAssetClasses,
  defaultOneTimeExpenses,
  getDefaultMonthlyExpenses,
} from "./types";

/* =====================================================================
   FIRE chat — SERVER-side actions  (StockSage integration)
   ---------------------------------------------------------------------
   The "supreme god" case: when the main StockSage chat handles a FIRE
   command from OFF the /fire page (e.g. the dashboard), there is no live
   React state to mutate. This is the server-side twin of bridge.ts: it
   implements the SAME `FireChatActions` contract over a plain in-memory
   plan object (a working copy loaded from / persisted to a saved
   scenario), so the SAME pure `executeFireTool` runs the full 26-tool
   editing surface with ZERO executor changes.

   Design mirrors bridge.ts (by-name lookups, neutral swatch for new
   assets) so on-page and off-page edits behave identically. Values
   arriving here are already range-clamped by the executor (FIRE_BOUNDS),
   so this layer just applies them. Scenario save/load are DB-backed and
   therefore injected (see `ServerScenarioOps`); unset = unsupported.
   ===================================================================== */

/** The plain, mutable FIRE plan the server executor edits in place. */
export interface ServerFirePlan {
  currentAge: number;
  retirementAge: number;
  lifeExpectancy: number;
  currentCorpus: number;
  monthlySavings: number;
  withdrawalRate: number;
  taxRate: number;
  salaryIncrement: number;
  savingsIncrement: number;
  assetClasses: AssetClass[];
  monthlyExpenses: MonthlyExpense[];
  oneTimeExpenses: OneTimeExpense[];
}

/**
 * DB-backed scenario operations, injected by the request handler. Kept out
 * of this pure module so it stays unit-testable without Prisma. When a hook
 * is absent the corresponding tool reports failure to the model (never
 * throws), matching bridge.ts's not-found semantics.
 */
export interface ServerScenarioOps {
  /** Persist the CURRENT working plan as a new named scenario. */
  saveScenario?: (plan: ServerFirePlan, name: string) => Promise<boolean>;
  /** Resolve a saved scenario by name into a working plan to swap in. */
  loadScenarioByName?: (name: string) => Promise<ServerFirePlan | null>;
}

/** New asset classes get a neutral swatch + icon — identical to bridge.ts. */
const NEW_ASSET_COLOR = "#64748b";

const eq = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/** Stable-enough id for a server-created row (crypto is a global in Node 19+). */
const rid = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

/**
 * Factory-default plan — matches the /fire page's initial useState values
 * (client.tsx) so a chat-driven `resetAll` off-page lands on the same plan a
 * fresh /fire visit would show.
 */
export function defaultServerFirePlan(): ServerFirePlan {
  return {
    currentAge: 30,
    retirementAge: 50,
    lifeExpectancy: 85,
    currentCorpus: 1_800_000,
    monthlySavings: 60_000,
    withdrawalRate: 4,
    taxRate: 30,
    salaryIncrement: 10,
    savingsIncrement: 8,
    assetClasses: defaultAssetClasses.map((a) => ({ ...a })),
    monthlyExpenses: getDefaultMonthlyExpenses(),
    oneTimeExpenses: defaultOneTimeExpenses.map((o) => ({ ...o })),
  };
}

/**
 * Server-side `FireChatActions` over an in-memory `ServerFirePlan`. Mutates
 * `this.plan` in place so the handler can persist the final state once per
 * turn. `saveScenario` / `loadScenarioByName` delegate to injected ops.
 */
export class ServerFireActions implements FireChatActions {
  constructor(
    /** The working plan — mutated in place; read by the handler after the turn. */
    public plan: ServerFirePlan,
    private readonly ops: ServerScenarioOps = {},
  ) {}

  /* ── Current values (read-only) ────────────────────────────────────── */
  /** MONEY-1079 — before/after reporting; reads the live working plan. */
  readValues(): FireCurrentValues {
    return {
      currentAge: this.plan.currentAge,
      retirementAge: this.plan.retirementAge,
      lifeExpectancy: this.plan.lifeExpectancy,
      currentCorpus: this.plan.currentCorpus,
      monthlySavings: this.plan.monthlySavings,
      withdrawalRate: this.plan.withdrawalRate,
      taxRate: this.plan.taxRate,
      salaryIncrement: this.plan.salaryIncrement,
      savingsIncrement: this.plan.savingsIncrement,
    };
  }

  /* ── Plan parameters ───────────────────────────────────────────────── */
  setCurrentAge(age: number): void {
    this.plan.currentAge = age;
  }
  setRetirementAge(age: number): void {
    this.plan.retirementAge = age;
  }
  setLifeExpectancy(age: number): void {
    this.plan.lifeExpectancy = age;
  }
  setCurrentCorpus(amount: number): void {
    this.plan.currentCorpus = amount;
  }
  setMonthlySavings(amount: number): void {
    this.plan.monthlySavings = amount;
  }
  setSafeWithdrawalRate(percent: number): void {
    this.plan.withdrawalRate = percent;
  }
  setTaxRate(percent: number): void {
    this.plan.taxRate = percent;
  }
  setSalaryIncrement(percent: number): void {
    this.plan.salaryIncrement = percent;
  }
  setSavingsIncrement(percent: number): void {
    this.plan.savingsIncrement = percent;
  }

  /* ── Asset allocation ──────────────────────────────────────────────── */
  addAssetClass({
    name,
    allocation,
    expectedReturn,
    icon,
  }: {
    name: string;
    allocation: number;
    expectedReturn: number;
    icon?: string;
  }): void {
    this.plan.assetClasses.push({
      id: rid("asset"),
      name,
      icon: icon ?? "💼",
      allocation,
      expectedReturn,
      color: NEW_ASSET_COLOR,
    });
  }
  updateAssetAllocationByName(name: string, allocation: number): boolean {
    const a = this.plan.assetClasses.find((x) => eq(x.name, name));
    if (!a) return false;
    a.allocation = allocation;
    return true;
  }
  updateAssetReturnByName(name: string, expectedReturn: number): boolean {
    const a = this.plan.assetClasses.find((x) => eq(x.name, name));
    if (!a) return false;
    a.expectedReturn = expectedReturn;
    return true;
  }
  removeAssetClassByName(name: string): boolean {
    const before = this.plan.assetClasses.length;
    this.plan.assetClasses = this.plan.assetClasses.filter(
      (x) => !eq(x.name, name),
    );
    return this.plan.assetClasses.length < before;
  }

  /* ── Monthly expenses ──────────────────────────────────────────────── */
  addExpense({
    category,
    amount,
    inflation,
  }: {
    category: string;
    amount: number;
    inflation: number;
  }): void {
    this.plan.monthlyExpenses.push({
      id: rid("exp"),
      category,
      amount,
      inflation,
    });
  }
  updateExpenseByCategory(
    category: string,
    updates: { amount?: number; inflation?: number },
  ): boolean {
    const e = this.plan.monthlyExpenses.find((x) => eq(x.category, category));
    if (!e) return false;
    if (updates.amount !== undefined) e.amount = updates.amount;
    if (updates.inflation !== undefined) e.inflation = updates.inflation;
    return true;
  }
  removeExpenseByCategory(category: string): boolean {
    const before = this.plan.monthlyExpenses.length;
    this.plan.monthlyExpenses = this.plan.monthlyExpenses.filter(
      (x) => !eq(x.category, category),
    );
    return this.plan.monthlyExpenses.length < before;
  }

  /* ── One-time goals ────────────────────────────────────────────────── */
  addOneTimeGoal({
    name,
    currentCost,
    yearsAway,
    inflation,
  }: {
    name: string;
    currentCost: number;
    yearsAway: number;
    inflation: number;
  }): void {
    this.plan.oneTimeExpenses.push({
      id: rid("ot"),
      name,
      currentCost,
      yearsAway,
      inflation,
    });
  }
  updateOneTimeGoalByName(
    name: string,
    updates: { currentCost?: number; yearsAway?: number; inflation?: number },
  ): boolean {
    const o = this.plan.oneTimeExpenses.find((x) => eq(x.name, name));
    if (!o) return false;
    if (updates.currentCost !== undefined) o.currentCost = updates.currentCost;
    if (updates.yearsAway !== undefined) o.yearsAway = updates.yearsAway;
    if (updates.inflation !== undefined) o.inflation = updates.inflation;
    return true;
  }
  removeOneTimeGoalByName(name: string): boolean {
    const before = this.plan.oneTimeExpenses.length;
    this.plan.oneTimeExpenses = this.plan.oneTimeExpenses.filter(
      (x) => !eq(x.name, name),
    );
    return this.plan.oneTimeExpenses.length < before;
  }

  /* ── Scenarios + reset ─────────────────────────────────────────────── */
  async saveScenario(name: string): Promise<boolean> {
    return this.ops.saveScenario
      ? this.ops.saveScenario(this.plan, name)
      : false;
  }
  async loadScenarioByName(name: string): Promise<boolean> {
    if (!this.ops.loadScenarioByName) return false;
    const loaded = await this.ops.loadScenarioByName(name);
    if (!loaded) return false;
    // Swap contents in place so `this.plan` (held by the handler) stays live.
    Object.assign(this.plan, loaded);
    return true;
  }
  resetAll(): void {
    Object.assign(this.plan, defaultServerFirePlan());
  }
}
