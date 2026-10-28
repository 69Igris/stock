# Empty-in-prod collections — root causes and fix plan (MONEY-1203 follow-on)

_Supersedes the previous fix board on this branch (`fix/MONEY-1205`, all landed
in `c0f26f0d` + `d1349bad`). Written 2026-08-18 after the founder-run
`sync-prod-to-qa.sh --collections-only --yes` reported:_

```
Skipped 4 empty-in-prod collection(s) (QA untouched):
  shareholding_breakdown  bond_master  bond_eod  financial_data
MongoDB sync complete — 30 copied, 4 skipped.
```

Every claim below was verified read-only against prod (Mongo, Cloud Run, Cloud
Scheduler, Cloud Logging) or against git. Nothing has been fixed yet — this is
the plan, and it stops here.

---

## Summary

| Collection                | Root cause                                                                                                                                                                                                                                                                      | Class                         | Fix shape                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bond_master`, `bond_eod` | `feed-parse-prod` **job** pins image `prod-fbdc29e2` (14-Aug), which predates bond parsing (#325, 16-Aug). The job runs nightly and "succeeds" — on code that skips the four bond families as unknown. Plus `nse-wdm-daily` has **no parse kind at all**, even on current code. | **Deploy gap + coverage gap** | Re-pin the job image → register `nse-wdm-daily` → run parse over the already-archived GCS objects. **No re-fetch.**                                |
| `shareholding_breakdown`  | Model is **new on this branch**, absent from `origin/main`. Its writers (ownership legs 5+6) are also branch-only. Prod has neither the collection nor the code.                                                                                                                | **Not deployed yet**          | Ships with this branch: `prisma db push` → merge/promote → provision the two schedulers → first runs populate it. Not a bug.                       |
| `financial_data`          | **Dead model.** No `prisma.financialData` reader or writer anywhere (the only text hits are an unrelated Yahoo JSON key and a chat tool name). A Yahoo-response cache from before the current data engine.                                                                      | **Vestigial**                 | **DONE 2026-08-18** — model + allowlist entry removed (T10–T12). Physical collection still needs a manual `db.financial_data.drop()` on prod + qa. |

---

## 1. `bond_master` + `bond_eod` — the real bug, and it is two bugs

### 1a. The job runs stale code (deploy gap)

Measured:

```
feed-parse-prod  image  = gcr.io/…/stockbook-workers:prod-fbdc29e2   (built 14-Aug, "Fix/money 1201 #323")
#325 "Feat/money 1204"  merged  16-Aug 12:08 IST  ← added bond parsing
prod SERVICE image      = prod-d7eefba7                                (built 18-Aug from release, includes #325)
```

`git show fbdc29e2:scripts/jobs/feed-parse.ts | grep -c '"bond-master"'` → **0**.
On `origin/main` and `origin/release` → **7**.

So the service moved to the bond-aware code today; the **job did not**, because
Cloud Run Jobs pin their image at setup time and deploying the service does not
touch them (`reference_cloud_run_jobs_pin_images` — this is the second time
this trap has bitten a nightly job on this project). Executions
`feed-parse-prod-8tpvt` (17-Aug) etc. all show `SUCCEEDED_COUNT 1` — success on
code that has never heard of the four families. Cloud Logging over 3 days has
the three `report-archive-sync … archived` lines for wdm/cbm and **not one
`feed-parse` line** naming them.

### 1b. `nse-wdm-daily` is archived but has no parser (coverage gap)

`PARSERS` in `scripts/jobs/feed-parse.ts:253-255` registers three of the four:

```
"nse-wdm-list":              { kind: "bond-master" }
"nse-corporate-bond-report": { kind: "bond-master" }
"nse-cbm-trades":            { kind: "bond-eod"    }
```

`nse-wdm-daily` (`dly17082026.zip`, 102,833 B on 17-Aug) is in the archive
registry (`report-registry.ts:1316`) and **nowhere in the parse table**. It will
be "skipped loudly" as a family with no parser — correct behaviour, but it means
even after 1a, one of the four bond feeds still produces nothing. It is also the
only `.zip` of the four; the parse path must unzip it.

### Tasks

- [ ] **T1 — Re-pin `feed-parse-prod` to the current image.** Founder-run:
      `./scripts/ops/setup-feed-backfill-job.sh prod` (it deploys `feed-parse-{env}`;
      confirm it re-reads the image tag rather than reusing the pinned one — read the
      script before running). Verify with
      `gcloud run jobs describe feed-parse-prod --format="value(spec.template.spec.template.spec.containers[0].image)"`
      → must show `prod-d7eefba7` or newer. Do the same for `feed-parse-qa`.
- [x] **T2 — `nse-wdm-daily` registered and parsed. DONE.** Decided from the
      real archived bytes, not the name. Findings, all measured:
  - It is a **multi-member zip** (6 members). `decodeFeedText` →
    `unzipSingleEntry` returns the FIRST local entry, which is
    `trd1708_sett.csv` — the trades file. Left as a documented dependency on
    member order because the failure mode is loud: a reorder hands the parser
    the `.xls`, the header check fails, `UnreadableFeedFile` is raised, and the
    object is retried rather than checkpointed.
  - It carries **NO ISIN**. It identifies an instrument by `Security` +
    `Issue Name`. `Security` ALONE is ambiguous — 1,352 of 2,488 distinct
    securities in the 17-Aug `wdmlist` repeat, the fact `BondMaster.symbol`
    already documents. The PAIR resolves: 10,666 distinct pairs of 10,673 master
    rows, and **all 21 trades resolved to exactly one ISIN**. The 7 pairs that
    map to two ISINs are **refused**, never guessed — a dropped price is a
    recoverable gap, a misattributed one is a lie nothing downstream can detect.
  - Its money column is **`Traded Value (Rs.Cr.)`** feeding
    `totalTradeValueLacs` — converted ×100. Storing crores in a lacs-named
    column would understate every WDM trade 100× while looking reasonable next
    to CBM rows.
  - `BondEOD.segment` was **already** `"CBM" | "WDM"`; only CBM had a parser.
    This is the half the schema was designed for.
  - Shipped: `parseWdmTrades` + `resolveWdmTrades` (pure, in
    `bond-eod-logic.ts`), a `BOND_EOD_PARSERS` dispatch table mirroring
    `BOND_MASTER_PARSERS`, `resolveWdmFile` (the DB join) and a shared
    `upsertBondEodRows` both shapes converge on, plus 4 new tally counters
    (`ambiguousPair`, `noMasterMatch`, `duplicateSymbolIssueDate`,
    `noSymbolOrIssue`) surfaced in the run summary.
  - **15 tests against CAPTURED fixtures** (the real archived trades file and a
    slice of the real master retaining all 7 ambiguous pairs). Mutation-proven:
    drop the ×100 → 1 fail; guess instead of refuse → 1 fail; allow duplicates
    → 1 fail; never return null → 1 fail; each restored byte-identical.
  - **Runtime proof, real bytes, no DB:** zip → `decodeFeedText` → 20 rows + 1
    counted duplicate → master 10,673 → **resolved 20/20, zero drops**, sample
    `IN0020210244 2026-08-17 seg=WDM last=100.2 valLacs=15000 src=nse-wdm-daily`.
  - Four pre-existing structural guards legitimately changed shape and were
    **re-pinned, not loosened**: the family list, the `UnreadableFeedFile` count
    (11→13), and two body-scoped assertions that followed the upsert into the
    shared helper. One of them caught a real mistake — I had used a bare
    `throw new Error` for the dispatch-table guard, which the suite forbids
    because the dispatcher reads it as transient and goes red forever; it is now
    `UnreadableFeedFile`, matching `BOND_MASTER_PARSERS`.
- [ ] **T3 — Run the parse over the existing archive.**
      `./scripts/ops/run-market-data-job.sh …` for families
      `nse-wdm-list,nse-corporate-bond-report,nse-cbm-trades,nse-wdm-daily` on prod.
      The bytes are already in GCS; nothing is re-fetched from NSE. Feed-parse is
      per-file checkpointed, so a re-run is safe.
- [ ] **T4 — Verify by outcome, not by "archived".** Pass = `bond_master` and
      `bond_eod` non-zero on prod **and** a `feed-parse` log line naming each family
      with its row count. Record the numbers on MONEY-1210. Then re-run
      `sync-prod-to-qa.sh --collections-only --yes` so QA gets them too.
- [x] **T5 — Close the class, not just the instance.** DONE 2026-08-18.
  - **Shipped:** `packages/core/src/ops/build-provenance.ts` +
    `./ops/build-provenance` subpath export. Every one of the four
    `scripts/jobs/*` tsup entry points (`feed-parse`, `feed-backfill`,
    `feed-repair`, `fo-summary`) now calls
    `reportBuildProvenance(log, "<entrypoint>")` as the FIRST statement of
    `main()`, so the commit a nightly "SUCCEEDED" was produced by is a grep
    instead of an unanswerable question.
  - **Why runtime, not `setup-scheduler.sh`'s post-deploy checks** (the original
    suggestion above): a check inside a setup script only fires when somebody
    runs setup, which is exactly the thing that was not happening — the job's
    image had not moved since 14-Aug precisely because nobody re-ran the script.
    The drift bites at 22:35 IST unattended, so that is where the fact has to be
    emitted.
  - **Where the SHA comes from — no new mechanism.** `workers/Dockerfile`
    already has `ARG DD_VERSION=unknown` / `ENV DD_VERSION=${DD_VERSION}`, and
    the cloudbuild configs already pass `--build-arg DD_VERSION=$COMMIT_SHA`
    from the SAME substitution that forms the image tag. So `DD_VERSION` is a
    property of the IMAGE LAYER, not of the job spec —
    `gcloud run jobs deploy --set-env-vars` cannot forge it, which is what makes
    a stale job unable to report a fresh SHA.
  - **A real rot found while doing it:** `workers/cloudbuild.yaml` (the
    parameterised `_ENV` config) tagged with `$COMMIT_SHA` but never passed the
    `--build-arg` — so any image built through it baked the literal string
    `"unknown"` and could not be told apart from a fresh one. `prod.yaml` and
    `qa.yaml` both had the line. Fixed, and pinned by
    `job-build-provenance.test.ts` so it stays fixed.
  - **Deliberately NOT done — do not "fix" the permanent WARN.** The steady
    state is `indeterminate` (SHA known, nothing declares what it should be).
    The tempting fix is to have `setup-feed-backfill-job.sh` pass
    `--set-env-vars EXPECTED_BUILD_SHA=…`, and it would detect NOTHING: that
    script pins the job image by reading it off the live SERVICE, so the
    expected value would equal
    the image's own baked `DD_VERSION` by construction, on that day and every
    day after. A green that cannot go red is worse than the WARN it replaces.
    The honest close is for the release pipeline to RE-POINT the job image,
    which removes the drift rather than reporting it.
  - **Report-only by default.** A nightly job that aborts because it is one
    commit behind turns a partial run into no run, unattended — and during this
    incident `feed-parse-prod` was still correctly parsing every non-bond
    family. `BUILD_PROVENANCE_STRICT=1` is the opt-in lever for a caller that
    has decided otherwise.
  - **39 tests** (`build-provenance` 31, `job-build-provenance` 8).
    Mutation-proven, each restored byte-exact and re-verified 39/39 green:
    absent-expected → `match` (the fail-open) = **5** fails across 4 suites;
    drop the `--build-arg` from `cloudbuild.yaml` = **1**; delete the
    `feed-parse` call = **1**; drop `"unknown"` from the placeholder set = **1**;
    log an ERROR verdict at `info` = **2**; strict mode blocking drift only =
    **1**.
  - **Runtime proof on the REAL tsup bundle** (`workers/dist/feed-parse.js`,
    all four entry points carry it): the measured incident pair
    `DD_VERSION=fbdc29e2` vs `EXPECTED_BUILD_SHA=d7eefba7` prints
    `[build-provenance] ERROR feed-parse is running build fbdc29e2 but`
    `d7eefba7 was expected…`; a bare `DD_VERSION=d7eefba7` prints the WARN
    carrying the SHA; short-vs-full SHA of one commit prints
    `ok … matching on 8 chars`; an empty or `unknown` `DD_VERSION` prints the
    ERROR naming the build defect.
  - This is the same defect class as MONEY-1189's un-executed nightly fix.

Ticket: **MONEY-1210** (already filed with the archive-vs-parse finding; add 1a
and 1b as the diagnosed causes).

---

## 2. `shareholding_breakdown` — not a bug, not yet deployed

Measured: `origin/main` schema has **0** mentions; this branch has the model,
`ownership-sync.ts:358` probes it and `:934` groups by it, and W3-D's two new
legs (`shpXbrl`, `bse`) are its writers. Prod's scheduler list shows only
`ownership-sync-daily-prod` — the two new schedulers W3-D specified do not
exist yet. Prod service is `d7eefba7` (#325), which predates this branch's
ownership work.

Nothing to fix. It fills as part of shipping this branch:

- [ ] **T6** — `prisma db push` on prod **and** QA (new model + the widened
      `ShareholdingPattern @@unique(symbol, exchange, quarter)`; the old
      `(symbol, quarter)` unique must be gone — same check as MONEY-1203 step 0).
- [ ] **T7** — merge → promote to release → prod service rebuild.
- [ ] **T8** — provision `ownership-sync-shp-xbrl` (`10 1,6,16,22 * * *`) and
      `ownership-sync-bse` (`50 1,4,6,16,18,22 * * *`) via
      `setup-scheduler.sh prod`; both are in `PROD_ONLY_JOBS`. Descriptions are
      294/296 chars (limit 499).
- [ ] **T9** — after the first runs, verify `shareholding_breakdown` non-zero
      and that `fiiPct` is populated (the column that is null on all 7,953
      `shareholding_patterns` rows today; W3-D's live proof parsed 0.02 for
      AAKASH). Then `sync-prod-to-qa` — W3-D already added it to
      `REFERENCE_COLLECTIONS`, which is why the sync named it at all.

Ticket: rides MONEY-1205 / MONEY-1207 close-out. No new ticket.

---

## 3. `financial_data` — dead model, DROPPED 2026-08-18

Measured: no `prisma.financialData.*` call in `apps`, `packages`, `workers` or
`scripts`. The only textual hits are `financialData` as a **Yahoo JSON key**
(`chat/route.ts:1318`) and `get_financial_data` as a **chat tool name** —
neither touches this model. Shape (`symbol, exchange, dataType, period, data:
Json, source: "YAHOO", expiresAt`) is a per-symbol Yahoo response cache from
before `stock_financials` / `stock_ratios` existed. `sync-prod-to-qa` already
special-cased it as "prod empty → skip (guard)".

- [x] **T10** — Re-verified before deleting: fresh greps for `financialData.`,
      `financialData:`, `(prisma|db|client|tx).financialData` and for
      `$runCommandRaw|findRaw|aggregateRaw` naming `financial_data` all return
      **zero** real call sites. The only `financialData.` hits in the tree are
      `apps/web/lib/chat-tools/flash-responder.ts:140,146,153`, a **local variable**
      holding Yahoo `quoteSummary`'s module of that name.
      `workers/src/processors/financial-data-sync.ts` is the SUCCESSOR — it
      writes `stockRatios`, `stockFinancials` and `instrumentMapping`, never
      `financialData`. Prod = 0 rows.
- [x] **T11** — `model FinancialData` removed from `schema.prisma` (replaced by
      a short tombstone comment), `prisma generate` re-run. Type-only fallout: none,
      as expected. Also removed the stale `FinancialData` entry from
      `ARCHITECTURE.json` and its card in `ARCHITECTURE.html` (the two must stay in
      sync).
- [x] **T12** — `financial_data` removed from `REFERENCE_COLLECTIONS` in
      `sync-prod-to-qa.sh` (a dated NOTE replaces it so the deletion is auditable).
      `prod-only-sync-coverage` did **not** name it — checked: it is absent from the
      pinned lists, from `QA_DIRECT` and from `ACCEPTED_GAP`, and the only
      count-based assertion is `referenceCollections.size > 10` (32+ entries
      remain), so nothing there had to be relaxed. `TEST-COVERAGE.md`'s only
      `financial_data` hit is the `get_financial_data` chat tool — unrelated, left
      alone.

**STILL OUTSTANDING (manual, founder-gated):** `prisma db push` does not drop
collections, so the empty physical collection remains. Run
`db.financial_data.drop()` on **prod AND qa**.

Ticket: `financial_data` was the clearest of the 13 dead models found in the
empty-data sweep and is now **done** (above). The remaining **12** still want one
**schema-hygiene ticket**, not twelve: `news_feeds`, `AnalysisReport`,
`DailyJournal`, `Order`, `content_generations`, `custom_indicators`,
`glossary_terms`, `learning_modules`, `lesson_progress`, `lessons`,
`screener_validations`, `studio_generations`. **Not yet filed** — file it when
starting that work. Each one needs the same T10 evidence step `financial_data`
got (fresh grep for a real reader/writer, including the indirect
`$runCommandRaw`/`findRaw`/string-keyed-delegate forms) before anything is
deleted; several of those names are also live _chat tool_ or _type_ identifiers,
which is exactly the false-positive that made this model look load-bearing.

---

## What is NOT on this board

- **MONEY-1203 itself is done** — 6/6 DoD verified, DoD 6 at 100.0% prod→QA
  parity on all three collections with matching newest `snapshotAt`. Close it.
- `Chat = 0`, `ResearchReport = 0`, `stock_profiles = 0` against 652 paying
  subscriptions — flagged on MONEY-1203 as needing its own investigation ticket.
  Not filed yet; not in this plan.
- **MONEY-1209** (NSE session cookies in plaintext in prod logs, P1) — filed,
  independent of this board.
