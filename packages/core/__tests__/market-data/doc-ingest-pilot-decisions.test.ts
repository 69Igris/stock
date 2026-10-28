/**
 * The MONEY-1314 pilot's two pure decisions — measured 2026-09-02.
 *
 * ## What went wrong, so the assertions below have a subject
 *
 * `batch-build --pilot-from-parsed=25 --apply` selected 25 documents, wrote
 * ZERO batch lines, tallied `{"noSidecar":25}` and **exited 0**.
 *
 * The selector drew its candidates from `document_financial_extracts` where
 * `status: "EXTRACTED"` — which proves the OLD parse lane read the document —
 * and never checked whether the document carried the markdown SIDECAR the BATCH
 * lane reads. On prod those two populations barely overlap: of 1,404 PARSED
 * documents only **202** are CONVERTED, and **1,201** have `convertStatus`
 * ABSENT. So the pilot drew 25 from the wrong 1,201 every time.
 *
 * ## Why the region is LIFTED and executed rather than asserted about
 *
 * Same mechanism and same reasoning as `tiingo-script-decisions.test.ts`:
 * `doc-ingest-backfill.ts` has a top-level `main()` and a module-scope
 * `@usemoney/database` import, so importing it would RUN it. The decisions are
 * pure and marker-delimited, so the region is read out of the shipping file,
 * written to a temp ESM module and imported. Mutate the region in the script
 * and these tests fail — which is exactly what a source-text assertion cannot
 * promise, and this repo has shipped assertions that passed against broken
 * source often enough to insist on the difference.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = "scripts/jobs/doc-ingest-backfill.ts";

// Resolved from THIS FILE, never from `process.cwd()`. The suite runs under
// `packages/core` via turbo and from the repo root when invoked directly, and a
// cwd-relative path silently reads a different tree in one of those two — which
// on a first run presents as ENOENT and on a later one could present as a
// region lifted out of the wrong copy of the script.
const REPO_ROOT = join(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
  "..",
);
const RAW = readFileSync(join(REPO_ROOT, SCRIPT), "utf8");

/** Lift a `/* marker:begin … *\/ … /* marker:end *\/` region, verbatim. */
function markedRegion(src: string, marker: string, file: string): string {
  const begin = src.indexOf(`${marker}:begin`);
  const end = src.indexOf(`/* ${marker}:end */`);
  if (begin < 0 || end < 0 || end <= begin) {
    throw new Error(
      `${file} is missing the ${marker} markers — the pure decision region ` +
        "must stay marked so this suite can EXECUTE it rather than assert " +
        "about its text",
    );
  }
  const afterComment = src.indexOf("*/", begin);
  if (afterComment < 0 || afterComment > end) {
    throw new Error(`${marker}:begin in ${file} is not inside a block comment`);
  }
  return src.slice(afterComment + 2, end);
}

const tempDir = mkdtempSync(join(tmpdir(), "doc-ingest-pilot-"));
after(() => rmSync(tempDir, { recursive: true, force: true }));

const REGION = markedRegion(RAW, "pilot-decisions", SCRIPT);
const CHAIN_REGION = markedRegion(RAW, "chain-decision", SCRIPT);

type PilotModule = {
  PILOT_REQUIRED_CONVERT_STATUS: string;
  PILOT_DEFAULT_MAX_PER_SYMBOL: number;
  buildPilotSidecarWhere: (
    ids: readonly string[],
    docTypes?: readonly string[],
  ) => Record<string, unknown>;
  pickRoundRobin: (
    rows: ReadonlyArray<{ id: string; symbol: string }>,
    n: number,
    maxPerSymbol: number,
  ) => string[];
  DEFAULT_MAX_BATCH_LINES: number;
  DEFAULT_MAX_BATCH_BYTES: number;
  splitBatchLines: (
    lines: readonly string[],
    opts: { maxLines: number; maxBytes: number },
  ) => string[][];
  batchChunkPath: (out: string, index: number, total: number) => string;
  pilotBuiltNothing: (o: {
    pilot: boolean;
    selected: number;
    linesBuilt: number;
  }) => boolean;
};

const modPath = join(tempDir, "pilot-decisions.mts");
writeFileSync(modPath, `${REGION}\n`, "utf8");
const mod = (await import(pathToFileURL(modPath).href)) as PilotModule;

type ChainModule = {
  SCAN_CONVERT_MAX_CHAIN_DEPTH: number;
  shouldChainScanConvert: (o: {
    depth: number;
    converted: number;
    remaining: number;
    stop: string;
    apply: boolean;
    taskCount: number;
  }) => { chain: boolean; reason: string };
  DEFAULT_CONCURRENCY: number;
  MAX_CONCURRENCY: number;
  resolveShard: (
    raw: string | undefined,
    env: Record<string, string | undefined>,
    errors: string[],
  ) => { index: number; count: number } | null;
  runPool: <T>(
    items: readonly T[],
    limit: number,
    shouldStop: () => boolean,
    worker: (item: T) => Promise<void>,
  ) => Promise<{ started: number; stoppedEarly: boolean }>;
};
const chainPath = join(tempDir, "chain-decision.mts");
writeFileSync(chainPath, `${CHAIN_REGION}\n`, "utf8");
const chainMod = (await import(pathToFileURL(chainPath).href)) as ChainModule;

describe("MONEY-1314 pilot — the sidecar gate on candidate selection", () => {
  it("REQUIRES a converted sidecar, not merely an EXTRACTED row", () => {
    const where = mod.buildPilotSidecarWhere(["a", "b"]);
    // The whole defect: without this key the query returns PARSED documents
    // that have no markdown to build a batch line from. 1,201 of 1,404 on prod.
    assert.equal(
      where.convertStatus,
      "CONVERTED",
      "buildPilotSidecarWhere no longer constrains convertStatus — the pilot " +
        "would again select documents with no sidecar and build zero lines",
    );
  });

  it("constrains to the candidate ids it was given", () => {
    const where = mod.buildPilotSidecarWhere(["x", "y", "z"]);
    assert.deepEqual(where.id, { in: ["x", "y", "z"] });
  });

  it("uses an EQUALITY, never a negation — absent must be excluded", () => {
    // On Mongo an absent attribute matches NEITHER `{f:v}` nor `{f:{not:v}}`.
    // Equality drops absent rows, which is what this gate wants; a negation
    // reads wider, is not, and is the MONEY-1050/1205/1234/1236 shape.
    const v = mod.buildPilotSidecarWhere(["a"]).convertStatus;
    assert.equal(
      typeof v,
      "string",
      "convertStatus became an operator object — a `not`/`notIn` form here " +
        "silently excludes absent rows while reading as though it includes them",
    );
  });

  it("copies the id list rather than aliasing the caller's array", () => {
    const ids = ["a"];
    const where = mod.buildPilotSidecarWhere(ids);
    ids.push("mutated-after-the-call");
    assert.deepEqual((where.id as { in: string[] }).in, ["a"]);
  });
});

describe("MONEY-1314 pilot — a pilot that built nothing must not exit 0", () => {
  it("FAILS when a pilot selected documents and produced no lines", () => {
    // The exact 2026-09-02 run: selected 25, lines 0, exit 0.
    assert.equal(
      mod.pilotBuiltNothing({ pilot: true, selected: 25, linesBuilt: 0 }),
      true,
    );
  });

  it("passes when a pilot actually built lines", () => {
    assert.equal(
      mod.pilotBuiltNothing({ pilot: true, selected: 25, linesBuilt: 25 }),
      false,
    );
  });

  it("FAILS when a pilot selected nothing at all", () => {
    // This test previously asserted `false` here, pinning a hole as intended
    // behaviour: the MONEY-1332 selector repair moved the real failure into the
    // selected === 0 branch, so the run that motivated the guard still exited 0.
    // WHICH failure occurred is the warning's job — the caller distinguishes
    // "no EXTRACTED rows at all" from "EXTRACTED rows exist, none converted" —
    // but neither is a pilot that proved anything.
    assert.equal(
      mod.pilotBuiltNothing({ pilot: true, selected: 0, linesBuilt: 0 }),
      true,
      "a pilot that selected nothing built nothing, so it proved nothing",
    );
  });

  it("NEVER fails an ordinary (non-pilot) run that built nothing", () => {
    // A page of genuinely unconvertible documents is legitimate. Failing it
    // would cry wolf during a real drain, which is why the guard is scoped.
    assert.equal(
      mod.pilotBuiltNothing({ pilot: false, selected: 500, linesBuilt: 0 }),
      false,
    );
  });
});

/**
 * SELF-CONTINUATION — MONEY-1334.
 *
 * The conversion drain STALLED on 2026-09-02 and went unnoticed for a day: it
 * has no Cloud Scheduler entry, so it moved only while a hand-driven loop was
 * alive, and 44,028 PDFs stopped draining with no error, no alert and no metric.
 *
 * The bound is the interesting half. `backfill-bse-results.ts` chains across a
 * FIXED shard array, so its length IS the proof; this drains an open queue the
 * weekly sync keeps adding to, so "chain while work remains" never terminates.
 */
describe("MONEY-1334 — the drain continues itself, and provably stops", () => {
  const ok = {
    depth: 0,
    converted: 500,
    remaining: 40_000,
    stop: "budget",
    apply: true,
    // ONE task = unsharded, which is the shape every assertion below was
    // written against. A sharded run refuses to chain for its own reason and
    // is covered in the MONEY-1339 suite.
    taskCount: 1,
  };

  it("chains when the wall clock stopped a run with work left", () => {
    assert.equal(chainMod.shouldChainScanConvert(ok).chain, true);
  });

  it("STOPS at the depth ceiling whatever the queue says", () => {
    // The structural proof: it consults no database, clock or queue, so a
    // chain is at most MAX links however the data behaves.
    const last = chainMod.SCAN_CONVERT_MAX_CHAIN_DEPTH - 1;
    const r = chainMod.shouldChainScanConvert({ ...ok, depth: last });
    assert.equal(r.chain, false);
    assert.equal(r.reason, "max-depth");
    assert.equal(
      chainMod.shouldChainScanConvert({ ...ok, depth: last - 1 }).chain,
      true,
      "the ceiling must bind at MAX, not one link early",
    );
  });

  it("refuses to chain a run that converted NOTHING", () => {
    // Without this a permanently-failing head — a corrupt object, an expired
    // credential — re-triggers itself to the ceiling, converting nothing and
    // paying for every container start to do it.
    const r = chainMod.shouldChainScanConvert({ ...ok, converted: 0 });
    assert.equal(r.chain, false);
    assert.equal(r.reason, "no-progress");
  });

  it("does not chain when the queue is drained", () => {
    assert.equal(
      chainMod.shouldChainScanConvert({ ...ok, remaining: 0 }).chain,
      false,
    );
  });

  it("chains ONLY on the wall clock, never on operator intent", () => {
    // drained = finished. failed = would re-run into the same failure.
    // dry-run / limit / max-batches = a person asked for a bounded piece of
    // work, and a chain silently exceeds what they asked for.
    for (const stop of [
      "drained",
      "failed",
      "dry-run",
      "limit",
      "max-batches",
    ]) {
      assert.equal(
        chainMod.shouldChainScanConvert({ ...ok, stop }).chain,
        false,
        `stop=${stop} must not chain`,
      );
    }
  });

  it("a DRY RUN never starts a real one", () => {
    // The one mode whose entire contract is that nothing happens.
    const r = chainMod.shouldChainScanConvert({ ...ok, apply: false });
    assert.equal(r.chain, false);
    assert.equal(r.reason, "dry-run");
  });
});

describe("MONEY-1339 — a sharded run must not chain", () => {
  const budgetExhausted = {
    depth: 0,
    converted: 500,
    remaining: 40_000,
    stop: "budget",
    apply: true,
  };

  it("chains at one task", () => {
    const r = chainMod.shouldChainScanConvert({
      ...budgetExhausted,
      taskCount: 1,
    });
    assert.equal(r.chain, true);
  });

  it("REFUSES to chain at four tasks, and says why", () => {
    // `triggerNextScanConvert` posts one `jobs:run` with a container override,
    // and an override carries no task index — so the follow-up runs the FULL
    // fan-out again. Four tasks each chaining once is four executions of four
    // tasks; at depth 20 that is exponential against a metered budget.
    const r = chainMod.shouldChainScanConvert({
      ...budgetExhausted,
      taskCount: 4,
    });
    assert.equal(
      r.chain,
      false,
      "a sharded run chained — each task would re-trigger the whole fan-out",
    );
    assert.match(r.reason, /sharded/);
  });

  it("reports SHARDED rather than budget-exhausted, so the log cannot recommend the thing it refuses", () => {
    const r = chainMod.shouldChainScanConvert({
      ...budgetExhausted,
      taskCount: 8,
    });
    assert.match(r.reason, /8 tasks/);
  });

  it("still refuses a dry run before it considers sharding at all", () => {
    const r = chainMod.shouldChainScanConvert({
      ...budgetExhausted,
      apply: false,
      taskCount: 4,
    });
    assert.equal(r.reason, "dry-run");
  });
});

describe("MONEY-1339 — resolveShard", () => {
  it("reads Cloud Run's own task variables when no flag is given", () => {
    const errors: string[] = [];
    const shard = chainMod.resolveShard(
      undefined,
      { CLOUD_RUN_TASK_INDEX: "2", CLOUD_RUN_TASK_COUNT: "4" },
      errors,
    );
    // This is the ONLY way a per-task shard can be expressed: `gcloud run jobs
    // execute` passes one argument list to every task, so a --shard flag could
    // never differ between them.
    assert.deepEqual(shard, { index: 2, count: 4 });
    assert.deepEqual(errors, []);
  });

  it("treats a single-task execution as UNSHARDED, not as shard 0 of 1", () => {
    const errors: string[] = [];
    const shard = chainMod.resolveShard(
      undefined,
      { CLOUD_RUN_TASK_INDEX: "0", CLOUD_RUN_TASK_COUNT: "1" },
      errors,
    );
    assert.equal(
      shard,
      null,
      "a one-task run resolved to a shard — it would then refuse to chain, " +
        "which is the whole self-continuation mechanism switched off by an " +
        "environment variable Cloud Run sets on every job",
    );
  });

  it("resolves to null outside Cloud Run, with no error", () => {
    const errors: string[] = [];
    assert.equal(chainMod.resolveShard(undefined, {}, errors), null);
    assert.deepEqual(errors, [], "a local run reported a shard argument error");
  });

  it("lets an explicit flag override the environment", () => {
    const errors: string[] = [];
    const shard = chainMod.resolveShard(
      "1/3",
      { CLOUD_RUN_TASK_INDEX: "2", CLOUD_RUN_TASK_COUNT: "4" },
      errors,
    );
    assert.deepEqual(shard, { index: 1, count: 3 });
  });

  it("REFUSES an out-of-range index rather than clamping it", () => {
    // A clamp would hand two tasks the same slice and leave another slice
    // unconverted — and both tasks would report a drained queue.
    const errors: string[] = [];
    assert.equal(chainMod.resolveShard("4/4", {}, errors), null);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /out of range/);
  });

  it("refuses a malformed flag but stays silent about malformed env", () => {
    const flagErrors: string[] = [];
    chainMod.resolveShard("nonsense", {}, flagErrors);
    assert.equal(flagErrors.length, 1, "a bad --shard value was accepted");

    const envErrors: string[] = [];
    chainMod.resolveShard(undefined, { CLOUD_RUN_TASK_COUNT: "x" }, envErrors);
    assert.deepEqual(
      envErrors,
      [],
      "a non-Cloud-Run environment produced an argument error, which would " +
        "make the job refuse to start anywhere the variables are unset",
    );
  });
});

describe("MONEY-1339 — runPool", () => {
  it("never exceeds its slot count", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 25 }, (_, i) => i);
    await chainMod.runPool(
      items,
      4,
      () => false,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
      },
    );
    assert.equal(peak, 4, `pool ran ${peak} documents at once, limit was 4`);
  });

  it("processes every item exactly once", async () => {
    const items = Array.from({ length: 37 }, (_, i) => i);
    const seen: number[] = [];
    const out = await chainMod.runPool(
      items,
      5,
      () => false,
      async (n) => {
        seen.push(n);
      },
    );
    assert.equal(out.started, 37);
    assert.equal(out.stoppedEarly, false);
    assert.deepEqual(
      [...seen].sort((a, b) => a - b),
      items,
    );
  });

  it("stops claiming new work when the budget expires, and finishes what is in flight", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    let done = 0;
    let stop = false;
    const out = await chainMod.runPool(
      items,
      3,
      () => stop,
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        done += 1;
        if (done >= 6) stop = true;
      },
    );
    assert.equal(out.stoppedEarly, true);
    assert.ok(
      out.started < 100,
      "the pool drained the whole page after the budget expired",
    );
    // Everything CLAIMED was finished. An abandoned document would have paid
    // its download and parse and stamped nothing.
    assert.equal(done, out.started);
  });

  it("runs serially at a limit of one", async () => {
    let inFlight = 0;
    let peak = 0;
    await chainMod.runPool(
      [1, 2, 3, 4],
      1,
      () => false,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
      },
    );
    assert.equal(peak, 1);
  });
});

describe("MONEY-1344 — a pilot must sample SYMBOLS, not the head of a key space", () => {
  // The 2026-09-02 pilot drew 25 documents from SIX companies. BONLON alone
  // contributed 5 of the 10 scanned-statement failures and GOYALALUM 3, so the
  // headline rates described a handful of small-cap filers — and this is the
  // gate that decides whether to spend a four-figure drain.
  const rows = (spec: Array<[string, number]>) =>
    spec.flatMap(([symbol, count]) =>
      Array.from({ length: count }, (_, i) => ({
        id: `${symbol}-${i}`,
        symbol,
      })),
    );

  it("spreads across every symbol before giving any symbol a second document", () => {
    const pool = rows([
      ["BONLON", 5],
      ["GOYALALUM", 5],
      ["HARDWYN", 5],
      ["AHLWEST", 5],
    ]);
    const picked = mod.pickRoundRobin(pool, 4, 2);
    assert.deepEqual(picked, [
      "BONLON-0",
      "GOYALALUM-0",
      "HARDWYN-0",
      "AHLWEST-0",
    ]);
  });

  it("reproduces the defect when the cap is lifted and the deal is not round-robin", () => {
    // The CONTROL for the case above: taking the first n from a pool ordered
    // by symbol returns 4 BONLON documents. That is what shipped.
    const pool = rows([
      ["BONLON", 5],
      ["GOYALALUM", 5],
    ]);
    const naive = pool.slice(0, 4).map((r) => r.id);
    assert.deepEqual(naive, ["BONLON-0", "BONLON-1", "BONLON-2", "BONLON-3"]);
    // …and the real picker does not.
    const picked = mod.pickRoundRobin(pool, 4, 2);
    assert.equal(new Set(picked.map((id) => id.split("-")[0])).size, 2);
  });

  it("never exceeds maxPerSymbol, even when only one symbol has documents", () => {
    const picked = mod.pickRoundRobin(rows([["BONLON", 40]]), 25, 2);
    assert.equal(
      picked.length,
      2,
      "one symbol filled a 25-document pilot — the exact 2026-09-02 shape",
    );
  });

  it("returns fewer than n rather than breaking the cap", () => {
    const picked = mod.pickRoundRobin(
      rows([
        ["A", 3],
        ["B", 3],
      ]),
      10,
      2,
    );
    assert.equal(picked.length, 4);
  });

  it("is deterministic — a re-run must be comparable with its predecessor", () => {
    const pool = rows([
      ["A", 3],
      ["B", 3],
      ["C", 3],
    ]);
    assert.deepEqual(
      mod.pickRoundRobin(pool, 5, 2),
      mod.pickRoundRobin(pool, 5, 2),
    );
  });

  it("preserves page order INSIDE a symbol", () => {
    const picked = mod.pickRoundRobin(rows([["A", 3]]), 3, 3);
    assert.deepEqual(picked, ["A-0", "A-1", "A-2"]);
  });

  it("takes nothing for a non-positive n or cap", () => {
    const pool = rows([["A", 3]]);
    assert.deepEqual(mod.pickRoundRobin(pool, 0, 2), []);
    assert.deepEqual(mod.pickRoundRobin(pool, 5, 0), []);
  });

  it("defaults to two documents per symbol", () => {
    assert.equal(mod.PILOT_DEFAULT_MAX_PER_SYMBOL, 2);
  });

  it("keeps the sidecar gate when a docType filter is added", () => {
    // The docType narrowing must NARROW. Losing the convertStatus term would
    // reinstate the original defect (documents with no markdown to read).
    const where = mod.buildPilotSidecarWhere(["a"], ["annual_report"]);
    assert.equal(where.convertStatus, "CONVERTED");
    assert.deepEqual(where.docType, { in: ["annual_report"] });
  });

  it("omits the docType term entirely when none is asked for", () => {
    // An empty `in` list matches NOTHING on Mongo, so an always-present term
    // would make an unfiltered pilot select zero documents.
    const where = mod.buildPilotSidecarWhere(["a"]);
    assert.equal(where.docType, undefined);
    assert.equal(mod.buildPilotSidecarWhere(["a"], []).docType, undefined);
  });
});

describe("MONEY-1345 — a 50,800-document drain is waves, not one file", () => {
  const line = (n: number) => "x".repeat(n);

  it("splits on the LINE ceiling", () => {
    const chunks = mod.splitBatchLines(
      Array.from({ length: 25 }, () => line(10)),
      { maxLines: 10, maxBytes: 1_000_000 },
    );
    assert.deepEqual(
      chunks.map((c) => c.length),
      [10, 10, 5],
    );
  });

  it("splits on the BYTE ceiling", () => {
    const chunks = mod.splitBatchLines([line(9), line(9), line(9)], {
      maxLines: 1000,
      maxBytes: 20,
    });
    assert.deepEqual(
      chunks.map((c) => c.length),
      [2, 1],
    );
  });

  it("counts the NEWLINE each line will carry in the file", () => {
    // Sized at the exact boundary where the newline decides, or the assertion
    // holds for a splitter that ignores it: three 9-byte lines are 27 bytes of
    // payload and 30 bytes of FILE. At a 29-byte ceiling the first spelling
    // fits all three and the second does not.
    //
    // A 20,000-line file understated by one byte per line is 20 KB over the
    // ceiling — a small systematic undercount that surfaces only at the limit,
    // on the largest wave, after the upload is paid for.
    const chunks = mod.splitBatchLines([line(9), line(9), line(9)], {
      maxLines: 1000,
      maxBytes: 29,
    });
    assert.deepEqual(
      chunks.map((c) => c.length),
      [2, 1],
      "three 9-byte lines fitted a 29-byte file — the newlines were not counted",
    );
    // …and the byte total the caller will actually write.
    assert.equal(Buffer.byteLength(`${chunks[0]?.join("\n")}\n`, "utf-8"), 20);
  });

  it("loses nothing and reorders nothing", () => {
    const lines = Array.from({ length: 47 }, (_, i) => `line-${i}`);
    const flat = mod
      .splitBatchLines(lines, { maxLines: 7, maxBytes: 1_000_000 })
      .flat();
    assert.deepEqual(flat, lines);
  });

  it("gives an oversized single line its OWN file rather than dropping it", () => {
    // Half a request is a paid call that cannot be attributed to a document.
    // The submission fails loudly on that one line instead of the drain
    // silently losing it.
    const chunks = mod.splitBatchLines([line(5), line(500), line(5)], {
      maxLines: 100,
      maxBytes: 50,
    });
    assert.equal(chunks.length, 3);
    assert.equal(chunks[1]?.length, 1);
    assert.equal(chunks.flat().length, 3);
  });

  it("returns no files for no lines", () => {
    assert.deepEqual(
      mod.splitBatchLines([], { maxLines: 10, maxBytes: 10 }),
      [],
    );
  });

  it("keeps the caller's filename when there is only one file", () => {
    // A single-file run must be byte-identical to the old behaviour, or every
    // existing runbook command changes meaning.
    assert.equal(
      mod.batchChunkPath("/tmp/pilot.jsonl", 0, 1),
      "/tmp/pilot.jsonl",
    );
  });

  it("numbers the files zero-padded, preserving the extension", () => {
    assert.equal(mod.batchChunkPath("/tmp/x.jsonl", 0, 3), "/tmp/x-000.jsonl");
    assert.equal(
      mod.batchChunkPath("/tmp/x.jsonl", 12, 30),
      "/tmp/x-012.jsonl",
    );
  });

  it("does not mistake a dot in a DIRECTORY for the extension", () => {
    assert.equal(
      mod.batchChunkPath("/tmp/v1.2/out", 1, 2),
      "/tmp/v1.2/out-001",
    );
  });

  it("ships ceilings that must be re-read from the vendor before the tail waves", () => {
    assert.equal(mod.DEFAULT_MAX_BATCH_LINES, 20_000);
    assert.equal(mod.DEFAULT_MAX_BATCH_BYTES, 900 * 1024 * 1024);
  });
});
