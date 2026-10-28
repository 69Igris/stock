# `document_embeddings` — measure, and decide the shrink

**MONEY-1471 (data-platform B0). Measured 2026-09-17 against PROD.**
This document decides; **MONEY-1472's sibling B8 executes.** Nothing has been
deleted, rewritten or re-indexed by this ticket.

Every number below is the output of
`npx tsx scripts/ops/embeddings-profile.ts --env prod --sample 20000`, and is
reproducible by re-running it. Where a figure is sampled rather than counted,
it says so — a projection and a census must not read alike.

---

## 1. What is actually there

|                   |                                                |
| ----------------- | ---------------------------------------------- |
| documents         | **5,865,339**                                  |
| data              | **67.15 GiB**                                  |
| storage           | 53.33 GiB                                      |
| indexes           | 0.30 GiB                                       |
| average document  | 12.0 KiB                                       |
| vector dimensions | 768 (observed, no other value seen in 20,000)  |
| embedding model   | `text-embedding-004` — 100% of a 20,000 sample |

**S0's figures are stale and should not be re-quoted.** S0 said 5,555,213 docs
and 50.8 GiB; the collection is now **5,865,339 docs and 67.15 GiB**. It grew
~310k documents and ~16 GiB between 14-Sep and 17-Sep. Any arithmetic in the
plan that still uses 5.55M is low by 5.6%.

### By docType — EXACT, from the index

`@@index([docType])` exists, so these are counted, not sampled.

| docType                   | documents |     share |
| ------------------------- | --------: | --------: |
| `annual_report`           | 4,317,836 | **73.6%** |
| `corporate_filing`        |   419,233 |      7.1% |
| `announcement`            |   333,089 |      5.7% |
| `quarterly_result`        |   265,048 |      4.5% |
| `drhp`                    |   225,061 |      3.8% |
| `concall_ppt`             |   220,910 |      3.8% |
| `screener_financials`     |    25,739 |      0.4% |
| `credit_rating`           |    17,503 |      0.3% |
| `concall_transcript`      |    13,241 |      0.2% |
| `financial_statement`     |    12,191 |      0.2% |
| everything else (8 types) |    15,478 |      0.3% |

**Three types are 86.4% of the collection**, and one is nearly three-quarters.
Whatever B8 does, it is a decision about `annual_report`.

---

## 2. The cost is the VECTOR, not the text

This is the finding that changes the answer, and it inverts the assumption the
prompt was written with.

| half        |          size | how                                                              |
| ----------- | ------------: | ---------------------------------------------------------------- |
| **vectors** | **33.56 GiB** | 768 dims × 8 B BSON double × 5,865,339 — arithmetic, not sampled |
| **content** | **10.68 GiB** | mean 1,954 B × 5,865,339 — mean from a 20,000 sample             |

The vector is **3.1× the text**. "The chunk text is inline and that is why the
collection is huge" is the intuitive reading and it is wrong: `content`
averages 1,954 B (min 8, max 5,867) while every document carries a fixed
6,144 B of float64 whether its text is 8 bytes or 5,867.

The two halves sum to 44.2 GiB against 67.15 GiB measured. The remaining
~23 GiB is BSON overhead, `_id`, the five indexed fields and WiredTiger
padding — worth knowing, because **no option below touches it.**

### What each lever is worth, arithmetically

| option                                      | vector | content | collection after |              saved |
| ------------------------------------------- | -----: | ------: | ---------------: | -----------------: |
| today                                       |  33.56 |   10.68 |        **67.15** |                  — |
| (a) BinData **float32**                     |  16.78 |   10.68 |            ~50.4 |     16.8 GiB (25%) |
| (a) BinData **int8**                        |   4.20 |   10.68 |            ~37.8 | **29.4 GiB (44%)** |
| (b) content out, pointer + 200-char preview |  33.56 |    1.09 |            ~57.6 |      9.6 GiB (14%) |
| (a int8) + (b)                              |   4.20 |    1.09 |            ~28.2 | **39.0 GiB (58%)** |

**(a) alone beats (b) alone by 3×**, and (a) is the cheaper change: a vector is
rewritten in place, while (b) needs a chunk store, a fetch path in three
readers, and a migration that can leave text stranded.

---

## 3. Duplication is UNMEASURED, and the sample cannot measure it

`exact dupes: 2 redundant of 20,000 (0.0%)`.

**Do not read that as "there is no duplication."** It is a lower bound and a
weak one: two copies of one boilerplate paragraph among 5.87M rows are very
unlikely to both be drawn into one sample. The number is consistent with
0.003% duplication and equally consistent with 30%.

`chunks per docId` and a real duplication census both need a **full collection
scan**, and the attempt is recorded here as a result rather than omitted:

```
npx tsx scripts/ops/embeddings-profile.ts --env prod --sample 20000 --census
→ Error code 50 (MaxTimeMSExpired): PlanExecutor error during aggregation
```

A `$group` over 5.87M documents exceeds the script's 120 s server-side ceiling
on this cluster. That ceiling is deliberate — an unbounded aggregation against
the cluster that serves the product is how a measurement becomes an incident —
so the census is **deferred to B8**, which scans the collection anyway to
rewrite it. Pruning cannot be sized before then, and **must not be included in
B8's acceptance target on today's evidence.**

---

## 4. The constraint: retrieval latency inside a chat turn

`fetch-document-context` runs inside a research-agent turn, with
`numCandidates = topK × 12`. Whatever B8 does, p95 must not regress against
what that path measures today.

That rules out one option outright:

- **BigQuery `VECTOR_SEARCH`** is batch/analytical — seconds. Fine for a future
  RAG-corpus job, not for a call a user is waiting on mid-conversation.
- **Vertex AI Vector Search** is millisecond-latency but needs an always-on
  endpoint with its own hourly cost, and it moves a working retrieval path onto
  new infrastructure to solve a STORAGE problem. Its cost must be quoted from
  the pricing page before it is considered, and it is not justified by anything
  measured here.
- **Atlas Vector Search**, where the data already is, keeps the latency
  characteristics the agent already depends on.

---

## 5. Recommendation

**Stay on Atlas Vector Search. Quantize the vectors to int8 (a). Defer the
content move (b) and the prune (c).**

Reasons, in order:

1. **(a) is 75% of the available saving for the least risk.** 29.4 GiB of 39.0
   GiB, achieved by rewriting one field in place — no new store, no fetch path,
   no reader change beyond the type.
2. **(b) touches three readers** (`fetch-document-context.ts`,
   `user-document-retriever.ts`, `vector-store.ts`) and adds a GCS round trip
   to a latency-constrained path, for 9.6 GiB.
3. **(c) cannot be sized yet** — see §3. Committing to a prune target on a
   20,000-row sample would be exactly the not-measured-is-not-passed mistake
   this repo keeps paying for.

**The open question is ANSWERED, and §5 survives it.** Measured 2026-09-17 by
`embeddings-profile.ts` §7, which reads the live definition through
`$listSearchIndexes` — a native aggregation stage on the connection the script
already holds, so no Atlas Admin key pair:

```
document_embeddings_vector_index  type=vectorSearch status=READY queryable=true
   vector embedding  dims=768 similarity=cosine quantization=absent
```

**`type: vectorSearch`, so no index migration is needed.** The branch that would
have changed the recommendation rather than its size — a legacy `knnVector`
field inside a classic `search` index, which supports no quantization at all —
did not fire. int8 is reachable from where we stand.

### But §2's table and this field are TWO DIFFERENT LEVERS

This is the distinction the question was phrased too loosely to separate, and
getting it wrong would produce a migration that reports success and frees
nothing:

| lever                                 | what it compresses                 | visible in `collStats`                                                                                          |
| ------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `quantization: "scalar"` on the index | the HNSW graph on the mongot nodes | **no** — a search index is not in `totalIndexSize`, which reads 0.31 GiB and is the regular Mongo indexes alone |
| BinData int8 in the **collection**    | the stored `embedding` field       | **yes** — this is §2's 29.4 GiB                                                                                 |

§2's arithmetic is about the SECOND. Setting the index field alone buys search
memory and leaves the 68 GiB untouched; B8's footprint criterion is measured by
`collStats`, so it would fail while looking done. The two are compatible and
worth doing together, but only one of them is what §6 grades.

**Confirm before arming: `similarity` is `cosine`.** Atlas constrains which
similarity functions accept an int8 BinData vector. If cosine is not among them,
the migration also has to normalize every vector and move the query to
`dotProduct` — a change to the READ path in all three readers, which is cost §5
does not currently carry. Verify against the Atlas docs for the cluster's
version before the first write, not after.

### The collection is growing WHILE B8 would run

Re-measured the same day as §1:

|              | §1 (earlier 2026-09-17) | §7 run (later 2026-09-17) |     delta |
| ------------ | ----------------------: | ------------------------: | --------: |
| documents    |               5,865,339 |             **5,951,933** |   +86,594 |
| data         |               67.15 GiB |             **68.14 GiB** | +0.99 GiB |
| content mean |                 1,954 B |                   1,956 B |      +2 B |

Neither figure is wrong; both carry their timestamp. What it means for B8 is
structural: a read-then-write migration must define what happens to rows created
after its cursor passes, or it will finish with a tail of un-migrated float64
documents and no record of which they are. Size the run against the rate, and
make the leftover set QUERYABLE rather than inferred.

---

## 6. B8's acceptance criteria

B8 may not be called done until all five hold:

|               | criterion                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Footprint** | `document_embeddings` ≤ **40 GiB** (from 67.15). Measured by `collStats`, not estimated.                                                        |
| **Parity**    | 50 sampled research queries, top-K before and after, **overlap ≥ 0.9**. A query set fixed BEFORE the migration, so it cannot be chosen to pass. |
| **Latency**   | `fetch-document-context` p95 no worse than the pre-migration measurement, taken over the same window length.                                    |
| **Rollback**  | the old collection **RENAMED to `document_embeddings_v1_retired`, never dropped**, and kept 30 days. An Atlas snapshot before the first write.  |
| **Census**    | B8's own full scan reports the real duplication rate and chunks-per-docId, and those numbers land back in this document.                        |

The 40 GiB target is deliberately looser than §2's 37.8 GiB arithmetic: that
arithmetic assumes every document quantizes, and a type the index cannot carry
would leave some at float64. A target that assumes a perfect migration is a
target that fails for the wrong reason.

---

## 7. Reproducing this

```bash
# the measurement in this document
npx tsx scripts/ops/embeddings-profile.ts --env prod --sample 20000

# the census — a FULL SCAN, currently exceeds the 120s ceiling on prod
npx tsx scripts/ops/embeddings-profile.ts --env prod --sample 20000 --census
```

§7 (the search index) runs on every invocation, so the first command above
re-answers §5's gate — it needs only a live `gcloud auth login`, since the
connection string comes from Secret Manager. It reports THREE states, never
two: `DID NOT RUN` with the error text, `none declared` when the stage ran and
returned nothing, or the field list. Collapsing the first two is how
`listFiles` failing open to `[]` becomes a recorded finding.

The script is read-only: it writes nothing, deletes nothing, and creates no
index. Every aggregation is bounded by `maxTimeMS = 120000`, so a pipeline that
turns out to be a full scan is killed by the server rather than left running
against the cluster that serves the product.
