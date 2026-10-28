import type { FireChatActions, ToolResult } from "./actions";
import { FIRE_BOUNDS, clamp, type FireBoundKey } from "./bounds";

/* =====================================================================
   FIRE chat — tool executor  (MONEY-1049)
   ---------------------------------------------------------------------
   Maps a Gemini function call (name + args) onto a `FireChatActions`
   method. Pure and side-effect-free except through `actions`, so it is
   unit-testable against a mock. Numbers coming back from the model are
   defensively coerced AND clamped to the same bounds the Plan-inputs
   sliders enforce (see ../bounds.ts) — the chat must not be able to drive
   the plan into a state the UI forbids (age 5, negative corpus, SWR 0,
   allocation 200…), which would feed nonsensical values into the
   projection math. A bad/missing value yields an error ToolResult (which
   the chat loop feeds back to the model) rather than throwing; a clamped
   value is applied AND flagged in the message so the model sees the
   correction and can re-plan.
   ===================================================================== */

export type ToolArgs = Record<string, unknown>;

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

/**
 * Clamp a model-supplied number to its field bound. Returns the clamped
 * value plus a note (empty unless it was out of range) to append to the
 * ToolResult message, so the model is told its value was corrected.
 */
function clampNote(
  value: number,
  key: FireBoundKey,
): { value: number; note: string } {
  const b = FIRE_BOUNDS[key];
  const clamped = clamp(value, b);
  const note =
    clamped !== value
      ? ` (clamped to the allowed ${b.min}–${b.max} range)`
      : "";
  return { value: clamped, note };
}

/** Format a plain-rupee amount the way the UI does (₹, lakh/crore). */
function fmtINR(n: number): string {
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${n.toLocaleString("en-IN")}`;
}

/**
 * MONEY-1079 — report a numeric change as "from <old> to <new>".
 *
 * The turn loop re-snapshots the plan after every tool call, so the model's
 * NEXT hop sees the already-updated value. With only "set X to <new>" in the
 * tool result it read that as "current" and re-applied the user's requested
 * delta — "save ₹20k more" on a ₹60,000 plan updated it to ₹80,000 but reported
 * ₹1,00,000. Handing the model the before/after as a FACT removes the
 * double-count at its source (rather than hoping a prompt rule holds).
 */
function changed(
  label: string,
  before: number,
  after: number,
  fmt: (n: number) => string = (n) => String(n),
): string {
  if (before === after) return `${label} is already ${fmt(after)} — no change.`;
  return `Changed ${label} from ${fmt(before)} to ${fmt(after)}.`;
}

/** Percent formatter for the rate/increment setters. */
const pct = (n: number): string => `${n}%`;

const bad = (field: string): ToolResult => ({
  ok: false,
  error: `Invalid or missing "${field}".`,
});

const notFound = (kind: string, name: string): ToolResult => ({
  ok: false,
  error: `No ${kind} named "${name}" found.`,
});

export async function executeFireTool(
  name: string,
  args: ToolArgs,
  actions: FireChatActions,
): Promise<ToolResult> {
  try {
    switch (name) {
      /* ── Plan parameters ───────────────────────────────────────────── */
      case "setCurrentAge": {
        const raw = num(args.age);
        if (raw === null) return bad("age");
        const { value: age, note } = clampNote(raw, "currentAge");
        const before = actions.readValues().currentAge;
        actions.setCurrentAge(age);
        return {
          ok: true,
          message: changed("current age", before, age) + note,
        };
      }
      case "setRetirementAge": {
        const raw = num(args.age);
        if (raw === null) return bad("age");
        const { value: age, note } = clampNote(raw, "retirementAge");
        const before = actions.readValues().retirementAge;
        actions.setRetirementAge(age);
        return {
          ok: true,
          message: changed("retirement age", before, age) + note,
        };
      }
      case "setLifeExpectancy": {
        const raw = num(args.age);
        if (raw === null) return bad("age");
        const { value: age, note } = clampNote(raw, "lifeExpectancy");
        const before = actions.readValues().lifeExpectancy;
        actions.setLifeExpectancy(age);
        return {
          ok: true,
          message: changed("life expectancy", before, age) + note,
        };
      }
      case "setCurrentCorpus": {
        const raw = num(args.amount);
        if (raw === null) return bad("amount");
        const { value: amount, note } = clampNote(raw, "currentCorpus");
        const before = actions.readValues().currentCorpus;
        actions.setCurrentCorpus(amount);
        return {
          ok: true,
          message: changed("current corpus", before, amount, fmtINR) + note,
        };
      }
      case "setMonthlySavings": {
        const raw = num(args.amount);
        if (raw === null) return bad("amount");
        const { value: amount, note } = clampNote(raw, "monthlySavings");
        const before = actions.readValues().monthlySavings;
        actions.setMonthlySavings(amount);
        return {
          ok: true,
          message: changed("monthly savings", before, amount, fmtINR) + note,
        };
      }
      case "setSafeWithdrawalRate": {
        const raw = num(args.percent);
        if (raw === null) return bad("percent");
        const { value: percent, note } = clampNote(raw, "withdrawalRate");
        const before = actions.readValues().withdrawalRate;
        actions.setSafeWithdrawalRate(percent);
        return {
          ok: true,
          message: changed("safe withdrawal rate", before, percent, pct) + note,
        };
      }
      case "setTaxRate": {
        const raw = num(args.percent);
        if (raw === null) return bad("percent");
        const { value: percent, note } = clampNote(raw, "taxRate");
        const before = actions.readValues().taxRate;
        actions.setTaxRate(percent);
        return {
          ok: true,
          message:
            changed("tax rate on withdrawals", before, percent, pct) + note,
        };
      }
      case "setSalaryIncrement": {
        const raw = num(args.percent);
        if (raw === null) return bad("percent");
        const { value: percent, note } = clampNote(raw, "salaryIncrement");
        const before = actions.readValues().salaryIncrement;
        actions.setSalaryIncrement(percent);
        return {
          ok: true,
          message: changed("salary increment", before, percent, pct) + note,
        };
      }
      case "setSavingsIncrement": {
        const raw = num(args.percent);
        if (raw === null) return bad("percent");
        const { value: percent, note } = clampNote(raw, "savingsIncrement");
        const before = actions.readValues().savingsIncrement;
        actions.setSavingsIncrement(percent);
        return {
          ok: true,
          message: changed("savings increment", before, percent, pct) + note,
        };
      }

      /* ── Asset allocation ──────────────────────────────────────────── */
      case "addAssetClass": {
        const rawAlloc = num(args.allocation);
        const rawReturn = num(args.expectedReturn);
        if (!args.name) return bad("name");
        if (rawAlloc === null) return bad("allocation");
        if (rawReturn === null) return bad("expectedReturn");
        const a = clampNote(rawAlloc, "allocation");
        const r = clampNote(rawReturn, "expectedReturn");
        actions.addAssetClass({
          name: str(args.name),
          allocation: a.value,
          expectedReturn: r.value,
          icon: args.icon ? str(args.icon) : undefined,
        });
        return {
          ok: true,
          message: `Added asset class "${str(args.name)}".${a.note}${r.note}`,
        };
      }
      case "updateAssetAllocation": {
        const raw = num(args.allocation);
        if (!args.name) return bad("name");
        if (raw === null) return bad("allocation");
        const { value: allocation, note } = clampNote(raw, "allocation");
        const ok = actions.updateAssetAllocationByName(
          str(args.name),
          allocation,
        );
        return ok
          ? {
              ok: true,
              message: `Set ${str(args.name)} allocation to ${allocation}%.${note}`,
            }
          : notFound("asset", str(args.name));
      }
      case "updateAssetReturn": {
        const raw = num(args.expectedReturn);
        if (!args.name) return bad("name");
        if (raw === null) return bad("expectedReturn");
        const { value: expectedReturn, note } = clampNote(
          raw,
          "expectedReturn",
        );
        const ok = actions.updateAssetReturnByName(
          str(args.name),
          expectedReturn,
        );
        return ok
          ? {
              ok: true,
              message: `Set ${str(args.name)} expected return to ${expectedReturn}%.${note}`,
            }
          : notFound("asset", str(args.name));
      }
      case "removeAssetClass": {
        if (!args.name) return bad("name");
        const ok = actions.removeAssetClassByName(str(args.name));
        return ok
          ? { ok: true, message: `Removed asset class "${str(args.name)}".` }
          : notFound("asset", str(args.name));
      }

      /* ── Monthly expenses ──────────────────────────────────────────── */
      case "addExpense": {
        const rawAmount = num(args.amount);
        const rawInflation = num(args.inflation);
        if (!args.category) return bad("category");
        if (rawAmount === null) return bad("amount");
        if (rawInflation === null) return bad("inflation");
        const amt = clampNote(rawAmount, "expenseAmount");
        const inf = clampNote(rawInflation, "inflation");
        actions.addExpense({
          category: str(args.category),
          amount: amt.value,
          inflation: inf.value,
        });
        return {
          ok: true,
          message: `Added expense "${str(args.category)}".${amt.note}${inf.note}`,
        };
      }
      case "updateExpense": {
        if (!args.category) return bad("category");
        const updates: { amount?: number; inflation?: number } = {};
        let note = "";
        if (args.amount !== undefined) {
          const raw = num(args.amount);
          if (raw === null) return bad("amount");
          const c = clampNote(raw, "expenseAmount");
          updates.amount = c.value;
          note += c.note;
        }
        if (args.inflation !== undefined) {
          const raw = num(args.inflation);
          if (raw === null) return bad("inflation");
          const c = clampNote(raw, "inflation");
          updates.inflation = c.value;
          note += c.note;
        }
        const ok = actions.updateExpenseByCategory(str(args.category), updates);
        return ok
          ? {
              ok: true,
              message: `Updated expense "${str(args.category)}".${note}`,
            }
          : notFound("expense", str(args.category));
      }
      case "removeExpense": {
        if (!args.category) return bad("category");
        const ok = actions.removeExpenseByCategory(str(args.category));
        return ok
          ? { ok: true, message: `Removed expense "${str(args.category)}".` }
          : notFound("expense", str(args.category));
      }

      /* ── One-time goals ────────────────────────────────────────────── */
      case "addOneTimeGoal": {
        const rawCost = num(args.currentCost);
        const rawYears = num(args.yearsAway);
        const rawInflation = num(args.inflation);
        if (!args.name) return bad("name");
        if (rawCost === null) return bad("currentCost");
        if (rawYears === null) return bad("yearsAway");
        if (rawInflation === null) return bad("inflation");
        const cost = clampNote(rawCost, "goalCost");
        const years = clampNote(rawYears, "yearsAway");
        const inf = clampNote(rawInflation, "inflation");
        actions.addOneTimeGoal({
          name: str(args.name),
          currentCost: cost.value,
          yearsAway: years.value,
          inflation: inf.value,
        });
        return {
          ok: true,
          message: `Added one-time goal "${str(args.name)}".${cost.note}${years.note}${inf.note}`,
        };
      }
      case "updateOneTimeGoal": {
        if (!args.name) return bad("name");
        const updates: {
          currentCost?: number;
          yearsAway?: number;
          inflation?: number;
        } = {};
        let note = "";
        if (args.currentCost !== undefined) {
          const raw = num(args.currentCost);
          if (raw === null) return bad("currentCost");
          const c = clampNote(raw, "goalCost");
          updates.currentCost = c.value;
          note += c.note;
        }
        if (args.yearsAway !== undefined) {
          const raw = num(args.yearsAway);
          if (raw === null) return bad("yearsAway");
          const c = clampNote(raw, "yearsAway");
          updates.yearsAway = c.value;
          note += c.note;
        }
        if (args.inflation !== undefined) {
          const raw = num(args.inflation);
          if (raw === null) return bad("inflation");
          const c = clampNote(raw, "inflation");
          updates.inflation = c.value;
          note += c.note;
        }
        const ok = actions.updateOneTimeGoalByName(str(args.name), updates);
        return ok
          ? { ok: true, message: `Updated goal "${str(args.name)}".${note}` }
          : notFound("goal", str(args.name));
      }
      case "removeOneTimeGoal": {
        if (!args.name) return bad("name");
        const ok = actions.removeOneTimeGoalByName(str(args.name));
        return ok
          ? { ok: true, message: `Removed goal "${str(args.name)}".` }
          : notFound("goal", str(args.name));
      }

      /* ── Scenarios + reset ─────────────────────────────────────────── */
      case "saveScenario": {
        if (!args.name) return bad("name");
        const ok = await actions.saveScenario(str(args.name));
        return ok
          ? { ok: true, message: `Saved scenario "${str(args.name)}".` }
          : {
              ok: false,
              error: `Could not save scenario "${str(args.name)}".`,
            };
      }
      case "loadScenario": {
        if (!args.name) return bad("name");
        const ok = await actions.loadScenarioByName(str(args.name));
        return ok
          ? { ok: true, message: `Loaded scenario "${str(args.name)}".` }
          : notFound("scenario", str(args.name));
      }
      case "resetAll": {
        actions.resetAll();
        return { ok: true, message: "Reset all parameters to defaults." };
      }

      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
