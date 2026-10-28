/**
 * Pure helpers for the GCP Storage client, extracted from gcp-client.ts so the
 * env/auth/path logic is unit-testable without instantiating the
 * `@google-cloud/storage` client. getStorageClient / getBucket / uploadFile
 * call these — one implementation, exercised by both production and tests.
 */

/** Default bucket when GCP_STORAGE_BUCKET is unset. */
export const DEFAULT_BUCKET_NAME = "stockbook-learning-content";

/** Default cache-control applied to uploaded objects. */
export const DEFAULT_UPLOAD_CACHE_CONTROL = "private, max-age=3600";

/** Thrown by getStorageClient when GCP_PROJECT_ID is missing. */
export const MISSING_PROJECT_ID_ERROR =
  "GCP_PROJECT_ID environment variable is required. Please set it in your .env file.";

/** Thrown by getStorageClient when the Storage client fails to initialize. */
export const STORAGE_INIT_ERROR = "Failed to initialize storage service";

/**
 * Assert a GCP project id is present. Throws {@link MISSING_PROJECT_ID_ERROR}
 * (matching getStorageClient) and narrows the type to a non-undefined string.
 */
export function assertProjectId(
  projectId: string | undefined
): asserts projectId is string {
  if (!projectId) {
    throw new Error(MISSING_PROJECT_ID_ERROR);
  }
}

/** Resolve the bucket name with the default fallback. */
export function getBucketName(envBucketName: string | undefined): string {
  return envBucketName || DEFAULT_BUCKET_NAME;
}

// NOTE (MONEY-807): resolveStorageAuthMethod + decodeBase64Credentials were
// removed here. Credential resolution now flows through `googleCredentials()`
// (@usemoney/core/gemini/credentials), which getStorageClient calls directly,
// so both helpers had zero production callers after that migration. The live
// base64-decode path is `decodeBase64Credentials` in lib/gemini/client-logic.ts.

/** Build a `gs://bucket/path` URI. */
export function buildGcsPath(bucketName: string, filePath: string): string {
  return `gs://${bucketName}/${filePath}`;
}

/** Merge custom upload metadata over the default cache-control. */
export function mergeUploadMetadata(
  customMetadata?: Record<string, string>
): Record<string, string> {
  return { cacheControl: DEFAULT_UPLOAD_CACHE_CONTROL, ...customMetadata };
}
