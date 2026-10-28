import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { uploadFile } from "@usemoney/storage";
import { prisma } from "@usemoney/database";
import { checkDailyLimit } from "@/lib/studio-rate-limit";
import { generateImageSuggestion } from "./generate-image-logic";
import {
  buildImagePrompt,
  generateBrandImage,
  hasImageCreds,
  type BrandTheme,
  type ImageAspect,
} from "./nano-banana";

interface ImageRequest {
  prompt: string;
  style?: string;
  aspectRatio?: string;
  brandTheme?: BrandTheme;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { prompt, style, aspectRatio, brandTheme } =
      (await request.json()) as ImageRequest;

    if (!prompt) {
      return NextResponse.json(
        { error: "Prompt is required" },
        { status: 400 },
      );
    }

    // Cost guardrail: cap real image generations per user per day.
    if (hasImageCreds()) {
      const rl = await checkDailyLimit(userId, "image");
      if (!rl.ok)
        return NextResponse.json(
          {
            error: `Daily image limit reached (${rl.limit}/day). Try again tomorrow.`,
            limit: rl.limit,
          },
          { status: 429 },
        );
    }

    // Real image generation (Nano Banana Pro) when Google creds exist.
    if (hasImageCreds()) {
      try {
        const img = await generateBrandImage({
          prompt,
          style,
          brandTheme: brandTheme ?? "cream",
          aspect: (aspectRatio as ImageAspect) ?? "1:1",
        });
        const ext = img.mimeType.includes("jpeg") ? "jpg" : "png";
        const uploaded = await uploadFile({
          file: img.data,
          fileName: `studio-${Date.now()}.${ext}`,
          contentType: img.mimeType,
          folder: `studio/images/${userId}`,
          userId,
          isPublic: true,
          metadata: { model: img.model, source: "studio-image" },
        });
        // Persist to the Studio library (best-effort — never fail the response on a DB hiccup).
        await prisma.studioGeneration
          .create({
            data: {
              userId,
              kind: "image",
              prompt: img.prompt,
              url: uploaded.url,
              model: img.model,
              meta: {
                aspect: aspectRatio ?? "1:1",
                style: style ?? "minimalist",
                brandTheme: brandTheme ?? "cream",
              },
            },
          })
          .catch(() => undefined);
        return NextResponse.json({
          fallback: false,
          image: { url: uploaded.url, model: img.model, prompt: img.prompt },
        });
      } catch (err) {
        // Fall through to a text suggestion if the model call/upload fails.
        return NextResponse.json({
          fallback: true,
          error: err instanceof Error ? err.message : "image generation failed",
          suggestion: generateImageSuggestion(prompt, style),
          enhancedPrompt: buildImagePrompt({
            prompt,
            style,
            brandTheme: brandTheme ?? "cream",
            aspect: (aspectRatio as ImageAspect) ?? "1:1",
          }),
        });
      }
    }

    const apiKey = process.env.GOOGLE_GENAI_API_KEY;

    if (!apiKey) {
      return NextResponse.json({
        fallback: true,
        suggestion: generateImageSuggestion(prompt, style),
      });
    }

    const aiPrompt = `You are an expert at creating image descriptions for blog posts about Indian stock markets, finance, and investing.

Given this image request, provide:
1. An enhanced, detailed prompt suitable for image generation
2. 5-8 stock photo keywords that could be used to find a similar image on stock photo sites
3. A color palette of 4-5 hex colors that would work well for this type of image

Image request: "${prompt}"
Style preference: ${style || "photorealistic"}
Aspect ratio: ${aspectRatio || "16:9"}

Respond in JSON format exactly like this:
{
  "enhancedPrompt": "detailed description here",
  "stockPhotoKeywords": ["keyword1", "keyword2", ...],
  "colorPalette": ["#hex1", "#hex2", ...]
}

Only respond with valid JSON, no additional text.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: aiPrompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error("AI request failed");
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    if (!text) {
      throw new Error("No response generated");
    }

    const suggestion = JSON.parse(text) as {
      enhancedPrompt: string;
      stockPhotoKeywords: string[];
      colorPalette: string[];
    };

    return NextResponse.json({
      fallback: true,
      suggestion,
    });
  } catch {
    return NextResponse.json({
      fallback: true,
      suggestion: generateImageSuggestion(
        "blog header image",
        "photorealistic",
      ),
    });
  }
}
