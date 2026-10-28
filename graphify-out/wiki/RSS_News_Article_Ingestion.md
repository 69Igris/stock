# RSS News Article Ingestion

> 25 nodes

## Key Concepts

- **processors/news-rss-sync.ts** (17 connections) — `workers/src/processors/news-rss-sync.ts`
- **news-ingest.ts** (14 connections) — `packages/services/src/news-ingest.ts`
- **processNewsRssSync()** (8 connections) — `workers/src/processors/news-rss-sync.ts`
- **routes/news-rss-sync.ts** (8 connections) — `workers/src/routes/news-rss-sync.ts`
- **parseRssChannel()** (6 connections) — `packages/services/src/news-ingest.ts`
- **dedupNewsBatch()** (5 connections) — `packages/services/src/news-ingest.ts`
- **RawNewsItem** (3 connections) — `packages/services/src/news-ingest.ts`
- **decodeXmlEntities()** (3 connections) — `packages/services/src/news-ingest.ts`
- **IngestedNewsArticle** (2 connections) — `packages/services/src/news-ingest.ts`
- **NewsRssSyncMessage** (2 connections) — `workers/src/processors/news-rss-sync.ts`
- **codePointOrRaw()** (2 connections) — `packages/services/src/news-ingest.ts`
- **jaccard()** (2 connections) — `packages/services/src/news-ingest.ts`
- **pickTag()** (2 connections) — `packages/services/src/news-ingest.ts`
- **stripCdata()** (2 connections) — `packages/services/src/news-ingest.ts`
- **tokenize()** (2 connections) — `packages/services/src/news-ingest.ts`
- **fetchFeed()** (2 connections) — `workers/src/processors/news-rss-sync.ts`
- **scoreSentiment()** (2 connections) — `workers/src/processors/news-rss-sync.ts`
- **tagSymbols()** (2 connections) — `workers/src/processors/news-rss-sync.ts`
- **newsRssSyncRoute** (2 connections) — `workers/src/routes/news-rss-sync.ts`
- **FeedConfig** (1 connections) — `workers/src/processors/news-rss-sync.ts`
- **DEDUP_TITLE_SIM** (1 connections) — `packages/services/src/news-ingest.ts`
- **NAMED_ENTITIES** (1 connections) — `packages/services/src/news-ingest.ts`
- **STOPWORDS** (1 connections) — `packages/services/src/news-ingest.ts`
- **FEEDS** (1 connections) — `workers/src/processors/news-rss-sync.ts`
- **NAME_TO_SYMBOL** (1 connections) — `workers/src/processors/news-rss-sync.ts`

## Relationships

- [PubSub Message Handlers](PubSub_Message_Handlers.md) (5 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/services/src/news-ingest.ts`
- `workers/src/processors/news-rss-sync.ts`
- `workers/src/routes/news-rss-sync.ts`

## Audit Trail

- EXTRACTED: 51 (98%)
- INFERRED: 1 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*