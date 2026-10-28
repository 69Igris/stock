# GCP Cloud Storage Upload

> 16 nodes

## Key Concepts

- **gcp-client.ts** (21 connections) — `lib/storage/gcp-client.ts`
- **uploadFile()** (13 connections) — `lib/storage/gcp-client.ts`
- **gcp-client-logic.ts** (10 connections) — `lib/storage/gcp-client-logic.ts`
- **gcp-client.test.ts** (9 connections) — `__tests__/storage/gcp-client.test.ts`
- **upload/route.ts** (6 connections) — `app/api/feedback/upload/route.ts`
- **getStorageClient()** (4 connections) — `lib/storage/gcp-client.ts`
- **assertProjectId()** (4 connections) — `lib/storage/gcp-client-logic.ts`
- **buildGcsPath()** (4 connections) — `lib/storage/gcp-client-logic.ts`
- **getBucketName()** (4 connections) — `lib/storage/gcp-client-logic.ts`
- **mergeUploadMetadata()** (4 connections) — `lib/storage/gcp-client-logic.ts`
- **POST()** (3 connections) — `app/api/feedback/upload/route.ts`
- **STORAGE_INIT_ERROR** (3 connections) — `lib/storage/gcp-client-logic.ts`
- **DEFAULT_BUCKET_NAME** (2 connections) — `lib/storage/gcp-client-logic.ts`
- **DEFAULT_UPLOAD_CACHE_CONTROL** (2 connections) — `lib/storage/gcp-client-logic.ts`
- **MISSING_PROJECT_ID_ERROR** (2 connections) — `lib/storage/gcp-client-logic.ts`
- **ALLOWED_TYPES** (1 connections) — `app/api/feedback/upload/route.ts`

## Relationships

- [Storage & Signed URLs](Storage_&_Signed_URLs.md) (18 shared connections)
- [Feedback Form Tabs](Feedback_Form_Tabs.md) (3 shared connections)
- [Document Upload Interface](Document_Upload_Interface.md) (2 shared connections)
- [Path Routing and Proxy](Path_Routing_and_Proxy.md) (2 shared connections)
- [Primitive UI Components](Primitive_UI_Components.md) (1 shared connections)

## Source Files

- `__tests__/storage/gcp-client.test.ts`
- `app/api/feedback/upload/route.ts`
- `lib/storage/gcp-client-logic.ts`
- `lib/storage/gcp-client.ts`

## Audit Trail

- EXTRACTED: 59 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*