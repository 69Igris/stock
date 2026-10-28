/**
 * Pure, Next-free fallback generator for the generate-image route (`route.ts`).
 *
 * The image-suggestion builder + style map was previously a non-exported
 * function inside the route handler module, testable only via an inline copy.
 * It is extracted here so the REAL fallback can be unit-tested directly.
 * `route.ts` imports and calls `generateImageSuggestion`.
 *
 * @see apps/content/__tests__/api/ai-routes.test.ts
 */

export interface ImageSuggestion {
  enhancedPrompt: string;
  stockPhotoKeywords: string[];
  colorPalette: string[];
}

/**
 * Build an image-generation suggestion used when no AI key is configured (or
 * the AI call fails). The `style` maps to a descriptive phrase; an unknown or
 * absent style falls back to "photorealistic".
 */
export function generateImageSuggestion(
  prompt: string,
  style?: string,
): ImageSuggestion {
  const styleMap: Record<string, string> = {
    photorealistic: "professional, high-resolution photograph",
    "digital-art": "modern digital artwork with clean lines",
    illustration: "hand-drawn style illustration",
    minimalist: "clean, minimalist design with simple shapes",
    abstract: "abstract artistic composition",
  };

  const styleDesc =
    styleMap[style || "photorealistic"] || styleMap["photorealistic"];

  return {
    enhancedPrompt: `${styleDesc} depicting ${prompt}. Professional quality, suitable for a financial blog header. Clean composition with good contrast and readability for text overlay.`,
    stockPhotoKeywords: [
      "finance",
      "stock market",
      "investment",
      "trading",
      "business",
      "growth chart",
      "portfolio",
      "Indian market",
    ],
    colorPalette: ["#1E40AF", "#059669", "#F59E0B", "#1F2937", "#F8FAFC"],
  };
}
