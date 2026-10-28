/**
 * Type-check `scripts/` — the tree nothing was checking (MONEY-1238).
 *
 * ## The gap
 *
 * `yarn type-check` is `turbo run type-check`, and turbo only reaches
 * WORKSPACES (`apps/*`, `packages/*`, `workers`). `scripts/` is none of those.
 * A `scripts/tsconfig.json` has existed the whole time — correct, `noEmit`,
 * extending the shared base — and **nothing ever executed it**. So every one of
 * the ~73 files under `scripts/` was unchecked: the nightly Cloud Run jobs
 * (`feed-parse`, `xbrl-backfill`, `xbrl-projection-drain`), the one-shot
 * migrations that write to prod, the F3 reconcile whose verdict gates the XBRL
 * switchover. `tsup`/`esbuild` strip types without checking them, so the build
 * cannot catch it either — the same reason `run-verify.sh` runs type-check
 * FIRST and calls it "the one gate `build` cannot provide".
 *
 * ## Why a BASELINE and not a clean gate
 *
 * Turning the check on surfaces **34 pre-existing errors across 14 files**,
 * none of them introduced by the ticket that wired this up, several of them in
 * migrations that have already run against production and must not be touched
 * casually. A gate that is red on the day it lands is a gate somebody disables.
 *
 * So this is a RATCHET, not a wall:
 *
 *   - a file NOT in the baseline may have ZERO errors;
 *   - a file in the baseline may not have MORE of any error code than recorded;
 *   - a file with FEWER errors than recorded FAILS TOO, with the instruction to
 *     lower the baseline. Without that arm the baseline never shrinks and a
 *     fixed file quietly re-earns its allowance.
 *
 * ## Why the key is (file, TS code) and not (file, line)
 *
 * Line numbers move on every edit above them, so a line-keyed baseline would be
 * red on unrelated changes and would get regenerated blindly — which is the same
 * as no baseline. Error CODES are stable, and keying on them also catches the
 * substitution a bare per-file count would miss: fixing one `TS18048` while
 * introducing one `TS2322` leaves the count identical.
 *
 * Run: `node --import tsx scripts/ops/typecheck-scripts.ts`
 * Regenerate the baseline: same command with `--write-baseline`.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const PROJECT = join("scripts", "tsconfig.json");
const BASELINE_PATH = join(HERE, "typecheck-scripts-baseline.json");

/** `file -> { TSxxxx -> count }`. */
type Baseline = Record<string, Record<string, number>>;

/**
 * `path(line,col): error TSxxxx: message`.
 *
 * Anchored at the line start so the INDENTED continuation lines tsc emits for a
 * multi-part diagnostic ("Type 'X' is not assignable…" / "  Property 'y' is
 * missing…") are not counted as separate errors. Counting them would make the
 * baseline depend on how verbose a type is, which changes when an unrelated
 * interface gains a member.
 */
const DIAGNOSTIC = /^([^\s(][^(]*)\((\d+),(\d+)\): error (TS\d+):/;

function runTsc(): { stdout: string; ok: boolean } {
  // The repo's own TypeScript, never a global one — a different compiler
  // version produces a different diagnostic set and the baseline stops meaning
  // anything.
  const tsc = join(REPO_ROOT, "node_modules", ".bin", "tsc");
  if (!existsSync(tsc)) {
    console.error(
      `[typecheck-scripts] no local tsc at ${tsc} — run yarn install first`,
    );
    process.exit(1);
  }
  const res = spawnSync(tsc, ["-p", PROJECT], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    // Generous: a cold run over the whole scripts tree measured ~9s, and a
    // loaded CI runner is slower. Bounded so this can never hang a suite.
    timeout: 10 * 60_000,
  });
  if (res.error) {
    console.error(
      `[typecheck-scripts] tsc could not run: ${String(res.error)}`,
    );
    process.exit(1);
  }
  return {
    stdout: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    ok: res.status === 0,
  };
}

function tally(stdout: string): Baseline {
  const out: Baseline = {};
  for (const line of stdout.split("\n")) {
    const m = DIAGNOSTIC.exec(line);
    if (!m) continue;
    const file = m[1]!.replace(/\\/g, "/");
    const code = m[4]!;
    out[file] ??= {};
    out[file]![code] = (out[file]![code] ?? 0) + 1;
  }
  return out;
}

function sortBaseline(b: Baseline): Baseline {
  const out: Baseline = {};
  for (const file of Object.keys(b).sort()) {
    const codes: Record<string, number> = {};
    for (const code of Object.keys(b[file]!).sort())
      codes[code] = b[file]![code]!;
    out[file] = codes;
  }
  return out;
}

function main(): void {
  const writeBaseline = process.argv.includes("--write-baseline");
  const { stdout } = runTsc();
  const actual = tally(stdout);

  if (writeBaseline) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(sortBaseline(actual), null, 2)}\n`,
    );
    const total = Object.values(actual)
      .flatMap((c) => Object.values(c))
      .reduce((a, b) => a + b, 0);
    console.log(
      `[typecheck-scripts] baseline written: ${Object.keys(actual).length} file(s), ${total} error(s)`,
    );
    return;
  }

  const baseline: Baseline = existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as Baseline)
    : {};

  const regressions: string[] = [];
  const improvements: string[] = [];

  for (const [file, codes] of Object.entries(actual)) {
    for (const [code, count] of Object.entries(codes)) {
      const allowed = baseline[file]?.[code] ?? 0;
      if (count > allowed) {
        regressions.push(
          `${file}: ${count} x ${code} (baseline allows ${allowed})`,
        );
      }
    }
  }
  for (const [file, codes] of Object.entries(baseline)) {
    for (const [code, allowed] of Object.entries(codes)) {
      const count = actual[file]?.[code] ?? 0;
      if (count < allowed) {
        improvements.push(`${file}: ${code} down to ${count} from ${allowed}`);
      }
    }
  }

  // The NEW errors first — that is what a failing run is usually about, and a
  // reader should not have to scroll past the good news.
  if (regressions.length > 0) {
    console.error("[typecheck-scripts] NEW type errors under scripts/:");
    for (const r of regressions) console.error(`  ${r}`);
    console.error("");
    console.error(stdout.trim());
    console.error("");
    console.error(
      "scripts/ is type-checked as of MONEY-1238. Fix the error — do not add " +
        "it to the baseline; the baseline records only what predates the gate.",
    );
    process.exit(1);
  }

  if (improvements.length > 0) {
    console.error("[typecheck-scripts] the baseline is now too generous:");
    for (const i of improvements) console.error(`  ${i}`);
    console.error("");
    console.error(
      "Someone fixed these. Lock it in so they cannot come back:\n" +
        "  node --import tsx scripts/ops/typecheck-scripts.ts --write-baseline",
    );
    process.exit(1);
  }

  const remaining = Object.values(actual)
    .flatMap((c) => Object.values(c))
    .reduce((a, b) => a + b, 0);
  console.log(
    `[typecheck-scripts] OK — no new type errors under scripts/ ` +
      `(${remaining} pre-existing, see scripts/ops/typecheck-scripts-baseline.json)`,
  );
}

main();
