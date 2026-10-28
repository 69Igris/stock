/**
 * MONEY-1143 — no source-reading test may strip BLOCK comments before LINE
 * comments.
 *
 * A `//` comment containing `/*` opens a phantom block that runs to the next
 * `*` + `/`, which can be hundreds of lines away. Measured on the real tree:
 * block-first stripping deleted **11,192 characters** from `Sidebar.tsx` — with
 * `NavLink`, `CollapsibleNavItem`, `useNavPrefetcher` and a real call site
 * inside them — and 26,686 characters across 22 files in one suite's walk.
 *
 * Why it earns a repo-wide guard rather than 12 local fixes:
 *
 *   Almost every one of these suites asserts an ABSENCE — "no nav entry points
 *   at X", "this file must not read the persisted plan", "no call site uses the
 *   bare form", "every fetch goes through the seam". When the text is eaten,
 *   the absence assertion passes BECAUSE the code is gone, not because the wire
 *   is. It is the one failure mode where a broken test and a healthy test are
 *   indistinguishable, and liveness floors do not catch it (a `>= 30 call
 *   sites` guard still saw 40 after one was swallowed).
 *
 *   It has now been fixed FIVE separate times in this repo. A guard that fails
 *   the moment someone writes the natural-looking order is the only thing that
 *   ends that.
 *
 * The rule: `.replace(LINE).replace(BLOCK)`, never the reverse.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..", "..", "..");

/**
 * Every `*.test.ts` AND `*.spawntest.ts` under apps/, packages/ and workers/.
 *
 * The second suffix is `packages/core`'s slow lane (MONEY-1316): that workspace
 * runs `node --test` twice, and a file is moved into the 180 s lane by being
 * RENAMED. `foo.spawntest.ts` does not end with `.test.ts`, so a walker written
 * for one suffix drops those files silently — which for THIS guard means four
 * files quietly stop being checked for the ordering bug, and the guard still
 * reports clean. That is the same "green does not mean it ran" shape the rule
 * below exists to prevent one level down.
 *
 * ASYNC on purpose. node's test runner executes files in PARALLEL, so a
 * synchronous walk + read of ~900 files blocks the event loop long enough to
 * starve its neighbours and push borderline files past the 30s per-file
 * timeout — turning a green suite into "0 failures, N cancelled". A guard that
 * destabilises the suite it protects is not worth having; `fs/promises` yields
 * between entries and the whole scan still runs in well under a second.
 */
async function testFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".next" || entry === "dist") {
        continue;
      }
      const full = join(dir, entry);
      try {
        const s = await stat(full);
        if (s.isDirectory()) await walk(full);
        else if (
          entry.endsWith(".test.ts") ||
          entry.endsWith(".spawntest.ts")
        ) {
          out.push(full);
        }
      } catch {
        continue;
      }
    }
  };
  for (const root of ["apps", "packages", "workers"]) {
    await walk(join(REPO, root));
  }
  return out;
}

/** `.replace(/\/\*[\s\S]*?\*\//g, "")` — the block-comment strip. */
const BLOCK_STRIP = /\.replace\(\s*\/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\//;

/**
 * The line-comment strip, in the three forms this repo uses:
 *   /^\s*\/\/.*$/gm
 *   /(^|[^:])\/\/.*$/gm
 *   /(^|[^:"'`\\])\/\/.*$/gm
 */
const LINE_STRIP = /\.replace\(\s*\/(?:\^\\s\*|\(\^\|\[\^[^\]]*\]\))\\\/\\\//;

describe("MONEY-1143 — comment stripping order is LINE before BLOCK", () => {
  const filesPromise = testFiles();

  it("[meta] the scan actually found the test files", async () => {
    const files = await filesPromise;
    // MONEY-1093's lesson: a scan that silently matches nothing passes.
    assert.ok(
      files.length > 500,
      `expected 500+ test files, found ${files.length} — the walker is broken ` +
        `and every assertion below is vacuous`
    );
  });

  it("[meta] the patterns match a known-good and a known-bad sample", () => {
    // Guards the guard: if these regexes stopped recognising the idiom, the
    // repo-wide check would report clean forever.
    const good = String.raw`s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")`;
    const bad = String.raw`s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")`;

    assert.ok(BLOCK_STRIP.test(good) && LINE_STRIP.test(good), "sample parses");
    assert.ok(
      LINE_STRIP.exec(good)!.index < BLOCK_STRIP.exec(good)!.index,
      "the good sample must read as LINE-first"
    );
    assert.ok(
      BLOCK_STRIP.exec(bad)!.index < LINE_STRIP.exec(bad)!.index,
      "the bad sample must read as BLOCK-first"
    );
  });

  it("[regression] no test file strips BLOCK comments first", async () => {
    const files = await filesPromise;
    const offenders: string[] = [];

    for (const file of files) {
      // This file DEFINES the two patterns (BLOCK_STRIP is declared above
      // LINE_STRIP, which reads as block-first to its own scan) and contains
      // deliberate good/bad samples. It describes the idiom rather than using
      // it, so it is the one legitimate exclusion.
      if (file.endsWith("comment-strip-ordering.test.ts")) continue;

      const src = await readFile(file, "utf8");
      const block = BLOCK_STRIP.exec(src);
      const line = LINE_STRIP.exec(src);
      // Only files doing BOTH are making an ordering claim at all.
      if (!block || !line) continue;
      if (block.index < line.index) {
        const lineNo = src.slice(0, block.index).split("\n").length;
        offenders.push(`${file.slice(REPO.length + 1)}:${lineNo}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "these files strip BLOCK comments before LINE comments. A `//` comment " +
        "containing `/*` will swallow every line up to the next `*/` — and " +
        "because these suites assert ABSENCES, the swallowed code reads as a " +
        "PASS. Swap the order: .replace(LINE) then .replace(BLOCK)."
    );
  });
});
