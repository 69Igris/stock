/**
 * apps/api must never talk to SEC, EDGAR or OpenFIGI — MONEY-979.
 *
 * The US fundamentals engine is a separate Python service with ONE budget:
 * SEC publishes a 10 req/s fair-access limit, enforced PER IP, and Cloud Run
 * gives every service in this project the same shared egress addresses. A
 * request path that reaches sec.gov therefore does not merely bypass the
 * archive — it spends a budget it cannot see, from a process that has no
 * limiter, once per page render. The documented remedy for exceeding it is to
 * stay under the threshold for ten minutes, and the signal is a 403 with a
 * BODY rather than a 429, so the failure would arrive as blank fundamentals
 * across the whole app with nothing in the logs naming a rate limit.
 *
 * `packages/core/__tests__/market-data/no-feed-fetch-bypass.test.ts` guards the
 * SEAM (a fetch that skips the archive). This guards the BOUNDARY: apps/api
 * reads US fundamentals from Mongo through `@usemoney/core/us-fundamentals`,
 * and from nowhere else.
 *
 * Mirrored in apps/web by `__tests__/meta/no-sec-egress.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const APP_ROOT = process.cwd();
const SCAN_DIRS = ["src"];
const SKIP = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
  "__tests__",
]);
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Hosts and packages this app must never reach for. */
const FORBIDDEN: ReadonlyArray<{ needle: string; why: string }> = [
  {
    needle: "sec.gov",
    why: "SEC fair access is 10 req/s PER IP and Cloud Run egress is shared",
  },
  {
    needle: "efts.sec.gov",
    why: "EDGAR full-text search — same budget, and it sends CORS headers, which is exactly what tempts a browser call",
  },
  {
    needle: "data.sec.gov",
    why: "the submissions/companyfacts JSON APIs — same budget",
  },
  {
    needle: "api.openfigi.com",
    why: "CUSIP->ticker mapping belongs to the ingest service, not a render path",
  },
  {
    needle: "edgartools",
    why: "the parser is Python and lives in services/us-fundamentals",
  },
  {
    needle: "services/us-fundamentals",
    why: "the Python service is reached through MongoDB, never imported",
  },
];

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SOURCE_EXT.test(entry)) out.push(full);
  }
  return out;
}

function sources(): string[] {
  const out: string[] = [];
  for (const d of SCAN_DIRS) {
    const full = join(APP_ROOT, d);
    try {
      out.push(...(statSync(full).isDirectory() ? walk(full) : [full]));
    } catch {
      /* a scanned dir may not exist in every app; the premise test below catches a total miss */
    }
  }
  return out;
}

/**
 * Strip line and block comments.
 *
 * Without this the guard fires on its own explanation — a file documenting
 * "we deliberately do NOT call data.sec.gov here" would be a violation. That is
 * how a guard gets deleted rather than fixed.
 */
function stripComments(src: string): string {
  // LINE FIRST, then BLOCK — never the reverse (MONEY-1143, enforced by
  // apps/web/__tests__/meta/comment-strip-ordering.test.ts, which is how this
  // file was caught writing it backwards).
  //
  // A `//` comment containing `/*` opens a phantom block that runs to the next
  // `*/`, which can be hundreds of lines away. Measured on the real tree,
  // block-first stripping deleted 11,192 characters from a single file.
  //
  // It matters more here than almost anywhere, because every assertion in this
  // file is an ABSENCE — "no source mentions sec.gov". When the text is eaten,
  // the absence passes BECAUSE the code is gone rather than because the
  // boundary holds, and a broken guard is indistinguishable from a healthy one.
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("MONEY-979 — apps/api never reaches SEC, EDGAR or OpenFIGI", () => {
  const files = sources();

  it("premise: the scan actually reads this app's source", () => {
    // A scan that silently walks nothing passes every assertion below. This is
    // the same failure the feed-bypass suite guards with its own reachability
    // check, and it is the reason that suite caught a real bug and a `git grep`
    // based one did not.
    assert.ok(
      files.length > 20,
      `expected to walk apps/api's source, found ${files.length} files — the ` +
        `layout changed and this guard is no longer reading it`,
    );
  });

  for (const { needle, why } of FORBIDDEN) {
    it(`no source mentions ${needle}`, () => {
      const hits = files.filter((f) =>
        stripComments(readFileSync(f, "utf8")).includes(needle),
      );
      assert.deepEqual(
        hits.map((f) => f.replace(APP_ROOT + "/", "")),
        [],
        `apps/api references "${needle}" — ${why}.\n` +
          `US fundamentals are read from Mongo via @usemoney/core/us-fundamentals.`,
      );
    });
  }

  it("the scan CAN fail (it is not vacuous)", () => {
    // Drive the same predicate over a synthetic file. An assertion never
    // observed failing is not evidence, and this one runs over a set that is
    // empty by design — exactly the shape that rots into a no-op.
    const synthetic = 'const u = "https://data.sec.gov/submissions/CIK.json";';
    assert.ok(stripComments(synthetic).includes("data.sec.gov"));
    const commented = "// we do not call https://data.sec.gov here";
    assert.ok(!stripComments(commented).includes("data.sec.gov"));
  });
});
