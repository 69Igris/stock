/**
 * `lake-replay-us --symbols` must never reach a WRITE — MONEY-1538 review.
 *
 * ## Why this is a spawntest
 *
 * The refusal lives in the job's own `parseArgs`, which is not exported: the
 * script calls `main()` at module top level (the Cloud Run entry-point
 * convention), so the only way to exercise the rule is to run the script. It
 * throws before `pinJobEnv`, so this spawn opens no socket and needs no
 * credentials.
 *
 * ## The hazard
 *
 * `replaceMonth` deletes the whole (market, month, source) before it loads.
 * Until MONEY-1538 that DELETE bound its dates as NULL and matched nothing, so a
 * narrowed `--symbols` run merely appended. With the DELETE working,
 * `--symbols=AAPL --apply` removes every US listing's month and reloads only
 * AAPL — and the coverage gate counts SESSIONS, which one listing fills, so the
 * month would be ACCEPTED.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// packages/core/__tests__/market-data -> repo root
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SCRIPT = join(ROOT, "scripts/jobs/lake-replay-us.ts");

function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 25_000,
    // No credentials and no project: if the refusal did NOT fire first, the
    // script would fail differently (at pinJobEnv), and the message assertion
    // below would catch it.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
}

describe("lake-replay-us refuses a narrowed WRITE", () => {
  it("--symbols with --apply exits non-zero and names the reason", () => {
    const res = run([
      "--env",
      "qa",
      "--from",
      "2024-03-01",
      "--to",
      "2024-03-31",
      "--symbols=AAPL",
      "--apply",
    ]);
    const out = `${res.stdout}\n${res.stderr}`;
    assert.notEqual(
      res.status,
      0,
      `expected a refusal, got exit ${res.status}`,
    );
    assert.match(out, /--symbols cannot be combined with --apply/);
  });
});
