/**
 * Native browser dialogs are BANNED in app source — MONEY-764.
 *
 * QA screenshot: the feedback "Close ticket" flow popped a raw
 * `window.confirm` ("localhost:3000 says…") instead of the app-standard
 * `ConfirmationDialog`. A sweep found six call sites (feedback close, saved
 * screen delete, chat bulk delete, broker disconnect ×2, share-link prompt
 * fallback); all now go through `usePfConfirm`. This static scan keeps it
 * that way: any reintroduced `window.confirm(` / `window.alert(` /
 * `window.prompt(` in app source fails the suite with the exact file:line.
 *
 * The pattern requires the call paren, so prose mentions in comments (e.g.
 * "replacement for `window.confirm`") don't trip it. Replacement for the
 * imperative shape: `usePfConfirm()` (components/ui/use-confirm.tsx).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// CWD is apps/web (the package's test script runs from there).
const SCAN_ROOTS = ["app", "components", "lib", "hooks"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "__tests__",
  "archive", // parked legacy components are not shipped
]);
const SOURCE_EXT = /\.(ts|tsx)$/;
const NATIVE_DIALOG_CALL = /window\.(confirm|alert|prompt)\s*\(/;

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (SOURCE_EXT.test(entry)) {
      yield full;
    }
  }
}

describe("no native browser dialogs in app source", () => {
  it("window.confirm/alert/prompt calls are absent (use usePfConfirm)", () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(root)) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (NATIVE_DIALOG_CALL.test(line)) {
            offenders.push(`${file}:${i + 1}  ${line.trim()}`);
          }
        });
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Native browser dialog calls found — replace with usePfConfirm() ` +
        `(components/ui/use-confirm.tsx):\n${offenders.join("\n")}`
    );
  });

  it("the scan actually covers the app surface (anti-rot guard)", () => {
    // If the directory layout changes and the roots stop existing, the scan
    // above would vacuously pass — pin that it still sees a healthy file
    // count so an empty walk reads as a failure, not a pass.
    let count = 0;
    for (const root of SCAN_ROOTS) {
      for (const _ of walk(root)) count++;
    }
    assert.ok(
      count > 200,
      `Expected to scan >200 source files, saw ${count} — roots moved?`
    );
  });
});
