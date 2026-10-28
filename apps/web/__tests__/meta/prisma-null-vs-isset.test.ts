/**
 * MONEY-1236 — a Prisma `where` may not spell "unset" as a bare `null`.
 *
 * ## The defect class
 *
 * On Prisma's MongoDB connector, `{ field: null }` is an equality against an
 * explicit JSON null. It matches ONLY documents that actually CARRY the key. A
 * document where the field was never written has no key at all — `prisma db
 * push` creates INDEXES, never FIELDS — and is invisible to that filter.
 * `isSet: false` is the only Prisma spelling that reaches an absent key (it
 * lowers to `$exists: false`); a bare `null`, `{ equals: null }` and
 * `{ not: null }` all do not.
 *
 * This has now been found by hand FIVE times:
 *
 *   MONEY-1050  `{not:false}` vs absent — one orphan blanked every result
 *   MONEY-1205  mf-metadata-sync selected 6,960 of 14,223 funds
 *   MONEY-1234  the XBRL projection selected 0 of 90,188 filings
 *   MONEY-1235  (same class)
 *   MONEY-1236  three ops/migration scripts, measured on prod 2026-08-21:
 *                 BrokerConnection.syncBucket        absent   1 of 9   (11.1%)
 *                 Subscription.cancelledAt           absent 650 of 652 (99.7%)
 *                 Subscription.proEntitlementType    absent 651 of 652 (99.8%)
 *
 * Every one of those was found by a human reading code. The failure mode is
 * silent by construction: the query succeeds, returns fewer rows than exist,
 * and the caller reports "nothing to do". Two of the MONEY-1236 scripts then
 * VERIFIED with a re-run of the same broken filter, so each printed "nothing to
 * fix" followed by "0 remaining" and exited 0 — a double false success.
 *
 * ## The rule this guard enforces
 *
 *   A Prisma `where` must not compare an OPTIONAL scalar field to a bare
 *   `null` — `{ f: null }` or `{ f: { equals: null } }` — unless the same
 *   filter also carries an `isSet` arm for that same field.
 *
 * ## Why `{ not: null }` is deliberately NOT flagged
 *
 * The false-positive story matters more than the coverage: a guard that cries
 * wolf gets disabled, and then the class comes back. `{ f: { not: null } }`
 * means "HAS a value", and excluding an absent key is exactly the intent — 53
 * such filters exist in this repo today and every one of them is correct.
 * `scripts/migrations/fix-premium-enddate.ts` is the clean illustration: its
 * `endDate: { not: null }` ("has an endDate to clear") is right, and sat in the
 * same object as the `cancelledAt: null` that was wrong. Flagging both would
 * have buried the real defect in noise.
 *
 * Two more things are deliberately out of scope, for the same reason:
 *
 *   - RAW Mongo bodies. `$runCommandRaw` / `findRaw` / `aggregateRaw` take
 *     `filter:` and `pipeline:`, never `where:`, so they are structurally
 *     outside this scan — which is essential, because in raw Mongo
 *     `{ field: null }` DOES match a missing key. The MONEY-1236 fixes lean on
 *     exactly that inversion to verify themselves.
 *   - `data:` payloads. `data: { endDate: null }` is a WRITE that sets the
 *     field to null. Only the balanced block after a `where:` is scanned.
 *
 * ## Escape hatch
 *
 * A legitimate bare `null` — a diagnostic that is deliberately MEASURING the
 * difference, or a field the WRITER always stamps — carries
 * `// prisma-null-ok: <why>` on the offending line or within the 5 lines above
 * it. A marker that only says "verified" is worse than no marker, because the
 * next reader cannot re-check it: each one names the writer that guarantees the
 * key exists and carries the measured absent-count.
 *
 * ## Measured precision on the tree at the time of writing
 *
 * First full scan flagged 17 distinct (file, field) sites across 2,425 source
 * files. ZERO of the 53 `{ not: null }` filters in the repo were flagged — no
 * false positive in that category at all. Three of the 17 are the MONEY-1236
 * fixes and are gone.
 *
 * ## What the MEASUREMENT then did to the classification
 *
 * The first pass classified the survivors from CODE READING alone, and 13 went
 * into KNOWN_UNFIXED as 12 DEFECT / 1 DELIBERATE. Every one was then counted on
 * prod (2026-08-21), and eight of the twelve DEFECT calls were WRONG — not
 * "small", wrong. The field is never absent, because the writer always stamps
 * it:
 *
 *   ContentAuthor.imageUrl    total     1  absent 0  null   0  set     1
 *   UpcomingEvent.symbol      total 1,766  absent 0  null   0  set 1,766
 *   IndexMembership.removedOn total   924  absent 0  null 924  set     0
 *   UpcomingIpo.issueStart    total 1,423  absent 0  null   0  set 1,423
 *
 * Those nine sites (the eight above plus scripts/data/debug-sectors.ts, whose
 * whole output is a contrast between the two semantics) now carry
 * `// prisma-null-ok:` markers naming the writer and the count, and their
 * entries are deleted. FOUR remain, all DEFECT.
 *
 * The lesson is the guard's own limit, and it belongs here rather than in a
 * ticket: this scan finds a SHAPE. Whether the shape is a defect is decided by
 * the WRITER, not the reader — `IndexMembership.removedOn` is the clean case,
 * where index-constituent-sync.ts:354 passes an explicit `removedOn: null` in
 * its `createMany`, so all 924 open stints carry the key by construction. A
 * DEFECT verdict here is a HYPOTHESIS until someone counts the absent rows.
 *
 * Two of those 17 were only found BECAUSE this scan exists, and one of them is
 * the argument for the whole file: `packages/services/src/user.service.ts`
 * carried a 20-line comment correctly explaining that a bare `viewedAt: null`
 * "matches ONLY documents that carry the key, and no writer carries it" — above
 * a bare `viewedAt: null`. Its own comment said "must stay identical to
 * apps/web/lib/actions/briefing.ts", and that twin had already been fixed. A
 * half-fixed pair, exactly the shape that hid MONEY-1234's second broken pipe.
 * Naming a bug in a comment is not protection from it; this scan is.
 *
 * ## Two directions, both load-bearing
 *
 * The guard fails on anything NOT in KNOWN_UNFIXED, and fails AGAIN once a
 * listed site is fixed, so the list can only shrink. The second direction is
 * not bookkeeping: a permit left behind after its site was repaired would let
 * the identical defect back in at exactly the spot we already know is
 * dangerous. When it fires, the remedy is to delete the named line.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..", "..", "..");
const SCAN_ROOTS = ["apps", "packages", "workers", "scripts"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  ".git",
  ".turbo",
  "vendor",
  "coverage",
  "build",
  ".vercel",
  // Tests are excluded: they deliberately contain both good and bad shapes as
  // fixtures (this file included).
  "__tests__",
  // `.claude/worktrees/**` holds checkouts of OTHER branches, so scanning them
  // would make this repo's result depend on whatever a parallel session has on
  // disk — the exact trap already written down in no-test-force-exit.test.ts.
  ".claude",
]);

/**
 * Sites that already had this shape when the guard landed.
 *
 * Keyed `relative/path.ts::fieldName` rather than by line, so an unrelated edit
 * above the offender does not invalidate the entry. The value is the reason it
 * is still here — a bare list of paths would rot into a blanket permit, which
 * is how a baseline turns into the thing it was meant to prevent.
 *
 * Two assertions keep it honest, in both directions:
 *   - a hit that is NOT listed fails the build (the point of the guard)
 *   - a listed entry that is no longer a hit ALSO fails the build, so fixing a
 *     site forces its line to be deleted and the list can only shrink
 */
const KNOWN_UNFIXED = new Map<string, string>([]);

// ---------------------------------------------------------------------------
// schema — which fields are OPTIONAL scalars
// ---------------------------------------------------------------------------

/**
 * Field names declared `Type?` (optional, non-list, non-relation) anywhere in
 * schema.prisma.
 *
 * By NAME, not by model. Resolving `prisma.subscription.findMany` back to the
 * `Subscription` model would need real type resolution, and a where-block often
 * sits behind a `db`/`tx` alias or a generic helper. Matching on the name is
 * the conservative trade: it can only ever consider a field that is optional
 * SOMEWHERE, and a required field of the same name would be rejected by Prisma
 * itself long before this guard mattered.
 */
function optionalScalarFields(schema: string): Set<string> {
  const models = new Set<string>();
  for (const m of schema.matchAll(/^(?:model|type)\s+(\w+)\s*\{/gm)) {
    models.add(m[1]);
  }
  const out = new Set<string>();
  let inModel = false;
  for (const raw of schema.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "");
    if (/^(?:model|type)\s+\w+\s*\{/.test(line)) {
      inModel = true;
      continue;
    }
    if (/^\}/.test(line)) {
      inModel = false;
      continue;
    }
    if (!inModel) continue;
    const f = line.match(/^\s*(\w+)\s+(\w+)(\[\])?(\?)?/);
    if (!f) continue;
    const [, name, type, list, optional] = f;
    // Relations are model-typed; a list can never be compared to null.
    if (!optional || list || models.has(type)) continue;
    out.add(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

const spaces = (s: string): string => s.replace(/[^\n]/g, " ");

/**
 * Replace comment bodies with spaces, preserving every offset and newline so
 * line numbers stay exact.
 *
 * LINE comments are stripped BEFORE block comments (MONEY-1143): a `//` comment
 * containing `/*` otherwise opens a phantom block that swallows everything up
 * to the next terminator, and this guard's whole job is to notice text that IS
 * there — swallowed text reads as clean.
 */
function blankComments(src: string): string {
  return src
    .replace(
      /(^|[^:"'`\\])\/\/.*$/gm,
      (m, p1: string) => p1 + spaces(m.slice(p1.length))
    )
    .replace(/\/\*[\s\S]*?\*\//g, (m) => spaces(m));
}

/** Index just past the `{`/`[` at `openIdx`'s matching close. */
function balancedEnd(src: string, openIdx: number): number {
  const open = src[openIdx];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/** Top-level `const NAME = { … }` / `= [ … ]` bodies, for OR-const resolution. */
function constBodies(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/\bconst\s+(\w+)\s*(?::[^=]*)?=\s*([{[])/g)) {
    const open = m.index! + m[0].length - 1;
    out.set(m[1], src.slice(open, balancedEnd(src, open)));
  }
  return out;
}

/**
 * Every filter position in a file.
 *
 * Three shapes, because each later one is a real blind spot the earlier ones
 * cannot see:
 *   1. the balanced block after `where:`
 *   2. a hoisted `const X: Prisma.FooWhereInput[] = [...]` — the established
 *      way this repo shares one predicate across several read sites, e.g.
 *      `UNCONSUMED_STAGING_OR` in packages/services/src/gst/invoice-engine.service.ts
 *   3. a `function …Where(…)` that RETURNS a filter object — MONEY-1236.
 *
 * Shape 3 exists because extracting the predicate into a named helper is now
 * this repo's PREFERRED form: `welcomeClaimWhere` and `manualHoldingWhere` were
 * both added by the very change that repaired these filters. Their return type
 * is structural, not `Prisma.*WhereInput`, and their bodies contain no literal
 * `where:` — so shapes 1 and 2 saw neither of them. The guard's coverage was
 * shrinking at exactly the rate the good pattern spread.
 */
function filterBlocks(src: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const push = (openIdx: number): void => {
    out.push({ start: openIdx, end: balancedEnd(src, openIdx) });
  };
  for (const m of src.matchAll(/\bwhere\s*:\s*\{/g))
    push(m.index! + m[0].length - 1);
  for (const m of src.matchAll(
    /:\s*Prisma\.\w*WhereInput(?:\[\])?\s*=\s*([{[])/g
  )) {
    push(m.index! + m[0].length - 1);
  }
  // Shape 3: every `return { … }` inside a function whose name ends in `Where`.
  for (const m of src.matchAll(/\bfunction\s+(\w*[Ww]here)\s*[(<]/g)) {
    let bodyOpen = src.indexOf("{", m.index! + m[0].length - 1);
    if (bodyOpen === -1) continue;
    // SKIP EVERY `{ … }` THAT IS NOT THE BODY. A signature can put three kinds
    // of object block ahead of it, and an annotation contains no `return`, so
    // landing on one makes the whole function invisible while looking covered:
    //
    //   a GENERIC CONSTRAINT    function fooWhere<T extends { … }>(…)
    //   a PARAMETER TYPE        function fooWhere(args: { … }): Prisma.X
    //   a RETURN TYPE           function fooWhere(x): { … } { … }   (and unions)
    //
    // Measured 2026-09-14 on `schemeCodeWhere` (MONEY-1294): a bare
    // `{ amfiSchemeCode: null }` planted in its body passed 7/7.
    //
    // The walk used to advance only while the next non-space character after a
    // block was another `{`, which handles the RETURN-type case alone — on a
    // PARAMETER block the next character is `)` and the walk stopped there,
    // scanning the parameter type as if it were the body. Measured over the
    // repo, that hid five live `*Where` functions: `buildUsScopeWhere`,
    // `buildDocumentListWhere`, `buildMutualFundWhere`, `buildPostListWhere`
    // and `buildInsightByDocumentWhere`.
    //
    // So the rule is stated the other way round: keep advancing while the next
    // character says "that block was NOT the body". `) , >` close a parameter
    // list or a generic; `{ | & [` continue a return-type annotation; `=` is a
    // parameter default. The body is the first block followed by none of them —
    // after it comes `}`, `export`, `function`, or the end of the file.
    for (let guard = 0; guard < 16; guard++) {
      const end = balancedEnd(src, bodyOpen);
      const after = /\S/.exec(src.slice(end));
      if (!after || !"{|&[),>=".includes(after[0])) break;
      const next = src.indexOf("{", end);
      if (next === -1) break;
      bodyOpen = next;
    }
    // THE WHOLE BODY, not only its `return { … }` literals. Three of the five
    // functions the walk above was missing build their filter by MUTATION —
    // `const where: X = { userId }; if (f.cat) where.category = f.cat; return
    // where;` — so `return` is followed by an identifier and a `return {` rule
    // finds nothing in them even once the body is reachable. Inside a function
    // whose name ends in `Where`, an `<optional scalar>: null` anywhere in the
    // body is the finding; there is no second meaning for it to have.
    push(bodyOpen);
  }
  return out;
}

interface Offender {
  key: string;
  line: number;
}

/**
 * Scan one file. `blanked` must already have had comments blanked.
 *
 * The `isSet` arm is looked for in the filter block AND in the body of any
 * top-level const the block pulls in from an `OR:` / `AND:` / `NOT:` / spread
 * position. Without that step the guard reports four false positives against
 * the ALREADY-FIXED GST invoice engine, which is precisely the kind of noise
 * that gets a guard switched off.
 */
function scan(
  relPath: string,
  raw: string,
  blanked: string,
  optional: Set<string>
): Offender[] {
  const consts = constBodies(blanked);
  const seen = new Map<string, number>();

  for (const block of filterBlocks(blanked)) {
    const body = blanked.slice(block.start, block.end);

    let scope = body;
    const referenced = new Set<string>();
    for (const r of body.matchAll(/\b(?:OR|AND|NOT)\s*:\s*(\w+)\b/g))
      referenced.add(r[1]);
    for (const r of body.matchAll(/\.\.\.(\w+)\b/g)) referenced.add(r[1]);
    for (const name of referenced) {
      const text = consts.get(name);
      if (text) scope += "\n" + text;
    }

    for (const m of body.matchAll(
      /\b(\w+)\s*:\s*(?:null\b|\{\s*equals\s*:\s*null\s*\})/g
    )) {
      const field = m[1];
      // `equals`/`not` are operator keys, not field names.
      if (field === "equals" || field === "not") continue;
      if (!optional.has(field)) continue;
      // An adjacent `isSet` arm for the SAME field is the established fix.
      if (new RegExp(`\\b${field}\\s*:\\s*\\{[^{}]*isSet\\b`).test(scope))
        continue;

      const abs = block.start + m.index!;
      const line = raw.slice(0, abs).split("\n").length;
      // Opt-out marker on the offending line or the 5 lines above it. Read from
      // the RAW source: blankComments has erased it from `blanked`.
      const rawLines = raw.split("\n");
      const window = rawLines.slice(Math.max(0, line - 6), line).join("\n");
      if (/\/\/\s*prisma-null-ok:/.test(window)) continue;

      const key = `${relPath}::${field}`;
      if (!seen.has(key)) seen.set(key, line);
    }
  }

  return [...seen].map(([key, line]) => ({ key, line }));
}

async function sourceFiles(): Promise<string[]> {
  const out: string[] = [];
  // ASYNC on purpose — node runs test FILES in parallel, and a synchronous walk
  // + read of ~2,400 files blocks the event loop long enough to push borderline
  // neighbours past their per-file timeout (the lesson recorded in
  // comment-strip-ordering.test.ts).
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      try {
        const s = await stat(full);
        if (s.isDirectory()) await walk(full);
        else if (
          (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
          !entry.endsWith(".test.ts") &&
          !entry.endsWith(".d.ts")
        ) {
          out.push(full);
        }
      } catch {
        continue;
      }
    }
  };
  for (const root of SCAN_ROOTS) await walk(join(REPO, root));
  return out;
}

async function allOffenders(optional: Set<string>): Promise<Offender[]> {
  const files = await sourceFiles();
  const out: Offender[] = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    // Cheap pre-filter: no `null` anywhere means nothing to find.
    if (!raw.includes("null")) continue;
    out.push(
      ...scan(file.slice(REPO.length + 1), raw, blankComments(raw), optional)
    );
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------

describe("MONEY-1236 — Prisma `where` must not spell 'unset' as a bare null", () => {
  const schemaPromise = readFile(
    join(REPO, "packages", "database", "prisma", "schema.prisma"),
    "utf8"
  );
  const optionalPromise = schemaPromise.then(optionalScalarFields);
  const offendersPromise = optionalPromise.then(allOffenders);

  it("[meta] the schema parse is live", async () => {
    const optional = await optionalPromise;
    // A scan that silently matches nothing passes (MONEY-1093). If the schema
    // parser breaks, `optional` empties and every assertion below is vacuous.
    assert.ok(
      optional.size > 300,
      `expected 300+ optional scalar field names in schema.prisma, found ${optional.size} ` +
        `— the schema parser is broken and every assertion below is vacuous`
    );
    for (const field of ["syncBucket", "cancelledAt", "proEntitlementType"]) {
      assert.ok(
        optional.has(field),
        `${field} must parse as an optional scalar`
      );
    }
  });

  it("[meta] the source walk is live", async () => {
    const files = await sourceFiles();
    assert.ok(
      files.length > 1500,
      `expected 1500+ scannable source files, found ${files.length} — the walker is broken`
    );
  });

  it("[meta] the rule flags a known-bad sample and spares four known-good ones", async () => {
    const optional = await optionalPromise;
    const run = (src: string): Offender[] =>
      scan("sample.ts", src, blankComments(src), optional);

    // BAD — the MONEY-1236 shape.
    const bad = `await prisma.subscription.findMany({
      where: { planId: "PRO", proEntitlementType: null },
    });`;
    assert.deepEqual(
      run(bad).map((o) => o.key),
      ["sample.ts::proEntitlementType"],
      "the bare-null shape must be flagged — if this stops matching, the " +
        "repo-wide check below reports clean forever"
    );

    // BAD — the `equals` spelling of the same thing.
    const badEquals = `await prisma.subscription.findMany({
      where: { cancelledAt: { equals: null } },
    });`;
    assert.deepEqual(
      run(badEquals).map((o) => o.key),
      ["sample.ts::cancelledAt"],
      "`{ equals: null }` is the same equality and must be flagged too"
    );

    // GOOD 1 — the established fix.
    const fixed = `await prisma.subscription.findMany({
      where: {
        planId: "PRO",
        OR: [{ proEntitlementType: null }, { proEntitlementType: { isSet: false } }],
      },
    });`;
    assert.deepEqual(run(fixed), [], "the isSet arm must clear the finding");

    // GOOD 2 — "has a value". Flagging this is the false positive that would
    // get the guard disabled.
    const hasValue = `await prisma.subscription.findMany({
      where: { endDate: { not: null } },
    });`;
    assert.deepEqual(
      run(hasValue),
      [],
      "`{ not: null }` must NEVER be flagged"
    );

    // GOOD 3 — raw Mongo, where `null` genuinely does reach an absent key.
    const rawMongo = `await prisma.$runCommandRaw({
      aggregate: "Subscription",
      pipeline: [{ $match: { cancelledAt: null } }],
      cursor: {},
    });`;
    assert.deepEqual(
      run(rawMongo),
      [],
      "raw Mongo bodies must never be flagged"
    );

    // GOOD 4 — a write. `data:` sets the field; it does not filter on it.
    const write = `await prisma.subscription.updateMany({
      where: { id: { in: ids } },
      data: { endDate: null, proEntitlementType: null },
    });`;
    assert.deepEqual(run(write), [], "`data:` payloads must never be flagged");
  });

  it("[meta] a hoisted OR-const satisfies the rule, and the opt-out marker works", async () => {
    const optional = await optionalPromise;
    const run = (src: string): Offender[] =>
      scan("sample.ts", src, blankComments(src), optional);

    // The shape packages/services/src/gst/invoice-engine.service.ts uses: one
    // shared predicate, four read sites. Without const resolution this reports
    // four false positives against already-correct code.
    const hoisted = `const UNCONSUMED_OR: Prisma.DodoPayoutStagingWhereInput[] = [
      { consumedByInvoiceId: null },
      { consumedByInvoiceId: { isSet: false } },
    ];
    await prisma.dodoPayoutStaging.findMany({
      where: { OR: UNCONSUMED_OR, currency: "USD" },
    });`;
    assert.deepEqual(
      run(hoisted),
      [],
      "a hoisted OR-const carrying isSet is the fix"
    );

    // …and the same const WITHOUT the isSet arm is still caught, so the
    // resolution step cannot be used to launder a bad predicate.
    const hoistedBad = `const UNCONSUMED_OR: Prisma.DodoPayoutStagingWhereInput[] = [
      { consumedByInvoiceId: null },
    ];
    await prisma.dodoPayoutStaging.findMany({
      where: { OR: UNCONSUMED_OR },
    });`;
    assert.deepEqual(
      run(hoistedBad).map((o) => o.key),
      ["sample.ts::consumedByInvoiceId"],
      "hoisting a bad predicate into a const must not hide it"
    );

    const optedOut = `await prisma.subscription.count({
      where: {
        // prisma-null-ok: measuring what the BROKEN filter sees, on purpose
        proEntitlementType: null,
      },
    });`;
    assert.deepEqual(
      run(optedOut),
      [],
      "the opt-out marker must suppress the finding"
    );
  });

  it("[regression] no NEW site filters an optional field with a bare null", async () => {
    const offenders = await offendersPromise;
    const unlisted = offenders
      .filter((o) => !KNOWN_UNFIXED.has(o.key))
      .map((o) => `${o.key}  (line ${o.line})`);

    assert.deepEqual(
      unlisted,
      [],
      "On Prisma + MongoDB `{ field: null }` matches ONLY documents that carry " +
        "the key, so this filter cannot see a row where the field was never " +
        "written — and the query SUCCEEDS, returning fewer rows than exist. " +
        "Fix: `OR: [{ f: null }, { f: { isSet: false } }]`. If the bare null is " +
        "deliberate (a diagnostic measuring the difference, or raw Mongo), add " +
        "`// prisma-null-ok: <why>` on or just above the line.\n" +
        unlisted.join("\n")
    );
  });

  it("[ratchet] every KNOWN_UNFIXED entry is still a live finding", async () => {
    const offenders = await offendersPromise;
    const live = new Set(offenders.map((o) => o.key));
    const stale: string[] = [];
    for (const key of KNOWN_UNFIXED.keys()) {
      if (live.has(key)) continue;
      // A permit pointing at a file that no longer exists permits nothing, and
      // failing on it would be noise rather than signal.
      const [path] = key.split("::");
      try {
        await stat(join(REPO, path));
      } catch {
        continue;
      }
      stale.push(key);
    }

    assert.deepEqual(
      stale,
      [],
      "these sites were fixed (or given a `prisma-null-ok` marker) but are " +
        "still listed as known-unfixed. Delete their lines from KNOWN_UNFIXED — " +
        "the list must only ever shrink, otherwise it rots into a blanket " +
        "permit that would let the same defect back in at exactly these spots.\n" +
        stale.join("\n")
    );
  });

  it("[fix] the three MONEY-1236 scripts carry the isSet arm", async () => {
    // A liveness floor on the fix itself. Without it, a revert to the bare
    // `null` would be caught by the regression test above — but only as long as
    // the scanner works, and this asserts the fix's TEXT independently.
    for (const [path, field] of [
      ["scripts/ops/backfill-syncbucket.ts", "syncBucket"],
      ["scripts/migrations/fix-premium-enddate.ts", "cancelledAt"],
      ["scripts/migrations/backfill-pro-entitlement.ts", "proEntitlementType"],
    ] as const) {
      const src = await readFile(join(REPO, path), "utf8");
      assert.match(
        src,
        new RegExp(`${field}\\s*:\\s*\\{\\s*isSet:\\s*false\\s*\\}`),
        `${path} must filter ${field} with an isSet arm, not a bare null`
      );
      // …and each verifies through raw Mongo rather than re-running the filter
      // it selected with. That is the durable half of MONEY-1236.
      assert.match(
        src,
        /\$runCommandRaw/,
        `${path} must verify by an INDEPENDENT route ($runCommandRaw), not by ` +
          `re-issuing the selection's own predicate`
      );
    }
  });
});
