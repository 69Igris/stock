# Historical feed backfill — operator guide & report

> MONEY-941 (Data Engine P3). Companion to
> [`exchange-archive-ranges.md`](./exchange-archive-ranges.md), which holds the
> registry seed and the probed floors.

## What this backfills

`scripts/jobs/feed-backfill.ts` walks every `backfillable` registry family day
by day and pushes the bytes through `getFeedAsset` into
`gs://stockbook-content-prod/feeds/`. It **parses nothing** — parsing is a
separate, flag-gated pass, because NSE prunes its archives and capturing bytes
is the urgent half.

**50 of 66 families are backfillable.** The other 16 are `backfillable: false`
for one of two reasons, and neither is a TODO:

- **Rolling / undated (14).** `bulk.csv`, `block.csv`, the 8 `ind_*list.csv`
  constituent files and the 4 Mutual Fund monthlies are single files upstream
  overwrites in place. Asking one "for 2019" returns TODAY's bytes and files
  them under a 2019 key — the archive would then assert it holds 2019's bulk
  deals while holding this morning's. Deal history comes from NSE's
  `historicalOR` API in P4; index-constituent membership history simply begins
  at the P2 deploy date.
- **Shape unknown (2).** `bse-egr` and `bse-index-daily-all` build no URL.

## Running it

```bash
# Always dry-run first: prints the day counts per family, fetches nothing.
node --import tsx scripts/jobs/feed-backfill.ts --dry-run \
  --families=nse-cm-legacy --from=1994-01-01 --to=2024-07-05

# The real thing. Run on PROD, where FEED_ARCHIVE_MODE=archive.
node --import tsx scripts/jobs/feed-backfill.ts \
  --families=nse-cm-legacy --from=1994-11-03 --to=2024-07-05 --rps=1
```

| Flag              | Env                     | Meaning                                                           |
| ----------------- | ----------------------- | ----------------------------------------------------------------- |
| `--families=a,b`  | `BACKFILL_FAMILIES`     | Registry ids. Omit for all backfillable.                          |
| `--from` / `--to` | `BACKFILL_FROM` / `_TO` | Window, clamped to each family's era.                             |
| `--rps`           | `BACKFILL_RPS`          | Request rate. **Leave at 1.**                                     |
| `--explore`       | `BACKFILL_EXPLORE_DAYS` | Days to descend BELOW the declared floor hunting the true edge.   |
| `--kmiss`         | —                       | Consecutive misses below the floor that end a range (default 20). |

**Run it on prod.** With `FEED_ARCHIVE_MODE` unset the walk fetches and
discards; the job warns loudly if you do this. QA receives the bytes through the
nightly feeds mirror rather than by walking the exchanges a second time.

**Shard by family across invocations** for the deep ones — each Cloud Run job
invocation should finish inside its timeout, and checkpoints make the split free.

## Behaviour worth knowing before you read the logs

**A 404 is a GAP, never the end of history.** P1 established that NSE's archive
is sparse and non-monotonic: 1994-11-03 is present, 11-04 is a genuine 404, and
12-01 is present again. So an in-range miss is checkpointed `MISSING` and the
walk continues, however long the run. Only **K=20 consecutive weekday misses
below the declared floor** end a range. An `ERROR` never counts toward that —
an error means we never learned whether the file exists, and letting a
throttling exchange convince the walker that history ended is the worst
available reading of a transient failure.

**No historical holiday calendar is consulted.** `nse-holidays.ts` covers
FY26-27 only. Weekend-skip plus 404-as-gap is the entire calendar rule, and it
is sufficient: a holiday and a missing file are equivalent here — both mean
there is nothing to archive.

**Newest-first.** Interruption is normal, so descending order means a truncated
run holds the most recent history rather than only the 1990s.

**Backoff is per HOST.** NSE rate-limits by IP, so a 403 on one family is a
statement about the whole host; 3 consecutive throttles pause it for 15 minutes.
The stop-loss counts errors only — a 1990s walk legitimately produces thousands
of misses, and folding those in would abort every deep walk in its first hour.

## Resuming

Every `(family, date)` is checkpointed in `feed_backfill_progress` with a
compound unique, so a re-run is an indexed lookup of what is already terminal
and the checkpoint write is an idempotent upsert. Killing and restarting the job
is safe and cheap; it picks up exactly where it stopped.

## Verifying a run

`packages/core/src/market-data/feed-backfill-verify.ts`:

- **`coverageByYear`** rolls checkpoints into per-year counts and grades each
  against the 240-252 trading-day band. This is the check that matters, because
  a backfill fails in a way that looks like success — a year is simply thinner
  than it should be, and a chart with 210 days instead of 250 just looks like a
  chart. `SUSPICIOUS` means re-run that year; `THIN` is a prompt to glance,
  since a genuinely sparse early year is possible.
- **`compareParity`** checks a legacy close against its UDiFF twin. This is what
  the **Jan–Jul 2024 era overlap** exists for: the same trading days are
  published in two independent formats, so agreement is real evidence both
  parsers are right. Without it there is nothing to compare a 30-year-old
  parser against except itself. Compared in integer **paise**, because
  `2845.61 - 2845.60` is `0.010000000000218` in binary float and a naive
  tolerance flags the most benign case there is.

## Run log

> Fill in as walks complete.

| Date | Families | Window | Archived | Missing | Errors | Notes                  |
| ---- | -------- | ------ | -------- | ------- | ------ | ---------------------- |
| —    | —        | —      | —        | —       | —      | no production walk yet |

---

## Integrity re-verify — 2026-08-16 (MONEY-1204 / 14a.1)

Read-only pass over `gs://stockbook-content-prod/feeds/**`. Nothing was written,
no checkpoint was reset, no exchange was contacted.

**Coverage: 67,065 objects walked.** That number is stated first on purpose. The
finding below is a ZERO, and a zero is only evidence when you can show the scan
actually looked — an empty walk and a clean archive print the same result. (The
first attempt at this scan did print `0` for every family, because it was piped
through a `timeout` that does not exist on macOS; without `set -o pipefail` the
broken stage was indistinguishable from "no matches". Same class as the absence
rules the parsers enforce.)

### Result

| Verdict    | Count | Meaning                                                              |
| ---------- | ----- | -------------------------------------------------------------------- |
| `empty`    | **0** | zero-byte objects — a successful write of nothing. **None found.**   |
| `envelope` | —     | MONEY-1169 multipart envelopes — needs the SDK-side pass (see below) |
| `html`     | —     | archived challenge/error pages — needs the SDK-side pass             |
| `invalid`  | —     | fails the magic-byte check its extension promises                    |

**The MONEY-1169 repair holds on the `empty` axis: not one zero-byte object
remains in 67,065.** The other three verdicts need a byte-level read of each
object; the code for that is `feed-repair.ts --audit` (below), and its run is
blocked — see "Blocked" at the end.

### Top families by object count

| Family               | Objects | Family                  | Objects   |
| -------------------- | ------- | ----------------------- | --------- |
| `NSE/cm-legacy`      | 7,339   | `NSE/index-snapshot`    | 3,207     |
| `NSE/mto`            | 6,086   | `NSE/shortselling`      | 2,223     |
| `NSE/fo-legacy`      | 5,940   | `NSE/sec-bhavdata-full` | 1,781     |
| `BSE/gross-delivery` | 4,840   | `NSE/fao-participant-*` | 1,637 ×2  |
| `NSE/fo-secban`      | 4,591   | `NSE/oi-cli-limit`      | 1,636     |
| `NSE/band-changes`   | 4,587   | `NSE/fii-stats`         | 1,636     |
| `NSE/fo-volatility`  | 3,605   | `NSE/sme-bhavcopy`      | **1,425** |
| `NSE/indices`        | 3,559   | `BSE/index-history`     | 793       |

### Two documented claims this scan FALSIFIES

Both were "the gap has been considered and dismissed" statements, which is the
dangerous kind — they stop anyone from looking again.

**1. `nse-sme-bhavcopy` is NOT unarchived, and its path was not simply "wrong".**
`report-registry.ts` carries `[--registry probe 2026-08-08: 404 — this exact path
is WRONG, not merely unproven. Do not enable without finding the real path
first.]` and the family ships `enabled:false`.

The bucket holds **1,425 objects under `feeds/NSE/sme-bhavcopy/`, spanning
2020-01 → 2025-10**, named exactly as the registry's own `buildUrl` produces
(`sme{DDMMYY}.csv` → `sme040520.csv`), with sizes that grow 6.4 KB → 78 KB as the
Emerge board grew. So the path was RIGHT for five and a half years and stopped
returning files after Oct-2025. The 2026-08-08 probe was truthful about 2026 and
its conclusion was over-generalised to the whole family.

Consequence for **14b.4**: there is a real, five-year SME price archive sitting
in the bucket that can be parsed today with **zero exchange egress**. The task is
a PARSE task, not the URL-discovery task the registry note implies. What still
needs deciding is the overlap against CM UDiFF series SM/ST (see
`per-file-derivable-map.md:90`) so the two do not double-ingest.

**2. EGR does not have "ZERO archived files".** Root `CLAUDE.md` says _"MWPL and
EGR have ZERO archived files because their registry paths 404; those are
URL-DISCOVERY tasks, not parse tasks."_ MWPL is correct — `feeds/NSE/mwpl-cli/`
holds 0 objects. **EGR holds 8**, all fetched successfully:

```
390 B  feeds/NSE/egr-bhavcopy/2026/05/EG_BC18052026.DAT
195 B  feeds/NSE/egr-bhavcopy/2026/05/EG_BC22052026.DAT
195 B  feeds/NSE/egr-bhavcopy/2026/08/EG_BC{03,04,05,06,07,10}082026.DAT
```

The path WORKS — a completely different finding from a 404, and it points at a
different action.

**CORRECTION (2026-08-16, after the bytes were actually parsed).** An earlier
revision of this paragraph said the 195 bytes were "a header with no rows". That
was wrong, and wrong in the direction that would have killed the task: the file
has **no header at all**, and those 195 bytes **are one complete data row** — a
single positional, comma-separated line for `GOLD10G99` carrying prev-close,
open, high, low, close, traded quantity, traded value and the date. So 195 B is a
normal thin-trading day for an instrument with one listed contract, not an empty
file, and "parse a header and write nothing" was never on the table. `egr-logic.ts`
now parses it.

Two column assignments were PROVEN from the bytes rather than assumed, each by a
falsifiable test that was actually run:

- **OHLC ordering** — columns 4-8 are the only assignment satisfying
  `low <= open <= high` with `close` inside. Reading them OPEN,HIGH,LOW,CLOSE,PREV
  puts the low (155349) ABOVE the high (155334).
- **quantity/value pairing** — `23,766,349 / 153 = 155,335.61`, which lands inside
  `[low 155324, high 155349]`: a session VWAP. The competing reading
  `23,766,349 / 110 = 216,057.72` sits **39% above the day's high**.

Also settled: the prices are **rupees, not paise**. ₹155,348 for "EGR 999 10 GRAM"
is ₹15,535/gram, which is where gold trades; a paise reading gives ₹1,553 per 10 g.
Five columns remain genuinely UNKNOWN; they are carried as raw cells with a written
falsification experiment each, never named and never persisted as a guess.

The registry's `startDate` is `2026-05-01` and the two May objects bracket it, so
the floor is right.

Also confirmed with 0 objects each, consistent with their registry notes:
`mwpl-cli`, `corpbond`, `combine-oi`, `nccl-oi`.

### `feed-repair.ts --audit` — new, read-only

`--audit` classifies every object from a RANGED read of its first 512 bytes plus
the declared size: no full download, no write, and `--apply` is ignored while it
is set (a read-only mode that a stray flag can upgrade to a writing one is not
read-only). It prints a per-family table of `ok / empty / envelope / html /
invalid`.

The classifier is `packages/storage/src/archive-audit.ts` — pure, 19 unit tests,
and deliberately co-located with `isMultipartEnvelope` so there is exactly ONE
implementation of "is this object corrupt". `packages/core` does not depend on
`@usemoney/storage`, so putting it there would have meant a second copy of the
envelope sniff, and two copies of a corruption predicate agree until the day they
do not.

`empty` and `envelope` are kept as separate verdicts because their remedies are
opposite: an envelope is repairable in place from bytes already held, while a
zero-byte object can only be fixed by re-fetching — which for a 2005 file may no
longer be possible. Collapsing them into one "bad" bucket is what turns a
re-fetchable gap into a permanent one.

### Blocked

- **The byte-level `--audit` run** (envelope / html / invalid verdicts) needs
  Application Default Credentials for the Node SDK; ADC currently fails
  `invalid_rapt` (expired reauth). The `gcloud` CLI uses different credentials,
  which is why the size-based `empty` scan above completed. Unblock with an
  interactive `gcloud auth application-default login`, then:
  `GCP_PROJECT_ID=stock-book-483718 node --import tsx scripts/jobs/feed-repair.ts --audit --bucket=stockbook-content-prod --prefixes=feeds/`
- **Re-walking the two zero-object checkpoint ranges** (`bse-index-history`, the
  54 `nse-cm-legacy` days) WRITES to the prod bucket and contacts the exchange —
  founder-gated, not attempted. Note `bse-index-history` already holds 793
  objects and `nse-cm-legacy` 7,339, so neither is empty at family level; the
  zero-object days are specific dates inside those ranges and identifying them
  needs the per-day checkpoint diff, not a bucket listing.
