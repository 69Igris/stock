/**
 * MONEY-1608 — a job whose `main()` never settles must not exit 0.
 *
 * `lake-replay-us` ran 8 h on prod and exited 0 with 0 rows loaded: its final
 * flush awaited an upload whose promise never settled, nothing held the event
 * loop, and Node ended the process as if it had finished. An exit code is only
 * knowable by exiting, so these cases spawn a real Node process per shape and
 * assert on its real status and stderr.
 *
 * `.spawntest.ts` because every case is a process launch through tsx — the
 * workspace's 30 s FILE budget is too tight to be evidence under turbo load
 * (MONEY-1316).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ENDED_WITHOUT_COMPLETING_EXIT_CODE } from "../../src/ops/job-completion";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const HELPER = join(
  ROOT,
  "packages",
  "core",
  "src",
  "ops",
  "job-completion.ts",
);

function run(body: string): { status: number | null; stderr: string } {
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { guardCompletion } from ${JSON.stringify(HELPER)};\n${body}`,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );
  return { status: r.status, stderr: r.stderr };
}

describe("guardCompletion — MONEY-1608", () => {
  it("a never-settling main() exits NON-ZERO and says so", () => {
    // The exact shape of the incident: an awaited promise with nothing behind
    // it. Without the guard this process exits 0 and prints nothing.
    const r = run(
      `guardCompletion("demo-job", new Promise(() => {})).catch(() => { process.exitCode = 1; });`,
    );
    assert.equal(r.status, ENDED_WITHOUT_COMPLETING_EXIT_CODE, r.stderr);
    assert.match(r.stderr, /demo-job ENDED WITHOUT COMPLETING/);
  });

  it("a main() that resolves after real work exits 0 and stays silent", () => {
    const r = run(
      `guardCompletion("demo-job", new Promise((res) => setTimeout(res, 50)));`,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ENDED WITHOUT COMPLETING/);
  });

  it("a main() that rejects keeps the caller's own exit code and message", () => {
    const r = run(
      `guardCompletion("demo-job", Promise.reject(new Error("boom")))` +
        `.catch((e) => { console.error("ERROR " + e.message); process.exitCode = 1; });`,
    );
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /ERROR boom/);
    assert.doesNotMatch(r.stderr, /ENDED WITHOUT COMPLETING/);
  });
});

describe("every lake job runs its main() under the guard — MONEY-1608", () => {
  const JOBS_DIR = join(ROOT, "scripts", "jobs");
  // DERIVED for the lake-* family, so a new lake job cannot be added without
  // the guard; the four sinks/syncs that write the same lake are named.
  const guarded = [
    ...readdirSync(JOBS_DIR).filter((f) => /^lake-.*\.ts$/.test(f)),
    "identity-sync.ts",
    "corp-action-lake-sink.ts",
    "event-lake-sink.ts",
    "filing-registry-sync.ts",
  ];

  it("finds the lake-* family — a silent zero here proves nothing", () => {
    assert.ok(guarded.length >= 9, `only ${guarded.length} jobs found`);
  });

  for (const file of guarded) {
    it(`${file} calls guardCompletion(…, main())`, () => {
      const src = readFileSync(join(JOBS_DIR, file), "utf8");
      assert.match(src, /guardCompletion\(\s*[\w"-]+,\s*(?:main|run)\(\)\s*\)/);
      // No second, unguarded entry: a bare top-level `main()` call.
      assert.doesNotMatch(src, /^(?:main|run)\(\)/m);
    });
  }
});
