/**
 * Ask THIS database which of the schema's unique constraints it actually
 * enforces. The decision lives in `index-guard-logic.ts`; this file only
 * gathers the two inputs.
 *
 * See that module's header for why this exists (MONEY-1485).
 */

import {
  auditIndexes,
  uniqueConstraintsFromDmmf,
  type DmmfModelLike,
  type IndexAudit,
  type ObservedIndex,
} from "./index-guard-logic";

/**
 * Collections this audit deliberately does not reach, and why.
 *
 * Empty today. It exists as the named place for an exemption, because the
 * alternative — quietly narrowing the constraint list when something fails —
 * is how a guard stops covering what it claims to.
 */
const EXEMPT_COLLECTIONS: ReadonlySet<string> = new Set();

/**
 * The whole surface this audit needs from a Prisma client.
 *
 * Narrowed to one method on purpose. It lets an operator script point the audit
 * at ANOTHER environment (the shared `prisma` singleton binds to
 * `process.env.DATABASE_URL` at import, so an audit that could only use it
 * could only ever audit the environment it was already running in — which, for
 * a defect whose whole shape is "QA and prod disagree about what exists", is
 * the one thing it must not be limited to). It also lets the tests drive a
 * fake, so the gathering code is EXECUTED rather than scanned.
 */
export interface RawCommandRunner {
  $runCommandRaw(command: Record<string, unknown>): Promise<unknown>;
}

interface ListCollectionsReply {
  readonly cursor?: {
    readonly id?: unknown;
    readonly firstBatch?: ReadonlyArray<{ readonly name?: unknown }>;
  };
}

interface ListIndexesReply {
  readonly cursor?: {
    readonly id?: unknown;
    readonly firstBatch?: readonly unknown[];
  };
}

/** Mongo returns the cursor id as a number, a bigint, or `{ $numberLong }`. */
function cursorIsExhausted(id: unknown): boolean {
  if (id === undefined || id === null) return true;
  if (typeof id === "number") return id === 0;
  if (typeof id === "bigint") return id === 0n;
  if (typeof id === "string") return id === "0";
  if (typeof id === "object") {
    const long = (id as { $numberLong?: unknown }).$numberLong;
    if (typeof long === "string") return long === "0";
  }
  return false;
}

/**
 * An index direction, or `null` when the value is not a direction at all.
 *
 * `$runCommandRaw` answers in EXTENDED JSON, so a `1` can arrive as a plain
 * number OR as `{ "$numberInt": "1" }` / `{ "$numberDouble": "1.0" }` /
 * `{ "$numberLong": "1" }` depending on how the driver encoded it — the same
 * encoding `cursorIsExhausted` above already has to handle for the cursor id,
 * and the same class that made MONEY-1481's dedupe compare `"[object Object]"`
 * against itself.
 *
 * Reading only plain numbers would drop a REAL unique index whose directions
 * came back wrapped, and the verdict for a dropped index is MISSING — a false
 * alarm on a correct database, which is the direction that gets a guard
 * switched off.
 *
 * A STRING direction (`"text"`, `"2dsphere"`, `"hashed"`) is still refused:
 * those never enforce a compound unique constraint, and coercing one to a
 * number would make it look as though it might.
 */
function toIndexDirection(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value && typeof value === "object") {
    const wrapper = value as Record<string, unknown>;
    for (const k of ["$numberInt", "$numberLong", "$numberDouble"] as const) {
      const inner = wrapper[k];
      if (typeof inner === "string" || typeof inner === "number") {
        const n = Number(inner);
        return Number.isFinite(n) ? n : null;
      }
    }
  }
  return null;
}

function toObservedIndex(raw: unknown): ObservedIndex | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = r.name;
  const key = r.key;
  if (typeof name !== "string" || !key || typeof key !== "object") return null;

  const numericKey: Record<string, number> = {};
  for (const [field, dir] of Object.entries(key as Record<string, unknown>)) {
    const direction = toIndexDirection(dir);
    if (direction === null) return null;
    numericKey[field] = direction;
  }

  return {
    name,
    key: numericKey,
    unique: r.unique === true,
    sparse: r.sparse === true,
    partialFilterExpression: r.partialFilterExpression,
  };
}

/**
 * The collections that exist, or `null` if the answer cannot be trusted.
 *
 * A TRUNCATED `firstBatch` is refused rather than used. This repo has already
 * been caught by that exact shape once — a partial `cursor.firstBatch`
 * manufactured gaps that looked like missing data (MONEY-1189) — and here the
 * consequence is worse than a gap: every collection past the batch boundary
 * would be judged COLLECTION_ABSENT, i.e. reported as healthy-and-unused when
 * it may be neither.
 */
async function existingCollections(
  client: RawCommandRunner,
): Promise<Set<string> | null> {
  const reply = (await client.$runCommandRaw({
    listCollections: 1,
    nameOnly: true,
  })) as unknown as ListCollectionsReply;

  const batch = reply.cursor?.firstBatch;
  if (!Array.isArray(batch)) return null;
  if (!cursorIsExhausted(reply.cursor?.id)) return null;

  const names = new Set<string>();
  for (const entry of batch) {
    if (entry && typeof entry.name === "string") names.add(entry.name);
  }
  return names;
}

async function indexesOf(
  client: RawCommandRunner,
  collection: string,
): Promise<ObservedIndex[]> {
  const reply = (await client.$runCommandRaw({
    listIndexes: collection,
  })) as unknown as ListIndexesReply;

  const batch = reply.cursor?.firstBatch;
  if (!Array.isArray(batch)) return [];

  const out: ObservedIndex[] = [];
  for (const raw of batch) {
    const parsed = toObservedIndex(raw);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/**
 * Audit every `@@unique` in the generated datamodel against the live database.
 *
 * Reads the DMMF rather than parsing `schema.prisma`: the generated client is
 * what the WRITERS were built from, so it is the same source of truth they are.
 * A separate parse of the schema file could disagree with the client the code
 * actually runs against, which is a second source of truth for the one fact
 * this whole guard turns on.
 */
export async function auditDatabaseIndexes(
  client?: RawCommandRunner,
  models?: readonly DmmfModelLike[],
): Promise<IndexAudit> {
  // LAZY, and that is load-bearing rather than tidy. `@usemoney/database`
  // builds its PrismaClient at MODULE scope from `process.env.DATABASE_URL`
  // (`client.ts:40-47`), and ESM evaluates every static import before ANY
  // statement in the importing module's body. A static import here would
  // therefore pin the client BEFORE an ops script's `main()` has parsed
  // `--env qa|prod` — so `--env prod` would be silently ignored while the
  // confirmation echoed the host `--env` resolved. That exact defect is what
  // `ops-script-db-target.test.ts` exists to prevent, and this module is
  // reached by `scripts/ops/verify-db-indexes.ts`, which takes `--env`.
  //
  // Deferring it also means importing this module costs no database client at
  // all, which is why the suite can drive it with a fake and no DATABASE_URL.
  const load = async (): Promise<typeof import("@usemoney/database")> =>
    import("@usemoney/database");

  const runner = client ?? (await load()).prisma;
  const modelList =
    models ??
    (((await load()).Prisma.dmmf?.datamodel?.models ??
      []) as unknown as DmmfModelLike[]);

  const constraints = uniqueConstraintsFromDmmf(modelList).filter(
    (c) => !EXEMPT_COLLECTIONS.has(c.collection),
  );

  const present = await existingCollections(runner);
  if (present === null) {
    return {
      findings: [],
      ok: 0,
      missing: 0,
      weakened: 0,
      collectionAbsent: 0,
      failing: 0,
      refusal:
        "could not enumerate collections — `listCollections` returned an " +
        "unreadable or TRUNCATED batch. Refusing rather than treating the " +
        "collections past the batch boundary as absent, which would report " +
        "them healthy.",
    };
  }

  const wanted = new Set(constraints.map((c) => c.collection));
  const byCollection = new Map<string, readonly ObservedIndex[] | null>();

  for (const collection of wanted) {
    byCollection.set(
      collection,
      present.has(collection) ? await indexesOf(runner, collection) : null,
    );
  }

  return auditIndexes(constraints, byCollection);
}
