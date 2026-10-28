# PDF → markdown conversion: the decision, and what measuring it changed

**Measured 2026-09-01** inside `node:20-alpine` (`--platform linux/amd64`,
musl, matching both stages of `workers/Dockerfile`), against **26 real filings
/ 1,816 pages** pulled from `gs://stockbook-content-prod`.

Every number below is an observation. Three of them contradict what the plan
assumed, and one of those would have broken the largest docType in the archive.

---

## 1. The library: `@firecrawl/pdf-inspector@1.17.0`

```
npm i @firecrawl/pdf-inspector@1.17.0    5.10s wall, 1.82s user
```

No postinstall, no build script, no Rust toolchain. Resolves on musl/x64 to the
prebuilt napi binary `@firecrawl/pdf-inspector-linux-x64-musl` (10,062,512
bytes); only two directories land under `node_modules/@firecrawl/`. Loads with
21 exports. **Image cost ~10 MB.**

`anydoc` was rejected and stays rejected: it fails a whole 341-page document
because one page is scanned (their issue #144), and its escape hatch ships the
entire filing to `api.firecrawl.dev`.

## 2. Throughput — the per-page figure is the wrong unit for our corpus

| population                      | classify   | extract     |
| ------------------------------- | ---------- | ----------- |
| text-bearing ≥100 pp (1,319 pp) | 3.69 ms/pg | 7.92 ms/pg  |
| whole corpus                    | 3.50 ms/pg | 14.98 ms/pg |

Small PDFs are dominated by a **fixed ~150–200 ms per document**, not by page
count — a 3-page BSE quarterly costs 17–51 ms/pg. Since the real queue is
~31,000 BSE quarterlies of 3–11 pages, **budget with the fixed cost.**

One 100× outlier: a 123-page image-based document ran **97.83 ms/pg** (12.0 s
wall) where two other image/scanned documents ran 0.76 and 1.38. Image-based
cost is not predictable from page count.

⚠️ The measurement host is `aarch64`, so `linux/amd64` ran emulated. Native
arm64 comparison puts emulation overhead at **1.6–1.9×** on well-behaved
documents, so real Cloud Run amd64 extraction is plausibly **~4 ms/pg** on
large text PDFs. Treat the amd64 numbers as an upper bound.

## 3. Memory — 512 MiB is not enough

Peak RSS is **2.3–4.8× file size**, worst observed **618 MB for a 129.81 MB
PDF**. Node's own floor is ~68 MB, which is why small documents show an absurd
MB-per-page figure and why page count is the wrong basis.

**109 archive objects exceed 40 MB.** A 512 MiB instance dies on anything over
~100 MB. The ingest worker ships with **2 GiB**; 1 GiB is the floor. Encoded as
`estimatePeakRssBytes` in `doc-convert-logic.ts` with a test pinning the 618 MB
observation, so lowering the multiplier fails by name rather than as an OOM.

---

## 4. THE BLOCKING FINDING — `classifyPdf` is not a router

**Five of twenty-two documents** report:

```
{ pdfType: "TextBased", confidence: 1.00, pagesNeedingOcr: [] }
```

and then extract to **zero characters**, with `extractPagesMarkdown` flagging
**every** page as OCR-bound.

```
BRAHMINFRA  TextBased 1.00  193pp  ->  193/193 need OCR, 0 chars
ENBETRD     TextBased 1.00    6pp  ->    6/6   need OCR, 0 chars
PADAMCO     TextBased 1.00    5pp  ->    5/5   need OCR, 0 chars
ZGAEKWAR    TextBased 1.00    6pp  ->    6/6   need OCR, 0 chars
ZNILKENG    TextBased 1.00    7pp  ->    7/7   need OCR, 0 chars
```

They are scans carrying a **garbage OCR text layer**. `extractText(ZGAEKWAR)`
returns 9,567 characters of
`ecu—"4m,<wr.w."m..'.V...'1.,THEGAEKWARMILLSLTD.Ffigl'l}QFHGE;emporiumlilo…`.
`classifyPdf` sees a text layer and believes it at full confidence;
`extractPagesMarkdown` applies a quality gate and rejects it.

**Four of the five are BSE `quarterly_result` — 30,956 rows, the largest
docType in the archive.** So this is the dominant population, not an edge case.

Three routing rules follow, all encoded in
`packages/core/src/market-data/doc-convert-logic.ts`:

1. **Never route on `classifyPdfAsync`.** Route on `extractPagesMarkdownAsync`:
   a page is OCR-bound iff `needsOcr === true` **or** its markdown is empty.
2. **`pagesNeedingOcr` has two different index bases.** `classifyPdf`'s is
   **0-indexed**; `extractPagesMarkdown`'s is **1-indexed**; `pages[].page` is
   **0-indexed**. Verified on a 26-page document: `[0…25]`, `[1…26]`, `[0…25]`.
   Two of them share a field NAME. Crossing them sends the wrong page to
   Document AI — silently, returning a real OCR result for a page nobody asked
   about.
3. **`ocrReason` can be absent entirely.** On the garbage-text-layer files the
   page object's keys are exactly `["page","markdown","needsOcr"]`; genuine
   scans do carry `ocrReason: "scanned"`. Never gate on the reason's presence —
   it misses precisely this population.

And `markdown` is **`""`, never `null`/`undefined`**, on an OCR-bound page. So
`md ?? null` and `md === null` both never fire.

---

## 5. The normaliser — required, and NOT the one that was planned

Base: 20,267 numeric cells / 51,247 cells / 1,307 tables.

### The rule that must never be written

The planned `"11, 0 9 0" -> 11,090` digit-collapse. That shape is **essentially
absent** (~15–20 cells, 0.1%). A `\d,\s\d` rule actually matches:

```
"31, 2025"                   <- "March 31, 2025"
"130, 138, 141, 147"         <- page-reference list in a contents table
"12003, 21002, 46307"        <- NIC product codes
"+91 33 2288 9371"           <- phone number
```

It would have rewritten dates, contents pages and telephone numbers across the
whole corpus to fix one cell in a thousand. A test pins eight real strings that
must survive untouched.

### D1 — ₹ arrives as an ASCII backtick (U+0060). The dominant defect.

| doc      | ₹ survives | becomes `` ` `` | corrupted |
| -------- | ---------: | --------------: | --------: |
| ITC      |          6 |           1,094 | **99.5%** |
| AXISBANK |        106 |             840 |     88.8% |
| TCS      |         48 |             578 |     92.3% |

Zero U+FFFD anywhere — a font-mapping artefact, not an encoding failure. The
legacy `RupeeForadian` font maps the glyph to U+0060, but **font detection is
insufficient**: the majority of hits come from ordinary `Lato-Regular` /
`Helvetica` runs. The rule is contextual — a backtick followed by a digit, `(`,
or a scale word — covering 90.1% / 94.0% of all backticks.

It **also corrupts the markdown**: backticks pair into inline code spans, so
prose between two amounts silently becomes `<code>` and swallows any pipes. The
repair therefore runs **before** table parsing.

### D2 — merged columns. 587 cells, 2.90%.

```
"2183.04 7.22 158.23 60.57 70.07 4.26 295.20 595.55 1587.49 10.51 1576.98"
```

Reported, never split — the column assignment is the information the extractor
lost.

### D3 — the one safe repair: a split decimal point.

`"3 5 47. 28" -> "3547.28"`, gated on the decimal-point **count**, so
`"21,88,211.30 27,77,153.30"` (two complete numbers) is refused. A spaces-only
rule concatenates that pair into a value wrong by a factor of a hundred million
that still parses as a number.

### D4 — digits migrating across cell boundaries. 33 cells, 0.17%. NOT REPAIRABLE.

```
|Revenue from Operations|12,680.65 10,377.010|9,391.26 0|44,271.73 6|
|Other Income|52.977 72.154|41.424|196.82|160.64|8|4|
```

`196.82` and `160.64` are left **looking like perfectly valid numbers**. The
only local signal is the orphan `8`/`4` in a neighbouring cell.

`extractTextWithPositions` shows the fragmentation is in the PDF's own text
runs — two different columns reporting x within **1.4 pt** of each other
(`12,680.65` at 252.5, `10,377.010` at 253.9, both real and both verified
arithmetically), with the whole content stream drawn twice at a 0.003 pt
y-offset. Concatenating the orphans fails the cross-check: 9,432.684 against a
printed 9,432.689.

**Detect, don't repair.** One occurrence fails the document over to the vision
lane, which rasterises and reads what is visually on the page.

### D5 — structural damage

| defect                                  | count | rate                |
| --------------------------------------- | ----: | ------------------- |
| ragged column counts                    |   884 | **67.6% of tables** |
| header ≥50% empty                       |    90 | 6.9% of tables      |
| prose paragraph inside a cell (>150 ch) |   353 | 0.75% of cells      |
| raw HTML tags in markdown               |   696 | —                   |
| superscript glued to preceding token    |   284 | —                   |

Raggedness is **counted, never a gate** — 67.6% would reject two thirds of the
corpus.

---

## 6. Archive health — and two of the four are REPAIRABLE, not lost

Four of the six largest objects sampled do not read as PDFs. All are stored
under `mimeType: "application/pdf"` with otherwise correct metadata:

```
SHOPERSTOP AR FY2014  212.03 MB  multipart/related envelope   -> REPAIRABLE
HUDCO      AR FY2014  135.34 MB  multipart/related envelope   -> REPAIRABLE
AKASH      AR FY2025  118.73 MB  TRUNCATED — last %%EOF at byte 1,381,340
                                 of 124,499,188; ends mid-stream
BSHSL      AR FY2023   90.98 MB  ZIP archive (starts "PK")
```

**The first two are MONEY-1169, already diagnosed, and the payload is intact.**
`packages/storage/src/multipart-envelope.ts` records the cause: every
non-resumable upload in `@google-cloud/storage` v7 hand-builds a
`uploadType=multipart` body, and inside the workers Docker image — and only
there — the transport resolves a different major of node-fetch, because the
image overlays `workers/node_modules` on the root `node_modules`. GCS treats
the request as a plain media upload and stores the whole envelope verbatim.

The PDF sits byte-for-byte intact between the second boundary's blank line and
the closing boundary. `stripMultipartEnvelope` recovers it with **zero exchange
traffic**. `scripts/jobs/feed-repair.ts` already does this at scale — over the
`feeds/` prefix only. Nobody had run it against `stock_documents`, and nothing
detected the shape there.

So the converter **peels before it parses**: `isMultipartEnvelope` ->
`stripMultipartEnvelope` -> `looksLikePdf` on the recovered payload. Two of the
six largest documents in the sample become readable rather than skipped, and
BSE's pre-2018 retention is irrelevant to them because the bytes are already
ours.

`looksLikePdf` rejects the ZIP before any Document AI call, Gemini upload, or
618 MB of conversion RSS is spent on it. It **cannot** detect the truncated
file — only the library's "Invalid PDF structure" does — and the test says so
rather than implying coverage it lacks.

Census, in-place repair, and whether the writing path is still live are
**MONEY-1315**.
