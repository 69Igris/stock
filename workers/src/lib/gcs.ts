/**
 * GCS Helper for Workers
 *
 * Lightweight GCS client for downloading and uploading documents
 * in the worker environment.
 */

import { Storage } from "@google-cloud/storage";

let storage: Storage | null = null;

function getStorage(): Storage {
  if (storage) return storage;

  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    throw new Error("GCP_PROJECT_ID environment variable is required");
  }

  const keyBase64 = process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64;
  if (keyBase64) {
    const credentials = JSON.parse(
      Buffer.from(keyBase64, "base64").toString("utf-8")
    );
    storage = new Storage({ projectId, credentials });
  } else {
    // Application Default Credentials (Cloud Run)
    storage = new Storage({ projectId });
  }

  return storage;
}

function getBucketName(): string {
  return process.env.GCP_STORAGE_BUCKET || "stockbook-learning-content";
}

/**
 * Download a file from GCS as a Buffer
 */
export async function downloadFromGCS(path: string): Promise<Buffer> {
  const bucket = getStorage().bucket(getBucketName());
  const [content] = await bucket.file(path).download();
  return content;
}

/**
 * Upload a Buffer to GCS
 */
export async function uploadToGCS(
  path: string,
  content: Buffer,
  contentType: string
): Promise<void> {
  const bucket = getStorage().bucket(getBucketName());
  const file = bucket.file(path);
  await file.save(content, {
    contentType,
    resumable: false,
    validation: false,
    metadata: { cacheControl: "private, max-age=3600" },
  });
}

/**
 * Delete a file from GCS (best-effort)
 */
export async function deleteFromGCS(path: string): Promise<void> {
  const bucket = getStorage().bucket(getBucketName());
  await bucket.file(path).delete({ ignoreNotFound: true });
}
