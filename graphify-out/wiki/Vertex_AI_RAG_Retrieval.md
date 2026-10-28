# Vertex AI RAG Retrieval

> 57 nodes

## Key Concepts

- **processors/stock-document-embed.ts** (37 connections) — `workers/src/processors/stock-document-embed.ts`
- **vertex-rag.ts** (28 connections) — `packages/core/src/rag/vertex-rag.ts`
- **dotenv** (21 connections) — `workers/package.json`
- **stock-document-embed-logic.ts** (20 connections) — `workers/src/processors/stock-document-embed-logic.ts`
- **processStockDocumentEmbed()** (18 connections) — `workers/src/processors/stock-document-embed.ts`
- **vertex-rag.test.ts** (11 connections) — `packages/core/__tests__/vertex-rag.test.ts`
- **resolveCorpusName()** (8 connections) — `packages/core/src/rag/vertex-rag.ts`
- **retrieveContexts()** (8 connections) — `packages/core/src/rag/vertex-rag.ts`
- **ragCorpus()** (7 connections) — `packages/core/src/rag/vertex-rag.ts`
- **apiBase()** (6 connections) — `packages/core/src/rag/vertex-rag.ts`
- **importFiles()** (6 connections) — `packages/core/src/rag/vertex-rag.ts`
- **vertexRagConfigured()** (6 connections) — `packages/core/src/rag/vertex-rag.ts`
- **chunkText()** (6 connections) — `workers/src/lib/embeddings.ts`
- **chunkByDocType()** (6 connections) — `workers/src/processors/stock-document-embed-logic.ts`
- **chunkFinancialText()** (6 connections) — `workers/src/processors/stock-document-embed-logic.ts`
- **embed-stock-documents.ts** (6 connections) — `scripts/data/embed-stock-documents.ts`
- **project()** (5 connections) — `packages/core/src/rag/vertex-rag.ts`
- **chunkAnnualReport()** (5 connections) — `workers/src/processors/stock-document-embed-logic.ts`
- **extractedSidecarPath()** (5 connections) — `workers/src/processors/stock-document-extract-logic.ts`
- **google-auth-library** (5 connections) — `workers/package.json`
- **StockDocumentEmbedDeps** (4 connections) — `workers/src/processors/stock-document-embed.ts`
- **buildMetadataFilter()** (4 connections) — `packages/core/src/rag/vertex-rag.ts`
- **buildRetrieveContextsBody()** (4 connections) — `packages/core/src/rag/vertex-rag.ts`
- **getAuth()** (4 connections) — `packages/core/src/rag/vertex-rag.ts`
- **rest()** (4 connections) — `packages/core/src/rag/vertex-rag.ts`
- *... and 32 more nodes in this community*

## Relationships

- [Vector Embeddings Service](Vector_Embeddings_Service.md) (15 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (6 shared connections)
- [Stock Document Text Extraction](Stock_Document_Text_Extraction.md) (5 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Google Cloud Credentials Handler](Google_Cloud_Credentials_Handler.md) (3 shared connections)
- [RAG Document Enqueue Service](RAG_Document_Enqueue_Service.md) (3 shared connections)
- [RAG Document Context Retrieval](RAG_Document_Context_Retrieval.md) (2 shared connections)
- [Corporate Actions Windows](Corporate_Actions_Windows.md) (2 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (2 shared connections)
- [Worker Package Dependencies](Worker_Package_Dependencies.md) (2 shared connections)
- [Document Container Management](Document_Container_Management.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/vertex-rag.test.ts`
- `packages/core/src/rag/vertex-rag.ts`
- `ragFiles:import`
- `scripts/data/embed-stock-documents.ts`
- `workers/package.json`
- `workers/src/lib/embeddings.ts`
- `workers/src/processors/stock-document-embed-logic.ts`
- `workers/src/processors/stock-document-embed.ts`
- `workers/src/processors/stock-document-extract-logic.ts`

## Audit Trail

- EXTRACTED: 181 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*