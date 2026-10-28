# Doc-ingest population, batch path and model — MEASURED

> **RE-MEASURED 2026-09-05 (MONEY-1337).** The §1 and §2 figures below are the
> 2026-09-01 census and are kept for provenance; these are the current ones.
>
> ```
> stock_documents                       97,314
>   PDFs                                89,330
>   PDFs with a stored object           82,336
>   gcsPath "" (BSE dropped it)          7,549
>
> conversion (of the 82,336)
>   CONVERTED                           32,893
>   never selected (attribute ABSENT)   39,291
>   PENDING (arrived since 09-01)        8,801
>   SCANNED_ONLY                         1,196
>   FAILED                                 155
>   -> UNCONVERTED                      48,092
>
> parse (PDF rows)
>   PENDING                             49,807
>   ABSENT                              37,749
>   PARSED                               1,382
>   FAILED_VALIDATION                      341
>   BATCHED / PROCESSING, stale             24
>   -> WAITING (annual + quarterly)     50,801
>
> extracts
>   EXTRACTED                            4,983   (1,370 symbols)
>   FAILED_VALIDATION                    1,885
>     of which UNKNOWN_SCALE             1,821   (96.6%; 1,804 sole reason)
>     TOTAL_INCOME_MISMATCH                 79
>     BALANCE_SHEET_IMBALANCE                2
> ```
>
> Two things this replaces outright. **The conversion drain stalled on
> 2026-09-02** — two executions ended "The configured memory limit was
> reached" — and nothing has converted or parsed since; MONEY-1339 answers that
> with four sharded 8Gi tasks. And **0 of 30,959 quarterly results are
> converted**: the queue is ordered `fetchedAt` ASC and 27,170 of them arrived
> on 27-28 August, so they sit at the end of it.
>
> The scanned-share split also needs reading per docType. Corpus-wide, 15.2% of
> converted documents are >=20% scanned — but that is dominated by concall
> slide decks, which the financials lane never parses. For ANNUAL REPORTS it is
> **817 of 13,339 (6.1%)**.

**Measured against PROD 2026-09-01.** Every size, cost and wave number in
MONEY-1314 cites THIS file. Three earlier figures were in circulation and two
of them were wrong; see §1.

---

## 1. Population — `buildParseQuery`'s exact predicate

Replicated exactly: `(parseStatus PENDING ∨ ABSENT) ∧ mimeType ∈
EXTRACTABLE_DOC_MIME_TYPES ∧ docType ∈ PARSEABLE_DOC_TYPES`, `force = false`.

```
ELIGIBLE                                        48,322
  quarterly_result   BSE                        29,669   (61.4%)
  annual_report      NSE                        15,923   (33.0%)
  annual_report      BSE                         2,730   ( 5.6%)
  financial_statement (any)                          0
```

**Which prior number was right.** MONEY-1308 measured **48,509** on 30 Aug —
this is 48,322 two days later, i.e. the same set. The research doc's **29,663**
and the in-code comment's **15,705** are both stale by a wide margin.

> **CITE 50,801, NOT 48,322 — re-measured 2026-09-05.** This section used to end
> "Cite 48,322", which contradicted the census block at the top of this file
> from the moment that block was added. The waiting set is now **50,801**
> (annual + quarterly), and the breakdown above is a 09-01 snapshot kept for the
> _shape_ of the split rather than its magnitudes — the queue has grown, and
> `PARSE_SCAN_CAP` is breached by more than it was.
>
> An instruction to cite a number outlives the number, which is why this is a
> correction here rather than only a newer figure elsewhere.

⚠️ **`PARSE_SCAN_CAP = 40_000` IS ALREADY BREACHED.** 48,322 > 40,000, so
`selectBreadthFirst`'s breadth-first pick silently narrows to the oldest 40,000
**today**, before this branch changes anything. The constant is at
`stock-document-parse-logic.ts:296` and its docstring still sizes itself against
"~15,700 eligible". MONEY-1314 raises it and the backfill job pages instead of
relying on a cap.

### The cohort is 627, not 1,681 or 1,865

```
symbols with an eligible annual_report              2,086
symbols already present in stock_financials         2,123
COHORT — latest annual per UNCOVERED symbol           627
```

Coverage has moved a long way since the "1,681 latest-per-symbol" comment was
written: most annual-report symbols now already have financials from the XBRL
lane, so the _uncovered_ cohort — the one that actually adds ratio coverage —
is **627**. Cheap enough that the cohort batch is a rounding error against the
tail.

The join is `symbol` only (matching `fetchCoveredSymbols`'s deliberate
over-match across exchange). "Latest annual" uses the `docType:"annual_report"`
proxy plus `fiscalYearOf` as a SORT key — `period` is free text
(`"2024" | "Q3-2024" | "FY2024-25"`) and there is no annual-vs-quarterly
predicate in the schema.

## 2. Corpus for `scan-convert` (any parseStatus, any docType)

```
all PDF rows                                       79,884
  with a usable gcsPath                            72,650
  gcsPath EMPTY — skipped by name                   7,234
total bytes                                        309.8 GB
average                                             4.26 MB
maximum                                           222.3 MB
```

Two things follow.

**The empty-path population grew** from the 6,125 documented in CLAUDE.md to
**7,234**. These are BSE rows whose attachment is gone upstream (retention:
BSE serves nothing before ~2018). `assertSafeObjectKey` already throws
`"GCS path is empty"` on them — the scan skips by name, never by exception.

⚠️ **The largest PDF is 222.3 MB, and Gemini's document limit is 50 MB**
(`MAX_PDF_BYTES` in `gemini-pdf.ts` already encodes this, returning
`TOO_LARGE`). So the whole-PDF _vision_ path — both the online retry and the
batch fallback — **cannot process the largest documents at all**. This is not
new and not caused by this branch, but it is the strongest argument for the
markdown path: page-selected markdown has no such ceiling. Documents over
50 MB are markdown-or-nothing.

`scan-convert` pages through 309.8 GB of GCS reads. That is the job's dominant
cost (egress inside the same region/project is free; the time is the constraint)
and it logs GB read as it goes.

## 3. Batch path — rung (i), Developer-API batch. PROBED, not assumed.

Probed live 2026-09-01 with `GOOGLE_GENAI_API_KEY_PROD`:

| Probe                                                         | Result                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /v1beta/models`                                          | 52 models; **`gemini-3.7-flash` present**                                                        |
| `generateContent` on `gemini-3.7-flash` with `responseSchema` | **200**, valid JSON, `modelVersion: "gemini-3.7-flash"`                                          |
| `POST …:batchGenerateContent` (2 inlined requests)            | **ACCEPTED** — `batches/erdmxqj4t8ibqcgv4iijrmar1rdstg5dexzd`, `BATCH_STATE_PENDING` → `RUNNING` |

**Rung (i) is taken: Developer-API batch.** The ladder's rungs (ii) Vertex and
(iii) stop are not needed. Consequences worth stating because they close two
open questions from the research:

- **The endpoint is region-less** — it is the same one `gemini-pdf.ts` already
  uses in prod, so the backfill introduces **no new data-residency posture**.
  (Founder direction 2026-09-01: any region is acceptable; this path did not
  need the concession.)
- Vertex's constraints — the `global`-endpoint residency disclaimer, the
  200k-request / 1 GB job caps, the `{"request":…}`-with-no-`key` line shape —
  **do not apply**. They stay documented in the synthesis for the day someone
  reconsiders Vertex.

### The line shape that was ACCEPTED

Developer-API batch, inlined form, verbatim from the accepted request:

```json
{
  "request": { "contents": [{ "parts": [{ "text": "…" }] }] },
  "metadata": { "key": "probe-1" }
}
```

The correlation key rides at **`metadata.key`**, not as a top-level `key`
field. `buildBatchRequestLine("developer")` emits exactly this. (The
top-level-`key` shape reported in some sources was not what the API accepted
here — the probe is the authority.)

For 48k documents the input goes in as a **JSONL file via the Files API**
rather than inlined; `batch-build` writes that file and `batch-submit` uploads
it. Wave sizing follows the account's enqueued-token allowance, discovered by
submission rather than from a published table (Google no longer publishes them).

## 4. Model

**Backfill model: `gemini-3.7-flash`** — the latest Flash live on the chosen
path, verified above.

|                 | input $/1M | output $/1M |
| --------------- | ---------- | ----------- |
| online          | 0.75       | 3.75        |
| **batch (50%)** | **0.375**  | **1.875**   |

⚠️ **The promotional rate expires 1 Jan 2027**, after which input doubles to
$1.50. Any drain not finished by then costs twice as much; this is a reason to
run the tail promptly, not to re-plan.

`gemini-3.7-flash` is **not currently registered** in
`packages/core/src/gemini/model-registry.ts` (`CHAT_MODEL_BY_TIER.PREMIUM` is
`gemini-3.5-flash`). MONEY-1314 adds a registry entry and selects 3.7 for the
BACKFILL explicitly. It does **not** change `CHAT_MODEL_BY_TIER` — the
steady-state realtime model is decided by the step-5 bake-off
(`gemini-2.5-flash` vs latest) and set via `DOC_PARSE_MODEL`.

## 5. Cost — MEASURED 2026-09-01, replacing the earlier estimate

The earlier version of this section gave "$454 (3k out) vs $918 (8k out)" for
the markdown path and an honest range of "$400-1,700" for a whole-PDF
fallback, with the note that it "will be replaced by a computed number before
any tail batch is submitted". This is that number.

### What the corpus actually splits into

30 PDFs were pulled from `stockbook-content-prod` spread across the archive and
run through the real pipeline (`convertPdfToMarkdown` -> `selectPagesForExtraction`).
Restricting to the ELIGIBLE docTypes — `annual_report` + `quarterly_result`,
n = 19 (11 AR, 8 QR):

```
markdown-usable   12   63.2%
needs vision       6   31.6%    (4 fully scanned + 2 gate-failover)
unreadable         1    5.3%    (0 pages returned)
```

⚠️ **n = 19 is small.** These proportions are good enough to size a budget and
to establish that the vision lane is a THIRD of the work rather than a rare
retry; they are not good enough to plan a schedule around. The pilot batch
(200 documents) replaces them.

**The vision share is the finding.** The cost model assumed markdown handled
essentially everything and treated whole-PDF as a rare fallback. It is
~15,260 documents at a mean of 78 pages — a real, separate line item.

### The arithmetic

Every constant here is measured rather than assumed: 3.93 chars/token on this
vendor's own tokenizer, a 4,506-token prefix discounted ~90% by implicit
caching, and 2,329 output tokens per document (1,728 output + 601 thinking,
observed on a two-period extract — not the 8,192 the schema permits).

| lane     |   docs | input tok/doc | note                                               |
| -------- | -----: | ------------: | -------------------------------------------------- |
| markdown | 30,519 |         6,520 | mean 23,854 selected chars, well under the 40k cap |
| vision   | 15,260 |        20,489 | mean 78 pages x 258 tok/page                       |

```
  input                                    $192
  output                                   $200
  markdown call wasted on a gate-failover   $35
  ----------------------------------------------
  TOTAL                                    $426     (ceiling $1,000)
```

**Output is 47% of spend**, so tightening the response schema remains the
single largest lever — but it is no longer the difference between affordable
and not. The cohort (627 documents) is ~$6.

> **SUPERSEDED IN BOTH DIRECTIONS — MONEY-1332 / MONEY-1334, 2026-09-03.**
> Two of the constants above moved and they move the total OPPOSITE ways, so
> the $426 cannot be adjusted by scaling it — it needs re-deriving before the
> drain.
>
> - **Output per document is larger.** "2,329 output tokens (1,728 + 601
>   thinking), not the 8,192 the schema permits" was measured on a TWO-PERIOD
>   extract that COMPLETED. On a real corpus 15 of 22 answers hit the ceiling
>   mid-JSON: ~78% of an 8,192 budget was going to thinking. The ceiling is now
>   16,384, explicitly split 8,192 visible + 8,192 thinking, so a document may
>   legitimately bill ~7x what this table assumes.
> - **Fewer documents take the model lane at all.** 12 of 16 sampled failures
>   had no numeric balance sheet in their sidecar because the statement pages
>   were scanned images the converter drops. Those documents now route to
>   vision BEFORE the sidecar is read (measured on the 25-document pilot: 10 of
>   25, and GCS reads fell 3.64 GB -> 0.003 GB), which removes a markdown call
>   AND its wasted-failover cost while adding a vision call.
> - **The markdown/vision split above is therefore wrong**, not merely stale:
>   it was derived from `convertStatus`, which says a document has SOME text,
>   not that it has its STATEMENTS.
>
> Also note `cachedTokens` was **0** across the first gemini-3.7-flash batch
> (against 10,887 on a 3.5-flash run). The ~90% prefix discount in the
> arithmetic above is not a given — a steady zero is a ~2.4x bill with no error
> anywhere, so read it from the pilot rather than assuming it.

### What would move this

- A higher gate-failover rate than 2-in-19. Each failover pays the markdown
  call and then the vision call, and vision is ~3x the input.
- The 50 MB vision ceiling. Documents above it that are ALSO scanned have no
  lane at all — measured at 0 of 19 here, but the corpus maximum is 222.3 MB.
- The promotional batch rate expiring **1 Jan 2027**, which doubles input.
