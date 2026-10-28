/**
 * A PROD_ONLY writer's table must reach QA — MONEY-1196.
 *
 * FOUR instances of one bug were found by hand, one per ticket, each spotted
 * sideways by someone working on something else:
 *
 *   shareholding_patterns  MONEY-1098 P5.4
 *   index_memberships      MONEY-1189
 *   institutional_flows    MONEY-1108   (caught while building the feature)
 *   stock_flags            MONEY-1196   (prod 7,527,076 rows, QA 0)
 *
 * Identical shape every time: a Prisma model whose ONLY writer is a worker
 * processor whose scheduler entry sits in `PROD_ONLY_JOBS`, while the collection
 * is absent from `REFERENCE_COLLECTIONS` in `scripts/ops/sync-prod-to-qa.sh`.
 * QA then has no writer AND no sync, so the table silently stops moving — no
 * error, no counter, nothing to notice.
 *
 * It is durable because it is invisible at the moment anyone would check: the
 * `index_memberships` case had prod and QA at exactly 924 rows on the day a
 * backfill seeded both. Perfect parity, still broken, because only one side had
 * a writer going FORWARD. Any check that samples state passes it. So this asks
 * the structural question instead — "what advances this table tomorrow?"
 *
 * Four manual catches is the point at which a rule belongs in a test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** CWD is packages/core when this suite runs. */
const ROOT = join(process.cwd(), "..", "..");
const SCHEDULER = join(ROOT, "scripts", "ops", "setup-scheduler.sh");
const SYNC = join(ROOT, "scripts", "ops", "sync-prod-to-qa.sh");
const SCHEMA = join(ROOT, "packages", "database", "prisma", "schema.prisma");
const PROCESSORS = join(ROOT, "workers", "src", "processors");

/**
 * Collections QA maintains ITSELF and must never receive from prod.
 *
 * Each needs a reason, not just an entry: an exemption list without them rots
 * into an allowlist that hides the next instance — which is exactly how this
 * bug survived four tickets.
 */
const QA_DIRECT: Record<string, string> = {
  instrument_mappings:
    "QA mints its own instrument _ids; the Kite dump is public and unmetered so QA fetches it directly (MONEY-855).",
  daily_prices:
    "Keys on instrumentId, a FK into QA's own instrument_mappings — a copy would point at prod's ObjectIds.",
  latest_quotes: "Same instrumentId FK problem as daily_prices.",
  intraday_bars: "Same instrumentId FK problem as daily_prices.",
  stock_profiles: "Same instrumentId FK problem as daily_prices.",
  market_data_sync_logs:
    "Environment-specific by definition — it records what THIS env's runs did.",
  feed_backfill_progress: "Per-environment checkpoint state.",
  // MONEY-979. NOT an FK problem — a deliberate refusal to copy operational
  // state. `us_edgar_cursor` holds the SEC detection watermark (last accession
  // seen, last acceptance timestamp) and the bulk-file Last-Modified/ETag
  // marks. Restoring prod's watermark into QA would make any QA detect run skip
  // every filing prod has already seen and then report a clean, healthy,
  // entirely empty run — the exact shape MONEY-1211/1236 are instances of. QA
  // starts from an empty cursor, which is correct: QA does not fetch from SEC
  // at all (SEC_EGRESS=off).
  us_edgar_cursor:
    "Operational detection state, not reference data — prod's watermark would make a QA run skip everything prod has seen and report a healthy empty run (MONEY-979).",
  // MONEY-1309. The 24x7 Tiingo news poller's watermark, exempted for exactly
  // the reason above it and NOT for a new one. `us_news_cursor` holds
  // `lastCrawlDate` (the newest crawl time this job has WRITTEN) plus a
  // liveness stamp; restoring prod's into QA would move QA's window past
  // articles a QA run never stored.
  //
  // Its SIBLING is synced: `us_news_articles` IS in REFERENCE_COLLECTIONS,
  // because the articles are reference data and carry no ObjectId reference.
  // Splitting the pair this way is the point — QA gets the DATA and starts from
  // an empty WATERMARK, which is the only combination that cannot manufacture a
  // healthy-looking empty run.
  us_news_cursor:
    "Operational watermark, not reference data — prod's lastCrawlDate would move QA's window past articles no QA run ever wrote. Its data table `us_news_articles` IS synced (MONEY-1309).",
  // MONEY-1198. This one IS genuinely QA-direct, and it is the only one of
  // feed-parse's eight models that survived the audit as such. `bhavcopy-sync`
  // is a worker processor and is NOT in PROD_ONLY_JOBS, so QA runs it and
  // writes index_closes itself. Verified against the LIVE scheduler rather
  // than inferred: `bhavcopy-sync-daily-qa` exists and is ENABLED.
  index_closes:
    "Written by bhavcopy-sync, a worker processor NOT in PROD_ONLY_JOBS — QA runs it and writes this itself (bhavcopy-sync-daily-qa verified ENABLED on the live scheduler, MONEY-1198).",
};

/**
 * QA genuinely has NO copy of these, and that is an accepted, tracked decision —
 * not a claim that QA feeds itself.
 *
 * This category exists because of what MONEY-1198 found. `derivative_eod` and
 * `derivative_summary` were sitting in QA_DIRECT under the reasons
 *
 *   "Pruned to a rolling window and re-derived from the GCS archive; QA replays
 *    the same bytes."
 *   "Derived from derivative_eod, same reasoning."
 *
 * Both are FALSE. The re-derivation they name is `feed-parse` / `fo-summary`,
 * whose nightly triggers are created only when ENV=prod — the very same
 * if-block that left `market_positioning` empty. QA does not re-derive anything.
 *
 * The distinction is the whole point. QA_DIRECT means "QA writes this itself",
 * which is a statement that can be checked and, here, was wrong. Folding a real
 * gap into that list would launder it into an exemption and retire the signal —
 * which is exactly the failure this suite exists to catch, committed by the
 * suite itself. So a gap is recorded AS a gap, with the reason it is tolerated
 * and the ticket that would close it.
 *
 * Why tolerated: derivative_eod is tens of millions of rows even after the
 * pre-2018 stock-F&O trim (69.0M rows deleted, 2026-08-11), so a nightly
 * mongodump/mongorestore of it prod -> QA is not a reasonable sync. The real
 * remedy is to give QA its own feed-parse-nightly / fo-summary-nightly trigger
 * now that the feeds/ mirror is live (2026-08-12) — which is a change to QA's
 * nightly cost and behaviour, and therefore its own decision.
 */
const ACCEPTED_GAP: Record<string, string> = {
  // MONEY-1314. This was a QA_DIRECT exemption until the parse lane was
  // retired, and its own comment said what to do: "If that QA trigger is ever
  // removed, this exemption becomes FALSE and the collection silently stops
  // moving on QA — delete the entry here in the same change, so the guard
  // fires instead of the data quietly freezing." It has been deleted, and the
  // gap is recorded AS a gap rather than laundered into an exemption.
  //
  // Why QA has no writer: `stock-document-parse-{daily,morning,midday,evening}`
  // are all in OLD_SCHEDULER_PREFIXES, and the replacement lane
  // `stock-document-ingest` has NO cron at all — it is announced at store time
  // and gated by DOC_INGEST_REALTIME, which ships "false" in both envs.
  //
  // Why it CANNOT simply be added to REFERENCE_COLLECTIONS, which is the
  // obvious fix and is wrong: `DocumentFinancialExtract.instrumentId` is a
  // REQUIRED relation to `InstrumentMapping`, and `instrument_mappings` is
  // QA-DIRECT — QA holds its own ObjectIds. Copied rows would carry prod's
  // instrument ids, and a dangling REQUIRED relation THROWS on read, blanking
  // every result rather than degrading. (`stock_documents` IS mirrored, so
  // `documentId` would resolve; `instrumentId` would not.)
  //
  // Two ways to close it, both deliberate decisions rather than side effects:
  // arm DOC_INGEST_REALTIME in QA (cheap — a trickle of new documents, not a
  // nightly batch), or run `doc-ingest-backfill` against QA.
  document_financial_extracts:
    "No QA writer: the parse lane is retired and the ingest lane ships disarmed (DOC_INGEST_REALTIME=false). NOT mirrorable — instrumentId is a REQUIRED relation to QA-DIRECT instrument_mappings, so copied rows would dangle and throw. Close by arming DOC_INGEST_REALTIME in QA or running doc-ingest-backfill there — MONEY-1314.",
  derivative_eod:
    "No QA writer: feed-parse's nightly trigger is prod-only. Too large to mirror (tens of millions of rows post-trim). Close by giving QA its own feed-parse-nightly trigger — MONEY-1198.",
};

/**
 * Strip bash `#` comments, respecting quotes.
 *
 * Not optional. `readBashArray` used to regex `"([^"]+)"` over the raw slice,
 * so it harvested every double-quoted string in the ~226 lines of PROSE inside
 * these arrays — bash saw 32 entries in `REFERENCE_COLLECTIONS`, the parser saw
 * 36. Four phantoms, lifted out of sentences discussing collection names.
 *
 * Nothing collided while the phantoms happened to be names that were synced
 * anyway. The failure it sets up is the dangerous direction: write one comment
 * saying a collection is handled, and the guard reads it as PRESENT and stops
 * reporting it, while `mongorestore` — which reads the real array — never
 * copies it. A test that agrees with a comment instead of the code is not a
 * test. Note the asymmetry that made this easy to miss: the TypeScript side of
 * this same file has always stripped comments.
 */
function stripBashComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === "#") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

/** Read a bash array literal, e.g. `NAME=( "a" "b" )`, ignoring comments. */
function readBashArray(src: string, name: string): string[] {
  const start = src.indexOf(`${name}=(`);
  assert.ok(start >= 0, `${name} not found — did the script get restructured?`);
  const end = src.indexOf("\n)", start);
  assert.ok(end > start, `${name} has no closing paren`);
  const body = stripBashComments(src.slice(start, end));
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

/** model name -> @@map collection name, from the Prisma schema. */
function readModelMap(schema: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  for (const m of schema.matchAll(re)) {
    const mapped = /@@map\("([^"]+)"\)/.exec(m[2]!);
    if (mapped) out.set(m[1]!, mapped[1]!);
  }
  return out;
}

/** Strip comments so prose about a model never counts as a write. */
function stripComments(src: string): string {
  return src
    .replace(/^[^\S\r\n]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const schedulerSrc = readFileSync(SCHEDULER, "utf8");
const syncSrc = readFileSync(SYNC, "utf8");
const modelMap = readModelMap(readFileSync(SCHEMA, "utf8"));

const prodOnlyJobs = new Set(readBashArray(schedulerSrc, "PROD_ONLY_JOBS"));
const referenceCollections = new Set(
  readBashArray(syncSrc, "REFERENCE_COLLECTIONS"),
);

/**
 * scheduler job name -> pubsub topic, from the `NAME|SCHEDULE|TOPIC|…` defs.
 * The topic is also the processor filename, by convention.
 */
function readJobTopics(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/"([a-z0-9-]+)\|([^|]*)\|([a-z0-9-]+)\|/g)) {
    out.set(m[1]!, m[3]!);
  }
  return out;
}
const jobTopics = readJobTopics(schedulerSrc);

/** Prisma models a processor file WRITES (not merely reads). */
function writtenModels(src: string): Set<string> {
  const clean = stripComments(src);
  const out = new Set<string>();
  const add = (delegate: string) =>
    out.add(delegate.charAt(0).toUpperCase() + delegate.slice(1));

  // 1. The direct form: `prisma.stockFlag.createMany(`.
  //
  // `[\s\S]*?` rather than nothing between the delegate and the method —
  // MONEY-1201. `mf-nav-service.ts:166` puts `prisma.mfNavHistory` and
  // `.upsert({` on DIFFERENT LINES (prettier wraps a long chain), and a
  // same-line regex silently reported that file as writing nothing. Bounded to
  // 40 chars so it cannot leap across unrelated statements.
  //
  // `db` as well as `prisma` — MONEY-1114. Several processors take an injected
  // client for testability (`const db = deps.prisma ?? prisma`, the shape
  // `xbrl-projection-writer.ts` already uses) and then write through `db`. A
  // `prisma`-only scan reads those files as writing NOTHING, which is this
  // suite's own vacuous-pass failure mode: `xbrl-sync.ts` writes `XbrlFiling`
  // and went from three detected models to zero on a refactor that changed no
  // behaviour at all. Anchored with `\b` and limited to those two identifiers,
  // so it cannot match an arbitrary object's `.update(`.
  const direct =
    /\b(?:prisma|db)\.(\w+)[\s\S]{0,40}?\.(create|createMany|upsert|update|updateMany|delete|deleteMany)\b/g;
  for (const m of clean.matchAll(direct)) add(m[1]!);

  // 2. The STRING-KEYED delegate form: `probe("shareholdingPattern")`.
  //
  // `ownership-sync.ts` resolves its delegates dynamically (`client[name]`),
  // so the literal scan above finds NOTHING in it — and it is a PROD_ONLY
  // processor writing TWO synced collections. It therefore contributed zero
  // models and passed this suite VACUOUSLY. `shareholding_patterns` survived
  // only because it is hard-coded in the "four known instances" test;
  // `insider_events` had no structural protection whatsoever, so removing it
  // from REFERENCE_COLLECTIONS would have left the whole suite green.
  //
  // That is this file's own header one layer deeper: a rule written down
  // somewhere that does not cover the case.
  const probed = /probe\(\s*["'](\w+)["']\s*\)/g;
  for (const m of clean.matchAll(probed)) add(m[1]!);

  // 3. The REPOSITORY form: `candleRepository.putCandles(...)`.
  //
  // MONEY-980. `us-eod-sync.ts` writes `Candle` through the repository, so the
  // Prisma call lives in packages/core and NEITHER scan above can see it. It is
  // the first prod-only processor whose table reaches the database through an
  // abstraction, and it passed this suite VACUOUSLY: deleting "candles" from
  // REFERENCE_COLLECTIONS left everything green, which was verified by doing it.
  //
  // Declared rather than inferred. Following a call into another package is a
  // static-analysis problem this file should not grow, and the seam is the whole
  // point of the repository — every future consumer will write this way, so the
  // scan has to be told once rather than taught to chase. `REPOSITORY_WRITES` is
  // asserted to actually fire below, so it cannot quietly rot into a no-op the
  // way an unmatched regex would.
  for (const [re, model] of REPOSITORY_WRITES) {
    if (re.test(clean)) out.add(model);
  }

  return out;
}

/** Repository method -> the model it ultimately writes. See form 3 above. */
const REPOSITORY_WRITES: ReadonlyArray<readonly [RegExp, string]> = [
  // `[(.]` rather than `\(` — MONEY-1291. The pattern used to require a call
  // paren, and then `us-eod-sync.ts` made `putCandles` injectable for a test
  // that asserts a NEGATIVE (a fetch NOT issued). The call site became
  // `deps.putCandles(...)` and the only surviving literal is
  // `candleRepository.putCandles.bind(candleRepository)` — so `.bind(` did not
  // match `\(`, form 3 became a no-op, and `Candle` was left unguarded in
  // REFERENCE_COLLECTIONS with the rest of this suite green.
  //
  // Caught by the premise below on the very next run, which is the whole reason
  // that premise exists: a DECLARED list rots silently in a way an inferred one
  // does not. Matching a dot as well as a paren covers the call, `.bind`, and
  // any future `.call`/`.apply` without loosening it to a bare mention.
  [/\bcandleRepository\s*\.\s*putCandles\s*[(.]/, "Candle"],
];

describe("PROD_ONLY writers must have their table synced to QA (MONEY-1196)", () => {
  const prodOnlyTopics = new Set(
    [...prodOnlyJobs].map((j) => jobTopics.get(j)).filter(Boolean) as string[],
  );

  it("resolves the inputs it reasons over — a silent zero here proves nothing", () => {
    // Every assertion below is vacuously true if the parsing broke, which is
    // the failure mode a structural test must not have.
    assert.ok(
      prodOnlyJobs.size > 5,
      `PROD_ONLY_JOBS parsed ${prodOnlyJobs.size}`,
    );
    assert.ok(
      referenceCollections.size > 10,
      `REFERENCE_COLLECTIONS parsed ${referenceCollections.size}`,
    );
    assert.ok(modelMap.size > 50, `schema models parsed ${modelMap.size}`);
    assert.ok(
      prodOnlyTopics.size > 3,
      `prod-only topics resolved ${prodOnlyTopics.size}`,
    );

    // The repository form is DECLARED, not inferred, so it is the one that can
    // rot silently: a renamed method leaves the regex matching nothing and the
    // table it protects unguarded again, with the suite still green.
    const repoHits = readdirSync(PROCESSORS)
      .filter((f) => f.endsWith(".ts") && !f.endsWith("-logic.ts"))
      .flatMap((f) => {
        const src = readFileSync(join(PROCESSORS, f), "utf8");
        return REPOSITORY_WRITES.filter(([re]) => re.test(src)).map(
          ([, model]) => `${f}:${model}`,
        );
      });
    assert.ok(
      repoHits.length > 0,
      "no processor matched any REPOSITORY_WRITES pattern — the declared list " +
        "has drifted from the code it protects, so form 3 is a no-op",
    );
  });

  it("every collection a PROD_ONLY processor writes is synced or exempt", () => {
    const offenders: string[] = [];

    for (const file of readdirSync(PROCESSORS)) {
      if (!file.endsWith(".ts") || file.endsWith("-logic.ts")) continue;
      const topic = file.replace(/\.ts$/, "");
      if (!prodOnlyTopics.has(topic)) continue;

      const src = readFileSync(join(PROCESSORS, file), "utf8");
      for (const model of writtenModels(src)) {
        const coll = modelMap.get(model);
        if (!coll) continue; // not a mapped model (or a false positive)
        if (referenceCollections.has(coll)) continue;
        if (coll in QA_DIRECT) continue;
        if (coll in ACCEPTED_GAP) continue;
        offenders.push(`${file} writes ${model} -> "${coll}"`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "A prod-only processor writes a collection QA never receives — QA's copy " +
        "will silently stop moving. Either add it to REFERENCE_COLLECTIONS in " +
        "scripts/ops/sync-prod-to-qa.sh (check indexes first — mongorestore " +
        "--drop replaces QA's with prod's), or add it to QA_DIRECT here WITH a " +
        "written reason.\n  " +
        offenders.join("\n  "),
    );
  });

  it("REGRESSION: no PROD_ONLY processor parses to ZERO written models", () => {
    // THE VACUOUS PASS — MONEY-1201.
    //
    // The scan can only flag a collection it can SEE being written. A processor
    // the regex cannot read contributes nothing and therefore passes, which is
    // indistinguishable from a processor that writes nothing at all. That is
    // exactly what happened: `ownership-sync.ts` resolves its delegates by
    // string, yielded zero models, and sailed through this suite while writing
    // two synced collections.
    //
    // So the parse itself is now asserted. A processor that writes NO model is
    // a real thing (pure orchestrators exist), but it must be listed here
    // explicitly rather than discovered by silence.
    // Processors that genuinely write nothing THEMSELVES because they DELEGATE
    // the write into another package. Each was checked individually, and the
    // delegate target is recorded so this stays a documented boundary of the
    // scan rather than a place to silence failures.
    //
    // These collections are consequently NOT structurally protected by this
    // suite — the scan reads `workers/src/processors/` and the writes are in
    // `@usemoney/core` / `@usemoney/research`. That limitation always existed;
    // what is new is that it is now ENUMERATED instead of indistinguishable
    // from "this processor writes nothing".
    const NO_WRITES_EXPECTED = new Map<string, string>([
      [
        "xbrl-projection.ts",
        // MONEY-1220. A thin arm-and-report shell: it resolves `apply` from the
        // env, calls `processXbrlProjectionWrite` (same directory, which holds
        // every write and IS scanned by this suite), and reports the outcome.
        // Its own only Prisma call is a read — `countUnprojectedFilings`, so a
        // run that selects nothing can say WHY instead of returning a bare zero.
        "delegates to xbrl-projection-writer.ts in this same directory",
      ],
      [
        "document-financials-projection.ts",
        // MONEY-1334, and the SAME shape as xbrl-projection.ts above: a thin
        // arm-and-report shell. It resolves `apply` from DOC_FINANCIALS_APPLY,
        // delegates to document-financials-projection-logic.ts — same directory,
        // so IT IS SCANNED BY THIS SUITE, which is what keeps this exemption
        // honest rather than a blind spot — and reports the outcome. VERIFIED at
        // the time of writing: the shell makes NO Prisma call of any kind, and
        // the sibling holds `db.stockFinancials.create` (:746),
        // `db.stockFinancials.update` (:778) and
        // `db.documentFinancialExtract.updateMany` (:645).
        "delegates to document-financials-projection-logic.ts in this same directory",
      ],
      [
        "mf-sync.ts",
        "delegates to syncAmfiMutualFunds in @usemoney/core/market-data",
      ],
      ["mf-metadata-sync.ts", "delegates to @usemoney/core/market-data"],
      [
        // MONEY-980. It became PROD_ONLY when US listings moved out of
        // `instrument_mappings` (QA-DIRECT, so its columns had to be written
        // per-environment) into `us_instruments` — which is nothing's FK target
        // and IS in REFERENCE_COLLECTIONS, so QA now RECEIVES what prod
        // computed. Leaving it on in QA also spent ~14,000 METERED Tiingo
        // requests a night against a quota `tiingo-pacer.ts` tracks
        // per-PROCESS, i.e. 2x the ceiling across two environments.
        //
        // Its own Prisma calls are the rotation stamp and reads; every write
        // lives in `@usemoney/core/market-data/instruments/` —
        // `syncUsInstruments`, `enrichUsInstrumentNames`,
        // `enrichUsInstrumentsWithPermaTicker`, `enrichUsInstrumentsWithCik`.
        "us-instrument-master-sync.ts",
        "delegates to syncUsInstruments + the three enrichers in @usemoney/core/market-data/instruments",
      ],
      [
        "news-sync.ts",
        "delegates to getOrFetchNews in @usemoney/research/data-sources/db-store",
      ],
      [
        "ipo-sync.ts",
        "delegates to @usemoney/research/data-sources/nse-issues + issues-logic",
      ],
      [
        "filings-sync.ts",
        "delegates to @usemoney/research/data-sources/nse-filings",
      ],
      [
        "corporate-actions-sync.ts",
        "delegates to @usemoney/research/data-sources/bse-client + corp-actions-window",
      ],
      [
        "chartink-strategy-sync.ts",
        "writes no Prisma model at all — verified, no prisma reference in the file",
      ],
    ]);
    const zeroYield: string[] = [];

    for (const file of readdirSync(PROCESSORS)) {
      if (!file.endsWith(".ts") || file.endsWith("-logic.ts")) continue;
      const topic = file.replace(/\.ts$/, "");
      if (!prodOnlyTopics.has(topic)) continue;
      if (NO_WRITES_EXPECTED.has(file)) continue;

      const src = readFileSync(join(PROCESSORS, file), "utf8");
      const models = [...writtenModels(src)].filter((m) => modelMap.has(m));
      if (models.length === 0) zeroYield.push(file);
    }

    assert.deepEqual(
      zeroYield,
      [],
      "A PROD_ONLY processor yielded NO recognisable Prisma writes. Either it " +
        "genuinely writes nothing (add it to NO_WRITES_EXPECTED with a reason) " +
        "or — far more likely — it writes through a form `writtenModels` " +
        "cannot read, and is passing this suite vacuously.\n  " +
        zeroYield.join("\n  "),
    );
  });

  it("pins the known instances so a revert is loud", () => {
    // These are the tables the bug was found on. If one leaves the allowlist,
    // this fails by name instead of the generic scan going quiet.
    //
    // `insider_events` is here from MONEY-1201: it is written by
    // `ownership-sync` through the string-keyed `probe()` form, so before the
    // scanner learned that form it had NO structural protection at all —
    // deleting it from REFERENCE_COLLECTIONS left every test green.
    for (const coll of [
      "shareholding_patterns",
      "insider_events",
      "index_memberships",
      "institutional_flows",
      "stock_flags",
    ]) {
      assert.ok(
        referenceCollections.has(coll),
        `${coll} must stay in REFERENCE_COLLECTIONS — it has a PROD_ONLY writer and no QA writer`,
      );
    }
  });

  it("every QA_DIRECT and ACCEPTED_GAP exemption carries a written reason", () => {
    for (const [list, name] of [
      [QA_DIRECT, "QA_DIRECT"],
      [ACCEPTED_GAP, "ACCEPTED_GAP"],
    ] as const) {
      for (const [coll, why] of Object.entries(list)) {
        assert.ok(
          why.trim().length > 20,
          `${name}["${coll}"] needs a real reason, not a placeholder`,
        );
      }
    }
  });

  it("an ACCEPTED_GAP names the ticket that would close it", () => {
    // A gap without a ticket is indistinguishable from a gap nobody noticed,
    // which is the state this whole suite exists to make impossible.
    for (const [coll, why] of Object.entries(ACCEPTED_GAP)) {
      assert.match(
        why,
        /MONEY-\d+/,
        `ACCEPTED_GAP["${coll}"] must cite the ticket that closes it`,
      );
    }
  });

  it("no collection is BOTH synced and exempted, or in both exemption lists", () => {
    const synced = [...Object.keys(QA_DIRECT), ...Object.keys(ACCEPTED_GAP)]
      .filter((c) => referenceCollections.has(c))
      .sort();
    assert.deepEqual(
      synced,
      [],
      `contradiction: ${synced.join(", ")} is in REFERENCE_COLLECTIONS and also exempted`,
    );

    // QA_DIRECT says "QA writes this itself"; ACCEPTED_GAP says "QA has no
    // copy". A collection cannot be both, and the pair being contradictory is
    // precisely how the false derivative_eod reason survived.
    const both = Object.keys(QA_DIRECT)
      .filter((c) => c in ACCEPTED_GAP)
      .sort();
    assert.deepEqual(
      both,
      [],
      `contradiction: ${both.join(", ")} is claimed both QA-direct and an accepted gap`,
    );
  });
});

/**
 * The same rule, for Cloud Run JOBS — MONEY-1198.
 *
 * ## The blind spot
 *
 * The suite above scans `workers/src/processors/*.ts` and cross-references
 * `PROD_ONLY_JOBS` against `SCHEDULER_DEFS`. `feed-parse` is in NEITHER place:
 * it is a Cloud Run JOB whose source is `scripts/jobs/feed-parse.ts` and whose
 * nightly trigger is created in `setup-feed-backfill-job.sh`, inside an
 * `if [ "$ENV" = "prod" ]` block. QA gets the job provisioned with no schedule.
 *
 * So an entire writer family — eight Prisma models — was invisible to the guard
 * that exists to catch exactly this. `market_positioning` was found by hand, by
 * the founder, reading a deploy runbook. That is the fifth manual catch of one
 * bug, and the second time the rule was already written down somewhere that did
 * not cover the case.
 *
 * ## What extending it actually found
 *
 * Not one more instance — FOUR, none of which anybody had looked at:
 *
 *   institutional_deals  no QA writer at all  -> added to REFERENCE_COLLECTIONS
 *   slb_positions        no QA writer at all  -> added to REFERENCE_COLLECTIONS
 *   derivative_eod       QA_DIRECT for a FALSE reason -> ACCEPTED_GAP
 *   derivative_summary   QA_DIRECT for a FALSE reason -> ACCEPTED_GAP
 *
 * and one that was genuinely fine but had never been written down as fine
 * (`index_closes`, which bhavcopy-sync writes on QA too).
 *
 * That ratio is the argument for the test. Scanning by hand found 1 of 5.
 */
describe("PROD-ONLY Cloud Run JOBS must have their tables synced too (MONEY-1198)", () => {
  const FEED_SETUP = join(ROOT, "scripts", "ops", "setup-feed-backfill-job.sh");
  const JOBS_DIR = join(ROOT, "scripts", "jobs");
  const feedSetupSrc = readFileSync(FEED_SETUP, "utf8");

  /** `deploy_job "$PARSE_JOB" "dist/feed-parse.js"` -> PARSE_JOB : feed-parse */
  const varToEntry = new Map<string, string>();
  for (const m of feedSetupSrc.matchAll(
    /deploy_job\s+"\$(\w+)"\s+"dist\/([\w-]+)\.js"/g,
  )) {
    varToEntry.set(m[1]!, m[2]!);
  }

  /**
   * The `ENV=prod`-gated block. Everything scheduled in here exists ONLY on
   * prod — which is the precise fact the false comment in sync-prod-to-qa.sh
   * got backwards.
   */
  const prodOnlyBlock = (() => {
    const start = feedSetupSrc.indexOf('if [ "$ENV" = "prod" ]');
    if (start < 0) return "";
    const end = feedSetupSrc.indexOf("\nelse", start);
    return end > start ? feedSetupSrc.slice(start, end) : "";
  })();

  /** Job VARs that get a scheduler trigger ONLY on prod. */
  const prodOnlyJobVars = new Set(
    [...prodOnlyBlock.matchAll(/schedule_job_run\s+"[\w-]+"\s+"\$(\w+)"/g)].map(
      (m) => m[1]!,
    ),
  );

  it("resolves the inputs it reasons over — a silent zero here proves nothing", () => {
    // This suite's own failure mode is finding nothing and passing. The bug it
    // covers is invisible-by-construction, so a parser that quietly stops
    // matching would restore the exact blind spot being closed.
    assert.ok(
      varToEntry.size >= 3,
      `parsed only ${varToEntry.size} deploy_job calls from setup-feed-backfill-job.sh`,
    );
    assert.ok(
      prodOnlyBlock.length > 0,
      'the `if [ "$ENV" = "prod" ]` block was not found — did the script get restructured?',
    );
    assert.ok(
      prodOnlyJobVars.size >= 2,
      `parsed only ${prodOnlyJobVars.size} prod-gated schedule_job_run calls`,
    );
  });

  it("REGRESSION: feed-parse and fo-summary are still prod-gated", () => {
    // If either ever gains a QA trigger this fails, which is the CORRECT
    // outcome: the exemptions below are written on the premise that QA does not
    // run them, and that premise must not change silently. It is the same
    // premise the old derivative_eod comment asserted while it was false.
    const entries = [...prodOnlyJobVars]
      .map((v) => varToEntry.get(v))
      .filter(Boolean)
      .sort();
    assert.deepEqual(entries, ["feed-parse", "fo-summary"]);
  });

  it("every collection a prod-only Cloud Run JOB writes is synced or exempt", () => {
    const offenders: string[] = [];
    let scanned = 0;

    for (const jobVar of prodOnlyJobVars) {
      const entry = varToEntry.get(jobVar);
      if (!entry) continue;
      const src = readFileSync(join(JOBS_DIR, `${entry}.ts`), "utf8");
      scanned++;
      for (const model of writtenModels(src)) {
        const coll = modelMap.get(model);
        if (!coll) continue;
        if (referenceCollections.has(coll)) continue;
        if (coll in QA_DIRECT) continue;
        if (coll in ACCEPTED_GAP) continue;
        offenders.push(`scripts/jobs/${entry}.ts writes ${model} -> "${coll}"`);
      }
    }

    assert.ok(scanned >= 2, `scanned only ${scanned} job entry points`);
    assert.deepEqual(
      offenders,
      [],
      "A prod-only Cloud Run JOB writes a collection QA never receives. The " +
        "job is provisioned on QA but its scheduler trigger is created only " +
        "when ENV=prod, so QA has no writer AND no sync. Either add it to " +
        "REFERENCE_COLLECTIONS in scripts/ops/sync-prod-to-qa.sh, or add it " +
        "to QA_DIRECT (only if QA genuinely writes it) / ACCEPTED_GAP (with a " +
        "ticket) in this file.\n  " +
        offenders.join("\n  "),
    );
  });

  it("pins the five collections this extension surfaced", () => {
    // Named individually so a revert fails by name rather than the generic
    // scan going quiet — the same reason the four original instances are
    // pinned above.
    for (const coll of [
      "market_positioning",
      "institutional_deals",
      "slb_positions",
      // MONEY-1204 F2 — was an ACCEPTED_GAP, bundled with derivative_eod
      // because it is derived from it. They share a writer and nothing else:
      // 432,609 rows / 190 MB measured on prod, against derivative_eod's 2.5M,
      // and it is the table 14c.3 made a GATE for the whole F&O tab. Copying
      // it down is the resolution; it is NOT QA-direct (QA has no writer).
      "derivative_summary",
    ]) {
      assert.ok(
        referenceCollections.has(coll),
        `${coll} must stay in REFERENCE_COLLECTIONS — feed-parse is its only writer and feed-parse-nightly is prod-only`,
      );
    }
    assert.ok(
      "derivative_eod" in ACCEPTED_GAP,
      "derivative_eod must stay recorded as a gap, not re-labelled QA-direct",
    );
    // The original assertion's real purpose: neither may be quietly re-labelled
    // as something QA writes itself, because QA writes neither.
    for (const coll of ["derivative_eod", "derivative_summary"]) {
      assert.ok(
        !(coll in QA_DIRECT),
        `${coll} has no QA writer — calling it QA-direct would be a false claim`,
      );
    }
    assert.ok(
      "index_closes" in QA_DIRECT,
      "index_closes is genuinely QA-direct (bhavcopy-sync writes it on QA) and must keep saying so",
    );
  });

  it("readBashArray reads the array, not the prose around it (F15)", () => {
    // These arrays carry ~226 lines of comment that discuss collection names
    // constantly. The parser used to regex every double-quoted string out of
    // the raw slice, so bash saw 32 entries and the parser saw 36. The
    // dangerous direction is not the extra names — it is that a comment
    // asserting a collection is handled would make this guard read it as
    // PRESENT and go quiet, while `mongorestore`, which reads the real array,
    // never copies it. A guard that agrees with a comment is not a guard.
    const synthetic = [
      "SYNTHETIC=(",
      '    "real_one"      # prose mentioning "phantom_a" in quotes',
      "    # a whole comment line about \"phantom_b\" and 'phantom_c'",
      '    "real_two"      # trailing note',
      ")",
    ].join("\n");

    assert.deepEqual(readBashArray(synthetic, "SYNTHETIC"), [
      "real_one",
      "real_two",
    ]);

    // And the real file: nothing that is plainly a sentence fragment or a
    // shell variable may appear as a collection.
    for (const coll of referenceCollections) {
      assert.doesNotMatch(
        coll,
        /[\s$'"]/,
        `"${coll}" was harvested out of a comment, not read from the array`,
      );
    }
  });
});

/**
 * No duplicate job in SCHEDULER_DEFS — MONEY-1196.
 *
 * A cherry-pick across branches that each edited this array union-merged it and
 * left `surveillance-sync-daily` defined TWICE: once at the corrected
 * `15 20 * * 1-5` and once at the stale `45 14`. The provisioning loop walks the
 * array in order, so the LAST definition wins — the run silently reverted a fix
 * that was correct in source, on a feed that cannot be backfilled.
 *
 * Nothing about the file looked wrong: both entries carry a full, plausible
 * comment block, and they sit 20 lines apart in a 300-line array. Only the LIVE
 * scheduler disagreed with the source, which is the hardest kind of drift to
 * notice because the source reads correct.
 */
describe("SCHEDULER_DEFS has no duplicate job names (MONEY-1196)", () => {
  const defsBlock = (() => {
    const start = schedulerSrc.indexOf("SCHEDULER_DEFS=(");
    const end = schedulerSrc.indexOf("\n)", start);
    return schedulerSrc.slice(start, end);
  })();

  const names = [...defsBlock.matchAll(/^ {4}"([a-z0-9-]+)\|/gm)].map(
    (m) => m[1]!,
  );

  it("parsed a plausible number of job definitions", () => {
    assert.ok(names.length > 30, `parsed only ${names.length} scheduler defs`);
  });

  it("REGRESSION: defines each job exactly once — the last one silently wins", () => {
    const seen = new Map<string, number>();
    for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, c]) => c > 1);
    assert.deepEqual(
      dupes.map(([n, c]) => `${n} x${c}`),
      [],
      "A job is defined more than once in SCHEDULER_DEFS. The provisioning " +
        "loop applies them in order, so the LAST definition wins and any " +
        "earlier fix is silently reverted at provision time.",
    );
  });

  it("pins the surveillance cron to IST 20:15 — it must never be UTC-converted", () => {
    // Jobs are created with --time-zone="Asia/Kolkata", so the cron IS IST.
    // `45 14` fires at 14:45 IST, before the 15:30 close and hours before NSE
    // publishes — and this feed cannot be backfilled, so a wrong day is
    // permanent.
    const line = names.includes("surveillance-sync-daily")
      ? /"surveillance-sync-daily\|([^|]+)\|/.exec(defsBlock)?.[1]
      : undefined;
    assert.equal(line, "15 20 * * 1-5");
  });
});

/**
 * Cloud Scheduler rejects a description over 499 characters — MONEY-1196.
 *
 * Two new jobs shipped with descriptions of 500 and 602 characters. Provisioning
 * failed them with INVALID_ARGUMENT and CONTINUED, so the pass exited non-zero
 * having created every OTHER job — `institutional-flow-sync-daily-prod` and
 * `macro-sync-weekly-prod` simply did not exist afterwards, on feeds that cannot
 * be backfilled. The 500-char one was over by a single character.
 *
 * Continuing past the failure is the right behaviour (one bad entry must not
 * strand 60 good ones), which is exactly why the limit belongs in a test: the
 * only other signal is one line in a long provisioning log.
 */
describe("scheduler descriptions fit Cloud Scheduler's limit (MONEY-1196)", () => {
  const defsBlock = (() => {
    const start = schedulerSrc.indexOf("SCHEDULER_DEFS=(");
    return schedulerSrc.slice(start, schedulerSrc.indexOf("\n)", start));
  })();

  /** NAME|SCHEDULE|TOPIC|MESSAGE|DESCRIPTION */
  const entries = [
    ...defsBlock.matchAll(/^ {4}"([a-z0-9-]+)\|[^|]*\|[^|]*\|[^|]*\|(.*)"$/gm),
  ].map((m) => ({ name: m[1]!, description: m[2]! }));

  it("parsed the descriptions it is checking", () => {
    assert.ok(entries.length > 30, `parsed only ${entries.length} entries`);
  });

  it("REGRESSION: every description is <= 499 chars", () => {
    const over = entries
      .filter((e) => e.description.length > 499)
      .map((e) => `${e.name}: ${e.description.length}`);
    assert.deepEqual(
      over,
      [],
      "Cloud Scheduler rejects these with INVALID_ARGUMENT. The provisioning " +
        "pass continues past the failure, so the job is simply never created.",
    );
  });

  /**
   * The DEPLOYED description, which is what Cloud Scheduler actually receives.
   *
   * The check above measures `DESC` alone, but an entry with an
   * `ENV_SCHEDULE_OVERRIDES` row is deployed as
   *   `${DESC} [${ENV} schedule override: ${SCHEDULE} IST - ${WHY}]`
   * (setup-scheduler.sh:1186), so its real length is DESC + WHY + ~44 chars of
   * scaffolding. A DESC comfortably under 499 can therefore still be rejected
   * the moment anyone adds an override for it — and several existing entries
   * sit at 487-493, which leaves no room for one at all.
   *
   * This is not hypothetical: MONEY-980's own QA override reached ~610 and was
   * caught only by measuring it by hand, because nothing failed.
   */
  it("REGRESSION: DESC + override WHY together fit, not just DESC", () => {
    const overridesBlock = (() => {
      const start = schedulerSrc.indexOf("ENV_SCHEDULE_OVERRIDES=(");
      if (start === -1) return "";
      return schedulerSrc.slice(start, schedulerSrc.indexOf("\n)", start));
    })();

    // NAME|ENV|SCHEDULE|WHY
    const overrides = [
      ...overridesBlock.matchAll(
        /^ {4}"([a-z0-9-]+)\|(qa|prod)\|([^|]*)\|(.*)"$/gm,
      ),
    ].map((m) => ({ name: m[1]!, env: m[2]!, schedule: m[3]!, why: m[4]! }));

    assert.ok(
      overrides.length > 0,
      "parsed no overrides — the regex has drifted from the file, and a guard " +
        "that matches nothing passes vacuously",
    );

    const byName = new Map(entries.map((e) => [e.name, e.description]));
    const over: string[] = [];
    for (const o of overrides) {
      const desc = byName.get(o.name);
      if (desc === undefined) continue;
      const deployed = `${desc} [${o.env} schedule override: ${o.schedule} IST - ${o.why}]`;
      if (deployed.length > 499) {
        over.push(`${o.name}[${o.env}]: ${deployed.length}`);
      }
    }
    assert.deepEqual(
      over,
      [],
      "the deployed description exceeds Cloud Scheduler's limit. Shorten the " +
        "DESC or the override WHY — the two share one budget.",
    );
  });
});

/**
 * The cron must fire at the IST time its own description claims — MONEY-1186.
 *
 * ## Why this is a test and not a comment
 *
 * Every job here is created with `--time-zone="Asia/Kolkata"`, so the cron IS
 * IST and no conversion is wanted. That has now been got wrong TWICE:
 *
 *   surveillance-sync-daily shipped `45 14` under the comment
 *   "20:15 IST (14:45 UTC)" and therefore fired at 14:45 IST — before the
 *   market close, on a feed that cannot be backfilled, writing the previous
 *   day's list stamped as today. Fixed in MONEY-1189, and a WARNING COMMENT
 *   was added directly above it.
 *
 *   macro-sync-weekly / -midweek then shipped `30 2` under the comment
 *   "08:00 IST (02:30 UTC)" — the identical mistake, written THREE LINES BELOW
 *   that warning, and fired at 02:30 IST. Found on a read-through, not by any
 *   signal the system produced.
 *
 * A warning comment demonstrably does not prevent the second occurrence. What
 * makes this mechanically checkable is that the fact is already stated TWICE
 * per entry in two independent encodings: once as cron fields, once as prose in
 * the description ("20:15 IST weekdays", "Sat 08:00 IST"). They can be compared.
 *
 * ## What this deliberately does NOT do
 *
 * It does not require a description to state a time. Plenty legitimately do not,
 * and demanding one would either force noise into 60 descriptions or invite a
 * copy-pasted time that is wrong — a worse failure than silence, because it
 * would then be asserted as correct. This checks only entries that DO make a
 * claim, which is the "precision without a catch-all shrinks coverage" lesson
 * applied in reverse: widen what is scanned, narrow what is asserted.
 */
describe("scheduler crons match the IST time their description claims (MONEY-1186)", () => {
  const defsBlock = (() => {
    const start = schedulerSrc.indexOf("SCHEDULER_DEFS=(");
    return schedulerSrc.slice(start, schedulerSrc.indexOf("\n)", start));
  })();

  /** NAME|SCHEDULE|TOPIC|MESSAGE|DESCRIPTION */
  const entries = [
    ...defsBlock.matchAll(
      /^ {4}"([a-z0-9-]+)\|([^|]*)\|[^|]*\|[^|]*\|(.*)"$/gm,
    ),
  ].map((m) => ({ name: m[1]!, cron: m[2]!, description: m[3]! }));

  /**
   * Pull "HH:MM IST" out of prose. Accepts "20:15 IST", "(Sat 08:00 IST)",
   * "12th, 08:30 IST" — i.e. a clock time followed by IST within a few
   * characters. Returns null when the description makes no claim, which is a
   * SKIP and not a failure.
   *
   * Deliberately ignores "9:00 PM IST" style: no entry currently uses it, and a
   * half-supported 12-hour parse that silently mis-reads one is worse than not
   * matching it at all. If one appears, this returns null and the entry is
   * skipped rather than wrongly asserted.
   */
  function claimedIst(description: string): { h: number; m: number } | null {
    const hit = /\b(\d{1,2}):(\d{2})\s*(?:IST)\b/.exec(description);
    if (!hit) return null;
    const h = Number(hit[1]);
    const m = Number(hit[2]);
    if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
    if (h > 23 || m > 59) return null;
    return { h, m };
  }

  /** Cron is "M H dom mon dow"; only the first two fields matter here. */
  function cronHm(cron: string): { h: number; m: number } | null {
    const f = cron.trim().split(/\s+/);
    if (f.length < 2) return null;
    const m = Number(f[0]);
    const h = Number(f[1]);
    // Step/list/range minutes ("*/15") are real and legitimate — an intraday
    // job has no single clock time to compare against, so it is skipped.
    if (!Number.isInteger(m) || !Number.isInteger(h)) return null;
    return { h, m };
  }

  it("parsed the entries it is checking", () => {
    assert.ok(entries.length > 30, `parsed only ${entries.length} entries`);
  });

  it("finds enough time-claiming descriptions to be worth running", () => {
    // Guards the guard. If a refactor changed the description style, every
    // entry would return null and this suite would pass by checking NOTHING —
    // the wrong-granularity success signal that MONEY-1189 is a catalogue of.
    const claiming = entries.filter((e) => claimedIst(e.description) !== null);
    assert.ok(
      claiming.length >= 5,
      `only ${claiming.length} descriptions state an IST time — the matcher ` +
        `has probably stopped matching, so this suite is asserting nothing`,
    );
  });

  it("REGRESSION: no cron is the UTC conversion of its own stated IST time", () => {
    const mismatches: string[] = [];
    for (const e of entries) {
      const claim = claimedIst(e.description);
      const actual = cronHm(e.cron);
      if (!claim || !actual) continue;
      if (claim.h === actual.h && claim.m === actual.m) continue;

      // Name the likely cause rather than just the diff: an entry that is off
      // by exactly 5h30 was UTC-converted, and saying so is the difference
      // between a two-minute fix and a re-investigation.
      const claimMin = claim.h * 60 + claim.m;
      const actualMin = actual.h * 60 + actual.m;
      const delta = (((claimMin - actualMin) % 1440) + 1440) % 1440;
      const why =
        delta === 330
          ? " (off by exactly 5h30 — the cron was UTC-converted; jobs are " +
            "created with --time-zone=Asia/Kolkata, so write IST)"
          : "";
      const hh = (n: number) => String(n).padStart(2, "0");
      mismatches.push(
        `${e.name}: cron "${e.cron}" fires ${hh(actual.h)}:${hh(actual.m)} IST` +
          ` but its description says ${hh(claim.h)}:${hh(claim.m)} IST${why}`,
      );
    }
    assert.deepEqual(mismatches, []);
  });
});

/**
 * ── The Python writers (MONEY-979) ────────────────────────────────────────
 *
 * The suite above scans `workers/src/processors/*.ts` for Prisma calls. That is
 * the whole of it, and it was complete right up until a writer arrived that is
 * not TypeScript and does not use Prisma.
 *
 * `services/us-fundamentals/` is a Python Cloud Run service writing eleven
 * collections through pymongo. Every one of its jobs is in PROD_ONLY_JOBS, so
 * it is exactly the population this file exists to protect — and the scan above
 * cannot see a single line of it. A US fundamentals collection left out of
 * REFERENCE_COLLECTIONS would have passed the entire suite green while QA's
 * copy silently never appeared.
 *
 * The service declares its collections in ONE place, as a plain literal dict,
 * precisely so this test can read it without running Python.
 */
describe("prod-only sync coverage — Python services (MONEY-979)", () => {
  const COLLECTIONS_PY = join(
    ROOT,
    "services",
    "us-fundamentals",
    "app",
    "store",
    "collections.py",
  );

  /** Parse `"key": "value",` pairs out of the literal COLLECTIONS dict. */
  function pythonCollections(src: string): string[] {
    const body = src.slice(src.indexOf("COLLECTIONS"));
    const out: string[] = [];
    for (const m of body.matchAll(/"[a-z0-9_]+"\s*:\s*"([a-z0-9_]+)"/g)) {
      out.push(m[1]!);
    }
    return out;
  }

  it("the declaration file exists and is non-trivial", () => {
    // Without this, deleting or renaming collections.py turns every assertion
    // below into a vacuous pass over an empty list — the failure mode this
    // whole file was written to catch.
    let src: string;
    try {
      src = readFileSync(COLLECTIONS_PY, "utf8");
    } catch {
      assert.fail(
        `${COLLECTIONS_PY} is missing. The Python service declares the ` +
          "collections it writes there so this test can read them without " +
          "running Python. If the service moved, update this path — do not " +
          "delete the check.",
      );
    }
    const found = pythonCollections(src);
    assert.ok(
      found.length >= 10,
      `expected >= 10 collections in collections.py, parsed ${found.length} ` +
        "— the dict shape changed and the regex no longer matches it",
    );
  });

  it("every collection the Python service writes is synced or exempt", () => {
    const src = readFileSync(COLLECTIONS_PY, "utf8");
    const offenders: string[] = [];

    for (const coll of pythonCollections(src)) {
      if (referenceCollections.has(coll)) continue;
      if (coll in QA_DIRECT) continue;
      if (coll in ACCEPTED_GAP) continue;
      offenders.push(coll);
    }

    assert.deepEqual(
      offenders,
      [],
      "services/us-fundamentals writes a collection QA never receives. Its " +
        "jobs are all PROD_ONLY (QA runs with SEC_EGRESS=off and cannot fetch " +
        "from SEC at all), so a missing entry means the data NEVER reaches QA " +
        "by any route. Add it to REFERENCE_COLLECTIONS in " +
        "scripts/ops/sync-prod-to-qa.sh, or to QA_DIRECT here WITH a written " +
        "reason.\n  " +
        offenders.join("\n  "),
    );
  });

  it("every collection the Python service writes is declared in schema.prisma", () => {
    // Prisma is the schema of record even though no TypeScript writer exists.
    // A collection name that is a typo, or a model somebody forgot to add,
    // produces a Mongo collection with no declared indexes — which works
    // perfectly until the first query that needs one.
    const schema = readFileSync(SCHEMA, "utf8");
    const mapped = new Set(
      [...schema.matchAll(/@@map\("([a-z0-9_]+)"\)/g)].map((m) => m[1]!),
    );
    const src = readFileSync(COLLECTIONS_PY, "utf8");
    const missing = pythonCollections(src).filter((c) => !mapped.has(c));
    assert.deepEqual(
      missing,
      [],
      "collections.py names a collection with no @@map in schema.prisma:\n  " +
        missing.join("\n  "),
    );
  });
});
