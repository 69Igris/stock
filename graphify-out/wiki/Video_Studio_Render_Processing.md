# Video Studio Render Processing

> 11 nodes

## Key Concepts

- **processors/studio-render.ts** (17 connections) — `workers/src/processors/studio-render.ts`
- **jobs.ts** (11 connections) — `packages/video-studio/src/jobs.ts`
- **jobs.test.ts** (6 connections) — `packages/video-studio/__tests__/jobs.test.ts`
- **processStudioRender()** (5 connections) — `workers/src/processors/studio-render.ts`
- **RenderJob** (4 connections) — `packages/video-studio/src/jobs.ts`
- **jobStatusKey()** (4 connections) — `packages/video-studio/src/jobs.ts`
- **setStatus()** (4 connections) — `workers/src/processors/studio-render.ts`
- **JobState** (3 connections) — `packages/video-studio/src/jobs.ts`
- **JobStatus** (3 connections) — `packages/video-studio/src/jobs.ts`
- **getRedis()** (2 connections) — `workers/src/processors/studio-render.ts`
- **RENDER_TOPIC** (2 connections) — `packages/video-studio/src/jobs.ts`

## Relationships

- [Video Timeline Generation](Video_Timeline_Generation.md) (5 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (4 shared connections)
- [Video and Audio Timeline Composition](Video_and_Audio_Timeline_Composition.md) (3 shared connections)
- [RAG Document Enqueue Service](RAG_Document_Enqueue_Service.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Storage Download Budget Manager](Storage_Download_Budget_Manager.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/video-studio/__tests__/jobs.test.ts`
- `packages/video-studio/src/jobs.ts`
- `workers/src/processors/studio-render.ts`

## Audit Trail

- EXTRACTED: 39 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*