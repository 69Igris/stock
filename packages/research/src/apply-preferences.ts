/**
 * MONEY-222 - Apply user research preferences to a plan.
 *
 * Called by the agent after `planner.plan()` returns. Two responsibilities:
 *
 * 1. **Trim the plan** when the user picked Custom style:
 *    - Drop compute / analysis tasks whose tool is outside the union of
 *      tools owned by the user's selected skill IDs (see
 *      `SKILL_TOOL_ALLOWLIST`).
 *    - Keep ALL data-fetch tasks (cheap, parallel, useful as raw context).
 *    - Keep ALL synthesis tasks (the report itself).
 *    - Recompute `dependsOn` so a dropped compute task doesn't deadlock
 *      its consumers.
 *
 *    MONEY-792 - **then AUGMENT** the trimmed plan: the trim only ever
 *    REMOVES. On the trigger-matched path (a query matches a skill →
 *    `skill.buildPlan` builds the plan) a preset's EXTRA selected skills
 *    (e.g. the L4-only `risk-var-stress` VaR pack, or quant/regime when the
 *    matched skill didn't template them) are silently dropped — their tools
 *    were never in the plan, so the trim has nothing to keep. After trimming
 *    we therefore APPEND canonical tasks for any allow-listed tool the user
 *    selected that is still absent (see `augmentPlanWithSkills`).
 *
 * 2. **Stamp `researchFocus`** onto the plan + the synthesize task params.
 *    The synthesizer's user prompt (`buildSynthesizerUserPrompt`) reads
 *    this and prepends a directive so the report leans toward the user's
 *    recurring lens.
 *
 * If neither preference is set, the plan is returned untouched.
 */

import type { ResearchPlan, ResearchTask } from "./types";
import {
  buildAllowedToolSet,
  expandSkillAliases,
  SKILL_TOOL_ALLOWLIST,
  ALWAYS_KEEP_TOOLS,
} from "./skills/skill-tool-map";

export interface ResearchPreferenceHints {
  customSkills?: readonly string[];
  researchFocus?: string;
  /**
   * MONEY-219 - the research-type preset the user picked. Stamped on
   * `out.preset` so downstream consumers (UI, telemetry, dynamic
   * credits) know which template was used. Does NOT change task
   * filtering - the caller passes the preset's resolved skills via
   * `customSkills`.
   */
  preset?: string;
}

export function applyResearchPreferences(
  plan: ResearchPlan,
  hints: ResearchPreferenceHints,
): ResearchPlan {
  const out: ResearchPlan = { ...plan, tasks: [...plan.tasks] };

  if (hints.researchFocus && hints.researchFocus.trim()) {
    out.researchFocus = hints.researchFocus.trim();
  }

  if (hints.preset) {
    out.preset = hints.preset;
  }

  if (hints.customSkills && hints.customSkills.length > 0) {
    out.customSkills = [...hints.customSkills];
    const allowed = buildAllowedToolSet(hints.customSkills);

    // Drop compute / analysis tasks whose tool is not allowed. Data-fetch
    // tasks and synthesis tasks are unconditionally kept.
    const keptIds = new Set<string>();
    out.tasks = out.tasks.filter((t) => {
      if (t.type === "data_fetch" || t.type === "synthesis") {
        keptIds.add(t.id);
        return true;
      }
      // computation / analysis
      if (allowed.has(t.tool)) {
        keptIds.add(t.id);
        return true;
      }
      return false;
    });

    // Re-write dependsOn to drop references to tasks that were filtered
    // out - otherwise the executor will deadlock waiting for them.
    out.tasks = out.tasks.map((t) => ({
      ...t,
      dependsOn: t.dependsOn.filter((d) => keptIds.has(d)),
    }));

    // MONEY-792 - trim-then-AUGMENT. The trim only removes tasks already in
    // the plan; on the trigger-matched path a preset's extra skills (whose
    // tools were never templated by the matched skill) would be silently
    // lost. Append canonical tasks for any selected-skill tool still absent.
    out.tasks = augmentPlanWithSkills(out, hints.customSkills);

    out.estimatedSteps = out.tasks.length;
  }

  // Stamp researchFocus onto every synthesis task's params so the
  // synthesizer prompt builder can pick it up without a new threading.
  if (out.researchFocus) {
    out.tasks = out.tasks.map((t) =>
      t.type === "synthesis"
        ? {
            ...t,
            params: { ...t.params, researchFocus: out.researchFocus },
          }
        : t,
    );
  }

  return out;
}

// ─── MONEY-792 (C1a): augment a trimmed plan with the user's extra skills ──

/**
 * Tools whose result is consumed by the synthesizer as prose/sections but
 * that we never synthesise an explicit task for — they're the report itself
 * (`synthesize_report`/`compare_stocks`) or summarisers. Augment never
 * appends these.
 */
const NEVER_AUGMENT_TOOLS: ReadonlySet<string> = ALWAYS_KEEP_TOOLS;

/**
 * Tools that need a data-fetch upstream we can append on their behalf.
 * Keyed by compute tool → the fetch tool that produces its raw series, with
 * the static params that fetch needs. Used ONLY when the plan has no
 * existing task producing that data AND the data dep can be satisfied for
 * the plan's subject symbol. If a tool needs portfolio/holdings context that
 * only the server-action layer can inject (VaR / drawdown / beta / risk-
 * adjusted returns), it is NOT listed here — those compute tools self-inject
 * from injected holdings and degrade gracefully (available:false) with no
 * upstream task, so we append them dep-free rather than fabricate a fetch
 * that can't feed them.
 */
interface FetchSpec {
  /** The fetch tool that produces the compute tool's raw input. */
  fetchTool: string;
  /** Static params the fetch needs, templated with the subject symbol. */
  buildParams: (symbol: string) => Record<string, unknown>;
}

const COMPUTE_FETCH_DEPS: Record<string, FetchSpec> = {
  // Single-symbol technical / quant tools read the subject's own OHLCV.
  compute_factor_scores: {
    fetchTool: "fetch_price_history",
    buildParams: (symbol) => ({ symbol, period: "2y" }),
  },
  compute_volume_profile: {
    fetchTool: "fetch_price_history",
    buildParams: (symbol) => ({ symbol, period: "1y" }),
  },
  compute_trend_strength: {
    fetchTool: "fetch_price_history",
    buildParams: (symbol) => ({ symbol, period: "1y" }),
  },
  detect_breakout_setups: {
    fetchTool: "fetch_price_history",
    buildParams: (symbol) => ({ symbol, period: "1y" }),
  },
  compute_technical_analysis: {
    fetchTool: "fetch_price_history",
    buildParams: (symbol) => ({ symbol, period: "1y" }),
  },
  compute_volatility_regime: {
    fetchTool: "fetch_price_history",
    buildParams: (symbol) => ({ symbol, period: "1y" }),
  },
  compute_drawdown_profile: {
    fetchTool: "fetch_price_history",
    buildParams: (symbol) => ({ symbol, period: "1y" }),
  },
  compute_position_var: {
    fetchTool: "fetch_price_history",
    buildParams: (symbol) => ({ symbol, period: "1y" }),
  },
};

/**
 * Tools that depend on the OUTPUT of another compute tool. Keyed by tool →
 * the upstream compute tool(s) it consumes. We only chain the dependency
 * when that upstream is itself present (existing or just-appended); never
 * fabricate the upstream just to satisfy a chain (keeps the DAG honest and
 * lets the consumer degrade gracefully when its input is absent).
 */
const COMPUTE_COMPUTE_DEPS: Record<string, readonly string[]> = {
  // Risk-adjusted returns reads maxDrawdown off compute_drawdown.
  compute_risk_adjusted_returns: ["compute_drawdown"],
};

/**
 * Portfolio / holdings-context tools whose inputs are injected by the
 * executor / server-action layer (NOT a fetch_* task). With no portfolio
 * they degrade gracefully (available:false / success:false) — so they can be
 * appended dep-free without ever deadlocking. This is exactly how the
 * portfolio-risk-analysis skill wires them.
 */
const PORTFOLIO_CONTEXT_TOOLS: ReadonlySet<string> = new Set<string>([
  "compute_var",
  "compute_drawdown",
  "compute_beta",
  "compute_correlation_matrix",
  // compute_risk_adjusted_returns is handled via COMPUTE_COMPUTE_DEPS so it
  // chains onto an appended/existing compute_drawdown when present.
]);

/**
 * The ONLY tools augment will append. Deliberately conservative: a tool is
 * augmentable iff we can satisfy its inputs deterministically and safely —
 * either it self-injects from the server-action layer (PORTFOLIO_CONTEXT_TOOLS),
 * it needs a single subject-symbol OHLCV fetch we know how to template
 * (COMPUTE_FETCH_DEPS), or it chains off another compute we may add
 * (COMPUTE_COMPUTE_DEPS). Everything else (e.g. the multi-statement DCF /
 * fundamentals tools whose deps span several fetches wired through the
 * executor's legacy switch + declarative bindings) is SKIPPED — appending it
 * dep-free would starve it and emit garbage. The matched-skill / LLM-fallback
 * paths still build those when the query actually warrants them.
 */
const AUGMENTABLE_TOOLS: ReadonlySet<string> = new Set<string>([
  ...PORTFOLIO_CONTEXT_TOOLS,
  ...Object.keys(COMPUTE_FETCH_DEPS),
  ...Object.keys(COMPUTE_COMPUTE_DEPS),
]);

/** Stable, collision-proof id for an appended task. */
function augmentedTaskId(
  tool: string,
  existingIds: ReadonlySet<string>,
): string {
  const base = `aug_${tool}`;
  if (!existingIds.has(base)) return base;
  let i = 2;
  while (existingIds.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/**
 * MONEY-792 - Augment a (possibly trimmed) plan with canonical tasks for the
 * tools owned by the user's selected skills that are NOT already present.
 *
 * Why: `applyResearchPreferences` only ever TRIMS. On the trigger-matched
 * path the matched skill's `buildPlan` produced the tasks; a preset that
 * bundles EXTRA skills (e.g. `risk-var-stress`) contributes tools the matched
 * skill never templated, so there is nothing for the trim to keep and they
 * vanish. This adds them back.
 *
 * Contract (deterministic, deadlock-free, additive only):
 *   - Never adds a tool already present in `plan.tasks`.
 *   - Never adds an ALWAYS_KEEP tool (`synthesize_report` / `compare_stocks`
 *     / `generate_summary`) — those are the report, not a sub-step.
 *   - Only appends tools in AUGMENTABLE_TOOLS — a conservative set whose
 *     inputs we can satisfy deterministically. Multi-fetch fundamentals/DCF
 *     tools are intentionally NOT augmentable (appending them dep-free would
 *     starve them); they're skipped here and built by the matched-skill / LLM
 *     paths when the query warrants them.
 *   - For a compute tool that needs raw OHLCV (COMPUTE_FETCH_DEPS): reuse an
 *     existing producing fetch task if present, else append ONE fetch for the
 *     subject symbol and depend on it. If no subject symbol is known, SKIP
 *     the tool (can't satisfy its data dep → would deadlock/return garbage).
 *   - For a compute tool that chains off another compute (COMPUTE_COMPUTE_DEPS):
 *     depend on that upstream only if it is present (existing or appended);
 *     otherwise append the tool dep-free (it self-injects / degrades).
 *   - Portfolio/holdings-context tools (VaR, drawdown, beta, correlation,
 *     risk-adjusted returns) carry NO fetch dep here: the executor /
 *     server-action layer injects their portfolio inputs and they degrade
 *     gracefully (available:false) when no portfolio exists. Appended dep-free.
 *   - Synthesis tasks gain a dependsOn edge on every appended task so the
 *     report waits for them.
 *
 * Returns the new task array (does NOT mutate `plan.tasks`).
 */
export function augmentPlanWithSkills(
  plan: ResearchPlan,
  customSkills?: readonly string[],
): ResearchTask[] {
  if (!customSkills || customSkills.length === 0) return plan.tasks;

  const tasks: ResearchTask[] = [...plan.tasks];

  // Tools already represented in the plan (any task type).
  const presentTools = new Set(tasks.map((t) => t.tool));
  const existingIds = new Set(tasks.map((t) => t.id));

  // Desired compute/analysis tools = union of the selected skills' allow-lists
  // (v1 aliases expanded), minus the never-augment set. Deterministic order:
  // iterate skills in expansion order, tools in declared order.
  const expanded = expandSkillAliases(customSkills);
  const desiredTools: string[] = [];
  const seenDesired = new Set<string>();
  for (const skill of expanded) {
    const toolList = SKILL_TOOL_ALLOWLIST[skill];
    if (!toolList) continue;
    for (const tool of toolList) {
      if (seenDesired.has(tool)) continue;
      seenDesired.add(tool);
      desiredTools.push(tool);
    }
  }

  // The subject symbol for any data-fetch we may need to append.
  const subjectSymbol =
    plan.symbols && plan.symbols.length > 0 ? plan.symbols[0] : undefined;

  const appendedIds: string[] = [];

  for (const tool of desiredTools) {
    // Already in the plan (templated by the matched skill) — nothing to add.
    if (presentTools.has(tool)) continue;
    // Never synthesise the report / summariser tools.
    if (NEVER_AUGMENT_TOOLS.has(tool)) continue;
    // Standalone data fetches own their own io and are only useful here as a
    // DEPENDENCY of an appended compute tool (handled below). A skill's
    // allow-list can list fetch_* tools (e.g. fetch_news, fetch_macro_dashboard)
    // — appending them dangling would add cost with no compute consumer, so
    // we skip them. The matched skill already fetched what it computes over.
    if (tool.startsWith("fetch_")) continue;
    // Conservative gate: only append tools whose inputs we can satisfy
    // deterministically (see AUGMENTABLE_TOOLS). Anything else is skipped
    // rather than appended input-starved.
    if (!AUGMENTABLE_TOOLS.has(tool)) continue;

    // ── Resolve this tool's data dependency ────────────────────────────
    const fetchSpec = COMPUTE_FETCH_DEPS[tool];
    const computeDeps = COMPUTE_COMPUTE_DEPS[tool];
    const dependsOn: string[] = [];

    if (fetchSpec) {
      // Reuse an existing fetch of the same tool if present.
      const existingFetch = tasks.find(
        (t) => t.type === "data_fetch" && t.tool === fetchSpec.fetchTool,
      );
      if (existingFetch) {
        dependsOn.push(existingFetch.id);
      } else if (subjectSymbol) {
        // Append one fetch for the subject symbol, then depend on it.
        const fetchId = augmentedTaskId(fetchSpec.fetchTool, existingIds);
        const fetchTask: ResearchTask = {
          id: fetchId,
          type: "data_fetch",
          tool: fetchSpec.fetchTool,
          params: fetchSpec.buildParams(subjectSymbol),
          dependsOn: [],
          status: "pending",
        };
        tasks.push(fetchTask);
        existingIds.add(fetchId);
        presentTools.add(fetchSpec.fetchTool);
        appendedIds.push(fetchId);
        dependsOn.push(fetchId);
      } else {
        // No existing producer and no subject symbol to fetch for — we cannot
        // confidently satisfy this tool's data dep. SKIP it (graceful: never
        // produce a deadlocking / input-starved task).
        continue;
      }
    } else if (computeDeps) {
      // Chain off an upstream compute only when that upstream is present
      // (existing or appended above). Otherwise append dep-free — the tool
      // self-injects from the server-action layer and degrades gracefully.
      for (const up of computeDeps) {
        const upTask = tasks.find((t) => t.tool === up);
        if (upTask) dependsOn.push(upTask.id);
      }
    }
    // else: portfolio/holdings-context tool — appended dep-free; the executor
    // / server-action injects its inputs and it degrades gracefully.

    const id = augmentedTaskId(tool, existingIds);
    const newTask: ResearchTask = {
      id,
      // Detection tools are analysis; everything else here is computation.
      type: tool.startsWith("detect_") ? "analysis" : "computation",
      tool,
      params: buildSymbolParams(plan, subjectSymbol),
      dependsOn,
      status: "pending",
    };
    tasks.push(newTask);
    existingIds.add(id);
    presentTools.add(tool);
    appendedIds.push(id);
  }

  if (appendedIds.length === 0) return tasks;

  // Make every synthesis task wait for the appended tasks so the report is
  // built only after the new analyses complete.
  return tasks.map((t) =>
    t.type === "synthesis"
      ? {
          ...t,
          dependsOn: Array.from(new Set([...t.dependsOn, ...appendedIds])),
        }
      : t,
  );
}

/**
 * Best-effort symbol params for an appended compute task: carry the plan's
 * subject symbol (singular + plural) so symbol-scoped tools / declarative
 * bindings have it. Empty object when no symbol is known.
 */
function buildSymbolParams(
  plan: ResearchPlan,
  subjectSymbol: string | undefined,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (subjectSymbol) params.symbol = subjectSymbol;
  if (plan.symbols && plan.symbols.length > 0)
    params.symbols = [...plan.symbols];
  return params;
}
