/**
 * Upload Utilities for Admin Content Management
 *
 * Handles file uploads from admin panel to GCP Storage.
 * Supports videos, audio, documents, and images.
 */

import { uploadFile, getBucket, fileExists } from "./gcp-client";
import { generateUploadUrl } from "./signed-urls";
import { geminiLogger as logger } from "@usemoney/logger";
import crypto from "crypto";

/**
 * Supported file types and their configurations
 */
export const SUPPORTED_FILE_TYPES = {
  // Videos
  "video/mp4": { ext: "mp4", category: "video", maxSize: 500 * 1024 * 1024 },
  "video/webm": { ext: "webm", category: "video", maxSize: 500 * 1024 * 1024 },
  "video/quicktime": {
    ext: "mov",
    category: "video",
    maxSize: 500 * 1024 * 1024,
  },

  // Audio
  "audio/mpeg": { ext: "mp3", category: "audio", maxSize: 50 * 1024 * 1024 },
  "audio/wav": { ext: "wav", category: "audio", maxSize: 100 * 1024 * 1024 },
  "audio/mp4": { ext: "m4a", category: "audio", maxSize: 50 * 1024 * 1024 },

  // Documents
  "application/pdf": {
    ext: "pdf",
    category: "document",
    maxSize: 50 * 1024 * 1024,
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    ext: "pptx",
    category: "document",
    maxSize: 100 * 1024 * 1024,
  },
  "application/vnd.ms-powerpoint": {
    ext: "ppt",
    category: "document",
    maxSize: 100 * 1024 * 1024,
  },

  // Images
  "image/png": { ext: "png", category: "image", maxSize: 10 * 1024 * 1024 },
  "image/jpeg": { ext: "jpg", category: "image", maxSize: 10 * 1024 * 1024 },
  "image/gif": { ext: "gif", category: "image", maxSize: 10 * 1024 * 1024 },
  "image/svg+xml": { ext: "svg", category: "image", maxSize: 5 * 1024 * 1024 },
  "image/webp": { ext: "webp", category: "image", maxSize: 10 * 1024 * 1024 },
} as const;

export type SupportedMimeType = keyof typeof SUPPORTED_FILE_TYPES;
export type ContentCategory = "video" | "audio" | "document" | "image";

/**
 * Upload result interface
 */
export interface UploadResult {
  success: boolean;
  path?: string;
  url?: string;
  error?: string;
  metadata?: {
    size: number;
    contentType: string;
    category: ContentCategory;
    uploadedAt: Date;
  };
}

/**
 * Validate file type and size
 */
export function validateFile(
  contentType: string,
  size: number
): {
  valid: boolean;
  error?: string;
  config?: (typeof SUPPORTED_FILE_TYPES)[SupportedMimeType];
} {
  const config = SUPPORTED_FILE_TYPES[contentType as SupportedMimeType];

  if (!config) {
    return {
      valid: false,
      error: `Unsupported file type: ${contentType}. Supported types: ${Object.keys(SUPPORTED_FILE_TYPES).join(", ")}`,
    };
  }

  if (size > config.maxSize) {
    const maxSizeMB = Math.round(config.maxSize / (1024 * 1024));
    return {
      valid: false,
      error: `File too large. Maximum size for ${config.category} files is ${maxSizeMB}MB`,
    };
  }

  return { valid: true, config };
}

/**
 * Generate a unique file path for uploads
 */
export function generateFilePath(
  category: ContentCategory,
  lessonId: string | null,
  originalFilename: string,
  adminId: string
): string {
  const timestamp = Date.now();
  const randomId = crypto.randomBytes(4).toString("hex");
  const ext = originalFilename.split(".").pop()?.toLowerCase() || "bin";
  const sanitizedName = originalFilename
    .replace(/[^a-zA-Z0-9.-]/g, "_")
    .slice(0, 50);

  if (lessonId) {
    // Upload to lesson directory
    return `lessons/${lessonId}/${category}/${timestamp}-${randomId}-${sanitizedName}`;
  } else {
    // Upload to admin uploads directory
    return `uploads/admin/${adminId}/${category}/${timestamp}-${randomId}.${ext}`;
  }
}

/**
 * Upload content directly from buffer
 *
 * @param content - File content as Buffer
 * @param contentType - MIME type
 * @param lessonId - Optional lesson ID
 * @param originalFilename - Original filename for path generation
 * @param adminId - Admin user ID
 * @returns Upload result
 */
export async function uploadContent(
  content: Buffer,
  contentType: string,
  lessonId: string | null,
  originalFilename: string,
  adminId: string
): Promise<UploadResult> {
  // Validate file
  const validation = validateFile(contentType, content.length);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const config = validation.config!;
  const filePath = generateFilePath(
    config.category,
    lessonId,
    originalFilename,
    adminId
  );

  try {
    const gcsPath = await uploadFile(filePath, content, contentType, {
      uploadedBy: adminId,
      originalFilename,
      lessonId: lessonId || "",
    });

    logger.info(
      {
        filePath,
        contentType,
        size: content.length,
        lessonId,
        adminId,
      },
      "Content uploaded successfully"
    );

    return {
      success: true,
      path: filePath,
      url: gcsPath,
      metadata: {
        size: content.length,
        contentType,
        category: config.category,
        uploadedAt: new Date(),
      },
    };
  } catch (error) {
    logger.error({ error, filePath }, "Failed to upload content");
    return {
      success: false,
      error: "Upload failed - please try again",
    };
  }
}

/**
 * Get a presigned URL for direct upload from client
 *
 * @param contentType - MIME type of file to upload
 * @param lessonId - Optional lesson ID
 * @param originalFilename - Original filename
 * @param adminId - Admin user ID
 * @returns Presigned upload URL and destination path
 */
export async function getPresignedUploadUrl(
  contentType: string,
  lessonId: string | null,
  originalFilename: string,
  adminId: string
): Promise<{
  success: boolean;
  uploadUrl?: string;
  filePath?: string;
  expiresAt?: Date;
  error?: string;
}> {
  // Validate file type
  const config = SUPPORTED_FILE_TYPES[contentType as SupportedMimeType];
  if (!config) {
    return {
      success: false,
      error: `Unsupported file type: ${contentType}`,
    };
  }

  const filePath = generateFilePath(
    config.category,
    lessonId,
    originalFilename,
    adminId
  );

  try {
    const { uploadUrl, expiresAt } = await generateUploadUrl(
      filePath,
      contentType,
      config.maxSize
    );

    return {
      success: true,
      uploadUrl,
      filePath,
      expiresAt,
    };
  } catch (error) {
    logger.error({ error }, "Failed to generate presigned upload URL");
    return {
      success: false,
      error: "Failed to prepare upload - please try again",
    };
  }
}

/**
 * Copy uploaded content to lesson directory
 *
 * @param sourcePath - Source path in uploads
 * @param lessonId - Target lesson ID
 * @param category - Content category
 * @returns New file path
 */
export async function copyToLesson(
  sourcePath: string,
  lessonId: string,
  category: ContentCategory
): Promise<string> {
  const bucket = getBucket();
  const sourceFile = bucket.file(sourcePath);

  // Check if source exists
  const exists = await fileExists(sourcePath);
  if (!exists) {
    throw new Error(`Source file not found: ${sourcePath}`);
  }

  // Generate new path in lesson directory
  const filename = sourcePath.split("/").pop() || "file";
  const destPath = `lessons/${lessonId}/${category}/${filename}`;
  const destFile = bucket.file(destPath);

  try {
    await sourceFile.copy(destFile);
    logger.info({ sourcePath, destPath, lessonId }, "Content copied to lesson");
    return destPath;
  } catch (error) {
    logger.error({ error, sourcePath, destPath }, "Failed to copy content");
    throw error;
  }
}

/**
 * Delete uploaded content
 *
 * @param filePath - Path to delete
 */
export async function deleteContent(filePath: string): Promise<void> {
  const bucket = getBucket();
  const file = bucket.file(filePath);

  try {
    await file.delete();
    logger.info({ filePath }, "Content deleted");
  } catch (error) {
    logger.error({ error, filePath }, "Failed to delete content");
    throw error;
  }
}

/**
 * Get upload progress tracking URL
 * For resumable uploads on large files
 */
export async function getResumableUploadUrl(
  contentType: string,
  size: number,
  lessonId: string | null,
  originalFilename: string,
  adminId: string
): Promise<{
  success: boolean;
  uploadUrl?: string;
  filePath?: string;
  error?: string;
}> {
  const validation = validateFile(contentType, size);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const config = validation.config!;
  const filePath = generateFilePath(
    config.category,
    lessonId,
    originalFilename,
    adminId
  );

  const bucket = getBucket();
  const file = bucket.file(filePath);

  try {
    const [uploadUrl] = await file.createResumableUpload({
      origin: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
      metadata: {
        contentType,
        metadata: {
          uploadedBy: adminId,
          originalFilename,
          lessonId: lessonId || "",
        },
      },
    });

    return {
      success: true,
      uploadUrl,
      filePath,
    };
  } catch (error) {
    logger.error({ error }, "Failed to create resumable upload");
    return {
      success: false,
      error: "Failed to prepare upload - please try again",
    };
  }
}
