/**
 * UNIT TEST — the pre-push gate checks everything CI checks (MONEY-1164).
 *
 * `yarn verify:push` exists to guarantee CI will be green, and
 * `.claude/hooks/pre-push-gate.sh` blocks pushing without its marker. That
 * promise holds only while the gate's phases are a SUPERSET of the `test` job's
 * steps in `.github/workflows/test.yml`.
 *
 * ## Why a test and not a comment
 *
 * A gate that checks LESS than CI is worse than no gate: it converts "CI is
 * red" into "CI is red and I was told it wouldn't be", which is how the
 * `VERIFY_GATE_BYPASS=1` habit starts. Two divergences had already opened up
 * silently:
 *
 *   - CI ran `yarn test:coverage-check`; the gate did not. PR #285 passed the
 *     gate (build 23/23, 24,478 tests, marker written) and went red on GitHub
 *     with "TEST-COVERAGE.md says 930 test files; 931 exist on disk".
 *   - CI ran `yarn db:generate`; the gate did not, so its type-check phase read
 *     whatever Prisma client node_modules happened to hold — the other
 *     branch's, after a checkout.
 *
 * Neither is visible in review: both files look fine on their own, and the
 * defect is the RELATION between them. That is exactly what a test can hold and
 * a comment cannot.
 *
 * Pure file parsing: no network, no build, no yarn.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..", "..", "..");

const WORKFLOW = join(REPO, ".github", "workflows", "test.yml");
const GATE = join(REPO, ".claude", "hooks", "run-verify.sh");

const workflow = readFileSync(WORKFLOW, "utf8");
const gateRaw = readFileSync(GATE, "utf8");

/**
 * The gate with COMMENTS and MESSAGES removed, leaving only lines that can
 * actually execute something.
 *
 * Matching the raw file text was a shadow check. `run-verify.sh` explains each
 * phase in prose and prints a failure message naming the command it just ran,
 * so the string "yarn test:python" appears three times: the phase banner
 * (`echo`), the invocation (`if ! yarn test:python`), and the failure hint
 * (`echo ... 'yarn test:python' job`). Deleting the INVOCATION left two
 * mentions behind and the guard stayed green.
 *
 * Demonstrated, not theorised — replacing `if ! yarn test:python; then` with
 * `if ! true; then` and the banner with "SKIPPED" produced `# fail 0`. The same
 * hole covers every phase: each one names its own command in an error message.
 *
 * A guard that a COMMENT can satisfy is the thing this repo calls a shadow, and
 * this one guards the promise "CI will be green".
 */
const gate = gateRaw
  .split("\n")
  // Whole-line comments only. A trailing `#` inside a quoted argument is not a
  // comment, and stripping from the first `#` would corrupt those lines.
  .filter((line) => !/^\s*#/.test(line))
  // `echo` / `printf` lines are OUTPUT. Every phase banner and every failure
  // hint is one, and both name the command they describe.
  .filter((line) => !/^\s*(echo|printf)\b/.test(line))
  .join("\n");

/**
 * CI steps the gate deliberately does NOT mirror, each with a reason.
 *
 * An unexplained omission here is how the gate silently stops matching CI, so
 * anything skipped has to be named and justified — the same posture as
 * `KNOWN_GAPS` in premium-actions-gated.test.ts.
 */
const NOT_MIRRORED: Array<{ command: string; why: string }> = [
  {
    command: "corepack enable",
    why: "runner bootstrap — the developer already has yarn on PATH",
  },
  {
    command: "yarn install --frozen-lockfile",
    why: "runner bootstrap — a local tree is already installed, and reinstalling on every push would make the gate unusably slow",
  },
  {
    command: "yarn test:smoke",
    why: "belongs to the separate `smoke` job, and is a strict subset of the full `yarn test --force` the gate runs",
  },
];

/** Every `run:` command in the workflow, in file order. */
function ciRunCommands(): string[] {
  return [...workflow.matchAll(/^\s*run:\s*(.+?)\s*$/gm)]
    .map((m) => m[1]!)
    .filter((c) => !c.startsWith("|") && !c.startsWith(">"));
}

/**
 * MONEY-1406 — the two test shards must PARTITION the workspace graph.
 *
 * The `test` job is a 2-way matrix so the gate's wall clock halves: web was
 * 607s of a 1319s run. Splitting a merge gate is only safe while the shards
 * cover everything exactly once — a package in NEITHER shard stops being tested
 * and nothing says so, which is the quietest way to lose a suite.
 *
 * Checked STRUCTURALLY rather than by enumerating packages: the filters must be
 * exact complements, `--filter=X` and `--filter=!X` for the same X. That holds
 * for any workspace graph, including one a future package joins, so a new
 * workspace cannot fall out of both shards — it lands in `rest` by
 * construction. Enumerating packages here would need turbo at test time and
 * would go stale the day someone adds one.
 */
describe("MONEY-1406 — the test shards cover every workspace exactly once", () => {
  interface Shard {
    shard: string;
    filter: string;
  }

  /** The matrix `include:` entries, read out of the workflow. */
  function shards(): Shard[] {
    const block = /include:\n([\s\S]*?)\n    steps:/.exec(workflow);
    assert.ok(
      block,
      "could not find the test job's matrix include: in test.yml"
    );
    const out: Shard[] = [];
    for (const m of block[1]!.matchAll(
      /- shard:\s*(\S+)\s*\n\s*filter:\s*"([^"]+)"/g
    )) {
      out.push({ shard: m[1]!, filter: m[2]! });
    }
    return out;
  }

  it("there are exactly two shards, and the matrix parses", () => {
    // Without this the complement assertion below passes vacuously the day the
    // matrix is reshaped or renamed.
    const s = shards();
    assert.equal(
      s.length,
      2,
      `parsed ${s.length} shards from test.yml — expected 2. A third shard is ` +
        `fine, but this guard's complement rule only covers two, so extend it ` +
        `in the same change rather than leaving the coverage unchecked.`
    );
    assert.deepEqual(s.map((x) => x.shard).sort(), ["rest", "web"]);
  });

  it("the two filters are exact complements, so nothing is tested twice or never", () => {
    const [a, b] = shards();
    const bare = (f: string) => f.replace(/^--filter=/, "");
    const pair = [bare(a!.filter), bare(b!.filter)].sort();
    const [negated, plain] = [
      pair.find((x) => x.startsWith("!")),
      pair.find((x) => !x.startsWith("!")),
    ];
    assert.ok(
      negated && plain,
      `the shards must be one positive and one negated filter, got ${pair.join(" and ")}`
    );
    assert.equal(
      negated!.slice(1),
      plain!,
      `the shards filter on different packages (${negated} vs ${plain}), so ` +
        `some workspace is in BOTH shards or in NEITHER. They must be ` +
        `--filter=X and --filter=!X for the same X.`
    );
  });

  it("the sharded command still runs through turbo with concurrency pinned", () => {
    // The serialization is load-bearing and predates the shards (MONEY-1238):
    // turbo must not fan workspaces out on a 2-vCPU runner. A shard reduces the
    // WORK per runner, never the need to serialize what is left.
    const run = ciRunCommands().find((c) => c.includes("turbo run test"));
    assert.ok(run, "no turbo test command found in test.yml");
    assert.match(run!, /--concurrency=1\b/);
    assert.match(run!, /\$\{\{\s*matrix\.filter\s*\}\}/);
  });
});

describe("MONEY-1164 — the pre-push gate mirrors CI", () => {
  it("sanity: both files parse and CI has the steps we think it has", () => {
    // Without this, a renamed workflow path or a reshaped `run:` block would
    // make every assertion below vacuously true.
    const commands = ciRunCommands();
    assert.ok(
      commands.length >= 5,
      `parsed only ${commands.length} run: commands from test.yml — the ` +
        `workflow's shape changed and this guard is no longer reading it`
    );
    assert.ok(gateRaw.includes("verify:"), "run-verify.sh did not parse");
  });

  it("every CI command is either run by the gate or explicitly exempted", () => {
    // PREFIX match, not equality. CI added `--prefer-offline` to its install
    // step on main and the exact-string exemption stopped hitting, so the guard
    // reported a parity gap that did not exist — a flag change is not a new
    // command. Matching the exempted command as a prefix keeps the guard
    // pointed at what it is for: a CI step the gate never runs at all.
    const isExempt = (command: string) =>
      NOT_MIRRORED.some((e) => command.startsWith(e.command));

    for (const command of ciRunCommands()) {
      if (isExempt(command)) continue;

      // The gate may run a SUPERSET (`yarn test --force` covers `yarn test`),
      // so match on the script name rather than the exact string.
      const script = command.replace(/^yarn\s+/, "").split(/\s+/)[0]!;
      assert.ok(
        new RegExp(`yarn (turbo run )?${script}\\b`).test(gate),
        `CI runs "${command}" but .claude/hooks/run-verify.sh never invokes ` +
          `"${script}". The gate would pass locally and CI would go red — ` +
          `the exact failure MONEY-1164 was filed for. Add a phase, or add ` +
          `an entry to NOT_MIRRORED explaining why it does not belong.`
      );
    }
  });

  it("the gate defaults NODE_OPTIONS to the same heap ceiling as CI", () => {
    // Node sizes its default old-space from total system RAM, so the same tree
    // OOMs on one machine and passes on another. The ceiling only means
    // something if both places pin the SAME number.
    const ciHeap = /NODE_OPTIONS:\s*--max-old-space-size=(\d+)/.exec(workflow);
    assert.ok(ciHeap, "test.yml no longer sets an explicit NODE_OPTIONS heap");

    // Read the ASSIGNMENT, not any mention of a heap size.
    //
    // This regex was `/NODE_OPTIONS:---max-old-space-size=(\d+)\}/`, matching
    // the shell default-value form `${NODE_OPTIONS:---max-old-space-size=4096}`.
    // The gate stopped using that form: a `:-` default is REPLACED wholesale by
    // any caller-supplied NODE_OPTIONS, so it was changed to PREPEND
    // (`VERIFY_NODE_OPTIONS="--max-old-space-size=4096 ${NODE_OPTIONS:-}"`).
    // The only surviving text matching the old pattern is the COMMENT
    // explaining why the form was abandoned — so this assertion has been
    // reading prose, and would have stayed green with the ceiling deleted from
    // the code entirely. Surfaced by stripping comments from `gate` above.
    const gateHeap = /VERIFY_NODE_OPTIONS="--max-old-space-size=(\d+)/.exec(
      gate
    );
    assert.ok(
      gateHeap,
      "run-verify.sh no longer assigns VERIFY_NODE_OPTIONS with an explicit " +
        "--max-old-space-size. If the variable was renamed, update this regex " +
        "— do not delete the check."
    );

    assert.equal(
      gateHeap[1],
      ciHeap[1],
      `CI builds with a ${ciHeap[1]}MB heap and the gate defaults to ` +
        `${gateHeap[1]}MB. A gate with a SMALLER ceiling fails on work CI ` +
        `would accept (and invites VERIFY_GATE_BYPASS); a LARGER one passes ` +
        `work CI will OOM on.`
    );
  });

  it("the gate respects a caller-supplied NODE_OPTIONS", () => {
    // The CONTRACT, not the spelling: whatever the caller set must survive into
    // VERIFY_NODE_OPTIONS, so the documented escape
    // (`NODE_OPTIONS=--max-old-space-size=8192 yarn verify:push`) still works.
    //
    // This used to assert the literal `${NODE_OPTIONS:-<default>}` form, which
    // pinned an implementation that turned out to be wrong: `:-` SUBSTITUTES,
    // so any unrelated value already in the environment (`--trace-warnings`,
    // `--inspect`, a corporate TLS setting) silently removed the heap ceiling
    // and the build died with the SIGABRT this phase exists to prevent. The
    // ceiling is now APPENDED to the caller's value instead, with ours first so
    // a caller's own `--max-old-space-size` still wins (Node takes the last
    // occurrence of a duplicated V8 flag).
    assert.match(
      gate,
      /VERIFY_NODE_OPTIONS="[^"]*\$\{NODE_OPTIONS/,
      "run-verify.sh must carry the caller's NODE_OPTIONS into the compile phases"
    );
    assert.match(
      gate,
      /VERIFY_NODE_OPTIONS="[^"]*--max-old-space-size=/,
      "run-verify.sh must still supply a heap ceiling of its own"
    );
    // And it must not go back to substituting.
    assert.doesNotMatch(
      gate,
      /VERIFY_NODE_OPTIONS="\$\{NODE_OPTIONS:-/,
      "`${NODE_OPTIONS:-…}` discards a caller's unrelated flags along with the " +
        "ceiling — append instead"
    );
  });

  it("the heap ceiling is scoped to the COMPILE phases, never exported", () => {
    // CI applies NODE_OPTIONS per-step — on `Typecheck`, NOT on `Run tests`.
    // Exporting it globally also raises the ceiling for every node:test worker,
    // and apps/web forks a lot of them; each then grows its heap further before
    // collecting, which on a memory-pressured machine produces 30s
    // testTimeoutFailures in files that pass in isolation. Observed exactly
    // that while building this fix: four unrelated files timing out per run, a
    // different four each run, all green standalone.
    assert.doesNotMatch(
      gate,
      /^\s*export NODE_OPTIONS/m,
      "NODE_OPTIONS must not be exported — it would leak into the test phase, " +
        "which CI deliberately runs at node's default heap"
    );

    const compilePhases = [
      ...gate.matchAll(
        /NODE_OPTIONS="\$VERIFY_NODE_OPTIONS" yarn (type-check|build)/g
      ),
    ].map((m) => m[1]!);
    assert.deepEqual(
      compilePhases.sort(),
      ["build", "type-check"],
      "both type-check and build must run under the pinned ceiling"
    );

    const testInvocation = /yarn (turbo run )?test[^\n]*--force/.exec(gate);
    assert.ok(testInvocation, "the gate no longer runs the test suite");
    assert.doesNotMatch(
      testInvocation[0],
      /NODE_OPTIONS/,
      "the test phase must run at node's default heap, as CI does"
    );
  });

  it("prisma generate runs BEFORE the phase that type-checks against it", () => {
    // turbo's `build` task dependsOn db:generate but `type-check` does not, so
    // ordering is the whole fix: type-check first would read a stale client.
    const generateAt = gate.indexOf("db:generate");
    const typecheckAt = gate.indexOf("yarn type-check");
    assert.ok(
      generateAt > -1,
      "the gate no longer generates the Prisma client"
    );
    assert.ok(typecheckAt > -1, "the gate no longer type-checks");
    assert.ok(
      generateAt < typecheckAt,
      "db:generate must precede type-check — otherwise the type-check reads " +
        "whatever client node_modules holds, which after a branch switch is " +
        "the other branch's schema"
    );
  });

  it("every phase failure removes the marker rather than leaving a stale one", () => {
    // The marker is the whole security property: a failed phase that left an
    // older marker in place would unlock a push for a tree that just failed.
    // `gateRaw`, not `gate`: this assertion counts failure paths BY THEIR
    // MESSAGE, and the comment/echo-stripped view deletes exactly those. The
    // stripping exists so that a command mention cannot stand in for an
    // invocation (see the note on `gate` above); here the message IS the
    // signal, and pairing each one with an `rm -f "$MARKER"` is the check.
    const failureBlocks = [...gateRaw.matchAll(/no marker written/g)];
    const removals = [...gateRaw.matchAll(/rm -f "\$MARKER"/g)];
    assert.ok(failureBlocks.length >= 5, "expected one guard per phase");
    assert.ok(
      removals.length >= failureBlocks.length,
      `${failureBlocks.length} failure paths but only ${removals.length} ` +
        `marker removals — a phase can fail while leaving a stale marker that ` +
        `still unlocks git push`
    );
  });
});
