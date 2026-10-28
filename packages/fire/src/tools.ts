import { Type, type FunctionDeclaration } from "@google/genai";
import { FIRE_BOUNDS, type FireBoundKey } from "./bounds";

/* =====================================================================
   FIRE chat — Gemini tool schema  (MONEY-1049)
   ---------------------------------------------------------------------
   Function declarations handed to Gemini. Each `name` must have a
   matching case in `toolExecutor.ts`. Covers stockbook's FIRE sections:
   parameters (incl. the MONEY-876 tax rate), asset allocation, monthly
   expenses, one-time goals, scenarios, reset.

   The numeric range hints ("18–100" etc.) are interpolated from
   FIRE_BOUNDS so the schema the model reads, the executor's clamp, and
   the sliders share ONE source of truth (see ../bounds.ts).

   Gemini gotcha: an OBJECT schema with EMPTY `properties` is rejected
   with 400 INVALID_ARGUMENT (it fails EVERY request that ships the tools
   array) — so no-arg tools like `resetAll` must omit `parameters`.
   ===================================================================== */

const num = (description: string) => ({ type: Type.NUMBER, description });
const str = (description: string) => ({ type: Type.STRING, description });

/** "min–max" hint for a bounded field, kept in sync with FIRE_BOUNDS. */
const range = (key: FireBoundKey): string =>
  `${FIRE_BOUNDS[key].min}–${FIRE_BOUNDS[key].max}`;

const fn = (
  name: string,
  description: string,
  properties: Record<string, { type: Type; description: string }>,
  required: string[],
): FunctionDeclaration => ({
  name,
  description,
  parameters: { type: Type.OBJECT, properties, required },
});

export const FIRE_TOOLS: FunctionDeclaration[] = [
  /* ── Plan parameters ─────────────────────────────────────────────── */
  fn(
    "setCurrentAge",
    "Set the user's current age in years.",
    {
      age: num(`Current age in years, ${range("currentAge")}`),
    },
    ["age"],
  ),
  fn(
    "setRetirementAge",
    "Set the user's target retirement age in years.",
    {
      age: num(`Retirement age in years, ${range("retirementAge")}`),
    },
    ["age"],
  ),
  fn(
    "setLifeExpectancy",
    "Set the user's expected lifespan in years.",
    {
      age: num(`Life expectancy in years, ${range("lifeExpectancy")}`),
    },
    ["age"],
  ),
  fn(
    "setCurrentCorpus",
    "Set the user's current invested corpus in INR (plain rupees, e.g. 500000 for ₹5 lakh).",
    { amount: num("Current corpus in INR") },
    ["amount"],
  ),
  fn(
    "setMonthlySavings",
    "Set the monthly savings / SIP amount in INR (plain rupees).",
    { amount: num("Monthly savings in INR") },
    ["amount"],
  ),
  fn(
    "setSafeWithdrawalRate",
    "Set the safe withdrawal rate (SWR) as a percentage. Typical values 3–4%.",
    { percent: num(`SWR percent, ${range("withdrawalRate")}`) },
    ["percent"],
  ),
  fn(
    "setTaxRate",
    "Set the tax rate applied to retirement withdrawals, as a percentage.",
    { percent: num(`Tax rate percent, ${range("taxRate")}`) },
    ["percent"],
  ),
  fn(
    "setSalaryIncrement",
    "Set the expected annual salary increment as a percentage.",
    {
      percent: num(
        `Annual salary increment percent, ${range("salaryIncrement")}`,
      ),
    },
    ["percent"],
  ),
  fn(
    "setSavingsIncrement",
    "Set the expected annual increase in monthly savings as a percentage.",
    {
      percent: num(
        `Annual savings increment percent, ${range("savingsIncrement")}`,
      ),
    },
    ["percent"],
  ),

  /* ── Asset allocation ────────────────────────────────────────────── */
  fn(
    "addAssetClass",
    "Add a new asset class to the portfolio.",
    {
      name: str('Asset name, e.g. "Crypto"'),
      allocation: num(`Allocation percent, ${range("allocation")}`),
      expectedReturn: num("Expected annual return percent"),
      icon: str("Optional emoji icon (default 💼)"),
    },
    ["name", "allocation", "expectedReturn"],
  ),
  fn(
    "updateAssetAllocation",
    "Change the allocation percent of an existing asset by name.",
    {
      name: str("Asset name (case-insensitive)"),
      allocation: num(`New allocation percent, ${range("allocation")}`),
    },
    ["name", "allocation"],
  ),
  fn(
    "updateAssetReturn",
    "Change the expected return of an existing asset by name.",
    {
      name: str("Asset name (case-insensitive)"),
      expectedReturn: num("New expected return percent"),
    },
    ["name", "expectedReturn"],
  ),
  fn(
    "removeAssetClass",
    "Remove an asset class from the portfolio by name.",
    { name: str("Asset name to remove (case-insensitive)") },
    ["name"],
  ),

  /* ── Monthly expenses ────────────────────────────────────────────── */
  fn(
    "addExpense",
    "Add a new monthly expense category.",
    {
      category: str("Expense category name"),
      amount: num("Monthly amount in INR (plain rupees)"),
      inflation: num("Annual inflation percent for this category"),
    },
    ["category", "amount", "inflation"],
  ),
  fn(
    "updateExpense",
    "Update an existing monthly expense by category name. Provide amount and/or inflation.",
    {
      category: str("Expense category (case-insensitive)"),
      amount: num("New monthly amount in INR (optional)"),
      inflation: num("New annual inflation percent (optional)"),
    },
    ["category"],
  ),
  fn(
    "removeExpense",
    "Remove a monthly expense by category name.",
    { category: str("Expense category to remove (case-insensitive)") },
    ["category"],
  ),

  /* ── One-time goals ──────────────────────────────────────────────── */
  fn(
    "addOneTimeGoal",
    "Add a one-time future goal/expense (e.g. child's education, a car).",
    {
      name: str("Goal name"),
      currentCost: num("Cost today in INR (plain rupees)"),
      yearsAway: num("Years from now the goal occurs"),
      inflation: num("Annual inflation percent for this goal"),
    },
    ["name", "currentCost", "yearsAway", "inflation"],
  ),
  fn(
    "updateOneTimeGoal",
    "Update an existing one-time goal by name.",
    {
      name: str("Goal name (case-insensitive)"),
      currentCost: num("New cost today in INR (optional)"),
      yearsAway: num("New years-away (optional)"),
      inflation: num("New annual inflation percent (optional)"),
    },
    ["name"],
  ),
  fn(
    "removeOneTimeGoal",
    "Remove a one-time goal by name.",
    { name: str("Goal name to remove (case-insensitive)") },
    ["name"],
  ),

  /* ── Scenarios + reset ───────────────────────────────────────────── */
  fn(
    "saveScenario",
    "Save the current FIRE plan as a named scenario.",
    { name: str("Scenario name") },
    ["name"],
  ),
  fn(
    "loadScenario",
    "Load a previously saved scenario by name.",
    { name: str("Scenario name (case-insensitive)") },
    ["name"],
  ),
  {
    // No `parameters`: Gemini rejects an OBJECT schema with empty properties.
    name: "resetAll",
    description:
      "Reset all FIRE parameters, assets, expenses, and goals to defaults. Saved scenarios are preserved.",
  },
];
