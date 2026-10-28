# @usemoney/storage

> GCP Cloud Storage utilities for UseMoney

## Usage

```typescript
import { getSignedUrl, uploadFile } from "@usemoney/storage";

// Signed URL
const url = await getSignedUrl("videos/lesson.mp4", 900);

// Upload
await uploadFile(buffer, "pdfs/guide.pdf");
```

## Functions

| Function                  | Description    |
| ------------------------- | -------------- |
| `getSignedUrl(path, ttl)` | Get signed URL |
| `uploadFile(file, path)`  | Upload file    |
| `downloadFile(path)`      | Download file  |
| `deleteFile(path)`        | Delete file    |

## Documentation

See **CLAUDE.md** for details.
