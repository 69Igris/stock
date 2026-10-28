/**
 * Secure Content Streaming Proxy
 *
 * Handles secure streaming of learning content:
 * - Validates user authentication and PREMIUM+ subscription
 * - Generates signed URLs with short TTL
 * - Supports video HLS streaming, audio, documents, and images
 * - Prevents direct asset URL exposure
 *
 * Path format: /api/storage/stream/{contentPath}
 * Examples:
 *   - /api/storage/stream/lessons/abc123/video/index.m3u8
 *   - /api/storage/stream/lessons/abc123/video/segment0.ts
 *   - /api/storage/stream/lessons/abc123/slides/slide1.jpg
 *   - /api/storage/stream/lessons/abc123/audio.mp3
 */

import { NextRequest, NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import {
  generateSignedUrl,
  fileExists,
  getFileStream,
  getFileMetadata,
} from "@/lib/storage";
import {
  hasFeatureAccess,
  isValidContentPath,
  isDocumentPath,
  extractDocumentUserId,
  getContentType,
  shouldRedirect,
  shouldProxy,
  parseRangeHeader,
} from "./route-logic";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    // Await params in Next.js 15+
    const { path: pathSegments } = await params;
    const contentPath = pathSegments.join("/");

    // Validate path format
    if (!isValidContentPath(contentPath)) {
      return NextResponse.json(
        { error: "Invalid content path" },
        { status: 400 }
      );
    }

    // Authenticate user
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    // Get user email
    const clerkUser = await currentUser();
    const email = clerkUser?.emailAddresses?.[0]?.emailAddress;
    if (!email) {
      return NextResponse.json(
        { error: "User email not found" },
        { status: 401 }
      );
    }

    // Find user in database
    const user = await prisma.user.findFirst({
      where: { email },
      include: { subscription: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Document paths: ownership check (no subscription required)
    if (isDocumentPath(contentPath)) {
      const pathUserId = extractDocumentUserId(contentPath);
      if (pathUserId !== user.id) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    } else {
      // Learning content: check subscription
      const planId = user.subscription?.planId || "FREE";
      const hasAccess = hasFeatureAccess(planId, "learningContent");

      if (!hasAccess) {
        return NextResponse.json(
          { error: "Premium subscription required for learning content" },
          { status: 403 }
        );
      }
    }

    // Verify file exists in storage
    const exists = await fileExists(contentPath);
    if (!exists) {
      return NextResponse.json({ error: "Content not found" }, { status: 404 });
    }

    // Handle HLS manifest and segments - redirect to signed URL
    // HLS.js needs to follow redirects to the actual segments
    if (shouldRedirect(contentPath)) {
      const signedUrl = await generateSignedUrl(contentPath, {
        expiresIn: 60, // 1 minute for HLS segments
      });

      return NextResponse.redirect(signedUrl, {
        status: 302,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    // Handle audio, documents, images - proxy the content
    if (shouldProxy(contentPath)) {
      try {
        // Get file metadata for content length
        const metadata = await getFileMetadata(contentPath);
        const contentType = getContentType(contentPath);
        const contentLength = metadata?.size;

        // Handle range requests for audio/video
        const rangeHeader = request.headers.get("range");

        if (rangeHeader && contentLength) {
          // Parse range header
          const range = parseRangeHeader(rangeHeader, contentLength);
          if (range) {
            const { start, end } = range;

            // Get partial content stream
            const stream = await getFileStream(contentPath, { start, end });

            return new NextResponse(stream as unknown as ReadableStream, {
              status: 206,
              headers: {
                "Content-Type": contentType,
                "Content-Range": `bytes ${start}-${end}/${contentLength}`,
                "Content-Length": String(end - start + 1),
                "Accept-Ranges": "bytes",
                "Cache-Control": "private, max-age=300",
                "X-Content-Type-Options": "nosniff",
              },
            });
          }
        }

        // Full content stream
        const stream = await getFileStream(contentPath);

        return new NextResponse(stream as unknown as ReadableStream, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            ...(contentLength && { "Content-Length": String(contentLength) }),
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch (streamError) {
        console.error("Stream error:", streamError);

        // Fallback: redirect to signed URL
        const signedUrl = await generateSignedUrl(contentPath, {
          expiresIn: 300, // 5 minutes
        });

        return NextResponse.redirect(signedUrl, { status: 302 });
      }
    }

    // Default: return signed URL in JSON (for special cases)
    const signedUrl = await generateSignedUrl(contentPath, {
      expiresIn: 300,
    });

    return NextResponse.json({
      url: signedUrl,
      contentType: getContentType(contentPath),
    });
  } catch (error) {
    console.error("Storage stream error:", error);
    return NextResponse.json(
      { error: "Failed to stream content" },
      { status: 500 }
    );
  }
}

// HEAD request for checking content availability
export async function HEAD(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: pathSegments } = await params;
    const contentPath = pathSegments.join("/");

    if (!isValidContentPath(contentPath)) {
      return new NextResponse(null, { status: 400 });
    }

    // Quick auth check
    const { userId } = await auth();
    if (!userId) {
      return new NextResponse(null, { status: 401 });
    }

    // Check if file exists
    const exists = await fileExists(contentPath);
    if (!exists) {
      return new NextResponse(null, { status: 404 });
    }

    const metadata = await getFileMetadata(contentPath);

    return new NextResponse(null, {
      status: 200,
      headers: {
        "Content-Type": getContentType(contentPath),
        ...(metadata?.size && { "Content-Length": String(metadata.size) }),
        "Accept-Ranges": "bytes",
      },
    });
  } catch (error) {
    console.error("HEAD request error:", error);
    return new NextResponse(null, { status: 500 });
  }
}
