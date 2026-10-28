/**
 * Shared harness for the `sync-prod-to-qa --tier=sample` suites — MONEY-1316.
 *
 * ## Why this is a separate module
 *
 * These cases drive the REAL `scripts/ops/sync-prod-to-qa.sh` through
 * `spawnSync`, so each one costs a process launch plus a bash run rather than
 * a function call. That is a deliberate design choice — the alternative is
 * asserting on the script's PROSE, and the single path they cover is the one
 * that can DELETE a QA collection — but it made the file expensive: ~45 s of
 * real work.
 *
 * The workspace runs `--test-timeout=30000`, and node applies that to the
 * FILE-level test as well as to each suite. The original file already carried
 * `{ timeout: 180_000 }` on every `describe`, and its header said node "applies
 * that PER SUITE" — which is true and was not enough. The suites had 180 s; the
 * file containing them had 30 s. It timed out, and a timed-out file is
 * CANCELLED rather than failed, so it reported a file-level `not ok` while
 * `# fail` stayed 0 — two consecutive `verify:push` runs on one tree gave
 * 6,369/6,369 pass (the file never ran) and 6,353/6,352 (it ran and timed out).
 *
 * There is no per-file timeout API to raise. The first attempt was therefore to
 * make each file CHEAP ENOUGH — splitting the suites across two files along a
 * MEANINGFUL axis rather than by stopwatch, so a new case has an obvious home:
 *
 *   sync-prod-to-qa-sample-refusals.spawntest.ts   what the script REFUSES to do
 *   sync-prod-to-qa-sample-plan.spawntest.ts       what it BUILDS and FORWARDS
 *
 * That split was worth keeping and was NOT the fix. Measured standalone with no
 * contention, the halves are 12.2 s and 9.1 s against a 30 s file wall — and the
 * observed multiplier under full parallel turbo load is ~2.5x, which puts the
 * plan half back over the line. The cost is inherent rather than sloppy: each
 * case drives the real script through `spawnSync` (~50 stub process launches),
 * and a case that lets the `npx` stub fall through execs the REAL
 * `qa-sample-plan.ts` under tsx at ~1.1 s a boot. Making these cheaper means
 * asserting on the script's PROSE instead, which is the evidence that was
 * already there and already wrong.
 *
 * ## The resolution: a second, explicitly-slow LANE (MONEY-1316)
 *
 * `packages/core`'s `test` script runs `node --test` TWICE. The normal lane
 * keeps `--test-timeout=30000` over `"__tests__/**\/*.test.ts"`; a second lane
 * runs `--test-timeout=180000` over `"__tests__/**\/*.spawntest.ts"`. The two
 * globs are disjoint (`*.test.ts` does not match `…​.spawntest.ts`), so a file
 * is renamed INTO the slow lane rather than listed in a config somewhere.
 *
 * 180000 is not a new number: it is the ceiling `SPAWNING_SUITE` below has
 * declared per-suite all along, now honest at file level too. Raising the
 * workspace-wide default instead would have hidden slow tests everywhere; a
 * special-cased slow-file list inside `scripts/test-timeout.ts` would have hidden
 * the cost. A rename is visible in `git status`, in the file name, and in the
 * lane the file runs in.
 *
 * `spawntest-lane-wiring.test.ts` (in the NORMAL lane, so it always runs) pins
 * the arrangement: that the lane exists with a QUOTED glob, that every
 * `.spawntest.ts` on disk lands in exactly one lane, and that the lane's timeout
 * is >= `SPAWNING_SUITE`'s. Without it a file could be renamed into a lane that
 * no longer runs it, and the symptom would again be a green run that proves
 * nothing.
 *
 * Everything below is unchanged from the original file; it moved so both
 * halves share ONE definition of the stubs and the runner rather than drifting
 * apart.
 */

import { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The per-SUITE timeout every `describe` in the spawning files carries.
 *
 * Node applies `--test-timeout` to each suite AND to the file-level test it
 * creates per file, so this alone was never sufficient — the suites had 180 s
 * while the file containing them had 30 s, and the file is what got cancelled.
 * It is now the FLOOR that the `.spawntest.ts` lane's own `--test-timeout` is
 * pinned at or above (`spawntest-lane-wiring.test.ts`), so the two numbers
 * cannot drift into that state again.
 *
 * Kept explicit rather than deleted in favour of the lane flag: a suite that
 * declares its own ceiling still bounds a single wedged case, and it is the one
 * number a reader of these files sees without reading a package.json.
 */
export const SPAWNING_SUITE = { timeout: 180_000 } as const;

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SCRIPT = join(ROOT, "scripts", "ops", "sync-prod-to-qa.sh");
const PLAN_CLI = join(ROOT, "scripts", "ops", "qa-sample-plan.ts");

export const STUBS = mkdtempSync(join(tmpdir(), "sync-sample-stubs-"));
after(() => rmSync(STUBS, { recursive: true, force: true }));

function stub(name: string, body: string): void {
  const p = join(STUBS, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
}

// ── The universe fixture ───────────────────────────────────────────────────
// Deliberately NOT scripts/ops/qa-sample-universe.json. That file has no
// `us.funds` list, so `assertPlanIsDeliberate` refuses it and the CLI exits 1 —
// correctly, and on purpose. A test that depended on that being fixed would be
// red for a reason that has nothing to do with what it is testing.
const MANIFEST = join(STUBS, "fixture-universe.json");
writeFileSync(
  MANIFEST,
  JSON.stringify({
    version: 1,
    us: {
      equities: {
        method: "fixture",
        source: "fixture",
        symbols: ["AAPL", "MSFT"],
      },
      etfs: { method: "fixture", source: "fixture", symbols: ["SPY"] },
      delisted: { method: "fixture", source: "fixture", symbols: ["ATVI"] },
      // The vector the real manifest is missing. `us_fund_nav`'s writer selects
      // assetType === "Mutual Fund", so the equity list can never match it.
      funds: { method: "fixture", source: "fixture", symbols: ["VFIAX"] },
    },
    in: {
      equities: {
        method: "fixture",
        source: "fixture",
        symbols: ["RELIANCE", "TCS"],
      },
      etfs: { method: "fixture", source: "fixture", symbols: ["NIFTYBEES"] },
    },
    isins: ["INE002A01018"],
    schemeCodes: ["100041"],
  }),
);

/** Prefer the workspace binary; `npx` is the fallback and must not need a network. */
const LOCAL_TSX = join(ROOT, "node_modules", ".bin", "tsx");
const REAL_TSX = existsSync(LOCAL_TSX) ? LOCAL_TSX : "npx";
const REAL_TSX_PREFIX = REAL_TSX === "npx" ? ["tsx"] : [];

// ── Stubs ──────────────────────────────────────────────────────────────────
stub(
  "gcloud",
  `
if [ "$1" = "secrets" ]; then
  for a in "$@"; do
    case "$a" in --secret=*) echo "mongodb+srv://u:p@fake.example.net/\${a#--secret=}"; exit 0;; esac
  done
  exit 1
fi
exit 0`,
);

// Eight callers, told apart the way the script tells them apart — by `--file`,
// by the ENV the call carries (MONEY-1487 / MONEY-1488 / MONEY-1519), and only
// then by the --eval text:
//   --file                      the post-restore re-link + index check
//   SO_STATE                    one collection's outcome row
//   SO_STALE_DAYS               the --status report
//   SO_NAMES                    the ordering FACTS query
//   UF_COLL (+UF_SPECS)         the unique-key-first pre-step: prod read, QA prep
//   --eval …countDocuments…     the SAMPLED count (tier=sample only)
//   --eval …estimatedDocument…  the empty-guard count
//
// The ordering stub emits FACTS, never an order: with no `STUB_ORDER_FACTS`
// every collection reports 0 and the script's own `sort` falls back on the
// manifest-position tie-break, so these suites see exactly the order they saw
// before this existed. Their subject is what the script REFUSES and what it
// FORWARDS, and neither should move because the walk was re-ordered.
stub(
  "mongosh",
  `
EVAL=""
for a in "$@"; do
  if [ "$a" = "--file" ]; then
    echo "RELINK_RAN tables=\${RELINK_TABLES} index=\${SYNC_INDEX_TABLES}" >> "$STUB_LOG"
    exit "\${STUB_RELINK_EXIT:-0}"
  fi
done
if [ -n "\${SO_STATE:-}" ]; then
  echo "OUTCOME \${SO_ID} \${SO_STATE} rows=\${SO_ROWS}" >> "$STUB_LOG"
  exit 0
fi
if [ -n "\${SO_STALE_DAYS:-}" ]; then
  echo "STATUS_RAN stale=\${SO_STALE_DAYS}" >> "$STUB_LOG"
  echo "SUMMARY stub"
  exit 0
fi
if [ -n "\${SO_NAMES:-}" ]; then
  echo "ORDER_QUERY" >> "$STUB_LOG"
  # ONE awk, not a sed per collection: these suites drive the real script ~10
  # times each and a stub that spawns 216 processes per run is what pushes the
  # FILE past its 180 s wall, which reports as cancelled with fail still 0.
  # (No backticks in this comment -- it sits inside a JS template literal,
  # and one closed it: esbuild then reported a syntax error 200 lines on.)
  awk -v names="\$SO_NAMES" -v facts="\${STUB_ORDER_FACTS:-}" 'BEGIN {
    n = split(facts, f, ",");
    for (i = 1; i <= n; i++) { p = index(f[i], ":"); if (p > 0) m[substr(f[i], 1, p - 1)] = substr(f[i], p + 1); }
    k = split(names, a, " ");
    for (i = 1; i <= k; i++) { v = (a[i] in m) ? m[a[i]] : 0; print v, i - 1, a[i]; }
  }'
  exit 0
fi
if [ -n "\${UF_COLL:-}" ]; then
  echo "UNIQUE_FIRST \${UF_COLL}" >> "$STUB_LOG"
  echo '[{"v":2,"key":{"k":1},"name":"k","unique":true}]'
  exit 0
fi
prev=""
for a in "$@"; do
  if [ "$prev" = "--eval" ]; then EVAL="$a"; fi
  prev="$a"
done
COLL=$(echo "$EVAL" | sed -n "s/.*getCollection('\\([a-z0-9_]*\\)').*/\\1/p")
case "$EVAL" in
  *countDocuments*)
    echo "SCOUNT $COLL" >> "$STUB_LOG"
    if [ "\${STUB_ZERO_SAMPLE:-}" = "ALL" ] || [ "\${STUB_ZERO_SAMPLE:-}" = "$COLL" ]; then
      echo 0
    else
      echo "\${STUB_SCOUNT:-5}"
    fi
    ;;
  *)
    echo "COUNT $COLL" >> "$STUB_LOG"
    echo "\${STUB_COUNT:-9}"
    ;;
esac`,
);

// Records the collection AND the exact --query it was handed. `QUERY=<NONE>`
// when no --query was passed at all — a full-collection dump under a tier that
// promised a sample.
stub(
  "mongodump",
  `
coll=""
query="<NONE>"
for a in "$@"; do
  case "$a" in
    --collection=*) coll="\${a#--collection=}";;
    --query=*) query="\${a#--query=}";;
  esac
done
echo "DUMP $coll QUERY=$query" >> "$STUB_LOG"
if [ -n "\${STUB_FAIL_COLLECTION:-}" ] && [ "$coll" = "\${STUB_FAIL_COLLECTION}" ]; then exit 1; fi
echo "archive:$coll"
if [ -n "\${STUB_SIGINT_AFTER:-}" ]; then
  n=$(grep -c '^DUMP ' "$STUB_LOG")
  if [ "$n" -eq "\${STUB_SIGINT_AFTER}" ]; then
    pg=$(ps -o pgid= -p $$ | tr -d ' ')
    if [ -n "$pg" ] && [ "$pg" != "\${STUB_RUNNER_PGID:-}" ]; then
      # Ctrl-C reaches the whole foreground process GROUP, which is what the
      # trap under test has to survive. Sending to the group is only safe
      # because the runner starts that run through pgwrap, which gives it its
      # own group; if that ever stops being true the else-branch fires and the
      # test fails loudly rather than signalling the test runner.
      echo "SIGINT group=$pg" >> "$STUB_LOG"
      kill -INT -"$pg"
      sleep 2
    else
      echo "SIGINT REFUSED pg=$pg runner=\${STUB_RUNNER_PGID:-}" >> "$STUB_LOG"
    fi
  fi
fi`,
);

// Drains the pipe and recovers the collection from the archive payload, so a
// restore is recorded per collection rather than as an anonymous count.
stub(
  "mongorestore",
  `
payload=$(cat)
case "$payload" in
  archive:*) echo "RESTORE \${payload#archive:}" >> "$STUB_LOG" ;;
  "") : ;;
  *) echo "RESTORE <unparsed>" >> "$STUB_LOG" ;;
esac`,
);

// Runs the script in its OWN process group, so a stub can send SIGINT to that
// group — which is what Ctrl-C does — without the signal reaching the test
// runner. `set -m` turns on job control in a non-interactive shell, and job
// control is precisely "each job gets its own process group"; `wait` then
// propagates the job's exit status unchanged.
stub(
  "pgwrap",
  `
set -m
"$@" &
wait $!
exit $?`,
);

// The plan generator, in three modes:
//   STUB_PLAN_EXIT   fail like a broken/absent manifest
//   STUB_PLAN_FILE   replay a fixed plan (deterministic; lets a plan be doctored)
//   neither          run the REAL CLI against the fixture manifest
stub(
  "npx",
  `
echo "NPX $*" >> "$STUB_LOG"
if [ -n "\${STUB_PLAN_EXIT:-}" ]; then
  echo "stub: plan generation failed" >&2
  exit "\${STUB_PLAN_EXIT}"
fi
if [ -n "\${STUB_PLAN_FILE:-}" ]; then
  cat "\${STUB_PLAN_FILE}"
  exit 0
fi
shift   # drop the "tsx" argument; STUB_REAL_TSX may already be tsx itself
exec "\${STUB_REAL_TSX}" \${STUB_REAL_TSX_PREFIX} "$@" --manifest="\${STUB_MANIFEST}"`,
);

// ── Runner ─────────────────────────────────────────────────────────────────
export interface Run {
  status: number;
  out: string;
  log: string;
}

const RUNNER_PGID = spawnSync(
  "ps",
  ["-o", "pgid=", "-p", String(process.pid)],
  {
    encoding: "utf8",
  },
).stdout.trim();

export function runSync(
  env: Record<string, string> = {},
  args: string[] = ["--yes", "--tier=sample"],
  opts: { ownProcessGroup?: boolean } = {},
): Run {
  const logFile = join(STUBS, `log-${Math.random().toString(36).slice(2)}`);
  writeFileSync(logFile, "");
  const argv =
    opts.ownProcessGroup === true
      ? [join(STUBS, "pgwrap"), "bash", SCRIPT, ...args]
      : ["bash", SCRIPT, ...args];
  const r = spawnSync(argv[0]!, argv.slice(1), {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      PATH: `${STUBS}:${process.env.PATH ?? ""}`,
      STUB_LOG: logFile,
      STUB_MANIFEST: MANIFEST,
      STUB_REAL_TSX: REAL_TSX,
      STUB_REAL_TSX_PREFIX: REAL_TSX_PREFIX.join(" "),
      STUB_RUNNER_PGID: RUNNER_PGID,
      ...env,
    },
  });
  assert.equal(r.signal, null, `the script was killed by ${r.signal}`);
  return {
    status: r.status ?? -1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    log: readFileSync(logFile, "utf8"),
  };
}

export interface Dump {
  collection: string;
  query: string;
}

export function dumps(log: string): Dump[] {
  return log
    .split("\n")
    .map((l) => /^DUMP (\S*) QUERY=(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ collection: m[1]!, query: m[2]! }));
}

export function restores(log: string): string[] {
  return log
    .split("\n")
    .map((l) => /^RESTORE (\S+)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]!);
}

// ── The collections the script actually iterates, derived from the script ──
function referenceCollections(): string[] {
  const src = readFileSync(SCRIPT, "utf8");
  const block = /^REFERENCE_COLLECTIONS=\(([\s\S]*?)^\)/m.exec(src);
  assert.ok(block, "REFERENCE_COLLECTIONS is gone from sync-prod-to-qa.sh");
  return [...block[1]!.matchAll(/^\s+"([a-z0-9_]+)"/gm)].map((m) => m[1]!);
}

export const REF = referenceCollections();

// ── The real plan, generated once ──────────────────────────────────────────
/**
 * The generated plan text.
 *
 * `let`, not `const`, because `before()` below fills it — and EXPORTED so both
 * split files read the same one. ESM exports are live bindings, so an importer
 * sees the value assigned in `before()` rather than the empty string captured
 * at import time. That is load-bearing after the MONEY-1316 split: a snapshot
 * copy would give every consumer "".
 */
export let PLAN = "";
export const PLAN_FILE = join(STUBS, "plan.tsv");

before(() => {
  const r = spawnSync(
    REAL_TSX,
    [
      ...REAL_TSX_PREFIX,
      PLAN_CLI,
      "--emit",
      "--years=2",
      "--universe=500",
      `--manifest=${MANIFEST}`,
    ],
    { encoding: "utf8", timeout: 120_000, cwd: ROOT },
  );
  assert.equal(r.status, 0, `qa-sample-plan.ts --emit failed:\n${r.stderr}`);
  PLAN = r.stdout;
  writeFileSync(PLAN_FILE, PLAN);
});

export function planLines(): Array<[string, string]> {
  return PLAN.split("\n")
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("\t");
      return [l.slice(0, i), l.slice(i + 1)] as [string, string];
    });
}

export function planFileWithout(collection: string): string {
  const p = join(STUBS, `plan-minus-${collection}.tsv`);
  writeFileSync(
    p,
    planLines()
      .filter(([c]) => c !== collection)
      .map((x) => x.join("\t"))
      .join("\n") + "\n",
  );
  return p;
}
