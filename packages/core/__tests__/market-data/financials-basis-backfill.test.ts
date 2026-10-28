/**
 * `stock_financials.basis` backfill — the three things it must never get wrong
 * (MONEY-1300).
 *
 * Source: `scripts/data/backfill-financials-basis.ts`
 *
 * ## What is at stake
 *
 * `basis` (CONSOLIDATED | STANDALONE) is ABSENT — not null — on all 32,359 prod
 * rows, because a Mongo `prisma db push` creates INDEXES, never FIELDS. The
 * backfill stamps the vendor rows with the literal `"UNKNOWN"`. Three
 * properties carry the whole ticket, and each one has already failed in this
 * repo in some other column:
 *
 *   (a) THE SELECTION REACHES ABSENT KEYS. Prisma's Mongo connector matches
 *       `{ basis: null }` against an explicit JSON null only, so it — and
 *       `{ not: null }` — return ZERO over this population. A backfill written
 *       with a Prisma `where` prints "nothing to do" and exits 0 over 32,359
 *       invisible rows. That is MONEY-1050 / 1205 / 1234 / 1235 / 1236,
 *       verbatim, five times.
 *   (b) AN `NSE_XBRL` ROW IS NEVER OVERWRITTEN. `StockFinancials`'s `@@unique`
 *       carries neither `source` nor `basis`, so a CONSOLIDATED value replaced
 *       by a blanket stamp is gone — there is no second copy.
 *   (c) THE STAMPED VALUE IS THE LITERAL `"UNKNOWN"`, never null and never
 *       absent. An explicit null is invisible to `{ basis: { not: null } }` and
 *       to a positive `in` list — i.e. it reads as "no basis" through the exact
 *       filters this class of defect is about — so it would move the rows from
 *       one unreadable state to another while looking like a fix.
 *
 * ## Why the checks are SEMANTIC and not structural
 *
 * Asserting that a filter object deep-equals `{ basis: { $exists: false } }`
 * pins a spelling, not a meaning: it stays green against a filter that is
 * correctly shaped and selects the wrong rows, and it says nothing at all about
 * the Prisma-vs-Mongo asymmetry that is the entire defect. So the cases below
 * EVALUATE the script's real filters against a fixture that contains every
 * shape the column can be in — absent, explicit null, a real basis, an
 * already-stamped `UNKNOWN` — through a small filter evaluator that models raw
 * Mongo semantics, and beside a second evaluator that models PRISMA's stricter
 * ones. The two disagreeing on the same fixture IS the bug, reproduced.
 *
 * The evaluator THROWS on an operator it does not implement. A fake that
 * silently ignores an unknown operator would let a filter widened with `$or`
 * pass while matching everything.
 *
 * The write path is driven through the script's real `applyBasisStamp` with an
 * injected runner, so the command being evaluated is the command the script
 * actually emits — not a second copy of it written in the test. A command
 * builder nothing is proven to call is a fix that shipped disarmed, which is
 * why the JOIN case scans `main()` for the call.
 *
 * ## MUTATION-VERIFIED
 *
 * Five mutations, each applied to the source, confirmed RED, then reverted
 * byte-identically:
 *
 *   1. `stampFilter()` loses its `source: { $nin: … }` arm — the whole XBRL
 *      guard. 8 RED, incl. "never stamps a row the projection owns" and
 *      "the write command carries the projection guard".
 *   2. `basisStampCommand()` sets `basis: null` instead of `UNKNOWN_BASIS`.
 *      4 RED, incl. "an explicit null would leave the row invisible to
 *      `{ not: null }`" — the crux of the ticket.
 *   3. `$exists: false` replaced by a bare raw `basis: null` in
 *      `missingBasisFilter()`/`stampFilter()` — legal Mongo that ALSO matches
 *      an explicit null. 8 RED, incl. "leaves an EXPLICIT null row alone".
 *   4. `main()`'s `await applyBasisStamp(run)` inlined back to a bare
 *      `run(basisStampCommand())`, i.e. the fix shipped disarmed while every
 *      behavioural case stays green. 1 RED: "main() drives the SAME census and
 *      write these cases drive". That is the JOIN.
 *   5. `UNKNOWN_BASIS` set to `"CONSOLIDATED"` — type-VALID, so `tsc` cannot
 *      see it, and a plausible slip. 6 RED, incl. "round-trips through the
 *      step-1 READER as UNKNOWN".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A DYNAMIC import, and it has to be — the same boundary
 * `reconcile-symbol-paging.test.ts` documents. `packages/core` is
 * `"type": "module"` while the repo root, and therefore `scripts/`, is not, so
 * tsx transpiles the script to CommonJS; a static named import resolves the
 * file and then throws `does not provide an export named …` at load time. Do
 * not "tidy" this into a static import.
 *
 * Importable at all because the script calls `main()` ONLY when it is the
 * process entry point. An unguarded call would shell out to gcloud and reach
 * for a DATABASE_URL the moment this file loaded. That this suite runs to
 * completion IS the proof the guard works; a broken guard cannot produce a
 * passing suite.
 */
const {
  COLLECTION,
  UNKNOWN_BASIS,
  PROJECTION_OWNED_SOURCES,
  missingBasisFilter,
  stampFilter,
  projectionSkipFilter,
  explicitNullBasisFilter,
  alreadyStampedFilter,
  basisStampCommand,
  applyBasisStamp,
  readBasisCensus,
  censusAccountingError,
  parseArgs,
} = await import("../../../../scripts/data/backfill-financials-basis");

/** The one declared provenance vocabulary, read from its own module. */
const { XBRL_SOURCE } = await import("../../src/market-data/xbrl-projection");

/**
 * The READER half of MONEY-1300 (step 1). Imported so the two halves are joined
 * by an executed assertion and not by two files agreeing in prose.
 */
const { normalizeStockFinancialsBasis, stockFinancialsBasisLabel } =
  await import("../../src/market-data/financials-basis");

/** CWD is `packages/core` when this suite runs. */
const ROOT = join(process.cwd(), "..", "..");
const SCRIPT_REL = "scripts/data/backfill-financials-basis.ts";
const SCRIPT_SRC = readFileSync(join(ROOT, SCRIPT_REL), "utf8");

/** LINE comments before BLOCK comments — MONEY-1143. */
const strip = (src: string): string =>
  src.replace(/^[^\S\r\n]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const SCRIPT = strip(SCRIPT_SRC);

// ════════════════════════════════════════════════════════════════════════════
// A collection, and two readers of it that disagree
// ════════════════════════════════════════════════════════════════════════════

type Doc = Record<string, unknown>;

const has = (d: Doc, f: string): boolean =>
  Object.prototype.hasOwnProperty.call(d, f);

/**
 * RAW MONGO semantics, which are the permissive ones.
 *
 * The two behaviours that matter here, and both are the OPPOSITE of Prisma's:
 *   - `{ f: null }` / `{ f: { $eq: null } }` matches a document that LACKS `f`.
 *   - `{ f: { $nin: [...] } }` matches a document that LACKS `f`.
 *
 * That inversion is why the script's selection is raw. It is modelled here
 * rather than assumed, because a test that assumed it would be asserting the
 * same belief the code is built on.
 */
function matchesRaw(doc: Doc, filter: Doc): boolean {
  for (const [field, cond] of Object.entries(filter)) {
    if (field.startsWith("$")) {
      throw new Error(
        `the fake does not implement the top-level operator ${field}; teach it ` +
          `rather than let a widened filter pass unevaluated`,
      );
    }
    const present = has(doc, field);
    const value = present ? doc[field] : undefined;

    if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      for (const [op, operand] of Object.entries(cond as Doc)) {
        switch (op) {
          case "$exists":
            if (present !== Boolean(operand)) return false;
            break;
          case "$eq":
            if (operand === null) {
              if (present && value !== null) return false;
            } else if (!present || value !== operand) {
              return false;
            }
            break;
          case "$ne":
            if (present && value === operand) return false;
            break;
          case "$in":
            if (!present || !(operand as unknown[]).includes(value)) {
              return false;
            }
            break;
          case "$nin":
            if (present && (operand as unknown[]).includes(value)) return false;
            break;
          default:
            throw new Error(
              `the fake does not implement ${op}; teach it rather than let it pass`,
            );
        }
      }
    } else if (cond === null) {
      if (present && value !== null) return false;
    } else if (!present || value !== cond) {
      return false;
    }
  }
  return true;
}

/**
 * PRISMA-MongoDB semantics for a scalar equality — deliberately stricter.
 *
 * An ABSENT key matches NOTHING. Not `null`, not `{ not: null }`, not an `in`
 * list. One line, and it is the whole of MONEY-1050 / 1205 / 1234 / 1235 /
 * 1236.
 */
const prismaEquals = (d: Doc, f: string, v: unknown): boolean =>
  has(d, f) && d[f] === v;
const prismaNot = (d: Doc, f: string, v: unknown): boolean =>
  has(d, f) && d[f] !== v;
const prismaIn = (d: Doc, f: string, vs: readonly unknown[]): boolean =>
  has(d, f) && vs.includes(d[f]);

/**
 * The population, in every shape the column can be in.
 *
 * A FACTORY, not a constant: `applyBasisStamp` mutates documents in place, so a
 * shared array would make each case depend on the order the previous ones ran.
 */
function fixture(): Doc[] {
  return [
    // absent basis, vendor source                       -> STAMP
    { _id: "r1", symbol: "RELIANCE", source: "TICKERTAPE" },
    // a real basis already                              -> leave alone
    { _id: "r2", symbol: "TCS", source: "TICKERTAPE", basis: "CONSOLIDATED" },
    // absent basis, PROJECTION-owned                    -> SKIP, and count it
    { _id: "r3", symbol: "INFY", source: XBRL_SOURCE },
    // the projection's own value                        -> leave alone
    { _id: "r4", symbol: "HDFCBANK", source: XBRL_SOURCE, basis: "STANDALONE" },
    // absent basis AND absent source. Unknown ranks LAST in
    // FINANCIALS_AUTHORITY, so it is not the projection's -> STAMP
    { _id: "r5", symbol: "AUGMONT" },
    // already stamped by an earlier run                 -> leave alone
    { _id: "r6", symbol: "ITC", source: "TICKERTAPE", basis: UNKNOWN_BASIS },
    // absent basis, a different vendor                  -> STAMP
    { _id: "r7", symbol: "WIPRO", source: "SCREENER" },
    // EXPLICIT null: the key is PRESENT. Out of `$exists: false`'s reach by
    // construction, and the row that catches a filter loosened to raw `null`.
    { _id: "r8", symbol: "SBIN", source: "YAHOO", basis: null },
  ];
}

const byId = (docs: Doc[], id: string): Doc => {
  const d = docs.find((x) => x._id === id);
  assert.ok(d, `fixture row ${id} vanished`);
  return d;
};

const idsMatching = (docs: Doc[], filter: Doc): string[] =>
  docs.filter((d) => matchesRaw(d, filter)).map((d) => String(d._id));

// ════════════════════════════════════════════════════════════════════════════
// The injected runner: a mongod small enough to read
// ════════════════════════════════════════════════════════════════════════════

interface RunnerHandle {
  run: (command: Doc) => Promise<Doc>;
  /** Every command the script emitted, in order. */
  commands: Doc[];
  docs: Doc[];
}

function runStages(docs: Doc[], stages: unknown[]): Doc[] {
  let cur = docs;
  let terminal: Doc[] | null = null;
  for (const stage of stages) {
    const s = stage as Doc;
    if ("$match" in s) {
      cur = cur.filter((d) => matchesRaw(d, s.$match as Doc));
    } else if ("$count" in s) {
      // Mongo's `$count` emits NOTHING over an empty input — modelled, because
      // the script's `facetCount` has to survive exactly that.
      terminal = cur.length > 0 ? [{ [String(s.$count)]: cur.length }] : [];
    } else if ("$group" in s) {
      const g = s.$group as Doc;
      const expr = g._id;
      if (typeof expr !== "string" || !expr.startsWith("$")) {
        throw new Error("the fake only groups by a single $field path");
      }
      const field = expr.slice(1);
      const counts = new Map<unknown, number>();
      for (const d of cur) {
        // Mongo groups an ABSENT field under null, which is how the script's
        // per-source breakdown can show an `<absent>` bucket at all.
        const key = has(d, field) ? d[field] : null;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      terminal = [...counts].map(([k, n]) => ({ _id: k, n }));
    } else {
      throw new Error(
        `the fake does not implement the stage ${Object.keys(s)[0]}`,
      );
    }
  }
  return terminal ?? cur;
}

function makeRunner(docs: Doc[]): RunnerHandle {
  const commands: Doc[] = [];
  const run = async (command: Doc): Promise<Doc> => {
    commands.push(command);

    if ("aggregate" in command) {
      assert.equal(
        command.aggregate,
        COLLECTION,
        "the aggregate must name the @@map'd collection",
      );
      const pipeline = command.pipeline as unknown[];
      assert.equal(
        pipeline.length,
        1,
        "the census is one $facet; the fake models that shape only",
      );
      const facet = (pipeline[0] as Doc).$facet as Record<string, unknown[]>;
      assert.ok(facet, "expected a $facet census");
      const out: Doc = {};
      for (const [name, stages] of Object.entries(facet)) {
        out[name] = runStages(docs, stages);
      }
      return { cursor: { firstBatch: [out] }, ok: 1 };
    }

    if ("update" in command) {
      assert.equal(command.update, COLLECTION);
      const updates = command.updates as Array<{
        q: Doc;
        u: Doc;
        multi?: boolean;
      }>;
      let n = 0;
      let nModified = 0;
      for (const u of updates) {
        const set = u.u.$set as Doc | undefined;
        assert.ok(set, "the fake only implements $set");
        assert.deepEqual(
          Object.keys(u.u),
          ["$set"],
          "the write must be a single $set — nothing else may ride along",
        );
        const targets = docs.filter((d) => matchesRaw(d, u.q));
        for (const d of u.multi ? targets : targets.slice(0, 1)) {
          n++;
          let changed = false;
          for (const [k, v] of Object.entries(set)) {
            if (!has(d, k) || d[k] !== v) {
              d[k] = v;
              changed = true;
            }
          }
          if (changed) nModified++;
        }
      }
      return { n, nModified, ok: 1 };
    }

    if ("find" in command) {
      assert.equal(command.find, COLLECTION);
      const filter = (command.filter ?? {}) as Doc;
      const limit = Number(command.limit ?? 101);
      const rows = docs.filter((d) => matchesRaw(d, filter)).slice(0, limit);
      return { cursor: { firstBatch: rows }, ok: 1 };
    }

    throw new Error(
      `the fake does not implement the command ${Object.keys(command)[0]}`,
    );
  };
  return { run, commands, docs };
}

// ════════════════════════════════════════════════════════════════════════════
// (a) the selection reaches ABSENT keys — `$exists: false`, never a bare null
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1300 (a) the selection reaches rows where `basis` is ABSENT", () => {
  it("selects exactly the vendor rows whose `basis` key does not exist", () => {
    const docs = fixture();
    assert.deepEqual(
      idsMatching(docs, stampFilter()),
      ["r1", "r5", "r7"],
      "the plan must be: absent basis, and not a row the projection owns",
    );
    assert.deepEqual(
      idsMatching(docs, missingBasisFilter()),
      ["r1", "r3", "r5", "r7"],
      "the whole hole, before the projection guard narrows it",
    );
  });

  it("spells the reach as `$exists: false`", () => {
    // The spelling matters for a reader arriving from the Prisma side: raw
    // `{ basis: null }` would also reach an absent key, and would read exactly
    // like the bug. Pinned so the meaning cannot be re-expressed into the shape
    // the whole ticket exists to keep out of this file.
    assert.deepEqual(missingBasisFilter(), { basis: { $exists: false } });
    assert.deepEqual((stampFilter() as { basis: unknown }).basis, {
      $exists: false,
    });
    assert.match(
      SCRIPT,
      /\$exists:\s*false/,
      "the script must select on $exists: false",
    );
  });

  it("leaves an EXPLICIT null row alone — it is out of scope, by construction", () => {
    // r8 CARRIES the key with a null value. `$exists: false` cannot reach it,
    // and a filter loosened to raw `{ basis: null }` silently would. Widening
    // the population must be a decision somebody makes, not a side effect of
    // choosing an operator.
    const docs = fixture();
    assert.equal(idsMatching(docs, stampFilter()).includes("r8"), false);
    assert.deepEqual(idsMatching(docs, explicitNullBasisFilter()), ["r8"]);
  });

  it("a bare-null PRISMA where sees NONE of the rows that need stamping", () => {
    // The defect, reproduced. This is why the selection is raw and not a Prisma
    // `where`: over the real population (32,359 rows, attribute absent on all
    // of them) this predicate returns ZERO and a backfill built on it reports
    // "nothing to do" and exits 0.
    const docs = fixture();
    const needed = ["r1", "r5", "r7"];
    for (const id of needed) {
      const d = byId(docs, id);
      assert.equal(
        prismaEquals(d, "basis", null),
        false,
        `${id} is invisible to Prisma's { basis: null } — that is the bug`,
      );
      assert.equal(
        prismaNot(d, "basis", null),
        false,
        `${id} is invisible to Prisma's { basis: { not: null } } too — BOTH ` +
          `directions return nothing, which is what makes the defect silent`,
      );
    }
    const prismaBareNull = docs
      .filter((d) => prismaEquals(d, "basis", null))
      .map((d) => String(d._id));
    assert.deepEqual(
      prismaBareNull,
      ["r8"],
      "a Prisma bare null reaches only the row that already CARRIES a null",
    );
  });

  it("every write goes through $runCommandRaw, never a Prisma write verb", () => {
    for (const verb of ["updateMany", "update", "upsert", "create"]) {
      assert.doesNotMatch(
        SCRIPT,
        new RegExp(`stockFinancials\\s*\\.\\s*${verb}\\s*\\(`),
        `the script calls stockFinancials.${verb}(). Prisma cannot express ` +
          `$exists:false, so a typed write here would silently narrow to rows ` +
          `that already carry the key — i.e. to nothing.`,
      );
    }
    assert.match(SCRIPT, /\$runCommandRaw/);
  });

  it("the ONE Prisma bare-null in the script is the deliberate defect demo", () => {
    // The dry run prints "what the BROKEN filter sees" beside the real number.
    // That is worth keeping and is the only legitimate bare null here, so it is
    // pinned to exactly one site, marked for the repo-wide class guard, and
    // required to be a COUNT rather than a selection.
    // Scoped to a Prisma `where`, not to the string `basis: null` — the header
    // and the dry-run banner both TALK about the broken filter, and quoting the
    // defect is not committing it.
    const whereSites = [...SCRIPT.matchAll(/where:\s*\{[^{}]*basis:\s*null/g)];
    assert.equal(
      whereSites.length,
      1,
      `expected exactly one Prisma \`where\` comparing basis to a bare null ` +
        `(the defect demo), found ${whereSites.length}. A second one is ` +
        `either a selection — which cannot see this population — or an ` +
        `untracked exception.`,
    );

    const lines = SCRIPT_SRC.split("\n");
    const i = lines.findIndex((l) =>
      /^\s*where:\s*\{\s*basis:\s*null\s*\}/.test(l),
    );
    assert.notEqual(i, -1, "could not locate the bare-null site in the source");
    const above = lines.slice(Math.max(0, i - 6), i).join("\n");
    assert.match(
      above,
      /prisma-null-ok:/,
      "the bare null must carry the `// prisma-null-ok: <why>` marker that " +
        "apps/web/__tests__/meta/prisma-null-vs-isset.test.ts requires",
    );
    assert.match(
      lines.slice(Math.max(0, i - 8), i).join("\n"),
      /\.count\(/,
      "the bare null must be a COUNT (the defect demo), never a selection",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (b) an NSE_XBRL row is never overwritten
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1300 (b) the projection's rows are never overwritten", () => {
  it("derives the guard from XBRL_SOURCE rather than a local literal", () => {
    assert.deepEqual([...PROJECTION_OWNED_SOURCES], [XBRL_SOURCE]);
    assert.equal(XBRL_SOURCE, "NSE_XBRL");
  });

  it("the write command carries the projection guard", () => {
    const cmd = basisStampCommand() as {
      update: string;
      updates: Array<{ q: Doc; u: Doc; multi?: boolean }>;
    };
    assert.equal(cmd.update, COLLECTION);
    assert.equal(cmd.updates.length, 1);
    assert.deepEqual(cmd.updates[0]!.q, {
      basis: { $exists: false },
      source: { $nin: ["NSE_XBRL"] },
    });
    assert.equal(cmd.updates[0]!.multi, true);
  });

  it("never stamps a row the projection owns, absent basis or not", async () => {
    const docs = fixture();
    const { run } = makeRunner(docs);
    await applyBasisStamp(run);

    const r3 = byId(docs, "r3");
    assert.equal(
      has(r3, "basis"),
      false,
      "an NSE_XBRL row with no basis must be LEFT with no basis — the " +
        "projection is what should supply it, and a blanket vendor stamp " +
        "would make that row permanently un-fixable through this filter",
    );
    assert.equal(byId(docs, "r4").basis, "STANDALONE");
  });

  it("counts the skipped rows rather than folding them into the total", async () => {
    const docs = fixture();
    const { run } = makeRunner(docs);
    const census = await readBasisCensus(run);

    assert.equal(census.total, 8);
    assert.equal(census.missingBasis, 4);
    assert.equal(census.stampable, 3);
    assert.equal(
      census.projectionSkipped,
      1,
      "a skip nobody can see is a skip nobody can act on",
    );
    assert.equal(census.explicitNull, 1);
    assert.equal(census.alreadyStamped, 1);
    assert.deepEqual(
      [...census.missingBySource].sort((a, b) =>
        a.source.localeCompare(b.source),
      ),
      [
        { source: "<absent>", n: 1 },
        { source: "NSE_XBRL", n: 1 },
        { source: "SCREENER", n: 1 },
        { source: "TICKERTAPE", n: 1 },
      ],
      "a row with NO source must appear as its own bucket, not vanish",
    );
    assert.equal(censusAccountingError(census), null);
  });

  it("the accounting check is not vacuous", () => {
    const base = {
      total: 8,
      missingBasis: 4,
      stampable: 3,
      projectionSkipped: 1,
      explicitNull: 1,
      alreadyStamped: 1,
      missingBySource: [
        { source: "TICKERTAPE", n: 1 },
        { source: "NSE_XBRL", n: 1 },
        { source: "SCREENER", n: 1 },
        { source: "<absent>", n: 1 },
      ],
      presentByBasis: [],
    };
    assert.equal(censusAccountingError(base), null);
    // The buckets stop partitioning the population.
    assert.match(
      censusAccountingError({ ...base, projectionSkipped: 0 }) ?? "",
      /must PARTITION/,
    );
    // The per-source breakdown disagrees with the total it describes.
    assert.match(
      censusAccountingError({
        ...base,
        missingBySource: base.missingBySource.slice(0, 2),
      }) ?? "",
      /per-source breakdown/,
    );
    // More rows missing a column than exist in the collection.
    assert.match(
      censusAccountingError({ ...base, total: 2 }) ?? "",
      /reading two different things/,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// (c) the stamped value is the literal "UNKNOWN"
// ════════════════════════════════════════════════════════════════════════════

describe('MONEY-1300 (c) the stamped value is the literal "UNKNOWN"', () => {
  it("is a non-empty string, and it is UNKNOWN", () => {
    assert.equal(UNKNOWN_BASIS, "UNKNOWN");
    assert.equal(typeof UNKNOWN_BASIS, "string");
    assert.notEqual(UNKNOWN_BASIS, null);
    assert.ok(UNKNOWN_BASIS.length > 0);
  });

  it("round-trips through the step-1 READER as UNKNOWN", async () => {
    // The JOIN between the two halves of this ticket. Step 1 already collapses
    // ABSENT and "UNKNOWN" to one reader state, so the backfill changes what
    // the COLUMN says without changing what the page RENDERS — which is what
    // makes it safe to run in either order relative to that deploy. Asserted
    // rather than described: a writer emitting a value the reader silently
    // collapses to UNKNOWN would look identical on screen and be wrong in the
    // database, and only an executed round trip can tell the two apart.
    assert.equal(normalizeStockFinancialsBasis(UNKNOWN_BASIS), "UNKNOWN");
    assert.equal(
      stockFinancialsBasisLabel(UNKNOWN_BASIS),
      stockFinancialsBasisLabel(undefined),
      "a stamped row and an untouched row must still read the same to a user",
    );

    // And the stamp must not be mistaken for a basis the reader recognises.
    for (const known of ["CONSOLIDATED", "STANDALONE"]) {
      assert.notEqual(UNKNOWN_BASIS, known);
    }

    // The whole write, driven for real, then read back through step 1.
    const docs = fixture();
    const { run } = makeRunner(docs);
    await applyBasisStamp(run);
    assert.equal(
      normalizeStockFinancialsBasis(byId(docs, "r1").basis),
      "UNKNOWN",
    );
    assert.equal(
      normalizeStockFinancialsBasis(byId(docs, "r4").basis),
      "STANDALONE",
      "the projection's own value must survive the run and still read as itself",
    );
  });

  it("the write sets exactly that one key to exactly that value", () => {
    const cmd = basisStampCommand() as {
      updates: Array<{ u: Doc }>;
    };
    assert.deepEqual(cmd.updates[0]!.u, { $set: { basis: "UNKNOWN" } });
  });

  it("stamps it, and touches nothing else on the row", async () => {
    const docs = fixture();
    const before = JSON.parse(JSON.stringify(byId(docs, "r1"))) as Doc;
    const { run } = makeRunner(docs);
    const res = await applyBasisStamp(run);

    assert.deepEqual(res, { matched: 3, modified: 3 });
    for (const id of ["r1", "r5", "r7"]) {
      assert.equal(byId(docs, id).basis, "UNKNOWN");
    }
    const after = byId(docs, "r1");
    assert.deepEqual(
      Object.keys(after)
        .filter((k) => k !== "basis")
        .sort(),
      Object.keys(before).sort(),
      "the stamp must add `basis` and nothing else — no source, no figures, " +
        "no fetchedAt",
    );
    for (const k of Object.keys(before)) {
      assert.deepEqual(after[k], before[k], `${k} was modified`);
    }
    // Untouched rows stay untouched.
    assert.equal(byId(docs, "r2").basis, "CONSOLIDATED");
    assert.equal(byId(docs, "r8").basis, null);
  });

  it("an explicit null would leave the row invisible to `{ not: null }`; UNKNOWN does not", async () => {
    const KNOWN_BASES = ["CONSOLIDATED", "STANDALONE", UNKNOWN_BASIS] as const;

    // The counterfactual the ticket rejects: the SAME selection, a null value.
    const nulled = fixture();
    const nulledRunner = makeRunner(nulled);
    await nulledRunner.run({
      update: COLLECTION,
      updates: [
        { q: stampFilter(), u: { $set: { basis: null } }, multi: true },
      ],
    });
    const nullRow = byId(nulled, "r1");
    assert.equal(
      prismaNot(nullRow, "basis", null),
      false,
      'a null-stamped row still reads as "no basis" through { not: null } — ' +
        "the exact filter this class of defect is about. It moved from one " +
        "unreadable state to another.",
    );
    assert.equal(
      prismaIn(nullRow, "basis", KNOWN_BASES),
      false,
      "and a positive `in` list — the spelling the schema comment recommends " +
        "— cannot reach it either",
    );

    // What the script actually does.
    const stamped = fixture();
    const { run } = makeRunner(stamped);
    await applyBasisStamp(run);
    const row = byId(stamped, "r1");
    assert.equal(prismaNot(row, "basis", null), true);
    assert.equal(prismaIn(row, "basis", KNOWN_BASES), true);
    assert.equal(prismaEquals(row, "basis", UNKNOWN_BASIS), true);
    assert.equal(
      prismaEquals(row, "basis", null),
      false,
      "and it must NOT read as null — a vendor row with an unrecorded basis " +
        "is a distinct state from a row nothing has decided",
    );

    // The discrimination that makes "UNKNOWN" a fix rather than a relocation:
    // an ordinary Prisma equality separates the three states.
    assert.equal(
      prismaEquals(byId(stamped, "r4"), "basis", "STANDALONE"),
      true,
    );
    assert.equal(has(byId(stamped, "r3"), "basis"), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Idempotency
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1300 the backfill is idempotent by construction", () => {
  it("a second run matches zero and modifies zero", async () => {
    const docs = fixture();
    const { run } = makeRunner(docs);

    const first = await applyBasisStamp(run);
    assert.deepEqual(first, { matched: 3, modified: 3 });

    const snapshot = JSON.stringify(docs);
    const second = await applyBasisStamp(run);
    assert.deepEqual(
      second,
      { matched: 0, modified: 0 },
      "the selection is `basis absent` and the write gives those rows a " +
        "basis, so the second pass cannot select them. This is a property of " +
        "the filter, not a checkpoint — there is nothing to reset after an " +
        "interrupted run.",
    );
    assert.equal(
      JSON.stringify(docs),
      snapshot,
      "a re-run must be byte-identical, not merely no-op-reported",
    );
  });

  it("the census reports zero stampable rows after the run", async () => {
    const docs = fixture();
    const { run } = makeRunner(docs);
    await applyBasisStamp(run);
    const after = await readBasisCensus(run);
    assert.equal(after.stampable, 0);
    assert.equal(after.missingBasis, 1, "only the NSE_XBRL row remains");
    assert.equal(after.projectionSkipped, 1);
    assert.equal(after.alreadyStamped, 4, "the 3 new stamps plus the old one");
    assert.equal(censusAccountingError(after), null);
    assert.deepEqual(idsMatching(docs, alreadyStampedFilter()), [
      "r1",
      "r5",
      "r6",
      "r7",
    ]);
    assert.deepEqual(idsMatching(docs, projectionSkipFilter()), ["r3"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The JOIN, and the safety rails around the write
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1300 the script is wired to what this file tests", () => {
  it("main() drives the SAME census and write these cases drive", () => {
    // Without this the whole file is a test of exported helpers that `main()`
    // is free to ignore — an exported function nothing calls is a fix that
    // shipped disarmed.
    assert.match(
      SCRIPT,
      /await\s+readBasisCensus\(\s*run\s*\)/,
      "main() must read its census through readBasisCensus",
    );
    assert.match(
      SCRIPT,
      /await\s+applyBasisStamp\(\s*run\s*\)/,
      "main() must write through applyBasisStamp",
    );
    assert.match(
      SCRIPT,
      /censusAccountingError\(/,
      "main() must fail on a census whose buckets do not sum",
    );
  });

  it("resolves the database target BEFORE constructing a client", () => {
    // The ops-script rule: `@usemoney/database` builds its PrismaClient at
    // MODULE scope from `process.env.DATABASE_URL`, and ESM evaluates static
    // imports before any statement in main(). A static import here would make
    // the confirmation prompt echo the host `--env` resolved while the write
    // landed on the shell's database.
    const staticSpecs = [
      ...SCRIPT.matchAll(
        /^[ \t]*(?:import|export)\s+(?:type\s+)?[^;]*?from\s*["']([^"']+)["']/gm,
      ),
    ].map((m) => m[1]!);
    assert.equal(
      staticSpecs.includes("@usemoney/database"),
      false,
      "statically importing @usemoney/database pins the client to the shell's " +
        "DATABASE_URL before --env resolves",
    );
    assert.equal(
      staticSpecs.includes("@usemoney/core/market-data"),
      false,
      "the market-data BARREL reaches @usemoney/database as a value through " +
        "ten modules — import the narrow subpath",
    );
    assert.match(
      SCRIPT,
      /await import\(\s*["']@usemoney\/database["']\s*\)/,
      "the positive half: the script must still obtain prisma lazily, or the " +
        "assertion above is vacuous",
    );
  });

  it("refuses --apply without a TTY", () => {
    // An agent runs dry runs; a human runs writes. Checked in parseArgs, which
    // is the first statement of main(), so it fires before gcloud is shelled
    // out to and before any connection exists.
    const original = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        configurable: true,
      });
      assert.throws(() => parseArgs(["--apply"]), /TTY/);
      assert.doesNotThrow(() => parseArgs([]), "a dry run needs no terminal");

      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      assert.deepEqual(parseArgs(["--apply"]), {
        apply: true,
        env: null,
        samples: 8,
      });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: original,
        configurable: true,
      });
    }
  });

  it("parseArgs is the first thing main() does", () => {
    const body = SCRIPT.slice(SCRIPT.indexOf("async function main("));
    const firstStatement = body.split("\n").find((l) => /^\s{2}\S/.test(l));
    assert.match(
      firstStatement ?? "",
      /parseArgs\(process\.argv\.slice\(2\)\)/,
      "the argv guards must run before gcloud is shelled out to and before " +
        "the deferred database import",
    );
  });

  it("refuses an argv it does not fully understand", () => {
    // `argv.includes()` silently drops what it does not recognise, which is how
    // a sibling came to accept-and-ignore `--dry-run` alongside `--apply`
    // (i.e. it WROTE).
    assert.throws(() => parseArgs(["--dry-run"]), /Unknown flag/);
    assert.throws(() => parseArgs(["--env=prod"]), /Use "--flag value"/);
    assert.throws(() => parseArgs(["--env"]), /no value/);
    assert.throws(
      () => parseArgs(["--env", "staging"]),
      /must be "qa" or "prod"/,
    );
    assert.throws(() => parseArgs(["--samples", "0"]), /positive integer/);
    // A raw `find` returns only `cursor.firstBatch` and this script cannot
    // issue a getMore, so an oversized --samples would silently under-report.
    assert.throws(() => parseArgs(["--samples", "500"]), /capped/);
    assert.deepEqual(parseArgs(["--env", "prod", "--samples", "3"]), {
      apply: false,
      env: "prod",
      samples: 3,
    });
  });

  it("verifies through PRISMA, not through the raw predicate it selected with", () => {
    // A verify that re-runs the selection's own filter can only confirm the
    // selection's own blind spot (MONEY-1236). The adversary here is a write
    // that sets `basis: null`: the raw "still missing" count would go to ZERO
    // and report success, because the attribute would then EXIST.
    assert.match(
      SCRIPT,
      /stockFinancials\.count\(\{\s*where:\s*\{\s*basis:\s*UNKNOWN_BASIS\s*\}/,
      "the post-write check must be an ordinary Prisma equality against the " +
        "stamped literal",
    );
    assert.match(SCRIPT, /Verification FAILED/, "and it must be able to fail");
  });
});
