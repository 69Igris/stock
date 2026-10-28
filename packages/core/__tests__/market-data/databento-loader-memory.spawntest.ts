/**
 * The loader STREAMS — measured, in its own process — MONEY-1373.
 *
 * ## Why this is a spawntest
 *
 * MONEY-1337 is the ticket where a converter that buffered whole objects was
 * OOM-killed twice ("The configured memory limit was reached") and stalled a
 * 48,000-document backlog for days. This loader reads files an order of
 * magnitude larger, so "it streams" is a claim worth checking rather than
 * asserting — and it is the ONLY property here that a buffering implementation
 * would otherwise pass, since a buffering loader maps every row correctly.
 *
 * It cannot live in the normal lane, and that was established by measurement
 * rather than assumed. A first version did, with a fixed 120 MB budget:
 *
 *   - a deliberate leak (retain every mapped row) PASSED it, because 60,000
 *     rows only retain ~12 MB — invisible against any budget loose enough to
 *     survive GC noise, and a budget tight enough to catch it would be flaky;
 *   - rewritten as a SCALING ratio it still passed, because inside the shared
 *     runner the baseline reading is polluted by whatever ran before it in the
 *     same process, and `global.gc` is not available to settle it.
 *
 * Run in isolation under `--expose-gc` the same measurement separates the two
 * cleanly: **1.05x for the correct loader, 1.91x for the leaking one**, on a
 * 3x input increase. So the check moved here, where a process and a GC can
 * both be controlled.
 *
 * ## The probe COLLECTS before every sample, and that is load-bearing
 *
 * `process.memoryUsage().heapUsed` is allocated-but-not-yet-collected, not the
 * live set. This loader allocates one short-lived string per row, so sampled
 * without a forced collection the number reports how long it has been since
 * V8 last scavenged — and V8 sizes its young generation from the machine's
 * memory state. Measured 2026-09-08 against ONE unchanged loader (the loader
 * path had an empty diff for the whole branch, and two reverted versions of
 * its only changed neighbour reproduced it): **1.05x in a quiet process,
 * 1.64-1.98x on a machine with 2 GB free of 36 GB**. The suite had passed
 * 60/60 in an earlier session and failed 5/5 in a later one on identical code.
 *
 * A verdict that moves with free RAM is not a verdict. With `global.gc()`
 * immediately before each sample the same loader reads FLAT at both sizes and
 * the leaking control still reads 2.79x — deterministic, and still falsifiable.
 * The ceiling was NOT raised to accommodate the drift; the instrument was
 * fixed.
 *
 * The child is `__tests__/fixtures/databento/loader-heap-probe.ts` — a
 * fixture path, so neither test lane's glob picks it up as a suite.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// CWD is `packages/core` when this suite runs.
const PROBE = join(
  "__tests__",
  "fixtures",
  "databento",
  "loader-heap-probe.ts",
);

/**
 * Measured on a correct implementation: 1.05. Measured while retaining every
 * mapped row: 1.91. 1.5 sits with margin on both sides.
 *
 * Deliberately not 1.9: a threshold set at the edge of the observed leak passes
 * the moment the leak gets slightly cheaper.
 */
const MAX_HEAP_SCALING_RATIO = 1.5;

/**
 * How much the DELIBERATELY LEAKING run must scale for this probe to be
 * believed: 2.0, against 2.79 measured.
 *
 * This is the premise, and it replaced a floor that no longer means anything.
 * The old one was `smallBytes > 1 MiB` — "too little to be a real
 * measurement". Now that the probe collects before it samples, it reports the
 * LIVE SET, and a streaming loader's live set is a few hundred KB at any file
 * size: the old floor would fail on a perfectly healthy loader.
 *
 * Dropping it and keeping only the ceiling would be worse. `ratio` is
 * `large / max(small, 1)`, so a probe that measured nothing at all would
 * report 0.00x and pass this suite forever — the exact shape MONEY-1238 keeps
 * costing this repo. The leak run is a ceiling that is VERIFIED rather than
 * assumed, re-derived on every execution: if retaining every row does not move
 * the number, the instrument is broken and the verdict on the real run is
 * worthless.
 */
const MIN_LEAK_RATIO = 2;

/**
 * The absolute ceiling on the 90,000-row run's LIVE SET: 8 MiB, against 1.28
 * measured.
 *
 * The ratio alone cannot catch a probe that stopped collecting before it
 * samples — dropping that `global.gc()` does not deterministically break any
 * ratio, it just restores the nondeterminism this whole change exists to
 * remove, and on a quiet machine the un-collected reading still lands under
 * 1.5x. So the un-collected reading is caught by its SIZE instead: it measured
 * 19-37 MB where the live set is 1.28 MB, because it counts every short-lived
 * per-row string V8 has not swept yet.
 *
 * Sized from what the loader is entitled to hold at any file size — the
 * 2,000-row symbol buffer, the decompressor's 64 KB carry, one write batch —
 * with room for V8's own floor. It is a bound on the DESIGN, not on the
 * observation: a loader that legitimately needed 8 MiB of live set for 90,000
 * rows of one symbol would be a different loader.
 */
const MAX_LIVE_SET_BYTES = 8 * 1024 * 1024;

interface ProbeResult {
  smallBytes: number;
  largeBytes: number;
  ratio: number;
  /** The same probe with every mapped row retained. See MIN_LEAK_RATIO. */
  leakSmallBytes: number;
  leakLargeBytes: number;
  leakRatio: number;
  hasGc: boolean;
}

function runProbe(): ProbeResult {
  const res = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", PROBE],
    { encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(
    res.status,
    0,
    `probe exited ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
  );
  const line = res.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  let parsed: ProbeResult;
  try {
    parsed = JSON.parse(line) as ProbeResult;
  } catch {
    throw new Error(`probe printed no JSON. stdout was: ${res.stdout}`);
  }
  return parsed;
}

describe("MONEY-1373 — the candle loader does not accumulate", () => {
  it("[premise] the probe program exists where this test looks for it", () => {
    // A spawntest whose child is missing exits non-zero and reads as a real
    // failure, but a spawntest that silently skips reads as coverage.
    assert.ok(existsSync(PROBE), `${PROBE} is missing`);
  });

  it("peak heap does NOT scale with the size of the file", () => {
    const r = runProbe();
    assert.ok(
      r.hasGc,
      "the child ran without --expose-gc, so its baseline was never settled " +
        "and the ratio below means nothing",
    );
    assert.ok(
      r.leakRatio >= MIN_LEAK_RATIO,
      `the DELIBERATELY LEAKING run scaled only ${r.leakRatio.toFixed(2)}x ` +
        `(${(r.leakSmallBytes / 1024 / 1024).toFixed(1)} MB -> ` +
        `${(r.leakLargeBytes / 1024 / 1024).toFixed(1)} MB), under a floor of ` +
        `${MIN_LEAK_RATIO}. This probe cannot SEE an accumulating loader, so ` +
        "the verdict below is not evidence of anything. Fix the probe before " +
        "reading the ratio.",
    );
    assert.ok(
      r.largeBytes < MAX_LIVE_SET_BYTES,
      `the 90,000-row run held ${(r.largeBytes / 1024 / 1024).toFixed(1)} MB ` +
        `live, over a ${MAX_LIVE_SET_BYTES / 1024 / 1024} MiB bound. Either ` +
        "the loader is holding rows, or the probe stopped calling " +
        "`global.gc()` before it samples and is reporting uncollected garbage " +
        "instead of the live set.",
    );
    assert.ok(
      r.ratio < MAX_HEAP_SCALING_RATIO,
      `peak heap scaled ${r.ratio.toFixed(2)}x when the input tripled ` +
        `(${(r.smallBytes / 1024 / 1024).toFixed(1)} MB -> ` +
        `${(r.largeBytes / 1024 / 1024).toFixed(1)} MB), against a ceiling of ` +
        `${MAX_HEAP_SCALING_RATIO}, while the leaking control read ` +
        `${r.leakRatio.toFixed(2)}x. A streaming loader's LIVE SET is one ` +
        "buffer whatever the file size; growth proportional to the input is " +
        "the signature of one that accumulates, which is how MONEY-1337's " +
        "converter was OOM-killed.",
    );
  });
});
