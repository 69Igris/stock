/**
 * Does this environment actually HAVE the unique indexes its writers assume?
 *
 * ## Why this exists (MONEY-1485)
 *
 * `putCandles` is written to absorb a concurrent insert: a `createMany` that
 * collides is caught, the chunk falls back to per-row inserts, and
 * `classifyCandleRowWriteError` counts a duplicate as a NO-OP rather than a
 * failure. That is correct — on ONE condition, that the four-part unique index
 * exists.
 *
 * In QA it did not. Duplicates were already present when the `@@unique` was
 * added, so `prisma db push` could not build
 * `candles_symbol_exchange_timeframe_ts_key`; the index was never created; and
 * the collision the code is written to absorb NEVER HAPPENED. Every duplicate
 * inserted cleanly and was counted as `created` — a green run writing exactly
 * the rows its own uniqueness contract forbids. It surfaced through a
 * developer's local `yarn dev`, not through a monitor, a test or a job outcome.
 *
 * And `prisma db push` is the ONLY thing that creates these indexes, and it is
 * a DEVELOPER action: it appears in `turbo.json` and in hand-run setup scripts,
 * and in NO deploy pipeline. So a deployed environment can run indefinitely
 * without an index its writers depend on, and nothing anywhere says so.
 *
 * This module is the decision, and it is PURE for the reason MONEY-1481 learned
 * the hard way: the dedupe's survivor rule lived inside a script, `scripts/**`
 * compiles as CJS, and a named export from a script is invisible to an ESM
 * test — so the rule that decided which row to DELETE could not be executed by
 * anything that checked it. A guard nothing can execute is a guard nothing can
 * check.
 */

/** One `@@unique` from the schema, resolved to database names. */
export interface UniqueConstraint {
  /** Prisma model name — for the message a human reads. */
  readonly model: string;
  /** The `@@map`ped collection name — what actually exists in Mongo. */
  readonly collection: string;
  /** `@map`ped field names, in declared order. */
  readonly fields: readonly string[];
}

/** One row of Mongo's `listIndexes` reply, narrowed to what decides this. */
export interface ObservedIndex {
  readonly name: string;
  readonly key: Readonly<Record<string, number>>;
  readonly unique?: boolean;
  readonly sparse?: boolean;
  readonly partialFilterExpression?: unknown;
}

/**
 * Four states, and the last two are the point of having four rather than a
 * boolean.
 *
 *   OK                a unique index enforces exactly these fields
 *   MISSING           it does not — this is the MONEY-1481 state
 *   WEAKENED          an index on the right fields exists, is `unique`, and
 *                     enforces LESS than it claims (sparse / partial). It reads
 *                     as healthy in every listing that only asks "is there a
 *                     unique index on these fields?"
 *   COLLECTION_ABSENT the namespace does not exist. NOT a fault: no row can
 *                     violate a constraint in a collection nothing has ever
 *                     written to. Collapsing this into MISSING would make every
 *                     environment fail for every model it legitimately does not
 *                     use yet, which is how a guard gets muted.
 */
export type IndexVerdict = "OK" | "MISSING" | "WEAKENED" | "COLLECTION_ABSENT";

export interface IndexFinding {
  readonly model: string;
  readonly collection: string;
  readonly fields: readonly string[];
  readonly verdict: IndexVerdict;
  /** Why, in the words the operator needs. Never empty. */
  readonly detail: string;
}

/**
 * Is `index` the unique index that enforces `fields`?
 *
 * MATCHED AS A SET, NOT A SEQUENCE, and that is deliberate. A unique index on
 * `{a:1, b:1}` and one on `{b:1, a:1}` enforce the IDENTICAL constraint — the
 * order changes which queries the index can serve, and changes nothing about
 * uniqueness. Prisma happens to create them in declared order, so a sequence
 * comparison would agree today and would report a false MISSING the first time
 * an index is rebuilt by hand in a different order. A false MISSING on a
 * correct database is how an alarm gets turned off.
 *
 * Direction is ignored for the same reason: `-1` enforces what `1` enforces.
 */
function enforcesFields(
  index: ObservedIndex,
  fields: readonly string[],
): boolean {
  const keyFields = Object.keys(index.key);
  if (keyFields.length !== fields.length) return false;
  const wanted = new Set(fields);
  if (wanted.size !== fields.length) return false; // duplicate field: not a real constraint
  return keyFields.every((k) => wanted.has(k));
}

/**
 * An index that is `unique` but SPARSE or PARTIAL does not enforce the whole
 * constraint — it exempts the documents its filter excludes. On Mongo a sparse
 * unique index lets any number of documents MISSING the field coexist, and a
 * partial one lets any number outside the filter coexist.
 *
 * This repo has already been bitten by the same shape one layer up: a Mongo
 * `db push` creates indexes and not fields, so an attribute is ABSENT rather
 * than null on pre-existing rows — which is exactly the population a sparse
 * index stops covering. So "there is a unique index on those fields" is not the
 * question; "does it cover every row" is.
 */
function isWeakened(index: ObservedIndex): boolean {
  return index.sparse === true || index.partialFilterExpression !== undefined;
}

/**
 * Judge ONE constraint against what the database actually reports.
 *
 * `indexes === null` means the collection does not exist. That is a DIFFERENT
 * answer from "the collection exists and has no such index", and the caller is
 * responsible for telling them apart — `listIndexes` on a missing namespace
 * errors rather than returning `[]`, so a caller that swallows the error into
 * an empty array turns a healthy unused model into a failure.
 */
export function judgeConstraint(
  constraint: UniqueConstraint,
  indexes: readonly ObservedIndex[] | null,
): IndexFinding {
  const base = {
    model: constraint.model,
    collection: constraint.collection,
    fields: constraint.fields,
  };
  const spec = `(${constraint.fields.join(", ")})`;

  if (indexes === null) {
    return {
      ...base,
      verdict: "COLLECTION_ABSENT",
      detail:
        `collection "${constraint.collection}" does not exist in this ` +
        "environment — nothing has been written to it, so no row can violate " +
        `${spec}. Not a fault.`,
    };
  }

  const matching = indexes.filter((i) => enforcesFields(i, constraint.fields));

  if (matching.length === 0) {
    return {
      ...base,
      verdict: "MISSING",
      detail:
        `NO index on ${spec} in "${constraint.collection}". The schema declares ` +
        "this @@unique and the database does not enforce it, so duplicate rows " +
        "insert cleanly and are counted as created. Run `prisma db push` " +
        "against THIS environment — and if it fails, the collection already " +
        "holds the duplicates that stop the index building.",
    };
  }

  const unique = matching.filter((i) => i.unique === true);
  if (unique.length === 0) {
    const names = matching.map((i) => i.name).join(", ");
    return {
      ...base,
      verdict: "MISSING",
      detail:
        `an index on ${spec} exists (${names}) but is NOT unique, so it ` +
        "enforces nothing. A non-unique index on the same fields is the most " +
        "misleading possible state: every listing shows an index there.",
    };
  }

  const sound = unique.filter((i) => !isWeakened(i));
  if (sound.length === 0) {
    const how = unique
      .map((i) => `${i.name} (${i.sparse === true ? "sparse" : "partial"})`)
      .join(", ");
    return {
      ...base,
      verdict: "WEAKENED",
      detail:
        `the unique index on ${spec} is ${how} — it exempts the documents its ` +
        "filter excludes, so the constraint holds for some rows and not " +
        "others. A Mongo `db push` creates indexes and not FIELDS, so rows " +
        "predating a column have it ABSENT, which is precisely the population " +
        "a sparse index stops covering.",
    };
  }

  return {
    ...base,
    verdict: "OK",
    detail: `enforced by ${sound.map((i) => i.name).join(", ")}`,
  };
}

export interface IndexAudit {
  readonly findings: readonly IndexFinding[];
  readonly ok: number;
  readonly missing: number;
  readonly weakened: number;
  readonly collectionAbsent: number;
  /** MISSING + WEAKENED. The number that decides an exit code. */
  readonly failing: number;
  /**
   * `null` when the audit is sound. A STRING when the audit itself could not be
   * trusted — see `auditIndexes`.
   */
  readonly refusal: string | null;
}

/**
 * Audit every constraint.
 *
 * ## An empty expectation set is a REFUSAL, not a pass
 *
 * If `constraints` is empty the obvious summary is `missing: 0`, which reads as
 * a healthy database for ever. It is not — it means the schema was never read.
 * This repo has shipped that defect repeatedly (`FILL_MIN_POPULATION` exists
 * because two counts compared with `>=` make an EMPTY population read OK
 * permanently), so the empty case gets its own answer rather than the healthy
 * one. NOT MEASURED IS NOT PASSED.
 */
export function auditIndexes(
  constraints: readonly UniqueConstraint[],
  indexesByCollection: ReadonlyMap<string, readonly ObservedIndex[] | null>,
): IndexAudit {
  if (constraints.length === 0) {
    return {
      findings: [],
      ok: 0,
      missing: 0,
      weakened: 0,
      collectionAbsent: 0,
      failing: 0,
      refusal:
        "NO unique constraints were read from the schema. That is not a clean " +
        "database, it is an audit that never ran — a zero here would otherwise " +
        "report healthy for ever.",
    };
  }

  // `undefined` (never looked up) and `null` (looked up, found absent) must not
  // be the same thing, and making that distinction is not optional here: a
  // collection the caller forgot to query would otherwise be judged
  // COLLECTION_ABSENT, which is the HEALTHY verdict. An incomplete audit would
  // then read as a clean one — the same not-measured-is-not-passed shape the
  // empty-constraints refusal above exists for, one level down.
  const unqueried = constraints
    .map((c) => c.collection)
    .filter((name) => !indexesByCollection.has(name));

  if (unqueried.length > 0) {
    const named = [...new Set(unqueried)].sort();
    return {
      findings: [],
      ok: 0,
      missing: 0,
      weakened: 0,
      collectionAbsent: 0,
      failing: 0,
      refusal:
        `${named.length} collection(s) were never looked up: ` +
        `${named.join(", ")}. Judging them absent would report them healthy, ` +
        "so the whole audit is refused rather than partly believed.",
    };
  }

  const findings = constraints.map((c) =>
    judgeConstraint(c, indexesByCollection.get(c.collection) ?? null),
  );

  const count = (v: IndexVerdict): number =>
    findings.filter((f) => f.verdict === v).length;

  const missing = count("MISSING");
  const weakened = count("WEAKENED");

  return {
    findings,
    ok: count("OK"),
    missing,
    weakened,
    collectionAbsent: count("COLLECTION_ABSENT"),
    failing: missing + weakened,
    refusal: null,
  };
}

/** The shape `Prisma.dmmf.datamodel.models` gives us, narrowed to what we read. */
export interface DmmfModelLike {
  readonly name: string;
  readonly dbName?: string | null;
  readonly fields: ReadonlyArray<{
    readonly name: string;
    readonly dbName?: string | null;
  }>;
  readonly uniqueIndexes?: ReadonlyArray<{
    readonly name?: string | null;
    readonly fields: readonly string[];
  }>;
}

/**
 * Turn the generated datamodel into the constraints to check.
 *
 * Resolved to DATABASE names on both axes — `@@map` for the collection and
 * `@map` for each field — because that is what `listIndexes` answers in. A
 * comparison of Prisma names against Mongo names silently matches nothing and
 * reports every constraint MISSING, which is the false-alarm direction that
 * gets a guard deleted.
 */
export function uniqueConstraintsFromDmmf(
  models: readonly DmmfModelLike[],
): UniqueConstraint[] {
  const out: UniqueConstraint[] = [];
  for (const model of models) {
    const collection = model.dbName ?? model.name;
    const dbField = new Map(
      model.fields.map((f) => [f.name, f.dbName ?? f.name]),
    );
    for (const unique of model.uniqueIndexes ?? []) {
      out.push({
        model: model.name,
        collection,
        fields: unique.fields.map((f) => dbField.get(f) ?? f),
      });
    }
  }
  return out;
}

/** One line per failing constraint, plus a summary. Empty when nothing fails. */
export function formatIndexAudit(audit: IndexAudit): string {
  if (audit.refusal !== null) return `REFUSED: ${audit.refusal}`;

  const lines = audit.findings
    .filter((f) => f.verdict === "MISSING" || f.verdict === "WEAKENED")
    .map((f) => `  [${f.verdict}] ${f.model} -> ${f.collection}: ${f.detail}`);

  const summary =
    `${audit.ok} enforced, ${audit.missing} MISSING, ` +
    `${audit.weakened} WEAKENED, ${audit.collectionAbsent} collection(s) absent`;

  return lines.length === 0 ? summary : `${summary}\n${lines.join("\n")}`;
}
