/**
 * Shared machinery for the two lane-wiring pins — MONEY-1317.
 *
 * ## Why this is a separate, NON-TEST module
 *
 * `packages/core`'s `test` script is two `node --test` invocations joined by
 * `&&`. Each lane needs a pin, and — this is the whole point — each pin has to
 * ride in the OTHER lane, because a check that rides in the lane it is checking
 * cannot report that the lane is gone:
 *
 *   spawntest-lane-wiring.test.ts        NORMAL lane, pins the SPAWN lane
 *   normal-lane-wiring.spawntest.ts      SPAWN  lane, pins the NORMAL lane
 *
 * Two files, one subject. Everything they need to reason about the subject —
 * resolving the package root, walking `__tests__` for the two suffixes, parsing
 * the script into lanes, and translating a glob to a RegExp — is identical, and
 * a copy in each file is exactly the "one rule, stated twice, disagreeing"
 * defect that MONEY-1255 measured on `mimeType` (a strict `in:` filter in one
 * function against a substring test in its sibling, so the FILE was right while
 * the row was unreachable for 1,211 rows). Two copies of a glob translator
 * drifting apart would let one lane's pin pass over an interpretation the other
 * lane's pin rejects, and neither would look wrong.
 *
 * ## The filename is load-bearing
 *
 * It must NOT end `.test.ts` or `.spawntest.ts`. Both suffixes are lane
 * membership — `TEST_FILE_SUFFIX_SRC` in `scripts/gen-test-coverage.ts` is
 * `\.(?:spawn)?test\.tsx?` — so either name would make this module a test file
 * that declares no tests: `node --test` would load it in a lane, and the
 * coverage inventory would count it as a file with 0 cases, drifting the
 * headline the doc-freshness gate compares against. Precedent for a plain `.ts`
 * living under `__tests__`: `market-data/sync-prod-to-qa-sample-harness.ts`.
 *
 * It exports DATA (module-scope, computed once at import) and PURE PREDICATES.
 * The `assert` calls stay in the two test files, so a failure is attributed to
 * the lane it belongs to rather than to a shared import.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Derived from this file's own location (`__tests__/ops` → the package root),
// NOT from `process.cwd()`. The workspace `test` script runs with cwd =
// packages/core, but a targeted `node --test packages/core/__tests__/…` from the
// repo root does not — and a path check that silently reads a different
// package.json is the failure these files are about.
export const PKG_ROOT = join(import.meta.dirname, "..", "..");
export const TESTS_DIR = join(PKG_ROOT, "__tests__");
export const PKG_JSON = join(PKG_ROOT, "package.json");

const SKIP_DIRS = new Set(["node_modules", "fixtures", "dist", ".turbo"]);

export function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      // Slash-normalised and relative to the package root, which is exactly the
      // form the globs in `package.json` are written against.
      out.push(relative(PKG_ROOT, full).split("\\").join("/"));
    }
  }
}

export const ALL_FILES: string[] = [];
walk(TESTS_DIR, ALL_FILES);

export const SPAWNTEST_FILES = ALL_FILES.filter((f) =>
  /\.spawntest\.tsx?$/.test(f),
);
export const NORMAL_TEST_FILES = ALL_FILES.filter((f) =>
  /\.test\.tsx?$/.test(f),
);

// ── The lanes, parsed out of the real `test` script ────────────────────────
export interface Lane {
  /** The glob exactly as node receives it, quotes stripped. */
  glob: string;
  /** Was the glob quoted in the script? The MONEY-1093 property. */
  quoted: boolean;
  timeoutMs: number;
}

const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8")) as {
  scripts?: Record<string, string>;
};
export const TEST_SCRIPT = pkg.scripts?.test ?? "";

/**
 * The `&&`-joined segments of the `test` script, in order and untrimmed.
 *
 * Kept alongside the parsed lanes because the two are asserted AGAINST each
 * other: see `findSegmentIntegrityProblems` below.
 */
export const SEGMENTS = TEST_SCRIPT.split("&&");

/**
 * Split on `&&` and read each `node --test …` invocation.
 *
 * Deliberately a parse of the SHELL COMMAND rather than a search for a known
 * string: a `assert.match(script, /spawntest/)` would pass on a script that
 * merely mentions the suffix in a comment, in a different flag, or in an
 * invocation whose glob does not select anything.
 */
export function parseLanes(script: string): Lane[] {
  const lanes: Lane[] = [];
  for (const segment of script.split("&&")) {
    if (!/(^|\s)--test(\s|$)/.test(segment)) continue;
    const timeout = /--test-timeout=(\d+)/.exec(segment);
    // The trailing positional argument: the glob, with or without quotes.
    const positional =
      /(?:^|\s)(['"]?)([^\s'"]*__tests__[^\s'"]*)\1(?:\s|$)/.exec(segment);
    if (timeout === null || positional === null) continue;
    lanes.push({
      glob: positional[2]!,
      quoted: positional[1] === '"' || positional[1] === "'",
      timeoutMs: Number(timeout[1]),
    });
  }
  return lanes;
}

export const LANES = parseLanes(TEST_SCRIPT);
export const SPAWN_LANE = LANES.find((l) => l.glob.includes("spawntest"));
export const NORMAL_LANE = LANES.find((l) => !l.glob.includes("spawntest"));

/**
 * Shell operators that must not appear inside a lane segment, and why.
 *
 * `parseLanes` is a PERMISSIVE reader: it looks for `--test`, a
 * `--test-timeout=`, and a positional containing `__tests__`, then stops. That
 * is right for finding lanes and blind to everything around them, so a segment
 * can keep parsing as a healthy lane while the shell no longer treats its
 * failure as fatal. MEASURED: append ` || true` to either invocation and every
 * pre-MONEY-1317 assertion still passes — the segment count is still 2, the
 * glob is still quoted, the timeout is still 180000 — while `yarn test` exits 0
 * over a red suite. The lane is not gone; its VERDICT is.
 *
 * Ordered longest-first and consumed as it matches, so a `||` is reported once
 * as `||` rather than twice as `||` and `|`.
 *
 * `&&` is the separator this string is SPLIT on, so any `&` still present in a
 * segment is a lone one — backgrounding the lane, after which `&&` tests the
 * shell's success at forking rather than the suite's at passing.
 *
 * None of these has a legitimate use here. The only argument either lane takes
 * is a glob, and `globToRegExp` refuses anything outside `[A-Za-z0-9_*./-]`.
 */
const SEGMENT_BREAKERS: ReadonlyArray<{ op: string; why: string }> = [
  { op: "||", why: "swallows the lane's failure — `yarn test` then exits 0" },
  {
    op: ";",
    why: "runs the next command unconditionally, discarding the exit code",
  },
  {
    op: "|",
    why: "a pipeline reports the LAST command's status, not the suite's",
  },
  {
    op: "&",
    why: "backgrounds the lane; `&&` then tests the fork, not the tests",
  },
];

function findSegmentBreakers(segment: string): string[] {
  const found: string[] = [];
  let rest = segment;
  for (const { op, why } of SEGMENT_BREAKERS) {
    if (!rest.includes(op)) continue;
    found.push(`${op} (${why})`);
    // Consume, so a longer operator is not re-reported as its own prefix.
    rest = rest.split(op).join(" ");
  }
  return found;
}

/**
 * The two-lane contract, checked as a WHOLE rather than lane by lane.
 *
 * Returns one human-readable line per problem; an empty array is healthy. Both
 * pins assert on this — the predicate lives here exactly once so the two lanes
 * cannot come to disagree about what a healthy script looks like.
 *
 * Two properties, and they catch different things:
 *
 *   1. every `&&` segment IS a lane. A third segment that is not a lane is a
 *      command riding in the test script whose failure or success nobody
 *      reasoned about; and a segment that stopped parsing as a lane is a lane
 *      that stopped running tests, which `parseLanes` alone reports as one
 *      fewer lane rather than as a defect.
 *   2. no segment carries a failure-swallowing operator. This is the direction
 *      no count can see: the lanes are all present and all correct, and the
 *      suite's verdict is discarded anyway.
 */
export function findSegmentIntegrityProblems(): string[] {
  const problems: string[] = [];

  if (SEGMENTS.length !== LANES.length) {
    problems.push(
      `the test script has ${SEGMENTS.length} \`&&\` segment(s) but ` +
        `${LANES.length} parse as a \`node --test\` lane. Every segment must be ` +
        `a lane: an extra one is an unreviewed command in the test script, and ` +
        `a missing one is a lane that has stopped running tests while still ` +
        `sitting there. Segments were:\n` +
        SEGMENTS.map((s, i) => `  [${i}] ${s.trim()}`).join("\n"),
    );
  }

  SEGMENTS.forEach((segment, i) => {
    for (const breaker of findSegmentBreakers(segment)) {
      problems.push(
        `segment [${i}] contains \`${breaker}\`. Every lane's failure must be ` +
          `fatal to \`yarn test\`, or a red suite writes the \`verify:push\` ` +
          `marker. Segment was:\n  ${segment.trim()}`,
      );
    }
  });

  return problems;
}

/**
 * A narrow glob→RegExp translator, NOT a general one.
 *
 * It understands only the two constructs these globs are allowed to use —
 * `**` (any number of path segments, INCLUDING ZERO, matching node's own
 * behaviour: `__tests__/**\/x.test.ts` does select `__tests__/x.test.ts`) and
 * `*` (any run of characters within one segment) — and THROWS on anything else,
 * so a pattern it cannot reason about fails loudly instead of matching nothing
 * and passing vacuously. Verified against `node --test` directly: the two globs
 * in `package.json` select disjoint sets, and `*.test.ts` does not match a
 * `.spawntest.ts` name.
 */
export function globToRegExp(glob: string): RegExp {
  assert.match(
    glob,
    /^[A-Za-z0-9_*./-]+$/,
    `refusing to interpret an unexpected glob: ${glob}`,
  );
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` consumes zero-or-more whole segments.
      if (glob[i + 2] === "/") {
        out += "(?:[^/]+/)*";
        i += 2;
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "." || c === "/" || c === "-") {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}
