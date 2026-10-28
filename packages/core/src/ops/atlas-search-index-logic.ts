/**
 * Planning the Atlas search-index applier. MONEY-1499 (B8).
 *
 * PURE — no Mongo, no filesystem. `scripts/ops/apply-atlas-search-indexes.ts`
 * is the I/O shell. The manifest is `scripts/ops/atlas-search-indexes.json`.
 */

import {
  checkVectorIndexField,
  type VectorDtype,
  type VectorIndexField,
} from "../embeddings-int8-logic";

export type ManageMode = "apply" | "verify-only" | "probe";

export interface IndexSpec {
  readonly collection: string;
  readonly name: string;
  readonly type: "vectorSearch";
  readonly manage: ManageMode;
  readonly dtype: VectorDtype;
  readonly definition: { readonly fields: readonly VectorIndexField[] };
}

const MANAGE_MODES: readonly ManageMode[] = ["apply", "verify-only", "probe"];

function fail(where: string, why: string): never {
  throw new Error(`atlas-search-indexes.json: ${where} ${why}`);
}

/**
 * Reads the manifest and REFUSES anything it cannot fully understand.
 *
 * An unrecognised `manage` value is fatal rather than defaulted, for the same
 * reason `layerOf()` in the lake DDL applier throws: a default is how a spec
 * that means "do not touch the live 67 GiB index" turns into a rebuild.
 */
export function parseIndexManifest(raw: unknown): IndexSpec[] {
  const indexes = (raw as { indexes?: unknown })?.indexes;
  if (!Array.isArray(indexes) || indexes.length === 0) {
    fail("top level", "must carry a non-empty `indexes` array");
  }
  return indexes.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    const where = `indexes[${i}]`;
    if (typeof e.collection !== "string" || !e.collection)
      fail(where, "needs a `collection`");
    if (typeof e.name !== "string" || !e.name) fail(where, "needs a `name`");
    if (e.type !== "vectorSearch")
      fail(where, 'only `type: "vectorSearch"` is supported');
    if (
      typeof e.manage !== "string" ||
      !MANAGE_MODES.includes(e.manage as ManageMode)
    ) {
      fail(
        where,
        `\`manage\` must be one of ${MANAGE_MODES.join(" | ")}, got ${JSON.stringify(e.manage)}`,
      );
    }
    const dtype = e.dtype;
    if (
      dtype !== "int8" &&
      dtype !== "int1" &&
      dtype !== "float32" &&
      dtype !== "array"
    ) {
      fail(
        where,
        `\`dtype\` must be int8 | int1 | float32 | array, got ${JSON.stringify(dtype)}`,
      );
    }
    const def = e.definition as { fields?: unknown } | undefined;
    if (!def || !Array.isArray(def.fields) || def.fields.length === 0) {
      fail(where, "needs a `definition.fields` array");
    }
    return {
      collection: e.collection,
      name: e.name,
      type: "vectorSearch",
      manage: e.manage as ManageMode,
      dtype,
      definition: { fields: def.fields as readonly VectorIndexField[] },
    };
  });
}

/**
 * Every `type: "vector"` field in a spec, checked against the rules for the
 * dtype the collection actually stores. Returns the problems for ALL fields —
 * a definition rejected one fault at a time is one index rebuild per fault.
 */
export function validateSpec(spec: IndexSpec): readonly string[] {
  const problems: string[] = [];
  let vectorFields = 0;
  for (const field of spec.definition.fields) {
    if (field.type !== "vector") continue;
    vectorFields++;
    const dims =
      typeof field.numDimensions === "number" ? field.numDimensions : NaN;
    const check = checkVectorIndexField(field, { dtype: spec.dtype, dims });
    if (!check.ok)
      problems.push(...check.problems.map((p) => `${spec.name}: ${p}`));
  }
  if (vectorFields === 0)
    problems.push(`${spec.name}: no field of type "vector"`);
  return problems;
}

/** Order-insensitive for field arrays; a filter field's position carries nothing. */
export function definitionsEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).sort().join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .sort()
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export type IndexAction = "create" | "update" | "noop" | "drift";

export interface IndexPlan {
  readonly spec: IndexSpec;
  readonly action: IndexAction;
  readonly reason: string;
}

export interface LiveIndex {
  readonly name: string;
  readonly latestDefinition?: unknown;
  readonly status?: string;
  readonly queryable?: boolean;
}

/**
 * What to do about one declared index, given what the cluster reports.
 *
 * `drift` is a FOURTH state and not a flavour of `update`: it is what a
 * `verify-only` index reports when it differs, and it must be visible without
 * being acted on. Collapsing it into `noop` would hide a live index that no
 * longer matches the file; collapsing it into `update` would rebuild the index
 * the research agent is querying.
 */
export function planIndex(spec: IndexSpec, live: LiveIndex | null): IndexPlan {
  const same = live
    ? definitionsEqual(spec.definition, live.latestDefinition)
    : false;
  if (spec.manage === "verify-only") {
    if (!live)
      return {
        spec,
        action: "drift",
        reason: "declared here, ABSENT on the cluster",
      };
    return same
      ? { spec, action: "noop", reason: "matches the cluster" }
      : {
          spec,
          action: "drift",
          reason: "differs from the cluster — NOT corrected (verify-only)",
        };
  }
  if (!live) return { spec, action: "create", reason: "absent on the cluster" };
  if (same) return { spec, action: "noop", reason: "matches the cluster" };
  return { spec, action: "update", reason: "definition differs" };
}

/** Exit 3 on drift, matching `scripts/ops/datadog/*.sh --only=verify`. */
export const EXIT_DRIFT = 3;

export function verdictFor(plans: readonly IndexPlan[]): {
  exitCode: number;
  summary: string;
} {
  const drift = plans.filter((p) => p.action === "drift");
  const changed = plans.filter(
    (p) => p.action === "create" || p.action === "update",
  );
  const summary =
    `${plans.length} declared — ${changed.length} to write, ${drift.length} drifted, ` +
    `${plans.filter((p) => p.action === "noop").length} already correct`;
  return { exitCode: drift.length > 0 ? EXIT_DRIFT : 0, summary };
}
