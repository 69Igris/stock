# Document Pagination and Filtering

> 22 nodes

## Key Concepts

- **documents.service.ts** (20 connections) — `packages/services/src/documents.service.ts`
- **documents-logic.ts** (12 connections) — `packages/services/src/documents-logic.ts`
- **documentScopeWhere** (4 connections) — `packages/services/src/documents-logic.ts`
- **clampDocumentPagination()** (4 connections) — `packages/services/src/documents-logic.ts`
- **buildDocumentListWhere()** (3 connections) — `packages/services/src/documents-logic.ts`
- **getDocuments()** (3 connections) — `packages/services/src/documents.service.ts`
- **toFiniteInt()** (2 connections) — `packages/services/src/documents-logic.ts`
- **deleteDocument()** (2 connections) — `packages/services/src/documents.service.ts`
- **getDocument()** (2 connections) — `packages/services/src/documents.service.ts`
- **DerivedDocumentStatus** (1 connections) — `packages/services/src/documents-logic.ts`
- **DocumentListFilters** (1 connections) — `packages/services/src/documents-logic.ts`
- **DocumentPaginationBounds** (1 connections) — `packages/services/src/documents-logic.ts`
- **DocumentReadiness** (1 connections) — `packages/services/src/documents-logic.ts`
- **DocumentDetail** (1 connections) — `packages/services/src/documents.service.ts`
- **DocumentFilters** (1 connections) — `packages/services/src/documents.service.ts`
- **DocumentListItem** (1 connections) — `packages/services/src/documents.service.ts`
- **GenerateReportInput** (1 connections) — `packages/services/src/documents.service.ts`
- **deriveDocumentStatus()** (1 connections) — `packages/services/src/documents-logic.ts`
- **generateReport()** (1 connections) — `packages/services/src/documents.service.ts`
- **DEFAULT_DOCUMENT_LIMIT** (1 connections) — `packages/services/src/documents-logic.ts`
- **MAX_DOCUMENT_LIMIT** (1 connections) — `packages/services/src/documents-logic.ts`
- **NOTE: Upload, signed URLs, GCS operations, and Pub/Sub publishing** (1 connections) — `packages/services/src/documents.service.ts`

## Relationships

- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (4 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (1 shared connections)

## Source Files

- `packages/services/src/documents-logic.ts`
- `packages/services/src/documents.service.ts`

## Audit Trail

- EXTRACTED: 36 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*