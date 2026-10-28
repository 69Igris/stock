/**
 * MONEY-1238 — a processor that WRITES must SAY what it wrote.
 *
 * ## The guard that did not exist
 *
 * `job-outcome.ts` claimed one: "`assertReportsJobOutcome` (in the tests) fails
 * when a data-writing processor does not call it — so the NEXT job cannot join
 * the list above quietly." `grep -rn assertReportsJobOutcome` over the whole
 * repository returned that sentence and nothing else. There was no such
 * function, in the tests or anywhere.
 *
 * What existed was a hand-typed five-name list, and a list cannot fail for a
 * file that is not on it. Measured on the tree this guard landed on: 44 files in
 * `workers/src/processors` issue Prisma writes and 3 of them reported. Three of
 * the silent ones — `xbrl-sync`, `events-sync`, `bhavcopy-sync` — had a Datadog
 * monitor watching for their metric, so those monitors had been in NO DATA since
 * the day they were created. Naming a bug in a comment is not protection from
 * it; a scan is.
 *
 * ## The rule
 *
 *   A file in `workers/src/processors` that issues a Prisma write must call
 *   `reportJobOutcome`, OR appear in EXEMPT or BACKLOG below with a date and a
 *   reason.
 *
 * `scripts/jobs/*.ts` are NOT scanned. They are one-shot Cloud Run Job scripts
 * rather than Pub/Sub processors, they are invoked by hand as often as by a
 * schedule, and several of them (the XBRL backfill, the projection drain) call
 * INTO a processor that already reports — scanning them would double-count.
 * The ones that ARE monitored are covered by the second describe block below,
 * which checks the monitor list against emit sites in both directories.
 *
 * ## Why a RATCHET rather than a clean bill
 *
 * 38 of 44 writers are non-compliant today. A guard that fails the build on all
 * 38 gets deleted within the hour, and then the class comes back. So the
 * baseline is a permit list that can only SHRINK, in both directions:
 *
 *   - a writer that is NOT listed fails immediately (the point of the guard)
 *   - a listed writer that HAS started reporting also fails, so fixing one
 *     forces its line to be deleted
 *
 * The second direction is not bookkeeping. A permit left behind after its site
 * was repaired would let the same silence back in at exactly the spot we already
 * know is dangerous. Modelled on
 * `apps/web/__tests__/meta/prisma-null-vs-isset.test.ts`, which is this repo's
 * house pattern for a shrink-only baseline.
 *
 * The remaining count is PRINTED on every run rather than merely tolerated: a
 * backlog nobody can see is a backlog nobody works.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { blankNonCode, outcomeReporterNames } from "./job-outcome-source-scan";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PROCESSOR_DIR = join(ROOT, "workers", "src", "processors");
const JOBS_DIR = join(ROOT, "scripts", "jobs");
const SERVICES_DIR = join(ROOT, "services");
const APPLY_SCRIPT = join(ROOT, "scripts/ops/datadog/apply-monitors.sh");

/**
 * Python emit sites — `services/*` (MONEY-979).
 *
 * The scan below was written when every job in this repo was TypeScript, and it
 * reads two directories of `.ts`. `services/us-fundamentals` is a Python Cloud
 * Run service that emits the SAME four counters through
 * `app/store/outcome.py::report_job_outcome`, and not one line of it is visible
 * to a `.ts` reader.
 *
 * Left alone, the first EDGAR job added to MONITORED_JOBS would report as
 * "monitored, nothing emits it" — and the honest-looking fix, an EMIT_PENDING
 * entry, would be a permanent lie about a call that already exists. So the scan
 * is widened, the same way `topic-publisher-coverage.test.ts` was widened for
 * the Python publishers, and with the same two constraints:
 *
 *   PER FILE, NOT ONE CORPUS. Joining every `.py` into one blob and asking
 *   whether the job id appears in it would pass on `app/main.py`'s ROUTE table
 *   and on the scheduler description — both of which name `edgar-detect` and
 *   neither of which emits anything. Deleting the real call would leave the
 *   guard green, which is the failure this file exists to prevent, reproduced
 *   one language over.
 *
 *   ON THE REPORT PATH. A file contributes ids only if it CALLS
 *   `report_job_outcome`. Its ids are the module-level `JOB` / `JOB_NAME`
 *   literals in that same file, which is the shape every emitter here uses
 *   (`JOB_NAME = "edgar-detect"` in `app/jobs/detect.py`, three lines above the
 *   call in its `finally`).
 *
 * KNOWN BOUNDARY, stated rather than discovered: `edgar-bulk-submissions` and
 * `edgar-bulk-companyfacts` are NOT found by this rule. Their emitters pass a
 * `job` variable resolved from `JOB_NAMES` in `app/bulk/common.py`, a file that
 * does not itself call `report_job_outcome`. Neither is monitored today (see
 * the EDGAR block in apply-monitors.sh for why), and the ticket that monitors
 * them has to extend this extractor in the same change — at which point this
 * test fails first and says so, which is the correct order.
 */
const PY_SKIP_DIRS = new Set([
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".git",
  "dist",
  "build",
]);

function collectPythonSources(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (PY_SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectPythonSources(full, out);
    // `test_*.py` excluded: a fixture naming a job id is not an emit site, and
    // a test that stubs the reporter would otherwise vouch for a job nothing
    // reports in production.
    else if (/\.py$/.test(entry.name) && !/^test_/.test(entry.name)) {
      out.push(full);
    }
  }
}

const pythonSourceFiles: string[] = [];
collectPythonSources(SERVICES_DIR, pythonSourceFiles);

/** A Python file that CALLS the reporter, not merely one that mentions it. */
const PY_REPORT_CALL = /\breport_job_outcome\s*\(/;
/** `JOB = "…"` / `JOB_NAME: str = "…"` at module level in that same file. */
const PY_JOB_LITERAL =
  /^\s*(?:JOB|JOB_NAME)\s*(?::\s*str\s*)?=\s*"([a-z0-9-]+)"/gm;

// ---------------------------------------------------------------------------
// The two permit lists. Both dated, both shrink-only.
// ---------------------------------------------------------------------------

/**
 * Processors whose unit of work is ONE user's request, not a schedule.
 *
 * A zero-write alert over these would page on a quiet hour rather than on a
 * broken pipeline: `import` writes nothing when nobody uploaded a CSV, and that
 * is the normal state of the system most of the time. They are listed rather
 * than silently skipped because "is this per-user?" is a judgement, and a
 * judgement that is not written down gets re-made differently next year.
 *
 * Adding `reportJobOutcome` to one of these is an improvement, not a violation
 * — but it must then be deleted from here, or the permit rots.
 */
const EXEMPT = new Map<string, string>([
  // MONEY-1314. NOT a processor — a persistence HELPER extracted from
  // stock-document-parse.ts so the old parse lane and the new ingest lane
  // cannot disagree about what a reading is (same unique key, same
  // collection, and a figure map encoding which columns this reader may
  // claim). It has no run, no selection and no outcome of its own: it is
  // called once per PERIOD, several times within one document. Both callers
  // report their own job-outcome, and a third counter here would double-count
  // rows against them.
  [
    "doc-extract-persist.ts",
    "2026-09-01: shared upsert helper, not a job; both callers report",
  ],
  ["comparison.ts", "2026-08-21: per-user stock/MF comparison request"],
  ["document-process.ts", "2026-08-21: per-user document extract/report"],
  ["import.ts", "2026-08-21: per-user CSV/XLS trade import"],
  ["l3-analysis.ts", "2026-08-21: per-user deep analysis request"],
  ["login-briefing.ts", "2026-08-21: per-user briefing, fired on login"],
  ["pairing.ts", "2026-08-21: per-user FIFO trade pairing"],
  ["research.ts", "2026-08-21: per-user StockSage research job"],
  ["roast.ts", "2026-08-21: per-user portfolio roast"],
  ["studio-render.ts", "2026-08-21: per-user video render"],
  ["sync.ts", "2026-08-21: per-user broker sync"],
]);

/**
 * Writers the zero-write monitor is the WRONG SIGNAL for.
 *
 * NOT a backlog. The alert is `selected > 0 AND written < 1`, and an entry
 * belongs here only when there is no honest way to make that condition mean
 * "this run did nothing useful".
 *
 * ## MONEY-1250 emptied the JOB half of this list
 *
 * It held ten entries on 2026-08-22 and nine of them were jobs. Every one was
 * listed for the same stated reason — "a zero-write run is the NORMAL, HEALTHY
 * outcome here" — and for eight of the nine that reason was true of the number
 * being paired, not of the JOB. The bug was in the choice of `selected`:
 *
 *     news-rss-sync         paired `fresh` (every item in the RSS channels,
 *                           ~200 every tick) instead of `toInsert`
 *     alert-evaluator       paired `evaluated` (every ACTIVE alert row)
 *                           instead of conditions actually met
 *     resend-contact-sync   paired every user instead of the CHANGED users
 *     intraday-sync         paired bars fetched instead of bars missing
 *     price-sync            paired instruments scanned instead of bars owed
 *     market-movers-sync    paired rows parsed instead of rows parsed on a
 *                           leg whose snapshot ADVANCED
 *     newsletter-publish    had no count at all; `publishDate <= now` was
 *                           already the "age of the oldest unpublished" signal
 *     intent-learning       paired signals FOUND instead of writes DECIDED
 *
 * In each case the honest denominator — work that was OWED a write — is zero on
 * exactly the runs the old note called healthy, so the monitor is silent on
 * them and fires on the real failure. The ninth, `investor-rollup`, was listed
 * on a claim that was simply false about the code: its snapshot write is
 * unconditional, one row per active user per run.
 *
 * The lesson is worth more than the list: "this job legitimately writes zero"
 * is almost always "this job is counting the wrong population". Reach for a
 * different `selected` before reaching for this map.
 *
 * Kept, because a genuine case exists (below) and the next one will be judged
 * against these. Each entry must name the signal that WOULD work, so this is a
 * design record rather than a permit.
 */
const WRONG_SIGNAL = new Map<string, string>([
  [
    "xbrl-projection-writer.ts",
    "2026-08-24: NOT A JOB. A library module — no route, no Pub/Sub topic, no " +
      "schedule, and therefore no run of its own to report. It is imported by " +
      "xbrl-projection.ts and xbrl-ratios.ts (both of which report) and by " +
      "scripts/jobs/xbrl-projection-drain.ts. A `reportJobOutcome` here would " +
      "emit a second outcome for a run that has already been counted, which is " +
      "worse than silence: the monitor divides one run's work across two " +
      "series. Right signal: the outcome its CALLERS already emit.",
  ],
  [
    "document-financials-projection-logic.ts",
    "2026-08-26 (MONEY-1255): NOT A JOB, and structurally the same carve-out as " +
      "xbrl-projection-writer.ts above — a library module with no route, no " +
      "Pub/Sub topic and no schedule, so it has no run of its own to report. " +
      "VERIFIED rather than taken on the writer's word: the module contains ZERO " +
      "reportJobOutcome calls, and its sole caller " +
      "workers/src/processors/document-financials-projection.ts emits one from a " +
      "`finally`, so every exit reports — including a throw and an idle run, " +
      "which reports 0/0. That `finally` matters: the same guard's sibling job " +
      "stock-document-extract had its report sitting BELOW an empty-queue early " +
      "return, so an idle night emitted nothing and its freshness monitor would " +
      "have gone red the moment the backlog finished draining. Reporting here " +
      "too would emit a second outcome for a run already counted, splitting one " +
      "run's work across two series — worse than silence.",
  ],
]);

/**
 * Scheduled, market-wide jobs that write and do not yet report.
 *
 * Every one of these is a job the zero-write monitor SHOULD be able to watch,
 * and the reason is the same for all of them: `reportJobOutcome` landed with
 * MONEY-1220 and only five callers were ever added. This is the backlog, not a
 * design decision.
 *
 * Measured 2026-08-21, after MONEY-1238 wired xbrl-sync, events-sync and
 * bhavcopy-sync: 44 writers, 3 pre-existing reporters, 3 added, 38 remaining
 * (10 exempt above + 28 here).
 */
const BACKLOG = new Map<string, string>([
  ["ownership-sync.ts", "2026-08-21: MONEY-1220 backlog — scheduled"],
  ["strategy-scan.ts", "2026-08-21: MONEY-1220 backlog — scheduled"],
]);

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

/**
 * Blank comment BODIES, string bodies and regex bodies — offsets preserved.
 *
 * Was a pair of regexes here, stripping LINE comments before BLOCK comments so
 * a `//` mentioning `/*` could not open a phantom block (MONEY-1143). MONEY-1325
 * found the same defect from the STRING side and shared the fix instead of
 * adding a third regex: three processors send an HTTP `Accept` header
 * containing a `*` `/` `*`, and each one opened a block comment that ran ~40
 * lines — swallowed code reads as "does not write" and drops the file off this
 * scan entirely, which is the failure this guard replaces. Verified over all
 * 115 processor files: ZERO verdicts change, so the swap is a latent-hole fix
 * rather than a behaviour change.
 */
const blankComments = (src: string): string =>
  blankNonCode(src, { preserveStringBodies: true });

/** Prisma write methods. `findMany`/`count`/`aggregate` are reads. */
const WRITE_METHOD =
  /\.(?:create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\s*\(/;

/** Raw Mongo. `$runCommandRaw` carries inserts/updates as often as reads. */
const RAW_COMMAND = /\$runCommandRaw\s*\(/;

/**
 * Does this file issue a Prisma write?
 *
 * A per-FILE conjunction (mentions the client AND calls a write method) rather
 * than a per-SITE regex, and the choice was measured rather than assumed. A
 * per-site rule has to recognise all of:
 *
 *     prisma.upcomingEvent.deleteMany({…})     the common shape
 *     prisma.studioGeneration\n  .create({…})  split across lines
 *     (prisma as any).alert.update({…})        alert-evaluator.ts:933
 *     delegate.upsert({…})                     ipo-sync.ts:217, a held delegate
 *     model.upsert({…})                        ownership-sync.ts:508
 *
 * …while rejecting `seen.delete(x)` on a Set and `resend.contacts.create(…)` on
 * the email client. No single site regex did both; the conjunction does, and
 * the ONE file it drops relative to a naive `.delete(`-anywhere rule is
 * `dead-letter-consumer-logic.ts`, which is pure and mentions no client at all.
 *
 * It errs toward INCLUSION on purpose. A false positive costs one dated line in
 * a permit list, which documents itself. A false negative is a writer that
 * silently leaves the scan — the exact failure this file replaces.
 */
function issuesPrismaWrite(code: string): boolean {
  if (RAW_COMMAND.test(code)) return true;
  return /\bprisma\b/.test(code) && WRITE_METHOD.test(code);
}

/*
 * `outcomeReporterNames` moved to `job-outcome-source-scan.ts` — MONEY-1325.
 *
 * MAKING A COLLABORATOR INJECTABLE IS HOW A SOURCE-TEXT GUARD IN THIS REPO GOES
 * QUIET. `corporate-actions-sync.ts` grew
 * `const report = deps?.reportOutcome ?? reportJobOutcome` and calls `report(…)`,
 * so the literal `reportJobOutcome(` stopped appearing anywhere in the file:
 *
 *   before the refactor  { reports: true,  ids: ["corp-actions-sync", …] }
 *   after                { reports: false, ids: [] }
 *
 * Green throughout, because that job has no `MONITORED_JOBS` entry and the file
 * is not classed as a Prisma writer — the scan simply stopped seeing a job that
 * reports perfectly well. The alias resolution is now shared with the
 * REACHABILITY guard, so the two cannot disagree about which files report.
 */

/** A call to any of them, `name(`. */
const callsAny = (code: string, names: readonly string[]): boolean =>
  names.some((n) => new RegExp(`\\b${n}\\s*\\(`).test(code));

const reportsOutcome = (code: string): boolean =>
  callsAny(code, outcomeReporterNames(code));

interface Processor {
  file: string;
  writes: boolean;
  reports: boolean;
}

async function scanProcessors(): Promise<Processor[]> {
  const files = (await readdir(PROCESSOR_DIR))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort();
  const out: Processor[] = [];
  for (const file of files) {
    const code = blankComments(
      await readFile(join(PROCESSOR_DIR, file), "utf8"),
    );
    out.push({
      file,
      writes: issuesPrismaWrite(code),
      reports: reportsOutcome(code),
    });
  }
  return out;
}

const scanned = scanProcessors();

// ---------------------------------------------------------------------------

describe("MONEY-1238 — every data-writing processor reports its outcome", () => {
  it("[meta] the scan is live", async () => {
    const all = await scanned;
    // A scan that silently matches nothing PASSES (MONEY-1093). Floors on both
    // halves, so a broken walk or a broken write-detector fails here rather
    // than reporting a clean repo.
    assert.ok(
      all.length > 60,
      `expected 60+ processor files, found ${all.length} — the walk is broken`,
    );
    assert.ok(
      all.filter((p) => p.writes).length > 30,
      `expected 30+ writers, found ${all.filter((p) => p.writes).length} — ` +
        `the write detector is broken and every assertion below is vacuous`,
    );
    assert.ok(
      all.filter((p) => p.reports).length >= 5,
      "expected at least the five known reporters",
    );
  });

  it("[meta] the comment stripper strips, and strips LINE before BLOCK", () => {
    // MONEY-1143. If the order inverted, the `/*` inside the line comment below
    // would open a block that swallows the write, and the file would leave the
    // scan reporting "no writes".
    const src = [
      "// a line comment mentioning /* an unterminated block",
      "await prisma.thing.create({ data: {} });",
      "/* a real block with await prisma.other.deleteMany({}) inside */",
    ].join("\n");
    const code = blankComments(src);
    assert.equal(
      code.split("\n").length,
      src.split("\n").length,
      "offsets and line count must be preserved",
    );
    assert.ok(issuesPrismaWrite(code), "the REAL write must survive stripping");
    assert.ok(
      !/deleteMany/.test(code),
      "a write mentioned only inside a block comment must not count",
    );
  });

  it("[meta] the rule flags known-bad shapes and spares known-good ones", () => {
    const flags = (src: string): boolean =>
      issuesPrismaWrite(blankComments(src));

    // BAD — every real shape found in this directory.
    assert.ok(flags("await prisma.upcomingEvent.deleteMany({ where: {} });"));
    assert.ok(flags("await prisma.studioGeneration\n  .create({ data: {} });"));
    assert.ok(flags("await (prisma as any).alert.update({ where: {} });"));
    assert.ok(
      flags('import prisma from "x";\nawait delegate.upsert({ where: {} });'),
      "a Prisma delegate held in a local must still count",
    );
    assert.ok(
      flags('await prisma.$runCommandRaw({ insert: "X", documents: [] });'),
    );

    // GOOD — the false positives that would make this guard noise.
    assert.ok(
      !flags("const seen = new Set();\nseen.delete(key);"),
      "Set.delete is not a Prisma write",
    );
    assert.ok(
      !flags("await resend.contacts.create({ email });"),
      "the email client is not Prisma",
    );
    assert.ok(
      !flags("const rows = await prisma.trade.findMany({ where: {} });"),
      "a read is not a write",
    );
  });

  it("[regression] no UNLISTED processor writes without reporting", async () => {
    const all = await scanned;
    const unlisted = all
      .filter((p) => p.writes && !p.reports)
      .filter(
        (p) =>
          !EXEMPT.has(p.file) &&
          !BACKLOG.has(p.file) &&
          !WRONG_SIGNAL.has(p.file),
      )
      .map((p) => p.file);

    assert.deepEqual(
      unlisted,
      [],
      "These processors issue Prisma writes and emit no job-outcome, so a run " +
        "that selects work and writes nothing is invisible — the class that " +
        "cost six incidents in one week (MONEY-1220). Fix: call " +
        "`reportJobOutcome({ job, selected, written })` at every exit, with " +
        "`selected` = rows chosen for work and `written` = rows actually " +
        "persisted. If the processor is per-user request-scoped, add it to " +
        "EXEMPT with a date and a reason instead.\n" +
        unlisted.join("\n"),
    );
  });

  it("[ratchet] every permit is still a live finding", async () => {
    const all = await scanned;
    const byFile = new Map(all.map((p) => [p.file, p]));
    const stale: string[] = [];

    // WRONG_SIGNAL is ratcheted too — MONEY-1238. It is a design record, not a
    // permit, but the same staleness applies: if one of these jobs DOES start
    // reporting, the entry has stopped describing reality and must be revisited
    // rather than left as a comment nobody rereads.
    for (const [file, reason] of [...EXEMPT, ...BACKLOG, ...WRONG_SIGNAL]) {
      const hit = byFile.get(file);
      // A permit for a file that no longer exists permits nothing, and failing
      // on it would be noise rather than signal.
      if (!hit) continue;
      if (hit.writes && !hit.reports) continue;
      stale.push(
        `${file}  (${hit.reports ? "now reports" : "no longer writes"}) — ${reason}`,
      );
    }

    assert.deepEqual(
      stale,
      [],
      "These are listed as permitted but are no longer findings. Delete their " +
        "lines — the lists must only ever shrink, otherwise a permit outlives " +
        "its reason and lets the same silence back in at exactly the spot we " +
        "already know is dangerous.\n" +
        stale.join("\n"),
    );
  });

  it("reports the remaining backlog out loud", async () => {
    const all = await scanned;
    const writers = all.filter((p) => p.writes);
    const reporting = writers.filter((p) => p.reports);
    const remaining = writers.filter(
      (p) => !p.reports && BACKLOG.has(p.file),
    ).length;

    // Printed, not asserted against a number: a hard count here would fail the
    // build on every unrelated processor added, which is how a guard gets
    // deleted. The shrink-only ratchet above is what enforces progress; this is
    // what makes the size of the debt visible while it exists.
    console.log(
      `[job-outcome coverage] ${reporting.length}/${writers.length} ` +
        `data-writing processors report — ${remaining} in BACKLOG, ` +
        `${EXEMPT.size} exempt (per-user)`,
    );
    assert.ok(reporting.length > 0, "at least one processor must report");
  });
});

describe("MONEY-1238 — every MONITORED job has somewhere that emits it", () => {
  /**
   * Monitored jobs whose emit site has not landed yet.
   *
   * `notify_no_data` is TRUE, so a monitored job with no emit site is in NO
   * DATA from the moment its monitor is created — permanently alerting, and
   * therefore permanently muted, which removes the only alert on the job that
   * is actually broken.
   *
   * EMPTY as of 2026-08-21, and it got there by being USED. `feed-parse` — the
   * incident named in the monitor template's own comment, pinned to a
   * 10-day-stale image and writing nothing for ten days — was listed here while
   * its call was still being written in `scripts/jobs/feed-parse.ts`. The
   * ratchet below failed the moment the call landed and the entry was deleted,
   * which is the whole behaviour this mechanism is for. Keep the map: the next
   * monitored job will be added before its emit site exists too.
   */
  const EMIT_PENDING = new Map<string, string>([]);

  /**
   * Every job id emitted from a Python file that calls the reporter.
   *
   * TWO spellings, because this service has two — MONEY-1358. `ftd.py` and
   * `detect.py` set a module-level `JOB_NAME = "edgar-bulk-ftd"` literal, which
   * `PY_JOB_LITERAL` finds. `submissions.py` and `companyfacts.py` instead read
   * `JOB_NAMES[FEED_SUBMISSIONS]` out of a shared dict in `app/bulk/common.py`
   * — a file that does not itself call the reporter, so nothing here saw those
   * two ids at all and their monitors could not be added without this scan
   * failing. `apply-monitors.sh` names that as precondition (c) on the EDGAR
   * exclusion block.
   *
   * A VALUE from that dict counts only when some reporting file imports the
   * dict: a table of names is not an emit site on its own, and treating it as
   * one would let a stale entry stand in for a job nobody runs.
   */
  async function pythonEmittedJobIds(): Promise<Set<string>> {
    const out = new Set<string>();

    const sharedTables = new Map<string, string[]>();
    for (const file of pythonSourceFiles) {
      const src = await readFile(file, "utf8");
      for (const table of src.matchAll(
        /^([A-Z_]+):\s*dict\[str,\s*str\]\s*=\s*\{([\s\S]*?)^\}/gm,
      )) {
        sharedTables.set(
          table[1]!,
          [...table[2]!.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]!),
        );
      }
    }

    for (const file of pythonSourceFiles) {
      const src = await readFile(file, "utf8");
      if (!PY_REPORT_CALL.test(src)) continue;
      for (const m of src.matchAll(PY_JOB_LITERAL)) out.add(m[1]!);
      for (const [name, values] of sharedTables) {
        // `import`ed AND subscripted here — both, so a file that merely
        // mentions the table does not inherit every id in it.
        if (
          new RegExp(`\\b${name}\\b`).test(src) &&
          new RegExp(`${name}\\[`).test(src)
        ) {
          for (const v of values) out.add(v);
        }
      }
    }
    return out;
  }

  /** Every `job: "…"` literal passed to reportJobOutcome, repo-wide. */
  async function emittedJobIds(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const dir of [PROCESSOR_DIR, JOBS_DIR]) {
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const f of files.filter((f) => f.endsWith(".ts"))) {
        const code = blankComments(await readFile(join(dir, f), "utf8"));
        // Through the alias too — see `outcomeReporterNames`. A file calling
        // `report({job:"corp-actions-sync"})` emits that id just as surely as
        // one calling `reportJobOutcome({...})`, and reading only the second
        // spelling is how this set silently lost a job.
        // A file's own module-level string constants, so `job: JOB_NAME`
        // resolves — MONEY-1358. `tiingo-news-poll.ts` names its job that way
        // and was therefore invisible here, which would have blocked its
        // monitor on a job that reports perfectly well.
        const constants = new Map(
          [
            ...code.matchAll(
              /^(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]+)"/gm,
            ),
          ].map((m) => [m[1]!, m[2]!] as const),
        );
        for (const name of outcomeReporterNames(code)) {
          for (const m of code.matchAll(
            new RegExp(`\\b${name}\\(\\s*\\{[^}]*?job:\\s*"([^"]+)"`, "gs"),
          )) {
            out.add(m[1]!);
          }
          for (const m of code.matchAll(
            new RegExp(
              `\\b${name}\\(\\s*\\{[^}]*?job:\\s*([A-Z_][A-Z0-9_]*)\\b`,
              "gs",
            ),
          )) {
            const resolved = constants.get(m[1]!);
            if (resolved) out.add(resolved);
          }
        }
      }
    }
    for (const id of await pythonEmittedJobIds()) out.add(id);
    return out;
  }

  /** The job ids apply-monitors.sh creates a monitor for. */
  async function monitoredJobIds(): Promise<string[]> {
    const src = await readFile(APPLY_SCRIPT, "utf8");
    const block = /declare -a MONITORED_JOBS=\(([\s\S]*?)\n\)/.exec(src);
    assert.ok(block, "could not find MONITORED_JOBS in apply-monitors.sh");
    return [...block[1]!.matchAll(/"([^|"]+)\|/g)].map((m) => m[1]!);
  }

  it("creates no QA monitor for a job QA never runs", async () => {
    // MONEY-1250. `notify_no_data: true` means a monitor for a job with no QA
    // schedule sits in NO DATA from birth — finding #1(d) of MONEY-1238,
    // verbatim, and it was already true of TWENTY of the monitors this script
    // creates. A monitor that has never once been green is a monitor somebody
    // mutes, and muting it removes the only alert on the job that is broken.
    //
    // The trap that hid it: PROD_ONLY_JOBS holds SCHEDULER ENTRY names
    // (`market-movers-sync-intraday`) while MONITORED_JOBS holds JOB IDS
    // (`market-movers-sync`). Comparing the two namespaces directly answers
    // "nothing is prod-only" for reasons that have nothing to do with the data.
    const [apply, scheduler] = await Promise.all([
      readFile(APPLY_SCRIPT, "utf8"),
      readFile(join(ROOT, "scripts/ops/setup-scheduler.sh"), "utf8"),
    ]);

    // DERIVED, not restated — a second hand-maintained copy is the drift this
    // whole ticket keeps paying for.
    assert.match(
      apply,
      /PROD_ONLY_SCHED="\$\(sed -n '\/\^PROD_ONLY_JOBS=\(\/,\/\^\)\/p' "\$SCHEDULER_FILE"/,
      "the prod-only set must be derived from setup-scheduler.sh at run time",
    );
    assert.match(
      apply,
      /if \[\[ "\$DD_ENV_TAG" == "qa" \]\] && job_is_prod_only "\$JOB"; then/,
      "the loop must skip prod-only jobs when targeting qa",
    );
    // A parse that returns nothing makes every job read as not-prod-only and
    // silently restores the twenty dead monitors — failure that looks like
    // success. The guard against that is itself load-bearing.
    assert.match(
      apply,
      /expected at least 10\. The format changed/,
      "the prod-only parse needs a falsifiable floor, not a fail-open default",
    );

    // …and the derivation must actually find something, or the assertions above
    // are satisfied by a script that skips nothing.
    const block = /^PROD_ONLY_JOBS=\(([\s\S]*?)\n\)/m.exec(scheduler);
    assert.ok(block, "could not find PROD_ONLY_JOBS in setup-scheduler.sh");
    const prodOnly = new Set(
      [...block[1]!.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!),
    );
    assert.ok(
      prodOnly.size >= 10,
      `expected a substantial PROD_ONLY_JOBS set, got ${prodOnly.size}`,
    );

    const monitored = await monitoredJobIds();
    const restricted = monitored.filter((job) => {
      const rows = [
        ...scheduler.matchAll(
          new RegExp(`"([a-z0-9-]+)\\|[^|]*\\|${job}\\|`, "g"),
        ),
      ].map((m) => m[1]!);
      return rows.length > 0 && rows.every((r) => prodOnly.has(r));
    });
    assert.ok(
      restricted.length > 0,
      "no monitored job resolved as prod-only — the id/entry-name mapping " +
        "broke, which is the exact shape that hid this defect",
    );
  });

  it("[meta] both sides of the comparison are non-empty", async () => {
    const [monitored, emitted] = await Promise.all([
      monitoredJobIds(),
      emittedJobIds(),
    ]);
    assert.ok(monitored.length >= 8, `monitored: ${monitored.length}`);
    assert.ok(
      emitted.size >= 8,
      `expected 8+ distinct emitted job ids, found ${emitted.size} — the ` +
        `extractor is broken and the assertion below is vacuous`,
    );
  });

  it("[meta] the PYTHON half of the scan reaches real files", async () => {
    // MONEY-979. An empty Python corpus does not make this suite vacuous — it
    // makes `edgar-detect` report as un-emitted, i.e. it fails loudly. It is
    // asserted anyway so that failure says "the services/ tree moved" rather
    // than sending the reader to app/jobs/detect.py to look for a call that is
    // already there.
    assert.ok(
      pythonSourceFiles.length > 20,
      `expected many Python sources under services/, got ` +
        `${pythonSourceFiles.length}`,
    );
    const py = await pythonEmittedJobIds();
    assert.ok(
      py.has("edgar-detect"),
      `the Python scan found ${[...py].sort().join(", ") || "nothing"} — it ` +
        `must find edgar-detect, whose emit site is app/jobs/detect.py`,
    );
    // …and it must be SELECTIVE. `edgar-detect` also appears in app/main.py's
    // route table, in app/classify.py and in setup-scheduler.sh, none of which
    // emit anything. A rule that counted those would go on passing after the
    // real call in detect.py's `finally` was deleted, which is the whole
    // failure this file exists to catch.
    assert.ok(
      !py.has("edgar-parse-13f"),
      "the Python scan is matching files that do not call report_job_outcome " +
        "— it has widened into a corpus match and no longer proves anything",
    );
  });

  it("every monitored job emits the metric its monitor queries", async () => {
    const [monitored, emitted] = await Promise.all([
      monitoredJobIds(),
      emittedJobIds(),
    ]);
    const missing = monitored.filter(
      (j) => !emitted.has(j) && !EMIT_PENDING.has(j),
    );
    assert.deepEqual(
      missing,
      [],
      "These jobs are monitored for the zero-write class but nothing calls " +
        '`reportJobOutcome({ job: "<name>" })` for them, so their monitors ' +
        "sit in NO DATA forever and get muted. Either add the call or remove " +
        "the job from MONITORED_JOBS in apply-monitors.sh.\n" +
        missing.join("\n"),
    );
  });

  it("[ratchet] EMIT_PENDING only lists jobs that still do not emit", async () => {
    const emitted = await emittedJobIds();
    const stale = [...EMIT_PENDING.keys()].filter((j) => emitted.has(j));
    assert.deepEqual(
      stale,
      [],
      "These now emit a job-outcome — delete their EMIT_PENDING entries.\n" +
        stale.join("\n"),
    );
  });

  it("the three jobs wired by this ticket emit their outcome", async () => {
    // A liveness floor on THIS change, asserted independently of the scan so a
    // regression in the scanner cannot hide a revert of the wiring.
    const emitted = await emittedJobIds();
    for (const job of ["xbrl-sync", "events-sync", "bhavcopy-sync"]) {
      assert.ok(emitted.has(job), `${job} must call reportJobOutcome`);
    }
  });

  /**
   * MONEY-1250 — the nine jobs lifted out of WRONG_SIGNAL, pinned by NAME.
   *
   * The shrink-only ratchet above cannot hold this on its own. Deleting a
   * `reportJobOutcome` call and re-adding the file to WRONG_SIGNAL passes every
   * other assertion in this file: the file writes, it does not report, and it
   * is listed with a reason — which is exactly the state it was in before this
   * ticket. That is not hypothetical; it is how the nine got there.
   *
   * So the floor is stated positively and by name. Putting any of these back in
   * a permit list now costs a deliberate edit to a test that says, in its
   * failure message, why it was moved.
   */
  const MONEY_1250_JOBS: ReadonlyArray<readonly [string, string]> = [
    ["alert-evaluator.ts", "alert-evaluator"],
    ["intent-learning.ts", "intent-learning"],
    ["intraday-sync.ts", "intraday-sync"],
    ["investor-rollup.ts", "investor-rollup"],
    ["market-movers-sync.ts", "market-movers-sync"],
    ["news-rss-sync.ts", "news-rss-sync"],
    ["newsletter-publish.ts", "newsletter-publish"],
    // Two ids from ONE processor: two schedules, two populations, two
    // definitions of health. See the note in price-sync.ts.
    ["price-sync.ts", "price-sync"],
    ["price-sync.ts", "price-backfill"],
    ["resend-contact-sync.ts", "resend-contact-sync"],
  ];

  it("the nine jobs lifted out of WRONG_SIGNAL still emit their outcome", async () => {
    const [emitted, all] = await Promise.all([emittedJobIds(), scanned]);
    const byFile = new Map(all.map((p) => [p.file, p]));

    const regressed: string[] = [];
    for (const [file, job] of MONEY_1250_JOBS) {
      if (!byFile.get(file)?.reports) {
        regressed.push(`${file} no longer calls reportJobOutcome`);
      }
      if (!emitted.has(job)) {
        regressed.push(`no reportJobOutcome({ job: "${job}" }) anywhere`);
      }
    }

    assert.deepEqual(
      regressed,
      [],
      "MONEY-1250 gave each of these a `selected` that counts work OWED A " +
        "WRITE rather than rows scanned, which is what makes " +
        "`selected > 0 && written === 0` truthful for a job whose quiet runs " +
        "are supposed to write nothing. Re-listing one in WRONG_SIGNAL instead " +
        "of repairing its counts puts it back in the state this ticket found " +
        "it in.\n" +
        regressed.join("\n"),
    );
  });

  it("[meta] the MONEY-1250 floor names files that exist and still write", async () => {
    // Without this, a rename or a deletion turns the floor above into a check
    // on nothing — the vacuity failure MONEY-1093 is named for. Each entry must
    // point at a real processor that still issues Prisma writes, or the entry
    // is stale and the floor is decorative.
    const all = await scanned;
    const byFile = new Map(all.map((p) => [p.file, p]));
    const broken = [...new Set(MONEY_1250_JOBS.map(([f]) => f))].filter(
      (f) => !byFile.get(f)?.writes,
    );
    assert.deepEqual(
      broken,
      [],
      `these MONEY-1250 entries no longer name a data-writing processor: ${broken.join(", ")}`,
    );
  });
});

describe("the scan survives an INJECTABLE reporter", () => {
  // Named because this is the instance that cost the scan a whole job, and
  // because a generic assertion passes by simply not finding the file.
  const CORP_ACTIONS = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "workers",
    "src",
    "processors",
    "corporate-actions-sync.ts",
  );

  it("PREMISE: corporate-actions-sync.ts still injects its reporter", async () => {
    // If this file stops using the `?? reportJobOutcome` shape, the case below
    // proves nothing and should be re-pointed rather than left passing.
    const code = await readFile(CORP_ACTIONS, "utf8");
    assert.match(
      code,
      /=\s*deps\?\.\w+\s*\?\?\s*reportJobOutcome/,
      "the injectable-reporter shape is gone; re-point this regression case",
    );
    assert.doesNotMatch(
      code,
      /\breportJobOutcome\s*\(/,
      "the literal call is back, so the alias path is no longer exercised",
    );
  });

  it("sees the job id through the alias", async () => {
    // The defect in one assertion. The old regexes read only the literal
    // spelling, so this file reported `reports:false, ids:[]` while reporting
    // its outcome perfectly well.
    const code = blankComments(await readFile(CORP_ACTIONS, "utf8"));
    assert.equal(
      reportsOutcome(code),
      true,
      "the file reports and must be seen to",
    );
    const ids = new Set<string>();
    for (const name of outcomeReporterNames(code)) {
      for (const m of code.matchAll(
        new RegExp(`\\b${name}\\(\\s*\\{[^}]*?job:\\s*"([^"]+)"`, "gs"),
      )) {
        ids.add(m[1]!);
      }
    }
    assert.ok(
      ids.has("corp-actions-sync"),
      `alias scan found ${JSON.stringify([...ids])}, expected corp-actions-sync`,
    );
  });
});
