# Path Routing and Proxy

> 19 nodes

## Key Concepts

- **[...path]/route.ts** (17 connections) — `app/api/storage/stream/[...path]/route.ts`
- **[...path]/route-logic.ts** (13 connections) — `app/api/storage/stream/[...path]/route-logic.ts`
- **GET()** (12 connections) — `app/api/storage/stream/[...path]/route.ts`
- **storage-stream-extended.test.ts** (11 connections) — `__tests__/api/storage-stream-extended.test.ts`
- **storage-stream.test.ts** (8 connections) — `__tests__/api/storage-stream.test.ts`
- **getContentType()** (6 connections) — `app/api/storage/stream/[...path]/route-logic.ts`
- **isValidContentPath()** (6 connections) — `app/api/storage/stream/[...path]/route-logic.ts`
- **getFileMetadata()** (6 connections) — `lib/storage/gcp-client.ts`
- **HEAD()** (5 connections) — `app/api/storage/stream/[...path]/route.ts`
- **extractDocumentUserId()** (5 connections) — `app/api/storage/stream/[...path]/route-logic.ts`
- **isDocumentPath()** (5 connections) — `app/api/storage/stream/[...path]/route-logic.ts`
- **parseRangeHeader()** (5 connections) — `app/api/storage/stream/[...path]/route-logic.ts`
- **shouldProxy()** (5 connections) — `app/api/storage/stream/[...path]/route-logic.ts`
- **shouldRedirect()** (5 connections) — `app/api/storage/stream/[...path]/route-logic.ts`
- **getFileStream()** (5 connections) — `lib/storage/gcp-client.ts`
- **CONTENT_TYPES** (2 connections) — `app/api/storage/stream/[...path]/route-logic.ts`
- **PROXY_EXTENSIONS** (2 connections) — `app/api/storage/stream/[...path]/route-logic.ts`
- **REDIRECT_EXTENSIONS** (2 connections) — `app/api/storage/stream/[...path]/route-logic.ts`
- **dynamic** (1 connections) — `app/api/storage/stream/[...path]/route.ts`

## Relationships

- [Storage & Signed URLs](Storage_&_Signed_URLs.md) (10 shared connections)
- [GCP Cloud Storage Upload](GCP_Cloud_Storage_Upload.md) (2 shared connections)
- [Auth & Integration Routes](Auth_&_Integration_Routes.md) (1 shared connections)

## Source Files

- `__tests__/api/storage-stream-extended.test.ts`
- `__tests__/api/storage-stream.test.ts`
- `app/api/storage/stream/[...path]/route-logic.ts`
- `app/api/storage/stream/[...path]/route.ts`
- `lib/storage/gcp-client.ts`

## Audit Trail

- EXTRACTED: 67 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*