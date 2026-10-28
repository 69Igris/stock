/**
 * The sector-write invariant (MONEY-1093): only equity-like instruments may
 * carry a `sector`.
 *
 * Two halves, deliberately different in kind.
 *
 * The first half tests the guard's BEHAVIOUR — real calls, real inputs. Those
 * assertions fail if the allow-list changes, which is the point.
 *
 * The second half is a source scan, and it exists because the behavioural half
 * cannot catch the failure that actually happened: a NEW writer that never
 * imports the guard at all. Three earlier attempts on this ticket enumerated
 * the writers they knew about and were defeated by the one they did not — the
 * predecessor of this file says so in its own header ("This scan pins only the
 * two it can read as source text"). So this scan DISCOVERS writers by walking
 * the tree for `instrumentMapping.update*` calls whose `data` writes `sector`,
 * and requires each one to carry a type predicate. Adding an unguarded writer
 * turns it red without anyone remembering to update a list.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  SECTOR_BEARING_TYPES,
  sectorWritableWhere,
  isSectorBearing,
} from "../../src/market-data/instruments/sector-write-guard";

/** Resolved from THIS FILE, not cwd — a cwd-relative path throws inside the
 *  describe body, which node reports as a dropped suite (`fail 0`, exit 0). */
const REPO = join(import.meta.dirname, "..", "..", "..", "..");

describe("the allow-list itself", () => {
  it("permits equity-like types", () => {
    for (const t of ["EQUITY", "REIT", "INVIT"]) {
      assert.equal(isSectorBearing(t), true, t);
    }
  });

  it("refuses DEBT — the whole reason this exists", () => {
    assert.equal(isSectorBearing("DEBT"), false);
  });

  it("refuses the other non-equity types", () => {
    // A bond has an issuer, not a sector; an index/derivative has neither. MF
    // and ETF have a scheme category, which is a different taxonomy and is not
    // stored in this column.
    for (const t of ["MF", "ETF", "INDEX", "FUTURES", "OPTIONS"]) {
      assert.equal(isSectorBearing(t), false, t);
    }
  });

  it("keeps REIT and INVIT — a bare EQUITY guard would strand the trusts", () => {
    // REITs are the reason "Real Estate" became a canonical sector on this
    // ticket, and `reclassify-instruments.ts` deliberately does NOT retype the
    // ~7 real trusts (so their news/filings sync keeps working). Guarding on
    // `instrumentType: "EQUITY"` alone would leave every one of them with no
    // sector, forever, since the enrichment pipeline only fetches null-sector
    // rows and this guard would then reject the write.
    assert.ok(SECTOR_BEARING_TYPES.includes("REIT"));
    assert.ok(SECTOR_BEARING_TYPES.includes("INVIT"));
  });

  it("treats an absent/blank type as equity, matching the schema default", () => {
    // `instrumentType String @default("EQUITY")`, and a Mongo document written
    // before the field existed can lack it. This function only decides whether
    // to BOTHER enriching, so it biases toward "yes" — the WHERE below is the
    // one that must fail closed.
    assert.equal(isSectorBearing(undefined), true);
    assert.equal(isSectorBearing(null), true);
    assert.equal(isSectorBearing(""), true);
  });

  it("is insensitive to case and surrounding whitespace", () => {
    // Real stored values have both: the bhavcopy plan accepts a lenient
    // " EQUITY" that a strict WHERE then rejects, which is a documented source
    // of silent no-ops on this ticket.
    for (const t of [" DEBT ", "debt", "Debt"]) {
      assert.equal(isSectorBearing(t), false, JSON.stringify(t));
    }
    assert.equal(isSectorBearing(" equity "), true);
  });
});

describe("the WHERE fragment", () => {
  it("is a positive `in` filter, never a negation", () => {
    // `{ not: "DEBT" }` / `{ notIn: [...] }` does NOT match a Mongo document
    // that lacks the field (MONEY-1050), so a negation would silently skip
    // legacy rows. An allow-list skips them too, but in the safe direction.
    const w = sectorWritableWhere();
    assert.deepEqual(w, {
      instrumentType: { in: ["EQUITY", "REIT", "INVIT"] },
    });
    const serialised = JSON.stringify(w);
    assert.ok(!serialised.includes("not"), "must not use a negated predicate");
  });

  it("returns a fresh object each call", () => {
    // Sharing one literal across call sites invites a caller to mutate it and
    // silently change every other writer's filter.
    const a = sectorWritableWhere();
    const b = sectorWritableWhere();
    assert.notEqual(a, b);
    a.instrumentType.in.push("DEBT");
    assert.deepEqual(b.instrumentType.in, ["EQUITY", "REIT", "INVIT"]);
  });

  it("agrees with isSectorBearing", () => {
    // The two must not drift: one gates the network call, the other the write.
    const allowed = sectorWritableWhere().instrumentType.in;
    for (const t of allowed) assert.equal(isSectorBearing(t), true, t);
    assert.equal(allowed.includes("DEBT"), false);
  });
});

// ── The discovery scan ───────────────────────────────────────────────────

/** Directories that hold UNATTENDED writers — code that runs without an
 *  operator watching. `scripts/` is excluded deliberately: those are
 *  operator-invoked, dry-run-by-default, and prompt before writing, and the two
 *  that write a real sector are pinned individually in
 *  `sector-writer-normalisation.test.ts`. Stated so the coverage of this scan
 *  is not mistaken for "every writer in the repo". */
const RUNTIME_ROOTS = ["apps", "packages", "workers"];

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  "__tests__",
  "coverage",
  ".turbo",
]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e)) out.push(full);
  }
  return out;
}

/**
 * Extract each `instrumentMapping.update|updateMany|upsert({ ... })` call by
 * brace balancing, so nested objects do not truncate the match the way a
 * non-greedy regex would.
 */
function extractWriteCalls(src: string): Array<{ call: string; at: number }> {
  const calls: Array<{ call: string; at: number }> = [];
  const re = /instrumentMapping\s*\.\s*(?:updateMany|update|upsert)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1; // at the '('
    const start = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    // The OFFSET is returned alongside the text. Deriving it later with
    // `indexOf(call)` is wrong: sector-enrichment.ts holds two near-identical
    // batch flushes, so `indexOf` resolved BOTH to the first one's position and
    // reported the same line for each — defeating the disambiguation it was
    // added for.
    calls.push({ call: src.slice(start, i + 1), at: m.index });
  }
  return calls;
}

/** Strip comments so prose mentioning `sector:` cannot make a call look like a
 *  writer, and a commented-out guard cannot make one look guarded. */
function stripComments(s: string): string {
  return s.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
}

interface Writer {
  file: string;
  call: string;
  /** 1-indexed line of the call, so two writers in one file are distinguishable. */
  line: number;
}

function findSectorWriters(): Writer[] {
  const found: Writer[] = [];
  for (const root of RUNTIME_ROOTS) {
    for (const file of walk(join(REPO, root))) {
      let src: string;
      try {
        src = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!src.includes("instrumentMapping")) continue;
      // Strip comments BEFORE extracting, not after. Stripping afterwards fails
      // both ways: a documentation example inside a JSDoc block is extracted as
      // a real writer (this file's own docstring was flagged), and a
      // commented-out `where` clause still counts as a guard because the
      // extracted fragment no longer contains the `/**` that opened the comment.
      const stripped = stripComments(src);
      for (const { call, at } of extractWriteCalls(stripped)) {
        const code = call;
        // Only calls whose DATA writes a sector. A `where` that reads sector
        // (e.g. selecting null-sector rows) is not a writer.
        const data = /data\s*:\s*\{([\s\S]*)$/.exec(code);
        if (!data) continue;
        // `sector:` OR the ES6 shorthand `{ sector, industry }`. Matching only
        // the colon form is not hypothetical pedantry: the first version of this
        // scan did exactly that and missed `flushUpdates` in
        // sector-enrichment.ts — a nightly worker writing a real sector — which
        // is the single most important writer in the set. The trailing class
        // keeps `sectorSource:` and `normalizeToNseSector(` from matching.
        if (!/\bsector\s*[,:}]/.test(data[1]!)) continue;
        // Writing `sector: null` REMOVES a sector. That is the safe direction —
        // it can never put one back onto a bond — so it needs no type guard.
        if (/\bsector\s*:\s*null/.test(data[1]!)) continue;
        // The SKIPPED sentinel ("N/A") is not a sector either: it means "Yahoo
        // has no data for this symbol, stop retrying", and every read path
        // rejects it via `isUsableSector`. Requiring a type predicate on these
        // would add a guard that can never fire — their ids come from a read
        // already scoped to `instrumentType: "EQUITY"` with no network call in
        // between, so the window a predicate would close is a few
        // milliseconds of synchronous partitioning. Contrast `flushUpdates` in
        // the same file, which holds its ids across a live Yahoo call PER
        // INSTRUMENT and therefore does need one. A dead guard is worse than no
        // guard: it reads as protection and gets copied to places that are
        // genuinely exposed.
        if (/\bsector\s*:\s*SECTOR_SKIPPED\b/.test(data[1]!)) continue;
        // Line number, so two writers in ONE file get distinguishable test
        // names. sector-enrichment.ts has two near-identical batch flushes and
        // both reported under the same name, which made a failure impossible to
        // locate from the output alone. Counted in the STRIPPED source, so it is
        // an approximate guide to the call rather than an exact original-file
        // line — enough to tell the two apart, which is all it is for.
        const line = stripped.slice(0, at).split("\n").length;
        found.push({
          file: file.replace(`${REPO}/`, ""),
          call: code,
          line,
        });
      }
    }
  }
  return found;
}

describe("every unattended sector writer carries a type predicate", () => {
  const writers = findSectorWriters();

  it("the scan finds writers at all — it must not pass vacuously", () => {
    // If the walk breaks or the pattern stops matching, an empty result would
    // make every assertion below trivially true. This is the liveness check.
    assert.ok(
      writers.length >= 3,
      `expected at least 3 unattended sector writers, found ${writers.length}: ` +
        writers.map((w) => w.file).join(", "),
    );
  });

  it("finds the writers this ticket actually fixed", () => {
    // Pins the scan's REACH, not just its count: these three are the paths that
    // were re-sectoring bonds, in three different workspaces. If a refactor
    // moves one somewhere the walk does not reach, this fails rather than
    // silently reducing coverage.
    const files = writers.map((w) => w.file);
    for (const expected of [
      "packages/core/src/screener/engine.ts",
      "packages/core/src/market-data/instruments/sector-enrichment.ts",
      "apps/web/lib/actions/stock-sector.ts",
    ]) {
      assert.ok(
        files.some((f) => f === expected),
        `${expected} is a known sector writer but the scan did not find it — ` +
          `the walk or the call extractor has regressed. Found: ${files.join(", ")}`,
      );
    }
  });

  for (const w of writers) {
    it(`${w.file}:${w.line} restricts its write by instrumentType`, () => {
      const where =
        /where\s*:\s*\{([\s\S]*?)\}\s*,?\s*(?:data|update|create)\s*:/.exec(
          w.call,
        );
      const clause = where?.[1] ?? w.call;
      assert.ok(
        /sectorWritableWhere\s*\(\s*\)/.test(clause) ||
          /instrumentType\s*:/.test(clause),
        `${w.file} writes InstrumentMapping.sector without an instrumentType ` +
          `predicate in its WHERE.\n\n` +
          `The nightly bhavcopy backfill types bonds DEBT and clears their ` +
          `sector, and it only ever revisits rows still typed EQUITY — so a ` +
          `sector written back here is PERMANENT and flows into holdings ` +
          `concentration, the risk stress test and the heatmap as if the bond ` +
          `were a share.\n\n` +
          `Spread \`sectorWritableWhere()\` (from ` +
          `@usemoney/core/market-data) into the where clause. If this write ` +
          `genuinely must not be filtered, say why in a comment on the same ` +
          `call and add it to the exemptions in this test deliberately.\n\n` +
          `Offending call:\n${w.call.slice(0, 400)}`,
      );
    });
  }
});
