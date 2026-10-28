# Storage & Signed URLs

> 35 nodes

## Key Concepts

- **storage/index.ts** (34 connections) — `lib/storage/index.ts`
- **signed-urls.ts** (19 connections) — `lib/storage/signed-urls.ts`
- **upload.ts** (19 connections) — `lib/storage/upload.ts`
- **getBucket()** (18 connections) — `lib/storage/gcp-client.ts`
- **generateSignedUrl()** (18 connections) — `lib/storage/signed-urls.ts`
- **fileExists()** (8 connections) — `lib/storage/gcp-client.ts`
- **signed-urls.test.ts** (8 connections) — `__tests__/storage/signed-urls.test.ts`
- **generateFilePath()** (6 connections) — `lib/storage/upload.ts`
- **deleteFile()** (5 connections) — `lib/storage/gcp-client.ts`
- **generateUploadUrl()** (5 connections) — `lib/storage/signed-urls.ts`
- **getResumableUploadUrl()** (5 connections) — `lib/storage/upload.ts`
- **uploadContent()** (5 connections) — `lib/storage/upload.ts`
- **validateFile()** (5 connections) — `lib/storage/upload.ts`
- **copyToLesson()** (4 connections) — `lib/storage/upload.ts`
- **getPresignedUploadUrl()** (4 connections) — `lib/storage/upload.ts`
- **upload.test.ts** (4 connections) — `__tests__/storage/upload.test.ts`
- **downloadFile()** (3 connections) — `lib/storage/gcp-client.ts`
- **listFiles()** (3 connections) — `lib/storage/gcp-client.ts`
- **buildContentDisposition()** (3 connections) — `lib/storage/signed-urls.ts`
- **generateAudioStreamingUrl()** (3 connections) — `lib/storage/signed-urls.ts`
- **generateDocumentUrl()** (3 connections) — `lib/storage/signed-urls.ts`
- **generateVideoStreamingUrls()** (3 connections) — `lib/storage/signed-urls.ts`
- **getFilename()** (3 connections) — `lib/storage/signed-urls.ts`
- **getTTLForContentType()** (3 connections) — `lib/storage/signed-urls.ts`
- **isSignedUrlValid()** (3 connections) — `lib/storage/signed-urls.ts`
- *... and 10 more nodes in this community*

## Relationships

- [GCP Cloud Storage Upload](GCP_Cloud_Storage_Upload.md) (18 shared connections)
- [Path Routing and Proxy](Path_Routing_and_Proxy.md) (10 shared connections)
- [Document Upload Interface](Document_Upload_Interface.md) (6 shared connections)
- [Feedback Form Tabs](Feedback_Form_Tabs.md) (4 shared connections)

## Source Files

- `__tests__/storage/signed-urls.test.ts`
- `__tests__/storage/upload.test.ts`
- `lib/storage/gcp-client.ts`
- `lib/storage/index.ts`
- `lib/storage/signed-urls.ts`
- `lib/storage/upload.ts`

## Audit Trail

- EXTRACTED: 126 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*