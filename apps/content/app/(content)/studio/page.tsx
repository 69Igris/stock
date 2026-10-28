import Link from "next/link";

export default function StudioHome() {
  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-bold text-neutral-900">Content Studio</h1>
      <p className="mt-2 text-neutral-600">
        Generate brand-safe images and reels with Gemini. Education-only, SEBI
        guardrails baked in.
      </p>
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Link
          href="/studio/image"
          className="rounded-2xl border-2 border-neutral-900 bg-[#f7f3e6] p-6 shadow-[4px_4px_0_0_#1d1d1b] transition hover:-translate-y-0.5"
        >
          <div className="text-lg font-bold">🖼️ Image Studio</div>
          <p className="mt-1 text-sm text-neutral-700">
            Nano Banana Pro (Gemini 3 Pro Image) — prompt → on-brand image →
            saved to your library.
          </p>
        </Link>
        <Link
          href="/studio/reel"
          className="rounded-2xl border-2 border-neutral-900 bg-[#f7f3e6] p-6 shadow-[4px_4px_0_0_#1d1d1b] transition hover:-translate-y-0.5"
        >
          <div className="text-lg font-bold">🎬 Reel Studio</div>
          <p className="mt-1 text-sm text-neutral-700">
            Edit a timeline by prompt or direct tools, then render with Veo +
            voiceover via the worker.
          </p>
        </Link>
      </div>
    </div>
  );
}
