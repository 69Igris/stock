# @usemoney/storage - CLAUDE.md

## Overview

GCP Cloud Storage utilities for UseMoney. Provides file upload, download, signed URL generation, and file management operations.

**Package:** `@usemoney/storage`

---

## Exports

```typescript
import {
  uploadFile,
  deleteFile,
  getSignedUrl,
  fileExists,
  downloadFile,
  getFileMetadata,
  listFiles,
  type UploadOptions,
  type UploadResult,
  type SignedUrlOptions,
} from "@usemoney/storage";
```

---

## MONEY-1169 — the upload contract (do not regress)

`uploadFile` MUST stay on the **resumable** path with **CRC32C validation on**
(both are the SDK defaults; `buildStreamOptions` pins them and
`__tests__/upload-options.test.ts` enforces it). History: `resumable: false` +
`validation: false` — two stale workarounds — caused every object written from
the workers image for ~3 months (all of `feeds/`, all of `stocks/`) to be
stored with the SDK's multipart request body AS its content. The non-resumable
path is `uploadType=multipart` on the wire; inside the Docker image the
transport resolves a different node-fetch major (the image overlays
`workers/node_modules`, which carries node-fetch@3, onto the root
node_modules' node-fetch@2), and the hand-built multipart body gets stored
verbatim. `validation: false` had silenced the exact CRC failure ("uploaded
data did not match the data from the server") that was reporting it.

Detection/repair of the corrupted shape lives in `src/multipart-envelope.ts`
(`isMultipartEnvelope` / `stripMultipartEnvelope`), used by
`scripts/jobs/feed-repair.ts`.

---

## Key Functions

| Function                          | Description                     |
| --------------------------------- | ------------------------------- |
| `uploadFile(options)`             | Upload file to GCS              |
| `deleteFile(fileName)`            | Delete file from GCS            |
| `getSignedUrl(fileName, options)` | Generate signed URL for access  |
| `fileExists(fileName)`            | Check if file exists            |
| `downloadFile(fileName)`          | Download file content as Buffer |
| `getFileMetadata(fileName)`       | Get file metadata               |
| `listFiles(prefix)`               | List files with a given prefix  |

---

## Usage

### Upload a File

```typescript
import { uploadFile } from "@usemoney/storage";

const result = await uploadFile({
  file: buffer, // Buffer containing file data
  fileName: "my-image.png", // Filename to use in storage
  contentType: "image/png", // MIME type
  folder: "content/images", // Optional: folder prefix
  userId: "user_123", // Optional: for tracking
  isPublic: true, // Optional: make publicly accessible (default: true)
  metadata: {
    // Optional: custom metadata
    originalName: "screenshot.png",
  },
});

console.log(result.url); // https://storage.googleapis.com/bucket/content/images/my-image.png
```

### Get Signed URL for Streaming

```typescript
import { getSignedUrl } from "@usemoney/storage";

// Read access for 15 minutes
const url = await getSignedUrl("videos/lesson-1.mp4", { expiresIn: 900 });

// Write access for direct upload
const uploadUrl = await getSignedUrl("uploads/temp.jpg", {
  action: "write",
  contentType: "image/jpeg",
  expiresIn: 300,
});
```

### Delete a File

```typescript
import { deleteFile } from "@usemoney/storage";

await deleteFile("content/images/old-image.png");
```

### Check File Existence

```typescript
import { fileExists } from "@usemoney/storage";

const exists = await fileExists("content/images/image.png");
```

### List Files

```typescript
import { listFiles } from "@usemoney/storage";

const files = await listFiles("content/images/");
// ["content/images/img1.png", "content/images/img2.jpg", ...]
```

---

## Types

### UploadOptions

```typescript
interface UploadOptions {
  file: Buffer; // File content as Buffer
  fileName: string; // Filename to use in storage
  contentType: string; // MIME type
  folder?: string; // Optional folder/prefix
  userId?: string; // Optional user ID for tracking
  metadata?: Record<string, string>; // Optional custom metadata
  isPublic?: boolean; // Make publicly accessible (default: true)
  bucketName?: string; // Override target bucket (MONEY-865 — e.g. the public content bucket)
}
```

### UploadResult

```typescript
interface UploadResult {
  url: string; // Public URL of the uploaded file
  fileName: string; // Full path in the bucket
  fileSize: number; // Size in bytes
  mimeType: string; // MIME type
}
```

### SignedUrlOptions

```typescript
interface SignedUrlOptions {
  action?: "read" | "write" | "delete" | "resumable"; // Default: "read"
  expiresIn?: number; // Seconds until expiry (default: 900)
  contentType?: string; // Required for write actions
}
```

---

## Configuration

Required environment variables:

```bash
# Required
GCP_PROJECT_ID=stock-book-483718
GCP_STORAGE_BUCKET=stockbook-learning-content        # PRIVATE bucket (isPublic:false path)
GCP_PUBLIC_STORAGE_BUCKET=...                        # PUBLIC uploads (isPublic:true, the default) resolve here — MONEY-865; unset => uploadFile THROWS

# Authentication (use one of these):
# Option 1: Base64-encoded service account (for Vercel/production)
GCP_SERVICE_ACCOUNT_KEY_BASE64=...

# Option 2: File path (for local development)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

---

## Authentication

The package supports two authentication methods:

1. **Base64 Credentials (Production)**: Set `GCP_SERVICE_ACCOUNT_KEY_BASE64` with the base64-encoded service account JSON. This is recommended for Vercel and other cloud deployments.

2. **File Path (Local Development)**: Set `GOOGLE_APPLICATION_CREDENTIALS` to the path of your service account JSON file. The Storage client will automatically use this.

---

## Error Handling

The package throws errors for:

- Missing `GCP_PROJECT_ID` or `GCP_STORAGE_BUCKET` environment variables
- `uploadFile` with `isPublic: true` (default) when neither `bucketName` nor `GCP_PUBLIC_STORAGE_BUCKET` is set (MONEY-865 — fail-loud instead of minting dead 403 URLs)
- GCS API errors (permissions, network, etc.)

For "not found" errors on delete/download operations, the package returns gracefully (void/null) instead of throwing.

## MONEY-979 — 404 is TWO different answers, and only one of them is `null`

`downloadFile`, `deleteFile` and `getFileMetadata` return `null`/void for a
missing **object** and now RETHROW for a missing **bucket**. They used to
key on `error.code === 404` alone, and GCS answers 404 for both:

```
GET /storage/v1/b/<no-such-bucket>/o/foo?alt=media
  -> 404  "The specified bucket does not exist."
GET /storage/v1/b/<real-bucket>/o/<no-such-object>?alt=media
  -> 404  "No such object: <bucket>/<object>"
```

Measured against the live API and against `@google-cloud/storage` 7.18, which
builds one `ApiError` with `code === 404`, `instanceof Error` and
`"code" in error` for both. The only discriminator is `.message`, and the
`catch` discarded it — so a misspelled, deleted or rotated
`GCP_STORAGE_BUCKET` made every read return `null`, with no throw and no log
naming the bucket. Callers act on that `null`: the 13F cold-store port turns it
into "this quarter is genuinely not archived" and renders an empty portfolio, so
one wrong env var reported every institutional manager as holding nothing. That
is `listFiles`'s MONEY-941 failure one layer down, in this same file.

`isBucketNotFound(error)` is exported and matches the BUCKET phrasing, not the
object one, deliberately: a reworded message can then only fail back to the old
behaviour, whereas matching `No such object` would turn every ordinary absent
object into a throw. Pinned by `__tests__/download-404.test.ts`, whose last case
drives the real SDK against a local 404 server rather than a transcribed string.

`fileExists` and `listFiles` still fail OPEN (`false` / `[]`) on every error,
including this one — `listFiles` at least logs (MONEY-941). Neither is a
trustworthy proof of absence; use `downloadFile` when the answer matters.

---

_Last Updated: July 2026_
