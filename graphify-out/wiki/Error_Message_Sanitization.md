# Error Message Sanitization

> 25 nodes

## Key Concepts

- **document-failure.ts** (15 connections) — `workers/src/processors/document-failure.ts`
- **describeDocumentFailure()** (10 connections) — `workers/src/processors/document-failure.ts`
- **error-sanitization-security.test.ts** (8 connections) — `packages/utils/__tests__/error-sanitization-security.test.ts`
- **document-failure.test.ts** (8 connections) — `workers/__tests__/processors/document-failure.test.ts`
- **sanitizeErrorMessage()** (6 connections) — `packages/utils/src/error-sanitization.ts`
- **error-sanitization.ts** (6 connections) — `packages/utils/src/error-sanitization.ts`
- **getSafeErrorMessage()** (5 connections) — `packages/utils/src/error-sanitization.ts`
- **sanitizeErrors()** (4 connections) — `packages/utils/src/error-sanitization.ts`
- **errorName()** (4 connections) — `workers/src/processors/document-failure.ts`
- **UnsupportedContentError** (3 connections) — `workers/src/processors/document-failure.ts`
- **isTimeout()** (3 connections) — `workers/src/processors/document-failure.ts`
- **isUnreachable()** (3 connections) — `workers/src/processors/document-failure.ts`
- **truncateReason()** (3 connections) — `workers/src/processors/document-failure.ts`
- **error-sanitization.test.ts** (3 connections) — `packages/utils/__tests__/error-sanitization.test.ts`
- **assertNoSecretLeak()** (2 connections) — `packages/utils/__tests__/error-sanitization-security.test.ts`
- **describeStatus()** (2 connections) — `workers/src/processors/document-failure.ts`
- **MAX_FAILURE_REASON_LENGTH** (2 connections) — `workers/src/processors/document-failure.ts`
- **PrismaClientKnownRequestError** (1 connections) — `packages/utils/__tests__/error-sanitization-security.test.ts`
- **DocumentFailure** (1 connections) — `workers/src/processors/document-failure.ts`
- **DocumentFailureKind** (1 connections) — `workers/src/processors/document-failure.ts`
- **.constructor()** (1 connections) — `workers/src/processors/document-failure.ts`
- **codedError()** (1 connections) — `workers/__tests__/processors/document-failure.test.ts`
- **ssrfError()** (1 connections) — `workers/__tests__/processors/document-failure.test.ts`
- **FORBIDDEN_FRAGMENTS** (1 connections) — `packages/utils/__tests__/error-sanitization-security.test.ts`
- **SAFE_OUTPUTS** (1 connections) — `packages/utils/__tests__/error-sanitization-security.test.ts`

## Relationships

- [Vector Embeddings Service](Vector_Embeddings_Service.md) (5 shared connections)

## Source Files

- `packages/utils/__tests__/error-sanitization-security.test.ts`
- `packages/utils/__tests__/error-sanitization.test.ts`
- `packages/utils/src/error-sanitization.ts`
- `workers/__tests__/processors/document-failure.test.ts`
- `workers/src/processors/document-failure.ts`

## Audit Trail

- EXTRACTED: 49 (98%)
- INFERRED: 1 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*