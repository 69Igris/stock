"use client";

import { useState } from "react";

interface ImgResult {
  fallback?: boolean;
  error?: string;
  image?: { url: string; model: string; prompt: string };
  suggestion?: {
    enhancedPrompt: string;
    stockPhotoKeywords: string[];
    colorPalette: string[];
  };
  enhancedPrompt?: string;
}

const STYLES = [
  "minimalist",
  "photorealistic",
  "illustration",
  "digital-art",
  "abstract",
  "3d",
];
const THEMES: ReadonlyArray<readonly [string, string]> = [
  ["cream", "Cream (social)"],
  ["dark", "Terminal Luxe"],
  ["none", "No brand"],
];
const ASPECTS = ["1:1", "16:9", "9:16", "4:5"];

export default function ImageStudioPage() {
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState("minimalist");
  const [brandTheme, setBrandTheme] = useState("cream");
  const [aspectRatio, setAspect] = useState("1:1");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImgResult | null>(null);
  const [gallery, setGallery] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    if (!prompt.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/ai/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, style, brandTheme, aspectRatio }),
      });
      const data = (await res.json()) as ImgResult;
      if (!res.ok) throw new Error(data.error ?? "Generation failed");
      setResult(data);
      if (data.image?.url)
        setGallery((g) => [data.image!.url, ...g].slice(0, 12));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-bold text-neutral-900">🖼️ Image Studio</h1>
      <p className="mt-1 text-sm text-neutral-600">
        Nano Banana Pro · education-only, SEBI-safe prompts.
      </p>

      <div className="mt-6 space-y-4 rounded-2xl border-2 border-neutral-900 bg-[#f7f3e6] p-6 shadow-[4px_4px_0_0_#1d1d1b]">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. a calm, abstract concept of one clear portfolio dashboard forming from scattered pieces"
          className="h-24 w-full rounded-lg border border-neutral-400 bg-white p-3 text-sm"
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="text-sm">
            Style
            <select
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-400 bg-white p-2"
            >
              {STYLES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Brand
            <select
              value={brandTheme}
              onChange={(e) => setBrandTheme(e.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-400 bg-white p-2"
            >
              {THEMES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Aspect
            <select
              value={aspectRatio}
              onChange={(e) => setAspect(e.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-400 bg-white p-2"
            >
              {ASPECTS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          onClick={generate}
          disabled={loading || !prompt.trim()}
          className="rounded-lg border-2 border-neutral-900 bg-[#16a34a] px-5 py-2 font-semibold text-white shadow-[3px_3px_0_0_#1d1d1b] disabled:opacity-50"
        >
          {loading ? "Generating…" : "Generate image"}
        </button>
      </div>

      {error && <p className="mt-4 text-sm text-red-600">⚠️ {error}</p>}

      {result?.image?.url && (
        <div className="mt-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={result.image.url}
            alt="generated"
            className="w-full rounded-xl border-2 border-neutral-900"
          />
          <p className="mt-2 text-xs text-neutral-500">
            model: {result.image.model}
          </p>
        </div>
      )}

      {result?.fallback && result.suggestion && (
        <div className="mt-6 rounded-xl border border-amber-400 bg-amber-50 p-4 text-sm">
          <p className="font-semibold">
            No image model configured — suggestion only:
          </p>
          <p className="mt-2">
            {result.enhancedPrompt ?? result.suggestion.enhancedPrompt}
          </p>
          <p className="mt-2 text-neutral-600">
            Keywords: {result.suggestion.stockPhotoKeywords.join(", ")}
          </p>
        </div>
      )}

      {gallery.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-neutral-700">
            This session
          </h2>
          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {gallery.map((url) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={url}
                src={url}
                alt=""
                className="aspect-square w-full rounded-lg border border-neutral-300 object-cover"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
