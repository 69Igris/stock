import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { uploadFile } from "@/lib/storage/gcp-client";
import { generateSignedUrl } from "@/lib/storage/signed-urls";

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

const MAX_SIZE = 5 * 1024 * 1024; // 5MB

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: "Only PNG, JPEG, WebP, and GIF images are allowed" },
        { status: 400 }
      );
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { error: "File size must be under 5MB" },
        { status: 400 }
      );
    }

    const ext = file.type.split("/")[1] || "png";
    const randomId = crypto.randomBytes(4).toString("hex");
    const timestamp = Date.now();
    const gcsPath = `feedback/${userId}/${timestamp}-${randomId}.${ext}`;

    const buffer = Buffer.from(await file.arrayBuffer());
    await uploadFile(gcsPath, buffer, file.type, {
      uploadedBy: userId,
      originalName: file.name,
    });

    const url = await generateSignedUrl(gcsPath, { expiresIn: 3600 });

    return NextResponse.json({
      success: true,
      path: gcsPath,
      url,
    });
  } catch (error) {
    console.error("[feedback/upload] Error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
