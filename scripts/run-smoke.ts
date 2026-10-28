#!/usr/bin/env node
/**
 * run-smoke — the SMOKE TIER runner (`yarn test:smoke`).
 *
 * WHY THIS EXISTS
 * ---------------
 * `yarn test` (turbo `test`) runs the WHOLE suite — every workspace, every
 * `__tests__/**` file. That is the REGRESSION gate and takes minutes. For a
 * fast pre-merge / local signal we want a tiny CRITICAL-PATH subset that runs
 * in well under a minute: FIFO pairing, the calc-suite, AI guardrails, webhook
 * signature/idempotency + the *-e2e routes, demo routes, the security/* suite,
 * subscription access, and the external-contract tests.
 *
 * MECHANISM
 * ---------
 * The subset is declared as workspace-relative globs in `scripts/smoke-list.txt`
 * (decoupled from code, easy to review/extend). This runner:
 *   1. reads + parses that manifest (ignoring `#` comments and blank lines),
 *   2. groups globs by their leading WORKSPACE directory (the dir that owns the
 *      `__tests__`, e.g. `apps/web`, `packages/core`),
 *   3. expands the globs with tinyglobby relative to each workspace, and
 *   4. spawns ONE `node --import tsx --test` per workspace WITH THAT WORKSPACE
 *      AS CWD. CWD-per-workspace is load-bearing: it makes the `@/*` tsconfig
 *      alias and `../../` relative imports resolve exactly as they do under the
 *      normal per-workspace `yarn test`.
 *
 * Each spawned run is wrapped in `scripts/test-timeout.ts` so the orphaned/
 * wedged-suite guard (process-group SIGKILL) still applies. The smoke budget is
 * intentionally tight: TEST_TIMEOUT_MS defaults to 120000 (2 min) here, far
 * below the 15-min full-suite cap, so a smoke run can never silently balloon.
 *
 * USAGE
 *   yarn test:smoke                 # run the manifest
 *   SMOKE_LIST=path yarn test:smoke # point at an alternate manifest
 *
 * Exit code is non-zero if ANY workspace run fails (or a glob matches nothing).
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "tinyglobby";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const MANIFEST = process.env.SMOKE_LIST
  ? path.resolve(process.env.SMOKE_LIST)
  : path.join(SCRIPT_DIR, "smoke-list.txt");
const TIMEOUT_GUARD = path.join(SCRIPT_DIR, "test-timeout.ts");

// Per-workspace `node --test` flags — identical to every workspace "test"
// script so smoke behaves exactly like a slice of the regression suite.
const NODE_TEST_FLAGS = [
  "--import",
  "tsx",
  "--test",
  "--test-force-exit",
  "--test-timeout=30000",
];

/** Resolve a manifest glob's leading workspace dir (the one that owns __tests__). */
function workspaceOf(glob: string): string {
  const segments = glob.split("/");
  const idx = segments.indexOf("__tests__");
  if (idx <= 0) {
    throw new Error(
      `smoke-list entry must be "<workspace>/.../__tests__/...": got "${glob}"`
    );
  }
  return segments.slice(0, idx).join("/");
}

function parseManifest(file: string): string[] {
  if (!existsSync(file)) {
    process.stderr.write(`[smoke] manifest not found: ${file}\n`);
    process.exit(2);
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** Group manifest globs by workspace and expand each to concrete file paths. */
function collectByWorkspace(globs: string[]): Map<string, string[]> {
  const byWorkspace = new Map<string, Set<string>>();

  for (const glob of globs) {
    const workspace = workspaceOf(glob);
    const workspaceDir = path.join(REPO_ROOT, workspace);
    if (!existsSync(workspaceDir) || !statSync(workspaceDir).isDirectory()) {
      throw new Error(`smoke-list references missing workspace dir: ${workspace}`);
    }
    // Glob is workspace-relative; strip the "<workspace>/" prefix and expand
    // with the workspace as cwd so matched paths are relative to it.
    const relGlob = glob.slice(workspace.length + 1);
    const matches = globSync(relGlob, { cwd: workspaceDir, dot: false });
    if (matches.length === 0) {
      throw new Error(`smoke-list glob matched no files: "${glob}"`);
    }
    const set = byWorkspace.get(workspace) ?? new Set<string>();
    for (const m of matches) set.add(m);
    byWorkspace.set(workspace, set);
  }

  // Sort for stable, reproducible run order.
  const out = new Map<string, string[]>();
  for (const ws of [...byWorkspace.keys()].sort()) {
    out.set(ws, [...byWorkspace.get(ws)!].sort());
  }
  return out;
}

function runWorkspace(workspace: string, files: string[]): Promise<number> {
  const workspaceDir = path.join(REPO_ROOT, workspace);
  // Wrap in the wall-clock guard exactly like the per-workspace "test" scripts.
  const args = [
    "--import",
    "tsx",
    TIMEOUT_GUARD,
    ...NODE_TEST_FLAGS,
    ...files,
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: workspaceDir,
      stdio: "inherit",
      env: {
        ...process.env,
        // Tight smoke budget (2 min) unless the caller overrides it.
        TEST_TIMEOUT_MS: process.env.TEST_TIMEOUT_MS ?? String(2 * 60 * 1000),
      },
    });
    child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    child.on("error", (err) => {
      process.stderr.write(`[smoke] failed to spawn for ${workspace}: ${err.message}\n`);
      resolve(1);
    });
  });
}

async function main(): Promise<void> {
  const globs = parseManifest(MANIFEST);
  if (globs.length === 0) {
    process.stderr.write(`[smoke] manifest is empty: ${MANIFEST}\n`);
    process.exit(2);
  }

  const byWorkspace = collectByWorkspace(globs);
  const totalFiles = [...byWorkspace.values()].reduce((n, f) => n + f.length, 0);

  process.stdout.write(
    `[smoke] ${totalFiles} critical-path test file(s) across ` +
      `${byWorkspace.size} workspace(s): ${[...byWorkspace.keys()].join(", ")}\n`
  );

  const started = Date.now();
  let failures = 0;
  for (const [workspace, files] of byWorkspace) {
    process.stdout.write(`\n[smoke] ── ${workspace} (${files.length} file(s)) ──\n`);
    const code = await runWorkspace(workspace, files);
    if (code !== 0) failures += 1;
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (failures > 0) {
    process.stderr.write(`\n[smoke] ✖ FAILED — ${failures} workspace run(s) failed in ${secs}s\n`);
    process.exit(1);
  }
  process.stdout.write(`\n[smoke] ✓ PASS — ${totalFiles} file(s) green in ${secs}s\n`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[smoke] ✖ ${message}\n`);
  process.exit(1);
});
