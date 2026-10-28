# Near-Realtime Document Parsing Service — Deep Research

**Date:** 28 Aug 2026 · **Scope:** both lanes (RAG extract + financials parse), unified service · **Constraints:** self-hosted, no new vendor fees, Gemini allowed, near-realtime, lowest possible cost

---

## TL;DR

Build one **doc-ingestion service** that converts every PDF to markdown **once, on arrival, on CPU, for free** (Firecrawl's MIT-licensed `pdf-inspector` + `anydoc`), then feeds both lanes from that markdown: chunks/embeddings for RAG, and a page-selected Gemini Flash-Lite structured-JSON call for financials. Trigger it per-document at store time — the 600s Pub/Sub ceiling only ever bit because one message carried a whole cohort; one doc per message needs **zero new infra** and lands in seconds-to-a-minute at ~$0 idle cost. Drain the 29,663 backlog with a Vertex AI batch job reading `gs://` URIs directly (50% price, ~$170–660 depending on model, days not months). An always-on worker (min-instances=1) buys guaranteed sub-minute latency for ~$45–50/mo — defer it until scale-to-zero cold starts actually annoy you.

One research finding changes the previous plan's arithmetic, flagged prominently below: **Gemini no longer bills the native text inside PDFs** — so markdown pre-conversion is not primarily a token saver; its value is latency, page selection, replacing Document AI, and feeding both lanes from one conversion.

---

## 1. Parsing stacks — what's actually free and fast (Aug 2026)

Two problems, two answers: text-layer PDFs are solved on CPU by structural parsers; scanned pages are now dominated by small document-VLMs that effectively require a GPU.

### Text-layer PDFs (the bulk of BSE/NSE filings) — CPU, free

| Tool                                                            | License                                                                                 | Speed                                                                                         | Fit                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pdf-inspector + anydoc** (Firecrawl, open-sourced 6 Aug 2026) | MIT, no models needed                                                                   | Classify 10–50ms; full text-PDF→MD typically <200ms — fastest of 7 parsers in a 200-PDF bench | **Winner.** Native **Node bindings** (napi-rs — no Python sidecar in the TS monorepo), financial-table-aware heuristics (continuation tables, footnotes), and the per-page text-vs-scanned classifier is the router the pipeline needs anyway |
| **Docling** (IBM)                                               | MIT, models Apache-2.0                                                                  | ~0.79 s/page on 8 CPU threads incl. OCR                                                       | Accuracy fallback: TableFormer emits a typed cell grid, trained on FinTabNet (financial-table pedigree). A 300-page AR ≈ 2–4 min on CPU                                                                                                       |
| marker / Surya / Chandra (Datalab)                              | Apache code, but weights are **OpenRAIL-M gated at $5M (Chandra: $2M) funding+revenue** | good                                                                                          | A legal dependency, not a free tool — skip                                                                                                                                                                                                    |
| pymupdf4llm                                                     | **AGPL-3.0**                                                                            | very fast                                                                                     | License veto territory; tables weak anyway                                                                                                                                                                                                    |
| MonkeyOCR, Nanonets-OCR2                                        | weights **non-commercial**                                                              | —                                                                                             | Disqualified                                                                                                                                                                                                                                  |

**Caveat:** anydoc is three weeks old. Its heuristic tables are less structured than model-based extraction — the existing `FAILED_VALIDATION` arithmetic gate is the safety net; pilot before trusting (§6).

### Scanned pages — GPU is effectively unavoidable for table fidelity

CPU classic OCR (PaddleOCR PP-StructureV3, Tesseract) hits throughput but not dense-statement fidelity (Docling scores 50.3 on olmOCR-bench vs 82–86 for VLMs). License-clean GPU options, ranked: **PaddleOCR-VL-1.5** (Apache-2.0, 0.9B params, OmniDocBench v1.5 **94.5** — best redistributable score, best table-TEDS lineage), **DeepSeek-OCR** (MIT, ~200k pages/day/A100 claim), **olmOCR-2** (Apache-2.0, 7B, fits an L4). Cloud Run L4 is ~$0.67/hr scale-to-zero, but **asia-south1 is invitation-only** (asia-southeast1 is GA).

**Recommendation: don't build the GPU leg yet.** Gemini already handles scanned pages as vision input at the same 258 tokens/page — the scanned minority can simply stay on the existing whole-PDF Gemini path. Measure the actual scanned share first with pdf-inspector (it's a free byproduct of Stage 1); self-host PaddleOCR-VL only if that share × Gemini cost ever justifies a GPU service.

Benchmark hygiene: trust OmniDocBench (table-TEDS column, not composite) and olmOCR-bench over vendor blogs; Datalab's and OpenDataLab's harnesses each favor their own tools.

---

## 2. Gemini economics — the finding that changes the plan

### ⚠ Native PDF text is no longer billed

Gemini's document-processing docs now state each PDF page costs **258 tokens (image modality)** and **"you are not charged for tokens originating from the extracted native text in PDFs."** A 300-page text-native AR is therefore ~77k input tokens _whether or not you pre-extract markdown_. So the earlier "markdown halves the model bill" claim is dead. What still pays, in order:

1. **Page selection** — the real cost lever. Financial statements are ~20–40 pages of a 300-page AR. Markdown in hand, select the statement sections and send ~10k tokens instead of ~77k: **~8× cheaper and much faster**, with better accuracy (less distractor content).
2. **Latency** — a text call skips the Files API upload→activation→read cycle that dominates the current ~35s-typical/240s-worst per-doc budget (`DEFAULT_DOC_PARSE_BUDGET_MS`).
3. **Replacing Document AI** in the extract lane — Document AI charges per page; anydoc markdown for text-native PDFs is free. The 45k-doc extract queue is where actual money is being spent today.
4. **One conversion, two lanes** — the markdown feeds RAG chunking _and_ financials parsing; the PDF is read once.

### Pricing (Aug 2026, paid tier, $/1M tokens)

| Model                              | Input         | Output        | Note                                                      |
| ---------------------------------- | ------------- | ------------- | --------------------------------------------------------- |
| **Gemini 2.5 Flash-Lite** (legacy) | **$0.10**     | **$0.40**     | cheapest listed — pilot this first                        |
| Gemini 3.1 Flash-Lite              | $0.25         | $1.50         |                                                           |
| Gemini 3.5 Flash-Lite              | $0.30         | $2.50         |                                                           |
| Gemini 3.7 Flash                   | $0.75 _promo_ | $3.75 _promo_ | **doubles 1 Jan 2027** — don't build unit economics on it |
| Gemini 3.1 Pro Preview             | $2.00–4.00    | $12–18        | no free tier                                              |

- **Free tier is disqualified for production**: unpaid-tier content is used for training and may be human-reviewed, and quotas (~15 RPM / ~1.5k RPD unofficial) are far below need. Use it for prompt development only.
- **Batch = 50% off** on both AI Studio (Files API refs, 24h target) and **Vertex (JSONL from GCS with `fileData`/`fileUri` `gs://` parts, up to 200k requests/job)**. Vertex is the backlog path: PDFs are already in the bucket, no re-upload, no 48h Files-API clock, and no AI-Studio tier ladder (Tier 1 caps enqueued tokens at ~10M — useless for a 2.4B-token backlog; Vertex sidesteps it).
- **Implicit caching** is automatic on ≥4,096-token prefixes (3.x models) at ~90% off cached tokens — make the fixed extraction prompt+schema the first ≥4k tokens of every request. Cache and batch discounts don't stack.
- Structured output (`responseSchema`) works on Flash tier; keep the schema flat-ish.

### Per-document arithmetic (300-page text-native AR, ~8k output)

| Path                                         | 2.5 Flash-Lite | 3.5 Flash-Lite |
| -------------------------------------------- | -------------- | -------------- |
| Whole PDF, online                            | ~$0.011        | ~$0.044        |
| Whole PDF, batch                             | ~$0.006        | ~$0.022        |
| **Page-selected markdown (~10k in), online** | **~$0.0013**   | **~$0.0055**   |
| 29,663 backlog, whole-PDF batch              | ~$170          | ~$660          |
| 29,663 backlog, page-selected batch\*        | ~$25           | ~$90           |
| 1,865 latest-annual cohort, page-selected    | ~$3            | ~$12           |

\*Page-selected batch requires converting the backlog to markdown first — the CPU conversion is free and a Cloud Run Job chews through it in hours, so this is the recommended sequence anyway.

---

## 3. Architecture — parse-on-arrival with zero new infra

### The key insight

The 600s Pub/Sub push ack deadline — the reason `RUN_TIME_BUDGET_MS=210s`, self-chains, and 4-a-day triggers exist — **only constrains per-message work**. Per-document work is 30–240s. Put **one document per message** and the entire ceiling problem disappears inside the existing push worker, with at-least-once delivery and the existing Mongo conditional-update claim as the idempotency layer.

### Trigger options (both are cheap)

- **A. Publish-at-store (recommended first):** `stock-document-sync` already publishes a follow-on extract job after a run (`publishExtractJobViaPubSub`). Extend the same seam: after each document row is created + PDF uploaded, publish `{documentId}` to a `stock-document-ingest` topic. No new GCP config, works in QA/local unchanged, and carries the Mongo id so there's no GCS-path→row lookup.
- **B. GCS `OBJECT_FINALIZE` → Pub/Sub:** native prefix filtering (`-p documents/`), delivery "typically within seconds", ~$0 (30k notifications ≈ 30MB vs 10 GiB/mo free). Catches writers other than the sync job. Worth adding later for belt-and-braces; Eventarc adds nothing (no prefix filters) — skip it.

### Latency menu (user asked for both)

| Option                                     | Latency                                                                                                                                                              | Incremental cost                                                          | How                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Minutes → usually seconds (start here)** | ~2–60s typical: publish-at-store → push delivery (sub-second) → cold start (a few s) → CPU convert (<1s text / minutes-Docling) → Gemini call (~5–15s on 10k tokens) | **~$0** — scale-to-zero, requests within free tier                        | One-doc-per-message on the existing push worker                 |
| **Guaranteed seconds**                     | Removes cold starts; end-to-end bounded by the Gemini call itself                                                                                                    | **~$44–50/mo** (1 vCPU min-instance, instance-based billing, asia-south1) | `min-instances=1` + `--no-cpu-throttling` on the ingest service |
| Same-run-as-fetch                          | Zero trigger latency but couples fetch to parse and re-inherits the fetch job's own 600s budget                                                                      | $0                                                                        | Not recommended — Option A is strictly better                   |

Do **not** build a StreamingPull worker on request-billed Cloud Run: CPU is throttled outside request windows, leases expire, messages loop — the known trap. A pull worker only earns its cost if per-item work exceeds ~30 min; this workload never does.

### Priority: fresh docs always jump the backlog

Two subscriptions on the ingest topic: `-realtime` (unthrottled, fed by publish-at-store) and `-backlog` (fed by the drain publisher, throttled via flow-control / Cloud Tasks rate caps — Pub/Sub has no native priority; the throttle _is_ the priority). The claim-before-parse conditional update stays the dedupe layer (GCS at-least-once × Pub/Sub at-least-once ⇒ duplicates are guaranteed possible).

### Backlog drain (pick one, both proven shapes)

1. **Vertex batch (recommended for the Gemini step):** Cloud Run Job builds JSONL (one `GenerateContent` request per doc, `fileData.fileUri: gs://…` or inlined page-selected markdown), submits, polls, ingests output through the **existing validation + upsert path**. 200k requests/job, 50% price, jobs mostly complete <24h. The repo already has the Cloud Run Job pattern (`scripts/jobs/xbrl-projection-drain.ts` + `setup-*-job.sh`).
2. **Cloud Run Job direct-drain:** the same job loops the queue itself calling Gemini online (7-day task timeout, no ack deadline) — simpler, full price, throttleable. Fine for the 1,865-doc cohort; use Vertex batch for the full 29,663.

Sequence: **cohort first** (1,865 latest-annual, page-selected ≈ $3–12, one day) → full drain via batch → realtime keeps it drained forever.

---

## 4. What changes in the repo (small, in order)

1. **`packages/core` doc-convert module:** wrap `pdf-inspector` + `anydoc` Node bindings; store `markdown` + per-page classification to GCS beside the PDF (`buildFullDocPath(symbol, docType, period, "md")`); stamp `convertStatus`, `scannedPageCount` on `stock_documents`. _(Remember the Mongo trap: new fields are ABSENT on existing rows — select with `{ isSet: false }` arms, per MONEY-1050/1205/1234/1236.)_
2. **`stock-document-ingest` processor + topic:** one doc per message; convert → (a) chunk/embed from markdown for RAG (Document AI only for scanned pages), (b) page-select statements → Gemini Flash-Lite structured call with ≥4k cached prefix → existing extract upsert + `FAILED_VALIDATION` arithmetic. Publish seam: after-store in `stock-document-sync` (pattern already exists at `publishExtractJobViaPubSub`).
3. **Backlog job:** `scripts/jobs/doc-ingest-drain.ts` on the existing Cloud Run Jobs pattern; Vertex batch submission for the Gemini step.
4. **Wind down** the 4 daily parse triggers and self-chains once realtime + drain are live; keep one nightly sweep as a safety net for missed messages.
5. **Arm the destination** (unchanged from previous analysis): `DOC_FINANCIALS_APPLY` + MONEY-1260 (BSE-only companies excluded by `xbrlFilings: { some: {} }`) still gate whether any of this reaches ratios. Wire in parallel with the cohort drain.

---

## 5. Cost summary

| Item                                                                                                   | Cost                                                                        |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| CPU conversion (anydoc/Docling, all docs, forever)                                                     | $0 (existing Cloud Run CPU, free-tier headroom)                             |
| Trigger plumbing (Pub/Sub messages, GCS notifications)                                                 | ~$0 (within free tiers)                                                     |
| Realtime Gemini, steady state (assume ~200–500 parse-eligible docs/day, page-selected, 2.5 Flash-Lite) | ~$0.30–0.70/day                                                             |
| Backlog: 1,865 cohort → full 29,663 (page-selected batch)                                              | ~$3–12 → ~$25–90                                                            |
| Extract lane savings                                                                                   | Document AI eliminated for text-native pages (currently the paid step)      |
| Optional: guaranteed-seconds min-instance                                                              | ~$45–50/mo                                                                  |
| Optional: self-hosted GPU OCR (PaddleOCR-VL on L4)                                                     | ~$0.67/hr scale-to-zero — build only if measured scanned-share justifies it |

---

## 6. Risks & open questions

- **anydoc table fidelity** on dense Schedule III statements is unproven (3-week-old release). Pilot: convert 200 already-parsed docs, run the Gemini call on page-selected markdown, compare `FAILED_VALIDATION` rates and spot-check values against the whole-PDF results before switching the lane. Docling is the drop-in fallback per document.
- **"Native text not billed"** is load-bearing for §2's arithmetic — verify against a live `countTokens` call at build time; docs pages have changed under us before (MONEY-1255's lesson: measure, don't trust a laptop 200).
- **Scanned share unknown** — pdf-inspector classification over the existing corpus is a free one-off job; run it before deciding on any GPU leg.
- **Page selection needs a locator** — finding "the statements" in markdown is a heuristic (section headings + table density). Mis-selection sends the wrong pages; the validation gate catches arithmetic nonsense but not a wrong-but-consistent period. Keep whole-PDF as the retry path on validation failure.
- **Vertex batch region/quota** — confirm gemini batch model availability + quotas in the project's region; 3.7 Flash promo pricing expires 1 Jan 2027.
- **14k docs/day inflow** (seen 27 Aug) is a backfill surge, not steady state — but the design is burst-proof (queue + throttled backlog leg) either way.

---

## Sources

**Parsing:** [AnyDoc + pdf-inspector announcement](https://www.firecrawl.dev/blog/anydoc-and-pdf-inspector) · [anydoc (MIT)](https://github.com/firecrawl/anydoc) · [pdf-inspector](https://github.com/firecrawl/pdf-inspector) · [Docling tech report (0.79s/page CPU)](https://arxiv.org/html/2408.09869v4) · [marker license](https://github.com/datalab-to/marker) · [MinerU](https://github.com/opendatalab/mineru) · [olmOCR](https://github.com/allenai/olmocr) · [DeepSeek-OCR](https://github.com/deepseek-ai/DeepSeek-OCR) · [PaddleOCR-VL-1.5](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.5) · [OmniDocBench](https://github.com/opendatalab/OmniDocBench) · [v1.5 leaderboard](https://www.codesota.com/ocr/benchmark/omnidocbench)

**Gemini:** [Pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Document processing (258 tok/page, native text free)](https://ai.google.dev/gemini-api/docs/document-processing) · [Batch API](https://ai.google.dev/gemini-api/docs/batch-api) · [Vertex batch from GCS](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/batch-prediction-gemini) · [Context caching](https://ai.google.dev/gemini-api/docs/caching) · [Rate limits/tiers](https://ai.google.dev/gemini-api/docs/rate-limits) · [API terms (free-tier training use)](https://ai.google.dev/gemini-api/terms) · [Structured output](https://ai.google.dev/gemini-api/docs/structured-output)

**GCP:** [GCS Pub/Sub notifications](https://docs.cloud.google.com/storage/docs/pubsub-notifications) · [Pub/Sub pricing](https://cloud.google.com/pubsub/pricing) · [Lease management](https://docs.cloud.google.com/pubsub/docs/lease-management) · [Node client defaults](https://github.com/googleapis/nodejs-pubsub/blob/main/src/default-options.ts) · [Cloud Tasks](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks) · [Cloud Run Jobs (168h)](https://docs.cloud.google.com/run/docs/create-jobs) · [Cloud Run pricing](https://cloud.google.com/run/pricing) · [Billing settings / CPU throttling](https://docs.cloud.google.com/run/docs/configuring/billing-settings) · [Cloud Run GPU](https://docs.cloud.google.com/run/docs/configuring/services/gpu) · [Subscription filters](https://docs.cloud.google.com/pubsub/docs/subscription-message-filter)
