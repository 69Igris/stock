# News Scraping and Fetching Tool

> 15 nodes

## Key Concepts

- **news-client.ts** (11 connections) — `packages/research/src/data-sources/news-client.ts`
- **fetch-news.ts** (10 connections) — `packages/research/src/tools/fetch-news.ts`
- **money1238-news-refresh-counts.test.ts** (7 connections) — `packages/research/__tests__/money1238-news-refresh-counts.test.ts`
- **refreshNews()** (6 connections) — `packages/research/src/data-sources/db-store.ts`
- **fetchNews()** (5 connections) — `packages/research/src/data-sources/news-client.ts`
- **getOrFetchNews()** (4 connections) — `packages/research/src/data-sources/db-store.ts`
- **parseRssXml()** (4 connections) — `packages/research/src/data-sources/news-client.ts`
- **NewsArticle** (3 connections) — `packages/research/src/types.ts`
- **fetchNewsTool** (3 connections) — `packages/research/src/tools/fetch-news.ts`
- **decodeHtmlEntities()** (2 connections) — `packages/research/src/data-sources/news-client.ts`
- **extractTag()** (2 connections) — `packages/research/src/data-sources/news-client.ts`
- **Row** (1 connections) — `packages/research/__tests__/money1238-news-refresh-counts.test.ts`
- **article()** (1 connections) — `packages/research/__tests__/money1238-news-refresh-counts.test.ts`
- **makeDb()** (1 connections) — `packages/research/__tests__/money1238-news-refresh-counts.test.ts`
- **storedRow()** (1 connections) — `packages/research/__tests__/money1238-news-refresh-counts.test.ts`

## Relationships

- [NSE Research Tools](NSE_Research_Tools.md) (8 shared connections)
- [Stock Financials Normalization](Stock_Financials_Normalization.md) (4 shared connections)
- [Technical Market Indicators](Technical_Market_Indicators.md) (3 shared connections)
- [Symbol Resolution and Skills](Symbol_Resolution_and_Skills.md) (3 shared connections)
- [Chartink Technical Scans Library](Chartink_Technical_Scans_Library.md) (3 shared connections)
- [Stock Document Fetching Staleness](Stock_Document_Fetching_Staleness.md) (1 shared connections)
- [Stock News Feed Synchronization](Stock_News_Feed_Synchronization.md) (1 shared connections)

## Source Files

- `packages/research/__tests__/money1238-news-refresh-counts.test.ts`
- `packages/research/src/data-sources/db-store.ts`
- `packages/research/src/data-sources/news-client.ts`
- `packages/research/src/tools/fetch-news.ts`
- `packages/research/src/types.ts`

## Audit Trail

- EXTRACTED: 42 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*