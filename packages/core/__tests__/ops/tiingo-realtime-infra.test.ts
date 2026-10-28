/**
 * MONEY-1309 T7 — the realtime/news infrastructure agrees with itself.
 *
 * Three files provision this feature and nothing compiles them together:
 *
 *   scripts/ops/gcs-lifecycle.json      deletes raw ticks at 30 days
 *   scripts/ops/sync-prod-to-qa.sh      keeps raw ticks out of QA's bucket
 *   scripts/ops/setup-scheduler.sh      publishes the 24x7 news poll
 *   workers/scripts/setup-pubsub.sh     creates the topic that poll publishes to
 *
 * ## The two failures this exists to catch, and why neither errors
 *
 * 1. ONE RULE, TWO FILES. "the raw ticks live under `feeds/TIINGO/ws/`" is
 *    stated as a lifecycle `matchesPrefix` in one file and as an rsync
 *    `--exclude` regex in another. They are not the same string — the lifecycle
 *    prefix is absolute from the bucket root and the rsync regex is RELATIVE to
 *    the rsync SOURCE — so no grep can keep them equal, and the failure is
 *    silent in both directions:
 *
 *      lifecycle moves, exclusion does not   -> the prefix that gets deleted on
 *                                               prod is not the prefix that is
 *                                               withheld from QA, so QA
 *                                               accumulates ticks nothing reads
 *                                               and nothing ages out.
 *      exclusion moves, lifecycle does not   -> ticks are mirrored into QA and
 *                                               kept there forever.
 *
 *    Neither raises. GCS lifecycle is asynchronous and rsync exits 0 either way.
 *
 * 2. A PREFIX THAT SHORTENS. `feeds/TIINGO/ws/` -> `feeds/` is one deleted path
 *    segment in a diff that looks like tidying, and it is `Delete @ age 30` over
 *    the entire prod->QA feed mirror (66,951 objects at the 2026-08-13 parity
 *    check). Nothing errors; a month later QA's replay starts missing objects
 *    and falls back to scraping the exchange, which is a SOFT failure BY DESIGN
 *    and therefore reports nothing.
 *
 * ## Why the applier's guard is EXECUTED, not grepped
 *
 * The rest of this repo's ops tests read shell as text, because a shell script's
 * entire output is a `gcloud` invocation and `gcloud` is what a test must not
 * run. `setup-gcs-lifecycle.sh` is the exception worth taking: its refusal logic
 * is a self-contained `node -e` program that reads its inputs from ENV and a
 * file and writes a merged policy — it issues no gcloud call of its own. So it
 * can be extracted and RUN against synthetic policies, and "the guard refuses a
 * `feeds/` delete" becomes an observed exit code rather than a regex that agrees
 * with a comment.
 *
 * A text-match version of these cases was written first and thrown away: it
 * passed against a guard whose `every` had been changed to `some`, because the
 * string `REFUSE: ... not scoped` was still in the file.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// packages/core/__tests__/ops -> repo root
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

const LIFECYCLE_SCRIPT = join(ROOT, "scripts/ops/setup-gcs-lifecycle.sh");
const LIFECYCLE_POLICY = join(ROOT, "scripts/ops/gcs-lifecycle.json");
const SYNC_SCRIPT = join(ROOT, "scripts/ops/sync-prod-to-qa.sh");
const SCHEDULER_SCRIPT = join(ROOT, "scripts/ops/setup-scheduler.sh");
const PUBSUB_SCRIPT = join(ROOT, "workers/scripts/setup-pubsub.sh");
const SYNC_JOB_SCRIPT = join(ROOT, "scripts/ops/setup-sync-job.sh");

const read = (p: string): string => readFileSync(p, "utf8");
const lifecycleSrc = read(LIFECYCLE_SCRIPT);
const syncSrc = read(SYNC_SCRIPT);
const schedulerSrc = read(SCHEDULER_SCRIPT);
const pubsubSrc = read(PUBSUB_SCRIPT);
const syncJobSrc = read(SYNC_JOB_SCRIPT);

interface LifecycleRule {
  action?: { type?: string; storageClass?: string };
  condition?: { age?: number; matchesPrefix?: string[] };
}
const policy = JSON.parse(read(LIFECYCLE_POLICY)) as { rule: LifecycleRule[] };

/**
 * Drop whole-line `#` comments before scraping a bash array.
 *
 * Load-bearing, not tidiness: bash honours `#` and a regex does not, so a
 * commented-out row is an ACTIVE entry to every test that scrapes these blocks
 * and a dead one to the script. Same reasoning, same words, as
 * edgar-infra-coverage.test.ts.
 */
const stripBashComments = (s: string): string =>
  s
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

function bashArrayValues(src: string, name: string, where: string): string[] {
  // Both spellings, because this repo uses both: `NAME=(` in scripts/ops and
  // `declare -a NAME=(` in workers/scripts. A regex that knew only one would
  // throw on the other — which is at least loud — but a regex that knew only
  // one and was written with `?` in the wrong place would silently match a
  // DIFFERENT array and compare the wrong list.
  const block = new RegExp(
    `\\n(?:declare -a )?${name}=\\(([\\s\\S]*?)\\n\\)`,
  ).exec(src);
  assert.ok(block, `could not find ${name}=( … ) in ${where}`);
  return [...stripBashComments(block[1]!).matchAll(/"([^"]+)"/g)].map(
    (m) => m[1]!,
  );
}

const allowPrefixes = bashArrayValues(
  lifecycleSrc,
  "ALLOW_PREFIXES",
  "setup-gcs-lifecycle.sh",
);
const protectedRoots = bashArrayValues(
  lifecycleSrc,
  "PROTECTED_ROOTS",
  "setup-gcs-lifecycle.sh",
);
const prodOnlyJobs = bashArrayValues(
  schedulerSrc,
  "PROD_ONLY_JOBS",
  "setup-scheduler.sh",
);
const oldSchedulerPrefixes = bashArrayValues(
  schedulerSrc,
  "OLD_SCHEDULER_PREFIXES",
  "setup-scheduler.sh",
);

/**
 * The `feeds` branch of sync-prod-to-qa.sh's tier switch, on its own.
 *
 * Scoped to the branch rather than the whole file because `GCS_PREFIX_LABEL`
 * and `GCS_EXCLUDE_REGEX` are BOTH assigned twice — once per tier — and a
 * whole-file regex would happily read the `stocks/` label next to the `feeds/`
 * exclusion and call them consistent.
 */
function feedsTierBlock(): string {
  const m = /if \[ "\$TIER" == "feeds" \]; then\n([\s\S]*?)\nelse\n/.exec(
    syncSrc,
  );
  assert.ok(m, "could not find the feeds tier branch in sync-prod-to-qa.sh");
  return m[1]!;
}
function assign(block: string, name: string): string {
  const m = new RegExp(`^\\s*${name}="([^"]*)"`, "m").exec(block);
  assert.ok(m, `${name} is not assigned in the feeds tier branch`);
  return m[1]!;
}

/**
 * Every NON-COMMENT line in the sync script that issues or PRINTS an rsync.
 *
 * The dry-run echo counts as a site: a dry run that prints a command the real
 * run does not issue is the MONEY-1157 stale-copy class, and it is the only
 * thing an operator sees before authorising the mirror.
 */
function rsyncSites(): { line: string; n: number }[] {
  return syncSrc
    .split("\n")
    .map((l, i) => ({ line: l, n: i + 1 }))
    .filter(({ line }) => /gcloud storage rsync/.test(line))
    .filter(({ line }) => !/^\s*#/.test(line));
}

/** The lifecycle rule that deletes the raw ticks. */
const tickRule = policy.rule.find(
  (r) =>
    r.action?.type === "Delete" &&
    (r.condition?.matchesPrefix ?? []).some((p) => p.includes("TIINGO")),
);

/* ═════════════════════════════════════════════════════════════════════════
   Every scan is proved to have read something.

   A regex that silently matches nothing turns each assertion below into a
   comparison of two empty things. That is the documented failure of
   no-feed-fetch-bypass.test.ts, so it gets its own suite here too.
   ════════════════════════════════════════════════════════════════════════ */
describe("MONEY-1309 — the infra scans reach real content", () => {
  it("[meta] every file this suite compares exists", () => {
    for (const p of [
      LIFECYCLE_SCRIPT,
      LIFECYCLE_POLICY,
      SYNC_SCRIPT,
      SCHEDULER_SCRIPT,
      PUBSUB_SCRIPT,
      SYNC_JOB_SCRIPT,
    ]) {
      assert.ok(existsSync(p), `missing: ${p}`);
    }
    // The path arithmetic itself. Four `..` from packages/core/__tests__/ops is
    // easy to get wrong by one, and every read above would then throw with a
    // path rather than a reason.
    assert.ok(
      existsSync(join(ROOT, "package.json")),
      `ROOT resolved to ${ROOT}, which is not the repo root`,
    );
  });

  it("[meta] every extraction found something", () => {
    assert.ok(
      allowPrefixes.length >= 2,
      `ALLOW_PREFIXES: ${allowPrefixes.length}`,
    );
    assert.ok(
      protectedRoots.length >= 3,
      `PROTECTED_ROOTS: ${protectedRoots.length}`,
    );
    assert.ok(
      prodOnlyJobs.length >= 10,
      `PROD_ONLY_JOBS: ${prodOnlyJobs.length}`,
    );
    assert.ok(
      oldSchedulerPrefixes.length >= 5,
      `OLD_SCHEDULER_PREFIXES: ${oldSchedulerPrefixes.length}`,
    );
    assert.ok(
      policy.rule.length >= 3,
      `lifecycle rules: ${policy.rule.length}`,
    );
    assert.ok(
      tickRule,
      "no Delete rule mentioning TIINGO in gcs-lifecycle.json",
    );
    assert.ok(
      feedsTierBlock().length > 50,
      "the feeds tier branch scraped almost nothing",
    );
  });
});

/* ═════════════════════════════════════════════════════════════════════════
   THE AGREEMENT — one rule, two files.
   ════════════════════════════════════════════════════════════════════════ */
describe("MONEY-1309 — the tick prefix is the same in the lifecycle and the mirror", () => {
  it("[regression] the rsync exclusion reconstructs the lifecycle prefix exactly", () => {
    const block = feedsTierBlock();
    const label = assign(block, "GCS_PREFIX_LABEL");
    const regex = assign(block, "GCS_EXCLUDE_REGEX");
    const src = assign(block, "GCS_SRC");

    // The rsync SOURCE and the label must describe the same prefix, or the
    // reconstruction below is arithmetic over unrelated strings.
    assert.ok(
      src.endsWith(`/${label}`),
      `GCS_SRC ${src} does not end with the labelled prefix ${label}`,
    );
    assert.equal(label, "feeds/");

    // MEASURED, SDK 554.0.0, on a four-object local fixture: `--exclude` is a
    // Python regex matched with `re.match` (start-anchored) against the path
    // RELATIVE to SOURCE. `ws/` excluded nothing; `TIINGO/ws/` excluded
    // `TIINGO/ws/…` and left `xTIINGO/ws/…` alone. So the leading `^` is
    // redundant and deliberately kept, and the rest of the pattern must be a
    // LITERAL for this reconstruction to mean anything.
    assert.ok(regex.startsWith("^"), `exclusion ${regex} is not anchored`);
    const literal = regex.slice(1);
    assert.doesNotMatch(
      literal,
      /[\\.*+?()[\]{}|$]/,
      `the exclusion ${regex} contains regex metacharacters, so "prefix + ` +
        `literal" is no longer a sound comparison. If a real pattern is ` +
        `needed here, this test has to compare LANGUAGES, not strings.`,
    );

    const declared = tickRule!.condition!.matchesPrefix!;
    assert.equal(
      declared.length,
      1,
      "the tick rule must carry exactly one prefix; a second one would be " +
        "invisible to this reconstruction",
    );
    assert.equal(
      label + literal,
      declared[0],
      "The prod->QA mirror exclusion and the GCS lifecycle rule disagree " +
        "about where raw ticks live.\n" +
        `  sync-prod-to-qa.sh  ${label} + ${literal}  = ${label + literal}\n` +
        `  gcs-lifecycle.json  ${declared[0]}\n` +
        "They are ONE rule written in two files. Whichever is wrong fails " +
        "silently: rsync exits 0 and GCS lifecycle is asynchronous.",
    );
  });

  it("[regression] the exclusion is applied at EVERY feeds rsync site, from one array", () => {
    // "Apply it at every invocation site" is not a thing a reviewer can hold in
    // their head, so it is a scan: every NON-COMMENT line that names
    // `gcloud storage rsync` must expand GCS_RSYNC_EXCLUDE. That covers the
    // real call AND the dry-run echo — and the echo matters as much, because a
    // dry run that prints a command the real run does not issue is the
    // MONEY-1157 stale-copy class, which this exact file has already paid for
    // once (its GCS_PREFIX_LABEL comment).
    //
    // MONEY-1373 gave the feeds tier a SECOND pair (`candles/`), so this rule
    // now has to say which sites it governs. It is PARTITIONED, not relaxed: a
    // site belongs to the candles pair only by naming `CANDLES_GCS_`, and
    // everything else — including any future third site — must still carry the
    // array. Written this way round on purpose; the alternative ("skip sites
    // that have no exclusion") is a rule that can never fail.
    //
    // MONEY-1478 added a THIRD pair (`tiles/`) on the same terms as candles: it
    // is DERIVED output in a different bucket, and the feeds regex would mean
    // `tiles/TIINGO/ws/` there — a path nobody reasoned about. So the partition
    // grows by one name, and the rule it enforces is unchanged: a site is
    // exempt only by naming its OWN pair's prefix, and anything else must still
    // carry the array.
    const sites = rsyncSites();
    const OWN_PAIR = /CANDLES_GCS_|TILES_GCS_/;
    const candlesSites = sites.filter(({ line }) => /CANDLES_GCS_/.test(line));
    const tilesSites = sites.filter(({ line }) => /TILES_GCS_/.test(line));
    const feedsSites = sites.filter(({ line }) => !OWN_PAIR.test(line));
    assert.ok(
      feedsSites.length >= 2,
      `expected at least the real call and the dry-run echo, found ${feedsSites.length}`,
    );
    const missing = feedsSites.filter(
      ({ line }) => !/GCS_RSYNC_EXCLUDE/.test(line),
    );
    assert.deepEqual(
      missing.map(({ n, line }) => `${n}: ${line.trim()}`),
      [],
      "an rsync invocation does not carry the exclusion array",
    );
    // …and the candles pair carries NO exclusion, which is the other half of
    // the same rule rather than an exemption from it. See the MONEY-1373 suite.
    assert.ok(
      candlesSites.length >= 2,
      `expected the candles real call and its dry-run echo, found ${candlesSites.length}`,
    );
    // The tiles pair, same rule. Asserted POSITIVELY so removing the pair fails
    // here rather than quietly shrinking the partition to nothing.
    assert.ok(
      tilesSites.length >= 2,
      `expected the tiles real call and its dry-run echo, found ${tilesSites.length}`,
    );
    for (const { n, line } of tilesSites) {
      assert.ok(
        !/GCS_RSYNC_EXCLUDE/.test(line),
        `${n}: the tiles pair must carry NO exclusion — the array is relative ` +
          `to its own source, so it would mean tiles/TIINGO/ws/ here`,
      );
    }

    // …and the array is built ONCE, from the regex constant, so the two sites
    // cannot drift into two different patterns.
    assert.match(
      syncSrc,
      /GCS_RSYNC_EXCLUDE=\(--exclude="\$GCS_EXCLUDE_REGEX"\)/,
      "the exclusion array must be built from GCS_EXCLUDE_REGEX, not re-typed",
    );
    // The non-feeds tier gets an EMPTY array, not an empty --exclude=. An empty
    // regex is matched at position 0 of every path, i.e. it excludes the whole
    // transfer — a silent no-op sync that exits 0.
    assert.match(
      syncSrc,
      /GCS_RSYNC_EXCLUDE=\(\)/,
      "the non-feeds tier must pass NO --exclude flag at all",
    );
  });

  it("[regression] the tick prefix is inside the lifecycle allow-list", () => {
    const declared = tickRule!.condition!.matchesPrefix![0]!;
    assert.ok(
      allowPrefixes.some((a) => declared.startsWith(a)),
      `${declared} is not under any ALLOW_PREFIXES entry [${allowPrefixes.join(", ")}]`,
    );
    assert.equal(tickRule!.condition?.age, 30, "raw ticks are kept 30 days");
    // The allow-list may never be widened to a shared root. `feeds/` on the
    // allow-list would make a `Delete @ feeds/` rule legal at LOCK 1; only LOCK
    // 2 would still stop it, and a guard that depends on exactly one lock is a
    // guard one edit from gone.
    for (const a of allowPrefixes) {
      for (const shared of ["feeds/", "candles/", "stocks/"]) {
        assert.ok(
          !shared.startsWith(a),
          `ALLOW_PREFIXES entry "${a}" is at or above the shared root ` +
            `"${shared}" — this script must never be able to own a whole ` +
            `shared prefix`,
        );
      }
    }
  });
});

/* ═════════════════════════════════════════════════════════════════════════
   MONEY-1373 — THE SECOND PAIR: the candle warehouse's cold shards.

   This suite lives here, beside the `feeds/` exclusion, because the two rules
   are ONE arrangement: the feeds tier now moves two prefixes with DIFFERENT
   exclusion policies, and the case above ("every rsync site carries the
   exclusion") can only be written once someone has said which sites are which.
   A second file scraping the same tier block is precisely the drift shape this
   file exists to prevent.

   WHAT WAS BROKEN. `candles/` holds the gzipped-JSONL COLD SHARDS that
   `CandleRepository` merges with its Mongo hot window. The Mongo `candles`
   table is a REFERENCE_COLLECTION and reaches QA by mongorestore; the shards
   reached QA not at all. So QA answered every cold read `absent` — the shape
   of "no data in that range", not of an error — while the synced table claimed
   coverage the shards could not serve. Pre-existing for D1, and widened by
   MONEY-1373's M1/H1 harvest to everything behind the 45-day hot window.
   ════════════════════════════════════════════════════════════════════════ */
describe("MONEY-1373 — the prod->QA mirror covers candles/", () => {
  it("[regression] the feeds tier mirrors candles/ prod -> QA", () => {
    const block = feedsTierBlock();
    const src = assign(block, "CANDLES_GCS_SRC");
    const dst = assign(block, "CANDLES_GCS_DST");
    const label = assign(block, "CANDLES_GCS_PREFIX_LABEL");

    assert.equal(src, "gs://stockbook-content-prod/candles/");
    assert.equal(dst, "gs://stockbook-content-qa/candles/");
    // Direction is the one thing in this script that can never be a
    // preference: prod is READ, qa is WRITTEN.
    assert.ok(src.includes("-prod/"), `${src} is not the prod bucket`);
    assert.ok(dst.includes("-qa/"), `${dst} is not the QA bucket`);
    // The label is derived WHERE THE PATHS ARE CHOSEN (MONEY-1157) — a label
    // set at the call site drifts from the paths it describes, which is how
    // the feeds job's only operator-visible log came to say "stocks/".
    assert.equal(label, "candles/");
    assert.ok(
      src.endsWith(`/${label}`),
      `CANDLES_GCS_SRC ${src} does not end with its own label ${label}`,
    );
  });

  it("[regression] the candles pair carries NO exclude pattern", () => {
    // The raw-tick exclusion is `feeds/`-only, and reusing it here would not be
    // harmless duplication. `--exclude` is matched RELATIVE to SOURCE, so the
    // same regex under `candles/` means `candles/TIINGO/ws/` — a path nobody
    // reasoned about, which would silently drop any shard whose
    // {market}/{timeframe} segments matched it. rsync exits 0 either way, so
    // the loss would surface as a QA range that reads `absent`.
    for (const { n, line } of rsyncSites().filter(({ line }) =>
      /CANDLES_GCS_/.test(line),
    )) {
      assert.doesNotMatch(
        line,
        /--exclude|RSYNC_EXCLUDE/,
        `${n}: the candles rsync must pass no exclusion — ${line.trim()}`,
      );
    }
    // And no exclusion array is DECLARED for it either, so there is nothing
    // sitting in the tier block for a later edit to wire up by accident.
    assert.doesNotMatch(
      feedsTierBlock(),
      /CANDLES_[A-Z_]*EXCLUDE/,
      "the candles pair must not declare an exclusion array",
    );
  });

  it("[regression] the candles pair is both ISSUED and PRINTED", () => {
    // Two lines that can be edited apart. A dry run that prints a pair the real
    // run does not issue — or the reverse — is the MONEY-1157 stale-copy class,
    // and the printed one is the ONLY one an operator or a Cloud Run log sees.
    // Counted by ROLE rather than totalled, because "at least two sites" is
    // also satisfied by two echoes and no rsync at all.
    const sites = rsyncSites().filter(({ line }) => /CANDLES_GCS_/.test(line));
    const printed = sites.filter(({ line }) => /\becho\b/.test(line));
    const issued = sites.filter(({ line }) => !/\becho\b/.test(line));
    assert.equal(
      printed.length,
      1,
      `expected exactly one --dry-run echo for the candles pair, found ${printed.length}`,
    );
    assert.equal(
      issued.length,
      1,
      `expected exactly one real rsync call for the candles pair, found ${issued.length}`,
    );
  });

  it("[regression] the non-feeds tiers mirror no candles at all", () => {
    // `stocks/` is the scraped-PDF mirror and runs DAILY against a different
    // consumer. An unguarded second pair there would mirror the whole candle
    // warehouse on a schedule nobody sized for it.
    const m =
      /if \[ "\$TIER" == "feeds" \]; then\n[\s\S]*?\nelse\n([\s\S]*?)\nfi\n/.exec(
        syncSrc,
      );
    assert.ok(m, "could not find the non-feeds tier branch");
    assert.match(
      m[1]!,
      /CANDLES_GCS_SRC=""/,
      "the non-feeds branch must blank CANDLES_GCS_SRC — the rsync is guarded " +
        "on it being non-empty, and an UNSET variable is the same state by " +
        "accident rather than by declaration",
    );
  });

  it("[regression] setup-sync-job.sh still passes --tier=feeds, and no --tier=candles exists", () => {
    // The feeds TIER covers both prefixes, so the job's args need no change.
    // The failure this guards is the opposite one: a reader adding a third
    // tier that the script rejects, leaving the job exiting 1 every run.
    assert.match(syncJobSrc, /--args="--yes,--tier=feeds"/);
    //
    // Scanned with the comments STRIPPED, and that is not a convenience: both
    // scripts now carry PROSE saying no such tier exists, which is the note
    // this guard wants to keep. bash honours `#` and a regex does not — the
    // same reasoning `stripBashComments` was written for one screen up.
    for (const [name, src] of [
      ["setup-sync-job.sh", syncJobSrc],
      ["sync-prod-to-qa.sh", syncSrc],
    ] as const) {
      assert.doesNotMatch(
        stripBashComments(src),
        /--tier=candles/,
        `${name} names a --tier=candles that does not exist`,
      );
    }
    // The ceiling for that claim: the script's own tier validation.
    assert.match(
      syncSrc,
      /Unknown --tier: \$TIER \(expected 'reference', 'sample', 'feeds' or 'lake'\)/,
      "the tier allow-list moved; the assertion above no longer pins anything",
    );
  });

  it("[regression] --tier=feeds --dry-run prints ALL THREE pairs, and calls no gcloud", () => {
    // EXECUTED, not grepped. The dry-run echo and the real call are two
    // different lines and the scans above compare them as TEXT; this runs the
    // script and reads what an operator would actually see.
    //
    // `gcloud` is stubbed on PATH — the script's preflight requires it to
    // EXIST — and the stub records every invocation, so "the dry run executes
    // nothing" is an observed empty log rather than a promise in a comment.
    const dir = mkdtempSync(join(tmpdir(), "money1373-dryrun-"));
    try {
      const log = join(dir, "gcloud-calls");
      writeFileSync(
        join(dir, "gcloud"),
        `#!/bin/bash\necho "$*" >> "${log}"\nexit 99\n`,
      );
      chmodSync(join(dir, "gcloud"), 0o755);
      const r = spawnSync("bash", [SYNC_SCRIPT, "--tier=feeds", "--dry-run"], {
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      assert.equal(r.status, 0, out);

      const printed = out
        .split("\n")
        .filter((l) => /gcloud storage rsync/.test(l))
        .map((l) => l.trim());
      assert.deepEqual(printed, [
        "gcloud storage rsync -r --exclude=^TIINGO/ws/ " +
          "gs://stockbook-content-prod/feeds/ gs://stockbook-content-qa/feeds/",
        "gcloud storage rsync -r " +
          "gs://stockbook-content-prod/candles/ gs://stockbook-content-qa/candles/",
        // MONEY-1478 — the THIRD pair, and the only one in the lake bucket.
        // ORDER IS ASSERTED, not just membership: the dry run must print the
        // commands in the sequence the real run issues them, or the preview is
        // a different plan from the execution.
        "gcloud storage rsync -r " +
          "gs://stockbook-lake-prod/tiles/ gs://stockbook-lake-qa/tiles/",
      ]);

      assert.ok(
        !existsSync(log),
        `--dry-run invoked gcloud: ${existsSync(log) ? readFileSync(log, "utf8") : ""}`,
      );
    } finally {
      // A test that leaves a temp tree behind is a test that orphans.
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ═════════════════════════════════════════════════════════════════════════
   THE APPLIER'S GUARD, EXECUTED.
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Lift the `node -e '…'` program out of setup-gcs-lifecycle.sh.
 *
 * It is a single-quoted shell string, so the JS inside it must never contain an
 * apostrophe — that is a constraint on the SCRIPT, and this extraction is what
 * enforces it: an apostrophe would terminate the string early and the assertion
 * below on the program's own markers would fail.
 */
function extractGuard(): string {
  const m = /node -e '\n([\s\S]*?)\n\s*'\n\s*\)"/.exec(lifecycleSrc);
  assert.ok(m, "could not lift the node guard out of setup-gcs-lifecycle.sh");
  const js = m[1]!;
  // Falsifiable floor. Without these, a regex that grabbed the wrong span (or a
  // one-line program) would still "run" and every exit code below would be
  // measuring something else.
  for (const marker of [
    "const isOwned",
    "const sweeps",
    "ALLOW_PREFIXES_NL",
    "PROTECTED_ROOTS_NL",
    "process.exit(same ? 2 : 0)",
  ]) {
    assert.ok(js.includes(marker), `the extracted guard has no \`${marker}\``);
  }
  return js;
}

interface GuardRun {
  status: number;
  out: string;
  merged: string | null;
}

/**
 * Run the guard against a synthetic bucket + policy.
 *
 * `LIVE_JSON` stands in for `gcloud storage buckets describe --format=json`.
 * The guard makes no network call, so nothing here is mocked — this is the real
 * program, on real inputs, reporting its real exit code.
 */
function runGuard(opts: {
  policy: unknown;
  live?: unknown;
  allow?: string[];
  protectedRoots?: string[];
}): GuardRun {
  const dir = mkdtempSync(join(tmpdir(), "money1309-lifecycle-"));
  try {
    const guardPath = join(dir, "guard.cjs");
    const policyPath = join(dir, "policy.json");
    const mergedPath = join(dir, "merged.json");
    writeFileSync(guardPath, extractGuard());
    writeFileSync(policyPath, JSON.stringify(opts.policy));
    const r = spawnSync(process.execPath, [guardPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        LIVE_JSON: JSON.stringify(
          opts.live ?? { name: "stockbook-content-prod" },
        ),
        POLICY_FILE: policyPath,
        BUCKET: "stockbook-content-prod",
        MERGED_FILE: mergedPath,
        ALLOW_PREFIXES_NL: (opts.allow ?? allowPrefixes).join("\n"),
        PROTECTED_ROOTS_NL: (opts.protectedRoots ?? protectedRoots).join("\n"),
      },
    });
    return {
      status: r.status ?? -1,
      out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
      merged: existsSync(mergedPath) ? readFileSync(mergedPath, "utf8") : null,
    };
  } finally {
    // A test that leaves a temp tree behind is a test that orphans.
    rmSync(dir, { recursive: true, force: true });
  }
}

const DELETE_AT = (prefix: string): unknown => ({
  action: { type: "Delete" },
  condition: { age: 30, matchesPrefix: [prefix] },
});

describe("MONEY-1309 — the lifecycle applier refuses a prefix that shortened", () => {
  it("[premise] it ACCEPTS the policy we actually ship", () => {
    // Without this, every refusal below is satisfied by a guard that refuses
    // everything — which is safe and useless, and would go unnoticed because
    // nobody runs this script daily.
    const r = runGuard({ policy });
    assert.equal(r.status, 0, `the real policy was refused:\n${r.out}`);
    assert.ok(r.merged, "no merged policy was written");
    const merged = JSON.parse(r.merged!) as { rule: LifecycleRule[] };
    assert.equal(merged.rule.length, policy.rule.length);
  });

  it("[regression] `feeds/TIINGO/ws/` shortened to `feeds/` is REFUSED", () => {
    // THE case. One deleted path segment = Delete @ 30 over the whole prod->QA
    // mirror.
    const r = runGuard({ policy: { rule: [DELETE_AT("feeds/")] } });
    assert.equal(r.status, 1, `a Delete on feeds/ was ACCEPTED:\n${r.out}`);
  });

  it("[regression] every intermediate shortening is REFUSED too", () => {
    // Not decoration: `feeds/TIINGO/` is the shortening a half-finished edit
    // produces, and `feeds/TIINGO/ws` (no trailing slash) is the one that looks
    // identical and silently also matches `feeds/TIINGO/wsanything`.
    for (const p of ["feeds/TIINGO/", "feeds/TIINGO/ws", "feeds", "fe", ""]) {
      const r = runGuard({ policy: { rule: [DELETE_AT(p)] } });
      assert.equal(
        r.status,
        1,
        `a Delete on ${JSON.stringify(p)} was ACCEPTED:\n${r.out}`,
      );
    }
  });

  // LOCK 2 IS DOCUMENTED AS INDEPENDENT OF THE ALLOW-LIST, and until now every
  // case above proved only LOCK 1: with the shipped allow-list
  // (`edgar/`, `feeds/TIINGO/ws/`) a Delete on `feeds/TIINGO/` is refused for
  // not being allow-listed, which says nothing about the sweep guard. These
  // cases WIDEN the allow-list so LOCK 1 passes and only LOCK 2 can refuse —
  // the exact scenario the guard claims to survive, and the one in which three
  // destructive rules were measured passing.
  const WIDE = ["edgar/", "feeds/", "candles/"];

  it("[lock2] a Delete INSIDE a protected root is refused even when allow-listed", () => {
    // `"feeds/".startsWith("feeds/TIINGO/")` is FALSE, so the upward-only test
    // let this through. `feeds/TIINGO/` is not tick-only — it also holds the US
    // instrument master, corporate actions, news and the EOD archives.
    const r = runGuard({
      policy: { rule: [DELETE_AT("feeds/TIINGO/")] },
      allow: WIDE,
    });
    assert.equal(r.status, 1, `a Delete INSIDE feeds/ was ACCEPTED:\n${r.out}`);
    assert.match(r.out, /INSIDE the protected root/);
  });

  it("[lock2] SetStorageClass to ARCHIVE over a protected root is refused", () => {
    // Not a delete, but ARCHIVE bills a 365-DAY minimum even for an object
    // deleted tomorrow, plus the highest retrieval fee — pointed at `candles/`,
    // which is read on a request path. LOCK 2 skipped the action entirely.
    const r = runGuard({
      policy: {
        rule: [
          {
            action: { type: "SetStorageClass", storageClass: "ARCHIVE" },
            condition: { age: 30, matchesPrefix: ["candles/"] },
          },
        ],
      },
      allow: WIDE,
    });
    assert.equal(r.status, 1, `ARCHIVE over candles/ was ACCEPTED:\n${r.out}`);
  });

  it("[lock2] but NEARLINE tiering is allowed — colder is not uniformly worse", () => {
    // The other direction, and it is load-bearing: sweeping ALL of
    // SetStorageClass into the destructive set refused the NEARLINE tiering of
    // `edgar/filings/` that we deliberately ship. Every GCS class serves first
    // bytes in milliseconds; what ARCHIVE changes is the minimum storage
    // duration and the retrieval fee.
    const r = runGuard({
      policy: {
        rule: [
          {
            action: { type: "SetStorageClass", storageClass: "NEARLINE" },
            condition: { age: 30, matchesPrefix: ["edgar/filings/"] },
          },
        ],
      },
      allow: WIDE,
    });
    assert.equal(
      r.status,
      0,
      `the shipped NEARLINE rule was REFUSED:\n${r.out}`,
    );
  });

  it("[lock2] a lowercase action type does not slip past the literal test", () => {
    // The GCS API is expected to reject this, but a guard that leans on
    // validation it does not own is not a guard.
    const r = runGuard({
      policy: {
        rule: [
          {
            action: { type: "delete" },
            condition: { age: 30, matchesPrefix: ["feeds/"] },
          },
        ],
      },
      allow: WIDE,
    });
    assert.equal(r.status, 1, `a lowercase delete was ACCEPTED:\n${r.out}`);
  });

  it("[lock2] the narrow tick rule stays allowed under a widened allow-list", () => {
    // The escape hatch must actually work, or the guard is just a wall.
    const r = runGuard({
      policy: { rule: [DELETE_AT("feeds/TIINGO/ws/")] },
      allow: WIDE,
    });
    assert.equal(
      r.status,
      0,
      `the legitimate tick rule was REFUSED:\n${r.out}`,
    );
  });

  it("[regression] a rule with NO prefix is REFUSED", () => {
    const r = runGuard({
      policy: {
        rule: [{ action: { type: "Delete" }, condition: { age: 30 } }],
      },
    });
    assert.equal(r.status, 1, `an unscoped Delete was ACCEPTED:\n${r.out}`);
  });

  it("[regression] ONE allow-listed prefix does not launder a rule's OTHER prefixes", () => {
    // `matchesPrefix` is a LIST, and LOCK 1 quantifies over it with `every`.
    // This case exists because the obvious weakening — `every` -> `some` — was
    // MEASURED green against every other assertion in this file: each of them
    // uses a single-prefix rule, so the two quantifiers are indistinguishable.
    //
    // SetStorageClass rather than Delete, deliberately: LOCK 2 only inspects
    // Delete rules, so a Delete here would be caught by the wrong lock and this
    // case would prove nothing about LOCK 1. And a Nearline transition on
    // `candles/` is not a hypothetical harm — those shards are read ON THE
    // REQUEST PATH by CandleRepository, so it puts a retrieval charge on a
    // user-facing read, which is exactly what gcs-lifecycle.json's own
    // "NOT covered here, deliberately" note says never to do.
    const r = runGuard({
      policy: {
        rule: [
          {
            action: { type: "SetStorageClass", storageClass: "NEARLINE" },
            condition: {
              age: 30,
              matchesPrefix: ["edgar/bulk/", "candles/"],
            },
          },
        ],
      },
    });
    assert.equal(
      r.status,
      1,
      "a rule carrying one allow-listed prefix and one foreign prefix was " +
        `ACCEPTED — LOCK 1 must quantify with \`every\`, not \`some\`:\n${r.out}`,
    );
  });

  it("[regression] LOCK 2 survives a WIDENED allow-list", () => {
    // The whole reason PROTECTED_ROOTS is a second, independent list. If the
    // only guard were allow-list membership, then editing the allow-list —
    // which is a one-line change in the same file, and reads as configuration
    // rather than as a safety boundary — would legalise the catastrophe.
    const r = runGuard({
      policy: { rule: [DELETE_AT("feeds/")] },
      allow: ["edgar/", "feeds/"],
    });
    assert.equal(
      r.status,
      1,
      `with feeds/ allow-listed, a Delete on feeds/ was ACCEPTED:\n${r.out}`,
    );
    assert.match(r.out, /protected root/i);
  });

  it("[regression] `Delete @ edgar/` is REFUSED — it would take the SEC archive", () => {
    // Allow-listed and therefore INVISIBLE to LOCK 1: "edgar/".startsWith(
    // "edgar/") is true. It is also invisible to the older
    // "edgar/filings must never be deleted" assertion next door, which looks
    // for a prefix STARTING WITH edgar/filings/. This hole existed for two
    // releases and is closed by PROTECTED_ROOTS holding `edgar/filings/`.
    const r = runGuard({ policy: { rule: [DELETE_AT("edgar/")] } });
    assert.equal(r.status, 1, `a Delete on edgar/ was ACCEPTED:\n${r.out}`);
  });

  it("[regression] an empty PROTECTED_ROOTS fails CLOSED", () => {
    // The fail-open direction. An empty ALLOW list refuses everything (loud and
    // safe); an empty PROTECTED list would silently remove LOCK 2 and leave the
    // run looking entirely normal.
    const r = runGuard({
      policy: { rule: [DELETE_AT("feeds/")] },
      allow: ["edgar/", "feeds/"],
      protectedRoots: [],
    });
    assert.equal(r.status, 1);
    assert.match(r.out, /PROTECTED_ROOTS reached node without/);
  });

  it("[regression] MERGE, not replace: an unowned live rule survives", () => {
    // The property the whole script exists for. A live rule outside the
    // allow-list must be carried into the merged policy untouched — an apply
    // that dropped it would silently un-tier the learning content or un-age the
    // bulk zips, over the following weeks.
    const r = runGuard({
      policy,
      live: {
        name: "stockbook-content-prod",
        lifecycle_config: {
          rule: [
            {
              action: { type: "SetStorageClass", storageClass: "COLDLINE" },
              condition: { age: 365, matchesPrefix: ["learning/"] },
            },
          ],
        },
      },
    });
    assert.equal(r.status, 0, r.out);
    const merged = JSON.parse(r.merged!) as { rule: LifecycleRule[] };
    const prefixes = merged.rule.flatMap(
      (x) => x.condition?.matchesPrefix ?? [],
    );
    assert.ok(
      prefixes.includes("learning/"),
      `the unowned learning/ rule was dropped: ${prefixes.join(", ")}`,
    );
    assert.equal(merged.rule.length, policy.rule.length + 1);
  });

  it("[regression] a describe blob that names another bucket is REFUSED", () => {
    // Pre-existing property, re-asserted here because it is now exercised
    // rather than grepped: any JSON at all must not read as "no rules".
    const r = runGuard({
      policy,
      live: { name: "some-other-bucket" },
    });
    assert.equal(r.status, 1);
    assert.match(r.out, /does not name stockbook-content-prod/);
  });
});

/* ═════════════════════════════════════════════════════════════════════════
   THE 24x7 NEWS POLL.
   ════════════════════════════════════════════════════════════════════════ */
describe("MONEY-1309 — the news poll is scheduled 24x7 and has a topic", () => {
  const ENTRY = "tiingo-news-poll";
  const rows = [
    ...schedulerSrc.matchAll(
      new RegExp(
        `^\\s*"(${ENTRY})\\|([^|]+)\\|([a-z0-9-]+)\\|([^|]*)\\|([^"]*)"`,
        "gm",
      ),
    ),
  ];

  it("[meta] exactly one scheduler row defines it", () => {
    // Two rows publishing to one topic is not redundancy, it is two runs of the
    // same job at two cadences against one metered quota.
    assert.equal(rows.length, 1, `found ${rows.length} rows for ${ENTRY}`);
  });

  it("[regression] every 2 minutes, on ALL SEVEN DAYS", () => {
    const [, , schedule, topic, message] = rows[0]!;
    assert.equal(schedule, "*/2 * * * *");

    // The day fields, asserted by POSITION rather than by comparing the whole
    // string a second time. This is the actual content of the ticket: the US
    // price jobs carry `2-6` because a US session closes 4:00 PM ET and lands
    // after midnight IST — a fact about the EXCHANGE CALENDAR. News has none.
    // An 8-K drops on a Sunday.
    const fields = schedule!.trim().split(/\s+/);
    assert.equal(fields.length, 5, `not a 5-field cron: ${schedule}`);
    assert.equal(fields[2], "*", "day-of-month must be * (every day)");
    assert.equal(fields[4], "*", "day-of-week must be * (all seven days)");
    assert.notEqual(
      fields[4],
      "2-6",
      "this must not inherit the US market cron",
    );

    // The route path IS the topic base name (setup-pubsub.sh builds the push
    // endpoint as ${URL}/jobs/${BASE_TOPIC}), so these two being equal is a
    // wiring fact, not a naming convention.
    assert.equal(topic, ENTRY);
    assert.equal(
      message,
      "{}",
      "empty payload: the page size and lookback are constants in the " +
        "worker's logic module, and a number here is a second copy this file " +
        "cannot fail on when it drifts (MONEY-1255)",
    );
  });

  it("[regression] the description fits Cloud Scheduler's 500-char cap", () => {
    // A cap this repo has hit before. Checked for EVERY row, not just the new
    // one, because the expensive version of this failure is `gcloud scheduler
    // jobs create` rejecting an unrelated job in the same pass.
    //
    // NOTE the joint budget for an OVERRIDDEN row: setup-scheduler.sh builds
    // EFF_DESC as `DESC + ~44 chars of scaffolding + WHY`, so a row that also
    // has an ENV_SCHEDULE_OVERRIDES entry has less than 500 to itself. This
    // entry has no override, so DESC is the whole of it.
    const defs = /\nSCHEDULER_DEFS=\(([\s\S]*?)\n\)/.exec(schedulerSrc);
    assert.ok(defs, "could not find SCHEDULER_DEFS");
    const all = [...defs[1]!.matchAll(/^\s*"([^"]+)"\s*$/gm)].map((m) =>
      m[1]!.split("|"),
    );
    assert.ok(all.length >= 30, `SCHEDULER_DEFS rows parsed: ${all.length}`);
    const over = all
      .filter((p) => (p[4] ?? "").length > 500)
      .map((p) => `${p[0]} (${(p[4] ?? "").length})`);
    assert.deepEqual(over, [], "description(s) over Cloud Scheduler's cap");
    assert.ok(
      all.some((p) => p[0] === ENTRY),
      `${ENTRY} is not among the parsed SCHEDULER_DEFS rows`,
    );
  });

  it("[regression] it is PROD_ONLY, and QA is fed by copy instead", () => {
    // 720 runs a day. A QA copy makes it 1,440 against ONE Tiingo account
    // quota, and `tiingo-pacer.ts` state is MODULE SCOPE — shared inside one
    // process and with nothing across processes — so the two envs would pace
    // independently to 2x the ceiling on an API that publishes no
    // remaining-quota header and signals the wall only with a 429.
    assert.ok(
      prodOnlyJobs.includes(ENTRY),
      `${ENTRY} must be in PROD_ONLY_JOBS`,
    );
    // …and prod-only is only defensible because QA RECEIVES the rows. Without
    // this half, "prod-only" is just "QA has no news".
    //
    // THE TABLE IS `us_news_articles`, NOT `us_stock_news`. This assertion
    // named the second one on the first pass and passed — `us_stock_news` is in
    // REFERENCE_COLLECTIONS for `us-eod-sync` leg (f), so the check was green
    // while proving nothing about THIS job. The poller has its own model
    // (`UsNewsArticle`, keyed on Tiingo's `tiingoId`), and the sibling guard
    // `prod-only-sync-coverage.test.ts` is what actually caught it.
    const refs = bashArrayValues(
      syncSrc,
      "REFERENCE_COLLECTIONS",
      "sync-prod-to-qa.sh",
    );
    assert.ok(refs.length >= 20, `REFERENCE_COLLECTIONS: ${refs.length}`);
    assert.ok(
      refs.includes("us_news_articles"),
      "us_news_articles must be in REFERENCE_COLLECTIONS — it is the only " +
        "path by which QA gets the articles a prod-only poll fetches",
    );
    // The WATERMARK must NOT be synced. Copying it would move QA's window past
    // articles no QA run ever wrote — the `us_edgar_cursor` refusal, and the
    // one combination that manufactures a healthy-looking empty run.
    assert.ok(
      !refs.includes("us_news_cursor"),
      "us_news_cursor is operational watermark state and must never be " +
        "restored into QA (see QA_DIRECT in prod-only-sync-coverage.test.ts)",
    );
  });

  it("[regression] it is NOT in OLD_SCHEDULER_PREFIXES", () => {
    // Nothing is being renamed. A name listed there is DELETED on every run of
    // setup-scheduler.sh, in every env — so a speculative entry is how a live
    // job gets removed by a script that was only meant to tidy up.
    assert.ok(
      !oldSchedulerPrefixes.includes(ENTRY),
      `${ENTRY} is in OLD_SCHEDULER_PREFIXES, which DELETES it on every run`,
    );
  });

  it("[regression] the topic is created AND given a push subscription", () => {
    // A scheduler row publishing into a topic nothing creates fails inside
    // Cloud Scheduler, where nobody is looking. A topic with no push
    // subscription is a message queue nothing drains.
    for (const arrayName of ["BASE_TOPICS", "BASE_WORKER_TOPICS"]) {
      const topics = bashArrayValues(
        pubsubSrc,
        arrayName,
        "workers/scripts/setup-pubsub.sh",
      );
      assert.ok(topics.length >= 30, `${arrayName}: ${topics.length}`);
      assert.ok(
        topics.includes(ENTRY),
        `${ENTRY} is missing from ${arrayName} in setup-pubsub.sh`,
      );
    }
    // gcp-setup.sh keeps its OWN copy of the topic list for a cold-project
    // bootstrap. It is documented as such in that file; a topic missing there
    // means a fresh project gets a Scheduler trigger publishing into nothing.
    const bootstrap = bashArrayValues(
      read(join(ROOT, "workers/scripts/gcp-setup.sh")),
      "BASE_TOPICS",
      "workers/scripts/gcp-setup.sh",
    );
    assert.ok(
      bootstrap.length >= 20,
      `gcp-setup BASE_TOPICS: ${bootstrap.length}`,
    );
    assert.ok(
      bootstrap.includes(ENTRY),
      `${ENTRY} is missing from gcp-setup.sh's bootstrap topic list`,
    );
  });
});
