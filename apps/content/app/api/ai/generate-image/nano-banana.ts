/**
 * Real image generation via Google "Nano Banana Pro" (Gemini 3 Pro Image).
 *
 * Next-free so the prompt builder + guardrail are unit-testable in isolation
 * (`route.ts` imports `generateBrandImage`; tests import `buildImagePrompt`).
 *
 * Model id is configurable — default `gemini-3-pro-image-preview` (Nano Banana
 * Pro, GA Jun 2026). Auth mirrors the rest of the repo: Vertex when
 * `GCP_PROJECT_ID` is set, else a Gemini API key. VERIFY the model is enabled
 * for your project/region (Nano Banana Pro shipped on the Gemini API first;
 * Vertex availability can lag) — flip `GEMINI_IMAGE_MODEL` if needed.
 *
 * SEBI: prompts are forced education-only — no tickers, prices, %s, or
 * advice-implying text baked into generated imagery.
 */
import { GoogleGenAI } from "@google/genai";

export type BrandTheme = "cream" | "dark" | "none";
export type ImageAspect = "1:1" | "16:9" | "9:16" | "4:5";

export interface ImagePromptOpts {
  prompt: string;
  style?: string;
  brandTheme?: BrandTheme;
  aspect?: ImageAspect;
}

const STYLE_MAP: Record<string, string> = {
  photorealistic: "professional, high-resolution photograph",
  "digital-art": "modern digital artwork with clean lines",
  illustration: "clean editorial vector illustration",
  minimalist: "clean, minimalist composition with generous negative space",
  abstract: "abstract, conceptual composition",
  "3d": "soft 3D render, premium product look",
};

/** UseMoney brand palettes (v3 cream-paper for social, Terminal Luxe for product). */
const BRAND: Record<Exclude<BrandTheme, "none">, string> = {
  cream:
    "UseMoney v3 'cream-paper' brand: warm cream background (#f7f3e6), near-black ink (#1d1d1b), emerald-green accent (#16a34a), gold highlight (#fbbf24), occasional orange (#ff6b35); neo-brutalist, premium, lots of negative space, crisp hard edges",
  dark: "UseMoney 'Terminal Luxe' brand: deep navy-black background (#060b18), emerald accent (#34d399), premium fintech, subtle glow, cinematic, lots of negative space",
};

/** The non-negotiable, education-only constraints baked into every image. */
export const SEBI_IMAGE_GUARDRAIL =
  "Educational, conceptual illustration only. Do NOT include any real ticker symbols, company names or logos, specific stock or index names, price levels or numbers, percentage returns, up/down buy-sell arrows as signals, or any text that implies investment advice, tips, or guaranteed returns. Avoid charts that look like a real recommendation.";

/** Build the final image prompt — pure + deterministic (unit-tested). */
export function buildImagePrompt(opts: ImagePromptOpts): string {
  const styleDesc =
    STYLE_MAP[opts.style ?? "minimalist"] ?? STYLE_MAP.minimalist;
  const brand =
    opts.brandTheme && opts.brandTheme !== "none"
      ? BRAND[opts.brandTheme]
      : null;
  const aspect = opts.aspect ?? "1:1";
  return [
    `${styleDesc} for an Indian retail-investing education brand.`,
    `Subject: ${opts.prompt.trim()}.`,
    brand ? `Brand styling: ${brand}.` : null,
    `Composition: ${aspect} aspect ratio, leave clean space for a headline overlay, strong contrast, readable.`,
    SEBI_IMAGE_GUARDRAIL,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
  model: string;
  prompt: string;
}

const MODEL = () =>
  process.env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image-preview";

/** True if any usable Google auth is configured (Vertex SA or API key). */
export function hasImageCreds(): boolean {
  return !!(
    process.env.GCP_PROJECT_ID ||
    process.env.GOOGLE_GENAI_API_KEY ||
    process.env.GEMINI_API_KEY
  );
}

function makeClient(): GoogleGenAI {
  const project = process.env.GCP_PROJECT_ID;
  if (project) {
    return new GoogleGenAI({
      vertexai: true,
      project,
      location: process.env.GCP_LOCATION ?? "us-central1",
    });
  }
  const apiKey = process.env.GOOGLE_GENAI_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("No GCP project or Gemini API key configured.");
  return new GoogleGenAI({ apiKey });
}

/** Generate one brand-safe image. Throws if no image part comes back. */
export async function generateBrandImage(
  opts: ImagePromptOpts,
): Promise<GeneratedImage> {
  const prompt = buildImagePrompt(opts);
  const model = MODEL();
  const ai = makeClient();
  const resp = await ai.models.generateContent({
    model,
    contents: prompt,
    config: { responseModalities: ["TEXT", "IMAGE"] },
  });
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  const image = parts.find((p) => p.inlineData?.data)?.inlineData;
  if (!image?.data) throw new Error(`No image returned by ${model}`);
  return {
    data: Buffer.from(image.data, "base64"),
    mimeType: image.mimeType ?? "image/png",
    model,
    prompt,
  };
}
