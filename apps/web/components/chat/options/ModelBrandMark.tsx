"use client";

/**
 * ModelBrandMark — real provider logos for the chat model picker.
 *
 * The brand marks (Gemini sparkle, OpenAI knot, Grok swoosh, Perplexity
 * compass-star) are the same vectors the landing-page footer renders in
 * `components/marketing/PlayfulFooter.tsx`, lifted here so the in-app model
 * selector shows the actual logos instead of a colored letter-glyph. Claude
 * uses the PNG brand mark at `/public/ai-logos/claude.png`.
 *
 * Marks that ship as `fill="currentColor"` inherit a theme-aware colour from
 * the wrapper (`var(--ink)` → ink in light, cream in dark) so they stay
 * legible on the playful paper surface in both themes. Gemini keeps Google
 * blue; Claude is full-colour already.
 */

import Image from "next/image";

export type ModelFamily = "gemini" | "claude" | "chatgpt" | "grok" | "custom";

/**
 * Map a model-registry `provider` ("google" | "anthropic" | "openai" | "xai")
 * to the brand-mark `family`. Lets every model-selector surface — chat
 * composer, research config, future settings — render the real provider logo
 * straight from a `ModelDefinition` instead of a colored letter-glyph.
 * Unknown providers fall back to the neutral "custom" monogram.
 */
export function providerToFamily(provider: string): ModelFamily {
  switch (provider) {
    case "google":
      return "gemini";
    case "anthropic":
      return "claude";
    case "openai":
      return "chatgpt";
    case "xai":
      return "grok";
    default:
      return "custom";
  }
}

export function ModelBrandMark({
  family,
  size = 16,
}: {
  family: ModelFamily;
  size?: number;
}) {
  switch (family) {
    case "claude":
      return (
        <Image
          src="/ai-logos/claude.png"
          alt=""
          width={size}
          height={size}
          aria-hidden
          style={{ width: size, height: size, objectFit: "contain" }}
        />
      );

    case "gemini":
      // Google Gemini — 4-point sparkle in Google blue.
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="#4285F4"
          aria-hidden
          style={{ display: "block" }}
        >
          <path d="M12 2 C12 7.5 16.5 12 22 12 C16.5 12 12 16.5 12 22 C12 16.5 7.5 12 2 12 C7.5 12 12 7.5 12 2 Z" />
        </svg>
      );

    case "chatgpt":
      // OpenAI ChatGPT — 6-loop knot, monochrome via currentColor.
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden
          style={{ display: "block", color: "var(--ink)" }}
        >
          <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .039.052v5.583a4.504 4.504 0 0 1-4.495 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
        </svg>
      );

    case "grok":
      // Grok (xAI) — angular swoosh, monochrome via currentColor.
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 34 33"
          fill="currentColor"
          aria-hidden
          style={{ display: "block", color: "var(--ink)" }}
        >
          <path d="M13.2371 21.0407L24.3186 12.8506C24.8619 12.4491 25.6384 12.6057 25.8973 13.2294C27.2597 16.5185 26.651 20.4712 23.9403 23.1851C21.2297 25.8989 17.4581 26.4941 14.0108 25.1386L10.2449 26.8843C15.6463 30.5806 22.2053 29.6665 26.304 25.5601C29.5551 22.3051 30.562 17.8683 29.6205 13.8673L29.629 13.8758C28.2637 7.99809 29.9647 5.64871 33.449 0.844576C33.5314 0.730667 33.6139 0.616757 33.6964 0.5L29.1113 5.09055V5.07631L13.2343 21.0436" />
          <path d="M10.9503 23.0313C7.07343 19.3235 7.74185 13.5853 11.0498 10.2763C13.4959 7.82722 17.5036 6.82767 21.0021 8.2971L24.7595 6.55998C24.0826 6.07017 23.215 5.54334 22.2195 5.17313C17.7198 3.31926 12.3326 4.24192 8.67479 7.90126C5.15635 11.4239 4.0499 16.8403 5.94992 21.4622C7.36924 24.9165 5.04257 27.3598 2.69884 29.826C1.86829 30.7002 1.0349 31.5745 0.36364 32.5L10.9474 23.0341" />
        </svg>
      );

    default:
      // Custom / bring-your-own endpoint — neutral monogram fallback.
      return (
        <span
          aria-hidden
          style={{
            fontFamily: "var(--font-mono, monospace)",
            fontWeight: 700,
            fontSize: Math.round(size * 0.62),
            lineHeight: 1,
            color: "var(--ink-3)",
          }}
        >
          {"{ }"}
        </span>
      );
  }
}

export default ModelBrandMark;
