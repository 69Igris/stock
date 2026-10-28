# Doc-Ingest Pipeline (P15/P16) — Deep Research Synthesis

**Date:** 1 Sep 2026 · **Scope:** validate the 28-Aug research doc + both build prompts against live docs, executed library tests, and the repo · **Method:** three parallel lanes (parser reality · Gemini/Vertex live-docs · repo grounding) + house-rules conformance

---

## TL;DR

The architecture stands: one `stock-document-ingest` worker, one doc per message, CPU markdown conversion feeding both lanes, page-selected Gemini calls, Vertex batch for the backlog. But four findings change the build, and one is a **founder decision, not an engineering one**:

1. 🚨 **Region × price × residency.** The doc-parse model running today is `gemini-3.5-flash` at **$1.50/$9.00 per 1M** — absent from the research doc's pricing table entirely. Every cheaper option it modelled (all Flash-Lites, 3.7-Flash at half the price) is **NOT available in asia-south1**; using them means the global endpoint, whose docs state it "doesn't support data residency requirements". For an Indian fintech handling exchange filings, staying regional forces the expensive model; going cheap leaves Mumbai. **The research doc's $3–12 cohort / $25–90 backlog numbers assumed models we cannot run in-region.** (`gemini-2.5-flash` IS in asia-south1 and may be the regional sweet spot — its current price needs one verification.)
2. **anydoc is disqualified — measured.** One scanned page (a signed auditor's page — ubiquitous) makes it reject an entire 341-page report (its open issue #144), and its only escape ships the whole filing to `api.firecrawl.dev`. Its PDF path is pdf-inspector internally anyway. **Pin `@firecrawl/pdf-inspector@1.17.0` alone** — 7 months old (not "3 weeks"; only anydoc is new), musl prebuilds verified loading on our actual `node:20-alpine` image, 16/16 fuzz inputs threw catchable errors with zero aborts.
3. **A number-normaliser is a required pipeline stage.** 1.21% of table-cell numbers come out digit-split (`"11, 0 9 0"` → 11,090) and ₹ renders as a backtick — unflagged by the library. Unnormalised, this feeds the arithmetic validation gate as false FAILED_VALIDATIONs.
4. **Three of the research doc's repo citations are wrong** (§Reconciliation) — most materially, the MONEY-1260 arming exclusion lives in `xbrl-ratios.ts:351`, not the doc-financials projection, and the drain-loop skeleton's termination model does not transfer to `--mode publish`.

---

## Plan-changing findings by lane

### Lane 1 — Parser (executed, not read)

| Finding                                                | Evidence                                                                                                | Plan impact                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| pdf-inspector is mature; anydoc is not                 | 58 releases since Apr-2026 vs 4 weeks; anydoc whole-doc-reject measured on ICICI AR                     | one dependency, not two                                                               |
| musl prebuilds work on our image                       | `docker run node:20-alpine` + install + `classifyPdf` executed; base is **node:20-alpine**, not Node 22 | no Dockerfile change, no Rust, ladder option (napi)                                   |
| 1.9–4.5 ms/page, classify 67–129 ms for 300+ pp        | Infosys/HDFC/ICICI/Wipro ARs                                                                            | conversion is noise in the 600s budget                                                |
| **~0.4 MB RSS/page** (278 MB peak @ 585 pp)            | `/usr/bin/time -l`                                                                                      | vs `1Gi × containerConcurrency:10` → **parse semaphore (1–2)** or page-range chunking |
| Sync variants block the event loop for the whole parse | measured 2 ms (async) vs full-parse block (sync)                                                        | **Async variants only**                                                               |
| Digit-split 1.21% + ₹→backtick, unflagged              | 67/5,516 table numbers                                                                                  | **normaliser stage before page-select**                                               |
| Local OCR needs glibc PDFium — won't load on Alpine    | `processPdfWithOcr` threw at the PDFium boundary; docs list no musl asset                               | scanned pages stay on **Document AI**, exactly as designed                            |
| `extractPagesMarkdown` gives per-page md + `needsOcr`  | shipped `index.d.ts`                                                                                    | the router AND real page indices for page-select                                      |

### Lane 2 — Gemini/Vertex (live docs, Sep 2026)

| Claim                                    | Verdict                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native PDF text not billed; 258 tok/page | **CONFIRMED — but scoped to Gemini 3 on the Developer API; Vertex UNVERIFIED.** Affects `--mode batch` whole-PDF fallback economics. Proof is `usage_metadata.promptTokensDetails` on one real call, not `countTokens`.                                          |
| ≥4,096-token prefix for implicit caching | **CONFIRMED for 3.5/3.7 Flash** (2.5 needs 2,048). **No Flash-Lite appears in the caching table** — the doc's "pilot 2.5 Flash-Lite" advice may deliver zero caching.                                                                                            |
| Cache × batch don't stack                | **CONFIRMED, direction matters:** cache (10% of _standard_) takes precedence over batch — cached tokens are NOT 5%.                                                                                                                                              |
| Vertex batch JSONL                       | `{"request": {contents, generationConfig}}`, **camelCase**, **no `"key"` field** (that's Developer-API batch — the likeliest implementation bug). 200k req/job **and a 1 GB input-file cap**; 72h queue + 24h run; **no SLA**; **no explicit caching in batch**. |
| Node client                              | `@google-cloud/vertexai` is dead (EOL passed). Repo already on `@google/genai ^2.8.0` → **pin ^2.20.0**; `ai.batches.create` exists.                                                                                                                             |
| Stale repo comment                       | `model-registry.ts:524` claims 3.x 404s regionally; live docs list `gemini-3.5-flash` in asia-south1. Re-test, then fix the comment.                                                                                                                             |

### Lane 3 — Repo grounding

| Finding                                                                                                                        | Impact                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MONEY-1260 exclusion is at `xbrl-ratios.ts:351` (ratios candidates), not the projection                                        | P16's "leave the arming path untouched" must name the right seam                                                                                                |
| `runDrainLoop`'s no-advance stop assumes synchronous stamping                                                                  | `--mode publish` returns before workers stamp → exits `no-advance` on batch 1. **Termination = published-count cursor, re-derived**                             |
| `PARSE_SCAN_CAP = 40_000` vs MONEY-1308's 48,509                                                                               | possibly breached **today**; neither external number matches the in-repo 15,705. **Re-measure with `buildParseQuery`'s exact predicate before sizing anything** |
| Cohort: repo says **1,681** latest-per-symbol, doc says 1,865                                                                  | re-measure; "19 of 26 ratio columns" **confirmed** (26 − 7 multi-period)                                                                                        |
| "Annual" has no predicate — `period` is free text                                                                              | `docType: "annual_report"` is the only proxy; small new pure function                                                                                           |
| Markdown path: **`${gcsPath}.md` sidecar** (the `.extracted.txt` pattern)                                                      | `buildFullDocPath`'s filename/directory sanitizers disagree; 6,125 `gcsPath: ""` rows refuse loudly via `assertSafeObjectKey`                                   |
| Embed trigger **must be debounced**                                                                                            | per-doc `{batchSize:500}` publishes rebuild MONEY-1307's storm; repo warns at `bse-announcements-sync.ts:981`. Redis `SET NX EX` latch                          |
| `FeedBackfillProgress` is `(family, date)`-keyed set-difference resume                                                         | wrong shape for doc-ids. **The corpus scan's cursor is its own stamp: `{scannedPageCount: {isSet: false}}`** — O(1), no checkpoint table                        |
| `OLD_SCHEDULER_PREFIXES` has **no generic test**                                                                               | removing the 3 parse triggers without listing them fails nothing and they fire forever → add names + a tickertape-style pin                                     |
| Parse budget is `RUN_TIME_BUDGET_MS = 210_000`; the doc's `DEFAULT_DOC_PARSE_BUDGET_MS` (240s) is gemini-pdf's per-call budget | two constants, doc conflated them                                                                                                                               |

---

## Cost arithmetic — our units, honest ranges

Per doc: ~10k in (page-selected) or ~77.4k in (whole-PDF), ~8k out. **Output dominates page-selected cost on expensive models.**

| Model                   | Where                             | $/doc page-sel **batch** | Cohort (1,681) | Backlog (≈48.5k, re-measure!) |
| ----------------------- | --------------------------------- | ------------------------ | -------------- | ----------------------------- |
| 3.5-flash (today's)     | asia-south1 ✅                    | $0.043                   | ~$73           | ~$2,110                       |
| 3.7-flash (promo→1-Jan) | **global only**                   | $0.019                   | ~$32           | ~$910                         |
| 2.5-flash               | asia-south1 ✅                    | _price to verify_        | —              | likely ~$19 / ~$560           |
| any Flash-Lite          | **global only**, caching unproven | $0.004–0.012             | $7–20          | $195–560                      |

The research doc's $3–12 / $25–90 figures are **only reachable off-region**. Realtime steady state (~200–500 docs/day, page-selected, 3.5-flash online): ~$17–44/day — another reason the model/region call precedes the drain.

**→ The founder decision:** regional (3.5-flash, ~$2.1k backlog ceiling, or verify 2.5-flash) vs global endpoint (3.7-flash/Lite, ~2–10× cheaper, docs disclaim data residency). Everything else in both branches is independent of it; the pilot (T6) measures both models if allowed.

---

## Updated two-branch plan (deltas folded; supersedes the earlier draft where they differ)

### P15 — `feat/MONEY-<A>` · the ingest worker

- **T0** decision note = Lane 1's brief → `docs/reference/doc-convert-decision.md`. Pin `@firecrawl/pdf-inspector@1.17.0` **only**. No anydoc. No Dockerfile change.
- **T1** `doc-convert(-logic)`: wraps `classifyPdfAsync` + `extractPagesMarkdownAsync` (Async only); **parse semaphore 1–2**; **normaliser** (digit-split + ₹) as a pure, fixture-goldened function; markdown at **`${gcsPath}.md`**; skip `gcsPath:""` by name; schema fields as specced, `convertStatus` with the isSet warning comment; `@@index([convertStatus, fetchedAt])`.
- **T2** page-select — unchanged, plus: operate on _normalised_ markdown; page indices from `extractPagesMarkdown`.
- **T3** gemini-pdf refactor — unchanged; prefix ≥4,096 (correct for 3.5/3.7-flash); note in code that Flash-Lite caching is unproven; **do not** change the default model (the region call is the founder's).
- **T4** worker — as specced, plus: filtered subs on the `source` **attribute**; vision retry only if `remaining ≥ retry-budget + safety` (full-worst-path <600s test); **debounced embed trigger** (Redis NX latch); `parsePath` selections carry isSet arms.
- **T5** publish seam — unchanged (`DOC_INGEST_REALTIME` present-and-"false" in both cloudbuild specs).
- **T6** pilot — plus: the `usage_metadata.promptTokensDetails` proof (IMAGE-only ⇒ exemption holds) replaces the countTokens idea; if permitted, measure 3.7-flash via global alongside for the founder decision.
- **T7** tests/docs — unchanged, plus fix the stale `model-registry.ts:524` comment after a live regional test.

### P16 — `feat/MONEY-<B>` · scan → backfill → drain → cutover

- **U1** corpus scan — cursor = `{scannedPageCount: {isSet: false}}` (no checkpoint table); `classifyPdfAsync` only.
- **U2** markdown backfill — as specced; cohort-first.
- **U3** drain — `--mode publish`: **published-count termination**, not `runDrainLoop`'s no-advance; cohort from the shared function (`buildPhaseQuery` + `selectBreadthFirst` + new small annual-proxy predicate); **re-measure the population first** and reconcile `PARSE_SCAN_CAP`. `--mode batch`: `{"request":…}` wrapper, **no `"key"`**, camelCase, ≤200k req **and ≤1 GB** per job, chunk accordingly; `@google/genai@^2.20.0` `ai.batches.create`; auth via `googleCredentials()` (**explicit key beats the job's `--service-account`** — grant Vertex IAM to the key's identity); `FAILED_BATCH` rows sweep via publish mode.
- **U4** cutover — remove the 3 triggers **and add their names to `OLD_SCHEDULER_PREFIXES`** + a tickertape-style test; cite `xbrl-ratios.ts:351` as the untouched arming seam (not the projection).
- **U5** acceptance — as specced, with re-measured population numbers.

**House-rules conformance** (lane 4): every new field selection carries the isSet arm (convertStatus, parsePath, FAILED_BATCH sweeps — the MONEY-1236-class test written first); `-logic.ts` pure with real-file fixtures; injectable deps at every I/O seam; env flags present-and-explicit in both specs; docs trio + TEST-COVERAGE per change; no new Mongo tables; mutation-verified tests throughout; `yarn verify:push` before any push.

---

## Risks & unverified (kept visible)

- Native-text exemption **on Vertex** — unverified; one batch row's usage metadata settles it.
- Flash-Lite implicit caching — absent from the caching table; treat as none.
- 2.5-flash current pricing — one lookup.
- Authentic _scanned_ BSE filings never tested (exchanges 403'd the lane); scanned-share comes from U1 anyway.
- 23.7 MB / 300+pp memory figure is extrapolated (585 pp measured).
- 3.7-flash promo **doubles 1 Jan 2027** — don't build unit economics on it.
- Batch has **no SLA**; 24h-run cancellation charges completed work only.

## Sources

Lane briefs (this session) · `docs/reference/doc-parsing-realtime-service-research-aug2026.md` · live pages cited inline in the lane briefs (ai.google.dev document-processing / caching / batch-api / pricing / model pages; docs.cloud.google.com Vertex batch + locations + SDK deprecation; github/npm for firecrawl packages).
