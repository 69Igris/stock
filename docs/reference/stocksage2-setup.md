# StockSage 2.0 — Operator Setup Runbook

> Step-by-step runbook for provisioning the StockSage 2.0 cloud surface
> (Document AI extraction + Vertex AI RAG) and for running the workers locally
> against it. **Everything here is operator-run by hand** — CI never executes any
> of these scripts, and we never touch Vercel directly.
>
> StockSage 2.0 keystone: the `stock-document-extract` worker (MONEY-783) turns
> PENDING stock PDFs into `READY` text via Google Document AI, the embed worker
> vectorises it, and the optional **Vertex RAG** retriever (MONEY-781/782) serves
> it. Atlas RAG stays the DEFAULT until `VERTEX_RAG_ENABLED=true`.

---

## 0. Prerequisites & the gcloud isolation contract

Use the **`gcp-stockbook`** config for this repo (alias =
`gcloud config configurations activate stockbook`). It sets the global active
config to `stockbook` (project `stock-book-483718`), and the config's account is
pinned to **`founder@disdigital.in`** — the account that holds the IAM.

- **ALWAYS operate as `founder@disdigital.in`.** **NEVER use `shaswat@orbizza.com`
  in this repo** — it is `PERMISSION_DENIED` on everything (and forbidden). The
  `stockbook` config account was pinned to founder with
  `gcloud config set account founder@disdigital.in`.
- With `gcp-stockbook` active, **plain `gcloud <cmd>` is correct** — it resolves
  to `stockbook` / `founder` / `stock-book-483718`. The setup scripts ALSO pin
  the config + account + project internally via a `gc()` wrapper, so they're
  safe regardless of the active config.
- If a second terminal runs a different gcp, that's yours to manage — `auth
login` can leave a different config active (e.g. `orvi-school`); re-run
  `gcp-stockbook` to switch back before running the scripts.

  ```bash
  gcp-stockbook                  # = gcloud config configurations activate stockbook
  gcloud config get-value account  # must read: founder@disdigital.in
  gcloud config get-value project  # must read: stock-book-483718
  ```

| Setting                | Value                   |
| ---------------------- | ----------------------- |
| GCP project            | `stock-book-483718`     |
| Cloud Run region       | `asia-south1`           |
| Vertex RAG region      | `us-central1`           |
| Document AI region     | `us`                    |
| Operator account       | `founder@disdigital.in` |
| Isolated gcloud config | `stockbook`             |

The setup scripts (`setup-document-ai.sh`, `setup-stocksage2.sh`,
`setup-vertex-rag.sh`) all pin the config + founder account + project internally
via a `gc()` wrapper, so you don't repeat the flags. With `gcp-stockbook` active,
the **re-auth in Step 1** is a plain `gcloud auth login founder@disdigital.in`.

---

## 1. Re-authenticate ONCE (the first thing you run)

The founder credentials hit a reauth policy and expire (`ERROR: Reauthentication
failed. cannot prompt during non-interactive execution`). Refresh them:

```bash
gcp-stockbook                              # ensure the stockbook config is active
gcloud auth login founder@disdigital.in    # refresh the founder token (browser)
gcloud config get-value account            # verify: founder@disdigital.in
gcloud config get-value project            # verify: stock-book-483718
```

Notes:

- This authenticates the **gcloud CLI** the setup scripts shell out to. `auth
login` can leave a different config active (e.g. `orvi-school`) — re-run
  `gcp-stockbook` afterward and verify the account/project as above.
- **You do NOT need `gcloud auth application-default login`.** The local workers
  read `GCP_SERVICE_ACCOUNT_KEY_BASE64` (already set in `.env` /
  `workers/.env.local`) for their Pub/Sub + Vertex credentials, so they never
  fall back to ADC — and skipping ADC login avoids clobbering the shared
  `application_default_credentials.json` another project's terminal may rely on.
  Only run ADC login if you deliberately unset the SA key locally.

---

## 2. Service-account key for Vertex RAG writes

Vertex RAG Engine corpus **WRITE** methods (`ragCorpora.create`,
`ragFiles:import`) **reject end-user gcloud credentials** with
`ACCESS_TOKEN_TYPE_UNSUPPORTED`. They require a **service-account token**.

`setup-vertex-rag.sh` (and `setup-stocksage2.sh`, which delegates the RAG step to
it) mints that token from a service-account key file inside a throwaway gcloud
config, so your personal login is never disturbed:

```bash
# Default key path is ./gcp-sa.json. Override with VERTEX_RAG_SA_KEY.
export VERTEX_RAG_SA_KEY=/absolute/path/to/aiplatform-sa-key.json
```

- The SA must have `roles/aiplatform.user` (RAG Engine read/write).
- **Read-only ops** (`gcloud services enable`, Document AI processor create,
  Pub/Sub) use your operator login from Step 1a — only the RAG REST writes need
  the SA key.
- The scripts NEVER print the token or the key contents (the dry-run masks the
  `Authorization: Bearer <sa-token>` header).

---

## 3. Dry-run, then apply

Both scripts are **dry-run by default** (they print the plan) and only mutate
cloud resources when you pass `--apply` — mirroring `setup-vertex-rag.sh`.

The orchestrator **requires an env arg: `qa | prod`** (every resource is
env-scoped). Add `--apply` to mutate.

```bash
# QA (done 2026-06-14):
bash scripts/ops/setup-stocksage2.sh qa            # show the full plan (dry-run)
bash scripts/ops/setup-stocksage2.sh qa --apply    # provision everything for QA

# PROD (run later — SAME script, prod resources):
bash scripts/ops/setup-stocksage2.sh prod          # dry-run the prod plan
bash scripts/ops/setup-stocksage2.sh prod --apply  # provision everything for PROD

# Single step / resume (e.g. only Document AI, or resume from pubsub):
bash scripts/ops/setup-stocksage2.sh qa --apply --only documentai
bash scripts/ops/setup-stocksage2.sh qa --apply --from 4
```

The env switches **every** resource: the `DATABASE_URL_{QA,PROD}` secret, the
`-{qa,prod}` Pub/Sub topics + scheduler jobs, the Vertex source bucket
`gs://stockbook-content-{qa,prod}/stocks`, and the corpus `stockbook-filings-{qa,prod}`.
The Document AI processor is project-scoped (qa+prod share the one processor).

What `setup-stocksage2.sh <env> --apply` does, in order (each step-selectable):

1. Enables `documentai`, `aiplatform`, `pubsub`, `run`, `cloudscheduler`.
2. Creates/reuses the **Document OCR** processor (region `us`) →
   `DOCUMENT_AI_PROCESSOR_ID`. (Delegates to `setup-document-ai.sh <env>`.)
3. **(optional)** Vertex AI RAG corpus. (Delegates to `setup-vertex-rag.sh <env>`
   — needs the SA key from Step 2.) **Non-fatal** — see the strategy note below.
4. Pub/Sub topics + push subs for the env (`stock-document-sync/extract/embed`,
   `investor-rollup`). (Delegates to `workers/scripts/setup-pubsub.sh <env>`.)
5. Cloud Scheduler daily jobs (`stock-document-extract-daily`,
   `investor-rollup-daily`). (Delegates to `setup-scheduler.sh <env>`.)
6. Prisma `db push` to the env DB (new models incl. `corporate_actions`).
7. **(optional, `--deploy-workers`)** Cloud Build redeploy of the workers.
8. Echoes the `NAME=value` env block for Vercel + the worker runtime.

Re-running is safe: API enable / processor reuse-by-name / topic+job upsert / db
push are all idempotent.

### Strategy note — Atlas is the primary RAG; Vertex is optional (read this)

**Do NOT bulk-import the raw PDFs into Vertex RAG Engine.** The content bucket
holds ~29k raw filing PDFs; handing those to Vertex would re-parse + naively
chunk them, discarding stockbook's Document-AI layout-aware extraction + the
per-docType smart chunkers (concall speaker-turns, AR headings) that feed
**Atlas `$vectorSearch`** — the primary, authoritative RAG. So:

- The **real win here is Document AI** (Step 2) → smart chunks → Atlas. That's done.
- The Vertex corpus (Step 3) is **deliberately deferred**. With `VERTEX_RAG_CORPUS`
  empty the retriever safely falls back to Atlas (the P2a seam), so QA shipped
  with `VERTEX_RAG_ENABLED=true` + empty corpus = Atlas. The script `--warn`s past
  an unresolved corpus instead of aborting.
- The corpus create is also currently **blocked** by a Vertex capacity rule
  (`RagManagedDb` Spanner mode is allowlist-gated for new projects in
  us-central1/us-east1/us-east4). We request KNN/serverless mode in the body; if
  it still rejects, use a supported region or BYO vector store.
- **When** Vertex is pursued: ingest the **extracted text** (the `.txt` +
  Document-AI sidecars), NOT the raw PDFs — a faithful A/B vs Atlas.

---

## 4. Environment — local file + the Vercel/worker hand-off list

### 4a. Local `.env` (repo root + `workers/.env.local`)

Set these locally so the workers and local Vertex calls pick up the new corpus
and processor. The workers load (in order) the monorepo-root `.env`, then
`workers/.env`, then `workers/.env.local` (override) — see `workers/src/index.ts`.

```bash
# --- GCP / ADC ---
GCP_PROJECT_ID=stock-book-483718
# Leave GCP_SERVICE_ACCOUNT_KEY_BASE64 UNSET locally → workers fall back to ADC
# (the application_default_credentials.json written by Step 1b).

# --- Local Pub/Sub pull subscriber (LOCAL ONLY) ---
ENABLE_PULL_SUBSCRIBER=true
PUBSUB_ENV=local        # CRITICAL — see the competing-consumer caveat in Step 5

# --- Document AI (MONEY-783) ---
DOCUMENT_AI_PROCESSOR_ID=<from setup-document-ai.sh output>
DOCUMENT_AI_LOCATION=us

# --- Vertex RAG (MONEY-781/782) — optional; Atlas stays default until enabled ---
VERTEX_RAG_ENABLED=true
VERTEX_RAG_CORPUS=<full resource name from setup-vertex-rag.sh output>
VERTEX_RAG_LOCATION=us-central1
```

### 4b. Hand-off list for Vercel (web) + the QA/prod worker runtime

**We never touch Vercel ourselves.** Hand the operator this `NAME=value` list to
set in the Vercel project (web) and in the Cloud Run worker env (via
`setup-infra.sh` / Cloud Build secrets). The scripts echo this exact block at the
end of `--apply`.

```
# Web (Vercel) — retrieval layer + research worker model lane
VERTEX_RAG_ENABLED=true
VERTEX_RAG_CORPUS=projects/stock-book-483718/locations/us-central1/ragCorpora/<CORPUS_ID>
VERTEX_RAG_LOCATION=us-central1

# Worker runtime (Cloud Run stockbook-workers-{qa,prod}) — extraction + RAG
DOCUMENT_AI_PROCESSOR_ID=<PROCESSOR_ID>
DOCUMENT_AI_LOCATION=us
VERTEX_RAG_ENABLED=true
VERTEX_RAG_CORPUS=projects/stock-book-483718/locations/us-central1/ragCorpora/<CORPUS_ID>
VERTEX_RAG_LOCATION=us-central1
```

> The deployed Cloud Run workers do NOT set `ENABLE_PULL_SUBSCRIBER` or
> `PUBSUB_ENV=local` — they receive Pub/Sub **push** subscriptions and resolve
> credentials via the attached service account (ADC on the metadata server). The
> pull subscriber + `PUBSUB_ENV=local` are strictly for your laptop.

---

## 5. How local picks up the workers (the pull-subscriber path)

In production, Pub/Sub **push** subscriptions POST to the Cloud Run worker's
`/jobs/*` endpoints. Push can't reach `localhost`, so locally the worker process
**pulls** messages instead. Verified mechanics:

### What turns the local pull subscriber on

`workers/src/index.ts` enables it when **either**:

- `ENABLE_PULL_SUBSCRIBER === "true"`, **or**
- `NODE_ENV` is NOT `production`/`qa` **and** `GCP_PROJECT_ID` is set.

It is hard-disabled on any deployed (`production`/`qa`) worker. Set
`ENABLE_PULL_SUBSCRIBER=true` + `GCP_PROJECT_ID` locally to be explicit.

### Which subscriptions it uses

`startPullSubscribers()` (`workers/src/lib/pull-subscriber.ts`) iterates
`TOPIC_PROCESSORS` and, per base topic, computes:

- topic = `getTopicName(baseTopic)` → `<base>-<PUBSUB_ENV>` (e.g.
  `stock-research-local`), where `PUBSUB_ENV` is resolved by `getTopicName` in
  `@usemoney/types/pubsub`.
- subscription = `getSubscriptionName(topic)` → `<topic>-pull-local`
  (e.g. `stock-research-local-pull-local`).

It uses the Subscriber API directly (`client.subscription(name).exists()`), and
**auto-creates** the pull subscription if missing (so you can skip the script),
acking after `MAX_DELIVERY_ATTEMPTS = 5` to self-dead-letter. A missing topic
(`NOT_FOUND`) is logged as `[skip]`, not a failure. You can also provision them
up front with `workers/scripts/setup-pubsub.sh local` (creates the topics +
`*-pull-local` subscriptions; no Cloud Run / push / IAM).

### Which jobs the local subscriber actually consumes (and which it does NOT)

`TOPIC_PROCESSORS` is the allow-list. As of MONEY-779 it registers **20**
processors — the base set (`trade-pairing`, `csv-import`, `broker-sync`,
`instrument-sync`, `price-sync`, `sector-enrichment`, `stock-research`, `mf-sync`,
`mf-metadata-sync`, `document-process`, `portfolio-roast`, `financial-data-sync`,
`news-sync`, `filings-sync`, `chartink-strategy-sync`, `strategy-scan`) **plus the
StockSage 2.0 jobs** `stock-document-sync`, `stock-document-extract`,
`stock-document-embed`, and `investor-rollup` (wired into
`workers/src/lib/pull-subscriber.ts` so local dev picks them up). So the local
pull subscriber DOES consume the keystone extract → embed chain + the nightly
rollup.

> **Competing-consumer note.** Those four also have QA Cloud Run push subs +
> daily schedulers. A local pull subscriber on the SAME env's topics gets a
> SEPARATE copy of every message (Pub/Sub fans out per subscription) — so set
> `PUBSUB_ENV=local` (below) to isolate your laptop onto `*-local` topics, or
> don't run local workers while relying on QA for the same data. The jobs are
> idempotent, so dev double-processing is safe.

### The command to run local workers

```bash
yarn workspace @usemoney/workers dev
```

On boot it prints a banner with `Pull Subscriber: ENABLED` and one
`✓ <topic> → listening` line per subscription it attached (20 when all `-local`
topics exist).

### Competing-consumer caveat (why `PUBSUB_ENV=local` is mandatory)

`getPubSubEnv()` falls back to **`qa`** when `PUBSUB_ENV` is unset and
`NODE_ENV` isn't `production`. If you run local workers without
`PUBSUB_ENV=local`, the pull subscriber attaches `*-pull-local` subscriptions to
the **`-qa` topics** — the SAME topics the QA Cloud Run push subscriptions
(`*-qa-push`) consume. Pub/Sub then fans every QA message (e.g. a Cloud
Scheduler-triggered `mf-sync`) to BOTH the QA worker AND your laptop, causing
duplicate concurrent runs and write conflicts on shared collections. Setting
`PUBSUB_ENV=local` isolates your machine onto the `*-local` topics. Provision
those isolated topics with `workers/scripts/setup-pubsub.sh local`.

---

## 6. Verification checklist

Run after `--apply` + a local worker boot (`PUBSUB_ENV=local`,
`ENABLE_PULL_SUBSCRIBER=true`, ADC from Step 1b).

- [ ] **Re-auth landed in the right config.** `CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud config list account --account=founder@disdigital.in --project=stock-book-483718` shows `founder@disdigital.in`. Your other terminal's `gcloud config list` (global) still shows `orvi` — untouched.
- [ ] **APIs enabled.** `documentai.googleapis.com`, `aiplatform.googleapis.com`, `pubsub.googleapis.com` appear in `gcloud services list` (isolated prefix).
- [ ] **Document AI processor exists.** The id echoed by `setup-document-ai.sh --apply` is set as `DOCUMENT_AI_PROCESSOR_ID`. Sanity-check in code: `documentAiReady()` (`workers/src/lib/docai.ts`) returns true only when both `GCP_PROJECT_ID` and the processor id are set — otherwise the worker silently falls back to `pdf-parse` (still works, just not layout-aware).
- [ ] **Local worker booted with pull on.** Banner reads `Pull Subscriber: ENABLED` and lists `✓ <topic>-local → listening` lines (20 of them when all `-local` topics exist).
- [ ] **A pull-listed job round-trips.** Publish a `stock-research-local` (or `mf-sync-local`) message and watch the local log: `[pull-subscriber] Processing … → Completed …`. This confirms ADC + topic isolation.
- [ ] **Keystone extract chain.** `stock-document-extract` is now in `TOPIC_PROCESSORS`, so a published `stock-document-extract-local` message is picked up by the local pull subscriber. You can also drive it directly via the HTTP endpoint:

  ```bash
  curl -X POST http://localhost:8081/jobs/stock-document-extract \
    -H "Content-Type: application/json" \
    -d '{"message":{"data":"'"$(printf '{"batchSize":5}' | base64)"'","messageId":"local-1","publishTime":"2026-06-14T00:00:00Z"},"subscription":"local-test"}'
  ```

  (Local dev skips HTTP OIDC because `ENABLE_PULL_SUBSCRIBER=true` + non-deployed
  env — see the middleware note in `workers/src/index.ts`.) Watch the worker log
  mark PENDING docs `PROCESSING` → Document AI (or `pdf-parse` fallback) →
  `READY`/`FAILED`, then chain a `stock-document-embed` job.

- [ ] **Embed produced vectors.** `DocumentEmbedding` rows exist for the symbols you extracted (the embed worker chunks the GCS sidecar for over-cap docs).
- [ ] **Vertex RAG retrieval works.** With `VERTEX_RAG_ENABLED=true` + `VERTEX_RAG_CORPUS` + `VERTEX_RAG_LOCATION=us-central1` set, a research query that hits the retriever returns chunks sourced from the corpus (not the Atlas fallback). Flip `VERTEX_RAG_ENABLED` off to confirm Atlas still serves (the seam is env-only).
- [ ] **No secrets in logs.** Confirm the `--apply` output never printed the SA token or key contents (the `Bearer` header is masked as `<redacted>`).

---

## Quick reference

| Step                 | Command                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| Re-auth (CLI)        | `CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud auth login founder@disdigital.in` |
| Re-auth (ADC)        | `gcloud auth application-default login`                                         |
| SA key for RAG       | `export VERTEX_RAG_SA_KEY=/path/to/aiplatform-sa-key.json`                      |
| Plan Document AI     | `bash scripts/ops/setup-document-ai.sh`                                         |
| Apply Document AI    | `bash scripts/ops/setup-document-ai.sh --apply`                                 |
| Plan full setup      | `bash scripts/ops/setup-stocksage2.sh`                                          |
| Apply full setup     | `bash scripts/ops/setup-stocksage2.sh --apply`                                  |
| Local Pub/Sub topics | `bash workers/scripts/setup-pubsub.sh local`                                    |
| Run local workers    | `yarn workspace @usemoney/workers dev`                                          |

---

_Owner: founder@disdigital.in · Project: stock-book-483718 · Last updated: 2026-06-14_
