/**
 * gen-test-coverage.ts — TEST-COVERAGE.md inventory reporter + freshness check.
 *
 * This is the generator the MONEY-838 note in TEST-COVERAGE.md asks for: the
 * doc's headline counts are hand-maintained and have drifted (twice) by
 * thousands; this script derives the FILE inventory from disk so CI can catch
 * the drift the day it happens instead of months later.
 *
 * What it measures (exact, static): test FILES — every `*.test.ts(x)` and
 * `*.spawntest.ts(x)` under the yarn workspaces (`apps/*`, `packages/*`,
 * `workers`), which is what the turbo `test` task runs — BOTH lanes of it, in
 * the one workspace (`packages/core`) that has two; see TEST_FILE_SUFFIX_SRC.
 * `tests/integration` (env-gated, `yarn test:full`),
 * `evals`, and `scripts` are inventoried separately and NOT counted against
 * the headline.
 *
 * What it deliberately does NOT measure: test CASES. Case totals come from
 * actually running `node:test` (subtests are generated at runtime, and the
 * doc notes ±~100 run-to-run variance) — a static count would be a fiction.
 * File-level drift is the leading indicator anyway: files change whenever
 * cases do.
 *
 * Modes:
 *   (default)  Print the per-workspace inventory, the doc headline, and any
 *              on-disk test file whose basename is never mentioned in the doc.
 *   --check    CI freshness gate. Exit 1 if the doc headline
 *              "**Total Test Files:** N" ≠ the on-disk workspace count, if
 *              the doc names a test file that does not exist (phantom rows),
 *              or if a test file exists on disk that the doc never mentions
 *              AND is not in UNMENTIONED_BASELINE.
 *
 *              That last gate is a RATCHET, added by MONEY-1238. It used to be
 *              a warning nobody had to act on, which left the blocking CI step
 *              satisfiable by bumping the headline and never adding the row —
 *              a freshness gate passable without documenting anything.
 *              Basename mentions are still a heuristic, so the baseline freezes
 *              the 149 pre-existing offenders and only ADDITIONS fail.
 *
 * Wired as `yarn test:coverage-check` and a (warn-only, for now) step in
 * .github/workflows/test.yml. After each real recount, restamp the headline
 * in TEST-COVERAGE.md and the gate is green again.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATH = join(REPO_ROOT, "TEST-COVERAGE.md");

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
  ".git",
  "vendor",
  ".claude",
]);

/**
 * The test-file suffixes this inventory recognises.
 *
 * `.spawntest.ts` (MONEY-1316) is the SECOND lane. `packages/core` runs
 * `node --test` twice — the normal files at `--test-timeout=30000`, and the
 * expensive process-spawning ones at 180000 — and a file is moved between lanes
 * by RENAMING it, because node has no per-file timeout API and no exclusion
 * list. Those files are every bit as real as the rest of the suite.
 *
 * NOTE the shape of this pattern: `foo.spawntest.ts` does NOT end with
 * `.test.ts` (the character before `test.ts` is `n`, not `.`), so the original
 * `/\.test\.tsx?$/` matched none of them. Four files would have dropped out of
 * the headline count in silence on the rename — a counted-but-unexecuted number
 * turning into an executed-but-uncounted one, which is the same class of defect
 * from the other side, and exactly what this generator exists to catch.
 *
 * Kept as ONE constant, and reused for the doc-citation and stem matchers
 * below, so a third suffix cannot be taught to the walker and forgotten in the
 * phantom-row gate.
 */
const TEST_FILE_SUFFIX_SRC = String.raw`\.(?:spawn)?test\.tsx?`;
const TEST_FILE_RE = new RegExp(`${TEST_FILE_SUFFIX_SRC}$`);

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (TEST_FILE_RE.test(entry.name)) {
      out.push(relative(REPO_ROOT, full));
    }
  }
}

function listDirs(parent: string): string[] {
  try {
    return readdirSync(join(REPO_ROOT, parent), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(parent, e.name));
  } catch {
    return [];
  }
}

// Workspace globs from root package.json: apps/*, packages/*, workers.
const workspaceRoots = [
  ...listDirs("apps"),
  ...listDirs("packages"),
  "workers",
];

const byWorkspace = new Map<string, string[]>();
for (const ws of workspaceRoots) {
  const files: string[] = [];
  walk(join(REPO_ROOT, ws), files);
  if (files.length > 0) byWorkspace.set(ws, files.sort());
}

const workspaceFiles = [...byWorkspace.values()].flat();

// Non-headline buckets, reported for context only.
const extraBuckets = new Map<string, string[]>();
for (const bucket of ["tests", "evals", "scripts"]) {
  const files: string[] = [];
  try {
    statSync(join(REPO_ROOT, bucket));
  } catch {
    continue;
  }
  walk(join(REPO_ROOT, bucket), files);
  if (files.length > 0) extraBuckets.set(bucket, files.sort());
}

const doc = readFileSync(DOC_PATH, "utf8");
const headlineMatch = doc.match(/\*\*Total Test Files:\*\*\s*(\d+)/);
const docCount = headlineMatch ? Number(headlineMatch[1]) : null;

// The doc names files both with and without the `.test.ts(x)` suffix
// (`trades-paired-view-live` (15) vs `email/contacts.test.ts`), so match on
// the stem. Heuristic only — the headline count is the hard contract.
const unmentioned = workspaceFiles.filter((f) => {
  const base = f.split("/").pop() ?? f;
  const stem = base.replace(TEST_FILE_RE, "");
  return !doc.includes(stem);
});

/**
 * RATCHET BASELINE — workspace test files with no mention in TEST-COVERAGE.md
 * at the time the gate was armed (MONEY-1238).
 *
 * ## The hole this closes
 *
 * `yarn test:coverage-check` is BLOCKING in CI (.github/workflows/test.yml),
 * and until now the only thing it could block on was the headline COUNT. So
 * the cheapest way to satisfy it was also the useless way: add a test file,
 * bump "**Total Test Files:** N" by one, never add the row. Green gate, and
 * the doc that CLAUDE.md calls "the single source of truth" says nothing about
 * the file. The unmentioned list was computed on every run and printed as a
 * WARNING nobody had to act on — the same computed-and-dropped shape this
 * ticket is about, sitting inside the freshness gate itself.
 *
 * ## Why a baseline and not a hard fail
 *
 * 149 files were already unmentioned when this was written. A gate that fails
 * on all 149 cannot be turned on, and a gate that cannot be turned on is worth
 * exactly as much as the warning it replaces. So the set below is frozen as
 * accepted debt and the gate fails only on ADDITIONS to it — the house ratchet
 * pattern from `apps/web/__tests__/meta/prisma-null-vs-isset.test.ts`.
 *
 * Every entry was verified tracked in git when captured, so none of them is a
 * file that merely happened to be uncommitted during the run.
 *
 * ## Shrinking it
 *
 * When a file here gains a row in TEST-COVERAGE.md the run prints it as
 * removable. That direction is a WARNING, not a failure, and the asymmetry is
 * deliberate: a wholesale recount of the doc can retire dozens of these at
 * once, and hard-failing on IMPROVEMENT would red-build the very change that
 * improves it. Additions are what silently rot; removals are self-announcing.
 */
const UNMENTIONED_BASELINE: ReadonlySet<string> = new Set([
  "apps/api/__tests__/routes/engagement-p4a-contract.test.ts",
  "apps/api/__tests__/routes/engagement-p4b-contract.test.ts",
  "apps/api/__tests__/routes/market-discover-p3-contract.test.ts",
  "apps/api/__tests__/routes/money1062-hardening-contract.test.ts",
  "apps/api/__tests__/routes/parity-p1a-contract.test.ts",
  "apps/api/__tests__/routes/parity-p1b-contract.test.ts",
  "apps/api/__tests__/routes/parity-p2a-contract.test.ts",
  "apps/api/__tests__/routes/parity-p2b-contract.test.ts",
  "apps/api/__tests__/routes/parity-p3a-contract.test.ts",
  "apps/api/__tests__/routes/parity-p3b-contract.test.ts",
  "apps/api/__tests__/routes/parity-p4a-contract.test.ts",
  "apps/api/__tests__/routes/parity-p4b-contract.test.ts",
  "apps/api/__tests__/routes/parity-p4c-contract.test.ts",
  "apps/api/__tests__/routes/parity-p4d-contract.test.ts",
  "apps/api/__tests__/routes/parity-p4e-contract.test.ts",
  "apps/api/__tests__/routes/portfolio-p2-contract.test.ts",
  "apps/api/__tests__/routes/response-helpers.test.ts",
  "apps/api/__tests__/routes/v1-contract.test.ts",
  "apps/api/__tests__/routes/v1-filters.test.ts",
  "apps/content/__tests__/api/studio-helpers.test.ts",
  "apps/content/__tests__/editor/sideload-logic.test.ts",
  "apps/web/__tests__/actions/broker-token-expiry.test.ts",
  "apps/web/__tests__/actions/custom-strategy.test.ts",
  "apps/web/__tests__/actions/gst-profile-action.test.ts",
  "apps/web/__tests__/actions/saved-screens-helpers.test.ts",
  "apps/web/__tests__/actions/screener-match-score.test.ts",
  "apps/web/__tests__/actions/subscription-entitlement.test.ts",
  "apps/web/__tests__/actions/walkthrough-subtours.test.ts",
  "apps/web/__tests__/analysis/detect-tier.test.ts",
  "apps/web/__tests__/api/demo-end.test.ts",
  "apps/web/__tests__/api/preview-plan-status.test.ts",
  "apps/web/__tests__/api/udf-search.test.ts",
  "apps/web/__tests__/api/udf-symbols.test.ts",
  "apps/web/__tests__/api/udf-time.test.ts",
  "apps/web/__tests__/brokers/base-client-retry.test.ts",
  "apps/web/__tests__/brokers/interactive-brokers-client.test.ts",
  "apps/web/__tests__/chat-tools/intent-mapper-comparison.test.ts",
  "apps/web/__tests__/chat-tools/metadata-fields.test.ts",
  "apps/web/__tests__/chat-tools/tier-classifier-extended.test.ts",
  "apps/web/__tests__/chat/mention-picker-recents.test.ts",
  "apps/web/__tests__/chat/research-preset-resolution.test.ts",
  "apps/web/__tests__/chat/sidebar-grouping.test.ts",
  "apps/web/__tests__/chat/skills-picker-alias-normalization.test.ts",
  "apps/web/__tests__/components/financials-empty-state.test.ts",
  "apps/web/__tests__/components/skeleton-hydration-safe.test.ts",
  "apps/web/__tests__/components/stock-header-responsive.test.ts",
  "apps/web/__tests__/components/terminal-luxe-primitives-extended.test.ts",
  "apps/web/__tests__/core/import/format-detector.test.ts",
  "apps/web/__tests__/core/interactive-brokers-adapter.test.ts",
  "apps/web/__tests__/core/subscription/plan-display.test.ts",
  "apps/web/__tests__/demo/session-edge-cases.test.ts",
  "apps/web/__tests__/fire/chat-parser.test.ts",
  "apps/web/__tests__/gemini/rag-shouldUseRAG.test.ts",
  "apps/web/__tests__/hooks/hooks-shape.test.ts",
  "apps/web/__tests__/market/sparkline-client.test.ts",
  "apps/web/__tests__/market/sparkline-helpers.test.ts",
  "apps/web/__tests__/mf/nav-growth-chart.test.ts",
  "apps/web/__tests__/newsletter/route-newsletter-send.test.ts",
  "apps/web/__tests__/pricing/savings-format.test.ts",
  "apps/web/__tests__/redis/client-cache.test.ts",
  "apps/web/__tests__/research/agent-query-cleaning.test.ts",
  "apps/web/__tests__/research/compare-synthesize.test.ts",
  "apps/web/__tests__/research/compute-accounting-quality.test.ts",
  "apps/web/__tests__/research/compute-comparison-scores.test.ts",
  "apps/web/__tests__/research/compute-constituent-analysis.test.ts",
  "apps/web/__tests__/research/compute-earnings-surprise.test.ts",
  "apps/web/__tests__/research/compute-investment-score.test.ts",
  "apps/web/__tests__/research/db-first-statements.test.ts",
  "apps/web/__tests__/research/executor-progress-emit.test.ts",
  "apps/web/__tests__/research/peer-fallback-chain.test.ts",
  "apps/web/__tests__/research/persistence-fallback.test.ts",
  "apps/web/__tests__/research/skill-cash-flow-quality.test.ts",
  "apps/web/__tests__/research/skill-chart-pattern-detection.test.ts",
  "apps/web/__tests__/research/skill-dcf-valuation-v2.test.ts",
  "apps/web/__tests__/research/skill-dividend-income.test.ts",
  "apps/web/__tests__/research/skill-earnings-deep-dive.test.ts",
  "apps/web/__tests__/research/skill-flows-and-positioning.test.ts",
  "apps/web/__tests__/research/skill-forward-scenarios.test.ts",
  "apps/web/__tests__/research/skill-fundamentals-core.test.ts",
  "apps/web/__tests__/research/skill-governance-flags.test.ts",
  "apps/web/__tests__/research/skill-macro-sensitivities.test.ts",
  "apps/web/__tests__/research/skill-news-sentiment-catalysts.test.ts",
  "apps/web/__tests__/research/skill-quant-factor-scores.test.ts",
  "apps/web/__tests__/research/skill-regime-volatility.test.ts",
  "apps/web/__tests__/research/skill-relative-valuation.test.ts",
  "apps/web/__tests__/research/skill-risk-portfolio-impact.test.ts",
  "apps/web/__tests__/research/skill-technical-trend.test.ts",
  "apps/web/__tests__/research/skills-new.test.ts",
  "apps/web/__tests__/research/task-step-default-expand.test.ts",
  "apps/web/__tests__/research/tickertape-mf-client.test.ts",
  "apps/web/__tests__/roast/deep-diagnostics.test.ts",
  "apps/web/__tests__/roast/format-roast-period.test.ts",
  "apps/web/__tests__/roast/pick-verdict-line.test.ts",
  "apps/web/__tests__/screener/bulk-action-csv.test.ts",
  "apps/web/__tests__/screener/quick-filter-chips.test.ts",
  "apps/web/__tests__/screener/sort-dropdown-helpers.test.ts",
  "apps/web/__tests__/sectors/performance-aggregator.test.ts",
  "apps/web/__tests__/services/credit-reservation.test.ts",
  "apps/web/__tests__/services/mf-nav-propagation.service.test.ts",
  "apps/web/__tests__/services/news-ingest.test.ts",
  "apps/web/__tests__/services/user-logic-unit.test.ts",
  "apps/web/__tests__/services/user-poison-live.test.ts",
  "apps/web/__tests__/settings/tabs-shape.test.ts",
  "apps/web/__tests__/skeletons/page-guard-props.test.ts",
  "apps/web/__tests__/subscription/pending-payment-poll-logic.test.ts",
  "apps/web/__tests__/utils/logger-singleton.test.ts",
  "apps/web/__tests__/workers/processor-investor-rollup-logic.test.ts",
  "apps/web/__tests__/workers/processor-resend-contact-sync.test.ts",
  "packages/core/__tests__/brokers/zerodha-historical-trades.test.ts",
  "packages/core/__tests__/market-data/bond-wdm-trades.test.ts",
  "packages/core/__tests__/market-data/institutional-client-class.test.ts",
  "packages/core/__tests__/market-data/mf-metadata-provider-wired.test.ts",
  "packages/core/__tests__/market-data/shareholding-dual-exchange.test.ts",
  "packages/core/__tests__/market-data/xbrl-valuation.test.ts",
  "packages/database/__tests__/schema-money-1220.test.ts",
  "packages/services/__tests__/alerts-service.test.ts",
  "packages/services/__tests__/broker-diagnostics-logic.test.ts",
  "packages/services/__tests__/consent-service.test.ts",
  "packages/services/__tests__/coupon-status-undo.test.ts",
  "packages/services/__tests__/dashboard-mf-nav-logic.test.ts",
  "packages/services/__tests__/feedback-service.test.ts",
  "packages/services/__tests__/job-service.test.ts",
  "packages/services/__tests__/news-service.test.ts",
  "packages/services/__tests__/paired-logic.test.ts",
  "packages/services/__tests__/parity-p2b-start-flows.service.test.ts",
  "packages/services/__tests__/parity-p3a-paper-portfolio.service.test.ts",
  "packages/services/__tests__/parity-p4a-stock-tabs.service.test.ts",
  "packages/services/__tests__/parity-p4c-services.test.ts",
  "packages/services/__tests__/parity-p4d-discover-market-logic.test.ts",
  "packages/services/__tests__/parity-p4e-subscription-management.service.test.ts",
  "packages/services/__tests__/parity-p4e-user-me.service.test.ts",
  "packages/services/__tests__/persist-broker-connection.test.ts",
  "packages/services/__tests__/pro-entitlement.test.ts",
  "packages/services/__tests__/quiz-service.test.ts",
  "packages/services/__tests__/result-feedback-service.test.ts",
  "packages/services/__tests__/sector-institutional-picks.service.test.ts",
  "packages/services/__tests__/subscription-entitlement-invalidation.test.ts",
  "packages/services/__tests__/trade-import-service.test.ts",
  "packages/trpc/__tests__/routers.test.ts",
  "packages/utils/__tests__/error-sanitization-security.test.ts",
  "workers/__tests__/mf-portfolio-route-only.test.ts",
]);

const isCheck = process.argv.includes("--check");

/**
 * Every gate reports; the process exits ONCE, at the end (MONEY-1238).
 *
 * Each check used to `process.exit(1)` where it stood, so under `--check` the
 * first failure hid every later one. That is not a cosmetic ordering issue: it
 * made the unlisted-files gate below UNREACHABLE in the state it exists for.
 * Add a test file without documenting it and the headline count drifts too, so
 * the count check fires first and exits — the run never reaches the gate that
 * would have named the file. The one configuration where the gate did run was
 * the one where somebody had already bumped the headline by hand, which is a
 * subset of the problem, not the problem.
 *
 * Non-`--check` behaviour is unchanged: everything prints as DRIFT and the exit
 * code stays 0.
 */
let checkFailed = false;

console.log(
  "TEST-COVERAGE.md freshness — file inventory (workspaces = turbo `test` task)",
);
console.log("");
for (const [ws, files] of [...byWorkspace.entries()].sort(
  (a, b) => b[1].length - a[1].length,
)) {
  console.log(`  ${String(files.length).padStart(4)}  ${ws}`);
}
console.log(`  ----`);
console.log(`  ${String(workspaceFiles.length).padStart(4)}  TOTAL on disk`);
console.log(
  `  ${String(docCount ?? NaN).padStart(4)}  TEST-COVERAGE.md headline ("Total Test Files")`,
);
for (const [bucket, files] of extraBuckets) {
  console.log(
    `  ${String(files.length).padStart(4)}  ${bucket}/ (not in headline${bucket === "tests" ? "; env-gated yarn test:full" : ""})`,
  );
}
console.log("");

const unmentionedSet = new Set(unmentioned);
const newlyUnmentioned = unmentioned.filter(
  (f) => !UNMENTIONED_BASELINE.has(f),
);
const retiredFromBaseline = [...UNMENTIONED_BASELINE].filter(
  (f) => !unmentionedSet.has(f),
);

if (unmentioned.length > 0) {
  console.log(
    `${unmentioned.length} workspace test file(s) never mentioned in ` +
      `TEST-COVERAGE.md (${unmentioned.length - newlyUnmentioned.length} ` +
      `accepted by the ratchet baseline, ${newlyUnmentioned.length} NEW):`,
  );
  for (const f of unmentioned) {
    console.log(`  - ${f}${UNMENTIONED_BASELINE.has(f) ? "" : "   <-- NEW"}`);
  }
  console.log("");
}

if (retiredFromBaseline.length > 0) {
  console.log(
    `RATCHET: ${retiredFromBaseline.length} baseline entries are now mentioned ` +
      `in TEST-COVERAGE.md (or no longer exist). Delete these lines from ` +
      `UNMENTIONED_BASELINE in scripts/gen-test-coverage.ts so the accepted ` +
      `debt cannot creep back in under them:`,
  );
  for (const f of retiredFromBaseline) console.log(`  - "${f}",`);
  console.log("");
}

if (docCount === null) {
  console.error(
    'FAIL: could not find the "**Total Test Files:** N" headline in TEST-COVERAGE.md',
  );
  process.exit(1);
}

if (docCount !== workspaceFiles.length) {
  const delta = workspaceFiles.length - docCount;
  console.error(
    `${isCheck ? "FAIL" : "DRIFT"}: TEST-COVERAGE.md says ${docCount} test files; ` +
      `${workspaceFiles.length} exist on disk (${delta > 0 ? "+" : ""}${delta}).`,
  );
  console.error(
    "Update the headline (and the per-file sections for what changed) in TEST-COVERAGE.md — it is the source of truth.",
  );
  checkFailed = true;
} else {
  console.log(`OK: headline matches disk (${docCount} files).`);
}

/*
 * PHANTOM ROWS — a table row naming a test file that no longer exists.
 *
 * The headline count alone does not catch this: deleting two test files and
 * adding two others keeps the total right while the doc still claims 176 cases
 * from files that are gone. That is exactly what happened on MONEY-1093, in the
 * branch whose own thesis is that a counted-but-unexecuted number is dangerous.
 *
 * Cheap and static, unlike the CASE count — a `grep`-style `it(` count
 * undercounts multi-line cases (it undercounted this very batch twice), and
 * counting properly means executing the suite, which this fast check must not do.
 */
const docText = readFileSync(DOC_PATH, "utf8");

// Every test file anywhere in the repo, by BASENAME — including the env-gated
// `tests/` integration tree, which is deliberately outside the headline count
// but is still legitimately referenced by the doc.
const allTestBasenames = new Set<string>();
{
  const found: string[] = [];
  for (const dir of ["packages", "apps", "workers", "tests"]) {
    walk(join(REPO_ROOT, dir), found);
  }
  for (const f of found) allTestBasenames.add(f.replace(/^.*\//, ""));
}

/** Doc placeholder in the maintenance instructions, not a real row. */
const DOC_TEMPLATE = /category\/test-file\.test\.tsx?$/;

/**
 * A line that DOCUMENTS a removal is a historical record, not a coverage claim.
 * The doc deliberately keeps "(removed MONEY-1062 W2) … was 75 tests" entries so
 * the history stays legible; flagging those would push someone to delete the
 * record to satisfy the gate.
 */
/**
 * Prose that documents a removal. Permissive on purpose — a narrative block
 * ("the inline reimplementations were removed and the real source is now
 * exercised by…") is a historical record, and the doc deliberately keeps them so
 * the history stays legible.
 */
const REMOVAL_NOTE = /\b(removed|deleted|superseded|replaced by)\b/i;

/**
 * The STRICT form, required to excuse a table row.
 *
 * A `|`-delimited row is a coverage claim — "this file, this many cases, PASS" —
 * so it must not be waved away by the mere presence of a word. The permissive
 * pattern above was defeated exactly that way: a row reading
 * `| zzz-does-not-exist.test.ts | 999 | PASS (not removed) |` exited 0, because
 * "removed" appears in it, negation and all. Demanding an adjacent ticket
 * reference means excusing a row takes a deliberate, traceable statement rather
 * than an accident of wording.
 */
const REMOVAL_NOTE_STRICT =
  /\bMONEY-\d+\b[^|]*\b(removed|deleted|superseded|replaced by)\b|\b(removed|deleted|superseded|replaced by)\b[^|]*\bMONEY-\d+\b/i;

/**
 * Removal notes are exempted per PARAGRAPH, not per line.
 *
 * The doc's "Deleted shadow files (8)" block opens with "the inline
 * reimplementations were removed" and then lists the eight old names across the
 * next six lines. A per-line check saw the marker only on the first line and
 * flagged all six citation lines — so the honest historical record looked like a
 * set of phantom coverage claims, and the only way to satisfy the gate would
 * have been to delete the record it exists to preserve.
 *
 * A paragraph is a run of contiguous non-blank lines, which is how these notes
 * are actually written.
 */
const REMOVAL_LOOKBACK = 8;

function nearARemovalNote(lines: string[], index: number): boolean {
  // A bounded LOOK-BACK, not whole-paragraph scope.
  //
  // Paragraph scope was the obvious reading and it was far too coarse: the
  // security section is a single 66-line paragraph, and an incidental "deleted"
  // in an unrelated sentence on its 9th line exempted a stale 4-case claim 53
  // lines further down. A removal note in this doc always INTRODUCES the names
  // it is about ("the inline reimplementations were removed … : `a`, `b`, `c`"),
  // and the longest such run is 7 lines, so 8 covers the real cases while
  // keeping an accident far less likely.
  //
  // Still a heuristic. It is the weakest part of this gate, and it is documented
  // as such rather than presented as a proof.
  const start = Math.max(0, index - REMOVAL_LOOKBACK);
  return lines.slice(start, index + 1).some((l) => REMOVAL_NOTE.test(l));
}

const docLines = docText.split("\n");
const phantom: string[] = [];
for (const [i, line] of docLines.entries()) {
  // Table rows are single-line claims and must NOT inherit a neighbour's
  // exemption — a `|`-delimited row sits in the same "paragraph" as the whole
  // table, so paragraph scope would exempt every row in any table that happened
  // to contain the word "removed".
  const exempt = line.trimStart().startsWith("|")
    ? REMOVAL_NOTE_STRICT.test(line)
    : nearARemovalNote(docLines, i);
  if (exempt) continue;
  // Match ANY backticked `*.test.ts(x)` citation, not only paths containing
  // `__tests__/`.
  //
  // Requiring `__tests__/` made the gate blind to the doc's DOMINANT citation
  // style. Measured on the current doc: 717 backticked test paths, of which 551
  // contain `__tests__/` and 166 do NOT — so nearly a quarter of every coverage
  // claim in the file was unreachable, including whole tables (Newsletter,
  // Pub/Sub) that cite bare basenames. Three phantom rows claiming 56 cases for
  // files that do not exist were live with the gate green, and a positive
  // control confirmed the asymmetry: a basename-style row claiming 999 cases
  // exited 0, while the identical row written with `__tests__/` exited 1.
  //
  // Resolution is by basename either way (see `base` below), so widening the
  // match does not weaken the check — it only stops the gate depending on how
  // the author chose to spell the path.
  // The suffix alternation is shared with the walker (`TEST_FILE_SUFFIX_SRC`),
  // so a `.spawntest.ts` row in the doc is checked rather than skipped. Widening
  // the walker alone would have been the worse half of the pair: the file would
  // be COUNTED while a stale citation of it stayed invisible to this gate.
  for (const m of line.matchAll(
    new RegExp(
      `\`([a-z0-9@/._-]*[a-z0-9@._-]+${TEST_FILE_SUFFIX_SRC})\``,
      "gi",
    ),
  )) {
    const cited = m[1]!;
    if (DOC_TEMPLATE.test(cited)) continue;
    const base = cited.replace(/^.*\//, "");
    if (!allTestBasenames.has(base)) phantom.push(cited);
  }
}
const uniquePhantom = [...new Set(phantom)];
if (uniquePhantom.length > 0) {
  console.error(
    `${isCheck ? "FAIL" : "DRIFT"}: TEST-COVERAGE.md names ${uniquePhantom.length} ` +
      `test file(s) that do not exist on disk:`,
  );
  for (const f of uniquePhantom.slice(0, 20)) console.error(`  - ${f}`);
  console.error(
    "Remove the row (and its case count) — a row for a deleted file claims " +
      "coverage that cannot run.",
  );
  checkFailed = true;
}

/*
 * UNLISTED FILES — the ratchet gate (MONEY-1238).
 *
 * Placed LAST so it cannot mask the two contracts above: the headline count and
 * the phantom rows are the harder claims, and a run should report those first.
 *
 * Fails on ADDITIONS to UNMENTIONED_BASELINE only. See that constant for why
 * the removal direction is a warning instead.
 */
if (newlyUnmentioned.length > 0) {
  console.error(
    `${isCheck ? "FAIL" : "DRIFT"}: ${newlyUnmentioned.length} workspace test ` +
      `file(s) exist on disk with no mention anywhere in TEST-COVERAGE.md:`,
  );
  for (const f of newlyUnmentioned.slice(0, 40)) console.error(`  - ${f}`);
  if (newlyUnmentioned.length > 40) {
    console.error(`  … and ${newlyUnmentioned.length - 40} more`);
  }
  console.error(
    "Add a row for each in TEST-COVERAGE.md (the doc is the source of truth — " +
      "CLAUDE.md requires it on every test add/remove/change). Bumping the " +
      "headline count alone satisfies the count check and leaves the file " +
      "undocumented, which is exactly what this gate exists to stop.",
  );
  checkFailed = true;
}

if (isCheck && checkFailed) process.exit(1);
