"use client";

import { useEffect, useRef, useState } from "react";
import { ScenePreview } from "@/components/studio/scene-preview";

const STARTER = {
  title: "Untitled reel",
  aspect: "9:16",
  brandTheme: "cream",
  music: { track: "corporate-lofi", gainDb: -22, duckUnderVoiceover: true },
  scenes: [
    {
      id: "hook",
      type: "hook",
      durationSec: 4,
      headline: "What do you ==actually own==?",
      motion: "rise",
      voiceover: {
        text: "Quick question — do you really know what you own?",
        lang: "en-IN",
      },
    },
    {
      id: "point",
      type: "point",
      durationSec: 4.5,
      headline: "Owning many is *not* diversified",
      subtext: "Education only.",
      disclaimer: true,
      voiceover: {
        text: "Owning thirty stocks doesn't always mean you're diversified.",
        lang: "en-IN",
      },
    },
    {
      id: "cta",
      type: "cta",
      durationSec: 3.5,
      headline: "Awareness first.",
      subtext: "UseMoney AI (my product)",
      motion: "pop",
      voiceover: { text: "Awareness first, decisions later.", lang: "en-IN" },
    },
  ],
};

interface JobStatus {
  state: string;
  progress?: number;
  message?: string;
  resultUrl?: string;
}

export default function ReelStudioPage() {
  const [json, setJson] = useState(JSON.stringify(STARTER, null, 2));
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function timelineOrNull(): unknown | null {
    try {
      return JSON.parse(json);
    } catch {
      setError("Timeline JSON is invalid.");
      return null;
    }
  }

  async function applyEdit(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/studio/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { timeline?: unknown; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Edit failed");
      setJson(JSON.stringify(data.timeline, null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Edit failed");
    } finally {
      setBusy(false);
    }
  }

  async function runInstruction() {
    const timeline = timelineOrNull();
    if (!timeline || !instruction.trim()) return;
    await applyEdit({ timeline, instruction });
  }

  async function quick(edits: unknown[]) {
    const timeline = timelineOrNull();
    if (!timeline) return;
    await applyEdit({ timeline, edits });
  }

  async function render() {
    const timeline = timelineOrNull();
    if (!timeline) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    setJobId(null);
    try {
      const res = await fetch("/api/studio/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "render-reel", timeline }),
      });
      const data = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !data.jobId)
        throw new Error(data.error ?? "Enqueue failed");
      setJobId(data.jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enqueue failed");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!jobId) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/studio/status?jobId=${jobId}`);
        const s = (await res.json()) as JobStatus;
        setStatus(s);
        if ((s.state === "done" || s.state === "error") && pollRef.current) {
          clearInterval(pollRef.current);
        }
      } catch {
        /* keep polling */
      }
    }, 2500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [jobId]);

  const btn =
    "rounded-lg border-2 border-neutral-900 bg-white px-3 py-1.5 text-sm font-medium shadow-[2px_2px_0_0_#1d1d1b] disabled:opacity-50";

  return (
    <div className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-bold text-neutral-900">🎬 Reel Studio</h1>
      <p className="mt-1 text-sm text-neutral-600">
        Edit the timeline by prompt or direct tools, then render (Veo +
        voiceover) via the worker. SEBI guardrails apply.
      </p>

      {/* Live preview filmstrip — client-side; the brand-exact frames come from the render. */}
      <div className="mt-6 rounded-xl border-2 border-neutral-900 bg-white p-4 shadow-[4px_4px_0_0_#1d1d1b]">
        <label className="text-sm font-semibold">Live preview</label>
        <p className="mb-2 text-xs text-neutral-500">
          Approximate scene cards, updated as you edit — the final brand-exact
          frames are produced by the render.
        </p>
        <ScenePreview json={json} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Editor */}
        <div>
          <label className="text-sm font-semibold">Timeline JSON</label>
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            spellCheck={false}
            className="mt-1 h-[460px] w-full rounded-xl border-2 border-neutral-900 bg-white p-3 font-mono text-xs"
          />
        </div>

        {/* Controls */}
        <div className="space-y-5">
          <div className="rounded-xl border-2 border-neutral-900 bg-[#f7f3e6] p-4 shadow-[4px_4px_0_0_#1d1d1b]">
            <label className="text-sm font-semibold">Edit by prompt</label>
            <input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder='e.g. "make the hook 5s, swap music to corporate-lofi, drop the last scene"'
              className="mt-1 w-full rounded-lg border border-neutral-400 bg-white p-2 text-sm"
            />
            <button
              onClick={runInstruction}
              disabled={busy}
              className={`mt-2 ${btn}`}
            >
              Apply edit
            </button>
            <p className="mt-1 text-xs text-neutral-500">
              Structural edits run offline; freeform/translation use Gemini.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => quick([{ op: "set_captions", enabled: false }])}
              disabled={busy}
              className={btn}
            >
              Remove captions
            </button>
            <button
              onClick={() => quick([{ op: "remove_audio" }])}
              disabled={busy}
              className={btn}
            >
              Make silent
            </button>
            <button
              onClick={() => quick([{ op: "set_aspect", aspect: "1:1" }])}
              disabled={busy}
              className={btn}
            >
              Square 1:1
            </button>
            <button
              onClick={() =>
                quick([{ op: "set_voiceover_lang", lang: "hi-IN" }])
              }
              disabled={busy}
              className={btn}
            >
              VO → Hindi
            </button>
          </div>

          <button
            onClick={render}
            disabled={busy}
            className="rounded-lg border-2 border-neutral-900 bg-[#16a34a] px-5 py-2 font-semibold text-white shadow-[3px_3px_0_0_#1d1d1b] disabled:opacity-50"
          >
            {busy ? "Working…" : "Render reel"}
          </button>

          {error && <p className="text-sm text-red-600">⚠️ {error}</p>}

          {status && (
            <div className="rounded-xl border border-neutral-300 bg-white p-4 text-sm">
              <p>
                Status: <b>{status.state}</b>
                {typeof status.progress === "number"
                  ? ` · ${status.progress}%`
                  : ""}
              </p>
              {status.message && (
                <p className="text-neutral-500">{status.message}</p>
              )}
              {status.resultUrl && (
                <video
                  src={status.resultUrl}
                  controls
                  className="mt-3 w-full max-w-[280px] rounded-lg border border-neutral-300"
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
