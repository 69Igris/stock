/**
 * `scripts/data/backfill-financials-from-rawdata.ts` must refuse an argv it
 * does not fully understand — MONEY-1205.
 *
 * ## Why this is an EXECUTION test, not a source scan
 *
 * The sibling guard in this directory (`ops-script-db-target.test.ts`) is a
 * static scan because its defect — a PrismaClient constructed before `--env`
 * resolves — is invisible at runtime on a machine with `DATABASE_URL` unset,
 * which is exactly where tests run. This defect is the opposite: it is only
 * ever visible at runtime, in the argv parser, and a source scan for the string
 * `KNOWN_FLAGS` would pass against a parser that had been rewritten to ignore
 * it. So each case below RUNS the real script and asserts on its real exit code
 * and its real stderr.
 *
 * Every invocation here is safe by construction: `parseArgs` is the first
 * statement of `main()`, so all of these fail before `databaseUrlForEnv` shells
 * out to gcloud and before the deferred `await import("@usemoney/database")`.
 * `DATABASE_URL` is stripped from the child's environment as a second belt —
 * the last case proves the parser is what runs first by reaching the
 * "DATABASE_URL is not set" check with an argv that is entirely VALID.
 *
 * ## What is being protected
 *
 * This script writes `StockFinancials` — 32,359 rows in prod, no transaction —
 * and its `--apply` mode is TTY-gated with a confirmation prompt. Two argv
 * shapes turn that safety into theatre:
 *
 *   `--apply --dry-run`   `--dry-run` is not a flag this script has. Silently
 *                         ignored, it reads as a rehearsal right up until the
 *                         rows change. `resector-real-estate.ts` grew the same
 *                         guard after exactly this WROTE.
 *   `--limit --apply`     `--limit` swallows nothing, and the old parser
 *                         returned null — indistinguishable from "--limit was
 *                         not passed". The non-positive-limit guard therefore
 *                         never fired and the run became UNLIMITED: a full-table
 *                         prod write by an operator who asked for 500 rows.
 *                         `--env --apply` is the same shape one step worse,
 *                         leaving APPLY mode pointed at the ambient
 *                         `DATABASE_URL` while the prompt names something else.
 *
 * Both fail OPEN — they widen the blast radius while looking like a narrower
 * run — which is why they are asserted on exit code rather than on a log line.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Resolved from THIS FILE, not from cwd — a cwd-relative path would make the
 * suite throw inside the describe callback, which node reports as a dropped
 * suite with `fail 0` and exit 0. The guard would vanish instead of failing. */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SCRIPT = "scripts/data/backfill-financials-from-rawdata.ts";

interface Run {
  status: number;
  output: string;
}

/**
 * Run the real script with `argv`, synchronously.
 *
 * `execFileSync` blocks until the child exits, so this cannot leave an orphan
 * behind the way a spawned async child can. `stdin: "ignore"` matters: it makes
 * the child's stdin a non-TTY, which is the CI/pipe shape the `--apply` guards
 * are written for.
 */
function run(argv: string[]): Run {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  try {
    const out = execFileSync("npx", ["tsx", SCRIPT, ...argv], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { status: 0, output: out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? -1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

describe("backfill-financials-from-rawdata argv safety", () => {
  it("REJECTS an unknown flag instead of ignoring it", () => {
    const r = run(["--bogus"]);
    assert.notEqual(
      r.status,
      0,
      "an unrecognised flag must be a non-zero exit, not a silently-ignored no-op",
    );
    assert.match(r.output, /Unknown flag\(s\): --bogus/);
  });

  it("REJECTS `--apply --dry-run` — the flag that does not exist", () => {
    // The whole point. `--dry-run` is not this script's spelling for a
    // rehearsal (absence of `--apply` is), so an operator typing it believes
    // they are rehearsing while `--apply` writes.
    const r = run(["--apply", "--dry-run"]);
    assert.notEqual(r.status, 0);
    assert.match(r.output, /Unknown flag\(s\): --dry-run/);
  });

  it("REJECTS `--limit` with no value rather than reading it as UNLIMITED", () => {
    const r = run(["--limit", "--apply"]);
    assert.notEqual(r.status, 0);
    assert.match(r.output, /--limit was given without a value/);
  });

  it("REJECTS `--env` with no value rather than falling back to the ambient DB", () => {
    const r = run(["--env", "--apply"]);
    assert.notEqual(r.status, 0);
    assert.match(r.output, /--env was given without a value/);
  });

  it("REJECTS a non-positive --limit", () => {
    const r = run(["--limit", "0"]);
    assert.notEqual(r.status, 0);
    assert.match(r.output, /--limit must be a positive integer/);
  });

  it("REJECTS an --env that is neither qa nor prod", () => {
    const r = run(["--env", "staging"]);
    assert.notEqual(r.status, 0);
    assert.match(r.output, /--env must be "qa" or "prod"/);
  });

  it("ACCEPTS a valid argv — the guards do not fire on a good run", () => {
    // The negative control, and the proof that parseArgs runs BEFORE any
    // database work: a fully valid argv gets past every guard above and stops
    // at the missing DATABASE_URL, which is the next statement in main().
    // Without this case the suite would still pass if the script exited
    // non-zero on everything.
    const r = run(["--symbols", "HDFCBANK", "--limit", "5"]);
    assert.notEqual(r.status, 0);
    assert.match(r.output, /DATABASE_URL is not set/);
    assert.doesNotMatch(r.output, /Unknown flag|given without a value/);
  });

  it("accepts the `--flag=value` form as well as `--flag value`", () => {
    // `assertKnownFlags` splits on "=" before checking membership. If it did
    // not, every documented `--limit=500` invocation would be rejected as an
    // unknown flag — a guard that breaks the happy path gets deleted, and the
    // protection goes with it.
    const r = run(["--symbols=HDFCBANK", "--limit=5"]);
    assert.match(r.output, /DATABASE_URL is not set/);
    assert.doesNotMatch(r.output, /Unknown flag/);
  });
});
