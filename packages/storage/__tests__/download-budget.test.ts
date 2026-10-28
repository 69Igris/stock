/**
 * Download pool sizing — MONEY-1322.
 *
 * `feed-repair` was sized against its own documented worst case:
 * `setup-feed-backfill-job.sh` step 4a said "12 objects x 100 MB x two live
 * buffers" — ~2.4 GB — and deployed the task at 2Gi, with the mitigation
 * ("lower --concurrency for stocks/") written as PROSE and encoded nowhere,
 * beside a printed command of bare `--args="--apply"`.
 *
 * The assertions that matter here are the two that a green-looking arithmetic
 * would not catch:
 *
 *   - the WORST CASE FITS. Not "the number went down" — `concurrency *
 *     perSlotBytes + reserve <= container`, re-derived in the test from the
 *     container size rather than compared against a copied constant. A
 *     literal-vs-literal assertion here would pass against any formula that
 *     happened to emit the same digit.
 *   - an unreadable memory declaration THROWS. `FEED_REPAIR_CONTAINER_MI=2G` is
 *     the correct Cloud Run spelling minus one character; a fallback there
 *     reinstates the overshoot while looking configured, which is the shape of
 *     MONEY-1214 and of MONEY-1314's `--memory`.
 *
 * Pure and synchronous; nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONTAINER_MI,
  LIVE_BUFFERS_PER_SLOT,
  RUNTIME_RESERVE_MI,
  deriveDownloadConcurrency,
  parseContainerMi,
} from "../src/download-budget";
import { ARCHIVE_AUDIT_HEAD_BYTES } from "../src/archive-audit";

const MIB = 1024 * 1024;
/** The shipped `--max-bytes` default in scripts/jobs/feed-repair.ts. */
const MAX_BYTES_DEFAULT = 100 * MIB;
/** The shipped `--concurrency` default, now a CAP rather than the pool. */
const REQUESTED_DEFAULT = 12;

/**
 * The invariant, re-derived from the plan's own inputs.
 *
 * Deliberately NOT `assert.equal(plan.concurrency, 5)`: pinning the digit
 * proves only that today's formula is today's formula. This says the thing the
 * task actually needs — the peak allocation of a full pool, plus the runtime
 * reserve, fits the container it was provisioned with.
 */
function assertWorstCaseFits(plan: {
  concurrency: number;
  perSlotBytes: number;
  containerMi: number;
}) {
  const peakBytes = plan.concurrency * plan.perSlotBytes;
  const availableBytes = (plan.containerMi - RUNTIME_RESERVE_MI) * MIB;
  assert.ok(
    peakBytes <= availableBytes,
    `worst case ${(peakBytes / MIB).toFixed(0)}MiB exceeds the ` +
      `${(availableBytes / MIB).toFixed(0)}MiB available in a ` +
      `${plan.containerMi}MiB task`,
  );
  assert.ok(
    peakBytes + RUNTIME_RESERVE_MI * MIB <= plan.containerMi * MIB,
    "reserve was not actually withheld from the container",
  );
}

describe("deriveDownloadConcurrency — the deployed shape", () => {
  it("a 2Gi task at the 100 MB ceiling yields a pool whose worst case FITS", () => {
    const plan = deriveDownloadConcurrency({
      requested: REQUESTED_DEFAULT,
      containerMi: 2048,
      maxBytes: MAX_BYTES_DEFAULT,
    });
    assertWorstCaseFits(plan);
    assert.equal(plan.fitsWorstCase, true);
    assert.ok(plan.concurrency >= 1);
  });

  it("and it LOWERS the request — the defaults did not fit, which is the whole ticket", () => {
    // The falsifiable half. If the derivation ever returned 12 here the job
    // would be back to ~3.5 GB of live buffers in a 2Gi task, and every other
    // assertion in this file would still be green.
    const plan = deriveDownloadConcurrency({
      requested: REQUESTED_DEFAULT,
      containerMi: 2048,
      maxBytes: MAX_BYTES_DEFAULT,
    });
    assert.ok(
      plan.concurrency < REQUESTED_DEFAULT,
      `expected the default pool to be cut; got ${plan.concurrency}`,
    );
    assert.match(plan.why, /LOWERED from 12/);
  });

  it("the derivation is LOGGED — the numbers, not just the answer", () => {
    // A self-limiting job that does not say how it limited itself is a second
    // undocumented constant. The `why` has to carry every input.
    const plan = deriveDownloadConcurrency({
      requested: REQUESTED_DEFAULT,
      containerMi: 2048,
      maxBytes: MAX_BYTES_DEFAULT,
    });
    assert.match(plan.why, /2048MiB task/);
    assert.match(plan.why, /256MiB runtime reserve/);
    assert.match(plan.why, /x 3 live buffers/);
    assert.match(plan.why, new RegExp(`concurrency=${plan.concurrency}\\b`));
  });

  it("never RAISES a request the caller made for its own reasons", () => {
    // An explicit `--concurrency=2` may be about an upstream rate limit, not
    // memory. Arithmetic that knows nothing about that must not override it.
    const plan = deriveDownloadConcurrency({
      requested: 2,
      containerMi: 8192,
      maxBytes: MAX_BYTES_DEFAULT,
    });
    assert.equal(plan.concurrency, 2);
    assert.equal(plan.requested, 2);
    assertWorstCaseFits(plan);
  });

  it("scales with the container, so --repair-memory=4Gi buys real parallelism", () => {
    const small = deriveDownloadConcurrency({
      requested: 64,
      containerMi: 2048,
      maxBytes: MAX_BYTES_DEFAULT,
    });
    const large = deriveDownloadConcurrency({
      requested: 64,
      containerMi: 8192,
      maxBytes: MAX_BYTES_DEFAULT,
    });
    assert.ok(large.concurrency > small.concurrency);
    assertWorstCaseFits(small);
    assertWorstCaseFits(large);
  });

  it("shrinks when --max-bytes is raised to reach the oversized stocks/ PDFs", () => {
    // The MONEY-1323 re-run: `--max-bytes=250000000` on the same 2Gi task. The
    // operator no longer has to remember `--concurrency=1` alongside it.
    const plan = deriveDownloadConcurrency({
      requested: REQUESTED_DEFAULT,
      containerMi: 2048,
      maxBytes: 250_000_000,
    });
    assertWorstCaseFits(plan);
    assert.ok(
      plan.concurrency <
        deriveDownloadConcurrency({
          requested: REQUESTED_DEFAULT,
          containerMi: 2048,
          maxBytes: MAX_BYTES_DEFAULT,
        }).concurrency,
    );
  });

  it("the AUDIT's ceiling is its head read, so its pool is not cut for bytes it never allocates", () => {
    // One function, one honest argument each. The audit ranges ~1 KiB per
    // object across 425,425 objects and is latency-bound; deriving its pool
    // from `--max-bytes` would have halved a walk for memory nobody spends.
    const plan = deriveDownloadConcurrency({
      requested: REQUESTED_DEFAULT,
      containerMi: 2048,
      maxBytes: ARCHIVE_AUDIT_HEAD_BYTES,
    });
    assert.equal(plan.concurrency, REQUESTED_DEFAULT);
    assertWorstCaseFits(plan);
  });
});

describe("deriveDownloadConcurrency — the edges are stated, not implied", () => {
  it("floors at 1 and REPORTS that a single object does not fit", () => {
    // Refusing to start would be worse: one-at-a-time is exactly how the five
    // oversized `stocks/` PDFs get repaired. But the caller must be told, or
    // an OOM kill reads as a task that vanished.
    const plan = deriveDownloadConcurrency({
      requested: 12,
      containerMi: 1024,
      maxBytes: 1024 * MIB,
    });
    assert.equal(plan.concurrency, 1);
    assert.equal(plan.fitsWorstCase, false);
    assert.match(plan.why, /DOES NOT FIT/);
  });

  it("a container smaller than the reserve still yields a usable pool of 1", () => {
    const plan = deriveDownloadConcurrency({
      requested: 12,
      containerMi: 128,
      maxBytes: MAX_BYTES_DEFAULT,
    });
    assert.equal(plan.concurrency, 1);
    assert.equal(plan.budgetBytes, 0);
    assert.equal(plan.fitsWorstCase, false);
  });

  it("a nonsense request degrades to 1 rather than to 0 or NaN", () => {
    // `Number("--concurrency=abc")` is NaN and `Math.min(NaN, n)` is NaN;
    // `Array.from({length: NaN})` is EMPTY, so the walk would silently do
    // nothing and report scanned=0 — which the job treats as an auth failure.
    for (const bad of [Number.NaN, 0, -5]) {
      const plan = deriveDownloadConcurrency({
        requested: bad,
        containerMi: 2048,
        maxBytes: MAX_BYTES_DEFAULT,
      });
      assert.equal(plan.concurrency, 1, String(bad));
    }
  });

  it("per-slot cost is the ceiling times the live-buffer count, not the ceiling", () => {
    // The old comment said two buffers; the code says three and says why
    // (download concat, the retained object a subarray view keeps alive, the
    // upload chunk). Whatever the number, the plan must expose it — a hidden
    // multiplier is the prose this replaces.
    const plan = deriveDownloadConcurrency({
      requested: 12,
      containerMi: 2048,
      maxBytes: MAX_BYTES_DEFAULT,
    });
    assert.equal(plan.perSlotBytes, MAX_BYTES_DEFAULT * LIVE_BUFFERS_PER_SLOT);
    assert.ok(LIVE_BUFFERS_PER_SLOT >= 2);
  });
});

describe("parseContainerMi — set-but-unreadable FAILS, absent does not", () => {
  it("reads the bare-MiB form an ops script writes", () => {
    assert.equal(parseContainerMi("2048"), 2048);
    assert.equal(parseContainerMi(" 4096 "), 4096);
  });

  it("reads the Cloud Run sizes a human types", () => {
    assert.equal(parseContainerMi("2Gi"), 2048);
    assert.equal(parseContainerMi("512Mi"), 512);
    assert.equal(parseContainerMi("8Gi"), 8192);
  });

  it("THROWS on a size that is one character wrong", () => {
    // The failure this exists for. `2G` is what someone types when they mean
    // `2Gi`, and it is indistinguishable from a correct setting in a job spec.
    for (const bad of ["2G", "2gb", "2 Gi", "two", "-1", "2.5Gi", "Gi"]) {
      assert.throws(
        () => parseContainerMi(bad),
        /not a size/,
        `expected "${bad}" to be refused`,
      );
    }
  });

  it("THROWS on a readable size that is not positive", () => {
    assert.throws(() => parseContainerMi("0"), /must be positive/);
    assert.throws(() => parseContainerMi("0Gi"), /must be positive/);
  });

  it("returns undefined — NOT a default — when nothing was declared", () => {
    // Absent and set-but-wrong must stay distinguishable at this layer. The
    // CALLER decides what absence means and logs which branch it took; folding
    // the default in here would make the two states one value again.
    assert.equal(parseContainerMi(undefined), undefined);
    assert.equal(parseContainerMi(""), undefined);
    assert.equal(parseContainerMi("   "), undefined);
  });

  it("the assumed default is the size the ops script actually deploys", () => {
    // `setup-feed-backfill-job.sh` ships --repair-memory=2Gi. If that moves and
    // this does not, an un-reprovisioned job budgets for the wrong container.
    assert.equal(DEFAULT_CONTAINER_MI, 2048);
    assert.equal(parseContainerMi("2Gi"), DEFAULT_CONTAINER_MI);
  });
});
