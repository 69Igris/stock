import type { FireSnapshot } from "./systemPrompt";

/* =====================================================================
   FIRE chat — deterministic command parser  (StockSage integration)
   ---------------------------------------------------------------------
   Tier 1 of the "functions if possible, else LLM" backend: map an
   UNAMBIGUOUS single-intent FIRE command to the exact same tool-call
   shape the LLM tier produces — WITHOUT calling a model (free, ~sub-ms,
   zero credits).

   Design rule: PRECISION over recall. A wrong parse silently moves a real
   slider, which is worse than a slightly slower LLM answer — so anything
   compound, interrogative, hypothetical, or fuzzy falls through to the LLM
   (returns null). We only fast-path commands we can be sure about.

   Mirrors lib/chat-tools/intent-mapper.ts's `classifyIntentFast` idiom
   (regex table + param extractors), extended with snapshot-aware name
   resolution (assets/expenses/goals/scenarios are referenced by name, and
   those names only exist in the current plan).
   ===================================================================== */

export interface FireToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface FireParseResult {
  functionCalls: FireToolCall[];
  /** Which matcher fired — for telemetry / debugging the hit rate. */
  matcher: string;
}

/* ── number parsing ─────────────────────────────────────────────────── */

/**
 * Parse an INR amount from free text: "55 lakh" → 5500000, "1.2 cr" →
 * 12000000, "90k" → 90000, "₹15,000" → 15000, "1,80,000" → 180000,
 * "5000" → 5000. Returns null when there's no clean number.
 */
export function parseInrAmount(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s]/g, "").toLowerCase();
  const m = cleaned.match(
    /^(-?\d+(?:\.\d+)?)(crore|cr|lakhs?|lacs?|lakh|lac|l|thousand|k|million|mn|m)?$/,
  );
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  const mult =
    unit === "crore" || unit === "cr"
      ? 1e7
      : unit === "lakh" ||
          unit === "lakhs" ||
          unit === "lac" ||
          unit === "lacs" ||
          unit === "l"
        ? 1e5
        : unit === "thousand" || unit === "k"
          ? 1e3
          : unit === "million" || unit === "mn" || unit === "m"
            ? 1e6
            : 1;
  return n * mult;
}

/** Parse a bare percentage: "3.5%" / "3.5" → 3.5. */
function parsePercent(raw: string): number | null {
  const n = Number(raw.replace(/[%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/* ── ambiguity guard ────────────────────────────────────────────────── */

// If ANY of these trip, the command is not a clean single-intent absolute
// set — hand it to the LLM (which can reason, ask, and goal-seek).
// A clause-separating comma (","-then-non-digit) counts too: "set age 33,
// corpus 55L, …, save as X" is a multi-intent command that must NOT be
// fast-pathed as just the save. Number commas ("₹1,80,000") are ","-then-
// digit, so the negative lookahead leaves them alone.
const COMPOUND = /(\band\b|\balso\b|\bthen\b|\bplus\b|&|;|,\s*(?!\d))/i;
const QUESTION = /\?/;
const HYPOTHETICAL = /\bwhat\s*if\b|\bsuppose\b|\bimagine\b/i;
// Intent-only words with no unambiguous tool/value mapping.
const INTENT =
  /\b(conservative|aggressive|safer|riskier|risky|balanced|moderate|optimi[sz]e|rebalance|diversif|enough|on\s+track|run(?:ning)?\s+out|afford|retire\s+early|help\s+me|plan\s+(?:my|for))\b/i;
// Question / assessment phrasing.
const ASK =
  /\b(how|why|what|which|when|where|should|could|would|can\s+i|do\s+i|will\s+i|explain|is\s+my|am\s+i|are\s+my|tell\s+me|show\s+me)\b/i;
// RELATIVE modifiers — these would misparse as absolute values, so they must
// go to the LLM even when a number is present ("increase equity by 10",
// "10% more equity", "double my SIP"). Directional verbs alone (increase /
// reduce / bump …) are SAFE because our matchers read the explicit "to N"
// target; only the relative framing below is dangerous.
const RELATIVE =
  /\b(more|less|another|extra|additional|half|double|triple|twice|by\s+[\d.])\b/i;

// HARD guards mean "this is a question / multi-intent", full stop — checked
// even for scenario ops. SOFT guards (INTENT / RELATIVE) are checked AFTER the
// scenario matchers, because a scenario NAME may legitimately be "Aggressive"
// or "Conservative".
function isHardAmbiguous(text: string): boolean {
  return (
    COMPOUND.test(text) ||
    QUESTION.test(text) ||
    HYPOTHETICAL.test(text) ||
    ASK.test(text)
  );
}

function isSoftAmbiguous(text: string): boolean {
  return INTENT.test(text) || RELATIVE.test(text);
}

/* ── name resolution against the live plan ──────────────────────────── */

/** Longest snapshot name (case-insensitive, whole word-ish) present in text. */
function findName(text: string, names: string[]): string | null {
  const lower = text.toLowerCase();
  let best: string | null = null;
  for (const name of names) {
    const n = name.toLowerCase();
    // word-boundary-ish containment; longest wins ("Fixed Deposits" > "Fixed")
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(n)}(?:$|[^a-z0-9])`, "i");
    if (re.test(` ${lower} `) && (best === null || name.length > best.length)) {
      best = name;
    }
  }
  return best;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ── matchers ───────────────────────────────────────────────────────── */

interface Matcher {
  id: string;
  run: (text: string, snap: FireSnapshot) => FireToolCall[] | null;
}

const one = (name: string, args: Record<string, unknown>): FireToolCall[] => [
  { name, args },
];

// Scalar parameter setters keyed on a DISTINCTIVE phrase, so ordering +
// keyword anchoring keeps them from colliding (e.g. "retirement age" hits
// `retire` and never the bare-age matcher).
const PARAM_MATCHERS: Matcher[] = [
  {
    id: "retirementAge",
    run: (t) => {
      const m =
        t.match(/\bretire(?:ment)?\s+age\s+(?:to|=|is|as)?\s*(\d{2,3})\b/i) ||
        t.match(/\bretire\s+(?:at|by|in)\s+(?:age\s+)?(\d{2,3})\b/i) ||
        t.match(/\bretire(?:ment)?\s+(?:to|at|by)\s*(\d{2,3})\b/i);
      return m ? one("setRetirementAge", { age: Number(m[1]) }) : null;
    },
  },
  {
    id: "lifeExpectancy",
    run: (t) => {
      const m =
        t.match(/\blife\s*expectancy\s+(?:to|=|is|of)?\s*(\d{2,3})\b/i) ||
        t.match(/\blive\s+(?:till|until|to|up\s*to)\s+(?:age\s+)?(\d{2,3})\b/i);
      return m ? one("setLifeExpectancy", { age: Number(m[1]) }) : null;
    },
  },
  {
    id: "currentAge",
    run: (t) => {
      const m =
        t.match(/\b(?:my\s+)?current\s+age\s+(?:to|=|is)?\s*(\d{1,3})\b/i) ||
        t.match(/\bset\s+(?:my\s+)?age\s+(?:to|=)?\s*(\d{1,3})\b/i) ||
        t.match(/\b(?:i\s*am|i'?m)\s+(\d{2})\s*(?:years?\s*old|yo)?\b/i);
      return m ? one("setCurrentAge", { age: Number(m[1]) }) : null;
    },
  },
  {
    id: "currentCorpus",
    run: (t) => {
      const m = t.match(
        /\b(?:current\s+)?corpus\s+(?:to|=|is|of)?\s*₹?\s*([\d.,]+\s*(?:crore|cr|lakhs?|lacs?|lakh|lac|l|thousand|k|million|mn|m)?)\b/i,
      );
      if (!m) return null;
      const amount = parseInrAmount(m[1]!);
      return amount === null ? null : one("setCurrentCorpus", { amount });
    },
  },
  {
    id: "monthlySavings",
    run: (t) => {
      const m =
        t.match(
          /\b(?:monthly\s+savings?|sip)\s+(?:to|=|is|of)?\s*₹?\s*([\d.,]+\s*(?:crore|cr|lakhs?|lacs?|lakh|lac|l|thousand|k|million|mn|m)?)\b/i,
        ) ||
        t.match(
          /\bsave\s+₹?\s*([\d.,]+\s*(?:lakhs?|lacs?|lakh|lac|l|thousand|k)?)\s*(?:per|a|\/)\s*month\b/i,
        );
      if (!m) return null;
      const amount = parseInrAmount(m[1]!);
      return amount === null ? null : one("setMonthlySavings", { amount });
    },
  },
  {
    id: "safeWithdrawalRate",
    run: (t) => {
      const m =
        t.match(
          /\b(?:safe\s+)?withdrawal\s+rate\s+(?:to|=|is|of)?\s*([\d.]+)\s*%?/i,
        ) ||
        t.match(/\bswr\s+(?:to|=|is|of)?\s*([\d.]+)\s*%?/i) ||
        t.match(/\bwithdraw\s+(?:only\s+)?([\d.]+)\s*%/i);
      const p = m ? parsePercent(m[1]!) : null;
      return p === null ? null : one("setSafeWithdrawalRate", { percent: p });
    },
  },
  {
    id: "taxRate",
    run: (t) => {
      const m = t.match(
        /\btax\s+rate\s+(?:to|=|is|of|on\s+withdrawals?)?\s*([\d.]+)\s*%?/i,
      );
      const p = m ? parsePercent(m[1]!) : null;
      return p === null ? null : one("setTaxRate", { percent: p });
    },
  },
  {
    id: "salaryIncrement",
    run: (t) => {
      const m = t.match(
        /\bsalary\s+(?:increment|hike|increase|growth|raise)\s+(?:to|=|is|of)?\s*([\d.]+)\s*%?/i,
      );
      const p = m ? parsePercent(m[1]!) : null;
      return p === null ? null : one("setSalaryIncrement", { percent: p });
    },
  },
  {
    id: "savingsIncrement",
    run: (t) => {
      const m = t.match(
        /\bsavings?\s+(?:increment|step[-\s]?up|increase|growth)\s+(?:to|=|is|of)?\s*([\d.]+)\s*%?/i,
      );
      const p = m ? parsePercent(m[1]!) : null;
      return p === null ? null : one("setSavingsIncrement", { percent: p });
    },
  },
];

// Collection matchers resolve names against the CURRENT plan snapshot.
const COLLECTION_MATCHERS: Matcher[] = [
  {
    id: "assetReturn",
    run: (t, snap) => {
      if (!/\b(return|expected\s+return|yield)\b/i.test(t)) return null;
      const name = findName(
        t,
        snap.assetClasses.map((a) => a.name),
      );
      const m = t.match(/([\d.]+)\s*%/);
      const p = m ? parsePercent(m[1]!) : null;
      return name && p !== null
        ? one("updateAssetReturn", { name, expectedReturn: p })
        : null;
    },
  },
  {
    id: "assetAllocation",
    run: (t, snap) => {
      const name = findName(
        t,
        snap.assetClasses.map((a) => a.name),
      );
      if (!name) return null;
      // "equity to 60%" / "equity 60%" / "equity allocation 60"
      const m =
        t.match(/(?:to|at|=|:)\s*([\d.]+)\s*%/) || t.match(/\b([\d.]+)\s*%/);
      const p = m ? parsePercent(m[1]!) : null;
      return p === null
        ? null
        : one("updateAssetAllocation", { name, allocation: p });
    },
  },
  {
    id: "removeAsset",
    run: (t, snap) => {
      if (!/\b(remove|delete|drop|get\s+rid\s+of)\b/i.test(t)) return null;
      const name = findName(
        t,
        snap.assetClasses.map((a) => a.name),
      );
      return name ? one("removeAssetClass", { name }) : null;
    },
  },
  {
    id: "removeExpense",
    run: (t, snap) => {
      if (!/\b(remove|delete|drop)\b/i.test(t)) return null;
      const category = findName(
        t,
        snap.expenses.map((e) => e.category),
      );
      return category ? one("removeExpense", { category }) : null;
    },
  },
  {
    id: "expenseInflation",
    run: (t, snap) => {
      if (!/\binflation\b/i.test(t)) return null;
      const category = findName(
        t,
        snap.expenses.map((e) => e.category),
      );
      const m = t.match(/([\d.]+)\s*%/);
      const p = m ? parsePercent(m[1]!) : null;
      return category && p !== null
        ? one("updateExpense", { category, inflation: p })
        : null;
    },
  },
  {
    id: "expenseAmount",
    run: (t, snap) => {
      const category = findName(
        t,
        snap.expenses.map((e) => e.category),
      );
      if (!category) return null;
      const m = t.match(
        /(?:to|at|=|:)\s*₹?\s*([\d.,]+\s*(?:lakhs?|lacs?|lakh|lac|l|thousand|k)?)\b/i,
      );
      const amount = m ? parseInrAmount(m[1]!) : null;
      return amount === null
        ? null
        : one("updateExpense", { category, amount });
    },
  },
  {
    id: "removeGoal",
    run: (t, snap) => {
      if (!/\b(remove|delete|drop|cancel)\b/i.test(t)) return null;
      const name = findName(
        t,
        snap.oneTimeGoals.map((g) => g.name),
      );
      return name ? one("removeOneTimeGoal", { name }) : null;
    },
  },
];

const CONTROL_MATCHERS: Matcher[] = [
  {
    id: "reset",
    run: (t) =>
      /\b(reset\s+(?:everything|all|to\s+defaults?|the\s+plan)|reset|start\s+over|clear\s+everything)\b/i.test(
        t,
      ) && !/\bdon'?t\b/i.test(t)
        ? one("resetAll", {})
        : null,
  },
  {
    id: "saveScenario",
    run: (t) => {
      const m =
        t.match(
          /\bsave\s+(?:this|it|the\s+plan)?\s*(?:as|scenario|under)\s+["']?([^"']{1,60}?)["']?\s*$/i,
        ) || t.match(/\bsave\s+scenario\s+["']?([^"']{1,60}?)["']?\s*$/i);
      const name = m?.[1]?.trim();
      return name ? one("saveScenario", { name }) : null;
    },
  },
  {
    id: "loadScenario",
    run: (t, snap) => {
      if (!/\b(load|switch\s+to|open|use|go\s+to)\b/i.test(t)) return null;
      const name = findName(
        t,
        snap.savedScenarios.map((s) => s.name),
      );
      return name ? one("loadScenario", { name }) : null;
    },
  },
];

// Order: params → collections → control. Each matcher anchors on distinct
// keywords, so first-match wins is safe.
const ALL_MATCHERS: Matcher[] = [
  ...PARAM_MATCHERS,
  ...COLLECTION_MATCHERS,
  ...CONTROL_MATCHERS,
];

/**
 * Deterministically parse a single-intent FIRE command. Returns the tool
 * call(s) to execute (same shape as the LLM tier), or null to fall through
 * to the LLM. Conservative: bails on any compound/interrogative/fuzzy input.
 */
export function parseFireCommand(
  text: string,
  snapshot: FireSnapshot,
): FireParseResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Questions / compound / hypotheticals are never fast-pathed, even for
  // scenario ops ("should I use my aggressive plan?" is advice, not a load).
  if (isHardAmbiguous(trimmed)) return null;

  // Scenario ops first — their user-defined names may contain the SOFT
  // guard words (a scenario literally called "Aggressive"), so they must
  // resolve before that guard runs.
  const scenarioIds = new Set(["saveScenario", "loadScenario"]);
  for (const matcher of CONTROL_MATCHERS) {
    if (!scenarioIds.has(matcher.id)) continue;
    const calls = matcher.run(trimmed, snapshot);
    if (calls) return { functionCalls: calls, matcher: matcher.id };
  }

  // Fuzzy intent / relative modifiers with no clean value → LLM.
  if (isSoftAmbiguous(trimmed)) return null;

  for (const matcher of ALL_MATCHERS) {
    if (scenarioIds.has(matcher.id)) continue; // already tried
    const calls = matcher.run(trimmed, snapshot);
    if (calls) return { functionCalls: calls, matcher: matcher.id };
  }
  return null;
}
