/**
 * `sync-prod-to-qa.sh` must report FAILURE when it fails — MONEY-1238.
 *
 * ## The defect
 *
 * `scripts/ops/sync-job/Dockerfile` sets `ENTRYPOINT ["/app/sync-prod-to-qa.sh"]`,
 * so this script's exit status IS the status Cloud Run reports for
 * `sync-prod-to-qa-daily`. The script accumulated `FAILED+=(…)` per collection,
 * printed a yellow "finished with N failure(s)" line, and then — with no `exit`
 * anywhere after the restore loop — fell off the end of the file and exited 0.
 * The job was green while QA was missing reference collections. Worse, the
 * post-restore re-link was gated on `[ ${#FAILED[@]} -eq 0 ]`, so exactly when a
 * partial restore had left rows pointing at PROD ObjectIds, the repair that
 * fixes them was skipped.
 *
 * ## Why this file runs the script instead of reading it
 *
 * The assertion that was there before read `assert.match(block, /FAILED\+=/)` —
 * it proved a STRING existed, not that any decision changed, and it was green
 * against a script that exited 0 no matter what. An exit code is only knowable
 * by exiting, so this harness puts stub `gcloud` / `mongosh` / `mongodump` /
 * `mongorestore` on PATH, runs the real script, and asserts on the real status.
 *
 * Nothing here touches a database or a network: the stubs are four bash scripts
 * in a temp directory, `spawnSync` is synchronous (so no test can orphan a
 * process), and the run is `--collections-only` so the GCS half never executes.
 *
 * ## Why the `.spawntest.ts` suffix (MONEY-1316)
 *
 * Running the real script means a process launch per case. Measured standalone
 * at 6.7 s, and the multiplier observed under full parallel turbo load is ~2.5x
 * — close enough to the workspace's 30 s FILE-level `--test-timeout` that a
 * green run would stop being evidence the file ran, since a timed-out file is
 * CANCELLED and reports `not ok` with `# fail` still 0. The suffix routes it
 * into the second `node --test` lane at `--test-timeout=180000`. The suffix is
 * the only wiring; `ops/spawntest-lane-wiring.test.ts` pins that the lane exists
 * and reaches every file carrying it.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  planSyncOrder,
  type QaSyncRecord,
} from "../../src/ops/qa-sync-outcomes";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SCRIPT = join(ROOT, "scripts", "ops", "sync-prod-to-qa.sh");

const STUBS = mkdtempSync(join(tmpdir(), "sync-exit-stubs-"));
after(() => rmSync(STUBS, { recursive: true, force: true }));

function stub(name: string, body: string): void {
  const p = join(STUBS, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
}

// Secret Manager: one distinct URL per secret name, so the script's
// "both secrets resolve to one database" guard is satisfied — unless the test
// deliberately asks for the collision via STUB_SAME_URL.
stub(
  "gcloud",
  `
if [ "$1" = "secrets" ]; then
  if [ -n "\${STUB_SAME_URL:-}" ]; then
    echo "mongodb+srv://u:p@same.example.net/db"; exit 0
  fi
  for a in "$@"; do
    case "$a" in --secret=*) echo "mongodb+srv://u:p@fake.example.net/\${a#--secret=}"; exit 0;; esac
  done
  exit 1
fi
exit 0`,
);

/** What the PROD spec read answers: prod's real unique key on `candles`. */
const UNIQUE_SPEC =
  '[{"v":2,"key":{"symbol":1,"exchange":1,"timeframe":1,"ts":1},' +
  '"name":"candles_symbol_exchange_timeframe_ts_key","unique":true}]';

// mongosh now has SEVEN callers and they are told apart by the ENV the script
// passes, not by parsing the JS out of argv:
//
//   --file            the post-restore re-link + index check
//   SO_STATE          one collection's outcome row      (MONEY-1488)
//   SO_STALE_DAYS     the --status report               (MONEY-1488)
//   SO_NAMES          the ordering FACTS query          (MONEY-1487)
//   UF_COLL           PROD: read the unique index specs (MONEY-1519)
//   UF_COLL+UF_SPECS  QA: drop + create with those specs (MONEY-1519)
//   (neither)         the empty-guard / sample count
//
// The spec the PROD read prints is the spec the QA call must receive — the
// UNIQUE_FIRST log line records what arrived, so the join is asserted, not
// assumed.
//
// The ordering stub emits FACTS ONLY — `<lastAttemptMs> <manifestIndex> <name>`
// — and never an order. That is the point of the cross-check below: the ORDER
// has to be produced by the script's own `sort`, so a test comparing it against
// `planSyncOrder` is comparing two implementations rather than reading one back.
stub(
  "mongosh",
  `
for a in "$@"; do
  if [ "$a" = "--file" ]; then
    echo "RELINK_RAN tables=\${RELINK_TABLES} index=\${SYNC_INDEX_TABLES}" >> "$STUB_LOG"
    exit "\${STUB_RELINK_EXIT:-0}"
  fi
done
if [ -n "\${SO_STATE:-}" ]; then
  echo "OUTCOME \${SO_ID} \${SO_STATE} rows=\${SO_ROWS}" >> "$STUB_LOG"
  exit "\${STUB_OUTCOME_EXIT:-0}"
fi
if [ -n "\${SO_STALE_DAYS:-}" ]; then
  echo "STATUS_RAN stale=\${SO_STALE_DAYS}" >> "$STUB_LOG"
  if [ -n "\${STUB_STATUS_FAIL:-}" ]; then exit 1; fi
  echo "COLLECTION                   FRESHNESS  STATE                AGE      LAST SUCCESS"
  echo "SUMMARY stub"
  exit 0
fi
if [ -n "\${SO_NAMES:-}" ]; then
  echo "ORDER_QUERY" >> "$STUB_LOG"
  if [ -n "\${STUB_ORDER_FAIL:-}" ]; then exit 1; fi
  if [ -n "\${STUB_ORDER_TRUNCATE:-}" ]; then echo "0 0 \${STUB_ORDER_TRUNCATE}"; exit 0; fi
  # ONE awk, not a shell loop with a sed per collection. That loop was four
  # processes x 54 collections per run, which took this suite from 12 s to over
  # its 180 s file wall — a stub is not allowed to be the expensive part.
  awk -v names="\$SO_NAMES" -v facts="\${STUB_ORDER_FACTS:-}" 'BEGIN {
    n = split(facts, f, ",");
    for (i = 1; i <= n; i++) { p = index(f[i], ":"); if (p > 0) m[substr(f[i], 1, p - 1)] = substr(f[i], p + 1); }
    k = split(names, a, " ");
    for (i = 1; i <= k; i++) { v = (a[i] in m) ? m[a[i]] : 0; print v, i - 1, a[i]; }
  }'
  exit 0
fi
if [ -n "\${UF_COLL:-}" ]; then
  if [ -n "\${UF_SPECS+set}" ]; then
    echo "UNIQUE_FIRST \${UF_COLL} specs=\${UF_SPECS}" >> "$STUB_LOG"
    exit "\${STUB_UF_PREP_EXIT:-0}"
  fi
  echo "UNIQUE_SPECS_READ \${UF_COLL}" >> "$STUB_LOG"
  if [ -n "\${STUB_UF_READ_FAIL:-}" ]; then exit 1; fi
  echo '${UNIQUE_SPEC}'
  exit 0
fi
echo "\${STUB_COUNT:-7}"`,
);

stub(
  "mongodump",
  `
coll=""
for a in "$@"; do case "$a" in --collection=*) coll="\${a#--collection=}";; esac; done
echo "DUMP $coll" >> "$STUB_LOG"
if [ -n "\${STUB_FAIL_COLLECTION:-}" ] && [ "$coll" = "\${STUB_FAIL_COLLECTION}" ]; then exit 1; fi
echo "archive:$coll"`,
);

// Records the collection (recovered from the archive payload) AND its argv, so
// a test can see whether `--drop` was passed. STUB_INDEX_FAIL_COLLECTION makes
// it fail the way mongorestore 100.9.5 really does when the rows landed and
// the index build did not — that stderr line is copied from the 2026-09-22
// production run, not invented.
stub(
  "mongorestore",
  `
payload=$(cat)
coll="\${payload#archive:}"
echo "RESTORE $coll args=$*" >> "$STUB_LOG"
if [ -n "\${STUB_INDEX_FAIL_COLLECTION:-}" ] && [ "$coll" = "\${STUB_INDEX_FAIL_COLLECTION}" ]; then
  echo "2026-09-22T20:29:39.342+0000	Failed: tradebook.$coll: error creating indexes for tradebook.$coll: createIndex error: (DuplicateKey) Index build failed: E11000 duplicate key error collection: tradebook.$coll" >&2
  exit 1
fi
exit 0`,
);

type Run = { status: number; out: string; log: string };

/** The manifest the script actually iterates, read out of the script itself. */
function referenceCollections(): string[] {
  const src = readFileSync(SCRIPT, "utf8");
  const block = /^REFERENCE_COLLECTIONS=\(([\s\S]*?)^\)/m.exec(src);
  assert.ok(block, "REFERENCE_COLLECTIONS is gone from sync-prod-to-qa.sh");
  const names = [...block[1]!.matchAll(/^\s+"([a-z0-9_]+)"/gm)].map(
    (m) => m[1]!,
  );
  // A silent empty set would make every ordering assertion below vacuous.
  assert.ok(names.length >= 50, `only ${names.length} collections parsed`);
  return names;
}

function runSync(env: Record<string, string> = {}, args?: string[]): Run {
  const logFile = join(STUBS, `log-${Math.random().toString(36).slice(2)}`);
  writeFileSync(logFile, "");
  const r = spawnSync(
    "bash",
    [SCRIPT, ...(args ?? ["--yes", "--collections-only"])],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${STUBS}:${process.env.PATH ?? ""}`,
        STUB_LOG: logFile,
        ...env,
      },
    },
  );
  assert.equal(r.signal, null, `the script was killed by ${r.signal}`);
  return {
    status: r.status ?? -1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    log: readFileSync(logFile, "utf8"),
  };
}

describe("sync-prod-to-qa exit code is the Cloud Run job's status", () => {
  it("exits 0 and says Complete when every collection copies", () => {
    const r = runSync();
    assert.equal(r.status, 0, r.out.slice(-1500));
    assert.match(r.out, /Reference-Data Sync Complete!/);
    assert.match(r.log, /RELINK_RAN/);
  });

  it("exits 1 when a collection fails to copy", () => {
    // THE defect. Before MONEY-1238 this exited 0 and printed the green
    // "Complete!" banner over a QA that was missing the collection.
    const r = runSync({ STUB_FAIL_COLLECTION: "stock_news" });
    assert.equal(r.status, 1, r.out.slice(-1500));
    assert.match(r.out, /Reference-Data Sync FAILED/);
    assert.match(r.out, /1 step\(s\) failed: stock_news/);
    assert.doesNotMatch(r.out, /Reference-Data Sync Complete!/);
  });

  it("still RE-LINKS when an unrelated collection failed", () => {
    // The ungating, proven by behaviour. The old gate was
    // `if [ ${#FAILED[@]} -eq 0 ]`, so this exact scenario — one unrelated
    // collection failing — skipped the repair for the five required-relation
    // collections that HAD just been replaced with prod's rows, leaving QA's
    // screener throwing. A partial restore needs the re-link more than a clean
    // one does; bailing out early is the one option that guarantees breakage.
    const r = runSync({ STUB_FAIL_COLLECTION: "stock_news" });
    assert.match(
      r.log,
      /RELINK_RAN/,
      "the re-link was skipped because an unrelated collection failed",
    );
    for (const t of [
      "stock_documents",
      "stock_financials",
      "stock_peers",
      "stock_ratios",
      "stock_shareholding",
    ]) {
      assert.match(r.log, new RegExp(`RELINK_RAN[^\\n]*\\b${t}\\b`));
    }
  });

  it("still RE-LINKS when one of the required-relation collections itself failed", () => {
    // The other four were restored and are orphaned right now; repairing them
    // is not optional because one of their siblings timed out.
    const r = runSync({ STUB_FAIL_COLLECTION: "stock_ratios" });
    assert.equal(r.status, 1);
    assert.match(r.log, /RELINK_RAN/);
  });

  it("exits 1 when the re-link itself fails", () => {
    // The re-link is part of the restore, not cleanup after it: with a dangling
    // REQUIRED relation Prisma THROWS rather than returning null, so a run that
    // copies fresh rows and cannot link them has left QA BROKEN, not stale.
    const r = runSync({ STUB_RELINK_EXIT: "1" });
    assert.equal(r.status, 1, r.out.slice(-1500));
    assert.match(r.out, /1 step\(s\) failed: relink/);
    assert.match(r.out, /RE-LINK FAILED/);
  });

  it("exits 1, distinctly, when the re-link runs but leaves orphans", () => {
    // Exit 2 from the re-link means it worked and rows STILL dangle — a
    // different action (this environment is missing instruments) from a re-link
    // that could not run. Collapsing the two loses the only signal saying which.
    const r = runSync({ STUB_RELINK_EXIT: "2" });
    assert.equal(r.status, 1, r.out.slice(-1500));
    assert.match(r.out, /1 step\(s\) failed: relink-orphans-remain/);
    assert.match(r.out, /RE-LINK INCOMPLETE/);
  });

  it("skips the re-link, and stays green, when prod is empty everywhere", () => {
    // The empty-guard skipped every collection, so nothing new carries prod's
    // ids. Running the repair anyway would be harmless but pointless; reporting
    // a failure would be wrong.
    const r = runSync({ STUB_COUNT: "0" });
    assert.equal(r.status, 0, r.out.slice(-1500));
    assert.doesNotMatch(r.log, /RELINK_RAN/);
    assert.match(r.out, /Re-link SKIPPED/);
    assert.match(r.out, /Reference-Data Sync Complete!/);
  });

  it("refuses to run at all when both secrets resolve to one database", () => {
    // The direction lock is structural, so the one way it fails is at the
    // secret — and this script drops the target before restoring it.
    const r = runSync({ STUB_SAME_URL: "1" });
    assert.equal(r.status, 1, r.out.slice(-1500));
    assert.match(r.out, /REFUSING TO RUN/);
    assert.doesNotMatch(r.log, /DUMP/, "it dropped/dumped before refusing");
  });

  it("leaves the feeds tier alone — no Mongo, no re-link, still exits 0", () => {
    // --tier=feeds touches no collection by construction, so none of the above
    // may start applying to it.
    const r = runSync({}, ["--yes", "--tier=feeds"]);
    assert.equal(r.status, 0, r.out.slice(-1500));
    assert.doesNotMatch(r.log, /DUMP/);
    assert.doesNotMatch(r.log, /RELINK_RAN/);
  });

  it("fails preflight when the re-link's runtime is missing", () => {
    // Loud at startup, BEFORE anything is dropped — the property MONEY-1238's
    // `npx` call did not have. Simulated by shadowing mongosh with a directory
    // that has everything else, which is what a slimmed-down image looks like.
    const partial = mkdtempSync(join(tmpdir(), "sync-exit-nomongosh-"));
    try {
      for (const f of ["gcloud", "mongodump", "mongorestore"]) {
        writeFileSync(join(partial, f), readFileSync(join(STUBS, f)));
        chmodSync(join(partial, f), 0o755);
      }
      const r = spawnSync("bash", [SCRIPT, "--yes", "--collections-only"], {
        encoding: "utf8",
        timeout: 60_000,
        // A PATH with no real bin dirs would break `mktemp`/`cat`; keep the
        // system ones and rely on mongosh not being installed there. If it IS
        // installed on this machine the check below would be vacuous, so the
        // test asserts on the message rather than merely on a non-zero status.
        env: {
          ...process.env,
          PATH: `${partial}:/usr/bin:/bin`,
          STUB_LOG: "/dev/null",
        },
      });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      if (
        spawnSync("bash", ["-c", "PATH=/usr/bin:/bin command -v mongosh"])
          .status === 0
      ) {
        return; // mongosh really is in /usr/bin here — nothing to simulate.
      }
      assert.equal(r.status, 1, out.slice(-1500));
      assert.match(out, /Missing required tool\(s\): mongosh/);
      assert.doesNotMatch(
        out,
        /drop \+ restore/,
        "it started restoring anyway",
      );
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// MONEY-1487 / MONEY-1488 — the ORDER and the FRESHNESS RECORD
// ────────────────────────────────────────────────────────────────────────────
//
// These live here because they need the same four stubs and the same real
// script, and because there is nowhere else the rule can be executed: the
// Cloud Run image has no Node, so the production implementation is mongosh and
// bash `sort`, and the pure TypeScript form in
// `packages/core/src/ops/qa-sync-outcomes.ts` cannot be imported by it.
//
// So the cross-check is behavioural. The stub supplies only the FACTS
// (`<lastAttemptMs> <manifestIndex> <name>`); the script's own `sort` produces
// the ORDER; the assertion compares that order against `planSyncOrder` fed the
// same facts. Both implementations run. A source scan asserting that the string
// `sort -k1,1n` exists would prove nothing about which order comes out — this
// repo has already shipped that mistake (`assert.match(block, /FAILED\+=/)`
// was green against a script that exited 0 no matter what).

/** Collections in the order `mongodump` was actually asked for them. */
function dumpOrder(log: string): string[] {
  return log
    .split("\n")
    .map((l) => /^DUMP (\S+)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]!);
}

/** `OUTCOME <collection> <state> rows=<n>` lines, in order. */
function outcomes(log: string): Array<{ collection: string; state: string }> {
  return log
    .split("\n")
    .map((l) => /^OUTCOME (\S+) (\S+) rows=/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ collection: m[1]!, state: m[2]! }));
}

const REF = referenceCollections();

describe("sync-prod-to-qa walks least-recently-visited first (MONEY-1487)", () => {
  it("with no record at all, it walks the manifest in manifest order", () => {
    // The first-ever run. Every collection sorts at 0 and the tie-break is
    // manifest position, so the behaviour is exactly what it was before this
    // change — which is the property that makes the rollout safe.
    const r = runSync();
    assert.equal(r.status, 0, r.out.slice(-1500));
    assert.deepEqual(dumpOrder(r.log), REF);
    assert.match(r.log, /ORDER_QUERY/, "the ordering query never ran");
  });

  it("the STARVED tail of the manifest is walked FIRST", () => {
    // THE defect, reproduced and then fixed. Give the first 20 collections a
    // recent visit and the remaining 34 none — which is the measured state on
    // 2026-09-18, when a run reached [20/54] and the 34 below the US block had
    // not synced since 2026-08-31. Every one of those 34 must now come first.
    const recent = REF.slice(0, 20);
    const starved = REF.slice(20);
    const facts = recent.map((c) => `${c}:${Date.now()}`).join(",");
    const r = runSync({ STUB_ORDER_FACTS: facts });
    assert.equal(r.status, 0, r.out.slice(-1500));
    const order = dumpOrder(r.log);
    assert.deepEqual(
      order.slice(0, starved.length),
      starved,
      "the never-visited collections did not come first",
    );
    assert.deepEqual([...order].sort(), [...REF].sort(), "not a permutation");
  });

  it("the order the SCRIPT produces equals the order planSyncOrder produces", () => {
    // The cross-check. Two independent implementations of one rule — bash
    // `sort` over mongosh facts, and the pure TypeScript function — given the
    // same input, compared. Ages are deliberately interleaved with the manifest
    // order so that a wrong sort key, a wrong direction, or a missing tie-break
    // each produce a different answer.
    const now = Date.now();
    const records: QaSyncRecord[] = REF.map((collection, i) => ({
      collection,
      lastState: "RESTORED" as const,
      // A deterministic zig-zag: every third collection is very old, the rest
      // recent, and two share an identical stamp so the tie-break is exercised.
      lastAttemptAtMs: i % 3 === 0 ? now - 40 * 86_400_000 : now - i * 1000,
      lastSuccessAtMs: now,
    }));
    const facts = records
      .map((rec) => `${rec.collection}:${rec.lastAttemptAtMs}`)
      .join(",");
    const r = runSync({ STUB_ORDER_FACTS: facts });
    assert.equal(r.status, 0, r.out.slice(-1500));
    assert.deepEqual(dumpOrder(r.log), planSyncOrder(REF, records));
  });

  it("falls back to manifest order, LOUDLY, when the ordering query fails", () => {
    // A hiccup in the BOOKKEEPING must never cancel the DATA COPY — and it must
    // never be silent either, because a run that does not rotate leaves the
    // tail as the tail and looks identical to one that did.
    const r = runSync({ STUB_ORDER_FAIL: "1" });
    assert.equal(r.status, 0, r.out.slice(-1500));
    assert.deepEqual(dumpOrder(r.log), REF);
    assert.match(r.out, /falling back to the static manifest order/);
    assert.match(r.out, /does NOT rotate/);
  });

  it("refuses a PARTIAL order — a short answer must not sync a subset", () => {
    // The ordering query answering with one collection instead of 54 would, if
    // trusted, sync a SUBSET and report success: a worse bug than the one being
    // fixed, and exactly the not-measured-is-not-passed shape. The length check
    // sends it to the manifest fallback instead.
    const r = runSync({ STUB_ORDER_TRUNCATE: REF[0]! });
    assert.equal(r.status, 0, r.out.slice(-1500));
    assert.deepEqual(dumpOrder(r.log), REF);
    assert.match(r.out, /falling back to the static manifest order/);
  });
});

describe("sync-prod-to-qa records what happened to every collection (MONEY-1488)", () => {
  it("stamps IN_FLIGHT BEFORE the dump and RESTORED after it", () => {
    // The ordering is the mechanism, not a detail: a process killed at the
    // 3600s task timeout cannot write "I was killed", so the intent has to be
    // on disk before the work starts and the ABSENCE of the overwrite is the
    // signal. If IN_FLIGHT were written after the dump it would record nothing
    // a kill could leave behind.
    const r = runSync();
    const lines = r.log.split("\n");
    const first = REF[0]!;
    const inFlight = lines.indexOf(`OUTCOME ${first} IN_FLIGHT rows=7`);
    const dump = lines.indexOf(`DUMP ${first}`);
    const restored = lines.indexOf(`OUTCOME ${first} RESTORED rows=7`);
    assert.ok(inFlight >= 0, "no IN_FLIGHT stamp was written");
    assert.ok(dump > inFlight, "the dump ran before the IN_FLIGHT stamp");
    assert.ok(restored > dump, "RESTORED was not written after the dump");
  });

  it("stamps EVERY visited collection, including the ones it skipped", () => {
    // MONEY-1255's stamping lesson, and the input to the rotation above: a
    // collection that legitimately had nothing to copy must not keep a stale
    // marker for ever, because that marker is what decides when it is next
    // reached.
    const r = runSync({ STUB_COUNT: "0" });
    assert.equal(r.status, 0, r.out.slice(-1500));
    const got = outcomes(r.log);
    assert.deepEqual(
      got.map((o) => o.collection),
      REF,
      "not every collection was stamped",
    );
    assert.deepEqual(
      [...new Set(got.map((o) => o.state))],
      ["SKIPPED_EMPTY"],
      "an empty-guard skip must be its own state, not a failure and not a copy",
    );
  });

  it("a FAILED collection is recorded as FAILED, not left at IN_FLIGHT", () => {
    // FAILED means the pipeline finished and reported an error; IN_FLIGHT means
    // the job is gone. Both mean QA may hold a partial copy, but only one of
    // them means anything is still running.
    const r = runSync({ STUB_FAIL_COLLECTION: "stock_news" });
    assert.equal(r.status, 1);
    const forNews = outcomes(r.log).filter(
      (o) => o.collection === "stock_news",
    );
    assert.deepEqual(
      forNews.map((o) => o.state),
      ["IN_FLIGHT", "FAILED"],
    );
  });

  it("a freshness write that fails does not fail the run", () => {
    // The diary must never be able to fail the copy. Every collection still
    // restores and the job stays green; the only visible effect is a warning.
    const r = runSync({ STUB_OUTCOME_EXIT: "1" });
    assert.equal(r.status, 0, r.out.slice(-1500));
    assert.deepEqual(dumpOrder(r.log), REF);
    assert.match(r.out, /freshness record not written/);
  });

  it("--status reads QA, prints, and exits WITHOUT touching prod", () => {
    const r = runSync({}, ["--status"]);
    assert.equal(r.status, 0, r.out.slice(-1500));
    assert.match(r.log, /STATUS_RAN stale=3/);
    assert.doesNotMatch(r.log, /DUMP/, "--status dumped something");
    assert.doesNotMatch(r.log, /OUTCOME/, "--status wrote an outcome row");
    assert.doesNotMatch(r.log, /RELINK_RAN/);
  });

  it("--status exits 1 when it cannot read the record", () => {
    // "we could not ask" is not "nothing has ever synced", and reporting the
    // second over the first is how a report becomes worse than no report.
    const r = runSync({ STUB_STATUS_FAIL: "1" }, ["--status"]);
    assert.equal(r.status, 1, r.out.slice(-1500));
    assert.match(r.out, /Could not read qa_sync_outcomes/);
  });
});

describe("the post-restore index check rides the re-link (MONEY-1487)", () => {
  it("the re-link program is handed EVERY reference collection to check", () => {
    // `mongorestore --drop` rebuilds indexes LAST, so a killed run leaves rows
    // with no unique index — observed live 2026-09-19 on stock_documents and
    // shareholding_patterns. The run that does the damage is the one that was
    // killed, so it can never report it; only a LATER run can, and only if it
    // checks collections it did not itself restore.
    const r = runSync();
    const line = r.log.split("\n").find((l) => l.startsWith("RELINK_RAN"));
    assert.ok(line, "the re-link never ran");
    for (const c of REF) {
      assert.ok(
        new RegExp(`index=[^\\n]*\\b${c}\\b`).test(line),
        `${c} was not handed to the index check`,
      );
    }
  });

  it("exit 3 is its own verdict, distinct from a failed or incomplete re-link", () => {
    // Three verdicts, three actions: `relink` = check connectivity,
    // `relink-orphans-remain` = this environment is missing instruments,
    // `missing-indexes` = re-run the sync or `prisma db push`. Collapsing any
    // pair sends an operator to the wrong place.
    const r = runSync({ STUB_RELINK_EXIT: "3" });
    assert.equal(r.status, 1, r.out.slice(-1500));
    assert.match(r.out, /1 step\(s\) failed: missing-indexes/);
    assert.match(r.out, /INDEXES MISSING/);
    assert.doesNotMatch(r.out, /RE-LINK FAILED/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// MONEY-1519 — `candles` gets its unique key BEFORE its rows
// ────────────────────────────────────────────────────────────────────────────
//
// `tiingo-realtime-qa` writes into QA's `candles`. Under `mongorestore --drop`
// the collection enforced nothing for the ~30 minutes of the restore, the QA
// writer landed bars prod's dump then delivered again, and the unique build at
// the end failed — leaving 29.6M rows and ONLY `_id_`, every night. These pin
// the ORDER that makes that impossible (key, then rows), the one flag that
// would silently undo it (`--drop` on that restore), and that every way the
// key can fail to exist is a NAMED outcome with no rows restored behind it.

/** Index of the first log line matching `re`, or -1. */
function lineIndex(log: string, re: RegExp): number {
  return log.split("\n").findIndex((l) => re.test(l));
}

/** The OUTCOME states one collection was stamped with, in order. */
function statesOf(log: string, collection: string): string[] {
  return outcomes(log)
    .filter((o) => o.collection === collection)
    .map((o) => o.state);
}

describe("MONEY-1519 — a unique-first collection can never be restored without its key", () => {
  it("REGRESSION: the key is created BEFORE candles' first row, and its restore does NOT --drop", () => {
    const r = runSync();
    assert.equal(r.status, 0, r.out.slice(-1500));

    const inFlight = lineIndex(r.log, /^OUTCOME candles IN_FLIGHT /);
    const specRead = lineIndex(r.log, /^UNIQUE_SPECS_READ candles$/);
    const prep = lineIndex(r.log, /^UNIQUE_FIRST candles /);
    const dump = lineIndex(r.log, /^DUMP candles$/);
    const restore = lineIndex(r.log, /^RESTORE candles /);
    assert.ok(prep >= 0, "no unique-key pre-step ran for candles");
    // IN_FLIGHT first: the pre-step DROPS, so a kill there is a kill mid-restore.
    assert.ok(
      inFlight >= 0 && inFlight < prep,
      "the pre-step ran before IN_FLIGHT",
    );
    assert.ok(
      specRead >= 0 && specRead < prep,
      "QA was prepared before prod was read",
    );
    assert.ok(
      dump > prep,
      "candles' rows were dumped before its unique key existed",
    );
    assert.ok(restore > prep);

    // THE flag. `--drop` would drop the key the pre-step just built and reopen
    // the window QA's writer fills with duplicates.
    const restoreLine = r.log.split("\n")[restore]!;
    assert.doesNotMatch(
      restoreLine,
      /--drop/,
      "candles is restored with --drop, which throws away the unique key built for it",
    );
    // Not vacuous: the stub DOES see argv, because an ordinary collection's
    // restore still carries --drop.
    assert.match(r.log, /^RESTORE stock_news args=.*--drop/m);

    // The JOIN: the QA call received exactly what the PROD read printed.
    assert.equal(
      r.log.split("\n")[prep],
      `UNIQUE_FIRST candles specs=${UNIQUE_SPEC}`,
    );
    assert.deepEqual(statesOf(r.log, "candles"), ["IN_FLIGHT", "RESTORED"]);

    // The unique-first set ONLY: two mongosh boots a collection (~5 s) is not
    // spent on the 53 that QA does not write.
    const prepared = r.log
      .split("\n")
      .map((l) => /^UNIQUE_FIRST (\S+) /.exec(l)?.[1])
      .filter((c): c is string => c !== undefined);
    assert.deepEqual(prepared, ["candles"]);
  });

  it("the DRY RUN shows the same fork — no --drop on candles, the key step first", () => {
    // MONEY-1157's class: a dry run printing a command the real run does not
    // issue. The operator reads THIS to know what the job will do to QA.
    const r = runSync({}, ["--dry-run", "--collections-only"]);
    assert.equal(r.status, 0, r.out.slice(-1500));
    const lines = r.out.split("\n");
    const key = lines.findIndex(
      (l) => /UNIQUE KEY FIRST/.test(l) && /candles/.test(l),
    );
    assert.ok(key >= 0, "the dry run does not show candles' unique-key step");
    const restore = lines.findIndex(
      (l, i) => i > key && /mongorestore --uri="<QA_URL>"/.test(l),
    );
    assert.ok(restore > key);
    assert.doesNotMatch(lines[restore]!, /--drop/);
    assert.match(r.out, /mongorestore --uri="<QA_URL>" --drop --archive/);
  });

  it("a pre-step that cannot build the key is INDEX_BUILD_FAILED, and NO rows are restored", () => {
    const r = runSync({ STUB_UF_PREP_EXIT: "1" });
    assert.equal(r.status, 1, r.out.slice(-1500));
    assert.doesNotMatch(
      r.log,
      /^DUMP candles$/m,
      "candles was restored without its key",
    );
    assert.doesNotMatch(r.log, /^RESTORE candles /m);
    assert.deepEqual(statesOf(r.log, "candles"), [
      "IN_FLIGHT",
      "INDEX_BUILD_FAILED",
    ]);
    assert.match(r.out, /1 step\(s\) failed: candles:INDEX_BUILD_FAILED/);
    // A failed key is one collection's problem, not the run's: the rest copy.
    assert.deepEqual(
      dumpOrder(r.log),
      REF.filter((c) => c !== "candles"),
    );
  });

  it("an unreadable prod spec is INDEX_BUILD_FAILED and QA is never touched", () => {
    const r = runSync({ STUB_UF_READ_FAIL: "1" });
    assert.equal(r.status, 1, r.out.slice(-1500));
    assert.doesNotMatch(
      r.log,
      /^UNIQUE_FIRST candles/m,
      "QA was dropped without a spec to rebuild",
    );
    assert.doesNotMatch(r.log, /^DUMP candles$/m);
    assert.deepEqual(statesOf(r.log, "candles"), [
      "IN_FLIGHT",
      "INDEX_BUILD_FAILED",
    ]);
    assert.match(
      r.out,
      /could not read candles's indexes from prod — not restoring; QA untouched/,
    );
  });
});

describe("MONEY-1519 — a failed index build is INDEX_BUILD_FAILED, not FAILED", () => {
  it("rows landed + index build failed -> INDEX_BUILD_FAILED, loudly, with the cause", () => {
    const r = runSync({ STUB_INDEX_FAIL_COLLECTION: "stock_news" });
    assert.equal(r.status, 1, r.out.slice(-1500));
    assert.deepEqual(statesOf(r.log, "stock_news"), [
      "IN_FLIGHT",
      "INDEX_BUILD_FAILED",
    ]);
    assert.match(r.out, /INDEX_BUILD_FAILED.*WITHOUT their indexes/);
    assert.match(r.out, /1 step\(s\) failed: stock_news:INDEX_BUILD_FAILED/);
    // The cause itself reaches the log (MONEY-1483's stderr tail).
    assert.match(r.out, /error creating indexes for tradebook\.stock_news/);
  });

  it("on a unique-first collection it says the key built first still holds", () => {
    const r = runSync({ STUB_INDEX_FAIL_COLLECTION: "candles" });
    assert.equal(r.status, 1, r.out.slice(-1500));
    assert.deepEqual(statesOf(r.log, "candles"), [
      "IN_FLIGHT",
      "INDEX_BUILD_FAILED",
    ]);
    assert.match(r.out, /unique key built first still holds/);
  });

  it("a data failure is still plain FAILED — the two are not merged", () => {
    const r = runSync({ STUB_FAIL_COLLECTION: "stock_news" });
    assert.deepEqual(statesOf(r.log, "stock_news"), ["IN_FLIGHT", "FAILED"]);
    assert.doesNotMatch(r.out, /INDEX_BUILD_FAILED/);
  });
});
