# Vector Embeddings Service

> 48 nodes

## Key Concepts

- **processors/document-process.ts** (43 connections) — `workers/src/processors/document-process.ts`
- **uploadToGCS()** (21 connections) — `workers/src/lib/gcs.ts`
- **downloadFromGCS()** (20 connections) — `workers/src/lib/gcs.ts`
- **document-process-logic.ts** (20 connections) — `workers/src/processors/document-process-logic.ts`
- **lib/embeddings.ts** (19 connections) — `workers/src/lib/embeddings.ts`
- **gcs.ts** (16 connections) — `workers/src/lib/gcs.ts`
- **src/embeddings.ts** (13 connections) — `packages/core/src/embeddings.ts`
- **handleFetchUrl()** (11 connections) — `workers/src/processors/document-process.ts`
- **processDocument()** (11 connections) — `workers/src/processors/document-process.ts`
- **getEmbeddingModel()** (9 connections) — `packages/core/src/embeddings.ts`
- **handleFetchNse()** (9 connections) — `workers/src/processors/document-process.ts`
- **handleExtractText()** (8 connections) — `workers/src/processors/document-process.ts`
- **indexDocumentForRAG()** (8 connections) — `workers/src/processors/document-process.ts`
- **capTextContent()** (8 connections) — `workers/src/processors/document-process-logic.ts`
- **generateBatchEmbeddings()** (6 connections) — `workers/src/lib/embeddings.ts`
- **generateEmbedding()** (6 connections) — `workers/src/lib/embeddings.ts`
- **stripHtmlTags()** (6 connections) — `workers/src/processors/document-process-logic.ts`
- **RemoteFetchError** (5 connections) — `workers/src/processors/document-failure.ts`
- **buildEmbeddingRequestBody()** (5 connections) — `packages/core/src/embeddings.ts`
- **generateEmbedding()** (5 connections) — `packages/core/src/embeddings.ts`
- **getEmbeddingFromVertexAI()** (5 connections) — `workers/src/lib/embeddings.ts`
- **extractPdfText()** (5 connections) — `workers/src/processors/document-process.ts`
- **shouldIndexForRAG()** (5 connections) — `workers/src/processors/document-process-logic.ts`
- **getBucketName()** (4 connections) — `workers/src/lib/gcs.ts`
- **getStorage()** (4 connections) — `workers/src/lib/gcs.ts`
- *... and 23 more nodes in this community*

## Relationships

- [Vertex AI RAG Retrieval](Vertex_AI_RAG_Retrieval.md) (15 shared connections)
- [Stock Document Text Extraction](Stock_Document_Text_Extraction.md) (11 shared connections)
- [Document Financial Ingestion Backfill](Document_Financial_Ingestion_Backfill.md) (7 shared connections)
- [Document Ingestion Query Selectors](Document_Ingestion_Query_Selectors.md) (6 shared connections)
- [Error Message Sanitization](Error_Message_Sanitization.md) (5 shared connections)
- [Google Cloud Credentials Handler](Google_Cloud_Credentials_Handler.md) (5 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (5 shared connections)
- [Stock Document Parsing Pipeline](Stock_Document_Parsing_Pipeline.md) (3 shared connections)
- [US Filing Insights Processor](US_Filing_Insights_Processor.md) (3 shared connections)
- [Stock Document Synchronization](Stock_Document_Synchronization.md) (3 shared connections)
- [Corporate Issues Logic](Corporate_Issues_Logic.md) (3 shared connections)
- [Document Body Guard Recovery](Document_Body_Guard_Recovery.md) (3 shared connections)

## Source Files

- `google-auth-library`
- `packages/core/__tests__/embeddings.test.ts`
- `packages/core/src/embeddings.ts`
- `workers/src/lib/embeddings.ts`
- `workers/src/lib/gcs.ts`
- `workers/src/processors/document-failure.ts`
- `workers/src/processors/document-process-logic.ts`
- `workers/src/processors/document-process.ts`

## Audit Trail

- EXTRACTED: 204 (100%)
- INFERRED: 1 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*