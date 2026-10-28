# Market Tick Data Archiver

> 16 nodes

## Key Concepts

- **tick-archive.ts** (14 connections) — `workers/src/realtime/tick-archive.ts`
- **tick-archive.test.ts** (9 connections) — `workers/__tests__/realtime/tick-archive.test.ts`
- **TickArchive** (7 connections) — `workers/src/realtime/tick-archive.ts`
- **archiveEnabled()** (6 connections) — `workers/src/realtime/tick-archive.ts`
- **.flush()** (4 connections) — `workers/src/realtime/tick-archive.ts`
- **archiveKey()** (3 connections) — `workers/src/realtime/tick-archive.ts`
- **.add()** (3 connections) — `workers/src/realtime/tick-archive.ts`
- **ARCHIVE_FLUSH_MS** (2 connections) — `workers/src/realtime/tick-archive.ts`
- **MAX_BUFFERED_LINES** (2 connections) — `workers/src/realtime/tick-archive.ts`
- **TICK_ARCHIVE_PREFIX** (2 connections) — `workers/src/realtime/tick-archive.ts`
- **TickArchiveCounters** (1 connections) — `workers/src/realtime/tick-archive.ts`
- **emptyTickArchiveCounters()** (1 connections) — `workers/src/realtime/tick-archive.ts`
- **.constructor()** (1 connections) — `workers/src/realtime/tick-archive.ts`
- **.dueForFlush()** (1 connections) — `workers/src/realtime/tick-archive.ts`
- **REPO** (1 connections) — `workers/__tests__/realtime/tick-archive.test.ts`
- **saved** (1 connections) — `workers/__tests__/realtime/tick-archive.test.ts`

## Relationships

- [Tiingo Minute Bar Aggregation](Tiingo_Minute_Bar_Aggregation.md) (4 shared connections)
- [Price Source Write Authority](Price_Source_Write_Authority.md) (3 shared connections)
- [RAG Document Enqueue Service](RAG_Document_Enqueue_Service.md) (2 shared connections)
- [Storage Download Budget Manager](Storage_Download_Budget_Manager.md) (1 shared connections)

## Source Files

- `workers/__tests__/realtime/tick-archive.test.ts`
- `workers/src/realtime/tick-archive.ts`

## Audit Trail

- EXTRACTED: 34 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*