# RAG Document Enqueue Service

> 25 nodes

## Key Concepts

- **rag-enqueue.ts** (20 connections) — `packages/research/src/data-sources/rag-enqueue.ts`
- **uploadFile()** (17 connections) — `packages/storage/src/index.ts`
- **source-cache.ts** (12 connections) — `packages/research/src/data-sources/source-cache.ts`
- **rag-enqueue.test.ts** (12 connections) — `packages/research/__tests__/rag-enqueue.test.ts`
- **enqueueDocumentForRag()** (7 connections) — `packages/research/src/data-sources/rag-enqueue.ts`
- **getRagCoverage()** (7 connections) — `packages/research/src/data-sources/rag-enqueue.ts`
- **canonicalSymbol()** (6 connections) — `packages/research/src/data-sources/source-cache.ts`
- **writeStockDoc()** (5 connections) — `packages/research/src/data-sources/source-cache.ts`
- **buildEnqueueKey()** (4 connections) — `packages/research/src/data-sources/rag-enqueue.ts`
- **isDatabaseConfigured()** (4 connections) — `packages/research/src/data-sources/rag-enqueue.ts`
- **cachedFetch()** (4 connections) — `packages/research/src/data-sources/source-cache.ts`
- **stockDocPath()** (4 connections) — `packages/research/src/data-sources/source-cache.ts`
- **EnqueuePrismaClient** (3 connections) — `packages/research/src/data-sources/rag-enqueue.ts`
- **computeCoverage()** (3 connections) — `packages/research/src/data-sources/rag-enqueue.ts`
- **initialProcessingStatus()** (3 connections) — `packages/research/src/data-sources/rag-enqueue.ts`
- **sanitizePathSegment()** (3 connections) — `packages/research/src/data-sources/rag-enqueue.ts`
- **readStockDoc()** (3 connections) — `packages/research/src/data-sources/source-cache.ts`
- **EnqueueDocumentArgs** (2 connections) — `packages/research/src/data-sources/rag-enqueue.ts`
- **UploadFn** (2 connections) — `packages/research/src/data-sources/stock-document-fetcher.ts`
- **SpyDb** (2 connections) — `packages/research/__tests__/rag-enqueue.test.ts`
- **RagCoverage** (1 connections) — `packages/research/src/data-sources/rag-enqueue.ts`
- **CachedDoc** (1 connections) — `packages/research/src/data-sources/source-cache.ts`
- **StockDocRow** (1 connections) — `packages/research/__tests__/rag-enqueue.test.ts`
- **withDb()** (1 connections) — `packages/research/__tests__/rag-enqueue.test.ts`
- **logger** (1 connections) — `packages/research/src/data-sources/rag-enqueue.ts`

## Relationships

- [NSE Research Tools](NSE_Research_Tools.md) (6 shared connections)
- [Storage Download Budget Manager](Storage_Download_Budget_Manager.md) (4 shared connections)
- [Stock Document Fetching Staleness](Stock_Document_Fetching_Staleness.md) (3 shared connections)
- [Vertex AI RAG Retrieval](Vertex_AI_RAG_Retrieval.md) (3 shared connections)
- [BSE Announcements Backfill](BSE_Announcements_Backfill.md) (2 shared connections)
- [Index Constituent Parsing](Index_Constituent_Parsing.md) (2 shared connections)
- [Feed Archive Header Auditing](Feed_Archive_Header_Auditing.md) (2 shared connections)
- [NSE Announcements Sync](NSE_Announcements_Sync.md) (2 shared connections)
- [Video Studio Render Processing](Video_Studio_Render_Processing.md) (2 shared connections)
- [Market Tick Data Archiver](Market_Tick_Data_Archiver.md) (2 shared connections)
- [Databento Data Harvesting](Databento_Data_Harvesting.md) (1 shared connections)
- [XBRL Feed Archive Backfill](XBRL_Feed_Archive_Backfill.md) (1 shared connections)

## Source Files

- `packages/research/__tests__/rag-enqueue.test.ts`
- `packages/research/src/data-sources/rag-enqueue.ts`
- `packages/research/src/data-sources/source-cache.ts`
- `packages/research/src/data-sources/stock-document-fetcher.ts`
- `packages/storage/src/index.ts`

## Audit Trail

- EXTRACTED: 80 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*