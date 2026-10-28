/**
 * GCP Cloud Storage Client
 *
 * Handles initialization and management of Google Cloud Storage client
 * for storing and serving learning content (videos, audio, documents).
 *
 * Uses the same authentication pattern as the Vertex AI client.
 */

import { Storage, Bucket } from "@google-cloud/storage";
import { geminiLogger as logger } from "@usemoney/logger";
import { googleCredentials } from "@usemoney/core/gemini/credentials";
import {
  assertProjectId,
  getBucketName,
  buildGcsPath,
  mergeUploadMetadata,
  STORAGE_INIT_ERROR,
} from "./gcp-client-logic";

/**
 * Singleton Storage client instance
 */
let storage: Storage | null = null;
let bucket: Bucket | null = null;

/**
 * Get or initialize the GCP Storage client
 *
 * Environment variables required:
 * - GCP_PROJECT_ID: Google Cloud project ID
 * - GCP_STORAGE_BUCKET: Storage bucket name (default: stockbook-learning-content)
 *
 * Credentials resolve via the shared `googleCredentials()` resolver
 * (@usemoney/core/gemini/credentials), preserving the legacy precedence
 * (GCP_SERVICE_ACCOUNT_KEY_BASE64 first) and adding the
 * GOOGLE_APPLICATION_CREDENTIALS_JSON fallback:
 * - GCP_SERVICE_ACCOUNT_KEY_BASE64: Base64-encoded service account JSON (recommended for Vercel)
 * - GOOGLE_APPLICATION_CREDENTIALS_JSON: Raw JSON or base64 service account
 * - GOOGLE_APPLICATION_CREDENTIALS: Path to service account JSON key (for local development)
 * - else Application Default Credentials (Cloud Run attached SA)
 */
export function getStorageClient(): Storage {
  if (storage) {
    return storage;
  }

  const projectId = process.env.GCP_PROJECT_ID;

  assertProjectId(projectId);

  try {
    // Spread the resolver first, then pin projectId from the explicit
    // GCP_PROJECT_ID env — never the resolver's derived value.
    const creds = googleCredentials();
    storage = new Storage({ ...creds, projectId });

    const authMethod = creds.credentials
      ? "service_account_json"
      : creds.keyFilename
        ? "file_path"
        : "application_default";

    logger.info(
      {
        projectId,
        authMethod,
        ...(creds.keyFilename ? { credentialsPath: creds.keyFilename } : {}),
      },
      "GCP Storage client initialized"
    );

    return storage;
  } catch (error) {
    logger.error(
      { error, projectId },
      "Failed to initialize GCP Storage client"
    );
    throw new Error(STORAGE_INIT_ERROR);
  }
}

/**
 * Get the learning content bucket
 */
export function getBucket(): Bucket {
  if (bucket) {
    return bucket;
  }

  const bucketName = getBucketName(process.env.GCP_STORAGE_BUCKET);

  try {
    const client = getStorageClient();
    bucket = client.bucket(bucketName);

    logger.info({ bucketName }, "GCP Storage bucket initialized");
    return bucket;
  } catch (error) {
    logger.error({ error }, "Failed to get storage bucket");
    throw error;
  }
}

/**
 * Upload a file to GCP Storage
 *
 * @param filePath - Path within the bucket (e.g., "lessons/123/video.mp4")
 * @param content - File content as Buffer or stream
 * @param contentType - MIME type of the file
 * @param metadata - Optional metadata
 * @returns The file's GCS path
 */
export async function uploadFile(
  filePath: string,
  content: Buffer | NodeJS.ReadableStream,
  contentType: string,
  metadata?: Record<string, string>
): Promise<string> {
  const bucket = getBucket();
  const file = bucket.file(filePath);

  try {
    await file.save(content as Buffer, {
      contentType,
      metadata: mergeUploadMetadata(metadata),
    });

    logger.info({ filePath, contentType }, "File uploaded to GCP Storage");
    return buildGcsPath(bucket.name, filePath);
  } catch (error) {
    logger.error({ error, filePath }, "Failed to upload file to GCP Storage");
    throw error;
  }
}

/**
 * Delete a file from GCP Storage
 *
 * @param filePath - Path within the bucket
 */
export async function deleteFile(filePath: string): Promise<void> {
  const bucket = getBucket();
  const file = bucket.file(filePath);

  try {
    await file.delete();
    logger.info({ filePath }, "File deleted from GCP Storage");
  } catch (error) {
    logger.error({ error, filePath }, "Failed to delete file from GCP Storage");
    throw error;
  }
}

/**
 * Check if a file exists in GCP Storage
 *
 * @param filePath - Path within the bucket
 * @returns True if file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  const bucket = getBucket();
  const file = bucket.file(filePath);

  try {
    const [exists] = await file.exists();
    return exists;
  } catch (error) {
    logger.error({ error, filePath }, "Failed to check file existence");
    return false;
  }
}

/**
 * Get file metadata
 *
 * @param filePath - Path within the bucket
 * @returns File metadata
 */
export async function getFileMetadata(
  filePath: string
): Promise<Record<string, any> | null> {
  const bucket = getBucket();
  const file = bucket.file(filePath);

  try {
    const [metadata] = await file.getMetadata();
    return metadata;
  } catch (error) {
    logger.error({ error, filePath }, "Failed to get file metadata");
    return null;
  }
}

/**
 * List files in a directory
 *
 * @param prefix - Directory prefix (e.g., "lessons/123/")
 * @returns Array of file paths
 */
export async function listFiles(prefix: string): Promise<string[]> {
  const bucket = getBucket();

  try {
    const [files] = await bucket.getFiles({ prefix });
    return files.map((file) => file.name);
  } catch (error) {
    logger.error({ error, prefix }, "Failed to list files");
    return [];
  }
}

/**
 * Download file content
 *
 * @param filePath - Path within the bucket
 * @returns File content as Buffer
 */
export async function downloadFile(filePath: string): Promise<Buffer | null> {
  const bucket = getBucket();
  const file = bucket.file(filePath);

  try {
    const [content] = await file.download();
    return content;
  } catch (error) {
    logger.error({ error, filePath }, "Failed to download file");
    return null;
  }
}

/**
 * Get a readable stream for a file
 *
 * @param filePath - Path within the bucket
 * @param options - Optional range options for partial content
 * @returns Readable stream
 */
export function getFileStream(
  filePath: string,
  options?: { start?: number; end?: number }
): NodeJS.ReadableStream {
  const bucket = getBucket();
  const file = bucket.file(filePath);
  return file.createReadStream(options);
}
