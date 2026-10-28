# Multipart Envelope Processing

> 10 nodes

## Key Concepts

- **multipart-envelope.ts** (16 connections) — `packages/storage/src/multipart-envelope.ts`
- **multipart-envelope.test.ts** (6 connections) — `packages/storage/__tests__/multipart-envelope.test.ts`
- **StrippedEnvelope** (2 connections) — `packages/storage/src/multipart-envelope.ts`
- **envelope()** (1 connections) — `packages/storage/__tests__/multipart-envelope.test.ts`
- **CONTENT_TYPE** (1 connections) — `packages/storage/src/multipart-envelope.ts`
- **CRLF** (1 connections) — `packages/storage/src/multipart-envelope.ts`
- **HEADER_SEP** (1 connections) — `packages/storage/src/multipart-envelope.ts`
- **BINARY** (1 connections) — `packages/storage/__tests__/multipart-envelope.test.ts`
- **CSV** (1 connections) — `packages/storage/__tests__/multipart-envelope.test.ts`
- **uploadFile** (1 connections) — `packages/storage/CLAUDE.md`

## Relationships

- [Feed Archive Header Auditing](Feed_Archive_Header_Auditing.md) (6 shared connections)
- [Storage Download Budget Manager](Storage_Download_Budget_Manager.md) (2 shared connections)
- [Document Body Guard Recovery](Document_Body_Guard_Recovery.md) (2 shared connections)
- [Document Container Management](Document_Container_Management.md) (1 shared connections)
- [Stock Document Validation Quarantine](Stock_Document_Validation_Quarantine.md) (1 shared connections)
- [Document Recovery Pipeline](Document_Recovery_Pipeline.md) (1 shared connections)

## Source Files

- `packages/storage/CLAUDE.md`
- `packages/storage/__tests__/multipart-envelope.test.ts`
- `packages/storage/src/multipart-envelope.ts`

## Audit Trail

- EXTRACTED: 21 (95%)
- INFERRED: 1 (5%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*