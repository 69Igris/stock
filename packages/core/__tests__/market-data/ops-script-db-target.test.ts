/**
 * Ops scripts must resolve their database target BEFORE constructing a client.
 *
 * `@usemoney/database` builds its PrismaClient at MODULE scope and bakes
 * `process.env.DATABASE_URL` into the constructor
 * (`packages/database/client.ts:40-47`). ESM evaluates every static import
 * before ANY statement in the importing module's body — so a static
 * `import prisma from "@usemoney/database"` in a script that resolves
 * `--env qa|prod` inside `main()` pins the client to whatever `DATABASE_URL`
 * the shell happened to export.
 *
 * That produced the worst failure shape a safety prompt can have: `--env prod`
 * was silently ignored, the client wrote to the shell's database, and
 * `confirmWrite` echoed the host that `--env` had resolved. The operator typed
 * "yes" to one database and wrote to another.
 *
 * An earlier version of this note claimed it "looked correct on the maintainer's
 * machine because the shell had no DATABASE_URL". That was wrong: `tsx`
 * auto-injects `.env`, so a repo `.env` supplies DATABASE_URL before `main()`
 * under BOTH documented invocations and the bug reproduced locally too. The
 * reason it survived was not environment-dependence — it was that nothing
 * asserted the import graph.
 *
 * The transitive case is just as fatal and much easier to reintroduce: a static
 * import of the `@usemoney/core/market-data` BARREL pulls `syncInstruments`,
 * which imports `@usemoney/database`. `resector-real-estate.ts` deferred its own
 * prisma import correctly and was still broken by that barrel.
 *
 * This is a static scan because the defect is invisible at runtime on a machine
 * with `DATABASE_URL` unset, which is exactly where tests run.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Resolved from THIS FILE, not from cwd. A cwd-relative path throws inside the
 * describe callback, which node reports as a dropped suite with `fail 0` and
 * exit 0 — the guard would silently disappear instead of failing.
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/** Scripts that connect to a database AND accept an --env flag. */
const OPS_SCRIPTS = [
  // MONEY-1485 — the FIRST ops script in this repo that actually carried the
  // static import this guard forbids, and it was not listed, so the guard could
  // not see it. It reaches `@usemoney/database` TRANSITIVELY, through
  // `packages/core/src/database/index-guard.ts`; that module now defers with
  // `await import("@usemoney/database")` inside `auditDatabaseIndexes`, so the
  // client is built after `--env qa|prod` is final. Listed so a future static
  // import trips this rather than auditing whatever DATABASE_URL the shell
  // exported while printing the host `--env` resolved.
  "scripts/ops/verify-db-indexes.ts",
  "scripts/data/reclassify-instruments.ts",
  "scripts/data/resector-real-estate.ts",
  // MONEY-1205 — same shape: --env qa|prod, a confirmWrite that echoes the
  // resolved host, and a lazy `await import("@usemoney/database")` inside
  // main(). Listed here so a future static import trips this guard rather than
  // writing instrument names to whatever DATABASE_URL the shell exported.
  "scripts/data/repair-instrument-names.ts",
  // MONEY-1205 — a prod writer over 32,359 `StockFinancials` rows with the same
  // shape again: `--env qa|prod`, a `confirmWrite` that echoes the RESOLVED
  // host, and a lazy `await import("@usemoney/database")` inside main().
  //
  // It was added importing `mayOverwriteFinancials` from the
  // `@usemoney/core/market-data` BARREL, which reaches the DB as a value
  // through ten modules (`instrument-sync`, `quote-service`, `mf-nav-service`,
  // …) — the transitive case this file was written for, reintroduced by a
  // guard that was itself a correctness fix. Listed here so the next one trips
  // the scan instead of writing to the database the prompt did not name.
  "scripts/data/backfill-financials-from-rawdata.ts",
  // MONEY-1300 — the vendor-row `basis` stamp, same shape once more: `--env
  // qa|prod`, a TTY-gated `--apply` that echoes the resolved host, and a lazy
  // `await import("@usemoney/database")` inside main().
  //
  // It carries its own static-import assertions, which is why it was correct
  // before this line existed. Listed anyway so it gets the TRANSITIVE closure
  // walk the local check cannot do: the defect this file exists for is not a
  // direct import of `@usemoney/database` but a barrel that reaches it through
  // ten modules, and no per-script assertion can see that.
  "scripts/data/backfill-financials-basis.ts",
  // MONEY-1401 B3 — the vendor-row SNAPSHOT/RESTORE, and the one on this list
  // whose blast radius is the whole of both tables: `--restore --apply` rewrites
  // every `stock_ratios` and `stock_financials` row it holds. Same shape as the
  // rest — `--env qa|prod`, a TTY-gated `--apply` that echoes the resolved
  // host, and a lazy `await import("@usemoney/database")` inside `main()`.
  //
  // Its only non-stdlib import is the sibling `-logic` module, which has ZERO
  // imports of its own, so it is correct today by construction. Listed anyway
  // for the TRANSITIVE closure walk: the defect this file exists for is not a
  // direct import of `@usemoney/database` but a barrel that reaches it through
  // ten modules, and the day someone reaches for a formatting helper out of
  // `@usemoney/core/market-data` here is the day that matters.
  "scripts/data/snapshot-vendor-fundamentals.ts",
  // MONEY-1530 / MONEY-1535 — the two `corporate_actions` repairs: a date
  // re-anchor that DELETES 1,772 duplicate rows and rewrites ~47,000, and a
  // `dividendPerShare` repair over ~14,000. Both take `--env=qa|prod`, resolve
  // it through `pinJobEnv`, and build their OWN `PrismaClient` from that URI in
  // their own source — the "own client" shape — so there is no singleton to
  // mis-target. Their shared I/O module (`corporate-action-repair-io.ts`)
  // deliberately does NOT construct a client, which is why each script is
  // listed here rather than the module: the closure walk below covers the
  // module as part of each script's static imports.
  "scripts/data/reanchor-corporate-action-dates.ts",
  "scripts/data/repair-corporate-action-dividends.ts",
  "scripts/data/repair-corporate-action-bonus.ts", // MONEY-1542, same shape
  "scripts/data/repair-corporate-action-subjects.ts", // MONEY-1598/1599
  "scripts/data/retire-derived-corporate-actions.ts", // MONEY-1600, same shape
  // MONEY-1617 — relabels ~62,700 US candles (Mongo + cold shards). Same "own
  // client from pinJobEnv" shape, and it reuses corporate-action-repair-io.
  "scripts/data/relabel-us-candles.ts",
];

const DB_PACKAGE = "@usemoney/database";

/** Resolve a workspace or relative specifier to a file path, or null. */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  if (spec.startsWith(".")) {
    const base = join(dirname(fromFile), spec);
    for (const cand of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
    ]) {
      if (existsSync(cand) && !cand.endsWith("/")) {
        try {
          if (readFileSync(cand, "utf8") !== undefined) return cand;
        } catch {
          /* directory */
        }
      }
    }
    return null;
  }
  const m = /^@usemoney\/([^/]+)(?:\/(.+))?$/.exec(spec);
  if (!m) return null; // external dependency — not our graph
  const pkgDir = join(REPO_ROOT, "packages", m[1]!);
  const pkgJson = join(pkgDir, "package.json");
  if (!existsSync(pkgJson)) return null;
  const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as {
    exports?: Record<string, unknown>;
    main?: string;
  };
  const key = m[2] ? `./${m[2]}` : ".";
  const target = pkg.exports?.[key] ?? (key === "." ? pkg.main : undefined);
  if (typeof target !== "string") return null;
  const full = join(pkgDir, target);
  return existsSync(full) ? full : null;
}

/**
 * Every module statically reachable from `entry`, and whether any of them
 * imports `@usemoney/database` as a VALUE (a `import type` is erased at compile
 * time and so cannot construct the client).
 *
 * A denylist of known barrels is NOT sufficient, and that is not theoretical:
 * the first version of this test enumerated three barrels and missed
 * `@usemoney/core/market-data/instrument-classification`, whose closure reaches
 * `instruments/types.ts` -> `import type { Prisma } from "@usemoney/database"`.
 * Type-only today, so safe — but deleting the word `type` there silently
 * reinstates the write-to-the-wrong-database bug with the guard still green.
 */
function findDbReachers(entry: string): {
  valueImporters: string[];
  typeOnlyImporters: string[];
} {
  const seen = new Set<string>();
  const queue = [entry];
  const valueImporters: string[] = [];
  const typeOnlyImporters: string[] = [];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    for (const { spec, typeOnly } of staticImports(src)) {
      if (spec === DB_PACKAGE) {
        const rel = file.replace(`${REPO_ROOT}/`, "");
        if (typeOnly) typeOnlyImporters.push(rel);
        else valueImporters.push(rel);
        continue;
      }
      const next = resolveSpecifier(spec, file);
      if (next) queue.push(next);
    }
  }
  return { valueImporters, typeOnlyImporters };
}

function read(rel: string): string {
  const full = join(REPO_ROOT, rel);
  assert.ok(existsSync(full), `${rel} not found — did it move or get renamed?`);
  return readFileSync(full, "utf8");
}

/**
 * Static imports AND re-exports. `await import(...)` is deliberately ignored.
 *
 * `export ... from` is not optional here: every barrel in this repo is built
 * entirely from re-exports — `packages/core/src/market-data/index.ts` has ZERO
 * `import` statements and twelve `export ... from`. A version of this scan that
 * matched only `import` extracted 0 specifiers from that barrel, so the closure
 * walk stopped dead at the exact module whose barrel import broke
 * `resector-real-estate.ts` and motivated this whole test. It passed only
 * because the two live closures happened to contain no re-export.
 */
function staticImports(
  src: string,
): Array<{ spec: string; typeOnly: boolean }> {
  const out: Array<{ spec: string; typeOnly: boolean }> = [];
  // `import ... from "x"` and `export ... from "x"` — both pull the module in
  // and both execute its top-level side effects.
  const re =
    /^[ \t]*(?:import|export)\s+(type\s+)?([^;]*?)from\s*["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push({ spec: m[3]!, typeOnly: Boolean(m[1]) });
  }
  const re2 = /^[ \t]*import\s*["']([^"']+)["']/gm;
  while ((m = re2.exec(src)) !== null) {
    out.push({ spec: m[1]!, typeOnly: false });
  }
  return out;
}

/** Static specifiers of one file, for the direct-import assertion. */
function staticImportSpecifiers(src: string): string[] {
  return staticImports(src).map((i) => i.spec);
}

describe("ops scripts never construct a DB client before resolving --env", () => {
  for (const rel of OPS_SCRIPTS) {
    it(`${rel} does not STATICALLY import @usemoney/database`, () => {
      const specs = staticImportSpecifiers(read(rel));
      assert.ok(
        !specs.includes("@usemoney/database"),
        `${rel} statically imports @usemoney/database. The client would be ` +
          `built from the shell's DATABASE_URL before --env is resolved, and ` +
          `the confirmation prompt would echo a host that is NOT the one ` +
          `written to. Use \`await import("@usemoney/database")\` after the ` +
          `env is final.`,
      );
    });

    it(`nothing in ${rel}'s static closure imports the DB as a value`, () => {
      // The whole transitive graph, not a denylist of barrels.
      const { valueImporters } = findDbReachers(join(REPO_ROOT, rel));
      assert.deepEqual(
        valueImporters,
        [],
        `${rel} statically reaches ${DB_PACKAGE} as a VALUE via: ` +
          `${valueImporters.join(", ")}. That constructs the PrismaClient from ` +
          `the shell's DATABASE_URL before --env is resolved, so the script ` +
          `writes to a different database than the prompt names. Import a ` +
          `narrower subpath, or make the offending import type-only.`,
      );
    });

    it(`${rel}'s closure keeps any DB import TYPE-ONLY`, () => {
      // Documents the load-bearing subtlety: `import type` is erased, so it is
      // allowed — but it is one keyword away from reinstating the bug, and this
      // records exactly which files that applies to.
      const { typeOnlyImporters } = findDbReachers(join(REPO_ROOT, rel));
      for (const f of typeOnlyImporters) {
        const src = readFileSync(join(REPO_ROOT, f), "utf8");
        const hit = staticImports(src).find((i) => i.spec === DB_PACKAGE);
        assert.equal(
          hit?.typeOnly,
          true,
          `${f} is in ${rel}'s static closure and imports ${DB_PACKAGE}. It ` +
            `MUST stay \`import type\` — dropping that keyword makes the ` +
            `client construct before --env resolves.`,
        );
      }
    });

    it(`${rel} DOES defer the database import`, () => {
      // The positive half: absence of a static import could also mean the
      // script no longer touches the DB at all, which would make the two
      // assertions above vacuous.
      //
      // TWO shapes satisfy it, and the second is STRICTER rather than an
      // exemption (MONEY-1485):
      //
      //   deferred singleton   `await import("@usemoney/database")` inside
      //                        main(), so the shared client is constructed
      //                        after `--env` is final.
      //   own client           `new PrismaClient({datasources:{db:{url}}})`
      //                        with the url RESOLVED from `--env`. There is no
      //                        singleton to mis-target at all, so the defect
      //                        this file exists for cannot occur — the client
      //                        cannot exist before the url that defines it.
      //                        `scripts/data/set-market-data-flags.ts` has
      //                        always had this shape.
      //
      // Both are non-vacuous in the way that matters: each names a client
      // built from a target the script itself resolved.
      const src = read(rel);
      const deferredSingleton =
        /await import\(\s*["']@usemoney\/database["']\s*\)/.test(src);
      const ownClient =
        /new PrismaClient\(/.test(src) && /datasources/.test(src);
      assert.ok(
        deferredSingleton || ownClient,
        `${rel} should either defer the @usemoney/database import inside ` +
          "main(), or construct its own PrismaClient from the url that " +
          "--env resolved",
      );
    });
  }

  it("the premise still holds: the client is built at module scope", () => {
    // If @usemoney/database ever becomes lazy itself, this whole file can go.
    // Until then, that module-scope construction is WHY the rules above exist.
    const client = read("packages/database/client.ts");
    assert.match(
      client,
      /export const prisma\s*=/,
      "client.ts no longer exports a module-scope prisma — re-evaluate this test",
    );
    assert.match(
      client,
      /process\.env\.DATABASE_URL/,
      "client.ts no longer reads DATABASE_URL at module scope — re-evaluate",
    );
  });
});

describe("the confirmation echoes the SAME value used to connect", () => {
  for (const rel of OPS_SCRIPTS) {
    it(`${rel} does not re-read process.env.DATABASE_URL for the prompt`, () => {
      // Deriving the echo from a separate read of the env is how the prompt and
      // the connection came to disagree. Both must come from one local value.
      const src = read(rel);
      assert.doesNotMatch(
        src,
        /confirmWrite\(\s*process\.env\.DATABASE_URL/,
        `${rel} passes a fresh process.env read into confirmWrite; pass the ` +
          `single resolved URI that the client was built from instead`,
      );
    });
  }
});
