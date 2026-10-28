/**
 * Storage Module
 *
 * Centralized exports for GCP Cloud Storage utilities.
 */

// Client utilities
export {
  getStorageClient,
  getBucket,
  uploadFile,
  deleteFile,
  fileExists,
  getFileMetadata,
  listFiles,
  downloadFile,
  getFileStream,
} from "./gcp-client";

// Signed URL utilities
export {
  generateSignedUrl,
  generateVideoStreamingUrls,
  generateAudioStreamingUrl,
  generateDocumentUrl,
  generateUploadUrl,
  isSignedUrlValid,
  getTTLForContentType,
  DEFAULT_TTL,
  type SignedUrlOptions,
} from "./signed-urls";

// Upload utilities
export {
  uploadContent,
  getPresignedUploadUrl,
  copyToLesson,
  deleteContent,
  getResumableUploadUrl,
  validateFile,
  generateFilePath,
  SUPPORTED_FILE_TYPES,
  type SupportedMimeType,
  type ContentCategory,
  type UploadResult,
} from "./upload";
