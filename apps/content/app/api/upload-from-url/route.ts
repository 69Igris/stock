/**
 * Re-upload a remote / data-URL image to GCS (paste sideloading).
 *
 * When an author pastes HTML content with `<img src="https://external…">` or a
 * base64 `data:` URL, BlockNote inserts it as-is — its `uploadFile` hook only
 * fires for File/Blob objects. This endpoint takes such a URL, fetches/decodes
 * it SERVER-SIDE (avoiding browser CORS on the external host), validates it with
 * the same rules as /api/upload, and stores it in the public GCS bucket — so the
 * published post never hot-links a third-party image.
 *
 * POST /api/upload-from-url  { url }  ->  { url: <gcs url> }
 */

import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { uploadFile } from "@usemoney/storage";
import {
  generateUniqueFilename,
  getFileCategory,
  getFolder,
  getMaxSize,
  isAllowedType,
} from "../upload/upload-logic";

const PUBLIC_BUCKET = process.env.GCP_PUBLIC_STORAGE_BUCKET;

/**
 * Basic SSRF guard: reject localhost / link-local / private-range hosts so an
 * authenticated author can't make the server fetch internal services. (Full
 * protection needs DNS-resolution checks; this + the auth gate is the baseline.)
 */
function isBlockedHost(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd")
    ) {
      return true;
    }
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    return false;
  } catch {
    return true;
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as { url?: unknown };
    const sourceUrl = typeof body.url === "string" ? body.url : "";
    if (!sourceUrl) {
      return NextResponse.json({ error: "No url provided." }, { status: 400 });
    }

    let buffer: Buffer;
    let contentType: string;
    let originalName: string;

    if (sourceUrl.startsWith("data:")) {
      // data:[<mime>][;base64],<data>
      const match = sourceUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
      if (!match) {
        return NextResponse.json(
          { error: "Invalid data URL." },
          { status: 400 },
        );
      }
      contentType = match[1] || "application/octet-stream";
      const dataPart = match[3] ?? "";
      buffer = match[2]
        ? Buffer.from(dataPart, "base64")
        : Buffer.from(decodeURIComponent(dataPart), "utf-8");
      originalName = `pasted.${contentType.split("/")[1] || "bin"}`;
    } else if (/^https?:\/\//i.test(sourceUrl)) {
      if (isBlockedHost(sourceUrl)) {
        return NextResponse.json(
          { error: "URL host is not allowed." },
          { status: 400 },
        );
      }
      const res = await fetch(sourceUrl, { redirect: "follow" });
      if (!res.ok) {
        return NextResponse.json(
          { error: `Could not fetch image (${res.status}).` },
          { status: 400 },
        );
      }
      contentType =
        res.headers.get("content-type")?.split(";")[0]?.trim() ||
        "application/octet-stream";
      buffer = Buffer.from(await res.arrayBuffer());
      originalName = sourceUrl.split("/").pop()?.split("?")[0] || "pasted";
    } else {
      return NextResponse.json({ error: "Unsupported url." }, { status: 400 });
    }

    if (!isAllowedType(contentType)) {
      return NextResponse.json(
        { error: `Unsupported media type: ${contentType}` },
        { status: 400 },
      );
    }
    const category = getFileCategory(contentType);
    if (buffer.length > getMaxSize(category)) {
      return NextResponse.json({ error: "File too large." }, { status: 400 });
    }

    const result = await uploadFile({
      file: buffer,
      fileName: generateUniqueFilename(originalName, contentType),
      contentType,
      folder: getFolder(category),
      userId,
      isPublic: true,
      bucketName: PUBLIC_BUCKET,
      metadata: {
        source: "paste-reupload",
        originalUrl: sourceUrl.startsWith("data:") ? "data-url" : sourceUrl,
        uploadedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json({ url: result.url });
  } catch (error) {
    console.error("upload-from-url error:", error);
    return NextResponse.json(
      { error: "Failed to import image." },
      { status: 500 },
    );
  }
}
