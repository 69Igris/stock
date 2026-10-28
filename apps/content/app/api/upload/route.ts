/**
 * File Upload API Route
 *
 * Handles image, video, and audio uploads for the Content CMS.
 * Uploads files to Google Cloud Storage and returns the public URL.
 *
 * POST /api/upload
 * - Accepts multipart form data with a file
 * - Images: max 5MB (jpg, png, gif, webp)
 * - Videos: max 100MB (mp4, webm, mov)
 * - Audio: max 50MB (mp3, wav, ogg, m4a)
 * - Requires authentication via Clerk
 * - Returns the public URL of the uploaded file
 */

import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { uploadFile } from "@usemoney/storage";
import {
  ALLOWED_TYPES,
  generateUniqueFilename,
  getFileCategory,
  getFolder,
  getMaxSize,
  isAllowedType,
} from "./upload-logic";

// Public bucket for content files (direct GCS URLs, no proxy needed)
const PUBLIC_BUCKET = process.env.GCP_PUBLIC_STORAGE_BUCKET;

export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { error: "Unauthorized. Please sign in to upload files." },
        { status: 401 },
      );
    }

    // Parse the form data
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    // Validate file presence
    if (!file) {
      return NextResponse.json(
        { error: "No file provided. Please select a file to upload." },
        { status: 400 },
      );
    }

    // Validate file type
    if (!isAllowedType(file.type)) {
      return NextResponse.json(
        {
          error: `Invalid file type. Allowed types: ${ALLOWED_TYPES.join(", ")}.`,
        },
        { status: 400 },
      );
    }

    // Validate file size based on category
    const category = getFileCategory(file.type);
    const maxSize = getMaxSize(category);
    if (file.size > maxSize) {
      return NextResponse.json(
        {
          error: `File too large. Maximum size for ${category} is ${maxSize / (1024 * 1024)}MB.`,
        },
        { status: 400 },
      );
    }

    // Convert file to buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Generate unique filename
    const uniqueFilename = generateUniqueFilename(file.name, file.type);

    // Upload to public GCS bucket for direct access
    const result = await uploadFile({
      file: buffer,
      fileName: uniqueFilename,
      contentType: file.type,
      folder: getFolder(category),
      userId,
      isPublic: true,
      bucketName: PUBLIC_BUCKET,
      metadata: {
        originalName: file.name,
        uploadedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json({
      url: result.url,
      fileName: result.fileName,
      fileSize: result.fileSize,
      mimeType: result.mimeType,
    });
  } catch (error) {
    console.error("Upload error:", error);

    // Handle specific error types
    if (error instanceof Error) {
      // Check for GCP configuration errors
      if (
        error.message.includes("GCP_PROJECT_ID") ||
        error.message.includes("GCP_STORAGE_BUCKET")
      ) {
        return NextResponse.json(
          {
            error: "Storage service is not configured. Please contact support.",
          },
          { status: 503 },
        );
      }
    }

    return NextResponse.json(
      { error: "Failed to upload file. Please try again." },
      { status: 500 },
    );
  }
}

/**
 * Handle unsupported methods
 */
export async function GET() {
  return NextResponse.json(
    { error: "Method not allowed. Use POST to upload files." },
    { status: 405 },
  );
}
