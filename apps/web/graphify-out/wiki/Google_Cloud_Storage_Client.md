# Google Cloud Storage Client

> 11 nodes

## Key Concepts

- **MockGCSBucket** (6 connections) — `__tests__/workers/gcs.test.ts`
- **gcs.test.ts** (5 connections) — `__tests__/workers/gcs.test.ts`
- **buildDocumentPath()** (1 connections) — `__tests__/workers/gcs.test.ts`
- **getBucketName()** (1 connections) — `__tests__/workers/gcs.test.ts`
- **getContentTypeForExtension()** (1 connections) — `__tests__/workers/gcs.test.ts`
- **.delete()** (1 connections) — `__tests__/workers/gcs.test.ts`
- **.download()** (1 connections) — `__tests__/workers/gcs.test.ts`
- **.exists()** (1 connections) — `__tests__/workers/gcs.test.ts`
- **.listByPrefix()** (1 connections) — `__tests__/workers/gcs.test.ts`
- **.upload()** (1 connections) — `__tests__/workers/gcs.test.ts`
- **validateGCSPath()** (1 connections) — `__tests__/workers/gcs.test.ts`

## Relationships

- No strong cross-community connections detected

## Source Files

- `__tests__/workers/gcs.test.ts`

## Audit Trail

- EXTRACTED: 10 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*