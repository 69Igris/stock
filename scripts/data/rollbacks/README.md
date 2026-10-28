# `scripts/data/rollbacks/` — destructive-repair recovery artefacts

Every file in this directory is the **only surviving copy** of something a
`scripts/data/` repair script overwrote or deleted. None of it can be
re-derived from the database, from a feed, or from a re-run.

Read this before you delete anything here, and before you replay anything from
here.

---

## Why this directory exists at all

The writers below used to resolve their snapshot path against
`process.cwd()`. In practice that meant the repo root, because that is where
`yarn data:*` and `scripts/ops/run-market-data-job.sh` are run from — so the
artefacts landed as an untracked, unexplained pile of `*.json` next to
`package.json`. A routine tidy of the root cleared them, and the next `--apply`
silently re-created the pile with no record that the previous one had been
thrown away.

Since **MONEY-1204** they all anchor on `import.meta.url` instead (and
`repair-instrument-names.ts`, added in **MONEY-1205**, does so from the
start), so the path
is repo-relative and identical no matter which directory the operator invoked
from:

```ts
path.resolve(path.dirname(fileURLToPath(import.meta.url)), "rollbacks");
```

The directory is created with `mkdirSync(..., { recursive: true })` at write
time, **after** the dry-run bail — a dry run still touches nothing on disk.

---

## What is here (as of 2026-08-16)

| File                                                                         | Bytes       | Written (IST)    | Producer                     | What replaying it reverses                                                                                                                             |
| ---------------------------------------------------------------------------- | ----------- | ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `purge-orphans-rollback-latest_quotes-2026-08-08T14-29-52-260Z.applied.json` | 2,830,632   | 2026-08-08 19:59 | `purge-orphan-price-rows.ts` | The **full documents** of the `latest_quotes` rows the run deleted. They are gone from the database entirely; this file is the restore source.         |
| `purge-orphans-rollback-daily_prices-2026-08-08T14-29-52-260Z.applied.json`  | 133,711,510 | 2026-08-08 20:00 | `purge-orphan-price-rows.ts` | The **full documents** of the `daily_prices` rows the same run deleted. Same story, ~500k rows of it.                                                  |
| `reclassify-rollback-1786631418411.applied.json`                             | 290,254     | 2026-08-13 20:00 | `reclassify-instruments.ts`  | 936 `InstrumentMapping` rows retyped away from `EQUITY`: restores `previousInstrumentType`, `previousSector`, `previousIndustry` per `id`.             |
| `resector-rollback-1786631444596.applied.json`                               | 84,746      | 2026-08-13 20:00 | `resector-real-estate.ts`    | 292 `InstrumentMapping` rows moved into the `Real Estate` sector: restores `previousSector` per `id`.                                                  |
| `reclassify-rollback-1786644184890.applied.json`                             | 325,533     | 2026-08-13 23:33 | `reclassify-instruments.ts`  | 964 rows, same shape as the 20:00 snapshot but the **other environment** (its `target` records an Atlas host; the 20:00 pair records an IP-form host). |
| `resector-rollback-1786644234291.applied.json`                               | 80,725      | 2026-08-13 23:33 | `resector-real-estate.ts`    | 278 rows, same shape as the 20:00 snapshot, same other environment.                                                                                    |

The two 2026-08-13 runs are a **pair per environment** — `reclassify` first,
`resector` a few seconds later — which is the documented order (retype the
bonds, then move the property companies). Do not replay one half of a pair.

The exact database each run touched is recorded in the artefact's own `target`
field, credentials masked. It is deliberately **not repeated here**: that string
is one of the reasons this directory is gitignored (see below).

`stock-ratios-repair-rollback-*.json`, written by
`scripts/ops/repair-stock-ratios-links.ts`, is matched by the ignore rules here
but that script has **not** been moved to this directory — it still writes to
its cwd. Do not assume its journals are here.

---

## `status: "staged"` vs `.applied.json` — read the field, not the name

`reclassify-instruments.ts`, `resector-real-estate.ts` and
`repair-instrument-names.ts` write the snapshot **before** the first database write, with `"status": "staged"`. Only after the
writes succeed do they rewrite the content to `"status": "applied"` (adding
`appliedRows`, `appliedAt` and `writtenIds`) and _then_ rename the file to
`*.applied.json`.

The content is authoritative and the filename is a convenience, in that order,
because **a filename cannot be updated by a crash**:

- A run that aborts at the confirmation prompt leaves a `staged` file describing
  writes that never happened. Replaying it would **revert legitimate state**.
- A run that throws mid-chunk, or whose `renameSync` fails, leaves rows already
  written under the _staged_ name. A responder reading only the name would
  conclude "nothing happened" and fail to replay.

So: open the file, read `"status"`. If it says `applied`, prefer **`writtenIds`**
over `rows` — `rows` is the full **planned** set, and the concurrency guard
(the nightly writers run 21:00 and 22:00 IST) can leave planned rows unwritten.
Replaying `rows` wholesale would overwrite the nightly writer's legitimate work.

The `purge-orphans-*` snapshots have no envelope — they are a bare streamed JSON
array of the deleted documents, so the `.applied.json` suffix is the only signal
they carry, and it is applied by the same rename-after-success step.

Each envelope also carries a `note` field with the replay instruction, e.g.
`"Replay: set sector back to previousSector for each id."`

---

## Why these are kept rather than deleted

**For `reclassify` / `resector`:** `sector` and `industry` exist **nowhere
else**. `InstrumentMapping` has no history column, and the sector-enrichment
pipeline only ever fetches rows whose sector is **UNSET** — and, for
`reclassify`, only rows still typed `EQUITY`. So a row that was wrongly retyped
to `DEBT`, or whose sector was wrongly cleared, is _never_ revisited by any job.
Even after a manual retype back to `EQUITY`, the next enrichment pass fetches a
**fresh** value from Yahoo, which is not the same thing as the original value.
The only way back to what was there before is this file.

**For `purge-orphan-price-rows`:** the deleted `latest_quotes` / `daily_prices`
documents were removed from the database outright. There is no soft-delete, no
tombstone, and no job that reclaims them (ingest upserts by `instrumentId` /
`(instrumentId, date)`, so a row whose `instrumentId` is not in that environment
is never revisited). These two files are the entire record.

---

## Git: ignored on purpose, and fragile because of it

The artefacts are ignored by five **filename-based** patterns in the repo-root
`.gitignore` (lines 73 and 87–90 as of MONEY-1204). None contains a `/`, so they
keep matching inside this subdirectory — verified with `git check-ignore -v`:

```
stock-ratios-repair-rollback-*.json
reclassify-rollback-*.json
resector-rollback-*.json
repair-names-rollback-*.json
*-rollback-*.applied.json
purge-orphans-rollback-*.json
```

> `repair-names-rollback-*.json` was added in **MONEY-1205** and is not
> cosmetic. `*-rollback-*.applied.json` only matches the artefact **after** a
> successful run; a run that aborts at the confirmation prompt — or throws
> mid-write — leaves the **staged** file behind under its plain `.json` name.
> Without its own pattern that file is untracked-and-visible, so a `git add -A`
> would commit the masked-but-real production cluster host in its `target`
> field. Any future repair script must add its own staged-name pattern here.

**This README is not matched by any of them** and is committed — it is the part
of the directory that is allowed to travel.

Two consequences, both sharp:

- **`git clean -fdx` destroys the only recovery path.** Untracked + ignored is
  exactly what that command removes. Nothing warns you, and nothing regenerates
  them. If you need a clean tree, move this directory aside first.
- **They must never be staged.** `git add -A` would otherwise commit a
  _masked-but-real_ production cluster hostname (the `target` field), plus
  hundreds of thousands of raw price documents. That is why the ignore rules
  exist, and why widening them to a directory-scoped rule that could be
  negated is not an improvement.

---

## Size warning

`purge-orphans-rollback-daily_prices-…applied.json` is **~134 MB**
(133,711,510 bytes). It was produced by streaming documents to disk precisely so
that ~500k rows never had to be held in memory at once.

- **Do not open it in an editor**, and do not `cat` it. Most editors will try to
  load and syntax-highlight the whole array.
- It is a JSON _array_, one document per line between `[\n` and `\n]`, so
  line-oriented tools work: `head -c 2000`, `sed -n '2,5p'`, `wc -l`, or a
  streaming parser. `jq` will read it but buffers the whole document.
- Any replay must stream it back in batches, the same way the purge deleted in
  batches of 5,000.
