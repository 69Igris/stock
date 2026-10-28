# Tiingo News Ingestion

> 94 nodes

## Key Concepts

- **processors/tiingo-news-poll.ts** (49 connections) — `workers/src/processors/tiingo-news-poll.ts`
- **tiingo-news-logic.test.ts** (32 connections) — `packages/core/__tests__/market-data/tiingo-news-logic.test.ts`
- **tiingo-news-logic.ts** (31 connections) — `packages/core/src/market-data/tiingo/tiingo-news-logic.ts`
- **tiingo-news-articles-logic.ts** (27 connections) — `packages/core/src/market-data/tiingo/tiingo-news-articles-logic.ts`
- **tiingo-news-poll.test.ts** (21 connections) — `workers/__tests__/processors/tiingo-news-poll.test.ts`
- **tiingo-news-articles-logic.test.ts** (20 connections) — `packages/core/__tests__/market-data/tiingo-news-articles-logic.test.ts`
- **fetchNews()** (13 connections) — `packages/core/src/market-data/tiingo/tiingo-news.ts`
- **runNewsPoll()** (13 connections) — `workers/src/processors/tiingo-news-poll.ts`
- **TiingoNewsArticle** (11 connections) — `packages/core/src/market-data/tiingo/tiingo-news-logic.ts`
- **newsFloorDate()** (11 connections) — `packages/core/src/market-data/tiingo/tiingo-news-logic.ts`
- **buildTiingoNewsUrl()** (9 connections) — `packages/core/src/market-data/tiingo/tiingo-news-logic.ts`
- **TiingoNewsClampedError** (8 connections) — `packages/core/src/market-data/tiingo/tiingo-news-logic.ts`
- **normalizeArticle()** (8 connections) — `packages/core/src/market-data/tiingo/tiingo-news-articles-logic.ts`
- **dedupeTickers()** (8 connections) — `packages/core/src/market-data/tiingo/tiingo-news-logic.ts`
- **parseNewsResponse()** (8 connections) — `packages/core/src/market-data/tiingo/tiingo-news-logic.ts`
- **TiingoNewsFloorError** (7 connections) — `packages/core/src/market-data/tiingo/tiingo-news-logic.ts`
- **TiingoNewsParseError** (7 connections) — `packages/core/src/market-data/tiingo/tiingo-news-logic.ts`
- **planNewsCursor()** (7 connections) — `packages/core/src/market-data/tiingo/tiingo-news-articles-logic.ts`
- **isBeforeFloor()** (7 connections) — `packages/core/src/market-data/tiingo/tiingo-news-logic.ts`
- **toStockNewsRows()** (7 connections) — `packages/core/src/market-data/tiingo/tiingo-news-logic.ts`
- **safeCursorAdvance()** (6 connections) — `packages/core/src/market-data/tiingo/tiingo-news-articles-logic.ts`
- **detectClampedResponse()** (5 connections) — `packages/core/src/market-data/tiingo/tiingo-news-logic.ts`
- **run()** (5 connections) — `workers/__tests__/processors/tiingo-news-poll.test.ts`
- **TIINGO_NEWS_MAX_LIMIT** (5 connections) — `packages/core/src/market-data/tiingo/tiingo-news-logic.ts`
- **TIINGO_NEWS_MAX_OFFSET** (5 connections) — `packages/core/src/market-data/tiingo/tiingo-news-logic.ts`
- *... and 69 more nodes in this community*

## Relationships

- [Tiingo EOD Data Client](Tiingo_EOD_Data_Client.md) (23 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (22 shared connections)
- [Tiingo US News Ingestion](Tiingo_US_News_Ingestion.md) (14 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (4 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [US EOD Data Synchronization](US_EOD_Data_Synchronization.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (2 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (2 shared connections)
- [Tiingo API Rate Limiting](Tiingo_API_Rate_Limiting.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/tiingo-news-articles-logic.test.ts`
- `packages/core/__tests__/market-data/tiingo-news-logic.test.ts`
- `packages/core/src/market-data/tiingo/tiingo-news-articles-logic.ts`
- `packages/core/src/market-data/tiingo/tiingo-news-logic.ts`
- `packages/core/src/market-data/tiingo/tiingo-news.ts`
- `workers/__tests__/processors/tiingo-news-poll.test.ts`
- `workers/src/processors/tiingo-news-poll.ts`

## Audit Trail

- EXTRACTED: 267 (100%)
- INFERRED: 1 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*